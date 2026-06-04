# ADR-0107: activity retry backoff — next_retry_at population (Phase 3 P2.4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0105 (activity retry executor), ADR-0106 (apps/workflow-worker), ADR-0049 (workflow-runtime), ADR-0007 (workflow engine + retry policy), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.4).

## Context

ADR-0105 shipped the `RetryExecutorWorker` + `PostgresActivityRetryClaimStore`,
whose claim gates on `attempt_number < max_attempts AND (next_retry_at IS NULL
OR next_retry_at <= now)`. But the runtime never populated those columns: the
`PostgresActivityStore` INSERT omitted `max_attempts`, `retry_policy`,
`next_retry_at`, and the NOT NULL `timeout_seconds` / `timeout_at` — so the
claim treated **every** failed activity as immediately eligible (`next_retry_at
IS NULL`), and the INSERT would in fact have failed against a real table (missing
NOT NULL columns). ADR-0105 named "auto-populate `next_retry_at` with a backoff
schedule on failure" as the deferred follow-up. This is it.

## Decision

- **`workflow-engine` — pure backoff helpers** (`activities.ts`). The
  strategy math that lived inline in `decideActivityRetry` is extracted to
  `retryDelaySeconds(policy, attemptNumber)` (the single source: `fixed_delay`
  → `initialDelaySeconds`; `linear_backoff` → `×attemptNumber`;
  `exponential_backoff` → `×2^(attempt−1)`; capped at `maxDelaySeconds`).
  `computeNextRetryAt({policy, attemptNumber, now})` returns the ISO time of the
  next attempt, or `null` when the policy is `no_retry` or attempts are
  exhausted. `DEFAULT_RETRY_POLICY` (3 attempts, exponential from 1s, capped at
  5m) is the fallback when a `schedule_activity` action declares none.
  `decideActivityRetry` now calls `retryDelaySeconds` (behavior unchanged).
- **`workflow-runtime` — engine + projection.**
  - `applyScheduleActivity` reads the action's `retryPolicy` + `timeoutSeconds`
    params (defaulting), and persists `retryPolicy`, `maxAttempts`, and
    `timeoutSeconds` on the **`activity_scheduled`** event (so a retry replay and
    the projection both see them).
  - `runActivityAttempt` takes the `retryPolicy` and, on `activity_failed` /
    `activity_timed_out`, stamps `nextRetryAt = computeNextRetryAt(...)` on the
    event (null when exhausted / no_retry). `retryActivity` reads the policy back
    from the scheduled event.
  - `projectActivities` carries `maxAttempts`, `retryPolicy`, `timeoutSeconds`,
    `timeoutAt` (= scheduledAt + timeout), and `nextRetryAt` — set from the
    failure event, **cleared** when the next attempt starts / the activity
    succeeds. Missing fields default (back-compatible with pre-P2.4 events).
- **`workflow-runtime-pg`** — `ActivityProjection` + `PostgresActivityStore`
  gain `maxAttempts`, `retryPolicy` (written `$n::jsonb`), `timeoutSeconds`,
  `timeoutAt`, `nextRetryAt`; the INSERT now satisfies every NOT NULL column,
  and the UPDATE refreshes `next_retry_at` so a re-projected failure updates the
  due time.

The claim store from ADR-0105 needs **no change** — its SQL already honors a
populated `next_retry_at`. P2.4 just makes the data real.

## Cross-cutting invariants enforced (by tests)

- **Backoff math is correct + capped.** `retryDelaySeconds` computes fixed /
  linear / exponential delays and caps at `maxDelaySeconds`; `computeNextRetryAt`
  stamps `now + cappedDelay` and returns `null` when exhausted or `no_retry`.
- **The failure carries the due time.** Scheduling a flaky activity
  (fixed_delay 30s, maxAttempts 3) under a clock fixed at 12:00:00 emits an
  `activity_failed` with `nextRetryAt = 12:00:30`; a `no_retry` policy emits
  `nextRetryAt = null`. The scheduled event carries `retryPolicy` + `maxAttempts`
  + `timeoutSeconds`.
- **Projection reflects + clears it.** A failed activity projects its
  `nextRetryAt` / `maxAttempts` / `retryPolicy` / `timeoutSeconds`; the next
  `activity_started` clears `nextRetryAt` (the retry is in flight) and advances
  `attemptNumber`. Defaults apply when the scheduled event omits the fields.
- **The store persists every NOT NULL column.** The INSERT binds
  `max_attempts`, `retry_policy` (`$9::jsonb`), `timeout_seconds`, `timeout_at`,
  and `next_retry_at`; the UPDATE refreshes `next_retry_at`.

## Alternatives considered

- **Compute `next_retry_at` in the claim store / a worker sweep instead of the engine.**
  - **Decision.** No — the engine owns the retry policy + attempt count at the
    moment of failure; computing the due time there (on the event) keeps the
    projection a pure left-fold and the claim store a dumb gate. A sweep would
    re-derive state the event already knows.
- **Store only `next_retry_at`, leave the other NOT NULL columns unset.**
  - **Decision.** No — the INSERT was already latently broken (missing
    `max_attempts` / `retry_policy` / `timeout_*`). Populating the whole row is
    the correct fix and unblocks a real-PG integration test (deferred to P2.5+).
- **Duplicate the backoff math in the runtime.**
  - **Decision.** No — `retryDelaySeconds` is extracted once in `workflow-engine`
    and shared by `decideActivityRetry` (the contract-level helper) and the
    runtime, so the strategy semantics can't drift.
- **Auto-populate a richer retry schedule (jitter, per-error backoff).**
  - **Decision.** Deferred — the policy's strategy + delays are honored;
    jitter / per-error-code backoff are additive on top of the same
    `computeNextRetryAt` seam.

## Consequences

- **60 packages + 3 apps, 123 meta-schema tables, 6,447 tests** (was 6,437;
  +10, 0 new tables/packages — the lease + retry columns landed in P2.1/P2.2).
  The parallel retry path (`RetryExecutorWorker` × N) now honors **real backoff**:
  a flaky downstream is retried on the policy's schedule, not hammered on every
  poll, and an exhausted / non-retryable activity is never reclaimed.
- **The activity projection is now complete** — `max_attempts`, `retry_policy`,
  `timeout_seconds`, `timeout_at`, `next_retry_at` all persist, so the
  `workflow_activities` row is a faithful, claim-ready record.
- **The deeper P2 work remains** — a real-Postgres integration test of the claim
  → fire/retry loop, a timeout sweeper (the `timeout_at` column is now
  populated, ready for it), and the full async activity queue (decouple schedule
  from execute).
