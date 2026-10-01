# ADR-0305: Spawning child workflows — the last stub (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0077 (Phase 3 plan) |

## Context

`packages/workflow-runtime/src/engine.ts` threw on one action kind — `spawn_child_workflow` — and had
since Phase 2. CLAUDE.md recorded it as "the only genuine stub in the TypeScript": a workflow definition
could declare the action, `validateWorkflowDefinition` would accept it, and the instance would fail at
run time on entering the state that used it.

It was the last one, which is its own reason to close it: a single known stub is a thing every reader has
to remember, and a reader who does not remember ships a definition that cannot run.

## Decision

Implement it. The action resolves a child definition, appends `child_workflow_spawned`, and starts the
child as a first-class instance in the same tenant. Four rules were not obvious and are where the
decision actually lives.

**Lineage depth is capped at 8, checked by walking the parent chain.** A definition that spawns back
into its own lineage — directly or through three intermediaries — is a loop that would otherwise
exhaust the process rather than fail a workflow, and a recursion guard on the *definition* would not
catch mutual recursion between two definitions. Walking the lineage costs one lookup per ancestor and
catches every shape.

**An unversioned reference picks the highest published version**, compared numerically by
`compareDefinitionVersions` rather than lexically — `"10.0.0"` sorts above `"9.0.0"`, which string
comparison gets backwards. Drafts are not candidates: a parent must not start a child from a definition
nobody published.

**A child that reaches a terminal status during its own start is handled**, which is the common case for
a short child whose initial state is terminal. The parent's projection has to see the completion it
already caused, so the spawn and the child's own transitions are appended before the parent's loop
continues to quiescence.

**The registry is snapshotted before delivering a signal.** Delivering a signal can run a
`spawn_child_workflow` action, which registers the child mid-loop; iterating the live map would then
deliver the same signal to an instance that did not exist when it was submitted — a signal arriving at a
workflow that had not been spawned when it was sent.

## Alternatives considered

- **Option A: remove `spawn_child_workflow` from the action vocabulary.**
  - **Pros:** no stub, no implementation; the contract would stop promising something.
  - **Cons:** it is a saga primitive the compensation planner is designed around, and removing a
    published action kind is a breaking contract change.
  - **Why not:** the feature is wanted; it was merely unfinished.

- **Option B: reject it in `validateWorkflowDefinition` instead, so it fails early.**
  - **Pros:** a definition using it would be refused at authoring time rather than at run time.
  - **Cons:** turns a run-time stub into a design-time wall, which is worse for anyone who has already
    modelled a parent/child workflow, and still leaves the feature unbuilt.
  - **Why not:** strictly less useful than implementing it.

- **Option C: no depth cap, relying on definition review to catch loops.**
  - **Pros:** no limit to explain; no lineage walk per spawn.
  - **Cons:** a mutually recursive pair passes any single-definition review, and the failure mode is the
    worker process rather than the workflow instance.
  - **Why not:** a workflow engine must fail the workflow, never the worker.

- **Option D: pick the *lowest* or the lexically greatest version when unversioned.** Rejected for the
  reason above — lexical comparison orders `"10.0.0"` below `"9.0.0"`, so an engine doing the obvious
  thing silently runs an old definition after the tenth release.

## Consequences

- **Positive:** no stub remains in the TypeScript. Parent/child workflows and the saga patterns built on
  them run.
- **Negative:** a depth limit is a number that will eventually be wrong for someone. 8 is deep enough
  that a legitimate hierarchy does not reach it and shallow enough that a loop fails fast; the error
  names the definition that closed the lineage, so the diagnosis is not a search.
- **Neutral:** the version-resolution rule is now load-bearing for anyone referencing a definition
  without a version, which is the convenient form and therefore the common one.
- **Reversibility:** the implementation replaces a throw. Reverting restores the stub.

## Implementation notes

- `packages/workflow-runtime/src/engine.ts` — `applySpawnChildWorkflow`, `resolveChildDefinition`,
  `lineageDepth`, `compareDefinitionVersions`, `MAX_CHILD_WORKFLOW_DEPTH`.
- Failures raise `WorkflowActionError` with a `failure` discriminant, so a missing parameter, an
  unresolvable definition and an exceeded depth are distinguishable by a caller rather than by message
  text.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Should a parent be able to await its children, beyond observing their events? The compensation planner reads the lineage but there is no explicit join. | amoufaq5 | _unscheduled_ |
| `MAX_CHILD_WORKFLOW_DEPTH` is a constant, not per-tenant configuration. | amoufaq5 | _unscheduled_ |

## References

- ADR-0077 (Phase 3 plan).
