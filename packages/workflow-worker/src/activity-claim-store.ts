import type { PgConnection } from "@crossengin/kernel-pg";

/** One claimed retryable activity: its `wfa_` id + the owning instance's `wfi_` ref. */
export interface ActivityRetryClaim {
  readonly activityId: string;
  readonly instanceRef: string;
}

export interface ClaimDueRetriesInput {
  readonly workerId: string;
  readonly now: Date;
  readonly limit: number;
  readonly leaseMs: number;
}

export interface ActivityRetryClaimStore {
  claimDueRetries(input: ClaimDueRetriesInput): Promise<readonly ActivityRetryClaim[]>;
  releaseActivity(activityId: string): Promise<void>;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

interface ClaimRow {
  readonly activity_id: string;
  readonly instance_ref: string;
}

/**
 * Postgres activity-retry claim store over `meta.workflow_activities`.
 * `claimDueRetries` atomically claims a disjoint batch of activities that
 * **failed / timed out**, **haven't exhausted** `max_attempts`, and whose
 * backoff has elapsed (`next_retry_at` null or past), that are unleased (or
 * lease-expired) — via **`FOR UPDATE SKIP LOCKED`** — so N retry workers each
 * get a disjoint set and re-run them in parallel via `engine.retryActivity`.
 * (Population of `next_retry_at` with a backoff schedule on failure is the
 * deeper follow-up; until then a failed activity is eligible immediately.)
 */
export class PostgresActivityRetryClaimStore implements ActivityRetryClaimStore {
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

  async claimDueRetries(input: ClaimDueRetriesInput): Promise<readonly ActivityRetryClaim[]> {
    const nowIso = input.now.toISOString();
    const leaseIso = new Date(input.now.getTime() + input.leaseMs).toISOString();
    const res = await this.conn.query<ClaimRow>(
      `WITH due AS (
         SELECT id
           FROM ${this.activities}
          WHERE status IN ('failed', 'timed_out')
            AND attempt_number < max_attempts
            AND (next_retry_at IS NULL OR next_retry_at <= $1)
            AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < $1)
          ORDER BY next_retry_at NULLS FIRST
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

  /** Clears an activity's claim lease (after a retry attempt, so the next poll re-evaluates it). */
  async releaseActivity(activityId: string): Promise<void> {
    await this.conn.query(
      `UPDATE ${this.activities} SET claimed_by = NULL, lease_expires_at = NULL WHERE activity_id = $1`,
      [activityId],
    );
  }
}
