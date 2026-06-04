# ADR-0113: activity-level timeout sweeper — timeoutActivity + claim (Phase 3 P2.10)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0111 (async activity queue), ADR-0108 (instance timeout sweeper), ADR-0107 (retry backoff), ADR-0049 (workflow-runtime), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.10).

## Context

ADR-0111's async activity queue introduced a state the inline model never had: an
activity that sits **non-settled** in the database. An async activity is
`scheduled` until an executor runs it; an in-flight activity an executor started
can be orphaned `running` if that worker dies mid-execution. Either can sit past
its deadline forever — nothing enforced the activity's `timeout_at` (populated by
P2.4 = `scheduledAt + timeoutSeconds`). P2.5 swept timed-out *instances*; P2.10
does the same for *activities*, completing deadline coverage now that async
makes orphaned activities possible.

## Decision

- **`workflow-runtime` — `WorkflowEngine.timeoutActivity({instanceId,
  activityId, nowMs?})`** times out a **non-settled** activity (last event
  `activity_scheduled` or `activity_started`) whose deadline (`scheduledAt +
  timeoutSeconds`, recomputed from the events) has passed. Emits
  `activity_timed_out` stamping `nextRetryAt` (so the retry executor can re-run
  it). **Idempotent + race-safe**: an already-settled activity, one not yet past
  its deadline, or an unknown/terminal instance is a no-op (`timedOut: false`).
- **`kernel` meta-schema** — `meta.workflow_activities` gains an
  `idx_workflow_activities_timeout_claim (status, timeout_at, lease_expires_at)`
  index (the column + lease columns already exist). No new column/table.
- **`workflow-worker`**
  - **`PostgresActivityTimeoutClaimStore.claimTimedOutActivities`** — claims
    `status IN ('scheduled', 'running') AND timeout_at <= now`, unleased, via
    **`FOR UPDATE SKIP LOCKED`** + lease. A normally-executing activity is well
    within `timeout_at`, so only genuinely overdue async / orphaned activities are
    claimed; the settled-guard covers the boundary race.
  - **`ActivityTimeoutSweeperWorker`** — `runOnce` claims a batch + times out
    each via `engine.timeoutActivity`, releasing the lease in a `finally`; emits
    the P2.7 `onRun` outcome.
- **`apps/workflow-worker`** — the existing `--mode timeout` now runs **both**
  the instance sweeper (`timeout`) and the activity sweeper (`activity-timeout`),
  on the same `--timeout-interval-ms`; `all` includes both; `WorkerEngine`
  extends `TimeoutActivityEngine`.

## Cross-cutting invariants enforced (by tests)

- **Times out an overdue non-settled activity.** A scheduled async activity no
  executor ran by its deadline is timed out (`activity_timed_out` with
  `nextRetryAt` populated); not-yet-due, already-settled (idempotent second
  sweep), and unknown ids are no-ops.
- **Disjoint parallel claiming.** `claimTimedOutActivities` emits the `FOR UPDATE
  SKIP LOCKED` claim over `status IN ('scheduled','running') AND timeout_at <=
  now`, binds `(now, limit, workerId, leaseExpiry)`.
- **Worker drains + leases.** `ActivityTimeoutSweeperWorker` runs each claim,
  releases the lease even on throw, emits `onRun`, poll loop routes errors.
- **Mode wiring.** `--mode timeout` wires `[timeout, activity-timeout]`; `--mode
  all` includes both.
- **Real-PG (gated).** An async activity left unrun past its deadline is timed
  out by `ActivityTimeoutSweeperWorker` (row `timed_out`, `next_retry_at` set).

## Alternatives considered

- **Sweep only `running` (orphaned in-flight), not `scheduled`.**
  - **Decision.** No — a `scheduled` async activity no executor picked up by its
    deadline is also a timeout (a stuck queue). Sweeping `scheduled` *and*
    `running` covers both; the `timeout_at` gate keeps healthy activities out.
- **A new `--mode activity-timeout`.**
  - **Decision.** No — both sweeps are "fail work past its deadline". Folding the
    activity sweeper into the existing `timeout` mode (two workers, one interval)
    keeps the mode surface coherent; `all` picks up both automatically.
- **Per-attempt activity timeout (reset on each retry).**
  - **Decision.** Deferred — the projection's `timeout_at` is the overall
    deadline (`scheduledAt + timeoutSeconds`, set once), which bounds total
    activity runtime across retries. A per-attempt deadline is a future
    refinement behind the same primitive.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,491 offline tests + 7 gated
  real-Postgres integration tests** (+1 index, +8 offline tests, +1 integration
  test; 0 new tables/columns/packages). Deadline coverage is now complete:
  **instances** (P2.5) and **activities** (P2.10) past their `timeout_at` are
  swept, so the async queue can't leak stuck or orphaned work.
- **The engine's per-unit primitives are now five** — `fireTimer`,
  `retryActivity`, `timeoutInstance`, `executeActivity`, `timeoutActivity` — each
  idempotent / settled-guarded, each driven by a leased `SKIP LOCKED` claim.
- **Per-attempt activity timeout** + stale-worker detection / a lease-reaper
  remain natural future layers on the now-complete worker arc.
