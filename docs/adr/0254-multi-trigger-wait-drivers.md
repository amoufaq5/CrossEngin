# ADR-0254: Multi-trigger wait drivers — signals + timers cross-reach

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-26 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0251 (`send_signal` — Q listed signal → `waiting_for_timer`), ADR-0249 (`cancel_timer` — same Q), ADR-0253 (`spawn_child_workflow`) |

## Context

ADR-0251 and ADR-0249 both flagged the same open question — "deliver signals to
`waiting_for_timer` instances so a signal can cancel a deadline directly
without a firing-timer intermediary." The motivating shape is the
**deadline + early-completion** pattern: a state with `kind: "waiting"`, an
on-entry `schedule_timer`, and both `signal_received` ("abort"/"complete") and
`timer_fired` ("deadline") outgoing transitions.

The projection wrinkle that made this a real gap: the `timer_scheduled` event
**directly** sets `state.status = "waiting_for_timer"` (projection.ts line 269,
overriding `refineStatus`'s signal precedence). So a state with both triggers
plus an on-entry `schedule_timer` ends up at `waiting_for_timer`, not
`waiting_for_signal` as one might assume from the refineStatus rules. Pre-M8.6,
`submitSignal`'s filter was `running || waiting_for_signal` — it **skipped**
this instance and the signal could not pre-empt the deadline.

The symmetric gap is `tickTimers`: its filter was `waiting_for_timer || running`,
so a `waiting_for_signal` instance with a long-lived **cross-state timer** (a
"SLA" timer scheduled in an earlier state, never fired or cancelled) was
invisible — the timer would never fire while the instance waited on a signal.

## Decision

Widen both drivers' status filters by **one line each**.

1. **`submitSignal`** accepts `running` || `waiting_for_signal` ||
   **`waiting_for_timer`**. A signal arriving at a `waiting_for_timer` instance:
   if the current state has a matching `signal_received` transition, it fires;
   otherwise the `signal_received` + `signal_consumed` events are still appended
   (audit), consistent with the existing behavior for `running` instances
   without a matching trigger.

2. **`tickTimers`** accepts `waiting_for_timer` || `running` ||
   **`waiting_for_signal`**. A timer firing on a `waiting_for_signal` instance
   with an active cross-state timer: if the current state has a matching
   `timer_fired` transition, it fires; otherwise the `timer_fired` event is
   appended (the active-timers projection still removes the timer).

3. **Scope.** The other waiting statuses — `waiting_for_activity`,
   `waiting_for_manual`, `waiting_for_child` — still gate both drivers. Their
   semantics aren't motivated by this ADR's Q; broadening any of them is a
   deliberate future decision (see Open questions).

## Alternatives considered

- **Widen to every `waiting_for_*` status.**
  - **Why not:** `waiting_for_activity` (activity in-flight),
    `waiting_for_manual` (human approval), and `waiting_for_child` (child
    workflow) each have semantics the deadline + early-completion pattern
    doesn't motivate; broadening should be per-status with a clear use case.

- **Change `refineStatus` precedence (timer over signal).**
  - **Why not:** would invert existing `waiting_for_signal` projections + would
    not actually help in the deadline pattern (the `timer_scheduled` event
    already overrides refineStatus). The filter widening is non-invasive and
    addresses the real path.

- **Auto-cancel pending timers when a signal pre-empts the timer state.**
  - **Why not:** timers scheduled in earlier states may intentionally outlive
    them (a global SLA); blanket auto-cancellation is too aggressive. Operators
    who want explicit cancellation use `cancel_timer` (M8.3) on the post-signal
    state's on-entry.

- **Restrict the widening to instances *with* a matching trigger.**
  - **Why not:** `submitSignal` already records `signal_received` +
    `signal_consumed` audit events on a `running` instance without a matching
    transition; the same audit-record behavior on `waiting_for_timer` is
    consistent. A `--only-if-matching` mode could be a future flag.

## Consequences

- **Positive:** the deadline + early-completion pattern works end-to-end — a
  signal pre-empts the deadline; cross-state SLA timers fire on
  `waiting_for_signal` states.
- **Neutral:** `submitSignal` now visits a wider instance set (any
  `waiting_for_timer` instance with matching tenant + correlationKey records
  the signal arrival in the audit log even when no transition fires); this is
  intentional + consistent with the existing `running`-instance behavior.
- **Negative:** adding a future fifth waiting status would also need a
  deliberate filter decision.
- **Reversibility:** trivial — revert the two filter lines.

## Implementation notes

- `timer_scheduled` (projection.ts) sets status directly to `waiting_for_timer`,
  overriding `refineStatus` — so a state with `[signal_received, timer_fired]`
  triggers + on-entry `schedule_timer` projects to `waiting_for_timer`, **not**
  `waiting_for_signal`. The deadline test verifies this is the path; the
  cross-state test verifies the symmetric direction.
- `submitSignal` recursively calls `runStepLoop` after each matched instance;
  if the new wider-filter match has no signal_received transition, the loop
  quiesces immediately (no state corruption — the existing append-only design
  is robust to "events appended without a transition").
- Test count 9,436 → **9,440** (+4: deadline pre-empt by signal, cross-state
  timer fires on waiting_for_signal, sanity for tickTimers on the deadline, and
  the no-matching-trigger audit case).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Widen `submitSignal` / `tickTimers` to `waiting_for_activity` (activity in-flight could be pre-empted by a signal / SLA timer) | platform | _deferred_ |
| Same for `waiting_for_manual` (manual-approval pre-emption by a signal — e.g., recall) | platform | _deferred_ |
| Same for `waiting_for_child` (parent pre-empts before a child completes) | platform | _deferred_ |
| Optional `submitSignal --only-if-matching` mode that refuses to append audit events when no transition would fire | platform | _deferred_ |
| Auto-cancel timers on a signal-driven transition out of the timer-scheduling state (operator-policy concern; defer) | platform | _deferred_ |

## References

- ADR-0251 / ADR-0249 — both flagged this gap in Open Questions.
- `packages/workflow-runtime/src/engine.ts` (`submitSignal`, `tickTimers`
  filters), `packages/workflow-runtime/src/projection.ts` (`timer_scheduled`
  status override).
