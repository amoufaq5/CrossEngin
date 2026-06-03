import type { PgConnection } from "@crossengin/kernel-pg";

/** One claimed due timer: its `wft_` id + the owning instance's `wfi_` ref (for `engine.fireTimer`). */
export interface TimerClaim {
  readonly timerId: string;
  readonly instanceRef: string;
}

export interface ClaimDueTimersInput {
  readonly workerId: string;
  readonly now: Date;
  readonly limit: number;
  readonly leaseMs: number;
}

export interface TimerClaimStore {
  claimDueTimers(input: ClaimDueTimersInput): Promise<readonly TimerClaim[]>;
  releaseTimer(timerId: string): Promise<void>;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

interface ClaimRow {
  readonly timer_id: string;
  readonly instance_ref: string;
}

/**
 * Postgres timer-claim store over `meta.workflow_timers`. `claimDueTimers`
 * atomically claims a batch of due, unleased (or lease-expired) `scheduled`
 * timers via **`FOR UPDATE SKIP LOCKED`** — so N workers each get a **disjoint**
 * set and fire them in parallel (no global lock), stamping a `claimed_by` +
 * `lease_expires_at` lease. A worker that connects with a role that can see all
 * tenants' rows (BYPASSRLS / the table owner) drains every tenant; the lease
 * lets another worker reclaim a timer whose owner died (`lease_expires_at` past).
 */
export class PostgresTimerClaimStore implements TimerClaimStore {
  private readonly conn: PgConnection;
  private readonly timers: string;
  private readonly instances: string;

  constructor(conn: PgConnection, opts: { readonly schema?: string } = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    this.timers = `${schema}.workflow_timers`;
    this.instances = `${schema}.workflow_instances`;
  }

  async claimDueTimers(input: ClaimDueTimersInput): Promise<readonly TimerClaim[]> {
    const nowIso = input.now.toISOString();
    const leaseIso = new Date(input.now.getTime() + input.leaseMs).toISOString();
    const res = await this.conn.query<ClaimRow>(
      `WITH due AS (
         SELECT id
           FROM ${this.timers}
          WHERE status = 'scheduled' AND fire_at <= $1
            AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < $1)
          ORDER BY fire_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE ${this.timers} t
          SET claimed_by = $3, lease_expires_at = $4
         FROM due
        WHERE t.id = due.id
       RETURNING t.timer_id,
                 (SELECT i.instance_id FROM ${this.instances} i WHERE i.id = t.instance_id) AS instance_ref`,
      [nowIso, input.limit, input.workerId, leaseIso],
    );
    return res.rows.map((r) => ({ timerId: String(r.timer_id), instanceRef: String(r.instance_ref) }));
  }

  /** Clears a timer's lease (when it turned out not to fire — already fired / not yet due). */
  async releaseTimer(timerId: string): Promise<void> {
    await this.conn.query(
      `UPDATE ${this.timers} SET claimed_by = NULL, lease_expires_at = NULL WHERE timer_id = $1`,
      [timerId],
    );
  }
}
