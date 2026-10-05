import type { PgConnection } from "@crossengin/kernel-pg";
import {
  DrDrillExecutionRecordSchema,
  scopedWrite,
  type DrDrillExecutionRecord,
} from "./records.js";
import {
  drillUpsertGuard,
  excludedSetClause,
  refuseUnlessWritten,
} from "./upsert-guard.js";
import { scopeFilter, type DrReadScope } from "./tenant-context.js";

const SCHEMA = "meta";
const TABLE = "dr_drill_executions";

const COLUMNS = `execution_id, tenant_id, kind, tier, outcome, passing,
  rpo_breached, rto_breached, scheduled_for, executed_at, record, recorded_at`;

/**
 * The columns `recordDrillResult` may move, and nothing else.
 *
 * Derived by walking `DRILL_OUTCOMES` — there is no `DRILL_TRANSITIONS` map to walk — and asking the
 * executor what each outcome changes: the outcome itself, `executed_at` (and `executedBy`, which has
 * no column), the measurements that feed `passing`/`rpo_breached`/`rto_breached`, the findings and
 * `reportUrl` inside `record`, and `recorded_at` for the observation.
 *
 * Immutable and absent: `execution_id`, `tenant_id`, `kind`, `tier` and `scheduled_for` — a drill's
 * *booking*. `recordDrillResult` is handed a planned record and records what happened; it does not
 * re-book the drill, so a replayed write must not be able to move when it was scheduled for. That
 * matters directly: `drillCadenceMet` and `isOverdue` are read off those fields.
 */
export const DRILL_MUTABLE_COLUMNS = Object.freeze([
  "outcome",
  "passing",
  "rpo_breached",
  "rto_breached",
  "executed_at",
  "record",
  "recorded_at",
] as const);

export class PostgresDrDrillStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  /**
   * Writes one observation of a drill, amending the row when the contract permits it.
   *
   * Under `DO NOTHING` a second `recordDrillResult` — a late `reportUrl`, a finding added at review,
   * or a planned drill being executed — was dropped and reported as success.
   */
  async record(record: DrDrillExecutionRecord): Promise<void> {
    const valid = DrDrillExecutionRecordSchema.parse(record);
    await scopedWrite(this.conn, valid.tenantId, async (tx) => {
      const result = await tx.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
         ON CONFLICT (execution_id) DO UPDATE
           SET ${excludedSetClause(DRILL_MUTABLE_COLUMNS)}
           WHERE ${drillUpsertGuard(TABLE)}`,
        [
          valid.executionId,
          valid.tenantId,
          valid.kind,
          valid.tier,
          valid.outcome,
          valid.passing,
          valid.rpoBreached,
          valid.rtoBreached,
          valid.scheduledFor,
          valid.executedAt,
          JSON.stringify(valid.record),
          valid.recordedAt,
        ],
      );
      await refuseUnlessWritten(tx, result.rowCount, {
        schema: SCHEMA,
        table: TABLE,
        executionId: valid.executionId,
        recordedAt: valid.recordedAt,
        stateColumn: "outcome",
        tenantId: valid.tenantId,
      });
    });
  }

  /**
   * `scope` is required and first. Unscoped, this is the read that mattered most of the three:
   * `assessDrReadiness` scores **drill recency** from it, so an owner-connected deployment was in
   * cadence because *some other tenant* had run a drill recently.
   */
  async listRecent(
    scope: DrReadScope,
    limit = 100,
  ): Promise<readonly DrDrillExecutionRecord[]> {
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
): DrDrillExecutionRecord {
  return DrDrillExecutionRecordSchema.parse({
    executionId: asString(row["execution_id"]),
    tenantId: asNullableString(row["tenant_id"]),
    kind: asString(row["kind"]),
    tier: asString(row["tier"]),
    outcome: asNullableString(row["outcome"]),
    passing: asNullableBool(row["passing"]),
    rpoBreached: asNullableBool(row["rpo_breached"]),
    rtoBreached: asNullableBool(row["rto_breached"]),
    scheduledFor: asIso(row["scheduled_for"]),
    executedAt: asNullableIso(row["executed_at"]),
    record: asRecord(row["record"]),
    recordedAt: asIso(row["recorded_at"]),
  });
}
