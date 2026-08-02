# ADR-0188: Job retry backoff — deferring re-claims via the RetryPolicy

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-25 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0185 (job worker + engine), ADR-0187 (scheduled producer), ADR-0077 (P2), `jobs` package |

## Context

ADR-0185 gave jobs bounded retries, but a retryable failure re-enqueued the run *immediately*
(cleared the claim, left `started_at`), so a persistently-failing job spun as fast as the workers
could poll — a retry storm — until it dead-lettered. The `jobs` `RetryPolicy` already declares a
`backoff` (exponential / linear / constant, `initialDelay`, `maxDelay`, `jitter`); nothing honored it.
This wires it in — a listed follow-up on ADR-0184/0185.

## Decision

- **A pure delay calculator in `@crossengin/jobs`** (`retry.ts`):
  - `retryDelayMs(policy, attemptNumber, rng?)` — `0` when there's no `backoff` (the prior immediate
    behavior); `constant` → `initialDelay`; `linear` → `initialDelay × n`; `exponential` →
    `initialDelay × 2^(n−1)`; each capped at `maxDelay`. `jitter` applies **only** when a `[0,1)`
    sampler `rng` is supplied (full-jitter over `[delay/2, delay)`), and is skipped otherwise — so the
    function is deterministic by default and replay/test-stable.
  - `nextRetryAt(policy, attemptNumber, now, rng?)` → `now + retryDelayMs(...)` as an ISO string.
- **The engine defers the re-claim.** `JobHandlerRegistration` now carries the full `retry?:
  RetryPolicy` (+ optional `jitterRng`); the attempt ceiling is `retry.maxAttempts ?? maxAttempts ??
  1`. On a retryable failure with attempts remaining, `PostgresJobRunEngine.executeJobRun` sets
  `started_at = nextRetryAt(retry, attempts, now)` in the same `UPDATE` that clears the claim — and
  since the claim's due-check is `started_at <= now`, a future `started_at` holds the run out of the
  claim set until its backoff elapses. No `backoff` ⇒ `started_at = now` ⇒ immediate, exactly as
  before.

## Consequences

- A flaky job now backs off between attempts instead of hot-looping: e.g. exponential `PT30S` retries
  at +30s, +60s, +120s, … capped at `maxDelay`, then dead-letters. The backpressure is enforced by
  the existing claim query — no new column, no timer, no scheduler; `started_at` *is* the
  next-attempt time.
- The ceiling can now come from the full `RetryPolicy` (`retry.maxAttempts`), so a single registration
  object carries both "how many" and "how far apart" — closer to the job definition's declared intent.
- Determinism is preserved: jitter is opt-in via an injected sampler, so tests and event-sourced
  replay stay reproducible without a real RNG. Backward compatible — registrations passing only
  `maxAttempts` (no `retry`) behave exactly as in ADR-0185.
- 6,920 tests pass (+10: pure retry — no-backoff/constant/linear/exponential/maxDelay-cap/jitter-bounds
  + nextRetryAt — 8; engine — backoff defers started_at, retry.maxAttempts drives the ceiling — 2).
  Full build + typecheck green.
- Follow-ups: the same backoff for distributed *activity* retries (ADR-0184 reschedules immediately);
  honoring `RetryPolicy` error-code allow/deny lists (`decideActivityRetry`); the `delayed` trigger
  producer; wiring producers + a scheduler tick into `operate-server`.
