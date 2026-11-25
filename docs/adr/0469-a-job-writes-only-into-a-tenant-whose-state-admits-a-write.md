# ADR-0469: A job writes only into a tenant whose state admits a write, and the queue around it says what it does

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-25 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0334 (tenant lifecycle and `--tenant-status-gate`), ADR-0430 (job handlers write through the system writer), ADR-0440 (per-tenant claim), ADR-0389 (queue writers set tenant context), ADR-0363 (value-granular admission), ADR-0360 (savepoint: `RELEASE` after `ROLLBACK TO`), ADR-0413 (`producer_unmounted`), ADR-0372 (tests that pin a defect) |

## Context

ADR-0430 made a background job write through the same guards and effects as an HTTP request, as a
`system` actor. ADR-0440 made the worker claim one tenant at a time. Neither asked whether the
tenant a run belongs to may still be written.

Re-measured against the tree before designing:

- **The claim reads every tenant not yet `deleted`.** `JOB_CLAIM_EXCLUDED_TENANT_STATUSES` excludes
  only `deleted`, deliberately: a `suspended` tenant's backlog must not vanish. So a run enqueued
  while a tenant was active is claimed after it moves to `suspended`, `archived` or
  `pending_deletion`.
- **The system writer consults the tenant's state only through the request-path gate.** The writer
  dispatches through the gateway's handlers, which `applyTenantStatusGate` decorates in place, so
  on the shipped compose (which passes `--tenant-status-gate`) a write into a blocked tenant is
  answered `403` and the handler records `writes_refused`. Without the gate
  (`--no-tenant-status-gate`, or a deployment that predates it) **the write lands**: a run claimed
  for a `pending_deletion` tenant marks its invoices overdue, posts its depreciation and raises its
  purchase orders into data the Article 17 runner is about to destroy. The gate is a request-path
  control; a job is not a request, and its refusal arrived at the first write rather than before
  the first read.
- **One tenant's failed claim took every tenant's claim with it.** `claimDueJobsPerTenant` runs the
  visits in one transaction, so a raise in one tenant aborted it and every later statement answered
  `25P02`.
- **A lost lease did not stop the handler.** `renewWhile` reported `onLeaseLost` and let the task
  run on. Firing a timer is idempotent; a job handler's business writes are not, and a run whose
  lease lapsed is re-claimed and re-executed by another worker.
- **`POST /v1/meta/jobs/invoke` answered `202` for work nothing could execute**, enqueuing a run for
  a job no handler serves, and a throwing enqueue escaped as an unclassified 500.
- **The depreciation catch-up read only its window**, so a draft older than the window (left by a
  run that failed between writing the entry and posting it) was never resumed.
- **`producer_unmounted` said "this deployment does not mount"** while `mountedProducers` is derived
  from this process's flags; another replica may mount the producer.
- **The replay probe's confined detail named the job worker** ("claimDueJobsPerTenant serves the
  queue") for a replay of the workflow projections.
- **Nothing checked that `meta.job_runs.status` admits the statuses the engine writes.** A CHECK
  refusing `dead-lettered` or `cancelled` raises `23514` inside the finalize, after the handler's
  writes committed, so the run stays `pending` and is re-executed.

## Decision

**A system write consults the tenant's standing before it writes, and the answer is a union, not a
boolean.**

- `@crossengin/operate-runtime`'s `SystemActor` gains a **required** `standing: TenantStandingReader`
  answering `writable`, `blocked {status}` or `unknown {reason}`. `dispatch` asks it before every
  write (after the operation-served checks, before the sequence counter moves), and
  `TenantEntityAccess.assertWritable()` lets a handler ask once before its first read. `blocked`
  throws `TenantNotWritable` (`retryable = false`), `unknown` and a throwing reader throw
  `TenantStandingUnknown` (`retryable = true`): not knowing must not admit the write, and must not
  dead-letter work a blip kept from being checked. Required rather than defaulted, because an
  optional reader defaulting to *writable* is the defect restated as a default.
  `NO_TENANT_REGISTRY_STANDING` is the named answer for a store with no tenant registry.
- The rule lives in `apps/operate-server`'s `tenantStandingFromDirectory`, which calls
  `blocksWrites` from `@crossengin/tenant-lifecycle` rather than restating it, so
  `@crossengin/operate-runtime` and `@crossengin/workflow-runtime-pg` stay free of the lifecycle
  package. It reads **the request-path gate's directory** when the gate is mounted, so a job and a
  request cannot disagree about one tenant; otherwise its own cached directory over
  `meta.tenants.status`. No row is `blocked` as `unprovisioned`.
- `buildErpJobProviders` takes the reader as a required input. Each handler calls
  `assertWritable()` before its implementation, and the two errors map to
  `failed("tenant_not_writable", "tenant_not_writable:<status>", false)` — finalized `failed` and
  dead-lettered — and `failed("tenant_standing_unknown", …, true)`. The starter-chart actor gets the
  same reader, built lazily because it is constructed before the directory, answering `unknown`
  (refusing) until built.

**The claim isolates each tenant in a savepoint.** `claimDueJobsPerTenant` wraps each visit in
`SAVEPOINT job_claim_tenant`; a raise is `ROLLBACK TO` **and** `RELEASE` (the savepoint survives a
rollback, ADR-0360), the tenant is recorded in `failedTenants`, and a **required**
`onTenantClaimFailed` names it, with `firstVisit` saying whether the failed visit was the one that
ran the reap. `buildJobClaimer` drops the reaped runs of a tenant whose **first** visit failed, since
that sweep rolled back with the claim; a tenant that filled its share in pass one and failed in pass
two keeps its committed reap, and dropping it there would under-report one. The supervisor reports
it per tenant, throttled.

**A lost lease aborts a job handler.** `renewWhile` accepts a function of an `AbortSignal` and
aborts it with a `LeaseLostError` only when a renew answers a definite `false`; a renew that throws
stops the heartbeat and does not abort, because the lease may still be held and an aborted handler
under a held lease is finalized `cancelled`. The promise form, used by the timer and activity paths,
is unchanged. Both job processors compose the lease signal with the cancellation signal.

**The invoke route refuses work it cannot run.** `JobInvoker.invoke` answers an outcome:
`no_listener` (404), `not_served` (409 `job_not_served`, before any statement), `queue_unavailable`
(503 `job_queue_unavailable`, `retry-after: 30`) and `enqueued` (202, naming any unserved job ids
beside the runs). `PostgresJobInvoker` takes `servedJobIds` (a thunk, since the registry is built
after the route) and a required `onError` receiving the action, the tenant, the deterministic run
ids the failed statement was writing and the remedy. The catch is around the enqueue statement
alone, inside the invoker; the route handler has **no** catch, so anything else an invoker throws
(the planner, the served-set thunk, an injected invoker) is the dispatch stage's 500, logged under
the request id, rather than a retryable 503 that claims a queue outage and records nothing.

**The job worker serves every registered handler, not only the produced ones.** `node.ts` gated the
job engine, its claim scope and (in this change) the status-admission refusal on `servedJobIds`,
which is *handled and producible from this process* — it drops a declaration whose producer this
process does not mount. So a worker-only replica on a split fleet served nothing: it refused its job
worker as `no_job_handlers` ("no job handler is registered in this process", with five registered),
and every run the producing replica enqueued sat `pending`. Measured live before the fix:
`[jobs] 14 declaration(s): 0 served, 14 unservable; producers mounted: none`, the job worker not
started, a pending run never claimed. The worker now reads `executableJobIds` — every declaration
the registry resolves a handler for — which is what makes the `producer_unmounted` detail's *another
replica may mount it* true of the execution as well as the enqueue.

**Smaller corrections.** The depreciation catch-up also reads every draft older than its window and
resumes it. `producer_unmounted` says "this process" and that another replica may mount the
producer. `probeJobQueueVisibility` takes a `subject`, and the replayer passes its own.

**The status admission is checked at boot.** `JOB_RUN_STATUSES_WRITTEN` (`pending`, `completed`,
`failed`, `dead-lettered`, `cancelled`, fenced against the three writing modules as text) is passed
to `admissionBlocksValues`. A refusal **refuses the boot** when this process mounts the job worker
and serves at least one job, and warns otherwise, printing `admissionRemedy`'s `ALTER` either way.

## Alternatives considered

- **Narrow `JOB_CLAIM_EXCLUDED_TENANT_STATUSES` to skip blocked tenants.** Refused: a suspended
  tenant's runs would never be claimed, so nothing would say why they stay pending, and a tenant
  restored to `active` would have its backlog run with stale triggers. Claiming and refusing by name
  is the honest disposition.
- **Rely on the request-path gate.** Refused: it is a request control that a deployment can turn off,
  it refuses at the first write rather than before the first read, and its refusal is a handler 403
  rather than a named job outcome.
- **A boolean `blocksWrites(tenantId)` on the writer.** Refused: it cannot carry *could not read*,
  which must refuse and must be retryable.
- **Abort on any failed renew.** Refused: a renew that throws says nothing about the lease.

## Consequences

- A run claimed for a `suspended`, `archived`, `pending_deletion` or `deleted` tenant is finalized
  `failed` with `tenant_not_writable:<status>` and dead-lettered, and writes nothing. A tenant
  restored to `active` is written by the next run once the directory's TTL (30 s by default) lapses.
- A failing tenant no longer stops the other tenants' claims.
- `POST /v1/meta/jobs/invoke` answers 409 and 503 where it answered 202 and 500. On this binary no
  `userInvoked` declaration has a handler (the five handled `erp-core` jobs are scheduled or event
  triggered, and no pack declares a `userInvoked` job), so a matching invocation is always 409 and
  the 503 and 202 arms are reachable only from a deployment's own handler — measured, not assumed.
- A worker-only process executes runs another process enqueued.
- An `erp-core` boot serving jobs on a database whose `job_runs.status` CHECK was narrowed by hand
  now refuses to start.

## Implementation notes

- `packages/operate-runtime/src/system-writer.ts`: `TenantStanding`, `TenantStandingReader`,
  `NO_TENANT_REGISTRY_STANDING`, `TenantNotWritable`, `TenantStandingUnknown`, `assertWritable`.
- `packages/operate-runtime/src/job-invoke-handler.ts`: `JobInvocationOutcome`,
  `JOB_QUEUE_RETRY_AFTER_SECONDS`.
- `packages/workflow-runtime-pg/src/job-claim.ts`: the savepoint, `TenantClaimFailure`,
  `JOB_CLAIM_TENANT_SAVEPOINT`, `QueueVisibilitySubject`, `JOB_RUN_STATUSES_WRITTEN`; the per-tenant
  cost comment now reads four statements (savepoint, context, claim, release), `4N + 2` per idle poll.
- `packages/workflow-worker/src/renew.ts`: `LeaseLostError`, the signal-taking task form.
- `apps/operate-server/src/job-tenant-standing.ts` (new), `erp-job-handlers.ts`, `job-invoke.ts`,
  `workflow-workers.ts`, `node.ts`.
- Outside the slice, updated because `SystemActor.standing` is required: `starter-chart.test.ts` and
  `starter-chart.integration.test.ts`.

## Verification

Per package, after the review's fixes: `@crossengin/operate-runtime` typecheck clean, 1,885 tests;
`@crossengin/jobs` 232; `@crossengin/workflow-worker` 69; `@crossengin/workflow-runtime-pg` typecheck
clean, 674; `apps/operate-server`'s affected suites (`node`, `workflow-workers`, `job-invoke`,
`job-tenant-standing`, `erp-job-handlers`, `starter-chart.integration`) pass, and its typecheck's one
remaining error is in `notification-store.ts`, another slice's file in the same tree. The
operate-runtime figure includes other slices' tests in the same tree and is not this change's count.

Mutation checks: removing the writer's standing check fails 4 tests; removing the savepoint rollback
fails 2; removing the lease abort fails 1 in `workflow-worker` and 2 in `workflow-runtime-pg`;
reporting a failed tenant's reaped runs fails 1 (the test was vacuous until the fake let the sweep
succeed and only the claim raise); replacing `blocksWrites` with `false` fails 2; dropping the
depreciation draft merge fails 1.

Live on PostgreSQL 16 (port 5441), catalog applied by the owner with `crossengin apply` (994
statements), the API connecting as `crossengin_app` (`NOSUPERUSER NOBYPASSRLS`, owning nothing,
boot line *confined on all 115 policied tables*), `--store pg --pack erp-core --workflow-workers
--schedule-ms 600000 --no-tenant-status-gate`, so the request-path gate is off and the writer's own
check is the only fence:

| Arm | Tenant state | Result |
|---|---|---|
| 1 | `bravo` `pending_deletion`, one sent invoice past due, one pending run | run `failed`, `{"code":"tenant_not_writable","message":"tenant_not_writable:pending_deletion"}`, one `dead_letter_jobs` row `permanent-error`, invoice still `sent`, 0 audit rows |
| 1 control | `acme` `active`, identical data | run `completed` `{"examined":1,"marked_overdue":1}`, invoice `overdue`, one `invoice.mark_overdue` audit row |
| 2 | `bravo` set back to `active`, a new run | `completed` `{"examined":1,"marked_overdue":1}`, invoice `overdue` — the refusal was the state, not the data |
| 3 | `job_runs.status` CHECK narrowed to four values, worker mounted | boot exit 1: `fatal: [jobs] meta.job_runs.status refuses 'dead-lettered', 'cancelled' …` with the `BEGIN; ALTER TABLE … DROP CONSTRAINT …` remedy |
| 3 control | same CHECK, no `--workflow-workers` | boots, the same line as a warning ending *(no worker here executes runs, so this is a warning)* |

The boot printed `[jobs] tenant standing: every job write is refused, non-retryably, for a tenant
whose state blocks writes …, read from meta.tenants.status` and the `producer_unmounted` details
in the per-process wording. Server and cluster stopped afterwards.

The review added four live arms on the same cluster, the API again as `crossengin_app`:

| Arm | Setup | Result |
|---|---|---|
| 4 (pre-fix) | `--pack erp-core --workflow-workers` and no producer flag (a split fleet's worker replica); a pending overdue run for `acme`, inserted as another replica's producer writes it | `0 served … producers mounted: none`, `job worker not started (no_job_handlers)`, the run still `pending` after the poll window |
| 4 (post-fix) | the same process and run | `job worker started`, the run `completed` `{"examined":1,"marked_overdue":1}`, the invoice `overdue` |
| 5 | an owner-installed `BEFORE UPDATE` trigger raising for `bravo`'s rows when `claimed_by` is set; one pending run each for `acme` and `bravo` | `acme` `completed`, `bravo` `pending`, and `[workflow-workers] job claim for tenant 2222… failed and was rolled back; the other tenants were still claimed` — the savepoint on real Postgres, not on a fake |
| 5 control | the trigger dropped | `bravo`'s run `completed` on the next poll |
| 6 | `--manifest` with an extra `userInvoked` job `adhoc-reindex` (no handler), `--enable-job-invoke` | `POST … {"action":"reindex-now"}` **409** `job_not_served` naming `adhoc-reindex`; `meta.job_runs` 9 rows before and after; an unknown action **404** |

Not run live: the lease-loss abort (covered by tests that abort only on a definite `false`), and the
invoke route's 503 and 202, which this binary cannot reach (see Consequences).

## Open questions

1. **The standing directory is cached** (30 s by default, the gate's figure), so a tenant moved to
   `pending_deletion` can still be written by a job for up to that long. The gate has the same
   window; closing it needs the lifecycle transition to evict the cache, which crosses processes.
2. **A refused run is dead-lettered and not re-armed.** A tenant restored to `active` gets the next
   scheduled tick, not the refused one. Whether a restore should re-enqueue the dead-lettered runs is
   a product decision.
3. **The starter-chart actor's reader is lazy.** It answers `unknown` until the directory is built,
   which is before the listener opens, so the arm is unreachable; a later refactor that provisions a
   chart at boot would meet it as a refusal rather than a write.
4. **The invoke route still answers 202 for a run whose tenant is blocked**, because the invoker does
   not consult the standing; the run is then refused by the writer. Refusing at the route would be
   earlier and needs the reader there.
5. **`renewWhile`'s throw arm keeps running a handler whose lease may be gone.** Aborting only on a
   definite `false` is the safe direction for the run's own record and the unsafe one for a second
   worker that re-claims it; the engine's `claimed_by` fence is what stops the double finalize, and
   it does not stop the double business write.

## References

- `packages/operate-runtime/src/system-writer.ts`, `packages/workflow-runtime-pg/src/job-claim.ts`,
  `packages/workflow-worker/src/renew.ts`, `apps/operate-server/src/job-tenant-standing.ts`,
  `apps/operate-server/src/job-invoke.ts`, `apps/operate-server/src/node.ts`.
