# ADR-0093: per-relation delete semantics in the column store (Phase 3 P1.13)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0092 (column-store foreign keys), ADR-0090 (column-mapped store), ADR-0004 (manifest spec), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.13), an ADR-0092 follow-up.

## Context

ADR-0092 added composite foreign keys to the column store but hardcoded
`ON DELETE RESTRICT`, naming per-relation delete behavior as the follow-up. The
manifest already declares it: a `many_to_one` `Relation` carries an optional
`onDelete` of `restrict | cascade | set_null`. The FK the store emits for that
relation's reference column should honor it — the delete policy is part of the
schema the manifest describes, not a storage default.

## Decision

Changes confined to `@crossengin/operate-runtime-pg`; the `EntityStore` contract
is unchanged.

- **`column-plan.ts`** — `relationDeleteIndex(manifest)` indexes every
  `many_to_one` relation's `onDelete` by `"<from>.<field>"` (only `many_to_one`
  has a FK-bearing column on the `from` entity; `one_to_many` is the inverse,
  `many_to_many` is a join table — both skipped). Relations without an explicit
  `onDelete` aren't indexed (so the default applies).
- **`entity-ddl.ts`**
  - `onDeleteClause(policy, refColumn)` maps the policy to SQL: `cascade →
    ON DELETE CASCADE`, `restrict → ON DELETE RESTRICT`, and `set_null →
    ON DELETE SET NULL (<ref>_id)` — the **column-list** form, so only the
    `<ref>_id` column is nulled and **`tenant_id` is never nulled** (a plain
    `SET NULL` would null every FK column, breaking tenant scoping). The
    column-list form requires Postgres ≥ 15.
  - `emitForeignKeyDdl(plan, knownEntities, onDeleteFor?)` takes an optional
    per-field policy resolver; each reference's FK uses `onDeleteFor(field)`
    (default `restrict`).
- **`column-store.ts`** — the constructor builds the `relationDeleteIndex`;
  `ensureSchema`'s FK phase passes `field → index.get("<entity>.<field>")` so
  each FK gets its manifest-declared delete behavior.

## Cross-cutting invariants enforced (by tests)

- **The delete policy is the manifest.** A `many_to_one` with `onDelete:
  "cascade"` produces `ON DELETE CASCADE` on that reference's FK, end-to-end
  through `ensureSchema`; with no `onDelete`, the FK is `RESTRICT`.
- **`set_null` never nulls the tenant.** The emitted clause is `ON DELETE SET
  NULL ("<ref>_id")` (column-list), so a cascade-to-null can't strip a row's
  `tenant_id` and escape its tenant.
- **Index scoping.** `relationDeleteIndex` keys by `"<from>.<field>"`, indexes
  only `many_to_one` relations with an explicit `onDelete`, and ignores
  `one_to_many` / `many_to_many`.
- **Backward compatible.** With no relation policy (or no resolver),
  `emitForeignKeyDdl` still emits `RESTRICT` exactly as ADR-0092 did.

## Alternatives considered

- **Plain `ON DELETE SET NULL` (all FK columns).**
  - **Decision.** No — it nulls `tenant_id` too, which would orphan a row from
    its tenant (and violate the `NOT NULL` tenant column). The column-list form
    targets only `<ref>_id`; the PG≥15 requirement is acceptable for a
    forward-looking platform and documented.
- **Default to `cascade` for required references.**
  - **Decision.** No — `restrict` is the safe default (deleting a referenced row
    is blocked unless the manifest explicitly opts into cascade/null), matching
    the kernel's reference default and avoiding surprise data loss.
- **Honor `onDelete` on `one_to_many` / `many_to_many`.**
  - **Decision.** Out of scope — `one_to_many` is the inverse of a
    `many_to_one` (the FK lives on the other entity), and `many_to_many` needs a
    join table (not yet modeled by the column store). Only the FK-bearing
    `many_to_one` side maps to a column here.

## Consequences

- **59 packages + 2 apps, 123 meta-schema tables, 6,321 tests** (was 6,315;
  +6, 0 new packages/tables). ADR-0092's delete-semantics follow-up is
  delivered: the column store's foreign keys now honor each relation's
  manifest-declared `onDelete`.
- **The column store models the manifest's relational intent fully** — typed
  columns (P1.10), PHI encryption (P1.11), composite FKs (P1.12), and now
  per-relation delete behavior (P1.13) — all behind the one `EntityStore`
  contract.
- **A join-table mapping for `many_to_many`** is **delivered in ADR-0094
  (P1.14).** A link/unlink API over the association rows remains the open
  follow-up, behind the same plan/DDL seams.
