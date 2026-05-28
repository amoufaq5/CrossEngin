# ADR-0255: Implement the workflow `submitManualAction` driver

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-26 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0251 (`send_signal` — completed the action vocabulary peer), ADR-0249 (`cancel_timer` — same shape "trigger has a peer driver"), ADR-0253 (`spawn_child_workflow` — closed the last *action* gap), ADR-0156 (instrumentation kind precedent) |

## Context

After ADR-0253 (M8.5) closed the last gap in the workflow *action*
vocabulary (`set_variable`, `audit_log`/`emit_event`, `schedule_activity`,
`schedule_timer`, `cancel_timer`, `send_signal`, `spawn_child_workflow`),
the parallel *trigger* vocabulary still had a hole. Triggers describe *how a
state advances*; drivers are the engine methods that deliver them:

| Trigger              | Driver                                       |
|----------------------|----------------------------------------------|
| `automatic`          | `runStepLoop` (every append)                 |
| `signal_received`    | `submitSignal`                               |
| `timer_fired`        | `tickTimers`                                 |
| `activity_completed` | `applyActivityCompletion` (activity lifecycle) |
| `child_workflow_completed` | `notifyParentOfChildCompletion` (M8.5)  |
| **`manual_action`**  | **(missing)**                                |

`manual_action` was already wired everywhere *except* the driver: the
trigger type exists in `definitions.ts`, the `waiting_for_manual` status
exists in `INSTANCE_STATUSES`, the `manual_action_taken` event kind exists
in `EVENT_KINDS` (with a schema rule requiring `actorPrincipalId` to be
non-null), `findApplicableTransitions` matches `manual_action` triggers by
`actionName`, and the projection handles `waiting_for_manual` correctly.
But no engine method drove the trigger — operators had no programmatic
path to fire a `manual_action` transition.

This is the parallel gap to the now-closed action gap, and it has the same
shape as M8.3/M8.4/M8.5: a feature reserved at the schema layer but
unimplemented at the driver layer. This ADR closes it.

## Decision

Add `WorkflowEngine.submitManualAction(input)` as the driver for
`manual_action` triggers, completing the trigger vocabulary.

```ts
interface SubmitManualActionInput {
  readonly instanceId: string;
  readonly tenantId: string;
  readonly actionName: string;
  readonly actorPrincipalId: string;          // required (event schema)
  readonly actorRoles?: readonly string[];     // for requiredRole + role_required guard
  readonly secondApproverPrincipalId?: string; // for requiresFourEyes
  readonly reason?: string;
  readonly attributes?: Record<string, unknown>;
}

interface SubmitManualActionResult {
  readonly applied: boolean;        // did a transition fire?
  readonly transitionName: string | null;
}
```

**Behavior, in order:**

1. **Address by `instanceId`** (not `correlationKey`). Manual actions are
   operator-targeted at a specific instance; `correlationKey` is the
   signal-bus model. Wrong tenant → throw; unknown instance → throw.
2. **Status filter.** Throw on terminal statuses
   (`completed`/`failed`/`cancelled`/`compensated`). Accept `running` or
   `waiting_for_manual`. Reject every other status (other waiting kinds
   throw with the actual status named) — the deliberate symmetric scope
   to ADR-0254's filter widening for signal/timer.
3. **Match the trigger.** Call `evaluateNextTransition` with
   `trigger: { kind: "manual_action", actionName }` and pass
   `principalRoles: input.actorRoles` so `findApplicableTransitions`'s
   existing `requiredRole` match works AND any `role_required` guard
   evaluates against the same roles. Result is the candidate transition
   or `null`.
4. **Enforce trigger preconditions** (only when a candidate matched).
   - `requiresFourEyes`: `secondApproverPrincipalId` must be present AND
     distinct from `actorPrincipalId`. Both checks throw.
   - `requiredRole`: `actorRoles` must include it. Throws.
   These fire **before** the audit event is appended, so a four-eyes /
   role violation is treated as a CLI misuse not an attempted action.
5. **Emit `manual_action_taken` instrumentation** (new kind, see below)
   with `{actionName, actorPrincipalId, transitionApplied, transitionName?,
   secondApproverPrincipalId?, reason?}`.
6. **Append the `manual_action_taken` event** with `actorPrincipalId`
   (the event schema's required non-null actor) and `payload` carrying
   `actionName` + optional `secondApproverPrincipalId` / `reason` /
   `attributes`. **Append regardless of match** — audit completeness
   (mirrors `submitSignal` which records arrival even when no
   transition fires).
7. **Apply the transition if matched.** Call `applyTransition` then
   `runStepLoop` (the same path `submitSignal` uses).

**Instrumentation kind.** `WORKFLOW_INSTRUMENTATION_KINDS` grows
19 → 20 with `manual_action_taken`. The `manual_action_taken` *event-log*
kind already existed; this is the matching *instrumentation* kind.
`META_WORKFLOW_TRACES.kind` CHECK is extended additively. The same
verb-pair shape as M8.1's `activity_started`/`activity_completed` /
M8.2's `timer_set`/`timer_cancelled` / M8.4's `signal_emitted` /
M8.5's `child_workflow_spawned`/`child_workflow_completed`.

## Alternatives considered

- **Reuse `submitSignal` for manual actions.**
  - **Why not:** different semantic. Signals are bus-style (matched by
    `tenantId + correlationKey`, can fan out to N instances). Manual
    actions are operator-targeted at one instance. Different inputs,
    different event kind, different four-eyes/role enforcement.

- **Append the event only when a transition fires.**
  - **Why not:** breaks audit completeness. Operators want a record of
    every manual action attempted, including denied/no-match — same
    reason `submitSignal` records arrivals on running-without-matching.

- **Append the event before enforcing four-eyes / role.**
  - **Why not:** would persist an audit trail of "manual action taken"
    even when the prerequisites failed. Throw-before-append makes it
    a misuse exit, not a logged action.

- **Throw when no transition matches (instead of audit-only).**
  - **Why not:** parity with `submitSignal`. Operators want to record
    "an approval was attempted on a state that no longer accepts it"
    in the audit log — the absence of `applied=true` in the response is
    the signal, not an exception.

- **Pass `secondApproverPrincipalId` only through `attributes`.**
  - **Why not:** four-eyes is structural and enforced by the engine; a
    typed top-level field keeps the contract explicit and the validation
    location obvious. (It also flows into the event payload + the
    instrumentation attributes for downstream queries.)

## Consequences

- **Positive:** the action vocabulary (closed in M8.5) and the trigger
  vocabulary (closed here) are now symmetric. `manual_action` is no longer
  schema-only; the human-approval pattern works end-to-end.
- **Positive:** `waiting_for_manual` is now usefully observable —
  operators see a parent waiting at a state with an outgoing
  `manual_action` trigger, call `submitManualAction`, and the
  transition fires.
- **Neutral:** instrumentation kinds grew 19 → 20. Schema CHECK extended
  additively — no migration.
- **Neutral:** the engine's append-only audit-on-attempt behavior now
  applies to two driver paths (`submitSignal` and `submitManualAction`).
- **Reversibility:** medium. Removing the method would orphan callers,
  but the schema (event kind, status, instrumentation kind) remains
  benign.

## Implementation notes

- The driver lands between `submitSignal` and `tickTimers` in
  `engine.ts` — operator-input drivers stay together, before the
  timer/clock-driven and child-completion-driven entry points.
- `instanceCorrelation.get(input.instanceId)` is threaded into the
  instrumentation event's `correlationId` when the instance has one
  (matches existing `signal_received`/`signal_consumed` behavior so the
  audit trail joins cleanly).
- The event's `payload` uses additive optional keys; the event's
  `actorPrincipalId` is the typed schema field (event-schema-required
  non-null), while the instrumentation event repeats it in `attributes`
  for query convenience.
- Test count 9,440 → **9,450** (+10): reject success, approve with
  role + four-eyes, missing second approver throws, second approver =
  actor throws, missing role throws, unknown actionName audit-only,
  cross-tenant throws, terminal instance throws, instrumentation
  attributes shape, kinds-enum coverage.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Surface `applied=false` distinctly when the action *matched* but a four-eyes/role violation aborted — currently throws (treated as misuse); a structured `denied` outcome may be useful for UIs | platform | _deferred_ |
| `submitManualAction` on `waiting_for_activity` / `waiting_for_child` (e.g., manual abort of a long activity / parent override of a stuck child) — pairs with ADR-0254's open questions | platform | _deferred_ |
| Bulk path for repeated approvals (e.g., approve 200 invoices under one auditor session) — current loop-N-times is correct but heavy | platform | _deferred_ |
| Optional second-approver role gate (the requiresFourEyes second approver must hold the same `requiredRole`) | platform | _deferred_ |
| Idempotency key on manual actions (a UI re-submit shouldn't double-fire) — currently each call appends one event | platform | _deferred_ |

## References

- ADR-0251 (`send_signal`), ADR-0249 (`cancel_timer`), ADR-0253
  (`spawn_child_workflow`) — completing-the-vocabulary lineage.
- ADR-0156 — instrumentation-kind precedent (verb-pair naming + additive
  CHECK extension).
- `packages/workflow-runtime/src/engine.ts`
  (`submitManualAction`), `packages/workflow-runtime/src/instrumentation.ts`
  (`WORKFLOW_INSTRUMENTATION_KINDS`),
  `packages/workflow-engine/src/transitions.ts`
  (`findApplicableTransitions` already matches manual_action),
  `packages/kernel/src/bootstrap/meta-schema.ts`
  (`META_WORKFLOW_TRACES.kind` CHECK).
