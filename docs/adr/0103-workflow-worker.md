# ADR-0103: workflow-worker — the distributed tick worker (Phase 3 P2)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0077 (Phase 3 plan), ADR-0049 (workflow-runtime), ADR-0050/M3.5 (workflow-runtime-pg), ADR-0007 (workflow engine) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). P1's increments consumed 0078–0079 + 0086–0102; this is P2, taking
> the next free number, 0103.

## Context

Phase 3 P2 (ADR-0077) moves from "serves requests" (P1) to "scales background
work": run the workflow runtime as a **worker process** over the Postgres event
log, advancing workflows over time, safely across multiple worker instances.

The existing runtime shapes how to do this. Activities execute **inline** within
an engine call (`startInstance` / `submitSignal` schedule + run them
synchronously via the `ActivityRegistry`), and `WorkflowEngine.tickTimers(nowMs)`
fires **all** due timers in bulk (firing `status='scheduled'` timers whose
`fire_at <= now`, then evaluating the resulting auto-transitions). The piece that
doesn't exist yet is the **process that drives `tickTimers` on a schedule, safe
to run N-up** — without it, an idle deployment never advances a timer-waiting
workflow.

## Decision

`@crossengin/workflow-worker` (depends on `kernel-pg` + `workflow-runtime`):

- **`lock-key.ts`** — `advisoryLockKey(namespace)` derives a stable **signed
  64-bit** bigint (the shape `pg_advisory_lock` takes) from a string via sha256.
  All worker processes passing the same namespace contend for one lock.
- **`worker.ts`** — `WorkflowWorker`:
  - `tickOnce()` runs `conn.withAdvisoryLock(lockKey, () =>
    engine.tickTimers(clock.now()))` — the **advisory lock serializes the tick
    across processes**, so running N workers is safe: only one ticks at a time,
    and the engine's `status='scheduled'` guard means even a racing tick can't
    double-fire a timer. If the lock holder's session dies, Postgres releases the
    advisory lock and another worker takes over (**failover**).
  - `start(intervalMs)` / `stop()` poll the tick on an interval (injectable
    `IntervalScheduler`, default `unref`'d so the worker never holds the process
    open; `onError` routes a failed tick, never thrown from the loop), with a
    `status()` snapshot (tickCount / lastTickAt / lastFiredCount).
  - The engine is a structural `TimerTickEngine` (just `tickTimers`), so the
    worker wraps a `buildPersistentEngine(...)`-wired engine without a hard
    dependency on the full class.

No new META tables — the worker drives the existing event-sourced engine + the
existing advisory-lock primitive on `PgConnection`.

## Cross-cutting invariants enforced (by tests)

- **Distributed-safe by the advisory lock.** Two workers sharing the lock state
  that tick concurrently never overlap (`maxActive === 1`) — the lock serializes
  them. With the engine's `scheduled`-only firing, serialization is sufficient to
  prevent double-fires.
- **Drives the engine correctly.** `tickOnce` calls `tickTimers` with the
  clock's `now` in ms under the lock keyed by the namespace (or a custom key),
  returns the fired-timer result, and updates `status()`.
- **Resilient poll loop.** `start`/`stop` schedule + clear an `unref`'d interval;
  a throwing tick is routed to `onError` and doesn't count as a tick or escape
  the loop.

## Alternatives considered

- **Per-unit `FOR UPDATE SKIP LOCKED` claim/lease (true parallelism).**
  - **Decision.** Deferred. The engine fires timers in **bulk** (`tickTimers`)
    and runs activities **inline**; per-unit claiming would require a
    `fireTimer(id)` engine method and decoupling activity execution from
    scheduling (an async activity queue). Those are a deeper engine refactor;
    serializing the existing bulk tick under an advisory lock is the correct,
    minimal first cut and is genuinely distributed (N processes + failover).
- **A coarse "leader" election outside Postgres (e.g. a lease row).**
  - **Decision.** No — `pg_advisory_lock` is already exposed on `PgConnection`,
    is automatically released on session death (clean failover), and needs no new
    table. A lease row would reinvent it with worse failover semantics.
- **Non-blocking `pg_try_advisory_lock` (skip if held).**
  - **Decision.** The existing `withAdvisoryLock` is blocking, but for a periodic
    tick that's benign: a second worker blocks briefly, then ticks a no-op (the
    first already moved the due timers to `fired`). Adding a try-lock primitive
    is an optional refinement, not needed for correctness.
- **Also scan + re-run due activity retries (`next_retry_at`).**
  - **Decision.** Deferred — re-executing a failed activity isn't exposed by the
    engine (activities run inline); a retry executor rides the same worker once
    the engine grows a per-activity run path.

## Consequences

- **60 packages + 2 apps, 123 meta-schema tables, 6,392 tests** (was 59 / 6,383;
  +1 package, +9 tests, 0 new tables). Phase 3 **P2 has begun**: the workflow
  runtime now has a distributed worker that advances timer-driven workflows,
  coordinated by a Postgres advisory lock, safe to run N-up with failover.
- **Deployment shape.** `new WorkflowWorker({ conn, engine:
  buildPersistentEngine(...).engine }).start(intervalMs)` in a worker process;
  scale out by running more, all sharing the tick lock.
- **The deeper P2 work is named** — per-unit `FOR UPDATE SKIP LOCKED` claiming +
  a `fireTimer(id)` path are **delivered in ADR-0104 (P2.1)**; an async activity
  queue + retry executor remain the follow-up, behind the same worker seam.
