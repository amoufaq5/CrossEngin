# ADR-0115: lease-reaper — proactively clear expired worker leases (Phase 3 P2.12)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0104/0105/0108/0111/0113 (the claim stores), ADR-0114 (stale detection), ADR-0106 (apps/workflow-worker), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.12).

## Context

When a worker crashes mid-claim, its leased rows (`claimed_by` set,
`lease_expires_at` in the future) sit leased until the lease expires — then the
next claim's `(claimed_by IS NULL OR lease_expires_at < now)` predicate reclaims
them **lazily**. That works, but the rows stay visibly "claimed by a dead
worker" until something happens to query them, and the claim predicate evaluates
the OR-expired branch for every stale row forever. P2.12 adds a **reaper** that
proactively clears expired leases on an interval — the maintenance counterpart
to the claim/execute workers, and the natural complement to P2.11's stale
detection.

## Decision

- **`workflow-worker` — `lease-reaper.ts`.**
  - **`PostgresLeaseReaper.reapExpired(now)`** runs `UPDATE … SET claimed_by =
    NULL, lease_expires_at = NULL WHERE lease_expires_at IS NOT NULL AND
    lease_expires_at < now` across the **three** lease-bearing tables
    (`workflow_timers` / `workflow_activities` / `workflow_instances`), returning
    a `LeaseReapResult` (per-table counts + total). It touches **only expired**
    leases — a live worker holding a valid (future) lease is untouched.
  - **`LeaseReaperWorker`** polls `reapExpired` on an interval, emitting a
    `RunOutcome` ({claimed: 0, processed: reaped}) via `onRun` for the heartbeat,
    routing errors to `onError`, never throwing from the loop.
- **`apps/workflow-worker`** — a new `--mode reap` + `--reap-interval-ms`
  (default 30000); the default **`all`** now runs **claim + retry + timeout +
  execute + reap**. `worker_heartbeats.mode` + `HeartbeatMode` gain `reap`.

Reaping is **no less safe** than the lazy reclaim the claim stores already do:
the engine's per-unit primitives (`fireTimer` / `retryActivity` /
`timeoutInstance` / `executeActivity` / `timeoutActivity`) are all idempotent /
settled-guarded, so a reclaim of an in-flight-but-lease-expired unit can't
double-process it.

## Cross-cutting invariants enforced (by tests)

- **Reaps the three tables.** `reapExpired` issues one `UPDATE` per table
  (`workflow_timers` / `_activities` / `_instances`), each
  `SET claimed_by = NULL, lease_expires_at = NULL WHERE lease_expires_at IS NOT
  NULL AND lease_expires_at < $1`, and sums the per-table `rowCount`s.
- **Only expired.** The `lease_expires_at < now` predicate means a valid lease is
  never cleared; a custom schema is honored, an invalid one rejected.
- **Worker loop.** `LeaseReaperWorker.runOnce` returns the total reaped; the poll
  loop emits `onRun`, routes errors, and stops cleanly.
- **Mode wiring.** `--mode reap` wires `[reap]` (polling `--reap-interval-ms`);
  `--mode all` appends `reap` to the set.
- **Real-PG (gated).** An instance + its scheduled activity stamped with an
  expired lease (as a dead worker would leave) are cleared by
  `PostgresLeaseReaper.reapExpired` (`claimed_by` back to NULL).

## Alternatives considered

- **Rely on lazy reclaim only (no reaper).**
  - **Decision.** No — lazy reclaim keeps dead-worker rows visibly "claimed"
    indefinitely (poor observability, and P2.11's stale view conflates a live
    lease with a dead one). A periodic reap keeps the lease columns honest.
- **Reap inside each claim store before claiming.**
  - **Decision.** No — that couples cleanup to the hot claim path and repeats it
    per claim type. A single reaper over all three tables is cheaper and runs on
    its own slow interval (30s), independent of claim frequency.
- **A SQL trigger / scheduled job in the database.**
  - **Decision.** No — the worker process is the natural owner of its lease
    lifecycle; keeping the reaper in the app (injectable, tested, heartbeat-
    observed) is consistent with the rest of the worker arc and needs no DB-side
    scheduler.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,506 offline tests + 9 gated
  real-Postgres integration tests** (+5 offline, +1 integration; 0 new tables/
  columns/packages — only the `worker_heartbeats.mode` enum gained `reap`). A
  crashed worker's claimed units are now reclaimed **proactively**: `--mode all`
  runs the reaper every 30s, and the lease columns reflect reality instead of a
  dead worker's last grab.
- **The lease lifecycle is now complete** — claim (5 stores) → lazy reclaim
  (claim predicate) → proactive reap (P2.12) → observe (heartbeat counters,
  P2.7) → detect dead workers (P2.11). The P2 distributed-worker arc has its
  maintenance layer.
