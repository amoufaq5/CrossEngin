import type { PgConnection } from "@crossengin/kernel-pg";

/** One claimed async activity awaiting first execution: its `wfa_` id + instance `wfi_` ref. */
export interface ActivityExecuteClaim {
  readonly activityId: string;
  readonly instanceRef: string;
}

export interface ClaimScheduledActivitiesInput {
  readonly workerId: string;
  readonly now: Date;
  readonly limit: number;
  readonly leaseMs: number;
}

export interface ActivityExecuteClaimStore {
  claimScheduledActivities(input: ClaimScheduledActivitiesInput): Promise<readonly ActivityExecuteClaim[]>;
  releaseActivity(activityId: string): Promise<void>;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

interface ClaimRow {
  readonly activity_id: string;
  readonly instance_ref: string;
}

/**
 * Postgres execute-claim store over `meta.workflow_activities`. Claims activities
 * that were scheduled in **`async`** execution mode and have **not yet started**
 * (`status='scheduled' AND execution_mode='async'`), are unleased (or
 * lease-expired), via **`FOR UPDATE SKIP LOCKED`** — so N executor workers each
 * get a disjoint batch and run them in parallel via `engine.executeActivity` (no
 * global lock). Inline activities never sit in `scheduled` across an engine call,
 * and the `execution_mode='async'` filter keeps them out of the queue entirely.
 */
export class PostgresActivityExecuteClaimStore implements ActivityExecuteClaimStore {
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

  async claimScheduledActivities(
    input: ClaimScheduledActivitiesInput,
  ): Promise<readonly ActivityExecuteClaim[]> {
    const nowIso = input.now.toISOString();
    const leaseIso = new Date(input.now.getTime() + input.leaseMs).toISOString();
    const res = await this.conn.query<ClaimRow>(
      `WITH due AS (
         SELECT id
           FROM ${this.activities}
          WHERE status = 'scheduled'
            AND execution_mode = 'async'
            AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < $1)
          ORDER BY scheduled_at
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

  /** Clears an activity's claim lease (after an execute attempt, so the next poll re-evaluates it). */
  async releaseActivity(activityId: string): Promise<void> {
    await this.conn.query(
      `UPDATE ${this.activities} SET claimed_by = NULL, lease_expires_at = NULL WHERE activity_id = $1`,
      [activityId],
    );
  }
}
