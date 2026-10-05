import { isoInstant, type PgConnection } from "@crossengin/kernel-pg";
import {
  DRILL_OUTCOMES,
  FAILOVER_TRANSITIONS,
  type DrillOutcome,
} from "@crossengin/dr";

/**
 * The write rules for a DR execution row, performed **in SQL** rather than decided in process.
 *
 * Both execution stores wrote `ON CONFLICT (execution_id) DO NOTHING` on what the runtime uses as
 * an *upsert* path, so a failover's plan was stored and its completion was not: the row kept the
 * status it was declared with forever, and `assessDrReadiness` — which reads `record` straight back
 * out of these tables — scored a faithfully-drilled deployment off rows that never advanced.
 * `DO NOTHING` is right for an idempotent *first* write and wrong for a record the executor moves.
 *
 * What replaces it is not a bare `DO UPDATE`. A bare one is the same defect inverted: a replayed
 * plan arriving after a completion would move the row *back*, silently, and that is strictly worse
 * than dropping it. So the `DO UPDATE` carries a `WHERE`, which is ADR-0321's "the row is the lock"
 * — a transition guarded by the stored state itself, inside the predicate, which a caller cannot
 * defeat by reusing what it read. The executor's own `assertTransition` cannot stand in for it:
 * `recordFailover` is handed a record the *caller* holds, so two workers each holding the planned
 * record can each make a legal move in process, and only the row knows which landed first.
 *
 * Two conditions, each from a different source, ANDed:
 *
 *  1. **The move must be one the contract permits, or no move at all.** Rendered from
 *     `FAILOVER_TRANSITIONS` rather than restated, so a new status or a new edge reaches the
 *     predicate by existing. Same-status is admitted because re-recording one state is a *refresh*
 *     of an observation and not a transition — `recordFailover` is called on the same record again
 *     when a verdict or a note is amended, and the transition map answers "may this move", to which
 *     staying put is not an answer.
 *  2. **A newer observation may not be overwritten by an older one.** `recorded_at` is when the row
 *     was *observed*, not when the failover was declared (`triggered_at` is that), and the whole row
 *     is one observation — which is why this is a refusal rather than ADR-0330's per-column
 *     `GREATEST`. A `GREATEST` here would leave a row whose content came from the older write and
 *     whose timestamp came from the newer, which lies about both.
 *
 * A refused write matches no row, and `INSERT 0 0` is indistinguishable from the `DO NOTHING` this
 * replaces — the silence the whole change is about. So a zero row count is diagnosed against the
 * stored row and **thrown**, naming which of the two rules refused it.
 */

/** Statuses, outcomes and column names all come from frozen enums; nothing here is user input. */
const STATUS_LITERAL_RE = /^[a-z][a-z0-9_]*$/;

function literal(value: string, what: string): string {
  if (!STATUS_LITERAL_RE.test(value)) {
    throw new Error(`${what} is not a bare identifier and cannot be rendered: ${JSON.stringify(value)}`);
  }
  return `'${value}'`;
}

/**
 * The observation rule, shared by both tables: this write is not older than the stored one.
 */
export function observationNotStaleGuard(table: string): string {
  return `EXCLUDED.recorded_at >= ${table}.recorded_at`;
}

/**
 * The failover status rule, rendered from `FAILOVER_TRANSITIONS`.
 *
 * A row-value `IN` list rather than a chain of ORs, so the rendered predicate is one shape whatever
 * the map holds; the terminal statuses contribute no pairs and need no special case.
 */
export function failoverStatusGuard(table: string): string {
  const pairs: string[] = [];
  for (const [from, tos] of Object.entries(FAILOVER_TRANSITIONS)) {
    for (const to of tos) {
      pairs.push(`(${literal(from, "failover status")}, ${literal(to, "failover status")})`);
    }
  }
  if (pairs.length === 0) {
    throw new Error("FAILOVER_TRANSITIONS declares no legal transition at all");
  }
  return (
    `(${table}.status = EXCLUDED.status` +
    ` OR (${table}.status, EXCLUDED.status) IN (${pairs.join(", ")}))`
  );
}

export function failoverUpsertGuard(table: string): string {
  return `${observationNotStaleGuard(table)}\n           AND ${failoverStatusGuard(table)}`;
}

/**
 * The outcome `planDrill` produces, which is the only thing a drill row can hold before it is run.
 *
 * Typed as `DrillOutcome` so a rename of the enum member is a compile error here, and pinned by a
 * test that asks `planDrill` rather than trusting this spelling.
 */
export const PLANNED_DRILL_OUTCOME: DrillOutcome = "not_executed";

/**
 * The drill rules. `packages/dr` declares **no** `DRILL_TRANSITIONS`, so there is no map to render
 * and inventing one would be writing contract here rather than performing it. What the contract does
 * state, and what these two clauses are:
 *
 *  - `DrillRecordSchema` requires `executedAt` for every outcome other than `not_executed`, and
 *    `recordDrillResult` carries the previous value forward rather than clearing it — so **an
 *    executed drill does not become unexecuted**.
 *  - `planDrill` is the only producer of `not_executed`, and it mints a fresh id at the same time —
 *    so no legal path produces that outcome for an id that already carries a result. **A recorded
 *    result is not withdrawn**; the planned state may still be refreshed into itself.
 *
 * Amending a result (`passed` → `passed_with_findings` after review, a late `reportUrl`) is
 * deliberately permitted, because nothing in the contract forbids it and it is the ordinary reason
 * `recordDrillResult` is called twice — which under `DO NOTHING` was dropped in silence.
 */
export function drillUpsertGuard(table: string): string {
  const planned = literal(PLANNED_DRILL_OUTCOME, "drill outcome");
  if (!DRILL_OUTCOMES.includes(PLANNED_DRILL_OUTCOME)) {
    throw new Error(`${PLANNED_DRILL_OUTCOME} is not a declared drill outcome`);
  }
  return (
    `${observationNotStaleGuard(table)}\n` +
    `           AND (EXCLUDED.executed_at IS NOT NULL OR ${table}.executed_at IS NULL)\n` +
    `           AND (EXCLUDED.outcome IS DISTINCT FROM ${planned}` +
    ` OR ${table}.outcome IS NOT DISTINCT FROM EXCLUDED.outcome)`
  );
}

/** `status = EXCLUDED.status, …` for exactly the columns a legal change may move. */
export function excludedSetClause(columns: readonly string[]): string {
  if (columns.length === 0) throw new Error("an upsert with no mutable column is a DO NOTHING");
  return columns
    .map((c) => {
      if (!STATUS_LITERAL_RE.test(c)) {
        throw new Error(`not a bare column name: ${JSON.stringify(c)}`);
      }
      return `${c} = EXCLUDED.${c}`;
    })
    .join(",\n             ");
}

export const DR_WRITE_REFUSAL_REASONS = [
  "stale_observation",
  "illegal_transition",
  "row_vanished",
] as const;
export type DrWriteRefusalReason = (typeof DR_WRITE_REFUSAL_REASONS)[number];

export class DrExecutionWriteRefusedError extends Error {
  constructor(
    readonly table: string,
    readonly executionId: string,
    readonly reason: DrWriteRefusalReason,
    detail: string,
  ) {
    super(`${table}: refused write for ${executionId} (${reason}): ${detail}`);
    this.name = "DrExecutionWriteRefusedError";
  }
}

export interface GuardedUpsertDiagnosis {
  readonly schema: string;
  readonly table: string;
  readonly executionId: string;
  readonly recordedAt: string;
  /** `status` for a failover, `outcome` for a drill — what the refusal is most likely about. */
  readonly stateColumn: string;
}

/**
 * Turns the silence of `INSERT 0 0` into a named refusal, by asking the row what it holds.
 *
 * One extra statement, on the failure path only. Reading first and deciding in process is the thing
 * the guard exists to avoid, so the read happens *after* the write it explains and is used for
 * nothing but the message.
 */
export async function refuseUnlessWritten(
  tx: PgConnection,
  rowCount: number,
  d: GuardedUpsertDiagnosis,
): Promise<void> {
  if (rowCount > 0) return;
  const result = await tx.query<Record<string, unknown>>(
    `SELECT ${d.stateColumn} AS state, recorded_at
       FROM ${d.schema}.${d.table}
      WHERE execution_id = $1`,
    [d.executionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DrExecutionWriteRefusedError(
      `${d.schema}.${d.table}`,
      d.executionId,
      "row_vanished",
      "the write matched no row and no row with that execution id exists",
    );
  }
  // ADR-0331: a TIMESTAMPTZ arrives from node-postgres as a `Date`, so the comparison goes through
  // the normaliser rather than `String(value)`, which is how that defect reached a keyset cursor.
  const storedAt = isoInstant(row["recorded_at"]);
  const storedState = row["state"] === null ? null : String(row["state"]);
  // Compared as instants, not as text. `isoInstant` always renders UTC, while `recordedAt` satisfies
  // `z.string().datetime({ offset: true })` and so may legitimately carry `+02:00` — two spellings of
  // one moment that do not order lexicographically, which would name the wrong rule as the refusal.
  if (storedAt !== null && Date.parse(storedAt) > Date.parse(d.recordedAt)) {
    throw new DrExecutionWriteRefusedError(
      `${d.schema}.${d.table}`,
      d.executionId,
      "stale_observation",
      `this write was observed at ${d.recordedAt} and the stored row at ${storedAt}`,
    );
  }
  throw new DrExecutionWriteRefusedError(
    `${d.schema}.${d.table}`,
    d.executionId,
    "illegal_transition",
    `the stored ${d.stateColumn} is ${JSON.stringify(storedState)} and this write declares a change the contract forbids from it`,
  );
}
