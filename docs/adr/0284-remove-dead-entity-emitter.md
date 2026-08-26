# ADR-0284: Deleting the kernel's entity emitter (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-26 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0283 (emitter reconciliation), ADR-0003 (meta-schema and dynamic entity engine), ADR-0004 (manifest specification) |

## Context

ADR-0283 established that `ColumnMappedEntityStore` owns entity DDL and left one follow-up
open: the kernel's own entity emitter is dead code that would emit an untenanted table.

`emitCreateTable` → `emitEntity` → `emitManifestCreate` / `emitManifestDiff` /
`applyManifest` had no caller outside kernel tests. `crossengin apply` emits the meta-schema
bootstrap; `operate-server` builds tables from `operate-runtime-pg`. Nothing else reached
them.

Being unused is not by itself a reason to delete code. The reason is what it would do if
used: it emits `id UUID PRIMARY KEY` with **no `tenant_id`, no composite key and no RLS
policy** — a single-tenant shape predating the tenancy model. Every other table in the
system is confined by `tenant_id = current_setting('app.current_tenant_id', true)::UUID`.
A future caller reaching for the obviously-named `applyManifest` would get tables with no
tenant isolation at all, and the code gives no hint that it is stale. It is a tenancy breach
waiting for a caller.

## Decision

- **Delete the emitter and everything that existed only to serve it.** `ddl/emit.ts` and
  `manifest/emit.ts` in full; `emitDiff`, `diffAndEmit` and `DiffEmitContext` from
  `ddl/diff.ts`; `emitColumn`, `EmitColumnOptions` and the orphaned `emitRangeCheck` from
  `ddl/column.ts`.
- **Keep what analyses rather than emits.** `computeEntityDiff` and its types stay —
  `computeManifestDiff` builds on them, and the CLI, `ai-architect` and `operate-server`'s
  design-review diff all build on that. `expandTraits`, `checkEntityFieldNames`,
  `buildColumnNameMap` and `computeResolvedIndexes` stay because `computeEntityDiff` calls
  them. `columnNameForField` and `emitDefault` stay because the serving store calls them.
- **Keep `topologicalSort`.** It is now unused, and it is the one deletion candidate this
  ADR declines. It is a general manifest utility with independent meaning and full test
  coverage, it is not emitter machinery, and `operate-runtime-pg` carries a near-duplicate
  (`topologicalEntityOrder`) that should be reconciled *toward* it. Deleting it would
  foreclose that. Unlike the emitter it is correct and harmless — the distinction that
  drives this ADR is not "unused" but "unused *and* would breach tenancy if used".
- **Fix the documentation rather than leave it describing removed API.** The kernel README's
  DDL section now describes the vocabulary the module actually exports and says plainly that
  the serving store owns entity DDL.

## Consequences

- **Public API removal.** `emitCreateTable`, `emitIndexes`, `emitColumnComments`,
  `emitEntity`, `EmitContext`, `emitManifestCreate`, `emitManifestDiff`, `applyManifest`,
  `EmitManifestContext`, `emitDiff`, `diffAndEmit`, `DiffEmitContext`, `emitColumn` and
  `EmitColumnOptions` are gone from `@crossengin/kernel`. No in-repo consumer existed; an
  out-of-repo one would break, which is the point.
- **−59 tests** (kernel **627 → 568**). That is coverage of deleted behaviour, not lost
  coverage: what the deleted code did is now done by `operate-runtime-pg`'s `entity-ddl`,
  which ADR-0283 covered. The one piece of live behaviour those tests reached — default
  rendering, still exported as `emitDefault` for the store — was rewritten against
  `emitDefault` directly rather than dropped, and gained cases the old tests lacked
  (jsonb literals, sequence defaults, non-finite numbers).
- Four READMEs (`kernel`, `compliance`, `ai-architect`) and two stale source comments no
  longer describe API that does not exist. A `testing` fixture pointed at
  `packages/kernel/src/ddl/emit.test.ts`, a file that no longer exists; it now points at a
  real one.
- **The kernel no longer emits tenant DDL at all.** Its `bootstrap/` half still emits the
  139 platform meta-schema tables — that is a different emitter with a different job, and it
  is untouched. `@crossengin/kernel/ddl` is now purely the vocabulary the serving store
  works from.
- Full workspace build + typecheck + test green.
- Follow-up: `topologicalSort` (kernel) and `topologicalEntityOrder` (operate-runtime-pg)
  compute the same entity dependency order by different routes. Reconciling them is the
  remaining duplication in this area, and the kernel's is the better home.
