# ADR-0111: async activity queue — decouple schedule from execute (Phase 3 P2.8)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0105 (activity retry executor), ADR-0107 (retry backoff), ADR-0110 (worker observability), ADR-0049 (workflow-runtime), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.8) — the deep follow-up
> ADR-0105 named.

## Context

Since M3 the engine ran activities **inline**: `applyScheduleActivity` emitted
`activity_scheduled` and then immediately ran the handler in the same engine
call, so the instance (and the caller) blocked on activity execution. ADR-0105
added a *retry* executor but the **first** run still happened inline. The deep
P2 item — named and deferred by ADR-0105 — is to decouple schedule from execute
so activities run on workers, not in the scheduling call. The constraint: this
must not break the synchronous semantics every existing workflow + test relies
on. So async is **opt-in, additive** — inline stays the default.

## Decision

- **Opt-in per activity.** A `schedule_activity` action with
  `parameters.executionMode: "async"` emits `activity_scheduled` and **returns
  without running the handler** — the activity stays `scheduled`, the instance
  parks `waiting_for_activity`. Without the flag (the default `"inline"`),
  behavior is exactly as before (handler runs in-call). The mode is persisted on
  the event + projection.
- **`workflow-runtime` — `WorkflowEngine.executeActivity({instanceId,
  activityId})`** runs the **first** attempt of a scheduled, never-started async
  activity (replaying the persisted input, attempt 1), then runs the step loop so
  a terminal state finalizes. **Idempotent + race-safe**: an activity that has
  already started (any `activity_started`), succeeded/failed, or an
  unknown/terminal instance is a no-op (`executed: false`), so two executors
  can't double-run it. (Disjoint from `retryActivity`: execute = no `started`
  event yet; retry = re-run after a settled failure.)
- **`kernel` meta-schema** — `meta.workflow_activities` gains
  `execution_mode TEXT NOT NULL DEFAULT 'inline'` (`inline`|`async`) + an
  `idx_workflow_activities_execute_claim (status, execution_mode,
  lease_expires_at)` index. No new table (count stays 124).
- **`workflow-worker`**
  - **`PostgresActivityExecuteClaimStore.claimScheduledActivities`** — claims
    `status='scheduled' AND execution_mode='async'`, unleased, via **`FOR UPDATE
    SKIP LOCKED`** + lease (the `execution_mode='async'` filter keeps inline
    activities — which never persist `scheduled` across a call — out of the
    queue).
  - **`ActivityExecutorWorker`** — `runOnce` claims a batch + runs each via
    `engine.executeActivity`, releasing the lease in a `finally`; emits the P2.7
    `onRun` outcome. N of these drain the queue in parallel.
- **`apps/workflow-worker`** — a new `--mode execute` + `--execute-interval-ms`
  (default 2000); the default **`all`** now runs **claim + retry + timeout +
  execute** (the full parallel set); `WorkerEngine` extends
  `ExecuteActivityEngine`; `worker_heartbeats.mode` + `HeartbeatMode` gain
  `execute`.

The lifecycle is now: schedule (async) → `scheduled` row → executor claims +
runs (`executeActivity`) → on failure, the P2.4 backoff stamps `next_retry_at`
and the P2.2 retry executor re-runs it. The full queue reuses the proven
claim/lease + per-unit-execute pattern.

## Cross-cutting invariants enforced (by tests)

- **Async defers, inline doesn't.** An async-scheduled activity is *not* run at
  `startInstance` (no `activity_started`, instance `waiting_for_activity`, row
  `scheduled`/`async`); an inline activity (default) still runs synchronously to
  completion.
- **Executor runs it.** `executeActivity` runs the pending async activity to
  success and the instance completes; idempotent on a second call; no-op for an
  unknown activity/instance.
- **Disjoint parallel claiming.** `claimScheduledActivities` emits the `FOR
  UPDATE SKIP LOCKED` claim over `status='scheduled' AND execution_mode='async'`,
  binds `(now, limit, workerId, leaseExpiry)`; custom/invalid schema handled.
- **Worker drains + leases.** `ActivityExecutorWorker` runs each claim, releases
  the lease even on throw, emits `onRun`, and the poll loop routes errors.
- **Real-PG (gated).** An async activity left pending by the engine is picked up
  by `ActivityExecutorWorker` over the real claim store and the instance
  completes.

## Alternatives considered

- **Make all activities async (flip the default).**
  - **Decision.** No — that breaks every workflow's synchronous semantics + a
    large body of tests, for no benefit to workflows that want inline execution.
    Opt-in `executionMode: "async"` adds the queue without a breaking change; a
    deployment chooses per activity.
- **Infer async from activity kind (e.g. `http_call` async, `transformation` inline).**
  - **Decision.** No — execution mode is an operational choice (does this step
    block the instance or run on a worker?), not a property of the kind. An
    explicit flag is clearer; a future definition-level default can layer on top.
- **A dedicated queue table instead of a column on `workflow_activities`.**
  - **Decision.** No — the activities *are* the work (same reasoning as the timer
    claim, ADR-0104). `execution_mode` + the existing lease columns + an index is
    additive and keeps one source of truth.
- **Claim on `status='scheduled'` alone (no `execution_mode`).**
  - **Decision.** No — an inline activity is transiently `scheduled` between its
    `activity_scheduled` and `activity_started` projection writes (committed
    separately), so a concurrent executor could double-run it. The
    `execution_mode='async'` filter makes the queue race-free.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,480 offline tests + 6 gated
  real-Postgres integration tests** (+1 column + 1 index, +12 offline tests, +1
  integration test; 0 new tables/packages). Activities can now run **off the
  scheduling call**, on a pool of `ActivityExecutorWorker`s, draining in
  parallel — the inline path is untouched and remains the default.
- **The engine's per-unit primitives are now four** — `fireTimer`,
  `retryActivity`, `timeoutInstance`, `executeActivity` — each idempotent /
  settled-guarded, each driven by a leased `SKIP LOCKED` claim.
- **The P2 distributed-worker arc is complete** — timers, retries (with
  backoff), timeouts, async execution, all parallel + observable + proven against
  real Postgres. A definition-level async default + activity-level timeout
  sweeping (now that async activities can sit `running`) are natural future
  layers.
