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
  /**
   * When a recurring timer next fires. Omitted from this INSERT until cron recurrence landed, so a
   * `cron_schedule` timer's next occurrence was in the column catalog, in `WorkflowTimerSchema` as a
   * requirement on a fired cron timer, and in no statement — the same shape as `kind` one field
   * over. Null for every other kind, which `WorkflowTimerSchema` requires.
   */
  readonly nextFireAt: string | null;
}

/**
 * Whether this write is entitled to release the row's claim.
 *
 * `upsert`'s claim-clearing arm rests on one premise, stated in its own doc comment: *advancing
 * `fire_count` is the one condition that means "this write is the result of that claim"*. That is
 * true of `ProjectingEventLog`, which writes because an event just landed, and **false of a
 * repair**: a replayer writes because the row disagrees with the log, and the row disagreeing is the
 * drift case — so a resync of exactly the timer a detector was built to find would advance
 * `fire_count` past a stale row, read the premise as satisfied, and clear the lease of the worker
 * that is at that moment firing it. With `claim_expires_at` NULL the timer is immediately claimable
 * again, and a second worker fires the same occurrence.
 *
 * So the premise is a property of the *caller*, and the caller states it. `"release_on_fire"` is the
 * default because that is what the engine needs and what every existing writer means.
 */
export const TIMER_CLAIM_POLICIES = [
  /** The write is the result of a claim: advancing `fire_count` hands the row back. */
  "release_on_fire",
  /** The write is a repair, which no claim produced, so the claim is left exactly as it is. */
  "preserve_claim",
] as const;
export type TimerClaimPolicy = (typeof TIMER_CLAIM_POLICIES)[number];

export interface TimerUpsertOptions {
  readonly claimPolicy?: TimerClaimPolicy;
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

  /**
   * `scheduled_at` is in the `SET` list because a recurring timer is armed again on its own id, and
   * the column is the start of *this* wait: a re-arm that moved `fire_at` and left `scheduled_at`
   * at the first arming would leave the row's own `fire_at > scheduled_at` reading of itself true
   * only by accident.
   *
   * **The claim is released exactly when the write records a fire the row had not recorded.** A
   * re-arm hands the row back to the `scheduled` claim set with the previous claimant's
   * `claimed_by` and a lease up to 30 s out, so without this the next occurrence of a one-minute
   * cron would wait out a lease that nobody is using — the claimant's work on that occurrence is
   * over. It is keyed on `fire_count` advancing rather than on `EXCLUDED.status = 'scheduled'`,
   * because `ProjectingEventLog` re-projects **every** timer on **every** append: a status-keyed
   * clause would clear a live claim held by another worker mid-fire whenever any unrelated event
   * landed on the instance. Advancing `fire_count` is the one condition that means "this write is
   * the result of that claim".
   */
  async upsert(projection: TimerProjection, options: TimerUpsertOptions = {}): Promise<void> {
    const instanceUuid = await this.instanceResolver.requireResolve(projection.instanceId);
    // Two whole statements rather than one with an interpolated `SET` tail: both column lists stay
    // literal, which is what `pg-column-coverage.ts` reads as text, and the only difference between
    // them is the pair of assignments that is actually in question.
    const sql =
      (options.claimPolicy ?? "release_on_fire") === "preserve_claim"
        ? `INSERT INTO ${SCHEMA}.${TABLE} (
         timer_id, instance_id, tenant_id, timer_name, kind, status, scheduled_at,
         fire_at, timezone, cron_expression, relative_seconds, transition_to_trigger,
         fired_at, cancelled_at, fire_count, next_fire_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (timer_id) DO UPDATE
         SET status = EXCLUDED.status,
             scheduled_at = EXCLUDED.scheduled_at,
             fire_at = EXCLUDED.fire_at,
             fired_at = EXCLUDED.fired_at,
             cancelled_at = EXCLUDED.cancelled_at,
             fire_count = EXCLUDED.fire_count,
             next_fire_at = EXCLUDED.next_fire_at`
        : `INSERT INTO ${SCHEMA}.${TABLE} (
         timer_id, instance_id, tenant_id, timer_name, kind, status, scheduled_at,
         fire_at, timezone, cron_expression, relative_seconds, transition_to_trigger,
         fired_at, cancelled_at, fire_count, next_fire_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (timer_id) DO UPDATE
         SET status = EXCLUDED.status,
             scheduled_at = EXCLUDED.scheduled_at,
             fire_at = EXCLUDED.fire_at,
             fired_at = EXCLUDED.fired_at,
             cancelled_at = EXCLUDED.cancelled_at,
             fire_count = EXCLUDED.fire_count,
             next_fire_at = EXCLUDED.next_fire_at,
             claimed_by = CASE
               WHEN EXCLUDED.fire_count > ${SCHEMA}.${TABLE}.fire_count THEN NULL
               ELSE ${SCHEMA}.${TABLE}.claimed_by END,
             claim_expires_at = CASE
               WHEN EXCLUDED.fire_count > ${SCHEMA}.${TABLE}.fire_count THEN NULL
               ELSE ${SCHEMA}.${TABLE}.claim_expires_at END`;
    await this.conn.query(
      sql,
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
        projection.nextFireAt,
      ],
    );
  }

  async upsertMany(
    projections: readonly TimerProjection[],
    options: TimerUpsertOptions = {},
  ): Promise<void> {
    for (const p of projections) {
      await this.upsert(p, options);
    }
  }
}
