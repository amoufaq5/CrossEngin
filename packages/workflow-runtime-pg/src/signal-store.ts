import type { PgConnection } from "@crossengin/kernel-pg";
import type { SignalStatus } from "@crossengin/workflow-engine";

import type { WorkflowInstanceIdResolver } from "./id-mapping.js";

const SCHEMA = "meta";
const TABLE = "workflow_signals";

export interface SignalProjection {
  readonly id: string;
  readonly instanceId: string | null;
  readonly tenantId: string;
  readonly signalName: string;
  readonly correlationKey: string;
  readonly status: SignalStatus;
  readonly receivedAt: string;
  readonly matchedAt: string | null;
  readonly consumedAt: string | null;
}

export class PostgresSignalStore {
  private readonly conn: PgConnection;
  private readonly instanceResolver: WorkflowInstanceIdResolver;

  constructor(opts: {
    readonly conn: PgConnection;
    readonly instanceResolver: WorkflowInstanceIdResolver;
  }) {
    this.conn = opts.conn;
    this.instanceResolver = opts.instanceResolver;
  }

  async upsert(projection: SignalProjection): Promise<void> {
    const instanceUuid =
      projection.instanceId === null
        ? null
        : await this.instanceResolver.requireResolve(projection.instanceId);
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (
         signal_id, instance_id, tenant_id, signal_name, correlation_key,
         status, received_at, matched_at, consumed_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (signal_id) DO UPDATE
         SET status = EXCLUDED.status,
             matched_at = EXCLUDED.matched_at,
             consumed_at = EXCLUDED.consumed_at,
             instance_id = COALESCE(EXCLUDED.instance_id, ${SCHEMA}.${TABLE}.instance_id)`,
      [
        projection.id,
        instanceUuid,
        projection.tenantId,
        projection.signalName,
        projection.correlationKey,
        projection.status,
        projection.receivedAt,
        projection.matchedAt,
        projection.consumedAt,
      ],
    );
  }

  async upsertMany(projections: readonly SignalProjection[]): Promise<void> {
    for (const p of projections) {
      await this.upsert(p);
    }
  }
}
