import type { PgConnection } from "@crossengin/kernel-pg";
import type { TimerKind, TimerStatus } from "@crossengin/workflow-engine";

import type { WorkflowInstanceIdResolver } from "./id-mapping.js";

const SCHEMA = "meta";
const TABLE = "workflow_timers";

export interface TimerProjection {
  readonly id: string;
  readonly instanceId: string;
  readonly tenantId: string;
  readonly timerName: string;
  /**
   * NOT NULL with no default, and omitted from this INSERT until ADR-0332's sweep reached here — so
   * every `ProjectingEventLog` append that scheduled a timer threw against a real database while
   * all 356 offline tests passed, because a fake `PgConnection` asserts SQL *shape* and cannot know
   * a column is missing from the statement. Resolved from the `TimerDefinition`, never guessed; see
   * `timer-provenance.ts`.
   */
  readonly kind: TimerKind;
  readonly status: TimerStatus;
  readonly scheduledAt: string;
  readonly fireAt: string;
  /** Column-defaulted to `'UTC'`; written anyway, because a `business_hours` timer's zone is the timer. */
  readonly timezone: string;
  /** Travels with `kind`: required by `WorkflowTimerSchema` for `cron_schedule`, nullable in the column. */
  readonly cronExpression: string | null;
  /** Travels with `kind`: required by `WorkflowTimerSchema` for `relative_after`, nullable in the column. */
  readonly relativeSeconds: number | null;
  /**
   * The transition this timer's firing triggers. Nullable, and read back by `claimDueTimers` on
   * every claimed timer while nothing wrote it — so a worker's `ClaimedTimer.transitionToTrigger`
   * was unconditionally `null`. See `timer-provenance.ts` for why one name is written only when it
   * is the only name.
   */
  readonly transitionToTrigger: string | null;
  readonly firedAt: string | null;
  readonly cancelledAt: string | null;
  /** Column-defaulted to `0`; a `fired` timer whose count stayed 0 is a row its contract forbids. */
  readonly fireCount: number;
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
         timer_id, instance_id, tenant_id, timer_name, kind, status, scheduled_at,
         fire_at, timezone, cron_expression, relative_seconds, transition_to_trigger,
         fired_at, cancelled_at, fire_count
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (timer_id) DO UPDATE
         SET status = EXCLUDED.status,
             fire_at = EXCLUDED.fire_at,
             fired_at = EXCLUDED.fired_at,
             cancelled_at = EXCLUDED.cancelled_at,
             fire_count = EXCLUDED.fire_count`,
      [
        projection.id,
        instanceUuid,
        projection.tenantId,
        projection.timerName,
        projection.kind,
        projection.status,
        projection.scheduledAt,
        projection.fireAt,
        projection.timezone,
        projection.cronExpression,
        projection.relativeSeconds,
        projection.transitionToTrigger,
        projection.firedAt,
        projection.cancelledAt,
        projection.fireCount,
      ],
    );
  }

  async upsertMany(projections: readonly TimerProjection[]): Promise<void> {
    for (const p of projections) {
      await this.upsert(p);
    }
  }
}
