# ADR-0190: Activity retry backoff — deferring the rescheduled attempt

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-26 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0184 (activity retry + dead-letter), ADR-0188 (job retry backoff), ADR-0182 (activity worker), ADR-0077 (P2) |

## Context

ADR-0184 gave activities bounded retries, but the reschedule was *immediate*: a retryable failure
appended a fresh `activity_scheduled` at the current instant, so in deferred (distributed) mode a
worker re-claimed and re-ran it as fast as it could poll — a retry storm, exactly the gap ADR-0188
closed for jobs. This applies the same fix to activities: a backoff defers the rescheduled attempt's
due time.

## Decision

- **The `schedule_activity` action carries an optional backoff** (in `@crossengin/workflow-runtime`,
  no new dependency — durations stay in **milliseconds** to avoid pulling ISO parsing into the core
  runtime): `retryBackoffMs` (initial; absent/0 ⇒ immediate, the prior behavior), `retryBackoffKind`
  (`exponential` default / `linear` / `constant`), `retryMaxBackoffMs` (cap). `parseActivityBackoff`
  reads them into an `ActivityRetryBackoff`; `activityRetryDelayMs(backoff, attemptNumber)` computes
  the per-attempt delay.
- **The backoff persists in the `activity_scheduled` payload** (`retryBackoff`), alongside
  `attemptNumber` / `maxAttempts`, so the distributed executor (`executeScheduledActivity`, running in
  a worker) reads it and applies the same policy on the *next* failure — the inline and distributed
  paths stay identical.
- **The reschedule defers `availableAt`.** On a retryable failure with attempts remaining,
  `runActivityHandler` computes `availableAt = now + activityRetryDelayMs(backoff, attemptNumber)` and
  puts it in the fresh `activity_scheduled` payload. `projectActivities` reads `availableAt` into the
  activity's `scheduledAt`, which the Postgres activity-store writes to `scheduled_at` — and since the
  claim's due-check is `scheduled_at <= now`, the retry stays out of the queue until its backoff
  elapses. No new column, no timer; `scheduled_at` *is* the next-attempt time, mirroring the job path.

## Consequences

- A flaky distributed activity now backs off between attempts (e.g. exponential 5 s → 10 s → 20 s,
  capped) instead of hot-looping the worker fleet, then dead-letters at the ceiling exactly as before.
  The backpressure is enforced by the existing activity claim — the same mechanism jobs use.
- Inline mode is unchanged in spirit: the engine still runs the retry in-process (it doesn't sleep),
  but the persisted `availableAt` makes the projected `scheduledAt` consistent with the deferred path
  for audit/observation. Backoff's real effect is on the distributed claim.
- Backward compatible: no `retryBackoffMs` ⇒ `availableAt` absent ⇒ `scheduledAt = occurredAt` ⇒
  immediate, byte-identical to ADR-0184. The payload gains fields only when a backoff is configured.
- 6,927 tests pass (+4: `activityRetryDelayMs` per-kind + cap, `parseActivityBackoff` defaults +
  fields, deferred reschedule defers `availableAt`/projected `scheduledAt`, first attempt has no
  `availableAt`). Full build + typecheck green.
- Follow-ups: sourcing the backoff from the workflow definition's activity `RetryPolicy`
  (`decideActivityRetry`) rather than action parameters; the same deferral for `activity_timed_out`;
  wiring producers + a scheduler tick into `operate-server`.
