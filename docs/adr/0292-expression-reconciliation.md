# ADR-0292: Letting Postgres deparse both sides (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0291 (foreign-key reconciliation), ADR-0290 (meta-schema reconciliation) |

## Context

ADR-0290 opened this and ADR-0291 left it open twice, both times calling it the harder problem:
*"An index or policy changed in place, under the same name, is still invisible. `diffSchema` compares
both by name only… comparing definitions means normalizing Postgres's own rendering of an
expression, which is a much less mechanical problem than the type and default spellings fixed
here."*

It was worse than "predicates are not compared". Indexes were compared by **name alone** — the
`columns` and `unique` fields were introspected and then ignored — so reordering an index's columns,
flipping its uniqueness, changing its access method or editing its predicate all reconciled to no
change. Policies the same: a `using` clause could be replaced wholesale and the drift report stayed
clean.

The reason it had been deferred is real. Postgres does not store the text anyone wrote; it stores a
parsed tree and prints it back through its own deparser, which **rewrites structure**, not just
spelling:

| Declared | Stored and printed back |
|---|---|
| `status = 'active'` | `(status = 'active'::text)` |
| `status IN ('succeeded', 'failed')` | `(status = ANY (ARRAY['succeeded'::text, 'failed'::text]))` |
| `status NOT IN ('closed', 'cancelled')` | `(status <> ALL (ARRAY['closed'::text, 'cancelled'::text]))` |
| `tenant_id = current_setting('app.current_tenant_id', true)::UUID` | `(tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)` |

`IN` becoming `= ANY (ARRAY[…])` is not a cosmetic difference that a normalizer can paper over.
Closing this by canonicalizing text in TypeScript means writing a SQL parser, and getting it subtly
wrong means either missing real drift or — as ADR-0290 measured when the comparison was naive —
inventing drift on a schema that is exactly correct.

## Decision

- **Do not replicate the deparser. Use it.** The declared expression is handed to Postgres, which
  renders it the same way it renders the stored one, and the two renderings are compared as strings.
  There is no normalizer to get wrong, and the comparison is exact by construction.
- **The probe is a `CHECK … NOT VALID` constraint inside a savepoint, rolled away.** Each declared
  expression is attached to its table, read back with `pg_get_constraintdef`, and undone. `NOT VALID`
  is what makes it free: Postgres records the constraint without scanning a single row. Stripping the
  `CHECK (` / `) NOT VALID` wrapper yields text **character-identical** to what `pg_get_expr` prints
  for the same expression stored as an index predicate or a policy clause — verified against both.
  Each probe gets its own savepoint, so an expression the table cannot carry is recorded as
  unrenderable instead of poisoning the batch, and the whole transaction is rolled back either way.
- **One mechanism for both.** An index predicate and a policy clause are both boolean expressions
  over the table's columns, so they go through the same renderer rather than two.
- **Unknown is not drift.** `diffSchema` takes the renderings as an optional argument and, without
  them, does not compare expressions at all. The opposite default would report every correct index
  and policy as drifted for any caller that did not probe — the exact failure ADR-0290 was written to
  remove. Both `apply` and `drift` supply them.
- **Compare the rest structurally, where no rendering is needed.** Column list and order, uniqueness,
  and the access method are exact comparisons that were simply never made.
- **A changed definition is replaced, in one statement.** `DROP INDEX …; CREATE INDEX …;` and
  `DROP POLICY …; CREATE POLICY …;` go to the applier as a single statement, which it runs in a
  single transaction. Two statements would leave a window: for an index, queries running without it;
  for a policy, a table with RLS enabled and no policy, which denies every row — fail-closed, but an
  outage. One statement means there is no window. This is the ADR-0291 rule for a changed foreign
  key, applied to the other two: a changed *declaration* is unambiguous, so closing it needs no
  decision.
- **A constraint-backed index is replaced through its constraint.** `DROP INDEX` on the index behind
  a UNIQUE constraint is refused by Postgres, so those route to `DROP CONSTRAINT` / `ADD CONSTRAINT`
  and the repaired object is still a constraint, not a bare unique index.

## Consequences

- **Verified live** against a real Postgres:
  - a correctly-applied schema still reports **`(no drift)`** with all 112 declared expressions
    compared through Postgres's own deparser;
  - five changes made **in place, every name unchanged** — an index predicate, an access method
    (`gin` → `btree`), an index's column order, a unique constraint's column order, and a policy's
    `using` clause — were **all detected**, each with its reason and before/after. Every one of them
    was completely invisible before;
  - `apply` repaired all five in **43 ms** and left `(no drift)`; each object was checked back to its
    declaration, and `incidents_year_sequence_key` came back as `contype = 'u'` — a real constraint,
    not a bare unique index;
  - a policy given an undeclared `WITH CHECK` was reported as *"present in the database … but not
    declared"* and repaired;
  - the probes committed **nothing**: zero leftover probe constraints after many runs;
  - **cost**: a full drift check, including ~112 probes, took **337 ms against a table holding 20,000
    rows** — `NOT VALID` really does skip the scan;
  - a fresh install still applies all 840 statements and reports no drift, since a table that does
    not exist yet is not probed.
- **A latent bug in the connection wrapper, found by this.** A multi-statement simple query makes
  node-postgres return an **array** of results, and `rowsResult` read `.rows` off the array — so the
  first atomic replacement failed with `Cannot read properties of undefined (reading 'length')`, a
  JS TypeError wearing the costume of a database error. It now takes the last result, which is what a
  caller of a DDL batch means.
- No new table; no meta-schema change. `LiveIndex` gains `method` and `predicate`, `TableDiff` gains
  `changedIndexes` and `changedPolicies`, and three step kinds are added.
- +47 tests (kernel-pg 238 → **280**, kernel 581 → **586**; workspace **9,817** across 598 files).
  Full workspace build + typecheck + test green.
- The three follow-ups ADR-0290 and ADR-0291 named as load-bearing for migration are now closed:
  expressions, foreign keys, and the diff's trustworthiness.

## Follow-ups

- **A policy's `WITH CHECK` is only exercised offline in the comparison's declared direction**,
  because nothing in the catalog declares one. The live run covered the other direction (a clause the
  database holds and the catalog does not).
- **Replacing an index rebuilds it.** On a large table that is a real cost, and it is unavoidable —
  Postgres cannot alter a predicate, a column list or an access method in place. The plan names the
  step so it is visible before it runs; it does not estimate the cost.
- **An expression is compared, not understood.** Two logically equivalent predicates written
  differently — `a > 1 AND a < 5` versus `a BETWEEN 2 AND 4` — deparse differently and read as a
  change, so the plan would rebuild an index that did not need rebuilding. Correct but not minimal.
- A policy's roles and command (`FOR SELECT`, `TO some_role`) are still neither declared nor
  compared; `RlsPolicy` has no field for either.
- ~~The applier halts on the first failure.~~ **Closed by ADR-0295**: it continues and reports
  every outcome, and a failed statement is still never recorded as applied. Original wording: The applier still halts on the first failure (ADR-0290, 0291).
