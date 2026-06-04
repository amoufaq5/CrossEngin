# ADR-0112: definition-level activity execution-mode default (Phase 3 P2.9)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0111 (async activity queue), ADR-0049 (workflow-runtime), ADR-0007 (workflow definitions), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.9).

## Context

ADR-0111 made activity execution async **per `schedule_activity` action**
(`parameters.executionMode: "async"`). For a workflow whose every step should
run off the scheduling call, repeating `executionMode: "async"` on each action
is noise. P2.9 adds a **definition-level default** so a whole workflow can opt
its activities into async in one place, while a per-action flag still overrides.

## Decision

- **`workflow-engine`** — `WorkflowDefinitionSchema` gains an optional
  `defaultActivityExecutionMode` (`inline`|`async`, from the new
  `ACTIVITY_EXECUTION_MODES` enum in `activities.ts`). It is `.optional()` (not
  `.default()`) so the inferred `WorkflowDefinition` output type stays
  back-compatible — existing definition literals/fixtures need no change; an
  absent value means inline.
- **`workflow-runtime`** — `applyScheduleActivity` resolves the mode by
  **precedence**: the per-action `executionMode` param (if `inline`/`async`) →
  the definition's `defaultActivityExecutionMode` → `"inline"`. The resolved mode
  is persisted on the `activity_scheduled` event + projection exactly as in
  ADR-0111, so the claim store / executor are unchanged.

No meta-schema change (the `execution_mode` column already stores the *resolved*
mode per activity), no new package, no DB column.

## Cross-cutting invariants enforced (by tests)

- **Schema.** `defaultActivityExecutionMode` is optional (absent → undefined),
  accepts `async`, and rejects an unknown value.
- **Default drives async.** A `schedule_activity` action with **no**
  `executionMode`, on a definition with `defaultActivityExecutionMode: "async"`,
  is left scheduled (instance parks) and an executor runs it.
- **Per-action overrides.** With the same async default, an action that sets
  `executionMode: "inline"` runs synchronously at schedule time.
- **Back-compatible.** A definition without the field behaves exactly as before
  (inline).

## Alternatives considered

- **Per-state or per-entity default instead of per-definition.**
  - **Decision.** No — the workflow definition is the natural unit for "how do
    this workflow's activities run". A finer scope adds knobs without a clear
    need; per-action already covers the exception case.
- **`.default("inline")` on the schema.**
  - **Decision.** No — zod's `.default()` makes the field **required** in the
    inferred output type, which would force every `WorkflowDefinition` literal +
    fixture across the workspace to add it. `.optional()` + an engine-side
    `?? "inline"` is non-breaking and equivalent.
- **A global engine-level default.**
  - **Decision.** No — execution mode is a per-workflow design choice; a global
    switch would change unrelated workflows. The definition default is scoped
    correctly.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,483 offline tests + 6 gated
  real-Postgres integration tests** (+3 offline tests; 0 new tables/columns/
  packages). A workflow can now declare `defaultActivityExecutionMode: "async"`
  once and have all its activities run on the executor pool, with per-action
  `executionMode` as the override — completing the async-queue ergonomics on top
  of ADR-0111's per-action seam.
