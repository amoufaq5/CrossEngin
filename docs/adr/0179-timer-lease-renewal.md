# ADR-0179: Timer lease renewal — heartbeat a claim through a slow fire

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0178 (engine-bound timer worker), ADR-0175 (timer claim), ADR-0176 (workflow-worker) |

## Context

A claim leases a timer for `leaseMs` (default 30s); after it lapses another worker may steal it
(ADR-0175). That's the crash-recovery mechanism — but it also means a **legitimately slow** fire (a
long instance advance) can outlive its lease and be double-claimed. Firing is idempotent, so a
double-fire is safe, but redundant work is wasteful. The fix is a heartbeat: renew the lease while
the fire runs.

## Decision

- **`renewTimerClaim(conn, {timerId, workerId, now, leaseMs, schema})`** (`workflow-runtime-pg`) —
  `UPDATE … SET claim_expires_at = now+leaseMs WHERE timer_id = $1 AND claimed_by = $2 AND status =
  'scheduled'`. Returns `true` only if a row updated: the timer must still be `scheduled` **and**
  still owned by this worker. `false` means the lease was already lost (stolen after lapse, or the
  timer fired) — a signal the caller may stop.
- **`renewWhile(task, {renewer, timerId, workerId, intervalMs, sleep, onLeaseLost?})`** (pure,
  `workflow-worker`) — runs `task` while a background heartbeat renews every `intervalMs`. A `done`
  flag checked before each renew guarantees no renewal races past completion; `renewWhile` awaits
  the heartbeat before returning, so no timer dangles. A lost lease stops the heartbeat and fires
  `onLeaseLost` but does **not** abort `task` (idempotent firing makes a double-fire safe) — the
  caller decides. `sleep` is injectable for deterministic tests.
- **Wired, opt-in.** `buildClaimRenewer(conn, {leaseMs, now, schema})` adapts `renewTimerClaim` to
  the `ClaimRenewer` seam; `buildTimerProcessor(engine, {renewal})` wraps the fire in `renewWhile`;
  `buildWorkflowTimerWorker({…, renewIntervalMs})` enables it end to end. Omit `renewIntervalMs`
  and behavior is exactly as before (a single lease, no heartbeat).

## Consequences

- A slow fire keeps its lease: `renewIntervalMs` well under `leaseMs` (e.g. 10s heartbeat on a 30s
  lease) means the claim is refreshed several times before it would lapse, so no other worker steals
  an in-flight timer. Redundant double-fires from slow advances go away.
- Crash recovery is unchanged: a worker that dies mid-fire stops heartbeating, its lease lapses, and
  the timer is reclaimed — exactly ADR-0175's behavior. The lease is still the source of truth.
- Opt-in and backward compatible: no `renewIntervalMs` ⇒ no renewal, and the pure `renewWhile`
  clean-shutdown semantics mean enabling it never leaks a heartbeat.
- 6,825 tests pass (+7: `renewTimerClaim` renew/lost/guards, `renewWhile` heartbeat-while-running /
  lease-lost-stops / no-renew-if-task-fast, and the processor heartbeating a slow fire). Full build
  + typecheck green.
- Follow-ups: the same claim + worker (with renewal) for scheduled activities + `jobs`; the P2
  exit-criterion end-to-end against real Postgres.
