import type { PgConnection } from "@crossengin/kernel-pg";
import {
  SloLatencyEvaluationRecordSchema,
  type SloLatencyEvaluationRecord,
} from "./records.js";

const SCHEMA = "meta";
const TABLE = "slo_latency_evaluations";

export class PostgresSloLatencyEvaluationStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async record(record: SloLatencyEvaluationRecord): Promise<void> {
    const valid = SloLatencyEvaluationRecordSchema.parse(record);
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (
         evaluation_id, tenant_id, slo_id, surface, breached,
         worst_severity, worst_threshold_id, worst_percentile, sample_count,
         breaches, evaluated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
       ON CONFLICT (evaluation_id) DO NOTHING`,
      [
        valid.evaluationId,
        valid.tenantId,
        valid.sloId,
        valid.surface,
        valid.breached,
        valid.worstSeverity,
        valid.worstThresholdId,
        valid.worstPercentile,
        valid.sampleCount,
        JSON.stringify(valid.breaches),
        valid.evaluatedAt,
      ],
    );
  }

  async listSince(
    since: Date,
    limit = 1000,
  ): Promise<readonly SloLatencyEvaluationRecord[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT evaluation_id, tenant_id, slo_id, surface, breached,
              worst_severity, worst_threshold_id, worst_percentile, sample_count,
              breaches, evaluated_at
       FROM ${SCHEMA}.${TABLE}
       WHERE evaluated_at >= $1
       ORDER BY evaluated_at DESC
       LIMIT $2`,
      [since.toISOString(), limit],
    );
    return result.rows.map((row) => rowToRecord(row));
  }

  async countBreachesSince(sloId: string, since: Date): Promise<number> {
    const result = await this.conn.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM ${SCHEMA}.${TABLE}
       WHERE slo_id = $1 AND breached = true AND evaluated_at >= $2`,
      [sloId, since.toISOString()],
    );
    const row = result.rows[0];
    if (row === undefined) return 0;
    return Number.parseInt(row.count, 10);
  }
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function rowToRecord(row: Record<string, unknown>): SloLatencyEvaluationRecord {
  const evaluatedAt = row["evaluated_at"];
  const breachesRaw = row["breaches"];
  const breaches: unknown[] = Array.isArray(breachesRaw)
    ? breachesRaw
    : typeof breachesRaw === "string"
      ? (JSON.parse(breachesRaw) as unknown[])
      : [];
  return SloLatencyEvaluationRecordSchema.parse({
    evaluationId: String(row["evaluation_id"]),
    tenantId: asNullableString(row["tenant_id"]),
    sloId: String(row["slo_id"]),
    surface: String(row["surface"]),
    breached: row["breached"] === true,
    worstSeverity: asNullableString(row["worst_severity"]),
    worstThresholdId: asNullableString(row["worst_threshold_id"]),
    worstPercentile: asNullableString(row["worst_percentile"]),
    sampleCount: Number(row["sample_count"] ?? 0),
    breaches,
    evaluatedAt:
      evaluatedAt instanceof Date ? evaluatedAt.toISOString() : String(evaluatedAt),
  });
}
