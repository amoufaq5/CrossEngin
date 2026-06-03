# ADR-0095: association link/unlink API over join tables (Phase 3 P1.15)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0094 (m2m join tables), ADR-0090 (column-mapped store), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.15), closing ADR-0094's
> follow-up.

## Context

ADR-0094 provisioned `many_to_many` join tables but stopped at the schema — it
named "a link/unlink API over the association rows" as the open follow-up.
Without it, an application can model associations but can't *manage* them
(enroll a student in a course, grant a role a permission) through the store.
This increment adds that API to `ColumnMappedEntityStore`, over the join tables
ADR-0094 already creates.

## Decision

Four methods on `ColumnMappedEntityStore` (not part of the `EntityStore`
interface — they're column-store-specific, like the JSONB store's `count`),
each keyed by the relation's `(leftEntity, rightEntity)` and wrapped in
`withTenantContext` (RLS):

- **`link(tenant, left, right, leftId, rightId)`** — `INSERT … ON CONFLICT DO
  NOTHING`, so a repeated link is a no-op. The composite FK (ADR-0094) enforces
  that both ids exist **in the same tenant** — a dangling id raises.
- **`unlink(tenant, left, right, leftId, rightId)`** — `DELETE …`, returns
  whether a link existed.
- **`isLinked(tenant, left, right, leftId, rightId)`** — `SELECT 1 … LIMIT 1`.
- **`listLinks(tenant, left, right, { leftId?, rightId? })`** — returns
  `{ leftId, rightId }` pairs, optionally narrowed to one side (all rights for a
  left, or all lefts for a right), ordered by `created_at`.

The relation is resolved through a `joinPlanFor(left, right)` lookup over the
join plans the store already builds; an unknown pair raises.

## Cross-cutting invariants enforced (by tests)

- **Idempotent links.** `link` emits `ON CONFLICT DO NOTHING`, so enrolling
  twice is harmless; params are `[tenant, leftId, rightId]` against the
  `<left>_<right>` table.
- **Tenant-scoped + RLS.** Every method runs in `withTenantContext`; the join
  table's RLS + composite FK confine links to the caller's tenant.
- **Directional queries.** `listLinks({ leftId })` filters `"<left>_id" = $2`
  and maps rows to `{ leftId, rightId }`; `unlink` / `isLinked` bind both ids.
- **Unknown relation raises.** `joinPlanFor` throws for a pair with no
  `many_to_many` relation, so a typo can't silently no-op.

## Alternatives considered

- **Put link/unlink on the `EntityStore` interface.**
  - **Decision.** No — associations aren't entities, and the JSONB store has no
    join tables. These are `ColumnMappedEntityStore` methods, parallel to the
    JSONB store's `count`.
- **Expose links as a synthetic entity (CRUD over the join table).**
  - **Decision.** No — a 4-method association API (`link`/`unlink`/`isLinked`/
    `listLinks`) is the natural vocabulary; forcing it through entity CRUD would
    invent a synthetic id and obscure the `(leftId, rightId)` key.
- **`upsert` semantics that error on a duplicate link.**
  - **Decision.** No — idempotent `ON CONFLICT DO NOTHING` matches how callers
    use associations (ensure-linked), and avoids a read-before-write race.
- **Surface links over HTTP in `operate-server` now.**
  - **Decision.** Deferred — the store API is the unit here; manifest-derived
    association *routes* (e.g. `POST /v1/courses/{id}/students/{id}`) are a
    `operate-runtime` concern for a later increment.

## Consequences

- **59 packages + 2 apps, 123 meta-schema tables, 6,333 tests** (was 6,328;
  +5, 0 new packages/tables). ADR-0094's follow-up is closed: the column store
  now both **provisions** join tables and **manages** the association rows.
- **The typed store is relationally complete** — entities (P1.10), PHI
  encryption (P1.11), references + FKs (P1.12), per-relation delete (P1.13),
  m2m join tables (P1.14), and now link/unlink over them (P1.15) — a manifest's
  full relational model, readable and writable, behind one store.
- **Manifest-derived association routes (HTTP) remain the open follow-up**,
  behind the existing store API.
