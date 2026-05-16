import type { PgConnection } from "@crossengin/kernel-pg";
import type { ProjectedInstance } from "@crossengin/workflow-runtime";

import type {
  WorkflowDefinitionIdResolver,
  WorkflowInstanceIdResolver,
} from "./id-mapping.js";

const SCHEMA = "meta";
const TABLE = "workflow_instances";

export interface CreateInstanceInput {
  readonly projection: ProjectedInstance;
  readonly definitionId: string;
  readonly relatedEntity?: Record<string, unknown> | null;
}

export class PostgresInstanceStore {
  private readonly conn: PgConnection;
  private readonly instanceResolver: WorkflowInstanceIdResolver;
  private readonly definitionResolver: WorkflowDefinitionIdResolver;

  constructor(opts: {
    readonly conn: PgConnection;
    readonly instanceResolver: WorkflowInstanceIdResolver;
    readonly definitionResolver: WorkflowDefinitionIdResolver;
  }) {
    this.conn = opts.conn;
    this.instanceResolver = opts.instanceResolver;
    this.definitionResolver = opts.definitionResolver;
  }

  async create(input: CreateInstanceInput): Promise<string> {
    const p = input.projection;
    const definitionUuid = await this.definitionResolver.requireResolve(input.definitionId);
    const result = await this.conn.query<{ id: string }>(
      `INSERT INTO ${SCHEMA}.${TABLE} (
         instance_id, tenant_id, definition_id, definition_key, definition_version,
         status, current_state, variables, related_entity, correlation_key,
         parent_instance_id, started_at, started_by_user_id, started_by_system,
         last_transition_at, timeout_at, sequence_cursor,
         awaiting_activity_ids, awaiting_signal_names, awaiting_timer_names
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10,
         NULL, $11, $12, $13, $14, $15, $16,
         $17::jsonb, $18::jsonb, $19::jsonb
       )
       RETURNING id`,
      [
        p.instanceId,
        p.tenantId,
        definitionUuid,
        p.definitionKey,
        p.definitionVersion,
        p.status,
        p.currentState,
        JSON.stringify(p.variables),
        input.relatedEntity === null || input.relatedEntity === undefined ? null : JSON.stringify(input.relatedEntity),
        p.correlationKey,
        p.startedAt,
        p.startedByUserId,
        p.startedBySystem,
        p.lastTransitionAt,
        p.timeoutAt,
        p.sequenceCursor,
        JSON.stringify([...p.awaitingActivityIds]),
        JSON.stringify([...p.awaitingSignalNames]),
        JSON.stringify([...p.awaitingTimerNames]),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`failed to insert instance ${p.instanceId}`);
    }
    this.instanceResolver.register(p.instanceId, row.id);
    return row.id;
  }

  async upsertProjection(projection: ProjectedInstance): Promise<void> {
    const p = projection;
    await this.conn.query(
      `UPDATE ${SCHEMA}.${TABLE}
          SET status = $1,
              current_state = $2,
              variables = $3::jsonb,
              correlation_key = $4,
              last_transition_at = $5,
              completed_at = $6,
              cancelled_at = $7,
              cancelled_by_user_id = $8,
              cancelled_reason = $9,
              failed_at = $10,
              failure_code = $11,
              failure_message = $12,
              suspended_at = $13,
              suspended_reason = $14,
              compensation_started_at = $15,
              compensation_completed_at = $16,
              sequence_cursor = $17,
              awaiting_activity_ids = $18::jsonb,
              awaiting_signal_names = $19::jsonb,
              awaiting_timer_names = $20::jsonb
        WHERE instance_id = $21`,
      [
        p.status,
        p.currentState,
        JSON.stringify(p.variables),
        p.correlationKey,
        p.lastTransitionAt,
        p.completedAt,
        p.cancelledAt,
        p.cancelledByUserId,
        p.cancelledReason,
        p.failedAt,
        p.failureCode,
        p.failureMessage,
        p.suspendedAt,
        p.suspendedReason,
        p.compensationStartedAt,
        p.compensationCompletedAt,
        p.sequenceCursor,
        JSON.stringify([...p.awaitingActivityIds]),
        JSON.stringify([...p.awaitingSignalNames]),
        JSON.stringify([...p.awaitingTimerNames]),
        p.instanceId,
      ],
    );
  }
}
