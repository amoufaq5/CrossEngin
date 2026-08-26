# ADR-0281: A pack may not silently replace what it inherits (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-26 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0004 (manifest specification), ADR-0212 (vertical packs), ADR-0267 (AI onboarding) |

## Context

Rewriting the package map for CLAUDE.md turned up an unresolved question: `pack-erp-construction`
declares `Project` and `WorkOrder`, both of which `pack-erp-core` already defines. Following it up
found a defect with two independent halves.

`resolveManifest` merged entities through a keyed map, so a child pack reusing an inherited entity
name **silently replaced** the parent's version. Construction's 7-field subcontractor `WorkOrder`
wholly replaced core's 9-field manufacturing one; retail's till-order `SalesOrder` replaced core's
sales-cycle one. Core's relations survived the merge and now bound columns that no longer existed.

And `validateManifest` never checked them: it verified that a relation's `from` and `to` entities
exist, but never that a `many_to_one`'s `field` exists on its `from` entity. So the breakage was
invisible. Three of seven packs shipped manifests in this state, and each asserted in its own tests
that validation passed.

That second half is not pack-specific. **An AI-generated manifest can declare a relation on a
column that was never created**, pass validation, be approved by a reviewer, be activated, and fail
at FK emit — which is precisely the class of error validation exists to catch.

## Decision

- **`validateManifest` checks the field.** A `many_to_one` relation's `field` must exist on its
  `from` entity. Only `many_to_one` binds a FK-bearing column there — a `one_to_many`'s `field`
  names the inverse collection and corresponds to no column anywhere, and `many_to_many` has no
  field at all. The check is written to exactly that shape rather than to all three kinds.
- **Overriding an inherited entity must be declared.** `Entity` gains an optional
  `overrides: boolean`. Resolution refuses an undeclared collision with
  `UndeclaredEntityOverrideError`; a replacement that says `overrides: true` is accepted and takes
  responsibility for the difference.
- **The marker is required only of the local manifest, not between parents.** A collision between
  two independently-authored parents is the *child's* ambiguity, created by choosing to extend
  both; neither parent could sensibly declare it is overriding the other. Parent-over-parent stays
  last-wins.
- **Resolution prunes what a replacement can no longer support.** When an entity is overridden, any
  inherited `many_to_one` whose `field` the replacement dropped is removed, rather than left to
  fail at FK emit. A `one_to_many` survives — its field names no column.

## Consequences

- **Three packs were shipping broken manifests**, now fixed by declaring the override and letting
  resolution prune: `erp-retail` (−2: `SalesOrder.account_id`, `SalesOrder.quote_id`),
  `erp-grocery` (−2, inherited through retail — the three-level lineage), `erp-construction`
  (−4: `WorkOrder.item_id`, `WorkOrder.bom_id`, `WorkOrder.warehouse_id`, `Project.manager_id`).
  Each pack's relation-count assertion now carries the arithmetic and the reason.
- A construction tenant no longer gets core's manufacturing `WorkOrder`, and a retail tenant no
  longer gets core's sales-cycle `SalesOrder`. That was already true — the override was already
  happening. What changed is that it is now declared, and the relations it invalidates are removed
  rather than left dangling.
- The AI Architect's output is now checked for this class of error before a reviewer ever sees it.
- One kernel test that asserted silent override was updated to declare it; two more were added for
  the refusal and the pruning. The pack fixtures that asserted a broken manifest validates were
  fixed rather than relaxed.
- +9 tests (kernel **592**; workspace **9,276**). Full workspace build + typecheck + test green.
- Follow-ups: `validateManifest` still throws on the first error rather than collecting them, so an
  inventory needs a separate pass — this investigation needed a standalone script to see all eight
  breakages at once. The same field-existence reasoning would apply to permissions and view columns
  that name fields, which are still unchecked.
