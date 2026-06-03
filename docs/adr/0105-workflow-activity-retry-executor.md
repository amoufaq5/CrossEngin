# ADR-0105: activity retry executor — per-unit retryActivity + claim (Phase 3 P2.2)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0104 (timer claim), ADR-0103 (workflow-worker), ADR-0049 (workflow-runtime), ADR-0007 (workflow engine + retry policy), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.2).

## Context

ADR-0104 gave parallel **timer** firing. The other half of P2 is **activity
retries**: re-run an activity that failed/timed out, across workers. Two
realities shaped this. Activities execute **inline** within an engine call (so
a failed activity is simply recorded `failed` and the instance parks), and the
activity's **input was not persisted** — only its sha256 — so there was nothing
to replay. Both had to change before a retry could re-run an activity with its
original input.

## Decision

- **`workflow-runtime`**
  - The `activity_scheduled` event now persists the **raw `input`** (alongside
    the existing `inputSha256`), so a retry can replay it.
  - A shared **`runActivityAttempt`** helper (`activity_started` → handler →
    completed/failed/timed_out + transition) is extracted from
    `applyScheduleActivity` (behavior unchanged — all 117 prior tests pass) and
    records the `attemptNumber` on each attempt event.
  - **`WorkflowEngine.retryActivity({ instanceId, activityId })`** re-runs a
    `failed`/`timed_out` activity at the next attempt with its original input,
    then advances the workflow on success. **No-op (`retried: false`)** if the
    activity already succeeded/cancelled, has a retry in flight (last event is
    `activity_started`), or the instance/activity is unknown/terminal — safe to
    drive from a leased claim.
- **`kernel` meta-schema** — `meta.workflow_activities` gains lease columns
  `claimed_by` + `lease_expires_at` and an `idx_workflow_activities_retry_claim`
  index (`next_retry_at` already existed). No new table.
- **`workflow-worker`**
  - **`PostgresActivityRetryClaimStore.claimDueRetries`** — atomically claims, via
    **`FOR UPDATE SKIP LOCKED`**, activities that are `failed`/`timed_out`,
    haven't exhausted `max_attempts`, whose backoff has elapsed (`next_retry_at`
    null or past), and are unleased/lease-expired; returns each activity id +
    instance `wfi_` ref. `releaseActivity` clears a lease.
  - **`RetryExecutorWorker`** — `runOnce` claims a batch and re-runs each via
    `engine.retryActivity`, releasing the lease after each attempt (in a
    `finally`, so a throwing retry still releases) so the next poll re-evaluates
    the new status/attempt. `start`/`stop` poll an injectable `unref`'d interval.

Running N `RetryExecutorWorker`s drains the retry backlog in **parallel** — no
global lock (`SKIP LOCKED` partitions); `retryActivity`'s in-flight/settled
guards + the lease cover races.

## Cross-cutting invariants enforced (by tests)

- **Retry replays the original input.** A flaky activity (fails attempt 1,
  succeeds attempt 2) is re-run by `retryActivity` with the **same input**
  (`[{n:7},{n:7}]`), and the workflow transitions to `done` on the retry's
  success.
- **Idempotent / settled-only.** `retryActivity` is a no-op for an
  already-succeeded activity, an unknown activity/instance, or one whose last
  event isn't a settled failure (no double-run of an in-flight attempt).
- **Disjoint parallel claiming.** `claimDueRetries` emits the `FOR UPDATE SKIP
  LOCKED` claim over `status IN (failed,timed_out) AND attempt_number <
  max_attempts AND (next_retry_at null|past) AND unleased`, binds `(now, limit,
  workerId, leaseExpiry)`, returns `{activityId, instanceRef}`.
- **Lease always released.** `RetryExecutorWorker` releases the lease after each
  attempt — even when the activity wasn't retried, and even if `retryActivity`
  throws (`finally`).

## Alternatives considered

- **Decouple activity execution from scheduling (full async queue).**
  - **Decision.** Deferred — that's a larger change to the engine's inline
    execution model (and every workflow's synchronous semantics). Re-running a
    *failed* activity (this ADR) delivers the retry value without rearchitecting
    the happy path; a true "schedule → enqueue → claim → run" pipeline is the
    next step.
- **Don't persist the raw input (keep sha256 only).**
  - **Decision.** A retry can't replay without the input; persisting it on the
    scheduled event is the minimal enabler. (Classification-aware payload
    handling is a separate, orthogonal concern.)
- **Auto-populate `next_retry_at` with a backoff schedule on failure.**
  - **Decision.** Deferred — needs the activity's retry policy threaded from the
    definition through the projection. Until then the claim treats `next_retry_at
    IS NULL` as immediately eligible; the SQL already honors a populated
    `next_retry_at`, so adding backoff later needs no claim-store change.
- **Bound retries in the engine.**
  - **Decision.** No — the claim store gates on `attempt_number < max_attempts`
    (a column), keeping the engine's `retryActivity` a pure per-unit primitive.

## Consequences

- **60 packages + 2 apps, 123 meta-schema tables, 6,416 tests** (was 6,405;
  +11, 2 new activity columns + 1 index, 0 new tables/packages). P2 now covers
  **both** time-based progression (timers) and **activity retries** in parallel:
  `RetryExecutorWorker` × N over `PostgresActivityRetryClaimStore` +
  `engine.retryActivity`, alongside the timer claim path.
- **The engine's per-unit primitives are symmetric** — `fireTimer` (P2.1) +
  `retryActivity` (P2.2), both idempotent/settled-guarded, both extracted from
  the bulk paths via shared helpers.
- **The deeper P2 work remains** — a full async activity queue (decouple
  schedule from execute) + backoff `next_retry_at` population + timeout
  sweeping — behind the same claim/lease + per-unit-execute pattern.
