import type { PgConnection } from "@crossengin/kernel-pg";
import {
  DrFailoverExecutionRecordSchema,
  scopedWrite,
  type DrFailoverExecutionRecord,
} from "./records.js";
import {
  excludedSetClause,
  failoverUpsertGuard,
  refuseUnlessWritten,
} from "./upsert-guard.js";
import { scopeFilter, type DrReadScope } from "./tenant-context.js";

const SCHEMA = "meta";
const TABLE = "dr_failover_executions";

const COLUMNS = `execution_id, tenant_id, tier, trigger, status, from_region,
  to_region, triggered_at, completed_at, actual_rpo_seconds, actual_rto_seconds,
  rpo_breached, rto_breached, incident_ticket_id, record, recorded_at`;

/**
 * The columns a legal failover transition may move, and nothing else.
 *
 * Derived by walking `FAILOVER_TRANSITIONS` and asking the executor what each edge changes:
 * `startFailover` moves the status, `completeFailover` the status plus `completed_at` and the two
 * actuals, `failFailover` the status plus `completed_at`, `abortFailover` and `revertFailover` the
 * status (and, in the record, `revertedAt`/`revertedToFailoverId`, which have no column of their
 * own). `rpo_breached`/`rto_breached` are derived from the actuals, so they move when the actuals
 * do; `record` is the whole record, which every edge rewrites, and which is the column
 * `assessDrReadiness` actually reads. `recorded_at` is when *this* row was observed.
 *
 * Everything else is immutable by construction and deliberately absent: `execution_id` is the
 * conflict key, `tenant_id` is the scope, `tier`/`trigger`/`from_region`/`to_region` are the
 * declaration, `triggered_at` is when it was declared — and `incident_ticket_id` is immutable
 * because **no transition in the map writes it**. `planFailover` is its only producer, and the
 * schema demands one for `primary_outage`/`regional_failure`, triggers that cannot change either.
 * Including any of them would let a late or replayed write rewrite history, which is the opposite
 * defect from the one `DO NOTHING` caused. `failover-store.test.ts` re-derives this list from the
 * contract and fails if it ever gains a member the state machine cannot move.
 */
export const FAILOVER_MUTABLE_COLUMNS = Object.freeze([
  "status",
  "completed_at",
  "actual_rpo_seconds",
  "actual_rto_seconds",
  "rpo_breached",
  "rto_breached",
  "record",
  "recorded_at",
] as const);

export class PostgresDrFailoverStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  /**
   * Writes one observation of a failover, advancing the row when the contract permits it.
   *
   * Throws `DrExecutionWriteRefusedError` rather than reporting success for a write that moved
   * nothing — a refused `DO UPDATE` and the old `DO NOTHING` are the same `INSERT 0 0`, and only the
   * throw tells them apart.
   */
  async record(record: DrFailoverExecutionRecord): Promise<void> {
    const valid = DrFailoverExecutionRecordSchema.parse(record);
    await scopedWrite(this.conn, valid.tenantId, async (tx) => {
      const result = await tx.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)
         ON CONFLICT (execution_id) DO UPDATE
           SET ${excludedSetClause(FAILOVER_MUTABLE_COLUMNS)}
           WHERE ${failoverUpsertGuard(TABLE)}`,
        [
          valid.executionId,
          valid.tenantId,
          valid.tier,
          valid.trigger,
          valid.status,
          valid.fromRegion,
          valid.toRegion,
          valid.triggeredAt,
          valid.completedAt,
          valid.actualRpoSeconds,
          valid.actualRtoSeconds,
          valid.rpoBreached,
          valid.rtoBreached,
          valid.incidentTicketId,
          JSON.stringify(valid.record),
          valid.recordedAt,
        ],
      );
      await refuseUnlessWritten(tx, result.rowCount, {
        schema: SCHEMA,
        table: TABLE,
        executionId: valid.executionId,
        recordedAt: valid.recordedAt,
        stateColumn: "status",
        tenantId: valid.tenantId,
      });
    });
  }

  /**
   * `scope` is required and first, which is the point of it: this read used to take a limit alone,
   * so as the table's owner — who bypasses RLS — it returned every tenant's failovers, newest
   * first, and the limit could crowd out the scope the caller meant entirely. `dr-readiness.ts`
   * feeds the result straight into `assessDrReadiness`, so a deployment scored its DR readiness
   * off other tenants' failovers.
   */
  async listRecent(
    scope: DrReadScope,
    limit = 100,
  ): Promise<readonly DrFailoverExecutionRecord[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const filter = scopeFilter(scope);
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE ${filter.sql}
       ORDER BY recorded_at DESC
       LIMIT $${String(filter.params.length + 1)}`,
      [...filter.params, limit],
    );
    return result.rows.map((row) => rowToRecord(row));
  }

  /** Measured answering 3 where the scope's own count was 1 — a wrong scalar, not a long list. */
  async countSince(scope: DrReadScope, since: Date): Promise<number> {
    const filter = scopeFilter(scope);
    const result = await this.conn.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM ${SCHEMA}.${TABLE}` +
        ` WHERE ${filter.sql} AND recorded_at >= $${String(filter.params.length + 1)}`,
      [...filter.params, since.toISOString()],
    );
    const row = result.rows[0];
    if (row === undefined) return 0;
    return Number.parseInt(row.count, 10);
  }
}

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNullableInt(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function asNullableBool(value: unknown): boolean | null {
  return value === null || value === undefined ? null : value === true;
}

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : asString(value);
}

function asNullableIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asIso(value);
}

function asRecord(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function rowToRecord(
  row: Record<string, unknown>,
): DrFailoverExecutionRecord {
  return DrFailoverExecutionRecordSchema.parse({
    executionId: asString(row["execution_id"]),
    tenantId: asNullableString(row["tenant_id"]),
    tier: asString(row["tier"]),
    trigger: asString(row["trigger"]),
    status: asString(row["status"]),
    fromRegion: asString(row["from_region"]),
    toRegion: asString(row["to_region"]),
    triggeredAt: asIso(row["triggered_at"]),
    completedAt: asNullableIso(row["completed_at"]),
    actualRpoSeconds: asNullableInt(row["actual_rpo_seconds"]),
    actualRtoSeconds: asNullableInt(row["actual_rto_seconds"]),
    rpoBreached: asNullableBool(row["rpo_breached"]),
    rtoBreached: asNullableBool(row["rto_breached"]),
    incidentTicketId: asNullableString(row["incident_ticket_id"]),
    record: asRecord(row["record"]),
    recordedAt: asIso(row["recorded_at"]),
  });
}
