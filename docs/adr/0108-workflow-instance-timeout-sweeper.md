# ADR-0108: instance timeout sweeper — timeoutInstance + claim (Phase 3 P2.5)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0107 (retry backoff), ADR-0105 (activity retry executor), ADR-0104 (timer claim), ADR-0106 (apps/workflow-worker), ADR-0049 (workflow-runtime), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.5).

## Context

Timers fire (P2.1) and failed activities retry (P2.2/P2.4), but a workflow
**instance** that parks waiting for a signal / manual task / timer that never
arrives sits forever — nothing enforced its overall `timeout_at` deadline
(`workflow_instances.timeout_at`, derived from the definition's
`timeoutSeconds`). The recommended P2.5 closes the time-based-progression trio
with a **timeout sweeper**: claim non-terminal instances past their deadline and
fail them — the same `FOR UPDATE SKIP LOCKED` + lease + per-unit-execute pattern
proven for timers and retries, now over `workflow_instances`. P2.4's byproduct
made it cheap: `timeout_at` (and the activity `timeout_at`) are now populated.

## Decision

- **`workflow-runtime` — `WorkflowEngine.timeoutInstance({instanceId,
  nowMs?})`** fails a non-terminal instance whose `timeoutAt` deadline has
  passed, emitting `instance_failed` with `errorCode: "INSTANCE_TIMEOUT"`
  (projects to status `failed`). **Idempotent + race-safe**: a terminal instance,
  an unknown instance, or one whose deadline has **not** actually passed (claimed
  a touch early, or the deadline was extended) is a no-op (`timedOut: false`), so
  two sweepers can't double-fail it. (There is no `timed_out` instance status —
  `failed` with the `INSTANCE_TIMEOUT` code is the terminal outcome.)
- **`kernel` meta-schema** — `meta.workflow_instances` gains lease columns
  `claimed_by TEXT` + `lease_expires_at TIMESTAMPTZ` and an
  `idx_workflow_instances_timeout_claim (status, timeout_at, lease_expires_at)`
  index (mirroring the timer + activity lease columns). No new table; count
  stays 123.
- **`workflow-worker`**
  - **`PostgresInstanceTimeoutClaimStore.claimTimedOutInstances`** — atomically
    claims, via **`FOR UPDATE SKIP LOCKED`**, instances that are **non-terminal**
    (`status NOT IN (completed, failed, cancelled, compensated)`), past deadline
    (`timeout_at <= now`), and unleased / lease-expired; stamps the lease and
    returns each instance's `wfi_` ref. `releaseInstance` clears a lease.
  - **`TimeoutSweeperWorker`** — `runOnce` claims a batch and fails each via
    `engine.timeoutInstance`, releasing the lease after each attempt (in a
    `finally`). `start`/`stop` poll an injectable `unref`'d interval.
- **`apps/workflow-worker`** — a new `--mode timeout` (over the claim store +
  sweeper) + a `--timeout-interval-ms` (default 10000); the default **`all`**
  mode now runs **claim + retry + timeout** (the full parallel production set);
  `WorkerEngine` extends `TimeoutInstanceEngine`.

Running N `TimeoutSweeperWorker`s sweeps the timeout backlog in **parallel** —
no global lock (`SKIP LOCKED` partitions); `timeoutInstance`'s deadline + terminal
guards + the lease cover races.

## Cross-cutting invariants enforced (by tests)

- **Times out only a past-deadline, non-terminal instance.**
  `timeoutInstance` fails a parked instance once `now ≥ timeoutAt`
  (`INSTANCE_TIMEOUT`); a not-yet-due instance, an already-failed instance
  (idempotent second sweep), and an unknown instance are all `timedOut: false`.
- **Disjoint parallel claiming.** `claimTimedOutInstances` emits the `FOR UPDATE
  SKIP LOCKED` claim over `status NOT IN (terminal) AND timeout_at <= now AND
  unleased`, binds `(now, limit, workerId, leaseExpiry)`, returns
  `{instanceRef}`; a custom schema is honored, an invalid one rejected.
- **Lease always released.** `TimeoutSweeperWorker` releases the lease after each
  attempt — even when the instance wasn't timed out, and even if
  `timeoutInstance` throws (`finally`).
- **Mode wiring.** `--mode timeout` wires only the sweeper (polling
  `--timeout-interval-ms`); `--mode all` wires claim + retry + timeout, each on
  its own interval.

## Alternatives considered

- **Sweep timed-out *activities* instead of instances.**
  - **Decision.** No — activities execute **inline**, so a `running` activity
    never persists between engine calls (it settles to succeeded/failed/timed_out
    immediately). The meaningful long-lived deadline is the **instance's** overall
    timeout while it's parked waiting. (Activity-level timeout becomes relevant
    only with the async activity queue — the deeper P2 follow-up — and its
    `timeout_at` is now populated, ready for it.)
- **Add a `timed_out` instance status.**
  - **Decision.** No — `failed` with `errorCode: INSTANCE_TIMEOUT` reuses the
    existing terminal failure path + projection (no schema enum change, no new
    event kind); the code distinguishes a timeout from other failures.
- **Fold timeout into the advisory-lock bulk tick (`WorkflowWorker`).**
  - **Decision.** No — the bulk tick fires *timers*; instance timeouts are a
    distinct claim over a distinct table. A parallel sweeper (like the retry
    executor) scales independently and shares the proven lease pattern.
- **Leave `all` = claim + retry (timeout opt-in only).**
  - **Decision.** No — a deployed tenant wants all three time-based progressions
    by default. `all` = claim + retry + timeout is the full production set;
    single-purpose modes stay available.

## Consequences

- **60 packages + 3 apps, 123 meta-schema tables, 6,459 tests** (was 6,447;
  +12, 2 new instance lease columns + 1 index, 0 new tables/packages). The
  time-based-progression trio is complete: **timers fire**, **failed activities
  retry on backoff**, and **stuck instances time out** — all parallel, all over
  the same `FOR UPDATE SKIP LOCKED` + lease primitive, all runnable from the one
  `workflow-worker` binary (`--mode all`).
- **The engine's per-unit primitives are now three** — `fireTimer`,
  `retryActivity`, `timeoutInstance` — each idempotent / settled-guarded, each
  driven by a leased claim.
- **The deeper P2 work remains** — a real-Postgres integration test of the
  claim → execute loops, worker observability / heartbeats, and the full async
  activity queue (decouple schedule from execute), which would also give
  *activity*-level timeout sweeping a target.
