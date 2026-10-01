# ADR-0299: Table-level constraints and policy permissiveness in the DDL vocabulary (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0291 (foreign-key reconciliation), ADR-0292 (index and policy definitions), ADR-0296 (dead-table reconciliation), ADR-0298 (policy roles and command) |

## Context

Two gaps in `TableDefinition` were named as load-bearing follow-ups and had the same shape: a rule the
contracts enforce had no way to be spelled in the schema, so the database accepted rows the contract
would refuse.

**Cross-column rules had no home.** `ColumnDefinition.check` attaches a `CHECK` to one column.
`bouncesCount <= recipientCount` and `publishedAt <= breachNotificationDeadlineAt` each compare two
columns, so neither could be declared. Both were enforced only by the re-parse on read — the argument
for re-parsing (ADR-0289), but not a substitute for a constraint: a row written by anything other than
the store, or by a hand-edit, is accepted and only fails later, on read, in whichever process reads it
first.

**`RlsPolicy` could not express `AS PERMISSIVE` / `AS RESTRICTIVE`.** Every catalog policy is
permissive, so nothing drifted in practice, but a restrictive policy added by hand read as permissive
and would have been silently replaced with a permissive one — a policy that was narrowing access
quietly becoming one that widens it.

A third gap is adjacent and stayed open: a composite foreign key still cannot be declared, because
`TableConstraint` covers checks, unique tuples and foreign keys but the emitter writes column-level
foreign keys inline (ADR-0291 matches them by column for that reason).

## Decision

`TableDefinition` gains an optional `constraints` array of a `TableConstraint` discriminated union
(`check` | `foreign_key` | `unique`), and `RlsPolicy` gains an optional `permissive` boolean whose
absence means Postgres's default — permissive — so every existing policy emits byte-identically.

Both are reconciled, not merely emitted:

- A declared table constraint missing from the database is **added**, guarded. A constraint cannot be
  validated against existing rows without deciding what happens to the rows that fail, so the add goes
  through `emitAddTableConstraintIfEmpty` — the same emptiness-rechecking `DO` block a type change
  uses (ADR-0291). On a populated table the SQL is reported as `unreconciled` instead.
- A declared constraint whose definition changed is **replaced** under the same guard.
- An undeclared constraint is **reported**, never dropped, because ADR-0291 refuses to loosen
  integrity.
- A policy's permissiveness is compared from `pg_policy.polpermissive`, canonicalised in
  `canonical.ts` alongside `polcmd` and `polroles`.

`meta.incident_communications` is the first table to declare constraints, carrying exactly the two
cross-column rules above.

## Alternatives considered

- **Option A: keep enforcing cross-column rules only on read.**
  - **Pros:** no schema vocabulary to add; the re-parse already catches it.
  - **Cons:** the database accepts a row nothing should have written, and the failure surfaces in a
    reader that did not create it. ADR-0289 added the re-parse to catch rows a CHECK *permits*; that
    is an argument for having both, not for having only one.
  - **Why not:** a constraint that can be expressed should be expressed. The re-parse stays.

- **Option B: a free-text `tableChecks: string[]`.**
  - **Pros:** smallest change.
  - **Cons:** nothing to compare structurally, so reconciliation would be string equality against
    Postgres's deparsed form, which ADR-0292 showed does not match what was written.
  - **Why not:** it would have produced permanent false drift, the exact failure `canonical.ts` exists
    to prevent.

- **Option C: make `permissive` required.**
  - **Pros:** no implicit default to reason about.
  - **Cons:** rewrites all 107 policy declarations and changes their emitted SQL, so the first drift
    check after the change reports every policy as changed.
  - **Why not:** absent meaning "the Postgres default" is how `command` and `roles` were already
    handled in ADR-0298, and it keeps the emit byte-identical.

## Consequences

- **Positive:** two regulatory rules — a bounce count that cannot exceed its recipients, and a breach
  notification that cannot be published after its GDPR deadline — are now enforced by the database.
  A restrictive policy can be declared and no longer reads as permissive.
- **Negative:** adding a constraint to a populated table remains manual, like a type change. The plan
  hands over the SQL; it does not decide what to do with rows that fail.
- **Neutral:** `TableConstraint` includes `foreign_key` and `unique` members that nothing in the
  catalog uses yet. They exist because the union would otherwise have to be widened later, which is a
  breaking change to a published type.
- **Reversibility:** both fields are optional, so removing them is mechanical for the vocabulary. The
  two constraints now in the database would be reported as undeclared and need manual `DROP
  CONSTRAINT`, as ADR-0296 measured for the kill-switch foreign keys.

## Implementation notes

- `packages/kernel/src/bootstrap/types.ts` — `TableConstraint`, `TableDefinition.constraints`,
  `RlsPolicy.permissive`.
- `packages/kernel/src/bootstrap/emit.ts` — `emitTableConstraint`, `emitAddTableConstraintIfEmpty`,
  `emitReplaceTableConstraintIfEmpty`; `emitRlsPolicy` renders `AS RESTRICTIVE` only when asked.
- `packages/kernel-pg/src/introspection.ts` — `CHECK_CONSTRAINT_QUERY`, `polpermissive`.
- `packages/kernel-pg/src/diff.ts`, `reconcile.ts` — `changedConstraints` / `addedConstraints` and the
  `add_table_constraint` / `replace_table_constraint` steps.
- Verified live against Postgres 16: both CHECKs reject the rows they exist for (bounces > recipients;
  published after the deadline) and accept the boundary cases (bounces == recipients, no deadline at
  all). A second `apply` is a clean no-op.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Should a composite foreign key be declarable through `TableConstraint.foreign_key`, now that the member exists? Nothing in the catalog wants one. | amoufaq5 | _unscheduled_ |
| Validating a constraint on a populated table — `NOT VALID` then `VALIDATE CONSTRAINT` — is expressible without deciding about failing rows. Worth planning? | amoufaq5 | _unscheduled_ |

## References

- PostgreSQL: `CREATE TABLE … CONSTRAINT`, `CREATE POLICY … AS { PERMISSIVE | RESTRICTIVE }`.
- ADR-0291, ADR-0292, ADR-0296, ADR-0298.
