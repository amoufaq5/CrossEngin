import type { PgConnection } from "@crossengin/kernel-pg";
import type { ActivityKind, ActivityStatus, RetryPolicy } from "@crossengin/workflow-engine";

import type { WorkflowInstanceIdResolver } from "./id-mapping.js";

const SCHEMA = "meta";
const TABLE = "workflow_activities";

/**
 * Six of these fields were absent until ADR-0332's sweep: `label`, `maxAttempts`, `retryPolicy`,
 * `timeoutSeconds`, `timeoutAt` and `sequenceCursor` are all NOT NULL with no default in
 * `META_WORKFLOW_ACTIVITIES`, so every `ProjectingEventLog` append that scheduled an activity threw
 * against a real database. The offline fake asserts SQL shape and cannot see a column the statement
 * never names, which is why the whole suite passed. Each is resolved or derived in
 * `activity-provenance.ts`, where the argument for each one lives.
 */
export interface ActivityProjection {
  readonly id: string;
  readonly instanceId: string;
  readonly tenantId: string;
  readonly kind: ActivityKind;
  readonly definitionActivityKey: string;
  readonly label: string;
  readonly status: ActivityStatus;
  readonly attemptNumber: number;
  readonly maxAttempts: number;
  readonly retryPolicy: RetryPolicy;
  readonly scheduledAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly timeoutSeconds: number;
  readonly timeoutAt: string;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly inputSha256: string | null;
  readonly outputSha256: string | null;
  readonly sequenceCursor: number;
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
         label, status, attempt_number, max_attempts, retry_policy, scheduled_at,
         started_at, completed_at, timeout_seconds, timeout_at,
         input_sha256, output_sha256, error_code, error_message, sequence_cursor
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
         $17, $18, $19, $20
       )
       ON CONFLICT (activity_id) DO UPDATE
         SET status = EXCLUDED.status,
             attempt_number = EXCLUDED.attempt_number,
             started_at = EXCLUDED.started_at,
             completed_at = EXCLUDED.completed_at,
             input_sha256 = EXCLUDED.input_sha256,
             output_sha256 = EXCLUDED.output_sha256,
             error_code = EXCLUDED.error_code,
             error_message = EXCLUDED.error_message`,
      [
        projection.id,
        instanceUuid,
        projection.tenantId,
        projection.definitionActivityKey,
        projection.kind,
        projection.label,
        projection.status,
        projection.attemptNumber,
        projection.maxAttempts,
        // `JSONB`: node-postgres serialises a plain object, and the column is the contract's
        // `RetryPolicySchema` rather than free-form — see `renderRetryPolicy`.
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
