# ADR-0282: One answer to "does this entity have that field?" (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-26 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0281 (relation field validation), ADR-0004 (manifest specification), ADR-0267 (AI onboarding) |

## Context

ADR-0281 made `validateManifest` check that a `many_to_one` relation's `field` exists, and closed
by naming the obvious next gap: "the same field-existence reasoning would apply to permissions and
view columns that name fields, which are still unchecked."

Following that up found the gap was not where the note put it. **`manifest.permissions` is already
fully checked** — entity, per-operation roles, transitions, and per-field grants all resolve. The
hole is entirely in `manifest.views`, and it is wider than columns.

`validateViews` resolved a view's entity, its report, dashboard and view references, and its
workflow transitions. It resolved **none of the field paths**, in any of the eight view kinds: list
columns, sorts, filters and column groups; record sections; form steps; kanban state and card
fields; calendar date fields; map geo fields and layer filters. It also never checked the role list
of a view's own `permissions` override, nor the workflow state each kanban column pins itself to —
even though the sibling `allowedTransitions` on the same view *was* checked.

An inventory across all seven packs found **846 field references and zero breakages**, so nothing
was shipping broken. But every pack ships only `list` views with `inherit` permissions, which is
why this went unnoticed: seven of the eight view kinds have no coverage from any pack at all. The
exposure is the AI Architect, which can author any of them. A view naming a field that does not
exist renders an empty cell and silently drops the filter — the view still "works", so nothing
fails loudly enough to be found.

Three checks against the same question also disagreed about what a field *is*. `validatePermissions`
resolved entity fields plus trait fields; `validateSearch` resolved entity fields only, so indexing
`created_at` on an `auditable` entity was **wrongly rejected**; ADR-0281's relation check resolved
entity fields only as well. None of them counted the implicit `id` primary key that
`emitCreateTable` always emits.

## Decision

- **One resolver, `resolvedFieldNames(entity, customTraits)`**, is the single answer to whether an
  entity has a field: the implicit `id`, the entity's own fields, and whatever its traits
  contribute. Relations, permissions, views and search all now ask it, so they cannot disagree.
  It is computed once per manifest, after trait existence is verified and before anything consults
  it.
- **It tolerates what is not its question.** An unresolvable trait is ignored rather than throwing —
  trait existence is checked earlier, and a second, less useful error there would mask the first.
  A name supplied by two traits at once is still an existing name; the collision is
  `emitCreateTable`'s error to raise, not an existence check's.
- **`id` counts as a field.** It is a real emitted column that the column-mapped store selects, and
  a view or grant that names it is a reasonable thing to write. This *relaxes* the pre-existing
  permissions check, which rejected `permissions.X.fields.id`. Rejecting a valid manifest is the
  worse failure of the two, and permitting a grant that is currently inert is the cheaper one.
- **Views resolve every field path they name**, across all eight kinds, via a new
  `viewReferencedFields` in the `views` package — the same seam as the existing
  `viewReferencedReports`/`Dashboards`/`Views`/`Workflows`. Each reference carries where it appeared,
  so the error names `views.v.columnGroups[0].columns[1].field` rather than just the view.
- **Only the first segment of a dotted path is resolved.** `account_id.name` traverses a reference;
  what lies past the dot belongs to the target entity and is not this entity's to have. That is the
  rule `validateSearch` already used, now applied uniformly.
- **A view's own permission override is checked against `manifest.roles`**, as every other grant in
  the manifest already was, and **a kanban column's state** against the entity's declared workflow
  states, as its sibling `allowedTransitions` already was.
- **The helpers read every array defensively.** `validateManifest` runs against hand-built manifests
  where schema defaults like `filters: []` were never applied, so a check that assumes the parsed
  shape crashes with a `TypeError` instead of validating.

## Consequences

- **No pack changed.** All 846 field references across the seven packs already resolved, and all
  seven still validate. This is the first of these validation increments that caught nothing
  retroactively — the value is entirely forward, on manifests the Architect writes.
- Search can now index or facet a trait-supplied field. That was a live false positive: nothing
  exercised it because no pack ships a `search` section.
- **Verified live.** Against a throwaway Postgres cluster and the real `crossengin` CLI, a clinic
  manifest with a kanban board was rejected three ways with exit 1 and the precise path — an unknown
  `cardFields[1]`, a column pinned to an undeclared state, and a grant to an undeclared role — while
  the correct manifest validated, applied its 837 meta-schema statements, booted the real
  `operate-server` on the column-mapped store, and round-tripped a record (`201`, then listed).
  `information_schema` confirms the accepted names are real columns: the emitted table carries
  `id`, `reason`, `status`, `created_at`, `updated_at`.
- +43 tests (kernel **622**, views **91**; workspace **9,318**). Full workspace build + typecheck +
  test green.
- Follow-ups: the two DDL emitters disagree about trait fields. `kernel`'s `emitCreateTable` emits
  all of them, but `operate-runtime-pg`'s `entity-ddl` emits a fixed housekeeping set
  (`tenant_id`, `id`, `created_at`, `updated_at`) and expands no traits, so `created_by` resolves
  for validation and has no column in a served table. This resolver follows the kernel, which is
  the manifest compiler's own answer and the one permissions already used; reconciling the two
  emitters is the real fix and is untouched here.
- A record view's `related[].relation` still resolves to nothing — relations have no name to
  resolve against, so checking it would need a naming scheme that does not exist yet.
- `validateManifest` still throws on the first error rather than collecting them (ADR-0281), so the
  inventory behind this ADR again needed a standalone script to see the whole surface at once.
