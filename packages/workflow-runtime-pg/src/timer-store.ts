import type { PgConnection } from "@crossengin/kernel-pg";
import type { TimerStatus } from "@crossengin/workflow-engine";

import type { WorkflowInstanceIdResolver } from "./id-mapping.js";

const SCHEMA = "meta";
const TABLE = "workflow_timers";

export interface TimerProjection {
  readonly id: string;
  readonly instanceId: string;
  readonly tenantId: string;
  readonly timerName: string;
  readonly status: TimerStatus;
  readonly scheduledAt: string;
  readonly fireAt: string;
  readonly firedAt: string | null;
  readonly cancelledAt: string | null;
}

export class PostgresTimerStore {
  private readonly conn: PgConnection;
  private readonly instanceResolver: WorkflowInstanceIdResolver;

  constructor(opts: {
    readonly conn: PgConnection;
    readonly instanceResolver: WorkflowInstanceIdResolver;
  }) {
    this.conn = opts.conn;
    this.instanceResolver = opts.instanceResolver;
  }

  async upsert(projection: TimerProjection): Promise<void> {
    const instanceUuid = await this.instanceResolver.requireResolve(projection.instanceId);
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (
         timer_id, instance_id, tenant_id, timer_name, status, scheduled_at,
         fire_at, fired_at, cancelled_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (timer_id) DO UPDATE
         SET status = EXCLUDED.status,
             fire_at = EXCLUDED.fire_at,
             fired_at = EXCLUDED.fired_at,
             cancelled_at = EXCLUDED.cancelled_at`,
      [
        projection.id,
        instanceUuid,
        projection.tenantId,
        projection.timerName,
        projection.status,
        projection.scheduledAt,
        projection.fireAt,
        projection.firedAt,
        projection.cancelledAt,
      ],
    );
  }

  async upsertMany(projections: readonly TimerProjection[]): Promise<void> {
    for (const p of projections) {
      await this.upsert(p);
    }
  }
}
