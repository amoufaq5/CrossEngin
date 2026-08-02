# ADR-0180: Durable scheduled-activity claim — the queue substrate for distributed activities

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0175 (timer claim), ADR-0178/0179 (timer worker + renewal), ADR-0077 (Phase 3 P2), ADR-0049 (workflow-runtime) |

## Context

The timer path is a complete distributed executor (claim → worker → fire → renew, ADRs 0175-0179).
Scheduled activities are the next work type. Unlike timers — which the engine already persists as
`scheduled` awaiting a tick — activities currently run **inline** in the engine's step loop, so
there's no window where one waits for a worker. Distributing them therefore needs two things: an
engine *deferred-scheduling* mode (leave the activity `scheduled`, persist its input, don't run the
handler inline) **and** a durable queue over `workflow_activities`. This ADR ships the queue
substrate — the exact analog of the timer claim — so the deferred engine mode + worker plug into a
proven primitive.

## Decision

- **Lease columns on `meta.workflow_activities`** — `claimed_by TEXT` + `claim_expires_at
  TIMESTAMPTZ` + an `idx_workflow_activities_due (status, scheduled_at)`. No new table.
- **`claimDueActivities` / `releaseActivityClaim` / `renewActivityClaim`** (`workflow-runtime-pg`),
  mirroring the timer primitives exactly:
  - claim — CTE selects up to `limit` `scheduled` activities with `scheduled_at <= now` and no live
    claim, `FOR UPDATE SKIP LOCKED`, then `UPDATE … RETURNING` a `ClaimedActivity` (activityId,
    instanceId, tenantId, `definitionActivityKey`, `kind`, `attemptNumber`, `maxAttempts`, lease).
    Concurrent workers get disjoint batches; a lapsed lease recovers a crashed worker's activities.
  - release — hand a claimed-but-unexecuted activity back for immediate re-claim (owner-scoped).
  - renew — extend the lease for a slow handler; `true` only if still `scheduled` and still owned.
- Every value bound; schema identifier validated; the worker connection is platform-scoped
  (RLS-bypassing), `tenant_id` + `attemptNumber`/`maxAttempts` ride back per row so the worker can
  run the handler and apply retry policy.

## Consequences

- The activity queue exists and behaves exactly like the timer queue — concurrent-safe claiming,
  crash recovery, lease renewal — so the forthcoming activity worker is a near-copy of the timer
  worker (claimer + processor + `WorkflowTimerWorker`-shaped loop).
- Nothing changes for existing inline activity execution: the columns are additive/nullable, and no
  activity is `scheduled`-without-running until the engine's deferred mode lands. This is the
  substrate, deliberately ahead of the consumer (same sequencing as the timer claim preceding its
  worker).
- 6,830 tests pass (+5: claim SQL shape + row mapping (attempt/max), empty batch, limit/schema
  guards, release, renew true/false). Full build + typecheck green; meta-schema table count
  unchanged.
- Follow-ups: the engine's **deferred-activity** mode (append `activity_scheduled` + persist input,
  leave it `scheduled`) + a targeted `executeScheduledActivity(instanceId, activityId)` (the activity
  analog of `fireDueTimersForInstance`); the activity worker binding (claim → execute → complete/
  fail with retry) reusing `workflow-worker`; dead-letter after `maxAttempts`.
