import type { PgConnection } from "@crossengin/kernel-pg";
import type {
  WorkflowInstrumentation,
  WorkflowInstrumentationEvent,
} from "@crossengin/workflow-runtime";

import {
  WorkflowDefinitionIdResolver,
  WorkflowInstanceIdResolver,
} from "./id-mapping.js";

const SCHEMA = "meta";
const TABLE = "workflow_traces";

export interface PostgresWorkflowInstrumentationOptions {
  readonly conn: PgConnection;
  readonly instanceResolver?: WorkflowInstanceIdResolver;
  readonly definitionResolver?: WorkflowDefinitionIdResolver;
}

export class PostgresWorkflowInstrumentation implements WorkflowInstrumentation {
  private readonly conn: PgConnection;
  private readonly instanceResolver: WorkflowInstanceIdResolver;
  private readonly definitionResolver: WorkflowDefinitionIdResolver;

  constructor(opts: PostgresWorkflowInstrumentationOptions) {
    this.conn = opts.conn;
    this.instanceResolver =
      opts.instanceResolver ?? new WorkflowInstanceIdResolver(opts.conn);
    this.definitionResolver =
      opts.definitionResolver ?? new WorkflowDefinitionIdResolver(opts.conn);
  }

  async onEvent(event: WorkflowInstrumentationEvent): Promise<void> {
    const instanceUuid =
      event.instanceId === null
        ? null
        : await this.instanceResolver.resolve(event.instanceId);
    const definitionUuid =
      event.definitionId === null
        ? null
        : await this.definitionResolver.resolve(event.definitionId);
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (
         tenant_id, instance_id, definition_id, kind,
         occurred_at, duration_ms, correlation_id, attributes
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        event.tenantId,
        instanceUuid,
        definitionUuid,
        event.kind,
        event.occurredAt,
        event.durationMs,
        event.correlationId,
        JSON.stringify(event.attributes),
      ],
    );
  }
}
