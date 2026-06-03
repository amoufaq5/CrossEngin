# ADR-0094: many_to_many join tables in the column store (Phase 3 P1.14)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0093 (delete semantics), ADR-0092 (column-store FKs), ADR-0090 (column-mapped store), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.14), the relational follow-up
> ADR-0093 named.

## Context

ADR-0093 completed the FK story for `many_to_one` references but left
`many_to_many` as the open relational gap: a `many_to_many` `Relation`
(`{ left, right }`) has no FK-bearing column on either entity — it needs a
**join table**. Without it the column store can't represent associations
(student↔course, role↔permission), so the typed store didn't fully model the
manifest's relational intent.

## Decision

Changes confined to `@crossengin/operate-runtime-pg`; the `EntityStore` contract
is unchanged. (This increment provisions the join-table **schema**; CRUD over
association rows is a separate future API.)

- **`column-plan.ts`** — `joinTablePlansForManifest(manifest, { schema })`
  derives a `JoinTablePlan` per `many_to_many` relation: the table is
  `<left>_<right>` (snake), with `<left>_id` / `<right>_id` link columns. A
  **self**-relation (`left === right`) disambiguates to `<table>_left_id` /
  `<table>_right_id`. Duplicate table names (a relation declared twice) emit
  once.
- **`entity-ddl.ts`**
  - The composite-FK DROP/ADD pair is factored into a shared `compositeFkStmts`
    helper (used by both entity FKs and join-table FKs).
  - `emitJoinTableDdl(plan, knownEntities)` emits a tenant-scoped link table:
    `(tenant_id, <left>_id, <right>_id)` **composite PK** (no duplicate links per
    tenant) + a `created_at`, RLS with the standard tenant-isolation policy, and
    a **composite `ON DELETE CASCADE` FK** from each side to its entity's
    `(tenant_id, id)` — so deleting either linked row removes the association
    (no dangling links). A side absent from `knownEntities` skips its FK (the
    table is still created).
- **`column-store.ts`** — the constructor builds the join plans;
  `ensureSchema` adds a **third phase** after entity tables (phase 1) and entity
  FKs (phase 2): create the join tables (their FKs reference entity tables, which
  now exist).

## Cross-cutting invariants enforced (by tests)

- **The association is a tenant-scoped table.** `Course`↔`Student` →
  `course_student (tenant_id, course_id, student_id)` PK + RLS; the composite PK
  prevents duplicate links within a tenant.
- **Same-tenant, cascade-cleaned links.** Each side is a composite FK
  `(tenant_id, <side>_id) → side (tenant_id, id) ON DELETE CASCADE` — a link can
  only join rows of the **same tenant**, and deleting either row removes the
  link.
- **Self-relations don't collide.** `Person`↔`Person` →
  `person (person_left_id, person_right_id)` columns, not a duplicate
  `person_id`.
- **Created after the entity tables.** `ensureSchema` creates `course` /
  `student` before `course_student`, so the join FKs resolve; a side not modeled
  as a table emits no FK.

## Alternatives considered

- **Add a JSONB array column on one side instead of a join table.**
  - **Decision.** No — a real link table is the relational representation,
    queryable + integrity-checked + RLS-scoped. A JSONB array can't FK or enforce
    uniqueness.
- **`ON DELETE RESTRICT` on the join FKs.**
  - **Decision.** No — `CASCADE` is the standard m2m semantic: a link is
    meaningless once either endpoint is gone, so it should be removed, not block
    the delete. (The *entity* FKs keep their per-relation policy from ADR-0093;
    only the join↔entity links cascade.)
- **Sort `left`/`right` alphabetically for a canonical table name.**
  - **Decision.** No — preserve the manifest's declared order (`<left>_<right>`)
    so the table name is predictable from the declaration; duplicate-name
    dedup handles a relation declared twice.
- **CRUD over association rows in this increment.**
  - **Decision.** Deferred — provisioning the schema is the coherent unit; a
    link/unlink API (and whether it rides `EntityStore` or a sibling) is a
    separate decision.

## Consequences

- **59 packages + 2 apps, 123 meta-schema tables, 6,328 tests** (was 6,321;
  +7, 0 new packages/tables). ADR-0093's open relational follow-up is closed:
  the column store now provisions `many_to_many` join tables, completing its
  model of the manifest's relations (1:N references **and** M:N associations).
- **The typed store is relationally complete (schema-wise).** Typed columns
  (P1.10) + PHI encryption (P1.11) + composite FKs (P1.12) + per-relation delete
  (P1.13) + join tables (P1.14) — a manifest's entities and relations become a
  genuine, tenant-scoped relational schema, all behind one `EntityStore` /
  `ensureSchema`.
- **A link/unlink API over association rows remains the open follow-up**, behind
  the existing plan/DDL seams.
