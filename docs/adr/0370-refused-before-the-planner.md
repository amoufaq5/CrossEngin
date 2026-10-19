# ADR-0370: Refused before the planner

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-19 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0313 (template authoring, four-eyes at three layers), ADR-0333 (what a fake `PgConnection` cannot see), ADR-0335 (an actor column is a record of the past), ADR-0302 (the structured actor vocabulary) |

## Context

`--notification-template-routes` mounts five status transitions over
`meta.notification_templates` — submit, approve, reject, deprecate, retire. **Every one of them
raised at the database and escaped as an unclassified 500**, found while measuring which background
subsystems the shipped compose should default on (register P0.3). The surface has existed since
ADR-0313 with 24 passing tests over its store and 37 over its routes.

Three different Postgres errors, from one cause plus one:

| Transition | Error | Why |
|---|---|---|
| submit, reject, retire | `08P01 bind message supplies 5 parameters, but prepared statement "" requires 4` | the arm's assignments are empty (`in_review`, `retired`) or literal (`draft` → `approved_at = NULL`), so nothing referenced `$5` |
| deprecate | `42P18 could not determine data type of parameter $5` | the timestamp was bound on demand and took `$6`, leaving `$5` referenced by nothing |
| approve | `42804 column "approved_by" is of type uuid but expression is of type text` | one parameter stood in two columns of disagreeing declared types |

The first two are one cause. `transition` built its parameter array as

```ts
const params: unknown[] = [tenantId, ntplId, request.to, template.status, request.actorId];
```

under a comment claiming `$1..$5` are fixed "so the statement reads the same for every target" —
and the statement does **not** read the same for every target. `transitionAssignments` is a `switch`
whose `approved` arm was the only one mentioning `$5`, so the other four bound a parameter their
statement never referenced. Reading the same is a property of the *text*, and buying it with an
unreferenced parameter costs the statement: Postgres compares the bind message against the parsed
statement before the planner is ever reached.

The third is a column type. ADR-0335 swept nine `meta.users`-referencing actor columns to plain
`TEXT` on the rule that *a column recording who performed an act is a record of the past, and a
referential constraint on it makes the actor undeletable as a consequence of having acted*. On this
table it reached `created_by` and **missed `approved_by` two lines down.** ADR-0313's four-eyes rule
compares them (`created_by <> $actor`), so the predicate pinned `$5` to `text` and the assignment
into the still-UUID column raised. The rule's own target had been half-applied.

### Why nothing saw it

This is a **sixth** member of ADR-0333's class, and the first where the boundary is *below* SQL
rather than above it. The five known members are all about what a fake cannot know past the SQL
string — does the column exist, is the `INSERT` complete, does a policy permit it, does a row come
back, does anyone call this. This store's fake is one of the better ones in the repo: it models the
table's RLS policy, holds rows in a `Map`, tracks the current tenant and answers reads from that
model. It still served all five statements, because **there is no bind step to model.** `08P01` and
`42P18` are protocol-level refusals; no amount of interpreting the SQL reaches them.

Three narrower observations, each sharper than the defect:

- **The test required the defect.** The approval test read
  `expect(update?.sql).toContain("approved_by = $5")` beside
  `expect(update?.sql).toContain("created_by <> $5")`. One parameter in both positions *is* the
  `42804` cause, so the only statement that assertion admitted was the one no server would run. It
  did not merely miss the bug; it pinned it as a feature.
- **The fake read positions by literal number.** Its `UPDATE` branch matched
  `sql.includes("approved_at = $6")`, so it modelled one particular numbering of the assignments
  and silently stopped modelling anything the moment that numbering changed — while the `SELECT`
  branch immediately below it already resolved placeholders with `/\bstatus = \$(\d+)/` and indexed
  `p[n-1]`. One file, two idioms, and the brittle one was in the branch the defect was in.
- **Meta-schema invariant #4 has a blind spot of exactly this shape.**
  `crossColumnTypeDisagreements` (ADR-0335) extracts binary comparisons between two bare column
  identifiers *from CHECK expressions* and requires their declared types to agree. Measured:
  `META_NOTIFICATION_TEMPLATES` carries no table constraint and no CHECK naming `created_by`, so
  there was nothing for it to extract. The identical `uuid <> text` disagreement lived in a store's
  `UPDATE` predicate with a bound parameter instead of in a CHECK, one layer out of that rule's
  sight.

## Decision

Three parts, in the order they have to land.

**1. The store binds what it references, and nothing else.** `$1..$4` stay fixed — tenant, template,
the status being set, the status it must still have — and every other value is bound on demand
through the existing `bind` helper. `transitionAssignments` takes the actor and binds it in the one
arm that uses it.

**2. The actor is bound twice in the approval statement, deliberately.** The assignment and the
four-eyes predicate each get their own placeholder. Two bindings of one value cost nothing and
cannot pin each other's type, where one binding in two positions is precisely what produced the
`42804`. The second binding is kept even now that both columns are `TEXT`, because what made the
single binding wrong was the coupling and not the types of the day.

**3. `meta.notification_templates.approved_by` is `TEXT` and unreferenced**, completing ADR-0335 on
this table. The types must agree because the two columns hold the same kind of value, which is the
argument rather than the symmetry: a `TEXT` `created_by` admits a non-UUID actor such as
`system:<slug>` (ADR-0302's provenance vocabulary), so a UUID `approved_by` cannot store what its
sibling can, and casting the parameter instead would raise `22P02` on exactly those actors.

**And the fence sits one level up, at the floor every fake already stands on.**
`packages/testing` exports `assertBindArity(sql, params)` — raise unless the statement references
exactly `{1..params.length}`. It is **both ways** on this repo's own rule
(`pg-record-retention.ts`), and the defect contains the counterexample to each one-way half:
"max referenced ≤ supplied" passes all three `08P01` transitions, and "max referenced ===
supplied" passes the `42P18` one, whose hole was in the middle. Every shared `test-fakes.ts` that fakes a `PgConnection` calls
it, and so does this store's fake.

It is deliberately **not** under `strategy/`. Those eleven rules read the workspace from disk and
answer one question per run; this is a per-statement predicate a fake calls on the statement in
front of it, and it needs the runtime parameter array that no static scan can have.

## Alternatives considered

- **Option A: fix the store and leave the fake alone.**
  - **Pros:** smallest diff; the live walk proves the fix.
  - **Cons:** the next statement to grow a conditional assignment is refused again, with the same
    four tests passing.
  - **Why not:** three increments in a row have found this family by hand (ADR-0333's own count),
    and the recurring rule in this repo is that the honest fix sits one level up from where the
    pain was felt. The predicate is 40 lines and every fake already holds `(sql, params)`.

- **Option B: a twelfth `strategy/` rule over the workspace source.**
  - **Pros:** unconditional, runs once, no fake has to adopt anything.
  - **Cons:** it cannot work. The supplied count is `params.length` at runtime — built by a `push`
    loop in this very store, and by `const p = [...a, ...b]` spreads elsewhere — so a text scan
    would have to evaluate the array's construction. ADR-0354 refused position-past-a-spread
    analysis for the write path on exactly this ground.
  - **Why not:** the question is only decidable where the array exists.

- **Option C: assert `max(referenced) === params.length` instead of set equality.**
  - **Pros:** one comparison, no set.
  - **Cons:** it misses the measured `42P18` case outright — `deprecate` referenced
    `{1,2,3,4,6}` of six supplied, so the maximum agreed while `$5` was referenced by nothing —
    and it also passes `WHERE a = $2 AND b = $2` with two parameters. Only set equality catches a
    hole in the middle. Pinned by a test.
  - **Why not:** unsound, and the real defect contains the counterexample. The sibling one-way
    check (`max referenced ≤ supplied`) fails the other way, passing all three `08P01`
    transitions, which is why the predicate is both directions rather than either.

- **Option D: cast the parameter (`approved_by = $5::uuid`) and leave the column UUID.**
  - **Pros:** no catalog change, no migration, no standing `ALTER`.
  - **Cons:** raises `22P02 invalid input syntax for type uuid` for every `system:<slug>` actor the
    sibling column admits, which moves the refusal from every approval to a subset of them. And it
    would leave invariant #4's blind spot holding a live member.
  - **Why not:** it makes the two columns permanently unable to hold the same values.

- **Option E: give the table a four-eyes CHECK so invariant #4 can see the pair.**
  - **Pros:** closes the blind spot by bringing the comparison into the rule's sight; a third layer
    for ADR-0313's rule, matching `meta.tenant_tombstones`.
  - **Cons:** `approved_by` is nullable for every row that is not approved, and a CHECK over the
    pair has to admit NULL — so it constrains only the approved rows and says nothing about the
    disagreement that caused this. It is also a tightening on a populated table, which is reported
    rather than planned (ADR-0363).
  - **Why not:** worth doing and not here; it is a separate decision about the table rather than
    part of making its transitions run. Left as an open question.

## Consequences

- **Positive:** all five transitions execute. `approved_by` carries the approver's principal, so
  ADR-0313's four-eyes attribution lands in the column for the first time. Nine shared pg fakes now
  refuse a statement no server would accept, at no cost to a correct store.
- **Negative:** one standing manual `ALTER` on any deployment that already applied the catalog — see
  *Implementation notes*. The reconciler reports it rather than planning it, correctly: it counts
  rows and not non-NULL values.
- **Neutral:** the store's parameter numbering is no longer stable across targets, which is what it
  always should have been. Anything asserting a literal `$n` on these statements had to change; one
  test did, and it was the test that required the defect.
- **Reversibility:** the store change is self-contained. The column change is a type widening over
  values that are all NULL, so the reverse is available for as long as that stays true — which it
  will not, now that approvals commit.

## Implementation notes

**The migration.** `uuid → text` on a populated table is reported, not planned, so an operator runs:

```sql
ALTER TABLE meta.notification_templates DROP CONSTRAINT notification_templates_approved_by_fkey;
ALTER TABLE meta.notification_templates ALTER COLUMN approved_by TYPE TEXT;
```

The foreign-key drop needs `--allow-loosening` once if taken through `crossengin-pg apply`
(ADR-0296's flag; it reaches foreign keys only). A **fresh** database gets the patched shape
straight out of `emitBootstrapSql` with no manual SQL. The precise claim about losslessness is about
the **values** and not the rows: a template could always be *created* — only its transitions raised
— so a deployment that mounted these routes may hold draft rows, and `approved_by` is NULL in every
one of them because no approval could ever commit.

**Reference count.** `pg-column-coverage.test.ts` asserts the number of catalogued references to
`meta.users.id`, and dropping this one took it 97 → 96. That assertion failed on the edit and named
the count, which is the fence doing its job; the figure is updated with that reason beside it.

**Adoption of `assertBindArity`.** Nine shared `test-fakes.ts` modules plus this store's inline
fake. `notification-providers/src/test-fakes.ts` is the tenth shared module and fakes `fetch`, not a
`PgConnection`. Measured across the nine adopters: **1,108 tests, zero further mismatches**, so the
class has exactly one live member. Measured beside it: **72 `*.test.ts` files build a fake `query` inline** rather than going
through their package's shared module, which is a separate sweep and the first open question.

**A dev-only import in a `src` file.** `test-fakes.ts` is not a `*.test.ts`, so each package's
`tsconfig.json` compiles it into `dist`, and it now imports `@crossengin/testing` — a
devDependency. That is the established convention rather than a new hazard, measured two ways:
three of the nine already import `vi` from `vitest`, also a devDependency and also compiled, and
**none of the nine re-exports `test-fakes` from its `index.ts`**, so no production consumer reaches
the module through the package root and nothing resolves the import at runtime. All nine declare
`@crossengin/testing`.

**Dollar quoting.** `referencedParamPositions` blanks `$tag$ … $tag$` bodies before scanning, because
`kernel-pg`'s row-counting guards embed statements inside `DO $ce$ … $ce$` and plpgsql uses `$1` for
its own arguments. A scan that read inside the body would report positions the bind step never sees.

**Live verification** — PG 16.13, as the non-owner `serving` role, `--store pg`, `erp-core`, with
`--notification-template-author-role erp_admin` and `--notification-template-approver-role
platform_admin` naming two distinct principals:

| Request | Before | After |
|---|---|---|
| `POST …/{id}/submit` | 500 (`08P01`) | **200**, status `in_review` |
| `POST …/{id}/approve` as approver | 500 (`42804`) | **200**, status `approved` |
| `POST …/{id}/reject` | 500 (`08P01`) | **200**, status `draft` |
| `POST …/{id}/deprecate` | 500 (`42P18`) | **200**, status `deprecated` |
| `POST …/{id}/retire` | 500 (`08P01`) | **200**, status `retired` |

The stored row, read back in tenant context:

```
walk-a | status=deprecated | created_by=…a001 | approved_by=…a002
```

— two distinct principals, which is the attribution the surface exists for and had never recorded.
And on a second server where one role is both author and approver, that principal approving its own
template is refused `403 four_eyes_violation`, so the handler-level half of ADR-0313's rule fires
where the role gate cannot reach it.

**Mutation-checked.** Re-pushing the actor into the initial array fails 5 tests, including the
five-transition regression test by name, each naming the real Postgres code
(`08P01: binds 5 parameters and references 4 — $5 referenced by nothing`). Reversed by the same
string replacement, never `git checkout --` (ADR-0367).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Should the 72 inline fake-query sites adopt `assertBindArity` too, or should they be converted to the shared `test-fakes.ts` of their package? | Platform | 2026-11-30 |
| Should `META_NOTIFICATION_TEMPLATES` carry a four-eyes CHECK (Option E), bringing the pair into invariant #4's sight? It constrains only approved rows and is a tightening on a populated table. | Platform | 2026-11-30 |
| Invariant #4 reads CHECK expressions only. Should a rule compare the declared types of two columns a *store's* predicate compares? The operands are resolvable — `pg-column-bindings.ts` already derives which symbol a parameter carries. | Platform | 2026-12-31 |
| `assertBindArity` answers nothing about *types*, so a parameter bound into two columns of agreeing-but-wrong types is still invisible. `pg-binding-names.ts` is the rule that asks that question for `VALUES` lists and not for `SET`/`WHERE`. | Platform | 2026-12-31 |
| The other three tables carrying `approved_by UUID references USER_FK` (`ml_training_runs`, `chargeback_statements`, `rate_limit_exceptions`) are internally consistent — every actor column in each is UUID — so ADR-0335's rule is unapplied rather than half-applied there. `pack_installations` is the latent member: `requested_by` is TEXT beside `installed_by` and `uninstalled_by` UUID, and nothing compares them yet. | Platform | 2027-01-31 |

## References

- ADR-0313 — notification template authoring; four-eyes at three layers.
- ADR-0333 — the fake-`PgConnection` boundary and its five known members.
- ADR-0335 — actor columns as records of the past; meta-schema invariant #4.
- ADR-0302 — `user:` / `system:` / `provider:` actor provenance.
- ADR-0354, ADR-0355 — why a static scan cannot resolve a parameter array built by `push`/spread.
- PostgreSQL protocol: `08P01` (protocol violation, bind), `42P18` (indeterminate datatype),
  `42804` (datatype mismatch), `22P02` (invalid text representation).
