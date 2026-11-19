# ADR-0442: A workflow undoes only what completed, and a claim is reaffirmed before its item runs

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-19 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0440 (`claimDueJobsPerTenant`, which the live job arms below run on), ADR-0408 (the read-order rule and the refused snapshot primitive — register P2.17), ADR-0389 (tenant context on the job queue; a fake `transaction` that discards its callback), ADR-0430 (the job write seam and `erp-job-handlers.ts`), ADR-0334 (cron timers, the claim released when `fire_count` advances), ADR-0329 (instance cancellation), ADR-0424 (the API connects as `crossengin_app`) |

## Context

The external due-diligence audit's **H-17** says the workflow engine is unreachable and, if it were
wired, carries correctness defects (module findings R14-01, R14-02, R15-02, R15-03, R15-04). **M-27**
(R14-05) is a cron day-skip that misses fires near a DST spring-forward. Register **P2.17** is the
workflow replayer comparing a projection with equality across separate reads. Measured before the
change:

1. **Saga compensation ran for activities that never completed** (R14-01), and **a compensation that
   threw, or had no handler registered, was recorded as `activity_compensated`** (R14-02), so the
   instance ended `compensated` and the failure was never retried.
2. **A claimed batch was renewed one item at a time** (R15-02). A batch claims every item at once and
   only the executing item was renewed, so items queued behind a slow one lost their lease and could
   run on a second worker.
3. **A job run's finalizing `UPDATE` did not check who held the claim** (R15-03), so a stale worker
   could finalize a run another worker had claimed.
4. **A throwing job handler was recorded as non-retryable** (R15-04), and the poll loop slept the
   short interval after every non-empty batch — including one where every item failed — so a failing
   queue spun.
5. **M-27.** In `America/New_York`, `15 0 * * 1` from 2026-03-02 returned **2026-03-16** instead of
   2026-03-09: a 23-hour day made the day-skip step past the next match.
6. **P2.17**, measured live on PG 16 by the implementer with 60 instances started and signalled while
   the replayer verified them concurrently:

   | Append | Replayer reads | False drift / checks |
   |---|---|---|
   | separate statements | separate statements | **245 / 2,314** |
   | separate statements | one snapshot | 172 / 1,532 |
   | one transaction | separate statements | 37 / 884 |
   | one transaction | one snapshot | **0 / 1,076** |

   At rest every arm showed 0. So neither half fixes it alone.
7. **On the confined role the engine could not start an instance**: `startInstance` failed with
   "definition not found", because the engine's lookups run with no tenant context.

## Decision

**Only completed work is compensated, and a compensation that did not happen is not recorded as one.**
`listCompensatableActivities` admits only activities with an `activity_completed` event. A failed,
throwing or unregistered compensation writes `compensation_step_completed`, not
`activity_compensated`, and the run ends `instance_failed` with code `COMPENSATION_INCOMPLETE`.
Cancellation results gain `failedCompensationActivityIds`, which the cancel route reports.

**A claim is reaffirmed immediately before its item runs.** `reaffirmClaim` renews each claim just
before the item starts; a renew that matches no row, or throws, skips the item as `lease_lost` and
does not release it. The timer, activity and job workers take a **required** `claimRenewer`, and the
supervisor and the `workflow-runtime-pg` builders always pass one — required because an optional
renewer defaulting to *do not renew* is the defect restated as a default.

**A job run is finalized only by the worker that holds it.** `executeJobRun` takes a required
`claimedBy` and adds `AND claimed_by = $n` to its read and to every finalizing `UPDATE`. The fence is
the trailing spread `...fenceParam(claimedBy)` at the end of an array literal, because a helper call
in the parameter position is unreadable to the binding rules and produced two findings of the
implementer's own plus one spurious `job-claim.ts:465` finding.

**A handler that throws without being aborted is a retryable failure** under the run's max-attempts
and backoff, ending dead-lettered. The poll waits the short interval only when an item succeeded;
otherwise it waits the idle interval.

**The cron day-skip walks back to the true day boundary**, in both directions.

**An event and every projection it moves commit together, and the replayer reads them from one
snapshot.** `ProjectingEventLog` writes the event and its projections in one transaction under the
event's tenant context, through a **required** `appendUnit`; `buildPersistentEngine` supplies
`transactionalAppendUnit`. The id-cache resolvers gain `boundTo(conn)` so the pool and the
transaction share one cache, and a rolled-back `instance_started` removes its cached id.
`WorkflowReplayer.verifyInstance` reads the log and all four projections inside one read-only
repeatable-read transaction whose first statement is `SET TRANSACTION ISOLATION LEVEL …`. The
equality comparison stays: under one snapshot, over an atomic append, it is sound.

**No route publishes a definition, starts an instance or submits a signal, and the boot line says
so.** `WORKFLOW_ENGINE_UNREACHABLE_REASONS` carries the two reasons and `node.ts` prints
`formatWorkflowEngineReach`: what mounted the engine, that no route creates instances, and a warning
when the connection is RLS-confined on `meta.workflow_events`.

## Alternatives considered

- **Add publish, start and signal routes (H-17's "unreachable").** Refused, for two reasons now in
  `WORKFLOW_ENGINE_UNREACHABLE_REASONS`. Definitions are loaded once at boot, so a publish route would
  report success and change nothing until a restart. And the engine's reads set no tenant context:
  measured live as the non-owner, the transactional append wrote the instance and its event (1 and 1
  rows) and the engine's own unscoped read-back then failed with "projection failed after start", so
  a start route would fail the same way. Review judged the argument plausible.
- **Fix P2.17 with one half.** Refused on measurement (table above): a snapshot over the old append
  still drifted 172 / 1,532, and the atomic append under the old reads 37 / 884.
- **Replace the replayer's equality with a one-sided comparison** (one of ADR-0408's two named
  remedies). Not taken: once the append is atomic and the read is one snapshot, equality is sound,
  and the measurement above shows the drift came from the two halves rather than the comparison.
- **A monotonic fencing token instead of the worker id.** Not taken in this increment. The worker id
  is sound because one worker processes its batches one at a time; review records the case it does
  not cover (open question 1).
- **An attempt cap for timers and activities.** Not taken: a real cap needs a new column in the
  shared `meta-schema.ts` (open question 2).

## Consequences

- **Positive:** a cancelled or failed instance no longer runs compensations for work that never
  happened, and a failed compensation is visible as `COMPENSATION_INCOMPLETE` instead of reading as
  success; no claimed item runs after its lease is lost; a stale worker cannot finalize a run; a
  failing job is retried and then dead-lettered instead of spinning; a weekly cron no longer loses a
  week; the workflow replayer stops reporting drift on healthy instances under load.
- **Negative:** each item now costs one renew round trip before it runs; the append is one
  transaction per event, so a projection write that fails now rolls the event back with it.
- **Neutral:** the engine is still unreachable from any route and still cannot run as the confined
  role. The difference is that the boot line and the replayer (`verifiable: false`) say so instead of
  reporting health.
- **Reversibility:** every change is code-local and removable; no schema changed.

## Implementation notes

- Changed: `packages/jobs/src/cron.ts`; `packages/workflow-runtime/src/` (`saga.ts`, `engine.ts`);
  `packages/workflow-worker/src/` (`renew.ts`, `batch.ts`, `activity-batch.ts`, `job-batch.ts`,
  `activity-types.ts`, `job-types.ts`, `worker.ts`, `activity-worker.ts`, `job-worker.ts`);
  `packages/workflow-runtime-pg/src/` (`id-mapping.ts`, `projecting-event-log.ts`,
  `persistent-engine.ts`, `replayer.ts`, `job-engine.ts`, `job-cancellation.ts`, `job-worker.ts`,
  `timer-worker.ts`, `activity-worker.ts`, `index.ts`, new `engine-reach.ts`);
  `apps/operate-server/src/` (`workflow-workers.ts`, `workflow-cancellation-routes.ts`, `node.ts`:
  one import and one boot-line block; `erp-job-handlers.ts`: a comment only), each with its tests.
- **Two fakes discarded their `transaction` callback** (`workflow-workers.test.ts`,
  `persistent-engine.test.ts` — ADR-0389's class), which hid the supervisor wiring. Fixing them
  showed the earlier "workflow-workers passes" was also wrong: once renewals succeed, a heartbeat with
  an immediate test sleep spun until the worker ran out of memory. The fake now answers each renew
  once.
- **Review closed seven vacuous fences**, each one where removing the wiring left every test green:
  the timer and activity workers passing their renewer to the batch, and their poll gate; the
  supervisor's `pollOnce` reaffirming activities and jobs and fencing a job on its own claim
  (`claimedBy: "operate-server-1"`); and the `workflow-runtime-pg` activity and job builders renewing
  under the right tenant (`[id, "worker-A", leaseExpiry, TENANT]`) and skipping a lost item. Review
  also corrected `erp-job-handlers.ts`, whose comment said a throw "leaves the run pending and
  re-claimed for ever".
- **In process** (review's run, which supersedes the implementer's where the counts differ): jobs
  231/231, workflow-engine 284/284, workflow-runtime 303/303, workflow-runtime-pg 664/664,
  workflow-worker 66/66, the four operate-server files (`workflow-workers`,
  `workflow-cancellation-routes`, `erp-job-handlers`, `node`) 179/179, testing 906/906; typecheck 0
  on all six packages. The implementer's earlier testing run was 905/906, the one failure an
  undeclared read in `ai-architect-runtime-pg/src/cost-store.ts` outside this slice.
- **Mutation-checked** (implementer, each reversed): cron settle removed forward / backward (3 / 2
  fail); compensation always recorded as `activity_compensated` (2); reaffirm disabled / a renew error
  treated as held (3 / 1); poll gate reverted (1); a rolled-back instance id left in the cache (1);
  `appendUnit` ignored (3); tenant context not set in the append (2); `buildPersistentEngine` without
  the transactional unit (1); replayer without `SET TRANSACTION` / with its reads back on the pool
  (1 / 1); supervisor timer worker given no renewer (1). Review mutation-checked each of its seven
  fences with a harness.
- **M-27 offline** (review): a brute-force comparison against a minute-by-minute naive search over 10
  zones (including Lord_Howe, Chatham, Santiago, Havana and Beirut), 8 expressions and ±48 h around
  every 2026 offset change — 2,448 cases, each checking the next and the previous match. The new
  `cron.ts` has **0** mismatches; HEAD's, built separately, has **129**.
- **P2.17 by review**, live through the real `buildPersistentEngine` and `WorkflowReplayer` as the
  owner, 30 instances per run with their 30 signals delivered concurrently with 120 `verifyInstance`
  calls: **0 false drift in 600** over 5 runs and 0 in the quiet re-verify, every instance reaching
  `completed|approved`. With the `SET TRANSACTION … REPEATABLE READ READ ONLY` statement removed from
  `dist`: **2 in 720** over 6 runs. Corrupting `current_state` by hand is reported `drifted: true`
  with the field named.
- **Live on PG 16** (the independent live run, which supersedes both reports where they differ), an
  in-process harness against the cluster with the connection as `crossengin_app`:
  - Jobs, running on ADR-0440's per-tenant claim: the unscoped claim still claims 0 (control) and the
    per-tenant claim claims 1. Worker B executing worker A's claim: `not_claimable`, handler called 0
    times, row untouched. A handler that always throws with `maxAttempts: 2`: first
    `retry_scheduled` (attempt 2, `error.code = handler_threw`, a 900-character message capped at
    500), then after re-claim `dead-lettered`, one row in `meta.dead_letter_jobs`, 2 handler calls.
  - P2.17 as the owner, 30 instances × 30 signals concurrent with 120 verifies, three runs:
    **0/120** concurrent drift each time, 0 quiet drift, 0 signal errors.
  - The replayer as `crossengin_app`: `verifiable: false`, `probeVisibility` `confined_by_rls` on
    all five tables; as the owner, `verifiable: true, drifted: false`.
  - Engine start as `crossengin_app`: "definition not found" before, "projection failed after start"
    after (open question 4).
  - M-27: `15 0 * * 1` in New York after 2026-03-02T05:15Z answers **2026-03-09T04:15Z** (was
    03-16), and the previous match of the next round-trips; `30 2 * * *` over the spring-forward
    answers 2026-03-09T06:30Z, skipping the non-existent 02:30 on 03-08.
  - The boot line `[workflow] engine mounted …; no route publishes a definition, starts an instance
    or submits a signal` and the RLS-confined warning both printed. No route was added.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| 1. **A job handler is not aborted when its lease is lost** (the rest of R15-03), and the fence is the worker id (`hostname:pid`) rather than a monotonic token, so a restarted process reusing a pid would pass it. | CrossEngin platform | _unscheduled_ |
| 2. **Timers and activities have no attempt cap.** An item that always throws is re-claimed every idle poll (1 s) for ever and can starve its batch. A cap needs a new column in `meta-schema.ts`. | CrossEngin platform | _unscheduled_ |
| 3. **A running activity whose worker dies stays stuck** (R15-01); crash recovery is not implemented. | CrossEngin platform | _unscheduled_ |
| 4. **The engine's reads set no tenant context** (R15-07), so it does not work as `crossengin_app`: the append path is scoped now and the read path is the larger change. Live, a start as `crossengin_app` fails with "projection failed after start". | CrossEngin platform | _unscheduled_ |
| 5. **Two concurrent appends to one instance can race** (R15-06); this predates the slice. | CrossEngin platform | _unscheduled_ |
| 6. **No route publishes a definition, starts an instance or submits a signal**, so the engine acts only on instances another process wrote. Needs definitions reloaded without a restart and open question 4 first. | CrossEngin platform | _unscheduled_ |
| 7. **The replayer's `probeVisibility` detail on the workflow projection tables reuses the job-queue sentence** ("The job worker claims per tenant …"), found live. | CrossEngin platform | _unscheduled_ |
| 8. The audit's R14-03 (a scheduled timer makes an instance deaf to signals) and R14-04 (no signal or activity output reaches workflow variables) are not addressed by this slice; neither report touches them. | CrossEngin platform | _unscheduled_ |

## References

- `packages/workflow-runtime/src/saga.ts`, `engine.ts`
- `packages/workflow-worker/src/renew.ts` (`reaffirmClaim`), `batch.ts`, `job-batch.ts`,
  `activity-batch.ts`, `worker.ts`
- `packages/workflow-runtime-pg/src/projecting-event-log.ts` (`appendUnit`), `persistent-engine.ts`
  (`transactionalAppendUnit`), `id-mapping.ts` (`boundTo`), `replayer.ts`, `job-engine.ts`
  (`executeJobRun`, `fenceParam`), `engine-reach.ts` (`WORKFLOW_ENGINE_UNREACHABLE_REASONS`)
- `packages/jobs/src/cron.ts`
- `apps/operate-server/src/workflow-workers.ts`, `workflow-cancellation-routes.ts`, `node.ts`
  (`formatWorkflowEngineReach`)
- ADR-0440, ADR-0408, ADR-0389, ADR-0430, ADR-0334, ADR-0329, ADR-0424
