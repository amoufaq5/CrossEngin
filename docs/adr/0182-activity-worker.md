# ADR-0182: Distributed activity worker — claim → execute → ack

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0180 (activity claim), ADR-0181 (deferred activities), ADR-0178/0179 (timer worker + renewal), ADR-0077 (P2) |

## Context

The activity path now has its two halves: the durable claim (ADR-0180) and the engine's
deferred-scheduling + `executeScheduledActivity` executor (ADR-0181). What runs them is a worker —
the exact analog of the timer worker (ADRs 0178-0179). This binds them into a running distributed
activity executor.

## Decision

- **`@crossengin/workflow-worker` gains an activity loop**, mirroring the timer one:
  `ClaimedActivity` / `ActivityClaimer` / `ActivityProcessor` (structural, so the pg claim adapts in
  with no dependency), `processActivityBatch` (claim → process each → release failures for retry,
  swallowing release errors), and `WorkflowActivityWorker` (`runOnce` / `start` / `stop` /
  `isRunning`, active-drain vs idle-backoff pacing, `onError` survival, injectable `now` / `sleep`,
  `unref`'d default timer).
- **`workflow-runtime-pg` gains the binding**: `buildActivityClaimer` (over `claimDueActivities` /
  `releaseActivityClaim`), `buildActivityClaimRenewer` (over `renewActivityClaim`, mapping the
  shared renewer's key onto the activity id), `buildActivityProcessor` (calls
  `engine.executeScheduledActivity(instanceId, activityId)`, optional `renewWhile` lease heartbeat),
  and `buildWorkflowActivityWorker` wiring claimer + processor + loop, with opt-in `renewIntervalMs`.
  The processor omits a `now` clock the timer processor carries — `executeScheduledActivity` takes no
  time argument (unlike `fireDueTimersForInstance(instanceId, nowMs)`), so there is nothing for it to
  drive; the claim-side `now` due-check is still threaded through the worker.

## Consequences

- Distributed activity execution runs end to end: `buildWorkflowActivityWorker(...).start()` claims
  `scheduled` activities off Postgres (`SKIP LOCKED`, disjoint batches across the fleet), executes
  each from its event log, and releases failures for retry — the activity analog of the timer worker.
- Combined with `deferActivities: true` (ADR-0181), an engine that only *schedules* activities plus a
  fleet of these workers = horizontally-scaled activity execution, idempotent + crash-recoverable +
  lease-renewed, reusing every primitive the timer path proved.
- The structural `ClaimedActivity` seam keeps `workflow-worker` free of `pg`; the deployment wires
  the two, as with the timer worker.
- Full workspace green (workflow-worker 19 tests, workflow-runtime-pg carries the new activity-worker
  suite); build + typecheck clean.
- Follow-ups: retry (bump `attemptNumber`, reschedule) + dead-letter after `maxAttempts`; the P2
  exit-criterion end-to-end against real Postgres.
