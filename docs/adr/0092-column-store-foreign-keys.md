# ADR-0092: foreign keys + topological apply order in the column store (Phase 3 P1.12)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0090 (column-mapped store), ADR-0091 (transparent encryption), ADR-0002 (multi-tenancy), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.12), an ADR-0090 follow-up.

## Context

ADR-0090 mapped manifest reference fields to `<name>_id` columns but emitted no
foreign keys, listing "FKs on reference columns with topological table-creation
order" as the follow-up. Without FKs the typed store can't enforce referential
integrity, and reference columns were typed `UUID` while the rows they point at
use a **TEXT** `id` (ADR-0090's cross-store-parity decision) — so a FK couldn't
even type-check. This increment fixes the type and adds **composite,
tenant-scoped** foreign keys, applied in an order (and phasing) that handles
dependencies and cycles.

## Decision

Changes confined to `@crossengin/operate-runtime-pg`; the `EntityStore` contract
is unchanged.

- **`column-plan.ts`**
  - A reference field's column is now typed **`TEXT`** (matching the target's
    TEXT `id`), and the mapping records its `referenceTarget` (the target entity
    name).
  - `referencedEntities(plan)` lists a plan's distinct targets.
  - `topologicalEntityOrder(plans)` — Kahn's algorithm over the reference graph,
    returning entity names with a referenced entity **before** the one that
    references it; targets absent from the set are ignored, and a reference
    cycle leaves its nodes appended in insertion order (still safe — see below).
- **`entity-ddl.ts`** — `emitForeignKeyDdl(plan, knownEntities)` emits, per
  reference column, an idempotent **composite** FK:
  `FOREIGN KEY (tenant_id, <ref>_id) REFERENCES <target> (tenant_id, id) ON
  DELETE RESTRICT` (`DROP CONSTRAINT IF EXISTS` → `ADD CONSTRAINT`). A target not
  in `knownEntities` is skipped. The CREATE TABLE itself stays FK-free.
- **`column-store.ts` `ensureSchema`** — now **two-phase**: create *all* tables
  in topological order (a referenced table before its referencer), then add
  *all* foreign keys once every target exists.

## Cross-cutting invariants enforced (by tests)

- **Composite, same-tenant FKs.** The FK is `(tenant_id, <ref>_id) → target
  (tenant_id, id)` — because the PK is `(tenant_id, id)`, a reference can only
  resolve to a row in the **same tenant**; cross-tenant references are
  structurally impossible, reinforcing RLS.
- **Type-correct.** Reference columns are `TEXT`, matching the `TEXT id` they
  point at, so the FK type-checks (the latent UUID-vs-TEXT mismatch is fixed).
- **Dependency-ordered creation.** `topologicalEntityOrder` puts `Account`
  before `Order` before `OrderLine`; `ensureSchema` creates the referenced table
  first, then adds the FK after both tables exist.
- **Cycle-safe.** A reference cycle (A↔B) still applies: tables are all created
  first, FKs added in a second pass — `topologicalEntityOrder` returns every
  node even under a cycle.
- **Idempotent + scoped.** `DROP CONSTRAINT IF EXISTS` → `ADD CONSTRAINT` re-runs
  cleanly; a reference to an entity not modeled as a table emits no FK.

## Alternatives considered

- **Single-tenant FK on `<ref>_id` alone (add `UNIQUE(id)`).**
  - **Decision.** No — a global `UNIQUE(id)` would let a reference point across
    tenants at the constraint level (RLS would still hide reads, but the integrity
    guarantee would be wrong). The composite `(tenant_id, id)` FK matches the PK
    and is the correct multi-tenant shape.
- **Inline FKs in `CREATE TABLE`, relying on topological order.**
  - **Decision.** No — inline FKs require a strict acyclic creation order and
    break on reference cycles. Creating all tables first and adding FKs in a
    second pass is cycle-proof; the topological order is still used for
    deterministic, dependency-first table creation.
- **Keep reference columns `UUID`.**
  - **Decision.** No — the store's ids are TEXT (cross-store parity, ADR-0090);
    a UUID reference column couldn't FK to a TEXT id. TEXT is the consistent
    choice. (A pack that wants UUID ids end-to-end is a separate future option.)
- **`ON DELETE CASCADE` / `SET NULL`.**
  - **Decision.** `RESTRICT` (the kernel's reference default) — deleting a
    referenced row is blocked rather than silently cascading tenant data.
    Per-relation delete behavior from the manifest is a later refinement.

## Consequences

- **59 packages + 2 apps, 123 meta-schema tables, 6,315 tests** (was 6,307;
  +8, 0 new packages/tables). ADR-0090's FK follow-up is delivered: the column
  store enforces referential integrity with tenant-scoped composite FKs,
  provisioned in a cycle-safe two-phase `ensureSchema`.
- **The typed store is closer to a real schema.** Typed columns (P1.10),
  transparent PHI encryption (P1.11), and now FKs + ordered DDL (P1.12) — the
  column-mapped store models a manifest's entities as a genuine relational
  schema, all behind the one `EntityStore` contract.
- **Per-relation delete semantics + UUID-id packs remain optional refinements**
  behind the existing plan/DDL seams.
