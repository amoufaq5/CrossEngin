# ADR-0363: A guard asking a proxy for its own question

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-13 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0290, ADR-0291, ADR-0299, ADR-0300, ADR-0301, ADR-0307, ADR-0329, ADR-0330, ADR-0331, ADR-0334, ADR-0338, ADR-0351, ADR-0352, ADR-0360, ADR-0362 |

## Context

This is the fifth increment driven by the October register rather than by an ADR's own open
ends, and it takes two items that are one defect seen from both ends: **P2.3** (`proveWideningSafe`
is complete, tested and wired to nothing, so every catalog enum value is standing manual SQL) and
**P0.5** (the live member — `meta.tenants.status` gained `pending_deletion`, so on an upgraded
deployment the Article 17 verify route's `UPDATE` is refused `23514` while the response carries
`tenantReadOnly: false` and the tenant keeps writing into data about to be destroyed).

The class is **a guard asking a proxy for its own question**.

`emitAddTableConstraintIfEmpty` emits `IF count(*) > 0 THEN RAISE`. The question that decides
whether its statement can fail is *does any existing row violate the expression?* Emptiness is a
**sufficient** answer to that and a strictly narrower one — an empty table is one way for the
violation count to be zero — so the guard was asking a question whose "no" is conservative and
whose "yes" is frequently wrong. ADR-0330's reasoning is correct as written: a widening and a
narrowing are indistinguishable *from the expressions*. What it concluded from that is what was
wrong, and it is one sentence away: **the data can be asked.** That is ADR-0330's own move — ask
Postgres rather than imitate its parser — applied one level out, to the rows rather than to the
expression.

ADR-0352 built `proveWideningSafe` and left it callerless, which is the shape ADR-0336 named: a
capability built, tested, documented and reachable by no deployment. This gives it its first
caller.

### The proxy appeared twice in one decision, and the second one was the live one

The guard is in the emitted SQL. The *planner* had its own copy:

```ts
if (rowCount === 0) return { plan: true };          // ← a second proxy
return { plan: false, reason: "constraint_needs_validation" };
```

So `planSchemaReconciliation` decided the same question from the same proxy, one layer up, and
that copy is the one an operator met: a populated table was refused before any proof was
consulted. Finding it was not analysis — the first implementation of this increment kept the
short-circuit and **live arm 3 failed**: a confined session got `replace_column_check`
*planned*, because `rowCount === 0` read a count the session could not believe. Both copies are
gone, and the proof is the only thing that decides.

### A row count is confinable, so the probe must not report one it cannot believe

`probeRowCounts` counted every table in the diff. A count is read through RLS, so on a confined
session it answers 0 for a table holding rows, and `rowCount === 0` then means *empty* or
*hidden* with no way to tell. `probeForReconciliation` asks the confinement **before** counting
and records the table in `confinedTables` instead of a figure it cannot stand behind — which is
ADR-0331's distinction (an empty collection is a claim, an absent entry means nobody looked)
inside a probe.

Three details are stated rather than one, because the remedy differs per case: `rowsPhrase`
renders *"holds N row(s)"*, *"row count not probed"* or *"row count not readable from this
session (row-level security confines it)"*.

## Decision

### The gate is a structural proof, and Postgres is the prover

**This is the increment's own correction, and it is the most important thing in it.** The first
implementation gated the plan on `proveWideningSafe` alone — *does any current row violate the
declared expression* — and that is **strictly weaker than "this is a widening"**. The gap is not
academic, and a read-only adversarial pass demonstrated it on the cluster: live
`CHECK status IN ('a','b','c')` holding `'a','b'`, declared `CHECK status IN ('a','b','d')` — a
*sideways* change. The guard counted 0 violating; a plain `INSERT … VALUES ('c')`, admitted by the
**live** CHECK and needing no DDL, committed inside the window; the `ALTER` then raised. Two
consequences from one missing test:

- A **narrowing or sideways** change was planned silently whenever today's rows happened to
  satisfy it, so ordinary writes the live rule permits begin failing `23514` in production with
  nothing in the plan having said the declaration narrows. That is scope ADR-0330's refusal was
  protecting and that this increment never argued for — its whole motivation is *enum values the
  catalog added*, i.e. widenings.
- It is exactly the sideways case in which the apply-time race is reachable, so ADR-0290's *every
  step in the plan is expected to succeed* became false for precisely the changes that were not
  meant to be planned. The emitted guard's own refusal string asserted the distinction the code
  never tested: *"the declaration is a narrowing, not a widening"*.

**Postgres answers the structural question directly, and that is the fix.**
`predicate_implied_by` is the planner's own prover, and `constraint_exclusion = on` exposes it: a
`SELECT … WHERE NOT (<declared>)` against a table carrying the live CHECK is planned as
`Result / One-Time Filter: false` **iff** the planner can refute `NOT declared` from the live
constraints. `proveDeclarationWidens` asks that, and ADR-0330's rule — *ask Postgres rather than
imitate its parser* — now applies to **implication** as well as to rendering. It needs **no
parsing of either expression**, which is what made the obvious alternative wrong: extracting both
value sets and comparing them is a regex over deparsed CHECK text, which ADR-0352 already refused
having been too narrow once inside its own increment.

It is **strictly stronger than counting**, in three ways, all measured on PG 16.13:

- *No row is consulted*, so an RLS-confined session can still plan a widening. Verified end to
  end: as the `FORCE ROW LEVEL SECURITY` owner of a table it sees 0 rows of, the plan is
  `replace_column_check` — where the row-counting path had to answer `constraint_needs_validation`.
- *The race is unreachable.* Every row the live CHECK admits satisfies the declared one, so there
  is no row an `INSERT` could add that the `ALTER` would refuse.
- *`EXPLAIN` does not execute*, so unlike the count it cannot fire a volatile function in the
  declared expression.

Sound and **incomplete**, in the safe direction: a true widening the prover cannot see answers
`not_implied` and is reported, which is the behaviour that shipped before this increment. Measured
coverage — a value-set widening, narrowing, sideways change and identical expression; a **range**
widening (`n >= 0` → `n >= -1`) and narrowing; a nullable column; an empty table (the proof is
row-independent); and a column with **no** live constraint, which answers `not_implied` because
adding a CHECK where none exists narrows the column's domain by definition.

One edge case closes itself, and it is worth recording because it is the only way a proven
widening could still fail: a live constraint added `NOT VALID` holds of new rows and not
necessarily of old ones. Measured — **the planner declines to use an unvalidated constraint for
exclusion**, so that case answers `not_implied` and the `ALTER` that would indeed have raised is
reported. Postgres is careful for the same reason this needs it to be.

### Two gates, and everything else is reported

`ReconciliationProbe` is four required fields — `rowCounts`, `wideningProofs`,
`wideningImplications`, `confinedTables` — and `proveWidenings` asks **both** questions for every
declared-CHECK difference on an existing table, over `missingColumnChecks`, `changedColumnChecks`
and the table-level CHECKs in `addedConstraints`/`changedConstraints`. The implication is the
**gate**; the proof beside it is the **diagnostic**.

| | plan |
|---|---|
| `live_implies_declared` | planned — structural, no row consulted |
| table empty and the count believed | planned — ADR-0299's rule, kept |
| `violated_by_existing_rows` | `constraint_violated_by_existing_rows` |
| `safe` but not a proven widening | `constraint_widening_unproven` |
| anything else | `constraint_needs_validation` |

Emptiness survives as a **second, independent gate** rather than as an instance of the first, and
with its own reason: a new rule on no data is a decision about future writes alone, and there is
no existing data whose reinterpretation a human needs to approve. It is guarded on
`confinedTables`, because a confined count of 0 is what hidden rows look like.

`wideningProofKey(table, subject, target)` is `` `${table}\0${subject}\0${target}` `` and keys
both maps, with `WideningProofSubject` as `"column_check" | "table_constraint"` — a column and a
table-level constraint can share a name, so a flat key would let one answer the other's question.

### Two new reasons, each earning its place by its remedy

`constraint_violated_by_existing_rows` is its own reason and `constraint_needs_validation` keeps
only the inconclusive arm. The axis is **not** ADR-0322's conclusive-versus-inferred: this is not
an absence read as evidence, it is a count that came back. What the split buys is the one thing a
reason is read for — **the remedy**. The new one sends an operator to the rows; the old one sends
them to a session whose policies do not confine the read, and a re-run from there may well plan
it.

`constraint_widening_unproven` is the correction's reason, and it names **the prover's answer and
never a fact about the expressions**. That is deliberate: `not_implied` covers *the declaration
really does reject values the live one admits* **and** *the implication holds and is outside what
the planner can prove* — the latter true of every pattern CHECK, of which the catalog has **213**.
A reason reading `constraint_narrows_admitted_values` would be a false claim for all of those, and
asserting a fact the code did not establish is the shape ADR-0362 found three times in one
increment. Its remedy is the `DROP`/`ADD` pair, and that is the point rather than a fallback: the
SQL **will succeed**, which is exactly why a plan must not run it unasked — handing it over keeps
a decision about what the deployment accepts with the operator.

`constraint_needs_validation`'s old detail said *"whether every one of them already satisfies it
is not something a plan may assume"*, which is now false of every arm it covers. It can be
asked.

### The emitted guard counts violations, and the emptiness clause is gone rather than kept beside it

`emitAddTableConstraintIfUnviolated` / `emitReplaceTableConstraintIfUnviolated` emit

```sql
SELECT count(*) INTO _ce_violating FROM <fq> WHERE NOT coalesce((<expr>), true);
IF _ce_violating > 0 THEN RAISE EXCEPTION '…% row(s) violate the declared expression…';
```

A second emptiness clause beside it would re-impose exactly the narrowing this lifts: on a table
that gained a *satisfying* row between the plan and the apply, it would refuse a statement that
succeeds.

`coalesce(E, true)` is load-bearing, because **a CHECK passes when its expression is NULL** —
counting `NOT E` would refuse a statement that succeeds for a row whose expression is unknown.
Verified to agree with what `ALTER TABLE … ADD CONSTRAINT … CHECK` validates across 20 of 20
expression shapes on PG 16.13 (`IN` lists, an `IS NULL OR` prefix, ranges, `BETWEEN`, regex
matches, cross-column comparisons) over a table holding a NULL row, a satisfying row and a
violating one.

The guard re-asks at apply time rather than trusting the plan, because a plan is applied a moment
later and a row inserted in between must abort the step rather than slip under a rule nothing
checked it against. `NOT VALID` is still never written: it records a rule the data may violate,
which is worse than not recording it.

### `LOCK TABLE … IN ACCESS EXCLUSIVE MODE`, because the count and the `ALTER` are not atomic

`ACCESS SHARE` (the count) and `ROW EXCLUSIVE` (an `INSERT`) are compatible, and the applier runs
each statement in its own `READ COMMITTED` transaction — so without the lock a row can commit
between the guard's count and the `ALTER`, and the guard would have passed on a table that then
refuses. The lock is in all three guards (both violation forms and both emptiness forms), ahead of
the count. `ALTER TABLE` takes `ACCESS EXCLUSIVE` anyway, so the lock changes the *duration* of a
lock the statement already needs and not its strength.

### `row_security_active` first, and the two guards it protects have different stakes

Every row-counting guard opens with

```sql
IF row_security_active('<schema>.<table>'::regclass) THEN RAISE EXCEPTION '…';
```

A guard counts through an ordinary `SELECT`, which RLS confines. The statement it guards does
not — constraint validation scans every row and a type change rewrites every row — so the fence
and the thing it fences read the table through different lenses, and on a confined session the
fence reads **fewer** rows, which is the direction that admits. Asked of `row_security_active`
rather than composed from ownership and `rolbypassrls`, which is ADR-0362's rule one layer out,
and asked **first**, because a count from a confined session is not evidence and a guard that
acts on it has already lost.

**The stakes are asymmetric, and measuring that corrected this increment's own comment.** Both
arms were run on PG 16.13 as a non-superuser *owner* of a `FORCE ROW LEVEL SECURITY` table with a
deny-all policy, which is the only session that can `ALTER` and still be confined:

- *Constraint guard*: the owner saw **0 of 4** rows, counted **0** violations against
  `kind IN ('a')` on a table holding `'b'` and `'c'`, the guard passed — and the `ALTER` raised
  **`23514 check constraint … is violated by some row`**, so the `DROP` rolled back and the live
  rule survived. Here the assertion converts an opaque mid-`DO`-block failure into a refusal that
  names the confinement and both remedies. Postgres's own validation is the data-integrity
  backstop and it holds.
- *Type change*: the same confined owner counted **0 of 3** rows, the guard passed, and the
  rewrite **applied** — `g2.n` is `text` and all three rows were rewritten. There is no backstop,
  because a type change has no validation pass to refuse it. Here the assertion is the *only*
  thing between a confined session and a successful rewrite of rows it cannot see, which is
  precisely the "migrate the data explicitly" decision the guard exists to enforce.

A non-owner cannot `ALTER` at all (`must be owner of table`), and `TableRls` is
`{enabled, policies}` — so **`FORCE` is not expressible by this catalog**, a stronger bound than a
test could give. An earlier draft of the comment claimed a test pinned it; none does, and the
nearest thing is a sentence of prose in `encryption-writepath.test.ts`. The live member therefore
arrives only through an operator's own `ALTER TABLE … FORCE`, which is exactly the hardened
deployment the fence is for.

### `messageText` escapes `%`, and the escape is a compile-time fence rather than a cosmetic one

A RAISE message is both a single-quoted SQL literal **and** a plpgsql format string. Measured: the
same guard with the `%` unescaped raises **`too few parameters specified for RAISE`** *at
compilation of the `DO` block* — so a `%` in the act does not produce a wrong message, it breaks
the statement before anything is counted, turning a refusal-with-a-count into a hard failure of
the apply step.

Its reach is narrower than it looks and the tests say so rather than implying coverage: a
constraint and a table name are refused by `quoteIdent` first (`SAFE_IDENT_REGEX` is narrower than
Postgres, which accepts both `%` and `'` inside a quoted identifier), so neither character can
reach the RAISE through a *name*. The live position is `emitAlterColumnTypeIfEmpty`'s `type`,
which is interpolated raw here and in the `ALTER` itself because the catalog's types are not
identifiers.

### `_ce_` on the plpgsql variables, because a column of the same name makes every reference ambiguous

Demonstrated: a table with a column `existing` raises
`column reference "existing" is ambiguous`. The violation guard is the first one here whose count
query names the table's own columns, so this moved from latent to live. No catalogued column is
named `existing` or `violating`; the prefix is what keeps that from being load-bearing.

### A conclusive refusal hands over the violator query **alone**

This was a data-integrity defect in the shipped remedy, pre-existing since ADR-0330 and verified
by paste rather than reasoned about. `manualColumnCheckSql` emitted the violator query as a
**comment** and the `DROP`/`ADD` as live statements. Pasted with `psql -f`: the `DROP` succeeded,
the `ADD` raised, the table was left with **zero** CHECK constraints, and
`INSERT … 'ANYTHING_AT_ALL'` was then accepted.

Two fixes, and they are different fixes:

- Both manual-SQL helpers wrap the pair in `BEGIN;` / `COMMIT;`, so a failed `ADD` takes the
  `DROP` with it. Verified: 1 constraint after, the rule still refusing.
- The **conclusive** arm is given `manualCheckViolatorsSql` instead of the pair — the violator
  `SELECT` live and alone, with a comment saying why the pair is not offered. On that arm the plan
  has *asked the rows*, so the `ADD` is proved to fail while the `DROP` would succeed; handing
  over a transaction that is guaranteed to roll back is strictly worse than handing over the
  question. The inconclusive arm still gets the pair, because there the `ADD` may well land.

**And a third site, found by reading what the real binary printed.** `admissionRemedy` emits the
identical unwrapped shape and is printed by **both** boot refusals — ADR-0352's and this
increment's. The two helpers were wrapped and it was not, so the live run of the new refusal
printed a bare `DROP`/`ADD` pair with the fix for exactly that hazard sitting one package away.
That the `ADD` can fail there is not hypothetical from what the survey establishes: `refuses` says
the live constraint rejects a value the catalog declares and says **nothing** about whether every
stored value is in the declared set, so a column narrowed one way and widened the other raises on
the `ADD`. One transaction wraps the **whole** output rather than each pair, because a refusal
naming two constraints wants all of them or none — half-applied leaves the column under a mixture
of rules nobody declared.

### `admissionBlocksValues` — P0.5's boot half, value-granular because the column has two writers

ADR-0352's `admissionBlocks` is column-granular, and for `meta.tenants.status` that is the wrong
grain. Two surfaces write that column and they write **different values**:
`--deletion-request-routes` writes `pending_deletion`, which an un-upgraded four-value CHECK
refuses, while `--tenant-deletion-routes` writes `deleted`, which it admits. Naming the column
would refuse the synchronous Article 17 route for a value it stores perfectly well — ADR-0334's
rule, that a refusal an operator cannot act on for the surface in front of them is worse than
none.

Each returned finding's `refused` list is **narrowed to the values asked about**, because a
caller names a value its own write depends on and a message listing values that surface never
writes sends an operator to the wrong thing. `declaredExpression` is untouched, so
`admissionRemedy` is unchanged: the `ALTER` restores the whole declared domain, because a CHECK is
replaced and never amended.

A `column_absent`, `table_absent` or `unreadable` column does **not** block — those are not in
`survey.refusing` and this inherits that deliberately, on ADR-0334's
`missing`-versus-`unreachable` asymmetry.

### Refuse when the gate reads the value, warn when nothing does

`decidePendingDeletionAdmission` is a pair and not a boolean, in
`apps/operate-server/src/pending-deletion-admission.ts`:

| `--deletion-request-routes` | `--tenant-status-gate` | blocking | effect |
|---|---|---|---|
| off | either | any | `silent` |
| on | either | none | `silent` |
| on | off | yes | `warn` |
| on | on | yes | `refuse_boot` |

`--tenant-status-gate` is the only reader of that column on the request path. With it on, a
refused `pending_deletion` costs the one thing the state exists for. With it off the value is
enforced by nothing either way, and what is lost is a status column an operator and the console
read, a `console.error`, and an honest `tenantReadOnly: false` on the 202 — while the lifecycle
trail records **nothing** rather than lying, because `recordLifecycle` answers `false` when no row
moved, so there is no second record to disagree with the first.

Refusing breaks nothing that worked in either case (ADR-0338's rule: the read-only window has
never held on an un-upgraded deployment). What stops it being a refusal in both is the other half
of that rule — a refusal for a column nothing reads would refuse a deployment whose behaviour the
reported fact does not change.

`PENDING_DELETION_ADMISSION_MAY_SERVE` is a total map rather than `!== "refuse_boot"`, so a fourth
effect is a compile error at the one place that decides;
`pendingDeletionAdmissionMessage` builds both sentences from one shared half so they cannot drift,
and names no remedy of its own because the `ALTER` has one producer.

### The fake answered a key the real statement never returns

Found by the live run and not by this package's 776 unit tests, which is this convention's own fifth member
reproduced **inside the increment that added it**. `EXPLAIN` is a utility statement: its output
column cannot be aliased and cannot be wrapped in a subquery, and its header is `QUERY PLAN` —
with a space. The first draft read `r.rows[0]?.plan`, which is always `undefined`, so every
implication answered `not_implied` and every widening was reported. The unit tests could not see
it, because the fake returned `{ plan }`: **the fake and the code agreed with each other and with
nothing else.**

The code reads the row's **first value by position** now. There is exactly one column, so position
is unambiguous, and it is also robust to a header this code does not control. Both fakes are keyed
`"QUERY PLAN"`, with a comment saying why.

### `proveWideningSafe` loses its `column` parameter

It took one and read it nowhere. This increment's first draft then documented that as "diagnostic
only" at the call site — false twice over: nothing logged it, and a parameter named `column`
invites a caller to believe the verdict is *about that column*, which for a table-level CHECK
spanning three of them it is not. The verdict is about the **expression** and the rows, so the
input names exactly those. Cheap here for a reason that will not come again: the function was
callerless from ADR-0352 until now, so no signature anywhere depended on it. `s.target` survives
as the plan's **lookup key** and is deliberately not an input.

### The exit code does not change, and that is weighed rather than inherited

`crossengin-pg apply` and `crossengin apply` return 1 only on
`!report.preconditions.ok || report.failed > 0`, so an `unreconciled` item exits **0** — including
`constraint_violated_by_existing_rows`, which is the first reason here that no re-run can clear.
"Exit 1 for a difference that will never converge" is a real argument, and the deciding fact is on
the other side: `deploy/docker-compose.yml` gates `api` on `migrate` with
`condition: service_completed_successfully`, so a non-zero exit takes the whole stack down. A
narrowing CHECK on one table is not a reason the API must not serve, and ADR-0331's
machine-readable convergence claim (`remaining.statements.length === 0`) is what a caller that
does care should read. Both sites carry the argument.

### `violatingRows` is not added to `UnreconciledItem`

It has one reader — string interpolation into `detail` — and an optional numeric field nothing
reads is the shape of defect ADR-0360 found in `onApplication`. The figure is in the sentence,
where it is read.

## Consequences

### What this fixes

- **P2.3 is closed.** A widening CHECK is planned on a populated table once **Postgres proves it a
  widening**. Every enum value the catalog has ever added stops being standing manual SQL, which is
  the class found by hand three times (ADR-0300, ADR-0334, ADR-0351).
- **And a narrowing is still not planned**, which is the increment's own correction and the reason
  the gate is structural rather than empirical. A deployment whose catalog narrows a CHECK is
  handed the SQL with a sentence saying what applying it will start refusing.
- **P0.5 is closed on both halves.** The `ALTER` applies through the normal path, and a database
  that has not had it applied yet is reported at boot — refused where the gate reads the value.
- **A pasted remedy can no longer destroy a constraint.** Pre-existing since ADR-0330 and found
  by paste.
- **Two confinement holes closed in the emitted guards**, one of which was a silent successful
  rewrite of hidden rows.
- The emitter's own test file asserted none of this before: `row_security_active`, `confin`,
  `Unviolated` and `violating` each appeared **0** times in `emit.test.ts`. It has 16 more tests,
  including that the confinement assertion precedes the count and the lock precedes both.

### Verified live

Throwaway PG 16.13, as the owner and as a non-superuser non-owner.

**All four arms through the real planner**, on a 3-row table with a live `kind IN ('a','b')`.
Widening (`a,b,c`) → **planned** `replace_column_check`. Narrowing (`a`) →
`constraint_violated_by_existing_rows` with the count. Sideways (`a,c`) with the offending row
removed, so the rows *do* satisfy it → **`constraint_widening_unproven`**, which is the
correction's own arm and was silently planned before it. Confined session, as the
`FORCE ROW LEVEL SECURITY` owner seeing 0 of 2 rows → the widening is **planned**, because the
structural proof consults no row; the row-counting path had to answer
`constraint_needs_validation` there.

**End to end through the real CLI, on the populated catalog with the narrowed CHECK.**
`crossengin-pg apply --plan` → `1 statement(s) to apply: replace_column_check tenants.status
[guarded]`; `--confirm` → 1 executed, 0 failed, exit 0; re-plan → *nothing to do*; and the
`UPDATE meta.tenants SET status = 'pending_deletion'` that was refused `23514` → `UPDATE 1`.

**The boot refusal, from the real binary.** With `--deletion-request-routes` and the gate **off**:
`[catalog] catalog admission: refuses — 540 admitted, 1 refusing`, the `[deletion-request]`
warning naming the value and saying the gate is off, and the server **up**. With the gate **on**:
`fatal:`, exit 1, no listener, and the `ALTER` pair printed — as a transaction, after the third
fix above. After `apply`: `541 admitted, 0 refusing`, **zero** `[deletion-request]` lines, gate
mounted, server up.

**The emitted guard, executed.** A widening applies through it (`LOCK TABLE` inside a `DO` block
works). A narrowing is refused by name with its count and **the live rule survives** — `'b'` is
still storable afterwards, so the `DROP` did not land.

**The confinement assertion, as the only session that can reach it.** As the `FORCE` owner:
`row_security_active` → `true`, rows visible `0` of 4, and the guard refuses by name rather than
counting 0 and proceeding.

**The two stakes.** Constraint path: confined count 0 → guard passes → `ALTER` raises `23514` →
rule survives. Type-change path: confined count 0 of 3 → guard passes → **rewrite applies**, all
three rows rewritten.

**The `%` escape.** Escaped: `to weird%type: table holds 4 row(s)`. Unescaped: `too few
parameters specified for RAISE`, at compile time.

**Cost**, on 200,000 rows: violation count **10.9 ms**, emptiness count 7.0 ms, the `ALTER` it
protects **15.2 ms** — about 70% of the statement it guards, about 4 ms dearer than the guard it
replaces.

**Volatility.** Of **788** catalogued CHECKs (780 column-level, 8 table-level) exactly **three**
call a function at all — `char_length`, `length`, `jsonb_array_length` — all IMMUTABLE, the one
STABLE `length` overload being `length(bytea, name)`, which an unqualified call cannot reach.

### What this costs

- **The guard evaluates the expression per row, and is not fenced by `SET TRANSACTION READ
  ONLY`.** It cannot be: it must run in the transaction performing the `ALTER`, and a read-only
  transaction refuses that — which is where it departs from `check-admission.ts`, whose fence
  ADR-0352 added precisely because evaluating a CHECK fires a volatile function's side effect.
  What makes it acceptable is arithmetic rather than a fence: the `ALTER` validates the same
  expression over the same rows, so a side effect fires **twice instead of once** where the guard
  passes and **once instead of twice** where it refuses. No new class of effect, and a measured
  population of zero.
- **An `ACCESS EXCLUSIVE` lock is now held across the count as well as the `ALTER`.** On a large
  table that is the count's duration added to a lock the statement already needed — 10.9 ms per
  200k rows.
- **A plan is one probe per declared-CHECK difference heavier.** Each is one catalog read plus one
  count. A converged database has zero differences and pays nothing.
- **A confined session now plans strictly less than before.** It used to plan a widening on a
  table it read as empty; it is refused by name instead. That is the intended direction and it is
  a behaviour change for a hardened deployment.

## Open questions

1. **The prover's incompleteness is unmeasured against the catalog.** `not_implied` is two facts
   under one answer, and nothing says how often the second one — *the implication holds and the
   planner cannot see it* — fires in practice. The shapes are known (all 213 pattern CHECKs, and a
   compound expression the prover may not reduce), and what is missing is a census: apply the
   catalog twice, once per version, and count how many declared-CHECK differences the prover
   proves. Until that exists, the honest statement is that a `constraint_widening_unproven`
   finding may be a true widening and an operator cannot tell from the reason.
2. **`proveWidenings` asks both questions for every difference, and the structural one alone
   decides.** The count is pure diagnostic now: it changes `constraint_widening_unproven` into
   `constraint_violated_by_existing_rows`, which is a better sentence and not a different plan.
   Skipping it when the implication proves (where it cannot refuse) would halve the probe's cost,
   at the price of a `--plan` output that cannot say how many rows block a refused narrowing —
   which is the one number an operator needs there. Kept, deliberately, and worth re-weighing if
   the probe shows up in an apply's wall-clock.
3. **The two guards in the emitted statement are now belt-and-braces for a proven widening**, and
   that is slightly dishonest in the comment's direction: a proven widening cannot fail, so its
   count can only refuse if the **live constraint itself changed** between plan and apply — which
   is a real window and a different one from the row-insert window the guard was written for.
   Making the guard say *that* is a one-line comment; making it *check* that is a second probe.
4. **`unknown_unreadable` and `unknown_session_confined` collapse into one reason.** Both land on
   `constraint_needs_validation` and the proof's `detail` carries the difference, so the *reason*
   an operator greps does not distinguish "nobody could read this" from "this session cannot". A
   third reason would, at the cost of a vocabulary entry for a case whose remedy is in the detail
   either way — and the structural gate makes it rarer, since a confined session can now plan a
   proven widening.
5. **`proveWidenings` probes a difference even when the plan will refuse it for an unrelated
   reason.** A `column_check_name_unavailable` difference is reported however the proofs came back,
   so two round trips were spent for nothing. Cheap today (one column in the catalog), and ordering
   the name check first would fix it.
6. **Table-level UNIQUE still uses the emptiness guard**, because the violation question for a
   UNIQUE is *does any duplicate exist*, which is a different query (`GROUP BY … HAVING count(*) >
   1`) and not the same shape; the implication test does not apply to it at all. Vacuous: the
   catalog declares **0** table-level UNIQUE constraints. A foreign key is the same story one step
   further out, since its violation question spans two tables.
7. **A `NOT NULL` tightening is the same class and is untouched.** `column_needs_backfill` and the
   `NOT NULL` arm of a type change still refuse on a row count, and *that* question has an exact
   structural answer too — `WHERE col IS NULL` — so the asymmetry is now visible: a CHECK is
   decided by a proof and a `NOT NULL` by a count. Whether the same treatment is wanted there is
   undecided, and the difference is that a `NOT NULL` has no live predicate to imply from, so it
   is the empirical question or nothing.
8. **`decidePendingDeletionAdmission` is the first of its kind and there are other such pairs.**
   Every value-set column written by a flag-gated surface has the same question, and the honest
   general form is a declaration — *this surface writes these values to that column* — rather than
   a second hand-written decision per surface. ADR-0288's maintained list is the hazard; a rule
   over `pg-column-bindings.ts`' existing extraction is the shape, since it already derives which
   symbol a writer binds into which column.
9. **Nothing surveys whether a *future* enum value will be admitted**, and after this increment
   nothing needs to: the plan converges, so the next release's value lands through `apply` like any
   other difference. What remains unaddressed is the deployment that never runs `apply` — for which
   `surveyCheckAdmission`'s boot census is the answer, and `admissionBlocksValues` is how a surface
   that cannot survive the gap refuses by name.
