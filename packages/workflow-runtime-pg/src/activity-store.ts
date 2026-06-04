import type { PgConnection } from "@crossengin/kernel-pg";
import type { ActivityKind, ActivityStatus, RetryPolicy } from "@crossengin/workflow-engine";

import type { WorkflowInstanceIdResolver } from "./id-mapping.js";

const SCHEMA = "meta";
const TABLE = "workflow_activities";

export interface ActivityProjection {
  readonly id: string;
  readonly instanceId: string;
  readonly tenantId: string;
  readonly kind: ActivityKind;
  readonly definitionActivityKey: string;
  readonly label: string;
  readonly status: ActivityStatus;
  readonly attemptNumber: number;
  readonly sequenceCursor: number;
  readonly maxAttempts: number;
  readonly retryPolicy: RetryPolicy;
  readonly scheduledAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly inputSha256: string | null;
  readonly outputSha256: string | null;
  readonly nextRetryAt: string | null;
  readonly timeoutSeconds: number;
  readonly timeoutAt: string;
}

export class PostgresActivityStore {
  private readonly conn: PgConnection;
  private readonly instanceResolver: WorkflowInstanceIdResolver;

  constructor(opts: {
    readonly conn: PgConnection;
    readonly instanceResolver: WorkflowInstanceIdResolver;
  }) {
    this.conn = opts.conn;
    this.instanceResolver = opts.instanceResolver;
  }

  async upsert(projection: ActivityProjection): Promise<void> {
    const instanceUuid = await this.instanceResolver.requireResolve(projection.instanceId);
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (
         activity_id, instance_id, tenant_id, definition_activity_key, kind,
         status, attempt_number, max_attempts, retry_policy, scheduled_at,
         started_at, completed_at, timeout_seconds, timeout_at,
         input_sha256, output_sha256, error_code, error_message, next_retry_at,
         label, sequence_cursor
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
       )
       ON CONFLICT (activity_id) DO UPDATE
         SET status = EXCLUDED.status,
             attempt_number = EXCLUDED.attempt_number,
             started_at = EXCLUDED.started_at,
             completed_at = EXCLUDED.completed_at,
             input_sha256 = EXCLUDED.input_sha256,
             output_sha256 = EXCLUDED.output_sha256,
             error_code = EXCLUDED.error_code,
             error_message = EXCLUDED.error_message,
             next_retry_at = EXCLUDED.next_retry_at`,
      [
        projection.id,
        instanceUuid,
        projection.tenantId,
        projection.definitionActivityKey,
        projection.kind,
        projection.status,
        projection.attemptNumber,
        projection.maxAttempts,
        JSON.stringify(projection.retryPolicy),
        projection.scheduledAt,
        projection.startedAt,
        projection.completedAt,
        projection.timeoutSeconds,
        projection.timeoutAt,
        projection.inputSha256,
        projection.outputSha256,
        projection.errorCode,
        projection.errorMessage,
        projection.nextRetryAt,
        projection.label,
        projection.sequenceCursor,
      ],
    );
  }

  async upsertMany(projections: readonly ActivityProjection[]): Promise<void> {
    for (const p of projections) {
      await this.upsert(p);
    }
  }
}
