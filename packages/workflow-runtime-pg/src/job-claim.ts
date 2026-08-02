import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const DEFAULT_SCHEMA = "meta";
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_LIMIT = 20;

/** A pending job run claimed by a worker for execution — what a worker needs to run the job. */
export interface ClaimedJob {
  readonly jobId: string;
  readonly tenantId: string;
  readonly jobDefinitionId: string;
  readonly jobKind: string;
  readonly attempts: number;
  readonly claimExpiresAt: string;
}

export interface ClaimDueJobsOptions {
  readonly workerId: string;
  readonly now: string;
  readonly limit?: number;
  readonly leaseMs?: number;
  readonly schema?: string;
}

interface ClaimRow {
  readonly run_id: unknown;
  readonly tenant_id: unknown;
  readonly job_id: unknown;
  readonly job_kind: unknown;
  readonly attempts: unknown;
  readonly claim_expires_at: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v instanceof Date ? v.toISOString() : String(v ?? "");
}
function int(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback;
}

/**
 * Atomically claims up to `limit` `pending` job runs for a worker, leasing each for `leaseMs`,
 * using `FOR UPDATE SKIP LOCKED` — so concurrent workers get disjoint batches and never execute the
 * same job twice. A job is claimable when it is unclaimed **or** its lease lapsed (so a crashed
 * worker's jobs are recovered). Executing a job flips its status out of `pending`
 * (running → completed/failed/dead-lettered/cancelled), removing it from the claim set. The worker
 * connection is platform-scoped (RLS-bypassing), so one fleet serves every tenant; `tenant_id` rides
 * back per row. (The job worker + jobs execution engine that consume this queue substrate are the
 * follow-ups; this is the primitive they plug into.)
 */
export async function claimDueJobs(
  conn: PgConnection,
  options: ClaimDueJobsOptions,
): Promise<readonly ClaimedJob[]> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`invalid limit: ${String(limit)}`);
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new Error(`invalid leaseMs: ${String(leaseMs)}`);
  const claimExpiresAt = new Date(new Date(options.now).getTime() + leaseMs).toISOString();

  const result = await conn.query<ClaimRow>(
    `WITH due AS (
       SELECT id
         FROM ${schema}.job_runs
        WHERE status = 'pending'
          AND started_at <= $1::timestamptz
          AND (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at < $1::timestamptz)
        ORDER BY started_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE ${schema}.job_runs j
        SET claimed_by = $3, claim_expires_at = $4::timestamptz
       FROM due
      WHERE j.id = due.id
     RETURNING j.run_id, j.tenant_id, j.job_id, j.job_kind, j.attempts, j.claim_expires_at`,
    [options.now, limit, options.workerId, claimExpiresAt],
  );

  return result.rows.map((r) => ({
    jobId: str(r.run_id),
    tenantId: str(r.tenant_id),
    jobDefinitionId: str(r.job_id),
    jobKind: str(r.job_kind),
    attempts: int(r.attempts, 1),
    claimExpiresAt: str(r.claim_expires_at),
  }));
}

/** Hands a claimed-but-unexecuted job back for immediate re-claim (scoped to the owning worker). */
export async function releaseJobClaim(
  conn: PgConnection,
  options: { readonly jobId: string; readonly workerId: string; readonly schema?: string },
): Promise<void> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  await conn.query(
    `UPDATE ${schema}.job_runs
        SET claimed_by = NULL, claim_expires_at = NULL
      WHERE run_id = $1 AND claimed_by = $2 AND status = 'pending'`,
    [options.jobId, options.workerId],
  );
}

/**
 * Extends the lease on a job this worker still holds (for a slow handler). Returns `true`
 * only if the row updated — still `pending` AND still owned; `false` means the lease was lost.
 */
export async function renewJobClaim(
  conn: PgConnection,
  options: {
    readonly jobId: string;
    readonly workerId: string;
    readonly now: string;
    readonly leaseMs?: number;
    readonly schema?: string;
  },
): Promise<boolean> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new Error(`invalid leaseMs: ${String(leaseMs)}`);
  const claimExpiresAt = new Date(new Date(options.now).getTime() + leaseMs).toISOString();
  const result = await conn.query(
    `UPDATE ${schema}.job_runs
        SET claim_expires_at = $3::timestamptz
      WHERE run_id = $1 AND claimed_by = $2 AND status = 'pending'`,
    [options.jobId, options.workerId, claimExpiresAt],
  );
  return (result.rowCount ?? 0) > 0;
}
