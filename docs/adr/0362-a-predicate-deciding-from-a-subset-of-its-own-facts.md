# ADR-0362: A predicate deciding from a proper subset of its own facts

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-12 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0330, ADR-0334, ADR-0337, ADR-0348, ADR-0349, ADR-0352, ADR-0355, ADR-0356, ADR-0359, ADR-0361 |

## Context

This is the fourth increment driven by the October register rather than by an ADR's own open
ends, and it takes three items whose register entries read as unrelated: P2.15 (confinement
fences), P2.4 (event-triggered job names) and P3.6 (the four-eyes attestation's timestamps).

They are one class, and the class is ADR-0361's read on **predicates** rather than on field
lists: **a predicate deciding from a proper subset of the facts that determine its answer.** In
every instance the narrowing fails in the reassuring direction, and in every instance a correct
sibling already sat somewhere in the tree.

- The confinement fence composed three or four catalog facts where Postgres reads five — it has
  no spelling for `rolsuper` at all — while `shared-table-erasure.ts` was already asking
  Postgres directly.
- The job survey answered from a trigger's **kind** where the question is about its **name**, so
  twelve declarations were told to register a handler that would not help, while the producer's
  own name builder sat one package away.
- The attestation refinement required `coAttestedAt` by name and then compared only
  `coAttestingUserId`, while the mapper beneath it asserted its contract by return type instead
  of establishing it by parse — with `rowToEvidence` fifteen lines further down doing exactly
  that and carrying a comment saying why.

The register's own framing of all three was wrong in ways that would have misdirected the work,
and the corrections are recorded below rather than quietly applied.

### P2.15 — three mechanisms, one defective, and the extracted one was not the best

The register said *"six confinement fences infer RLS confinement from ownership without reading
`relforcerowsecurity`"*. The true figure is **three predicate implementations and one defect**:

| | mechanism | score |
|---|---|---|
| `kernel-pg/introspection.ts:155` | composes four catalog facts | **6/8** |
| `tenant-lifecycle-pg/shared-table-erasure.ts:680` | `row_security_active(c.oid)` | **8/8** |
| `workflow-runtime-pg/job-claim.ts:239` | composes ownership and bypass | **5/8** |

Scored against ground truth on PG 16.13 — two tables (`plainrls` RLS-enabled, `forcedrls`
RLS-enabled + FORCE) under the catalog's own NULLIF-guarded isolation policy, four roles, no
tenant context, and rows actually returned by a `SELECT` as the oracle:

| role | table | rows seen | confined | `row_security_active` | composed | ownership-only |
|---|---|---|---|---|---|---|
| `r_owner` | plainrls | 2 | no | f ✓ | f ✓ | f ✓ |
| `r_owner` | forcedrls | 0 | **yes** | t ✓ | t ✓ | **f ✗** |
| `r_bypass` | plainrls | 2 | no | f ✓ | f ✓ | f ✓ |
| `r_bypass` | forcedrls | 2 | no | f ✓ | f ✓ | f ✓ |
| `r_plain` | plainrls | 0 | yes | t ✓ | t ✓ | t ✓ |
| `r_plain` | forcedrls | 0 | yes | t ✓ | t ✓ | t ✓ |
| `r_super_nobypass` | plainrls | 2 | no | f ✓ | **t ✗** | **t ✗** |
| `r_super_nobypass` | forcedrls | 2 | no | f ✓ | **t ✗** | **t ✗** |

`probeJobQueueVisibility`'s third miss is the live defect and it is permissive: an owner of a
FORCEd table read `visible` while Postgres showed it none of the rows. Confirmed destructively —
that owner's `DELETE … WHERE tenant_id IS NOT NULL` removed nothing, the confirm-absence
`count(*)` **also reported 0** because it reads through the same policy, and a BYPASSRLS role
then counted both rows still present. That silent zero is the single thing this family exists to
catch (ADR-0330's erasure, ADR-0349's rekey), and the fence reported the queue visible.

Its own doc comment is the sharpest statement of the class in the repository:

> Ownership, `rolbypassrls` and `relrowsecurity` are facts Postgres will state, so they are
> *asked for* (ADR-0330's rule)

Three facts asked for, and the decision imitated, while citing the ADR that says not to.

Two further corrections. `data-key-rekey.ts` carries **no** copy of the predicate (the register
said it did) — it delegates. And `relforcerowsecurity` is latent today: nothing in the repo runs
`ALTER TABLE … FORCE ROW LEVEL SECURITY`, so every occurrence is a comment or a fixture.

### P2.4 — the separator, not the arity, and the survey misdirected

The register framed this as a three-part produced name against a two-part declared one. The
shipped producer emits **two** parts — `eventPrefix` is optional, `--event-prefix` defaults to
null and appears nowhere in `deploy/` — so arity was never the discriminator and dropping the
prefix would have fixed nothing. The real mismatch is that the producer separates entity from
verb with a **dot** (`salesorder.placed`) while every declaration fuses them with an
**underscore** and puts the domain first (`retail.order_placed`).

Measured against the real async `resolveManifest`: **294** producible names across the seven
resolved packs (erp-core 230, retail 238, healthcare 243, grocery 247, construction 233,
education 243, government 243), and **0 of 12** declared names producible. Stronger than the
register claimed: trying every declared name's own first segment as `--event-prefix` across all
seven packs gives **0 matches**, so the failure is structural rather than a misconfiguration.
Counted per resolved deployment, that is **55 of 55** (pack, declaration) instances.

And the survey built to say so said the opposite. Measured live on resolved erp-core, verbatim:

> no handler is registered for 'erp-core-payment-received-handler', and **event_emitter enqueues
> it** — so **every fire accumulates a pending run** nothing can execute … the behaviour **has to
> be registered by the deployment** before this job can run

Two of three clauses false. `survey.ts:14` states the rule being broken in its own words:
*"`surveyManifestJobs` reports `no_producer` in preference to `handler_missing` — naming the fix
that would not work is worse than naming none."* The cause is granularity: `classify()` reads
`JOB_KIND_PRODUCERS[kind]`, the kind `event` genuinely has a producer, and no member of
`JOB_SERVICE_VERDICTS` could say *a producer exists and cannot address this declaration*.

### P3.6 — the register's own fix was refuted

The register proposed adding `attestedAt === decidedAt` to `AccessReviewDecisionSchema`. That is
**vacuous for every persisted row and makes a measured loss legal by decree**: `rowToDecision`
fills `decidedAt` *and* `attestation.attestedAt` from the same column `row.decided_at`, so the
equality holds by construction on every read and no clause could ever fire for a stored decision.
Executed end to end: an authored `attestedAt: 03:00` with
`attestationPhrase: "I attest this access is appropriate."` round-trips as `attestedAt: 00:00`
(a silent three-hour rewrite), `attestationPhrase: undefined`, and **still parses**.

Three facts the register did not have:

1. **There is no column.** `meta.access_review_decisions` declared 24 columns with `attested_at`
   and `attestation_phrase` absent, and the `INSERT` was **complete over the catalog** (23 of 24;
   the 24th is `id` with `uuid_generate_v7()`). That is exactly why no SQL rule reported it: all
   ten workspace rules compare SQL against the catalog or the catalog against a value set, and
   **none compares a contract field to a catalog column.**
2. **The signed bytes commit to both lost fields, independently.**
   `canonicalAttestationBytes` hashes `attestedAt` and `attestationPhrase`; measured
   `digest(authored) = 937fe1f3…` against `digest(readback) = d888114d…`, with each loss changing
   it on its own. `canonicalStringify` skips `undefined`, so a dropped phrase removes the **key**
   rather than nulling it.
3. **`rowToDecision` does not re-parse.** It returns a bare object literal *typed as* the
   contract, which asserts conformance rather than establishing it — so no clause had ever been
   checked on read. Its sibling `rowToEvidence` parses and says in prose why; the file held both
   the rule and its violation. This is the member where the "proper subset" is not a narrower
   *field list* but the **type annotation standing in for the parse**.
   Measured afterwards: **9 of the 13** clauses are reachable from a stored row at all, and the
   primary four-eyes clause is **not one of them** — `decidedByUserId ===
   attestation.attestedByUserId` reads both sides from the single column `decided_by_user_id`, so
   the mapper *reconstructs* the equality and no row can break it. The reachable four-eyes fence
   is the co-attestor's, and that one is newly checked.

The live incoherence is on the half that *does* have a column: `co_attested_at` is real, bound and
read back, `DecisionAttestationSchema` requires it **by name** for `two_person_attestation`, and
the next clause constrains only `coAttestingUserId`. Executed: a `two_person_attestation` with
`coAttestedAt` in 2020 and `attestedAt` in 2026 **parses** — a four-eyes record an auditor reads,
temporally incoherent, accepted and stored.

## Decision

**The verdict is asked for; the facts explain it.** `SESSION_POLICY_VISIBILITY_COLUMNS` carries
`row_security_active(c.oid) AS policies_active` and `sessionWouldBeConfined` returns it. The four
catalog facts stay and are still read, because a refusal must say *why* — "you do not own the
table" and "you own it and FORCE confines the owner too" send an operator to opposite remedies —
and `sessionPolicyVisibilityReason` composes that explanation, with `role_is_exempt` as the honest
arm for the superuser case no fact here can name.

**The grammar has one spelling and the survey enumerates its domain.**
`kernel/src/manifest/event-names.ts` holds `eventNameSegment`, `ENTITY_EVENT_VERBS`,
`entityEventName` and `producibleEntityEventNames`; `operate-runtime`'s producer imports them.
`event_unproducible` is the sixth `JOB_SERVICE_VERDICT`, checked after `no_producer` and before
both handler checks, and `producibleEventNames` is **required** on both the survey input and the
registry input with `[]` as the claim rather than its absence.

**The mapper establishes its contract, and the phrase gets a column.** `rowToDecision` parses.
`attestation_phrase` is catalogued, bound and read, because it duplicates nothing and is the only
evidence its attestation kind carries. `attested_at` deliberately gets **no** column, because it
duplicates `decided_at` and three independent things in the tree treat them as one instant — the
sole live producer computes one `nowIso`, the mapper fills both from one column, and
`EvidenceBundleDecisionRow` carries `decidedAt` and not `attestedAt`, so the sealed pack an
auditor receives already names the field the row holds. Two clauses land on
`DecisionAttestationSchema`: `coAttestedAt >= attestedAt`, and a phrase required for
`typed_attestation_phrase`.

**The declarations are adjudicated, not repointed.** Four are renamed; eight are declared in an
eleventh workspace rule with a reason that costs something checkable.

## Alternatives considered

- **Keep the composed predicate and only point `job-claim.ts` at it.**
  - Pros: smallest diff; closes the one live defect.
  - Cons: leaves the shared rule at 6/8 and leaves two *correct* call sites refusing a session
    that genuinely sees every row — one of them the rekey's pre-destruction fence, whose printed
    remedy ("grant the role BYPASSRLS") cannot help a superuser, which is ADR-0334's
    remedy-that-cannot-work.
  - Why not: the composed form **can never** reach 8/8. Both its misses are
    `SUPERUSER NOBYPASSRLS`, which `check_enable_rls` exempts and no catalog fact read here can
    see — a repo-wide grep for `rolsuper` / `usesuper` / `is_superuser` returns **zero**.

- **Converge `shared-table-erasure.ts` onto the shared rule.**
  - Pros: one spelling of the SQL as well as one rule.
  - Cons: it is the 8/8 spelling, so this would import the superuser false refusal into the
    Article 17 erasure and refuse a deletion that can really delete.
  - Why not: converging onto the *worse* answer is the defect, not the fix. Its query is also
    batched over ~115 catalogued targets where the shared one is single-table, so the SQL shapes
    genuinely differ and the cost of unifying them is unmeasured.

- **Make the composed rule 8/8 by reading `rolsuper`.**
  - Pros: keeps the predicate a pure function of catalog facts.
  - Why not: it is a second implementation of `check_enable_rls`, which is the thing ADR-0330
    exists to refuse.

- **A `validateJobs` error for an unproducible event name** (ADR-0348's split would ask for one).
  - Pros: decidable from the manifest alone, so a pack author, `crossengin validate`, the pack's
    tests and the approving reviewer all catch it.
  - Cons: `validateManifest` is **error-only** — it throws `ManifestValidationError` and has no
    warning channel — so it would refuse 8 of 12 declarations and with them **all seven packs**.
  - Why not: for the five with no counterpart the remedy does not exist (ADR-0334), and for three
    more it is a domain judgement. Departing from ADR-0348 here is argued from that measurement
    rather than from preference. An eleventh workspace rule carries the same forcing function
    without refusing deployments that work (ADR-0352's rule).

- **Rename all seven declarations that have any producible neighbour.**
  - Pros: closes three more lines in the census.
  - Why not: `payment.completed` is a payment's *processing* completing, which is not a payment
    being *received* — a received payment may still fail to clear. Repointing silently would make
    the declaration read as served while firing at a moment nobody chose, which is ADR-0337's
    falsely-true direction and invisible once it runs. (My own brief for this slice claimed
    `perishablelot.received` was a near candidate; it is **not producible** — `received` is that
    entity's *initialState*, so it is reached by a create and emits `perishablelot.created`, and
    `purchaseorder.received` is the only producible `.received` name in the seven packs. That is the
    targets-versus-states over-reporting `producibleEntityEventNames`' own doc comment exists to
    prevent, committed in the brief written to prevent it.)

- **Add `attested_at` beside `attestation_phrase`.**
  - Pros: the signature over an authored attestation becomes recomputable from its row.
  - Cons: invents a second fact nothing in the tree distinguishes, and all five exports of
    `attestation-signing.ts` have zero callers outside their own module, so the bytes it would
    serve are computed by nothing today.
  - Why not: the asymmetry is the decision. One field duplicates `decided_at`; the other
    duplicates nothing and its absence destroys the only evidence a declared attestation kind
    carries. Dropping the silent fill in favour of a *declared* one is the honest half.

- **The register's `attestedAt === decidedAt` clause.**
  - Why not: refuted by measurement — see Context. It would declare the unstored field equal to
    the stored one and make a measured silent rewrite legal by definition.

- **A workspace rule over the ≥11-member unordered-timestamp-pair class.**
  - Why not: both candidate anchors were measured and both lose. The tight one — *a refinement
    whose message names a field the clause does not read* — has **zero** members: all three cited
    clauses genuinely read every field their message names, for *presence*; the gap is that
    presence is required and ordering is not, which that anchor cannot see.

## Consequences

- **Positive.** The confinement verdict is Postgres's own and there is no composition left to get
  wrong. The one live defect of the three is closed and verified live at 8/8. The event-name
  grammar has a single spelling, so the producer and the survey cannot disagree about what is
  emittable, and 55 declarations now carry a reason whose remedy is true. `rowToDecision` parses,
  which puts **9 of the 13** `superRefine` clauses under a check on read for the first time — and
  the honest headline there is reachability rather than defects found: **not one existing test
  broke** when the parse landed, so no fixture was feeding it a row the contract forbids. A
  `typed_attestation_phrase` attestation finally carries and stores its only evidence — and
  because both signing paths end in `DecisionAttestationSchema.parse(out)`, one signed without a
  phrase is refused before a signature is returned.
- **Negative.** The authority switch is a **loosening** at two correct call sites for a
  `SUPERUSER NOBYPASSRLS` session, including the rekey's pre-destruction fence. It is correct —
  that session genuinely sees every row — and it narrows a false refusal rather than widening a
  true one, but it is a behaviour change on a destructive path and is taken on the live
  measurement above rather than on reasoning. A handled job whose event nothing emits drops out
  of `servedJobIds`; harmless by measurement, since 0 of 55 instances has ever matched.
  `attestation_phrase` is one more column on an already wide table.
- **Neutral.** `attested_at` remains unstored, so a signature over an authored attestation still
  cannot be recomputed from its row — the same state as before, now *declared* in the mapper
  instead of silent.
- **Reversibility.** Every piece is a small revert except the catalog column, which is additive
  and nullable. The authority switch is one field read; reverting it restores a 6/8 predicate.

## Implementation notes

- `parseSessionPolicyVisibility` is **strict on the verdict and permissive on the four facts**,
  and the asymmetry is load-bearing. An unreadable explanation costs a sentence; an unreadable
  verdict reads as *not confined*, which is a fence that silently stops refusing. This was found
  by an adversarial review **after** the first commit shipped: the test asserting the permissive
  default justified it with *"every caller checks `rlsEnabled` first"*, and only **one of three**
  does — `check-admission.ts` and `encryption-writepath.ts` both parse and branch with nothing
  between, and the second is `KeyRotationMigrator.probeTable`. Unreachable from either caller
  today, because both build their SQL from the shared select list; reachable from the next one.
- `encryption-writepath.ts` **interpolates** `SESSION_POLICY_VISIBILITY_COLUMNS` where it had
  hand-written the five columns. That constant's doc comment said it existed "so a caller wanting
  extras asks once" and it had **zero** consumers; the one caller with extras restated it. The
  new column reached that probe without the file being edited, and `RotationVisibilityRow extends
  SessionPolicyVisibilityRow`, so the row type had already followed — only the SQL had not.
- `producibleEntityEventNames` reads declared transition **targets** and never `workflow.states`.
  `verbFor` reads `input.transitionTo`, so a state nothing transitions to can never appear in a
  name: resolved erp-core has 95 (entity, state) pairs against 77 (entity, target) pairs, so
  reading states would report 18 names producible that no write can emit — the permissive
  direction.
- `node.ts` computes the producible set with the **same** `--event-prefix` it gives
  `entityEventEffect`. A prefix on one side only makes every name disagree by a segment, and
  neither function can detect it because each is individually correct.
- Three fakes needed the new verdict column and two needed more than that. **Eleven tests failed
  at once**, every one because an absent verdict reads as not-confined, so every RLS refusal
  stopped firing while every assertion about the SQL kept passing. The fakes **derive** the
  verdict from their own facts now, and `job-claim.test.ts`'s throws when a fixture declares one
  its facts contradict — an exempt owner on a FORCEd table describes a database that does not
  exist.
- The retired `sessionWouldBeConfined` tests are the sharpest member of the class: they pinned an
  exhaustive truth table and compared the rule against an `ownershipOnly` derivation **written in
  the test**, calling the single disagreement a property. Neither side was ever compared with a
  database. The live matrix is recorded as data now and both retired compositions are scored
  against it.
- **The eleventh rule has NINE declarations, not eight, and the ninth is the sharpest.**
  `erp.work_order_completed → workorder.completed` is a correct rename on **six** of the seven
  resolved packs and names nothing on `erp-construction`, which keys its own
  `work_order_lifecycle` over `draft → scheduled → in_progress → done` — the pack ADR-0359 found
  replacing core's `WorkOrder`. So producibility is a property of the *resolved* manifest, and the
  fence is **per pack, never over the union**: a union would read that job as served, and the
  direction is what matters, because an over-wide producible set **under**-reports findings.
  The declaration grain is `(jobId, packs)` and the brief's `(jobId)` would not have worked — at
  `(pack, jobId)` grain the residual is 28 instances over 9 pairs with 21 of the 28 being three
  core facts repeated across seven packs, a list that grows with the pack count, while at `(jobId)`
  grain the construction member reads `overtaken` on six packs and is needed on one.
- **The rule's own test found a defect in the rule**, which is the clearest evidence the fence is
  worth its length: the `undeclared` arm accepted a declaration on `jobId` + `packs` alone, so a
  declaration whose `eventName` had gone stale would go on covering whatever the job was renamed
  to — an adjudication of a string nobody uses silencing the one in use. Found by the test written
  for `event_name_changed`, which expected two findings and got one.
- **Three mutations survived the first battery and each named a real hole.** The
  `entity_unreferenced` guard and resolving entities *through* the pack's own array were both
  unpinned, because every `: Entity = {` const in the live packs is reached by its array — so a
  test over the real workspace alone cannot distinguish this scan from one that takes every const
  it finds, and both mutations passed. That is ADR-0355's *a measurement taken once goes stale
  silently* arriving inside a new rule, and it is why the module carries fixture tests beside the
  live ones.
- **CLAUDE.md's phantom-failure hazard was observed again.** One
  `pnpm --filter @crossengin/testing test` came back `3 failed | 574 passed` after a
  doc-comment-only edit, while two commits were landing in other packages; three re-runs with
  `pgrep` empty give 577/577. The rule holds: reproduce a sweep failure in isolation before
  believing it.
- **Inserting one column broke a positional test in exactly the way ADR-0355 predicts**, which
  is that rule's own class arriving live inside this increment. `decision-store.test.ts` asserted
  `params[11]`, `[12]`, `[16]` and `[17]`, and adding `attestation_phrase` shifted three of them
  onto a **neighbour of the same declared type** — `attestation_phrase` TEXT where
  `attestation_signature_sha256` CHAR(64) had been asserted — the one case a type cannot
  separate, so the test would have kept passing against the wrong column wherever the values
  happened to be null. The literal indices are a lookup through the column list now.
- A clause **count** written into a comment went stale inside this one increment: the attestation
  slice took `DecisionAttestationSchema` from eleven clauses to thirteen while the mapper slice
  was describing "eleven". The comment names no count now — CLAUDE.md's own stale-figure rule
  biting at a one-commit distance. Likewise a comment citing `co_attested_at` as bound at `$16`,
  which the sibling had already shifted to `$17`: a bind position in a comment is volatile by
  construction, so it names the column and the two modules instead.
- `pnpm --filter <pkg> build` excludes `*.test.ts` (ADR-0307), so making
  `producibleEventNames` required surfaced **one** error on `build` and **23** on `typecheck`.
  The test file gained a `buildWith` helper whose default is `[]` — the correct claim for a
  fixture with no emitter, not "assume producible".

### Corrections to figures on file

- The register's "six fences" is **three mechanisms, one defective**; its "one column in six
  queries" is one column in **one** query plus one branch, the six being probe *invocations*.
- CLAUDE.md's ADR-0352 sentence — *"the rule had eight spellings of which only
  `KeyRotationMigrator`'s private copy read `relforcerowsecurity`"* — is retired twice over: the
  figure is not reproducible from the committed tree by any counting (3 mechanisms / 5 emitters /
  7 modules naming the refusal / 9 naming it or a variant), and that copy was **not** the most
  correct of them.
- `salesorder.placed` is **not** producible on resolved erp-core: core's SalesOrder lifecycle is
  `draft → confirmed → fulfilled → invoiced → closed/cancelled`, and `placed` belongs to
  *retail's* `cart → placed → fulfilled → returned`, which replaces it. The adjudication of
  `retail.order_placed` is unaffected, since that declaration is retail's.
- `workorder.completed` is producible on six packs and **not** on `erp-construction`, whose
  WorkOrder lifecycle targets `done` (ADR-0359 found that pack replacing core's `WorkOrder`).
- Four comments in four packages described this rule and the accurate one described the
  **defective** code. Three were found by survey; the fourth, in `check-admission.ts`, was found
  by the new text fence on its first run.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Should `sessionWouldBeConfined`'s loosening at `KeyRotationMigrator.probeTable` be gated behind a flag for a deployment that deliberately runs a `SUPERUSER NOBYPASSRLS` serving role? Measured population today: zero. | Platform | 2026-12-31 |
| `government.permit_issued` and `education.grade_posted` are the two declarations whose remedy a domain owner could apply today — declare a lifecycle on `Permit`, add a `posted` target to `Enrollment`. The other three need an entity that does not exist. | Platform | 2026-12-31 |
| A twelfth workspace rule over row→record mappers that return a bare literal instead of parsing. `rowToDecision` was one; the census of how many others exist is the input and was not taken. | Platform | 2026-12-31 |
| `attested_at` stays unstored, so a signature over an authored attestation is not recomputable from its row. Closing it means either the column or dropping the field from `canonicalAttestationBytes` under a `.v2` domain tag. | Platform | 2027-03-31 |
| The ≥11-member unordered-timestamp-pair class is named in the register and untouched here, both candidate anchors having been measured and refused. | Platform | 2027-03-31 |
| `entity-events.test.ts` sits at 12 tests, below the house 15–35 band, for a module six branches wide. Flagged rather than padded. | Platform | _N/A_ |

## References

- PostgreSQL `row_security_active` / `check_enable_rls` — the function the executor consults when
  deciding whether to apply a table's policies.
- ADR-0330 (ask Postgres rather than imitate its parser), ADR-0334 (a remedy that cannot work is
  worse than none), ADR-0337 (a falsely-true control is the dangerous direction), ADR-0348
  (manifest-alone properties are validation errors), ADR-0349 (the rekey's pre-destruction
  fence), ADR-0352 (report and never refuse where the degraded state is harmless), ADR-0359 (a
  surface whose drop changes which rows come back is refused), ADR-0361 (an invariant two readers
  agree on is not an invariant either is right about).
