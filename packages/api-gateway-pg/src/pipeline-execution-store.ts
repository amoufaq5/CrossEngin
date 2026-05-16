import type { PipelineExecution } from "@crossengin/api-gateway";
import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA = "meta";
const TABLE = "gateway_pipeline_executions";

export class PostgresPipelineExecutionStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async record(execution: PipelineExecution): Promise<void> {
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (
         request_id, tenant_id, started_at, completed_at, total_duration_ms,
         final_stage, final_outcome, final_response_status, stages,
         auth_outcome, route_match_outcome, idempotency_outcome,
         principal_id, route_operation_id, resolved_api_version,
         correlation_id, rate_limit_decision_id, bytes_in, bytes_out
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (request_id) DO NOTHING`,
      [
        execution.requestId,
        execution.tenantId,
        execution.startedAt,
        execution.completedAt,
        execution.totalDurationMs,
        execution.finalStage,
        execution.finalOutcome,
        execution.finalResponseStatus,
        JSON.stringify(execution.stages),
        execution.authOutcome,
        execution.routeMatchOutcome,
        execution.idempotencyOutcome,
        execution.principalId,
        execution.routeOperationId,
        execution.resolvedApiVersion,
        execution.correlationId,
        execution.rateLimitDecisionId,
        execution.bytesIn,
        execution.bytesOut,
      ],
    );
  }

  async countSince(since: Date): Promise<number> {
    const result = await this.conn.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM ${SCHEMA}.${TABLE} WHERE started_at >= $1`,
      [since.toISOString()],
    );
    const row = result.rows[0];
    if (row === undefined) return 0;
    return Number.parseInt(row.count, 10);
  }
}
