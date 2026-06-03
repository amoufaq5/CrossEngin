# ADR-0104: per-unit timer claim + fireTimer for parallel workers (Phase 3 P2.1)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0103 (workflow-worker), ADR-0049 (workflow-runtime), ADR-0007 (workflow engine), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.1), the per-unit-claim
> follow-up ADR-0103 named.

## Context

ADR-0103 shipped the `WorkflowWorker` that serializes the engine's **bulk**
`tickTimers` under a Postgres advisory lock — correct + failover-safe, but one
worker does all the timer work at a time. For real throughput, workers should
fire timers **in parallel**, each owning a disjoint slice. That needs two new
pieces the runtime lacked: a way to fire **one** timer by id, and a way to
atomically **claim** a disjoint batch of due timers across processes.

## Decision

- **`workflow-runtime` — `WorkflowEngine.fireTimer({ instanceId, timerId,
  nowMs? })`** fires one specific scheduled timer (the per-unit path). It's
  **idempotent + race-safe**: a timer already fired/cancelled, not yet due, or on
  a terminal/non-waiting instance is a no-op (`fired: false`), so two workers
  that both claim-and-fire the same timer can't double-fire. The shared
  `applyTimerFired` helper (event append → transition → step loop) is extracted
  from `tickTimers`, which now calls it (behavior unchanged — all prior tests
  pass).
- **`kernel` meta-schema** — `meta.workflow_timers` gains **lease columns**
  `claimed_by TEXT` + `lease_expires_at TIMESTAMPTZ` and an
  `idx_workflow_timers_claim (status, fire_at, lease_expires_at)` index. No new
  table; no count change.
- **`workflow-worker`**
  - **`PostgresTimerClaimStore.claimDueTimers(workerId, now, limit, leaseMs)`** —
    atomically claims due `scheduled` timers that are unleased (or lease-expired)
    via **`FOR UPDATE SKIP LOCKED`**, stamping `claimed_by` + `lease_expires_at`,
    and returns each timer's id + its instance's `wfi_` ref (a subquery join) for
    `engine.fireTimer`. `releaseTimer` clears a lease.
  - **`ClaimingTimerWorker`** — `runOnce()` claims a batch and fires each via
    `engine.fireTimer`; a claimed timer that doesn't fire (raced / not due) has
    its lease released. `start`/`stop` poll an injectable `unref`'d interval.

Running N `ClaimingTimerWorker`s drains the timer backlog in **parallel** — no
global lock, because `SKIP LOCKED` partitions the rows; `fireTimer`'s idempotency
covers any residual race.

## Cross-cutting invariants enforced (by tests)

- **Per-unit fire is idempotent.** `fireTimer` fires a due timer and runs its
  transition; firing the same timer again, a not-yet-due timer, or an
  unknown/terminal instance is `fired: false` (no double-fire) — and `tickTimers`
  still fires + transitions exactly as before (113 prior tests green).
- **Disjoint parallel claiming.** `claimDueTimers` emits `FOR UPDATE SKIP
  LOCKED` over `status='scheduled' AND fire_at <= now AND (unleased | expired)`,
  binds `(now, limit, workerId, leaseExpiry)`, and returns `{ timerId,
  instanceRef }`; a custom schema is honored, an invalid one rejected.
- **Lease hygiene.** A claimed timer that returns `fired: false` is released
  (lease cleared) so another pass can re-evaluate it; the lease lets a different
  worker reclaim a dead owner's timer once `lease_expires_at` passes.

## Alternatives considered

- **Keep only the advisory-lock bulk tick.**
  - **Decision.** No — it caps timer throughput at one worker. The claim path adds
    real parallelism; the two coexist (bulk tick as a simple default, claiming for
    scale).
- **A separate work-queue table instead of lease columns on `workflow_timers`.**
  - **Decision.** No — the timers *are* the work; two nullable columns + an index
    on the existing table is additive and keeps the source of truth single.
- **Claim-and-process in one transaction (no explicit lease).**
  - **Decision.** No — that holds a transaction open for the whole fire (which
    runs the engine's step loop). An explicit `claimed_by`/`lease_expires_at` lease
    releases the row lock immediately and survives a worker crash (another reclaims
    after expiry).
- **Make `fireTimer` look the timer up by id alone (scan instances).**
  - **Decision.** No — the claim already knows the instance (`instance_ref`), so
    `fireTimer` takes `{ instanceId, timerId }` and reads just that instance's
    events. (Tenant scoping: the worker connects with a role that sees all tenants'
    workflow rows — BYPASSRLS / table owner — documented in the store.)

## Consequences

- **60 packages + 2 apps, 123 meta-schema tables, 6,405 tests** (was 6,392;
  +13, 2 new timer columns + 1 index, 0 new tables/packages). P2 now supports
  **parallel** timer firing: `ClaimingTimerWorker` × N over
  `PostgresTimerClaimStore` + `engine.fireTimer`, alongside the advisory-lock
  bulk worker.
- **The engine grew a reusable per-unit fire** (`fireTimer`) that a future async
  activity executor / retry path can mirror.
- **An async activity queue + retry executor remain the deeper P2 follow-up** —
  the same claim/lease + per-unit-execute pattern, applied to activities (which
  currently run inline).
