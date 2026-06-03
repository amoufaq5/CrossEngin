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
