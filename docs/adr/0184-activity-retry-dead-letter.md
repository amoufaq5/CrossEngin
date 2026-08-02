# ADR-0184: Activity retry + dead-letter

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0181 (deferred activities), ADR-0182 (activity worker), ADR-0180 (activity claim), ADR-0049 (workflow-runtime) |

## Context

Activities can now be scheduled, deferred, executed inline or by a distributed worker (ADRs
0180-0182), but a failure was terminal: `activity_failed` fired the failed transition on the first
attempt, no matter the outcome's `retryable` flag or a configured attempt ceiling. Real activities
(integration calls, HTTP) need bounded retries and an explicit dead-letter when they exhaust.

## Decision

- **A retry ceiling on `schedule_activity`.** The action takes an optional `maxAttempts` (default 1
  = no retry); the engine persists it in the `activity_scheduled` payload so every attempt — inline
  or distributed — knows the ceiling.
- **`scheduleActivity(…, attemptNumber, maxAttempts)`** — the shared scheduler (extracted from
  `applyScheduleActivity`) records an attempt as `scheduled` (fresh `activityId` per attempt,
  persisting input + ceiling) and runs it inline unless `deferActivities`.
- **Retry vs dead-letter in the failed branch.** On a `failed` outcome, `willRetry = retryable &&
  attemptNumber < maxAttempts`. When true: the `activity_failed` is recorded (with `attemptNumber` /
  `maxAttempts` / `willRetry:true` / `deadLettered:false`) and a **fresh attempt is rescheduled** —
  no transition, because the activity isn't done. When false (non-retryable, or ceiling reached):
  the `activity_failed` carries `deadLettered:true` and the failed-trigger **transition fires** —
  the workflow handles the dead-letter (a failure state, compensation, etc.).
- **Works everywhere.** The logic lives in the shared `runActivityHandler`, so it holds for the
  inline path *and* the distributed executor: in deferred mode a retry appends a new `scheduled`
  activity that a worker re-claims (a fresh `activityId`, so the idempotency check doesn't block it).

## Consequences

- A flaky activity retries up to its ceiling and then dead-letters cleanly; a retry that succeeds
  stops the loop and completes; a non-retryable failure dead-letters on attempt 1 regardless of the
  ceiling. Each attempt is a distinct `activity_scheduled` → `activity_started` → `activity_failed`
  in the log, fully auditable, and the terminal one is flagged `deadLettered`.
- Backward compatible: with no `maxAttempts` (default 1) behavior is exactly as before — every
  existing inline/activity test passes unchanged.
- Distributed retries ride the existing worker + claim: the rescheduled attempt is just another
  `scheduled` activity, claimed and executed by the fleet, so retry needs no worker change.
- 6,858 tests pass (+4: retryable exhausts → dead-letter + failed transition, retry succeeds →
  completed, non-retryable → no retry, deferred retry reschedules a fresh scheduled attempt). Full
  build + typecheck green.
- Follow-ups: honor the full `RetryPolicy` (backoff delays via a `next_retry_at` timer, error-code
  allow/deny lists from `decideActivityRetry`) rather than the outcome's `retryable` boolean +
  immediate reschedule; the same retry shape for `activity_timed_out`; job retry/dead-letter on the
  `job_runs` `dead-lettered` status.
