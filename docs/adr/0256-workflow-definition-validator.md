# ADR-0256: Workflow definition pre-publish validator

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-26 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0049 (workflow engine runtime), ADR-0058 (manifest authoring), ADR-0251/0253/0255 (action+trigger vocabulary completion that made this gap apparent) |

## Context

After ADR-0255 (M8.7) closed the trigger vocabulary, the workflow engine's
"happy" path is complete: every documented trigger has a driver, every
documented action has an `applyAction` branch, and the schema's
`WorkflowDefinitionSchema.superRefine` checks ~10 structural invariants
at parse time (duplicate state/transition names, initialState declared
+ kind, exactly-one-initial + at-least-one-terminal, transitions
reference declared states + don't depart terminal, published 4-eyes,
deprecated has deprecatedAt, `signal_received`/`timer_fired` triggers
reference declared signals/timers, guards reference declared variables).
Action-level schemas additionally check parameter PRESENCE
(`schedule_activity requires activityKey`, `set_variable requires
variableName`, etc., shipped piecemeal across ADR-0249/0251/0253).

**The gap** — the schema doesn't cross-reference action-target NAMES
against the definition's declared lists. A `set_variable` action can
reference an undeclared variable; a `schedule_timer` can reference an
undeclared timer; a `send_signal` can reference an undeclared signal.
The schema validates parameters EXIST but not that the names RESOLVE.
These mistakes pass parse and surface at runtime as
silent-no-op or runtime throw (depending on the path).

Two structural gaps the schema also doesn't catch:

1. **Dead-end non-terminal states.** A non-terminal state with zero
   outgoing transitions is a runtime trap — an instance arrives, can
   never advance, and sits there waiting forever. The schema enforces
   `at least one terminal state` but not that every non-terminal can
   reach one.
2. **Unreachable states.** `findUnreachableStates` exists as a helper
   (definitions.ts L497) but isn't enforced anywhere. Operators
   authoring a 20-state workflow have no automated check for dead code.

Today operators discover all three classes of bug at runtime — usually
during incident response when an instance is "stuck" and the operator
re-reads the definition manually.

## Decision

Add `validateDefinition(def)` in a new
`packages/workflow-engine/src/validation.ts` module — a structural
validator distinct from the parse-time schema, intended to run BEFORE
persistence (CLI `--validate`, pre-publish gate, Architect-agent
auto-check).

```ts
export interface WorkflowValidationIssue {
  readonly code: WorkflowValidationCode;     // 5 stable codes
  readonly path: string;                      // navigable JSON path
  readonly message: string;                   // human-readable
  readonly severity: "error" | "warning";
}

export interface WorkflowValidationResult {
  readonly ok: boolean;                       // no error-severity issues
  readonly issues: readonly WorkflowValidationIssue[];
}

export function validateDefinition(def: WorkflowDefinition): WorkflowValidationResult;
```

**The 5 codes:**

| Code                          | Severity | Rule |
|-------------------------------|----------|------|
| `dead_end_state`              | error    | non-terminal state with no outgoing transitions |
| `unreachable_state`           | warning  | state not reachable from `initialState` (helper exists) |
| `unknown_variable_in_action`  | error    | `set_variable.variableName` not in `variables[]` |
| `unknown_timer_in_action`     | error    | `schedule_timer.timerName` / `cancel_timer.timerName` not in `timers[]` |
| `unknown_signal_in_action`    | error    | `send_signal.signalName` not in `signals[]` |

**Path format** — JSON-pointer-like, navigable by tooling:
`states[i].onEntryActions[j].parameters.variableName` or
`transitions[i].preTransitionActions[j].parameters.timerName`.
Issues fired on any of the four action scopes: `state.onEntryActions`,
`state.onExitActions`, `transition.preTransitionActions`,
`transition.postTransitionActions`.

**`ok` semantic** — `ok = issues.every(i => i.severity !== "error")`.
Warnings allowed (unreachable state is dead code, not a runtime trap).

**Cross-registry refs deliberately OUT of scope:**
- `schedule_activity.activityKey` — resolves against `ActivityRegistry`
  at runtime, not declared on the definition. The schema's
  `requires activityKey` is enough; cross-registry validation needs the
  registry instance (operator-time concern, future Q).
- `spawn_child_workflow.childDefinitionKey` — resolves against a
  separate published definition, not this one. Cross-definition
  validation needs the manifest registry (M7.6.5 has the resolver but
  it operates at manifest level, not engine level).

## Alternatives considered

- **Fold all checks into `WorkflowDefinitionSchema.superRefine`.**
  - **Why not:** changes `parse()` semantics. Every existing fixture
    + test that parses a "happy enough but missing X" definition would
    suddenly fail. Separating shape (schema) from semantics (validator)
    lets operators stage adoption — schema rejects on shape errors;
    validator surfaces semantic warnings + errors with structured codes
    + paths for programmatic handling.

- **Make `validateDefinition` throw on first error.**
  - **Why not:** operators want the FULL list in one pass. A definition
    with 5 unknown-variable refs should surface all 5, not error-fail-
    after-the-first. Aggregate-then-return matches the way operators
    iterate (fix one, re-validate, see remaining).

- **Treat unreachable states as errors.**
  - **Why not:** dead code is annoying but not a runtime trap (the
    instance never gets there). Dead-end non-terminal IS a runtime
    trap. The distinction matters for CI gates — warnings can be
    suppressed/ignored, errors fail the build.

- **Validate every parameter shape (e.g., `set_variable.value` is the
  right type for `variables[name].type`).**
  - **Why not:** scope creep. `value` types are runtime-evaluated
    (could be a variable interpolation expression). This validator
    catches the structural class of bugs ("name doesn't resolve"); the
    value-type class is a separate milestone.

- **Run validator inside `engine.startInstance` so every start hits it.**
  - **Why not:** validation is authoring-time; runtime checks would
    cost cycles for definitions that have already been validated +
    published. Operators wire `validateDefinition` into a pre-publish
    gate.

- **Check `spawn_child_workflow.childDefinitionKey` against currently-
  loaded definitions in the engine.**
  - **Why not:** that's a runtime concern. The engine's definition map
    is mutable + the child may be published after the parent — checking
    at validation time would force operator ordering. Resolver-level
    check belongs in the future cross-definition validator.

## Consequences

- **Positive:** authoring-time catches three classes of runtime bug —
  dead-end states, unreachable states, unknown action-target refs —
  with crisp paths + codes for programmatic handling.
- **Positive:** the engine's invariants stay implicit
  (`applyTransition` doesn't validate; runtime stays fast). Validation
  is an opt-in gate.
- **Positive:** stable code list — `WORKFLOW_VALIDATION_CODES` is a
  const tuple operators can switch on.
- **Neutral:** cross-registry refs deferred. Operators wanting "every
  `activityKey` matches a registered handler" wire that check at the
  ActivityRegistry boundary (future Q).
- **Neutral:** the schema is unchanged. Existing fixtures + parse
  semantics preserved.
- **Reversibility:** trivial — delete validation.ts + drop the
  `index.ts` export. Pure additive module.

## Implementation notes

- `validateDefinition` works on the parsed `WorkflowDefinition` type,
  but defensively guards `typeof params[key] === "string"` before
  checking against declared name sets — the schema is the right
  boundary for shape errors, the validator doesn't crash on a
  non-string slot.
- Path format mirrors zod's issue paths (array-index brackets,
  dot-separated keys) so tooling that already navigates `ZodIssue.path`
  can adapt with minimal change.
- 12 new tests in `validation.test.ts` cover: clean definition →
  `ok: true`; missing outgoing → `dead_end_state` error; unreachable
  terminal → `unreachable_state` warning + `ok: true`;
  `unknown_variable_in_action` across the 4 action scopes; multi-issue
  aggregation; benign on shape-broken input (schema's job); cross-
  registry refs (`schedule_activity` / `spawn_child_workflow`) NOT
  flagged.
- workflow-engine test count 181 → **193** (+12). Workspace test count
  9,450 → **9,462**. No schema change, no engine change, no breaking
  change.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Cross-registry validator — `validateDefinitionWithRegistry(def, activityRegistry, definitionRegistry)` checking `schedule_activity.activityKey` resolves + `spawn_child_workflow.childDefinitionKey` matches a published definition in the parent's tenant | platform | _deferred_ |
| CLI gate — `crossengin workflow validate <def.json>` exit-2 on errors, exit-0 on warnings (or fail-on-warning via `--strict`) | platform | _deferred_ |
| `engine.startInstance` opt-in pre-flight (`validateOnStart: true`) — runtime gate for paranoid deployments | platform | _deferred_ |
| Cyclic automatic-only loops detection — a chain of automatic transitions back to itself bounded by `MAX_STEP_ITERATIONS` but author-time catch would be cleaner | platform | _deferred_ |
| Value-type validation — `set_variable.value` shape matches `variables[name].type` (e.g., `type: "number"` rejects `value: "abc"`) | platform | _deferred_ |
| `manual_action.requiresFourEyes: true` without `requiredRole` — pure four-eyes without role discrimination is unusual; warning? | platform | _deferred_ |

## References

- `packages/workflow-engine/src/validation.ts` (this milestone),
  `packages/workflow-engine/src/definitions.ts` (`findUnreachableStates`
  reused, `WorkflowDefinitionSchema.superRefine` is the boundary
  validator).
- ADR-0049 — original engine runtime contract; this ADR closes one
  authoring-time gap.
