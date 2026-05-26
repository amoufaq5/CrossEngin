# ADR-0253: Implement the workflow `spawn_child_workflow` action

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-26 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0251 (`send_signal`), ADR-0249 (`cancel_timer`) — same unimplemented-action lineage; ADR-0156/0120 (instrumentation kind + CHECK precedent) |

## Context

ADR-0251 (M8.4) implemented `send_signal` and left `spawn_child_workflow` as the
**last** throwing branch in the engine's `applyAction` dispatch. The schema
already reserved every supporting piece:

- `child_workflow_spawned` + `child_workflow_completed` **event-log kinds**
  (`EVENT_KINDS`, with a validation that each carries a `childInstanceId`);
- a `child_workflow_completed` **transition trigger** matched by
  `childDefinitionKey` (`findApplicableTransitions` already handles it);
- `StartInstanceInput.parentInstanceId`, written into the `instance_started`
  payload and surfaced on the projection as `parentInstanceId`;
- state-neutral projection cases for both child events.

So the trigger implies the intended model: a parent **spawns** a child workflow
and **reacts when it completes** (sub-workflow orchestration / saga decomposition).
Only the action that starts the child + the notification that wakes the parent
were missing.

## Decision

Implement `spawn_child_workflow` as start-child + notify-parent-on-completion,
add the precise waiting status, and validate the parameter.

1. **Dispatch.** `spawn_child_workflow` → `applySpawnChildWorkflow`. The
   `applyAction` switch now has **zero throwing branches** — the action
   vocabulary is complete.

2. **`applySpawnChildWorkflow`.** Reads `childDefinitionKey` (no-op if missing —
   the parse-time check is the real guard) + optional `input` (child variables)
   + `correlationKey`; resolves the child via `findPublishedDefinitionByKey`
   (a **published** definition with that key in the **parent's tenant**; no-op if
   none — defensive, mirroring `cancel_timer`/`send_signal`); pre-generates the
   child `instanceId`; appends `child_workflow_spawned` to the **parent** (with
   the child id) + emits instrumentation **before** starting the child; then
   `startInstance`s the child with `parentInstanceId` + variables + correlationKey.

3. **`StartInstanceInput.instanceId`** (optional) — lets the parent record the
   child's id before the child runs.

4. **Parent notification.** `emitTerminalForStateKind`, after appending the
   child's terminal event, calls `notifyParentOfChildCompletion` when
   `state.parentInstanceId` is set: appends `child_workflow_completed` to the
   parent (childInstanceId + childTerminalKind), emits instrumentation, and fires
   the parent's matching `child_workflow_completed` transition (matched by the
   child's `definitionKey` via the existing `evaluateNextTransition`) + runs the
   parent step loop. Skips a parent that no longer exists or is already terminal.

5. **`waiting_for_child` instance status (new).** A `waiting`-kind state with an
   outgoing `child_workflow_completed` trigger projects to `waiting_for_child`
   (`refineStatus`); the parent quiesces there (`runStepLoop`); it's in
   `ACTIVE_INSTANCE_STATUSES`, `INSTANCE_TRANSITIONS` (running ↔ waiting_for_child
   ↔ terminal), and the `META_WORKFLOW_INSTANCES.status` CHECK. This isolates the
   waiting parent from `submitSignal`/`tickTimers` and is the precise status
   (parity with `waiting_for_activity` et al.).

6. **Instrumentation.** `child_workflow_spawned` + `child_workflow_completed`
   added to `WORKFLOW_INSTRUMENTATION_KINDS` (17 → 19) + `META_WORKFLOW_TRACES`
   CHECK (the event-log kinds already existed).

7. **Validation.** `StateActionSchema.superRefine` gains `spawn_child_workflow
   requires childDefinitionKey`.

## Alternatives considered

- **Fire-and-forget spawn (no parent notification).**
  - **Why not:** the `child_workflow_completed` trigger exists in the schema;
    without notification it would be dead. Orchestration (parent reacts to child)
    is the intended model.

- **No `waiting_for_child` status (parent idles at `running`).**
  - **Why not:** `refineStatus` would mis-status a waiting-kind state with a
    child trigger as `running`, and a `running` parent is exposed to
    `submitSignal` noise. The dedicated status is correct + isolating, and the
    change is additive (no test ripple, additive CHECK).

- **Resolve the child by `definitionId` instead of `childDefinitionKey`.**
  - **Why not:** the `child_workflow_completed` trigger matches by
    `childDefinitionKey`, so the spawn must reference the child by key for the
    completion round-trip to match. `findPublishedDefinitionByKey` resolves it.

- **Throw on an unregistered child definition.**
  - **Why not:** would crash the parent's transition. No-op (mirrors
    `cancel_timer`/`send_signal`) + the absence of `child_workflow_spawned` is
    observable. (Future Q: validate child-key references at parse when both defs
    are in one manifest.)

- **Append `child_workflow_spawned` *after* `startInstance`.**
  - **Why not:** a synchronously-terminating child's `child_workflow_completed`
    would then precede `child_workflow_spawned` in the parent's log. Pre-generating
    the id + appending spawned-first keeps the order correct.

- **A deferred-notification queue for synchronous child completion.**
  - **Why not (now):** the append-only + full-reprojection + `emittedTerminals`
    design makes synchronous re-entrant notification correct for the common shape
    (spawning state → child trigger → next state). A state with multiple
    meaningful on-entry actions *after* the spawn combined with a synchronously-
    terminating child is a documented edge (future Q).

## Consequences

- **Positive:** `spawn_child_workflow` works — a parent spawns + links + reacts
  to a child. The `applyAction` switch is **complete**: every dispatch action is
  implemented (`set_variable`, `audit_log`/`emit_event`, `schedule_activity`,
  `schedule_timer`, `cancel_timer`, `send_signal`, `spawn_child_workflow`).
- **Neutral:** new `waiting_for_child` status (12 → 13); instrumentation kinds
  17 → 19; `META_WORKFLOW_INSTANCES.status` + `META_WORKFLOW_TRACES.kind` CHECKs
  extended additively (no migration for existing rows). The instances
  "12 → 13 statuses" + instrumentation "17 → 19 kinds" assertions updated. Test
  count 9,427 → **9,436** (+9: engine +8, definitions +1).
- **Negative:** cross-instance spawn cycles (a parent spawning a child that
  spawns the parent) are unbounded — a definition-authoring concern, like the
  self-signal cycle from ADR-0251.
- **Reversibility:** restore the throw + drop the status / kinds / CHECK / method
  additions.

## Implementation notes

- The common path has no re-entrancy: the child completes on a later
  `tickTimers`/`submitSignal` while the parent is quiesced at `waiting_for_child`,
  so `notifyParentOfChildCompletion` drives a parent that is in no active call
  frame.
- A synchronously-terminating child (initial → terminal during the parent's spawn
  on-entry) re-enters the parent; the append-only log + monotonic sequence +
  `emittedTerminals` guard keep it correct (verified by test).
- `pnpm -r typecheck` can serve a stale turbo cache after an enum change (it
  reported a false pass while a fresh build caught `INSTANCE_TRANSITIONS` missing
  the new key); the build / `typecheck:tests` / CI build-first ordering is the
  authoritative check.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Validate `childDefinitionKey` references at parse time when parent + child are in one manifest | platform | _deferred_ |
| Pass the child's terminal output / variables back to the parent (currently only `childTerminalKind`) | platform | _deferred_ |
| Deferred-notification queue for deep synchronous spawn chains | platform | _deferred_ |
| Cross-instance spawn-cycle guard (pairs with ADR-0251's self-signal-cycle Q) | platform | _deferred_ |

## References

- ADR-0251 — `send_signal` (this closes the last unimplemented action; same
  dispatch + parse-validation pattern).
- ADR-0156 — timer instrumentation (the add-a-kind + extend-CHECK precedent,
  reused here for the two child kinds).
- `packages/workflow-runtime/src/engine.ts` (`applySpawnChildWorkflow`,
  `notifyParentOfChildCompletion`), `…/projection.ts` (`refineStatus`),
  `packages/workflow-engine/src/{instances,definitions}.ts`,
  `packages/kernel/src/bootstrap/meta-schema.ts`.
