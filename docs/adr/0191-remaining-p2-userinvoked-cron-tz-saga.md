# ADR-0191: Remaining P2 — userInvoked producer, cron timezones, distributed saga compensation

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-27 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0186–0190 (job/activity producers + retry), ADR-0049 (workflow-runtime), ADR-0077 (P2) |

## Context

With the event / scheduled / delayed producers and job + activity retry-backoff landed (ADR-0186–0190),
three independent P2 gaps remained: the **`userInvoked`** producer (on-demand "run this job now"),
**timezone-aware cron** (the scheduler evaluated UTC only), and **saga compensation that actually runs**
on a distributed/terminal failure (the runtime only *planned* it). These are on disjoint packages
(`@crossengin/jobs`, `@crossengin/workflow-runtime`) with no interdependency, so they were built in
parallel and integrated together.

## Decision

- **`userInvoked` producer** (`@crossengin/jobs` + `@crossengin/workflow-runtime-pg`). The pure
  planner mirrors the event producer: `UserInvocation` (`tenantId` / `action` / `data` /
  `idempotencyKey?`), `matchUserInvokedJobs` (by `trigger.action`), `enqueueKeyForUserInvocation`
  (deterministic, `userInvoked::`-prefixed so an action and an event of the same name never collide),
  and `planUserInvokedJobRuns` → `PlannedJobRun[]` (`jobKind: "userInvoked"`, `delayMs 0`). The pg
  binding `enqueueUserInvokedJob` inserts `pending` `job_runs` through the **shared `insertPlannedRuns`
  helper** (extracted from `enqueueJobsForEvent`, now common to event / delayed / userInvoked) —
  deterministic `run_id` + `ON CONFLICT DO NOTHING`, so a re-submitted invocation never double-runs.
- **Timezone-aware cron** (`@crossengin/jobs`, `cron.ts`). `cronMatches` / `cronPrevOnOrBefore` /
  `cronNextAfter` take an optional trailing `timezone`; field-matching runs against the wall-clock in
  that IANA zone (via `Intl.DateTimeFormat(...).formatToParts`, pinned to `en-US` for Latin digits),
  falling back to UTC when absent or on an invalid zone. Returned instants stay real UTC `Date`s —
  only the field comparison is zoned. `scheduledJobsDue` threads each job's `trigger.timezone`. UTC
  behavior is byte-identical when no zone is set.
- **Distributed saga compensation** (`@crossengin/workflow-runtime`). A new public
  `compensateInstance(instanceId) → CompensationResult` and its private core `runCompensation` build
  the plan via the existing pure `planCompensation`, then execute it: emit `compensation_started`, run
  each compensating handler (resolved by the source activity's kind via the new pure
  `compensationKindByActivityId`; an unregistered compensator is a recorded no-op), append
  `activity_compensated` per source activity, then `compensation_completed`. It honors the definition's
  strategy (`immediate_reverse_order` reverse, `parallel` all, `no_compensation` / `manual_review`
  run nothing) and is idempotent (a re-plan drops already-compensated activities → zero steps). It is
  **auto-wired into the terminal-failure path** (`emitTerminalForStateKind`, right after
  `instance_failed`), so every route that settles an instance in `terminal_failure` — inline
  dead-letter, signal reject, timer failure, the distributed `executeScheduledActivity` path — runs
  compensation exactly once. A `compensationActivityKey` now threads from the `schedule_activity`
  action through the `activity_scheduled` payload so the undo handler is discoverable from the log.

## Consequences

- All four practical job triggers now have producers (`event` / `scheduled` / `delayed` /
  `userInvoked`); `workflow` + `cdc` remain (internally-sourced, lower priority). Cron jobs fire at the
  tenant's local wall-clock, not just UTC. A distributed workflow that fails now *unwinds* its
  completed side effects instead of leaving them — the saga guarantee the runtime only modeled before.
- Built by two background agents on disjoint packages (jobs; workflow-runtime), integrated centrally:
  the pg `enqueueUserInvokedJob` binding + the shared `insertPlannedRuns` refactor + one workspace
  regression. No agent touched `index.ts`, git, or another package.
- 6,955 tests pass (+28: jobs +15 — userInvoked match/key/plan + cron timezone match/prev/fallback;
  workflow-runtime +10 — auto-compensation, reverse/parallel/none/manual strategies, unregistered
  no-op, idempotency; workflow-runtime-pg +3 — userInvoked pg enqueue match / no-match / schema).
  Full build + typecheck green.
- Follow-ups (unchanged): the `workflow` / `cdc` producers; DST-correctness hardening for cron zones;
  wiring the producers + a scheduler tick into `operate-server`'s event emission (the serving-app
  capstone); and the P2 exit-criterion end-to-end against a live Postgres (kill worker A → resume on
  B), which needs real infrastructure this offline workspace can't stand up.
