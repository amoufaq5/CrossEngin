import type { PgConnection } from "@crossengin/kernel-pg";
import {
  applyFaxObservation,
  type FaxObservationDisposition,
  type FaxObservationOutcome,
  type VoiceReachabilityObservation,
} from "@crossengin/notification-providers";
import { withTenantContext } from "@crossengin/operate-runtime-pg";

/**
 * The durable half of ADR-0310's open `fax` verdict: the consecutive count ADR-0329 said closing it
 * would need, kept where a count can be kept safely.
 *
 * `applyFaxObservation` is the readable statement of the rule. This performs it in **one** statement
 * instead of reading, deciding and writing, for the reason ADR-0330 gave `PostgresReadStateStore`
 * and ADR-0321 gave `transition`: the row is the lock. A read-modify-write here loses to a
 * concurrent callback in the direction that *advances* a run, which is the direction that eventually
 * writes a permanent suppression — so the decision has to be taken by the `UPDATE` itself, where
 * Postgres serialises it. A test pins the two against each other over a live database, so the
 * version somebody can read and the version that runs cannot drift.
 *
 * Three rules are in the SQL, in this order, and the order is `applyFaxObservation`'s:
 *
 *   1. **A repeated `CallSid` does not advance.** Twilio retries a callback that did not answer 2xx,
 *      and nothing else about a counter is idempotent. Checked first so that a retry arriving after
 *      the window has lapsed is still read as a retry rather than as a fresh run of one.
 *   2. **A run older than the window restarts at one.** A number is reassigned; two verdicts four
 *      months apart are not evidence about the same device.
 *   3. **Otherwise it advances.**
 *
 * `clearRun` is the other direction and is why the parser reports `voice_answered` at all: a single
 * answered call refutes the inference outright, so the run is deleted rather than decremented. A
 * delete and not a zero, because an absent row and a run of zero mean exactly the same thing and one
 * of them does not need storing — and because a number that has been answered has nothing left for
 * an operator to look at.
 */

export interface FaxObservationStoreOptions {
  readonly schema?: string;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The stored run, as a reader sees it. */
export interface FaxObservationRow {
  readonly tenantId: string;
  readonly recipientAddress: string;
  readonly consecutiveCount: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly lastCallSid: string | null;
  readonly lastDisposition: FaxObservationDisposition;
  /** When a run first crossed a configured threshold, or null if it never has. */
  readonly suppressedAt: string | null;
}

export interface FaxObservationWriteResult extends FaxObservationOutcome {
  readonly recipientAddress: string;
  /** Already non-null when this observation was not the crossing that set it. */
  readonly suppressedAt: string | null;
}

interface ObserveRow {
  readonly consecutive_count: unknown;
  readonly suppressed_at: unknown;
  readonly disposition: unknown;
}

/**
 * `TIMESTAMPTZ` comes back from node-postgres as a `Date` and `INTEGER` as a number, but
 * `count(*)`-shaped and `BIGINT` columns come back as strings (ADR-0331) — so nothing here reads a
 * column's JavaScript type on faith.
 */
function intOf(value: unknown, column: string): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`fax observation column ${column} is not an integer: ${String(value)}`);
  }
  return parsed;
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function isoOf(value: unknown, column: string): string {
  const iso = isoOrNull(value);
  if (iso === null) throw new Error(`fax observation column ${column} is null`);
  return iso;
}

function dispositionOf(value: unknown): FaxObservationDisposition {
  const raw = String(value);
  if (raw === "started" || raw === "advanced" || raw === "restarted" || raw === "duplicate") {
    return raw;
  }
  throw new Error(`fax observation returned an unknown disposition: ${raw}`);
}

/**
 * Postgres-backed counter for `meta.notification_fax_observations`.
 *
 * The table carries tenant RLS, so every method runs inside `withTenantContext` *and* binds
 * `tenant_id` explicitly — the table's owner bypasses its policies, so the explicit predicate is the
 * only part that holds for owner and non-owner alike (`PostgresSuppressionStore`'s rule, same
 * reasoning). An observation whose tenant is not the context's is refused before any SQL runs.
 */
export class PostgresFaxObservationStore {
  private readonly conn: PgConnection;
  private readonly qualified: string;

  constructor(conn: PgConnection, options: FaxObservationStoreOptions = {}) {
    const schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.qualified = `"${schema}"."notification_fax_observations"`;
  }

  /**
   * Counts one `fax_detected` and reports where the run now stands.
   *
   * The `CASE` arms repeat the condition rather than sharing it through a lateral or a CTE on
   * purpose: an `ON CONFLICT … DO UPDATE` arm cannot refer to another arm's result, and splitting
   * this into two statements would reintroduce exactly the window the single statement closes.
   * `disposition` is computed by the same arms, so the outcome reported is the branch that actually
   * ran rather than a second guess at it afterwards.
   */
  async observe(
    tenantId: string,
    observation: VoiceReachabilityObservation,
    at: Date,
    windowHours: number,
  ): Promise<FaxObservationWriteResult> {
    if (!UUID_RE.test(tenantId)) {
      throw new Error("fax observation tenantId must be a UUID");
    }
    if (observation.signal !== "fax_detected") {
      // The two signals are not two shapes of the same write — one counts and one clears — so the
      // wrong one arriving here is a caller bug rather than something to silently route.
      throw new Error(`observe expects fax_detected, got ${observation.signal}`);
    }
    if (!Number.isFinite(windowHours) || windowHours <= 0) {
      throw new Error(`fax observation windowHours must be positive, got ${String(windowHours)}`);
    }
    const t = this.qualified;
    /*
     * `$5` is the window in hours. `make_interval` rather than concatenating an `interval` literal:
     * the figure comes from configuration, and a literal assembled by concatenation is an injection
     * site in a statement that is otherwise fully parameterised.
     *
     * `last_disposition` is a stored column rather than something derived in `RETURNING`, because
     * `RETURNING` sees the *new* row and every one of these three branches is a statement about the
     * old one — so the branch has to be recorded by the arm that took it. It also makes the row
     * self-describing: "this run's last observation was a retried callback" is readable without
     * reconstructing it from two timestamps.
     */
    const stale = `${t}.last_observed_at < $3::timestamptz - make_interval(hours => $5::int)`;
    const retry = `${t}.last_call_sid = $4`;
    const sql =
      `INSERT INTO ${t} (tenant_id, recipient_address, consecutive_count,` +
      ` first_observed_at, last_observed_at, last_call_sid, last_disposition)` +
      ` VALUES ($1::uuid, $2, 1, $3::timestamptz, $3::timestamptz, $4, 'started')` +
      ` ON CONFLICT (tenant_id, recipient_address) DO UPDATE SET` +
      `   consecutive_count = CASE WHEN ${retry} THEN ${t}.consecutive_count` +
      `     WHEN ${stale} THEN 1 ELSE ${t}.consecutive_count + 1 END,` +
      `   first_observed_at = CASE WHEN ${retry} THEN ${t}.first_observed_at` +
      `     WHEN ${stale} THEN $3::timestamptz ELSE ${t}.first_observed_at END,` +
      `   last_observed_at = CASE WHEN ${retry} THEN ${t}.last_observed_at` +
      `     ELSE GREATEST(${t}.last_observed_at, $3::timestamptz) END,` +
      `   last_disposition = CASE WHEN ${retry} THEN 'duplicate'` +
      `     WHEN ${stale} THEN 'restarted' ELSE 'advanced' END,` +
      `   last_call_sid = $4` +
      ` WHERE ${t}.tenant_id = $1::uuid` +
      ` RETURNING consecutive_count, suppressed_at, last_disposition AS disposition`;
    const result = await withTenantContext(this.conn, tenantId, async (tx) =>
      tx.query<ObserveRow>(sql, [
        tenantId,
        observation.address,
        at.toISOString(),
        observation.callSid,
        Math.round(windowHours),
      ]),
    );
    const row = result.rows[0];
    if (row === undefined) {
      // Under RLS as a non-owner role an `ON CONFLICT DO UPDATE` whose `WHERE` the policy also
      // confines returns nothing, and the insert path cannot have been taken. Throwing beats
      // reporting a count: a caller handed a fabricated run could cross a threshold on it.
      throw new Error(
        "fax observation write returned no row; the session's RLS context cannot see it",
      );
    }
    return {
      recipientAddress: observation.address,
      consecutiveCount: intOf(row.consecutive_count, "consecutive_count"),
      disposition: dispositionOf(row.disposition),
      suppressedAt: isoOrNull(row.suppressed_at),
    };
  }

  /**
   * Records that a run justified a suppression. Idempotent, and never moves an existing stamp.
   *
   * `COALESCE` rather than an unconditional assignment, following `requestJobCancellation`'s rule
   * (ADR-0315): the field answers "when did this address first cross the threshold", and a run that
   * keeps growing past it re-plans the identical suppression every time — so an unconditional stamp
   * would walk forward on every later call and the row would stop being able to say when the block
   * was imposed.
   */
  async markSuppressed(tenantId: string, address: string, at: Date): Promise<void> {
    if (!UUID_RE.test(tenantId)) {
      throw new Error("fax observation tenantId must be a UUID");
    }
    await withTenantContext(this.conn, tenantId, async (tx) =>
      tx.query(
        `UPDATE ${this.qualified} SET suppressed_at = COALESCE(suppressed_at, $3::timestamptz)` +
          ` WHERE tenant_id = $1::uuid AND recipient_address = $2`,
        [tenantId, address, at.toISOString()],
      ),
    );
  }

  /**
   * Deletes the run for an address, because something answered the call that can hear speech.
   *
   * Reports whether a run existed, so a caller can log a reset that actually undid accumulated
   * evidence distinctly from the overwhelmingly common no-op.
   */
  async clearRun(tenantId: string, address: string): Promise<boolean> {
    if (!UUID_RE.test(tenantId)) {
      throw new Error("fax observation tenantId must be a UUID");
    }
    const result = await withTenantContext(this.conn, tenantId, async (tx) =>
      tx.query(
        `DELETE FROM ${this.qualified} WHERE tenant_id = $1::uuid AND recipient_address = $2`,
        [tenantId, address],
      ),
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** The stored run for one address, for an operator asking why a number was suppressed. */
  async load(tenantId: string, address: string): Promise<FaxObservationRow | null> {
    if (!UUID_RE.test(tenantId)) {
      throw new Error("fax observation tenantId must be a UUID");
    }
    const result = await withTenantContext(this.conn, tenantId, async (tx) =>
      tx.query<Record<string, unknown>>(
        `SELECT tenant_id, recipient_address, consecutive_count, first_observed_at,` +
          ` last_observed_at, last_call_sid, last_disposition, suppressed_at` +
          ` FROM ${this.qualified}` +
          ` WHERE tenant_id = $1::uuid AND recipient_address = $2`,
        [tenantId, address],
      ),
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      tenantId: String(row["tenant_id"]),
      recipientAddress: String(row["recipient_address"]),
      consecutiveCount: intOf(row["consecutive_count"], "consecutive_count"),
      firstObservedAt: isoOf(row["first_observed_at"], "first_observed_at"),
      lastObservedAt: isoOf(row["last_observed_at"], "last_observed_at"),
      lastCallSid: row["last_call_sid"] == null ? null : String(row["last_call_sid"]),
      lastDisposition: dispositionOf(row["last_disposition"]),
      suppressedAt: isoOrNull(row["suppressed_at"]),
    };
  }
}

/**
 * The store's rule, restated over a loaded row.
 *
 * Exported so a test can assert that the SQL above and `applyFaxObservation` agree on the same
 * inputs, which is the only thing that keeps the readable rule and the race-free one one rule.
 */
export function expectedOutcomeFor(
  existing: FaxObservationRow | null,
  observedAt: Date,
  callSid: string,
  windowHours: number,
): FaxObservationOutcome {
  return applyFaxObservation({
    existing:
      existing === null
        ? null
        : {
            consecutiveCount: existing.consecutiveCount,
            lastObservedAt: existing.lastObservedAt,
            lastCallSid: existing.lastCallSid,
          },
    observedAt,
    callSid,
    windowHours,
  });
}
