# ADR-0203: Association support on the JSONB entity store (Phase 3 P3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0202 (association write UI), ADR-0201 (m2m related lists — read), ADR-0095 (column-store link/unlink API), ADR-0086 (JSONB `PostgresEntityStore`), ADR-0077 (P3) |

## Context

The `many_to_many` association API — read (ADR-0201) + write (ADR-0202) — only worked on the
column-mapped store (`--store pg-columns`), whose per-relation join tables satisfy the structural
`AssociationReader` / `AssociationWriter` seams. The default JSONB document store (`--store pg`, the
`PostgresEntityStore` over `meta.operate_entity_records`) implemented neither, so association routes
returned `501 associations_unsupported` and the renderer's association panel stayed hidden. The
column store models a manifest's relations as typed DDL; the JSONB store deliberately does not — it
keeps one generic document table. To bring associations to it we need a store-agnostic link home that
does not require per-relation DDL.

## Decision

- **One generic tenant-scoped link table** (`meta.operate_entity_links`, kernel meta-schema, table
  #127). Columns: `id`, `tenant_id` (→ tenant FK, RLS), `left_entity` / `right_entity` (identifier-
  checked TEXT), `left_id` / `right_id` (TEXT, 1–200 chars), `created_at`. A unique constraint on
  `(tenant_id, left_entity, right_entity, left_id, right_id)` makes `link` idempotent; two partial
  indexes (`…_left`, `…_right`) serve narrowing by either side. RLS
  (`operate_entity_links_tenant_isolation`) confines every row to the caller's tenant — the same
  posture as `operate_entity_records`. Unlike the column store's per-relation join tables, a single
  table carries every relation's links, discriminated by `(left_entity, right_entity)`.
- **`PostgresEntityStore` now implements `AssociationReader` + `AssociationWriter`** — `link`
  (`INSERT … ON CONFLICT DO NOTHING`), `unlink` (`DELETE … RETURNING` row count), `listLinks`
  (`SELECT` narrowed by optional `leftId` / `rightId`), each wrapped in `withTenantContext` so the RLS
  policy — not just a `WHERE tenant_id` clause — scopes the query. The `(leftEntity, rightEntity)`
  pair always arrives in the relation's canonical order (the handler passes `spec.left` / `spec.right`
  consistently for read and write), so no per-store canonicalization is needed. The links table name
  is `<schema>.operate_entity_links` with `schema` the same validated identifier as the records table.
- **Zero wiring change.** The association handlers already test `isAssociationReader` / `is­Association­
  Writer` at runtime and register their routes in `compileOperateServer` unconditionally. Because
  `PostgresEntityStore` now satisfies both, `--store pg` serves the association read + write routes and
  the renderer panel becomes visible/editable with no server-composition change.

## Consequences

- Associations work on the **default** serving store, not just `--store pg-columns`. A deployment that
  keeps the schema-flexible JSONB document model gets the manifest's full relational model — 1:N
  (ADR-0200) and now M:N read + write — end-to-end.
- The two stores model links differently by design: the column store uses typed per-relation join
  tables with composite FKs (referential integrity enforced by the database); the JSONB store uses one
  generic link table with a uniqueness constraint and no FK to the document rows (consistent with its
  schemaless posture — a dangling link is possible but tenant-confined). Both satisfy the identical
  structural seam, so the runtime is oblivious to which is mounted.
- 7,037 tests pass (+5: link idempotency + round-trip; `listLinks` narrowing by left and by right;
  unlink existence reporting; tenant isolation; custom-schema table targeting). Meta-schema table count
  126 → 127. Full build + typecheck + test green.
- Follow-ups: an `isLinked` helper on the JSONB store (the column store has one); a periodic sweep to
  prune links whose endpoints were deleted (the JSONB store has no cascading FK); bulk link.
