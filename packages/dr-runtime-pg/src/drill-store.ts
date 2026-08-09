import type { PgConnection } from "@crossengin/kernel-pg";
import {
  DrDrillExecutionRecordSchema,
  type DrDrillExecutionRecord,
} from "./records.js";

const SCHEMA = "meta";
const TABLE = "dr_drill_executions";

const COLUMNS = `execution_id, tenant_id, kind, tier, outcome, passing,
  rpo_breached, rto_breached, scheduled_for, executed_at, record, recorded_at`;

export class PostgresDrDrillStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async record(record: DrDrillExecutionRecord): Promise<void> {
    const valid = DrDrillExecutionRecordSchema.parse(record);
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
       ON CONFLICT (execution_id) DO NOTHING`,
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
  }

  async listRecent(limit = 100): Promise<readonly DrDrillExecutionRecord[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM ${SCHEMA}.${TABLE}
       ORDER BY recorded_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => rowToRecord(row));
  }

  async countSince(since: Date): Promise<number> {
    const result = await this.conn.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM ${SCHEMA}.${TABLE} WHERE recorded_at >= $1`,
      [since.toISOString()],
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
