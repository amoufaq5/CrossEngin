import { assertScopeTenantId, type PgConnection } from "@crossengin/kernel-pg";

/**
 * Sets `app.current_tenant_id` for the *current transaction only*
 * (`set_config(..., is_local => true)`), so the row-level-security policy on the job queue's three
 * tables (`tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID`) admits the
 * row a producer is writing. A `SELECT set_config(...)` rather than `SET LOCAL` so the tenant id
 * rides as a bound `$1` parameter instead of being interpolated into SQL text.
 *
 * This module exists because every writer in this package issued a bare `conn.query`, and
 * `meta.job_runs` / `meta.dead_letter_jobs` each carry exactly **one** `ALL`-scope isolation policy
 * with a NULL `WITH CHECK` — so the `USING` doubles as the write check and, with no context set, the
 * predicate is `tenant_id = NULL`, which is never true. Measured live on PG 16.13 as the non-owner
 * `serving` role, both arms rolled back: today's statement answers
 * `ERROR: new row violates row-level security policy for table "job_runs"` (42501), and the same
 * statement inside this wrapper answers `INSERT 0 1`.
 *
 * **An `INSERT` is the loud case and the quiet ones are worse.** The same `USING` governs which rows
 * an `UPDATE` or a `SELECT` can see, so an unscoped one matches **0 rows silently** — no error code,
 * nothing in a log — and every caller here reads a zero `rowCount` as *somebody else got there
 * first*. That is why this module reaches ten statements and not three: `executeJobRun`'s own read
 * matched nothing, so the queue could enqueue runs it could never execute, and `finalizeFailure`'s
 * `UPDATE` returned `not_claimable` one line *before* `recordDeadLetter`, so the dead-letter fence
 * below could never fire. Fencing the `INSERT`s alone would have been a fix whose own effect was
 * unreachable. It worked at all only because the shipped
 * compose connects as `POSTGRES_USER` — the role that ran `migrate` — and a table's owner bypasses
 * RLS, so the whole job queue was owner-dependent and stopped working the moment a deployment used
 * a least-privilege serving role, which is the configuration every other store here is written for.
 *
 * **Why this and not a platform write arm.** ADR-0332's pattern is
 * `tenant_id IS NULL AND current_setting('app.platform_record_write', true) = 'on'`, and
 * `PLATFORM_WRITE_GRANTS`' own doc says it covers "every tenant-scoped meta table whose `tenant_id`
 * is **nullable**". These three declare `tenant_id` NOT NULL with a `meta.tenants` reference, so such
 * a policy is unsatisfiable by any row the column permits — created live, grant claimed, and the one
 * row it admits refused by
 * `null value in column "tenant_id" of relation "job_runs" violates not-null constraint`. A policy
 * with no admissible case is not a policy (ADR-0375), and naming one as the remedy is worse than
 * naming none (ADR-0334). The scope here is a *fact about the row* — every producer already holds the
 * tenant it is enqueueing for — which is what makes the ordinary tenant context the honest answer
 * and is the same fix ADR-0333 swept into fourteen stores and ADR-0335 applied to two more.
 *
 * **Which statements it reaches is decided by one question: does the caller hold the row's tenant?**
 * The thirteen writes and reads against these tables fall into three groups, and the two it does not
 * reach are left for opposite reasons rather than both being unfinished.
 *
 * *Fenced (10)* — every statement whose caller already has the tenant in hand: the three producers'
 * `INSERT`s, `recordDeadLetter`'s, `executeJobRun`'s read and its three finalizing `UPDATE`s, and
 * `job-cancellation.ts`'s request/observe/finalize statements. For these the scope is a **fact about
 * the row**, so there is nothing to decide.
 *
 * *Cross-tenant by design (2)* — `claimDueJobs` and `reapCancelledJobRuns` sweep every tenant so one
 * fleet serves all of them, and `reapCancelledJobRuns` *returns* the tenant ids it found. There is no
 * single scope to set, and a platform *read* arm could not express it either for the same NOT NULL
 * reason. What a confined session's claim can see is the question `probeJobQueueVisibility` already
 * answers at boot (ADR-0334), and a negative-control test asserts the reaper issues no context
 * statement, so a later "completeness" edit cannot quietly turn a cross-tenant sweep into a
 * single-tenant one.
 *
 * *Blocked by a contract, not by wiring (2)* — `releaseJobClaim` and `renewJobClaim` take
 * `{jobId, workerId}` and **no tenant at all**, so they cannot be fenced without widening a
 * signature. The worker *does* hold it (`ClaimedJob.tenantId`, and `JobCancellationWatcher`
 * already takes `{jobId, tenantId}`), so the fact is one hop away — but `ClaimRenewer` is shared
 * with the timer and activity workers, so adding it there is a three-path contract change rather
 * than a parameter. Deferred on a stated cost: a lost release or renew is **recoverable**, because
 * the lease lapses and the run is re-claimed, where a lost finalize is not. That is the only reason
 * it is the safe half to leave; see this increment's ADR.
 *
 * A **ninth** spelling of a function this workspace already holds in eight packages, which is a known
 * and named debt: CLAUDE.md records it for `scopeFilter` — "copies exist for want of a shared home;
 * it belongs in `kernel-pg`'s `connection.ts`" — and ADR-0334 closed that one by moving it there and
 * having each package re-export from the module that held the copy. The same move is **not** mechanical
 * here, and the census is why, so it is written down rather than assumed. **15** packages declare
 * `SET_TENANT_CONTEXT_SQL`, and they do three different things with it: **9** wrap it in a
 * `withTenantContext` (this one included), **4** wrap it as `scopedRead`/`scopedWrite`
 * (`api-gateway-pg`, `certification-runtime-pg`, `dr-runtime-pg`, `observability-runtime-pg`), and
 * **2** issue it inline with no wrapper at all. So converging is a decision about which of two
 * competing names wins, not a move of identical copies — and one of the two inline packages,
 * `feature-flags-pg`, is inline *for a reason*: its `tenant_id` is nullable, so every site reads
 * `if (tenantId !== null) await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId])`, and a wrapper taking a
 * non-null `tenantId` would hide the arm that makes a platform-wide flag writable.
 *
 * `assertScopeTenantId` is imported rather than re-spelled, and that part *is* settled:
 * `/^[0-9a-fA-F-]{1,64}$/` with `invalid tenantId for RLS context: ${JSON.stringify(tenantId)}` is
 * byte-identical in **6** local `TENANT_ID_RE` copies plus a seventh in `apps/operate-server`'s
 * `cli.ts`; `crypto-pg` and `forensics-pg` already import this one. The exception is deliberate and
 * kernel-pg's own doc names it: `dr-runtime-pg` keeps a **stricter** full-UUID regex and its own
 * message, so "every sibling carries an identical copy" would be false of the one package that
 * thought about it. `operate-runtime-pg`'s copy additionally carries a `settings` arm whose only
 * caller is local, so a shared form would start with a parameter one package uses.
 */
export const SET_TENANT_CONTEXT_SQL = "SELECT set_config('app.current_tenant_id', $1, true)";

/**
 * Runs `fn` inside a transaction with the tenant RLS context established, validating the tenant id
 * to a UUID-ish shape first so a malformed value fails fast rather than silently widening scope.
 *
 * The transaction is a **change in behaviour and an improvement**, worth knowing before reading the
 * producers: each of them loops, issuing one `INSERT … ON CONFLICT (tenant_id, run_id) DO NOTHING`
 * per planned run, and those statements used to commit one at a time. Inside one transaction a
 * failure part-way rolls the batch back instead of leaving a prefix committed — which is only safe
 * because every `run_id` is derived deterministically from `(tenant, job, trigger)`, so the retry
 * re-derives the same ids and the conflict clause makes the second attempt a no-op for whatever
 * landed. All-or-nothing over a prefix is the better of the two for a caller that will retry.
 */
export async function withTenantContext<T>(
  conn: PgConnection,
  tenantId: string,
  fn: (tx: PgConnection) => Promise<T>,
): Promise<T> {
  assertScopeTenantId(tenantId);
  return conn.transaction(async (tx) => {
    await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
    return fn(tx);
  });
}
