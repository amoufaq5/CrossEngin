import {
  numericIdentity,
  readRowsWithUnreadable,
  unreadableDetail,
  type PgConnection,
  type RowRead,
  type UnreadableRow,
} from "@crossengin/kernel-pg";
import { ChainCheckpointSchema, type ChainCheckpoint } from "@crossengin/forensics";

import {
  scopeFilter,
  SET_PLATFORM_AUDIT_WRITE_SQL,
  withTenantContext,
} from "./tenant-context.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const TABLE = "forensic_chain_checkpoints";

const READ_COLUMNS = `sequence_number, root_hash, checkpointed_at, checkpointed_by,
  external_anchor_reference, algorithm, provenance`;

const DEFAULT_LIST_LIMIT = 50;

/**
 * How far a checkpoint scan got, and what it found that it does not hand back row by row.
 *
 * Three fields and deliberately no fourth naming the highest sequence that parsed. The store counts
 * rows and refusals and says whether it finished; which sequences are **witnesses** is not its
 * question, because a witness is a checkpoint the chain does not contradict and this read has no
 * chain to compare against. A consumer that needs one folds the pages it is already given
 * (`auditAnchors` does), and a figure here would be a second derivation of that fact — strictly
 * redundant and strictly weaker, since it cannot exclude an anchor the chain disagrees with.
 */
export interface CheckpointScanOutcome {
  readonly scanned: number;
  readonly refusedCount: number;
  /** Whether the scan reached the end of this scope's checkpoints. */
  readonly complete: boolean;
}

export const CHECKPOINT_SCAN_PAGE_SIZE = 1_000;
export const CHECKPOINT_SCAN_CEILING = 1_000_000;

export interface CheckpointScanOptions {
  readonly ceiling?: number;
  readonly pageSize?: number;
}

/**
 * Where one page of a scan ended, as the **keyset** of its last row.
 *
 * `sequence` is the raw value node-postgres hands a `BIGINT` back as — a **string** (ADR-0331) — and
 * it is bound through a `::bigint` cast rather than passed through `Number`, which stops being the
 * stored value past 2^53 and would then either re-read a row or step over one.
 */
interface ScanCursor {
  readonly sequence: string;
  readonly id: string;
}

/**
 * The cursor the first page is read from, below every row the table can hold.
 *
 * It exists so a scan has **one** statement shape rather than a predicate-less first page and a
 * keyed one after it, and `-1` is what buys that: the column's own CHECK is `sequence_number >= 0`,
 * so `sequence_number > -1` is true of every row and the first page's predicate is the whole scope.
 * Measured on PG 16.13 the sentinel costs nothing and on the platform scope it *earns* something —
 * `tenant_id IS NULL` alone plans a `Parallel Seq Scan` (34.2 ms over 50k rows) while the sentinel's
 * `sequence_number >= -1` gives the planner an index condition and a `Bitmap Index Scan` (22.1 ms).
 *
 * The `id` half is unreachable by construction — `sequence_number = -1` is unsatisfiable under that
 * CHECK — so its value is immaterial and it is here only because the statement binds three
 * parameters.
 */
const SCAN_START_CURSOR: ScanCursor = {
  sequence: "-1",
  id: "00000000-0000-0000-0000-000000000000",
};

/**
 * Where the next page starts, read off the **raw** row rather than off the mapped record — which is
 * the whole reason a refused anchor cannot stall a scan: the row the contract rejected still carries
 * the two columns the cursor is made of, so the page after it is reachable.
 *
 * The refusal is a fence on the one premise the loop's termination rests on. Without both columns in
 * the SELECT list the cursor cannot advance, and the symptom is not a wrong answer but a scan that
 * never ends — so a `SELECT` list edited to drop either one fails here by name instead of hanging.
 *
 * It takes the row as possibly absent for the same reason rather than making its caller prove
 * otherwise: the page it is read from is known non-empty by the loop's own control flow, and folding
 * that into this one refusal keeps the fence in one place instead of adding an arm that cannot run.
 */
function cursorFrom(row: Record<string, unknown> | undefined): ScanCursor {
  const sequence = row?.["sequence_number"];
  const id = row?.["id"];
  if ((typeof sequence !== "string" && typeof sequence !== "number") || typeof id !== "string") {
    throw new Error(
      "a checkpoint scan page must select both sequence_number and id: the keyset cursor is made " +
        "of the pair, and without it the scan cannot advance past this page",
    );
  }
  return { sequence: String(sequence), id };
}

/**
 * The tiebreaker among rows at **one** sequence, which `UNIQUE (tenant_id, sequence_number)` does
 * not prevent for the platform scope: SQL treats NULLs as distinct, so `(NULL, 3)` and `(NULL, 3)`
 * are two legal rows and the `ON CONFLICT` arm below never fires for a platform checkpoint.
 * Measured live on PG 16.13 — two rows at the same platform sequence, and ten runs of the
 * untiebroken query returned the **older** one every time (ADR-0371).
 *
 * That order is the fail-open one, which is why this is a correctness fix rather than tidying: an
 * anchor's `provenance` is what a bounded proof takes its prefix on trust from, so a stale
 * `verified_full` masking a later `unverified` would license exactly the skip the provenance exists
 * to refuse. Newest-first means a later verdict about one sequence supersedes an earlier one, and
 * the direction a mistake falls in is toward re-folding. `id` is the total tiebreaker (uuidv7, so
 * time-ordered) for two rows stamped in the same transaction.
 */
const NEWEST_AT_ONE_SEQUENCE = "checkpointed_at DESC, id DESC";

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Postgres `CHAR(64)` right-pads with spaces; sha256 hex is exactly 64 chars, but trim defensively. */
export function rowToCheckpoint(row: Record<string, unknown>): ChainCheckpoint {
  const anchor = row["external_anchor_reference"];
  const algorithm = row["algorithm"];
  const provenance = row["provenance"];
  // An out-of-enum provenance is handed to the parse to refuse rather than coerced to `undefined`:
  // absent says this row's columns do not cover the question, which is false of a row that answered
  // it and said something this binary does not know.
  return ChainCheckpointSchema.parse({
    sequenceNumber: Number(row["sequence_number"] ?? 0),
    rootHash: String(row["root_hash"]).trim(),
    checkpointedAt: asIso(row["checkpointed_at"]),
    checkpointedBy: String(row["checkpointed_by"]),
    externalAnchorReference: anchor == null ? undefined : String(anchor),
    algorithm: algorithm == null ? undefined : String(algorithm),
    provenance: provenance == null ? undefined : String(provenance),
  });
}

/**
 * A stored checkpoint exists and the contract refuses it — the **third** answer `latest` owes, and
 * the one its two outcomes could not express.
 *
 * It is a throw and not a widened return, which is ADR-0373's rule rather than this module's
 * preference: a single-row read that throws is correct, because the caller asked about *that row*
 * and must not be served past it. What was wrong was the **kind** of throw — a bare `ZodError`,
 * which a caller cannot classify (`record`'s own input parse raises the same type) and whose
 * `message` is the JSON of its issues, so an `invalid_enum_value` carries the stored value into
 * whatever log line, HTTP body or incident note catches it. Measured live as a non-owner: blanking
 * `checkpointed_by` through the tenant isolation arm made the hourly integrity pass file
 * `outcome: "error"` with that JSON on the `onError` line, and nothing else.
 *
 * **`null` is refused, and the measurement is what refuses it.** `null` means *no checkpoint for
 * this scope*, which `CHAIN_FULL_REASONS` describes as a condition that "heals on the next
 * scheduler pass" — and this one cannot, because `record` is `ON CONFLICT (tenant_id,
 * sequence_number) DO NOTHING`, so a pass anchoring at the same tail answers `INSERT 0 0` and the
 * refused row stays (verified live). Reporting a self-healing condition for a permanent one is
 * ADR-0334's remedy-that-cannot-work. It is also ADR-0331's rule at this seam: *there is no row* and
 * *this binary cannot read the row there is* are different facts with different remedies, and the
 * second is the stronger of the two, because `record` begins `ChainCheckpointSchema.parse`, so no
 * write this binary performs can produce one.
 *
 * The identity is the row's `sequence_number` and no other column — `UnreadableRow`'s rule: the
 * business key is what a `WHERE` clause needs and the only handle a remedy can name, while every
 * other column of a refused row is of unestablished trustworthiness. `detail` comes from
 * `unreadableDetail`, so it names the field path and the issue code and no value from the row.
 */
export class CheckpointRowUnreadable extends Error {
  constructor(
    readonly scope: string | null,
    readonly row: UnreadableRow,
  ) {
    super(
      `the ${scope === null ? "platform" : scope} chain's checkpoint at sequence ` +
        `${row.identity ?? "<unidentified>"} is stored in a shape the contract refuses ` +
        `(${row.detail}), so nothing can be read from the anchor it is. Fold from genesis for this ` +
        `scope and go and look at that row.`,
    );
    this.name = "CheckpointRowUnreadable";
  }
}

/**
 * One spelling of the single-row read's refusal, so `latest` and `getBySequence` cannot come to
 * disagree about what one is. The identity is read **off the raw row** rather than from the mapper,
 * which is the whole reason it still answers for a row the mapper refused.
 */
function readOne(
  scope: string | null,
  row: Record<string, unknown> | undefined,
): ChainCheckpoint | null {
  if (row === undefined) return null;
  try {
    return rowToCheckpoint(row);
  } catch (err) {
    throw new CheckpointRowUnreadable(scope, {
      identity: numericIdentity(row, "sequence_number"),
      detail: unreadableDetail(err),
    });
  }
}

export interface PostgresChainCheckpointStoreOptions {
  readonly schema?: string;
}

/**
 * Persists anchored `ChainCheckpoint`s into `meta.forensic_chain_checkpoints` and reads them back scoped to
 * a tenant (or the platform, `tenantId = null`). Append-only: a re-`record` of an existing
 * `(tenant, sequence)` is a no-op (`ON CONFLICT DO NOTHING`).
 *
 * That now also means a `provenance` cannot be upgraded in place, which is the point rather than a
 * limitation: a `DO UPDATE` arm here would let an `unverified` anchor become a trusted one without
 * anything having verified the prefix — ADR-0371's defect by another route, and reachable by anyone
 * who can write a checkpoint at all. A better-verified anchor is a new checkpoint at the new tail.
 *
 * **Append-only is a property of this store and not of the table**, and the distinction is the one
 * ADR-0374 measured: `forensic_chain_checkpoints`' isolation policy is `ALL`-scope, so its `USING`
 * doubles as its `WITH CHECK` and a *tenant-context* session may `UPDATE` or `DELETE` its own
 * checkpoint row — verified live as the non-owner `serving` role. ADR-0332's split made the
 * **platform** arm append-only (a `SELECT` read and an `INSERT` write, no `UPDATE`), and nothing
 * covers the tenant arm. So the fences that hold here are the column CHECKs and the read refusals
 * below, not the policy.
 *
 * Each read therefore has a third answer, and which one it gives is decided by how many rows the
 * caller asked about (ADR-0373): `latest` and `getBySequence` throw `CheckpointRowUnreadable`,
 * because a caller asking about one row must not be served past it, while `listRecent` returns the
 * readable rows beside the refused ones, because a page that throws takes every other row's finding
 * with it.
 *
 * Scope is both an RLS elevation and a bound predicate, for the two separate reasons the chain store
 * gives: the owner bypasses RLS, so a read with no predicate crossed scopes (a tenant's
 * `latest()` could return the *platform's* newest checkpoint, which is the witness a truncation check
 * is measured against — ADR-0287); and a platform **write** needs its own elevation, because the
 * platform arm used to sit inside the tenant isolation policy where an `ALL` policy's `USING` doubles
 * as its `WITH CHECK`.
 */
export class PostgresChainCheckpointStore {
  private readonly schema: string;

  constructor(
    private readonly conn: PgConnection,
    options: PostgresChainCheckpointStoreOptions = {},
  ) {
    this.schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(this.schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(this.schema)}`);
    }
  }

  async record(tenantId: string | null, checkpoint: ChainCheckpoint): Promise<void> {
    const valid = ChainCheckpointSchema.parse(checkpoint);
    await this.scoped(tenantId, "write", (conn) =>
      conn.query(
        `INSERT INTO ${this.schema}.${TABLE}
          (tenant_id, sequence_number, root_hash, checkpointed_at, checkpointed_by,
           external_anchor_reference, algorithm, provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, sequence_number) DO NOTHING`,
        [
          tenantId,
          valid.sequenceNumber,
          valid.rootHash,
          valid.checkpointedAt,
          valid.checkpointedBy,
          valid.externalAnchorReference ?? null,
          valid.algorithm,
          valid.provenance ?? null,
        ],
      ),
    );
  }

  async latest(tenantId: string | null): Promise<ChainCheckpoint | null> {
    const scope = scopeFilter(tenantId);
    return this.scoped(tenantId, "read", async (conn) => {
      const result = await conn.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE ${scope.sql} ORDER BY sequence_number DESC, ${NEWEST_AT_ONE_SEQUENCE} LIMIT 1`,
        scope.params,
      );
      return readOne(tenantId, result.rows[0]);
    });
  }

  async getBySequence(
    tenantId: string | null,
    sequenceNumber: number,
  ): Promise<ChainCheckpoint | null> {
    const scope = scopeFilter(tenantId, 2);
    return this.scoped(tenantId, "read", async (conn) => {
      const result = await conn.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE sequence_number = $1 AND ${scope.sql} LIMIT 1`,
        [sequenceNumber, ...scope.params],
      );
      return readOne(tenantId, result.rows[0]);
    });
  }

  /**
   * The checkpoint history, newest first — the **pair** form, so a refused row comes back beside the
   * records instead of taking them with it.
   *
   * It was `result.rows.map(rowToCheckpoint)`, which is ADR-0373's defect exactly: the mapper ends
   * in a `.parse`, so one refused row threw the whole page out and every other row's finding with
   * it. The two single-row reads above are *right* to throw and this one is not, which is the
   * distinction that increment is about.
   *
   * **The pair form rather than a reporter**, and that was decided by looking for the consumer and
   * finding none — this method has zero non-test callers. So it is decided by the store's
   * character: both of `latest`'s consumers are **verifiers** (`verifyChainFromCheckpoint` and
   * `proveScopeIntegrity`'s truncation check), and this table's whole purpose is to witness a
   * verification, so the caller this will gain is one computing a verdict — where the refused row is
   * part of the answer and not a note on the side. The pair also makes a caller's *drop* visible: it
   * has to write `.records`, which shows up in review and in a grep, where a discarded callback does
   * not. ADR-0373's `tombstone-store::listForTenant` note is the precedent for deferring the
   * question to the caller's kind; the cost of deferring the *shape* is that nothing routes the row
   * at all, which is what this closes.
   *
   * **That prediction came true and this method was still the wrong one** (ADR-0375). The caller it
   * named arrived — an audit that cross-checks every anchor against the chain — and it could not use
   * this read: a verdict about the anchor *table* needs an ascending cursor over the whole set, and
   * this is descending with a limit, so what it returns is the newest N and no way to ask for the
   * rest. `scanCheckpoints` is that shape. The **pair form** argued for above is what each of its
   * pages hands over, so the principle is exercised and the method is not; this one is still
   * callerless, and now for a reason rather than for want of one.
   */
  async listRecent(
    tenantId: string | null,
    limit: number = DEFAULT_LIST_LIMIT,
  ): Promise<RowRead<ChainCheckpoint>> {
    const scope = scopeFilter(tenantId, 2);
    return this.scoped(tenantId, "read", async (conn) => {
      const result = await conn.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE ${scope.sql} ORDER BY sequence_number DESC, ${NEWEST_AT_ONE_SEQUENCE} LIMIT $1`,
        [limit, ...scope.params],
      );
      return readRowsWithUnreadable(result.rows, rowToCheckpoint, (row) =>
        numericIdentity(row, "sequence_number"),
      );
    });
  }

  /**
   * Every checkpoint in one scope, page by page, as the **set** a verdict about the anchor table has
   * to be computed over (ADR-0375).
   *
   * `latest` is one row, so a refused anchor is a finding only while it is the *newest*: on a scope
   * holding N checkpoints the other N−1 could be edited with no verdict change at all. That is the
   * aperture this closes, and nothing else here does — `getBySequence` needs a sequence to ask
   * about, and `listRecent` can only ever hand back the newest N.
   *
   * **Ascending, and the direction is the decision.** This table is append-only in sequence order
   * for every writer in the workspace, so an ascending prefix is *stable under appends* while a
   * descending one shifts: a descending scan that stopped at its ceiling would leave the oldest rows
   * unread and let a later append push a row out of reach, which is ADR-0374's burial at ceiling
   * depth instead of at depth 1. Ascending, what a ceiling leaves unread is the **newest** tail —
   * which `complete: false` names, and which the next pass reaches once the ceiling is raised.
   *
   * `id` is the tiebreaker for `NEWEST_AT_ONE_SEQUENCE`'s reason one read across: two rows can share
   * a platform sequence, so a sequence-only cursor would either loop on the first of them or step
   * over the second, and `(sequence_number, id)` is total because `id` is the primary key.
   *
   * `onPage` rather than a returned array, which is ADR-0367's `drainList` rule: the caller decides
   * what it holds. The consumer that wants the correspondence keeps `(sequence, rootHash)` pairs, the
   * one that wants only the refusals keeps those, and neither has to hold a million checkpoints to
   * produce one verdict. Each page is the **pair** `listRecent` argues for, because a refused anchor
   * is part of a verification's answer rather than a note beside it.
   */
  async scanCheckpoints(
    tenantId: string | null,
    onPage: (page: RowRead<ChainCheckpoint>) => void,
    opts: CheckpointScanOptions = {},
  ): Promise<CheckpointScanOutcome> {
    // `drainList`'s treatment of the two bounds, for its reasons. The page size takes a floor
    // because `0` would make `LIMIT 0` answer an empty page forever — the one way this loop could
    // fail to terminate. The ceiling takes no floor: a non-positive one is already answered by the
    // check at the top of the loop, which returns `complete: false` having read nothing, and that is
    // the honest answer for a zero budget rather than a condition to refuse by name.
    const pageSize = Math.max(1, Math.trunc(opts.pageSize ?? CHECKPOINT_SCAN_PAGE_SIZE));
    const ceiling = Math.trunc(opts.ceiling ?? CHECKPOINT_SCAN_CEILING);
    const scope = scopeFilter(tenantId, 4);

    // `sequence_number >= $1::bigint` is **implied by the disjunction beside it and is not
    // redundant to the planner**, which is the opposite of how it reads. Measured on PG 16.13 over a
    // 200k-row scope, at page 100 of a scan: without it the plan is
    // `Index Cond: (tenant_id = $1)` with the whole disjunction left as a `Filter`, so every page
    // re-reads every row before the cursor — `Rows Removed by Filter: 100001`, 2745 buffers,
    // 22.2 ms, and the full 200-page scan takes **4.86 s**, quadratic in the page count. With it the
    // plan is `Index Cond: ((tenant_id = $1) AND (sequence_number >= $2))`, `Rows Removed by
    // Filter: 1`, 31 buffers, 0.563 ms, and the full scan **0.13 s**. Identical in the generic plan.
    //
    // The disjunction is spelled out rather than written as the row comparison
    // `(sequence_number, id) > ($1, $2)` because the two are not interchangeable to a reader even
    // though they are to the planner (it truncates a row comparison to the indexable leading prefix
    // and derives the same index condition, measured at 0.551 ms on the same page). Spelled out, the
    // `id` arm is visible as the thing the platform scope's duplicate sequences need.
    const sql = `SELECT ${READ_COLUMNS}, id FROM ${this.schema}.${TABLE}
         WHERE ${scope.sql}
           AND sequence_number >= $1::bigint
           AND (sequence_number > $1::bigint
                OR (sequence_number = $1::bigint AND id > $2::uuid))
         ORDER BY sequence_number ASC, id ASC LIMIT $3`;

    // One transaction for the whole scan, and what that buys is **not** a single snapshot:
    // `PgConnection.transaction` issues a bare `BEGIN`, so the scan runs at READ COMMITTED and each
    // statement takes its own snapshot — measured inside one `transaction`, where statement 1 saw 9
    // rows, another session committed, and statement 2 saw 0. A row whose `sequence_number` is
    // edited between two pages can therefore fall between them, which is an open end of ADR-0375
    // and not a property this comment may assert away.
    //
    // What it does buy: one connection and so one scope elevation for every page, no interleaved
    // tenant context from a pooled connection serving another scope mid-scan, and one place to set
    // `REPEATABLE READ` if the exactness is ever wanted — which has to be set before the first
    // statement, so it is the reason this is a transaction at all rather than a loop of reads.
    return this.scoped(tenantId, "read", async (conn) => {
      let cursor = SCAN_START_CURSOR;
      let scanned = 0;
      let refusedCount = 0;

      // No non-advancing-cursor guard, and the reason is the predicate rather than diligence: it is
      // strictly-after on the **pair** `(sequence_number, id)`, which the row itself carries and
      // which is unique because `id` is the primary key. So a page either comes back shorter than
      // its limit — which ends the scan — or hands over a last row strictly greater than the one
      // the page began at, and the cursor advances by at least one row per page.
      //
      // Strictly-after needs **both** arms strict, and the `id` one is the arm that matters: with
      // `id >= $2` the sequence arm is still strict while the `id` arm re-admits the row the cursor
      // was taken from, so a boundary inside a run of one sequence re-reads its own last row —
      // progress drops to `pageSize - 1` a page, `scanned` over-counts, a refused row at a boundary
      // reaches `onPage` twice, and where one sequence holds `pageSize` rows the page comes back
      // full and identical for ever. That is reachable on the platform scope alone, whose duplicate
      // sequences are the very thing the tiebreaker exists for (ADR-0371), and it is fixtured.
      //
      // `drainList` needs the guard it has because a store's `nextCursor` is opaque to it; here one
      // would be a check that cannot fire, which reads as coverage it does not provide.
      for (;;) {
        if (scanned >= ceiling) {
          return { scanned, refusedCount, complete: false };
        }
        // Never read past the ceiling, so the stop is a claim about the set rather than about how
        // the ceiling divides by the page size. At least 1 by construction: the page size is
        // floored and the loop has already returned whenever `scanned >= ceiling`.
        const limit = Math.min(pageSize, ceiling - scanned);
        const result = await conn.query<Record<string, unknown>>(sql, [
          cursor.sequence,
          cursor.id,
          limit,
          ...scope.params,
        ]);
        const rows = result.rows;
        scanned += rows.length;

        const page = readRowsWithUnreadable(rows, rowToCheckpoint, (row) =>
          numericIdentity(row, "sequence_number"),
        );
        refusedCount += page.unreadable.length;
        onPage(page);

        // Short of its limit means `LIMIT` ran out of rows rather than out of budget, so the scope
        // is exhausted. Compared against `limit` and not `pageSize`: a page the ceiling trimmed can
        // be full at a smaller number, and reading that as the end would claim a complete scan the
        // ceiling stopped. A scope holding exactly `ceiling` rows therefore answers
        // `complete: false` — proving the end costs one more page and the ceiling is the budget —
        // which is the conservative direction, since the consumer reads it as *not proven*.
        if (rows.length < limit) {
          return { scanned, refusedCount, complete: true };
        }
        cursor = cursorFrom(rows[rows.length - 1]);
      }
    });
  }

  /**
   * Opens the transaction one call runs in under the elevation its scope and access need.
   *
   * A platform **read** needs none: the platform arm of the read policy is open to every scope, as
   * it has always been. A platform **write** needs `app.platform_audit_write`, and asking for it per
   * call rather than per store is what keeps a read transaction unable to insert.
   */
  private scoped<T>(
    tenantId: string | null,
    access: "read" | "write",
    fn: (conn: PgConnection) => Promise<T>,
  ): Promise<T> {
    if (tenantId !== null) return withTenantContext(this.conn, tenantId, fn);
    if (access === "read") return this.conn.transaction(fn);
    return this.conn.transaction(async (tx) => {
      await tx.query(SET_PLATFORM_AUDIT_WRITE_SQL);
      return fn(tx);
    });
  }
}
