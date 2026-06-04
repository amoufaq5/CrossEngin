# ADR-0114: stale-worker detection over the heartbeat table (Phase 3 P2.11)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0110 (worker heartbeats), ADR-0106 (apps/workflow-worker), ADR-0060/0061 (SLO enforcement), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.11).

## Context

ADR-0110 made each worker write a heartbeat (`last_heartbeat_at` + status +
counters) to `meta.worker_heartbeats`. That captured the *data* but not the
*judgement*: nothing turned "this worker's heartbeat is old" into an actionable
signal. A `running` worker that crashes or hangs stops beating but leaves its
row `running` — P2.11 detects that (a stale, presumed-dead worker) so it can be
surfaced as an incident / page.

## Decision

- **`workflow-worker` — `worker-health.ts` (pure).**
  - `classifyWorkerHealth(snapshot, {now, staleAfterMs})` → `stopped` (clean
    shutdown), else `stale` when `last_heartbeat_at` is older than `staleAfterMs`
    (default 60s), else `healthy`.
  - `summarizeWorkerHealth(snapshots, {now, staleAfterMs})` → a
    `WorkerHealthReport` (per-class counts + `StaleWorkerAlert[]`, oldest
    heartbeat first). `formatWorkerHealth` renders a one-line operator/incident
    summary. All pure — `now` injected.
- **`workflow-worker` — `PostgresWorkerHeartbeatStore` read side.**
  - `listAll()` reads every heartbeat row → `HeartbeatSnapshot[]` (for an
    in-memory summary).
  - `listStale({now, staleAfterMs})` pushes the filter into SQL —
    `status='running' AND last_heartbeat_at < now − staleAfterMs`, returning
    `StaleWorkerAlert`s with a computed `age_ms`, oldest first. The one-query
    "who's dead" lookup, served by the `idx_worker_heartbeats_heartbeat` index.

The `StaleWorkerAlert` is a structural record the caller routes to an incident /
page; `workflow-worker` stays off `@crossengin/incident-response` /
`observability-runtime` (a consumer wires the SLO/incident hook — same
separation the heartbeat itself keeps).

## Cross-cutting invariants enforced (by tests)

- **Classification.** A recent `running` heartbeat is `healthy`; one older than
  the window is `stale`; a `stopped` worker is `stopped` regardless of age; a
  custom `staleAfterMs` shifts the boundary.
- **Summary.** Counts per class are correct; stale alerts are emitted
  oldest-heartbeat-first with the right `ageMs`; an empty list is an all-zero
  report.
- **SQL read side.** `listAll` maps rows (bigint counters → numbers, null
  `last_run_at`) to snapshots; `listStale` binds `(now, now − staleAfterMs)`,
  filters `status='running' AND last_heartbeat_at < cutoff`, and maps alerts.
- **Real-PG (gated).** Two seeded heartbeats (one fresh, one 5-minutes-stale,
  both `running`) — `listStale` returns only the stale one, and
  `summarizeWorkerHealth(listAll())` flags it.

## Alternatives considered

- **Wire directly into `observability-runtime` / declare an incident here.**
  - **Decision.** No — `workflow-worker` doesn't depend on the incident/SLO
    packages, and shouldn't (it would invert the contract direction). Emitting a
    structural `StaleWorkerAlert` keeps detection here and routing in the
    consumer, exactly as the heartbeat write side is consumer-agnostic.
- **A background poller that auto-pages on stale workers.**
  - **Decision.** Deferred — the detection primitives (`listStale` /
    `summarizeWorkerHealth`) are the reusable core; a poller is a thin consumer
    (an operator query, a cron, or a future SLO surface) that composes them. No
    need to bake a paging loop into the library.
- **Infer staleness from `last_run_at` instead of `last_heartbeat_at`.**
  - **Decision.** No — a healthy worker with an empty backlog beats but doesn't
    *run*; `last_run_at` would false-positive an idle worker.
    `last_heartbeat_at` is the liveness signal; the counters show throughput
    separately.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,501 offline tests + 8 gated
  real-Postgres integration tests** (+10 offline, +1 integration; 0 new tables/
  columns/packages). A dead/hung worker is now a typed alert, not just an old
  row: `store.listStale({now})` (one indexed query) or
  `summarizeWorkerHealth(store.listAll(), {now})` answers "which workers are
  down" and hands back `StaleWorkerAlert`s an incident system can act on.
- **The heartbeat loop is now closed** — write (P2.7) → detect (P2.11). Wiring
  the alerts into an actual SLO/incident surface, and a background staleness
  poller, are natural consumer-side follow-ups.
