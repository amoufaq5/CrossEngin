# ADR-0181: Deferred activity scheduling + `executeScheduledActivity`

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0180 (activity claim), ADR-0177 (fireDueTimersForInstance), ADR-0049 (workflow-runtime), ADR-0077 (Phase 3 P2) |

## Context

The activity claim (ADR-0180) needs activities to sit `scheduled`, awaiting a worker. But the engine
runs `schedule_activity` **inline** — append `activity_scheduled`, immediately `activity_started`,
run the handler, complete — and it persists only the input's `sha256`, not the input itself. To
distribute activities the engine needs (1) a mode that leaves the activity `scheduled` without
running it, persisting the input, and (2) a targeted, log-driven executor a worker calls — the
activity analog of `fireDueTimersForInstance` (ADR-0177).

## Decision

- **`deferActivities` engine option** (default `false`). When true, `applyScheduleActivity` appends
  `activity_scheduled` and returns — no inline handler run. The default is unchanged: activities run
  inline exactly as before.
- **Persist the input.** The `activity_scheduled` payload now carries `input` alongside `inputSha256`
  (additive) — so a worker in another process has what it needs to run the handler.
- **`runActivityHandler(...)`** — extracted from the inline path (append `activity_started` → run the
  resolved handler → append `activity_completed`/`_failed`/`_timed_out` → apply the transition). Both
  the inline path and the distributed executor share it, so behavior is identical.
- **`executeScheduledActivity(instanceId, activityId)`** (public) — reads the instance from the event
  log, finds the `activity_scheduled` event (kind / key / input / attempt), runs `runActivityHandler`,
  then drives the **step loop** (so a terminal transition emits `instance_completed`). Log-driven, so
  it works for an instance this process never started; **idempotent** — an activity that already has
  `activity_started` is a no-op, matching at-least-once claims.

## Consequences

- With `deferActivities: true` + the activity claim (ADR-0180), the pieces for a distributed activity
  worker are in place: schedule leaves the activity `scheduled` → a worker claims it (SKIP LOCKED) →
  `executeScheduledActivity` runs it under the tenant. The worker binding is the last step.
- Default behavior is untouched — every existing inline activity test passes; the refactor is a pure
  extraction plus an opt-in flag and an additive event field.
- Idempotency + step-loop driving mirror the timer executor exactly, so the activity worker is a
  near-copy of the timer worker.
- 6,835 tests pass (+5: deferred leaves it scheduled (no `activity_started`), execute runs +
  transitions to completed, idempotent re-execute is a no-op, cross-process execution over one shared
  log, unknown-activity no-op). Full build + typecheck green.
- Follow-ups: the activity worker binding (claim → `executeScheduledActivity` → complete/fail) reusing
  `workflow-worker` + the ADR-0180 claim/renew; retry (bump `attemptNumber`, reschedule) + dead-letter
  after `maxAttempts`; persisting the deferred `activity_scheduled` projection with the input for the
  worker to read from the table rather than the event log.
