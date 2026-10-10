# ADR-0355: The name that was the only signal

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-10 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0356, ADR-0354, ADR-0353, ADR-0352, ADR-0337, ADR-0336, ADR-0335, ADR-0334, ADR-0333, ADR-0330, ADR-0307, ADR-0288 |

## Context

ADR-0354 derived, per catalogued column, the workspace **symbol** its SQL binds, and compared that
symbol against `VALUE_SET_DOMAINS`' declared domain. Its own first open end named what that
comparison cannot see, and said so with the example:

> the comparison is against the **symbol** and nothing compares it against the parameter
> *position*: a store writing `record.kind` into the `status` column passes this rule and
> `pg-column-coverage.ts` both. Column-to-property name agreement is measurable and legitimately
> violated often enough (`tenant_id` ← `scope`, `created_by` ← `actor`) that the threshold needs
> deciding before it can be a rule.

Every rule in `packages/testing/src/strategy/` asks whether the column exists
(`pg-column-coverage.ts`), whether the statement names every required column (the same), whether a
live database admits the values (`check-admission.ts`, ADR-0352), whether the catalog's CHECK and
the contract's enum enumerate the same members (`pg-value-set-domains.ts`, ADR-0353) and whether the
declaration names the symbol the writer binds (`pg-column-bindings.ts`, ADR-0354). None asks whether
the value is the one the column is **for**. A transposition inside one `VALUES` list satisfies all
five: the SQL is well-formed, the columns exist, the `INSERT` is complete, both values are admitted
by their CHECKs, and both symbols are the declared domain — because in the live member it is the
*same* domain on both sides.

The one signal left is the names. This repo spells a column `snake_case` and its contract field
`camelCase`, and that single transform is a rule, not a coincidence — so the question the open end
asked is answerable, and the threshold it asked to have decided is a measurement.

## Decision

An eighth workspace rule, `packages/testing/src/strategy/pg-binding-names.ts`, asks whether a
column's name agrees with the name of the value bound into it. It consumes ADR-0354's extraction
rather than scanning again — **one extractor, two questions** — and every binding is accounted for
one of four ways:

1. **Agreement**, `camelOfColumn(column) === property`. **682 of 764** bindings, which is what makes
   the rule worth having: a divergence is exceptional and so can be made to carry a reason.
2. A **derivation**, of which there are exactly **two** (25 bindings), each stating why it is
   principled *and* why it is tight — and whose tightness is **re-asked against the catalog on
   every run** rather than trusted from a measurement taken once.
3. A **declaration** in `BINDING_NAME_DIVERGENCES` carrying what was read to decide it writes the
   right value. **28** of them, covering 32 bindings.
4. A **literal**, which carries no name to compare (25), or a column the catalog does not declare
   (**0**).

Anything else is a finding. Two of the nine finding kinds are the transposition signature itself,
and `transposed_pair` is the one no declaration can resolve.

The threshold the open end asked for is therefore **not a similarity score**. It is exact agreement,
plus two derivations that are rules, plus a declaration per exception. Four plausible generalisations
of those derivations were measured and refused, and the measurement that refuses each is kept beside
it in `REFUSED_DERIVATIONS` so nobody reaches for it a second time.

**All 28 divergences were adjudicated and none was a defect.** Each was read against the store, the
catalogued column and the contract field; the two that read as suspicious afterwards were handed to
an independent pass asked to refute them, and **both were dismissed on facts the first reading had
not established**. Those facts are now the notes.

## The derivations, and the four refused

**`business_key`** (16 bindings) — `property === "id"` ∧ the column ends `_id` ∧ the column carries
a **column-level UNIQUE** ∧ the column **references nothing**. Every catalogued table carries the
house two-identifier shape: a UUID surrogate `id` with a `uuid_generate_v7()` default, and a TEXT
business key `<prefix>_id` with a single-column UNIQUE and an id-prefix CHECK. The contract that owns
the record calls its own identity `id`, so `campaign.id` lands in `campaign_id`. Measured: **72**
tables declare exactly one such column, **74** declare none, and **none declares two** — so
`record.id` has at most one place to land.

**`resolved_surrogate`** (9) — the column ends `_id` and the property is
`` `${camelOfColumn(noun)}Uuid` ``. The contract names a row by its business id and the column holds
the referenced row's UUID surrogate, so the store resolves one to the other through a
`*UuidResolver`. The noun is on both sides, so the property names its own column and no other.

The four refused, each with its count:

- **`*_id` ← `id` for any column with no foreign key** — i.e. `business_key` without the UNIQUE.
  **72 of 146** tables have more than one non-FK `*_id` column, `meta.tenant_tombstones` has four
  and one has eight, so it would admit a record's own id into any of them. The UNIQUE is the whole
  content of the derivation, and the catalog already declares it.
- **the property is a camel-boundary suffix of the column name** — `id` is a suffix of **11**
  columns of `meta.workflow_events` and `at` of **4** of `meta.notification_deliveries`, so it
  admits exactly the transposition the rule exists to catch.
- **a shared leading token of four characters or more** — **138** bound properties would be
  admitted into more than one column of their own table.
- **"the property names a different column of the same table", as a bare detector** — it fires on
  **17** bindings of which **16** are the business-key convention, because every table carries both
  identifiers. **The declared type is what separates them**, which is why
  `property_names_sibling_column` requires `sibling.type === mine.type`.

## The vocabulary, settled afterwards

An earlier draft of this module shipped six divergence kinds invented before the adjudication, and
**four of them had no member**. The five that ship were settled from the adjudications instead: each
divergence was read by an agent given the store, the column and the contract field and asked to name
the convention **in its own words**, **17 distinct convention names** came back, and these five are
what they collapse onto once the two derivations are taken out.

| Kind | n | What a reader must check |
|---|---|---|
| `nested_record` | 6 | the prefix names the sub-record the property was read off |
| `act_parameter` | 10 | the act's parameter is this field and not another of the same type |
| `qualifier_differs` | 10 | the qualifier one side omits does not change which fact it is |
| `statement_local` | 1 | the column is one the constant may live in |
| `column_overloaded` | 1 | nothing reads the column as its name says, and the catalog says so |

The axis is *what a reader has to check*, which is why `act_parameter` and `qualifier_differs` are
separate rather than one "the names differ a bit" bucket: for the first the two names denote
**different things** and the question is whether the act's input really is this field
(`tenants.status` ← a transition's `to`, `notification_dispatches.completed_at` ← `at`), and for the
second they denote the **same thing** and the question is whether the qualifier changes which
(`delivered_count` ← `delivered`, `decided_at` ← `decidedAtIso`). `DIVERGENCE_KIND_RULES` is a total
map, so a sixth kind cannot land without saying what believing it requires, and a test asserts every
kind has a member — so one invented and left empty fails where it is declared.

## The two declarations that could have waved the signature away

Two of the nine findings exist only because two kinds of declaration are dangerous, and both are
checked mechanically rather than trusted.

**`sibling_unaddressed`.** A declaration may resolve a `property_names_sibling_column` — it has to,
because there is a live one and it is correct — and that is the single highest-risk line in the
file. So its note must **name the sibling column**: an adjudication that never looked at the column
the value could have belonged in cannot have ruled the confusion out, and a note that never mentions
it is evidence that it did not.

**`overload_uncommented`.** `column_overloaded` is the one kind that admits the column's **name is
wrong** rather than merely vaguer, so it is where a real transposition could hide. Declaring it
requires the catalogued column to carry a source comment **naming itself** — so the next person,
reading the catalog rather than the test directory, is told. The self-naming requirement is what
stops prose attributed from the line above satisfying it.

That required one addition to the shared catalog parser: `CatalogColumn.comment`, the `//` prose
immediately above a column's `name:`. It is read from the **unstripped** source against line
numbers, because `stripComments` preserves newlines and not offsets, and one rule covers both
spellings the catalog uses — `// …` above the literal and `{` then `// …` then `name:` inside it —
since in both the prose is immediately above `name:`. **49** of the 2,399 columns carry one.

It had to go in the shared parser and not a second one. The catalog's own `ColumnDefinition` has
`name`, `type`, `notNull`, `primaryKey`, `default`, `unique`, `references`, `check` and
`renamedFrom` and **no comment field**, so nothing here is ever emitted as a SQL `COMMENT` and no
`COMMENT` exists on any column of any of the 146 tables. The source comment is the catalog's *only*
semantic signal about a column, which is exactly what makes requiring one a real cost — and a second
parser over `meta-schema.ts` is how the survey and the drift check come to disagree about what the
catalog says (ADR-0352's reason `check-admission.ts` imports `CHECK_CONSTRAINT_QUERY`).

The same parser gained `references` and `unique` for the `business_key` derivation, and `references`
is the one that mattered: **196 of the catalog's 233** references are written as one of three shared
`ColumnReference` constants rather than inline, so a parser reading only the inline form answers
`null` for 84% of them — and the derivation's "references nothing" predicate would have been
**vacuously true for every foreign key in the workspace**. This increment's first measurement of its
own soundness came back clean for exactly that reason, and the fix is what made the derivation
genuinely unsound without the UNIQUE.

## The one overload, and why it is a declaration rather than a defect

`meta.job_runs.started_at` holds a job's **due** instant, not a start time: the enqueuer writes the
cron tick (`cronPrevOnOrBefore`, so ≤ now and immediately claimable), `claimDueJobs` filters
`started_at <= $1` and orders by it, and a retry pushes it **forward** to `now + backoff` — a future
instant relative to any start. It was the open end's own canonical shape, and an adversarial pass
established the two facts that make the binding right rather than wrong.

First, **the contract that would say otherwise is dead.** `JobRunRecordSchema.startedAt` is
non-nullable while `completedAt` and `durationMillis` are nullable — a shape only coherent if the
column is populated at insert on a `pending` row, i.e. a due time — and nothing in `packages/` or
`apps/` constructs or serves a `JobRunRecord`. The producer provably does not implement it either:
`JobRunTriggerInfoSchema`'s scheduled member is `{kind, scheduledFor}` and the writer emits
`{kind, cron, fireAt}`. So the live semantics are defined entirely by the producer/claim/engine
triple, and all three agree.

Second, **no read path can return the wrong field.** Every `SELECT` against `meta.job_runs` names
its columns and none names this one, so it appears only in the claim predicate, the `ORDER BY` and
the retry `SET`. `duration_ms` comes from an in-process `execStart` and never from this column, and
the tick is independently preserved under its honest name inside the `trigger` JSONB as `fireAt`.

The honest remedy is a separate `due_at` column, which is a schema change and not a different source
for this parameter. What shipped instead is the remedy **both** verifiers independently named: the
catalog now says so, where the next reader looks.

`meta.rate_limit_decisions.route` got the same treatment one notch down, as `qualifier_differs`
rather than `column_overloaded`, and the distinction is the line between the two kinds: that column
is **vaguer**, not wrong. It holds the route's operationId, which its sibling
`meta.gateway_pipeline_executions.route_operation_id` says outright. The decisive fact is that
`RouteDefinition` has **no path string** — it carries `pathSegments` of literal/parameter/wildcard
objects, the sole consumer of that array compiles them to a `RegExp`, and no path renderer exists
anywhere in the workspace — so the operationId is not one of two close concepts but the only route
identity that exists as a string. The `RateLimitDecisionSchema.route` the column appears to mirror
is not even the contract the value comes from: the checker imports `RateLimitDecision` from
`@crossengin/api-gateway-runtime`, which has no `route` field, and the `@crossengin/rate-limiting`
schema has zero consumers outside its own package.

## Alternatives considered

- **Option A: a similarity threshold** — Levenshtein, token overlap, or a shared-prefix length,
  with a cutoff.
  - **Pros:** one knob; no declaration list to maintain.
  - **Cons:** every cutoff is arbitrary, and the measurements say arbitrary is also *unsound*: a
    shared leading token of four characters admits **138** properties into more than one column of
    their own table, and a camel-boundary suffix admits `id` into 11 columns of one table. A
    transposition is precisely a pair of *similar* names.
  - **Why not:** the cases a similarity score would wave through are the cases the rule exists for.
    Exact agreement plus declared exceptions is the only threshold that does not have to be tuned.

- **Option B: compare column-to-property names with no declaration list, and simply report** — a
  census rather than a fence.
  - **Pros:** no list; the numbers are visible.
  - **Cons:** 82 non-agreeing bindings is a wall of output nobody reads twice, and a census has no
    forcing function — which is ADR-0334's finding about `needsAuditEmitter`, where *location* was
    never what made the list wrong and the absence of a both-ways comparison was.
  - **Why not:** the declaration list is compared in both directions (`divergence_overtaken`,
    `divergence_duplicate`, `divergence_unknown_column`), so a divergence that goes away fails here
    and a new one fails here, which a census cannot do.

- **Option C: a `due_at` column on `meta.job_runs`, fixing the one overload rather than declaring
  it.**
  - **Pros:** the column would then hold what its name says, and `column_overloaded` would have no
    member — a cleaner vocabulary.
  - **Cons:** it changes the claim predicate, the `ORDER BY`, `idx_job_runs_due` and the retry path
    of a worker fleet that `--workflow-workers` mounts live, and it leaves `started_at` with nothing
    to hold, since no code records when a handler began. It is a subsystem change wearing a column's
    clothes.
  - **Why not:** out of scope for the increment that *built the detector*, and the detector's value
    does not depend on it. Declared with its evidence and named as a follow-up, which is ADR-0307's
    treatment of `failed` being both terminal and compensatable.

- **Option D: require `column_overloaded` to cite an ADR on disk**, as
  `pg-unreachable-stores.ts`' `no_caller_by_design` requires a `decidedIn`.
  - **Pros:** the established house shape for a reason that must never be assumed.
  - **Cons:** an ADR reference is satisfied by this file existing, and this file would exist anyway.
    It proves the increment happened, not that the catalog says anything.
  - **Why not:** the catalog comment is the stronger requirement, because it puts the fact where the
    person who would be misled is reading. Both were available and the comment costs the same.

- **Option E: make `property_names_sibling_column` undeclarable**, like `transposed_pair`.
  - **Pros:** the signature could never be waved away.
  - **Cons:** there is a correct live member — `access_review_decisions.attestation_kind` ←
    `decision.attestation.kind`, beside a top-level `kind` column of the same type — so the rule
    would be permanently red, and a permanently red rule is one people learn to ignore.
  - **Why not:** `sibling_unaddressed` buys the same protection at a price that can actually be
    paid: the declaration must name the column it could have been confused with.

- **Option F: fix `camelOfColumn`/`columnOfCamel` to round-trip every catalogued name** — four do
  not (`minimum_k_anonymity` ×3, `request_count_30d`).
  - **Pros:** the transform would be total in both directions.
  - **Cons:** a general digit-boundary rule is **unsound**: it would turn `fingerprintSha256` into
    `fingerprint_sha_256`, breaking a column that exists. A single-letter-segment rule needs to know
    `K` is its own word.
  - **Why not:** the forward transform is total and is what decides agreement; the reverse is used
    only to *find* a same-type sibling, where a miss is permissive and a wrong hit would need a
    column literally named `minimum_kanonymity` to exist. The four are asserted **by name** instead,
    so a fifth is visible in a diff.

## Consequences

- **Positive:** a transposition inside one `VALUES` list is now a test failure, which it was not
  before under any of the five rules above it. Two kinds of it are caught with no declaration
  consulted, and the 28 exceptions each carry what was read to clear them — so the adjudication is
  on disk rather than in a session. The two live residuals both verifiers named are fixed in the
  catalog, where they are read.
- **Negative:** 28 declarations to keep current, and `BINDING_NAME_DIVERGENCES` is the first list in
  this directory whose entries are *judgements about correctness* rather than structural facts —
  **whether a declared reason is true is unverifiable by machine**, as it is for all seven siblings.
  The rule is also blind to a divergence whose property happens to agree with the column it was
  wrongly bound into, which is the next layer down and needs the parameter position compared against
  the column's *meaning* rather than its name.
- **Neutral:** `CatalogColumn` gained three fields this increment (`references`, `unique`,
  `comment`) on top of ADR-0353's two, so the shared parser now carries most of a
  `ColumnDefinition`. Two source comments landed in `meta-schema.ts` and emit no SQL.
- **Reversibility:** complete and cheap. The rule is one module plus its test; deleting them removes
  the check and nothing else. The two catalog comments are prose. The parser addition is additive and
  read by one rule.

## Implementation notes

`pg-binding-names.ts` consumes `scanColumnBindings`' output, so the positional derivation ADR-0354
refused three readings of — a `VALUES`-list zip, "the next `query(…)` call", and position past a
spread — is not repeated here. `summarizeBindingNames` partitions every binding, and the real-
workspace test asserts the partition as floors on the **checked** side (`agreeing >= 650`,
`agreeing / (total − literals) > 0.85`, `uncatalogued === 0`, `derived.business_key >= 14`,
`derived.resolved_surrogate >= 8`) for `pg-unreachable-stores.ts`' reason: a scanner that stopped
matching would check nothing and sail past a ceiling.

Two **live controls** on the real tree, rather than fixtures, because a signature that only fires on
a synthetic table proves nothing about the scan: pointing `meta.job_runs.claim_expires_at`'s real
binding at `completedAt` yields exactly one `property_names_sibling_column`, and transposing the
real `input_data_class`/`output_data_class` bindings in one `INSERT` yields `transposed_pair` — a
pair no constraint could catch, since both are TEXT under the same six-value CHECK.

`derivation_ambiguous` is the piece worth copying. A derivation's tightness is a measurement over the
catalog, and a measurement taken once goes stale silently; so `derivationTargets` re-asks it per
binding, and a second admissible column makes the rule **say** it has stopped being an explanation
instead of widening. The whole-catalog form is asserted too, with the property fixed per candidate
set — deriving the property from the column under test makes the predicate trivially true, which is
how the first version of that assertion passed over 114 ambiguous tables.

The adjudication ran as nine parallel readers, one per `*-pg` package plus `apps/operate-server`,
each handed only its own bindings and required to re-derive the pairing positionally before judging.
Five of the first six contradictions in the run were the *measurement's* own fault rather than the
code's — ADR-0354 found the same ratio — which is why the two that survived went to an independent
refuter and why both of their dismissals rest on facts the first reading had not checked.

## Live verification

On a throwaway PG 16.13 cluster, as a **non-owner** role under tenant context:

- `crossengin-pg apply --yes` applies the catalog clean and the **re-plan is clean**, so the two new
  source comments emit no SQL and cost no migration — which is the point of `ColumnDefinition`
  having no comment field.
- `enqueueScheduledJobs` with a `now` of `2026-10-10T09:17:42Z` against a `0 3 * * *` job writes
  `started_at = 2026-10-10T03:00:00.000Z` — **the cron tick, not `now`** — exactly equal to
  `trigger->>'fireAt'`, with `completed_at` and `duration_ms` NULL on a `pending` row. A column
  genuinely holding a start time cannot be set before the handler runs; this one is, six hours
  earlier.
- `claimDueJobs` picks that run up; with `started_at` pushed to a later instant (the retry's effect,
  `now + backoff`) the same claim returns **nothing**. So the column is what decides visibility, and
  a value in it that is not a start time is what the claim path requires.

So the column the one `column_overloaded` declaration is about behaves as the declaration says, run
rather than read.

The run also turned up the rule's own boundary, in the shape it predicts: `ClaimedJob.jobId` is the
**run** id (`run_id`) and `ClaimedJob.jobDefinitionId` is `job_id`. That is consistent across every
consumer and so is not a defect, but it is the write-path divergence this rule catches, on the read
path, where nothing looks — see the open questions.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| ~~The rule covers the **write** path only. A row → record mapping can name a field as wrongly as a parameter can, and `ClaimedJob.jobId` ← `run_id` is a live (consistent, non-defect) member found while verifying this one~~ — **closed by ADR-0356** | Platform | _closed_ |
| Should `meta.job_runs` gain a `due_at`/`visible_at` column, retiring the one overload? | Platform | _unscheduled_ |
| Nothing compares the bound property against the column's *meaning*, only its name — a store writing `record.kind` into `status` passes if the property is called `status` | Platform | _unscheduled_ |
| `BINDING_NAME_DIVERGENCES` notes are judgements; no machine checks that a reason is true | Platform | _unscheduled_ |
| `CatalogColumn` now carries five fields beyond the original three; does `parseCatalogSource` want splitting from the coverage rule it lives in? | Platform | _unscheduled_ |
| The reverse transform is lossy on four catalogued names; a fifth is a declared exception rather than a fix | Platform | _unscheduled_ |

## References

- ADR-0354 — the symbol a writer binds; this ADR closes its Q2.
- ADR-0353 — `pg-value-set-domains.ts`, and the shared catalog parser's `check`/`defaultExpression`.
- ADR-0352 — one reader of the catalog, so the survey and the drift check cannot disagree.
- ADR-0337 — floors on the checked side, and the refusals kept beside their measurements.
- ADR-0334 — a list is only a rule when it is compared in both directions.
- ADR-0333 — what a fake `PgConnection` structurally cannot see.
- ADR-0307 — a contradiction pinned by a test rather than resolved, where resolving it is a
  subsystem decision.
