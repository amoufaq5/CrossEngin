# ADR-0118: projection drift-sweep worker mode (Phase 3 P2.14)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0037 (workflow-runtime-pg / WorkflowReplayer), ADR-0106 (apps/workflow-worker), ADR-0110 (worker heartbeats), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.14).

## Context

`workflow-runtime-pg` already ships `WorkflowReplayer` — `resyncInstance`
re-projects an instance from the canonical event log and re-upserts its
projection rows, `bulkResync` does it in bounded batches, `verifyInstance`
returns a drift report. But nothing *ran* it periodically: projection drift left
by a crash mid-projection or a schema change sat until someone invoked the
replayer by hand. P2.14 adds a worker mode that sweeps it on a slow interval — a
self-healing safety net alongside the claim/execute/reap workers.

## Decision

- **`workflow-worker` — `drift-sweeper.ts`.** A structural `DriftResyncer`
  interface (`bulkResync({batchSize?, maxInstances?, status?}) →
  DriftResyncReport[]`, satisfied by `WorkflowReplayer` — so the package stays
  off `workflow-runtime-pg`) + a **`DriftSweepWorker`**: `runOnce` re-projects a
  **bounded** batch (`maxInstances`, default 500) and reports
  `{resynced, upserts}` (instances + total projection rows rewritten); emits the
  P2.7 `onRun` outcome, routes errors, never throws from the loop.
- **`apps/workflow-worker`** — a new **`--mode resync`** + `--resync-interval-ms`
  (default 300000 — slow) + `--resync-max` (default 500). `node.ts` builds a
  `WorkflowReplayer({conn, definitions})` and passes it as the runner's
  `resyncer`. `worker_heartbeats.mode` + `HeartbeatMode` gain `resync`.

Crucially, **`resync` is opt-in — NOT part of `--mode all`**: a full
re-projection is heavy (it rewrites correct rows too, since `resyncInstance` is
unconditional), so it runs on its own slow cadence when an operator enables it,
not in the hot production set. Re-upsert is idempotent, so re-projecting a
correct instance is harmless.

## Cross-cutting invariants enforced (by tests)

- **Sweeps + sums.** `DriftSweepWorker.runOnce` calls `bulkResync` with the
  configured `batchSize` / `maxInstances` (+ optional `status`) and returns the
  instance count + the summed upserts (instance + activities + signals + timers);
  the status filter is omitted when unset.
- **Worker loop.** Runs per tick, emits `onRun({claimed: resynced, processed:
  upserts})`, routes errors, stops cleanly.
- **Mode wiring.** `--mode resync` wires `[resync]` (polling
  `--resync-interval-ms`) and **throws without a resyncer**; `--mode all` does
  **not** include `resync`.
- **Real-PG (gated).** An instance whose projected `status` is corrupted (as a
  crashed projection would leave it) is restored to the correct status by
  `DriftSweepWorker` re-projecting from the canonical event log.

## Alternatives considered

- **Include `resync` in `--mode all`.**
  - **Decision.** No — re-projecting up to N instances every interval is heavy
    and rewrites correct rows; the production `all` set is the per-unit
    progression workers. Drift-sweep is a periodic safety net an operator opts
    into.
- **Verify (detect) then resync only drifted instances.**
  - **Decision.** Deferred — `bulkResync` re-upserts unconditionally (simple +
    self-healing). A `verifyInstance`-gated sweep that only writes when a
    `DriftReport` is non-empty would cut wasted writes; it's a natural
    refinement behind the same `DriftResyncer` seam.
- **A rolling cursor across runs (cover very large datasets).**
  - **Decision.** Deferred — each run re-projects the first `maxInstances` of the
    listing (offset 0). For a bounded safety net that's fine; a persisted cursor
    that advances the swept slice per run is the deeper follow-up.
- **Put the replayer wiring in `workflow-worker` (not the app).**
  - **Decision.** No — `workflow-worker` stays off `workflow-runtime-pg` (the
    structural `DriftResyncer` seam); the app, which already wires
    `buildPersistentEngine`, owns constructing the concrete `WorkflowReplayer`.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,520 offline tests + 15 gated
  real-Postgres integration tests** (10 worker + 5 serving; +6 offline, +1
  integration; 0 new tables/columns/packages — only the `worker_heartbeats.mode`
  enum gained `resync`). Projection drift is now self-healing: `workflow-worker
  --mode resync` periodically re-projects from the event log, restoring rows a
  crash or schema change left stale.
- **The worker now has eight modes** — tick · claim · retry · timeout · execute ·
  reap · resync · all — spanning progression (claim/execute), deadlines
  (timeout), maintenance (reap), and consistency (resync), all observed by the
  heartbeat.
- **A verify-gated sweep + a rolling cursor** remain the drift-sweep refinements.
