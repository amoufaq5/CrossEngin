# ADR-0204: P3 relational closeout — association counts, `isLinked`, link integrity, richer detail UX (Phase 3 P3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-10 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0203 (JSONB-store associations), ADR-0202 (association write UI), ADR-0201 (m2m read), ADR-0200 (1:N related records), ADR-0095 (store link/unlink), ADR-0080 (renderer), ADR-0077 (P3) |

## Context

ADR-0200 → ADR-0203 built the manifest's full relational model into the serving runtime and the
renderer: 1:N reverse children, M:N association read + write, and (0203) associations on the default
JSONB store. Three gaps remained to round out P3's relational surface: (1) no way to get a relation's
count without paging every record; (2) no `isLinked` predicate on the JSONB store (the column store
had one); (3) no way to reason about links whose endpoints were deleted (the JSONB link table has no
cascading FK — 0203 flagged this as a follow-up); and (4) the detail-view relation panels showed no
counts and swallowed link/unlink errors silently. This ADR closes all four. The disjoint server pieces
were built in parallel by two background agents (`operate-runtime` count routes; `operate-runtime-pg`
store methods + integrity planner), then integrated with the renderer changes.

## Decision

- **Association count route** (`operate-runtime`, `association.ts` + `compile.ts`). A new
  `AssociationCounter` structural seam (`countLinks(tenantId, leftEntity, rightEntity, {leftId?,
  rightId?}) → number`) + `isAssociationCounter` guard, mirroring the read/write seams.
  `manifestAssociationCountRoutes` derives `GET /v1/<owner>/{id}/<related>/count` per m2m direction
  (self-relation → one route; de-duped by operationId), `buildAssociationCountHandler` RBAC-checks
  `list` on the *related* entity (same gate as the read side), narrows to the owner side, and returns
  `{count}`. `501 associations_unsupported` when the store can't count. Registered in
  `compileOperateServer` alongside the list + write routes.
- **`countLinks` on both stores** (`operate-runtime-pg`). `PostgresEntityStore` (JSONB) counts over the
  generic `operate_entity_links` table with optional side-narrowing; `ColumnMappedEntityStore` counts
  over the per-relation join table. Both `withTenantContext`-wrapped (RLS-scoped). `PostgresEntityStore`
  now also has **`isLinked`** (reaching parity with the column store) and explicitly declares
  `implements … AssociationCounter`.
- **Pure link-integrity planner** (`operate-runtime-pg`, `link-integrity.ts`). `planLinkPrune({links,
  existingLeftIds, existingRightIds}) → {keep, drop}` classifies a link as dangling when either endpoint
  id is absent from the known-existing sets; `danglingLinkCount` is the convenience count. Pure — no DB
  access: it operates on an already-fetched link set + the caller's known-existing id sets, so execution
  (the actual prune, and *how* endpoint existence is determined) stays a caller concern. This is the
  reasoning half of the 0203 "no cascading FK" follow-up; a scheduled sweep that wires it to real
  reads/deletes is the remaining half.
- **Richer detail-view relation panels** (`operate-web`). Both the 1:N (`RelatedRecords`) and M:N
  (`AssociatedRecords`) panels now show a **count badge** — the 1:N panel renders `N+` when a page
  cursor signals more rows than the previewed page, the M:N panel the exact loaded count. Link / unlink
  failures, previously swallowed, now surface **inline** under the panel; unlink is **optimistic** (the
  row disappears immediately and is restored if the server rejects it).

## Consequences

- A client can read a relation's size cheaply (`…/count`) instead of paging all links — useful for
  list-view badges and large associations, on either store. The endpoint is a first-class capability
  even though the current detail panels derive their badge from already-loaded data.
- The JSONB store reaches feature parity with the column store for the association predicate surface
  (`link`/`unlink`/`isLinked`/`listLinks`/`countLinks`); the two stores remain interchangeable behind
  the structural seams, so the runtime is oblivious to which is mounted.
- Dangling links are now *reasoned about* by a tested pure function; actually pruning them (a periodic
  job) stays a follow-up, consistent with the schemaless JSONB posture that permits them in the first
  place.
- The detail view communicates relation size and write outcomes honestly — no more silent link/unlink
  failures.
- 7,056 tests pass (+19: association-count route derivation both directions + self-relation + de-dupe,
  `isAssociationCounter`, count handler 401/403/501/200; `isLinked` + `countLinks` on both stores;
  `planLinkPrune` / `danglingLinkCount`). `operate-web` verified by strict `tsc`. Full build + typecheck
  green. Two disjoint server packages were authored concurrently by background agents against a pinned
  `countLinks` contract, then integrated.
- Follow-ups: a scheduled dangling-link prune sweep wiring `planLinkPrune` to real reads/deletes;
  count-badge on the entity list view; server-side pagination of related/association panels; a column
  chooser / per-column filter UI.
