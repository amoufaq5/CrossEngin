import type { PipelineExecution } from "@crossengin/api-gateway";
import { setPlatformWriteSql, type PgConnection } from "@crossengin/kernel-pg";

const SCHEMA = "meta";
const TABLE = "gateway_pipeline_executions";

/**
 * The two session settings a scoped **write** needs, declared here and shared with
 * `rate-limit-checker.ts` — this package has no `records.ts` to hold them, and the two writers want
 * one copy rather than two strings that can drift.
 *
 * `app.platform_record_write`, because both tables are the deployment's own observational record: a
 * pipeline execution and a rate-limit decision say what the gateway *did*, never what it should do.
 * The grant deliberately does not reach `meta.rate_limit_policies` or `meta.quota_definitions`,
 * which say the latter and sit on `app.platform_config_write` instead.
 *
 * Until the policy split neither writer set anything at all, which worked only because a table's
 * owner bypasses its policies. As a non-owner, the old single `ALL`-scope policy admitted a
 * *platform* row unconditionally (the defect) while refusing a tenant row, since with no context
 * `current_setting('app.current_tenant_id', true)` answers NULL and the comparison is never true.
 * Both arms are needed for that reason: one because the split now demands a grant, the other
 * because nothing ever supplied the context a tenant row has always needed.
 */
export const SET_TENANT_CONTEXT_SQL =
  "SELECT set_config('app.current_tenant_id', $1, true)";

export const SET_PLATFORM_RECORD_WRITE_SQL = setPlatformWriteSql("record");

const TENANT_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

/** A tenant context, or the platform record-write elevation, never both. */
export function scopedWrite<T>(
  conn: PgConnection,
  tenantId: string | null,
  fn: (tx: PgConnection) => Promise<T>,
): Promise<T> {
  if (tenantId !== null && !TENANT_ID_RE.test(tenantId)) {
    throw new Error(`invalid tenantId for RLS context: ${JSON.stringify(tenantId)}`);
  }
  return conn.transaction(async (tx) => {
    if (tenantId === null) await tx.query(SET_PLATFORM_RECORD_WRITE_SQL);
    else await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
    return fn(tx);
  });
}

export class PostgresPipelineExecutionStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async record(execution: PipelineExecution): Promise<void> {
    await scopedWrite(this.conn, execution.tenantId, (tx) =>
      tx.query(
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
    
      ),
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
