# ADR-0290: Migrating the meta-schema, and the diff that could not see (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09-30 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0289 (incident-record persistence), ADR-0286 (audit-log anchoring), ADR-0283 (additive column-store migration), ADR-0024 (migration strategy) |

## Context

ADR-0289 measured the gap it had to leave open: **editing an existing meta-schema table breaks
`crossengin apply` on an already-applied database.** Statements are keyed by hash, `emitCreateTable`
emits a bare `CREATE TABLE`, and the applier halts on the first failure — so a changed definition is
a new hash for a statement that then fails with `relation already exists`. Measured then and again
here: **halted at statement #312 of 840, 0 executed, and the remaining 528 never applied.** ADR-0286
edited `meta.audit_log` the same way, so `main` already carried it.

The fix looked like it should be small, because `kernel-pg` already has the two pieces a reconciling
migration needs: `introspectSchema` reads the live schema from `pg_catalog`, and `diffSchema`
compares it against `META_TABLES`. Build a planner over the diff, apply only the deltas, done.

**The first live run destroyed that plan.** On a database that had just been applied correctly,
`crossengin-pg drift` reported **138 of 139 tables as modified**:

```
~ 138 table(s) modified:
    ~ tenants
        ~ column status [default]
        ~ column created_at [type]
        - index tenants_slug_key
```

An inventory of every mismatch found three mechanical causes and nothing else:

| Cause | Columns |
|---|---|
| `TIMESTAMPTZ` vs `format_type`'s `timestamp with time zone` | 425 |
| `CHAR(64)` vs `character(64)`, `NUMERIC(12, 6)` vs `numeric(12,6)` | 109 |
| `DEFAULT 'active'` vs Postgres re-rendering it as `'active'::text` | ~30 |
| a UNIQUE constraint's backing index, absent from `table.indexes` | 117 indexes |

So `diffSchema` could not tell a correct schema from a drifted one, which makes it useless as a
drift report and **disqualifies it as the foundation for a migrator** — a planner built on it would
have "repaired" 138 tables that were already right. The diff had to be fixed first.

## Decision

- **Compare like with like, and prove it on a correct schema.** `canonical.ts` rewrites a declared
  type into the spelling `format_type` prints, normalizes a default by dropping the casts and parens
  Postgres adds when re-rendering one, and computes the full set of index names a table should carry
  — including the ones a UNIQUE constraint creates, which are declared in `uniqueConstraints` or on a
  column and never in `indexes`. The acceptance test is the sharpest one available: **a
  freshly-applied schema must report zero drift.** It now does.
- **`_meta_migrations` is not drift.** The applier creates its own bookkeeping table in the same
  schema, and a diff that did not know that reported it as an extra table on every migrated
  database.
- **Reconcile against the live schema instead of replaying the bootstrap SQL.** `apply` introspects,
  diffs, plans, and applies only the plan. On an empty database the plan *is* the bootstrap emission
  — a property pinned by a test asserting the two statement lists are equal for the real 139-table
  catalog — so a fresh install cannot regress, and the general path handles the migrating case as the
  same code.
- **The plan holds one invariant: every step in it is expected to succeed.** A step that might fail
  is worse than no step, because the applier halts on the first failure and everything after it goes
  unapplied — which is the behaviour this exists to remove. So the plan contains only additions
  (tables, columns, indexes, UNIQUE constraints, RLS, policies) and the two column changes that
  always apply: a default, which touches no row, and *relaxing* `NOT NULL`, which cannot conflict
  with data already there.
- **Everything else is reported, with the SQL, and not run.** ADR-0283's rule, applied to the
  platform's own schema: a removed column, index or policy, a tightening to `NOT NULL`, a type
  change, and an RLS setting the catalog does not ask for. Two of those are refusals about *data*
  (what fills the nulls, whether the cast is the intended reinterpretation); the rest are refusals
  about *intent* — an undeclared index may exist for a query the catalog does not know about, and
  dropping a policy or disabling RLS loosens access, which a migration should never do on its own.
- **A type change is refused even though it looked safe.** The first implementation guarded it on
  the table being empty, which is genuinely safe, and the live run failed anyway:
  `foreign key constraint "incidents_declared_by_fkey" cannot be implemented`. `ALTER COLUMN TYPE`
  drags the column's constraints with it, and ADR-0289's change had dropped a foreign key the
  database still held. Detecting that needs foreign-key introspection the diff does not do, so the
  step was removed rather than shipped knowing it halts. The emitters written for it were deleted
  too — shipping an unused emitter is the ADR-0284 mistake.
- **`skipApplied: false` for a plan.** The hash log records what *ran*, not what the database holds,
  so a statement whose object was later dropped is still marked applied. A plan already contains only
  what the database needs, so the skip has nothing to save and can only leave an object missing.
  This is what makes the second half of ADR-0289's remedy unnecessary.
- **A missing UNIQUE constraint is repaired with `ADD CONSTRAINT`, not `CREATE INDEX`** — guarded by
  a `pg_constraint` lookup, since Postgres has no `IF NOT EXISTS` for constraints. A unique index
  with no constraint behind it is not what the declaration asked for.
- **Both `apply` commands take the same path.** `crossengin-pg apply` had the identical bug; leaving
  one of two apply paths broken is not a fix. Both also gained `--plan`, which introspects and prints
  the plan — including what it will not close — and changes nothing.

## Consequences

- **Verified live** against a real Postgres, in the order the reasoning went:
  - `drift` on a correctly-applied schema: **138 modified tables → `(no drift)`**;
  - a database with **no `meta` schema at all** now bootstraps in one command (840 statements) —
    it previously failed with `schema "meta" does not exist`, a **pre-existing bug** (below);
  - a no-op `apply` went from 840 statements in 3639 ms to **1 statement in 9 ms**;
  - the upgrade that used to halt — the pre-ADR-0289 schema, then the current one — applied **7 of
    its 8 differences in 29 ms** (4 columns, 2 indexes, 1 UNIQUE constraint) and **reported the
    eighth** with the SQL to run;
  - running that SQL by hand left the schema at **`(no drift)`** with all 10 indexes and
    `declared_by` as `text`;
  - dropping `meta.incidents` **and** one index, with **8 statements still recorded as applied**,
    then `apply`: both fully recreated, 10 indexes back, `(no drift)`. The `DELETE FROM
    meta._meta_migrations` that ADR-0289 had to prescribe is no longer needed;
  - both CLIs verified on the reconcile path, and `--plan` on an empty database prints 839 statements
    grouped as one line per table.
- **A second pre-existing bug, found by testing a genuinely fresh database for the first time.**
  `checkCreatePrivilege` called `has_schema_privilege`, which **raises** for a schema that does not
  exist — so `apply` threw on exactly the case its own first statement (`CREATE SCHEMA IF NOT
  EXISTS`) was there to handle. Every setup across several increments had created the schema by hand
  first, which hid it. It now checks existence and falls back to the database-level CREATE privilege.
- No new table; no meta-schema change at all. The catalog is untouched — this increment changes how
  it is *reached*.
- +85 tests (kernel-pg 132 → **207**, kernel +7, architect-cli +3; workspace **9,732** across 597
  files). Full workspace build + typecheck + test green, 0 type errors.

## Follow-ups

- **An index or policy changed *in place*, under the same name, is still invisible.** `diffSchema`
  compares both by name only. Comparing definitions means normalizing Postgres's own rendering of an
  expression (`tenant_id = current_setting('x', true)::UUID` reads back as
  `(tenant_id = (current_setting('x'::text, true))::uuid)`), which is a different and much less
  mechanical problem than the type and default spellings fixed here. Until then, changing an index
  predicate or a policy clause requires a new name or a manual drop.
- **Foreign keys are not introspected at all**, so a declared FK the database lacks is not detected,
  an undeclared FK it holds is not reported, and a type change cannot be planned around one. That is
  the piece that would make column type changes safely automatable.
- **A type change and a tightening to `NOT NULL` remain manual**, by design, and the plan hands over
  the exact SQL. Automating either means deciding what happens to existing rows.
- The applier still halts on the first failure. That is now much less consequential — the plan is
  built to succeed — but for a reconciliation plan whose steps are largely independent, continuing
  past a failure and reporting every outcome would be strictly more useful than stopping.
- `crossengin-pg apply --plan` prints human output only; `crossengin apply --plan` honours
  `--format json`.
