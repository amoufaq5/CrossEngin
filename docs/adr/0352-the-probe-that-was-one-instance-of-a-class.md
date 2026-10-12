# ADR-0352: The probe that was one instance of a class

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-09 |
| **Authors** | platform |
| **Reviewers** | platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0288, ADR-0292, ADR-0299, ADR-0300, ADR-0322, ADR-0330, ADR-0334, ADR-0336, ADR-0349, ADR-0351 |

## Context

ADR-0351 added a boot probe for one column and said, in its own open questions, that the column was
never special:

> The probe reads one CHECK on one column. Every other catalogued CHECK the contract widens has the
> same sharp edge and no probe, so this is one instance of a class — a general "does the live catalog
> admit what this binary emits" boot survey is the shape.

The sharp edge is ADR-0330's. A **widening** CHECK cannot be told from a **narrowing** one from the
expressions, so `planSchemaReconciliation` refuses to plan one against existing rows and reports
`constraint_needs_validation` with the SQL instead. The consequence is that **every enum value the
catalog has ever added is refused `23514` on every already-applied deployment until an operator runs
that `ALTER` by hand**, and nothing says so until a write fails.

That is not hypothetical and it is not rare. Three increments added a value to a catalogued CHECK and
each left the same standing manual SQL behind: ADR-0300 found `meta.feature_flags` three flag kinds
behind its contract, ADR-0334 added `pending_deletion` to `meta.tenants.status` (and the catalog's own
comment on that column spells the whole problem out — *"Widening a CHECK is not a tightening and
cannot fail against existing rows, but `planSchemaReconciliation` cannot tell the two apart"*), and
ADR-0351 added `'v4'` to `meta.tenant_tombstones.proof_version`, where the refusal lands inside the
Article 17 pipeline's transaction *after the tenant's data has been deleted*. Three members, three
discoveries by hand, nothing checking.

### The class, measured

Read from the built catalog objects rather than from the source text, which matters: a single-line
`grep` for `check: "…"` finds **66** value sets and the real figure is **287**, because Prettier wraps
a long declaration onto the line after `check:` and because `check?: string` is a field on
`RlsPolicy` as well as on `ColumnDefinition`. The catalog's own comment in `column-check.ts` says 761
and that is stale too. Count the objects.

```
777  column-level CHECKs the catalog emits (8 table-level constraint CHECKs besides)
287  value sets — `col IN (…)`, over 123 tables, 242 distinct value lists, 29 with an `IS NULL OR` prefix
263  bounded ranges — `col >= N` (194), `col BETWEEN A AND B` (58), `col > N` (11)
213  pattern matches
 13  compound, cross-column or function-wrapped, which no candidate can be derived from
```

Only one value set is numeric (`meta.rate_limit_policies.response_code IN (429, 503)`) and only one
is written as an equality (`meta.webhook_endpoints.signing_algorithm = 'hmac-sha256'`) — both are in
the class and both defeat a naive parser, which is why they are named.

## Decision

**A general admission survey in `kernel-pg`, run at boot, that asks the live database to evaluate its
own CHECK against every value the catalog declares.** Six parts, each of which was measured rather
than reasoned.

**1. It evaluates the live predicate and never reads it.** ADR-0351's probe matched the deparsed
constraint text with a regex, and that regex was too narrow inside the same increment: Postgres
renders one `CHECK (col IN (…))` two ways depending only on the column's declared type.

```
TEXT     CHECK ((proof_version = ANY (ARRAY['v1'::text, …])))
VARCHAR  CHECK (((proof_version)::text = ANY ((ARRAY['v1'::character varying, …])::text[])))
```

A general survey cannot afford a per-spelling regex, so it asks instead:

```sql
SELECT probe.ord, coalesce((<live expression>), true) AS admits
  FROM (VALUES ($1::int, $2::TEXT), …) AS probe(ord, <column>) ORDER BY probe.ord
```

This is `expression-render.ts`' habit of asking Postgres rather than imitating its parser, and it is
total over every shape: one mechanism answers for a string `IN` list, an integer `IN` list, a regex,
a range and both deparse spellings. `coalesce(E, true)` is not decoration — **a CHECK passes when its
expression is NULL**, and a consequence worth recording is that `col IS NULL OR col IN (…)` and
`col IN (…)` are therefore equivalent *as constraints*, so the prefix on 29 catalogued checks is
redundant rather than meaningful.

**2. The declared side is parsed, because it has one spelling.** The asymmetry is the whole reason
the design works: the catalog's expression is text this repository wrote, in shapes this repository
chose, so classifying it is safe — while the live side is Postgres's rendering, which is not.
`CHECK_SHAPES` is five members and `CHECK_SHAPE_COVERAGE` is a **total map** over them, so a sixth
shape is a compile error until it says what its candidates are worth. The distinction it carries is
not cosmetic:

- `value_set` → **complete**. The declared list is every value the column can hold, so asking all of
  them and getting `admits` is a *proof* that no write this catalog permits is refused.
- `bounded_range` → **probe**. The declared boundary is the one candidate the expression yields, so a
  refusal is conclusive and a pass is not — a live `col <= 100` added beside the declared `col >= 1`
  refuses 101 and admits 1, and this survey calls that `admits`.
- `pattern` / `session_setting` / `unclassified` → **none**, each with its reason.

**3. A candidate is cast to the catalog's declared type, through an allow-list.** Measured:
`$1::character varying(8)` with a 12-character value whose first 8 characters are in the list answers
`admits = true` while the real `INSERT` raises `22001 value too long` — so a cast carrying the type's
modifier makes the survey answer "admitted" for a value the database refuses. Dropping the modifier
is not uniformly safe either: `numeric(12,6)` → `numeric` widens, but `character(3)` → `character`
**narrows to one character** (`'abcdef'::character` is `'a'`, measured), so a candidate cast through
it is silently a different value. `UNCONSTRAINED_WITHOUT_MODIFIER` is therefore an allow-list of four
base types, a trailing modifier on anything else is refused, and an **infix** modifier is refused
outright because a suffix strip would turn `timestamp(3) with time zone` into `timestamp(3) with
time`, which is not a type. All 73 refusals are on checks with no candidates today, so the rule costs
nothing — which is when it is cheap to make.

**4. The evaluations run inside `SET TRANSACTION READ ONLY`, with a savepoint each.** A CHECK
expression can call a volatile function, and evaluating it **fires the side effect** — demonstrated
with a CHECK calling a function that inserts a row, which inserted the row. The expression comes from
the database's own catalog rather than from a caller and it already runs on every write, so this is
not a new capability; but a survey that evaluates 540 of them on every boot is executing arbitrary
catalog code, and that deserves a fence. `SET TRANSACTION READ ONLY` blocks it (`25006`) and costs
the legitimate evaluations nothing, set as the first statement inside the existing `transaction()`
seam so `PgConnection` needed no change. A savepoint per constraint is what keeps one hostile or
type-drifted constraint from aborting the batch: a column whose live type has drifted raises `42883`
and reads `unevaluated`, which is weaker than `admits` by construction.

**5. It reports and never refuses; a surface names its own column.** This is the departure from
ADR-0351's probe, and the reason that probe is **deleted** rather than kept beside it. The survey
cannot know which values a surface emits, so refusing for a column nothing writes would refuse a
deployment that works — ADR-0334's reason `--tenant-status-gate` is opt-in. A surface that knows its
own write is load-bearing calls `admissionBlocks` with its column, next to the code that needs it,
which is a derived condition where a list of fatal columns inside the survey would be ADR-0288's
hand-maintained list. ADR-0351's deletion-pipeline refusal is the one such caller today and it is
that whole probe re-expressed over this survey — two spellings of one question being the shape of
defect this repository keeps finding.

**6. The widening proof, and the trap it exists for.** `proveWideningSafe` answers whether replacing
the live CHECK with the declared one can fail against the rows already there — the half ADR-0330 says
the planner cannot know, answered by asking the data rather than the expressions. **The count is
RLS-confined**, which is the whole reason the function is not three lines: measured with one
violating row present, the owner counts 1 and a non-owner with no tenant context counts 0, while the
`ALTER` genuinely raises `check constraint … is violated by some row`. A survey that answered from
that count would hand an operator SQL that fails. So the confinement is asked of the catalog
(`relrowsecurity` / `relforcerowsecurity` / ownership / `rolbypassrls`) rather than inferred from the
count — `probeJobQueueVisibility`'s reason, that zero rows and no visible rows are the same
observation — and a confined session gets `unknown_session_confined` instead of a claim. Third place
this class has been found; ADR-0330's erasure and ADR-0349's rekey are the other two.

## What the planner already says

Measured on one database, with `meta.tenants.status` narrowed by hand and one row in the table.

`crossengin apply --plan`:

```
  1 difference(s) left alone:
      [constraint_needs_validation] tenants.status
ALTER TABLE "meta"."tenants" DROP CONSTRAINT "tenants_status_check";
ALTER TABLE "meta"."tenants" ADD CONSTRAINT "tenants_status_check" CHECK (status IN ('active', 'suspended', 'archived', 'pending_deletion', 'deleted'));
```

The survey, same database:

```
meta.tenants.status refuses ["pending_deletion"]  widening=safe rows=0
    ALTER TABLE "meta"."tenants" DROP CONSTRAINT "tenants_status_check";
    ALTER TABLE "meta"."tenants" ADD CONSTRAINT "tenants_status_check" CHECK (status IN ('active', 'suspended', 'archived', 'pending_deletion', 'deleted'));
```

**The SQL is byte-identical**, which is worth stating plainly: the survey adds nothing to the remedy,
and `admissionRemedy` independently reproducing what `reconcile.ts` hands over is a convergence
rather than a second spelling. What it does add is four things the plan does not carry: it runs **at
boot in the serving binary** rather than in an invocation an operator must choose to run; it names
**which value** is refused, so the consequence is legible (*a write carrying `pending_deletion` is
refused 23514*) where `constraint_needs_validation` says only that something differs; it proves the
widening is **safe against the rows that are actually there**, refusing to make that claim from a
confined session; and it lets a surface refuse on its own column. On an **empty** table the planner
plans the replacement outright (`replace_column_check … [guarded]`), so the gap is specifically the
populated deployment — which is every deployment that has ever served a request.

## Alternatives considered

- **Option A: generalise ADR-0351's regex over the deparsed text.**
  - **Pros:** no SQL execution at all, so no read-only fence and no volatile-function question; and it
    is the mechanism already shipped, so it is the smallest diff.
  - **Cons:** the regex was already too narrow once within its own increment, and the two spellings
    measured above are both real for one declaration. Worse, it only answers for `IN`-shaped checks —
    a regex over a regex CHECK or a range CHECK yields nothing — so the generalisation would cover 287
    of 550 probeable checks and would need a parser per shape to cover the rest.
  - **Why not:** the failure mode is silent and in the permissive direction. A spelling the regex
    cannot read answers `unreadable`, which *mounts*, so the `23514` stays exactly where it was behind
    a warning. Asking Postgres is total over shapes and spellings and costs one savepoint.

- **Option B: reuse `diffColumnChecks` and report a CHECK whose rendering differs.**
  - **Pros:** the machinery exists, is tested, and already runs on every `apply`; no new query at all.
  - **Cons:** ADR-0292 records that two logically equivalent predicates written differently deparse
    differently, so the rendering comparison has **false positives** — acceptable in a plan an
    operator reads, and not at boot, where a false positive is a loud warning about a database that is
    correct. And it answers *differs*, not *which value is refused*, which is the actionable half.
  - **Why not:** it is the right detector for the shapes this survey cannot derive a candidate from,
    which is why those are reported `not_probeable` with `diffColumnChecks` named as their cover
    rather than being answered badly here.

- **Option C: refuse the boot on any refusal.**
  - **Pros:** the strongest possible statement, and symmetrical with ADR-0351's probe.
  - **Cons:** measured, a narrowed CHECK on a column nothing in the deployment writes is harmless, and
    refusing would refuse a deployment that works today. `meta.job_runs.status` is the live
    illustration: ADR-0334 added `dead-lettered` and `cancelled` to it, so a deployment that upgraded
    past ADR-0334 without running the manual `ALTER` has a job fleet that cannot dead-letter — which
    matters if `--workflow-workers` is mounted and is inert if it is not, and the survey cannot tell.
  - **Why not:** ADR-0334's reasoning for `--tenant-status-gate` being opt-in, applied to a census.

- **Option D: a declared list of columns whose refusal is fatal.**
  - **Pros:** it would let the survey refuse precisely and by itself.
  - **Cons:** 287 value sets, each needing a judgement about whether anything emits it — and the
    judgement belongs to the surface that writes the column, not to a list in `kernel-pg`. This is
    ADR-0288's `needsAuditEmitter` exactly, which was wrong three times.
  - **Why not:** `admissionBlocks` gives the same outcome as a derived condition. A surface that
    writes a column names it where the write is.

- **Option E: also check the catalog's value list against its contract enum.**
  - **Pros:** it is the *upstream* half of the same sentence — "does the live catalog admit what this
    binary emits" — and a defect there ships in the artifact rather than being a migration state.
    ADR-0300 and ADR-0334 were both found there, by hand.
  - **Cons, measured:** of the 287 value sets, **258** match a workspace `as const` array exactly;
    **17** of those match more than one array, so value-matching cannot identify the contract
    uniquely; and of the 5 with only a strict superset, two are **deliberate** narrowings
    (`gateway_idempotency_records.method` is the mutating methods only; a digest row cannot carry
    `immediate` or `never`) that are indistinguishable from a stale one without a per-column
    declaration. So a derived rule reports deliberate narrowings as defects and a declared one is 287
    hand-written links.
  - **Why not:** out of scope on that measurement, not on size. It is the top open question, and the
    census turned up two real findings that are recorded there.

- **Option F: take a whole `LiveSchema` from `introspectSchema`.**
  - **Pros:** maximum reuse; the survey reads exactly what the drift check reads.
  - **Cons:** six queries including indexes and policies the survey does not use, on every boot.
  - **Why not:** taken **in part**, which is the better half of it. The survey imports
    `CHECK_CONSTRAINT_QUERY` and `COLUMN_QUERY` verbatim and adds no SQL of its own for the catalog
    read, so the two cannot disagree about what the database holds, and it pays for two queries rather
    than six.

## Consequences

- **Positive.** The class has a detector. Verified live as a **non-owner** on PG 16.13 against the
  real applied catalog: a clean database reports `540 admitted, 0 refusing, 0 unconstrained, 237 not
  probeable, 0 absent, 0 unreadable` in **269 ms**, and five hand-made narrowings are each caught by
  the right verdict —

  | narrowing | verdict |
  |---|---|
  | `tenant_tombstones.proof_version` loses `'v4'` (ADR-0351's own defect) | `refuses ["v4"]` |
  | `tenants.status` loses `'pending_deletion'`, column altered to `VARCHAR` (ADR-0334's defect, in the deparse spelling that defeated ADR-0351's regex) | `refuses ["pending_deletion"]` |
  | `rate_limit_policies.response_code` loses `503` (the one numeric value set) | `refuses ["503"]` |
  | `incidents.revision` raised to `>= 2` (a range boundary) | `refuses ["1"]` |
  | `api_keys.status` constraint dropped entirely | `unconstrained` |

- **Positive.** The survey works as a non-owner, which the widening proof does not — the catalog reads
  are not policy-confined and the evaluation touches no table rows. That asymmetry is why the two are
  separate functions with separate verdict vocabularies.
- **Positive.** `sessionWouldBeConfined` has one definition now. The rule had **eight** spellings in
  the workspace and the only one that reads `relforcerowsecurity` — the single input that overrides
  ownership — was private to `KeyRotationMigrator.commonRefusals`. Every other copy infers confinement
  from ownership alone and would let a `FORCE ROW LEVEL SECURITY` owner through. Nothing sets that flag
  today, so the divergence is latent, which is when converging it is free.
- **Negative.** 269 ms added to every boot under a Postgres store, unconditionally. It is 540 queries
  in one read-only transaction and it cannot be deferred, because the thing it reports is true of the
  deployment before the first request.
- **Negative.** `bounded_range`'s pass is a probe and not a proof, and the survey's own counts do not
  separate the two — `540 admitted` is 287 proofs and 253 probes. The coverage map says which is
  which; the headline does not.
- **Neutral.** The remedy duplicates nothing: it is the same SQL `reconcile.ts` hands over, produced
  independently, and a test pins its shape.
- **Reversibility.** High. Nothing about the catalog or any stored record changed; the survey reads and
  the one refusal it drives is ADR-0351's, which already existed.

## Implementation notes

- `packages/kernel-pg/src/check-admission.ts` — the classifier (pure), the survey, the widening proof,
  `admissionBlocks`, `admissionRemedy`, the formatter. 57 tests, offline against a fake `PgConnection`
  whose fallback arm **throws** (ADR-0350's rule): an empty `{rows: []}` would read as `table_absent`
  for a statement whose shape later changed, so every assertion about what the survey *found* would
  pass vacuously while reporting that the catalog had not been applied.
- `packages/kernel-pg/src/introspection.ts` — `SessionPolicyVisibility`, `sessionWouldBeConfined`,
  `probeSessionPolicyVisibility`. Only the **rule** moved; the queries stay at each call site, because
  `commonRefusals` wants `has_scope_column` in the same round trip and its comment says why. A shared
  query would carry every caller's columns or cost a second statement.
- `apps/operate-server/src/proof-version-probe.ts` and its test are **deleted**. The refusal it carried
  is seven lines in `node.ts` over `admissionBlocks`, and keeping both would be two mechanisms for one
  question. Its `index.ts` export is gone with it.
- The survey runs under `conn !== undefined` — so unconditionally on a Postgres store and not at all on
  `--store memory`, where there is no catalog to ask. Deliberately **not** behind a flag: the fact it
  reports is true whether or not any surface is mounted to meet it, and a flag would let a deployment
  turn the census off and still be refused at the first write.
- A test caught one real gap in the module rather than in itself: the `unevaluated` detail reported the
  error's prose and dropped its SQLSTATE, and the code is the actionable half — `42883` says a column's
  live type has drifted from the declared one and `25006` says the read-only fence caught a CHECK trying
  to write. `firstLine` carries it now.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The **contract → catalog** half is unbuilt, and it is the upstream one: a value the contract can emit that the catalog's CHECK refuses ships in the artifact rather than being a migration state. The census found two real ones, both latent because their tables are writerless — `REPORT_ENGINES` is `["postgres","clickhouse","auto"]` and `BaseReportSchema` **defaults to `"auto"`**, which `meta.report_runs.engine`'s CHECK refuses; and `DIGEST_FREQUENCIES` has six members against `meta.notification_digests.frequency`'s four. A rule needs the contract link *declared* per column, because 17 value sets match more than one `as const` array and two of the five superset candidates are deliberate narrowings. | platform | — |
| Now that a widening can be **proved** safe against the rows present, `planSchemaReconciliation` could plan it instead of reporting `constraint_needs_validation` — which is ADR-0330's open end closed rather than merely measured. It needs the proof re-checked inside the statement's own transaction, which is the `DO`-block pattern `replace_column_check` already uses for emptiness, and it must refuse on a confined session exactly as this survey does. | platform | — |
| `meta.job_runs.status` is reported and not refused, and whether that is right depends on `--workflow-workers` being mounted — which `node.ts` knows and the survey does not. A second `admissionBlocks` caller there would close it, and the same question applies to every surface that writes a value-set column. | platform | — |
| 11 checks are a strict `> N` bound and yield no candidate, because the smallest value such a bound admits depends on the column type's granularity. 213 patterns yield none either. Both are `not_probeable` with `diffColumnChecks` named as their cover, and a generator for an integer `> N` would close the first group cheaply. | platform | — |
| `sessionWouldBeConfined` converged two call sites of eight. The other six (`api-gateway-pg`'s idempotency store and replayer, `workflow-runtime-pg`'s replayer and job claim, `ai-architect-runtime-pg`'s inflation store, `tenant-lifecycle-pg`'s shared-table erasure, plus `operate-server`'s ciphertext probe and `replay`) each infer confinement from ownership without reading `relforcerowsecurity`. Mechanical, and latent until something sets that flag. | platform | — |
| The survey's headline count does not separate a proof from a probe, so `540 admitted` reads stronger than it is for the 253 range checks. Splitting the count is cosmetic; deciding whether a range probe is worth reporting at all is not. | platform | — |
| `admissionRemedy` reuses the **live** constraint name in its `ADD`, which is right for a remedy an operator pastes and wrong for a database whose constraint an operator renamed by hand outside Postgres's naming family — there the added name perpetuates the rename. `column-check.ts` solves name prediction for the reconciler and this deliberately does not use it. | platform | — |

## References

- ADR-0330 (a widening CHECK cannot be told from a narrowing one; `constraint_needs_validation`),
  ADR-0292 (asking Postgres to deparse rather than writing a SQL parser; the rendering comparison's
  false positives), ADR-0351 (the one-column probe this generalises, and its Q5).
- ADR-0300, ADR-0334 (two earlier members of the class, each found by hand).
- ADR-0288 (the hand-maintained list, wrong three times), ADR-0322 (a surface that degrades rather than
  refusing has to say so), ADR-0334 (converting a run-time failure into a boot refusal; the
  `missing`-versus-`unreachable` asymmetry), ADR-0349 (`rls_would_confine_this_session` on the rekey),
  ADR-0350 (a fake's fallback arm should throw).
- PostgreSQL: `pg_get_expr`, `pg_constraint.conkey`, `format_type`, `SET TRANSACTION READ ONLY`,
  SQLSTATE `23514` / `22001` / `25006` / `42883`.
