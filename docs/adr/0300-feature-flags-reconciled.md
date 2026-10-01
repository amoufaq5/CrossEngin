# ADR-0300: Reconciling `meta.feature_flags` instead of deleting it (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0296 (dead-table reconciliation), ADR-0289 (re-parse on read), ADR-0293 (SLO incident persistence) |

## Context

ADR-0296 found that `meta.feature_flags` could not store a `FeatureFlag`'s own id, which is why no
foreign key to it could be well-formed: the kill switch's `flag_id` had to drop its reference rather
than retarget it, costing the `ON DELETE RESTRICT` protection a test used to assert. The ADR left the
question open and named it "the next instance of the reconcile-or-delete question" — a table declared
in Phase 1 that nothing had ever written, whose columns no longer matched the contract they were
modelled from.

The gap was not one column. Against `FeatureFlagSchema` the table was missing 18 columns, declared
`kind` with 4 of the 7 flag kinds, and typed `default_value` as JSONB where the contract holds a
string. Nothing wrote the table, so none of it had ever failed.

This is the same finding as ADR-0289's `declared_by`, for the fifth time: a column narrower than its
contract is invisible until something tries to write.

## Decision

Reconcile the table rather than delete it, and give it a store so it stops being dead.

- `META_FEATURE_FLAGS` gains the 18 missing columns, all 7 `kind` values, and a `flag_id TEXT` unique
  column holding the flag's own contract id — the column ADR-0296 said was needed before a foreign key
  to this table could be well-formed.
- `default_value` becomes TEXT, **keeping its name**. A rename is not available: the reconciler has no
  concept of one, so declaring a new name adds a column and reports the old as undeclared without
  dropping it, stranding a `NOT NULL` column that every insert then fails on.
- Its RLS policy is written `tenant_id IS NULL OR tenant_id = …`, because a flag may be platform-wide
  or tenant-scoped and a CHECK or policy evaluating to NULL is *passed* by Postgres — so the `IS NULL`
  arm is what makes the platform-wide case deliberate rather than accidental.
- `packages/feature-flags-pg` gains `PostgresFeatureFlagStore` alongside the kill-switch store.

The kill switch's foreign key to `flag_id` stays off. The column now exists, but ADR-0291 refuses to
*add* a foreign key to an existing database when it cannot prove every row satisfies it, and
`meta.feature_flags` is empty in every deployment — so the reference would be added on a fresh install
and reported as undeclared drift on every existing one, forever. It becomes available once a
deployment has flags in the table.

## Alternatives considered

- **Option A: delete the table.**
  - **Pros:** removes 1 of 140 tables and the question with it; nothing reads or writes it.
  - **Cons:** the SLO loop writes `KillSwitch` rows that name a flag (ADR-0296), and the flag they name
    has to live somewhere. Deleting the table moves the problem rather than removing it, and ADR-0291
    reports a dropped table as undeclared on every existing database.
  - **Why not:** the table is wanted; it was merely never finished.

- **Option B: reconcile the columns but add no store.**
  - **Pros:** smallest diff; the schema stops lying.
  - **Cons:** leaves the table dead, which is precisely the condition that let it drift unnoticed for
    ~170 PRs. A schema nothing exercises is a schema nothing checks.
  - **Why not:** the store is what makes the next drift fail loudly.

- **Option C: rename `default_value` to match the contract's spelling.**
  - **Pros:** the column would read as what it holds.
  - **Cons:** the reconciler cannot rename, so the old column survives as undeclared and `NOT NULL`,
    and every insert fails against a column the catalog no longer mentions.
  - **Why not:** measured, not reasoned about — the type change under the same name is reconcilable on
    an empty table and the rename is not.

## Consequences

- **Positive:** the table can store what the contract produces, and a store exercises it. The
  `flag_id` column that ADR-0296 named as the blocker now exists.
- **Negative:** `default_value` keeps a name that describes its old type. The column type changed
  under it, which is only reconcilable because the table is empty everywhere — the guard re-checks
  emptiness in its own transaction and refuses otherwise.
- **Neutral:** the kill switch's foreign key stays off, for a different reason than before: not
  "impossible" but "not addable without reporting drift forever".
- **Reversibility:** the added columns are additive and reversible on a fresh install. On an existing
  database, removing them would leave them reported as undeclared, as ADR-0296 measured for the six
  readerless indexes.

## Implementation notes

- `packages/kernel/src/bootstrap/meta-schema.ts` — `META_FEATURE_FLAGS` and its test assertions.
- `packages/feature-flags-pg/src/flag-store.ts` — the store, re-parsing every row on read (ADR-0289),
  with a tenant-conditional scope because a flag may be platform-wide.
- Verified live: the migration is a 31-statement plan against a database bootstrapped from the old
  declaration, every statement succeeding; a second `apply` is a clean no-op; and the platform-wide
  policy path does not raise `''::UUID` on a reused pooled connection, which an earlier spelling did
  (hence `NULLIF(current_setting(…), '')`).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Restore the kill switch's `flag_id` foreign key once a deployment has rows in `meta.feature_flags`? It is addable then without permanent drift. | amoufaq5 | _unscheduled_ |
| `default_value`'s name still describes its old type. Worth a rename once the reconciler can express one? | amoufaq5 | _unscheduled_ |

## References

- ADR-0289, ADR-0291, ADR-0293, ADR-0296.
