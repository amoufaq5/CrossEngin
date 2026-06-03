import type { PgConnection } from "@crossengin/kernel-pg";
import {
  SloEvaluationRecordSchema,
  type SloEvaluationRecord,
} from "./records.js";

const SCHEMA = "meta";
const TABLE = "slo_evaluations";

export class PostgresSloEvaluationStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async record(record: SloEvaluationRecord): Promise<void> {
    const valid = SloEvaluationRecordSchema.parse(record);
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (
         evaluation_id, tenant_id, slo_id, surface, breached,
         worst_severity, worst_threshold_id, target, evaluations, evaluated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT (evaluation_id) DO NOTHING`,
      [
        valid.evaluationId,
        valid.tenantId,
        valid.sloId,
        valid.surface,
        valid.breached,
        valid.worstSeverity,
        valid.worstThresholdId,
        valid.target,
        JSON.stringify(valid.evaluations),
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
