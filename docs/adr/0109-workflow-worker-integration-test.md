# ADR-0109: real-Postgres worker integration test + projection NOT NULL fixes (Phase 3 P2.6)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0108 (timeout sweeper), ADR-0107 (retry backoff), ADR-0105/0104 (claim stores), ADR-0106 (apps/workflow-worker), ADR-0035 (workflow-runtime-pg), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.6).

## Context

P2–P2.5 built three parallel claim/execute loops (timer claim, activity retry,
instance timeout) — all verified only against **mocked** `PgConnection`s. The
two things a mock can't show are exactly the ones that matter for a distributed
worker: that the `FOR UPDATE SKIP LOCKED` SQL actually **partitions** a backlog
across concurrent claimers, and that the lease lifecycle (claim → expiry →
reclaim) behaves under real Postgres locking. P2.6 adds a real-Postgres
integration test that drives the full `buildPersistentEngine` → projection →
worker stack end-to-end.

Standing it up immediately surfaced **latent projection bugs** the mocked unit
tests had hidden: the `workflow-runtime-pg` projection stores never wrote
several `NOT NULL` columns, so `buildPersistentEngine` would have failed on the
first real write of a timer / activity / signal.

## Decision

- **`apps/workflow-worker/src/integration.test.ts`** — a real-PG suite gated on
  `CROSSENGIN_PG_TEST=1` (skipped offline / in CI). It seeds a tenant + user +
  definitions, builds a persistent engine (`FixedClock`), and asserts:
  - **ClaimingTimerWorker** fires due timers and **two workers racing the same
    backlog stay disjoint** (`SKIP LOCKED`) with no double-fire — all instances
    reach the terminal state.
  - **RetryExecutorWorker** re-runs a failed activity once its `next_retry_at`
    backoff has elapsed; the instance completes.
  - **TimeoutSweeperWorker** fails a parked, past-deadline instance with
    `INSTANCE_TIMEOUT`.
  - A claimed timer's **lease blocks a second claimer** at the same instant and
    is **reclaimable after the lease expires**.
- **`workflow-runtime` + `workflow-runtime-pg` — projection NOT NULL fixes** the
  integration test exposed:
  - **Timers** — the engine stamps `kind` (`relative_after`) on
    `timer_scheduled`; `projectTimers` + `TimerProjection` + the store INSERT
    carry it (`workflow_timers.kind` is NOT NULL).
  - **Activities** — the engine stamps `label` on `activity_scheduled`;
    `projectActivities` carries `label` + `sequenceCursor`, and the store INSERT
    writes `label` + `sequence_cursor` (both NOT NULL).
  - **Signals** — the engine stamps `deliveryGuarantee` (`at_least_once`) +
    `sourceSystem` on `signal_received`; `projectSignals` + the store INSERT
    carry them (both NOT NULL).
  - **Retry finalization** — `retryActivity` now runs the step loop after
    `runActivityAttempt`, so a retry that drives the workflow into a terminal
    state emits `instance_completed`/`failed` (the inline schedule path already
    got this from its enclosing step loop; the per-unit retry path did not).

## Cross-cutting invariants enforced (by the integration test, real PG)

- **SKIP LOCKED partitions the backlog.** Two `ClaimingTimerWorker`s over one
  `PostgresTimerClaimStore` claim disjoint timer sets; their fired counts sum to
  the total and every instance completes (no double-fire).
- **Backoff is honored end-to-end.** A flaky activity fails attempt 1 (row
  `failed`, `next_retry_at` populated), and `RetryExecutorWorker` re-runs it only
  once the clock passes `next_retry_at`; the instance then completes.
- **Deadlines are enforced.** A parked instance past `timeout_at` is failed with
  `INSTANCE_TIMEOUT` by the sweeper.
- **Lease exclusivity + reclaim.** A second claimer skips leased rows at the
  same instant; after `lease_expires_at` passes, the rows are reclaimable.
- **The persistent engine actually writes.** Every `NOT NULL` column on
  `workflow_timers` / `workflow_activities` / `workflow_signals` /
  `workflow_instances` is satisfied — `buildPersistentEngine` projects a full
  workflow run into real tables.

## Alternatives considered

- **Spin Postgres up inside the test (testcontainers / embedded).**
  - **Decision.** No — the repo's convention is offline-by-default tests. The
    suite is **env-gated** (`CROSSENGIN_PG_TEST=1` + `PG*`), skipped unless a real
    PG is provided, so CI stays hermetic; an operator (or a dedicated CI job)
    runs it against a throwaway database. (It was run green here against a local
    PG 16 with the full meta-schema applied.)
- **Put the test in `packages/workflow-worker`.**
  - **Decision.** No — that library package would have to take
    `workflow-runtime-pg` + `workflow-engine` as new deps. `apps/workflow-worker`
    already depends on the whole stack (it wires it), so the end-to-end test
    belongs there.
- **Patch only `next_retry_at`-adjacent columns, skip the timer/signal NOT NULL gaps.**
  - **Decision.** No — the integration test write path hit all of them; fixing
    each store fully is the correct outcome (the persistent engine was latently
    broken for real timer/signal/activity writes, undetected by mocks).
- **Use a fake `uuid_generate_v7()` only in the test.**
  - **Decision.** Acceptable for the test database — production uses the
    `pg_uuidv7` extension (kernel-pg preconditions enforce it); the test's shim
    over `gen_random_uuid()` is a setup detail, not shipped code.

## Consequences

- **60 packages + 3 apps, 123 meta-schema tables, 6,459 offline tests + 4 gated
  real-Postgres integration tests** (6,463 with `CROSSENGIN_PG_TEST=1`). The P2
  distributed-worker arc is now **proven end-to-end against real Postgres**, not
  just mocked — SKIP LOCKED disjointness, lease lifecycle, and all three workers.
- **`buildPersistentEngine` is fixed** — the projection stores now satisfy every
  `NOT NULL` column, so a real workflow run (timers, activities with retry, signals,
  instances) persists correctly. This was a latent break in `workflow-runtime-pg`
  that no mocked test could catch.
- **The deeper P2 work remaining** narrows to worker observability / heartbeats
  and the full async activity queue (decouple schedule from execute).
