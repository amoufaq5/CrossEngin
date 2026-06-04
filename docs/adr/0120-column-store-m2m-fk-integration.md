# ADR-0120: column-store m2m link + FK ON DELETE integration test (Phase 3 P1.25)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0119 (column-store integration test), ADR-0094 (m2m join tables), ADR-0095 (link API), ADR-0092/0093 (FKs + ON DELETE), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 (serving-stack) hardening increment (P1.25), extending
> ADR-0119.

## Context

P1.24 (ADR-0119) proved the column store's typed tables + native query + at-rest
encryption against real Postgres, but two of its relational features stayed
offline-only because **no built-in pack has a `many_to_many` relation** and the
FK `ON DELETE` enforcement is a database behavior: the **association link API**
(`link`/`unlink`/`isLinked`/`listLinks` over a real join table, ADR-0094/0095)
and the **`many_to_one` FK `ON DELETE`** semantics (ADR-0092/0093). P1.25 adds
those two integration cases.

## Decision

- **`apps/operate-server/src/integration-columns.test.ts`** gains two cases
  (gated on `CROSSENGIN_PG_TEST=1`, random tenant per test, a dedicated `lk`
  schema so the synthetic entities don't collide with P1.24's `public.*`
  tables). Both use a minimal hand-built `{entities, relations}` manifest (cast
  to `Manifest`, the same shape the offline column-store test uses) since no pack
  ships an m2m relation:
  - **m2m link API + cascade.** A `Course`/`Student` manifest with a
    `many_to_many` relation; `ensureSchema` provisions the `course_student` join
    table. `link` (idempotent) / `isLinked` / `listLinks` (narrowed by `leftId`)
    / `unlink` round-trip over the real table, and **deleting a linked `Course`
    cascades** its join rows away (the join FK is `ON DELETE CASCADE`).
  - **`many_to_one` ON DELETE RESTRICT.** An `Order → Account` `many_to_one`
    relation with `onDelete: "restrict"`; an `Account` that an `Order`
    references **cannot be deleted** — `store.remove` rejects on the FK
    violation.

## Cross-cutting invariants enforced (real PG, gated)

- **The join table works.** `link` is idempotent (`ON CONFLICT DO NOTHING`),
  `isLinked` / `listLinks` reflect the real rows, `unlink` reports + removes.
- **Composite FK cascade.** Removing a linked entity clears its association rows
  via the join table's `ON DELETE CASCADE` FK.
- **FK restrict is enforced.** A referenced row can't be deleted while a
  `many_to_one` referencer points at it (`ON DELETE RESTRICT`).

## Alternatives considered

- **Add an m2m relation to a pack to use a real manifest.**
  - **Decision.** No — that changes a vertical pack's schema for a test. A
    minimal synthetic manifest (the offline test's pattern) exercises the same
    store code paths without touching the packs.
- **Test all three ON DELETE modes (restrict / cascade / set_null).**
  - **Decision.** The m2m case already covers cascade (the join FK); the
    `many_to_one` case covers restrict. `set_null` (column-list form, PG ≥ 15)
    is a natural add behind the same pattern — deferred to keep the increment
    tight.
- **A dedicated schema vs reusing `public`.**
  - **Decision.** A dedicated `lk` schema — the synthetic `Account`/`Order`
    entities would otherwise collide with P1.24's healthcare `public.account`
    (different columns), so isolating them keeps both suites independent.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,520 offline tests + 19 gated
  real-Postgres integration tests** (10 worker + 9 serving; +2 this increment, 0
  new tables/columns/packages/production code). The column store's full
  relational surface — typed tables, native query, at-rest encryption (P1.24),
  **m2m links, and FK ON DELETE** (P1.25) — is now proven against real Postgres.
- **The serving-stack persistence coverage is comprehensive** — both
  `EntityStore` bindings, all the column store's distinguishing features, end to
  end under `CROSSENGIN_PG_TEST=1`.
- **`set_null` ON DELETE + a non-bypassing-role RLS-policy test** remain the
  last column-store integration follow-ups.
