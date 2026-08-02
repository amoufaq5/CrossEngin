# ADR-0177: `fireDueTimersForInstance` — targeted, log-driven timer firing for the worker

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0176 (workflow-worker), ADR-0175 (timer claim), ADR-0049 (workflow-runtime) |

## Context

`tickTimers(nowMs)` fires due timers by iterating the engine's **in-memory** `instanceTenant` map —
the set of instances *this process started*. A distributed worker (ADR-0176) is the opposite case:
it claims a due timer for an instance it never started, in another process, and must fire it from
the durable log. The engine needed a targeted, in-memory-map-independent way to advance one
instance's timers.

## Decision

- **`WorkflowEngine.fireDueTimersForInstance(instanceId, nowMs)`** (extracted from the `tickTimers`
  loop body, now the shared implementation both call). It reads the instance **purely from the
  event log** (`getInstanceState` / `listByInstance` already do — no `instanceTenant` lookup),
  reconstructs the still-`scheduled` timers, fires those with `fireAt <= nowMs` (appends
  `timer_fired`), applies the resulting transition, and runs the step loop. Returns the same
  `TickTimersResult`. `tickTimers` now just folds this over the in-memory map.
- **Idempotent per timer.** An already-`timer_fired`/`timer_cancelled` timer isn't in the scheduled
  set, so a re-delivered claim (at-least-once) fires nothing — the property the worker's
  release/lease-retry semantics rely on.
- **Cross-process by construction.** Because it's log-driven, a second engine sharing only the
  event log — its in-memory map empty — fires the timer correctly. That's exactly the worker's
  `TimerProcessor`: claim → `withTenantContext(tenant)` → `fireDueTimersForInstance(instanceId, …)`.

## Consequences

- The distributed worker now has the engine capability it needs: fire a claimed timer's instance
  from the log, without that instance ever having been started in the worker's process.
- `tickTimers` behavior is unchanged — it delegates to the new method per in-memory instance, and
  every existing tick test still passes; the refactor is pure extraction.
- The remaining wiring (a `TimerProcessor` that runs this under the timer's tenant RLS context, on
  the same connection the persistent event log uses) is the deliberate next slice — it needs the
  tenant-context connection threaded through the engine's event log, a persistence concern.
- 6,813 tests pass (+4: targeted fire + transition, cross-process firing over one shared log while
  `tickTimers` finds nothing, idempotent re-fire, unknown-instance no-op). Full build + typecheck
  green.
- Follow-ups: the engine-bound `TimerProcessor` (with RLS connection + lease renewal for slow
  fires); the same targeted pattern for scheduled activities; the P2 exit-criterion end-to-end
  (kill worker A mid-flight → resume on B).
