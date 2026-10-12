# ADR-0356: The other direction the value moves

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-10 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0355, ADR-0354, ADR-0353, ADR-0352, ADR-0337, ADR-0334, ADR-0333, ADR-0307 |

## Context

ADR-0355 built the eighth workspace rule, `pg-binding-names.ts`, and asked the one question none
of the seven before it asked: **is the value the one the column is for?** A transposition inside a
single `VALUES` list is well-formed SQL naming existing columns with a complete `INSERT`, every
value admitted by its CHECK and carrying the declared domain — so it satisfies every rule above it,
and the only remaining signal is the **names**. A rule over names is possible only because
agreement is this repo's norm: 682 of 764 bindings agree exactly under `snake_case` ⟷ `camelCase`.

Its own first open end states the gap it left:

> the rule covers the **write** path only. A row → record mapping can name a field as wrongly as a
> parameter can, and the verification itself turned up a live member: `ClaimedJob.jobId` is the
> **run** id (`run_id`) while `jobDefinitionId` is `job_id` — consistent across every consumer and
> so not a defect, but exactly the divergence this rule catches on the other side, where nothing
> looks.

The asymmetry is not cosmetic. A parameter and a record field are the two ends of one round trip,
and the write half is the half that has a rule. Every member of this directory's recurring class —
ADR-0333's six defects past the fake connection, ADR-0353's CHECK that refused every value its only
writer emits, ADR-0354's declaration naming a coincidentally-equal domain, ADR-0355's transposition
— is something **a fake `PgConnection` structurally cannot see**, and a read mapping is that blind
spot read a **sixth** way, in the place the fake is at its most useless: it answers
`{rows: [...]}` with whatever the test author put there, so a mapper reading the wrong column of a
correct row returns the author's own fixture value and the assertion they wrote about it passes.

What makes the read side a different problem rather than the same one mirrored: **the write path
knows its table and the read path has to find it.** `pg-column-bindings.ts` derives the column from
the `INSERT`'s own column list, which names the table in the statement. A mapper has a `row`
parameter and an object literal, and nothing in either says which table the row came from — the
`SELECT` is frequently in a different module (`records.ts` holds the mappers,
`campaign-store.ts` holds the SQL), and one store issues `SELECT *`.

## Decision

`packages/testing/src/strategy/pg-record-reads.ts` is the **ninth** workspace rule, and it asks
whether a record field's name agrees with the column it is **read from**.

**The anchor is the catalog, not the SELECT.** A read is `<receiver>.<property>` where the property
is a catalogued column name; the statement that produced the row is never consulted. Measured
before choosing: across the workspace, **every** non-column `snake_case` property — an Anthropic
`stop_reason`, an OpenAI `prompt_tokens`, a `pg_catalog` `rls_enabled` — is absent from the
catalog, so there is **zero collision** between "a column access" and "any other `snake_case`
property access". Anchoring on the `SELECT` was built first and abandoned: it is per-module wrong
(the mapper and the statement are different files), and `installation-store.ts:92` issues
`SELECT *`, which names no column at all.

**The table comes from the declared row interface, by column-set containment.** `resolveRowShapes`
reads every `interface \w*Row` with at least three fields and finds the catalogued tables whose
column set contains all of its catalogued fields; exactly one candidate pins the table. Measured:
**40 interfaces, 26 resolved, 0 ambiguous**, giving a table for **313 of 336** reads. The name
alone would not do, and is ambiguous exactly where it matters: `campaign_id` is one table's
business key and three tables' foreign key, `instance_id` one and four. A field the catalog has no
column of is **tolerated** rather than disqualifying, because that is what a SQL alias looks like
from here — which took the resolution from 18 to 22 before the single-word widening.

**The vocabulary is the write path's, imported unchanged.** `DERIVATION_RULES`, `NAME_DERIVATIONS`,
`camelOfColumn` and `columnOfCamel` come from `pg-binding-names.ts`, because
`admits(column, property, table)` does not care which direction the value is moving: the predicate
that explains writing `record.id` into `widget_id` explains reading it back. A second copy of those
rules would be a second thing to keep in step, and ADR-0355's `derivation_ambiguous` guard — a
derivation's tightness re-asked against the catalog on every run — is inherited with them rather
than restated.

**Three provenances for a row field, settled by reading the SELECTs.** `ROW_FIELD_ALIASES` declares
every row field the catalog has no column of, as a `joined_column` (`c.campaign_id AS
campaign_natural_id`), a `parameter_echo` (the SELECT handing back one of its own arguments), or
`introspection` (a `pg_catalog` row, which has no catalogued table and so no field with a column to
be compared with). One "alias" kind would have conflated a checkable claim with an uncheckable one.
**Declaring an alias puts the read under the rule rather than taking it out**: with
`campaign_natural_id` declared as `access_review_campaigns.campaign_id`, the read
`campaignId <- campaign_natural_id` is compared against `campaignId` and *agrees*.

**Six divergence kinds, settled from the adjudications and not before them.** Thirty-five
divergences went to independent adjudication; the conventions came back under **22 distinct
names**, and these six are what they collapse onto: `nested_record` (6), `record_vocabulary` (2),
`qualifier_differs` (5), `names_the_side` (4), `derivation_unreachable` (2), `field_overloaded` (1)
— **20** declarations covering **23** reads, since a `(file, field, column)` key matches every read
that diverges that way and two of them do so more than once: `job-cancellation.ts` reads
`cancel_requested_at` into `requestedAt` at two sites returning the same outcome record, and
`job-engine.ts` reads `input_redacted` into `input` at three.
`READ_KIND_RULES` is a total map carrying, per kind, what a reader must check to believe a
declaration of it — so a seventh kind cannot land without saying what believing it requires — and a
test asserts every kind has a member, which an earlier draft of ADR-0355 needed because it invented
six kinds first and four had none.

**`field_overloaded` costs a comment on the interface**, which is ADR-0355's `column_overloaded`
rule one side across. It is the one kind that admits a **name** is wrong rather than merely vaguer,
and a declaration living only in this directory leaves the interface — where the next person
reads — still saying the wrong thing. `collectFieldComments` reads the prose above `readonly
<field>:` in all three spellings the repo uses, and the comment must **name the field**.

**Eleven findings, ordered, with the transposition signature first.** `reversed_pair` is the only
one no declaration can resolve: two fields of **one object literal** each reading the other's
column. Grouping is by the enclosing literal's offset and not by proximity, because two sibling
records in one function are not a transposition.

## Alternatives considered

- **Option A: anchor the read on the module's own `SELECT` column list.**
  - **Pros:** it is what the write path does, and it proves the column was projected.
  - **Cons:** the mapper and the statement are in different modules across this repo
    (`access-reviews-runtime-pg/src/records.ts` holds five mappers; the three stores beside it hold
    the SQL), and one store issues `SELECT *`, which names nothing.
  - **Why not:** built, measured per-module wrong, then abandoned on `installation-store.ts:92`.
    The catalog is total where a projection list is not, and the measurement that made it safe is
    that no non-column `snake_case` property in the workspace collides with a catalogued column.

- **Option B: resolve the row's table by column name alone.**
  - **Pros:** no interface scan, no containment join, works for an inline row type.
  - **Cons:** unsound exactly where the derivations matter — `campaign_id` names one business key
    and three foreign keys, `instance_id` one and four, so `business_key` would be answered against
    whichever table was asked.
  - **Why not:** a derivation answered against the wrong table is a *confident* wrong answer, which
    is the failure mode ADR-0354 spent most of an increment removing from its own measurement.

- **Option C: a similarity threshold over the two names, as ADR-0355's Q2 asked for.**
  - **Pros:** would explain many divergences mechanically instead of by declaration.
  - **Cons:** ADR-0355 already refused one on measurement for the write path, and the refusal is
    stronger here, not weaker: **a transposition is precisely a pair of similar names**, so every
    cutoff is unsound rather than merely arbitrary.
  - **Why not:** the two examples ADR-0355's open end offered (`tenant_id ← scope`,
    `created_by ← actor`) appear nowhere in this repo. Exact agreement plus the inherited
    derivations plus declarations is what the measurement supports.

- **Option D: a second copy of the derivation rules, specialised for reading.**
  - **Pros:** the read direction could grow its own rules without touching the write path's.
  - **Cons:** two definitions of one predicate, which is the shape this file has found wrong four
    times (ADR-0288's `needsAuditEmitter`).
  - **Why not:** `admits` is direction-free by construction. `jobId <- run_id` falls out as a
    *declaration* rather than a derivation precisely because `job_runs.run_id` carries only a
    table-level `UNIQUE (tenant_id, run_id)` — the distinction ADR-0355 added
    `CatalogColumn.unique` for, inherited for free.

- **Option E: use a `query<XRow>` generic as authoritative for the field list, not just the table.**
  - **Pros:** would admit single-word-column reads (`status`, `kind`) wherever a store queries with
    a named generic, widening coverage.
  - **Cons:** a generic **names no receiver**, so applying its field list to an unannotated
    receiver can *admit a read that is not one*.
  - **Why not:** the generic is used for the table only, where a mis-attribution can mis-resolve a
    table and cannot invent a read. Measured: 51 of 336 reads learn their type from a generic, and
    bounding its reach found a real mis-attribution — see the implementation notes.

## Consequences

- **Positive:** a record field reading the wrong column of the right type is a test failure. The
  sixth reading of this directory's recurring class is closed, and it is the one where a fake
  connection is at its most useless: a fake hands back the fixture the test author wrote, so a
  mapper reading the wrong column returns the author's own value and every assertion passes.
  **336 reads accounted for four ways** — 305 agree exactly (90.8%), 7 derive, 23 are declared with
  what was read to clear them, 1 is an alias — with **0 unexplained**.
- **Negative:** `RECORD_READ_DIVERGENCES` is the second list in this directory whose entries are
  **judgements about correctness** rather than structural facts, so whether a declared reason is
  true is unverifiable by machine — as it is for all eight siblings, and here as in ADR-0355 the
  reasons are the whole content. The interface scan is a text scan, so a row type behind a method
  return type is out of reach (2 declarations say so by name). The containment join's decisiveness
  **is** re-asked every run — `row_table_ambiguous` fires for any shape carrying three catalogued
  columns that pins no table, and the 0-findings assertion is what makes that a failure — but the
  three-column floor is below it: all **14** unresolved shapes carry **two or fewer** catalogued
  columns (seven are `pg_catalog` introspection rows, the rest contract-shaped projections), so a
  row that lost columns until it fell under the floor would be dropped silently rather than
  reported.
- **Neutral:** of the 35 divergences adjudicated, **2** came back suspicious and **both survived
  adversarial refutation as naming divergences rather than defects**, at severity *cosmetic*; both
  are declared with what was read to clear them. Neither has a reachable wrong value: `attestedAt`
  has no column at all so `decided_at` is the only source the row carries, and every consumer of
  `ClaimedJob.jobId` uses it as a run id.
- **Reversibility:** trivially reversible — delete one module and one test. What is not reversible
  for free is the vocabulary: the six kinds were settled from 35 adjudications, and re-deriving them
  would mean re-reading every divergence against its store, its column and its contract field.

## Implementation notes

**The measurement that bounded the generic's reach.** `job-cancellation.ts` issues
`conn.query<{ run_id: unknown; tenant_id: unknown }>` inline at line 286, and matching **named**
generics alone carried `StateRow` from line 168 onto `reapCancelledJobRuns`' own rows 137 lines
later. It was right there by luck — both resolve to `meta.job_runs` — and a guess either way. The
shipped regex matches `query\s*<` generally and records an anonymous row type **as one**, so a read
after it learns `null`: *the last query in scope had a row type I cannot name* is the honest answer,
and it costs only a derivation that was never available. Cost: `tableResolved` 318 → 313.

**Three defects in my own scan, each caught by a count moving.** Six of the first thirty-seven
findings were a ternary's `:` read as a field named `null`, fixed by requiring a key to sit
immediately after `{` or `,`. Row-to-row copies in test fakes
(`public_key_base64: incoming.public_key_base64`) read as record mappings, fixed by skipping
`snake_case` keys — they are a row being copied, not a mapping into a contract. And **I reproduced
ADR-0354's own bare-name-map defect**: the shape index was keyed by interface name alone while four
stores name their interface plainly `Row`, so a read was handed another table's column list. Caught
because the read count went **down** (349 → 290) rather than by anybody looking; fixed with
`(file, name)` keying plus a uniqueness-gated fallback in both the scanner and `tableForRead`. The
same `\w*Row` rather than `\w+Row` widening is what those four stores needed — requiring a prefix
left exactly them unresolvable and cost the `business_key` derivation 4 of its 9 members while
`resolveRowShapes` had resolved their tables perfectly well.

**A finding that was added, then gated.** `row_type_unknown` was written because
`interface StoredInstanceRow extends StoredCancellationColumns {` was skipped entirely by the
interface regex and three reads off it silently resolved to no table — so the resolution answered
`null` and the derivations were lost without a word. Fixing the regex found two more invisible row
types, whose every read **agreed**, and firing there is noise: a row needing no table is not a gap.
So the finding is gated on a read that actually diverges.

**A fix to the shared parser, found by a sibling rule's phantom output.** `stripComments` in
`pg-column-coverage.ts` — which every rule in this directory uses — paired quotes as string
delimiters without skipping **regex literals**, and a pattern may contain a quote: `"([^"]+)"`
carries three, so pairing them closed the first two and left the third opening a string that ran to
the next quote anywhere in the file. The symptom was phantom domains in `pg-value-set-domains.ts`
once this module landed; the cause was two files away. `statementSpan` there needed the same skip,
because a `{` inside `[{,]` increments its brace depth and is never balanced. One parser is what
keeps two rules from disagreeing about the catalog, and it is also one place for a defect to reach
all nine.

`opensRegexLiteral` is therefore **exported, with three readers**: `stripComments`, `statementSpan`
and this module's own `blankStringBodies`, which had the identical hole. There the direction is
conservative — a blanked region loses a read rather than inventing one — but **19** of the scanned
files put a quote inside a pattern, so the loss was silent rather than theoretical. Fixing it
changed **no count**, which is worth recording so nobody reads it as having recovered a read. Worth
recording too: the heuristic was first written **twice**, once per scanner, and converged only on a
second pass — two definitions of one predicate is the shape this directory has found wrong four
times (ADR-0288's `needsAuditEmitter`), committed inside the increment whose whole argument is that
one vocabulary should serve both directions.

**The two surviving adjudications.** Both were sent to adversarial refutation, and both stand as
divergences with severity *cosmetic*.

`attestedAt <- decided_at` (`access-reviews-runtime-pg/src/records.ts:200`) is a **derivation with
no column**: `meta.access_review_decisions` carries `attestation_kind`, `_signature_sha256`,
`_signing_key_fingerprint`, `co_attesting_user_id` and `co_attested_at` and no
`attestation_attested_at`, and the writer binds neither `att.attestedAt` nor
`att.attestationPhrase` (23 columns against 23 params, both absent). What makes it weaker than its
neighbour `attestedByUserId <- decided_by_user_id` is that nothing *enforces* the equality:
`AccessReviewDecisionSchema.superRefine` fixes `decidedByUserId === attestation.attestedByUserId`
and constrains `timeBoundExtendUntil` and `appliedAt` against `decidedAt`, and says nothing about
`attestedAt`. So one derivation is recoverable from the contract and this one rests on producer
behaviour — `buildRevokeDecision` sets both from one `nowIso`, and every construction site in the
workspace does the same. The honest location of the gap is `decision-store.ts` (an unbound field
with no column) and `decisions.ts` (a missing refinement), not the read.

`jobId <- run_id` (`workflow-runtime-pg/src/job-claim.ts`) is the member that prompted the rule and
the one `field_overloaded`. It is **not** the transposition signature by this rule's own criterion:
`run_id` is UUID and `job_id` is TEXT, so the declared types separate them — the same criterion
ADR-0355 shipped because the declared type is what separates two similar names. The round trip
closes on the **value** and not on the name: every consumer uses it as a run id (`executeJobRun`,
`renewJobClaim` and `releaseJobClaim` all filter `WHERE run_id = $1`; `observeJobCancellation`
takes `{runId: jobId}`), the engine never trusts the handle for the definition id (`executeJobRun`
re-reads `job_id` from the row it just locked), and `ClaimedJob.jobDefinitionId` has **no consumer
at all** — so the field that could have been swapped is dead and no site reads both. The asymmetry
is across the two paths: `EnqueuedJobRun.jobId` binds `job_id` while this reads `run_id`, one
property name meaning two columns in one package, and `ClaimedJob` is the sole holdout against its
own package's settled vocabulary. Both interfaces declaring it now carry the comment the kind
charges.

**Verified live as a non-owner on PG 16.13** (`app_user`, `rolbypassrls = false`, `meta.job_runs`
owned by `app_owner` with RLS enabled), because the rule's whole claim is about what a mapper really
returns. 964/964 statements applied with a clean re-plan, then `claimDueJobs` through the real
`createNodePgConnection` binding inside one transaction:

| probe | answer |
|---|---|
| `claimed.jobId` | `22222222-2222-7222-8222-222222222222` — a **UUID**, the run id |
| `claimed.jobDefinitionId` | `close-period` — the declaration id, `job_id` |
| `WHERE run_id = claimed.jobId` | **1 row**, whose `job_id` is `close-period` |
| `WHERE run_id = claimed.jobDefinitionId` | `22P02 invalid input syntax for type uuid: "close-period"` |
| `EnqueuedJobRun.jobId` binds `job_id` = | `close-period` |
| `ClaimedJob.jobId` reads `run_id` = | `22222222-…` |

The last two rows are the finding in two lines: **one property name, two columns, two interfaces,
one package**, and the fourth row is why it is not the transposition signature — the declared types
separate them and the database refuses the swap outright. And
`meta.access_review_decisions` live carries `attestation_kind`,
`attestation_signature_sha256`, `attestation_signing_key_fingerprint`, `co_attested_at` and
`decided_at` and **no `attestation_attested_at`**, which is the premise the `attestedAt`
declaration rests on, asked of the applied schema rather than of the catalog source.

**The floors are one-sided and on the checked side**, for `pg-unreachable-stores.ts`' reason: a
scan that stopped matching would report everything unexplained, and over-reporting is the direction
that fails CI on correct code. Two **live controls on the real tree** rather than fixtures: an
agreeing read repointed at a same-type sibling of its own column yields
`field_reads_sibling_column` (the transposition's *half*, which no pair check would catch), and two
agreeing same-type reads of one literal swapped yields `reversed_pair`.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `attestation.attestedAt` has a producer and no enforcement — a `superRefine` pinning it to `decidedAt` would break nothing today, which is the cheapest moment it will ever have | Platform | 2026-11-30 |
| `ClaimedJob.jobId` could simply be renamed `runId`, since `jobDefinitionId` has no consumer and nothing serializes the handle | Platform | _N/A_ |
| 21 reads carry no row type at all and 2 carry one no interface was found for, so 23 of 336 reach no derivation — closing that is ADR-0337's refused compiler-API answer for the third time | Platform | _N/A_ |
| Nothing compares a field against a column's *meaning*, only its name — `record.kind` read into a property called `status` passes if `status` is the column | Platform | _N/A_ |
| `stripComments` is shared by all nine rules and was wrong about regex literals for four increments; nothing fences the shared scanner against its own output | Platform | _N/A_ |
| All 14 unresolved row shapes sit *below* `row_table_ambiguous`' three-column floor, so a row that lost columns until it fell under that floor would be dropped silently | Platform | _N/A_ |

## References

- ADR-0355 — the write path's name rule, whose Q1 this closes; `DERIVATION_RULES` and the
  `snake_case` ⟷ `camelCase` transform are imported from it unchanged.
- ADR-0354 — `pg-column-bindings.ts`, whose extraction this rule does **not** reuse: a binding is a
  parameter and a read is a property access, so there is no shared extractor, only a shared
  vocabulary.
- ADR-0353, ADR-0352 — the catalog-domain and live-admission halves of the same question.
- ADR-0337 — the compiler-API measurement, refused twice before and inherited here.
- ADR-0333 — the fake-connection boundary this rule reads a sixth way.
- ADR-0307 — the pure-function/IO split that puts `collectFieldComments` outside the audit.
