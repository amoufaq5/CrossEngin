import {
  assertScopeTenantId,
  parseSessionPolicyVisibility,
  sessionPolicyVisibilityReason,
  sessionWouldBeConfined,
  SESSION_POLICY_VISIBILITY_QUERY,
  type PgConnection,
  type SessionPolicyVisibilityRow,
} from "@crossengin/kernel-pg";

import { SET_TENANT_CONTEXT_SQL, withTenantContext } from "./tenant-context.js";

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
  /**
   * Confines the claim to one tenant's runs (`tenant_id = …` inside the `due` CTE). Absent, the claim
   * spans every tenant the session can see — which is every tenant only for a session Postgres
   * exempts from the table's policies, and none at all for the shipped serving role; see
   * `claimDueJobsPerTenant`. The predicate is the second belt beside the tenant context, and the one
   * that keeps an exempt session from claiming another tenant's runs under a tenant's context.
   */
  readonly tenantId?: string;
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
 * no live worker is going to honour.
 *
 * With `tenantId`, the claim is confined to that tenant and is meant to run under its context — the
 * form `claimDueJobsPerTenant` uses and the worker adapter calls. Without it, the statement spans
 * every tenant the session can see, which is every tenant only for a session exempt from the
 * table's policies and none for a confined one; `tenant_id` rides back per row either way.
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
  let tenantPredicate = "";
  if (options.tenantId !== undefined) {
    assertScopeTenantId(options.tenantId);
    params.push(options.tenantId);
    tenantPredicate = `\n          AND tenant_id = $${params.length.toString()}::uuid`;
  }
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
          AND (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at < $1::timestamptz)${tenantPredicate}${servedPredicate}
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
 * The tenants whose queues a per-tenant claim visits. Every status but `deleted`: a suspended or
 * archived tenant's already-enqueued runs are still the platform's work to finish, while a deleted
 * tenant's queue rows were erased with it (`meta.job_runs` is not a retained table), so visiting one
 * would only cost a round trip. `meta.tenants` carries no row-level security, which is what lets a
 * confined session enumerate the tenants it then claims for one at a time.
 */
export const JOB_CLAIM_EXCLUDED_TENANT_STATUSES = ["deleted"] as const;

/** Reads the tenant ids a per-tenant claim visits, in a stable order (`id`). */
export async function listJobClaimTenants(
  conn: PgConnection,
  options: { readonly schema?: string } = {},
): Promise<readonly string[]> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  const result = await conn.query<{ id: unknown }>(
    `SELECT id FROM ${schema}.tenants WHERE status <> ALL($1::text[]) ORDER BY id`,
    [JOB_CLAIM_EXCLUDED_TENANT_STATUSES],
  );
  return result.rows.map((r) => str(r.id));
}

export interface ClaimDueJobsPerTenantOptions extends Omit<ClaimDueJobsOptions, "tenantId"> {
  /** The tenants to visit — `listJobClaimTenants`, read once per poll. */
  readonly tenantIds: readonly string[];
  /** Where in `tenantIds` this poll starts; the caller carries `nextStartIndex` between polls. */
  readonly startIndex?: number;
  /**
   * Runs each tenant's visit before its claim, inside the same transaction and tenant context —
   * the cancellation reaper's per-tenant form, so it reaches the rows a confined session can see.
   */
  readonly beforeClaim?: (tx: PgConnection, tenantId: string) => Promise<void>;
}

export interface ClaimDueJobsPerTenantResult {
  readonly claimed: readonly ClaimedJob[];
  /** Where the next poll should start, so the head of the tenant list is not always served first. */
  readonly nextStartIndex: number;
  /** How many tenants the first pass asked — the poll's cost is two statements per tenant asked. */
  readonly tenantsVisited: number;
}

/**
 * Claims due job runs one tenant at a time, under each tenant's own context, so a session the queue's
 * tenant-isolation policy confines can claim at all.
 *
 * Why not a platform claim arm. `meta.job_runs.tenant_id` is NOT NULL, so ADR-0332's
 * `tenant_id IS NULL` write arm admits no row (ADR-0389, proven live); and an `UPDATE` arm on a bare
 * GUC is a cross-tenant write route for any session able to call `set_config`, which is the shape
 * ADR-0409 removed from `meta.operate_tenant_manifests`. The tenant is a fact about the row, so the
 * claim takes it from the row's tenant — enumerated from `meta.tenants`, which has no RLS.
 *
 * **One transaction, two statements per tenant asked**, and the cost is stated rather than hidden: an
 * idle poll over N tenants is `2N + 2` round trips. `set_config(…, true)` is transaction-local and
 * re-settable, so the tenants share one `BEGIN`/`COMMIT`; the row locks the claims take are held only
 * until that commit.
 *
 * Fairness. Pass one asks each tenant, starting at `startIndex` and rotating, for at most
 * `ceil(limit / tenants)` runs, so one tenant's backlog cannot fill every slot; pass two gives any
 * capacity left to the tenants that filled their share. `nextStartIndex` is one past the last tenant
 * pass one asked, so a poll that stopped early resumes with the next tenant rather than the first.
 */
export async function claimDueJobsPerTenant(
  conn: PgConnection,
  options: ClaimDueJobsPerTenantOptions,
): Promise<ClaimDueJobsPerTenantResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`invalid limit: ${String(limit)}`);
  const tenants = options.tenantIds;
  for (const t of tenants) assertScopeTenantId(t);
  const n = tenants.length;
  if (n === 0) return { claimed: [], nextStartIndex: 0, tenantsVisited: 0 };
  const start = (((options.startIndex ?? 0) % n) + n) % n;
  const share = Math.max(1, Math.ceil(limit / n));
  const { tenantIds: _ignored, startIndex: _start, beforeClaim, ...claimOpts } = options;

  return conn.transaction(async (tx) => {
    const claimed: ClaimedJob[] = [];
    const saturated: string[] = [];
    let visited = 0;
    let nextStartIndex = start;
    const claimFor = async (tenantId: string, cap: number, first: boolean): Promise<number> => {
      await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
      if (first && beforeClaim !== undefined) await beforeClaim(tx, tenantId);
      const got = await claimDueJobs(tx, { ...claimOpts, limit: cap, tenantId });
      claimed.push(...got);
      return got.length;
    };
    for (let i = 0; i < n && claimed.length < limit; i += 1) {
      const index = (start + i) % n;
      const tenantId = tenants[index] as string;
      const cap = Math.min(share, limit - claimed.length);
      const got = await claimFor(tenantId, cap, true);
      visited += 1;
      nextStartIndex = (index + 1) % n;
      if (got === cap) saturated.push(tenantId);
    }
    for (const tenantId of saturated) {
      if (claimed.length >= limit) break;
      await claimFor(tenantId, limit - claimed.length, false);
    }
    return { claimed, nextStartIndex, tenantsVisited: visited };
  });
}

/**
 * Whether this connection can see the job queue at all.
 *
 * `meta.job_runs`, `meta.dead_letter_jobs` and `meta.job_costs` each carry exactly one `ALL`-scope
 * tenant-isolation policy and **no platform arm**, while the worker fleet is deliberately
 * cross-tenant — one fleet serves every tenant, with `tenant_id` riding back per row. Those two
 * facts only compose when Postgres exempts the connection's role from the table's policies, which
 * for an ordinary deployment means being the table's owner — but *only* while the table does not
 * carry `FORCE ROW LEVEL SECURITY`, which confines the owner too. As a role Postgres does not
 * exempt, with no tenant context, `claimDueJobs` returns **0 rows**
 * and `executeJobRun` answers `not_claimable` — verified live — and neither is an error: an empty
 * claim is what an empty queue looks like, and `not_claimable` is what an already-finalized run
 * looks like. So a fleet that will never execute anything reads exactly like a fleet with nothing to
 * do.
 */
export const JOB_QUEUE_VISIBILITY = [
  /**
   * Postgres will not apply this table's policies to this role, so the claim sees every tenant.
   *
   * Deliberately *not* spelled "its owner, or `BYPASSRLS`", which is what this comment used to say
   * and what the code used to compute: ownership is exempt until the table carries
   * `FORCE ROW LEVEL SECURITY`, and then the owner is confined like anyone else. The exemption is
   * `row_security_active`'s to decide, not this list's to enumerate.
   */
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
 * the same observation, which is the ambiguity that let this go unnoticed. The answer is *asked for*
 * (ADR-0330's rule) and is deterministic on an empty database and on a full one alike.
 *
 * It used to ask for ownership, `rolbypassrls` and `relrowsecurity` and then compose the verdict
 * here from the first two — three facts Postgres will state, and the decision imitated, while
 * citing the ADR that says not to. The composition omitted `relforcerowsecurity`, so an owner
 * of a `FORCE ROW LEVEL SECURITY` table read `visible` while seeing none of its rows: measured live
 * on PG 16.13 as the one divergent cell of six, and confirmed destructively — the owner's
 * `DELETE … WHERE tenant_id IS NOT NULL` removed nothing, the confirm-absence `count(*)` also
 * reported 0 because it reads through the same policy, and a `BYPASSRLS` role then counted both
 * rows still present. That silent zero is the single thing this probe exists to catch, and the
 * prose above described the code accurately while the code described the database wrongly.
 * It now reads `sessionWouldBeConfined`, whose verdict is `row_security_active` — Postgres's own
 * answer — so there is no composition here left to omit a column from.
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

  const result = await conn.query<SessionPolicyVisibilityRow>(SESSION_POLICY_VISIBILITY_QUERY, [
    schema,
    table,
  ]);
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
  const v = parseSessionPolicyVisibility(row);
  const { role, isOwner, bypassesRls } = v;
  if (!v.rlsEnabled) {
    return {
      visibility: "unguarded",
      role,
      isOwner,
      bypassesRls,
      detail: `row-level security is disabled on ${schema}.${table}, so nothing confines a tenant's rows`,
    };
  }
  if (!sessionWouldBeConfined(v)) {
    return {
      visibility: "visible",
      role,
      isOwner,
      bypassesRls,
      detail:
        `'${role}' is exempt from ${schema}.${table}'s policies (${sessionPolicyVisibilityReason(v)}), ` +
        "so a cross-tenant claim sees every tenant's runs",
    };
  }
  return {
    visibility: "confined_by_rls",
    role,
    isOwner,
    bypassesRls,
    detail:
      `Postgres will apply ${schema}.${table}'s policies to '${role}' ` +
      `(${sessionPolicyVisibilityReason(v)}), and the table has only a tenant-isolation policy — so ` +
      "a single cross-tenant claim with no app.current_tenant_id set matches nothing. " +
      (v.rlsForced && isOwner
        ? "Owning the table is not enough here: FORCE ROW LEVEL SECURITY confines the owner too. "
        : "") +
      "The job worker claims per tenant under each tenant's own context (claimDueJobsPerTenant), " +
      "which serves the queue for this role; granting it BYPASSRLS would end the confinement the " +
      "serving role exists for (ADR-0424) and is not the remedy",
  };
}

/**
 * Hands a claimed-but-unexecuted job back for immediate re-claim (scoped to the owning worker).
 *
 * Under the run's own tenant context, with `tenant_id` in the predicate too. `meta.job_runs` carries
 * one `ALL`-scope tenant-isolation policy, so without the context a session that policy confines —
 * the shipped serving role, ADR-0424 — matched 0 rows silently and the claim was not released; the
 * predicate keeps an exempt session (the owner opt-out) to the same one row. The tenant travels from
 * `ClaimedJob.tenantId` through `JobClaimer.release`, which is what made it a contract change across
 * the timer, activity and job paths rather than a parameter here.
 */
export async function releaseJobClaim(
  conn: PgConnection,
  options: {
    readonly jobId: string;
    readonly workerId: string;
    readonly tenantId: string;
    readonly schema?: string;
  },
): Promise<void> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  await withTenantContext(conn, options.tenantId, (tx) =>
    tx.query(
      `UPDATE ${schema}.job_runs
          SET claimed_by = NULL, claim_expires_at = NULL
        WHERE run_id = $1 AND claimed_by = $2 AND status = 'pending' AND tenant_id = $3::uuid`,
      [options.jobId, options.workerId, options.tenantId],
    ),
  );
}

/**
 * Extends the lease on a job this worker still holds (for a slow handler). Returns `true` only if the
 * row updated — still `pending` AND still owned; `false` means the lease was lost.
 *
 * Scoped for `releaseJobClaim`'s reason. Unscoped, a confined session answered `false` — *the lease
 * was lost* — for a lease the worker still held, so every slow handler was re-claimed by another
 * replica while it ran and executed twice.
 */
export async function renewJobClaim(
  conn: PgConnection,
  options: {
    readonly jobId: string;
    readonly workerId: string;
    readonly tenantId: string;
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
  const result = await withTenantContext(conn, options.tenantId, (tx) =>
    tx.query(
      `UPDATE ${schema}.job_runs
          SET claim_expires_at = $3::timestamptz
        WHERE run_id = $1 AND claimed_by = $2 AND status = 'pending' AND tenant_id = $4::uuid`,
      [options.jobId, options.workerId, claimExpiresAt, options.tenantId],
    ),
  );
  return (result.rowCount ?? 0) > 0;
}
