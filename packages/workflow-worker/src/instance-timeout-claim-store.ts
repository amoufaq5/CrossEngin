import type { PgConnection } from "@crossengin/kernel-pg";

/** One claimed timed-out instance: its `wfi_` ref (for `engine.timeoutInstance`). */
export interface InstanceTimeoutClaim {
  readonly instanceRef: string;
}

export interface ClaimTimedOutInstancesInput {
  readonly workerId: string;
  readonly now: Date;
  readonly limit: number;
  readonly leaseMs: number;
}

export interface InstanceTimeoutClaimStore {
  claimTimedOutInstances(input: ClaimTimedOutInstancesInput): Promise<readonly InstanceTimeoutClaim[]>;
  releaseInstance(instanceRef: string): Promise<void>;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

interface ClaimRow {
  readonly instance_ref: string;
}

/**
 * Postgres timeout-claim store over `meta.workflow_instances`.
 * `claimTimedOutInstances` atomically claims a disjoint batch of **non-terminal**
 * instances whose overall `timeout_at` deadline has passed and that are unleased
 * (or lease-expired) — via **`FOR UPDATE SKIP LOCKED`** — so N sweeper workers
 * each get a disjoint set and fail them in parallel via `engine.timeoutInstance`
 * (no global lock). A worker that connects with a role that can see all tenants'
 * rows (BYPASSRLS / the table owner) sweeps every tenant; the lease lets another
 * worker reclaim an instance whose owner died (`lease_expires_at` past).
 */
export class PostgresInstanceTimeoutClaimStore implements InstanceTimeoutClaimStore {
  private readonly conn: PgConnection;
  private readonly instances: string;

  constructor(conn: PgConnection, opts: { readonly schema?: string } = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    this.instances = `${schema}.workflow_instances`;
  }

  async claimTimedOutInstances(
    input: ClaimTimedOutInstancesInput,
  ): Promise<readonly InstanceTimeoutClaim[]> {
    const nowIso = input.now.toISOString();
    const leaseIso = new Date(input.now.getTime() + input.leaseMs).toISOString();
    const res = await this.conn.query<ClaimRow>(
      `WITH due AS (
         SELECT id
           FROM ${this.instances}
          WHERE status NOT IN ('completed', 'failed', 'cancelled', 'compensated')
            AND timeout_at <= $1
            AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < $1)
          ORDER BY timeout_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE ${this.instances} t
          SET claimed_by = $3, lease_expires_at = $4
         FROM due
        WHERE t.id = due.id
       RETURNING t.instance_id AS instance_ref`,
      [nowIso, input.limit, input.workerId, leaseIso],
    );
    return res.rows.map((r) => ({ instanceRef: String(r.instance_ref) }));
  }

  /** Clears an instance's claim lease (after a sweep attempt, so the next poll re-evaluates it). */
  async releaseInstance(instanceRef: string): Promise<void> {
    await this.conn.query(
      `UPDATE ${this.instances} SET claimed_by = NULL, lease_expires_at = NULL WHERE instance_id = $1`,
      [instanceRef],
    );
  }
}
