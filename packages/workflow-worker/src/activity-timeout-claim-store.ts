import type { PgConnection } from "@crossengin/kernel-pg";

/** One claimed non-settled activity past its deadline: its `wfa_` id + instance `wfi_` ref. */
export interface ActivityTimeoutClaim {
  readonly activityId: string;
  readonly instanceRef: string;
}

export interface ClaimTimedOutActivitiesInput {
  readonly workerId: string;
  readonly now: Date;
  readonly limit: number;
  readonly leaseMs: number;
}

export interface ActivityTimeoutClaimStore {
  claimTimedOutActivities(input: ClaimTimedOutActivitiesInput): Promise<readonly ActivityTimeoutClaim[]>;
  releaseActivity(activityId: string): Promise<void>;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

interface ClaimRow {
  readonly activity_id: string;
  readonly instance_ref: string;
}

/**
 * Postgres activity-timeout claim store over `meta.workflow_activities`. Claims
 * **non-settled** activities (`status IN ('scheduled', 'running')`) whose
 * `timeout_at` deadline has passed and that are unleased (or lease-expired), via
 * **`FOR UPDATE SKIP LOCKED`** + lease — so N sweeper workers each get a disjoint
 * batch and time them out in parallel via `engine.timeoutActivity` (no global
 * lock). A normally-executing activity is well within `timeout_at`, so only
 * genuinely overdue async / orphaned activities are claimed; `timeoutActivity`'s
 * settled-guard covers any residual race.
 */
export class PostgresActivityTimeoutClaimStore implements ActivityTimeoutClaimStore {
  private readonly conn: PgConnection;
  private readonly activities: string;
  private readonly instances: string;

  constructor(conn: PgConnection, opts: { readonly schema?: string } = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    this.activities = `${schema}.workflow_activities`;
    this.instances = `${schema}.workflow_instances`;
  }

  async claimTimedOutActivities(
    input: ClaimTimedOutActivitiesInput,
  ): Promise<readonly ActivityTimeoutClaim[]> {
    const nowIso = input.now.toISOString();
    const leaseIso = new Date(input.now.getTime() + input.leaseMs).toISOString();
    const res = await this.conn.query<ClaimRow>(
      `WITH due AS (
         SELECT id
           FROM ${this.activities}
          WHERE status IN ('scheduled', 'running')
            AND timeout_at <= $1
            AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < $1)
          ORDER BY timeout_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE ${this.activities} t
          SET claimed_by = $3, lease_expires_at = $4
         FROM due
        WHERE t.id = due.id
       RETURNING t.activity_id,
                 (SELECT i.instance_id FROM ${this.instances} i WHERE i.id = t.instance_id) AS instance_ref`,
      [nowIso, input.limit, input.workerId, leaseIso],
    );
    return res.rows.map((r) => ({ activityId: String(r.activity_id), instanceRef: String(r.instance_ref) }));
  }

  /** Clears an activity's claim lease (after a timeout attempt, so the next poll re-evaluates it). */
  async releaseActivity(activityId: string): Promise<void> {
    await this.conn.query(
      `UPDATE ${this.activities} SET claimed_by = NULL, lease_expires_at = NULL WHERE activity_id = $1`,
      [activityId],
    );
  }
}
