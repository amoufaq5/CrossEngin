# ADR-0308: The reconciler learns to rename, and to loosen when told

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-02 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0290, ADR-0291, ADR-0292, ADR-0296, ADR-0300 |

## Context

Two of ADR-0290's follow-ups had the same shape: the reconciler was *correct* and yet a correct catalog
could not be expressed through it.

**It had no concept of a rename.** Declaring a column under a new name added the new one and reported
the old one as undeclared without dropping it. If the new column is `NOT NULL`, that is not a cosmetic
untidiness — the table then holds two columns where the catalog says one, and every insert fails against
the old one until a human intervenes. ADR-0300 ran into this directly and worked around it: a
`meta.feature_flags` column whose type had changed kept a name describing its old type, because renaming
it would have bricked existing deployments.

**It would not remove a foreign key the catalog had dropped.** ADR-0291's rule — never loosen integrity
— is right as a default and wrong as an absolute. ADR-0296 removed four `meta.users` references from
`feature_flag_kill_switches` for a real reason, and the consequence was measured in both directions: a
fresh install is correct, and every existing install reports the same four refusals on every drift check
forever, with four `DROP CONSTRAINT` statements the operator must paste by hand before a kill switch can
be written at all. A permanent refusal is not a safety property; it is a thing that trains operators to
stop reading the refusals.

The constraint both fixes have to respect is ADR-0290's single invariant: **every step in a plan is
expected to succeed.** Anything whose outcome depends on the rows that are already there belongs in
`unreconciled` with the SQL, not in `steps`.

## Decision

**A column may declare `renamedFrom`, and a rename is planned — on a populated table, first.**

`ColumnDefinition.renamedFrom?: string` names the column the database may still hold this one under.
`diffSchema` reports `renamedColumns` and, crucially, *excludes* the old name from `undeclaredColumns`,
so a rename does not also read as drift. `planSchemaReconciliation` emits `rename_column` as the first
step for its table, before every addition, type change, index and policy — so every later statement in
the plan names the column as the catalog declares it.

A rename is the one repair that relocates data without reading it, so the row count is irrelevant. It is
planned when **the old name is live and the new one is not**, and only then:

- **Both live** → `column_rename_ambiguous` in `unreconciled`. There are two columns and nothing in the
  catalog says which holds the data. Renaming onto an occupied name fails outright, and dropping one
  first is a decision about existing data. Both resolutions are spelled out as manual SQL.
- **Neither live** → nothing. The diff already treated the column as an ordinary addition, because
  `renamedFrom` describes history; it does not ask for anything.
- **`renamedFrom` naming a column the catalog still declares** → not a rename. Both columns are wanted,
  and the declaration is a mistake; it is reported, not acted on.

**`ReconciliationOptions.allowLoosening` turns the undeclared-foreign-key refusal into a drop.** Off by
default. It reaches **foreign keys only** — not a column, a table, an index, a policy or a CHECK — and
the line is not taste: dropping a foreign key cannot fail against the rows that are there, so it is the
one loosening that keeps the plan's invariant true. Every other refusal is either a decision about data
or an object somebody may have created deliberately, and neither becomes safe because a flag was passed.

A foreign key that *blocks a type change* is still dropped without the flag, as ADR-0291 established:
there the drop is a visible step in service of a change the catalog asked for, not a loosening.

## Alternatives considered

- **Option A:** infer a rename by matching an added column against a dropped one of the same type.
  - **Pros:** no declaration needed; works on catalogs nobody annotated.
  - **Cons:** a guess, and a wrong guess silently moves data between unrelated columns. Two columns
    added and two dropped in one release is an ordinary diff and an unresolvable matching problem.
  - **Why not:** the failure mode is data in the wrong column, discovered later. An explicit
    `renamedFrom` costs one line in the catalog and cannot be wrong by accident.

- **Option B:** plan the rename as `ADD COLUMN` + `UPDATE … SET new = old` + `DROP COLUMN old`.
  - **Pros:** works without `ALTER … RENAME`; the intermediate state is readable.
  - **Cons:** rewrites every row, takes a lock proportional to the table, and the `DROP` is exactly the
    loosening the reconciler refuses elsewhere. Three statements where one suffices, each able to fail
    separately.
  - **Why not:** `ALTER TABLE … RENAME COLUMN` is catalog-only and atomic. The expensive version is
    strictly worse.

- **Option C:** make `allowLoosening` general — let it drop anything the catalog no longer declares.
  - **Pros:** one flag closes every "reported forever" follow-up at once, including the six readerless
    indexes of ADR-0296.
  - **Cons:** it would drop a column (data loss), a policy (RLS off on a tenant table until the next
    statement), and an index somebody added for a query the catalog knows nothing about. It also breaks
    the invariant: a `DROP COLUMN` on a replicated or logically-decoded table can fail.
  - **Why not:** these are different decisions with different worst cases. One flag that means "I accept
    all of them" is a flag nobody can reason about at the moment they pass it.

- **Option D:** leave both as they were and keep documenting the manual SQL.
  - **Pros:** zero new risk in the migrator.
  - **Cons:** this *was* the state, and ADR-0300 shows what it costs — a column that cannot be named
    correctly, and a drift report that is permanently non-empty on every existing deployment.
  - **Why not:** a drift check whose output is never empty is a drift check nobody reads.

## Consequences

- **Positive:** a column can be renamed to say what it means. `meta.feature_flags.default_value_json`
  now carries the name its type deserves, declared as `renamedFrom: "default_value"`, and migrates on a
  populated table without a human. The four ADR-0296 kill-switch references can be removed with one
  flag instead of four pasted statements, and the drift report on an existing deployment can reach
  empty — which is the state that makes the next real drift visible.
- **Negative:** `renamedFrom` is history that accumulates in the catalog. It must stay as long as any
  deployment might still hold the old name, and nothing tells us when that is — so in practice these
  annotations are never safely deletable. `allowLoosening` is also a flag an operator can pass without
  reading what it will drop; the plan names every statement, but `--plan` is optional.
- **Neutral:** the ambiguous case (both columns live) is still manual. That is the correct answer and
  it is also the case an operator is most likely to hit, since it is what a half-finished manual
  migration leaves behind.
- **Reversibility:** `renamedFrom` is a declaration; removing it makes the column read as an ordinary
  addition again. `allowLoosening` is a parameter with a safe default. The *rename itself* is not
  reversible without another rename, and the dropped foreign key is not reversible without being able
  to prove every row satisfies it — which is the whole reason ADR-0291 refused to add one.

## Implementation notes

- `ColumnDefinition.renamedFrom` in `packages/kernel/src/bootstrap/types.ts`; it affects nothing the
  emitter writes, so a fresh bootstrap is byte-identical.
- `diffSchema` collects `renamedColumns: readonly ColumnRename[]` (`{column, from, ambiguous}`) and
  suppresses `from` in `undeclaredColumns`. `hasDrift` counts a rename as drift.
- `planRenames` runs before every other planner for its table. `rename_column` is in
  `RECONCILE_STEP_KINDS`; `emitRenameColumn` renders it.
- `allowLoosening` is read in exactly one place — the undeclared-foreign-key branch, beside the
  existing `blocksRetype` condition.
- Verified live against a throwaway cluster: a populated table with the old column name migrates, the
  rows survive, the plan re-runs to empty, and the ambiguous case refuses with both resolutions.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Should `renamedFrom` annotations carry a "since" marker so they can eventually be retired, or do they live in the catalog forever? | amoufaq5 | _unscheduled_ |
| The six readerless ADR-0296 indexes are still reported as undeclared. `allowLoosening` deliberately does not reach them; should a separate, narrower flag? | amoufaq5 | _unscheduled_ |
| A composite foreign key remains declarable and unreconciled (ADR-0291, ADR-0299). Unchanged by this ADR. | amoufaq5 | _unscheduled_ |

## References

- ADR-0290 (migration is reconciliation; the one invariant), ADR-0291 (foreign keys; refusing to
  loosen), ADR-0292 (indexes and policies), ADR-0296 (the removed references), ADR-0300 (the column
  that could not be renamed).
- PostgreSQL: `ALTER TABLE … RENAME COLUMN` is a catalog-only operation and takes no table rewrite.
