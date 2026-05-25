# ADR-0249: Implement the workflow `cancel_timer` action

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-25 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0156 (timer_set/timer_cancelled instrumentation), ADR-0049 (workflow runtime), ADR-0132 (activity instrumentation) |

## Context

ADR-0156 (M8.2) added `timer_set` and `timer_cancelled` to the workflow
instrumentation kinds and wired `timer_set` into `applyScheduleTimer`. But
`timer_cancelled` was reserved, not emitted: the engine's `cancel_timer` action
handler still threw `action kind cancel_timer is not implemented in M3`. So a
workflow that declares a `cancel_timer` on-entry action crashes at runtime, and
the reserved instrumentation event has no producer. The event-log kind
`timer_cancelled` already exists (history.ts) and the projection already handles
it (drops the timer from the active set, and flips `waiting_for_timer → running`
when no timers remain) — only the action that *appends* it was missing.

Engine timer/signal model (relevant to how cancellation is reached): scheduling
a timer puts the instance in `waiting_for_timer`; `submitSignal` only delivers to
`running` / `waiting_for_signal` instances; so the realistic trigger for a cancel
is a *firing* timer, not a signal. The canonical pattern: a short "checkpoint"
timer fires and transitions into a state whose on-entry cancels a longer pending
"deadline" — i.e. "work completed early, cancel the SLA deadline".

## Decision

Implement `cancel_timer`.

1. **`applyCancelTimer(instanceId, tenantId, action)`.** Read `timerName` from the
   action parameters (no-op if absent). Reconstruct the instance's still-active
   timers from its event log, take every active timer whose name matches, and for
   each: emit the `timer_cancelled` instrumentation event (`timerId` + `timerName`)
   then append a `timer_cancelled` event-log event (so the projection drops it).
   Cancel **all** matches (rescheduling under one name can leave more than one);
   cancelling an unknown / already-fired timer is a safe no-op (common in saga
   compensation, which fires defensively).

2. **Extract `activeTimersFromEvents`.** `tickTimers` reconstructed the active
   timer set inline (`timer_scheduled` minus `timer_fired`/`timer_cancelled`);
   `applyCancelTimer` needs the same. Extract one private helper and call it from
   both — DRY, no behavior change to `tickTimers`.

3. **Validate at the definition layer.** Add `cancel_timer requires timerName`
   to the `WorkflowDefinition` superRefine, mirroring `schedule_timer`, so a
   malformed action is caught at parse time, not runtime.

Wire ordering when a cancel runs: `timer_cancelled` instrumentation → the
`timer_cancelled` event-log append. The dispatch case for `cancel_timer` no longer
throws; `spawn_child_workflow` and `send_signal` remain unimplemented.

## Alternatives considered

- **Cancel by explicit `timerId` instead of `timerName`.**
  - **Why not:** `schedule_timer` declares `timerName`; a workflow author knows
    the name, not the runtime-generated `wft_…` id. By-name matches the contract.

- **Throw / error on cancelling an unknown timer.**
  - **Why not:** compensation and race handling fire cancels defensively (the
    timer may have already fired); a no-op is the safe, expected behavior.

- **Cancel only the first matching timer.**
  - **Why not:** rescheduling under one name can leave multiple active timers;
    cancelling all matches is unambiguous.

- **Inline the timer reconstruction in `applyCancelTimer`.**
  - **Why not:** duplicates the `tickTimers` loop; one shared helper avoids drift.

- **Skip the definition-layer validation.**
  - **Why not:** `schedule_timer` validates its `timerName`; the symmetric check
    fails fast on malformed definitions instead of no-oping silently at runtime.

## Consequences

- **Positive:** `cancel_timer` is functional; the reserved `timer_cancelled`
  event now has a producer; SLA-deadline-cancel and saga-compensation patterns
  work end to end; the M3-era "not implemented" throw is gone for `cancel_timer`.
- **Negative:** none material; `spawn_child_workflow` + `send_signal` still throw
  (separate milestones).
- **Neutral:** `tickTimers` + `applyCancelTimer` share the new helper.
- **Reversibility:** trivial — restore the throw in the dispatch case.

## Implementation notes

- `packages/workflow-runtime/src/engine.ts`: dispatch `cancel_timer →
  applyCancelTimer`; new `activeTimersFromEvents` (also used by `tickTimers`);
  `applyCancelTimer` appends the event via the same `appendEvent` shape as
  `applyScheduleTimer` and emits via `emitInstrumentation`.
- `packages/workflow-engine/src/definitions.ts`: `cancel_timer requires
  timerName` superRefine check.
- Tests: `engine.test.ts` "timer lifecycle instrumentation (M8.2)" block gains 4
  — emits `timer_cancelled` (checkpoint→cancel-deadline), same `timerId` as the
  deadline's `timer_set`, a cancelled timer never fires on a later tick, and
  cancelling an unknown timer is a no-op; the stale "reserved for a future
  milestone" comment is refreshed. `definitions.test.ts` gains a
  `cancel_timer requires timerName` rejection. Test count 9,400 → 9,405 (+5).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Cancel by explicit `timerId` (in addition to `timerName`) for fine-grained control | platform | _deferred_ |
| Deliver signals to `waiting_for_timer` instances so a signal can cancel a deadline directly | platform | _deferred_ |
| Implement `spawn_child_workflow` + `send_signal` (still "not implemented in M3") | platform | _deferred_ |

## References

- ADR-0156 — timer_set/timer_cancelled instrumentation (this implements the
  cancel_timer producer it reserved).
- `packages/workflow-runtime/src/engine.ts`, `packages/workflow-engine/src/definitions.ts`.
