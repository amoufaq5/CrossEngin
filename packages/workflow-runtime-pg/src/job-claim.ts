import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const DEFAULT_SCHEMA = "meta";
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_LIMIT = 20;

/** A pending job run claimed by a worker for execution — what a worker needs to run the job. */
export interface ClaimedJob {
  /**
   * `jobId` is the **run** id (`meta.job_runs.run_id`), not the job's. The name is wrong and the
   * value is right: every consumer uses it as a run id — `executeJobRun` filters
   * `WHERE run_id = $1`, `renewJobClaim` and `releaseJobClaim` likewise, and
   * `observeJobCancellation` takes it as `{runId}`. The job's own id is `jobDefinitionId` beside
   * it. Note the asymmetry across the two paths in this one package: `EnqueuedJobRun.jobId` is
   * `job_id`, so the same property name means two different columns depending on which direction
   * the row is moving.
   */
  readonly jobId: string;
  readonly tenantId: string;
  readonly jobDefinitionId: string;
  readonly jobKind: string;
  readonly attempts: number;
  readonly claimExpiresAt: string;
}

/**
 * Which runs this worker is able to execute, so it claims nothing else.
 *
 * **Absent and empty mean different things, and that is the whole point.** Absent is "no filter" —
 * every due run, the behaviour every existing caller has. Present means the caller has declared what
 * it serves, and an *empty* declaration therefore claims **nothing** rather than everything: a
 * worker with no handlers must not take work it will fail. A spelling like `($n IS NULL OR …)` would
 * make the empty case unfiltered, which is the fail-open direction and the reason this is one
 * optional object rather than two optional arrays.
 *
 * `jobIds` and `jobKinds` are OR'd: a run qualifies if its `job_id` is named or its `job_kind` is.
 */
export interface JobClaimScope {
  readonly jobIds?: readonly string[];
  readonly jobKinds?: readonly string[];
}

export interface ClaimDueJobsOptions {
  readonly workerId: string;
  readonly now: string;
  readonly limit?: number;
  readonly leaseMs?: number;
  readonly schema?: string;
  /**
   * The handlers this worker holds. Omit for the unfiltered claim; supply it and a run whose job
   * nothing here can execute is never claimed — which is what keeps a partially-configured fleet
   * from finalizing another replica's work `failed` with `handler_not_found`, and what keeps a
   * process with no handlers from a claim/release hot loop.
   */
  readonly serves?: JobClaimScope;
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
 * (running → completed/failed/dead-lettered/cancelled), removing it from the claim set.
 *
 * A run with a recorded cancellation is **never** claimed: once `cancel_requested_at` is set the work
 * must not start on a fresh worker, so the predicate excludes it rather than relying on a later check.
 * That leaves such a run unclaimable, which is why `reapCancelledJobRuns` exists to finalize the ones
 * no live worker is going to honour. The worker
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

  // The served predicate goes **inside** the `due` CTE, beside the `LIMIT`. Filtering the claim's
  // output instead would let a head-of-queue run this worker cannot execute consume one of the
  // `LIMIT` slots — so a backlog of unserved runs would starve the served ones behind it while
  // every poll honestly reported claiming nothing.
  const params: unknown[] = [options.now, limit, options.workerId, claimExpiresAt];
  let servedPredicate = "";
  if (options.serves !== undefined) {
    const clauses: string[] = [];
    params.push(options.serves.jobIds ?? []);
    clauses.push(`job_id = ANY($${params.length.toString()}::text[])`);
    params.push(options.serves.jobKinds ?? []);
    clauses.push(`job_kind = ANY($${params.length.toString()}::text[])`);
    // `= ANY('{}')` is false, so two empty arrays claim nothing — the fail-closed answer for a
    // worker that declared it serves nothing.
    servedPredicate = `\n          AND (${clauses.join(" OR ")})`;
  }

  const result = await conn.query<ClaimRow>(
    `WITH due AS (
       SELECT id
         FROM ${schema}.job_runs
        WHERE status = 'pending'
          AND started_at <= $1::timestamptz
          AND cancel_requested_at IS NULL
          AND (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at < $1::timestamptz)${servedPredicate}
        ORDER BY started_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE ${schema}.job_runs j
        SET claimed_by = $3, claim_expires_at = $4::timestamptz
       FROM due
      WHERE j.id = due.id
     RETURNING j.run_id, j.tenant_id, j.job_id, j.job_kind, j.attempts, j.claim_expires_at`,
    params,
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

/**
 * Whether this connection can see the job queue at all.
 *
 * `meta.job_runs`, `meta.dead_letter_jobs` and `meta.job_costs` each carry exactly one `ALL`-scope
 * tenant-isolation policy and **no platform arm**, while the worker fleet is deliberately
 * cross-tenant — one fleet serves every tenant, with `tenant_id` riding back per row. Those two
 * facts only compose when the connection's role bypasses RLS, which for an ordinary deployment means
 * being the table's owner. As a non-owner with no tenant context, `claimDueJobs` returns **0 rows**
 * and `executeJobRun` answers `not_claimable` — verified live — and neither is an error: an empty
 * claim is what an empty queue looks like, and `not_claimable` is what an already-finalized run
 * looks like. So a fleet that will never execute anything reads exactly like a fleet with nothing to
 * do.
 */
export const JOB_QUEUE_VISIBILITY = [
  /** The role bypasses RLS on this table (its owner, or `BYPASSRLS`): the claim sees every tenant. */
  "visible",
  /** RLS confines this role, so an unscoped cross-tenant claim will match nothing, silently. */
  "confined_by_rls",
  /** RLS is not enabled on the table — unexpected for a `tenant_id`-bearing table, and reported. */
  "unguarded",
  /** The catalog had no row for the table: it does not exist in this schema. */
  "absent",
] as const;
export type JobQueueVisibility = (typeof JOB_QUEUE_VISIBILITY)[number];

export interface JobQueueVisibilityReport {
  readonly visibility: JobQueueVisibility;
  readonly role: string;
  readonly isOwner: boolean;
  readonly bypassesRls: boolean;
  readonly detail: string;
}

/**
 * Asks the catalog — rather than counting rows — whether this connection's role can serve the queue.
 *
 * Counting is the wrong question and that is the point: zero visible runs and zero existing runs are
 * the same observation, which is the ambiguity that let this go unnoticed. Ownership, `rolbypassrls`
 * and `relrowsecurity` are facts Postgres will state, so they are *asked for* (ADR-0330's rule) and
 * the answer is deterministic on an empty database and on a full one alike.
 *
 * Intended for the boot path, beside the supervisor's own refusals: a worker fleet that cannot see
 * its queue should say so once, loudly, instead of polling in silence forever.
 */
export async function probeJobQueueVisibility(
  conn: PgConnection,
  options: { readonly schema?: string; readonly table?: string } = {},
): Promise<JobQueueVisibilityReport> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  const table = options.table ?? "job_runs";
  if (!SCHEMA_RE.test(table)) throw new Error(`invalid table identifier: ${JSON.stringify(table)}`);

  const result = await conn.query<{
    role: unknown;
    bypasses_rls: unknown;
    is_owner: unknown;
    rls_enabled: unknown;
  }>(
    `SELECT current_user AS role,
            COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS bypasses_rls,
            pg_catalog.pg_get_userbyid(c.relowner) = current_user AS is_owner,
            c.relrowsecurity AS rls_enabled
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, table],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return {
      visibility: "absent",
      role: "",
      isOwner: false,
      bypassesRls: false,
      detail: `${schema}.${table} does not exist`,
    };
  }
  const role = str(row.role);
  const isOwner = row.is_owner === true;
  const bypassesRls = row.bypasses_rls === true;
  if (row.rls_enabled !== true) {
    return {
      visibility: "unguarded",
      role,
      isOwner,
      bypassesRls,
      detail: `row-level security is disabled on ${schema}.${table}, so nothing confines a tenant's rows`,
    };
  }
  if (isOwner || bypassesRls) {
    return {
      visibility: "visible",
      role,
      isOwner,
      bypassesRls,
      detail:
        `'${role}' ${isOwner ? "owns" : "bypasses RLS on"} ${schema}.${table}, so a cross-tenant ` +
        "claim sees every tenant's runs",
    };
  }
  return {
    visibility: "confined_by_rls",
    role,
    isOwner,
    bypassesRls,
    detail:
      `'${role}' neither owns nor bypasses RLS on ${schema}.${table}, and the table has only a ` +
      "tenant-isolation policy — so a cross-tenant claim with no app.current_tenant_id set matches " +
      "nothing and every poll reports an empty queue. Connect as the table's owner, or grant the " +
      "role BYPASSRLS",
  };
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
