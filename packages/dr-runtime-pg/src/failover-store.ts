import type { PgConnection } from "@crossengin/kernel-pg";
import {
  DrFailoverExecutionRecordSchema,
  type DrFailoverExecutionRecord,
} from "./records.js";

const SCHEMA = "meta";
const TABLE = "dr_failover_executions";

const COLUMNS = `execution_id, tenant_id, tier, trigger, status, from_region,
  to_region, triggered_at, completed_at, actual_rpo_seconds, actual_rto_seconds,
  rpo_breached, rto_breached, incident_ticket_id, record, recorded_at`;

export class PostgresDrFailoverStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async record(record: DrFailoverExecutionRecord): Promise<void> {
    const valid = DrFailoverExecutionRecordSchema.parse(record);
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)
       ON CONFLICT (execution_id) DO NOTHING`,
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
  }

  async listRecent(limit = 100): Promise<readonly DrFailoverExecutionRecord[]> {
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
