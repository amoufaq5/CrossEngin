# ADR-0110: worker observability — heartbeats + per-run outcomes (Phase 3 P2.7)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0109 (worker integration test), ADR-0106 (apps/workflow-worker), ADR-0103–0108 (the worker arc), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.7).

## Context

P2–P2.6 built and proved three parallel claim/execute workers, but a running
worker was **invisible**: nothing recorded that it was alive, how much it was
draining, or whether it was erroring. A worker that crashes or silently stops
claiming would go unnoticed. P2.7 adds the observability layer — a per-worker
heartbeat persisted to a platform table, fed by a normalized per-run outcome
each worker now emits.

## Decision

- **`kernel` meta-schema** — a new **platform-wide** table
  `meta.worker_heartbeats` (table #124; no `tenant_id`, so **no RLS** — one
  worker spans all tenants, like `cdc_checkpoints` / `regions`). Keyed unique on
  `worker_id`; columns `mode` (tick/claim/retry/timeout/all), `status`
  (starting/running/stopped), `hostname`, `started_at`, `last_heartbeat_at`,
  `last_run_at`, and cumulative `poll_count` / `claimed_total` /
  `processed_total` / `error_count` + `last_error`. Indexes on
  `last_heartbeat_at` (find stale workers) and `(mode, status)`.
- **`workflow-worker` — `onRun` on every worker.** A normalized `RunOutcome`
  (`{claimed, processed}`) is emitted from each worker's poll loop:
  `ClaimingTimerWorker` → `{claimed, fired}`, `RetryExecutorWorker` →
  `{claimed, retried}`, `TimeoutSweeperWorker` → `{claimed, timedOut}` (the bulk
  `WorkflowWorker` maps its `onTick`). The existing `onError` is unchanged.
- **`workflow-worker` — `heartbeat.ts`.**
  - **`WorkerHeartbeat`** — a pure accumulator: `recordRun(outcome)` folds
    counters + stamps `lastRunAt`, `recordError(err)` counts + captures the
    message, `snapshot()` stamps `lastHeartbeatAt` and returns the immutable view.
  - **`PostgresWorkerHeartbeatStore.upsert`** — `INSERT … ON CONFLICT
    (worker_id) DO UPDATE` (a restarted worker reuses its row; `started_at` is
    preserved).
  - **`HeartbeatReporter`** — exposes `onRun` / `onError` handlers to wire into
    every worker, flushes the snapshot on an injectable `unref`'d interval
    (immediate flush + `running` on `start`, a final `stopped` flush on `stop`),
    and routes a failed flush to `onError` (never throws from the loop).
- **`apps/workflow-worker`** — `run()` builds a `HeartbeatReporter` (unless
  `--no-heartbeat`), wires its `onRun`/`onError` into the worker set, starts it on
  `--heartbeat-interval-ms` (default 15000), and `stop`s it (final flush) on
  shutdown. `hostname` comes from `node:os`.

## Cross-cutting invariants enforced (by tests)

- **Counters fold correctly.** `WorkerHeartbeat` sums `claimed`/`processed`
  across runs, counts errors + keeps the last message, and starts `starting` →
  `running` → `stopped`.
- **Upsert is keyed on worker_id.** The store emits `ON CONFLICT (worker_id) DO
  UPDATE` with every counter bound; a custom schema is honored, an invalid one
  rejected.
- **Reporter lifecycle.** `start` flushes immediately as `running` then on each
  tick; `stop` clears the timer + flushes `stopped`; a failing flush routes to
  `onError` instead of throwing.
- **Wiring.** `buildWorkerSet` threads `onRun` into each worker (invoked per poll
  with the normalized outcome).
- **Real-PG (gated).** A `HeartbeatReporter` over `PostgresWorkerHeartbeatStore`
  writes a `meta.worker_heartbeats` row with the folded counters, and a second
  flush upserts the same row (no duplicate).

## Alternatives considered

- **Reuse `observability-runtime`'s `RequestOutcome` / SLO engine.**
  - **Decision.** Deferred — that models request-level SLOs (availability /
    latency burn). Worker liveness + drain counters are a simpler, different
    signal; a dedicated heartbeat table is the right primitive. Feeding worker
    outcomes into the SLO engine (e.g. an "is the backlog draining" SLO) is a
    natural later layer on top of this.
- **A per-run append-only log instead of an upsert row.**
  - **Decision.** No — operators want "is each worker alive and draining right
    now", which a single upserted row answers in one indexed lookup. A full
    time-series of every poll is high-volume and belongs in metrics, not a meta
    table.
- **Put the heartbeat in a tenant-scoped table.**
  - **Decision.** No — a worker drains every tenant (BYPASSRLS); its heartbeat is
    platform-wide, like `cdc_checkpoints`.
- **Make the heartbeat mandatory.**
  - **Decision.** No — `--no-heartbeat` lets a worker run without the extra
    writes (e.g. a one-shot drain), keeping the observability opt-out cheap.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,468 offline tests + 5 gated
  real-Postgres integration tests** (+1 table, +9 offline tests). A deployed
  worker is now **observable**: `SELECT * FROM meta.worker_heartbeats WHERE
  last_heartbeat_at < now() - interval '1 minute'` finds dead workers, and the
  counters show drain throughput + error rates per worker.
- **Every worker emits a uniform `RunOutcome`**, so future consumers (an SLO on
  backlog drain, a dashboard) have one hook to read.
- **The P2 distributed-worker arc is operationally complete** — claim/execute
  (timers · retries · timeouts), backoff, real-PG proof, and now liveness. The
  remaining deep follow-up is the full async activity queue (decouple schedule
  from execute).
