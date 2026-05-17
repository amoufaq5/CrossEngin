import type { PgConnection } from "@crossengin/kernel-pg";
import type { ActivityKind, ActivityStatus } from "@crossengin/workflow-engine";

import type { WorkflowInstanceIdResolver } from "./id-mapping.js";

const SCHEMA = "meta";
const TABLE = "workflow_activities";

export interface ActivityProjection {
  readonly id: string;
  readonly instanceId: string;
  readonly tenantId: string;
  readonly kind: ActivityKind;
  readonly definitionActivityKey: string;
  readonly status: ActivityStatus;
  readonly attemptNumber: number;
  readonly scheduledAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly inputSha256: string | null;
  readonly outputSha256: string | null;
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
         status, attempt_number, scheduled_at, started_at, completed_at,
         input_sha256, output_sha256, error_code, error_message
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
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
        projection.status,
        projection.attemptNumber,
        projection.scheduledAt,
        projection.startedAt,
        projection.completedAt,
        projection.inputSha256,
        projection.outputSha256,
        projection.errorCode,
        projection.errorMessage,
      ],
    );
  }

  async upsertMany(projections: readonly ActivityProjection[]): Promise<void> {
    for (const p of projections) {
      await this.upsert(p);
    }
  }
}
