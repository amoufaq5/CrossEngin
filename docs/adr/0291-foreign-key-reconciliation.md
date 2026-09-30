# ADR-0291: Foreign keys the migrator can see, and the steps that were never safe (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09-30 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0290 (meta-schema reconciliation), ADR-0289 (incident-record persistence), ADR-0283 (additive column-store migration) |

## Context

ADR-0290 named foreign keys as the piece that would make column type changes automatable:
*"Foreign keys are not introspected at all, so a declared FK the database lacks is not detected, an
undeclared FK it holds is not reported, and a type change cannot be planned around one."* That was
not a theoretical gap — the first attempt at a guarded type change failed live with
`foreign key constraint "incidents_declared_by_fkey" cannot be implemented`, so the step was pulled
and ADR-0289's own schema change stayed manual.

This closes that. It also found two steps the plan had been making that were **never** safe, which
is the more useful half.

## Decision

- **Introspect foreign keys, and match them by column rather than by name.** `TableDefinition` has
  no table-level foreign key, so every declared FK is a `references` on one column and the emitter
  writes it inline, letting Postgres name it. There is no name in the declaration to match against,
  so the column is the key.
- **`ON DELETE` omitted means RESTRICT, because that is what the emitter writes.** Comparing a
  declared `undefined` against an introspected `RESTRICT` would report drift on every reference that
  leaves it out — the same class of false positive as ADR-0290's `TIMESTAMPTZ`. The acceptance test
  is the same too: **a correctly-applied schema reports zero drift**, now including its ~200 foreign
  keys.
- **Four rules, by how unambiguous the catalog is.**
  - A **declared** FK the database lacks is **added**.
  - A **changed** declaration — different target or different `ON DELETE` — is **replaced**, drop
    then add, because Postgres can alter neither in place. The catalog changed, so closing it is
    unambiguous.
  - An **undeclared** FK is **reported**, on the same footing as an undeclared index: it may have
    been added deliberately, and dropping it loosens referential integrity.
  - Except when it sits on a column whose type is being rewritten, where the drop is **planned as
    its own visible step**. There the drop is not a judgement about the constraint but a
    prerequisite of a change the catalog does ask for — and it belongs in the plan rather than
    hidden inside the type change.
- **Adding an FK is not probed or guarded.** It fails only when the table holds rows whose reference
  does not resolve, which means the database already contradicts a constraint the catalog declares.
  That is an integrity problem the operator needs to see, not an ambiguous decision to route around.
  The same reasoning covers a unique index over duplicate rows.
- **A type change is plannable again, but only on an empty table**, and the statement re-checks
  emptiness in its own transaction. FK introspection removed one of ADR-0290's two reasons for
  refusing it; the other — whether reinterpreting existing rows under a cast is the intended
  reading — is still a decision nobody has made. The probe answers "is it empty" at plan time and
  the `DO` block answers it again at execution time, so a row inserted in between aborts the change
  instead of being silently rewritten.
- **A NOT NULL column with no default is refused on a populated table.** ADR-0290's own
  `emitAddColumn` docstring said Postgres refuses this "correctly, since filling it is a decision
  about existing data" — and then the planner emitted the step unconditionally anyway. What goes in
  those rows is a decision, so it is reported with SQL that adds the column nullable, backfills, and
  tightens.
- **Refusals propagate.** An index, unique constraint or foreign key that covers a column the plan
  is not adding cannot be created either, so it is refused with `depends_on_unreconciled` rather
  than attempted.

## Consequences

- **Verified live** against a real Postgres:
  - **zero drift on a correctly-applied schema**, including every foreign key — but only after a
    real bug: `attname` is Postgres's `name` type, and node-postgres has no array parser for
    `name[]`, so every column list arrived as the literal string `{tenant_id}` and **each foreign
    key read as simultaneously added and removed** (125 tables reported as modified). `attname::text`
    fixes it. No offline fake would have shown this — the fakes hand back real arrays.
  - **ADR-0289's own upgrade is now fully automatic**: the pre-ADR-0289 schema to the current one
    plans **9 statements with zero refusals** — the four columns, the FK drop ordered *before* the
    type change, the type change, two indexes and the unique constraint — applies in 38 ms, and
    leaves `(no drift)` with `declared_by` as `text`, the constraint gone and all 10 indexes present.
    ADR-0290 managed 7 of 8 with one manual step.
  - a dropped FK was re-added with its declared `CASCADE`; an `ON DELETE` changed by hand to
    `RESTRICT` was replaced back to `CASCADE`; an undeclared `files_adhoc_fkey` was **reported and
    left alone**, and drift went clean once it was dropped by hand.
  - the same upgrade against a table **holding one row** halted at statement #1 with
    `column "year" of relation "incidents" contains null values` — the defect above. After the fix
    it refuses the two unfillable columns and, on the next run, also refuses the unique constraint
    over them, which had failed with `column "year" named in key does not exist`. Following the
    printed SQL and re-applying closes everything, with the row intact and its UUID preserved as
    text.
  - the emptiness guard, run against that populated table, raised
    `refusing to change meta.incidents.declared_by to uuid: table holds 1 row(s)`.
- No new table; no meta-schema change. `LiveTable` gains `foreignKeys`, `TableDiff` gains three
  foreign-key fields, and `ReconciliationPlan` gains a `ReconciliationProbe` input.
- +38 tests (kernel-pg 207 → **238**, kernel 574 → **581**; workspace **9,770** across 597 files).
  Full workspace build + typecheck + test green.

## Follow-ups

- **An index or policy changed in place, under the same name, is still invisible** — unchanged from
  ADR-0290, and still the harder problem, because it needs Postgres's own rendering of an expression
  normalized rather than a type or a default spelling.
- **A composite foreign key cannot be declared**, only introspected. `TableDefinition` has no
  table-level constraint, so a multi-column live FK is always read as undeclared. Nothing in the
  catalog wants one yet.
- **Type changes on a populated table, and NOT NULL backfills, remain manual** by design. The plan
  now hands over SQL for both; automating either means deciding what happens to existing rows,
  which is the one thing a migrator should not decide.
- The applier still halts on the first failure. The plan is built to succeed and two more classes of
  predictable failure are gone from it, but a plan whose steps are largely independent would be
  better served by continuing and reporting every outcome.
