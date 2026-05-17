import type { PgConnection } from "@crossengin/kernel-pg";
import type { EventLog } from "@crossengin/workflow-runtime";
import type { WorkflowEvent } from "@crossengin/workflow-engine";

import type { WorkflowInstanceIdResolver } from "./id-mapping.js";

const SCHEMA = "meta";
const TABLE = "workflow_events";

interface Row {
  readonly event_id: string;
  readonly tenant_id: string;
  readonly sequence_number: number;
  readonly kind: string;
  readonly occurred_at: string;
  readonly actor_principal_id: string | null;
  readonly actor_system_id: string | null;
  readonly previous_state: string | null;
  readonly new_state: string | null;
  readonly activity_id: string | null;
  readonly signal_id: string | null;
  readonly timer_id: string | null;
  readonly child_instance_id: string | null;
  readonly variable_name: string | null;
  readonly payload: unknown;
  readonly correlation_id: string | null;
  readonly causation_event_id: string | null;
  readonly instance_text_id: string;
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  return {};
}

function rowToEvent(row: Row): WorkflowEvent {
  return {
    id: row.event_id,
    instanceId: row.instance_text_id,
    tenantId: row.tenant_id,
    sequenceNumber: row.sequence_number,
    kind: row.kind as WorkflowEvent["kind"],
    occurredAt: row.occurred_at,
    actorPrincipalId: row.actor_principal_id,
    actorSystemId: row.actor_system_id,
    previousState: row.previous_state,
    newState: row.new_state,
    activityId: row.activity_id,
    signalId: row.signal_id,
    timerId: row.timer_id,
    childInstanceId: row.child_instance_id,
    variableName: row.variable_name,
    payload: parsePayload(row.payload),
    correlationId: row.correlation_id,
    causationEventId: row.causation_event_id,
  };
}

export interface PostgresEventLogOptions {
  readonly conn: PgConnection;
  readonly instanceResolver: WorkflowInstanceIdResolver;
}

export class PostgresEventLog implements EventLog {
  private readonly conn: PgConnection;
  private readonly resolver: WorkflowInstanceIdResolver;

  constructor(opts: PostgresEventLogOptions) {
    this.conn = opts.conn;
    this.resolver = opts.instanceResolver;
  }

  async append(event: WorkflowEvent): Promise<void> {
    const instanceUuid = await this.resolver.requireResolve(event.instanceId);
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (
         event_id, instance_id, tenant_id, sequence_number, kind, occurred_at,
         actor_principal_id, actor_system_id, previous_state, new_state,
         activity_id, signal_id, timer_id, child_instance_id, variable_name,
         payload, correlation_id, causation_event_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18)`,
      [
        event.id,
        instanceUuid,
        event.tenantId,
        event.sequenceNumber,
        event.kind,
        event.occurredAt,
        event.actorPrincipalId,
        event.actorSystemId,
        event.previousState,
        event.newState,
        event.activityId,
        event.signalId,
        event.timerId,
        event.childInstanceId,
        event.variableName,
        JSON.stringify(event.payload),
        event.correlationId,
        event.causationEventId,
      ],
    );
  }

  async appendBatch(events: readonly WorkflowEvent[]): Promise<void> {
    for (const event of events) {
      await this.append(event);
    }
  }

  async listByInstance(instanceId: string): Promise<readonly WorkflowEvent[]> {
    const instanceUuid = await this.resolver.resolve(instanceId);
    if (instanceUuid === null) return [];
    const result = await this.conn.query<Row>(
      `SELECT e.event_id, e.tenant_id, e.sequence_number, e.kind, e.occurred_at,
              e.actor_principal_id, e.actor_system_id, e.previous_state, e.new_state,
              e.activity_id, e.signal_id, e.timer_id, e.child_instance_id, e.variable_name,
              e.payload, e.correlation_id, e.causation_event_id,
              $1::TEXT AS instance_text_id
         FROM ${SCHEMA}.${TABLE} e
        WHERE e.instance_id = $2
        ORDER BY e.sequence_number ASC`,
      [instanceId, instanceUuid],
    );
    return result.rows.map(rowToEvent);
  }

  async latestSequence(instanceId: string): Promise<number | null> {
    const instanceUuid = await this.resolver.resolve(instanceId);
    if (instanceUuid === null) return null;
    const result = await this.conn.query<{ max: number | null }>(
      `SELECT MAX(sequence_number) AS max FROM ${SCHEMA}.${TABLE} WHERE instance_id = $1`,
      [instanceUuid],
    );
    const row = result.rows[0];
    if (row === undefined || row.max === null) return null;
    return row.max;
  }

  async count(): Promise<number> {
    const result = await this.conn.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM ${SCHEMA}.${TABLE}`,
    );
    const row = result.rows[0];
    return row === undefined ? 0 : Number.parseInt(row.count, 10);
  }
}
