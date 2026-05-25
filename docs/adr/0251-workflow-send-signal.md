# ADR-0251: Implement the workflow `send_signal` action

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-25 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0249 (`cancel_timer` — same unimplemented-action lineage), ADR-0156 (timer instrumentation — add-a-kind + CHECK precedent), ADR-0120 (workflow instrumentation) |

## Context

ADR-0249 (M8.3) implemented `cancel_timer` and recorded that the workflow
engine's `applyAction` dispatch still throws `"not implemented in M3"` for the
two remaining action kinds: `spawn_child_workflow` and `send_signal`. A
workflow declaring `send_signal` crashed at runtime.

`send_signal` lets a running instance **emit a signal to other instances**
correlated by a key — the saga-coordinator → participants pattern (a coordinator
reaches a state and signals every participant to proceed), cross-workflow
choreography, and fan-out. The engine already has `submitSignal` — the external
signal-submission entry point (a webhook/bridge submits a signal) — which does
the tenant + correlation matching, appends `signal_received` / `signal_consumed`
events on receivers, and runs their transitions. `send_signal` is the *internal*
action that reuses that path; it is the smaller of the two remaining actions
(no child-instance lifecycle), so it lands first.

## Decision

Implement `send_signal` by delegating delivery to `submitSignal`, recording
sender-side observability, and validating its parameters at parse time.

1. **Dispatch.** `applyAction`'s combined throw splits:
   `send_signal` → `applySendSignal`; `spawn_child_workflow` keeps throwing (now
   its own message — still the one unimplemented action).

2. **`applySendSignal`.** Extracts `signalName` + `correlationKey` (no-op return
   if either is missing — runtime defense; the parse-time check below is the
   real guard) and an optional `payload`, then calls
   `submitSignal({ tenantId, signalName, correlationKey, payload, sourceSystem:
   <senderInstanceId> })`. The entire correlation + receiver-event + transition
   path is reused — no duplicate delivery logic.

3. **Tenant-scoped.** `submitSignal` filters by `tenantId`, so a sender reaches
   only instances in its own tenant.

4. **Receiver-side audit (existing model).** Signals are recorded as
   `signal_received` / `signal_consumed` events on the **receivers** — that is
   the established signal model, unchanged. The sender's `instanceId` is threaded
   as `sourceSystem`, so each receiver's `signal_received.actorSystemId` names the
   emitting instance (origin linkage in the source-of-truth log).

5. **Sender-side observability (the one additive enum).** A new `signal_emitted`
   instrumentation kind (`WORKFLOW_INSTRUMENTATION_KINDS` 16 → 17, parallel to
   M8.2's `timer_set`) is emitted **after** `submitSignal` with
   `{ signalName, targetCorrelationKey, signalId, matchedInstanceCount }`.
   `META_WORKFLOW_TRACES.kind` CHECK extended additively. This is *not* a new
   event-log kind (see Alternatives) — `EVENT_KINDS`,
   `META_WORKFLOW_EVENTS`, and the projection are untouched.

6. **Parse-time validation.** `StateActionSchema.superRefine` gains
   `send_signal requires signalName` + `send_signal requires correlationKey`,
   mirroring `cancel_timer requires timerName` — fail-fast at definition parse,
   not at runtime.

## Alternatives considered

- **Add a `signal_emitted` *event-log* kind (source-of-truth sender event).**
  - **Cons:** signals are modeled as `signal_received` / `signal_consumed` on
    *receivers*; a sender event would need `EVENT_KINDS` + the
    `META_WORKFLOW_EVENTS` CHECK + projection no-op handling. The receiver's
    `signal_received.actorSystemId = senderInstanceId` already captures origin in
    the source-of-truth log; sender observability is covered by the
    instrumentation kind.
  - **Why not:** `cancel_timer` (ADR-0249) reused a *reserved* event-log kind
    (`timer_cancelled`); there is no reserved sender-side signal kind, and adding
    one isn't warranted for what is fundamentally an observability concern.

- **Reuse the generic `action_applied` instrumentation kind** (defined since M8,
  never emitted).
  - **Why not:** the M8.1/M8.2 precedent uses *specific* kinds (`activity_started`,
    `timer_set`), so operators can filter "all emitted signals." A specific
    `signal_emitted` matches that and is self-documenting.

- **Custom delivery inside `applySendSignal`** instead of calling `submitSignal`.
  - **Why not:** duplicates the correlation + event-emit + transition + step-loop
    logic; delegation reuses the already-tested path verbatim.

- **Emit `signal_emitted` *before* `submitSignal`** (intent-first, like
  `timer_set`).
  - **Why not:** the useful audit payload (`signalId` + `matchedInstanceCount`)
    is only known after delivery; emitting after carries the richer data.

- **Thread an `idempotencyKey` through `send_signal`.**
  - **Why not:** each on-entry execution is a distinct emission; replay
    re-projects from events (it does not re-run actions), so there's no
    double-emit to dedupe. Left as a future Q for at-most-once fan-out.

## Consequences

- **Positive:** `send_signal` works — saga coordinator → participants, fan-out
  to N correlated instances, cross-workflow choreography. Receivers get the
  standard signal events; the sender gets a `signal_emitted` trace; origin is
  linked via `sourceSystem`. `spawn_child_workflow` is now the **only**
  remaining unimplemented dispatch action.
- **Negative:** a workflow whose new state's on-entry `send_signal` targets its
  own `correlationKey` with a matching `signal_received` transition can recurse
  (a definition-authoring concern — see Open questions).
- **Neutral:** instrumentation kinds 16 → 17; `META_WORKFLOW_TRACES.kind` CHECK
  extended additively (no migration for existing rows); event-log schema +
  projection unchanged. Test count 9,405 → **9,415** (+10: +8 engine, +2
  definitions).
- **Reversibility:** trivial — restore the combined throw + drop the kind /
  CHECK / validation.

## Implementation notes

- `applyTransition` appends `state_transitioned` *before* running on-entry
  actions, so the sender's projected state during `applySendSignal` is already
  the new state. Terminal states run on-entry actions (the test coordinator's
  emit-state is `terminal_success`).
- `submitSignal` runs each receiver's step loop after the signal transition, so
  post-signal automatic transitions also process.
- The sender completes its own transition regardless of match count —
  `matchedInstanceCount: 0` (no correlated receiver) is a valid emit and still
  produces a `signal_emitted` trace.
- `payload` is accepted only as a non-null, non-array object (mirrors the JSONB
  record shape `submitSignal` expects); anything else is dropped to `undefined`.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Implement `spawn_child_workflow` — the last unimplemented dispatch action | platform | _deferred_ |
| Deliver signals to `waiting_for_timer` instances so a `send_signal` can cancel a deadline directly (pairs with ADR-0249 Q) | platform | _deferred_ |
| Self-signal cycle guard (a definition that signals its own correlation key in a loop) | platform | _deferred_ |
| A sender-side `signal_emitted` *event-log* kind if source-of-truth sender audit is later required | platform | _deferred_ |
| `idempotencyKey` on `send_signal` for at-most-once fan-out | platform | _deferred_ |

## References

- ADR-0249 — `cancel_timer` (this closes the sibling `send_signal` gap; same
  `applyAction` dispatch + parse-time validation pattern).
- ADR-0156 — timer instrumentation (the add-a-kind + extend-`META_WORKFLOW_TRACES`
  -CHECK precedent reused here for `signal_emitted`).
- `packages/workflow-runtime/src/engine.ts` (`applySendSignal`),
  `packages/workflow-runtime/src/instrumentation.ts`,
  `packages/workflow-engine/src/definitions.ts`,
  `packages/kernel/src/bootstrap/meta-schema.ts`.
