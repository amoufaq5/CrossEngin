import type { PgConnection } from "@crossengin/kernel-pg";
import {
  SloEnforcementActionRecordSchema,
  type SloEnforcementActionRecord,
} from "./records.js";

const SCHEMA = "meta";
const TABLE = "slo_enforcement_actions";

export class PostgresSloEnforcementActionStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async record(record: SloEnforcementActionRecord): Promise<void> {
    const valid = SloEnforcementActionRecordSchema.parse(record);
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (
         action_id, tenant_id, slo_id, surface, decision, severity,
         incident_id, kill_switch_id, flag_id, paged, page_channel_count,
         threshold_id, occurred_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (action_id) DO NOTHING`,
      [
        valid.actionId,
        valid.tenantId,
        valid.sloId,
        valid.surface,
        valid.decision,
        valid.severity,
        valid.incidentId,
        valid.killSwitchId,
        valid.flagId,
        valid.paged,
        valid.pageChannelCount,
        valid.thresholdId,
        valid.occurredAt,
      ],
    );
  }

  async listForIncident(
    incidentId: string,
  ): Promise<readonly SloEnforcementActionRecord[]> {
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT action_id, tenant_id, slo_id, surface, decision, severity,
              incident_id, kill_switch_id, flag_id, paged, page_channel_count,
              threshold_id, occurred_at
       FROM ${SCHEMA}.${TABLE}
       WHERE incident_id = $1
       ORDER BY occurred_at ASC`,
      [incidentId],
    );
    return result.rows.map((row) => rowToRecord(row));
  }

  async listRecent(limit = 100): Promise<readonly SloEnforcementActionRecord[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT action_id, tenant_id, slo_id, surface, decision, severity,
              incident_id, kill_switch_id, flag_id, paged, page_channel_count,
              threshold_id, occurred_at
       FROM ${SCHEMA}.${TABLE}
       ORDER BY occurred_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => rowToRecord(row));
  }

  async countSince(since: Date): Promise<number> {
    const result = await this.conn.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM ${SCHEMA}.${TABLE} WHERE occurred_at >= $1`,
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

function rowToRecord(row: Record<string, unknown>): SloEnforcementActionRecord {
  const occurredAt = row["occurred_at"];
  return SloEnforcementActionRecordSchema.parse({
    actionId: asString(row["action_id"]),
    tenantId: asNullableString(row["tenant_id"]),
    sloId: asString(row["slo_id"]),
    surface: asString(row["surface"]),
    decision: asString(row["decision"]),
    severity: asNullableString(row["severity"]),
    incidentId: asString(row["incident_id"]),
    killSwitchId: asNullableString(row["kill_switch_id"]),
    flagId: asNullableString(row["flag_id"]),
    paged: row["paged"] === true,
    pageChannelCount: Number(row["page_channel_count"] ?? 0),
    thresholdId: asNullableString(row["threshold_id"]),
    occurredAt:
      occurredAt instanceof Date ? occurredAt.toISOString() : asString(occurredAt),
  });
}
