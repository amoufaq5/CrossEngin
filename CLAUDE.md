# CLAUDE.md

Project state for AI assistants resuming work on this codebase. Read top to
bottom once, then keep nearby.

**This file describes the shape of the system, not its history.** History lives
in `docs/adr/index.md` (generated — 376 records). Earlier versions of this file
tried to narrate every shipped milestone and went ~170 PRs stale as a result.
When you land something, update the *shape* here if it changed and write an ADR
for the *decision*; do not append to a running log.

## What this is

CrossEngin: an AI-native multi-tenant ERP platform. Three layers — a **kernel**
(multi-tenancy + meta-schema + DDL emit), declarative **manifests**, and an **AI
Architect** that authors them. Vertical packs (core / retail / healthcare /
grocery / government / education / construction) ride on top.

A tenant describes their business in prose; the Architect designs a manifest; a
platform reviewer approves it; activating it makes it that tenant's live schema,
served through the same gateway as everything else.

## Where we are

**87 packages + 3 apps, 146 meta-schema tables, 20,185 tests**, all green, no
type errors.

- **Phase 1** (contracts) and **Phase 2** (M1–M8, runtime pillars) are complete.
- **Phase 3** (ADR-0077, P1–P8: serving app → distributed workers → web renderer
  → more packs → marketplace → multi-region → AI in prod → hardening) is
  complete. P6 (multi-region) is deliberately thin — ADR-0077 Q6 gates it on
  demand.
- **Phase 4** (commercialisation) is in progress and has **no plan ADR**. It has
  proceeded one shipped increment at a time since ADR-0236 — billing, third-party
  marketplace, SOC 2 / HIPAA certification, the forensics chain, deployment, the
  platform console, AI onboarding, the notification stack, and a long run on GDPR
  Article 17 (ADR-0316 – ADR-0329): the erasure, its proof, the proof's reach, the
  audit of the proofs, and the alarm for what that audit finds.
  The last four increments (ADR-0330 – ADR-0333) have been **sweeps rather than features**: taking a
  defect that was found once and asking how many other members its class has. That turned up a
  column-level CHECK nobody compared across 765 of them, a `Date`-vs-string assumption in four stores
  (one of them breaking keyset pagination in production), 29 tables letting a tenant write a
  platform-wide row, a signal store that could never succeed against a real database, and a workflow
  orchestration layer that was unreachable from the deployed binary. ADR-0333 asked *why nothing
  caught them* and found the answer in this file: the convention that Postgres modules are tested
  against a fake connection recording `{sql, params}` draws the boundary at the SQL **string**, so
  everything past it — does the column exist, does the policy permit it, does the row come back,
  does anyone call this — was unverified by construction. Six defects were in that blind spot,
  each one something **built, tested, and never connected to reality**: two stores that threw
  against every real database, two that dropped every state transition, three workers that were
  exported and never started, a verdict table nothing wrote, fourteen stores whose reads were
  correct only as the table's owner, and a decimal sort that did not terminate. The recurring shape
  is that **the honest fix usually sits one level up from where the pain was felt** — here, a
  workspace test that reads the catalog and every store's SQL rather than a convention asking people
  to be careful.
  ADR-0334 is the fifth sweep and its class is **what a value *is*, and who agrees**. The
  centre of it: `tenant-lifecycle` declared a **seven**-state tenant machine with
  `READ_ONLY_STATES`/`blocksWrites`/`blocksReads` that **nothing in the workspace read**, while
  `operate-server` carried its own four-value enum — and *that* one is what the catalog's CHECK
  constrains. Two of the unreachable three were billing facts duplicated onto the tenant (`past_due`
  is a *subscription* status with its own transition map; `trial` is a plan tier with no producer
  anywhere); the third, `pending_deletion`, was the state the deployment was actually **missing**, and
  it is load-bearing: ADR-0321 made the Article 17 erasure asynchronous and ADR-0316 retires the
  tenant row only after it commits, so a tenant whose deletion was verified and queued sat `active`
  and went on **accepting writes into data about to be destroyed**. There is one vocabulary now, of
  five, in the contracts package, and `--tenant-status-gate` is the request-path enforcement that
  column never had. Beside it, three subsystems that had never run: a cron timer that fired exactly
  once, every job producer filling a queue with no consumer (and `no_definitions` refusing the one
  worker that does not read a definition), and **83 of 145 tables with no writer** and nothing saying
  which of those are deliberate.
  ADR-0335 closes six of those 83, and the class is **a record nobody could write** — three
  different things wearing one costume. *Nothing could write it, and a reference made that
  load-bearing*: `meta.users` had no writer while **97 catalogued columns reference it**, ten of them
  `NOT NULL ON DELETE RESTRICT` on a table with a live store, so with one row provisioned
  `PostgresRecipientResolver` resolved a real audience **for the first time** — every notification
  audience in every deployment had been resolving to `[]`; `meta.notification_preferences` was read on
  every dispatch and written by nothing, so the consent half of `computeDispatchEligibility` was
  unreachable; and `meta.access_review_evidence` had a reader with its exact column list and no
  writer, so `certifiable` was **false in every certification report ever produced**.
  *The deletion cascaded it away*: **15 of the 16 `PLATFORM_RECORD_TABLES` were `ON DELETE CASCADE`
  children of `meta.tenants`**, and ADR-0320 retires that row after the pipeline commits — so the
  compile-time retention set was correct and a foreign key undid it one statement later, leaving
  **every Article 17 proof `unwitnessed`**, one of ADR-0324's paging `sev1` defects.
  *Built, tested, never connected*: `@crossengin/api-gateway-pg` had **zero importers**.
  The recurring rule, arrived at for the **third** time (ADR-0318, ADR-0321): **a column recording
  who performed an act is a record of the past, and a referential constraint on it makes the actor
  undeletable as a consequence of having acted.** Two defects were visible only live and only as a
  non-owner — the whole asynchronous Article 17 flow could not write a single row — and one was
  visible only by applying the catalog to a real cluster, where a `uuid <> text` four-eyes CHECK took
  the entire bootstrap down at statement #0 of 960 while every offline test passed.
  ADR-0336 is the sixth sweep, and its class is **a store nobody constructed** — the question
  ADR-0335 named in its own open ends after *moving* a defect rather than closing it.
  `pg-storeless-tables.ts` asks which catalogued table has no writer; nothing asked **which writer
  has no caller**, and the two differ exactly where it matters, because that rule decides a table is
  written by reading a store's SQL as text — so a store with no caller makes its table read as
  written while no deployment has ever put a row in it. Eight exported `Postgres*` classes were
  constructed only in their own tests, confirmed three ways (a grep, an independent oracle, and a
  new workspace rule written blind), and **none of the eight tables appeared on the writerless
  census.** What the eight do *not* share is the finding: three were a missing **wire**, five a
  missing **subsystem one level up**, where a route would be a surface reporting success and
  recording a typed-in claim — so the deliverable is partly routes and partly declarations carrying
  their reasons. The sharpest member is the one that was asked to be wired:
  `PostgresIdempotencyStore` had **no path to be passed at all**, so every deployment's replay guard
  has been a `Map` in one process, and wiring it unfixed would have been **worse than that** — as a
  non-owner its read answered 0 rows for a row that exists (every request reading `first_seen`) and
  its write was refused `42501` *after* the handler committed, escaping as a 500 that a client
  retries into the second execution the record exists to prevent. Both reproduced by hand on a live
  cluster, beside the pair that settles it: with the flag, a retry after a process restart reads
  `replay_hit_match`; without it, `first_seen`. Two subsystems turned out to be the disease behind
  five of the stores — **nothing in the workspace evaluates a feature flag** (17 evaluation reasons,
  zero producers, no manifest field, no CLI flag, no route: a modelled domain with no mechanism, and
  a second complete flag subsystem in `packages/deploy`, which has zero importers and holds the only
  `evaluateFlag()`), and **there is no incident lifecycle surface at all**, which makes `human_owned`
  unreachable in every deployment and sev1/sev2 incidents impossible to close. The recurring rule
  held for the fourth time: **the honest fix sits one level up from where the pain was felt** — here
  a fifth strategy rule over the dependency graph, and a measurement that *refused* its own
  transitive version, because module reachability is not symbol reachability and `export *` makes it
  answer "reached" for precisely the stores the rule exists to report.

  ADR-0337 is the seventh sweep, and it widened ADR-0336's predicate past the `Postgres*` naming
  limit that ADR had declared as a blind spot. **Four of the five blind spots had live members**, and
  what came out is one class with two faces — both *a capability built, catalogued, documented and
  reachable by no deployment*, and in both the sharpest member is one where the **absence is
  reported as success**.
  *Face one: six drift replayers with zero callers.* `WorkflowReplayer`, `DrReplayer`,
  `SloEnforcementReplayer`, `AccessReviewReplayer`, `GatewayReplayer` and
  `incident-response-runtime-pg`'s function-shaped one — each advertised in this file as shipped,
  none ever constructed outside its own tests. **Two were bug-fixed in consecutive increments while
  nothing called them** (ADR-0330 stopped the workflow one reporting drift on every healthy instance;
  ADR-0333 gave the DR one an issue kind it could not emit), so a detector's false positives *and*
  its false negatives were corrected and no deployment ran it. The sixth exports no class, and
  `new X(` is the whole matching strategy — so the one driver the fence cannot see is, by this file's
  own account, the sole detector for a tamper class. Thirteen defects came out of them, every one
  invisible to its own tests, including **ADR-0330's exact defect in the same function one field
  across** (`variables` is `JSONB`, which comes back *parsed*, compared with `!==`).
  *Face two, and the more serious: at-rest PHI encryption is reachable by no deployment, and its
  absence is certified.* On `--store pg-columns` every PHI write is a **500** — `patient.mrn` is
  genuinely `bytea` and nothing in the workspace sets `app.column_encryption_key`, which four ADRs
  specify and ADR-0091 names outright. On `--store pg` the same write **succeeds and stores
  plaintext** (`document->>'mrn'` reads back `MRN-1`), a limitation documented nowhere. And the
  encryption-at-rest control was **vacuously satisfied** on exactly that deployment, because
  `satisfied = issues.length === 0` and a JSONB schema declares zero at-rest columns — so a HIPAA
  report asserted encryption over plaintext PHI with a reassuring summary. That is ADR-0335's
  `certifiable` defect **inverted**, and the inversion is the dangerous direction: a falsely-false
  control costs a certification, a falsely-true one *is* the compliance failure. The control is fixed;
  the key management is a design decision ADR-0070 left open and is now the top open item.
  The increment's cleanest results are two **deletions** — `CampaignScheduler` and
  `UnroutableChannelSender`, both second spellings of live code — because **a callerless class is a
  question, not a verdict**; and two refusals argued from measurement rather than taste: the
  compiler-API answer to the factory blind spot (26 s, 1.2 GB, and cross-package symbols resolving
  into `dist`, so it is green only after a build and against a stale one green on the last build) and
  the general function-shaped fence (82 of 812 modules, mostly contracts packages, and it misses three
  of the six replayers it exists to find).

  ADR-0338 is the first increment in this run that is **not** a sweep: it takes the single defect
  ADR-0337 ranked top and closes it, and the class is **a specification with no setter**. At-rest PHI
  encryption was reachable by no deployment — four ADRs specify
  `current_setting('app.column_encryption_key')`, ADR-0091 names the requirement in so many words,
  and **nothing in the workspace set the GUC**, so every `phi`/`regulated` write was a 500 on the
  typed store and plaintext on the default one. The decision it had been waiting on is a
  key-management choice, and the answer is the one the repo had already made once for the
  structurally identical problem (ADR-0302's per-tenant key from one deployment secret): **derive per
  tenant with HKDF, store nothing.** That bought the whole increment in one piece — no new table, no
  CHECK migration on a `meta.crypto_keys` that is structurally a public-key directory, no cipher added
  to a package with three pins asserting it has none — at one stated cost, **no crypto-shredding**,
  which is the only argument for a stored DEK and is now the top follow-up.
  Three things fell out that were sharper than the defect. **ADR-0070's own stated direction would
  have destroyed PHI**: it proposed mirroring the tenant-RLS GUC idiom, and
  `pgp_sym_encrypt(x, current_setting('app.k', true))` returns **NULL silently**, so a missing key
  writes NULL over every value and reports success — live on three of the five real classified fields.
  The `''` reset value that *breaks* the RLS cast is what *saves* this path, by accident.
  **The per-tenant fallback was a silent downgrade from ciphertext to plaintext**: a tenant whose DDL
  application is refused is served from the JSONB store, which has no encryption, so ADR-0314's "their
  data is in a different place than they think" was understating it — and the guard had to cover
  `withTransaction`, which hands out the *underlying* store, or every handler that writes in a
  transaction would route around it.
  And the worst of the three, found while verifying the fix: **the write handed the plaintext straight
  back.** Redaction was registered against `[list, read]` while the routes emit
  `list, create, read, update, delete` plus one per workflow transition, so a `PATCH {"sex":"female"}`
  returned `mrn`, `given_name`, `family_name` and `date_of_birth` — fields the same credential cannot
  read through `GET`. Encrypting a column at rest while any write discloses it is ADR-0337's
  falsely-true-control direction in a new place. That list was ADR-0288's `needsAuditEmitter` shape
  for the **fourth** time, and a static helper could never have been right: a transition's operationId
  comes from the manifest's workflow, which a `(name: string) => string[]` cannot know. It is derived
  from the routes actually derived now.

  ADR-0339 is the mirror of ADR-0338, and the class is **a rule with one half wired**. ADR-0329 put
  `privilegedForClass` behind both the read redaction and the write mask *specifically* so the two
  could not diverge — and only the read half was ever called, which made that property
  unenforceable rather than merely unchecked. What the measurement showed is an asymmetry that is
  total and in the dangerous direction: of **46** sensitive-classified fields in the seven packs,
  **39 were unreadable by every role in every deployment** (the policy had no producer, so an
  empty policy refused everyone and only an explicit per-field `read` grant came back) and **all
  46 were writable by anybody** with entity `update` (the mask had no caller *at all*, so the 7
  carrying an explicit `update` grant were no better off than the other 39 — which is why the live
  example below is one of them). 39 is the **read** side alone, 46 minus the 7 with a `read`
  grant, and this file carried it for the write side too until ADR-0361's increment re-measured
  it. Neither side had a
  symptom, because total redaction looks exactly like classification working. Live: `case_worker`
  changed `Citizen.national_id` against the pack's own `update: ["gov_admin"]`, and `front_desk`
  **blind-overwrote** `Patient.mrn` — replacing a medical record identifier it cannot read before
  or after, in the column ADR-0338 had just made ciphertext.
  The split that made it shippable is the whole decision: an **explicitly declared** grant is
  enforced always (7 fields, each deliberate, and it cannot make anything uncreatable), while the
  **classification default** is opt-in because with no declaration all 46 are unwritable and 12 are
  `required`, so seven entities become uncreatable by every role — so the flag refuses at boot and
  names them, and that list is the migration guide. The recurring rule held a fifth time: the honest
  fix sits one level up from the pain. The pain was a callerless function; the fix was the
  declaration surface that function needed and never had.

  ADR-0340 takes ADR-0339's own Q3 and corrects two of the three things that ADR said about it. The
  class is **an obligation handed back and dropped**: `rbacCheck` returned `requiresAbac` for a
  grant carrying `abac` and **nothing read it**, so an ABAC-qualified grant granted
  unconditionally — the inverse of this repo's own *fail closed* invariant, inside the authorization
  decision. What ADR-0339 missed is that the hole is in **five** functions, and the four in
  `fields.ts` are the worse place: each reads `rule.roles` and never `rule.abac`, and two of them
  are the pair ADR-0339 reached for as its fix, so an **explicitly declared** per-field grant — the
  7 it made authoritative with no flag — was enforced as to roles and silently unconditional as to
  attributes. Measured by building the committed tree in a worktree: one grant on `Patient` yielded
  `{"allowed":true,"requiresAbac":…}`, `{"readable":["mrn"],"redacted":[]}` and `{"ok":true}` — all
  three unsafe, and the middle one **disclosed the PHI field ADR-0338 had just made ciphertext** to
  a grantee whose grant says a policy must admit them first. `abac: ""` also parsed, and
  `"" !== undefined`, so an empty key was a live obligation naming nothing. It is not gated on a
  pack author: `ManifestSchema.permissions` is `@crossengin/auth`'s own `EntityPermissionsSchema`
  unwrapped, so **the Architect can author one** and a reviewer approves a declaration the runtime
  discards.
  The decision converges rather than invents — `workflow-engine`'s `ABAC_CHECK_GUARD` already read
  the reference as a `policyKey` and already **threw** on it — so `abac` is documented as an opaque
  key bounded the same way, `""` is refused, and `dischargeAbac` is the one function that calls an
  evaluator: no obligation → `null` (*nothing to check*, deliberately not a `satisfied` discharge,
  because reporting the second for the first claims an evaluation that never ran), no evaluator →
  `undischargeable` (a statement that nothing could answer, not a claim about this principal's
  attributes), a throw or an out-of-enum return → `undischargeable`. One
  `OperateRuntimeOptions.abacEvaluator` threaded from `compile.ts`, the only module holding all five
  readers, because two evaluators would let the read and write halves disagree about one grant.
  And a manifest declaring an obligation the deployment cannot discharge is **refused at boot by
  name**, with no escape hatch — ADR-0338's `--allow-plaintext-phi` exists because plaintext PHI is
  degraded-but-coherent, while an unevaluated obligation is the opposite of what the manifest
  declares, and the measured count across the seven packs is **zero**, so refusing breaks nothing
  that worked. The attributes are deliberately **not** wired, and the ordering is the whole
  argument: the source does exist (ADR-0339 said it did not), but before this change `{}` erred
  toward granting and disclosing and after it the same `{}` errs toward denial — so an evaluator
  wired first is wrong-and-safe, while attributes wired first would restore the hole.

  ADR-0341 closes that Q1 and **corrects that last clause of its own predecessor**: with obligations
  refused at boot, attributes wired alone restore no hole — nothing could read them either way — so
  the cost of that order is *inertness*, not exposure, and the real reason to do both halves at once
  is that **either alone is inert**. The class is **a record written and never read**:
  `meta.user_tenant_membership.abac_attributes` has had a writer *and* a reader since ADR-0335 and
  nothing that makes a decision, so the ABAC domain had its subject recorded and never consulted.
  The bound that shapes the whole increment is in the seam: `AbacEvaluationInput` carries
  `{policyKey, principal, entity, operation, field?}` and **no record**, so "owns this row" and
  `user.department == record.department` — one of the two spellings this package's own tests used —
  are inexpressible by **any** evaluator here, OPA included. What is expressible is a predicate over
  the principal's own attributes, and that is what shipped.
  Four decisions carry it. `Principal.abacAttributes` is `Record | null` and still **required**,
  because an evaluator handed `{}` cannot tell *has none* from *nobody looked* — ADR-0331's
  distinction inside an authorization input, failing in the allowing direction — and `dischargeAbac`
  refuses `null` **before calling the evaluator**, so a deployment's own evaluator cannot get it
  wrong. Attributes resolve **once in the auth stage** on `ResolvedPrincipal`, which one decoration
  covers for both credential families because an api-key validates in `authenticate` and then
  resolves in a *separate* `resolve_principal` stage through the same resolver a JWT uses. The
  directory **writes no SQL** — `PostgresUserStore.membershipFor` already carries the
  `withTenantContext` and strict `scopeFilter` that table's single `ALL`-scope policy requires — and
  looks nothing up for a credential that names no person (`PRINCIPAL_KIND_NAMES_A_PERSON`, a total
  map with only `user` true), because ADR-0331's bare api-key is a `service_account` on one shared
  placeholder id. And `--abac-policy` is the consumer, whose declaration is *also* what switches the
  producer on: the lookup exists exactly when something reads it. The boot check changed shape with
  it — `evaluatorDeclared: boolean` became `answerableKeys: ReadonlySet<string>` with a second
  refusal `policy_undeclared`, because "an evaluator exists" was never the question; a
  declared-but-incomplete policy set answers `undischargeable` for exactly the keys it lacks, which
  is the same silence the boot refusal exists to end.

  ADR-0342 crosses the bound ADR-0341 named, and the class is **a question the seam could not be
  asked**: the input had no place to put the record half of all ABAC policies are about. Putting it
  there was not the hard part. **No call site had the record at the moment it decided** —
  `rbacCheck` runs before any store call in every handler — and the availability is neither uniform
  nor derivable from the grant: entity `create` never has one, `read` loads it immediately *after*
  the check, `update`/`delete` load it *conditionally* and after the write mask, a transition loads
  it unconditionally, `list`'s subject is a **set** so a per-row answer is a filter and not a 403,
  field `read` is redacted once per *response* by a generic JSON walk that cannot identify a record
  boundary, and field `update` sees only the caller's patch. So availability became part of the
  contract — `ABAC_RECORD_AVAILABILITY` over eight positions, with its reasons — and a fourth
  outcome **`deferred`**, mapped `false`, makes a deferral a *refusal pending a record*: a call site
  that ignores it denies, which is ADR-0340's dropped obligation prevented one level up, where the
  forgetting would have been per handler instead of per function. The positions that can never
  supply a record are **refused at boot by name**; the one that sometimes can is **reported** rather
  than refused, because "you may only set this field on a record that is yours" is a coherent
  declaration whose consequence — not settable at create — is a fact to say and not a
  misconfiguration. The handlers' invariant is that **nothing is written before the obligation is
  discharged**, and a record-level denial is a **403 and not a 404**: a 404 would make a
  record-predicate refusal indistinguishable from a missing record, and neither the caller nor an
  operator could then tell "not yours" from "not there".

  ADR-0343 takes the refusal ADR-0342 ranked first among its own open ends and finds that it was
  **not the kind of refusal it claimed to be**. The class is **a structural refusal that was really
  a wiring one**, and the repo already had the vocabulary to tell them apart and did not apply it:
  `pg-unreachable-stores.ts` splits a blocked store into `prerequisite_of_unbuilt_surface` (blocked
  by *ordering*) from `contract_cannot_carry_the_surface` (blocked by *shape*) on the stated grounds
  that calling both "unwired" sends the next person to write the route that cannot be written
  honestly — and ADR-0342's three `never` positions were exactly those two kinds mixed. A create has
  no row and a list's answer is a row *set*: both shape. Field `read` had the record all along and
  the stage never looked: ordering. So response redaction is **per record** now, driven by a
  `ResponseRecordShape` (`record` / `page` / `none`) **declared** from the route's action through a
  total map and never probed from the body, because a heuristic over the response decides an
  authorization answer and a record carrying its own `data` array would be misread. The cost is
  decided by the **`deferred` outcome doing a second job**: compute once with no record, and if
  nothing deferred stop — one evaluation, today's walk, today's bytes, for every deployment that
  declared no record policy. Only a deferral pays per record, and the per-record pass can only ever
  *relax* the record-free one, so every fallback is the stricter set and fail-closed is the
  algorithm's default direction rather than an invariant to remember. Two `never` positions remain
  and both are now shape, with the distinction stated: **a field policy filters columns within a
  row, which a response can express per record; an entity-list policy would filter rows**, leaving
  the page's cursor describing a set the caller was not shown.

  ADR-0344 closes ADR-0343's own Q1, and the class is **a seam that could only be asked one
  question at a time**. `AbacEvaluator` is synchronous, so nothing can coalesce after the fact — a
  batch has to be *collected* before any answer is needed, which makes "add a batch arm" a question
  about each reader's control flow rather than about the type. Asking it reader by reader found
  **three of that open end's own claims wrong**. It does not touch all five readers but **one**,
  and the four that do not, do not for three different reasons: `rbacCheck` asks one question,
  `computeFieldRedaction` is callerless, and the two write masks **must not** batch,
  because they stop at the first refusing field so a pool would evaluate past the rejection — more
  work, and it hands the policy layer questions whose answers were never needed, which is ADR-0340's
  reason `rbacCheck` evaluates only after the role check. The shape is not
  `(inputs) => AbacOutcome[]` either: a bare positional array makes a permuted answer set a **silent
  mis-authorization**, roughly half of which allows, and no check over the *outcomes* can see it
  since every one is a legal answer to some question in the set — so an answer echoes its own index,
  pure redundancy for a correct implementation and that is its whole job. And the fan-out is
  **records × fields**, not records, so the pool spans both axes and the plural entry point is in
  the contracts package rather than only in the gateway.
  The refusal granularity is the decision and it splits on whether the **correspondence** survives:
  a throw, a non-array, a wrong length or a wrong index fails the **whole** batch, because no answer
  can then be shown to belong to its question and the prefix of a short array is not evidence that
  it answers the first ones; an `outcome` outside the enum fails **that one**, where the position is
  intact. A throw is in the first column for its own reason — catching per element would be
  *strictly laxer*, leaving the other N−1 answers standing as authoritative when what the throw says
  is that the implementation is in an unknown state. `evaluateBatch` is a **sibling, never a
  replacement**: supplied without a single evaluator it refuses everything, since the three
  reachable readers that ask one question would already be answering `undischargeable` and the one
  that could use the batch must not enforce a policy the rest of the deployment cannot. Deliberately
  **no total map** over the five readers — `ABAC_OUTCOME_ALLOWS` is a map because a new *enum member*
  must be a compile error, while these are hand-written functions, so a map could not make a sixth
  reader a compile error and would be a constant nobody reads. `--abac-policy` supplies the
  degenerate batch **on purpose**, so the validated branch is the branch this repo runs rather than
  one reached only from its own tests (ADR-0336's class, which the increment would otherwise
  reproduce). The gateway enumerates the records by **running its own redactor** with a collecting
  field-set resolver, so enumeration and rebuild are one traversal definition — and the property is
  a **superset**, not an equality, which is the safe direction, because `page`'s rebuild skips a
  wrapper key the record-free set names. Measured on the same tree, both arms: a 500-row page with
  three obligated fields goes from **1,503 evaluator calls to 2**, and live the crossings are
  2 per response with **zero** on the single arm.

  ADR-0345 closes ADR-0343's Q2 and the class is **a denial that is not a refusal**. It is the
  *mirror* of ADR-0343: that increment found a structural refusal that was really a wiring one, and
  here the stated reason was **true** — ADR-0343's own sentence, *"an entity-list policy would
  filter rows, leaving the page's cursor describing a set the caller was not shown"*, is exactly
  what happens. So one refusal was imaginary and one was real, and the real one closes by paying its
  price rather than by discovering there wasn't one.
  The crux is the cursor. `encodeKeyset` is `base64url(JSON.stringify({k, id}))` — plainly
  reversible — and `nextCursor` comes from the **last row of the store's slice**. Of the three
  candidates, two are unsound: the **last visible row** leaves a fully-denied page with no cursor,
  so the walk loops or silently truncates (a wrong answer, which this repo ranks below a refusal);
  **re-filling to `limit`** makes the work per request a function of the policy's *selectivity*, so
  a caller who may see 1% of rows costs ~100 store calls for one page — a denial of service
  reachable from a manifest declaration. So the store's cursor passes through **untouched**, and the
  price is that **a page can be short or empty while `nextCursor` is non-null**: termination is
  `nextCursor === null` and nothing else. Verified against every in-repo consumer. There is no
  withheld count either, and the contrast with ADR-0342 is the useful part — a record-level denial
  is a 403 and not a 404 *because the caller had named the record*; here they named nothing, so
  **who named the record** is what decides whether telling them it exists costs anything.
  The residual is that the cursor names the **position** of withheld rows, which is irreducible —
  advancing past a withheld row means naming where it was. One rule holds it to position rather than
  contents: **while rows are being withheld, a caller may not address rows by a field they may not
  read**, over `?sort` (the cursor carries the value), `?filter` and `?q` (a chosen-predicate oracle
  the response answers through the cursor's presence). A 400 per surface, **before the store call**.
  A classified *default* sort is a **boot refusal** instead, because the sort came from the manifest
  and no caller can opt out — and the measured member is `erp-healthcare`'s `Patient`, sorting by
  `family_name`, which is **`pii`** and deliberately *not* one of ADR-0338's five ciphertext fields
  (an earlier draft claimed that tie and it is false). 132 list views across the resolved packs,
  every one with a default sort, 28 distinct by `(entity, sort)`, one hit.
  `ABAC_DENIAL_EFFECT` is the **second axis** this made real: availability answers *can this
  position be asked*, and until now that was the only axis worth having because a denial always
  refused. The association **list** filters too (its cursor is an offset into the owner's links, so
  no disclosure applies), while the **count** keeps refusing with **no logic change** — `deferred`
  is already `false` — and needed only its own sentence in the 403, because the availability reason
  now says the list position has every row in hand, which is true of the route it counts for and not
  of itself. Live, the case the design turns on: a fully-denied page returns **0 rows with a
  non-null cursor**, the walk terminates, and two principals holding one role see an exact
  complement of the seven rows.

  ADR-0346 closes ADR-0345's own Q1 and the class is **a format that was never meant to be read, and
  was**. `ListQuery.cursor` has been documented as an "opaque keyset cursor" since it was written and
  is `base64url(JSON.stringify({k, id}))` — opaque by *convention*, which is not a property, and row
  filtering is what turned the convention into a disclosure.
  It opens by correcting this file: ADR-0338 is recorded here as having added "no cipher to a package
  with three pins asserting it has none", and **the pins never said that**. They describe the key
  *registry* — which algorithms a registered `KeyHandle` may have, what a handle is for, which
  key-management acts are audited — which is exactly why ADR-0338 could add `key-derivation.ts` and
  leave all three alone. An AEAD over a **derived** key is outside all three for the same reason, so
  this increment adds the package's first cipher and the pins stay, with
  `isCryptoOperation("encrypt")` still false and a test pinning that `aes-256-gcm` is not a
  registerable algorithm *because* adding it would mean a registered cipher key needing a
  private-material column `meta.crypto_keys` does not have.
  What made it a small increment: **the cursor is opaque to the client, not to the store**, so
  sealing is an envelope at the handler boundary and `store.ts`, `entity-ops.ts`, `column-store.ts`
  and `list-sql.ts` are untouched — they go on producing and consuming the plaintext keyset.
  Three decisions carry it. **One refusal reason**, `not_for_this_request`, because GCM fails
  identically for a tampered ciphertext, a wrong tenant, a wrong entity, a changed sort and a rotated
  key — the context is an *input to the authenticator*, not a field that comes back — so two reasons
  would claim a distinction the primitive does not make. **A declared `s1.` tag at a fixed offset**
  rather than a probe, and the concrete reason is that the formats are not distinguishable by
  inspection: "does it parse as `{k, id}`?" would read a sealed cursor whose random nonce happened to
  decode into JSON as plaintext. And **legacy plaintext is accepted**, so no walk in flight breaks —
  safe because a client can only construct a cursor whose contents it already knows, since the threat
  is reading *ours* and forging was always possible; the cost is that a legacy cursor carries no
  binding. The binding is canonical JSON of `[tenantId, entity, sortSpec]`, not a delimiter-joined
  string, because `entity:"A"` + `field:"b:asc"` collides with `entity:"A:b"` + `field:"asc"` under
  `:`; it is deliberately **not** bound to the principal, since filtering is post-hoc over one store
  ordering so A's position is a sound position for B; and a soundness fix falls out of the sort
  binding, because `isAfter` compares `k[i]` against `sort[i]`'s field so a cursor replayed under a
  different `?sort` is meaningless today.
  The boot refusal gets an **escape hatch** — `--allow-cursor-disclosure`, ADR-0338's
  `--allow-plaintext-phi` shape and deliberately not ADR-0340's no-hatch shape, because a plaintext
  cursor is degraded-but-coherent (the filter works, the rows are withheld, only positions leak)
  while an unevaluated obligation is the opposite of what a manifest declares. Live, the two modes on
  the same request are the whole increment: one hands back
  `{"k":["l2"],"id":"rec_muybya7w0002"}` — `l2` being an oncology row this cardiology caller is
  withheld on every page — and the other `s1.wfHmgacd…`.

  ADR-0347 takes the item that has sat top of this file's PHI entry since ADR-0338 — the DEK
  envelope, and with it crypto-shredding — and the class is **a claim nothing could have supported**.
  Most of the increment is correcting the motivation on file. ADR-0338 recorded the envelope's gain
  as making a tenant's PHI *"unrecoverable including from backups, a claim ADR-0316's `DROP SCHEMA`
  cannot make"*, and that is **false**: the wrapped key and the ciphertext it protects live in one
  database, so one backup holds both and restoring it restores the pair. What the envelope buys is a
  **bounded deletion horizon** — afterwards the data is recoverable only from backups predating the
  destruction, and only until those expire, so the bound is the deployment's backup retention rather
  than the destruction itself — where a derived key gives **no horizon at all**, since it exists
  wherever `COLUMN_ENCRYPTION_SECRET` does. That difference is the whole value and is enough;
  claiming more is ADR-0337's falsely-true control in a new place. A KEK in an external KMS is what
  would support the original claim, and is the top follow-up.
  The second correction is what shaped the design: **it holds only for a key that is random**. A
  deployment switching modes has tenants already holding ciphertext under the derived key and
  **nothing records which key wrote a column**, so provisioning a random key for one of them makes
  their PHI permanently unreadable. The only safe migration is to **seed** that tenant's data key
  with the bytes of the key their ciphertext is already under — and a seeded key stays recomputable
  from the deployment secret, so destroying its row destroys nothing. So shreddability is a property
  of **the row and not the mode**: `provenance` is on the table, `shreddabilityOf(mode, provenance?)`
  answers over the pair, and an `envelope` with no provenance in hand answers `derivable`, the
  conservative direction, because claiming `shreddable` for a recomputable key tells a deployment
  its Article 17 erasure bounded a horizon it did not.
  Two things fell out. The erasure needed **no new code** — `meta.tenant_data_keys` carries
  `tenant_id` and cascades from `meta.tenants`, which is deliberately the *opposite* of
  ADR-0335's `PLATFORM_RECORD_TABLES` rule, since those tables exist to outlive their tenant and
  this one exists not to — confirmed by the shared-table erasure's own counts failing on 114 → 115
  the moment it was catalogued. And **the probe was wrong, and only live could say so**: the first
  one asked whether the tenant's own Postgres schema existed, which is sound only for ADR-0314's
  per-tenant manifests, so for a boot manifest — whose column tables sit in the shared schema — it
  answered `false` for every tenant, handed each a random key and made the PHI written one step
  earlier unreadable. It asks the direct question now (does a table carrying an encrypted column
  hold a row for this tenant), with `42P01` as the one honest `false` and every other uncertainty
  resolving to `true`.

  ADR-0348 closes ADR-0339's own Q1 — the **39 unauthored per-field grants**, top of this file's
  field-authorization entry ever since — and the class is **one grant list consulted at two
  different moments**. `FieldPermission` was `{read?, update?}` with no `create` arm, and the write
  mask asks the same list on a create and on an update, so three things followed and all three were
  live. *The default deployment's classified fields are **write-only***: measured through real HTTP
  on the shipped `erp-core`, `ap_clerk` POSTed a Vendor carrying `tax_id` and `contact_email`, the
  row holds both, and neither the create response nor `GET /v1/vendors` returns either — **to the
  credential that just wrote them**. All 21 of `erp-core`'s classified fields are in that state, so
  a user fills in a vendor's tax ID, it saves, and the field is blank on every later view while
  anyone with entity `update` can silently overwrite it. *The policy everyone wants is
  inexpressible*: **set once at registration, never changed** — an MRN, a national id, a tax
  identity — cannot be said with one list, which is why ADR-0339 found `front_desk`
  blind-overwriting `Patient.mrn` and could only have fixed it by stopping the desk registering
  patients. And *ADR-0339's "each deliberate, and it cannot make anything uncreatable" is false
  about **three of its seven***: a `required` classified field whose write grant is narrower than
  its entity's `create` grant makes the entity uncreatable, and `Citizen.national_id` (403
  reproduced live, `case_worker` cannot register a citizen), `WorkOrder.cost_estimate` (`foreman`
  cannot raise one) and `PerishableLot.cost_per_unit` (`receiving_clerk` cannot receive one) were
  all in that shape.
  The fix is four parts and the recurring rule holds a **sixth** time — the honest fix sits one
  level up from the pain. The pain was 39 unwritten declarations; the fix is the **arm they needed**
  (`create?`, absent falling back to `update`, so not one shipped grant changed meaning) and the
  **validator that makes writing them safe**, and only then the grants. The asymmetry that earns the
  arm is the whole argument: `update ⊆ read` is enforced and **`create` is deliberately not**,
  because *a principal supplying a value already knows it, so writing it discloses nothing, while
  changing a value you cannot read destroys one you cannot see*. The three kernel rules are
  **validation errors and not boot refusals**, the opposite of ADR-0340's choice and for a stated
  reason: an obligation's dischargeability is a property of the *deployment*, while these are
  properties of the manifest alone and so are decidable by a pack author, by `crossengin validate`
  and by the reviewer approving what the Architect designed — a rule checkable earlier should be.
  Two of the three defects were **found by that validator mid-increment** rather than by anybody
  looking, which is the clearest evidence it was the right level. Every fix adds only the `create`
  arm; no `read` or `update` list in any of the three changed.

  ADR-0349 closes ADR-0347's own Q1 and the class is **an executor whose only atomic unit was the
  wrong one**. `KeyRotationMigrator` rotates a whole *schema*, one *column* per transaction, and for
  a per-tenant key both axes are wrong: `reencryptColumnSql` emitted `WHERE col IS NOT NULL` and
  `ReencryptColumnInput` had **no field that could carry a predicate**, so under a boot manifest —
  where every tenant's encrypted columns share one schema with a `tenant_id` column — a rekey for
  one tenant would re-encrypt every *other* tenant's PHI under this tenant's key pair. The
  per-column split bought nothing either: a resume ledger makes a half-applied rotation *resumable*
  while `ColumnEncryptionKeySource` resolves exactly one key per tenant per operation, so a
  half-rotated tenant is unreadable either way. `ReencryptScope` is required and discriminated,
  all three statements are built from **one** `scopeWhere`, and `rekeyTenant` is **one transaction**
  in `crypto-pg`. The subtle part is that `rls_would_confine_this_session` **stays** and for an
  inverted reason: for a tenant-scoped rotation the confinement *is* the scope for the **rows** and
  is false of the **count**, since a confined session reports `0 rows re-encrypted`, byte-identical
  to "this tenant holds no ciphertext" — and the rekey's next act is to delete the generation those
  rows are under. So the tenant predicate is **not a second belt beside RLS, it is the only
  confinement**. The sharpest thing review found afterwards: `rotation.rowsReencrypted === 0` used
  to pass straight through to `rekeyWithin`, so a confirm pass over an empty row set succeeded
  vacuously and the next statement destroyed the only copy of the key — now `nothing_to_reencrypt`.

  ADR-0350 is the Article 17 counterpart, and the class is **a remit whose mechanism was half of
  it**. `DELETION_SUBSYSTEMS`' `shared_tables` has said "rows in the shared boot schema and `meta.*`"
  since Phase 1 and reached `meta.*` alone, because every `META_TABLES` entry declares
  `schema: "meta"` while `ColumnMappedEntityStore` writes to `<--schema ?? "public">`; and
  `eraseTenantSchemaWithin` drops only the derived `t_<hex>` schema a **boot**-manifest tenant does
  not have, so it attested `nothing_to_erase`. On `--store pg-columns` nothing erased the tenant's
  records. What makes it worse than a gap is that **which of two outcomes a tenant got was an
  accident**: measured live, a tenant holding *any* erasable platform row (one
  `meta.operate_tenant_settings` row sufficed) got a signed, anchored `v3` tombstone whose scope
  named exactly that table while `public.patient` still held the PHI — false by **omission**, which
  `contentManifestOk`, `tombstoneMatchesAttestations` and the chain all structurally cannot see,
  since every digest commits to the scope that *was* composed and that scope is correct — while a
  tenant holding none got `assemble/scope_empty`, *"there is no deletion to attest"*, about a
  patient's medical record. So a fence existed and fired on the **harmless** case; one unrelated row
  moved its predicate to the dangerous one, and its existence is why nobody looked.
  The fix is one subsystem with two named groups, not a seventh subsystem — a seventh key makes
  `TombstoneCapabilityDeclarationSchema`'s `.strict()` parse fail on **every stored v2/v3 tombstone**
  and fire ADR-0324's paging `sev1` on honest proofs, needing a fourth content tag. (ADR-0351 then
  wrote that tag and found this was never the *decisive* objection — see below.) And the ordering
  question turned out to be the real work: `topologicalEntityOrder` orders the **reference** graph
  and deliberately appends a cycle's members in *insertion order* (ADR-0285), which has no ordering
  property at all — 18 of `erp-core`'s 51 entities are cycle leftovers and reversing that list puts
  the parent first on two `RESTRICT` edges. The cycle is contributed entirely by edges that constrain
  no deletion (`Employee.department_id` is `set_null`), so the plan orders a **weighted** graph:
  `restrict` non-negotiable, `cascade` honoured where the graph admits it (a relaxed one undercounts
  the proof's row figure), `set_null` given up first, and a `restrict`-only cycle named for the
  erasure to refuse by name. The recurring rule held a **seventh** time — the honest fix sits one
  level up: the pain was a target list, and the fix is the order that list needed and never had.

  ADR-0351 closes ADR-0350's own Q1 and the class is the one this lineage keeps finding: **a silence
  in the scope that the bytes cannot make honest.** v1 could not tell *we have no object storage*
  from *nobody asked*, so ADR-0329 signed the capability declaration as `content.v2`; v2 could not
  tell *nothing was lawfully retained* from *this proof cannot say*, so ADR-0331 signed the retention
  claim as `content.v3`; and v3 could not tell *this deployment has no typed per-entity relations*
  from *it has 54 and the manifest declared none* — the second being the wrong pack having loaded,
  which `boot-erasure-report.ts` warns about at boot and no stored proof could say. Measured rather
  than reasoned, and against a proof this repository wrote: the same scope, declaration and claim
  hash to `d8cb6d10…` under v3 on **both** store modes, and `d8cb6d10…` is the digest **ADR-0350's
  own live pre-fix run stored** — in the tombstone whose scope named exactly
  `meta.operate_tenant_settings` while `public.patient` still held the PHI. So
  `crossengin.tombstone.content.v4` signs `{model, schema, relationCount}`: the model separates
  ADR-0350's two cases and the count separates the third, since a column store serving a manifest
  declaring no entity is **legitimate** under per-tenant manifests and the signature of a
  misconfiguration otherwise. It is a *declaration* and not a measurement, which is what decides
  where it lives — every field is derivable from `--store` and the manifest before a row is read, so
  it rides beside `capabilityDeclaration` rather than on an attestation, where a count would sit
  next to `rowCount` and be read as part of what was destroyed. And the **count is derived, never
  supplied**: the pipeline fills it from the target list it hands the erasure, so the figure the
  digest commits to *is* the number of relations that deletion targeted, structurally rather than by
  a cross-check somebody has to remember.
  Two things were sharper than the tag. **The fence that existed was not one**: adding `"v4"` to the
  enum and nothing else typechecked and passed every test, and `proofVersionCoversDeclaration("v4")`
  answered `false` — so a v4 record was structurally a **v1** record, the two refinements refused it
  for carrying a declaration or obligations, and `readDeclaredAbsences` reported it
  `reason: "v1_proof"`: a silent regression of both v2 and v3. The test written for exactly that case
  said so in its own comment — *"a fourth tag added to neither list would silently sign nothing
  new"* — and then asserted only that the predicates return a boolean, which they do for every
  input. It documented the hazard and checked nothing. So the three membership lists became **one
  total map** `PROOF_VERSION_COVERAGE` with the arrays derived from it, which keeps the original
  refusal intact (*a version names a domain tag, not an ordinal*, so an ordering comparison is still
  refused) while buying what lists could not: a new member is a compile error until it says what its
  bytes carry. And **the migration had a sharp edge that needed answering rather than noting**: the
  column lands automatically and the widened CHECK does not (ADR-0330 — a widening CHECK cannot be
  told from a narrowing one), so between the upgrade and that one manual `ALTER` the v4 `INSERT` is
  refused `23514` **inside the deletion pipeline's transaction, after the tenant's data has been
  deleted** — rollback, `aborted`, the request left `in_progress` for a human to meet under an
  Article 12(3) deadline. `proof-version-probe.ts` asks `pg_get_constraintdef` at boot and refuses
  the deletion surfaces printing the `ALTER`, gated on `--deletion-capabilities` being declared and
  deliberately **not** on a list of the flags that mount a deletion surface, which is ADR-0288's
  maintained list avoided in the place it has already been wrong three times.

  ADR-0352 closes ADR-0351's Q5 and the class is **a probe that was one instance of a class**. The
  sharp edge is ADR-0330's: a *widening* CHECK cannot be told from a *narrowing* one, so
  `planSchemaReconciliation` **used to report** `constraint_needs_validation` on a populated table
  rather than planning it — which meant **every enum value the catalog has ever added was refused
  `23514` on every already-applied deployment until an operator ran an `ALTER` by hand**, with
  nothing saying so until a write failed. ADR-0363 closed that half by giving `proveWideningSafe` a
  caller; this survey is the other half and the two ask different questions (see the `proveWideningSafe`
  entry above). Three increments did exactly that and each was found by hand: ADR-0300 (three flag
  kinds), ADR-0334 (`pending_deletion`, whose catalog comment spells the whole problem out), and
  ADR-0351 (`'v4'`, where the refusal lands *inside* the Article 17 transaction after the data is
  gone). Measured from the built catalog objects rather than the source text — which matters, because
  a single-line `grep` for `check: "…"` finds **66** value sets against a real **287**, since Prettier
  wraps a long declaration onto the next line and `check?: string` is a field on `RlsPolicy` too:
  **777** emitted column CHECKs, **287** value sets over 123 tables, **263** bounded ranges, **213**
  patterns, 13 compound or cross-column.
  The design turns on three measurements. It **evaluates the live predicate and never reads it**,
  because ADR-0351's regex was too narrow inside its own increment — one `CHECK (col IN (…))` deparses
  `col = ANY (ARRAY[…])` on a `TEXT` column and `(col)::text = ANY ((ARRAY[…])::text[])` on a
  `VARCHAR` one — and asking Postgres is total over every shape where a per-spelling regex covers 287
  of 550 probeable checks. `coalesce(E, true)` is load-bearing, since a CHECK passes when its
  expression is NULL, which also makes `col IS NULL OR col IN (…)` *equivalent as a constraint* to
  `col IN (…)` and so the prefix on 29 catalogued checks redundant. A candidate is cast to the
  **declared** type through an allow-list, because `$1::character varying(8)` with a 12-character
  value whose first 8 are in the list answers `admits = true` while the real `INSERT` raises `22001` —
  and dropping a modifier is not uniformly safe either, since `character(3)` → `character` *narrows to
  one character*. And the evaluations run inside `SET TRANSACTION READ ONLY` with a savepoint each,
  because a CHECK can call a volatile function and **evaluating it fires the side effect**
  (demonstrated: a CHECK whose function inserts a row inserted the row), while the fence blocks it
  `25006` and costs the legitimate cases nothing.
  Two decisions are departures. It **reports and never refuses** — a narrowed CHECK on a column
  nothing writes is harmless and refusing would refuse a deployment that works (ADR-0334's reason
  `--tenant-status-gate` is opt-in), so a surface that knows its own write is load-bearing names its
  column through `admissionBlocks`, and **ADR-0351's probe is deleted** rather than kept beside it.
  And `proveWideningSafe` answers ADR-0330's open end by asking the *data* rather than the
  expressions — with the trap that **the count is RLS-confined**: with one violating row the owner
  counts 1 and a non-owner counts 0 while the `ALTER` genuinely raises, so the confinement is asked of
  the catalog and a confined session gets `unknown_session_confined` rather than a claim. Third place
  that class has been found (ADR-0330's erasure, ADR-0349's rekey), and converging it found what it
  took to be eight spellings of one rule. **ADR-0362 retired that reading twice over**: the figure
  is not reproducible from the committed tree by any counting (3 predicate implementations, 5
  modules emitting a verdict, 7 naming the refusal, 9 naming it or a variant), and the copy this
  increment extracted as the only correct one was **not** the most correct of them — it scores 6 of
  8 against live ground truth where `shared-table-erasure.ts`, which was already asking Postgres,
  scores 8 of 8.

  ADR-0353 closes ADR-0352's Q1 — the **upstream** half — and the class is **a table that could not
  accept its own record**. Downstream, the catalog is right and the database is behind, which is
  recoverable by one `ALTER`; upstream, the artifact itself cannot persist its own records and no
  migration fixes it. It opens by retiring **both** findings ADR-0352 recorded for this class,
  because the census behind them read only named `as const` arrays: `REPORT_ENGINES`' third member
  `auto` is a report *definition's* engine preference and the authoritative domain for
  `meta.report_runs.engine` is `ReportRunRecordSchema.engine`, an inline `z.enum` of the two the
  column admits; and `DIGEST_FREQUENCIES`' `immediate`/`never` are refused three times on the write
  path (`DIGEST_WINDOW_MINUTES` answers null, `buildDigestBatch` throws, `delivery-drain` returns
  early) plus by name in `DigestBatchSchema`'s `superRefine`. Neither was a defect.
  The real one is `META_DEPLOYMENTS`, whose four CHECKs were authored independently of
  `DeploymentRecordSchema` — the only record that table stores, field for field — so **four of its
  seven enum fields emitted values the table refused**: `target` *entirely disjoint* (ten against ten,
  no overlap), `app_kind` differing on 6 of 9 by hyphen-versus-underscore, `environment` and
  `strategy` by one each way, while `region`, `trigger` and `status` matched exactly. The table was
  written in pieces against nothing. Two things about it matter more than the defect: **none of the
  four is a subset or a superset**, so every nesting test was structurally blind, and the kernel test
  standing over `target` asserted three values no `DeployTarget` has ever had — a test comparing the
  catalog with itself, under a title naming the contract.
  So the link is **declared**, not derived, and both derivations are refused on measurement: a
  strict-superset rule gives 23 pairs over 15 columns with **0** defects, a field-name rule gives
  **4,938** pairs over 180 columns, and exact set equality is *unsound* rather than imprecise —
  `meta.deployments.environment` equalled `@crossengin/feature-flags`' environment enum exactly and so
  read as accounted for while drifted. Elimination by import (deriving the CHECK from the enum) was the
  strongest alternative and measured **favourably** on the two counts that looked fatal — every
  exactly-matched column but one agrees in *order* as well as membership, so the SQL would be
  byte-identical (`meta.workflow_events.kind` swaps two adjacent members, 280 of 281), and 261 of the
  domains sit in packages kernel can import without a cycle — and is refused for a third: **it cannot
  be total**, since the other 20 are in four packages that depend on kernel and twelve of them in an *app*,
  so the fence is needed for the remainder anyway and a partial elimination plus a fence is more
  machinery than a fence. So `pg-value-set-domains.ts` is the sixth strategy rule and all 288
  catalogued value-set CHECKs declare their domain, `mirrors` asserting **equality** in both
  directions, with the exception surface a measured six — 1 `narrows` carrying the symbol that
  enforces it, 5 `catalog_only`, every one a table already declared writerless for an independent
  reason.

  ADR-0354 closes ADR-0353's Q1 and the class is **a declaration adjudicated by reading, and a
  writer that reads differently**. `mirrors` compares *members*, so two constants spelling one
  domain are interchangeable to it, and a declaration naming the wrong one passes — ADR-0353 had
  the live evidence (`meta.deployments.environment` exactly equalled `@crossengin/feature-flags`'
  enum while the record emits `@crossengin/deploy`'s) and refused exact set equality as *unsound
  rather than imprecise* for that reason, then closed no loop. **And it declared the premise
  wrong**: the parameter-to-field link is *not* invisible to a scan, and measuring it is most of the
  increment. `pg-column-bindings.ts` derives, per catalogued value-set column, the **symbol** the
  SQL binds into it: column *i* ↔ `VALUES` expression *i*, `$n` → `params[n-1]`, and the receiver's
  type → the domain over the four idioms this repo uses to type an enum field. Three plausible
  readings are refused on measurement: a **zip** of the column list against the parameter array
  (`platform-users.ts` writes `VALUES ($4::uuid, $1, $2, $3, 'active')` — column order is not
  parameter order and `status` comes from a literal, so 28 of 73 inserts misalign *silently*); "the
  **next** query call" for the parameter array (`tx.query(\`INSERT …\`, […])` opens *before* its own
  statement, so 56 positions resolved against another method's array — it is the **enclosing** call,
  or the next one that passes the `const` the SQL was assigned to); and position past a **spread**,
  which shifts everything downstream and nothing upstream, so the split is exact and without it
  `access_review_evidence.status` resolved to `evidence.acceptedAt`.
  The load-bearing decision is that **name resolution is the same four steps on both sides** — same
  file, same package, the package the file imports it from, workspace-unique — because **five of the
  first six "contradictions" were the measurement's own fault**: four an imported constant
  attributed to the importing package, and one a bare-name map holding whichever `SeveritySchema`
  was scanned last, `incident-response`'s sev1–sev5 against `observability`'s P0–P3, which would
  have made the most alarming finding of the run an artefact.
  One finding survived and it is the open end's exact predicate: `apps/operate-server` spelled one
  two-member domain twice — `MANIFEST_PROPOSAL_SOURCES`, **module-private** in the module that owns
  the table, and `AI_MANIFEST_SOURCES`, exported elsewhere — the writer binds the private one, and a
  ref can only name what a package exports, so the declaration named the other and equal members let
  it pass. Reported as `binding_domain_unexported` rather than a contradiction, and firing *instead*
  of it, on ADR-0334's rule: while the bound constant is private no declaration can be right, so
  "re-adjudicate the declaration" is a remedy that does not exist. Converged, both pairs (the
  statuses were the same duplication one column across), and `AiManifestRecordLike` stays a
  structural seam because **a value set is not a structure**. Three checks need no declaration at
  all — a SQL literal against its CHECK (23, all admitted), an inline literal union as a **subset**
  (one write path need not cover the domain: `job-engine.ts` binds `"failed" | "dead-lettered"` into
  a six-member column and is right to), and a `string`-typed field as `unconstrained` (4, all on
  `meta.notification_dispatches`, declared with their consequence). **66 of 287** columns are checked
  against the symbol their writer binds (83 bindings, since a column written twice is checked twice),
  and **164 of 287 sit on tables already declared writerless**, which is the bound and is asserted in
  both directions.

  ADR-0355 closes ADR-0354's Q2 and the class is **a value bound into the wrong column of the right
  type** — the one question none of the seven rules before it asks, because every one of them asks
  whether the column exists, whether the `INSERT` is complete, whether a live database admits the
  value, whether the CHECK and the contract enumerate the same members, or whether a declaration
  names the bound symbol, and **a transposition inside one `VALUES` list satisfies all seven**. It
  satisfies them for a reason worth stating: the two columns' domain is frequently the *same*
  domain, so no constraint, no type comparison and no member comparison can separate them —
  `meta.job_runs.input_data_class` and `output_data_class` are both TEXT under one six-value CHECK,
  which is the live demonstration and the increment's own control. The remaining signal is the
  **names**, and a rule over them exists only because agreement is this repo's norm: **682 of 764**
  bindings match exactly under `snake_case` ⟷ `camelCase`, so a divergence is exceptional enough to
  be made to carry a reason.
  The threshold ADR-0354 asked to have decided is **not a similarity score**, and the measurements
  are what refuse one: a shared four-character leading token admits **138** properties into more
  than one column of their own table, and a camel-boundary suffix admits `id` into 11 columns of
  `meta.workflow_events` — so every cutoff is not merely arbitrary but *unsound*, because a
  transposition is precisely a pair of similar names. What shipped is exact agreement plus **two
  derivations** that are rules plus **28 declarations**, with the four refused generalisations kept
  beside their counts. The sharper half of the derivations is that their tightness is **re-asked
  against the catalog on every run**: a measurement taken once goes stale silently, so a second
  admissible column makes `derivation_ambiguous` say the rule has stopped being an explanation
  rather than let it widen.
  Three things came out of it beyond the rule. The vocabulary was **settled from the adjudications
  and not before them** — 28 divergences read against the store, the column and the contract field,
  the convention named in the reader's own words, **17 distinct names** collapsing onto five — and
  an earlier draft's six invented kinds had **four with no member**, which a test now makes
  impossible. **None of the 28 was a defect**, and the two that read as suspicious were dismissed by
  an independent refuter on facts the first reading had not established: `rate_limit_decisions.route`
  because `RouteDefinition` has **no path string at all** (it carries `pathSegments` of objects, the
  sole consumer compiles them to a `RegExp`, and no path renderer exists in the workspace, so the
  operationId is the only route identity that exists as a string), and `job_runs.started_at` because
  `JobRunRecordSchema` is a **dead contract** nothing constructs and no `SELECT` names the column
  outside the claim predicate. And **the rule's own soundness measurement first came back clean for
  the wrong reason**: `parseCatalogSource` carried no `references`, so the `business_key`
  derivation's *"references nothing"* predicate was vacuously true for every foreign key in the
  workspace — 196 of the catalog's 233 references are shared `ColumnReference` constants rather than
  inline objects — and fixing the parser is what showed the derivation is genuinely unsound without
  the column-level UNIQUE beside it.
  The two load-bearing declarations cost something checkable, which is the design's whole defence
  against becoming an escape hatch: a declaration resolving a sibling collision must **name the
  sibling**, and `column_overloaded` — the one kind admitting a column's name is *wrong* rather than
  vaguer — requires the catalogued column to carry a source comment **naming itself**, so the fact
  lands where the next reader is. That is also the remedy both verifiers independently named, and it
  is free: `ColumnDefinition` has no comment field, so the two comments ADR-0355 adds emit no SQL
  and the re-plan after a live apply is clean.

  ADR-0356 closes that rule's own Q1 and the class is **the other direction the value moves**. The
  eighth rule covered the write path only, and a row → record mapping can name a field as wrongly
  as a parameter can — a fake `PgConnection` is at its most useless there, since it hands back the
  rows the test author wrote, so a mapper reading the wrong column returns the author's own fixture
  and every assertion passes. What makes it a different problem rather than the same one mirrored:
  **the write path knows its table from the statement and this one has to find it.** `records.ts`
  holds five mappers while the SQL sits in the three stores beside it, and one store issues
  `SELECT *` — so the SELECT-as-anchor version was built, measured per-module wrong, and abandoned
  for the **catalog**, which is safe on a measurement rather than by assumption: every non-column
  `snake_case` property in the workspace is absent from the catalog, so there is zero collision
  between a column access and any other property access. The table then comes from the declared
  `interface \w*Row` by **column-set containment** (40 interfaces, 26 resolved, 0 ambiguous, a table
  for 313 of 336 reads), because the column name alone is ambiguous exactly where it matters —
  `campaign_id` is one table's business key and three tables' foreign key. The vocabulary is
  imported unchanged, since `admits(column, property, table)` does not care which way the value
  moves. **305 of 336 reads agree exactly, 7 derive, 23 are declared, 0 are unexplained.**
  Three defects in the scan were each caught by a count moving rather than by anybody looking, and
  the sharpest is that **I reproduced ADR-0354's own bare-name-map defect**: the shape index was
  keyed by interface name alone while four stores name their interface plainly `Row`, so a read was
  handed another table's column list — found because the read count went *down*, 349 → 290. The two
  adjudications that survived adversarial refutation are **naming divergences, not defects**, and
  the live run is the whole finding in two lines: `EnqueuedJobRun.jobId` binds `job_id` =
  `close-period` while `ClaimedJob.jobId` reads `run_id` = a UUID — one property name, two columns,
  two interfaces, one package — and `WHERE run_id = claimed.jobDefinitionId` answers
  `22P02 invalid input syntax for type uuid`, which is **why it is not the transposition
  signature**: the declared types separate the two and the database refuses the swap. One fix landed
  two files away from the new rule: `stripComments`, shared by all nine, paired quotes without
  skipping regex literals, and `"([^"]+)"` carries three — so the third opened a string that ran to
  the next quote anywhere in the file.

  ADR-0357 turns the question **outward**. Every increment from ADR-0330 asked something about the
  *artifact* — does this store write the columns it names, does this CHECK admit what the contract
  emits, does this property name the column it is read from — and the ten rules in
  `packages/testing/src/strategy/` are that question asked nine ways. This one reads `deploy/`
  against the code, and the class is **a claim about the deployment that the deployment does not
  make**: four protections stated in one place and absent from the place that would enforce them.
  The sharpest is a **disclosure and not a gap**. ADR-0346's boot refusal
  (`cursor_discloses_withheld_rows`) is correct and **vacuously silent on every deployment there
  is**, because no pack declares a row-filtering grant — and the disclosure one layer in is not
  vacuous: `keysetOf` maps over the **whole declared sort** and renders `String(row[field])` from
  the record, so a caller naming a **classified** field in `?sort` is handed its plaintext in
  `nextCursor` inside a response whose body the gateway just redacted on that caller's own grants.
  **This is a different disclosure from the one ADR-0345 and ADR-0346 reasoned about**, and the
  difference is what makes it live: both of those argue about a *withheld row's* value, gated on a
  record policy nothing declares, while here the row is one the caller **is** shown and the *value*
  is one they are not. Measured against the real resolved packs: **14 (entity, sortable classified
  field) pairs across the seven, 8 distinct, at least one in every pack** — `Employee.work_email`
  (`pii`) rides in from `erp-core`, which is the shipped compose default, and healthcare adds
  `Patient.mrn`, the `phi` field ADR-0338 made `bytea` ciphertext at rest and ADR-0339 found
  `front_desk` blind-overwriting. The column store is **worse than the document store**, which is
  the opposite of how one comment reads: `columnExpr` answers `null` for an `encryptAtRest` column
  so `?sort=mrn` is dropped from `ORDER BY`, while the value is in the record either way —
  `selectList` emits `pgp_sym_decrypt(…) AS mrn` and selects it with no `?fields`, and *with* one
  `projectionColumns` adds every sort field's column back with no `encryptAtRest` filter *because
  the cursor needs it* — and `keysetOf` reads the record. So the cursor carries the decrypted
  plaintext of an ordering that was never applied, which is a soundness bug in the keyset beside
  the disclosure, and a store-narrowed survey would have dropped the one `phi` member. It **reports and never refuses**, argued from the same
  measurement: ADR-0338's refusal rests on *nothing served PHI correctly today*, which is false
  here since `erp-core` has a member, and the hatch an operator would reach for also disarms the
  sharper row check beside it — ADR-0334's *a remedy that cannot work is worse than none*, one
  notch out.
  The other three are the shape stated plainly. `deploy/docker-compose.yml` carried the comment
  *"Credentials reach the API through the environment, not through `command`, because argv is
  readable by anyone who can run `ps` (ADR-0301)"* and nine lines later passed `--api-key
  ${OPERATE_ADMIN_API_KEY}` in `command:` — the one credential on the stack that can provision and
  delete tenants — because the flag was the **only route**: `cli.ts` reads `process.env` nowhere by
  design and no module owned a variable. `PGSSLMODE=verify-ca`, the mode whose entire purpose is to
  validate a certificate, mapped to `{rejectUnauthorized: false}` and validated nothing, with no
  configuration that could repair it (`PgConfig` has no `ca` field, nothing reads `PGSSLROOTCERT`)
  — on the wire that carries `app.current_tenant_id`, which **is** the tenant-isolation boundary.
  And there was no `/health`, no `/readyz` and no `healthcheck:` anywhere, so every one of this
  binary's **deliberate** boot refusals — ADR-0338's, ADR-0340's, ADR-0345's, ADR-0349's, each one
  a considered design decision that exits the process — became a public 502 with nothing in the
  stack holding the opinion that anything was wrong. Each fix exposed one second spelling of its
  own judgement and converged it: `createNodePgConnection`'s inline `config.ssl === "verify-full"`
  became `sslModeValidatesCertificate`, and the health module's serving set became a per-member
  map the `NonServingOutcome` type is derived from.

  ADR-0358 closes the register's own P0 item 1, and the class is **a perimeter the deployment
  asserted and nothing enforced**. `operate-web` authenticated nobody: its proxy stamped one fixed
  `OPERATE_API_KEY` as `x-api-key` on every request of all five verbs, defaulting to the literal
  `"devkey"` when unset, so **every browser that could resolve the domain was that principal** — on
  the shipped compose a `platform_admin` who can provision and delete tenants — with no
  `middleware.ts`, no cookie and no login surface anywhere, behind a Caddy that forwards without
  checking a credential. ADR-0357 documented it and fixed nothing.
  The increment was scoped by a measurement taken before designing: a JWT minted **entirely
  in-repo** — fresh Ed25519 key, `sub` = a real `meta.users.id`, `tenant_id`, `scope` = a role — is
  accepted by the existing gateway **with no verifier change**, and three tokens differing only in
  `scope` returned exactly `erp-core`'s declared read grant on `Employee.work_email` (present for
  `erp_admin` and `hr_manager`, absent for `erp_viewer`). So this was never a six-package
  subsystem; the API side worked and what was missing was a credential, a mint and a browser
  session.
  Four decisions carry it. The credential is **four nullable-or-defaulted columns on `meta.users`
  and never in `USER_COLUMNS`**, because that one constant feeds seven statements over a
  `.strict()` schema — adding the hash there either throws on every registry read or puts it in six
  200 bodies. The hash is **scrypt over a peppered password**, and the pepper's whole justification
  is a live measurement: `meta.users` carries no `tenant_id` and so **no RLS**, so the hashes are
  readable by anything holding the serving role's grant and a secret the database does not hold is
  what makes reading that table insufficient — `parseCredentialPepper` is a *third* parser over the
  one `refuseWeakSecret`, on that function's own stated intent. **One environment variable**, with
  the public half **derived** from the seed and registered in the gateway's own JWKS, which closes
  a class by construction rather than by a check — and the measurement is sharper than convenience:
  `signEd25519(seedA, pubB, m)` **does not throw**, node builds the key from `d` and silently
  discards an inconsistent `x`, so a configured pair can be stated inconsistently and the only
  symptom is `invalid_signature` on every login. And **the login names its tenant**, because
  `membershipFor` requires one and `platform-users.ts` deliberately refuses a by-user membership
  read, so respecting that refusal beat adding the read it declined.
  Three things were sharper than the feature. **`maxmem` is mandatory and the documented formula is
  wrong for the purpose**: the real requirement is `128·r·(N+p+2)`, exactly 3,072 bytes more than
  the documented `128·N·r` — and `128·N·r` at the default N=2^15, r=8 is *precisely* node's 32 MiB
  ceiling, so the default parameters sit just above it and scrypt throws. **The async form is a
  correctness decision**, measured: 8 concurrent derivations at N=2^15 finish in 415 ms with a
  10 ms timer still firing 39 times, where `scryptSync` blocks the loop flat. And
  **`spendPasswordWork` forced the re-hash**: it must derive under the deployment's *current*
  parameters or a fixed dummy cost equalises today and diverges the moment the floor rises, so a
  hash still under weaker parameters costs measurably less than an unknown email — re-opening the
  enumeration oracle silently, in a deployment that had already tested this.
  `isEd25519PublicKeyBase64` had existed since `principals.ts` did with **zero callers** while
  `parseJwksKeySpec` checked only for a colon, so a typo'd key booted cleanly and turned every
  Bearer request into an `invalid_signature` 401 naming nothing; validating it caught two in-repo
  fixtures using fake keys. And `components/Sidebar.tsx` **failed open** —
  `viewerRoleList === undefined || …` with the comment *"No viewer (dev) → show"*, where
  `undefined` is exactly the unauthenticated state.

  ADR-0359 takes three of the register's P2 items and finds they are **one class with six members**,
  and the class is written down in this repository's own prose: `parseListQuery`'s doc comment reads
  *"Unknown / non-filterable params are ignored, so an arbitrary query can't widen the result
  set"*, which is true of the **surface** and exactly backwards about the **answer** — ignoring
  `?tax_id=X` returns every vendor, which is the rows the caller asked to *exclude*, under a 200
  indistinguishable from one where the filter applied. Two readings of "widen", and the response is
  wrong in the one the comment does not address.
  Two members are live on a shipped pack. On `--store pg-columns` + `erp-healthcare`,
  `GET /v1/patients?mrn=MRN-1` was the first page of **every patient**: `columnExpr` answers `null`
  for an `encryptAtRest` column, `buildListSql` dropped the predicate with no record of having done
  so, and the `WHERE` was `tenant_id = $1` alone — measured as **2 of 2** (entity, encrypted field)
  pairs reachable through a declared surface across the seven packs (`Patient.mrn` filterable,
  sortable *and* searchable; `Observation.value_text` searchable). The repo's own test pinned it as
  a feature, titled *"excludes encrypted columns from filter + sort (can't order ciphertext)"* with
  `expect(sel.params).toEqual([TENANT, 6]); // no filter bound for mrn` — a true premise and a
  wrong conclusion, because excluding a filter does not narrow the answer, it widens it.
  The sharper member needs no encryption at all. The same `null` also meant *not a column*, and
  `erp-construction` replaced core's `WorkOrder` with one whose state column is `status` while
  core's inherited `work_order_lifecycle` still named `state` — unchecked, because `stateField` was
  `z.string().min(1)` and the only test on an `entityLifecycle` was that its *entity* resolves.
  `withLifecycleStateFilter` then makes the state field filterable unconditionally, so **the two
  Postgres stores answered one request oppositely**: `pg-columns` dropped the predicate and returned
  every row, the JSONB store compared `document ->> 'state'` against NULL and returned none, and
  neither is an error. `store-parity.test.ts` declares no encrypted field, which is why neither was
  ever compared.
  **One rule decides all six**: *a surface whose drop changes WHICH rows come back is refused; one
  whose drop changes only their ORDER is reported* — `UNSERVEABLE_SURFACE_REFUSES` in the store and
  the same split one layer up in `parseListQuery`. The sort asymmetry is argued from measurement:
  **243 of 375** entities across the seven packs have no list view and so declare no sortable field,
  so refusing an unsortable `?sort` would 400 two thirds of every pack's collections over an answer
  that was never wrong (ADR-0338's rule read the other way). `ListConfig.fields` is what makes the
  refusal shippable, for exactly one question — `?utm_source=ad` names nothing and is an ordinary
  unknown parameter, `?tax_id=X` on an entity that *has* `tax_id` is a caller asking for something
  this deployment declined to serve.
  Beside it, the two mappings that answered a wrong thing one layer out. The dispatch stage's catch
  was **inverted**: the detailed message went to the client in a **504** that clients retry, while
  the recorded `StageResult.reason` was the bare constant `"handler_threw"` — and the 480-character
  slice is sized for `StageResultSchema.reason`'s `max(500)`, so it was applied to the one string
  that never reached the record. The honest fix **moves one string**, which is simultaneously the
  disclosure fix and what makes 504 → 500 safe. And a per-tenant gateway that cannot be built was
  served **the deployment's** gateway — on `--store pg` over the *same store object*, so the tenant
  got their own data under someone else's rules, with their field grants, classification and the
  very ABAC obligation that caused the refusal all absent. The repo carried both words for it:
  `server.ts` calls it *"the fail-closed answer"* and `tenant-gateway-cache.ts:81`, in the defective
  file, calls it *"(fail open to the default server)"*.

  ADR-0360 closes the register's P0 item 7 and the class is **a declaration read by nobody at either
  end**. `Field.unique` is validated, merged across lineage and hashed into `manifestHash`, **45
  distinct (entity, field) pairs** declare it across the seven packs, and **zero** UNIQUE constraints
  existed on any of the 54 entity tables. It had **two** readers and neither emitted anything:
  `kernel`'s `ddl/diff.ts` reads it only to *throw* when it changes, and `ui-schema.ts` copies it
  onto the `UiSchema` — where `unique` occurs **exactly once in the whole `apps/operate-web` tree**,
  as the type declaration at `lib/schema.ts:26`, read by no component. So the register's own wording,
  *"while the UI says the field is unique"*, is **false in the direction that understates it**: that
  would at least have been a promise, and what was true is P1 item 2's shape — authored, validated,
  hashed, serialized to every client, read by nobody — reaching *inside* a section that otherwise is
  served. Two employees could share an `employee_number`, two patients an `mrn`, two invoices an
  `invoice_number`.
  Three measurements shaped the fix and each one moved it. `UniqueHintSchema` is
  `boolean | {scope: string[]}` and always has been, so `field.unique === true` **silently drops** a
  declared composite key — this increment's own class inside its own fix — and
  `ColumnMapping.uniqueScope` is a list for that reason, with a scope naming an absent field refused
  at *validation* (ADR-0348's split: a property of the manifest alone) and resolved field→column in a
  second plan pass, because emitting the index without the unresolved column would enforce a
  **stricter** constraint than the manifest declares. **14 of the 45 are sequence-defaulted**, so the
  409 is gated on `callerKeys`: *the caller supplied the value* is the 409's whole justification, and
  where they did not it evaporates — a `23505` on an allocator-chosen `invoice_number` takes the fixed
  500, because *"send a different value"* is an instruction they cannot follow for a value they never
  sent. The keys come from `parsedBody`, which the create handler already reads for the write mask on
  the same stated ground (*"a default and the `created_at` stamp are the server writing a field, not
  the caller writing it"*) — one rule, read twice. And **the document store cannot carry the
  guarantee at all**, by shape rather than by wiring, so on the shipped compose default the honest
  figure is **0 of 32**, not 2 withheld; the boot survey is therefore a pure function of
  `(manifest, storeKind)` and never of the store, because the two stores that enforce nothing have no
  plan to ask and *those are the deployments carrying the headline*.
  It **reports and never refuses**, and ADR-0359 is the precedent one increment old: a plaintext PHI
  column is incoherent while an absent unique index is *permissive* — every read returns the right
  rows and every write stores what it was given — so it changes neither which rows come back nor
  their order, only which can be created. Two things were sharper than the defect. **A try/catch
  would have shipped the opposite of the design in the per-tenant applier**, measured rather than
  reasoned: that function runs in one explicit transaction, so a `23505` aborts it, every later
  statement answers `25P02`, the `COMMIT` returns `ROLLBACK` — the catch would report a refusal it
  had turned into the total failure that sends the tenant to the JSONB fallback. Per-statement
  savepoints, with `RELEASE` after `ROLLBACK TO` because the savepoint survives it; verified live on
  PG 16.13, and 5 tests fail on the mutation. And **my own first boot line's remedy was false** —
  *"serve this pack on `--store pg` where the value is plaintext"*, on the store that enforces
  nothing — caught by a subagent instructed to check each remedy before writing it, and now pinned by
  a test asserting the string does not contain `--store pg`. A refuter's *"`onApplication` has zero
  consumers"* was the inverse: wrong cause, right conclusion — it *is* wired and `return`ed early on
  `applied: true`, which is exactly the arm a withheld index arrives on.

  ADR-0361 is the mirror of ADR-0360 and the class is **a reader whose aperture is narrower than the
  writer's**. `entityClassifiedFields(entity)` read `entity.fields`, which is not the set the served
  table has — a trait contributes more — so the narrow answer needed no workaround and the wide one
  did: **five** call sites spelled the wide form by hand as
  `entityClassifiedFields({...entity, fields: [...resolved]})`, a fabricated entity whose only purpose
  was to widen the aperture of a function that should never have narrowed it, and **three** took the
  narrow one. Three of eight readers wrong is a convention failing, not three typos. And in every
  instance of the class **the comment beside the narrow read asserts the property the narrow read
  breaks** — one of them *true and worthless* (`write-mask.ts` claimed the mask and the redaction
  "cannot drift apart" because they read the same source; both read the raw entity, so they agreed
  **in being wrong**), the rest simply false: the rule re-derivation "from the same two inputs the
  rule itself read", a view's undeclared role that "fails closed at serve time", and ADR-0340's
  affirmative *"abac obligations: none declared"*. **An invariant two readers agree on is not an
  invariant either is right about**; agreement is cheap when both read the same narrow source.
  Live on both stores as a non-owner, the boot line and the request path contradicted each other about
  one field in one process **and the boot line was the wrong one**, in the reassuring direction:
  `[fields] writable by no declared role: 2 — Contact.declared_email, Contact.personal_email`, and
  seconds later a 201 for `personal_email` with the plaintext handed back in the create response, a
  `GET` redacting the declared field and returning the trait one **in full**, and a `PATCH`
  overwriting it. ADR-0337's falsely-true-control direction in a new place and worse than silence: the
  surface built to make classification legible is the thing that concealed the gap. After, the two
  fields are an exact complement in every direction — both 403 for the unprivileged role, both 201
  and both visible for the privileged one under `--sensitive-field-class pii=boss`.
  The same narrow read **fails in opposite directions** depending on the consumer's drop set: the
  gateway drops `redacted` alone so an undescribed key passes through, while `redactAuditPayloads`
  drops `redacted ∪ undescribed` so it is withheld — even from a reader privileged for `pii`. So one
  of the three is a capability gap and not a disclosure, which is a decision rather than a patch; its
  *remedy comment* was the trap, since taking its advice for the field list alone makes every trait
  field a described, unclassified one and converts a fail-closed omission into a fail-open disclosure.
  Two omissions outranked all three of the register's claims: `validateClassifications` read raw, so
  the `phi`-requires-`auditable` **invariant was bypassable by moving the declaration into a trait**;
  and `assessManifestRisk` and `manifest-diff.ts`'s `classificationLayer` read raw, so **the reviewer's
  approval gate is on the narrow side of the split** — a trait-carried PHI manifest reports
  `level: "low", sensitiveFields: 0`, and weakening `phi` → `internal` on a trait field is approved
  unseen. The recurring rule held an **eighth** time: the honest fix sits one level up. The pain was
  three readers that forgot; one level up is a signature in which forgetting is not expressible
  (`classifiedFields` takes a field list, so there is no entity-shaped call to get wrong) plus
  `resolvedClassifiedFields` as the one answer, plus a **tenth** workspace rule over the whole class —
  which found 12 raw readers where this increment's own grep had found 8, three of them `fails_open`,
  and refused four broader anchors on measurement.

  ADR-0362 is ADR-0361's rule read on **predicates** rather than on field lists, and the class is
  **a predicate deciding from a proper subset of the facts that determine its answer**. It takes
  three register items that read as unrelated — a confinement fence, a job survey and a four-eyes
  attestation — and in every one the narrowing fails in the reassuring direction while a correct
  sibling already sat somewhere in the tree. **The register's framing of all three was wrong in
  ways that would have misdirected the work**, which is the increment's second finding and the
  reason the corrections are written down rather than quietly applied.
  *The confinement fence.* "Six fences infer confinement from ownership" is **three predicate
  implementations and one defect**, and the sharpest part is that the repo had already converged
  onto the wrong winner: ADR-0352 extracted `sessionWouldBeConfined` as the only correct copy of
  eight, and it scores **6 of 8** while `row_security_active` — Postgres's own answer, sitting
  unremarked in the Article 17 erasure — scores **8 of 8**. The live defect is a third spelling:
  `probeJobQueueVisibility` composed ownership and bypass, so an owner of a `FORCE ROW LEVEL
  SECURITY` table read `visible` while Postgres showed it **none** of the rows, and the destructive
  confirmation is the silent zero this whole family exists to catch — the `DELETE … WHERE tenant_id
  IS NOT NULL` removed nothing, the confirm-absence `count(*)` **also** reported 0 because it reads
  through the same policy, and a `BYPASSRLS` role then counted both rows still present. Its own doc
  comment is the class stated outright: *"Ownership, `rolbypassrls` and `relrowsecurity` are facts
  Postgres will state, so they are **asked for** (ADR-0330's rule)"* — three inputs asked for and
  the decision imitated, citing the ADR that says not to.
  *The job survey.* All **55** (resolved pack, declaration) instances of an event-triggered job are
  unproducible, and the survey written to say so told an operator *"event_emitter enqueues it — so
  every fire accumulates a pending run … the behaviour has to be registered by the deployment"*:
  two clauses of three false, in the function whose own comment states the rule being broken
  (*"naming the fix that would not work is worse than naming none"*). The cause is **granularity** —
  `classify()` reads `JOB_KIND_PRODUCERS[kind]`, the kind `event` genuinely has a producer, and no
  verdict could say *a producer exists and cannot address this declaration*. The register blamed
  arity; the shipped producer emits **two** segments unless `--event-prefix` is passed, which no
  deployment passes, so the discriminator is the **separator** (`.` against `_`) and dropping the
  prefix would have fixed nothing. Measured stronger than the register claimed: every declared
  name's own first segment tried as a prefix across all seven packs gives **0 matches**, so the
  failure is structural.
  *The attestation.* The register's own proposed fix is **refuted**: `attestedAt === decidedAt`
  could never fire for a stored row, because `rowToDecision` fills both from the same column — it
  would declare the unstored field equal to the stored one and make a measured silent rewrite legal
  by decree, ADR-0337's falsely-true direction. Three facts it did not have: there is **no column**
  and the `INSERT` was *complete over the catalog*, which is exactly why no SQL rule reported it
  (all ten compare SQL↔catalog or catalog↔a value set, and **none compares a contract field to a
  catalog column**); the signed bytes commit to both lost fields independently; and `rowToDecision`
  returned a bare literal **typed as** the contract, so no clause had ever been checked on read
  while `rowToEvidence` fifteen lines down parses and says why. That is the member where the proper
  subset is not a narrower field list but **the type annotation standing in for the parse**.
  The recurring rule held a **ninth** time, and the increment's own three self-instances are the
  evidence that it is a class rather than three bugs: a retired test pinned an exhaustive truth
  table and compared the rule against a derivation of itself written in the test, calling the single
  disagreement a property; **four comments in four packages** described the composition and the
  *accurate* one described the defective code; and a comment this increment wrote defended its own
  permissive default with a property only one of three callers has.

  ADR-0363 takes two register items that are one defect from both ends — P2.3 (`proveWideningSafe`
  complete and wired to nothing) and P0.5 (its live member) — and the class is **a guard asking a
  proxy for its own question**. `emitAddTableConstraintIfEmpty` asks *is this table empty*, where
  the question deciding whether its statement can fail is *does any existing row violate the
  expression*: emptiness is sufficient and strictly narrower, so its "no" was conservative and its
  "yes" frequently wrong. ADR-0330's reasoning is right as written — a widening and a narrowing are
  indistinguishable *from the expressions* — and its conclusion was one sentence from the fix,
  because **Postgres can be asked**, which is that ADR's own *ask Postgres rather than imitate its
  parser* applied one level out. The proxy appeared **twice in one decision** and the planner's copy
  was the live one (`rowCount === 0` short-circuiting before any proof was consulted); it was found
  not by reading but by **live arm 3 failing**, where a confined session got a widening *planned*
  because it read a count it could not believe.
  **And then the increment corrected itself, which is the most important thing in it.** Gating on
  `proveWideningSafe` — *does any current row violate it* — is **strictly weaker than "this is a
  widening"**, so a **narrowing or sideways** change was planned silently whenever today's rows
  happened to satisfy it, and ordinary writes the live rule permits would start failing `23514` in
  production with nothing in the plan having said the declaration narrows. Demonstrated on the
  cluster by an adversarial read-only pass: live `IN ('a','b','c')`, declared `IN ('a','b','d')`,
  guard counted 0, a plain `INSERT … 'c'` committed in the window, the `ALTER` raised — and the
  guard's own refusal string asserted the distinction the code never tested. The fix is
  **`predicate_implied_by`, the planner's own prover**, reached through `constraint_exclusion = on`:
  `EXPLAIN SELECT … WHERE NOT (<declared>)` is planned `Result / One-Time Filter: false` iff the live
  constraints refute it. It reads **neither expression**, which is what made the obvious alternative
  wrong (extract both value sets and compare them is a regex over deparsed CHECK text, refused by
  ADR-0352), and it is stronger than counting in three measured ways: no row is consulted, so a
  confined session can **plan** a widening it could not count; the race is unreachable, since every
  row the live CHECK admits satisfies the declared one; and `EXPLAIN` does not execute, so it cannot
  fire a volatile function the count would. Sound and incomplete in the safe direction — a true
  widening the prover cannot see is reported, which is the pre-increment behaviour — and one edge
  closes itself: a `NOT VALID` live constraint is the only way a proven widening could still fail,
  and **the planner declines to use one for exclusion**, so that case answers `not_implied`.
  **One fake defect, found by the live run and not by kernel-pg's 776 unit tests**, which is this file's own
  fifth fake-boundary member reproduced inside the increment that added it: `EXPLAIN`'s output column
  is `QUERY PLAN`, cannot be aliased and cannot be wrapped in a subquery, so `rows[0]?.plan` was
  always `undefined` and every implication answered `not_implied` — while the fake returned
  `{ plan }`, so **the fake and the code agreed with each other and with nothing else.** It reads the
  row's first value by position now.
  Three things were sharper than the defect. **A pasted remedy could destroy a constraint**, since
  ADR-0330: `manualColumnCheckSql` emitted the violator query as a *comment* and the `DROP`/`ADD`
  live, so `psql -f` dropped the rule, failed the add, left the table with **zero** CHECK
  constraints and then accepted anything — fixed by a transaction, and separately by giving the
  *conclusive* arm the violator query **alone**, because there the plan has asked the rows so the
  `ADD` is proved to fail while the `DROP` would succeed. **The two confinement stakes are
  asymmetric**, which corrected this increment's own comment: measured as the only session that can
  `ALTER` while confined (a non-superuser owner of a `FORCE ROW LEVEL SECURITY` table), the
  constraint path counts 0 violations, passes the guard, and the `ALTER` raises `23514` — so the
  assertion converts an opaque failure into a named one and Postgres's validation is the backstop —
  while the type-change path counts **0 of 3** rows, passes, and the **rewrite applies**, because a
  type change has no validation pass to refuse it. And the `%` escape is a **compile-time** fence
  rather than a cosmetic one: unescaped, the same guard raises `too few parameters specified for
  RAISE` at compilation of the `DO` block, so a `%` in the act breaks the statement before anything
  is counted. P0.5's boot half is `admissionBlocksValues`, **value**-granular because
  `meta.tenants.status` has two writers writing different values — naming the column would refuse
  the synchronous Article 17 route for `deleted`, which the old CHECK stores perfectly well — and it
  **refuses only when `--tenant-status-gate` reads the value**, warning otherwise, since without the
  gate nothing enforces the state either way.

  ADR-0364 is the first user-directed increment of the run, and the class is **an argument that
  expired and nothing noticed**. `set-credential`'s own doc comment says why it is a subcommand:
  *"there is no mail channel … an operator with shell access is the only principal that exists
  **before the first password does**."* Every clause is true of the **bootstrap** and stops
  applying the moment that subcommand has been run once — after which an authenticated principal
  carrying a grant exists, and the premise is spent. Nothing noticed, so the argument that
  justified one shell step kept justifying **every** password: a tenant's onboarding broke at
  step 3 of 4 (create tenant over HTTP, create user over HTTP, `docker compose exec`, log in), and
  `--platform-user-routes` mounted **ten** identity routes with no UI at all while the one act that
  makes them usable had no route.
  Two routes, and the split is the decision rather than a layout: the operator route is authorised
  by a **grant** and must not ask for the current password, the self route is authorised by
  **possession** of the current password and needs no grant. So the preferences module's
  `buildSetHandler(ctx, onBehalf)` boolean — one handler, one flag — would have been wrong here,
  because the two differ in *what authorises them* and not in whom they are about.
  **`self_not_permitted` is the checkable part of four-eyes for a credential**: the operator route
  skips the possession proof, so aiming it at the caller would let a stolen session replace its own
  credential and lock the owner out — refused **before any store call and before any audit row**,
  since an act that must not be expressible is not a write anyone wants a row for.
  `--credential-admin-role` is its own grant rather than `--platform-user-role` re-read for one
  stated reason, measured against a live catalog: **`meta.users` carries no `tenant_id`, no RLS and
  no policies**, so a route writing it has its role check as the *entire* authorization with no
  policy belt behind it — which is the opposite of every other write surface here. The refusal set
  is **smaller than the CLI's by construction**: `pepper_absent` and `pepper_refused` are
  unreachable because the routes are built from the same `resolveCredentialAuth` material the login
  is, so a deployment that can verify a password can hash one.
  Three things were sharper than the feature, and all three are this run's own classes landing
  inside it. **The first draft read `input.pathParams` and `input.body` through `as` casts** while
  `HandlerInput` carries `params` and `parsedBody` — so both routes would have answered 400 to
  every request, and the casts are exactly why `tsc` had nothing to say: ADR-0362's *type
  annotation standing in for a check*, committed inside the increment citing it. The module now has
  **no cast anywhere** and the removed helper's place carries the paragraph naming it. **Three
  client/server contract defects were caught by reading the server rather than by a test**: a
  `?email=` filter the list route drops (ADR-0359's class — never offer a surface the server
  discards), a flat provision body against a nested `{user, membership?}` `.strict()` schema, and a
  `tenantId` sent into a schema that `.omit()`s it. The second of those was **live in
  `deploy/.env.example`**, whose step-1 curl could never have worked while `README.md` had it
  right. And three times in one increment I read one process's output and attributed it to another
  — a stale server on the port, an agent's journal lagging its writes, and a test file an agent was
  mid-write on — which is ADR-0363's fake answering the wrong query's row, at the level of my own
  measurements.
  **And then an adversarial review of it found five more, two high, in the same session** (ADR-0364's
  addendum). The self route read `existing.credentialHash` and **none** of the `status`,
  `failedAttempts` and `lockedUntil` the same `findById` returns — so the login's account lockout was
  bypassed through it, a wrong guess was never counted (`recordFailure` had one caller in the
  workspace, the login's), and a wrong possession proof **left no trace at all**, because `record`
  sits after the `matched` gate. Two doors, one lock, and the slow one reachable through the fast
  one; the reachability is this module's own argument for `self_not_permitted`, a held live session.
  `credentialIsLocked` is **exported from the login** rather than spelled twice, `onFailedAttempt` is
  **required** because an optional counter defaulting to *do not count* is the defect restated as a
  default, and there is deliberately no policy field beside it — the handler reads the column the
  counter wrote, so the threshold here would be a declaration nothing reads. And `status` was read
  and never consulted, so a password for a **retired** user answered an unqualified `200` while
  `verifyLogin` refuses that status outright: `CREDENTIAL_WRITE_BY_STATUS` splits **terminal from
  recoverable** off the transition map, refusing `deleted` and letting `suspended` succeed with
  `loginBlocked` on the 200 (ADR-0322). The documentation half was worse than the code half: the
  **only documented path to the first login could not be followed**, because `.env.example`'s curls
  named a port the stack published nowhere — fixed by publishing `127.0.0.1:8787` rather than by
  pointing the bootstrap at the TLS layer that is the last thing to come up — and
  `docker-compose.ai.yml` carried its own copy of the whole `api` command, **ten flags behind**, so
  the entire self-hosted-AI path had no `--credential-login` and still passed `--api-key` on argv.
  That copy is **deleted**, not re-synced: `ai-model-source.ts` gives the model the environment route
  that was the only thing the overlay's command added, so `environment:` (which merges, where a
  command replaces) is all it declares and there is nothing left to keep in step.

  ADR-0365 is the second user-directed increment and the class is **a route that accepts input it
  neither serves nor adjudicates** — three members on one surface, two in the request and one in the
  response. The first is what lets ADR-0364's four-step onboarding end in an account that can do
  nothing: a membership's `primaryRole` is `z.string().min(1)` and nothing compared it against
  `manifest.roles`, so granting `platform_admin` — measured, **not** one of `erp-core`'s 15 declared
  roles — stores cleanly, echoes back, mints a session and reaches **0 of 255** (entity, operation)
  pairs and 0 of 51 entities against the `erp_admin` control's 250 and 50. Nothing in between: an
  undeclared primary role is a total denial. **And the deployment invites the mistake** — the shipped
  compose passes `--platform-user-role platform_admin` and an api-key spec naming the same role,
  which is correct because the platform routes are guarded by `adminRoles` and never by the manifest,
  so the role that authorizes everything the operator does is the one role that authorizes nothing
  inside the ERP, and it is the name in front of them on the grant form.
  The fence **warns and never refuses**, because the directory answers from the manifest *this
  deployment* serves and ADR-0314 makes a tenant's own activated manifest real. Its argument for not
  being a boot survey is **half of what the first draft claimed**, and the adversarial pass caught
  the other half in the module's own comment: the *unscoped* census is refused on measurement (as a
  non-owner with no tenant context `meta.user_tenant_membership` answers **0** where the owner
  answers **4** — ADR-0333's silent-zero class in the one table whose rows are the finding), but
  "the tenant list is itself a table a confined session cannot read" is **false** — `META_TENANTS`
  has no `rls` key, no `tenant_id` and no `policies`, and live as a non-owner it enumerates — so a
  *scoped* per-tenant census is available and the write-time placement rests on a positive reason
  instead: the roles are in the request body, so the check costs no read, and the operator hears it
  at the moment the remedy is theirs.
  Beside it, two surfaces this repo's own rule already forbade: `?status=bogus` was **dropped** so
  the response was every user — the rows the caller asked to exclude — and `?cursor=garbage` decoded
  to offset 0 so a caller asking for page 5 got page 1, both under a 200. Both are 400 now, on both
  list handlers, through one parser whose status vocabulary is its argument. `?email=` is **served**
  rather than refused, exact and case-folded, because `meta.users.email` is UNIQUE so an equality is
  one index lookup where the `ILIKE` the console wanted is the measured 66× cliff. And the third
  member is a figure already computed: `counts()` had **zero** non-test callers.
  Three things were sharper than the defects, and all three are this run's own classes landing inside
  it. **The console's first renderer reinstated in the UI the exact promise the server withholds** —
  it unioned `declaredRoles` from every `not_declared` warning and printed "This tenant's manifest
  declares: …" under a *secondary*-only warning, which is ADR-0334's remedy-that-cannot-work one
  layer out, since a declared secondary role reached no authorization decision for **two**
  independent reasons — both closed one increment later by ADR-0369, which is what makes that
  renderer correct now and is why the gate it was replaced by is gone. **A brief of mine was wrong in the direction that hid a defect**: I wrote that
  a stale cursor would now 400, and it does not (`encodeCursor` is `base64url("o:<offset>")` with no
  filter binding, so it decodes perfectly and is honoured against the new filter's rows) — and that
  framing "directed attention at a refusal rather than at a wrong answer", which is why an in-flight
  `loadMore` landing after a filter change appended the previous query's rows under the new filter
  and overwrote the cursor, unguarded until the review found it. And **three figures the register
  itself carried were stale** (the method is `counts()` not `userCounts`; the tenants list renders
  five tiles not three; `erp-core`'s unique-field count is 32, where 34 is resolved
  `erp-healthcare`) — plus one real defect found in passing and closed: `TenantCounts` hand-listed
  **four** of `TENANT_STATUSES`' five, so `pending_deletion` was counted by the server on every
  request and shown by no tile, which is this increment's own headline two files over.

  ADR-0366 is the third user-directed increment and the class is **superseded code is not inert**.
  Two callerless GL posting effects, which the backlog called a one-line deletion, and **neither was
  merely dead**. `billGlPostingEffect` is field for field a subset of `recognitionGlPostingEffect` as
  `compile.ts:436` configures it — and *wrong* on the normal case: measured against the real store,
  a bill of 120 with 20 of input tax gets `expense D120` from the dead one against the live one's
  AP C120 / expense D100 / tax_input D20, so it **books input tax into the expense account**, and all
  seven resolved packs declare the `TaxCode` + `BillLine` pair the live wiring gates its split on, so
  the taxed case is the only case. It is also **unwireable**: both post an entry numbered
  `${bill_number}-GL` while `JournalEntry.entry_number` is `unique: true`, which since ADR-0360
  emits a real index — a `23505` inside the approval transaction on `pg-columns` (and ADR-0360's 409
  arm does not apply, because an effect writes through `input.store.create` rather than a `writeTxn`
  caller-key path), two identical posted entries double-counting expense and AP on the shipped `pg`
  store where ADR-0360 measures 0 of 32 unique declarations enforced.
  `paymentGlPostingEffect` is the sharper half, because **ADR-0124 retains it by name** — *"the
  generic `paymentGlPostingEffect` remains for reuse"* — and the reuse route is not merely published
  but **one line**: `writeEffects` replaces the inferred list while `additionalWriteEffects` one line
  below it appends. So the retention is a loaded surface rather than a stale note: on any manifest
  declaring a `Payment` entity, which is all seven packs, adding it that way posts the document's
  full total on top of what a Payment already settled — measured **AR net −50, cash +170** for an
  invoice of 120 with a Payment of 50 hand-marked paid — silently, because the entry numbers differ
  so no constraint fires. One mechanism offered for that is wrong and is recorded: it is *not*
  reached through `paymentApplicationEffect`, which settles via `store.update`, and `runWriteEffects`
  has exactly one caller, so a store write runs no effects. It is reached through `mark_paid`, the
  scenario the retention was wanted for. So the retention is **withdrawn with its measurement**,
  which is the one thing a silent deletion would have lost.
  **The real finding is the gap the deletion makes visible**, and it was in neither the backlog nor
  the register: every live settlement-side effect is gated on `names.has("Payment")` and **no effect
  `compile.ts` wires triggers on `paid` at all**, while `erp-core` declares a direct permission-gated
  `mark_paid` on both documents plus two timer transitions — and on **`TaxReturn` as a third edge**
  (`workflows-ext.ts:200-213`, granted at `:243`), which no effect and no `compile.ts` wiring names
  at all. So a document hand-marked paid leaves **AR net +70** on an invoice of 120 that reads
  `paid` — the control account is never cleared, with no other route to clear it (all eleven effects
  enumerated; the only AR-clearing postings are the Payment-gated settlement, a credit note and a
  reversal, all different business acts) — and a tax return reaching `paid` moves cash, leaves
  `tax_payable` uncleared and posts nothing. Reachable **since ADR-0365**, which measured `erp_admin`
  at 79 of 79 transitions, and which is why the plan ordered that increment first.
  The methodological correction is worth more than the 314 lines, and it landed on this increment's
  own measurement. The plan justified the batch partly by *"removes 2 of 6 `fx_rate: 1` sites"* and
  *"2 of 7 unstamped entry sites"*. The first reproduces; every **surviving** GL posting effect
  hardcodes it too, so the deletion takes the count from 6 to 4 and the *proportion* of offending
  sites to **100%** — a count reduction inside a defect class is not progress against the class. The
  second **does not reproduce**: the entry-create sites are **8**, because
  `journalReversalEffect`'s receiver is named `created` rather than `entry` and a pattern keyed on
  the variable name excludes it — and that excluded site is the **sole counterexample** to the claim
  the figure was offered for (*"0 of the 7 sets `book_id` or `fiscal_period_id`"*), since the carry
  loop sits three lines above it. The matching pattern's blind spot and the claim's only refutation
  are the same line: ADR-0362's class reproduced inside the census arguing the deletion, and caught
  by the adversarial pass rather than by the author.

  ADR-0367 is the fourth user-directed increment and the class is **a prefix is not the set**. Every
  money reader issued one `listPage` with a hardcoded `limit` and discarded the `nextCursor` beside
  it — 500 tax-split lines, 1000 journal lines, 1000 payments, 5000 for the FX revaluation and the
  two finance reports, none overridden anywhere, so every one ran at its default in every
  deployment. The item on file read *"silently under-report past it"*, which is right about six
  sites and wrong about seven: those write a wrong row into the general ledger.
  **The worst member was not on the list.** `journalPostingGuard` is the double-entry invariant for
  the whole ledger and the cap made it wrong in **both directions from one read**, measured at the
  real default: a 1001-line entry unbalanced by 9999 whose first 1000 happen to balance is
  **allowed to post**, and a genuinely balanced 1001-line entry is **refused**
  `422 unbalanced_journal_entry: debits (10000.00) must equal credits (0.00)` — a detail that is a
  lie about the entry. A balancing prefix is the *ordinary* shape, because every GL posting effect
  writes its lines as a balanced group. The field's own comment said *"a single entry should be well
  under this"*, which is false for the two sources the entity model names: `JournalEntry.source`
  enumerates `payroll` and `depreciation`, both jobs declared, and 5000 employees × 5 lines is
  25 000 — **the cap sat below an artifact the manifest had already committed to.**
  The measurement that decides the design is the site that looked *safe*.
  `paymentApplicationEffect` settles a document once payments cover its total, so an under-reported
  sum can only fail to settle — an argument resting on `Payment.amount`'s declared `min: 0`, which
  **nothing enforces** (`FieldErrorCode` has no range member; `type.min` is read in exactly two
  places, both change-detectors in `kernel/ddl/diff.ts`). Measured: an invoice of 400 with three
  payments of 200 and a correction of −300 — true applied **300** — is written **`paid` with a
  `paid_at` stamp** at a cap of 3 and correctly left `sent` at 99, and because that write bypasses
  the issued-document lock by design the document then drops out of **both** the aging report and
  the FX revaluation's open set. A live receivable disappears from the books. The same unenforced
  declaration flipped the *other* safe verdict: the tax split's gate reconciles
  `netTotal + taxTotal` and the code says in its own comment that withholding is **not** in that
  quantity, so a dropped tail netting to ~0 applies a truncated withholding figure — `AR 360 /
  Withholding 40, stamped 40` against the full set's `AR 260 / Withholding 140, stamped 140`, and
  **both balance**. So the rule admits no per-site exception: *a prefix is not the set, whatever is
  in the tail*, and no site may reason about sign or lean on a declaration nothing checks.
  `drainList` is the primitive and `READ_CEILING_EFFECT` is a total map over **three positions**
  whose content is the whole decision — a **guard** `refuses` (a decision from a prefix is not a
  decision), an **effect** `aborts` (a row written from a prefix is a wrong row that *balances*, so
  nothing downstream can see it), a **report** `declares` (a bounded reading that says how far it
  looked is honest where silence is not, and an aging report over the first N documents is still the
  only view an operator has). The report arm is convergence: `usage-handler.ts` already emits
  `overflow` and `read-state-routes.ts` sets `truncated = page.nextCursor !== null`.
  Two sites are **not** drained because they are not scans: `lookupPeriodEndRate` asked for 5000
  rates with `sort: []`, which leaves `ORDER BY id ASC` over time-ordered ids, so it kept the
  **oldest** and dropped the newest — the ones nearest period end — and returned a stale rate it
  multiplied the whole revaluation by; it asks `lte` + `desc` + `limit: 1` now, exact in one row.
  And `resolveAccountId`'s `?? page.records[0]` is dropped, converging on `resolveCurrencyId`, which
  matters on the shipped store because ADR-0360 measures it enforcing 0 of 32 unique declarations.
  **The prerequisite is the increment's own class one level down.** A drain on
  `InMemoryEntityStore` was *unsound*, and the facts that made it look sound are why: the sort's
  tiebreaker went through `compareValues` while `isAfter`'s last clause was a raw `>`. Measured with
  `sort: []` — numeral ids visited 2 of 5, and mixed-case ids returned **the same cursor twice**, a
  walk that never terminates. House ids are fixed-width so the two agreed on them, which is why it
  went unnoticed; nothing strips a client-supplied `id`. `compareIds` is the one comparator and the
  repair landed entirely on the **sort**, measured: the seek expression it replaced is identical over
  168 inputs, so `compareValues` on the sort side is what disagreed — and making the *seek*
  decimal-aware instead would have moved this store further from both Postgres stores, which is the
  trap. The recurring rule held a **tenth** time: the pain was nine truncating reads, one level up
  is a drainer, and the drainer is sound only once the comparator below it is one comparator.
  Three things an adversarial pass found after the first commit, and all three were in work of mine.
  **The transaction premise was false as a general claim**: `writeTxn` falls through to
  `body(ctx.store)` on a non-transactional store and two effects wrote their header *before* their
  own read, so a 5-line reversal at `maxLines: 3` left a second posted entry behind and a retry left
  a third — both now read before they write anything, so *nothing was written* is a property of each
  effect rather than a promise about the caller's store. **Four of six refusal messages interpolated
  a record value**, one of them a record **id**, into a string `writeTxn` puts in a 500 body under a
  comment of mine authorising it because the refusal carries "no row, no value, no tenant" — all six
  are literals now, pinned by a test that reads the construction sites as text with a vacuity floor.
  And a new test was **vacuous**: 1200 documents against a pre-increment cap of 5000 means a one-page
  read was *right*, so it passed against the code it was written to refute; the fixture is past 5000
  now and mutation-checked. The report ceilings are the fourth correction and mine: briefed at
  100 000, they are **20 000**, because what bounds a report is its **response** — both return a row
  per document, and at the real pack's widest money record (`Invoice`, 777 B of JSON) 100 000 is a
  ~74 MiB body.

  ADR-0368 is the fifth user-directed increment and the class is **inheritance ran where the
  lineage was already known**. `resolveManifest` — the whole `meta.extends` mechanism, with its
  merge, its `overrides: true` marker and its three refusals — had exactly one non-test caller,
  `loadBuiltinPack`, which runs over the seven *built-in* packs at boot, whose lineage is fixed at
  build time and could have been composed by hand. A **tenant's** activated manifest is the only
  input in the system whose lineage is a runtime question, and it reaches
  `TenantGatewayCache.serverFor`, which parsed, validated and built and resolved nothing. So
  `meta.extends` on a stored manifest was read and never followed, and **activating a design
  replaced the pack**: a four-entity design took the other forty-seven entities, fifteen roles,
  nineteen workflows and seventy-nine transitions away from that tenant — the general ledger, AR/AP,
  inventory and HR among them. The mechanism was *applied to the input that did not need it*, and
  `node.ts` asserted the opposite in prose — *"resolving that lineage is the gateway cache's job
  rather than a second resolution here"* — returning `null` from `roleDirectory` for any manifest
  carrying `extends`, on a premise that did not hold.
  Two more defects composed with it into one hazard rather than three gaps. The **approval gate was
  supplied under a flag nothing passed**: `reviewGate` reaches the design routes only under
  `--require-design-review`, so the activation handler's `if (ctx.reviewGate !== undefined)` was
  skipped and the tenant's own `erp_admin` designed a manifest, reviewed their own diff and clicked
  Activate — while the compose comment claimed *"a reviewer approves it, and activating it makes it
  that tenant's live schema"*, both halves false, and `/setup` claimed *"you review everything
  before anything goes live"*. And the **design spec asked for six of the manifest's sixteen
  sections**: 4,834 characters mentioning neither `workflow` nor `extends`, with no `workflows` key
  in the worked example, so **every AI design had zero workflows and zero transitions** and every
  one was standalone and therefore a replacement.
  The ordering is the decision and it **reverses the plan's**. Batch 19 said "gate first"; a gate
  over a manifest that replaces the pack is *worse than no gate*, because it launders the
  replacement through a human shown a diff covering five of sixteen sections — ADR-0337's
  falsely-true direction. So lineage first, then the gate, then the prompt; the plan's own
  gate-before-key still holds inside that. Resolution goes **between parse and validation**, which
  is measured and not reasoned: a child extending core and referencing `Account` is *refused* by
  `tryValidateManifest` unresolved and *ok* resolved, yielding the **52-entity / 16-role union in
  one `getManifest` call** — so resolution after validation would have been inert. The parent policy
  is **the deployment's own manifest and nothing else**, because the boot manifest is the one this
  deployment has already surveyed, provisioned and declared, and one registry entry is *sufficient
  and complete* since `stripExtendsFromMeta` leaves a resolved manifest carrying no `extends`, so
  handing it back resolves to itself with zero further lookups and no possible loop. A resolution
  failure is a **`refused`** and not the `{kind:"none"}` fallback, because `none` serves the
  deployment's gateway and a tenant whose activation did nothing would never be told — ADR-0314's
  "their data is in a different place than they think".
  Three things were sharper than the defect. **The prompt half had to ship with it or the mechanism
  ships with no producer** — this file's own most-found class, committed inside the increment naming
  it — so the Architect is told to emit `extends` and is given the parent's entity names, since
  redeclaring one without `overrides: true` is refused at resolution. **Two CLI refusals** close
  flags that would otherwise be *silently inert*, which is worse than absent because an operator who
  asked for an approval gate and got none believes their tenants' designs are reviewed: a review
  gate needs Postgres (`reviewStore` is built only inside `designReview && conn !== undefined`) and
  needs `--ai-design`, because `source: "ai"` is the **only** proposal producer in the workspace
  while `MANIFEST_PROPOSAL_SOURCES` declares a `manual` nothing writes. And **my own first test was
  wrong rather than the code**: `--ai-design --require-design-review` with no store answers the
  *Architect's* store refusal, because first-refusal-wins and that is the better sentence — which
  makes the review-store arm reachable only on a deployment that did not ask for the Architect, and
  it is kept as its own condition anyway so removing the producer arm cannot silently take the store
  requirement with it.
  One figure was corrected mid-increment and it is the **plan's**, not this file's: the batch plan
  records the reviewer's diff as covering "4 of 16 sections" against this register's 5, and **the
  register is right**. Those four line references are the four *layer functions*, missing that
  relations and roles ride on other layers and that `classificationLayer` is a second read of
  entities. `ManifestDiffView` covers entities, relations, roles, permissions and **workflows** —
  `LifecycleWorkflow` is `Extract<…, {kind: "entityLifecycle"}>` and `lifecycleLayer` reports
  "lifecycle added with N states" — so **a workflow this increment teaches the Architect to emit is
  shown to the reviewer**, and the two halves compose rather than passing each other. Measured end
  to end: adding a lifecycle is `additive`, narrowing one reports `states removed: …; transitions
  removed: …` at **`breaking`**. The wrong figure had reached five files before it was measured,
  which is the whole argument for measuring a number before repeating it.
  **And `meta.extends` is invisible in that diff** — adding it leaves the view `comparable` with
  every count zero and no warnings — so the one fact every AI design now declares is absent from
  the page where it is approved. Enforced rather than trusted (resolution refuses any parent but
  the deployment's own), so it is a gap in what a reviewer can *see*. The trap underneath it cost
  two independent readings, mine and a slice's, and is worth knowing before touching this function:
  `diffManifests` returns `emptyView()` — `comparable: false`, every count zero — whenever either
  side fails `parseManifest`, so **an unparseable manifest and an unchanged one differ only in the
  `comparable` flag**. Both of us concluded "workflows are not in the diff" from a fixture using
  `initial` and string states where the schema wants `initialState` and state objects, and read the
  empty view as the answer.

  ADR-0369 is the sixth user-directed increment and the class is **a reader that truncated the list
  it was given** — ADR-0361's class one domain across, on a *scope list* rather than a field list.
  A membership's `secondary_roles` is `TEXT[] NOT NULL`, accepted, bound into the `INSERT`, read
  back by `rowToMembership`, echoed in two API bodies, rendered as a console column and warned
  about by ADR-0365's fence, and it reached **no authorization decision whatsoever** — while the
  consumption side was already complete, since **26** non-test call sites spread
  `...(secondaryRoles ?? [])`. One `[0]` in
  `principalRoles: (p) => ({primaryRole: p?.grantedScopes[0] ?? "anonymous"})` made every one of
  them take the empty arm. There were **two** truncations, either sufficient alone (the mint
  stamped one `scope`, and the reader dropped the tail), which is why nothing failed and no test
  was wrong — and why `token-mint.ts` stated the consequence in its own doc comment and
  `membership-role-fence.ts` derived a whole documented position from the pair.
  The headline is measured against the real `rbacCheck` over resolved `erp-core` (255 pairs):
  `platform_admin` reaches **0 of 255** and `erp_admin` 250, so an operator signing in as the role
  the shipped compose grants reached nothing inside the ERP — and the remedy their own grant form
  offered, a secondary `erp_admin`, was **inert**. It is 250 now. `ap_clerk` 31 + `hr_manager` 26
  compose to exactly **55**, the union.
  Four measurements decided the design. **Every route in the workspace declares
  `requiredScopes: []`** (18 + 5), so the gateway's `grantedScopes.includes()` check is vacuous
  workspace-wide and widening the *reader* grants no scope-gated route; an undeclared role
  contributes nothing in all three readers; **130 role declarations across the seven resolved
  packs, 0 with whitespace, 0 declaring `inherits`**; and `--credential-login` and `--jwks-url` are
  mutually exclusive, refused twice. So `scope` carries the list, primary first, de-duplicated —
  **the vehicle was never missing** — and `scp`, the array claim the gateway reads *after* it, is
  refused because emitting both leaves the array dead and emitting `scp` alone yields a token this
  gateway reads and nothing else does. **No flag**: nothing retroactively activates, because a live
  session's token carries one scope and activation is a login event per user (ADR-0339's split — an
  explicitly declared grant is enforced always). A `role:` prefix tagging which scopes are roles
  was refused on ADR-0342's own grounds, and the one behaviour change that *is* real — a foreign
  token's scopes past the first — is **reported at boot and never refused**, since a refusal would
  refuse a deployment that works.
  Three things were sharper than the defect. **A role name may contain whitespace** and the claim
  is space-delimited, so `"hr manager"` arrives as two roles — a hazard that was already live for
  the *primary* and which this increment extends to the list; refused at the grant (where the
  operator can act, ADR-0348's split) and at the mint (the backstop for a stored row), and
  deliberately **not** in the kernel, because `--api-key key:role:tenant` sets
  `grantedScopes: [spec.role]` with no split so such a name is legitimately holdable by an api-key.
  **Four places argued at length that a secondary role is unread and all four stop being true at
  once** — the mint's doc comment, the fence's `SECONDARY_UNREAD` and its whole "two positions"
  section, the console's `primaryUndeclared` gate, and this file. **The backstop was worse than the
  fault it guarded and only the live run said so**: `sessionScope`'s throw escapes
  `ctx.mint(outcome)` uncaught, so the login answered a **500 carrying the exception's message** —
  on the one route whose entire design is that every refusal looks identical, and as a status
  clients retry for a condition no retry fixes. ADR-0359's `writeTxn` finding reproduced inside the
  increment citing it, past every test, because every test supplies a well-formed role list. It is
  a twelfth `LoginRefusal` now (`membership_role_unusable`, not counting against the lockout, since
  the password was correct), verified byte-identical to a wrong-password refusal with the role named
  in the log — and the throw stays as a backstop this path can no longer reach, `dischargeAbac`'s
  shape. The predicate was also spelled **twice**, which is this increment's own class, and is one
  function in `token-mint.ts` beside the delimiter now. And **the "total denial" clause
  had to be weakened, by this increment**: `resolveEffectiveRoles` visits the primary and then
  loops the secondaries, so a *declared* secondary beside an undeclared primary carries that
  secondary's grants — `ghost_role` + `["hr_manager"]` is **26 of 255**, exactly `hr_manager`
  alone, where the same primary with no secondary is 0. ADR-0365 measured its 0 of 255 on a grant
  carrying **no** secondary roles and before this it generalised for the same reason everything
  else about this column did: the list was unread. Found by a slice reading the function rather
  than the brief, which asserted the old rule in both halves.
  **An adversarial pass over the committed diff then found nine more, two of this ADR's own claims
  false and one of its comments measurably wrong** (ADR-0369's addendum). The one that changes the
  security story: the boot line argued that an undeclared scope grants nothing *"and every platform
  gate is a `.has`"*, so the only reachable widening would be a scope matching a **declared
  manifest role** — and the gates test **CLI-supplied** sets, where `platform_admin` is measured as
  *not* one of `erp-core`'s fifteen declared roles. So the old reasoning called the dangerous case
  safe: an IdP emitting `scope: "openid profile platform_admin"` used to resolve `openid` and be
  refused everywhere, and now reaches tenant provision and delete. Still reported (no shipped
  configuration passes a JWKS flag, and every alternative without a contract change is worse), at
  **warning** level, naming the flag; the instrument that settles it is a reader that knows which
  `kid` verified the token, which `PrincipalResolverInput` does not carry. Two more worth keeping:
  **the console's 400 arm enumerated the causes and so ruled the new one out** — "the user id must
  be a uuid, and a role must not be empty", both satisfied when the cause is a space, no field
  highlighted (ADR-0364's addendum class inside the increment whose README it edits); and
  **`.min(1)` does not short-circuit a `ZodEffects` refinement** — measured on zod 3.25.76, a
  failing string check marks the result *dirty* rather than aborting, so `""` came back carrying
  `too_small` **and** a sentence about whitespace it does not contain, past a comment asserting that
  could not happen and a test reading `issues[0]` alone. The predicate is two composed functions
  now, one per reader.

  ADR-0370 is the seventh user-directed increment and the class is **a statement refused before the
  planner**. `--notification-template-routes` mounted five status transitions over
  `meta.notification_templates` and **every one of them raised at the database and escaped as an
  unclassified 500** — found while measuring which background subsystems the shipped compose should
  default on (register P0.3), on a surface that has existed since ADR-0313 with 24 passing tests
  over its store and 37 over its routes. Three Postgres errors from one cause plus one: `08P01 bind
  message supplies 5 parameters, but prepared statement "" requires 4` on submit, reject and retire,
  `42P18 could not determine data type of parameter $5` on deprecate, and
  `42804 column "approved_by" is of type uuid but expression is of type text` on approve.
  The first two are one cause and its comment states it: the parameter array was built with the
  actor fixed at `$5` *"so the statement reads the same for every target"*, and the statement does
  **not** — `transitionAssignments` is a `switch` whose `approved` arm was the only one mentioning
  `$5`, so the other four bound a parameter their own statement never referenced. **Reading the same
  is a property of the text, and buying it with an unreferenced parameter costs the statement.** The
  third is a column: ADR-0335's actor sweep reached `created_by` and **missed `approved_by` two
  lines down**, so ADR-0313's four-eyes predicate (`created_by <> $actor`) pinned `$5` to `text` and
  the assignment into the still-UUID column raised. The rule's own target had been half-applied.
  **Why nothing saw it** is the increment, and it is a sixth member of ADR-0333's class — see the
  *Tests* convention. Three things were sharper than the defect. **The test required the defect**:
  the approval test read `toContain("approved_by = $5")` beside `toContain("created_by <> $5")`, and
  one parameter in both positions *is* the `42804` cause, so the only statement that assertion
  admitted was the one no server would run. **The fake read positions by literal number**
  (`sql.includes("approved_at = $6")`), so it modelled one numbering of the assignments and silently
  stopped modelling anything when that numbering changed — while the `SELECT` branch immediately
  below it already resolved placeholders with a regex and indexed `p[n-1]`: one file, two idioms,
  and the brittle one was in the branch the defect was in. And **meta-schema invariant #4 has a
  blind spot of exactly this shape**: `crossColumnTypeDisagreements` extracts comparisons between
  two bare column identifiers *from CHECK expressions*, and measured, this table carries no table
  constraint and no CHECK naming `created_by` — so the identical `uuid <> text` disagreement lived
  in a store's `UPDATE` predicate with a bound parameter and was one layer out of that rule's sight.
  The actor is bound **twice** in the approval statement deliberately, and the reason survives the
  column fix: two bindings of one value cannot pin each other's type, where one binding in two
  positions is precisely what raised. Live on PG 16.13 as a non-owner, all five transitions answer
  200 where each answered 500, and the stored row reads
  `created_by=…a001 | approved_by=…a002` — two distinct principals, which is the attribution the
  surface exists for and had never once recorded.

  ADR-0371 is the second increment that measuring register P0.3 produced, and the class is **a
  bounded check that trusts an anchor whose one writer verifies nothing**. `verifyChainFromCheckpoint`
  states its own soundness condition in its own doc comment — *"Trust in the anchor comes from the
  earlier verification that produced it (ADR-0252/0255); this does not re-fold the prefix"* — and
  that premise was false for every checkpoint any deployment has ever held: `CheckpointScheduler`
  reads the chain tail and anchors it, and `createCheckpoint` and `checkpointStore.record` have
  **exactly one non-test caller each**, both in that file, so there was no verified path the
  scheduler was an unsound alternative to.
  Three facts compose with it. `fromCheckpoint` **defaults to true**; `verifyChainSuffix([])` and
  `verifyChainSignatures([])` are both vacuously valid, so `ok = integrity.valid &&
  signatures.valid` is true over zero entries; and **the signature is the only check in the stack
  that binds an entry's stored columns to its content** — both folds compare `priorEntryHash`
  against the previous row's `entryHash`, stored column against stored column, and
  `hashChainStep`/`canonicalEntryBytes` occur in exactly two places in the workspace, the write path
  and `verifyChainEntrySignature`. The anchor half binds the *row* to `payload_sha256` rather than
  `payload_sha256` to the signed bytes, which `audit-anchor.ts` says itself: *"a chain whose entries
  were forged wholesale would satisfy this check alone, because the forged entry would commit to the
  forged row."*
  Live and unprompted on a real 344-entry chain, through the shipped subcommand: `[full]` answers
  **FAILED, 344 checked, seq 323–325 `bad_signature`** and `[from checkpoint 337]` answers **OK, 6
  checked** — the same chain at the same moment, and the mode the proof uses by default is the one
  that answers OK. One pass of the real scheduler at the tail of a clean chain then takes the proof
  to `sigs.CHECKED=0, chain.ok=true, verdict=verified`. And the forgery settles it: an Article 17
  row at sequence 4, below the checkpoint at 7, rewritten from `platform.tenant_delete_refused` to
  `platform.tenant_deleted` with the entry's `payload_sha256` made consistent and the hashes
  untouched, reads **`compromised` in full mode and `verified` in the default one** — with
  `anchors{verified=7 tampered=0}` in **both**, so the anchor half is not a mitigation but the check
  the attack is shaped to satisfy. The `UPDATE` is `UPDATE 1` as the non-owner `serving` role with
  tenant context, that table's isolation policy being `ALL`-scope. And the steady state is worse
  than one missed window: the checkpoint scheduler starts immediately before the proof and both
  default to the same hour, so an hour's entries are **anchored before anything examines them** and
  the suffix the proof sees is whatever was written between the two passes.
  The fix is that **the thing that writes the anchor is the thing that verifies it**, and the
  injected verifier is `verifyChainFromCheckpoint` itself, which makes the induction self-healing: a
  new chain folds in full and anchors `verified_full`, every pass after folds only the new suffix and
  anchors `verified_suffix`, and a deployment whose legacy anchor carries no provenance pays one full
  fold and is bounded from then on — **provided its chain gains an entry**, because `record` is
  `ON CONFLICT … DO NOTHING` so a legacy row sitting *at* the tail is never replaced, which makes an
  idle *tenant* chain re-fold every pass until something appends. Simply
  defaulting `fromCheckpoint` to `false` was refused on measurement — Ed25519 verify is **152 µs**
  here, so a full fold is 15.2 s of signature CPU per pass per scope at 100k entries and 152 s at 1M,
  with the whole chain in memory. That figure was also *understated* when it was taken, because
  `foldFromGenesis` loaded the chain **twice** (once through `reader.verify`, once through
  `verifyStoredChainSignatures`); it loads once now and runs both pure checks over that array, so the
  whole pass went from three full chain loads per scope to one.
  **And the first draft of that fix reproduced the defect it closes, which an adversarial pass
  caught.** The pass read the tail, verified, and then called `createCheckpoint`, which issued its
  own `loadChain` and anchored at the **then**-current tail — so every entry committed during the
  verification was stamped `verified_full` by a fold that never saw it, and skipped forever by every
  bounded pass after it, since those start at `checkpoint.sequenceNumber + 1`. The same class,
  narrowed from *the whole prefix* to *one band per pass* and reopened on every pass, in a window
  that is continuously written on a serving deployment (every audited request anchors a row,
  ADR-0286) and is the whole full fold on the first post-upgrade pass. So `checkpointFromChain` is
  **`checkpointFromTail`** and the scheduler anchors at the tail it read *before* verifying, which is
  conservative in the only safe direction — a row appended in the window is simply not covered yet.
  The replacement is exact and that is why it needed a test about *which read is made*:
  `lastEntryHash(entries)` on a non-empty chain **is** the tail row's `entry_hash`, so no assertion
  on the resulting checkpoint can tell the two apart. Three full chain loads per scope per pass
  became one, and the class doc comment had said *"records a `ChainCheckpoint` at that tail"* all
  along — accurate prose beside code that did something else.
  **And the live verification found a defect nobody had read**, which is the increment's second real
  finding: `UNIQUE (tenant_id, sequence_number)` **does not constrain the platform scope**, because
  `tenant_id` is nullable with NULL meaning platform (ADR-0331) and SQL treats NULLs as distinct — so
  `(NULL, 3)` twice is legal, `ON CONFLICT … DO NOTHING` never fires for a platform checkpoint, and
  the append-one-row-per-sequence design does not hold there. Measured: two real rows at platform
  sequence 3, 546 ms apart, `count(distinct id) = 2`. `latest()` ordered by `sequence_number DESC
  LIMIT 1` with **no tiebreaker** and returned the **older** of them 10 runs out of 10 — the
  fail-open direction, since a stale `verified_full` masking a later `unverified` licenses exactly
  the skip the provenance exists to refuse. Both ordered reads carry `checkpointed_at DESC, id DESC`
  now (untiebroken `verified_full` 10/10 → tiebroken `verified_suffix` 10/10 on the same two rows),
  and it also **inverts the healing condition for that one scope**: the idle *tenant* chain re-folds
  because its anchor is never replaced, while the idle *platform* chain heals and grows without
  bound. Two opposite failures from one `DO NOTHING`. The constraint itself is the top open question
  — `UNIQUE NULLS NOT DISTINCT` is PG15 against a floor of 14, and a partial unique index cannot be
  created while the duplicates every such deployment already holds are there.
  Three things were sharper than the defect. **Swapping two `start()` lines in `node.ts` would have
  made it accidentally sound** — run the proof first and the hour's entries are verified before they
  are anchored — and it is refused on three measurements: the two `intervalMs` are **independent
  configs**, `--checkpoint-config` **mounts with no proof at all**, and soundness would become a
  property of a start order in a third file, invisible at both sites and to `verify-chain
  --from-checkpoint` run by hand. **The live false `compromised` was ADR-0358's hazard with a live
  instance**: fingerprint `04ae9a8e5b42e0` signed exactly 323–325 in a 39 ms burst, its registered
  public key is *self-consistent* (its own fingerprint matches the stored column, verified), and the
  Ed25519 verification still fails — a well-formed but mismatched `--audit-chain-config` pair, signing
  with one half and announcing the other, from an ordinary boot that said nothing, which on the full
  path is a paging `sev1` at a 100% false-positive rate. So **the two findings compose: one
  manufactured a false positive and the other buried it**, and `ed25519PublicKeyFromSeed` had existed
  since ADR-0358 for exactly this with no caller on that path. **And a figure this increment added
  to the durable record was reverted out of it, because the argument for it expired inside the same
  increment.** `StoredIntegrityReportSchema.chain` gained a `signaturesChecked` on the stated ground
  that a bounded pass over an unchanged tail reports `signaturesValid: true` having examined nothing
  — true before the fix and *eliminated by it*, since `mode: "from_checkpoint"` is now reachable only
  when the anchor is admitted, so `checked: 0` beside it is the healthy steady state and the schema
  comment calling zero "the alarming value" would have shipped as advice to treat the normal case as
  a finding. It was also in the wrong place: `record()` stores the report whole while `payload_sha256`
  is derived from `canonicalStoredReport`, which excluded the field — so the stored report stopped
  being byte-identical to the committed payload and `toVerdictView`'s instruction that the two *"let
  a reader confirm the row's content **is** the committed content"* was false for every row the binary
  would write. Reverting restored that parity and retired three further findings with it. What is a
  finding is the **reason**, and it reached nothing that runs unattended: `fullBecause` is rendered on
  the hourly `onPass` line and by `formatIntegrityProof` now, with the count beside it, and **none of
  the three is in the durable record** — one rule, that a diagnostic belongs where diagnostics are
  read while the record carries only what the digest covers. And the `recordVerdict` comment
  arguing that a verdict belongs in the chain because *"editing it or removing an earlier one breaks
  a link"* is **false in its mechanism**: editing an entry breaks no link, only the signature notices
  — this file's own recurring documentation class, in the comment justifying where the record of
  verification is kept.

  ADR-0372 is the first increment produced by **measuring the register rather than reading it** — a
  nine-cluster read-only audit re-derived every open item against the committed tree, refuted **nine
  of its own verdicts**, and turned up three defects the register did not have. They read as
  unrelated and are one class with two faces. *A claim with no evidence*: `assessDrReadiness({now})`
  answered `ready: true, totalIssues: 0` and the certification control signed it `satisfied` with
  the summary **"DR readiness: READY (0 issues)"**, because every count in that report is derived by
  *filtering* a supplied list, so an empty list contributes zero issues on **every** axis — it was
  never a backup guard, it was four vacuous axes. *A fact with no claim*: `GdprDeletionRequestSchema`
  refused `completedAt > deadlineAt`, so a deletion finishing one second past its Article 12(3)
  deadline destroyed the tenant's data, wrote the tombstone, **committed** the row `completed`, and
  threw on the read-back — because **the parse sits on the far side of the commit**, which converts
  *can this row be represented* into *did this write happen*. The runner then filed it
  `completed_unrecorded`, which is false, and one such row stopped `auditCompleted` auditing every
  other completed request. And `absent` was the only deletion disposition that let a deletion run,
  which for any deployment that takes backups is a false statement inside a cryptographic proof.
  **The rule was already written out forty lines above the function that broke it** —
  `evidenceFromEncryptionCoverage`'s nine-line comment ends *"an absence of evidence is not
  evidence"* and implements it — so ADR-0337 wrote the rule and applied it to the member it had
  found. An adversarial pass then aimed that criticism at this increment and hit twice: a **fourth**
  zero-scope adapter in the same file, `evidenceFromAccessReviewEvidence`, answering
  `satisfied: true` with *"sealed at 100% completion"* over a pack covering **zero reviewed
  items** — reachable from the shipped producer, where the DR one needs two flags no deployment
  passes — and the increment **not building**, because making the unreadable-row reporter required
  named four call sites in `node.ts` and none was answered, which is ADR-0307's conditional green
  with both packages green in isolation. The fourth adapter's cause is `completionRate: 1` over a
  zero divisor, so the guard went in the **adapter** and not the metric: changing the metric would
  move every stored pack's sealed digest (ADR-0332 read the other way), and *the metric is right;
  reading it as a measurement over an empty scope was wrong*. `forensic_chain` is the fourth of four
  and is **not** in that state because it is guarded **at the source**, so the census is four
  adapters with four answers rather than three fixes and a hole. ADR-0371's own defect also had a
  **second door**, found by auditing that ADR rather than using it:
  `PostgresChainLogReader.verifyFromCheckpoint` took a checkpoint of any provenance and handed the
  suffix to a `verifyChainSuffix` that is `{valid: true}` over an empty list, and **all three of its
  existing tests passed `provenance: "unverified"`** while one asserted the vacuous clearing as
  correct. The most instructive thing in the increment is that count: **five separate tests asserted
  the state it corrects**, including `dr-readiness.test.ts`'s *"No executions + no declared infra ⇒
  ready, zero issues"* and `access-reviews`' *"compiles an empty finished campaign at 100%
  completion"* — the defect named as the intended behaviour, twice, in the packages that own it.
  Every part also had to be given a **reader**: `requiredSubsystemsFor`, `absentSubsystemsFor` and
  `unerasedSubsystemsFor` had zero callers outside `assembleTombstone`, `formatDrReadiness` and
  `formatUnevidencedAxes` had none outside their own test, and `isCompletedLate` would have been a
  **third** callerless Article 12(3) predicate — so a boot line, a report line naming the axes *and
  their remedy*, and a reader in `auditCompleted` are part of the increment rather than follow-ups,
  since a computed fact reaching nobody is this run's most-found shape. Verified live as a non-owner
  on PG 16.13: seven checks, the migration **1 planned step / 0 unreconciled on a populated table**
  with a clean re-plan, and the three pre-upgrade rows reading **SQL NULL rather than `{}`**.

  ADR-0373 closes ADR-0372's own Q2 and the class is **a sweep one bad row stops**. That increment
  gave three reads in one store a required `onUnreadable` reporter and established *report and carry
  on*; the missing half is that **where a sweep's purpose is to find defective rows, an unreadable row
  *is* the finding — so it must be routed into the finding set, not out of the answer.** Dropping it is
  the same silence one layer in; throwing takes every other row's finding with it, and both land on the
  reassuring side. Counted on the rule's own anchor — a conversion applied to a row *page*, since a
  single-row read that throws is correct and ADR-0289 says its caller must not be served past — the
  class had **82** members needing a declaration and has **65**, so 17 are closed and 42 of the rest
  are an explicit backlog. (An earlier version of this entry said **51**, with "63 single-row reads
  excluded"; that triple is the *refused* anchor's — every invocation of a row mapper, 114 sites of
  which 63 are single-row — and `REFUSED_ROW_PAGE_ANCHORS` refuses it for exactly that reason. It
  then said **67** and **44**, which were right when written and wrong one increment later, because
  ADR-0374 migrated `listRecent` and `getBySequence`: both figures move with every slice that
  migrates a store, which is why this entry says to **re-derive them by calling the module** —
  `scanWorkspacePageReads(readWorkspaceSources().files)` over `VERDICT_NEEDS_DECLARATION` — rather
  than reading them here. As of ADR-0375 the module answers 907 files, 111 sites, 65 needing a
  declaration, 65 declared, 42 of them `unmigrated`, and `{guarded_by_primitive: 16,
  guarded_in_place: 2, record_throwing: 50, record_total: 11, record_dropping: 2, projection: 30}` —
  `scanCheckpoints` is the new `guarded_by_primitive` member, so it needs no declaration.
  ADR-0374's `906 files, 110 sites` was **right when it was written** and moved by exactly one of
  each; ADR-0375's first draft of this sentence recorded **943**, which is
  `readWorkspaceSources().files.length` — the *input* including tests, where `scan.files` is the
  module's answer — and then "corrected" the earlier figure by comparing input against answer. So
  the paragraph whose whole content is *re-derive* argued from a quantity nothing produces, and
  `.files` is in the call above because omitting it throws rather than answering wrongly.
  Re-derive; do not diff, and read the field name.)
  The two live members show the two routes to that silence: one makes the **row** unreadable
  (the sweep stops), the other makes the **evidence** unreadable in a way the contract tolerates (the
  detector answers *cannot say*, which is not a defect).

  Live on PG 16.13 as a non-owner, the two faces. A blanked `actor_reference` on a chain entry is a
  genuine signature-breaking tamper — the field is inside `canonicalEntryBytes` and no CHECK refused
  `''` — and `loadChain` **threw**, so the hourly integrity pass filed `outcome: "error"`: no verdict
  row, no `onFinding`, no `escalate`, **no paging sev1**, one log line an hour for ever, while
  `verifyStoredChainSignatures` — the only check in the stack that binds an entry's stored columns to
  its content (ADR-0371) — is the detector the tamper disabled. And a blanked `operation` on an
  anchored audit row was **dropped**, so the anchor check (the only detector there is for an edited
  audit row, ADR-0286) was never asked about it and the proof read **`verified`** — where the *same
  row rewritten into a valid shape* read `hash_mismatch` and `compromised`. **The two rewrites
  answered oppositely, and the one that did not page is the easier one**: both are one `UPDATE` as the
  same role, and the contract-refusing one needs no knowledge of the canonical payload. That is why
  the new verdict clause sits beside `tampered` and not beside `unanchored` — an unanchored row is the
  *absence* of evidence, and the write path's new parse makes this one conclusive rather than inferred
  (ADR-0322's axis).

  The recurring rule held an **eleventh** time — the honest fix sits one level up. The pain was 51
  reads; one level up is `kernel-pg`'s `read-rows.ts` plus the twelfth workspace rule over the class,
  and the primitive's two shapes are the whole design: a store whose consumer is a scheduler or a
  route **forwards** a reporter, while one whose consumer is a **verifier** returns the refused rows
  beside the records, because there the unreadable row is not a note on the side and a verdict computed
  over the readable rows alone is a verdict about a different set of rows than the one on disk.

  Three things were sharper than the defect. **It corrects ADR-0372 on the one thing that increment
  argued hardest for**: that module says no other column of a refused row may be reported and then
  reports `err.message`, which for an `invalid_enum_value` issue *is* the stored value — so
  `unreadableDetail` answers the field path and the issue code, sorted and de-duplicated, and a test
  pins that `err.message` contains the value while the detail does not. **The write path's refusals
  were not a superset of the read path's and neither nested the other**: `assertEmittable` checked
  four things by hand while the reader parses through a `.strict()` `AuditLogEntrySchema` that refuses
  an `actor` with an extra key, an `occurredAt` with no offset and any extra top-level key — while the
  guard refuses `operation: " "`, which `z.string().min(1)` admits. That is ADR-0353's
  `META_DEPLOYMENTS` shape and it makes every *the writer is stricter* test structurally blind; the
  guard ends in the reader's own parse now, which is the premise the `compromised` verdict rests on.
  And **`certification.ts`'s duplicate chain reader carried ADR-0331's defect in its second
  spelling**: its `SELECT` had **no `WHERE` clause in either branch** while its own comment claimed *"a
  null tenant reads the platform chain"*, so as the owner — which the shipped compose is — it read
  every scope interleaved, the fold reported a `sequence gap`, and `audit.tamper_evident_log` read
  **not satisfied** on a healthy chain. Deleted rather than fixed; `forensicChainReaderFor` is the one
  reader there is.

  The stated cost is a **forward**-compatibility hazard rather than a current false positive, and it
  is concrete: `ActorSchema` is `.strict()` with five required-and-nullable keys, so adding a sixth to
  `AuditActor` makes every stored row unreadable and therefore every scope `compromised` — a paging
  sev1 caused by a schema evolution, where the same change used to be silent. The remedy belongs to
  the contract change (the field must be `.optional()`, or arrive with a migration — ADR-0351's
  versioning rule one table over), and it is the increment's second open end.

  ADR-0374 is the increment ADR-0373 made necessary, and the class is **the increment's own alarm,
  cancelled by a write it does not fence**. That increment routed a blanked `actor_reference` on a
  chain entry into the verdict as `compromised` with a paging `sev1` — and one `UPDATE` on a column
  of a **different table** cancels it, because `proveScopeIntegrity` reaches
  `checkpoints.latest(scope)` with no `try` at either of two call sites: one inside
  `verifyChainFromCheckpoint` and one directly, for the
  truncation check. The count is per **mode** rather than per pass — two on `fromCheckpoint: true`
  and one on `false`, the first being gated on the mode — which is precisely why catching it in the
  chain half alone closes nothing, since the site a full fold reaches is the one that half skips. ADR-0373 gave that store a parse on read, which is the premise the whole increment
  rests on, so a refused checkpoint row now reaches both `await`s as a thrown `ZodError` and the
  hourly scheduler files `outcome: "error"` — no verdict row, no `onFinding`, no `escalate`, no page.
  It is ADR-0373's own graded way (3) — *the tamper disabled the detector* — on a read it migrated and
  a **table** it did not fence, and the direction is the dangerous one: the cheaper write buries the
  finding about the dearer one.
  Catching it in the chain half alone would have closed **nothing**, which is the measurement that
  shaped the fix: on `fromCheckpoint: false` that half never calls `latest` at all, so the second,
  direct call is still unguarded — and that is the call a deployment whose anchors cannot be trusted
  reaches on *every* pass. So `anchor_unreadable` is a fifth `ChainFullReason` (fold from genesis,
  naming the reason, catching **only** `CheckpointRowUnreadable`) **and**
  `IntegrityProofReport.anchorRowsRefused` is a third refusal axis that `integrityVerdictFor` answers
  `compromised` for — beside `tampered` and not beside `unanchored`, on ADR-0373's exact argument one
  table across, and checked **before** `anchors === null` so the finding does not depend on whether
  anything else in the scope happened to be anchored. **The fold alone is not sufficient**: a full
  fold over a sound chain answers `ok: true`, so it reads as a healthy full verification.
  Two things were sharper than the defect. **It is reachable by the tenant and not only by an owner** —
  that table's isolation policy is `ALL`-scope with a NULL `WITH CHECK`, so its `USING` doubles as the
  write check and a tenant-context session `UPDATE`s its own checkpoint (`UPDATE 1`, live as the
  non-owner `serving` role) — and the census generalises past the finding: **78 `meta` tables are in
  that state, 0 of them carry a `DELETE`-scoped policy, and on **6 of 6** scopes measured a
  tenant-context non-owner's `DELETE` count **equalled the owner's row count** on every one of
  `forensic_chain_checkpoints`, `forensic_chain_entries` and `audit_log` — so a tenant destroys its
  entire tamper-evident trail in its own scope.** (The figure first recorded here was a single
  stitched triple, `DELETE 1 / 12 / 3`, which **no scope answers**: the first two come from one
  tenant and the third from another. Comparing against the owner's count per scope is both the
  honest form and the control the triple lacked.) So **CLAUDE.md's own "`DELETE` is
  reachable by no policy on any of the 32" is true of the *named arms* and false of the behaviour**,
  which is corrected in the RLS bullet below; the empty-scope control is what makes that measurement
  trustworthy, since the same statement for a scope holding nothing answers `DELETE 0` — ADR-0333's
  silent zero, in the measurement that would otherwise have read as protection. Narrowing 78 isolation
  arms is one decision over the whole catalog and is reported rather than taken.
  And **the column nobody was pointed at was in the same state**: `external_anchor_reference` is
  `z.string().min(1).optional()`, so `''` is refused by the contract exactly as a blanked
  `checkpointed_by` is — measured, same throw, same verdict — and both are fenced in the same change
  with `char_length(x) >= 1` and deliberately **no** upper bound, because both contracts declare no
  maximum and a CHECK refusing what the contract permits is the same defect pointing the other way.
  The migration exercised **both** of ADR-0363's arms on one cluster, and the other arm is the sharper
  result: the two new CHECKs report `constraint_widening_unproven` with the `BEGIN`/`ALTER`/`COMMIT`
  triple, while **ADR-0373's own `actor_reference` CHECK reports `constraint_violated_by_existing_rows`
  with the violator `SELECT` alone** — because that cluster really holds the blanked row ADR-0373
  measured, so the migration **found a tamper rather than merely preventing the next one**.

  ADR-0375 takes ADR-0374's own open ends 6 and 7 and the class is **one witness read, and never
  compared**. Two faces, both live, and measuring the open ends is what found them.
  *The aperture*: the detector ADR-0374 built is `latest()` — **one row** — so a refused checkpoint
  row is a finding only while it is the *newest*, and on a scope holding N anchors the other N−1 can
  be blanked with no verdict change. Measured as the non-owner `serving` role on one scope with
  anchors at 1, 3 and 4, `checkpointed_by := ''` under that tenant's own context: at sequence 1
  `verdict=verified anchorRefused=0`, and the **identical statement** at sequence 4
  `verdict=compromised anchorRefused=1`. So the scheduler's refusal-to-anchor protected exactly the
  one row a tamperer need not choose, and charged a permanent fold from genesis and an unanswerable
  truncation check for it.
  *The correspondence, and the worse half*: nothing compares a checkpoint's `root_hash` against the
  chain entry at its sequence, except incidentally inside `verifyChainSuffix` for the newest anchor
  on a bounded pass — and `sequence_number`'s only CHECK is `>= 0`, so **on a fully converged
  deployment** one `UPDATE` edits an anchor into a valid-shaped lie. Raised above the tail it
  manufactures `truncated=true causes=[chain_truncated]` with the formatter printing *"TRUNCATED:
  checkpoint at 99 but the chain ends at 4"* — a **false** paging sev1 telling an operator audit
  history was destroyed while every entry is present, naming the wrong table, and leaving the bounded
  fold checking **0** signatures because the suffix after 99 is empty. Lowered it hides a real one,
  and that arm is the increment: a genuine truncation (`cut >= 3` → `compromised
  causes=[chain_truncated]`) followed by two `UPDATE`s lowering the anchors below the new tail reads
  **`VERIFIED`**, with *"integrity valid, signatures valid (3 checked)"* and no truncation line at
  all — two destroyed entries of a tamper-evident audit log, hidden by editing the witness. A third
  arm needs no sequence edit: `root_hash := 'f'*64` on the tail anchor reads `verified` on **both**
  modes.
  `scanCheckpoints` + `anchor-audit.ts` read the table as a set and cross-check it, which closes
  every arm above; the honest limit is that **the fix recovers the evidence that a witness was
  altered, not the truncation itself — and only for an edit that leaves `root_hash` behind** — once a
  witness is edited the truncation it would have proven is unprovable, and what survives is proof of
  the edit *because the stale root hash is still there* (both lowered anchors come back
  `root_hash_mismatch`, because their root hashes name entries the cut destroyed). **An adversarial
  pass over the commit found the other half of that sentence, and it bounds the whole increment: a
  two-column `UPDATE` defeats the correspondence rule.** `disagreementFor` asks three questions and
  every "no" falls through to *no finding*, which is deliberate for the case the truncation check owns
  (an anchor the chain does not reach yet) and is also what setting both columns produces. Measured
  by the same single statement as the same non-owner role: lowering each anchor **and** setting its
  `root_hash` to the surviving entry at its new sequence reads `verified truncated=false witness=2
  disagree=[] causes=[]`, byte-identical to a healthy scope; raising one to 99 **and** `root_hash :=
  'f'*64` restores the false `chain_truncated` sev1. Neither costs the attacker anything extra — the
  destination entry's hash is readable from the chain, and `UNIQUE (tenant_id, sequence_number)` only
  needs the destination sequence free, which it is wherever an anchor moves *down* off its own. So
  this raises the cost of the cheap edits and closes none of the dear ones, and the two-column form is
  **quieter than the `DELETE`** below it, which at least leaves `witness=null` for an operator to see.
  It is the top open end; the obvious detector beside it (`checkpointed_at` compared against
  `sequence_number`'s order) is recorded **with its refutation**, because it reaches neither arm — the
  lowering moves the anchors *in order*, so both orders are the same permutation, and the raising
  moves one row, which is trivially monotonic. With a sound
  set-wide detector the scheduler anchors again, so `CHAIN_FULL_REASON_BLOCKS_ANCHORING`,
  `anchoringWouldBury` and `refused_anchor_would_bury` are **deleted** rather than relaxed — which
  corrects ADR-0374's own prediction of a "one-line relaxation", refused by the fence it shipped
  beside it: `anchor_unreadable` was that map's only `true`, so flipping it leaves every member
  `false`, which `chain-verify.test.ts` calls a silently disarmed fence and asserts against by name.
  **A judgement with no case left is not a judgement.** The one attack it does not close is the
  cheapest: every anchor `DELETE`d reads `verified`, `witness=null`, and the formatter prints
  *"truncation: not checkable (no checkpoint yet — run the checkpoint scheduler)"* for a scope whose
  checkpoints were destroyed — a remedy that cannot work (ADR-0334), measured and named as the top
  open end rather than speculated, and closing it means reading the chain's own memory of a prior
  witness, which makes one pass's verdict an input to the next.

  ADR-0376 is the first increment to touch the **deployment** rather than the engine, and the class
  is **a default that is not a default, and a surface that does not say it is there**. It takes the
  register's oldest P0 item — the shipped compose mounts no background subsystem — and finds that
  its framing was the wrong question: of eleven absent flags only **three** were a default decision,
  and measuring the three refuted the register on one, refuted **this increment's own first draft**
  on another, and turned up a defect in the binary that was in no register entry.
  *The defect:* the drain-absence warning was gated on `senderWiring.report.channels.length > 1`,
  and `buildSenderRegistryFromEnv` registers `in_app` **unconditionally** while the shipped compose
  sets no SES or Twilio variable — so `channels` is exactly `["in_app"]`, length 1, and the warning
  was **unreachable on every deployment that ships**. Boot printed `[notify] channels: in_app` and
  stopped, which reads as "in-app notices work", and `DeliveryScheduler` is the *only* delivery path
  in the binary, so with no drain nothing was delivered on any channel — the
  looks-healthy-sends-nothing failure the comment on that gate said it existed to prevent. The gate
  could not have been right at **any** value, because `in_app` makes `>= 1` a tautology; the honest
  axis is the **store**, where a Postgres store with no drain has a remedy to name and `--store
  memory` refuses the flag at parse and builds no notification store at all (ADR-0334's `missing` vs
  `not applicable`). Verified live in three arms as a non-owner.
  *The withdrawal is the better half.* `--read-state-routes --read-state-role platform_admin` was a
  default in a draft, measured end to end (every badge fetch answers **404** today; with the flag,
  **200** `{"scope":"self"}` through a session minted by the documented bootstrap) — and then
  withdrawn, because `markNoticeRead` and `markReadThrough` have **zero consumers** in
  `operate-web`, **no page lists notifications at all** (`/inbox` is the approvals inbox over entity
  records, a different subject) and the badge counts unread in_app notices. So the default would
  replace a *decaying* approximation with a true count nothing can ever reduce, which is ADR-0334's
  remedy-that-cannot-work one notch out. It is blocked on a **surface**, not on a default, and the
  absence is fenced with its reason. Beside it, the grant was measured to protect nothing:
  `resolveViewer` takes the viewer from `principal.principalId` unconditionally and
  `bodyNamesAViewer` refuses a body naming one, so `allowedRoles` gates a principal's access to its
  **own** row — ADR-0364's argument for `/v1/account/password` needing no grant, at a second surface.
  *`--tenant-status-gate` is on, and ADR-0334's reason for leaving it off is retired by
  measurement:* the shipped key carries `platform_admin`, which reaches **0 of 255** (ADR-0365), so
  `GET /v1/vendors` with it was *already* a 403 and the gate only improves the diagnosis — while an
  api-key naming the placeholder tenant **with an ERP role** was served **200 over a tenant that has
  no `meta.tenants` row**, writing records under a `tenant_id` with no parent. Serving an
  unprovisioned tenant is not "working" (ADR-0338), and the boot survey names it by uuid before the
  first request.
  *And the documented bootstrap was one step short of runnable in all three documents*, which is
  ADR-0364's addendum class for the fifth time: every version omitted creating the tenant, so the
  membership grant answered **422** `meta.tenants has no row for the id this grant names` on every
  fresh deployment and there was no documented source for the uuid it wanted — the id is **minted by
  the server**, which is also why `OPERATE_ADMIN_API_KEY`'s placeholder can never name a real
  tenant. The step it called shell-only has been an HTTP route since ADR-0364, authorised by a
  **grant** the compose passes and satisfied by that same api-key (200 with `x-api-key` alone,
  measured), so its stated reason — *"reaching that route needs a session, which needs a
  password"* — was true of the console and false of the route. `ORACLE.md` additionally still
  carried ADR-0369's pre-fix claim and told an operator to keep a **spare tenant** for themselves to
  work around it. `deployment-defaults.test.ts` is the **first fence over `deploy/`**, which is the
  increment's own class answered one level up: the compose is not typechecked, not linted and
  imported by nothing, so a deleted line there is invisible to all twelve rules and every test —
  exactly how `docker-compose.ai.yml` came to be ten flags behind the base.

  ADR-0377 closes the register's P0 item 2 and the class is **a cursor carrying what the ordering
  does not**. ADR-0357 measured the disclosure, surveyed it, reported it at boot and fixed nothing,
  leaving two things half-true. *The mitigation was one environment variable and the canonical
  quickstart told the operator to leave it unset*: `deploy/.env.example` carried
  `COLUMN_ENCRYPTION_SECRET` and `CURSOR_ENCRYPTION_SECRET` **commented out identically** while
  `ORACLE.md`, `README.md` and `VERCEL-SUPABASE.md` all treat the cursor one as required — so "still
  open by default" understated it, and the asymmetry that settles it is measured on the pack the
  compose serves rather than chosen: resolved `erp-core` declares **0** `phi`/`regulated` fields and
  **1** classified field a list view can sort by, so the at-rest secret is right to stay commented
  and the cursor one is not. It is uncommented with a generator line, and the boot pair over the
  identical field is the verification (`plaintext_disclosing … Employee.work_email (pii)` →
  `sealed … none of their values travels back in the clear`).
  *And ADR-0357's own write-up claimed a second defect that does not exist.* It called the column
  store worse than the document store with "a soundness bug in the keyset beside the disclosure",
  because `columnExpr` answers `unavailable` for an `encryptAtRest` column so `?sort=mrn` is dropped
  from `ORDER BY` while the value is still rendered into the cursor. **The disclosure is real and the
  soundness claim is not**: a dropped key contributes no clause to `seekPredicate`, which builds from
  `usable` alone and pushes the id tiebreaker unconditionally, so the component is read by nothing —
  **dead payload**, which is exactly what makes withholding it free. `nullDroppedSortComponents`
  blanks it, **in place and never removed**, because `seekPredicate` indexes `cursor.k` by *declared*
  position and that indexing is ADR-0359's own fix for the `?sort=mrn,family_name` mis-comparison.
  Measured live as `front_desk` (holds `Patient.list`, not `mrn.read`) on `pg-columns` with real
  `bytea` PHI: the cursor goes from `{"k":["MRN-SECRET-1"],…}` to `{"k":[null],…}`, the body omits
  `mrn` in both, and the walk still visits 3 of 3 rows once and terminates. The fix is **not** in
  `keysetOf`, refused on two measurements — on `--store pg` every field is expressible so it would
  close **0 of 14** members, and doing it anyway would confine that store's walk to the NULL tail.
  Removing the call is a **compile error** rather than a silent revert, since the import then goes
  unused.
  **And an adversarial pass over part 1 *as first written* found it shipped a falsely-true control,
  which is the sharpest thing in the increment.** `REPLACE_WITH_32_PLUS_RANDOM_CHARS` is **33 bytes
  with 19 distinct byte values**, above both of `refuseWeakSecret`'s floors (32 and 16), so
  `parseCursorEncryptionSecret` **accepts it** — and nothing in any `.ts` fenced the marker
  (measured: zero hits). So `cp .env.example .env` without replacing that one line would have gone
  from a *true* warning naming the field to a *false* `sealed` asserting "none of their values
  travels back in the clear", under a key derivable from a file in this repository: ADR-0337's
  direction, created by the fix, and the fifth time this run has reproduced its own class inside its
  own fix. `SECRET_PLACEHOLDER_PREFIX` plus a third `COLUMN_SECRET_REFUSAL_REASONS` member
  (`unreplaced_placeholder`, checked **first**) closes the cursor secret, the column secret **and
  the credential pepper** in one change — and the pepper was **already live**, because
  `OPERATE_TOKEN_SIGNING_KEY`'s placeholder is 31 characters and genuinely refused, so the
  documented path is *copy → boot fails naming the signing key → replace that one line → boot
  succeeds* and leaves the pepper published on a `meta.users` that has **no RLS**, which is ADR-0358's
  own stated reason the pepper exists. The rule: **an entropy floor cannot see the one weakness a
  placeholder has, which is that it is published**, so the check is on the literal and not on its
  strength.

  ADR-0378 takes the register's oldest arithmetic item and the class is **a wrong figure that
  balances**. It opens by retiring two of that item's three clauses: `Currency.decimal_places` is
  inert and **reading it could not change a figure**, because no money *amount* field in any of the
  seven packs exceeds `scale: 2`, so a 3-decimal currency cannot be stored at three decimals
  anywhere; and the hardcoded `100` is not the defect either, being correct for every declared field
  and the same choice `billing/src/tax.ts:84` made when it was written. **The defect is the *rate***
  — `Math.round(net * (rate / 100) * 100) / 100`, a double times a double — and the fix is that
  module's own idiom with the *rate* scaled to an integer too, so the product is exact rather than a
  double.
  The measurement is what makes the finding both narrower and worse than the register's. Over
  **60,000,000** (rate, net) pairs — every `decimal(6,3)` rate against nets to 20.00 — the per-line
  error is **exactly 0 or −1 cent, 764 times under, never over**, and that one-directional property
  *decides which figures were reachable*. For **regular tax the reconciliation gate already protected
  the posted amount**: it accepts a line-derived split only when `|netTotal + taxTotal − total| <=
  0.005`, and since no line can be a cent **high**, a total that ties to an exact stamped total
  implies every line was exact — no combination of codes can compensate for a deficit — so what moved
  was never the figure but **which GL account it landed on**, a correctly-totalled document having
  silently lost its per-code split. The one reachable **money** defect is **withholding**, and it is
  reachable precisely because the gate excludes it by design (`taxTotal` is regular tax only): the AR
  control amount `total − withholdingTotal` was **overstated** by a cent and the statutory
  `withholding_total` that `whtCertificateClearingEffect` prefills a certificate from
  **understated** by one — **in an entry that balances**, 0.70 debits against 0.70 credits, which is
  why no gate, write guard or replayer could ever have caught it and `journalPostingGuard`'s
  double-entry invariant is satisfied by a wrong set of numbers.
  Three things were sharper than the defect. **An independent refutation recommended the wrong form
  and was refuted by a wider population**: it measured net-only scaling at **0 divergences** and this
  increment measures it at **52 in 1.8M real-rate pairs** (`12.50 @ 2.28%` answers 0.28 for an exact
  0.29), because its rate set evidently reached no 3-decimal rate — so a recommendation backed by a
  measurement is still only as wide as its population, and the form is kept as the *fallback* where
  its imprecision beats the alternative. Which matters, because **truncating an unrepresentable rate
  is not the conservative failure**: `1234.56 @ 0.0625%` truncates to `0.063%` and answers `0.78`
  where the exact figure is `0.77` — wrong in the **over** direction the whole increment exists to
  stop — so a fourth decimal falls back rather than scaling. And **the headline is the mechanism and
  deliberately not a frequency**, because three honest measurements of one defect give 1 in 376, 1 in
  174 and 1 in 306: the rate is a property of the tenant's (rate, net) population and swings ~450x
  between a real-rate rectangle and the full declared domain, so the comment records the direction
  and the cause, which are durable.
  The **952 pre-existing `write-effects` tests are assertion-neutral** to the change — every fixture
  uses a round net against a round rate, which is the honest account of why 20k tests never saw it —
  and restoring the double form fails **4 of the 5** new boundary tests and **none** of the 952.
  Beside it, **P0.6b is withdrawn with its measurement rather than shipped**: the facts hold (no
  effect `compile.ts` wires triggers on `paid`, while five declared transitions reach it), and the
  proposed remedy is measured **harmful** — a residual posting cannot tell *paid with no Payment
  rows* from *paid via payment application*, so on the ordinary ordering it posts the document total
  on top of what a Payment already settled (**AR net −50, cash +170**), silently, because the entry
  numbers differ so no constraint fires. ADR-0366's rule read forward: a *proposed addition* is
  withdrawn with its refutation exactly as a retention is.

  ADR-0381 closes the last of the register's P0 items and the class is **a fact already read and
  thrown away** — this run's most-found shape, landing on the authorization path. A session carries
  the roles the login resolved at mint time (ADR-0369) and nothing on the request path re-consulted
  the membership, so revoking one took effect at the next login: **one hour** on the shipped
  compose. Meanwhile `abacAttributeDirectoryFromStore` has read that row in the auth stage on every
  request since ADR-0341 and answered `null` for exactly a revoked or absent membership — and the
  only consumer of that `null` was `dischargeAbac`, which acts on it for a grant carrying an
  obligation, of which the measured count across the seven packs is **zero**. The revocation was
  detected and the detection reached nothing.
  **The register's own named precedent would have built the wrong thing**, which is the increment's
  second finding: it pointed at ADR-0334's tenant-status directory — a *second* cached directory —
  and that is right for its own question (there was no existing read of `meta.tenants` on the
  request path) and wrong here, because two directories over one row are two caches with two TTLs
  that can disagree about whether one membership is active. So `withMembershipRevocationCheck` is a
  **sibling decoration over the same instance**, composed outside `withAbacAttributes` so a refused
  principal is refused before anything is attached, with the second `attributesFor` a cache hit by
  construction.
  The soundness rests on a **measurement rather than a type**: `attributesFor`'s `null` means *no
  row* or *not active* and never *active with no attributes*, because `MembershipRecord.abacAttributes`
  is `z.record(z.unknown())` — neither optional nor nullable — over a column declared
  `NOT NULL DEFAULT '{}'::jsonb`. Were it nullable the gate would refuse active members whose
  attributes are empty, which is most of them; an earlier draft assumed exactly that and had planned
  a three-valued refactor of the cache, which the measurement retired. Default-on under
  `--credential-login` with no flag of its own (ADR-0338's rule), scoped to a principal that names a
  person so a bare api-key's shared `DEFAULT_PRINCIPAL_ID` cannot refuse every service credential at
  once, and tied to the login rather than offered to `--jwks-url` — the two are mutually exclusive,
  so the gate never sees a foreign subject and an *absent* row really is a revocation.
  Live, one hour → **30 seconds**: 200, revoke, 200 (the cached value), **401** after 31s, with the
  api-key unaffected and a restored membership working again six seconds later. The window is the
  directory's value TTL and **not** the session TTL, which the boot line says with the figure because
  the two differ by two orders of magnitude.
  And **this increment's own class landed on its own fix**: that boot line was first a ternary with
  an `OFF — needs a Postgres store` arm, and **that arm cannot fire**, because `--credential-login`
  is refused at parse under `--store memory`, so reaching the line implies a connection, the
  directory and the gate. ADR-0361's reason for deleting an unreachable check, and it was caught by
  booting the arm it claimed to describe — the only thing that would have.

  ADR-0380 is the small sharp half of the register's oldest operational item, and the class is **a
  verdict over nothing**. P0.9 named it as *`verify-chain` exits 0 over an empty chain*; measuring it
  rather than taking it on trust found that it survives two increments that had touched that command
  (ADR-0374's addendum for a refused anchor, ADR-0375 for anchor findings) and that **the sharp case
  is worse than the item records**: a scope with a checkpoint at sequence 7 and **zero** chain
  entries — which ADR-0375 says is a state only the tamper produces, since nothing in the workspace
  deletes a chain entry and the Article 17 shared-table erasure *retains* that table — printed
  `witness 7` beside `signatures: valid (0 checked)` and concluded **`OK`, exit 0**. Every fact was
  on the page and the verdict contradicted them.
  Three things compose into it and none is a bug alone: `verifyChainIntegrity([])` and
  `verifyChainSignatures([])` are **both vacuously valid**, so `ok` is true over zero entries; the
  anchor audit **deliberately** does not call a witness the chain fails to reach a *disagreement*,
  because that is the truncation check's whole subject and folding it in would report one fact as two
  causes and take the witness away from the check that needs it (its own doc says so); and **the
  truncation check was computed in exactly one place**, inline inside `proveScopeIntegrity`, so
  `verify-chain` — which holds the witness and *prints* it — never read the tail to compare against.
  The hourly pass caught it and the command an operator runs by hand did not.
  So `chainTruncation` is one definition with two callers, moved to `anchor-audit.ts` which owns the
  witness it compares (ADR-0371's reason for moving `ChainTail`), and the exit code is a three-way
  conjunction. The second half is the **headline**: a fold that examined nothing now prints
  `NO HISTORY — nothing was examined` rather than `OK`, and **exits 0**, which is the decision rather
  than an oversight — a new tenant and a tenant whose entries *and* checkpoints were both deleted are
  byte-identical from these two tables, closing that needs the chain's memory of a prior witness
  (ADR-0375's open end 2), and the repo's exit vocabulary has no third value since **2 already means
  a usage error**. So the state is *named* rather than resolved, and the word an operator reads as
  "verified" is withheld. `formatChainTruncation` gives all three states a sentence and the quiet one
  is the point: no witness prints *"not checkable"* and never *"not truncated"*, because the second
  claims a check that never ran (ADR-0372).
  Live, four arms, and the last two are the non-vacuity controls a fence that refused everything
  would have passed: the witnessed empty chain goes `OK/0` → `TRUNCATED/1`, the unwitnessed one
  `OK/0` → `NO HISTORY/0`, and a 6-entry scope stays `OK/0` both with and without a witness it
  reaches. Mutation-checked: narrowing the predicate to the obvious `tailSequence !== null && …`,
  which silently drops the empty-chain case, fails 3 of the 10 new tests.

  ADR-0379 takes the register's most serious remaining item — an Article 17 request naming one data
  subject erasing the whole tenant — and the class is **a claim the code cannot make**. The runner
  hardcoded `kind: "data_subject_erasure"` over a pipeline whose entire remit is to empty every
  table carrying the tenant's id and drop its schema, so every verified request destroyed everyone's
  data under a signed proof saying one person's had been erased. Live, with the pre-fix behaviour
  reproduced by a two-point mutation on one cluster: Bob asked, the stored tombstone read
  `kind=data_subject_erasure rows=3`, and **0 records were left — including Carol's, who never
  asked**. After, the same flow stores `kind=tenant_deletion` referencing the request.
  **Nothing downstream could have caught it, and that is the finding rather than an aside.** The
  kind's only refinement is that it reference a deletion *request*, the request's `subjectIdentifier`
  is required, so the proof names its subject **transitively and is internally consistent** — while
  no refinement anywhere bounds that kind's **scope**, because a `DeletionScope` is a list of
  schemas and tables and the contract sees *what* was destroyed and never *whose*. A tenant-wide
  scope under it parses, hashes, verifies and anchors, measured. So the two obvious fixes are both
  wrong: **threading `subjectIdentifier` makes the record worse**, since a subject named on a proof
  covering every table reads as a per-subject erasure that *verifies* where the unlabelled one at
  least lets a reader see the contradiction (ADR-0337's direction, and the field exists on
  `DeleteTenantInput` with **no caller in the workspace**); and refusing the kind at the runner alone
  would make every verified request refuse, **silencing the only wired Article 12(3) instrument**,
  since `auditCompleted` walks `status = 'completed'` and a path that cannot complete is never
  audited for lateness.
  So the fix is one level up and in three parts: `TENANT_WIDE_ERASURE_HONOURS`, a total map over
  `TOMBSTONE_KINDS` answering whether destroying a whole tenant *truthfully performs* that kind
  (`tenant_deletion` and `scheduled_purge` yes, the other three no), refused at the pipeline's
  **`input`** stage so a returned refusal still means nothing was destroyed and the runner files it
  `rejected` rather than stranding it; `--deletion-subject-scope tenant|subject`, **required** by the
  runner with no default on ADR-0328's argument one question across — that flag says what the
  deployment *holds* and this one what a verified request *reaches*, and neither value is safe to
  assume since `tenant` destroys every subject's data when one asks while `subject` is **refused at
  parse by name**, naming the missing per-subject capability (P1.4) rather than a flag to add; and
  the synchronous route's kind set narrowed to what the map admits.
  Four things were sharper than the defect. **The map's own type refused the mutation** — restoring
  the hardcoded kind is `TS2322` against `Readonly<Record<"tenant", "tenant_deletion">>`, so the
  pre-fix line does not compile in the post-fix tree and the before-measurement needed the
  annotation widened first. **Two existing tests asserted the defect as the intended behaviour**
  (ADR-0372's shape for the sixth time), one of them accepting a `data_subject_erasure` with a
  **200**, and a third titled *"accepts only the two kinds a tenant-scoped delete can produce"*
  naming both — the defect written down as a specification. **A guard was deleted rather than kept**:
  it refused that kind with no request reference and could no longer fire, and the typechecker found
  it, which is the argument for the kind set being a narrowed type rather than a runtime filter.
  And the route's narrowed list is **written down and fenced in both directions** rather than
  derived through a cast, because `filter` types as the full union and an `as` there would be
  ADR-0362's annotation-standing-in-for-a-check — with a non-vacuity assertion beside it, so
  narrowing the remit by hand cannot retire the fence while keeping it green.

There is no roadmap document for Phase 4 by design; the user directs the next
increment. See **What's actually left** at the bottom for the current open ends.

## Architecture in 90 seconds

- **`zod` schemas are the source of truth.** Types derive via `z.infer`. Every
  package exports `XSchema` + `type X` pairs.
- **Purity is layered, not optional.** A contracts package defines record shapes,
  state machines and pure functions. A `-runtime` package executes them in
  process. A `-runtime-pg` package persists them. Sockets and SQL live only in
  the last kind. The Package map below explains the pattern once.
- **The kernel meta-schema is the integration point.** Any package needing
  persisted records wires `META_*` table definitions into
  `packages/kernel/src/bootstrap/meta-schema.ts`; the kernel emits DDL
  deterministically from those.
- **Tenant isolation by RLS.** Tenant-scoped tables enable row-level security
  with `tenant_id = current_setting('app.current_tenant_id', true)::UUID`.
  Platform-wide tables skip RLS. Both are enforced by the meta-schema test suite.
  The predicate is `NULLIF`-guarded for a measured reason: `current_setting('app.current_tenant_id',
  true)` answers NULL only until the setting has been *used once* on a connection, after which its reset
  value is `''` — and `''::UUID` **raises**, so an unguarded cast fails on every pooled connection that has
  served a tenant, i.e. in production and not in a fresh psql session.
  Note: a table's **owner bypasses RLS** — verified empirically — so
  cross-tenant reads are granted explicitly (e.g. `app.platform_review`,
  `app.platform_audit`), never assumed from role. On `meta.audit_log` that grant is a **second,
  `SELECT`-only policy** (ADR-0313) rather than an `OR` inside the isolation one: on an `ALL`-scope policy
  the `USING` expression also serves as the `WITH CHECK`, so a combined form would let an elevated reader
  forge an entry into another tenant's chain. Verified live as a non-owner role, in both directions.
  **`tenant_id` is nullable there, and NULL means platform scope** (ADR-0331) — a fact about the
  deployment rather than about one tenant — reachable only through a **third**, `INSERT`-scoped policy
  on its own grant `app.platform_audit_write`. Three decisions, each load-bearing: its own GUC, because
  `app.platform_audit` is the *read* grant and the population holding it is the one whose conduct these
  rows record; `INSERT`-scoped, so it carries only a `WITH CHECK` and cannot serve an `UPDATE`'s or
  `DELETE`'s `USING`; and `tenant_id IS NULL` *inside* the check, so the write elevation buys no access
  to any tenant's chain. `meta.forensic_chain_entries` and `_checkpoints` carry the same split on the
  same grant, since the chain anchors that trail and the two are one privilege.
  **The same split now covers the other 29 tables that had the permissive shape** (ADR-0332), over
  three more grants — `app.platform_record_write` (17 tables), `app.platform_config_write` (11) and
  `app.platform_key_write` (1, `crypto_keys` alone, because that table holds the public keys a chain
  entry's `signingKeyFingerprint` resolves against, so a session able to both append to the trail and
  register a key could re-sign a rewritten chain and have it verify). **12** of them are mutable and
  get an `UPDATE` arm too; the other **17** are append-only, so a platform row there is
  immutable-by-RLS once written. **No `DELETE`-scoped policy exists on any of the 32 — and that is a
  statement about the named arms, not about the behaviour** (ADR-0374). An `ALL`-scope isolation arm
  with a NULL `WITH CHECK` has its `USING` serve as the `WITH CHECK`, so it admits a tenant-scoped
  `UPDATE` **and `DELETE`** of that tenant's own rows. Measured live as the non-owner `serving` role:
  **78** `meta` tables carry such an arm, **0** of them carry a `DELETE` policy, and a tenant-context
  session's `DELETE` count equalled the **owner's** row count, per table, on 6 of 6 scopes measured
  — all rolled back. Per scope rather than as one triple, because the triple first recorded here
  (`1 / 12 / 3`) is answered by no scope: it stitched two tenants together. The empty-scope control
  is the other half of what makes it trustworthy: the
  same statement for a scope holding nothing answers `DELETE 0`, byte-identical to a refusal
  (ADR-0333's silent zero, in the measurement that would otherwise have read as protection). So what
  the platform split buys is that a *platform-scope* row cannot be deleted, or (on the 17) updated; a
  tenant's own rows are a different question, and narrowing 78 isolation arms is one decision over the
  whole catalog — see *What's actually left*. The one
  remaining member of the write-split class is `meta.audit_integrity_verdicts`, whose hole is
  differently shaped — see *What's actually left*.
- **Strict TypeScript.** No `any`. No `--no-verify`. Explicit return types on
  exported functions.

## Package map

87 packages under `packages/`, 3 apps under `apps/`. Almost every package is
`packages/<name>` with `src/index.ts` re-exporting 3-30 sibling `src/*.ts` modules and a
matching `*.test.ts` per module.

**The layering convention.** Most domains appear two or three times under closely related
names, and the suffix tells you what layer you are in:

- **`X`** — the *contracts* layer. Pure zod schemas, enums, state machines and
  deterministic helpers (validators, comparators, planners). No sockets, no database, no
  clock unless injected. This is where record shapes and cross-cutting invariants
  (four-eyes, tenant scoping, deadlines) are enforced by `superRefine`.
- **`X-runtime`** — the *in-process engine* over those contracts. Still pure and offline —
  it takes an injected `Clock`/`IdGenerator` and returns decisions, plans and projected
  state — but it holds the loop, the scheduler and the state machine driver.
- **`X-runtime-pg`** / **`X-pg`** — the *impure persistence sibling*. Postgres stores for
  the runtime's records (via `@crossengin/kernel-pg`'s `PgConnection`), a
  `withTenantContext` wrapper that sets `app.current_tenant_id` inside a transaction so RLS
  confines every query, a `buildPersistent*` factory that wraps the pure engine so each
  decision is written as it is made, and usually a `replayer` that re-derives state from the
  log and reports drift.

So `dr` declares tiers and RPO/RTO; `dr-runtime` executes a failover state machine and
scores readiness; `dr-runtime-pg` persists the failover/drill/readiness rows. Read the
contracts package first — the runtime packages assume its vocabulary. A handful of
packages exist at only one layer, noted below where that is true.

### Substrate (the kernel itself)

- **`kernel`** — the meta-schema and manifest compiler. Four areas: `bootstrap/`
  (`META_TABLES`, the catalog of **146** platform Postgres tables, plus deterministic DDL
  emit), `ddl/` (the DDL *vocabulary* — `resolvedFields`, field→Postgres types, built-in
  traits, column naming, default rendering, identifier quoting, structural entity diff;
  it does **not** emit entity tables, `operate-runtime-pg` does — ADR-0284),
  `manifest/` (zod manifest types, validate,
  cross-validate, diff, patch, `manifestHash`, `meta.extends` resolution — entity
  *ordering* lives with the store that creates tables, ADR-0285), and
  `tenancy/` + `workflow/` (tenant resolution, workflow definition validation).
  **`bootstrap/emit.ts`'s row-counting guards count *violations* since ADR-0363, and every one of
  them opens with a confinement assertion.** `emitAddTableConstraintIfUnviolated` /
  `emitReplaceTableConstraintIfUnviolated` emit
  `SELECT count(*) … WHERE NOT coalesce((<expr>), true)` and refuse with the count, which is the
  question that decides whether the statement can fail — where `…IfEmpty` asked a **proxy** for it,
  sufficient and strictly narrower. There is deliberately no emptiness clause beside it: an empty
  table is a degenerate instance, and a second clause would refuse a statement that succeeds on a
  table that gained a *satisfying* row between the plan and the apply. `coalesce(E, true)` is
  load-bearing, because a CHECK passes when its expression is NULL — verified to agree with what
  `ALTER TABLE … ADD CONSTRAINT` validates across 20 of 20 expression shapes on PG 16.13.
  `rlsConfinementGuard` is the first line of all four guards (`row_security_active`, asked rather
  than composed — ADR-0362's rule one layer out) and its **two stakes are asymmetric**: on the
  constraint path a confined count lets the step through and the `ALTER` raises `23514`, so the
  assertion converts an opaque failure into a named one, while for `emitAlterColumnTypeIfEmpty` it
  is the *only* thing between a confined session and a **successful** rewrite of rows it cannot
  see — measured both ways as a `FORCE ROW LEVEL SECURITY` owner, the only session that can `ALTER`
  while confined. `tableQuiesceLock` (`ACCESS EXCLUSIVE`) sits between the assertion and the count,
  because `ACCESS SHARE` and `ROW EXCLUSIVE` are compatible and the applier runs each statement in
  its own transaction, so a row could commit in between; `ALTER TABLE` takes that lock anyway, so
  it changes a duration and not a strength. `messageText` escapes `'` **and `%`**, the second being
  a compile-time fence rather than a cosmetic one — unescaped, the guard raises `too few parameters
  specified for RAISE` at compilation of the `DO` block — whose live position is
  `emitAlterColumnTypeIfEmpty`'s raw `type`, since `quoteIdent` refuses either character in a name
  first. The plpgsql variables carry a `_ce_` prefix because a column of the same name makes every
  reference ambiguous (`column reference "existing" is ambiguous`), which the violation guard made
  reachable by being the first one whose query names the table's own columns.
  **`manifest/event-names.ts` is the one spelling of the entity-event grammar** (ADR-0362):
  `eventNameSegment`, `ENTITY_EVENT_VERBS`, `entityEventName` and `producibleEntityEventNames`.
  It lives here and not in `operate-runtime` for a dependency reason that is also the increment's
  own class avoided — `@crossengin/jobs`' survey must enumerate the names the producer can emit,
  and `jobs → operate-runtime` and `jobs → kernel` are both cycles, so copying `segment()` into
  kernel would have been a second spelling of the transform the convergence exists to remove. The
  one thing in it that is easy to get wrong is wrong in the permissive direction:
  `producibleEntityEventNames` reads declared transition **targets** and never `workflow.states`,
  because `verbFor` reads `input.transitionTo`, so a state nothing transitions *to* can never appear
  in a name — resolved `erp-core` has 95 (entity, state) pairs against 77 (entity, target) pairs, so
  reading states would report 18 names producible that no write can emit. Measured across the seven
  resolved packs: **294** names in union (core 230, retail 238, healthcare 243, grocery 247,
  construction 233, education 243, government 243). `eventNameSegment` is deliberately **not**
  idempotent at one input — `segment("")` is `x_` and `segment("x_")` is `x` — and an entity segment
  can never need either, since `EntityNameSchema` is `/^[A-Z][A-Za-z0-9]*$/`, so the odd outputs can
  only come from `eventPrefix` or a `Transition.to`.
  **`validatePermissions` checks a per-field grant for coherence with the entity grants beside it**
  since ADR-0348, where before it checked only that the field exists and every role is declared —
  and all three incoherences were reachable, **three of them live in the shipped packs**.
  `checkFieldGrantCoherence` refuses, in this order: a field role the matching **entity** grant does
  not name (first, because the other two read as puzzling when the cause is a role that cannot reach
  the record at all — inert rather than dangerous, and it reads as working); an `update` role the
  field's `read` grant does not name (a **blind overwrite**, which destroys a value the writer cannot
  see — and an *absent* read grant is **not** a pass, since the field then falls to the
  classification default and it is the same overwrite one level away, so the two cases get different
  messages because the remedies differ); and a `required` field whose **effective** create grant
  (`create ?? update`) fails to cover the entity's `create` roles, which makes the entity
  uncreatable by a role the manifest plainly intends to create it. `requiredFieldsByEntity` comes
  out of the entity index through `resolvedFields`, so a classified **trait** field is in scope.
  These are **validation errors, not boot refusals** — the opposite of ADR-0340's ABAC check and for
  a stated reason: an obligation's dischargeability is a property of the *deployment*, while all
  three of these are properties of the manifest alone, so they are decidable by a pack author, by
  `crossengin validate`, by the pack's own test suite and by the reviewer approving what the
  Architect designed. A rule that can be checked earlier should be — and activation validates, so a
  per-tenant manifest is covered with no second check to forget.
  **And `validateWorkflows` checks that an `entityLifecycle`'s `stateField` is a field of its
  entity** (ADR-0359), where its whole declaration had been `z.string().min(1)` and the only test
  on a lifecycle was that its *entity* resolves. One live member, and the damage was not in the
  workflow: `withLifecycleStateFilter` adds the state field to `filterableFields` unconditionally,
  so a name no entity has became a filterable column the two stores answer **oppositely** —
  `pg-columns` has no column and dropped the predicate (every row), the document store compared
  `document ->> 'state'` against NULL (no rows). Measured on resolved `erp-construction`, whose
  `WorkOrder` replaces core's with one whose column is `status` while core's inherited
  `work_order_lifecycle` still named `state`. Checked against `fieldsByEntity`, which is
  `resolvedFields` + `id`, so a state field contributed by a **trait** is accepted — the served
  table really does have a column for it — and the entity check fires first, so an operator is told
  the entity does not exist rather than being told its state field is missing, which would be true
  and useless. Eight in-repo fixtures declared a phantom `stateField` and were corrected; the pack
  now declares its own lifecycle over `status` with its own transition grants, which `overrides:
  true` always implied.
  **And a `unique: {scope: [...]}` must name fields the entity resolves to** (ADR-0360), with a
  scope naming the field itself refused too and `unique: true` printed as the remedy — it degenerates
  to the unscoped form, so it is not wrong so much as a declaration that does not say what its author
  thinks. Over `resolvedFields` and not `entity.fields`, because the unique field *and* the field its
  scope names can both arrive from a trait, with a negative control pinning a trait-contributed
  declaration (which `entity.fields` would miss entirely). A validation error on the same split as
  the three above, and vacuous today — 0 of the 47 source declarations use the scoped form, which is
  precisely why it costs nothing to refuse the incoherent case now.
  **And `validateClassifications` resolves traits, where the whole invariant was bypassable by moving
  the declaration one level out** (ADR-0361): the identical `phi` field was *refused* on
  `entity.fields` and *accepted* on a trait, with the served table carrying the same column either
  way. A validation rule whose predicate is narrower than the artifact it constrains is a spelling
  convention, not a rule. Two loops rather than one over the resolved set, because the path and the
  remedy differ by where the declaration is: an own field indexes `fields[j]` and its remedy is
  local, while a trait's field has no index in this entity at all, so the path names the trait and
  the message carries the warning the own-field case does not need — a trait is shared, so dropping
  the classification there changes every entity carrying it, and adding `auditable` to *this* entity
  is the change whose blast radius is one entity.
  **And `validateReports`/`validateDashboards` check their grants' role names** (ADR-0361), which
  nothing did: a report's and a dashboard's `permissions` is an `RbacGrant` whose roles were validated
  by no one, so a manifest granting a report to `ghost_report_role` passed — while a *view's* were
  checked, which made "a declaration is validated" true of one surface and false of two that look
  identical from the manifest. `validateReports`' former `reportIds.has(key)` duplicate check is
  **deleted** rather than kept: `reports` is a `z.record`, so `Object.entries` cannot yield one key
  twice and the condition was unreachable — a check that cannot fire reads as coverage it does not
  provide, which is the same vacuity this file already records for `validateFiles`. Validation errors
  on ADR-0348's split, and vacuous today (0 reports and 0 dashboards in any pack), which is exactly
  when they cost nothing.
  `resolvedClassifiedFields(entity, customTraits)` joins `resolvedFields` and `resolvedFieldNames` in
  `ddl/resolution.ts` as **the one answer to "which of this entity's fields are classified, as the
  served table has them"** (ADR-0361) — the reason `resolvedFields` is the one answer to "which fields
  become columns?". Five call sites were spelling it by hand as
  `entityClassifiedFields({...entity, fields: [...resolved]})`, a fabricated entity whose only purpose
  was to widen the aperture of a function that should never have narrowed it, while three read
  `entity.fields` directly — and the three were invisible precisely *because* the helper took an
  entity: the narrow answer needed no workaround and the wide one did.
- **`kernel-pg`** — the impure applier. `PgConnection` + `parsePgEnvConfig` + node-postgres
  binding, advisory-lock-gated per-statement migration application with `_meta_migrations`
  hash bookkeeping, preconditions, and the pgcrypto at-rest encryption stack (coverage report,
  encrypt-on-write column migration, encrypting-view triggers, key rotation planner). Ships the
  `crossengin-pg` CLI.
  **`DEFAULT_COLUMN_KEY_REF` is the one spelling of the key reference** (ADR-0338), beside
  `COLUMN_ENCRYPTION_KEY_GUC`; there were three independent copies and none was exported.
  `columnKeyRefFor` validates the GUC name, which is where that validation belongs because
  `pgpSymEncryptExpr`/`DecryptExpr` interpolate their `keyRef` **raw** — zero escaping, by design —
  and `isRaisingKeyRef` answers whether a reference can be shown to raise, false for the
  two-argument `current_setting` form *and* for a bind placeholder. `EncryptionMigrator` gained the
  `sessionSettings` option its sibling `KeyRotationMigrator` already had, applied **inside** each
  per-column transaction because `set_config(…, true)` is transaction-local: without it
  `crossengin-pg encrypt --apply` could never have worked under the default key ref, which is the
  same defect as the serving store's in the sibling class. `--apply` now **refuses** before opening a
  connection — `key_value_absent` when `COLUMN_ENCRYPTION_KEY` is unset, `key_ref_can_yield_null` for
  a caller-supplied two-argument ref — and exits 2 having run nothing, because a halt partway through
  a column conversion leaves a mixed schema. The key value is read from the environment, never argv
  (ADR-0301). `--plan` warns instead of refusing: a plan is SQL an operator pastes, and printing it
  is how they discover what to arrange.
  **Migration is reconciliation, not replay** (ADR-0290): `introspectSchema` reads `pg_catalog`,
  `diffSchema` compares it to `META_TABLES`, and `planSchemaReconciliation` turns the difference
  into statements. `apply` runs the plan, so an empty database gets the full bootstrap (the plan
  *is* `emitBootstrapSql` there, pinned by a test) and a migrated one gets only its deltas. Both
  `crossengin apply` and `crossengin-pg apply` take this path and both accept `--plan` to print it
  without executing. The plan holds one invariant — **every step in it is expected to succeed** —
  and there is **one unguarded exception nobody has named**: `create_index` is pushed with
  `guarded: false`, while the sibling `add_unique_constraint` beside it is `guarded: true` and every
  other data-dependent class (a type change, a `NOT NULL` tightening, a populated-table constraint)
  is reported as `unreconciled` with the SQL handed over. So **any** declared unique index added to
  `META_TABLES` later carries a latent `23505` against that invariant. There are already 6
  `unique: true` indexes in the catalog, 3 of them partial, and all of them only ever landed on
  fresh databases where the question could not arise — which is why it has never been seen, and is
  the same shape as ADR-0360's reason the entity-store unique indexes run last, each in its own try.
  Otherwise,
  anything whose outcome depends on existing data is reported as `unreconciled` with the SQL instead:
  a type change or a `NOT NULL` tightening on a populated table, a `NOT NULL` column with no default
  that has nothing to fill existing rows with, an undeclared index or policy, and anything that would
  drop or loosen. Refusals propagate — an index or constraint covering a column the plan is not
  adding is refused too (ADR-0291). What *is* planned: every addition, a default change, relaxing
  `NOT NULL`, and a column type change **on an empty table**, guarded by a `DO` block that re-checks
  emptiness in its own transaction.
  **Foreign keys are reconciled** (ADR-0291), matched by column since the emitter writes them inline
  and unnamed: a declared one missing is added, a changed target or `ON DELETE` is replaced, an
  undeclared one is reported — unless it blocks a type change, where dropping it is a visible step.
  **A column-level `check` expression is compared too** (ADR-0330), which closes the hole ADR-0329
  had to work around: `declaredCheckConstraints` read only `table.constraints`, so a changed inline
  CHECK was neither planned nor reported across **765** of them. The obstacle was never the
  comparison but the *matching*, because Postgres names a column check `<table>_<column>_check` when
  the expression references exactly one column and `<table>_check` when it references none or
  several. **`pg_constraint.conkey` on the probe's own row is that `Var` set**, computed by the same
  parser that computed the live one — so the name is *asked for* rather than inferred, for the price
  of one extra column in a query that already runs, and ADR-0292's refusal to write a SQL parser
  stands. Matching goes by rendering first (so a *changed* expression is one finding rather than
  missing-plus-undeclared, which an operator would act on differently), by derived name second, and
  by naming family third when exactly one candidate fits. Planned as a guarded
  `replace_column_check` — safe because **neither identifier in the statement is inferred** — and
  **on a populated table too since ADR-0363**, once the probe's `proveWideningSafe` verdict says no
  existing row violates the declaration. A name the plan would have to *predict*,
  `ChooseConstraintName`'s numeric suffix inside a shared family, is never written and reads
  `column_check_name_unavailable` **however the proof came back**, since that reason is about the
  identifier and not the rows. Costs one probe per declared column check (**781** as of ADR-0371,
  ~850 ms, flat in row count) plus, since ADR-0363, one catalog read and one violation count per
  *declared-CHECK difference* — a converged database has none and pays nothing.
  **The plan asks Postgres whether the declaration widens, and the rows only for the diagnosis**
  (ADR-0363). `ReconciliationProbe` is four required fields — `rowCounts`, `wideningProofs`,
  `wideningImplications`, `confinedTables` — and `decideCheckPlan` has **two independent sufficient
  gates**: `live_implies_declared` from `proveDeclarationWidens` (structural, no row consulted, so
  it survives a confined session and admits no race), and *the table is empty*, which is ADR-0299's
  rule kept for its own reason — a new rule on no data is a decision about future writes alone, and
  there is no existing data whose reinterpretation a human needs to approve — guarded on
  `confinedTables`. Everything else is reported, over **three** reasons.
  `constraint_violated_by_existing_rows` is conclusive, on the axis **answered versus unanswered**
  and deliberately *not* ADR-0322's conclusive-versus-inferred (a count came back, rather than an
  absence read as evidence). `constraint_widening_unproven` is the correction's reason — the rows
  satisfy it and nothing proved it a widening — and it names **the prover's answer and never a fact
  about the expressions**, because `not_implied` covers both *it really narrows* and *the
  implication holds and the planner cannot see it*, the latter true of all 213 pattern CHECKs. Its
  remedy is the `DROP`/`ADD` pair and that is the point: the SQL **will succeed**, which is exactly
  why a plan must not run it unasked. The conclusive arm hands over
  `manualCheckViolatorsSql`, the violator `SELECT` **live and alone**, because there the `ADD` is
  proved to fail while the `DROP` before it would succeed; the inconclusive arm still gets the
  `DROP`/`ADD` pair, now wrapped in `BEGIN;`/`COMMIT;` — which is a **data-integrity fix**, not
  tidying: verified by paste, the old unwrapped pair left `meta.comms` with zero CHECK constraints
  and then accepted anything. `probeForReconciliation` asks the confinement **before** counting and
  records the table in `confinedTables` rather than a figure it cannot stand behind (ADR-0331's
  claim-versus-nobody-looked, inside a probe), and `rowsPhrase` renders all three states so a
  missing count says which.
  **Index and policy definitions are compared too** (ADR-0292) — columns, order, uniqueness and
  access method structurally; predicates and policy clauses by **asking Postgres to deparse the
  declared text** (`expression-render.ts` attaches it as a `CHECK … NOT VALID` constraint inside a
  savepoint, reads `pg_get_constraintdef`, and rolls it away). That sidesteps writing a SQL parser:
  Postgres rewrites structure, not just spelling, so `status IN ('a','b')` comes back as
  `(status = ANY (ARRAY['a'::text, 'b'::text]))`. `NOT VALID` keeps it free — ~112 probes cost 337 ms
  against a 20k-row table. A changed definition is replaced in **one** statement
  (`DROP …; CREATE …;`), so no query runs without the index and no table sits with RLS on and no
  policy; a constraint-backed index routes through its constraint, since `DROP INDEX` on one is
  refused. Omit the renderings and expressions are simply **not compared** — unknown must not read as
  drift.
  **The applier continues past a failed statement** (ADR-0295) and reports every outcome with an index,
  rather than halting at the first; a failure is still logged `succeeded = false` so it re-runs next
  time, and `stopOnFailure` remains for a caller whose statements build on each other. **A policy's
  `command` and `roles` are declared and compared too** (ADR-0298), optional with the Postgres defaults
  as the meaning of absent, so the existing 107 policies emit byte-identically; `polcmd`/`polroles`
  canonicalise in `canonical.ts`, role lists compare as sets, and an unresolvable role reads as
  undetermined rather than as drift.
  `canonical.ts` is what makes the diff trustworthy: it rewrites a declared type into
  `format_type`'s spelling, strips the casts Postgres adds to a default, and treats an omitted
  `ON DELETE` as the RESTRICT the emitter writes — because comparing the raw text called 138 of 139
  tables drifted on a schema that was exactly correct.
  **`check-admission.ts` asks whether a live database admits the values the catalog declares**
  (ADR-0352), over every catalogued CHECK rather than the one column ADR-0351 probed. It **evaluates
  the live predicate** — `coalesce((<pg_get_expr>), true)` against candidates bound into a `VALUES`
  list aliased to the column name — and never reads the deparsed text, because one declaration has
  two renderings and a regex over them was already too narrow once. `CHECK_SHAPE_COVERAGE` is a total
  map over five shapes whose content is the **complete / probe / none** distinction: a value set's
  declared list is the whole domain so a pass is a *proof*, while a range's declared boundary is one
  candidate so a refusal is conclusive and a pass is not. `admissionCastType` casts to the
  **declared** type through an allow-list — a modifier-bearing cast truncates (`varchar(8)` answers
  `admits` for a value the `INSERT` refuses `22001`) and dropping one is only safe where the
  unmodified form constrains nothing, which `character(3)` → `character` is not. Evaluations run
  inside `SET TRANSACTION READ ONLY` with a savepoint each, because a CHECK can call a volatile
  function and evaluating it fires the side effect, while a type-drifted column raises `42883` and
  must read `unevaluated` rather than abort the batch. It issues **no new catalog SQL**: it imports
  `CHECK_CONSTRAINT_QUERY` and `COLUMN_QUERY`, so the survey and the drift check cannot disagree
  about what the database holds. It **reports and never refuses** — a surface names its own column
  through `admissionBlocks`, which is the derived condition a list of fatal columns would be. 777
  checks surveyed in **269 ms**, verified live as a non-owner.
  `proveWideningSafe` is the separate half, and separate because it reads tenant data where the survey
  reads only the catalog: it answers ADR-0330's open end by counting the rows that violate the
  declared expression, and **refuses the claim on a confined session** rather than reading 0 as safe —
  measured, the owner counts 1 and a non-owner 0 while the `ALTER` genuinely raises. It has a caller
  since ADR-0363 (`planSchemaReconciliation`, through `proveWidenings`) and is the **diagnostic**
  there rather than the gate — what it proves is *no current row violates this*, which is strictly
  weaker than *this is a widening*, and gating on it planned narrowings. **`proveDeclarationWidens`
  is the gate**: `SET LOCAL constraint_exclusion = on` plus
  `EXPLAIN (FORMAT JSON, COSTS OFF) SELECT 1 FROM t WHERE NOT (<declared>)`, proved iff the plan is
  `Result / One-Time Filter: false` — `predicate_implied_by`, the planner's own prover, which reads
  neither expression and consults no row. It answers over **three** values
  (`live_implies_declared` / `not_implied` / `unknown_unreadable`), reads the row's **first value by
  position** because `EXPLAIN`'s header is `QUERY PLAN` and cannot be aliased, and treats every
  unrecognised plan shape as *not proved* — its "no" costs a planned step and its "yes" allows one.
  Both lost `proveWideningSafe`'s `column` parameter in the same increment: it took one and read it
  nowhere, and a parameter named `column` invites a caller to believe the verdict is about that
  column, which for a table-level CHECK spanning three of them it is not — the verdict is about the
  **expression**. Cheap for a reason that will not come again: callerless from ADR-0352 until then,
  so no signature depended on it. The survey and the plan are **two questions and not two answers
  to one** — the plan asks whether *this binary's declaration* can be applied, the survey whether
  the *live* constraint admits what this binary emits — so they agree on a converged deployment and
  diverge on exactly the one that has drifted.
  **`sessionWouldBeConfined` asks Postgres for the verdict and the catalog for the explanation**
  (ADR-0362). It returns `row_security_active(c.oid)` — the SQL face of `check_enable_rls`, the
  function the executor itself consults — so it is not a better approximation of the rule, it *is*
  the rule, and ADR-0330's *ask Postgres rather than imitate its parser* applies to a predicate
  exactly as it does to an expression. It used to compose four catalog facts, measured at **6 of 8**
  against live ground truth: both misses are a `SUPERUSER` holding `NOBYPASSRLS`, which
  `check_enable_rls` exempts and no fact read here can see — a repo-wide grep for `rolsuper` /
  `usesuper` / `is_superuser` returns **zero**. The misses are conservative and the bootstrap
  `postgres` role carries `rolbypassrls`, so it was never in the divergent set: what the switch buys
  is an **unwritable** composition rather than a corrected one, and three sites now agree on what
  decides rather than two agreeing and one differing. The four facts stay and are still read,
  because a refusal has to say *why* — "you do not own the table" and "you own it and FORCE confines
  the owner too" send an operator to opposite remedies — and `sessionPolicyVisibilityReason`
  composes that sentence, with `role_is_exempt` as the **honest arm**: Postgres says this session is
  free and no fact here says why, where claiming `owner_exempt` would be actionable and false.
  `parseSessionPolicyVisibility` is **strict on the verdict and permissive on the four facts**, and
  the asymmetry is load-bearing rather than tidy: an unreadable explanation costs a sentence, an
  unreadable verdict reads as *not confined* and silently stops a fence refusing. That was found by
  review **after** the first commit shipped, because the test defending the permissive default
  claimed *"every caller checks `rlsEnabled` first"* and only **one of three** does —
  `check-admission.ts` and `encryption-writepath.ts` both parse and branch with nothing between, and
  the second is `KeyRotationMigrator.probeTable`, whose refusal runs immediately before a key
  generation is destroyed. Only the *rule* is shared; each call site keeps its own query, since
  `commonRefusals` wants `has_scope_column` in the same round trip — but it **interpolates**
  `SESSION_POLICY_VISIBILITY_COLUMNS` now rather than restating the five columns, which is the case
  that constant's doc comment names and had zero consumers of, and is how the sixth column reached
  that probe without the file being edited.
  **`PGSSLMODE` says what the channel actually promises, and `verify-ca` is refused** (ADR-0357).
  That wire carries `app.current_tenant_id` on every query — it **is** the tenant-isolation
  boundary — and on the column store `app.column_encryption_key` on every PHI write, while the
  default is `prefer`, which lets the *server* decide whether there is any TLS at all.
  `PG_CHANNEL_ASSURANCES` is **three** facts over the six modes rather than a boolean, because *not
  validated* collapses two different remedies: `plaintext_possible` (`disable`/`allow`/`prefer`,
  which share one answer and differ only in *who declines*) has to arrange TLS, while
  `encrypted_unauthenticated` (`require`) already has it and needs the trust decision.
  `sslModeValidatesCertificate` is **composed from two total maps** and not written as a second
  per-mode one, because the predicate gates a refusal while the assurance gates what an operator is
  told, so a mode reported `authenticated` while the predicate answered `false` would refuse a
  working deployment with a message contradicting its own boot line — and `node-pg.ts` now *calls*
  it where it compared `config.ssl === "verify-full"` inline, with a test reading that file as text
  to pin both the call and the absence of the literal. **That test then found a third judgement in
  the same ternary**, which is this increment's own class landing on its own fix: the outer arm
  still listed `require || verify-ca || verify-full` to decide *which modes get a TLS object at
  all*, a different question from *is the peer checked* (`require` answers yes and no) and exactly
  the complement of `plaintext_possible` — so `sslModeRequiresTls` is the second predicate and the
  ternary names no mode but `disable`. Had the test only pinned the call, that list would have
  stayed. `verify-ca` **stays in the union** and is
  refused at parse: both maps have to answer for it, since *this binding cannot honour this mode* is
  a fact about the mode rather than an absence of one, and deleting the name would leave the refusal
  with nothing to name. Refused rather than warned, which is ADR-0340's shape and not ADR-0338's —
  an operator who set it has *made* the trust decision and would otherwise hold `require`'s
  guarantees under `verify-full`'s name, nothing can repair it by configuration, and the measured
  count of `verify-ca` anywhere in the repo is **zero**. The one remaining mode comparison is
  `disable`, which the assurance deliberately cannot answer.
  Append to the `kernel-pg` entry:

  **`read-rows.ts` is what a multi-row read does with a row its contract refuses** (ADR-0373), and it
  is here rather than copied per store for `scopeFilter`'s reason (ADR-0334). Two shapes and the
  store's own contract picks: `readRows(rows, map, identify, onUnreadable)` **forwards** the fact,
  which is right where the consumer is a scheduler or a route; `readRowsWithUnreadable(rows, map,
  identify)` returns the refused rows **beside** the records, which is right where the consumer is a
  **verifier**, because there the unreadable row is part of the answer rather than a note on the side.
  `identify` is separate from `map` because it reads the business key straight off the **raw** row, so
  it still answers for the row the mapper refused — and it runs **inside the catch**, so a throw from
  it costs only its own row's identity (`null`) and not the rows after it. `unreadableDetail` answers
  the **field path and the issue code**, sorted and de-duplicated: a `ZodError`'s own `message` is the
  JSON of its issues and an `invalid_enum_value` issue carries `received`, which is the stored value,
  so ADR-0372's `detail = err.message` is a disclosure into a log line, an HTTP body and an incident
  note — ADR-0367's rule in a new place, and a correction to the ADR this generalises. The sorting is
  not tidiness: a detail that varies with the order zod walked the object cannot be compared across two
  sweeps. `numericIdentity` is separate from `textIdentity` because a `BIGINT` arrives from
  node-postgres as a **string** and an `INTEGER` as a **number** (ADR-0331), so one `typeof` predicate
  would answer for one and not the other. Its reach is bounded and the bound is stated: the no-value
  property is **enforced** for a `ZodError` and **assumed** for a mapper's own guard, whose message
  passes through — a convention of exactly the kind ADR-0367 found failing in four of six refusal
  strings, and the only honest fence is a text test over the construction sites.
- **`types`** — deliberately tiny: branded primitive id types (`TenantId`, `UserId`,
  `RequestId`, `ManifestId`) plus the `meta-schema` record shapes.
  **`classifiedFields(fields)` takes a field list and not an `Entity`** (ADR-0361), and the signature
  is the whole fence. It was `entityClassifiedFields(entity)` reading `entity.fields`, which is not
  the set the served table has — a trait contributes more — so the narrow answer was the only one
  reachable without fabricating an entity. Three of its eight readers took it and two of those failed
  **open**. A field list cannot be called wrongly: the caller must say which fields it means, and
  `resolvedClassifiedFields` in `@crossengin/kernel/ddl` is the one answer for "as the served table
  has them".
- **`config`** — shared TypeScript / ESLint / Prettier config bases. No `src/`.
- **`testing`** — the shared `vitestPreset`, the eleven workspace rules under `strategy/`, and
  `pg-bind-arity.ts`. That last one is deliberately **not** under `strategy/`: those rules read the
  workspace from disk and answer one question per run, while `assertBindArity(sql, params)` is a
  per-statement predicate a fake calls on the statement in front of it, and it needs the runtime
  parameter array no static scan can have (ADR-0370). It answers the one thing a fake
  `PgConnection` cannot learn by interpreting SQL — whether the statement references exactly
  `{1..params.length}` — and it is the floor for all nine shared `test-fakes.ts` modules that fake
  a connection.

### Serving a manifest (the Operate stack)

- **`operate-runtime`** — the largest package and the heart of the product: it compiles a
  resolved manifest into a live multi-tenant API. Route/operation derivation and slugs,
  an `EntityStore` interface with typed list filters + keyset pagination + projection,
  RBAC-enforcing CRUD/lifecycle handlers — which **refuse a list surface they cannot serve** since
  ADR-0359, where `parseListQuery`'s own comment claimed the opposite (*"Unknown / non-filterable
  params are ignored, so an arbitrary query can't widen the result set"* — true of the surface,
  backwards about the answer, since ignoring `?tax_id=X` returns the rows the caller asked to
  exclude). `parseListQuery` returns a `ParsedListQuery {query, unserved}` and the handler answers
  **400** on the first entry; `ListConfig.fields` (required) is what makes that shippable, for
  exactly one question — `?utm_source=ad` names nothing and is an ordinary unknown parameter, while
  `?tax_id=X` on an entity that *has* `tax_id` is a caller asking for something this deployment
  declined to serve. There are two reasons and deliberately **no `not_sortable`**: an unhonoured
  sort returns the right rows in the wrong order, and 243 of 375 pack entities declare no sortable
  field at all, so refusing would 400 two thirds of every pack's collections over an answer that
  was never wrong. The store's half arrives as `ListSurfaceUnserveable` — declared in `store.ts`
  beside `EntityStore` because the handler that turns it into a 400 cannot import
  `operate-runtime-pg` — caught in the list arm and answered with its own sentence, since a caller
  told "not filterable" would ask for the column to be exposed and on that path it already is.
  **`listConfigForEntity`'s three field-derived outputs read one private `resolvedFieldsOf`** since
  ADR-0361, where `entityFieldNames` resolved traits and `textFieldsOf`/`referenceFieldsOf` read
  `ent.fields` through a module-local `EntityLike` — two readings of one entity's field list inside
  one function. `ListConfig.fields` therefore held a trait field that `searchableFields` and
  `filterableFields` could not, and since ADR-0359 `fields` is what decides whether an unknown query
  parameter is ignored or refused, so the split had become authorization-adjacent: a trait-contributed
  field was *declared* and *unserveable* at once. `EntityLike` is **deleted** — a structural
  `{name, fields?}` omitting `traits` is what made the narrow read the only read this module had.
  Behaviour-identical on every shipped pack, measured: not one of the eight built-in trait fields is a
  `SEARCHABLE_KINDS` member or a `reference` (they are `datetime`, `uuid`, `integer` and `boolean`),
  and the only trait any pack declares is `auditable`. When a custom trait does reach it a
  trait-contributed text field becomes searchable, which on the column store means `?q` can collapse
  the whole OR group and `UNSERVEABLE_SURFACE_REFUSES.search` refuses the request rather than widening
  it — a consequence a pinned test in `list-surface-survey.test.ts` named by failing when the
  convergence landed.
  `writeTxn` no longer puts `e.message` in its 500 body — which **filter rows** since ADR-0345, when a
  record-bearing obligation sits on an entity's `list` grant: the arm asks `rbacCheckForRecords`
  once for the page it loaded and drops the refused rows, passing the store's `nextCursor` through
  **untouched**, so a page may be short or empty with a non-null cursor and termination is
  `nextCursor === null` and nothing else. Deliberately not through ADR-0342's `resolveObligation`,
  which turns a refusal into a 403 — right for an act about one named record, wrong here, because
  the point of the position is that a denial is not an error. **The cursor is sealed at that boundary since ADR-0346** when
  `HandlerContext.cursorSealer` is present — opened on the way in, sealed on the way out, so the
  token a client holds is opaque to the client and still the plaintext keyset to every store, which
  is why the stores needed no edit. One `sealing` object holds the sealer and the context, because an
  open that succeeded against one context and a seal issued under another would hand back a cursor
  the caller's very next request cannot use: a walk that dies on page two. The context is
  `[tenantId, entity, sort]` with the **effective** sort, so a cursor is confined to the ordering its
  keyset is aligned to whether or not the caller spelled it out; `cursor_not_for_this_request` is the
  400. Absent, the arm takes exactly the path it took before. `withheldAddressing` runs **before**
  the store call and 400s a `?sort` / `?filter` / `?q` naming a classified field while rows are
  being withheld, one code per surface; its withheld set is the entity's classified fields rather
  than this caller's redaction set (computed at the gateway, after the handler returns), so it is
  wider than necessary and wrong only in the refusing direction. The association **list** filters
  the same way and needs no guard — its cursor is an offset into the owner's links and the route has
  no query surfaces — while the association **count** refuses, with no logic change, carrying its
  own reason because the availability prose now says the list position has every row in hand, which
  is true of the route it counts for and not of itself. Also association (m2m) routes, numbering sequences,
  tenant settings, a `UiSchema` builder that drives the web client, plus write **guards**
  (period locks, posted-entry immutability) and write **effects** — the double-entry
  accounting core: GL postings for invoices/bills/payments/credit notes, tax breakdown,
  FX revaluation and booking-rate stamping, WHT certificate clearing, payment application,
  journal reversal. Also entitlements, signed offline licences, plan catalog, AR/AP aging
  and WHT reconciliation reports.
  **`list-drain.ts` is where a figure stops being computed from one page** (ADR-0367).
  `drainList(store, tenantId, entity, query, {ceiling, pageSize?}, onPage)` loops on
  `nextCursor !== null` and returns `{complete, records, pages, haltedBy?}`; `onPage` rather than a
  returned array, because the caller decides what it holds — the balance guard folds two running
  sums over an entry of any size, the reports fold payments into a per-document map, and only the
  two mirror-the-rows effects need the rows. **No early stop, and that is a correctness rule rather
  than simplicity**: a caller summing toward a threshold cannot halt when it crosses one, because a
  later page may carry a negative term that takes it back under, which is the measured
  `paymentApplicationEffect` defect. Termination is the cursor and never the row count — the three
  stores all read `limit + 1`, so a short page does imply a null cursor, but that is an
  implementation detail of three expressions rather than the contract. `DrainDidNotTerminate` covers
  the two *store faults* (`cursor_did_not_advance`, `page_budget_exhausted`), which a row ceiling
  alone cannot bound because an empty page with a non-null cursor is legal; the `+ 9` page slack is
  for short and empty pages and is deliberately **not** what distinguishes an exactly-full set from
  a truncated one (an earlier comment claimed that and the measurement refuted it — `records >=
  ceiling` is tested before the budget, and the two cases differ in the *cursor* of the page that
  exhausts the ceiling). `READ_CEILING_EFFECT` is a total map over `{guard, effect, report}` →
  `{refuses, aborts, declares}`, and `BoundedReadDeclaration {complete, bounded}` lives beside
  `DrainOutcome` because that is the type which *produces* the fact — both report bodies extend it
  rather than restating it, so `complete` is a compiler obligation on every answer.
  **Recognition and settlement have one spelling each since ADR-0366**, and the two that went were
  not inert. `billGlPostingEffect` posted a Bill's gross total as `expense` and so **booked input tax
  into the expense account** — measured `expense D120` against the live
  `recognitionGlPostingEffect`'s AP C120 / expense D100 / tax_input D20 — and could not be wired
  beside it anyway, since both emit `${bill_number}-GL` into a column ADR-0360 made a real unique
  index. `paymentGlPostingEffect` was the generic that `recognitionGlPostingEffect` and
  `paymentSettlementGlPostingEffect` replaced on two different axes (the tax split, and the trigger
  moving from the document edge to the `Payment` record, which is what buys partial settlement and
  realized FX). ADR-0124 retained it by name *"for reuse"*, and that retention is **withdrawn**: the
  route is one line (`additionalWriteEffects` appends where `writeEffects` replaces), and on any
  manifest declaring a `Payment` entity — all seven packs — taking it posts the document total on top
  of what a Payment already settled, measured **AR net −50**, silently, because the entry numbers
  differ so no constraint fires. What the deletion *reveals* is live and is register item 6b: nothing
  posts on a document's own `→paid` edge, which three declared transitions reach with no `Payment`
  row.
  **`writeTxn` takes the caller's own keys and answers 409 on a `UniqueViolation` only for a field
  they named** (ADR-0360) — the one exception to that catch's *"the body names nothing"* rule, and
  scoped by its own reason rather than by the field. Everything else reaching it is a condition the
  caller cannot act on, which is why the body is a fixed sentence; a unique violation is the one
  write failure the caller is the **only** party who can fix, and the field name is not a disclosure
  because they supplied it. So where they did *not* supply it the justification evaporates:
  **14 of the 45** declared unique fields carry a `sequence` default, and a `23505` on one the caller
  omitted is the allocator having handed out a number it already handed out — an internal fault, for
  which *"send a different value"* is an instruction they cannot follow. Those take the fixed 500.
  The keys come from `parsedBody`, which the create handler already reads for the write mask on the
  same stated ground (*"a sequence / literal / settings default and the `created_at`/`updated_at`
  stamp are the server writing a field, not the caller writing it"*) — one rule, read twice, where a
  second spelling is what would eventually disagree. `NO_CALLER_SUPPLIED_FIELD` is the named empty
  list a delete and a transition pass: a delete carries no body and a transition's patch is the state
  the *manifest's* workflow names plus a timestamp, and the empty set is the **claim** there, which
  ADR-0331's rule keeps distinct from *nobody gathered them* — here the difference decides a 409
  against a 500. **409 and not 422**, because the value is well-formed and would have been valid a
  moment earlier or in another tenant: a conflict with current state, the distinction
  `conflict_idempotency_mismatch` draws. The parameter is **required** on all four call sites, since
  neither default is correct — `[]` loses every diagnosis and "all fields" gives the wrong
  instruction.
- **`operate-runtime-pg`** — Postgres `EntityStore` implementations plus the serving-side
  stores. **`ListSqlAdapter.columnExpr` answers a `ColumnExpr` and no longer `string | null`**
  (ADR-0359), because `null` meant *encrypted at rest*, *not a column* and *unsafe field name* and
  all three were handled identically: `buildListSql` dropped the predicate and the `WHERE` became
  `tenant_id = $1` alone. `buildListSql` returns `unserveable` beside the SQL and the two stores
  refuse before issuing the statement, through one total map —
  `UNSERVEABLE_SURFACE_REFUSES` (`filter: true`, `search: true`, `sort: false`) — whose content is
  the increment's whole rule: *a surface whose drop changes WHICH rows come back is refused; one
  whose drop changes only their ORDER is reported*. `search` is `true` and is not an exception,
  because a surface is recorded only when the OR group collapsed **entirely** (which matches every
  row); a *partial* collapse narrows and is named per pair by the boot survey instead. `id`
  resolves explicitly on the column store, where it had resolved to nothing and been dropped — so
  `?sort=id` produced the right order for the wrong reason (the id tiebreaker is appended to every
  ORDER BY) and `?id=<value>` was a filter that matched every row. And `seekPredicate` indexes
  `cursor.k` by the **declared** sort position, where it filtered the sort list and then indexed
  the filtered one — so with `?sort=mrn,family_name` on the column store it compared the cursor's
  `mrn` value against `family_name`. Two store flavours behind one contract: `PostgresEntityStore` (tenant-scoped
  JSONB document table) and `ColumnMappedEntityStore` (real per-entity typed tables with
  DDL derived from the manifest — topological create order, composite tenant-scoped FKs
  with per-relation `ON DELETE`, m2m join tables, pgcrypto-encrypted PHI columns, SQL-level
  filter/sort/keyset/projection pushdown). Its column plan comes from the kernel's
  `resolvedFields`, the same function `validateManifest` uses, so **trait fields are real
  columns** and validation cannot accept a field the served table lacks; `ensureSchema`
  migrates additively (`ADD COLUMN IF NOT EXISTS`), so a manifest that gains a field no
  longer bricks the boot. Plus sequence allocator, settings, entitlement, subscription
  stores, Stripe webhook ingest and dangling-link pruning.
  **And that manifest's `meta.extends` lineage is resolved** (ADR-0368), which until then it was not:
  `resolveManifest` had one non-test caller, `loadBuiltinPack`, so the inheritance mechanism ran over
  the built-in packs whose lineage is fixed at build time and was withheld from the only input whose
  lineage is a runtime question — and an activated design therefore **replaced** the deployment's
  pack. `tenant-manifest-lineage.ts` holds the policy (`TENANT_PARENT_POLICY`: a tenant may extend
  only the manifest this deployment itself serves) and `buildTenantManifestLineage` returns the
  registry and the permitted slug **as one object**, derived from one argument, so a registry whose
  permitted slug says something else cannot be formed. `TenantGatewayCache` takes it as a **required**
  option and resolves **between `safeParse` and `tryValidateManifest`** — measured, not reasoned: a
  child referencing an inherited `Account` is *refused* by validation unresolved and *ok* resolved,
  giving the 52-entity / 16-role union in **one** `getManifest` call, so resolution after validation
  would have been inert. One entry is sufficient *and complete* because `stripExtendsFromMeta` leaves
  a resolved manifest carrying no `extends`. Three new `GATEWAY_BUILD_REFUSAL_KINDS`
  (`lineage_parent_unknown`, `lineage_cycle`, `lineage_override_undeclared`), all **permanent**,
  classified through the existing `REFUSAL_BY_ERROR_NAME` by `Error.name`; a resolution failure is a
  **`refused`** and not the `{kind:"none"}` fallback, because `none` serves the deployment's gateway
  and a tenant whose activation did nothing would never be told. `REFUSAL_NAMES_PERMITTED_PARENT` is a
  total map rather than a `lineage_` prefix test, and `unknown` is `false` there deliberately — naming
  a permitted parent beside an unidentified cause asserts a diagnosis. Verified live as a non-owner:
  the child's own entity answers 403 and an inherited one 200 on **one** gateway, and each of the
  three refusals is a 503 whose log reads *"extends unknown parent 'operate-erp/retail' — this
  deployment permits extending only 'operate-erp/core'"*.
  **A tenant serving its own activated manifest gets its own Postgres schema** (ADR-0314), not a share of
  the boot tables — two tenants author independently, so A's `Invoice` and B's `Invoice` are different
  types with the same name, and `ADD COLUMN IF NOT EXISTS` matches on *name only*, so a shared table would
  let B read integers through A's text column while reporting success. Per-*schema* rather than a table
  prefix because the schema is the one axis `columnPlansForManifest` / `emitEntityTableDdl` /
  `ColumnMappedEntityStore` already take, so a tenant's tables come out of the same emitter with the same
  `tenant_id`, primary key, composite FKs and RLS policy. The schema is **not** the isolation boundary —
  `tenant_id` and its policy still are — it is a schema-*evolution* boundary.
  `TenantColumnStoreRegistry.ensure` is the whole lifecycle (idempotent, memoised on the manifest hash,
  an advisory xact lock per tenant so two replicas cannot race the `DROP POLICY`/`CREATE POLICY` pair, a
  refusal memoised for 60s so an operator's fix is picked up without a restart); `storeFor` is
  deliberately synchronous and does not provision; `TenantColumnStoreRouter` routes **per call** to the
  tenant's store or the JSONB fallback.
  **And encrypts a classified column with that tenant's own key** (ADR-0338). `encryptionKey:
  ColumnEncryptionKeySource` is a resolver from tenant id to key *value*, and it is the **value**
  rather than a per-tenant `keyRef` because the expression must stay one string — the trigger path
  bakes it into a plpgsql function body. One private `scoped(tenantId, fn)` backs all **11** former
  `withTenantContext` call sites and sets `app.column_encryption_key` through
  `withTenantContext`'s new settings map, with the key **bound as `$2`**, so it reaches no SQL text;
  a store with no encrypted column passes no settings and issues no extra statement, so a deployment
  with no PHI pays nothing. Constructing a store over a plan with an encrypted column and no key
  **throws `ColumnEncryptionUnavailable` naming the entities and fields** — ADR-0334's conversion of a
  page-1 500 into a boot refusal — with an exemption for a caller who passed a non-default
  `encryptionKeyRef`, since that caller has arranged the key by a route the store cannot see.
  `PlaintextFallbackRefused` closes what was a **silent downgrade from ciphertext to plaintext**: the
  router's fallback is the JSONB store, which has no encryption, so a tenant whose DDL application was
  *refused* had their PHI written in the clear while the log reported a refusal. `encryptedEntities`
  makes those entities refuse — **reads too**, because a read from the plaintext fallback cannot return
  PHI that was written encrypted, so serving it is a wrong answer and not a degraded one
  (ADR-0336's `IdempotencyStore.get` rule). The guard had to cover `withTransaction`, which hands its
  callback the *underlying* store, or every handler that writes inside a transaction — the ordinary
  write path — would route around it; the wrapper is hand-written rather than a `Proxy` so a seventh
  `EntityStore` method fails to typecheck instead of passing through unguarded. The set comes from the
  **tenant's own** manifest via `encryptedEntityNames`, never the deployment's: under per-tenant
  manifests a deployment-wide set taken from the boot pack would be correct only for tenants serving
  that pack and would leave exactly the tenant-declared classified field unguarded.
  **And names what an Article 17 deletion must empty** (ADR-0350). `bootSchemaErasurePlan(manifest,
  {schema})` returns every table `ensureSchema` creates — entity tables and m2m join tables — in the
  order they must be emptied, plus `blockingCycle` and `relaxed`. The order is over the
  **delete-blocking** graph and not the reference graph, which is the whole content of it:
  `topologicalEntityOrder` orders references (what `CREATE TABLE` needs) and tolerates a cycle by
  appending its members in *insertion order* (ADR-0285), and that has no ordering property at all —
  so reversing it is not a deletion order wherever the reference graph cycles, which is all seven
  packs. `DELETE_ORDER_WEIGHT` is a total map over `OnDelete` (so a fourth member is a compile error
  beside `onDeleteClause`'s switch): `restrict` 2, non-negotiable; `cascade` 1, honoured where the
  graph admits it because a cascaded child is destroyed by its *parent's* statement and the child's
  own `DELETE` then undercounts the figure a proof commits to; `set_null` 0, given up first since it
  destroys nothing early. A `restrict`-only cycle is named rather than thrown, because such a
  manifest *serves* fine and only its deletion cannot run. A **self**-reference is excluded on a
  measurement: on PG 16.13 with the erasure's own single-statement CTE shape, a self-referencing
  `ON DELETE RESTRICT` key does not refuse the bulk delete. `COLUMN_STORE_DEFAULT_SCHEMA` is
  exported here because a second spelling of `"public"` is that defect's own shape — `column-store.ts`
  spelled it inline twice and `apps/operate-server` held a third copy.
  **And enforces a declared `unique`** (ADR-0360), which nothing did: zero UNIQUE constraints existed
  on any of the 54 tables against **45** declarations. `emitUniqueIndexDdl` writes
  `CREATE UNIQUE INDEX IF NOT EXISTS "<table>_<col>_uniq" ON … ("tenant_id"[, …scope], "<col>")` —
  `(tenant_id, …)` and never `(col)` alone, which is the whole of why this could not be an inline
  `UNIQUE` copied from the field, since a bare one would make one tenant's `employee_number` collide
  with another's; tenant **first** because a multi-column index serves a prefix of its own columns.
  An **index**, and separate from `CREATE TABLE`, because `CREATE TABLE IF NOT EXISTS` no-ops so an
  inline constraint would be silently skipped for every table an earlier manifest created —
  `emitAddColumnDdl`'s reason one constraint over. `ColumnMapping.uniqueScope` is a **list and not a
  boolean** (`null` declares none, `[]` is tenant-wide), because `UniqueHintSchema` is
  `boolean | {scope}` and `=== true` drops the composite form silently; `columnPlanForEntity`
  resolves the scope field→column in a second pass and throws `UnresolvableUniqueScopeError` rather
  than emitting an index without the unresolved column, which would enforce a **stricter** constraint
  than the manifest declares. **These statements run last, each in its own try, and a failure is
  reported** — the only statement class here whose outcome depends on existing **data**, since a
  unique index over a populated table with duplicates raises `23505` and no `IF NOT EXISTS` helps.
  Last mechanically too: an index can be on a column `emitAddColumnDdl` has only just added.
  `rethrowUniqueViolation` translates a `23505` into `UniqueViolation` through `uniqueIndexFields`,
  derived from the same function that generated the name rather than parsed back out of it (the name
  truncates at 63 characters), and an **unattributable** one — a constraint this store never emitted
  — is re-thrown untouched, because claiming a field for a constraint we cannot attribute is a guess
  in an error message. `uniqueWithheldFor` names the encrypted case, which is withheld rather than
  emitted: `pgp_sym_encrypt` is non-deterministic, so two rows with one plaintext both insert and an
  operator reading `\d` would see a constraint that cannot do its job.
  **`applyTenantManifestSchema` emits them too, behind per-statement savepoints** (ADR-0360), which
  it did not — so a tenant serving their **own** activated manifest got every table, column, FK, join
  table and RLS policy and no unique index. A savepoint and **not** a try/catch, measured: that
  function runs the whole application in one explicit transaction, so a raise aborts it, every later
  statement answers `25P02` and the `COMMIT` returns `ROLLBACK` — the catch would report a refusal it
  had turned into the total failure that sends the tenant to the JSONB fallback, where ADR-0314 says
  their data is in a different place than they think. `ROLLBACK TO SAVEPOINT` leaves the savepoint
  established, so the loop releases as well or a tenant with many unique fields grows a
  subtransaction per index. The refusal rides on `TenantSchemaApplication.uniqueIndexRefusals`
  (**required**, `[]` is the claim) rather than on a second callback, because the result is already
  what the registry stores and forwards; `statements` stays *what ran*, so a refused statement is in
  the refusal and not in the list an operator pastes. `applied: true` **with** a non-empty refusal
  list is deliberate: the application genuinely succeeded minus one guarantee, and `applied: false`
  would send the tenant to the fallback over duplicate rows.
  **And erases it** (ADR-0316), because ADR-0314's schema was never removed and `tenant-lifecycle` then
  signed a GDPR Article 17 tombstone over data that survived. `surveyTenantSchema` measures with
  `count(*)`, not `reltuples`, since a cryptographic proof commits to the figure; `probeCascadeCollateral`
  establishes what `DROP SCHEMA … CASCADE` would destroy **outside** the schema by running it in a
  savepoint and rolling back, because inferring it from `pg_depend` was wrong twice in opposite
  directions (a constraint's `objid` is a `pg_constraint` oid, so every primary key read as external and
  nothing could be erased; and `pg_identify_object(…).schema` is NULL for a *rule*, so a view in another
  schema — the one case the check exists for — went straight through). `eraseTenantSchema` settles the
  cheap refusals before it probes, drops under the apply path's advisory lock, and **confirms absence
  before committing** — a `DROP` that reported success while the schema remained would produce a signed
  tombstone for live data.

### Request edge

- **`api-gateway`** — contracts for the 17-stage per-request pipeline (`receive` →
  `emit_audit`) with 6 stage outcomes, 8 auth schemes × 16 auth outcomes, route matching +
  version negotiation + sunset, idempotency records, content/encoding/language negotiation,
  RFC 9457 problem types, CORS and default security headers.
- **`api-gateway-runtime`** — that pipeline as real middleware. EdDSA JWT verification with
  iss/aud/exp/nbf and a JWT-vs-header tenant cross-check, opaque-token matching, body
  parsing, handler dispatch, handler 4xx/5xx → deny/error mapping, classification-driven
  response redaction (including a registry derived straight from a manifest), security
  headers, and a schema-valid `PipelineExecution` per request.
  **A thrown handler is a 500 whose body names nothing, with the message in the recorded stage
  reason** (ADR-0359), where the mapping was **inverted**: `gatewayTimeout({reason:
  err.message.slice(0, 480)})` put the detail in the client's RFC 9457 `detail` under a **504** —
  a status clients retry by convention, for faults that are permanent — while the recorded
  `StageResult.reason` was the bare constant `"handler_threw"`. The 480 is the tell:
  `StageResultSchema.reason` is `z.string().max(500)`, so the slice was sized for the one string
  that never reached the record, which is strong evidence the author meant the detail for the
  operator and wired it to the body. The honest fix **moves one string**, and that single move is
  simultaneously the disclosure fix and what makes 504 → 500 safe; `PROBLEM_TYPES` gained
  `internal_server_error`, 500 having been in `PROBLEM_STATUS_CODES` with nothing to name it.
  There is deliberately **no** permanent/transient map keyed on error classes: the gateway must not
  import the pg or crypto packages, no error class declares a disposition, and keying on `err.name`
  is ADR-0288's maintained list — wrong three times here. `gatewayTimeout` now has no non-test
  caller on the request path and stays, with a comment saying why.
  **Which fields are classified is supplied, never derived** (ADR-0361): `RedactionSpecOptions`
  carries a **required** `classifiedFieldsForEntity` resolver and `redactionSpecForEntity` reads only
  that, with the `entityClassifiedFields(entity)` import deleted — because that read *was* the defect.
  A trait-contributed classified field yielded no classification, so for an entity whose only
  classified fields come from a trait the function returned `null`, **no spec was registered at all**,
  and every response carrying that entity's records went out in the clear. `RedactionManifestInput` is
  a deliberate structural seam — a full `Manifest` is assignable to it so this package need not depend
  on `@crossengin/kernel` — and it declares `entities`, `permissions` and `roles` and **not `traits`**,
  which is the shape of the defect. Required rather than optional-with-a-fallback on ADR-0338's
  argument, which this file already followed once for `operationsForEntity`: a default that cannot
  possibly be correct fails silently in the unsafe direction, so the compiler asks instead. Adding
  kernel here was measured **acyclic** and refused anyway — it contradicts the seam's own stated
  reason and would drag kernel's `files`/`i18n`/`integrations`/`jobs`/`reporting`/`search`/`views`
  closure into the request edge. `compile.ts` supplies the **same index** the write mask holds, so the
  two halves of ADR-0329 read one object rather than two derivations of one fact.
  **Redaction covers writes since ADR-0338, and until then it did not.** The stage itself was always
  fine — it is operation-keyed off `route.operationId` and redacts any JSON response with a spec —
  but the registry was populated from `[list, read]` while the routes emit
  `list, create, read, update, delete` **plus one per workflow transition**, so a
  `PATCH {"sex":"female"}` returned `mrn`, `given_name`, `family_name` and `date_of_birth`: fields the
  same credential cannot read through `GET`. Any principal with update permission read any record's
  classified fields with a no-op write, verified live. That hand-maintained list was ADR-0288's
  `needsAuditEmitter` shape for the **fourth** time, and a static `(name: string) => string[]` helper
  could never have been right, because a transition's operationId comes from the manifest's workflow
  and the helper is not given one — the registry's spec set is derived from the routes actually
  derived now, via `entityOperationIndex` over `compileOperateServer`'s own `routeSpecs` plus the
  three association spec families. **Measured on resolved retail+core: 24 operations covered before,
  90 after** — 66 operations across 12 classified entities were serving classified fields in the
  clear, including all four `salesOrder` transitions. Its reach is wider than the encryption work
  that found it: redaction keys on *any* classification, so `erp-core`'s 21
  `pii`/`commercial_sensitive` fields are in scope too, none of them encrypted at rest.
  **The association list route was a second live member**: `GET /v1/<owner>/{id}/<related>` was in
  no entity's mapping, while `buildAssociationListHandler`'s own doc comment claims *"the gateway
  redacts per-caller at the edge, exactly like the list endpoint"*. No pack declares a
  `many_to_many`, so no pack exercised it. Attribution for those routes is by **whose records come
  back** — list and count to `relatedEntity`, link/unlink to `ownerEntity`.
  Both hand-maintained lists are **deleted** rather than corrected and `operationsForEntity` is now
  **required**: `defaultOperationsForEntity` was `[read, list, get]` with **no write ids at all**, so
  a caller omitting the override lost write redaction for every entity, and a default that cannot
  possibly be correct fails silently in the unsafe direction. `CompiledOperateServer` exposes
  `redactionOperationIds` so the mapping is checkable in **both** directions — `MapRedactionRegistry`
  answers only `specFor(id)`, and that missing direction is what let a `.get` no route emits sit in
  the list unnoticed.
  **Redaction is per record since ADR-0343**, which closed the position ADR-0342 refused at boot. The
  stage computed one field set for the whole body and `redactJsonValue` dropped those names
  *wherever* they appeared — which is why it handled a bare record and a `{data: […]}` page alike,
  and why it could not answer a per-field policy about *which* record. `ResponseRecordShape`
  (`record` / `page` / `none`) is **declared** on the spec and **required**, derived by
  `compileOperateServer` from `ACTION_RECORD_SHAPE`, a total map over `RouteAction` — never probed
  from the body, because a heuristic there decides an authorization answer and a record carrying its
  own `data` array would be read as a page. `SHAPE_REDACTORS` is a total map so a fourth shape is a
  compile error rather than inheriting `none`, the permissive branch. The **two passes are keyed on
  the deferral**: compute once with no record, and if `FieldRedactionResult.deferred` is empty apply
  the old walk — one evaluation, identical bytes, for every deployment with no record policy, which
  is all of them today. Only a deferral recomputes per record, and the per-record pass can only
  **relax** the record-free one, so the page wrapper's own keys, a non-object `data` element and a
  `record` body that is not an object all fall back to the *stricter* record-free set: fail-closed by
  construction. The stage's `redacted_<n>_fields` reason reports the **record-free** count on both
  paths, because on the per-record path the counts differ per row and a sum would scale with the page
  size. This is what ended ADR-0338's shared-spec property — the shape is a property of the
  *operation*, so a spec keyed by operation carries it, and the sharing that remains
  (`classifiedFields`, `entityPermissions`, `roles`) is pinned structurally instead.
  **And the per-record pass is one evaluator call since ADR-0344.** `recordsIn(shape, body)`
  enumerates the record positions by **running `redactRecords` itself** with a collecting
  `RedactedFieldsFor` that returns the empty set and throwing the rebuilt body away — so enumeration
  and rebuild are *one traversal definition* and cannot disagree about which objects are records,
  where two independent walks would be ADR-0288's shape again. The property is a **superset, not an
  equality**, and that asymmetry is the safe direction: `page`'s rebuild skips any wrapper key the
  record-free set names, so an entity with a classified field literally called `data` would stop the
  real rebuild descending while the empty-set enumeration still finds the rows — every position the
  rebuild can reach was enumerated, never the reverse, and an over-enumeration costs one evaluation
  for a record nobody asks about. `computeResponseRedactionForRecords` then answers all of them in
  one call, keyed back to the body **by object identity** with a fail-closed fallback to the
  record-free set (unreachable while the two share a definition, and `JSON.parse` never aliases, so
  a repeated record cannot arrive on the live path at all). It also built the `auth.Principal` and
  **copied `spec.roles` into a fresh `Map` once per record** before this; all of it is once per
  response now. `RedactionSpecOptions.abacBatchEvaluator` is the optional sibling that rides onto
  `spec.abac.evaluateBatch`. The two passes mean **two** seam crossings per response, not one,
  because the pool is per *call*: the record-free pass batches its own F cells and the per-record
  pass the remaining N×F — collapsing them would need the first pass to know what the second will
  ask, which is the thing it exists to discover.
- **`api-gateway-pg`** — Postgres implementations of the runtime's four store interfaces
  (idempotency, route registry with TTL cache, sliding-window rate-limit checker,
  pipeline-execution store) plus a replayer that flags out-of-order stages, pass-with-4xx,
  orphaned rate-limit decisions, and summarizes p50/p95 latency.
  **The package had zero importers until ADR-0335** — four stores and a replayer, none reachable from
  the deployed binary, so `meta.rate_limit_decisions` had never held a row and the sliding window was
  per-replica and per-restart. `--rate-limit-policy <rlp_id>:<limit>:<windowSeconds>` declares the
  policies and `node.ts` builds `PostgresRateLimitChecker` from them. `rate-limit-policy.ts` holds the
  declaration and `surveyRoutePolicies` (`surveyManifestJobs`' shape for routes), said at boot because
  an undeclared policy is a *refusal* at request time and the one thing worse than refusing is
  refusing without having said it would. `decision-schema-probe.ts` asks the catalog once at boot
  rather than lazily per request: the remedy for an unpatched catalog is standing manual SQL an
  operator runs once, which a boot line can carry and a per-request error cannot. The checker mounts
  **either way, loudly** (ADR-0322's rule) — the limit is enforced whether or not the decision row can
  be written, and refusing would cost the enforcement to protect its own projection.
  **ADR-0335 wired one of the four; ADR-0336 wired two more and declared the fourth.**
  `--idempotency-store pg` makes `PostgresIdempotencyStore` the gateway's replay guard, which had
  **no path to be passed at all** — `compile.ts` reads `options.idempotencyStore ?? new
  InMemoryIdempotencyStore()` and `server.ts` lacked the option — so every deployment's guard has
  been a `Map` in one process, including on `--tenant-deletion-routes`, the one route that *requires*
  a key. It carried two ADR-0335-class defects and **wiring it unfixed would have been worse than the
  in-memory store**: all three statements were bare `conn.query` calls on a table with one
  `ALL`-scope policy and no platform arm, so as a non-owner `get` answered **0 rows for a row that
  exists** (every request reading `first_seen`, a guard that always says "never seen") and `put` was
  refused `42501` — which, running *after* the handler committed with no try/catch in the 17 stages,
  escapes as a **500 for a mutation that succeeded**, and a client retrying that 500 gets the second
  execution. Both reproduced by hand on a live cluster. `deleteExpired` gained a required scope, for
  `rls_would_confine_this_session`'s reason. The two halves get **opposite** failure policies and
  that split is the decision: `get` **propagates** (it runs before the handler, nothing has happened,
  and not knowing whether this is a replay must not admit it — `cancellation_unknown`'s shape) while
  `put` is **reported and swallowed**, because throwing there causes the double execution it would
  prevent (ADR-0333). The guarantee is bounded and *stated* (`IDEMPOTENCY_GUARANTEE`): there is no
  reserve step, so two *concurrent* retries of one key both execute and only the **sequential** case
  is closed — which is what clients actually produce. The reaper is mounted by the store and
  deliberately **not** by a second flag, since a durable store needing another opt-in to stop growing
  is a feature with a trap in it.
  `--gateway-execution-capture <rate>` persists a sampled `PipelineExecution` — the writer
  `meta.gateway_pipeline_executions` never had, and the only thing that gives `GatewayReplayer` a row
  to read. The rate has **no `z.default()`** and `0` is **refused by name** (omitting the flag is how
  "off" is spelled), because the derived figure is **≈2,100 B per request** = 6.6 TB/yr at 100 req/s
  and **66 TB/yr at 1,000 req/s**, the same order as the 124 TB/yr that refused
  `meta.feature_flag_evaluations` a writer. A **uniform sample, not an outcome filter**:
  `pass_with_4xx_or_5xx` is a drift code about a row whose outcome *disagrees* with its status, so
  filtering on the claimed outcome discards exactly the rows where the claim is false.
  `sampleValue` is imported from `audit-chain.ts` so the two samples **nest** and a captured
  execution always has a chain entry beside it; past `maxInFlight` an execution is **shed and
  counted** rather than queued, since an execution row is independent under `ON CONFLICT DO NOTHING`
  and an unbounded promise chain turns a slow disk into an OOM.
  **`PostgresRouteRegistry` is declared a different serving model, not a queue position**:
  `compileOperateServer` derives routes *and their handlers* in one pass from the manifest, so a
  stored row the manifest did not produce has no handler and resolves `no_handler` after consuming
  its rate-limit budget, while a manifest route absent from the table stops matching — activating a
  manifest would quietly un-serve part of it. `lookup` is also synchronous and cold-returns `null`,
  a requirement `RouteRegistry` cannot express.
- **`rate-limiting`** — contracts only: 6 algorithms × 10 scope kinds, policies with 5
  overage handlings, 10 quota targets × 7 periods × 6 classes, IETF rate-limit headers,
  exception kinds with duration caps, throttle event audit.

### Workflow, jobs and background execution

- **`workflow-engine`** — contracts: workflow definitions (states, 
  triggers, guards, actions), 12 instance statuses, 10 activity kinds with retry policies,
  signals with 3 delivery guarantees, 4 timer kinds, compensation strategies, and the
  **27**-kind append-only event history. Also **instance cancellation** (ADR-0329), whose contract is
  shaped differently from ADR-0315's job promise for a reason: a job has one kind of work and an
  instance has several, so the guarantee is a **total map** `INSTANCE_CANCELLATION_EFFECTS` from work
  kind to strength — an unfired timer and a scheduled activity are `dropped`/`never_started`, an
  in-flight activity is only `signalled` (told via `AbortSignal`; one that ignores it still lands
  `cancelled`), and a child instance is `not_cascaded`, a separate instance with its own disposition.
  Whether an instance may be cancelled is answered by `INSTANCE_TRANSITIONS` and not by either
  terminal set, which matters because of ADR-0307's wart: `failed` is terminal yet the map says
  `["compensating"]`, and that is the right answer — a failed instance is compensated, not cancelled.
  `disposition` is a required enum with **no** `z.default()`, because a default is applied to silence
  and silence must not decide whether a half-written order is reversed. There is deliberately **no new
  instance status**: `INSTANCE_STATUSES` is a CHECK on `meta.workflow_instances.status`, so unlike
  `EVENT_KINDS` that is not an additive change — the fence is a field, exactly ADR-0315's shape.
- **`workflow-runtime`** — the in-process event-sourced executor. Append-only event log,
  deterministic left-fold projection, automatic transitions + on-entry actions until
  quiescent, registered activity handlers, signal correlation with exactly-once dedup,
  timer firing, saga compensation planning. `cancelInstance` + `surveyCancellableWork` (ADR-0329)
  fence **four** places, not three: due timers, automatic transitions, `submitSignal` (a delivered
  signal would transition the instance, run on-entry actions, schedule activities and spawn children)
  and activity scheduling — the first and third because the existing status check does not cover them,
  since the instance is still `running` between the request event and `instance_cancelled`. `setStatus`
  is now the fold's only status writer and returns early once `cancelled`, so a late
  `activity_completed` is recorded without resurrecting the instance, and
  `isInstanceCancellationRequested` also answers true on `status === "cancelled"` — an
  `instance_cancelled` can arrive with no request event, and reading only the fence would let a
  cancelled instance's timers fire. The rollback emits `activity_compensated` per step and **not** the
  `compensation_started`/`_completed` bracket, which would end the instance `compensated` and so
  indistinguishable from unwinding a *failure*; it ends `cancelled` under both dispositions.
  **`submitSignal` mints a signal id per match and returns `deliveries`** (ADR-0332) — with N matched
  instances there is no single `signalId`, and the old shape appended one id to every instance, so
  `meta.workflow_signals`' UNIQUE `signal_id` collapsed N deliveries to one row and the replayer
  reported drift on healthy data. `deduplicated` returns **the first submit's deliveries**, never an
  empty list, because telling a retrying webhook nothing matched is the one thing that is never true of
  a duplicate. The idempotency key is written to the receipt event *and* the row, so dedup survives a
  restart and reaches a second replica, and the unique constraint gains `instance_id` as a **fourth**
  column — one delivery per instance is the natural key, and the old three-column form is its **left
  prefix**, which is what the deduplicator reads, so the property making the fourth column free is
  itself pinned by a test. The deduplicator is a **fast path and the log is the authority**: it reads
  before the appends it guards, so each instance's own log is re-asked immediately before its receipt
  is appended — without that second question two concurrent submits of one key both read "unseen", the
  loser's row is refused, and the instance's projection can **never** be rebuilt because every later
  `resyncInstance` re-hits the same conflict.
- **`workflow-runtime-pg`** — persistence *and* distributed execution. `PostgresEventLog` +
  four projection stores + `ProjectingEventLog` (every append re-projects and upserts) +
  `buildPersistentEngine`, a replayer for drift repair, and the claim/lease layer that makes
  multiple workers safe: `claimDueTimers`/`Activities`/`Jobs` with renew + release, plus a
  `PostgresJobRunEngine` with a job handler registry and enqueue path.
  **`PostgresWorkflowDefinitionStore` is the writer `meta.workflow_definitions` never had**
  (ADR-0331), and definitions are **authored rather than compiled from a manifest** — the evidence is
  in that ADR. `planDefinitionPublication` decides between `insert` / `replace_draft` /
  `transition_status` / `unchanged` / `refused`, testing idempotency **before** every refusal so a
  repeat is never a conflict with itself; a published version is immutable, so its content digest
  (`crossengin.workflow.definition.content.v1`) covers `label` and `description` too and **preserves
  array order**, since `chooseTransition` returns the first guard-passing candidate and reordering two
  transitions is a behaviour change. Tenant scoping is **conditional** (copying `feature-flags-pg`),
  because `tenantId` is nullable and an unconditional `withTenantContext` would hide the very row a
  platform-wide write is inserting; there is no `revision` column, so a status change is guarded by
  **the status itself** inside the `UPDATE` predicate — ADR-0321's "the row is the lock", and stronger
  than a timestamp token because a caller cannot defeat it by reusing what it read. The summary digest
  is recomputed from the **re-parsed row**, never from a stored column, so a row edited after
  publication compares unequal (ADR-0323 in miniature). `surveyManifestWorkflows` classifies every
  manifest workflow against the definitions that exist, with `MANIFEST_WORKFLOW_MECHANISM` a total map
  so a fourth kind is a compile error. `signal-provenance.ts` is the fix for a store that could never
  succeed: `PostgresSignalStore.upsert` named nine columns and omitted `delivery_guarantee` and
  `source_system`, both NOT NULL with no default, so **every** `submitSignal` threw against a real
  database. The record was wrong, not the column — `SignalDefinition.deliveryGuarantee` is required
  and non-defaulted, so the definition is the only place a guarantee exists — and `sourceSystem` comes
  from the event's `actorSystemId`, a recorded fact rather than a fabricated default. A signal whose
  definition is absent **refuses** (`SignalProvenanceUnresolved`) rather than substituting a
  guarantee: guessing `at_most_once` claims a weaker promise than was declared and
  `exactly_once_idempotent` a stronger one, in the very table the guarantee is read back from.
- **`workflow-worker`** — the thin generic worker loop over those claims: batch processing,
  lease renewal while a handler runs, and three concrete workers (timer, activity, job).
  Small by design — the logic lives in `workflow-runtime-pg`. `abortWhile` (ADR-0315) is the cooperative
  half of cancellation: it gives the task an `AbortSignal`, not a kill, and a probe that **throws
  mid-flight does not abort** — the handler is already part-done and a database blip is not a
  cancellation. That is the opposite choice from the pre-flight check in `processJobBatch`
  (`cancellation_unknown` skips the item), where nothing has been done yet and deferring costs nothing.
  Two answers to "what if we cannot tell?", each correct for its position.
  **`no_definitions` does not refuse the job worker** since ADR-0334, and the supervisor's own
  refusal text said why: it reads *"every claimed item would be released unadvanced and re-claimed —
  a hot loop that makes no progress"*, which is true of a timer and an activity and **false of a job
  run**, because `claimDueJobs` reads `meta.job_runs` and `executeJobRun` dispatches through
  `JobHandlerRegistry` and **no workflow definition is consulted anywhere on the job path**. The
  refusal was live, not theoretical: the shipped catalog declares zero orchestration or scheduled
  workflows, so `meta.workflow_definitions` is empty in every deployment and `definitionCount` is 0 —
  a process with job handlers registered got its job worker refused for the absence of a thing the
  job queue does not use, and the printed remedy sent an operator to workflow authoring. It also hid
  the refusal that *is* true (`no_job_handlers`). `WORKFLOW_WORKER_NEEDS_DEFINITIONS` is a **total
  map** `{timer: true, activity: true, job: false}` rather than a loop, so a fourth kind is a compile
  error instead of a kind inheriting whichever answer the loop happened to give it.
- **`workflow-signal-bridge`** — verifies an inbound webhook's HMAC, extracts a correlation
  key by field path, and submits a signal to the workflow runtime; ships as a registered
  gateway handler with typed bridge outcomes → HTTP statuses.
- **`jobs`** — contracts for background work: 6 job kinds, cron expressions, idempotency
  keys, retry strategies, dead letters, per-run cost ledger, data-class tagging. Also **cancellation**
  (ADR-0315), whose contract is a bounded promise: `JOB_CANCELLATION_CHECKPOINTS` ×
  `JOB_CANCELLATION_GUARANTEES` state that **a cancellation guarantees no further work will be *started***
  — an arbitrary handler cannot be preempted, so it is *told* via an `AbortSignal` and a handler that
  ignores it still lands `cancelled` rather than `completed`. The checkpoint is stored on the run, so the
  guarantee is readable from the data rather than inferred from logs. `planJobCancellation` chooses between
  cancelling now and recording the request; `workflow-runtime-pg`'s `requestJobCancellation` re-asserts the
  premise *inside* the `UPDATE` predicate so a worker that claimed the run in between wins the row, and
  `COALESCE`-stamps so cancelling twice is a no-op on the record.
  `survey.ts` (ADR-0334) is `surveyManifestWorkflows`' shape for jobs — **six** verdicts
  (`handler_registered` / `served_by_kind_handler` / `deprecated` / `no_producer` /
  `event_unproducible` / `handler_missing`)
  over `JOB_KIND_PRODUCERS`, a **total map over `JOB_KINDS`** naming which producer enqueues each
  kind. `workflow` and `cdc` are `"none"`, so a job of those kinds reports `no_producer` **in
  preference to** `handler_missing`: naming a fix that would not work is worse than naming none.
  **`event_unproducible` is the sixth, and it exists because the map's granularity is the wrong
  one** (ADR-0362): `classify()` reads `JOB_KIND_PRODUCERS[kind]`, the kind `event` genuinely *has*
  a producer, and the question is whether that producer can emit this declaration's **name**. So all
  **55** (resolved pack, declaration) instances landed on `handler_missing`, whose detail told an
  operator *"event_emitter enqueues it — so every fire accumulates a pending run … the behaviour has
  to be registered by the deployment"* — two clauses of three false, in the function whose own
  comment at `:14` states the rule being broken. Checked **after** `no_producer`, which is the
  stronger statement (nothing enqueues this *kind* at all) and must keep winning for a `workflow`
  job, and **before** both handler checks; `deprecated` still outranks it, since all three producers
  skip a deprecated declaration so its name being unproducible is not a finding. It covers
  `delayed` as well as `event` — both are matched by `matchEventJobs` and both carry a name, read
  through a `switch` on the discriminated union rather than a total map, because the name lives in a
  *different field per member* (`eventName` / `afterEvent`) so a map keyed on the kind could only
  reach it through a cast. `SurveyManifestJobsInput.producibleEventNames` is **required with no
  default** and `[]` is the **claim** — this deployment emits no entity events, which is true with
  `--emit-entity-events` off — because an optional field defaulting to "assume producible" is the
  pre-ADR-0362 answer kept as the default, reachable by anyone who forgets the argument
  (`probeJobQueueVisibility`'s scope parameter, ADR-0334). The names arrive as an `Iterable<string>`
  rather than a manifest, which is what keeps this package free of the manifest layer: kernel
  depends on `@crossengin/jobs`, so `jobs → kernel` is a cycle. The same increment replaced the two
  hand-written `||` filter chains in `surveyManifestJobs` with a module-private total map over the
  verdict enum — they were a maintained list of "will never run" verdicts, and the one place a
  seventh verdict falling out of **both** lists would have been silent.
  `cron.ts`'s evaluator is complete and correct (5-/6-field, IANA zones via `Intl`, pure) and is what
  `scheduledJobsDue` has always used — and until ADR-0335 it **constructed an `Intl.DateTimeFormat`
  per stepped minute**, taking that path for any non-`undefined` zone including the literal `"UTC"`,
  which is `ScheduledTrigger.timezone`'s and `TimerDefinition.timezone`'s effective default.
  Measured: one sparse expression went from **9,427 ms to 30 ms**. The formatter is cached per zone
  (bounded at 512, so a pathological zone set cannot grow the map without limit) and the fourteen
  **UTC-equivalent zone names** map to `undefined`, which skips the formatter entirely —
  `Etc/GMT+0` and `Etc/GMT-0` are both in that set, because POSIX's sign inversion does not apply at
  zero. `"Z"` is deliberately **not** in it: it is a legal ISO designator that `Intl` *rejects* as a
  zone, so listing it would route an unresolvable zone to the UTC reader and turn
  `isResolvableTimeZone`'s refusal into a silent accept. An invariant test asserts every member
  resolves.
  `cronCanEverMatch` answers the question the old evaluator answered with a silent `null` — a
  29 February expression in a non-leap window, a day-30 February — and `JobTriggerSchema` **refuses**
  `timezone_unresolvable` and `cron_never_matches` at parse time rather than at the first tick, with
  `scheduledJobsDue` reporting through `onUnschedulable` instead of skipping. The refinement sits on
  `JobTriggerSchema` and **not** on `ScheduledTriggerSchema`, which is not a style choice: zod 3's
  `z.discriminatedUnion` rejects a `ZodEffects` member **without erroring at the union**, degrading
  every reader's `trigger.kind` to `unknown`. `CRON_FIELD`/`CRON_REGEX`/`CronExpressionSchema` moved
  from `types.ts` to `cron.ts` to break the runtime cycle that creates; `types.ts` re-exports them.

### Identity, security, data protection

- **`auth`** — RBAC + ABAC. Role definitions with inheritance, grants, per-entity and
  per-field permissions, write masks, the classification-aware redaction
  (`computeClassifiedFieldRedaction`) that fails closed on pii/phi/regulated fields, and
  `canonicalAuditEntryPayload` — the round-trip-stable bytes a forensic chain commits to for
  one audit entry (ADR-0286). Sensitive grants are **per class** since ADR-0329
  (`privilegedRolesByClass`), on one rule: **a class with an entry is authoritative for that class**,
  and the wholesale `privilegedRoles` reaches only classes with no entry. Read as a union instead, a
  wholesale grantee could never be withheld from `phi`, which is the one narrowing the feature exists
  for — so `{phi: []}` is a refusal, not a fall-through. One function behind both
  `computeClassifiedFieldRedaction` and `validateClassifiedWriteMask`, so a role cannot write a class
  it may not read — **and until ADR-0339 only the read half had a caller**, which made the property
  that comment claims unenforceable: three of this module's four field-level functions were
  callerless and the policy parameterising them had no producer, so the read side refused everyone
  and the write side refused nobody. `validateClassifiedWriteMask` is reached from
  `operate-runtime`'s create and update handlers now, with the **same policy object** the redaction
  registry gets. Of the two classification-unaware originals, **only `computeFieldRedaction` is
  callerless**: `validateWriteMask` is imported by `operate-server`'s `sensitive-field-policy.ts`
  and is what the handlers fall back to when no classified rule applies, so deleting it would
  break the boot survey. This file called both dead from the increment that wired the second.
  **A field grant has three arms since ADR-0348** — `read`, `update` and `create` — because the
  first two were *one list consulted at two moments*, so a grant could not say **set once at
  registration, never changed** and narrowing who may change a `required` field necessarily narrowed
  who may create the record. `create` **absent falls back to `update`**, which is what let the arm
  land without changing the meaning of a single shipped declaration, and `fieldWriteGrant(perm,
  writeOp)` is the one spelling of that fallback so no reader re-derives it.
  **That sentence was not enough, so `fieldWriteGrantArm` sits beside it** (ADR-0361), answering
  *which arm* `fieldWriteGrant` took. A refusal has to name the grant that refused, and
  `write-mask.ts` derived that from `perm.update` while the decision was made through
  `fieldWriteGrant(perm, writeOp)` — so a create refused by a field's own `create` arm reported the
  **update** grant, sending an operator to widen a list that already named them. Measured live on
  `erp-core`: `ap_clerk` POSTing `contact_phone` got `explicit_update_grant` and PATCHing the same
  field returned **200**, so the remedy the 403 pointed at was already satisfied. Written immediately
  beside the function it describes and over the same `??`, because the hazard was never that someone
  reads the wrong field — it is that the answer lived somewhere the fallback's author could not see. `update ⊆ read` is
  enforced by the kernel and **`create` is deliberately not**: a principal supplying a value already
  knows it, so writing it discloses nothing, while changing a value you cannot read destroys one you
  cannot see. `validateClassifiedWriteMask` takes a trailing `writeOp` defaulted to `"update"` — a
  departure from `operationsForEntity`'s required-ness (ADR-0338) for the opposite reason: *that*
  default could not possibly be correct, and this one is correct for the update path and **fails
  closed** for the other, since the change grant is the narrower one wherever the two differ. It is
  **required** on `WriteMaskInput` and `evaluateMask`, where the compiler can ask and a handler that
  forgot it would refuse a create the manifest permits.
  **`abac.ts` is the ABAC obligation** (ADR-0340). `RbacGrant.abac` is an opaque **policy key**,
  bounded `min(1).max(200)` like `workflow-engine`'s `ABAC_CHECK_GUARD.policyKey` — the one spelling
  in the repo that was already right, and whose `defaultGuardEvaluator` already *threw* — never an
  expression, which is how two of this package's own tests had been reading it.
  `dischargeAbac(policyKey, context, evaluator)` is the only function anywhere that calls an
  `AbacEvaluator`, and its four answers are the decision: no obligation → `null` (*nothing was
  checked*, which is not the same fact as *a policy said yes*); no evaluator → `undischargeable`,
  never `denied`, because the second is a claim about this principal's attributes and the first says
  nothing could answer; an evaluator that **throws**, or returns a value outside `ABAC_OUTCOMES`, →
  `undischargeable`, since an exception inside an authorization check must not become an allow nor
  a 500 a client retries. `ABAC_OUTCOME_ALLOWS` is a total map so a new outcome is a compile
  error — which ADR-0342 then relied on, because `deferred` had to be *written down* to be read at
  all, where an `if`-shaped condition would have had to have it added to the denying branch.
  **`dischargeAbacBatch(requests, evaluator, batch?)` is the plural form** (ADR-0344), one discharge
  per request and positionally aligned, with the same refusals in the same order plus two of its
  own. `AbacBatchEvaluator` answers `AbacBatchAnswer {index, outcome}` and the index must be exactly
  its own position: for a correct implementation that is pure redundancy, and that is its job, since
  a batch returning the right number of valid outcomes in the **wrong order** is a silent
  mis-authorization no check over the outcomes can see. Refusal granularity splits on whether the
  **correspondence** survives — a throw, a non-array, a wrong length or a wrong index refuses the
  **whole** batch (nothing can then be shown to belong to its question, and the prefix of a short
  array is not evidence that it answers the first ones), while an out-of-enum `outcome` refuses
  **that one**. `evaluateBatch` is a **sibling, never a replacement**: supplied without `evaluator`
  it refuses everything, because three of the five readers can only ask one question and the fourth
  is callerless. An empty request list returns `[]` calling **neither** function — not to keep the
  length check honest (`0 !== 0` passes) but so a vacuous alignment cannot stand in for a check, and
  so a policy service is not woken for nothing. ADR-0341's `abacAttributes === null` refusal settles
  **before** the array is built, so a batch evaluator receives only answerable questions and its
  length is the number of those.
  **`rbacCheckForRecords(input, records)` is the plural entity check** (ADR-0345), one decision per
  record and positionally aligned, which is what row filtering runs on. The entity, grant and
  **role** arms resolve once — none depends on the record — and only the obligation is asked per
  row, pooled into exactly one `dischargeAbacBatch`. Each element is identical to what `rbacCheck`
  would return for that record, reason and `abac` included, and that is held **by construction**:
  both readers go through one private `lookupGrant` and one `decideFromDischarge`, so the
  elementwise property cannot rest on two functions agreeing. The input is
  `Omit<RbacCheckInput, "record">` for the plural read path's reason, and
  `RbacCheckInput.abacBatchEvaluator` rides on the shared input — ignored by `rbacCheck`, which asks
  one question — so a caller cannot hand the single evaluator to one form and the batch to the
  other. An elementwise-equality test asserts *agreement*, not correctness, so ADR-0340's
  role-check-first ordering is fenced **separately** with a spy: both readers share `lookupGrant`
  and would regress together.
  All readers fail closed — `rbacCheck` and `rbacCheckForRecords` plus the four field functions, which take one
  trailing `AbacEnforcement {entity, evaluator?, evaluateBatch?, record?}` whose `entity` is *required*, so a caller cannot
  ask for enforcement without naming the entity the policy is about, and **omitting the parameter
  refuses rather than skips** (pinned by a `toEqual` against the no-evaluator result, so a forgotten
  argument cannot become a silent grant). `AuthorizationDecision.requiresAbac` is **deleted** rather
  than fixed in place — a field whose whole history is being dropped must not survive under its old
  name — and `abac?: AbacDischarge` rides on **both** arms so a satisfied check is reportable.
  `rbacCheck` consults the evaluator **only after** the role check passes: there is nothing to learn
  from an evaluation when a 403 was already owed, and asking hands the deployment's policy layer a
  principal it has no business seeing. `surveyAbacObligations` covers all four grant positions — the
  five operation names, `transitions`, and `fields[x].read`/`.update` — which is what the boot
  refusal is built from.
  **`Principal.abacAttributes` is `Record | null` since ADR-0341**, where `null` means *not
  resolved* and `{}` asserts the principal has none — two facts an evaluator cannot tell apart, and
  the conflation resolves in the allowing direction. Still **required**, not optional: an optional
  field can be forgotten with the type valid (ADR-0330's rule), and here every construction site has
  to say which it holds. `dischargeAbac` refuses `undischargeable` on `null` **before** calling the
  evaluator and **after** the no-obligation check, so an absent obligation still answers `null` —
  there was nothing to check, so a missing input cannot matter — and a deployment-supplied evaluator
  cannot answer from attributes nobody gathered even if it forgets to look. `abacAttributesResolved`
  is the one spelling of that comparison.
  **And the record is on the input since ADR-0342**, with the same provenance rule one level out:
  `AbacEvaluationInput.record?` absent means *the call site could not supply one*, never *the record
  is empty*. The fourth outcome **`deferred`** is what an evaluator answers when its policy needs a
  record and got none, and it is `false` in `ABAC_OUTCOME_ALLOWS` — so it is a **refusal pending a
  record**, and a call site that ignores it refuses rather than grants. That direction is the whole
  safety argument: reporting it as an allow-with-an-outstanding-obligation would be ADR-0340's
  dropped obligation one level up, where the drop is per handler instead of per function and so
  harder to see. `isAbacDeferred` is the one spelling. `dischargeAbac` deliberately gains **no**
  record-absence refusal — only the evaluator knows whether a key needs a record, and such a refusal
  would reject predicates over the principal's own attributes that never wanted one, at every
  position `ABAC_RECORD_AVAILABILITY` does not answer `always` for *and* at the **first pass** of
  every position it does (ADR-0343's two-pass legitimately asks once with no record). The count this
  sentence used to carry ("five of the eight") was wrong before ADR-0343 and is deliberately gone:
  `never` was three and `never` plus `sometimes` four, and a figure here breaks again on the next
  flip. That contrasts with the `abacAttributes === null` arm, where
  the seam *always* claims to carry the input, so absence is unambiguously a gap.
  **Availability is part of the contract**: `ABAC_RECORD_AVAILABILITY` over the nine
  `ABAC_GRANT_POSITIONS` answers `always` / `sometimes` / `never`, with
  `ABAC_RECORD_AVAILABILITY_REASONS` carrying the sentence the boot refusal prints — so the position
  a record can reach, the handler that reaches it and the message explaining why it cannot have one
  definition apiece, and a reason that restates its own key fails a shape test. `abacGrantPosition`
  is total and does not throw: the two operation names still unreachable for a field obligation are
  mapped to the entity position for that operation rather than defaulting, because the permissive
  default is the one a fall-through would pick. **`never` is pinned as the exact set
  `{entity_create, field_create}`** — `{entity_create, entity_list}` after ADR-0343,
  `{entity_create}` after ADR-0345, and `field_create` joined it in ADR-0348 — and as
  an exact set rather than key by key, because per-key assertions on this map are what let
  `field_read` sit on the wrong value, so flipping a position back fails there rather than passing
  quietly. **`field_create` is one kind of impossibility at a second scope**, not a new kind: it
  arrived with `FieldPermission.create` and answers `never` for `entity_create`'s own reason, since
  the record a policy there would be about does not exist until the write commits.
  `surveyAbacObligations` reads that arm **directly and never through the fallback**, because an
  inherited `create` carries `update`'s obligation — already in the list — so resolving the fallback
  would report the inherited one twice and a declared one not at all (ADR-0340's dropped obligation,
  in the function the boot refusal is built from). `entity_list` is `always` now: the list handler loads the page before it returns, so
  every row is in hand, and **a denial there drops the row from the page rather than refusing the
  request**. ADR-0343's `field_read`-vs-`entity_list` distinction survives but **moves axis** — both
  have the record and both always did; what separates them is what a denial *does*, and reading that
  as an availability difference is what kept both refused at boot longer than the facts warranted.
  **`ABAC_DENIAL_EFFECT` is that second axis** (ADR-0345), a total map over the nine positions to
  `refuses_request` / `withholds_field` / `filters_rows`, with descriptions keyed per **effect** —
  three strings, not eight, since the effect's name already carries the position-specific part.
  Availability answers *can this position be asked*; until row filtering existed that was the only
  axis worth having, because the answer to a denial was the same everywhere. `entity_create` reads
  `refuses_request` though a boot refusal makes it unreachable, because a total map with a hole is
  what a total map exists to prevent. Read by the boot report and by nothing else, deliberately: the
  list arm *is* the `filters_rows` behaviour, so branching on the map there would be a tautology.
  **`FieldRedactionResult.deferred` is the other half of the two-pass** (ADR-0343): the fields whose
  role check passed and whose *only* refusal is an obligation answering `deferred`, so it answers
  exactly "would supplying the record possibly change this?". A field refused on roles, or answered
  `denied` or `undischargeable`, is **not** in it — re-asking cannot change a statement about this
  principal, a statement that nothing could answer, or a missing role — and the
  classification-default branch carries no obligation and can never contribute. It is a
  **subsequence** of `redacted`, not merely a subset: both are pushed in field-list order in one
  loop pass, so a caller can zip either against its own field list, and a property test asserts
  **exactly one** of `ABAC_OUTCOMES` contributes, derived from the enum rather than restated.
  **`computeClassifiedFieldRedactionForRecords` is the plural read path** (ADR-0344), one result per
  record and positionally aligned, with **one** `dischargeAbacBatch` call pooling every
  (record, field) obligation — so a page costs one evaluator call rather than N×F. The three
  properties above survive the refactor because the function is now **plan → discharge → assemble**:
  a planner per record appends to one shared request array and returns a `PlannedField {name,
  verdict}` list in field order, and the assembler walks that one list, so order and the subsequence
  are still provable from a single ordered loop and no parallel array is indexed. Its enforcement
  parameter is `Omit<AbacEnforcement, "record">` **deliberately** — the records travel in the array,
  so supplying one twice is structurally impossible rather than resolved by a silent precedence
  rule. `computeClassifiedFieldRedaction` keeps its exact signature over the same pair and is *not*
  a wrapper that indexes `[0]`, which would need a non-null assertion or an unreachable arm.
  `fieldEvaluationContext` is the one spelling of the evaluation input, shared by the planner and
  the three one-question-at-a-time readers, so the batching and non-batching paths cannot build
  different questions about one grant.
- **`sso`** — federated identity contracts: SAML 2.0 + OIDC provider configs, SCIM 2.0
  provisioning, claim mappings with transforms and JIT user policies, session lifecycle,
  login audit.
- **`security`** — field/entity data classification resolution, at-rest encryption + key
  management options, CSP builder, backup policy, incident classification, threat model,
  certification standards, and a `SECURITY.md` disclosure-policy emitter.
- **`crypto`** — real cryptography over `node:crypto`: SHA-256/BLAKE2b-512 hashing and hash
  chains, HMAC-SHA256 webhook signing with replay windows, Ed25519 sign/verify/keypair,
  opaque tenant-scoped `KeyHandle`s behind a `KeyStore`, and auto-audit of key management.
  **`password.ts` is the password KDF since ADR-0358, and the three pins stay for `aead.ts`'
  reason**: they describe the key *registry*, and a password hash registers no key, holds no
  material in `meta.crypto_keys` and has no lifecycle, so scrypt is not a `KeyAlgorithm` and must
  not become one. `scrypt(hmacSha256(pepper, password), salt, 64, {N: 2^15, r: 8, p: 1, maxmem})`,
  encoded `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>` — the parameters travel **in the string**,
  because a hash that does not record them cannot be verified once the defaults move, and that is
  also why there is no sibling `algorithm` column to disagree with the bytes.
  Three things are load-bearing and each is a measurement. **`maxmem` must be passed above
  N=2^14**: the real requirement is `128·r·(N+p+2)`, exactly 3,072 bytes more than the documented
  `128·N·r`, and `128·N·r` at the defaults is *precisely* node's 32 MiB ceiling — so the default
  parameters sit just above it and scrypt throws `memory limit exceeded`, making an omitted
  `maxmem` a silent ceiling at 2^14 nobody declared. **The async form is mandatory**: 8 concurrent
  derivations at N=2^15 finish in 415 ms with a 10 ms timer still firing 39 times, where
  `scryptSync` blocks the loop flat, so on a single-process server the sync form stalls every
  request behind one login (the libuv pool is 4 and shared with fs and dns, which is why the caller
  also needs a lockout rather than treating the KDF as its limiter). And **`spendPasswordWork`
  derives under the parameters it is given**, which is what makes it a timing equaliser that tracks
  the deployment rather than one that goes stale: a fixed dummy cost equalises today and diverges
  the moment the floor rises. `PASSWORD_OUTCOME_ADMITS` is a map so a fourth outcome is a compile
  error at the one place that decides, and `unreadable_hash` is kept apart from `mismatched`
  because a corrupt row must not be counted as a failed attempt — it would lock a user out of an
  account whose password they typed correctly. No floor on a user's password, deliberately: the
  floor is on the **deployment's** pepper, through `parseCredentialPepper`.
  `ed25519PublicKeyFromSeed` is the other ADR-0358 addition, in `signing.ts`, and it exists so a
  deployment that signs its own tokens holds **one** secret. The reason is sharper than
  convenience: `signEd25519(seedA, pubB, m)` **does not throw** — node builds the key from `d` and
  silently discards an inconsistent `x`, so the signature verifies under A and not under B. A
  configured pair can therefore be stated inconsistently with no symptom but every login failing
  at the gateway. The primitive is left unchecked on a measurement (deriving costs 0.099 ms against
  a 0.133 ms signature, a 75% overhead on a function the forensic chain calls per audit append) and
  a test pins the silent-ignore instead.
  **There is a symmetric cipher since ADR-0346 — `aead.ts`, AES-256-GCM — and the three pins stay
  exactly as they are**, because they never asserted what this file used to say they did. They
  describe the key *registry*: `KEY_ALGORITHMS` is `MAC_ALGORITHMS ∪ SIGNATURE_ALGORITHMS`, the
  algorithms a registered `KeyHandle` may have; `KEY_PURPOSES` is what a handle is *for*;
  `CRYPTO_OPERATIONS` is the audited **key-management** vocabulary. That is exactly why ADR-0338
  could add `key-derivation.ts` and leave all three alone, and an AEAD over a **derived** key is
  outside all three for the same reason — no material at rest, no `meta.crypto_keys` row, no
  lifecycle. `isCryptoOperation("encrypt")` is still false, and a test pins that `aes-256-gcm` is not
  in `KEY_ALGORITHMS` with the positive reason: adding it would mean a *registered* cipher key, which
  would need the private-material column that table does not have. A cursor seal must not be audited
  either — one per page at request rate is the 124 TB/yr argument that refused
  `meta.feature_flag_evaluations` a writer (ADR-0336).
  `aeadSeal`/`aeadOpen` are `nonce || ciphertext || tag` (12 ‖ n ‖ 16, a contract rather than an
  implementation detail since other code transports the bytes), with a **fresh random nonce per
  seal** — never a counter, since there is no state to hold one and GCM nonce reuse under one key
  discloses the XOR of two plaintexts *and* leaks the authentication subkey. `aeadOpen` answers
  `null` for every rejection and throws for none, because its input is a string a client sends back
  and a throw would make a stale cursor a 500; a **wrong-length key throws**, because that is a
  deployment bug wrong for every input and answering it with `null` would make a misconfiguration
  indistinguishable from an attack. `aad` is a **required** parameter, and the honest reason is at
  the call site rather than in the cipher: an empty AAD is cryptographically identical to never
  calling `setAAD`, so requiring it buys nothing from GCM and everything from the signature — an
  unbound seal still encrypts and still authenticates, so nothing looks wrong while it is valid in
  every context instead of the one it was issued for.
  `deriveTenantCursorKey` is the second derivation, returning **raw bytes** where the column key
  returns base64 (`aeadSeal` takes bytes, `pgp_sym_encrypt` takes text), and the two are separated
  **only by their info strings** — which is what keeps one compromise from being two, so a leaked
  cursor key must not decrypt a PHI column. Pinned by a test asserting the two keys differ for one
  secret and one tenant, and by a known-answer vector computed two ways. `deriveTenantColumnKey` is HKDF-SHA256
  with the **tenant id as salt** and the generation in the `info` string — that way round because
  HKDF's salt is the per-instance separator and info is the context label, and swapping them would
  make two tenants' keys differ only in info. A derived column key is **not** a `KeyHandle`: no
  registry row, no public material, no lifecycle, nothing stored. `parseColumnEncryptionSecret`
  refuses rather than stretching (`too_short` under 32 bytes, `too_uniform` under 16 distinct byte
  values — the shape a deployment produces when it is satisfying a length check rather than supplying
  entropy), the derivation re-runs the same check so a caller holding bytes cannot bypass it, and the
  derivation is pinned by a **known-answer vector** computed two ways, because a silent change to it
  would make every existing ciphertext undecryptable. `columnKeyFingerprint` exists so a key can be
  *identified* in a log line without being disclosed.
  **`data-key.ts` is the one key here that is not derived** (ADR-0347). `generateDataKey()` is
  `randomBytes(32)` and nothing else — deliberately not seeded from the tenant id or the deployment
  secret, because *a key that can be recomputed cannot be destroyed*, so wrapping a derived key
  would buy a row to delete and no consequence for deleting it. `wrapDataKey`/`unwrapDataKey` are
  thin over `aeadSeal`/`aeadOpen` and restate none of their rules; `dataKeyWrapAad(tenantId,
  generation)` is canonical JSON of the pair for `cursorSealAad`'s reason. A wrong-length data key
  **throws**, and it matters most on `dataKeyToColumnKey`, whose consumer `pgp_sym_encrypt` accepts a
  key of **any** length — so a short key rendered to base64 would encrypt PHI weakly and report
  success. `deriveTenantKek` is the third derivation, the same construction under a third `info`
  tag, which is what keeps the envelope from adding a credential: it adds a *row* to keep or destroy
  and no second secret. A KEK held outside the database is the one thing that would support
  ADR-0338's original "including from backups" claim; see *What's actually left*.
- **`crypto-pg`** — a Postgres key registry for those handles (tenant-scoped rows, rotate /
  revoke / list). Thin: registry, records, tenant context. Note what it is **not**: `meta.crypto_keys`
  has no private-material column and its `algorithm` CHECK names only `hmac-sha256`/`ed25519`, so it
  is structurally a *public*-key directory and a wrapped data key cannot live there without migrating
  two CHECKs and a regex — which is half the reason ADR-0338 derives rather than stores.
  **`data-key-store.ts` is where a wrapped data key lives instead** (ADR-0347), over its own
  `meta.tenant_data_keys`. `ensure(tenantId, seed?)` is idempotent under an **xact**-scoped advisory
  lock (`TENANT_SCHEMA_LOCK_SQL`'s shape, not `kernel-pg`'s applier lock — that one is a *session*
  lock node-pg refuses inside a transaction, and this lock must be held by the transaction that
  reads and inserts), and a row that exists **ignores the seed**, so the provenance decision is made
  once per tenant and never revisited. `provenance` is derived from whether a seed was supplied and
  never accepted from a caller. `destroy` is a **hard delete** and not a `destroyed_at` flag,
  because a soft delete leaves the wrapped key in the row — a tombstone claiming a destruction over
  a key still there and still openable is ADR-0323's tampered scope in a new place. Every statement
  sets tenant context, **the reads too**, since that table's isolation policy is its only arm
  (ADR-0335's class).
- **`compliance`** — contracts only: the compliance-pack shape (metadata, parameters,
  contributions) and the resolver that merges pack clauses into a manifest.
- **`residency`** — 8 regions × 5 broad regions, cloud providers, residency profiles with
  per-data-class rules, routing decisions, and cross-region migration steps.
- **`residency-runtime`** — small: a tenant→region directory interface, `decideRegionRouting`
  and serving-region affinity selection.
- **`residency-runtime-pg`** — very thin: the Postgres-backed tenant residency directory.
- **`files`** — file lifecycle contracts (uploading → scanning → available → quarantined →
  archived), storage tiers and regions, signed-URL operations, OCR + embedding status,
  quota tiers, audit.

### AI surface

- **`ai-providers`** — the provider-neutral contract: `LlmProvider`, `LlmRouter`,
  `CompletionRequest`/`CompletionChunk` discriminated union, usage + pricing schemas, task
  policies with residency filters, and a `MockLlmProvider` for offline tests.
- **`ai-providers-anthropic`** — real Anthropic Messages API client (pricing, request
  builder, SSE streaming with state shared across read boundaries, typed retryable errors).
  Zero runtime deps.
- **`ai-providers-openai`** — the same five-module shape against OpenAI Chat Completions and
  Embeddings; the first provider where `embed()` actually works.
- **`ai-providers-local`** — an OpenAI-compatible local/self-hosted endpoint (Ollama, vLLM,
  LM Studio) behind the same contract, with zero-cost pricing so cost ceilings ignore it.
- **`ai-router`** — `DefaultLlmRouter`: picks a provider per task from a policy map, filters
  by tenant residency, retries retryable errors with backoff + jitter, falls back to the
  next provider, enforces per-tenant cost ceilings pre-flight, tracks per-provider p50/p95
  latency, and reports which provider actually served each call.
- **`ai-architect`** — contracts for the Architect agent: agent turn / plan / reflection /
  tool-call shapes, the tool-name allow-list, diff summaries, and the session / message /
  tool-invocation / proposal record schemas.
- **`ai-architect-pg`** — the Postgres transcript: four stores plus a `PostgresTranscript`
  implementing the `Transcript` lifecycle the chat engine emits into, so every proposal and
  its approval decision is auditable.
- **`ai-architect-runtime`** — a per-session cost tracker and an `ArchitectGuardRuntime` that admits or
  refuses a design request against budget and policy — now **per request** as well as per month
  (ADR-0311): `estimateRequestCost` bounds the output by construction (`maxTokens` is provider-enforced,
  and a request declaring none is `unbounded`, which a ceiling refuses) and heuristically on the input
  (`ESTIMATED_CHARS_PER_TOKEN = 3.5`, deliberately pessimistic *because* it feeds a ceiling — over-counting
  delays, under-counting admits), with `reconcileRequestCost` feeding the worst observed ratio back and
  `StreamCostMeter` aborting a stream that runs past budget. Plus `classifyDesignOutput`, which splits a
  failed design into `shape` (what the payload *is*) × `wrapper` (how it was *delivered*), so a fenced
  manifest (recoverable) and a fenced array (the model answered the wrong question) stop landing in one
  bucket. ADR-0330 made that split *act*: `DESIGN_SHAPE_RETRIABILITY` is a **total map** over the shape
  enum drawing one line — *did the model understand the question?* Broken syntax is a transcription
  failure and is retried; a well-formed object or array that is not a manifest is a confident answer to
  something else and is not, because asking again buys the same wrong answer for another paid call. A
  total map rather than an `if`-chain so a ninth shape is a compile error instead of a new member
  falling into whichever branch the chain ended on. A *wrapper* is never itself a reason to retry —
  `classifyDesignOutput` already unwraps a fence, so a fenced manifest is accepted with no second call.
  Also `script-tokens.ts` (ADR-0330), which closes ADR-0311's CJK note: `estimateInputTokens` takes the
  **greater** of the character count and a script-aware scan over *code points* (so an emoji counts
  once, not as two Latin characters), with a per-class ratio — latin 3.5, other_script 2, cjk 0.75,
  astral 0.5. Two orderings are load-bearing: everything above U+FFFF is `astral` first, because four
  UTF-8 bytes is dearer than a BMP ideograph's three; and the **cheapest class is an allow-list** so an
  unrecognised script falls to `other_script`, never to `latin` — but not to the dearest class either,
  since pricing every unknown code point as an ideograph would refuse legitimate requests.
- **`ai-architect-runtime-pg`** — a Postgres per-tenant monthly AI cost store backing that guard, and
  (ADR-0330) the **durable** estimator correction over `meta.architect_estimate_inflation`, which
  closes ADR-0311's "only per session": a restart forgot the correction in the direction that *admits*
  requests it had learned to delay. Its own table keyed on the tenant alone, because the monthly ledger
  is keyed `(tenant_id, period_key)` and a figure there would reset every month — the same forgetting
  on a monthly cadence. The high-water mark **relaxes per observation and never on time**: a time-decay
  would loosen a ceiling input *on silence*, which is what ADR-0317 refused for an attestation and
  ADR-0328 for a schema default, so an idle tenant keeps its correction and a busy one earns its way
  back; a reading that cannot be priced relaxes nothing, so a provider outage cannot loosen the
  ceiling. An **unreadable** stored row resolves pessimistic (2) rather than to "no correction" (1) —
  the opposite of most fail-closed choices here and right for this one input, since over-counting
  delays a request while under-counting admits one the ceiling exists to refuse — while an **absent**
  row resolves to 1, because nothing was ever learned and so nothing was lost.

### Vertical packs

Each pack is a declarative `Manifest` builder (`buildErp*Pack(opts?)`) with the same module
shape — `entities` / `relations` / `roles` / `permissions` / `workflows` / `jobs` / `views` /
`pack`. All except core declare `meta.extends` and only cross-validate after
`resolveManifest` merges their lineage.

- **`pack-erp-core`** — the base pack and by far the largest: ~51 entities spanning general
  ledger (LedgerAccount, JournalEntry/Line, FiscalYear/Period, AccountingBook), AR/AP
  (Invoice, Bill, Payment, Vendor), sales + CRM (Lead, Opportunity, Quote, SalesOrder,
  Shipment), procurement (PurchaseOrder, GoodsReceipt), inventory (Item, Warehouse,
  StockLevel/Movement), manufacturing (WorkOrder, BOM), projects, HR (Employee, Position,
  Timesheet, LeaveRequest), fixed assets, pricing, multi-currency (Currency, ExchangeRate)
  and tax (TaxCode/Rule/Jurisdiction, TaxReturn, WhtCertificate), with lifecycle workflows,
  scheduled + event jobs and list views.
- **`pack-erp-healthcare`** — extends core. Patient / Encounter / Observation, all auditable
  and PHI-classified, cross-pack references to Account and Invoice, an Encounter lifecycle,
  HIPAA compliance pack.
- **`pack-erp-retail`** — extends core. Product / Store / SalesOrder / OrderLine, a cart →
  placed → fulfilled → returned lifecycle, PCI pack; exercises classification on a non-PHI
  domain (`Product.unit_cost` is commercial_sensitive).
- **`pack-erp-grocery`** — extends *retail*, proving three-level transitive lineage
  (grocery → retail → core). Supplier + PerishableLot, HACCP pack.
- **`pack-erp-construction`** — extends core. Project / WorkOrder / Subcontractor.
- **`pack-erp-education`** — extends core. Student / Course / Enrollment.
- **`pack-erp-government`** — extends core. Citizen / Case / Permit.

### Business operations

- **`billing`** — contracts: plan families and tiers, subscriptions, metered usage,
  invoices and line kinds, payments/refunds/credits, dunning stages, tax, billing events.
- **`billing-runtime`** — the metering engine: usage ingest with idempotency, per-meter
  buckets, rating (overage + subscription base lines), draft invoice assembly, period close.
- **`billing-runtime-pg`** — persists usage and invoices, wraps the engine so each period
  close is written, and syncs metered usage up to Stripe.
- **`billing-stripe`** — a real Stripe client (form-encoded, injectable `fetch`): customers,
  subscriptions, usage records, billing-portal sessions, and webhook signature verification
  with a tolerance window.
- **`finops`** — 17 cost categories × 5 allocation methods, per-tenant attribution, budgets
  with breach actions, unit economics (LTV/CAC/contribution margin), chargeback statements,
  anomaly kinds, cost reports.
- **`tenant-lifecycle`** — **5**-state tenant lifecycle (`active` / `suspended` / `archived` /
  `pending_deletion` / `deleted`), grace periods,
  GDPR Article 17 deletion requests with legal bases and retention obligations, data
  exports with TTL-bounded download links, cryptographic tombstones with proof hashes.
  **It was seven and nothing read it** (ADR-0334). `TENANT_LIFECYCLE_TRANSITIONS`,
  `READ_ONLY_STATES`, `TERMINAL_STATES`, `RESTORABLE_STATES` and the four predicates
  (`isReadOnly`/`isTerminal`/`isRestorable`/`blocksWrites`/`blocksReads`) had **no consumer in the
  workspace**, while `operate-server` carried its own four-value `TenantStatus` — and that one is
  what `meta.tenants.status`' CHECK constrains and what the console transitions. Two of the
  unreachable three were **billing facts duplicated onto the tenant**: `past_due` is a *subscription*
  status with its own transition map in `@crossengin/billing` (a tenant in arrears is still an
  `active` tenant), and `trial` is a plan tier in `PLAN_TIERS` with no producer anywhere. Both are
  gone, and `GRACE_FROM_STATE`'s `billing_grace` reads `active` — it used to name a `fromState` no
  tenant row could hold. The third, `pending_deletion`, is **kept and added to the CHECK**, because it
  is the one the deployment was missing: it has been in `READ_ONLY_STATES` since Phase 1 and is what
  `deletion_grace` and `appeal_window` name as their `fromState`. `pending_deletion -> active` is in
  the map because `DELETION_REQUEST_TRANSITIONS` permits `verified -> rejected`, so a request that put
  a tenant there can be rejected afterwards and the tenant must come all the way back — routing the
  restore through `archived` would cost a tenant their write access for somebody else's mistake.
  `operate-server` re-exports the enum rather than restating it, and
  `consoleTransitionsAreLifecycleTransitions()` proves the console's map is a subset.
  A tombstone is **composed from per-subsystem attestations, never written by hand** (ADR-0317), because
  what made the first one false was not a wrong number but a subsystem nobody asked whose silence read as
  nothing to delete: `assembleTombstone` refuses `subsystem_unattested` for any of the six
  `DELETION_SUBSYSTEMS` in scope that did not report, each owns its `DeletionScope` fields exclusively so
  a list has one provenance, and only a **scope-bearing** outcome may carry figures — a
  `nothing_to_erase` that could would smuggle numbers into the proof.
  There are **four** outcomes since ADR-0330: `erased_and_retained` joined them, so a subsystem that
  destroyed some data and lawfully kept the rest can say both in one claim with one provenance.
  A fourth enum member rather than an optional retention block riding along on `erased`, because the
  outcome is the single answer to "what happened here" and has to stay total: an optional field can be
  forgotten with the outcome unchanged, which is ADR-0317's silence in a new place, and a new member is
  a **compile-time** demand on every exhaustive reader where a new field is not. `SCOPE_BEARING_OUTCOMES`
  and `RETENTION_BEARING_OUTCOMES` replace four inline `=== "erased"` comparisons, and a test asserts
  they partition the enum with only `nothing_to_erase` left over, so a fifth outcome added to neither
  fails there. The retained side carries an obligation and a reference and **no figure at all** — there
  is no numeric field on it — and `retainedObligations` is a *list* for `erased_and_retained` while
  `retained` keeps its singular field, because a partial retention is chosen table by table and that is
  exactly where two obligations become possible over one subsystem. `retainedReason`/`retainedDataReference` are *derived* from
  a `retained` attestation rather than remembered. Every refusal lands before a hash is computed, and the
  assembler re-verifies its own output. `tombstoneMatchesAttestations` answers the question a hash cannot:
  whether a stored record still agrees with its evidence — a tampered scope flips `contentManifestOk`
  while `proofOk` stays true, since the proof commits to the stored digest.
  **And the scope itself is declared by the deployment, not by the caller** (ADR-0328).
  `DeletionCapabilities` is a **total** map — one of `erases` / `retains` / `absent` for every one of
  the six `DELETION_SUBSYSTEMS`, no optionality — and `requiredSubsystemsFor` derives the scope from
  it. That closed ADR-0317's defect one level up: the rule refuses a subsystem *in scope* that did
  not attest, and scope was a list the caller passed — which on the HTTP route was the **request
  body**, defaulting to `[]`, so a remote client chose how much of the proof covered and omitting the
  field covered nothing. `retains` stays **in** scope, because a lawful retention is a claim the
  proof must carry rather than a licence to go quiet; `tenant_schema` may never be `absent`; and
  `CONSERVATIVE_DELETION_CAPABILITIES` (everything `erases`) is an exported *starting point*, never a
  `z.default()` — a schema default is applied to silence, which is the thing ADR-0317 refused, and
  `safeParse({})` fails. The map is a literal `z.object`, not `z.record(z.enum(...))`, because zod 3's
  record **accepts** a partial object while typing it as total. `shared_tables` may not be `absent`
  either since ADR-0329, for `tenant_schema`'s reason: it is the second subsystem the pipeline
  *performs*, so a declaration calling it absent is a configuration error caught at boot rather than
  at the first deletion.
  **And the declaration is inside the signed bytes** (ADR-0329), as `crossengin.tombstone.content.v2`
  — a second domain tag, not an edit in place, because v1's bytes are what every stored digest commits
  to and appending to them would stop every existing tombstone verifying. `crossengin.tombstone.proof.v1`
  is unchanged for *every* version: the proof payload commits to `contentManifestSha256`, which is
  version-bound by its own tag, so the proof inherits the version without its own bytes moving and the
  chain transitively witnesses the declaration. A verifier selects the version from the explicit
  `proofVersion` field and **never** by inferring it from whether a declaration is attached — an
  inference would read a *deleted* declaration as an older record, a tamper that covers its own tracks
  — and the contract pairs the two in both directions, so a relabelling is refused rather than hashed
  best-effort. What this buys is the one distinction v1 could not make: "we have no cache layer" and
  "we have a cache layer and it held nothing" compose **byte-identical** scopes, since
  `nothing_to_erase` may carry no figures at all, so under v1 a deployment could answer the harder
  claim with the cheaper one.
  **And since ADR-0351 the bytes say where the tenant's records were**, as
  `crossengin.tombstone.content.v4`, which is the fourth tag answering the fourth instance of one
  question: v1 could not separate *no object storage* from *nobody asked*, v2 *nothing retained* from
  *cannot say*, and v3 *no typed per-entity relations* from *54 and the manifest declared none*.
  `TombstoneRecordStorageDeclaration` is `{model, schema, relationCount}` over
  `RECORD_STORAGE_MODELS` (`typed_tables` / `document_rows` / `no_durable_store`), with `schema`
  non-null for `typed_tables` **alone** and a `relationCount` of 0 on that model deliberately *not*
  refused — a column store serving a manifest that declares no entity is legitimate under per-tenant
  manifests and the signature of a misconfiguration otherwise, so the zero **is** the claim. It
  travels on `TombstoneAssemblyInput` beside `capabilities` rather than on an attestation, because
  every field is derivable before a row is read and `DeletionAttestation`'s own comment states the
  rule a figure there would break: *the figures in a proof describe what was destroyed*. The
  capabilities path **requires** it (`record_storage_undeclared`), so that path signs v4 and the
  `requiredSubsystems` path still emits v1 — and no assembler emits v2 or v3 any more, though both
  remain legal for stored records. `readRecordStorage` is the reader, with **no default declaration**
  on the `unknown_not_in_proof` arm for `readRetentionClaim`'s reason.
  **`PROOF_VERSION_COVERAGE` is the one total map the three membership lists became**, over
  `TombstoneProofVersion` to `{declaration, retentionClaim, recordStorage}`, with
  `DECLARATION_BEARING_PROOF_VERSIONS` / `RETENTION_BEARING_` / `RECORD_STORAGE_BEARING_` derived from
  it so every exact-membership assertion kept working. The original refusal stands — *a version names
  a domain tag, not an ordinal, and nothing promises the next tag is a superset*, so `>= "v2"` is
  still refused — but a map is not an ordering comparison and it buys what the lists could not: adding
  an enum member is a **compile error** until it declares its coverage. That mattered measurably;
  see *Where we are*. The three refusal messages render their remedy from those arrays through
  `declareOneOf`, because two of the three had already gone stale naming `'v2' or 'v3'` — a
  hand-maintained list inside a *remedy* is the worst place for one, since the reader is being told
  what to do.
- **`tenant-lifecycle-pg`** — also the tenant lifecycle **trail** (ADR-0335). `lifecycle-event-store.ts`
  is the first writer `meta.tenant_lifecycle_events` ever had, whose own `PLATFORM_RECORD_TABLES`
  comment says why it matters: *without it nothing in the database distinguishes a tenant that was
  deleted from one that never existed.* Constructed **unconditionally under `--store pg`** with no
  flag, because a transition the deployment already performs either leaves a record or does not, and
  making the record opt-in is what left this table empty for four phases. `lifecycleEventFor` derives
  `toState` from `ACTION_TARGET_STATE` and `requiresFourEyesApproval` from `actionRequiresFourEyes` —
  never accepting either — so a caller passing `false` cannot record an unapproved privileged act as
  an approved-not-required one. `probeLifecycleTrail` reports `durable` / `cascades_with_tenant` /
  `unreadable_after_deletion` / `absent` at boot, and `lifecycleTrailGaps()` names the actions with no
  producer; neither refuses, because the trail degrades to *no record* rather than to a wrong one
  (ADR-0322).
  **`tenant-context.ts` is here because two of this package's stores could never write at all.**
  `PostgresLifecycleEventStore`'s insert and `PostgresDeletionRequestStore`'s `submit`/`transition`
  set no tenant context, and on both tables the isolation policy is the **only** arm carrying a
  `WITH CHECK` — the platform arm is `SELECT`-scoped by ADR-0332's rule — so as a non-owner every
  write raised `42501`. For the deletion-request store that is **ADR-0321's store, shipped and never
  exercised live as a non-owner: the entire asynchronous Article 17 flow was unreachable outside an
  owner connection.** The *reads* were fine, which is what hid it — they elevate through
  `app.platform_audit`, so an operator could list requests and never create one. Two properties are
  load-bearing and each is pinned: the scope names the **row's own** tenant (a fact about the record,
  not something a caller supplies and could get wrong), and a bare `conn.query` is **not enough**,
  because `set_config(…, true)` is transaction-local and is discarded with the implicit
  single-statement transaction before the statement it was set for.
- **`tenant-lifecycle-pg`** — the tombstone's store (ADR-0318), and the first writer
  `meta.tenant_tombstones` ever had: declared in Phase 1, it had drifted behind its contract in the way
  ADR-0300 found for `meta.feature_flags`, and in the table where it mattered most. `executed_by` and
  `approved_by` referenced `meta.users` with `ON DELETE RESTRICT`, which would make a user
  undeletable *because* a tombstone named them; and a `scheduled_purge` has no human executor at all.
  (ADR-0318's own wording said a tenant deletion erases `meta.users`. It does not —
  **`meta.users` has no `tenant_id` column**, so `eraseSharedTablesWithin` never reaches it and a
  tenant deletion leaves every user row intact, verified against the live catalog in ADR-0330. The
  decision stands on the `RESTRICT` argument alone; the stronger premise was wrong.) They are TEXT and
  unreferenced now, the table gained the `attestations` its claim is composed from and the chain
  coordinates that witness it, a `SELECT`-only platform policy (isolation alone made the record
  unreadable by the only people who need it, since a tombstone outlives its tenant), and a four-eyes
  CHECK — the third layer for one rule. `write` appends the chain entry **first and in the same
  transaction** (ADR-0286) and **replaces** the caller's `anchors` with it: a claimant choosing their own
  witness is the hole, not a feature. The chain payload is the two digests and the identity, never the
  scope, because a scope can name every table a tenant held and every integrity pass rereads the chain.
  `deleteTenantAtomically` (ADR-0319) then runs the whole deletion — erase, attest, assemble, anchor,
  store — in **one** transaction, so the data and its proof cannot disagree: run separately there is a
  window where the schema is gone and the record of its deletion is not, which ADR-0316 actually hit and
  had to answer with a 500 saying "do not issue a tombstone from this response". `eraseTenantSchemaWithin`
  and `writeWithin` are the seams, following `appendWithin`'s precedent; the erase's advisory lock
  becomes the *caller's* to release, so nothing re-creates the schema between the drop and the tombstone.
  `tenant_schema`'s attestation is produced by the pipeline from the erasure that just ran and a
  caller-supplied one is dropped — an attestation about work the transaction is about to do is a
  prediction, not evidence.
  **`DeleteTenantInput.bootSchema` carries the record-storage declaration minus its count**
  (ADR-0351): `BootSchemaDeletionInput extends BootSchemaErasureInput` with
  `Omit<TombstoneRecordStorageDeclaration, "relationCount">`, and the pipeline fills the count from
  `targets.length` — the same list it hands the erasure. So the figure the v4 digest commits to **is**
  the number of relations that deletion targeted, structurally rather than by a cross-check somebody
  has to remember; ADR-0344's `Omit` idiom for its reason, since supplying it twice is impossible
  rather than resolved by a precedence rule nobody reads. The erasure itself receives only
  `{targets, blockingCycle}` and knows nothing about the declaration.
  **`PostgresDeletionRequestStore` + `DeletionRunner` make that pipeline asynchronous** (ADR-0321), because
  ADR-0320 put it behind an HTTP request that a large tenant can outlast. `meta.gdpr_deletion_requests` is
  the handle — the third never-written Phase-1 table, with the same two defects: `verified_by` referenced
  `meta.users` (`ON DELETE RESTRICT` would make a verifier undeletable *because they verified the request
  to delete them*) and nothing joined a completed request to its tombstone. `transition` re-asserts the
  current status **inside the `UPDATE` predicate**, so the row is the lock and two schedulers cannot both
  claim one request. The runner's five outcomes turn on one distinction: a `DeletionPipelineAborted` is
  raised *inside* the pipeline's transaction, so receiving it **proves** the rollback and the refusal is
  deterministic → `rejected`; anything else thrown is genuinely unknown → `aborted`, left `in_progress`
  for a human, since the contract offers no way back to `verified` and re-running on an assumption is how
  a tenant gets deleted twice.
  **`DeletionReconciler` then resolves what that strands, from evidence** (ADR-0322). Because the pipeline
  writes the tombstone in the same transaction as the `DROP SCHEMA` and ADR-0321 put the request's id on
  it, **a tombstone naming the request exists ⟺ that request's deletion committed** — so nothing infers
  from a missing schema or a log line, it asks `findForRequest` one question. The two directions are
  **not** symmetric, and that is the decision: presence is conclusive *at any age* and is applied
  automatically, while an absence is only an inference — "not committed" and "not committed yet" look
  identical — so `never_committed` is gated behind a staleness window, is never applied by a scheduler,
  and is its own verdict rather than being folded into the first. `ambiguous_evidence` (two tombstones
  naming one request) is never applied at all: the premise is broken, which is a finding and not a row to
  pick from.
  **And evidence is verified before it is used** (ADR-0323), which matters because of what the chain does
  *not* cover: `proofSha256` commits to `contentManifestSha256` and the chain entry commits to the two
  digests and the identity — **neither commits to the scope** — so editing a stored tombstone's `scope`
  leaves every digest and the chain entry byte-identical and `--integrity-proof-config` cannot see it.
  `contentManifestOk` and `tombstoneMatchesAttestations` are the only two detectors, and until ADR-0323
  nothing called either on the reconciliation path. `verifyStoredEvidence` now gates
  `completed_by_evidence` behind four named defects (`scope_tampered`, `proof_mismatch`,
  `scope_disagrees_with_attestations`, `unwitnessed` — which asks the stronger `isAnchoredByChain`
  question, not merely "is the column set"), yielding `evidence_unverified`, which **nothing** may apply —
  not a scheduler and not an operator, since `acceptNeverCommitted` authorises an inference from an
  absence and says nothing about a record that lies. `auditCompleted` does the reverse direction for
  requests already `completed`, where a third question arises that the forward path never asks: the
  request keeps its own copy of the digest, so the two can disagree while both records are intact.
  **And a third direction starts from the proofs** (ADR-0327), because both of those start from a
  *request* and a tombstone written by the synchronous route of ADR-0320 has none — so every one of
  them was verified by nothing, in the one table where `verifyStoredEvidence` is the only detector
  there is. `scanAll` keysets on `tombstone_id` (NOT NULL and unique-constrained, so the ordering is
  total: `deleted_at` can tie and a tie makes a sweep re-read or step over a row at every page
  boundary — and the skipped row is one nothing else verifies; `chain_sequence_number` is nullable for
  pre-anchoring rows; `OFFSET` shifts under a mid-sweep insert), reading through the same
  `app.platform_audit` elevation its siblings use. `auditTombstones` classifies each finding
  `unreferenced` / `referenced` / `dangling` — the last being a proof naming a request that is *gone*,
  which is not the same fact as a proof naming none — and reports the **referenced** ones too, because
  `auditCompleted` only walks `status = 'completed'` under its own limit, so a tombstone whose request
  sits `in_progress` would otherwise fall through both. It writes nothing, pinned by a test that
  records every statement: ADR-0323 established that `evidence_unverified` is a verdict nothing may
  apply, and a sweep that found a tampered scope has even less standing to act than that.
  `verifyTombstone(id)` (ADR-0329) is the **targeted** re-read that finally gives
  `onTombstoneResolved` a caller able to substantiate a recovery: a clean sweep page does not say a
  particular tombstone verifies, since it may simply not have been on the page. Its three outcomes
  are `absent` / `verified` / `unverified`, and `absent` closes nothing — a deleted proof is not a
  verified one, and it is exactly the fact a naive "it stopped appearing in the findings" check reads
  as recovery. `tombstoneStanding` is the *extraction* of the rule `auditTombstones` applied inline,
  so a targeted check cannot be stricter (never closing anything) or laxer (closing an episode whose
  finding stands); a **dangling-but-intact** tombstone answers `unverified` deliberately, because the
  sweep still reports it.
  **And `eraseSharedTablesWithin` is the second real erasure** (ADR-0329), which until then did not
  exist at all: **112 of the 143 `META_TABLES` carry a `tenant_id`** and nothing erased one of them,
  so every deployment declared `shared_tables: "absent"` and signed an Article 17 proof over a tenant
  whose rows were still in `meta.operate_entity_records`.
  **And since ADR-0350 it erases the boot manifest's own entity tables too** — a required
  `bootSchema: {targets, blockingCycle}` whose list the *caller* supplies, because
  `operate-runtime-pg` creates those tables and so is the only thing entitled to name them and this
  package must not depend on it. The two groups are **one** target list, **one** probe and **one**
  refusal pass, which is what keeps ADR-0330's *"a returned refusal means nothing was destroyed"*
  true across both; the boot group is first because it is the tenant's own records, and neither
  group's order is resorted here. Grouped rather than two parameters (ADR-0342's rule):
  targets-without-the-cycle-verdict is a list that looks complete and that the database refuses
  partway through. Five refusals guard it and each converts a mid-transaction raise — which rolls
  back, and which ADR-0321's runner files `aborted` and strands — into a deterministic `rejected`:
  `target_collides_with_catalog` (an entity resolving onto a catalogued relation, worst of all a
  retained one, with a correct-looking `tenant_id = $1`), `boot_schema_target_invalid`,
  `boot_schema_order_unrunnable`, `target_lacks_tenant_scope` (the probe asks for the column it
  scopes by now, which every catalogued target carried by construction and a boot target need not)
  and `boot_schema_table_undeclared`. That last one is `censusBootSchemaTables`, the **other
  direction** — `pg-record-retention.ts`'s both-ways rule, since a one-way comparison is what the
  original defect was made of — narrowed to the signature this emitter writes and nothing else does,
  a policy named `<relname>_tenant_isolation`, because the default boot schema is `public` and a
  `tenant_id`-keyed census would refuse every deletion in a deployment that shares it. It catches
  `ensureSchema`'s additive migration leaving a previous manifest's table behind, which is the
  original defect's own shape one manifest later.
  Targets are derived from `META_TABLES` minus
  a **compile-time** retention set — a caller-supplied retention list would be ADR-0328's defect in a
  new field — which ADR-0330 split into its **two genuinely different reasons**, because defining one
  of them away was the thing that made statutory retention inexpressible.
  `PLATFORM_RECORD_TABLES` (16) is the original rule: *the platform's record of what happened to the
  tenant; not the tenant's data, not an Article 17 subject at all* — the tombstone, the request, the
  chain and its checkpoints, the audit log and its verdicts, the lifecycle events, the compliance
  attestations and certification reports, the **public**-key registry the chain's signatures resolve
  against, and the six access-review tables. These are silent in the proof.
  `STATUTORY_RETENTION_TABLES` (2) is the tenant's own data the law forbids deleting, each naming its
  obligation: `meta.invoices` and `meta.tenant_credits` under `tax_records_7y` — a tax invoice the
  platform *issued* and the credit notes adjusting it, where retaining the invoices and destroying the
  credits would leave a record that **overstates** the tax charged. These are **named** in the proof.
  `tenant_data_exports` stays erased, since a copy of the subject's own data behind a TTL'd link is
  reached by Article 17 as much as the original; so do `billing_events` (an operational log whose
  unbounded `payload` a seven-year hold must not sweep up — Art 5(1)(c)), `subscriptions` (the
  *current* state of a contract, and a contractual limitation period is not even expressible in
  `RETENTION_OBLIGATIONS`), `billing_subscriptions` (retaining it would leave a deleted tenant
  **entitled**) and `billing_usage_records`. `DELIBERATELY_ERASED_BILLING_TABLES` names them so nobody
  "completes the table" later. Three refusals guard the split, and
  `retained_table_blocks_erasure` is the load-bearing one: a retained table with a `RESTRICT` foreign
  key into an erasable one makes the parent undeletable *because* the retention exists — ADR-0318's
  defect, now derived from the catalog instead of discovered by a deletion, since retaining a table is
  precisely the edit that creates it. Deletion is in **reverse
  `META_TABLES` order**, relying on the meta-schema invariant that an FK resolves to a table declared
  earlier, so nothing hand-sorts. `rls_would_confine_this_session` is not theoretical and was observed
  live: as a non-owner role with no tenant context the `DELETE` matched 0 rows, reported 0, and the
  confirm-absence `count(*)` *also* saw 0 while the rows were still there — both read through the same
  policy, so the confirmation cannot catch it, and the probe refuses up front. ADR-0319's
  single-subsystem filter became a **refusal** keyed on `Object.keys(ATTESTERS)`, so a subsystem the
  pipeline performs cannot be missing from the protected set, and a caller attesting for one gets a
  pre-transaction `input`-stage refusal rather than a silent drop. The shared erasure runs **first** in
  the pipeline, because all of its refusals land before it writes anything — which is what keeps "a
  returned refusal means nothing was destroyed" true for both erasures.
- **`marketplace`** — contracts: 8 pack kinds, a registry with Ed25519 signing and security
  review, per-tenant install lifecycle, permission grants, listings, reviews,
  compatibility.
- **`marketplace-runtime`** — the two state machines: pack submission/review/publish/retire,
  and installation admit → grant → complete / fail / update / uninstall.
- **`marketplace-runtime-pg`** — persists installations and pack versions, and wraps both
  engines so each transition is written.

### Observability, reliability, delivery

- **`observability`** — contracts: SLO definitions and error-budget compute, alert policies
  and channels, log/field redaction, synthetic check declarations, OTel-style span
  attributes.
- **`observability-runtime`** — the SLO enforcement loop. Rolling request-outcome window,
  multi-window Google-SRE burn-rate evaluation, latency percentile evaluation against a
  budget, synthetic consecutive-failure detection, and pure planners that turn a breach into
  a declared incident + an on-call page + a kill-switch flag rollback. Plus a
  `TraceCollector` that stitches gateway → workflow → notification spans into a tree.
  **`evaluate()` is async and declares through an injected `IncidentDeclarer`** (ADR-0293): the
  engine never constructs an `INC-YYYY-NNNN`, so the id on the row, in the log line, on the page and
  in the enforcement action is one string by construction. A declaration that fails leaves the
  surface unopened for the next tick rather than aborting the pass, a surface with a declaration in
  flight is skipped, and a `recovered` decision carries `closeOut` — `cancelled` / `human_owned` /
  `unpersisted` / `failed`. Before declaring it asks the declarer which incident this signal already
  has open (ADR-0294), so a restart mid-breach adopts it as `breach_ongoing` instead of declaring a
  second for one episode; the key is `autoDeclaredForKey(signal, surface)`, namespaced so the latency
  breach on a surface is not the availability one.
- **`observability-runtime-pg`** — persists evaluations and enforcement actions for both the
  availability and latency engines (one action table with a `signal` column), plus a
  replayer that flags ongoing-without-open, duplicate-open and paged-without-channels. Both
  `buildPersistent*` engines default their declarer to the incident store on the same connection, so
  a persisted evaluation cannot name an unpersisted incident, and both write the `KillSwitch` they
  activated **before** the action row that names it, so a reader never sees a `kill_switch_id` with no
  switch behind it (ADR-0296). A recovery's `closeOut` is stored on the action row, set iff the decision
  is `recovered` and refused in both directions (ADR-0297).
- **`incident-response`** — 5 SEV levels with SLA profiles, 7 incident roles, an 8-state
  incident lifecycle, runbook executions with per-step outcomes, blameless postmortems with
  prioritized action items, and customer comms carrying the GDPR 72h breach deadline. The timeline's
  11th kind is **`paged`** (ADR-0327), with `pagedTimelineMetadata` / `pagedTimelineMessage` as the one
  shape its three callers share: channel **kinds**, counts and the provider's own handle, and nothing
  from the finding — ADR-0310's rule, inherited because the note is read by the same people. The
  channel-kind pattern is the mechanical half of that: an address, a `+1555…` number, a `#channel` and
  a mixed-case routing key are structurally rejected, and the refusal names the *position, not the
  value*, since a rejected "channel kind" is exactly the thing that might be an address. Also owns
  the `INC-YYYY-NNNN` vocabulary (`formatIncidentId` / `parseIncidentId`), which
  `observability-runtime` re-exports, and `IncidentRecord.autoDeclaredFor` + `autoDeclaredForKey` —
  the `signal:subject` key an automated declarer declares under, which a restart looks an open
  incident up by (ADR-0294).
- **`incident-response-runtime`** — the pure `IncidentExecutor` over one incident's record:
  declare, assign/hand off roles, change severity, note, attach a postmortem, transition. Two
  rules carry the weight. `incidentTransitionBlockers` answers "may this move?" by building the
  candidate record and asking `IncidentRecordSchema`, never by re-listing its rules; and a target
  status back-fills the timestamps it *transitively* implies, because `mitigating → resolved`
  skips where `mitigatedAt` is normally stamped. `cancelIfUntriaged` is the only automatic exit —
  `triaged` needs the on-call roles assigned, so no scheduler can resolve an incident. Plus
  `assessIncidentSla`, which scores an *open* incident against the wall clock (the contracts
  helpers only answer for targets already reached). Also the `IncidentDeclarer` seam (ADR-0293) —
  "who chooses an auto-declared incident's id and whether the record outlives the process", and
  answers "which open incident did this signal already open?" — with `CountingIncidentDeclarer` as the
  offline implementation, which finds nothing because nothing it declared survived. `findById?`
  (ADR-0327) is the third question: *what grade was this incident declared at?*, which is what lets a
  resolve route where its trigger did after a restart. Optional on the seam, following
  `PageChannelSender.resolve?`'s precedent, and absent/`null` mean the same thing to a caller —
  nothing to resolve, leave the alert for a human. `notePage` appends a `paged` entry and changes
  nothing else, and is callable on **any** status including `closed` and `cancelled`, because a
  resolve's note arrives *after* the close-out and refusing on a terminal status would drop precisely
  the note that says the alert was closed.
- **`incident-response-runtime-pg`** — `meta.incidents` as the store, with ids allocated from
  `MAX(sequence_number) + 1` under an advisory lock (so a restart continues the year's sequence),
  a `revision` guard on every write, an append-only timeline the engine enforces before any SQL,
  and a replayer that **re-parses** each row — the only way to catch a row edited into a state the
  contract forbids but a CHECK constraint permits (ADR-0289). `insertAllocated` holds that lock
  across the allocation *and* the insert, so two declarations in flight cannot be handed one sequence
  (ADR-0293), and `PostgresIncidentDeclarer` is the store-backed declarer the SLO engines use.
  `findOpenFor` answers hydration's question from `auto_declared_for` (ADR-0294). Also the three stores
  that are **still** dead — `PostgresRunbookExecutionStore`, `PostgresPostmortemStore`,
  `PostgresCustomerCommsStore` (ADR-0296) — each with its own revision guard, since a postmortem edited
  by two people over days was last-writer-wins. ADR-0296 resolved the *tables* (they had no
  business-key column, so a record could be written and never looked up) and said in its own last
  follow-up that nothing exposes these records over HTTP; the *records* have never been written, and
  ADR-0336 declares why, per store, rather than wiring them. **There is no incident lifecycle surface
  in the deployed binary at all** — no `/incidents` route anywhere, and `PersistentIncidentEngine` is
  constructed only by `PostgresIncidentDeclarer`, which calls `declare` / `findOpenFor` / `load` /
  `cancelIfUntriaged` and never `assignRole`, `changeSeverity`, `note`, `transition` or
  `attachPostmortem`. Two consequences are live rather than theoretical: **`human_owned` is
  unreachable in every deployment**, since `cancelIfUntriaged` declines only when the status is not
  `declared` and reaching `triaged` requires on-call roles no route assigns, so ADR-0326's
  "an alert wrongly closed is silence" arm never fires; and **sev1 and sev2 incidents cannot be closed
  at all**, because `IncidentRecordSchema` refuses `closed` without a `postmortemId` for every
  severity with `postmortemRequired` — which is every grade the three escalators declare at — while
  the refinement above it refuses any status past `declared` for those grades without
  `publiclyVisible: true`, i.e. a status page this platform does not have. `declare → cancel` is the
  whole reachable lifecycle. `appendPagedNote` (ADR-0327) is the paged timeline
  note's writer and **never throws** — the page has already gone out and the incident is already
  durable, so raising would turn a successful escalation into an error — retrying a lost revision race
  three times before reporting `revision_conflict`. `findById` throws on an unparseable row rather than
  answering null: null means no row ever held the id, while a parse failure means one did and has been
  edited into a state the contract forbids and a CHECK permits (ADR-0289).
- **`dr`** — 5 DR tiers with RPO/RTO targets, replication topology, backup kinds, failover
  records, drills with finding severities, runbooks.
- **`dr-runtime`** — executes it: a `FailoverExecutor` state machine (plan → start →
  complete / fail / abort / revert), a `DrillExecutor`, and `assessDrReadiness` which scores
  replication lag, drill recency and runbook staleness into a breach report.
- **`dr-runtime-pg`** — persists failovers, drills and readiness reports; wraps the runtime
  and ships a replayer.
  **An upsert is guarded, and a refused write throws** (ADR-0333). The failover and drill stores
  wrote `ON CONFLICT (execution_id) DO NOTHING` on what the runtime uses as an upsert path, so a
  failover's plan was stored and its *completion* was not — and `assessDrReadiness`, fed the stale
  `record` JSONB, scored a deployment that breached **both** its RPO and RTO targets as
  `ready: true` with zero breaches. The `SET` list is **derived** by walking `FAILOVER_TRANSITIONS`
  and `DRILL_OUTCOMES` and diffing the executor's records either side of each edge, with the
  immutable complement asserted absent; `incident_ticket_id` is excluded because no edge writes it
  and a replayed write setting one would be a late rewrite of *why* the failover happened. Two guard
  clauses, because a bare `DO UPDATE` is the same defect inverted: the status is checked against the
  transition map (with the same-status case admitted explicitly, since `canTransitionFailover(s, s)`
  is false for every status and re-recording one state is a refresh of an observation), and
  `EXCLUDED.recorded_at >= table.recorded_at` refuses a stale write — a refusal rather than
  ADR-0330's per-column `GREATEST`, because the whole row is one observation and a `GREATEST` would
  leave older content stamped with a newer time. **The refusal throws**, which is what keeps the fix
  from reproducing the bug: `INSERT 0 0` from a refused `DO UPDATE` is byte-identical to the old
  `DO NOTHING`. `PostgresDrReadinessStore` deliberately keeps `DO NOTHING` — a snapshot is a
  measurement at a moment and its id is minted per assessment, so the conflict means "write this
  once" — pinned by a test so nobody "completes the sweep". The replayer was **structurally unable**
  to see any of it (all its issue kinds are intra-row, and a row left by `DO NOTHING` is a perfectly
  consistent *plan* row), so it false-*negatived* where ADR-0330's workflow replayer
  false-positived; it gained `projection_disagrees_with_record`, because a partial `SET` list makes
  that divergence reachable for the first time.
  **And every read names its scope** (ADR-0333): `listRecent`, `countSince` and `latest` took no
  scope argument at all, so as the table's owner — who bypasses RLS — they answered from whichever
  scope held the newest row. `latest()` returned another tenant's snapshot as the platform's
  readiness, and `dr-readiness.ts` scored drill *cadence* off other tenants' drills. The scope is a
  **required first parameter with no default**, because the defect was a read that could not name
  one and a default would let a caller go on not naming one; `scopeFilter` is strict here rather
  than `crypto-pg`'s inclusive form, since a platform drill is not evidence about a tenant's
  disaster recovery. Both call sites already had `config.tenantId` and passed it to everything else.
- **`feature-flags`** — 7 flag kinds, 10 targeting rule kinds with FNV-1a sticky percentage
  bucketing, a 9-stage rollout ramp state machine, 8-trigger kill switches with strict
  separation of duties, 17 evaluation reasons, and a 23-kind append-only change audit.
  **Nothing in the workspace evaluates a flag** (ADR-0336), and that is the disease behind both of
  this domain's callerless stores. Every ingredient is modelled and none composed — `isFlagActive`,
  `isFlagInEnvironment`, `parseDefaultValue`, `parseKilledValue`, `findActiveKillSwitch`,
  `chooseTargetingRule`, `computeStableBucket`, `FlagEvaluationSchema` — and no function anywhere
  takes a flag plus a context and returns a value. Proved mechanically rather than read: each of the
  17 `EVALUATION_REASONS` appears only in `evaluations.ts`, its own test, and the CHECK on
  `meta.feature_flag_evaluations.reason`, so `FLAG_EVALUATION_REASON_PRODUCERS` is a **total map**
  answering `"none"` seventeen times, with `stored_flags` / `declared_flags` reserved in the union so
  the product choice is expressible — `JOB_KIND_PRODUCERS`' shape, and `flagEvaluationIsImplemented()`
  is the one call that answers it. There is no *source* either: a flag has no manifest field, no CLI
  flag, no env var and no route, so a flag here is **neither a database record nor a deployment
  declaration but a modelled domain with no mechanism**. The sharpest part is on the store that *is*
  reachable: `KillSwitchLookup` has exactly one method, `findForIncident` — *which incident did this
  switch open* — and never *is this flag killed*, so the SLO loop's third enforcement action writes a
  row naming a `flag_id` whose flag row cannot exist and nothing ever asks. ADR-0333's class on a
  constructed store, which a callerless-store census clears on its first question.
- **`feature-flags-pg`** — Postgres stores for `KillSwitch` records, which the SLO loop writes
  when it rolls a flag back and reads back when a restart adopts the incident (ADR-0296), and for
  `FeatureFlag` itself — the table was declared in Phase 1, never written, and had drifted 18 columns
  and 3 flag kinds behind its contract before anything tried (ADR-0300). Scoped
  conditionally, because a kill switch may be platform-wide or tenant-scoped; `loadForIncident` throws
  on two rows rather than picking one, and the active predicate uses the database clock so a drifted
  worker cannot serve a lapsed override as live.
  **`FEATURE_FLAG_COLUMN_NAMES` has to name what the catalog declares, and a test now asserts that**
  (ADR-0332): the list said `default_value`, which ADR-0308's rename machinery had moved to
  `default_value_json` — so `PostgresFeatureFlagStore` could not round-trip a single flag against any
  real database while every offline test passed, since a fake connection asserts SQL *shape* and
  cannot know a column does not exist. The same class as ADR-0331's signal store, and the reason the
  assertion is against `META_TABLES` rather than a second copy of the names.
  `targeting-rule-store.ts` (ADR-0335) is the writer `meta.feature_flag_targeting_rules` never had, so
  a flag read back from the database no longer round-trips `ftr_…` ids pointing at nothing and is
  **resolvable** against its own targeting — resolvable and not *evaluable*, because resolving a
  flag's rules and evaluating the flag are different steps and ADR-0336 found only the first exists.
  `flag_id` is TEXT referencing `meta.feature_flags(flag_id)`
  (`CASCADE`), not the UUID surrogate, because the contract's own id is what a rule names.
  **Nothing constructs it** — not a route, not a scheduler, not `node.ts`; only its own test. The
  reasoning for shipping no route is sound (a rule changes what the deployment serves, so it is at
  least `config`-grade and would need `--notification-template-routes`' four-eyes apparatus,
  ADR-0313) but the consequence is that this store is the ADR-0333 class in a new place, and the
  increment that added it **moved** the defect rather than closing it: before, the table had no store
  and `pg-storeless-tables.ts` named it; now the table has a store and the census no longer reports
  it, while no caller exists. See *What's actually left* — the storeless rule's inverse is unfenced.
- **`deploy`** — apps × 4 environments × 4 strategies, artifact kinds, migration records,
  release channels, on-prem/BYOC packaging (Helm/Terraform).
  It also ships **a second, complete feature-flag subsystem** (ADR-0336) and has **zero importers**,
  which is the `api-gateway-pg` condition before ADR-0335. `src/feature-flags.ts` holds the
  workspace's only `evaluateFlag()`, with its own 4-member `FLAG_KINDS` against
  `@crossengin/feature-flags`' 7 (a strict subset), its own `TargetingRuleSchema`, and a `hash*31`
  bucket rather than FNV-1a — **six colliding exported names** across the two packages
  (`FLAG_KINDS`, `FlagKind`, `FlagVariant`, `FlagVariantSchema`, `TargetingRule`,
  `TargetingRuleSchema`). So the workspace has two incompatible flag vocabularies under one set of
  names, and the one with a working evaluator is the one nothing imports. Which of the two is the
  real model is a product decision, not a wiring step.
- **`edge`** — region routing strategies, per-route latency budgets and percentiles,
  autoscaling policies with signals and decisions, edge cache strategies, throttling
  verdicts, region affinity.
- **`active-active`** — multi-region active-active topology, 7 consistency levels, vector
  clocks, 6 CRDT kinds (G/PN counters, OR-set, LWW register/map, MV register), conflict
  detection + resolution, split-brain lifecycle and healing.

### Audit, compliance and evidence

- **`forensics`** — hash-chained tamper-evident logs rooted at a genesis hash, evidence with
  sealed/retention/destruction lifecycle, chain of custody with sha256-verified transfers,
  legal holds with separation of duties, e-discovery requests, court-admissible
  attestations.
  **`ChainCheckpoint.provenance` is the fact a bounded verification rests on** (ADR-0371), and the
  one place that decides what it buys is `CHECKPOINT_PROVENANCE_ANCHORS_A_BOUNDED_PROOF`, a total
  map so a fourth provenance is a compile error rather than a value inheriting whichever answer an
  `if`-chain ended on. `checkpointAnchorsBoundedProof(provenance | undefined)` is the only reader a
  caller wants: it answers `false` for **absent** as well as for `unverified`, because a prefix
  nothing can vouch for is not a prefix to trust — and the two stay distinct in the data for
  ADR-0331's reason, since `unverified` is a row *stating* that nothing checked it while absent is a
  row that does not cover the question, and the remedies differ. A caller that must tell them apart
  reads `provenance` itself, which is why the function takes the optional value rather than
  collapsing both into one input.
- **`forensics-pg`** — the append-only chain in Postgres: an advisory-lock-serialized chain
  log writer, Ed25519 entry signer, chain-suffix verification and periodic checkpoints.
  `appendWithin(tx, …)` appends into a caller's transaction, so a record and its anchor
  commit together (ADR-0286). **Every read carries its own scope predicate** (ADR-0331), beside RLS
  rather than instead of it, because a table's owner bypasses its policies and connecting as the owner
  is an ordinary deployment: with no predicate, `loadChain(null)` returned a *tenant's* entries
  interleaved with the platform's and `tailWithin` handed the tenant's first-ever entry
  `sequence_number = 1`, having seen the platform chain's `0` as the global maximum — so every scope's
  `priorEntryHash` came from another scope and `verify()` reported a gap on healthy data. Observed
  live as the owner. `scopeFilter` **branches** (`tenant_id = $1` / `tenant_id IS NULL`) rather than
  using `tenant_id IS NOT DISTINCT FROM $1`, which is the one operator matching NULL to NULL and would
  give a single code path: measured against 45k entries it is **not indexable** — 16 ms sequential scan
  versus **0.09 ms** index scan — and this read runs on *every append*, to find the tail, against a
  table that only grows. A platform append also sets `app.platform_audit_write`, transaction-locally,
  for the `INSERT`-scoped policy that is now the only route to a platform-scope entry.
  **`scopeFilter` is the idiom the rest of the repo copies** — ADR-0333 swept it into fourteen
  store classes across seven packages, with a strict and an inclusive spelling chosen per table.
  Six copies exist for want of a shared home; it belongs in `kernel-pg`'s `connection.ts`.
  **A checkpoint carries the provenance of what verified its prefix, and the store will not promote
  one** (ADR-0371). `PostgresChainCheckpointStore.record` binds the column and `READ_COLUMNS` — one
  constant feeding `latest`, `getBySequence` and `listRecent` — carries it back, so all three read
  paths answer with it. `ON CONFLICT (tenant_id, sequence_number) DO NOTHING` stays, and after this
  it is a **security property** rather than append-only hygiene: a `DO UPDATE SET provenance =
  EXCLUDED.provenance` arm would let an `unverified` anchor become `verified_full` with nothing
  having verified the prefix, which is ADR-0371's own defect by another route and reachable by
  anyone who can write a checkpoint at all — a better-verified anchor is a **new** checkpoint at the
  new tail. `rowToCheckpoint` hands a stored value this binary does not recognise to
  `ChainCheckpointSchema` to **refuse** rather than coercing it to `undefined`, because coercing
  would read a *newer* claim as the gap that means "predates the column" (ADR-0331 failing in the
  direction that launders an unknown claim into a known one). And `createCheckpoint` **threads** the
  provenance and deliberately does not derive it, with the reason at the method: the class holds the
  whole chain in hand, so deriving `verified_full` there is tempting and would be ADR-0337's
  falsely-true control, since `verifyChainIntegrity` compares a stored `priorEntryHash` against a
  stored `entryHash` and recomputes neither — and this class holds no keys by design, so that an
  auditor can read a chain it cannot write.
  **And `checkpointFromTail(tail, meta)` replaces `checkpointFromChain(entries, meta)`** (ADR-0371),
  which is the critical half of that increment: a caller that verified a chain holds the tail its
  verification covered and must anchor *there*, where one that re-reads the chain to find a tail
  anchors past it and stamps the entries appended in between as verified. `ChainTail` moved here from
  `chain-log-store.ts` for that reason — it is the *input to a checkpoint*, so the two must agree
  about what an anchor is made of — and the move was free, since it had zero external importers and
  `index.ts` re-exports both modules with `export *`. The emptiness refusal moved with it to
  `createCheckpoint`, the one caller that can meet it, because a `ChainTail` **cannot represent an
  empty chain** (`tailOfChain([])` is `null`) and the builder is left with no failure mode to forget.
  `createCheckpoint` survives for the caller holding no tail and reads **one row** rather than the
  chain; `CheckpointMeta.provenance` is required there, so that caller — the only producer of
  `unverified` — has to say it has nothing to vouch with.
  **Both ordered reads break a same-sequence tie newest-first** (`NEWEST_AT_ONE_SEQUENCE`,
  ADR-0371), because `UNIQUE (tenant_id, sequence_number)` does **not** constrain the platform
  scope: `tenant_id` is nullable, NULL means platform, and SQL treats NULLs as distinct, so
  `(NULL, 3)` twice is legal and `ON CONFLICT … DO NOTHING` never fires there. Found live — two real
  rows at one platform sequence, and the untiebroken `ORDER BY sequence_number DESC LIMIT 1` returned
  the **older** one 10 times out of 10. That is the fail-open order for the one column a bounded
  proof trusts its prefix on, so newest-first is a correctness fix: a later verdict about a sequence
  supersedes an earlier one and a mistake falls toward re-folding. Asserted on the recorded SQL,
  because the fake de-duplicates on `(tenant, sequence)` in its INSERT branch and so cannot hold the
  two rows the rule is about — slice 1's recorded-SQL-versus-round-trip argument in a second place.
  Append:

  **A refused row is part of the chain's verdict, not absent from it** (ADR-0373). `loadChain` and
  `loadFrom` answer `ChainRead {entries, unreadable}` through one private `readChain`, so the two
  cannot come to disagree about what a refused row is, and neither throws on one.
  `unreadableEntryVerdict(unreadable)` is the one place the precedence lives, applied as
  `unreadableEntryVerdict(read.unreadable) ?? verifyChainIntegrity(read.entries)` by both `verify()`
  and `verifyChainFromCheckpoint` — **unconditionally**, because a fold over a chain with a row missing
  is not a fold over that chain: `verifyChainIntegrity` walks the entries it was given, so a refused row
  reads to it as a `sequence gap`, which is a true statement about the array and a false one about the
  table and sends an operator to look for a deleted entry that is present and malformed. The sharpest
  case is the refused row at the **tail**, where what reads back is a contiguous genesis-anchored chain
  the fold pronounces `{valid: true, brokenAt: null}` — so without the precedence `verify()` calls a
  chain carrying a signature-breaking tamper healthy. `brokenAt` is the **first** unreadable row's
  sequence and the ordering belongs to the read's `ORDER BY sequence_number ASC` rather than to the
  function, which a test pins. `ChainSignatureVerdict.unreadable` is its own axis and
  `verifyChainSignatures(entries, resolver, unreadable)` takes it **required**, because
  `EntrySignatureResult` demands a `fingerprint` and the fingerprint is one of the columns whose
  unreadability lands a row there — reporting `""` for it would read as a value. `valid` is
  `allOk && unreadable.length === 0` while `checked` stays `entries.length`, which is ADR-0371's point
  about zero being a readable figure. One asymmetry is worth knowing: a verdict failing on this axis
  alone has `results.every(ok)` true, so a surface rendering `results` without reading `unreadable`
  reports a failure and names no cause — `formatChainVerification` names them for that reason.

  **And a refused *anchor* is too** (ADR-0374). `PostgresChainCheckpointStore`'s two **single-row**
  read paths — `latest` and `getBySequence`, not all three, which an earlier version of this sentence
  said and the next clause of the same sentence already contradicted — go
  through one private `readOne`, which parses and throws `CheckpointRowUnreadable` carrying the
  refused row rather than answering `null` — `null` is *no checkpoint for this scope*, which heals on
  the next scheduler pass, where a refused row **cannot** heal because `record` is
  `ON CONFLICT … DO NOTHING` so it stays where it is (ADR-0331's claim-versus-gap, inside a
  verification). `listRecent` answers `{records, unreadable}` instead, ADR-0373's **verifier** shape,
  because a checkpoint history is read to be checked. The error type is what lets
  `verifyChainFromCheckpoint` fold from genesis on this one cause and rethrow every other — anything
  else from `latest` is a read that did not happen, and a fold claiming to replace it would assert a
  verification over a scope whose anchor state is unknown.

  **And `scanCheckpoints` reads the whole table, because `latest` is one row** (ADR-0375). An
  ascending keyset scan over `(sequence_number, id)`, one read transaction, handing each page to an
  `onPage` callback as the pair above and returning only `{scanned, refusedCount, complete}` — it
  counts rows and refusals and says whether it finished, and holds **no** opinion about which
  sequences are witnesses, because it cannot check one (`highestReadableSequence` was there for one
  commit, had no reader, and was a second derivation of the figure `auditAnchors` folds with the
  exclusion applied). Three things about it are
  load-bearing. The **direction**: this table is append-only in sequence order for every writer in
  the workspace, so an ascending prefix is stable under appends while a descending one shifts — a
  descending scan stopped by its ceiling would leave the oldest rows unread and let a later append
  push a row out of reach, which is ADR-0374's burial at ceiling depth instead of at depth 1.
  Ascending, what a ceiling leaves unread is the newest tail, which `complete: false` names. The
  **`id` tiebreaker**, for `NEWEST_AT_ONE_SEQUENCE`'s reason one read across: two rows can share a
  platform sequence, so a sequence-only cursor would loop on the first or step over the second. And
  the **redundant-looking conjunct**: `sequence_number >= $1::bigint` beside the disjunction is
  implied by it and is *not* redundant to the planner — measured on PG 16.13 at page 100 of a scan
  over a 200k-row scope, without it the index condition is `tenant_id` alone and the disjunction is
  left as a `Filter`, so every page re-reads every row before the cursor (`Rows Removed by Filter:
  100001`, 22.2 ms a page, **4.86 s** for the 200-page scan, quadratic in the page count); with it
  the condition is `(tenant_id, sequence_number)`, 0.563 ms a page and **0.13 s** for the scan.
  `onPage` rather than a returned array is ADR-0367's `drainList` rule — the caller decides what it
  holds, and neither consumer holds a million checkpoints to produce one verdict.
  `listRecent`'s own prediction is **corrected** rather than fulfilled: it predicted "the caller this
  will gain is one computing a verdict", that caller arrived, and it could not use the method, because
  the shape it needed is ascending-with-a-cursor. The pair form it argued for is what `onPage` hands
  over per page, so the principle is exercised and the method is still callerless.
- **`access-reviews`** — periodic attestation campaigns (SOC 2 / ISO 27001 / HIPAA / PCI /
  GDPR / 21 CFR Part 11): campaigns, scoped items, decisions with attestation kinds and
  four-eyes, exceptions with per-reason duration caps, templates, sealed evidence with
  per-framework control mappings.
  **`DecisionAttestationSchema` orders the co-attestation and requires the phrase its kind names**
  (ADR-0362). It required `coAttestedAt` **by name** for `two_person_attestation` and then
  constrained only `coAttestingUserId`, so a four-eyes record with `coAttestedAt` in 2020 and
  `attestedAt` in 2026 parsed and stored — one of three `STRONG_ATTESTATION_KINDS`, temporally
  incoherent, in a record an auditor reads. That clause is worth having where the register's own
  proposal was not, and the difference is which operands have columns: `co_attested_at` is real,
  bound and read back, so the clause binds **stored** rows, while `attestedAt === decidedAt` could
  never fire for one because `rowToDecision` fills both from `decided_at`. It cannot be a CHECK for
  two reasons and the decisive one is not the obvious one — required-ness depending on
  `attestation_kind` is true of the family, but *this* comparison's right-hand side has no column at
  all, so the nearest CHECK (`co_attested_at >= decided_at`) is a **different predicate** that
  agrees only because the mapper reconstructs the equality. The guard is `typeof x === "string"`
  rather than an explicit null check, which fences this increment's own class: `coAttestedAt` is
  `.nullable()` today, and `Date.parse(undefined)` is `NaN` with every `NaN` comparison false, so a
  later move to `.optional()` would silently turn the refusal into an accept.
  `typed_attestation_phrase` now requires a non-empty phrase — the kind whose name asserts one
  required none and stored none — and because `signDecisionAttestation` and
  `signDecisionAttestationWithStore` both end in `DecisionAttestationSchema.parse(out)`, one signed
  without a phrase is refused **before a signature is returned**. The clause is **coupled to the
  column** by necessity: with it and no `attestation_phrase`, such a row is writable and not
  readable.
- **`access-reviews-runtime`** — drives them: due-campaign scheduling and next-occurrence
  planning, item generation from live grants with reviewer resolution, overdue/past-grace
  detection, and auto-revocation planning for unattested items. `evidence-compilation.ts`
  (ADR-0335) composes a sealed `AccessReviewEvidence` pack from finished campaigns and their
  decisions, with six refusals (`no_campaigns` / `framework_mismatch` / `tenant_mismatch` /
  `campaign_unfinished` / `period_invalid` / `foreign_item`). `EVIDENCE_RATE_SCALE = 4` is
  load-bearing, and it is ADR-0332's `decimal` question read in the other direction:
  `computeCampaignEvidenceMetrics` divides, so 2 of 3 resolved items is `0.6666666666666666`, the
  schema accepts it, `computeEvidenceSealSha256` **commits to it**, and the `NUMERIC(5,4)` column
  then stores `0.6667` — so the digest is over figures the row does not hold and `verifyEvidenceSeal`
  fails against the stored record from the moment it is written, which is worse than no proof because
  it reads as one. The rates are therefore quantised **in the producer, before the digest**, and the
  store refuses one that is not; quantising at the store boundary is what ADR-0332 does for a
  computed `decimal` and is exactly wrong here.
- **`access-reviews-runtime-pg`** — persists campaigns/items/decisions, wraps the runtime,
  and ships a replayer.
  **`rowToDecision` parses** (ADR-0362), where it returned a bare object literal *typed as*
  `AccessReviewDecision` — which asserts conformance rather than establishing it, so **no clause had
  ever been checked on read** while its sibling `rowToEvidence` fifteen lines down does
  `AccessReviewEvidenceSchema.parse` and carries a comment saying *"a row edited into a shape the
  contract forbids is only caught here"*. The file held both the rule and its violation. This is the
  member of ADR-0362's class where the proper subset is not a narrower field list but **the type
  annotation standing in for the parse**. Measured afterwards: **9 of the 13** clauses are reachable
  from a stored row at all, and the primary four-eyes clause is **not** one of them —
  `decidedByUserId === attestation.attestedByUserId` reads both sides from the single column
  `decided_by_user_id`, so the mapper *reconstructs* the equality and no row can break it; the
  reachable four-eyes fence is the co-attestor's. **Not one existing test broke** when the parse
  landed, so this is fail-closed hardening rather than a bug-find, and the honest headline is
  reachability.
  `attestation_phrase` is bound and read, and **`attested_at` deliberately is not**. The asymmetry
  is the decision rather than an inconsistency: `attested_at` duplicates `decided_at`, which the
  sole live producer (one `nowIso`), this mapper and `EvidenceBundleDecisionRow` all treat as one
  instant — so storing it would invent a second fact nothing in the tree distinguishes — while the
  phrase duplicates nothing and is the only evidence `typed_attestation_phrase` carries. The
  mapper's fill of `attestedAt` from `decided_at` is a **declared** decision now, with its
  consequence stated: an authored `attestedAt` that differs is dropped, and a signature over the
  authored value cannot be recomputed from the row.
  `evidence-store.ts` (ADR-0335) is the writer `meta.access_review_evidence`
  never had: `certification.ts:177–199` read it with its exact column list, so the adapter answered
  `null`, the engine read that as *no evidence* rather than *not wired*, and `certifiable` was **false
  in every certification report ever produced**. `latestSealed` had no tenant predicate either, so as
  the table's owner tenant A's SOC 2 report read *satisfied at 100% citing tenant B's digest* — the
  owner-bypass class of ADR-0331/ADR-0333, in the one table a compliance claim is built from.
- **`certification-runtime`** — runtime-only (no contracts sibling): a control catalog
  mapped to frameworks, evidence adapters that pull real signals from other packages
  (encryption coverage, DR readiness, forensic chain integrity, access-review completion),
  per-control and per-framework assessment, and a sealed, hash-verified certification report.
- **`certification-runtime-pg`** — persists those reports and wraps the engine. Thin.
- **`data-lineage`** — the provenance graph for GDPR Article 15: 14 node kinds × 10 edge
  kinds with classification propagation rules (pii → public only via `anonymized_from` with
  k≥5), provenance records, a sha256-only data-subject registry, subject access requests,
  graph traversal (ancestors/descendants/path/cycle), retention policies and sealed evidence
  packs.
- **`ml-training`** — opt-in training consent (phi/regulated permanently forbidden),
  datasets with redaction strategies, eval sets where safety-refusal must pass 100%,
  training runs, evaluations, and a model registry with shadow → canary → production
  lifecycle.

### Presentation, search, integration

- **`views`** — frontend renderer contracts: 8 view kinds (list, record, form, kanban,
  calendar, map, dashboard, pivot), columns with render hints, filter operators,
  permissions, theme, widgets.
  **`PermissionRefSchema` carries no `abac` key** (ADR-0361). An obligation is a qualifier something
  has to *discharge*, and the only surface that discharges one is the entity grant path —
  `surveyAbacObligations` walks `manifest.permissions` and nothing else, which is what ADR-0340's boot
  refusal is built from. A key here would be an obligation no deployment could discharge *and* no boot
  check could see: approved by a reviewer, hashed into `manifestHash`, and served with its qualifier
  silently removed. Deleted rather than surveyed because the measured count of views declaring one is
  **zero**, and because a view's permission declaration is served by nothing at all today — modelling
  an obligation on an unserved surface is a trap for an author rather than a capability. The `roles`
  half stays: it is validated against `manifest.roles` and a boot survey reports that this deployment
  does not read it.
- **`i18n`** — locales (11 on the roadmap, incl. RTL Arabic variants), ICU MessageFormat
  parsing, CLDR plural categories, bundles, resolution chains, calendar/numbering systems,
  per-tenant config.
- **`search`** — Typesense/pgvector-style contracts: index manifest, 4 search kinds, facets,
  permission tags, embedding models and vector index kinds, reindex jobs.
- **`reporting`** — 7 report kinds (tabular, pivot, timeseries, kpi, funnel, cohort,
  custom), aggregations, dashboards on a grid layout, schedules and exports, ClickHouse
  audit sink, CDC pipeline health.
  **`BaseReportSchema` has no second `abac` field** (ADR-0361). There was one beside `permissions`,
  and it was three things at once: a **duplicate** of `permissions.abac` with no rule for which wins,
  **unbounded** where the authoritative spelling is `max(MAX_ABAC_POLICY_KEY_LENGTH)`, and read by
  **nothing** — zero readers in the workspace, zero reports declared in any pack. Deleted on
  `PermissionRefSchema`'s argument at the same cost of zero. The obligation a report *can* still carry
  is its `permissions: RbacGrant`'s own, which no survey walks and which `checkAbacObligations` now
  reports rather than claiming absent — as it does for `DashboardDeclaration.permissions`, the
  position nobody had named.
- **`notifications`** — 6 channels × 18 providers (email/SMS/push/voice), templates with
  typed variables, audiences and on-call rotations, preferences and suppression reasons,
  and dispatch/delivery audit with retry, throttle, digest and quiet-hours decisions. Also the
  consent-vs-deliverability split: `UNCONDITIONAL_SUPPRESSION_REASONS` are the reasons a
  non-suppressible category does *not* override, because a hard bounce is not a preference (ADR-0302).
  **A non-suppressible category cannot be opted out of by anybody** since ADR-0335: the refusal was
  conditioned on `source === "user_set"`, so an `admin_set` or `system_default` row could switch off
  the one category that overrides consent. The check is on the category alone now, in one place that
  `computeDispatchEligibility`'s consent arm reads.
  Plus (ADR-0309) per-user **read state** — a row per notice opened *and* a per-viewer watermark, because
  only a watermark can answer for notices the reader was never shown, which is what a go-live backfill
  needs; per-user **quiet hours**, where the timezone is the user's while the window may be the tenant's
  (a tenant window of 22:00–07:00 silences a Tokyo user during *Tokyo's* night, a different absolute
  interval — a window is a statement about the recipient's night) and which **fails open** to no policy,
  because quiet hours only ever delays and never-sending is the worse failure; and `dispatchDedupHash`
  over canonical sorted-key JSON through an injected hasher, byte-identical in behaviour to
  `canonicalAuditEntryPayload` because `JSONB` does not preserve key order.
- **`notification-providers`** — the impure senders behind `ChannelSender`: `SesEmailSender` (SES v2,
  real SigV4 from `@crossengin/crypto`), `TwilioSmsSender` (form-encoded, Basic auth), `FcmPushSender`
  (FCM HTTP v1, with an injected `FcmAccessTokenProvider` — minting the token is a private key, a second
  endpoint and a refresh cache, none of which belongs in a pure client), `TwilioVoiceSender` (the same
  Account/credential/error vocabulary as SMS, imported rather than restated), and the bounce parser that
  turns an SES or Twilio event into planned `SuppressionRecord`s — it plans, and writes nothing, and it
  attributes each row to `provider:<source>`. Zero runtime deps, injectable `fetch`, endpoint overrides
  for VPC endpoints and proxies. **`twilio_voice` is the third bounce source** (ADR-0329), and the
  boundary is *not* "will it recur" — almost everything recurs — **it is whose fact it is**: a
  permanent code is a statement about the *destination* (`13224` invalid destination, `21214`
  unallocated, `13225` Twilio forbids calls to this number) and a transient one is about *us* or the
  moment (`21216` our account may not call it, `21219` an unverified trial number, `21210` a `From` we
  do not own) and produces **nothing** rather than a bounded soft row — `soft_bounce_exceeded` means a
  threshold was *crossed*, needs state a pure module lacks, and is itself unconditional, so a bounded
  row would outrank a `security_alert` for its whole window and keep blaming the callee after the geo
  permission was enabled. `13225` vs `21216` is the pair that makes the rule concrete: near-identical
  English, opposite sides. `busy` and `no-answer` suppress nothing and are checked **before** the code
  table so a code riding along cannot route around them — the line is live, a handset is on it, and
  `hard_bounce` is unconditional on the channel an on-call rotation reaches a person by. Every voice
  code maps to `hard_bounce`, which is itself a finding: a callee cannot reply STOP and there is no
  voice FBL, so no voice code can ever mean `unsubscribe` or `spam_complaint`. A third source rather
  than a branch inside `twilio` because the two callbacks are different documents suppressing on
  different channels, and the path segment is the deployment's declaration of which sender it
  configured — declared beats probed, ADR-0328's rule. The SMS reader also stopped failing open: an
  unknown `MessageStatus` is `payload_unrecognized`, not "not a failure", since the latter asserts
  knowledge of a status it has never seen. The **`fax` verdict** suppresses on a *run* since ADR-0332 —
  the parser still plans nothing from a single one, and the run is counted in
  `meta.notification_fax_observations` by the server, so the pure module stays pure.
  **A push payload may not vary with the notification's content**
  (ADR-0310): everything sent is either a notice the deployment declared at construction or an identifier
  already on the `SendRequest`, `pushPayloadViolations` checks that on every send, and `send` refuses
  without calling FCM — so a composer that reaches for tenant data is a failed delivery, not a
  lock-screen disclosure.
  Also the **page transports** (ADR-0325), which are deliberately *not* the notification senders:
  `PagerDutyPageSender` (Events API v2 — needs no configuration, because the `routing_key` **is** the
  credential and the alert policy already carries it as `serviceKey`, with `dedup_key` = the incident id
  so re-paging updates one alert), `SlackPageSender` (`chat.postMessage`, because an incoming webhook is
  bound to one channel and so could not obey the policy's), `WebhookPageSender` (HMAC over
  `timestamp.body`, the same scheme as the bounce webhook, refused at construction if the secret is under
  16 bytes), `SmsPageSender` (ADR-0326, its own `PAGE_SMS_*` credentials rather than the notification
  stack's `TWILIO_*`, because a deployment may well page from a different number than it messages
  customers from), and `PageDispatcher` over them. **A page is not a notification and must not travel as
  one:** the notification stack exists to *withhold* delivery — preferences, suppressions, quiet hours —
  and a `sev1` is the one thing none of those may apply to, so `email_digest` is reported `unroutable`
  rather than adapted. `PageContent` is three fields (incident id, severity, a deployment-declared
  `signal`) and nothing from the finding, which names a tenant and a tombstone — ADR-0310's rule on
  another surface. Six dispositions, every channel attempted even if one throws, and
  `delivered === 0` is `undelivered`: logged at error, never thrown, because the incident is already
  durable and a throw would make a successful declaration look like a failed escalation.
  **And a page closes itself** (ADR-0326). `resolve` is optional on the sender contract and
  `PageDispatcher.resolve` fans out over the same channels through a shared `fanOut`: PagerDuty closes
  the alert on the same `dedup_key`, while a Slack message and a webhook POST cannot be unposted and
  report `unsupported`, which is not a failure (so an all-`unsupported` resolve is not `undelivered` —
  `asked` excludes it). **The retry is the dispatcher's, not the senders'**, because only it sees the whole
  fan-out and can bound the latency in front of somebody waiting to be woken: three attempts two seconds
  apart by default, `attemptsMade` on every outcome, and `failed` the *only* retryable disposition — a
  `rejected` is a decision, and retrying collects it again at the one moment the attempts matter.
  `classifyPageFailure` is shared by all three HTTP senders because each had classified **429** as
  `rejected`, which is the never-retried set, for the most ordinary transient failure a provider emits.
  **The gap grows and jitters** (ADR-0328): exponential from the configured delay, jittered *upward*
  over `[gap, gap × 2)` — not full or equal jitter, which decorrelate by spreading *below* the delay
  and so re-open the hot loop ADR-0327's floor exists to stop — and stopped when the next wait would
  exceed a total budget (30s default, 60s ceiling). The failure it answers is several replicas of one
  process retrying one degraded provider in lockstep, which no single deployment can see and so none
  would configure; `waitedMs` on every outcome makes the waiting legible afterwards, and with
  `attemptsMade` and `retryAfterMs` beside it separates the three ways a retry stops.
  **And the retry honours `Retry-After`** (ADR-0327, `retry-after.ts`): both RFC 9110 forms, with the
  wait `max(policy.delayMs, retryAfterMs)` — the policy's delay is the platform's floor, so a
  `Retry-After: 0` cannot become a hot loop, and the provider's figure is the floor when longer — and a
  request beyond `MAX_RETRY_AFTER_MS` (30s) **stops** the retry rather than holding a page past the
  point where it is still a page. The numeric-shape guard is load-bearing, not theoretical:
  `Date.parse("-5")`, `("+5")` and `("1.5")` all answer a date in 2001, so without `/^\d+$/` first a
  malformed delta became a decades-long wait.
  `fcm-token.ts` (ADR-0327) is the `FcmAccessTokenProvider` ADR-0310 left as a seam: an RS256-signed
  JWT assertion exchanged for a short-lived access token, cached until 60s *before* expiry (a token
  lapsing between the check and FCM's receipt is a 401 indistinguishable from revocation), with
  concurrent callers awaiting one in-flight mint and a rejection never poisoning the cache. It refuses
  at construction, and an **EC** key is one of the refusals — it passes every textual check and
  `createSign("RSA-SHA256")` signs with it anyway (the name selects the digest; node takes the
  algorithm from the key), producing a valid ECDSA JWT that Google rejects as `invalid_grant`. No error
  message may contain key material. `FcmPushSender` now reports a **non-retryable** mint as `dropped`
  rather than letting it propagate as `failed`, because a permanently-wrong service account was
  otherwise indistinguishable from a 5xx blip and the dispatch was retried forever; and a credential
  FCM itself refuses is discarded from the cache, via one `fcmRefusedTheCredential(status, code)` with
  two readers — deriving it from the resulting `errorCode` was wrong and a test caught it, since the
  code carries the provider's status suffix so `PERMISSION_DENIED` yields `fcm_permission_denied`.
  `metadata-token.ts` (ADR-0328) is the **other** FCM credential route — GKE/Cloud Run workload
  identity, where there is no key file and the *network position* is the credential. Plain `http://`
  to a link-local address is correct rather than a mistake (no CA can certify
  `metadata.google.internal`) and a test pins it so nobody "fixes" it; `Metadata-Flavor: Google` is
  built in one function every path calls, because Google requires it specifically so a
  confused-deputy request cannot reach the server; an endpoint override allows https anywhere but
  plain http **only** for the known link-local hosts. It shares `fcm-token.ts`'s clock and expiry
  skew so the two age tokens identically and nothing else. The sharp distinction is **not on GCE**
  (`metadata_server_unreachable`, dug out of undici's nested `cause`, *not* retryable, and its message
  says to supply a key file) from **on GCE and refused** (`service_account_not_attached`, an IAM
  problem) from a **timeout**, which is its own kind and *is* retryable — a silence cannot tell them
  apart and the mistakes are not symmetric: calling a wedged node terminal drops a notification,
  calling an unroutable address retryable only delays one.
- **`pwa`** — PWA manifest, service-worker cache strategies, IndexedDB outbox with
  conflict strategies, background sync, push (PHI-safe), Capacitor native wrapper config.
- **`integrations`** — thin: 12 integration kinds (outbound/inbound HTTP, GraphQL, HL7,
  FHIR, EDI, SFTP, webhook), credential refs, HMAC signature and retry policy shapes, and
  integration-call audit records.
- **`migration`** — data onboarding: 12 source kinds (CSV, JSONL, Parquet, Salesforce,
  ServiceNow, SQL dumps, HL7 v2, FHIR R4 …), schema inference with semantic hints, field
  mappings with transforms, preview/dry-run with row validation, an idempotent backfill
  ledger, and a staged onboarding flow.

### Developer / partner surface

- **`sdk`** — the public API contract: version negotiation with Sunset/Deprecation headers,
  scopes, operation catalog, RFC 9457 errors, cursor pagination, idempotency TTLs, webhook
  events and HMAC-SHA256 delivery signing.
- **`sdk-clients`** — client generation contract: 10 target languages × 10 registries × 3
  support tiers, generator pipeline and naming conventions, semver release lifecycle with
  security advisories, compatibility matrix, auth + retry helpers, and client telemetry with
  W3C trace context.

### Apps

- **`apps/architect-cli`** — **one-shot CLI** (`crossengin` binary). Subcommands `init`,
  `validate`, `diff`, `patch`, `hash`, `apply` (dry-run emits the full meta-schema SQL; live
  mode runs the migration applier), `chat` (multi-vendor Architect chat with tool dispatch,
  human-in-the-loop write approval and optional Postgres transcript), `license`, `version`,
  `help`. Every subcommand takes `--format human|json`; exit 0 / 1 / 2.
  **`apply` re-plans after a clean pass** (ADR-0331), because "executed 9, failed 0" is a report about
  what ran and an operator reads it as a claim about the schema. A step can only be planned against the
  schema as it was *before* the pass, so a plan does not always converge in one — found live, reporting
  `failed: 0` with a CHECK still missing. `remaining.statements.length === 0` on the JSON payload is the
  convergence claim, defaulting to `null` so absent cannot read as yes, and `standingDifferences`
  decides which of the two plans may be *printed*: rendering the pre-apply plan afterwards announced
  "1 statement(s) to apply" about work the same invocation had just done.
- **`apps/operate-server`** — **long-running process**, the deployed serving binary and the
  largest app (80 modules). A Node `http` listener over `buildOperateGateway` plus a
  framework-neutral `dispatch` core with a Fetch/Workers edge adapter — **both** now enforce one
  configurable request-body cap (`--max-request-body`, default 10 MiB, floor 1 KiB, ceiling 1 GiB, refused
  rather than clamped out of band, enforced per chunk as the body arrives; ADR-0312), where previously the
  Fetch path had none. Loads a builtin pack
  or a manifest file (optionally per-tenant manifests with an activation poller, each tenant's own
  manifest provisioned into its own schema before its gateway is compiled — ADR-0314), serves
  from the in-memory / JSONB / column-mapped store, and wires in: API-key and JWT auth with
  local or remote JWKS and a background refresh poller; the hash-chained audit log with
  checkpointing and chain verification; notification delivery (planning, throttling,
  digests, drain loop) over senders built **from the environment** — `in_app` always, plus SES and
  Twilio when fully configured, since all but the sender identity are credentials and argv is readable
  via `ps` (ADR-0301) — with `--bounce-webhook` closing the loop by recording provider bounces as
  suppressions, verified against the platform's own HMAC on the raw bytes in front of the gateway,
  under a per-tenant key derived from `NOTIFICATION_BOUNCE_SECRET` (ADR-0302);
  **template authoring** (`--notification-template-routes`) with three fail-closed grants — author,
  approver (four-eyes at three layers, the store's `UPDATE` carrying `created_by <> $actor` as a
  predicate so a race cannot land one), and a separate grant for non-suppressible categories — which
  **refuses** unsafe authored content rather than storing it, because a template body reaches a browser
  as markup and `z.string().url()` accepts `javascript:alert(1)` (ADR-0313) — and whose five status
  transitions **all raised at the database until ADR-0370**, escaping as unclassified 500s: the
  parameter array fixed the actor at `$5` while only the approval arm referenced it, so four
  transitions bound a parameter their statement never mentioned (`08P01`, `42P18`) and the fifth put
  one parameter into both `approved_by` (then UUID) and `created_by` (TEXT), which pinned it to text
  and raised `42804`. The actor is bound **on demand** and **twice** in the approval statement now —
  two bindings of one value cannot pin each other's type — and the surface records the four-eyes
  attribution it exists for (`created_by=…a001 | approved_by=…a002`) for the first time;
  the **read-only audit trail** (`--audit-read-routes`) whose reads are themselves recorded, where an
  unrecordable granted read is a 503 and a tenant naming another tenant is a 403 rather than a quietly
  narrowed query (ADR-0313); **job-run cancellation** (`POST /v1/meta/jobs/runs/{id}/cancel`, gated on the
  job-invoke roles, tenant from the credential, outcome reported as 200/202/409/404 — ADR-0315);
  the **GDPR Article 17 deletion flow** (`--tenant-deletion-routes`) — the only route that reaches
  `deleted`, which `platform-admin`'s transition map excludes on purpose; its own grant separate from
  the erasure's (erasing a schema is a step this contains), four-eyes at three layers, and the **only**
  route here that *requires* an idempotency key, because a retried delete generates a new tombstone id,
  erases nothing the second time and would 409 `scope_empty` for a request that had already succeeded.
  The tenant row is retired **after** the pipeline commits — ADR-0316's ordering, whose stated reason
  (*the anchor references `meta.tenants`*) **no longer holds**: ADR-0335 removed `TENANT_FK` from
  `meta.audit_log` and from every other table in that path, and the catalog still carries a stale
  comment above that column claiming *"the foreign key stays"* one line above the inline comment
  saying it was deliberately removed — and **two further comments cite the same vanished key**,
  `tenant-deletion-routes.ts:33` (*"the tombstone's chain anchor references `meta.tenants`"*) and
  `deletion-pipeline.ts:427` (*"because the audit record's `tenant_id` references it"*), measured
  against the built catalog where `audit_log.tenant_id` and all seven platform-record tables carry
  `references: null`. So inverting the order is *available* as far as the foreign keys go, and it is
  what would close the write window between the confirm-absence pass and the commit — **but there is
  a second constraint on it that nobody had named**, and it is the reason the ordering cannot simply
  be swapped: the pipeline reads `fromState` from `meta.tenants` *inside* the transaction before its
  first destructive statement, and retirement is `UPDATE … SET status = 'deleted'` rather than a
  `DELETE`, so the row survives and retiring first makes `fromState` read `deleted` instead of the
  real source state. Any inversion must capture `fromState` before the retire. The ordering is kept
  for now rather than defended. A failed retire is `tenantRetired: false` on a **200** rather
  than an error that
  implies the deletion did not happen, and the body carries the tombstone receipt — digests, anchors,
  chain coordinates — since a bare "deleted" would be ADR-0317's defect in response form (ADR-0320);
  the **asynchronous half of that flow** (`--deletion-request-routes`, `--deletion-runner-ms`) — submit /
  verify / reject / poll over `/v1/platform/deletion-requests` so a caller holds a *handle* rather than an
  open connection, with the request id generated server-side (a caller-chosen one that collided would hand
  back another tenant's request), the Article 12(3) deadline computed from the deployment rather than
  accepted from the body, a verifier who may not be the submitter, and a scheduler that deliberately does
  **not** sweep at boot — unlike every sibling scheduler here — because a boot is when a misconfiguration
  is most likely and this work destroys a tenant's data irreversibly (ADR-0321); and the **repair** of
  what a failed run stranded (`--deletion-request-reconcile-role`, `--deletion-stranded-after-ms`) —
  `GET .../stranded` lists every `in_progress` request with its verdict beside it and
  `POST .../{id}/reconcile` resolves one, where the caller asks for a resolution and never supplies the
  answer: the body's only field authorises applying the inference from an *absence* of evidence, never
  choosing it, so a verdict that was not applied answers **409** rather than a 200 that would read as
  resolved. The scheduler's tick repairs the conclusive half in a separate `try` (the likeliest reason a
  request is stranded is that a run failed) and logs **only what it wrote**, since an unapplied verdict is
  a standing fact that would otherwise be repeated every tick (ADR-0322); plus
  `GET .../unproven`, the audit of *completed* requests whose proof no longer stands up — findings only,
  recorded against the reader's own tenant and **refused** when none resolves (ADR-0313), and recorded
  even when clean, because "we checked and found nothing" cannot be claimed from the absence of a log
  line (ADR-0323) — and both directions **escalate** (`--deletion-escalation-config`), declaring a paging
  `sev1` for the one tamper class the forensic chain is structurally unable to raise, **one incident per
  request** (`findOpen` on `deletion_evidence:<requestId>`, so a three-second scheduler adopts rather than
  re-declares), cancelled when the evidence is put right, and with **no fallback declarer** — the opposite
  of the integrity escalator's choice, because this finding is re-derived every tick and so is retried
  rather than lost (ADR-0324) — **graded per defect** and leaving its own anchored row since ADR-0326,
  with `--deletion-audit-every-ticks` putting `auditCompleted` on the scheduler;
  **tenant-schema erasure** (`--tenant-erasure-routes`) — a read-only survey route so a destructive act
  is not approved blind, then a drop whose `executedBy` is the credential and whose `approvedBy` is the
  body and must differ, with the tenant id repeated as `confirmTenantId` so an irreversible action is not
  one mistyped path segment away; an erasure that succeeds and cannot be recorded returns **500
  `erasure_unrecorded`** with the scope and an instruction not to issue a tombstone from it, since a 200
  would license a proof with nothing behind it and a 503 would read as "nothing happened" (ADR-0316),
  and whose 200 carries the erasure as a ready-to-paste `DeletionAttestation` so the handoff to the
  tombstone assembler is not a transcription (ADR-0317);
  the four read-only
  audit-integrity verdict routes (`--audit-verdict-routes`, ADR-0303); the in-production AI Architect
  (`--ai-design`, local provider first — ADR-0306) with a
  budget guard, design jobs, and a design-review approval gate; access-review campaign
  lifecycle; certification reports; DR readiness; SLO evaluation; usage metering and Stripe
  usage sync; marketplace admin/authoring; platform-tenant administration; residency
  routing; **live SLO enforcement** (`--slo-config` / `--slo-defaults`) which over a Postgres store
  persists every evaluation, every enforcement action and the declared `IncidentRecord` itself, one
  declarer shared by both signals, and warns at boot when it has no store (ADR-0293); and background
  schedulers for jobs, pruning, checkpoints and the **audit-integrity proof** (`--integrity-proof-config` — runs row↔anchor *and* chain link/signature verification
  per tenant, plus a checkpoint-witnessed truncation check, and records the verdict in the
  chain, and with an `escalation` block declares a `sev1` incident + pages once per
  compromised episode, recording it as an anchored `audit.integrity_compromised` row and
  persisting the `IncidentRecord` in `meta.incidents` — cancelled on recovery unless a human
  has triaged it; ADR-0287, ADR-0288, ADR-0289). **`includePlatform` defaults to `true`** on both
  `--integrity-proof-config` and `--checkpoint-config`, and the two are flipped together (ADR-0332):
  one without the other would be wrong rather than merely partial, since the truncation check has no
  witness without a checkpoint (ADR-0287) — and with platform-scope rows now reachable (ADR-0331),
  defaulting them *out* of verification would mean the newest trail in the system was the one nothing
  checked. **The verdict row is written now** (ADR-0333): `recordVerdict` appended a chain entry and
  never touched `meta.audit_integrity_verdicts`, so the store's `record()` was called by nothing but
  its own unit test, the table was empty in every deployment, and every `--audit-verdict-routes`
  answer was truthfully "no verifications" about a verification that had run every hour. Both halves
  of the anchor come from the entry just appended (ADR-0318: half an anchor is worse than none) —
  the seam was never missing, the callback discarded `entryHash` and returned only the sequence. The
  write is **reported, never thrown**: the chain entry has committed, so raising would turn a
  successful verification into a failed pass to protect a projection of it. Under the same flag
  rather than a new one, because a second flag would let a deployment turn recording on and still
  get no record — and `recordVerdict` defaults to **true**, so this is a default-on behaviour change
  rather than an opt-in. Verified live end to end: three ticks, three rows, anchored at consecutive
  chain sequences, served by the read route with `anchored: true`.
  **`integrityVerdictFor` is implemented through `compromiseCauses` since ADR-0374's addendum**, so
  the six conditions that answer `compromised` are an **enum** rather than six `return` statements:
  `COMPROMISE_CAUSES` × `COMPROMISE_CAUSE_HOLDS` (a total map of predicates) × the escalation's
  `COMPROMISE_CAUSE_PAYLOAD_KEY` (a total map naming the `after` key that explains each). The point
  is the compile error — a seventh entry in the predicate map alone is `TS2353`, adding the enum
  member to fix that is `TS2741` at the payload key and at both fence fixtures, so **a cause cannot
  compile until the anchored row gains a key that explains it**. It replaced a test comment claiming
  exactly that fence and providing none: a seventh branch with no key gave 83 of 83 passing.
  The one gap no type sees is a bare `if (…) return "compromised"` in the body, which a **text
  fence** over the function covers — and that fence caught a vacuity hazard on its first run, since
  the prose two functions above quotes the same string, so the lazy fix is to write the expectation
  down to 2 and check nothing. `chain_broken_or_unsigned` is deliberately **one cause for two
  facts**, because splitting it would be a seventh condition and would leave `ok: false` with both
  sub-flags set unrepresented; which half failed travels in the `chain` key. There is deliberately
  **no** elementwise truth-table test against a re-derivation of the old `if` sequence — that is
  ADR-0362's retired test verbatim, a rule compared against a derivation of itself — so the golden
  is the 21 existing `integrityVerdictFor` call sites, written against the branches and untouched.
  **Seven causes since ADR-0375**, the new one being `checkpoint_disagrees_with_chain`, and the fence
  held with the seventh exactly as it was built to: the enum member, the predicate, the payload key
  and both fixtures had to move together. That increment also spent the one convenience ADR-0374
  bought — the call sites were spared by keeping `integrityVerdictFor`'s signature, and the fifth
  parameter is retyped to an `AnchorAuditReport` now, because the axis grew a second dimension and a
  list of refused rows could not carry it. `noAnchorFindings()` is the fixture helper, and it answers
  `disagreeing: []` and not `null` because it means *asked and clean*.
  **`anchor-audit.ts` is the anchor table read as a set** (ADR-0375): `auditAnchors(scope, store,
  chain | null)` folds `scanCheckpoints` into `{scanned, complete, refused, refusedCount,
  disagreeing, witnessSequence}`. Three decisions in it. The **correspondence rule** is two maps
  built once from the chain and four outcomes per readable anchor `(S, H)` — the entry at `S` carries
  `H` → agrees and `S` is a witness; some entry **elsewhere** carries `H` → `sequence_relocated` with
  `matchedAt`, not a witness; an entry at `S` exists and differs → `root_hash_mismatch`, not a
  witness; neither → the chain does not reach this anchor, which is deliberately **not** a
  disagreement and **is** a witness, because that is exactly what truncation looks like and
  `ChainTruncationCheck` is its subject (folding it in would report one fact as two causes *and* take
  the witness away from the check that needs it). **That fourth outcome is also the rule's measured
  limit, and it is stated where the code is rather than only in the ADR**: it is what a **two-column**
  `UPDATE` produces, so setting `sequence_number` and `root_hash` in one statement hides a truncation
  under a report byte-identical to a healthy scope's and restores the false `chain_truncated` sev1 the
  one-column form no longer produces. Narrowing it is not available here — an anchor the chain does
  not reach *is* the truncation signature, so the fourth outcome cannot distinguish the two from the
  anchor table alone, and closing it needs evidence that table does not hold. `disagreeing: null` means the correspondence was
  **not asked**, never "none found" (ADR-0331), and it is asked only over a chain the reader refused
  no row of — the maps would otherwise be incomplete and an anchor pointing at a refused entry would
  be named `root_hash_mismatch`, a finding attributed to the wrong table, while `chain_row_refused`
  already answers `compromised`. And **`witnessSequence` supersedes `latest()` as the truncation
  witness**, which is strictly stronger rather than merely wider: `latest()` answers the *highest*
  sequence, so a single refused newest row left the check `null` while an older readable anchor sat
  directly beneath it. Two predicates and not one — `anchorAuditDisproves` is `compromised` and
  `anchorAuditHasFindings` adds coverage the scan did not reach, which is `unproven`, because an
  absence of evidence is not evidence (ADR-0372). `!anchorAudit.complete` is therefore an `unproven`
  arm in `integrityVerdictFor` and **not** a seventh cause: a scan the ceiling stopped did not read
  the whole table, so `verified` would claim a reading nobody took, and nothing is disproven.
  **And `CheckpointScheduler` verifies before it anchors, which it did not** (ADR-0371):
  `verifyChainFromCheckpoint`'s own doc comment said *"trust in the anchor comes from the earlier
  verification that produced it"*, and this scheduler — the **only** checkpoint writer in the
  workspace — read the tail and anchored it, verifying nothing. So the bounded proof's soundness
  condition was stated in one file and satisfied by none, and because `verifyChainSuffix([])` and
  `verifyChainSignatures([])` are both vacuously valid, an hourly proof could report `verified` with
  **zero signatures examined** over a forged prefix. `CheckpointSchedulerOptions.verify` is a
  **required** seam — an optional verifier defaulting to *do not verify* is the defect restated as a
  default (ADR-0364) — and it is what forced the `node.ts` wiring to be written rather than
  remembered, since the compile error named the one call site. The provenance written is **derived
  from the report's own `mode`** through a module-private total map (`full` → `verified_full`,
  `from_checkpoint` → `verified_suffix`), never passed in, because a caller who could choose it
  could assert a verification that never ran; the scheduler deliberately does **not** read the
  latest checkpoint's provenance itself, which would be a second spelling of the bounded-verify
  decision in the one place that must hold no opinion about *how* the verification was performed.
  The tail is resolved **before** the verification, and that ordering is now a **correctness
  requirement** rather than the error-avoidance convenience its first comment called it: the anchor
  claims that sequence, and everything at or below it is provably inside what the verification then
  loaded, so the pass builds the checkpoint with `checkpointFromTail(tail, …)` and makes **no second
  read**. Letting `createCheckpoint` find a tail afterwards anchors at a *later* sequence, stamping
  every entry appended during the verification as verified by a fold that never saw it — and since
  the next bounded pass starts at `checkpoint.sequenceNumber + 1`, that band is skipped forever. The
  increment's own class, narrowed to one band per pass and reopened on every pass, in a window a
  serving deployment writes continuously (ADR-0286 anchors a row per audited request). Anchoring at
  the pre-verify tail is conservative in the only safe direction: a row in the window is not covered
  *yet*. The old reason survives as the empty-chain skip, for this increment's own vacuity one step
  round — a full fold over zero entries is vacuously `ok`, so verifying first would report a failure
  where there is nothing to anchor. `onCheckpoint` fires **outside** the `try`, because a throw from
  a caller's own callback would otherwise file a recorded anchor as an `error`, which says the
  opposite of what happened to the database; `checkpointedAt` is resolved **per scope**, so a long
  pass does not stamp its last scope with the time its first was read; and a pass already in flight
  makes `runOnce` a no-op returning `[]`, because a full fold is unbounded in the chain's length
  (152 µs of signature CPU per entry) so a scope that must fold from genesis can outlast an hourly
  interval and the timer would stack passes on exactly the deployment least able to afford them —
  cost and not correctness, since a re-`record` at one sequence is a no-op.
  `refused_unverified` is a fourth outcome carrying the report while a verifier that
  **throws** stays an `error` — ADR-0322's split, since both withhold the anchor and the difference
  is what an operator is told: a refusal says the chain did not verify and names what failed, an
  error says the verification could not be performed and asserts nothing about the chain, and
  conflating them would report *"this chain is broken"* when the truth is *"the key registry was
  down"*. `CheckpointLifecycleOptions` takes the `registry` **ingredient** and composes `verify`
  itself, `buildIntegrityProofLifecycle`'s idiom, because the builder owns both chain stores — so a
  verification cannot be pointed at a different store than the one being anchored, where a caller
  supplying its own seam would have to build a second pair at the same schema.
  **`onRefused` is required where `onCheckpoint` and `onError` are not**, and the asymmetry is the
  decision: a refusal is the only outcome here that leaves **nothing in the database** — an anchor
  that is written is its own record, a throw is a condition the next pass meets again, and a refused
  verification writes no row at all (see the provenance entry for why writing one would be worse). So
  an optional handler would let a deployment discover that its chain had stopped verifying by never
  being told. That gap is not closed, only made unmissable: the durable form is the increment's top
  open question. **`onAnchorFindings` is required beside it** (ADR-0375), and its argument is that one
  *strengthened*: the scheduler audits the whole anchor table on every pass and anchors regardless of
  what it finds, so nothing in the database distinguishes a refused or relocated checkpoint row from a
  sound one and this callback is the only record of the finding — and the surface now anchors rather
  than refusing, which makes the gap bigger and not smaller. It passes `chain: null`, so the
  correspondence half is the integrity proof's: this scheduler's verifier loads the chain internally
  and does not hand it back, while `proveScopeIntegrity` already loads the whole chain for the anchor
  half. It audits **before** the tail check, and the ordering is observable because its member is
  live rather than hypothetical: a scope can hold checkpoints with an **empty chain**, and the only
  thing in the workspace that produces that is the tamper itself — zero `DELETE FROM
  forensic_chain_entries` anywhere, and the Article 17 shared-table erasure *retains* that table as a
  `PLATFORM_RECORD_TABLES` member, while ADR-0374 measured a tenant-context `DELETE` matching the
  owner's row count on 6 of 6 scopes. So an audit placed after the tail check answers the one case it
  exists for by reading nothing. `fullBecause` reaches the hourly `[integrity-proof]` line and
  `formatIntegrityProof` too, because a deployment whose anchors cannot be trusted folds from genesis
  on every pass and still answers `verdict=verified` — so the one standing condition an operator has
  to act on, and the unbounded cost it carries, was reported nowhere. It is committed to **no** stored
  record: a diagnostic belongs where diagnostics are read, and the verdict's bytes carry only what
  the digest covers (committing the reason would need a second domain tag beside
  `audit_integrity_proof`).
  The escalator declares through the same
  `IncidentDeclarer` the SLO loop uses (ADR-0297), with `CountingIncidentDeclarer` as both the offline
  default and the fallback that keeps the page going out when the record cannot be stored.
  **All three escalators now page over real transports and resolve their own alerts** (ADR-0326):
  `buildPageSendersFromEnv` wires PagerDuty (which needs nothing — the `routing_key` is the credential
  and the policy carries it), plus Slack, a signed webhook and SMS where configured; one
  `PageDispatcher` per signal so the page names what fired; `deliverAndRecord` writes every attempt to
  `meta.audit_log` with the tenant taken from the `IncidentRecord` the escalator holds, since the report
  carries none. A **resolve** is deliberately *not* routed through `deliverAndRecord` — an
  all-`unsupported` resolve would land as `platform.page_undelivered`, claiming a page failed when none
  was sent — but it does get its own timeline note, through `resolveAndNote`.
  **Every page is also appended to its incident's timeline** (ADR-0327), which was the only record
  that landed for the SLO escalator while `meta.audit_log.tenant_id` was NOT NULL: an SLO surface is
  never a tenant, so the row was *structurally impossible* and the timeline — no tenant column,
  append-only, on the record a review actually opens — took it either way. ADR-0331 made the row
  possible (NULL is platform scope), so the two are now a **pair** rather than a substitute, and the
  timeline keeps its job: it is what still lands when the emitter itself is unreachable.
  The **tombstone sweep** is reachable too: `GET /v1/platform/tombstones/unproven` (paged, `?after=`,
  recorded even when clean because the *examined* count is the claim — ADR-0323), plus one page per
  audit tick on the deletion scheduler, lapping when it reaches the end rather than sweeping the whole
  table, since that table only grows and a full sweep per tick would eventually outlast its interval.
  Mobile **push** is built from the environment (`FCM_PROJECT_ID` plus either
  `FCM_SERVICE_ACCOUNT_JSON` or the client-email/private-key pair, which `normalizePrivateKeyPem`
  absorbs the literal-`\n` form of), and since ADR-0328 also from the **GCE metadata server** —
  `FCM_CREDENTIAL_SOURCE=metadata_server`, declared rather than probed, because a key file is
  unambiguous evidence of intent while the metadata route is configured by nothing. **Voice** is wired
  too, sharing the SMS account and credential by default but **never** the number: `TWILIO_FROM_NUMBER`
  may legitimately be unable to place a call (a short code, an alphanumeric sender id) or be absent
  entirely when SMS uses a messaging service, and defaulting it produces a channel that registers at
  boot, reads as healthy and fails at the provider on every call. A separate subaccount is available,
  with one refusal: a `TWILIO_VOICE_ACCOUNT_SID` naming another account requires its own credential.
  Voice deliberately does **not** warn about a missing status callback where SMS does, because
  ADR-0310 gave it no bounce source — warning would promise handling that does not exist.
  **The deletion flow now requires `--deletion-capabilities`** and refuses to mount without it: both
  the synchronous route and the runner, loudly, because the scope of an Article 17 proof is a property
  of the deployment and the field it replaced was read from the request body with `[]` as its default
  (ADR-0328). The **tombstone sweep escalates** as well as logs, keyed on the evidence record — a
  referenced tombstone adopts its request's episode, one no request names gets
  `deletion_evidence:tombstone:<id>` — and its log line leads with the **lap**, since "every stored
  proof has been verified since ⟨time⟩" is only true per completed lap.
  **A stalled sweep now says so** (ADR-0329, `onSweepStall` + `sweepProgress().stall`), which closes
  ADR-0328's "nothing reads `pagesAdvanced`": the findings surface goes quiet in exactly the same way
  whether every proof verifies or none is being read. `attemptsWithoutAdvance` counts audit ticks that
  did not move the cursor, built on the rule that **reaching the end of the table counts as motion** —
  so an empty table and a single-page table, which lap every tick, reset it forever rather than reading
  as stalled, which is the alarm an operator would mute. The two kinds split on whether any page came
  back: `no_pages` (the store is unreachable or every page throws) versus `pinned_cursor`. Reported
  through *both* surfaces because the half that matters most never reaches `onTombstoneFindings` — a
  `no_pages` stall **is** a throwing sweep, so there is no page to hand over — which required giving
  `sweepOnce` its own `try` inside `auditOnce`. Logged at error and deliberately **not** deduped: a
  stall is a standing condition and the growing counter is the signal. Threshold 3, and a malformed
  `stallAfterAttempts` reads as the **default, not off**, the opposite of `auditEveryTicks`, because
  there "off" is the status quo and here "off" is precisely the silence this exists to end.
  Voice's status callback is now **warned about when missing** and asks Twilio for **one** event
  (ADR-0329): `twilio_voice` is a real bounce source, so the old silence became the misleading thing —
  a channel that registers at boot, reads as healthy and can never suppress a dead number — and
  `StatusCallbackEvent` narrowed from four events to `completed`, because three of the four are
  non-terminal, answer `422`, and Twilio retries non-2xx.
  The deletion route's 200 also carries **both** erasures (ADR-0329) — `erased` and
  `erasedSharedTables`, never summed, because they are different claims over different scopes that the
  tombstone carries as two attestations — while the audit row's single `rowCount` is the total; and
  since ADR-0330 it names **what is lawfully retained and why** (`statutoryRetained`, `null` rather
  than an empty list when there is nothing to claim, and carrying no figure at all), which is the
  sentence an operator sends in answer to an Article 17 request.
  **A stalled sweep declares a `sev2`** (ADR-0330), keyed `deletion_evidence:sweep:<surface>` — per
  surface and never per kind, because a half-up database flips between `no_pages` and `pinned_cursor`
  and that is one incident, with the kind in the detail rather than the key. Not `sev1`: ADR-0324's
  grade is for a *detected* falsified proof, a fact in hand, while a stall concludes nothing about any
  row and persists as long as its cause does, so paging it would compete with real tamper findings on
  the same rotation — and the grade **is** the route, since `AlertPolicy` maps severity to a channel
  set. `--deletion-sweep-stall-after` moves the threshold (3 by default); the grade lives in
  `--deletion-escalation-config` beside `severity` and `severityByDefect`, because a second CLI knob
  would split one policy across two places. The recovery is applied **automatically**, which is the
  exception to this family's rule that an absence is only an inference: an advance is positive
  evidence of motion. It used to write **no audit row** and say so (`audited: false`), because
  `meta.audit_log.tenant_id` was NOT NULL with a foreign key to `meta.tenants` and a sweep walks every
  tenant's proofs, so the row was *structurally impossible* — the same wall ADR-0327 named for the SLO
  escalator. **ADR-0331 removed that wall**: `tenant_id` is nullable, NULL means platform scope, and
  all three escalators now leave anchored platform rows (verified live, including the ADR-0286
  contrast — a tampered platform row reports `hash_mismatch` and `COMPROMISED` while the chain's own
  `verify()` still answers `{"valid":true}`). The timeline note ADR-0327 added is **not** superseded by
  it: the two are a pair, and the timeline is the one that still lands when the emitter itself is
  unreachable, which is the condition a compromise finding escalates for.
  `PostgresReadStateStore` (ADR-0330) is the writer `meta.notification_read_states` and
  `meta.notification_read_watermarks` never had — ADR-0309 modelled both and nothing stored one, so the
  tables had sat unwritten and, in the way of ADR-0300, **drifted**: `dispatch_id` was `UUID` against a
  contract whose `dispatchId` is `disp_…`, a value that cannot be stored in a UUID column, so the first
  `INSERT` would have failed on a schema that read as correct. Both write rules are enforced **in SQL**
  because an inbox is the one surface where the same person has several tabs open: `ON CONFLICT … DO
  NOTHING` so re-opening a notice cannot move `readAt` (the field answers "when did you first see
  this"), and `GREATEST` inside the `DO UPDATE` so a stale client replaying an older position cannot
  un-read everything between the two — ADR-0321's "the row is the lock", applied to a different race.
  **`--workflow-cancel-role` mounts a real engine now** (ADR-0331). ADR-0330 refused the flag outright
  and the premise it named was true: no `WorkflowEngine` was instantiated and
  `meta.workflow_definitions` had **no writer**, so there was no source of definitions and a route over
  an empty map would answer `unknown_instance` for every instance. There is a writer now, so the
  refusal narrows to `--store memory` (neither table exists there) and the flag otherwise builds
  `PostgresWorkflowDefinitionStore` → `loadEngineDefinitions({})` → `buildPersistentEngine`. The map is
  keyed by `definitionId` and loads **every** status, not only `published`: a missing definition makes
  the engine go quiet rather than raise (a due timer is skipped, a signal declined), so narrowing to
  `published` would silently strand in-flight instances of a `deprecated` definition, while
  `startInstance` already refuses a non-published one by name. An **empty** map warns loudly, because
  under RLS as a non-owner role with no tenant context the load sees only platform-wide rows — and a
  404 then reads as "no such instance" rather than "this server loaded no definitions".
  `surveyManifestWorkflows` names every manifest workflow no published definition serves, since under
  the authored model the cost of an absent definition is an *absent* workflow rather than a wrong one.
  **Entity lifecycle transitions remain a different mechanism** (`operate-runtime`'s lifecycle
  handlers) and are unaffected.
  **`--workflow-workers` mounts the three workers that drive the queues** (ADR-0333) — timer,
  activity and job — which is what makes a due timer actually fire. `workflow-workers.ts` had
  existed since ADR-0331's increment with tests, a refusal taxonomy, a drain budget and an
  `index.ts` export, and `node.ts` never called it: the module was as unreachable as the engine it
  supervises. The engine is built **once** for both the cancellation route and the supervisor,
  because `WorkflowWorkerSupervisorInput` requires exactly that — two engines over one connection
  would each hold their own definition map and their own inline-vs-deferred activity policy, so a
  cancellation and a timer fire could disagree about the same instance. Each worker **refuses by
  name** rather than polling uselessly: `no_definitions` (every claim would be released unadvanced
  and re-claimed — a hot loop making no progress), `activities_run_inline`, `no_job_handlers`.
  `--workflow-defer-activities` is **refused without** `--workflow-workers`, which is the
  load-bearing refusal: `deferActivities` is a biconditional and its own contract says so — inline,
  a row is `scheduled` only between the `activity_scheduled` and `activity_started` appends, so a
  worker can claim it inside that window and run the handler a second time (the duplicate append
  collides on the log's unique key, so the *log* survives and the side effects have happened twice);
  deferred with nothing claiming, every instance stalls at its first activity and nothing reports
  it. Both directions are closed — the CLI refuses one, the supervisor the other. `workerId` is
  `hostname():pid`, because that value lands in `claimed_by` and its job is to let an operator
  answer "which process holds this lease" from the row alone. Verified live: the three refusals
  print, the server boots, and the drain reports on shutdown.
  **`--schedule-ms` warns when nothing drains its queue**, which is the sentence that should have
  existed since the scheduler was written: its own comment said it enqueues "so the distributed
  worker fleet runs them" and there was no fleet, so every deployment using it has been accumulating
  `pending` rows in `meta.job_runs` indefinitely and the manifest's scheduled jobs have **never run
  in this binary**. Since ADR-0334 it warns **separately** for the two reasons, which need different
  fixes: no worker is mounted at all, or one is mounted and no handler serves the jobs being
  enqueued. And the defect was never limited to `--schedule-ms` — `POST /v1/meta/jobs/invoke` and the
  entity-event emitter fill the same queue, so `JOB_KIND_PRODUCERS` (a total map over `JOB_KINDS`)
  names the producer behind each unserved declaration.
  **A job handler is registered against the job's id by the deployment, and `JOB_HANDLER_PROVIDERS`
  ships empty** (ADR-0334). A `JobDeclaration` carries an id, a trigger, a retry policy, concurrency,
  data classes and a prose `description` — and **no field of any kind that describes the work**, not
  even the `z.unknown()` slot an orchestration `Workflow` has, so there is nothing in a manifest to
  compile and a compiler would have zero valid inputs (ADR-0331's finding one notch more absolute).
  What the manifest *owns* is how a run is **governed**, and `buildJobHandlerRegistry` reads the
  ceiling, the backoff, the data classes and the failure strategy off the declaration and **refuses**
  a provider that restates any of them, so the queue cannot disagree with the manifest a reviewer
  approved. A `kind` provider is **expanded into one registration per declaration** rather than using
  `registerForKind`, because a kind registration carries one ceiling for twelve jobs that do not
  share one. All 25 declarations across the seven packs are tenant-domain ERP work — eight are
  third-party integrations with no client in this repo, the rest need `operate-runtime`'s entity store
  and the packs have no runtime layer — and **no noop handler ships**, because a run reported
  `completed` having done nothing is exactly the class ADR-0332 and ADR-0333 exist to end. So the
  absence is *said*: `surveyManifestJobs` names every unserved declaration with its producer, the
  claim's `due` CTE is filtered to `servedJobIds` so an unserved backlog cannot starve served runs out
  of a batch (an **empty** declaration claims nothing, since `= ANY('{}')` is false), and a run
  claimed anyway is **dead-lettered** rather than only status-flipped. `retry.backoff.jitter: true` is
  declared on all 25 jobs and had never been applied; `onFailure` was declared on all 25 and read by
  nothing, and now gates the dead-letter write (`swallow-and-log` → suppressed).
  **`probeJobQueueVisibility` is the loud half of a finding the fleet cannot report itself**
  (ADR-0334): `meta.job_runs`, `_dead_letter_jobs` and `_job_costs` each carry one `ALL`-scope
  isolation policy and no platform arm, while the fleet is deliberately cross-tenant — so as a
  non-owner with no tenant context the claim matches **0 rows** and `executeJobRun` answers
  `not_claimable`, and neither is an error: an empty claim is what an empty queue looks like. **A
  fleet that can never execute anything reads exactly like an idle one.** The probe asks the catalog
  (`relrowsecurity`, `rolbypassrls`, ownership) rather than counting rows, because a count of 0 is
  also what an empty queue gives, and answers `visible` / `confined_by_rls` / `unguarded` / `absent`.
  **`--tenant-status-gate` enforces `meta.tenants.status` on every request** (ADR-0334), which that
  column never had: a `suspended`, `archived` or `pending_deletion` tenant is read-only and a
  `deleted` one is refused outright. Read-vs-write comes from `SAFE_HTTP_METHODS` on the **route's own
  method**, not from a declaration at registration, so it is total by construction — every route has
  a method and a route added later cannot omit itself from a classification list (ADR-0288's lesson) —
  and the two rules are `blocksWrites`/`blocksReads` **called**, not restated. `applyTenantStatusGate`
  runs over `registry.operationIds()` (a method added to `HandlerRegistry` for this, because a
  cross-cutting refusal covering "the routes we remembered" is the shape of defect this repo keeps
  finding) inside `buildOperateHttpServer`, so a per-tenant gateway gets it too, sharing one directory
  instance. **`platform.` is exempt on a rule**: the gate answers for the tenant a request *acts on*,
  and a platform route acts on the deployment — gating on the caller's tenant would mean a deployment
  whose platform tenant went `suspended` could not reach the route that reactivates it. A state that
  forbids the request is **403** with the state on an RFC 9457 problem; a state that could not be
  *established* is **503**, because a 403 is a claim about the tenant and there is none in hand, and
  because a 503 is retryable and a 403 is not. The directory is cached
  (`--tenant-status-ttl-ms`, 1000..300000, default 30s) with a **shorter absence TTL** — the two
  mistakes are not symmetric: a stale status delays an enforcement, a stale absence keeps refusing a
  tenant an operator has just provisioned. A **first** lookup that throws propagates (never known, so
  no guess in either direction); a **refresh** that throws serves the last known answer up to
  `maxStaleMs`, because "we knew a minute ago" is evidence and cannot mean forever. **Opt-in**, because
  the gate 403s a credential whose tenant has no `meta.tenants` row and `--api-key 'key:role:tenant'`
  names arbitrary UUIDs — so a boot survey names those tenants *before* the first request, separating
  `missing` from `unreachable` (at boot the database may not be up, and calling that "not provisioned"
  would print a list of tenants that are).
  **The deletion-request routes move the tenant row with the request** (ADR-0334): `pending_deletion`
  on verify, `active` on reject. Both run **after** the request's own transition — the authoritative
  act, carrying the in-predicate guard, the four-eyes rule and the audit row — and a failure is
  *reported* as `tenantReadOnly: false` / `tenantRestored: false` rather than thrown, which is
  ADR-0320's `tenantRetired` rule: a verify that moved the request and could not move the tenant has
  happened, and a 5xx would say otherwise. `transitionStatus(id, to, from)` re-asserts the **source**
  state in the `UPDATE` predicate (ADR-0321's "the row is the lock"), with the source sets derived
  from `TENANT_LIFECYCLE_TRANSITIONS` — so a console suspension mid-flight wins the row, verified
  live, and the no-match is named in the log rather than overwritten. The sets are chosen so a
  no-match still leaves the handle's claim true: `markPendingDeletion`'s complement is
  `{pending_deletion, deleted}` and both block writes, which a test asserts.
  **The drain and the read-state routes announce themselves, and the drain-absence warning can
  fire** (ADR-0376). Eighteen bracketed boot surfaces print a line and those two printed nothing:
  `[notify]` said which channels were registered and never whether anything would be delivered, and
  `[read-state]` had three warnings for its *refusal* branches and no line on success — so the one
  mount an operator could not confirm from the log was the one whose client silently falls back. The
  drain-absence warning's gate was `senderWiring.report.channels.length > 1` against an `in_app`
  sender that is registered **unconditionally**, so it was unreachable on every shipped deployment;
  it is gated on the **store** now, which is the only axis where the two states differ in remedy, and
  it says that `in_app` is included because that is the clause an operator disbelieves. The
  `[read-state]` line names the **granted roles**, because the grant is per role and the flag is
  repeatable, so a console user whose membership carries a role not on that line is silently on the
  recency approximation — and the grant was measured to protect nothing anyway (`resolveViewer` takes
  the viewer from `principal.principalId` unconditionally and `bodyNamesAViewer` refuses a body
  naming one, so it gates a principal's access to its own row; `backfillRoles` is the one that gates
  something).
  **Per-viewer notification read state is reachable over HTTP** (`--read-state-routes`, ADR-0331),
  closing ADR-0309's tables-with-no-writer: mark one notice read, move a read-through watermark, read
  an unread count. The viewer is **always the credential** and a body naming one is *refused* rather
  than ignored, because ignoring it would let a client believe it marked somebody else's notice read.
  `--read-state-backfill-role` is additive on `--read-state-role` and gates the one privileged source
  (`system_backfill`, watermark-only since a row-wise backfill is unbounded), recorded *before* the
  write so an unrecordable one is refused; the ordinary per-notice mark is **not** audited, because the
  read-state row *is* that record and the reader, subject and tenant are one principal by construction.
  `--max-request-body-route <prefix>=<size>` gives ADR-0312's platform-wide cap a per-route form,
  matched by path **prefix** rather than by the gateway's route template — the limit has to be chosen
  before the body is read, and route matching happens after it.
  **Field-level write authorization is enforced, and who is privileged is declarable** (ADR-0339).
  `--sensitive-field-role` / `--sensitive-field-class <class>=<role>` are the entity-route
  counterparts of `--audit-read-sensitive-*`, with that pair's grammar, empty-value meaning and
  unknown-class refusal copied byte for byte — and they feed **one** `SensitiveFieldPolicy` to the
  response-redaction registry *and* the write mask, because `privilegedForClass` has a single
  definition so a role cannot write a class it may not read. They deliberately do **not** imply
  `--classified-write-mask`, which is where this parser departs from the audit one: the declaration
  says who may see a class, the mask says writes are enforced against it, and a deployment fixing
  its reads must not silently acquire a write refusal on the 39 fields no manifest grants.
  `--classified-write-mask` **refuses at boot** when the declaration would leave a required
  classified field writable by nobody, naming the entities and fields; a declared grantee the
  manifest does not define is **warned** about, since a grant that reaches nobody through a typo is
  a declaration that does nothing. The survey runs over the **manifest's** roles rather than the
  api-key roles — a JWT deployment can present any role the manifest declares, so the narrower set
  would produce a false boot refusal — and measures `uncreatable` with the mask **on** whatever the
  flag says, because a refusal computed under the regime the operator is leaving could never gate
  the change.
  **A manifest declaring an ABAC obligation this deployment cannot discharge is refused at boot**
  (ADR-0340, `abac-obligations.ts`), and there is deliberately **no flag past it**: ADR-0338 shipped
  `--allow-plaintext-phi` because plaintext PHI is a degraded-but-coherent state an operator may
  knowingly accept, while serving a grant with its qualifier removed is the opposite of what the
  manifest declares. The refusal names the count and the first eight obligations and both remedies,
  and the boot line is *affirmative* when there are none — "we checked and found nothing" cannot be
  claimed from the absence of a log line. It lives in **`buildOperateHttpServer`**, which is also
  what compiles an activated **per-tenant** manifest, so a tenant's own manifest is covered by the
  same rule — the placement that gives a per-tenant gateway the tenant-status gate (ADR-0334), and
  the reason there is no second check to forget. `node.ts` asks again *before* its sensitive-field
  survey, purely for ordering: an obligation on a required classified field's `update` grant makes
  that field unwritable and would otherwise trip `--classified-write-mask`'s
  `would_make_entity_uncreatable`, naming the classification declaration as the remedy for
  something no declaration can fix. First refusal wins, so it has to be the one whose remedy is
  true.
  **A fourth refusal and a third report joined it in ADR-0345.** `rowFiltered` names the
  record-bearing obligations whose position's `ABAC_DENIAL_EFFECT` is `filters_rows` — derived
  through that map, so the string `"entity_list"` appears nowhere in the module's logic — and is
  **reported, not refused**, for `createBlocked`'s reason: a denial that drops a row is a coherent
  answer. It gets its own sentence because **none of its three consequences is guessable from the
  declaration**, and all three are things a client integration gets wrong silently: a page comes
  back shorter than `limit` and may be empty while `nextCursor` is non-null, so a client stopping on
  an empty `data` stops early; the association count route over that entity refuses; and a
  `?sort`/`?filter`/`?q` naming a classified field is refused at request time.
  `list_sort_addresses_withheld_field` is the refusal, last in the order for `record_unavailable`'s
  reason — it is computed from `recordBearingKeys`, so with no evaluator it would be vacuously
  silent. It fires when a view's **default** sort names a classified field of an entity in
  `rowFiltered`, read through `listConfigForEntity` (the same function the handler uses) over
  `resolvedFields`, so a classified **trait** field is in scope. The predicate is *classified* and
  deliberately **not** `isSensitiveDataClass`-narrowed, so it is the same set the request-time guard
  uses — narrowing it would let a boot pass still 400 on page one for an `internal`-classified sort.
  And the refusal is **not** preventing a leak: the guard already stops the value reaching a cursor,
  so what it converts is a *certain page-one 400 on every request* into a boot failure naming the
  view, the field, its classification and three remedies — ADR-0334's conversion again, since the
  sort came from the manifest and no caller can opt out.
  **`--abac-policy <key>=<attribute>:<op>[:<operand>]` is the policy layer** (ADR-0341, ops `eq` /
  `ne` / `in` / `present`; ADR-0342 added `eq_record` / `ne_record` / `in_record`, whose operand is
  a **field of the record** rather than a literal), colon-delimited after the key because that is `--rate-limit-policy`'s
  convention here, and a repeated key is **refused** rather than last-wins since which of two
  policies decides an authorization must not depend on argv order. Declaring one is *also* what
  builds the attribute directory — the producer is wired exactly when a consumer exists, so a
  deployment with no policy pays no per-request lookup — and the flag is **refused under
  `--store memory`**, where there is no membership table and every obligation would answer
  `undischargeable`, the total denial that reads as the policy working. Three evaluation rules are
  decisions: an **absent** attribute denies for every operator **including `ne`** (so `ne` is not
  the negation of `eq` — nothing is known, and a grant condition over nothing must not be
  satisfied); a **structured** value denies for all but `present`, since guessing a scalar rendering
  would make the answer depend on an unstated convention; and a key no policy declares is
  **`undischargeable`, not `denied`**, because that is a configuration gap rather than a statement
  about the principal. Attribute lookup is `hasOwnProperty`-guarded, which is not pedantry: a policy
  naming `constructor` or `toString` would otherwise find the attribute *present* on every
  principal, a fail-open reachable from the declaration alone — and **the record is a second source
  with the same exposure**, so the guard covers it too, since a record field named `constructor`
  would otherwise be present on every record.
  **Three record operators rather than a `record.<field>` prefix on the operand** (ADR-0342): a
  prefix collides with a literal that happens to start with `record.`, so one spec would have two
  readings and the parser would pick one silently; the operator *is* the declaration of which kind
  of comparison this is, and `ABAC_OPERATOR_NEEDS_RECORD` is the total map `recordBearingPolicyKeys`
  and the boot check read. The declaration decides which keys need a record, because only the
  deployment knows. Two more total maps sit beside it, and the first fixed a live bug: parse arity
  was `operatorRaw !== "in"`, so `in_record` would have been treated as single-valued and
  `teams=team:in_record:a,b` refused with a message pointing at `in` — `OPERATOR_OPERANDS` owns that
  axis now, and `OPERATOR_RENDERED_WORD` owns display so nothing dispatches on the spelling
  (`replace("_record","")`). `formatAbacPolicies` renders `department eq record.department` and a
  multi-field `in_record` as `record.(a,b)`, so a literal `in a,b` line cannot be misread as a
  record one — and the module's absolute rule now covers both sources: **no attribute value and no
  record value may appear in anything it logs**, only the declaration the operator typed. An
  absent or structured value on **either** side denies for all three, `ne_record` included.
  `BuildOperateHttpServerOptions.abac` groups the evaluator, the **keys it can answer**, the
  **keys that need a record** and the attribute directory as **one** object, because they must agree
  and most of the pairings are silently wrong if they can be formed apart: an evaluator without its
  key set leaves the per-tenant check unable to ask whether the manifest's obligations are
  answerable, one without `recordBearingKeys` cannot tell a record policy from an attribute policy
  and so would boot a manifest that puts a record policy on a `create`, and one without a
  directory refuses every obligation. `answerableKeys` and `recordBearingKeys` are required beside
  the evaluator; the directory and `evaluateBatch` are the **two** genuinely optional members, and
  the second is optional for the opposite reason to the required ones — its absence cannot make an
  answer different, only the asking dearer (ADR-0344). `buildAbacBatchEvaluator(evaluator)` takes
  the evaluator **instance**, not the policy map, so the batch provably is that evaluator mapped and
  the two cannot answer one question differently; `node.ts` wires it unconditionally alongside the
  evaluator. For a map lookup it buys nothing and is supplied anyway, so the branch a deployment
  with a real batch takes — the validated one, with the length and index checks — is the branch this
  repo runs on every per-record redaction. It is deliberately **not** exported from
  `@crossengin/auth`: a generic `batchFromEvaluator` there would let any deployment satisfy the arm
  without batching anything while a reviewer reads the wiring as batched.
  **At-rest PHI is decided at boot** (ADR-0338): `resolveStore` surveys the manifest's
  `phi`/`regulated` fields (through `resolvedFields`, so a classified *trait* field cannot be missed),
  calls `decidePhiStorage`, and either refuses or builds one `buildColumnKeySource` shared by the boot
  store and the per-tenant registry so a tenant's key is derived once. The secret is
  `COLUMN_ENCRYPTION_SECRET` from the environment and **there is no flag for it** — ADR-0301 — while
  `--allow-plaintext-phi` is the one flag, refused by name on `--store pg-columns` where plaintext is
  not an outcome a `BYTEA` column can produce. **The key source is built before the decision is
  logged**, which is load-bearing rather than tidy: `secretPresent` is "the variable is non-empty" and
  cannot see a secret that is present and too weak to use, so logging first would put
  `phi storage: encrypted` on the record and throw a `ColumnSecretRefused` immediately after — this
  increment's own defect, one layer in, caught in review. A secret that is set and **unused** warns
  rather than refusing, since the variable may be set for a sibling service. The router is built
  **per tenant gateway** so `encryptedEntities` comes from that tenant's own manifest.
  **`--column-key-mode derived|envelope` chooses where that key comes from** (ADR-0347), default
  `derived`, and `envelope` on a deployment that encrypts no column is **refused at boot by name** —
  a mode that silently does nothing would let an operator believe a tenant's key is destroyable when
  there is no key and no ciphertext to destroy, which is the overclaim that increment exists to
  correct. The derived source stays live in envelope mode because it is the **seed**, so the two are
  one decision rather than alternatives; the secret is parsed **once, eagerly**, before either
  closure, since `buildEnvelopeKeySource` takes bytes and so cannot repeat
  `buildColumnKeySource`'s refusal. `data-key-envelope.ts` holds the mode, the shreddability pair
  and the two boot lines, performs no encryption, issues no SQL and never reads the environment.
  `shreddabilityOf(mode, provenance?)` answers `shreddable` / `derivable` / `not_applicable` over
  the **pair** and not a boolean, because whether destroying a row destroys anything is a property
  of **that row** — an `envelope` with no provenance in hand answers `derivable`, the conservative
  direction, since claiming `shreddable` for a recomputable key tells a deployment its Article 17
  erasure bounded a horizon it did not, while the converse costs an unnecessary rekey.
  The key source **caches the promise and not the value**, because here a cache miss is a database
  round trip and N concurrent cold writes would be N callers racing to create one tenant's first
  row (`fcm-token.ts`'s in-flight collapse); a rejection is **not** remembered. Nothing is caught: a
  failed unwrap or a wrong-length key is a refused request, because the available fallback —
  deriving instead — would split one tenant's ciphertext across two keys with nothing recording
  which, and a refused write is recoverable where that is not.
  `tenantMayHoldCiphertext` is the seed decision's input and **every uncertainty resolves to
  `true`**: seeding a tenant that holds nothing costs only shreddability, while randomising one that
  does makes their PHI permanently unreadable. `42P01` is the one honest `false`. Its first version
  asked whether the tenant's own schema existed — sound only for ADR-0314's per-tenant manifests,
  and for a boot manifest it answered `false` for every tenant; found live, which is where a proxy
  that is merely indirect and one that is wrong first become distinguishable.
  **The fax run counter is opt-in** (`--bounce-fax-observations`, `--bounce-fax-suppress-after`,
  `--bounce-fax-window-hours`, ADR-0332): a threshold below `MIN_FAX_SUPPRESSION_THRESHOLD` is
  **refused rather than clamped**, because a threshold of 1 is the inference ADR-0302 forbids and
  silently raising it would make the deployment believe something it did not ask for. It warns at boot
  when `TWILIO_VOICE_MACHINE_DETECTION` is unset, since `AnsweredBy` arrives only then.
  `--workflow-cancel-role` now refuses only under `--store memory` (ADR-0331), and the decimal wire
  type is applied by `compileOperateServer` itself (ADR-0332) rather than by a flag — the decorator
  needs both the store and the manifest, and that is the one place holding both, so no app wiring was
  needed and the write effects are covered by the same seam as a client request.
  **Three registries that nothing could write are reachable** (ADR-0335).
  `--platform-user-routes` + `--platform-user-role` mount `/v1/platform/users` — provision a
  principal, grant it a membership in a tenant, retire it — which is the first writer `meta.users` and
  `meta.user_tenant_membership` ever had; the grant is **separate** from `--platform-admin-role`,
  which administers tenants. `--preference-routes` + `--preference-role` mount per-user notification
  preferences, where the viewer is **always the credential** and a body naming another user is
  *refused* rather than ignored (ADR-0331's rule), with `--preference-admin-role` additive for the one
  on-behalf route, recorded before the write so an unrecordable privileged write is refused.
  `--rate-limit-policy` + `--rate-limit-default-policy` declare the policies that make
  `api-gateway-pg` reachable at all.
  A `surveyUserFkReadiness` boot survey runs **unconditionally** and names unprovisioned api-key
  principals — only specs that *name* one, because a bare `key:role:tenant` resolves as a
  `service_account` on `DEFAULT_PRINCIPAL_ID` and provisioning *that* would undo ADR-0331's fix by
  making the shared placeholder satisfy every per-person guard again.
  **The tenant lifecycle trail is wired into all four transition surfaces** — the console's
  suspend/archive/activate, the synchronous deletion's `… -> deleted`, and the asynchronous route's
  verify (`schedule_deletion`) and reject (`restore`) — and each **reports** whether the append landed
  rather than throwing, which is ADR-0320's `tenantRetired` rule: a verify that moved the request and
  could not move the trail has happened, and a 5xx would say otherwise. `lifecycleRecorded` is
  **three-valued** (`null` / `false` / `true`), because `false` for both *no store configured* and
  *the store was asked and nothing landed* reproduces in the response exactly the confusion this table
  exists to end. The console's `CONSOLE_ACTION` map has **three** non-null entries, not four:
  `TENANT_STATUS_TRANSITIONS` has no set targeting `pending_deletion` or `deleted`, so a fourth would
  be an entry for an unreachable state — pinned by `consoleActionsNeedNoApprover()`, which must be
  empty, so adding one fails with the reason rather than at the first click.
  `transitionStatus` reads `SELECT status … FOR UPDATE` and runs the guarded `UPDATE` **in one
  transaction**, because `RETURNING` answers with the *new* row and `PENDING_DELETION_SOURCES` has
  three members, so the predicate's candidate list does not say which one matched (and there is no
  `RETURNING OLD` before PG 18 against a floor of 14).
  **The boot line says what this deployment will erase of a tenant's own records** (ADR-0350,
  `boot-erasure-report.ts`), and says it **either way, including when the figure is zero** — the
  sharpest evidence for which is ADR-0316's own live notes, which record *"`meta` (144 tables) and
  `public` are untouched"* as a **success** criterion: it was checking for *collateral* damage, and
  that is the identical observation this defect produces, so a passing check and a missing erasure
  were one sentence. `STORE_ANSWER` is a total map over the store kinds (`pg`'s zero is a fact, not a
  finding: its records are the catalogued `meta.operate_entity_records`), the cycle is answered
  **before** the count so a `column_tables: 54` line cannot sit beside a deletion that refuses every
  time, and `bootErasureCoverageIsSuspect` shares the two predicates with the arm so the level and
  the verdict cannot disagree. The plan is derived **once at boot** and threaded to both
  `deleteTenantAtomically` call sites — the finding is about the *manifest*, so it belongs where an
  operator reads months before an Article 12(3) deadline — and only for `pg-columns`, because asking
  for a plan on `--store pg` would **throw** for a `duration` field the JSONB store serves perfectly
  well. The boot census of undeclared boot-schema tables runs beside it, swallowed on failure, since
  a failed read establishes nothing and the deletion-time refusal is the fence.
  **`recordStorageDeclarationFor` lives in the same module and reads the same axis** (ADR-0351): a
  module-private total map `RECORD_STORAGE_FOR_STORE` (`memory` → `no_durable_store`, `pg` →
  `document_rows`, `pg-columns` → `typed_tables`) sits beside `STORE_ANSWER`, so the boot line an
  operator reads and the claim a v4 proof signs are two readings of **one** map rather than two
  answers to one question. It returns the declaration minus its count, which the pipeline derives.
  **And `proof-version-probe.ts` refuses the deletion surfaces when this database's
  `proof_version` CHECK does not name the version this binary emits** — `pg_get_constraintdef`,
  Postgres's own deparse, asked once at boot rather than per statement, because the remedy is
  standing manual SQL an operator runs once (`decision-schema-probe.ts`' precedent). It converts a
  `23514` that would land **inside the deletion pipeline's transaction after the tenant's data has
  been deleted** — rollback, `aborted`, the request stranded `in_progress` under an Article 12(3)
  deadline — into a boot failure printing the `ALTER` pair, rendered from the **declared** version
  list and never the stored one, since the stored one is what is being replaced. Three decisions:
  it is gated on `--deletion-capabilities` being declared and deliberately **not** on a list of the
  flags that mount a deletion surface, which is the one derived condition that cannot fall behind
  them (ADR-0288's maintained list, wrong three times); it **refuses** where the rate-limit probe
  mounts loudly, because that one guards a *projection* of an enforcement that happens either way
  and here there is no degraded behaviour to protect; and `absent` / `unreadable` **warn and mount**,
  ADR-0334's `missing`-versus-`unreachable` asymmetry — an observed omission has one `ALTER` as its
  remedy, while at boot the database may simply not be up, and refusing on an unestablished fact
  would refuse a deployment that works. A constraint whose rendering does not match the
  `= ANY (ARRAY[…])` shape at all reads `unreadable` with the text rather than `refuses`, because
  *this expression is not one I can read* and *this expression rejects v4* are different facts and
  only the second has a remedy. **It reads two spellings because Postgres produces two**, measured
  on 16.13 over the identical `CHECK (proof_version IN (…))` and differing only in the column's
  declared type: `TEXT` gives `= ANY (ARRAY['v1'::text, …])` and `VARCHAR` gives
  `= ANY ((ARRAY['v1'::character varying, …])::text[])`, whose extra paren the first regex rejected
  — and since `unreadable` **mounts**, a drifted column would have left the `23514` exactly where it
  was behind a warning. The catalog declares TEXT, so the live verification could only ever exercise
  the first; the fake asked for the second is what found it.
  **ADR-0352 replaced that probe with the general survey and deleted it**, because it was one instance
  of a class: `surveyCheckAdmission` runs **unconditionally under a Postgres store** (not behind a
  flag — the fact it reports is true whether or not a surface is mounted to meet it) and prints a
  `[catalog] catalog admission: …` census, reporting and never refusing. The deletion pipeline's
  refusal survives as seven lines over `admissionBlocks`, naming
  `meta.tenant_tombstones.proof_version` where the write is, with `admissionRemedy`'s `ALTER` pair
  printed — the same SQL `reconcile.ts` hands over, produced independently. Keeping both the probe and
  the survey would have been two mechanisms for one question.
  **A second such refusal joined it in ADR-0363, and it is `admissionBlocksValues` rather than
  `admissionBlocks`** — **value**-granular, because `meta.tenants.status` has two writers writing
  different values: `--deletion-request-routes` writes `pending_deletion`, which an un-upgraded
  four-value CHECK refuses, while `--tenant-deletion-routes` writes `deleted`, which it admits, so
  naming the *column* would refuse the synchronous Article 17 route for a value it stores perfectly
  well (ADR-0334's rule that a refusal an operator cannot act on for the surface in front of them is
  worse than none). The returned finding's `refused` list is narrowed to the values asked about while
  `declaredExpression` is untouched, so the remedy still restores the whole domain — a CHECK is
  replaced and never amended. `decidePendingDeletionAdmission` in
  `pending-deletion-admission.ts` is a **pair and not a boolean**: `refuse_boot` when
  `--tenant-status-gate` is also on, because that flag is the column's only reader on the request
  path and a refused `pending_deletion` then costs the one thing the state exists for; `warn`
  otherwise, because without the gate nothing enforces the state either way and the cost is a stale
  status column, a `console.error` and an honest `tenantReadOnly: false` — with the lifecycle trail
  recording *nothing* rather than lying, since `recordLifecycle` answers `false` when no row moved.
  Refusing breaks nothing that worked in either case (the window has never held on an un-upgraded
  deployment, ADR-0338's rule), and what stops it being a refusal in both is that rule's other half.
  `PENDING_DELETION_ADMISSION_MAY_SERVE` is a total map so a fourth effect is a compile error, and
  `pendingDeletionAdmissionMessage` builds both sentences from one shared half and names no remedy of
  its own, because the `ALTER` has one producer.
  **And `surveyEnvelopeTenantReadiness` names api-key tenants with no `meta.tenants` row** under
  `--column-key-mode envelope` (ADR-0349's live finding (a)), whose every PHI read and write is
  otherwise refused by `tenant_data_keys_tenant_id_fkey` and surfaced as an HTTP **504** — a
  retryable status for a permanent fault. Three-valued (`provisioned`/`missing`/`unknown`), because a
  zero-row count means either absent or unreadable, and reported rather than refused since a JWT
  request carries its own tenant and the api-key specs are a lower bound.
  **`operate-server rekey` is the fourth maintenance subcommand** (ADR-0349) and the only one that
  writes: `--tenant <uuid> --confirm-tenant <uuid> [--plan]` moves one tenant's at-rest column key
  to a fresh random data key in a single transaction, re-encrypting their encrypted columns and
  retiring the old generation, which is what makes a later destruction bound anything. The tenant id
  is typed **twice** (ADR-0316's `confirmTenantId` rule, required even under `--plan` so the
  invocation an operator reviews is the one they re-run) and there is deliberately no `--yes`, since
  a flag meaning "I meant it" can be pasted from a runbook without reading the id. **Two** schema
  flags, which this subcommand cannot avoid: one `--schema` drives `PostgresDataKeyStore` (default
  `meta`) and `ColumnMappedEntityStore` (default `public`), so a single value would address the
  wrapped key correctly and the ciphertext wrongly for at least one configuration — and, finding no
  key where it looked, provision a second one. It must run on a session RLS does not confine, and
  refuses `permits_writes` with `--allow-live-rekey` as the hatch while **reporting**
  `no_tenant_row`, because an api-key principal naming an unprovisioned UUID reads that way.
  **`operate-server replay` is the first caller the six drift replayers ever had** (ADR-0337), and
  it is read-only. `REPLAY_SCOPE_SUPPORT` is a **total map** over the six subsystems because they do
  not share one scoping story, and the three arms are read off the catalog rather than chosen:
  `access_reviews` and `workflow` are **tenant-only** (their tables carry the isolation policy as
  their *only* arm, so a non-owner with no tenant context matches **zero** rows); `dr`, `slo` and
  `gateway` are tenant-or-platform (isolation plus a platform `SELECT` arm — measured on seven real
  captured executions: 6 for a tenant, 1 for the platform, and **1 as a non-owner but 7 as the
  owner** with no scope at all, so "every scope" is an owner-only diagnostic and never a sweep); and
  `incidents` takes **no** scope, since `meta.incidents` has no `tenant_id` and no RLS, so a scope
  flag is *refused* rather than ignored. A scopeless invocation is refused outright, and that is
  ADR-0322's rule applied where it bites hardest: the degraded answer prints `0 findings` having read
  nothing, which is **indistinguishable from a clean sweep**, so warning cannot be loud enough.
  Refusal is **per subsystem**, so `--platform` reads the three that can serve it and names the three
  that cannot. A report is `ok` only when every section was *readable* and found nothing — a refused
  section with zero findings exits **1**, because `0 findings` from something unread would otherwise
  launder it into a passing maintenance job. Each section carries `coverage` (how the scope was
  reached — clean from a tenant loop and clean from one unscoped read are different claims) and
  `complete` (whether a `LIMIT` cut the set), and both are needed because a complete-scope pass can
  still be window-truncated. The five findings vocabularies stay **five**, as a discriminated union:
  the meanings do not align, the finding identity differs with no common key, and three packages were
  already colliding on `interface DriftIssue` meaning three different things.
  **The repairing half is deliberately unreachable.** `resyncInstance`'s *derivation* is conclusive —
  an append-only log is the authority and a projection behind it is simply wrong, which is ADR-0322's
  appliable side — but the implementation is not safe to apply: it is not one transaction (1 + 3N
  statements through four stores, so a conflict mid-loop leaves exactly the half-resynced instance
  its own comment claims to prevent — ADR-0319 unapplied), and it writes `workflow_timers.status`
  and `workflow_activities.status`, the columns `claimDueTimers`/`claimDueActivities` select on, with
  an unconditional `ON CONFLICT … DO UPDATE` — so since ADR-0333 mounted the fleet it is a second
  writer editing a running queue. Detection is wireable, repair is not, and the surface says so.
  **It found real drift on its first run**: six `rate_limit_decision_not_found` over six captured
  executions, attributable — the in-memory checker persists **no** decision row while every execution
  still stamps an `rld_…` id, so declaring `--rate-limit-policy` takes it to 3 and 3 with zero
  findings. That is the **inverse** of ADR-0336's open end ("every decision row exists and nothing
  names it"), so both halves of that join are now known, and a boot warning says it before the sweep
  does.
  **`OPERATE_API_KEY_SPECS` is the environment route `--api-key` never had** (ADR-0357), owned by
  `api-key-source.ts` beside its own variable name and decision, the way `column-encryption.ts`
  owns `COLUMN_ENCRYPTION_SECRET_VAR` — `cli.ts` reads `process.env` nowhere by design, which is
  why the flag was the only route and why the shipped compose published the `platform_admin`
  credential on the host's process list beside a comment saying credentials do not travel that way.
  `resolveApiKeySpecs` is called **once** in `serve()`, before anything reads the specs, so the
  envelope tenant-readiness survey and the principal wiring take one answer. Both sources are
  **concatenated** rather than one overriding the other, because precedence means a deployment that
  set the variable and forgot the flag silently serves one set and which set depends on a rule
  nobody reads; the `both` verdict says so out loud. Split on newline **and** comma (a compose
  `environment:` block takes a multi-line value cleanly and a `.env` file does not, and neither
  character can occur in a `token:role:tenant[:principal]` spec), named `_SPECS` rather than
  `_KEYS` because `deploy/` already carries two variables holding bare tokens a *client* sends, and
  **warned rather than refused** — ADR-0338's rule read the other way, since every deployment today
  passes `--api-key` and works. The boot line is affirmative in both directions and never prints a
  spec.
  **A classified field's value reaching a caller through a cursor is surveyed at boot**
  (`decideCursorDisclosure`, ADR-0357) — the second cursor question, and the one that is live where
  ADR-0346's refusal is vacuous. Four verdicts, `CURSOR_DISCLOSURE_MAY_SERVE` every member `true`,
  the `plaintext_disclosing` line at **warning** level and the rest at info. The survey is the
  **sortable** set and not the default sort, which is the difference from `listSortConflicts`: that
  one walks `defaultSort`, which no caller can decline, and so earns a refusal with no hatch, while
  this asks what a caller can *choose* — and surveying the default would have missed `Patient.mrn`
  entirely. It borrows `listConfigForEntity`, `resolvedFields` and `entityClassifiedFields` rather
  than restating any of them, so it reads the set `parseListQuery` will accept and a classified
  **trait** field is in scope. Said after `checkAbacObligations`, because that check can refuse on
  the same secret and printing a second cursor finding first would hand an operator two when the
  first is the one that stops the boot.
  **Which declared list surfaces this store can express is surveyed at boot too**
  (`list-surface-survey.ts`, ADR-0359), with `LIST_SURFACE_MAY_SERVE` every member `true`: it
  reports and never refuses. ADR-0338's argument *does* hold — nothing served `?mrn=` correctly, so
  a refusal would break nothing that worked — and what stops it is the **remedy**, since the
  surface is declared by a *builtin pack's* view and an operator meeting the refusal could not
  clear it without editing this repository ("a remedy that cannot work is worse than none"). The
  honest reason a report suffices is that **the wrong answer is already gone**: the store refuses
  the request before the statement, so a boot refusal would buy no correctness and cost a
  deployment its boot. It is a fact about a **store choice** and not about a manifest — the same
  manifest has members on `pg-columns` and none on `pg`, which is why it cannot be a kernel rule
  and why `erp-healthcare` is not wrong to declare `mrn` filterable. Three verdicts, with
  `surfaces_refused` ranked above `search_narrowed` because reporting the milder of the two when
  both hold understates what an operator will meet. And **a per-tenant gateway that cannot be
  built now gets a 503** rather than the deployment's gateway: `serverFor` answers
  `{server} / {none} / {refused}`, `none` still falls back (that is the feature), and
  `onBuildRefused` logs under `[tenant-gateway]` — split from `onInvalidManifest` because that
  callback's sentence is *false* for a build failure, the manifest having passed both gates, and
  its implied remedy is therefore the wrong one.
  **And how many declared `unique` fields this deployment enforces** (`unique-enforcement.ts`,
  ADR-0360), said on all three stores, either way, including when the figure is zero — which is the
  half that would have surfaced 45 unenforced declarations four phases ago, and the hazard ADR-0350
  named: a passing check and a missing guarantee can be one sentence. A **pure function of
  `(manifest, storeKind)`** over a total map, and deliberately **not** of
  `ColumnMappedEntityStore.uniqueWithheld()` — the two stores that enforce nothing have no plan to
  ask, and *those are the deployments carrying the headline*: on `--store pg` + `erp-core` (the
  shipped compose default) the figure is **0 of 32**, not 2 withheld, so a store-sourced survey would
  have reported the small number on the deployment that is mostly right and printed nothing on the
  one that is wholly wrong. Three reasons, and `no_durable_store` is the survey's own rather than the
  emitter's, because `--store memory` is not the document store and that sentence would be false of
  it; the two vocabularies are joined by a **type-level `extends`** rather than a
  `Record<UniqueWithheldReason, …>`, since the `Record` form breaks whenever this package's `dist` is
  a build behind the emitter's source — ADR-0307's conditional green — while the property worth
  fencing is coverage and not a correspondence. It **reports and never refuses**: ADR-0338's premise
  holds (nothing was enforced, so a refusal breaks nothing) and two measurements take it away — the
  remedy is a data migration no operator owns, and the degradation is **permissive** rather than a
  wrong answer, which is ADR-0359's line (*an absent unique index changes neither which rows come
  back nor their order*). **Where the store can answer, it is asked and the two are compared** as
  sets of (entity, field) and not by count, because two lists of equal length naming different fields
  is the divergence a count cannot see: they are independent derivations of one fact, so a divergence
  makes the *boot line* wrong, not the DDL, and an operator reading `33 of 34 enforced` would be
  trusting a figure that no longer describes the indexes. Free, since the plans exist by then — and
  it is also what keeps the store's method from being a second spelling with only a test behind it.
  `onApplication`'s `applied: true` arm reports a **per-tenant** withheld index, which it did not:
  it `return`ed early, which is exactly the arm one arrives on, so the fact reached nobody — the same
  defect `onUniqueIndexRefused` exists to prevent, one path over, in the file whose comment argues
  against it.
  **And whether any view declares its own role list** (`view-permission-survey.ts`, ADR-0361), which
  nothing reads. `validateManifest` checks those names against `manifest.roles` and its comment
  claimed an undeclared role *"fails closed at serve time"* — false in the direction that made the
  gap look handled: `listConfigForEntity` is the only serve-time reader of `manifest.views` and takes
  `columns`, `sort` and `pageSize` from it, through a structural `ListViewLike` that has **no
  `permissions` member at all**, while `UiSchema` carries no view either — so there is not even a
  client that *could* honour the declaration. An override is therefore strictly *wider* in effect than
  it reads: the view is presented per the entity's grants. A **pure function of the manifest** and so
  said once rather than per store, unlike the surface survey beside it. Reports and never refuses, and
  the argument is not ADR-0338's: the measured count of overriding views across all seven packs is
  **zero** (132 views, every one `"inherit"`, all of kind `list`), so a refusal would break nothing —
  what stops it is that the declaration is **not served at any layer**, so nothing is partially
  honoured and the remedy an author wants does not exist (ADR-0334). Said either way including when
  the count is zero, which it is everywhere, and that is exactly when it costs nothing to start.
  **And `checkAbacObligations` no longer claims "none declared" when an obligation sits somewhere it
  does not walk** (ADR-0361). `surveyAbacObligations` takes a `PermissionMap`, so it is total over
  `manifest.permissions` and nothing else — while an `RbacGrant`, which carries `abac`, also hangs off
  a **report** and a **dashboard**. A manifest whose only obligation sat there booted cleanly and
  printed *"abac obligations: none declared, so no grant depends on an ABAC evaluator"*, the one
  sentence added so that "we checked and found nothing" could not be claimed from silence — it was
  claiming it from a narrower survey. `unservedPositions` is **reported, never refused**, and the
  distinction is ADR-0340's own: its refusal has no hatch because *serving a grant with its qualifier
  removed is the opposite of what the manifest declares*, and nothing serves a report or a dashboard,
  so there is no partially-honoured grant. The two positions that *were* deletable were deleted
  instead at a measured cost of zero — `PermissionRefSchema.abac` on a view and the redundant
  unbounded top-level `abac` on a report. `where` is a rendered location rather than a structured
  position, deliberately: `ABAC_GRANT_POSITIONS` is a closed vocabulary that two total maps answer
  over, and adding a member for a surface no handler reaches would oblige both to answer availability
  and denial-effect questions about a request that cannot happen.
  **`/health` and `/readyz` exist** (`health.ts`, ADR-0357), wrapped **outermost in front of the
  gateway** — a probe carries no credential, so a gateway route would be 401'd by the auth stage,
  which is the bounce webhook's argument read the other way round. The split is the whole design
  and getting it backwards is invisible until the first outage: **liveness touches nothing** and a
  failed one gets the container *killed*, so a liveness probe that checked Postgres would fail on
  every replica during a database outage and the orchestrator would restart all of them repeatedly;
  **readiness checks Postgres** and a failed one takes the instance *out of rotation* and leaves it
  running, which is the correct response to a dependency it cannot reach. `SELECT 1` and not a table
  read, because a probe selecting from `meta.tenants` would be answered by RLS, ownership and a
  grant as much as by the database's health. Both unauthenticated, so the body is a **closed
  vocabulary** — a check's declared lowercase name and one of three enumerated outcomes, no version,
  no uptime, no dependency error text, and `durationMs` on the report and *not* in the response,
  since a timing an anonymous caller can poll measures the database's load from outside the
  perimeter. Cost is bounded by **in-flight collapse** and deliberately **no success cache**, because
  a cache asserts reachability on the evidence of a round trip already finished; the slot is released
  **inside** the settle handlers, so its lifetime is exactly "the probe is in flight" and a joining
  request cannot be served a stale `ready`. The timeout is a **race, not a cancellation**
  (`PgConnection` cannot cancel a statement), so releasing at the budget would leak one connection
  per probe against a wedged database — the pool exhaustion the collapse exists to prevent, caused
  by the surface meant to report it. The check list is **required and may be empty**: `[]` is a
  signed assertion that `--store memory` needs nothing to serve, where an optional field could be
  forgotten with the type still valid and every probe would answer 200 for a process whose database
  is gone.
  **A password is settable over HTTP since ADR-0364** (`credential-routes.ts`), which closes the one
  step of a tenant's onboarding that needed a shell. **Two** routes, and they are gateway routes
  rather than interceptors — the login is outside the gateway because `authenticate` runs before
  `match_route` and a login carries no credential that stage would accept, while both of these
  carry one. `POST /v1/platform/users/{id}/credential` is the operator's, gated on
  `--credential-admin-role` and mounted only when a role is granted; `POST /v1/account/password` is
  the person's own, gated on nothing but `--credential-login`, so a deployment that mounts the
  login gets self-service for free and an operator grant is the deliberate addition. The split is
  **what authorises them** and not whom they are about, which is why this is not
  `buildSetHandler(ctx, onBehalf)`: the operator route is authorised by a grant and takes no
  current password, the self route by possession of the current password and takes no subject —
  *"the viewer is always the credential"* (ADR-0331), load-bearing here rather than tidy, since a
  subject parameter on the self route would be the operator route without the grant.
  `--credential-admin-role` is its own grant and not `--platform-user-role` re-read, on a live
  measurement: **`meta.users` carries no `tenant_id`, no RLS and no policies**, so the role check
  is the *entire* authorization for a write to it, with no policy belt behind it — and
  `--credential-admin-role` without `--credential-login` is **refused** at parse, because these
  routes hash under the pepper the login verifies with, so the grant would otherwise be silently
  inert. `self_not_permitted` is the checkable part of four-eyes for a credential: the operator
  route skips the possession proof, so aiming it at the caller would let a stolen session replace
  its own credential — refused **before any store call and before any audit row**, since an act
  that must not be expressible is not a write anyone wants a row for. `confirmUserId` repeats the
  path id (ADR-0316's `confirmTenantId` rule — this overwrites a credential, so naming the wrong
  user both locks that person out and hands their account to whoever typed the password) and is
  compared case-insensitively. The record goes **before** the write and an unrecordable one is a
  **503** (ADR-0313's rule, ADR-0334's status), while a *refusal* row is best-effort, because
  nothing changed and a lost refusal row must not become a 503. The audit scope is the increment's
  one asymmetry: an operator's write files at **`tenantId: null`**, platform scope (ADR-0331),
  because a credential is a property of the user and not of any one membership so filing it under
  the operator's tenant would file it under an arbitrary one — while a self-service change files
  against **the caller's own** tenant, which is the only one it is about. The refusal set is
  **smaller than the CLI's by construction**: `pepper_absent` and `pepper_refused` cannot be
  reached, because the routes are built from the same `resolveCredentialAuth` material the login
  is. `PostgresCredentialStore.findById` is the read they need, with **no `spendPasswordWork`
  obligation on a miss** — the one way it differs from `findByEmail`, which an unauthenticated
  login reaches and where an early return is an account enumerator; every caller here is past the
  auth stage and naming its own id or one it holds a grant over, so there is nothing to enumerate.
  **The self route honours the login's lock and advances the login's counter** (ADR-0364's addendum),
  through `credentialIsLocked` exported from `auth-token-route.ts` rather than a second spelling —
  because a second spelling is how the two doors came to disagree, with the login refusing a locked
  account and this route verifying passwords against it at full speed. A `mismatched` outcome counts
  and `unreadable_hash` does not, which is `REFUSAL_COUNTS_AGAINST_LOCKOUT`'s split one surface over,
  and a locked attempt counts for neither, on the login's own rule that hammering a locked account
  must not extend its own lock. `account_locked` is **429**: the login answers one body for every
  refusal because an unauthenticated caller must learn nothing, and this caller is already
  authenticated as the account in question, so the useful answer is the one that says *stop*. The
  operator route deliberately does **not** check the lock — setting a password *is* how a lockout is
  cleared, and `setCredential` clears it in the same statement, so checking it there would make the
  remedy unreachable from the surface that applies it.
  **And both routes consult `status`**, which `findById` has always returned and nothing read.
  `CREDENTIAL_WRITE_BY_STATUS` is a total map over `USER_STATUSES` and the split is **terminal versus
  recoverable**, read off `USER_STATUS_TRANSITIONS` rather than off a status name: `deleted` has no
  outgoing transition, so a password set there could never be used and the route refuses
  `user_not_active`; `suspended` transitions back to `active`, so the write lands and the 200 carries
  `loginBlocked` and `subjectStatus` saying what it does not yet buy (ADR-0322). `selfMay` is false
  for every non-active status, because a session minted before a suspension stays valid until it
  expires (ADR-0358), so a suspended person can still reach that route — and rotating the credential
  they were suspended from is the one thing the suspension exists to stop. `asUserStatus` **parses**
  rather than casting, since `CredentialRecord.status` is a bare `string` constrained only by the
  column's CHECK, so a row from a later binary takes the fail-closed arm instead of indexing the map
  with a key it does not have.
  **A session carries every role its membership grants** (ADR-0369), over three functions that are
  one round trip: `roleFor` returns the row's `SessionRoles {primaryRole, secondaryRoles}`,
  `sessionScope` composes the `scope` claim (primary first, de-duplicated, secondary order
  preserved) and `principalRolesFromScopes` reads it back — exported and tested **across** each
  other, since a change to one that the other does not follow is the defect restated. `secondaryRoles`
  is **required** on the pair (`[]` is the claim, which the `NOT NULL` column really carries) and the
  pair is named rather than positional, because which role is primary is consequential: it is the one
  `UiViewer.primaryRole` shows and the only one an api-key spec can express. `sessionScope`
  **throws** on a role name carrying whitespace, which is the one fence the vehicle needs — the claim
  is space-delimited, so `"hr manager"` would arrive as two roles, neither declared — and
  `SCOPE_DELIMITER` is a constant because the refusal and the join must be about the same character.
  The reader is deliberately **total and uninterpreting**: no de-duplication, no filtering of
  undeclared names, no case folding, because every consumer already fails closed on a name it does
  not know and a reader that dropped one would make the fence reporting it unreachable.
  `formatScopeRoleReading` is the boot line, beside the reader rather than with the other surveys
  (ADR-0361's rule), `null` for an api-key-only deployment, and its second clause is the increment's
  one behaviour change: a token this deployment did not mint has its scopes past the first read as
  secondary roles.
  **A membership grant says whether the role it names is one the tenant's manifest declares**
  (ADR-0365, `membership-role-fence.ts`). `MembershipRoleDirectory` answers
  `(tenantId) => Promise<ReadonlySet<string> | null>` and the `null` is the whole of it: an **empty
  set** asserts *this manifest declares no role* and `null` says *nobody looked* (ADR-0331), so the
  two produce different verdicts — `not_declared` carrying the sorted catalog, `unresolved` carrying
  `declaredRoles: null` and **naming no remedy**, because nothing was read so the grant may well be
  correct. A private discriminated `RoleCatalog` carries the set and its sorted names together, which
  makes the conflation *unrepresentable* rather than merely avoided: the first implementation wrote
  `declaredRoles: verdict === "unresolved" ? null : (declaredRoles ?? [])`, and that `?? []`
  substitutes the claim for the gap in the one module whose central decision is to keep them apart —
  unreachable as written, and the direction of a dead default is still the wrong one. A directory that
  **throws** answers `unresolved` rather than propagating, since the fence is advisory and rides a
  privileged write. It is consulted **once** per check and not once per role, because a manifest can
  be activated between two calls and a warning set drawn from two answers describes no single
  manifest. `warningVerdictOf` returns `null` for `declared` through compiler-established narrowing
  and *then* reads the total map, where a type predicate over a map lookup would be an annotation
  standing in for a check (ADR-0362).
  It covers **both** write paths — `buildGrantMembershipHandler`, whose tenant is the path's, and
  `provision`'s optional nested membership, which uses **that membership's** `tenantId` — and the
  tenant it asks about is pinned by a test, because mutating either path to the wrong tenant left all
  84 tests green. The warnings ride **two** places: the 201 body (always present, `[]` and never
  omitted, since an absent field reads as *none* and is indistinguishable from *not checked*) and the
  audit `detail`, set on the event **before** `record` so the row carries what the operator was told
  (ADR-0313's ordering). The **two positions are not one defect**, and **ADR-0369 changed what
  separates them**: at the time, an undeclared secondary cost nothing extra because a declared one
  would not be read either — `roleFor` returned `membership.primaryRole` alone and the mint stamped
  `scope: input.role`, one string, *and* `principalRoles` returned **no `secondaryRoles` key at
  all** — so the secondary warning named the mechanism and deliberately withheld the declared
  names, which is the promise the console's first renderer reinstated and the review removed. Both
  halves are closed, both positions offer the names, and what survives is the **consequence**, held
  in two total maps over the position (`NOT_DECLARED_COST`, `UNRESOLVED_COST`). That difference is
  also weaker than it was: a *declared* secondary beside an undeclared primary now carries grants,
  so the primary's sentence is qualified **unless a declared secondary role carries one**, and only
  the empty-catalog branch is unconditional — if the manifest declares no role, no secondary can be
  declared either.
  `node.ts` builds the directory from the boot manifest's `manifestRoleNames` and answers `null` two
  ways under `--per-tenant-manifests`: an unparseable stored manifest (one the gateway cache refuses
  to build anyway) and one declaring `meta.extends`, whose parents contribute roles `roles` does not
  hold and whose lineage is the cache's to resolve rather than a second resolution here.

  **And both registry list handlers refuse a parameter they used to drop** (ADR-0365).
  `parseRegistryListQuery` is one parser with the status vocabulary as its **argument**, which is why
  it is one: the two handlers differ in nothing else, and two copies is how both came to drop
  `?status=bogus` identically and in silence. `LIST_QUERY_REFUSAL_OUTPUTS` is a total map over the
  three refusable parameters so a fourth is a compile error rather than a 400 with no explanation,
  and each reason says **what the parameter used to do instead**, because that is the half a caller
  cannot see. `decodeUserListCursor` answers `number | null` and the store's own offset read
  **throws**, so a direct caller of `list()` is refused too and not only one arriving through a
  route. `suppliedQueryValue` treats an empty value as absent — one rule for all four parameters,
  since a form serialises an unset field as `?k=` and ADR-0359's class is about a value the caller
  *did* supply being dropped; without it the console's own cleared email box would 400. The page
  size is **not** adjudicated by ADR-0359's rule, which is which-rows versus order and does not
  reach how-many: `?limit=abc` is refused because a caller named a page size and supplied something
  that is not one, and `?limit=9999` clamps because `REGISTRY_LIST_MAX_LIMIT` is a platform decision.
  `?email=` is served with no refusal of its own, for the inverse of the rule — an address nobody
  holds narrows the answer to zero rows, which is the right answer rather than a mistake to report.
  `GET /v1/platform/users/stats` is its own route and deliberately not folded into
  `GET /v1/platform/stats`, which is mounted under a different grant, so merging would make user
  counts require the tenant-administration grant. It is declared **before** the `{id}` route *and*
  that parameter carries `UUID_SEGMENT_PATTERN`, each pinned by its own mutation — the pattern is
  what decides, since `matchRoute` returns the first match and `pattern: null` matches any segment,
  and the ordering costs nothing beside it. The pattern is **not** looser than the handler's parse,
  which an earlier comment claimed: measured over 20,000 random hex segments it diverged from
  `z.string().uuid()` **zero** times, so the handler's 400 for a non-uuid id is unreachable through
  the matcher and a test pins the two agreeing. `MAX_LIMIT` became `REGISTRY_LIST_MAX_LIMIT` because
  **eleven** sibling modules in this app hold the bare name privately, none exports it, and
  `index.ts` re-exports this file with `export *`.
  Append:

  **The anchor check's own finding** (ADR-0373). `listAnchoredForScope` used to **drop** a row the
  contract refuses, under a comment arguing *"an old record must not hide every newer one"* — right
  about throwing and wrong about dropping, because this read's consumer is the anchor check and a
  dropped row is a row the detector is never asked about. It answers `AnchoredAuditRead {rows,
  unreadable}` now; `verifyAuditAnchors(tenantId, rows, chain, unreadable)` takes the fourth argument
  **required** and `AuditAnchorReport.unreadable` is its own axis rather than a sixth
  `AuditAnchorVerdict` — structurally, because a refused row never becomes an `AnchoredAuditEntry` and
  so cannot be *in* `results`, and because `TAMPERED` is a `ReadonlySet` so a sixth member added to it
  and to nothing else compiles and reads as neither disproven nor unproven (ADR-0351). The verdict
  clause sits **beside `tampered`**: an unanchored row is the absence of evidence and pages nobody,
  while a row this reader refuses is evidence of something, since `assertEmittable` now ends in the same
  `AuditLogEntrySchema.parse` the reader runs. `listForTenant` still answers a bare array and still
  drops the refusal, because its consumer is a reader; `audit-read-store.ts`'s `rowToEntry` still
  **throws**, with its reasoning already on file (*"the caller turns it into a refused page, not a
  shorter one"*) — two opposite choices for one mapper in one app, decided by whether the consumer is
  serving a page or computing a verdict, which is the increment's thesis confirmed in-repo. The refused
  rows are named by `formatIntegrityProof` and nowhere else: the durable record carries the fact
  through `verdict`, and a count in the stored report would have to move `integrityVerdictPayload`,
  `StoredIntegrityReportSchema`, `canonicalStoredReport` and `storedIntegrityReportFor` together or break the
  parity ADR-0371 reverted a field out of.
- **`apps/operate-web`** — **long-running process** (Next.js app router + Tailwind, `next
  dev`/`next start` on :3000). The generic manifest-driven UI: a catch-all `/api/[...path]`
  proxy to operate-server, dynamic entity list/record/form pages under `/e/[slug]` rendered
  from the server's `UiSchema`, an inbox, reports (aging, WHT, period close), tenant admin
  (settings, billing), a setup wizard, and a platform console for tenant provisioning and
  design reviews. No package `bin`; deployed as a web server, not a CLI.
  **It authenticates people since ADR-0358, and until then it authenticated nobody** — one fixed
  `OPERATE_API_KEY` as `x-api-key` on every request, defaulting to the literal `"devkey"` when
  unset, so every browser that could reach the domain was that principal. What is there now:
  `middleware.ts` (the only gate available, since all 15 pages are `"use client"` and 11 are
  statically prerendered, so a server-side `cookies()` check in a page body is impossible),
  `/login`, two auth route handlers, an `httpOnly; Secure; SameSite=strict` session cookie whose
  lifetime is derived from the API's own `expiresAt`, and a proxy that forwards **the viewer's**
  token and 401s without calling upstream when there is no cookie. `OPERATE_API_KEY` and its
  `?? "devkey"` default are **deleted** rather than left unset, because that default meant removing
  the variable did not fail closed.
  Two shapes are worth knowing. The authenticated chrome moved into one `AppChrome` client
  component keyed on `usePathname()` rather than 15 pages into a route group — a route group does
  not escape the root layout, and this kept all 11 static pages static. And the proxy answers
  `/api/*` with a **JSON 401** rather than a redirect, because `fetch` follows redirects by
  default, so a redirect would hand every caller a 200 carrying the login page's HTML with
  `res.ok` true. The cookie is only a hint: the API verifies the token on every request, so a
  forged one is a 401 **from the API**.
  **It manages people since ADR-0364** — `/platform/users`, `/platform/users/[id]`, a Members panel
  on `/platform/[id]` and `/account` — which is what made the ten identity routes
  `--platform-user-routes` has mounted since ADR-0335 reachable by anybody without `curl`.
  `lib/users.ts` is the contract and it **imports** `PlatformError` and `throwProblem` from
  `lib/platform.ts` rather than restating them, because the 401-redirect inside `throwProblem` is
  the half a second copy forgets. Three shapes are worth knowing. The status buttons are driven by
  `USER_STATUS_TRANSITIONS` / `MEMBERSHIP_STATUS_TRANSITIONS`, mirrors of the server's maps, so a
  button is offered exactly when the transition is legal rather than offered and 409'd. The
  set-password panel's confirmation field is **deliberately not seeded from the route param** —
  prefilling it from the same `id` the request is aimed at would confirm nothing — and it
  distinguishes the two 404s (`user_unknown` from the route, versus the gateway matcher's
  `no route for …` when `--credential-admin-role` is not granted), which is the one refusal whose
  remedy is a deployment flag rather than anything the viewer can do. `/account` is the one page
  that does **not** go through `lib/users.ts`, for a measured reason: **401 is three different
  facts on that path** — no cookie (middleware or proxy), and a perfectly good session whose
  *second* authentication failed (`current_password_wrong`) — and `throwProblem` reacts to the
  status alone, so through it a mistyped password starts a document load to `/login` that
  `middleware.ts` bounces straight back, giving a page flash, three cleared inputs and nothing
  said. It reads the body's `error` code as the discriminator and still hands a genuine 401 to the
  shared `redirectToLogin`, so it is a second reader of the body and not a second copy of the
  reaction. It also renders the server's `sessionsRevoked: false` rather than paraphrasing it,
  behind a **narrowing predicate** and not a cast, because that field decides which of two opposite
  sentences a reader sees and an omitted one reads as `false`.
  `Sidebar.tsx`'s active-link state is a **longest-matching-prefix over a declared list** since the
  same increment, where it was `pathname.startsWith("/platform") && !pathname.startsWith(…)` —
  an exclusion list that every new platform page has to be added to, and which lights two links at
  once when it is not.
  It still has **zero tests**, so it is outside the sweep — though no longer outside every strategy
  rule: `entity-field-aperture.ts` (ADR-0361) walks it through a local fs walk, because that member
  has no `src/` and is therefore invisible to the other nine, and it is where 25 of the class's
  `.fields` reads live (all on the `UiEntitySchema` that `ui-schema.ts` produces, and so all
  downstream of the one raw reader that decides what the client sees at all),
  and the login and console flows are verified by `tsc`, `next build` and a live run.

## Cross-cutting invariants

Recurring patterns enforced by zod `superRefine`:

- **Four-eyes principle.** Wherever an action is privileged (deletion, hold
  release, postmortem review, template approval), the actor must not also be the
  approver: `executedBy !== approvedBy`, `author ∉ reviewers`,
  `releasedBy !== issuedBy`.
- **State machines.** Most lifecycle types export a `*_STATUSES` enum, a
  `*_TRANSITIONS` map and a `canTransition*` helper. Schemas enforce
  status↔required-field pairing. Walk the map; don't hardcode paths.
- **Cryptographic anchoring.** sha256 content addressing throughout — dataset
  freezing, deletion proofs, evidence sealing, postmortem storage, webhook
  signing; ed25519 for pack signing and chain entries.
- **Tenant scoping.** Records with `tenant_id` get RLS. Cross-tenant
  audit/compliance records are platform-wide (cdc checkpoints, regions, plans,
  deployments, ediscovery, tombstones).
- **Forbidden lists.** PHI/regulated data can never be used for ML training
  (`FORBIDDEN_TRAINING_DATA_CLASSES`). The `latest` docker tag is forbidden.
  Two-person integrity for human evidence collection.
- **Deadlines.** Where regulation imposes timing (GDPR 72h breach, Article 12(3)
  three-month deletion), the schema enforces it.
- **Fail closed.** When a check cannot be completed, deny rather than allow. An
  unresolvable identity yields an empty result set, never an unfiltered one; an
  unrecordable privileged read is refused, not served unaudited.

## Meta-schema

`packages/kernel/src/bootstrap/meta-schema.ts` is the central catalog of **146**
platform-level Postgres tables. Each new package adds tables there and updates
`meta-schema.test.ts` (count, sorted expected-names list, column assertions).

**A fresh database holds one more table than the catalog does**, and it is not a stale count:
`information_schema` reports 147 `meta` base tables against `META_TABLES`' 146, because
`_meta_migrations` is created by `kernel-pg`'s applier for its own per-statement hash bookkeeping and
is deliberately not emitted from the catalog. Verified. Count the catalog, not the database.

Four invariants the test suite enforces:

1. Every `tenant_id`-bearing table has RLS enabled.
2. Foreign-key references resolve to a table declared **earlier** in
   `META_TABLES`. If a new FK points at a table declared later, move the target
   earlier rather than dropping the FK.
3. **No policy predicate anywhere contains `IS NULL OR`** (ADR-0332). A platform read arm is
   `SELECT`-scoped with `using` exactly `tenant_id IS NULL`; each read arm has exactly **one**
   matching `INSERT` arm; and a write grant is always ANDed with `tenant_id IS NULL` and never
   appears on a `SELECT` policy. That is a rule plus a count rather than a maintained list, because
   a maintained list is what ADR-0288's `needsAuditEmitter` was and it was wrong three times —
   `kernel-pg`'s canonical test matches `/_platform_(audit_)?(read|write|update)$/` and asserts
   **78**, so a 30th table cannot land without the number moving.
4. **Both sides of a cross-column comparison are one type** (ADR-0335), or the constraint is not a
   constraint. `crossColumnTypeDisagreements` extracts binary comparisons between two bare column
   identifiers and requires their declared types to agree. It exists because making
   `workflow_definitions.created_by` TEXT while `published_by` stayed UUID rendered the four-eyes
   CHECK as `published_by <> created_by` — and Postgres has **no `uuid <> text` operator**, so the
   `CREATE TABLE` raised `operator does not exist` and took the **entire bootstrap** with it at
   statement #0 of 960, while every offline test passed: the emitted-SQL assertions compare
   *strings*, and a string containing a comparison between two types Postgres cannot relate is a
   perfectly well-formed string. `IS NULL`/`IS NOT NULL` are unary and deliberately excluded, since a
   naive "two columns of different types in one expression" rule false-positives on
   `published_at IS NOT NULL AND published_by IS NOT NULL` and would train people to add exemptions.
   Five comparisons today, with a vacuity guard asserting both four-eyes pairs are found and both
   sides of each are TEXT.
   **Its blind spot is the same defect in a store's predicate, and it had a live member** (ADR-0370):
   the rule extracts comparisons *from CHECK expressions*, and `META_NOTIFICATION_TEMPLATES` carries
   no table constraint and no CHECK naming `created_by` — measured — so when ADR-0335's actor sweep
   reached `created_by` and missed `approved_by` two lines down, the resulting `uuid <> text` lived
   only in that store's `UPDATE` predicate and every approval raised `42804`. A rule over the
   *operands a store compares* is the open end; `pg-column-bindings.ts` already derives which symbol
   a parameter carries, so the operands are resolvable.

**`TENANT_FK` is absent from the 16 `PLATFORM_RECORD_TABLES`** (ADR-0335), on the rule that *a table
whose purpose is to outlive the tenant it describes cannot be a `CASCADE` child of that tenant's
row*. Fifteen of them were, and ADR-0320 retires the tenant row after the pipeline commits — so the
erasure's compile-time retention set was correct and the foreign key undid it one statement later,
leaving every Article 17 proof `unwitnessed`. Isolation is unchanged: RLS still confines these rows
per tenant and the erasure still skips them by name. Reordering the retirement does **not** fix it —
ADR-0329 records that `meta.audit_log.tenant_id` references `meta.tenants`, so retiring first makes
every erasure unrecordable. `packages/testing/src/strategy/pg-record-retention.ts` compares the two
halves from disk in **both directions**, with a negative control.

**`meta.tenant_data_keys` carries `TENANT_FK` for exactly the inverted reason** (ADR-0347): it is
the one table whose *survival* defeats its own purpose, since a wrapped key outliving its tenant is
a key nobody destroyed. The Article 17 erasure needed no new code to reach it — confirmed by the
shared-table erasure's own target counts failing on 114 → 115 the moment it was catalogued, which is
the fence doing its job rather than a test to update — but **the mechanism is the delete by name and
not the cascade** (ADR-0349): `eraseSharedTablesWithin` reaches the row because it carries
`tenant_id`, and the `ON DELETE CASCADE` has **never fired and cannot**, because nothing in the
workspace ever deletes a `meta.tenants` row. Retirement is `UPDATE … SET status`. So the cascade is
not a second fence; it is inert, and this file credited it with the erasure for two increments.
**And it is not one table's quirk: 99 catalogued tables reference `meta.tenants` with
`ON DELETE CASCADE` and not one of those cascades has ever fired**, for the same reason — so every
argument anywhere in this file that rests on a tenant cascade is resting on a mechanism that has
never run.
The constraint is **not** inert, though, and that is its live consequence: a tenant with no
`meta.tenants` row cannot have a data key at all, so `--column-key-mode envelope` answers every PHI
read and write for an unprovisioned api-key tenant with `tenant_data_keys_tenant_id_fkey` — reported
as a 504. A boot survey names them. It carries **no platform
arm**: a data key is never platform-scoped, `tenant_id` is NOT NULL, and a platform read arm would
let any tenant's gateway session read every tenant's wrapped key.

**`meta.users` carries the login credential in four columns, and the upgrade is free** (ADR-0358).
`credential_hash` / `credential_updated_at` / `credential_locked_until` are nullable and
`credential_failed_attempts` is `NOT NULL DEFAULT 0`, which is the split rather than an
inconsistency: a provisioned user holds no credential until one is set and *no credential* must stay
distinguishable from *a credential nobody matched* (ADR-0331), while absent and zero are the same
fact for an attempt count. Nullability is also what keeps `provision`'s two literal `INSERT`s valid
against `missing_required_column`. The hash's CHECK is a **regex** naming the KDF
(`^scrypt\$…\$[0-9a-f]{32}\$[0-9a-f]{128}$`) rather than a value set, so it needs no
`pg-value-set-domains.ts` declaration — `check-admission.ts` classifies `~` as `pattern` — and the
parameters live *in* the string so there is no sibling `algorithm` column to disagree with the
bytes. Measured on a **populated** table with the columns dropped to reproduce an un-upgraded
deployment: **4 planned, 0 unreconciled, 4 executed, re-plan clean**, with both CHECKs riding along
on their `ADD COLUMN`. That last part is why ADR-0330's widening-versus-narrowing problem cannot
bite here and does for `proof_version`: a CHECK on a column the plan is *adding* has no existing
rows to validate against.

**`meta.access_review_decisions.attestation_phrase` exists because a declared contract field with
no column is invisible to every workspace rule** (ADR-0362). `DecisionAttestationSchema` declared
it, `canonicalAttestationBytes` hashed it into the bytes `attestation_signature_sha256` commits to,
and the `INSERT` beside it was **complete over this table** — so `pg-column-coverage`,
`pg-binding-names` and `pg-record-reads` all passed, because every one of the ten rules compares SQL
against the catalog or the catalog against a value set and **none compares a contract field to a
catalog column**. Measured: an authored phrase round-tripped to `undefined`, and since
`canonicalStringify` skips undefined keys it left the payload a **key short** rather than null, so
the signature over a signed attestation carrying a phrase could never be recomputed from its own
row. `attested_at` deliberately gets **no** column beside it and the asymmetry is the decision:
that one duplicates `decided_at`, which the sole live producer (one `nowIso`), `rowToDecision` and
`EvidenceBundleDecisionRow` all treat as one instant, so storing it would invent a second fact
nothing in the tree distinguishes; this one duplicates nothing and is the only evidence
`typed_attestation_phrase` carries. Nullable TEXT with a `length(...) <= 500` CHECK matching the
contract's `max(500)`, and the migration is free for ADR-0358's reason — a CHECK on a column the
plan is *adding* has no existing rows to validate against. Measured on a fresh database and on a
populated one with the column dropped: **1 step, 0 unreconciled, re-plan clean**.

**`meta.tenant_tombstones.record_storage` is nullable with no default, and that is the whole
decision** (ADR-0351) — `retained_obligations`' choice for a sharper reason. NULL means *this
record's bytes do not cover a record-storage declaration*, true of every v1, v2 and v3 row, and
there is no honest default to give them: all three `RECORD_STORAGE_MODELS` are *claims*, so
`{"model":"document_rows",…}` would assert that the deployment had no typed relations — precisely
the assertion ADR-0350's gap made unavailable — written onto rows whose digests never covered it,
and then refused by the contract's version pairing anyway. The column's sibling is the widened
`proof_version` CHECK, and the two **used to** migrate differently: on an empty table the plan was
`2 steps, 0 unreconciled`, and on a populated one `1 step, 1 unreconciled` — the column landing and
the CHECK handed over as SQL, because ADR-0330 cannot tell a widening CHECK from a narrowing one.
**Since ADR-0363 both land**, because the plan asks **Postgres** whether the declaration widens
rather than assuming it cannot know: the four-to-five-value change is one `predicate_implied_by`
proves, so the `replace_column_check` is planned on a populated table too. `proof-version-probe.ts` was replaced
by ADR-0352's general survey and the boot fence over it is what survives; see the `operate-server`
entry.

**`meta.forensic_chain_checkpoints.provenance` records how the anchor came to be trusted, which is
the fact a bounded verification rests on and that no checkpoint carried** (ADR-0371). Nullable TEXT
with a three-value CHECK and **no default**, `record_storage`'s treatment for its reason: every
checkpoint on disk predates the column and all three values are *claims*, so defaulting one would
assert that something verified a prefix whose writer asserted nothing — and absent is exactly the
state `checkpointAnchorsBoundedProof` answers `false` for. **Nothing in a deployment writes
`unverified`, and the write path obliges a hand-placed anchor to**: `CheckpointMeta.provenance` is
**required** where the contract field is optional, which is the asymmetry rather than an
inconsistency — on a stored row absent means *an older binary wrote this*, so a current writer
permitted to omit it would make a new row indistinguishable from one of those and absent would stop
meaning what the refusal reads it as meaning (ADR-0331). A caller holding no verification therefore
refuses **by name** rather than by silence. The scheduler is not that caller: it writes **no row at
all** for a scope whose verification did not pass, on two costs that compose. `latest()` returns the
newest row, so an unverified anchor would **mask an older verified one** and convert a bounded
deployment into a full-folding one on a single bad pass; and `record` is
`ON CONFLICT … DO NOTHING` on a table ADR-0332 made immutable-by-RLS, so for a **tenant** scope the
masking would *persist* after the chain was repaired — the later good anchor at that sequence no-ops.
A transient fault would become a permanent cost whose only remedy is understanding `DO NOTHING` and
waiting for the chain to grow (ADR-0334's rule). The persistence half does not hold for the platform
scope, where the conflict arm never fires at all (see below) and a later anchor at one sequence wins
on the newest-first tiebreaker — so the masking is self-healing there and the refusal rests on the
first cost alone. So `CHAIN_FULL_REASONS`' `anchor_unverified` is reachable from a hand-placed
anchor and from no deployment, which is said rather than claimed otherwise, and the gap it leaves —
a scope that stopped verifying leaves nothing in the database saying so — is why
`CheckpointSchedulerOptions.onRefused` is **required** while the other two callbacks are not.
The migration is free for ADR-0358's reason: a CHECK on a
column the plan is *adding* has no existing rows to validate against, so ADR-0330's
widening-versus-narrowing problem cannot reach it — measured on the pre-migration cluster as
**1 planned step, 0 unreconciled, 1 executed, re-plan clean**.
**And this table's `UNIQUE (tenant_id, sequence_number)` does not constrain the platform scope**
(ADR-0371): `tenant_id` is nullable with NULL meaning platform (ADR-0331), SQL treats NULLs as
distinct, so `(NULL, 3)` twice is legal and `ON CONFLICT … DO NOTHING` never fires for a platform
checkpoint — so an hourly pass writes a fresh row every tick on a table ADR-0332 made append-only,
and `includePlatform` defaults to true. The reads were given a newest-first tiebreaker because the
untiebroken order was measured returning the *stale* anchor; the constraint is unfixed, and the
migration rather than the DDL is the hard part (`UNIQUE NULLS NOT DISTINCT` is PG15 against a floor
of 14, and a partial unique index on `(sequence_number) WHERE tenant_id IS NULL` cannot be created
while the duplicates every such deployment already holds are there).

**`meta.dr_readiness_snapshots.unevidenced_axes` is why `ready` is no longer `total_issues = 0`**
(ADR-0372). Every count on that table is derived by *filtering* a supplied list, so an empty list
contributes zero issues and a deployment that recorded no backup, no drill and no runbook scored
`READY (0 issues)` — with the certification control signing it `satisfied`. The seven counts still
sum to `total_issues`, because each is projected as its own `INTEGER` column under a `>= 0` CHECK and
a reader sums them: an unevidenced axis is a **separate axis and not an eighth count**, so
`ready = false AND total_issues = 0` is exactly *"nothing wrong was found because nothing was looked
at"* and this column says which. Nullable `TEXT[]` with **no default**, which is the
claim-versus-nobody-looked distinction in the column itself (ADR-0331, ADR-0371's
`anchor_provenance_absent`): NULL is a row written before the check existed, `{}` is the signed claim
that every axis carried a record. Defaulting to `{}` would retro-assert the second over every stored
row, which is the falsely-true direction. **No CHECK**, because an array-containment predicate is not
a shape `check-admission.ts` can probe and `DrReadinessReportSchema`'s own `z.enum` is the fence —
the argument the `report` JSONB column beside it already rests on; the column is also *derived* from
`report.unevidencedAxes` and never accepted, the seven counts' own rule, so the two cannot disagree.
The migration is free for ADR-0358's reason — measured on a populated table with the column dropped
to reproduce an un-upgraded deployment: **1 planned step, 0 unreconciled, 1 executed, re-plan
clean**, and the three pre-upgrade rows read SQL NULL rather than `{}`.

**Three columns whose unreadability defeats an audit carry a CHECK** (ADR-0373):
`meta.forensic_chain_entries.actor_reference` and `.signature` as `char_length(x) >= 1`, and
`meta.tenant_tombstones.attestations` as `jsonb_typeof(attestations) = 'array'`. Only three, measured
rather than chosen: **505 TEXT and 159 JSONB columns carry no CHECK**, 36+ of them
`NOT NULL DEFAULT '[]'::jsonb` with no array constraint, so "every contract refinement gets a CHECK"
is a separate increment and probably a further workspace rule — ADR-0362 established that none of the
rules compares a *contract field* to a *catalog column*, and this is that question's other half. The
upper bound is deliberately absent on the two TEXT columns, against the catalog's majority
`char_length(x) BETWEEN 1 AND N` idiom, because both contracts are `z.string().min(1)` with **no
maximum** and a CHECK refusing what the contract permits is the same defect reversed. The JSONB one
is `jsonb_typeof` and not `jsonb_array_length >= 0`, for two measured reasons: an empty array is that
column's own default and its legitimate claim, so a length bound would be testing something other
than what it says, and `jsonb_array_length` **raises** `22023` on a non-array rather than violating,
where this spelling raises a plain `23514`. None needs a `pg-value-set-domains.ts` declaration —
`catalogValueSets` matches `IN (…)` and `col = 'literal'` only, so the count is **288 before and
after**. Standing manual SQL on every existing deployment (three `ALTER`s, reported with the exact
statement until run), and the arm an operator meets depends on their rows: a clean deployment gets
three `constraint_widening_unproven` with the `BEGIN`/`ALTER`/`COMMIT` triple, while one holding a
violating row gets `constraint_violated_by_existing_rows` with the violator `SELECT` and no `ALTER` —
**the migration finding a tamper rather than merely preventing the next one**. Verified both ways on
PG 16.13, with a clean re-plan and `drift` exit 0 afterwards.

**Two more join them one table across, and the consequence there is a notch worse** (ADR-0374):
`meta.forensic_chain_checkpoints.checkpointed_by` and `.external_anchor_reference`, the only two
columns on that table that carried no CHECK, both `char_length(x) >= 1` and both with **no upper
bound** for the three above's reason. Worse because a refused *entry* makes one entry unreadable and
ADR-0373 routed it into the verdict, while a refused **anchor** makes `proveScopeIntegrity`'s two
unguarded `checkpoints.latest(scope)` calls throw, so the hourly pass filed `outcome: "error"` and
the blanking **cancelled a `compromised` verdict about a genuine chain tamper one table over**.
Reachable by the tenant: that table's isolation arm is `ALL`-scope with a NULL `WITH CHECK`, so a
tenant-context session may `UPDATE` its own checkpoint — `UPDATE 1`, live as the non-owner `serving`
role. `external_anchor_reference` is nullable and the CHECK is correct over NULL **with no guard**,
because a CHECK passes when its expression is NULL — so the absent anchor, which is the claim that
column makes for every checkpoint not externally anchored, is admitted and only `''` is refused
(ADR-0352 measured the `IS NULL OR` prefix redundant on 29 catalogued checks). Standing manual SQL,
reported as `constraint_widening_unproven` with the `BEGIN`/`ALTER`/`COMMIT` triple — and the same
plan on the same cluster reported ADR-0373's `actor_reference` as
`constraint_violated_by_existing_rows` with the violator `SELECT` alone, because that cluster really
held the blanked row: **both of ADR-0363's arms in one plan, the migration finding a tamper rather
than only preventing the next one.** `meta-schema.test.ts` asserts the whole-table invariant —
and that invariant was **false under its own predicate** when it was written, because the fourth
exempt column was the attack's third door.

**So two temporal CHECKs join them, and they are the catalog's first** (ADR-0374's addendum):
`meta.forensic_chain_checkpoints.checkpointed_at` and
`meta.forensic_chain_entries.recorded_at`, each
`>= '0001-01-01 00:00:00+00 BC'::timestamptz AND < '10000-01-01T00:00:00Z'::timestamptz`. The second
is the column **ADR-0373 exempted by name** on the table it was fencing, as *"the TIMESTAMPTZ that
`Iso8601` parses to"* — false the same way: `TIMESTAMPTZ` admits two infinities and years to 294276,
`z.string().datetime({offset: true})` admits none, and `recorded_at` is inside
`canonicalEntryBytes`, so a tamper there is signature-breaking exactly as `actor_reference` is.
`'infinity'` arrives from node-postgres as the **number** `Infinity`, so `asIso`'s `instanceof Date`
is false and `String()` yields `"Infinity"`. Neither was a buried alarm — the read paths already
grade it `compromised` — so what was missing is the **write fence**.
Three things about the expression are measured and two of them refuse the obvious form. The lower
bound is **1 BC and not 1 AD**, because `toISOString()` renders JS year 0 as
`0000-01-01T00:00:00.000Z` and zod admits it, and JS year 0 is Postgres 1 BC — an AD bound refuses
what the reader accepts, which is ADR-0373's no-upper-bound rule pointing the other way. The
explicit **`+00` is load-bearing**: a bare literal folds in the *applying session's* `TimeZone`, so
`'0001-01-01 BC'` under `Asia/Tokyo` folds to `+09:18:59 BC` — it **crosses the era boundary** and
moves the bound 9h18m59s — where the offset-bearing form is epoch −62167219200 under UTC, Tokyo and
Los Angeles alike; and the reconciler stays clean either way (`pg_get_constraintdef` renders at read
time, so both sides render in one session and agree), which is exactly why simplifying it away would
go unnoticed. There is deliberately no `isfinite()` — the range bounds refuse both infinities, so it
could never fire — and no `extract(year from …)`, which Postgres *accepts* in a CHECK and which is
**STABLE**, so the constraint would mean different things in the writing session and a later
validation; `extract` does not raise on infinity either, it returns `Infinity`.
The two migrate on **opposite arms of ADR-0363**: `recorded_at` has no violating row and gets the
`BEGIN`/`ALTER`/`COMMIT` triple, while `checkpointed_at` reads
`constraint_violated_by_existing_rows` with the violator `SELECT` alone, because the cluster held
four rows at `infinity` — the migration finding a tamper, for the second time in that increment.
Each table's exempt set is now `["id", "tenant_id", "created_at"]` and exempt for a **measured**
reason rather than their declared type: `READ_COLUMNS` names neither `id` nor `created_at`, nothing
in `forensics-pg` reads `created_at`, and neither schema has a field for it — so the rule is *a
column is owed a CHECK iff a reader parses it against a contract narrower than its type*.
The class is **444 TIMESTAMPTZ columns across the 146 tables with zero CHECKs between them** (and 0
TIMESTAMP, DATE, TIME or TIMETZ columns), 165 distinct reads in 53 files parsing one against a
contract that refuses infinity, 49 of them in 11 detector-subsystem files of which 8 are already
`guarded_by_primitive`. The sharpest remainder is on neither table fenced there —
`meta.audit_integrity_verdicts.verified_at`, whose `isoOf` helper is
`new Date(String(value)).toISOString()`, so the same tamper is a bare `RangeError: Invalid time
value` rather than a `ZodError`, in a `record_throwing` conversion with no wrapper, in the store that
holds the verdicts.

**Every column-level value-set CHECK declares which contract domain governs it** (ADR-0353), in
`packages/testing/src/strategy/pg-value-set-domains.ts` rather than in the catalog — a ref is a
string either way, since the kernel cannot import *all* of the packages it would name, so the
declaration buys nothing by living here and would cost a `ColumnDefinition` field the emitter reads
nothing from. 288 of them, compared both ways every run. `META_DEPLOYMENTS` is why: its `app_kind`,
`environment`, `target` and `strategy` CHECKs were written independently of `DeploymentRecordSchema`
and **refused four of its seven enum fields**, `target` with no overlap at all, so a store for that
table could never have inserted a row. They now spell what `@crossengin/deploy` declares — not the
union, because a CHECK refusing every value its only possible writer emits is not a constraint, and
the catalog's finer `vercel_edge`/`vercel_node` distinction lived in a CHECK nothing reads and no type
expresses.

Append new tables to the bottom of the array in build order, not alphabetically —
the expected-names test sorts independently.

## Build + test commands

```bash
pnpm install

# Per-package
pnpm --filter @crossengin/<name> build|test|typecheck

# Workspace
pnpm -r build && pnpm -r typecheck && pnpm -r test
# `-r` bails at the first failing package; add --no-bail to see them all.
```

**`build` and `typecheck` read different configs** (ADR-0307). `tsconfig.json` excludes `**/*.test.ts`
because tests must not land in `dist`; `tsconfig.typecheck.json` — two lines per package, extending that
one plus `@crossengin/config/typescript/typecheck.json` — puts them back and sets `noEmit`. So the
tests *are* typechecked, and a test double that stops satisfying its interface fails at `typecheck`
rather than at runtime where a catch can swallow it. A new package needs that file or its `typecheck`
fails — and the rule is **enforced**, not merely conventional:
`packages/testing/src/strategy/typecheck-config.ts` asserts against the real workspace that every package
with a `src/` has the file, extends **both** bases (the local one carries the package's own
`rootDir`/`include`; the shared one re-includes the tests and turns emit off — extending only one
typechecks *something*, which is the dangerous outcome) and runs the one script. The two exemptions
(`packages/config`, which is JSON only, and `apps/operate-web`, a Next app that already includes every
`.ts`/`.tsx`) are spelled out as lines, so adding a third is visible in a diff.

**`packages/testing/src/strategy/` holds the workspace-level rules**, and there are **twelve** now:
`typecheck-config.ts` (ADR-0307), `pg-column-coverage.ts` (ADR-0333), which reads `META_TABLES`
and every store's SQL *as text* and asserts the two things a fake `PgConnection` structurally
cannot — that every column a statement names exists, and that every `notNull`-with-no-default
column is named by every `INSERT` — and whose `parseCatalogSource` carries `check` and
`defaultExpression` too (ADR-0353) and `type`, `references`, `unique` and `comment` (ADR-0354,
ADR-0355), because one catalog parser is what keeps two rules from
disagreeing about what the catalog says. `references` is the one of those that mattered: **196 of
the catalog's 233** references are written as one of three shared `ColumnReference` constants rather
than inline, so a parser reading only the inline form answers `null` for 84% of them and any rule
whose predicate is *"this column references nothing"* is vacuously true for every foreign key in
the workspace — which is how ADR-0355's first measurement of its own soundness came back clean for
the wrong reason. `comment` is the `//` prose above a column's `name:`, read from the **unstripped**
source against line numbers (`stripComments` preserves newlines and not offsets) and covering both
spellings the catalog uses in one rule, since the prose sits immediately above `name:` whether it is
outside the literal or inside it. It is the catalog's **only** semantic signal about a column —
`ColumnDefinition` has no comment field, so no `COMMENT` is emitted on any column of any of the 146
tables — which is exactly what makes ADR-0355 requiring one a real cost. 49 columns carry one.
**Its `stripComments` is shared by all ten rules, and it was wrong about regex literals for four
increments** (ADR-0356): it paired quotes as string delimiters without skipping a regex, and a
pattern may contain one — `"([^"]+)"` carries three quotes, so pairing them closed the first two and
left the third opening a string that ran to the next quote **anywhere in the file**. The symptom was
phantom domains in `pg-value-set-domains.ts` once a ninth rule landed, and the cause was two files
away; `statementSpan` there needed the same skip, since a `{` inside `[{,]` increments its brace
depth and is never balanced. `opensRegexLiteral` is **exported and has three readers** —
`stripComments`, `statementSpan` and `pg-record-reads.ts`' `blankStringBodies`, which had the
identical hole in the *conservative* direction (a blanked region loses a read rather than inventing
one) and reached **19** of the scanned files; fixing it changed no count, which is worth knowing
before someone reads the fix as having recovered something.
One parser is what keeps two rules from disagreeing about the catalog
and is also one place for a defect to reach all ten, and nothing fences the shared scanner against
its own output.
Then `pg-storeless-tables.ts` (ADR-0334), which declares every
catalogued table with **no writer** and why, and `pg-record-retention.ts` (ADR-0335), which reads the
Article 17 erasure's `PLATFORM_RECORD_TABLES` and the catalog's cascading tenant tables and compares
them **in both directions** (`protected_table_cascades` / `_not_in_catalog` / `_undeclared_here` /
`expected_protection_absent`), with a negative control that re-adds `audit_log`'s reference and
demands exactly one finding naming it. Both directions is the part that carries the weight: ADR-0334
established that *location* was never what made ADR-0288's `needsAuditEmitter` wrong, the absence of a
both-ways comparison was.
The fifth is `pg-unreachable-stores.ts` (ADR-0336), **the storeless rule's inverse**: that rule asks
which catalogued table has no store, and this one asks **which store has no caller**. The two are
different questions, which ADR-0335 demonstrated by *moving* a defect rather than closing it —
`meta.feature_flag_targeting_rules` left the writerless census the moment a store was written for it,
and that store is constructed only in its own test. Measured: **55 exported `Postgres*` classes, 49
reachable, 6 declared**, over 1,740 files and 18 pg packages. Five reasons, each with a required
field prose cannot substitute for — `no_caller_by_design` (needs a `decidedIn` ADR asserted to exist
on disk, because it is the one reason that must never be assumed), `substitute_in_use` (needs a
`substitutedBy` asserted itself constructed outside tests), `unpersisted_record`,
`prerequisite_of_unbuilt_surface` and `contract_cannot_carry_the_surface`. The last two split on
**ordering versus shape** on ADR-0330's reasoning: a store blocked by ordering will be wired and its
note says what must land beside it, while one blocked by its contract's shape needs a schema change
first, and calling both "unwired" sends the next person to write the route that cannot be written
honestly. `tables` is required and **may be empty**, since `[]` is a signed assertion that the store
writes no catalogued table while an absent field would mean nobody looked (ADR-0331's distinction).
Twelve finding kinds compared in both directions, and `table_declared_storeless` is the **cross-rule
join** — the sharpest statement of why two rules are needed, because `pg-storeless-tables.ts` decides
a table is written by reading a store's SQL as text, so **a store with no caller makes its table read
as written while no deployment has ever put a row in it**. No count equality anywhere: the
declarations are the only place a name is written down and the floors are one-sided, with the floor
on the **reachable** side (`reachable >= 40`) because a site matcher that stopped matching would
report all 55 unreachable, and over-reporting is the direction that fails CI on correct code.
It caught a live wiring commit mid-increment (`[overtaken] api-gateway-pg:PostgresIdempotencyStore`),
where the fix is deleting the declaration rather than weakening the check.
**ADR-0337 widened it, because four of the five blind spots had live members.** The candidate set is
now **every exported class in every member including `apps/*`** — 324 candidates, **289 reachable**,
3 exempt as `diagnostic_type`, 17 as `test_surface` (never granted to a `*-pg` member, since
persistence is not a test double), **14 callerless classes declared** plus one callerless *member*,
so **15** declarations (counted from the array: 15 `scope:` entries, 14 of them carrying a
`symbol:` — this file said 15 + 1 = 16 and the arithmetic was the error, not the measurement). (ADR-0337's own text records 285 / 19 / 21: that was measured before the same
increment's wiring made five of them `overtaken`, and the fix for an overtaken declaration is
deleting the line. Measure the census, do not read the figure.) Members are candidates too,
with three mechanical exemptions read from `package.json` and the class scan rather than from names
(`entrypoint`, `not_importable`, `contracts_only`). `CALLERLESS_FLAG_STORES` is no longer a second
list nobody reads: `auditCallerlessFlagLists` reads it from disk as text and compares **three** facts
in both directions — that list against the live scan and against `UNREACHABLE_STORES` — because
comparing the two lists alone would pass while both were stale together.
**Two refusals are argued from measurement rather than taste, and both are in the module so nobody
attempts them a third time.** The *compiler-API* answer to the factory blind spot: 1,026 roots pull
in 2,173 program files at 26 s and 1.2 GB inside a 3-second suite; one program cannot hold 90
packages (112 unresolved specifiers, since members do not share a tsconfig); and decisively there is
no `paths` mapping, so **cross-package symbols resolve into `dist/*.d.ts`** — measured on all 69
`new Postgres*` sites in `node.ts` — making the symbol at the use and the symbol at the declaration
two different symbols, joinable only by the filename heuristic the compiler was meant to replace or
by a second copy of the workspace's module resolution whose stale-by-one-package failure is silent
total over-reporting. It would also be green only after `pnpm -r build` and, against a stale `dist`,
green on the previous build. And the *general function-shaped fence* — "an exported symbol nothing
outside its module uses" — reports 82 of 812 modules, almost all contracts modules doing their job,
and because the reference test is a word match it **misses three of the six replayers it exists to
find** (all three export `DriftIssue`). So the unit stays "an exported class, constructed somewhere",
plus a `module`-scope declaration checked four ways and a narrow driver-family census over
`replayer.ts` with floors on **both** sides — a ceiling on how many are classless and a floor on how
many the glob finds, because a family that stopped using the convention would otherwise pass on zero.
**A scan over source must strip comments and strings before it believes a match**: my own widened
scan read this module's doc comment — which contains the literal `new PostgresTargetingRuleStore(` —
as a construction site, and the store read as reachable. The shipped rule strips them and its comment
says it anticipated exactly that.
**The driver-family census accounts for a module three ways** — a tracked class, a module
declaration, or a non-test file naming one of its **exported functions** — and the third arm's names
come from `export function` only, because exported *types* and *constants* collide across the family
(`DriftIssue` appears in three of the six replayers) so crediting a module because one of those
appeared anywhere would credit all six and the fence would never fire. A shared function name credits
every module exporting it, which can only make a module read *reachable*, never unreachable — the
same conservative direction as the class scan's by-name attribution. A driver exported as
`export const run = () => …` is invisible to it: that leaves its module unaccounted, which is the
safe direction, and trips the family's own invariant that every member exports at least one function.
The two-sided floor was restated rather than extended, because the third arm moved the ceiling's
meaning: the floor (≥ 6 family modules) still guards a convention that stopped being used or a glob
that stopped matching, while the ceiling (≤ 3 classless) now guards the **class parse** — if
`exportedClasses` stopped matching, all six would read classless at once and three other assertions
would still pass. The arm's liveness is proved by a control pair rather than a count, so it does not
depend on which replayers happen to be wired.
**The rule caught this increment's own wiring**, which is the clearest evidence it works:
`operate-server replay` constructs four replayers and calls the fifth, and five declarations came
back `overtaken`, each naming `node.ts` and each fixed by deleting one line. The fifth exposed the
census gap above — a classless module that went from declared-unreachable to genuinely wired was
accounted for by neither arm — so the third arm exists because the first declaration to *resolve*
found it.
**The transitive version was built as a measurement and refused as a fence, and the measurement is
what refuses it**: entrypoints taken from every `package.json` `"bin"` — never from a filename that
looks like a CLI, since `src/cli.ts` is the argv *parser* and does not import the command bodies,
which over-reported by five of thirteen — resolve with zero unresolvable imports and reach 760 of
1,026 non-test files, and then three of the six declared stores come back **reached**, because an
`index.ts` carrying `export *` is imported by package root. **Module reachability is not symbol
reachability**, and here it answers "reached" for precisely the stores the rule exists to report;
answering it honestly needs symbol-level use analysis through `export *`, a type-aware pass rather
than a text scan. The flat signal is sound *because* it is conservative — it can only under-report,
so what it declares is a lower bound. All six read the real workspace from disk rather than
importing it, which is what keeps them unconditional: importing `@crossengin/kernel` would make the
dependency graph cyclic, and reading `kernel/dist` would make the answer depend on whether someone ran
`pnpm -r build`. A rule that is green only after a build is not a rule.
The sixth is `pg-value-set-domains.ts` (ADR-0353), and it is the **upstream** half of ADR-0352's
question: whether the catalog's CHECK admits every value the *contract* can emit, which is a property
of the artifact and so belongs in a test where the other half belongs at boot. `VALUE_SET_DOMAINS`
declares, for each of the **288** catalogued value-set CHECKs, which workspace domain governs it —
**282** `mirrors`, **5** `catalog_only`, **1** `narrows` — and `mirrors` asserts **equality**, which
is the whole point: `META_DEPLOYMENTS`' four drifted columns were neither subsets nor supersets of
`DeploymentRecordSchema` (`target` was *entirely disjoint*), so every nesting test was blind to them.
The link is declared and not derived because both derivations were measured and refused — an
unconstrained strict-superset rule gives **23 pairs over 15 columns with 0 defects** (`[month,year] ⊂
TIMESERIES_BUCKETS`; `MAC_ALGORITHMS ⊂ KEY_ALGORITHMS` by spread), and a field-name link gives
**4,938 pairs over 180 columns** because `status` is a field on 51 schemas. Exact set equality is
*unsound* rather than imprecise, demonstrated live: `meta.deployments.environment` exactly equalled
`@crossengin/feature-flags`' environment enum and so read as accounted for while the record that
table stores emits `@crossengin/deploy`'s. `narrows` carries `except` plus a `guardedBy` whose own
declaration must name every excluded member (`pg-unreachable-stores.ts`' `substitutedBy` shape), and
`catalog_only` is contradicted by **exact enumeration and not by overlap**, because containment is
the coincidence that sank the superset rule. A ref is `<package>:<NAME>` or
`<package>:<XSchema>.<field>`, the second where a constant is ambiguous or absent —
`meta.report_runs.engine` refs `ReportRunRecordSchema.engine`, since `REPORT_ENGINES`' third member
`auto` is a report *definition's* preference. The resolver reads three sites, follows spreads,
aliases and **imports** (without which `DATA_CLASSES`, declared in three packages, resolves nowhere,
so `meta.files.data_class` has no nameable domain) and reaches **1,363 domains over 915 files with
zero unresolved**. **29 of the 287** declarations ref a schema field; the rest ref a constant.
`auditColumnDefaults` is the one question here needing no declaration — a column's
`default` against its own `check`, 0 findings today.
The seventh is `pg-column-bindings.ts` (ADR-0354), which asks whether a declaration names the domain
the store actually **binds**: the sixth rule compares *members*, so two constants spelling one domain
are interchangeable to it and a wrong adjudication passes. It derives the symbol instead — column *i*
↔ `VALUES` expression *i*, `$n` → `params[n-1]` out of the **enclosing** `query(…)` call (or the next
one passing the `const` the SQL was assigned to), then the receiver's type → the domain over the four
idioms this repo uses to type an enum field, with `type X = z.infer<typeof XSchema>` as a hop. The
`field: z.enum(…)` form is answered from `collectWorkspaceDomains`' own output rather than re-parsed,
so there is **one reader** of that declaration, and `WorkspaceDomain.typedBy` is what makes the two
legal spellings of a domain (`CONST` and `XSchema.field`) and a deliberate re-export alias
(ADR-0334's `TENANT_STATUSES`) compare equal. Three readings are refused on measurement and each
produced a *confident wrong answer* first: a zip of the column list against the parameter array
(28 of 73 inserts misalign — `platform-users.ts` writes `VALUES ($4::uuid, $1, $2, $3, 'active')`),
"the next query call" for the parameter array (56 positions resolved against another method's), and
a position past a **spread**, which refuses everything at or after it and nothing before. **Name
resolution is the same four steps on both sides**, because five of the first six "contradictions"
were the resolver's own — an imported constant attributed to the importing package, and a bare-name
map holding whichever `SeveritySchema` was scanned last. Findings: `ref_contradicts_binding`,
`binding_domain_unexported` (which fires *instead* of it when the bound constant is module-private,
on ADR-0334's rule that a remedy which cannot work is worse than none), plus three needing **no
declaration** — a SQL literal against its CHECK, an inline literal union as a **subset**, and a
`string`-typed field as `unconstrained`. `BINDING_GAPS` (28, at `PG_SCAN_GAPS`' `(file, table, kind)`
grain) and `UNCONSTRAINED_BINDINGS` (4) are compared both ways, and the floor is on the **checked**
side for `pg-unreachable-stores.ts`' reason. 164 columns are unreachable because their table
is declared writerless — asserted both ways, so this rule's silence there is the fifth rule's finding
and not a second one. 66 of 287 columns checked, 83 bindings confirmed. Its type index and the sixth
rule's domain scan are **cross-checked rather than shared**: they answer different questions about one declaration (its members, and which symbol it
names), so for every `schema_field` with a nameable `typedBy` the target is asserted to resolve to
the same member set — 400+ comparisons.
The eighth is `pg-binding-names.ts` (ADR-0355), which closes ADR-0354's own Q2 and asks the one
question none of the seven above it does: **is the value the one the column is for?** All of them
ask whether the column exists, whether the `INSERT` is complete, whether a live database admits the
values, whether the CHECK and the contract enumerate the same members and whether a declaration
names the bound symbol — and **a transposition inside one `VALUES` list satisfies all seven**,
because the symbol is the *same* domain on both sides. The remaining signal is the names, and this
repo's `snake_case` ⟷ `camelCase` transform is a rule: **682 of 764** bindings agree exactly, which
is what makes a divergence exceptional enough to carry a reason. It consumes
`pg-column-bindings.ts`' extraction rather than scanning again (one extractor, two questions), and
accounts for every binding four ways — agreement, a **derivation** (2, 25 bindings), a
**declaration** (28, 32 bindings), or a literal (25) / uncatalogued column (**0**).
The two derivations are `business_key` (`property === "id"` ∧ the column ends `_id` ∧ a
**column-level UNIQUE** ∧ **no FK** — the house two-identifier shape, measured tight at 72 tables
with exactly one such column, 74 with none and **none with two**) and `resolved_surrogate`
(`<noun>_id ← <noun>Uuid`, the noun on both sides). **Four generalisations were refused on
measurement** and each keeps its count beside it: `*_id ← id` without the UNIQUE (72 tables have
more than one non-FK `*_id` column, one has eight), a camel-boundary suffix (`id` is a suffix of 11
columns of `meta.workflow_events`), a shared four-character leading token (**138** properties
admitted into more than one column of their table), and "the property names a different column" as
a bare detector (17 hits, **16** of them the business-key convention — **the declared type is what
separates them**, which is why `property_names_sibling_column` requires the types to match).
`derivation_ambiguous` is the piece worth copying: a derivation's tightness is a measurement over
the catalog, and one taken once goes stale silently, so `derivationTargets` **re-asks it on every
run** and a second admissible column makes the rule say it has stopped being an explanation rather
than widen.
The five divergence kinds were **settled from the adjudications and not before them** — each
divergence was read against the store, the column and the contract field and the convention named
in the reader's own words, **17 distinct names** came back, and these five are what they collapse
onto: `nested_record` (6), `act_parameter` (10), `qualifier_differs` (10), `statement_local` (1),
`column_overloaded` (1). An earlier draft shipped six kinds invented first and **four had no
member**; a test now asserts every kind has one. `act_parameter` and `qualifier_differs` are
separate on the axis *what a reader must check*: for the first the two names denote different things
(`tenants.status ← to`) and for the second the same thing under a qualifier (`delivered_count ←
delivered`). **None of the 28 was a defect** — the two that read as suspicious went to an
independent refuter and both were dismissed on facts the first reading had not established.
Two findings exist because two declarations are dangerous. `sibling_unaddressed`: a declaration may
resolve a `property_names_sibling_column` (there is a live correct one,
`access_review_decisions.attestation_kind ← decision.attestation.kind` beside a top-level `kind` of
the same type) and its note must **name the sibling**, because an adjudication that never looked at
the column the value could have belonged in cannot have ruled the confusion out.
`overload_uncommented`: `column_overloaded` is the one kind admitting the column's **name is wrong**
rather than merely vaguer, so declaring it requires the catalogued column to carry a source comment
**naming itself** — prose attributed from the line above cannot satisfy it — so the next person,
reading the catalog rather than this directory, is told. `transposed_pair` is the only finding no
declaration can resolve. Two **live controls** on the real tree rather than fixtures: pointing
`meta.job_runs.claim_expires_at`'s real binding at `completedAt` yields exactly one sibling finding,
and transposing the real `input_data_class`/`output_data_class` bindings in one `INSERT` yields
`transposed_pair` — a pair no constraint could catch, both being TEXT under one six-value CHECK.
The ninth is `pg-record-reads.ts` (ADR-0356), which closes ADR-0355's own Q1 and is the eighth rule
read in **the other direction the value moves**: a row → record mapping can name a field as wrongly
as a parameter can, and the write half is the half that had a rule. What makes it a different
problem rather than the same one mirrored is that **the write path knows its table from the
statement and this one has to find it** — `records.ts` holds five mappers while the SQL is in the
three stores beside it, and `installation-store.ts:92` issues `SELECT *`. So the anchor is the
**catalog** (a read is `<receiver>.<property>` where the property is a catalogued column name, the
`SELECT` never consulted — safe on a measurement: every non-column `snake_case` property in the
workspace, an Anthropic `stop_reason`, an OpenAI `prompt_tokens`, a `pg_catalog` `rls_enabled`, is
absent from the catalog, so there is **zero collision**), and the table comes from the declared
`interface \w*Row` by **column-set containment** — 40 interfaces, **26** resolved, **0** ambiguous,
a table for **313 of 336** reads. The name alone would not do and is ambiguous exactly where it
matters (`campaign_id` is one business key and three foreign keys, `instance_id` one and four), and
a field the catalog has no column of is **tolerated** rather than disqualifying, because that is
what a SQL alias looks like from here. `DERIVATION_RULES`, `NAME_DERIVATIONS`, `camelOfColumn` and
`columnOfCamel` are **imported unchanged**, because `admits(column, property, table)` does not care
which direction the value is moving — so `jobId <- run_id` falls out as a declaration rather than a
derivation precisely because `job_runs.run_id` carries only a *table-level* `UNIQUE (tenant_id,
run_id)`, the distinction ADR-0355 added `CatalogColumn.unique` for, inherited for free.
Accounting: **305 of 336 agree exactly** (90.8%), 7 derive, **23** are declared, 1 is an alias, 2
are read from several columns and compared to none, **0** unexplained. `ROW_FIELD_ALIASES` is the
three-way provenance settled by reading the SELECTs — `joined_column` (`c.campaign_id AS
campaign_natural_id`), `parameter_echo` (the SELECT handing back its own argument) and
`introspection` (a `pg_catalog` row, which has no catalogued table and so no field with a column to
compare) — and **declaring an alias puts the read under the rule rather than taking it out**: with
`campaign_natural_id` declared, `campaignId <- campaign_natural_id` is compared against `campaignId`
and *agrees*. The six divergence kinds were **settled from 35 adjudications and not before them**
(the conventions came back under 22 distinct names), and `field_overloaded` — the one admitting a
**field's** name is wrong rather than merely vaguer — charges a source comment on the interface, for
`overload_uncommented`'s reason one side across: the declaration lives in this directory and the
next person reads the interface. `reversed_pair` is the only finding no declaration resolves, keyed
on the **enclosing literal's offset** and never on proximity, since two sibling records in one
function are not a transposition.
The tenth is `entity-field-aperture.ts` (ADR-0361), and it is the first of the ten that is not about
SQL. It asks **whether a reader of an entity's fields asks over the set the served table has**: an
entity's own `fields` are not that set, a trait contributes more, and `resolvedFields` is the one
answer — so a function taking an `Entity` and reading `entity.fields` is asking a narrower question
than the artifact answers. Sometimes that is correct and deliberate; usually it was a blind spot
nobody declared, and the rule makes every instance say which. The **direction** is the field worth
having — `fails_open` (something is disclosed or writable that should not be), `fails_closed` (the
field is omitted, so nothing unsafe happens) or `incomplete` — because it is what decides whether a
member is a defect or a declaration, and the same narrow read produced *both* of the first two: the
gateway redactor drops `redacted` alone so an undescribed key passes through, while
`redactAuditPayloads` drops `redacted ∪ undescribed` so it is dropped. **One narrow read, two
opposite failure directions, decided by the consumer's drop set.**
Measured over 982 files: **84** reads of the `.fields` shape survive comment-stripping and
string-blanking, **19** on an `Entity`-typed binding — 23% precision for a bare scan, **100% for the
type anchor** on a population checked by hand — which is **16** readers grouped per `(file, symbol)`:
**12 raw** (fails_open 3, fails_closed 1, incomplete 8), 3 calling a resolver, 1 `trait_aware`. Twelve
declarations, matching in both directions, 0 findings. It walks `apps/operate-web` through a local
walk as well, because that member has no `src/` and is therefore invisible to the other nine rules.
**Four generalisations refused on measurement**, each with its count: any `<receiver>.fields` read is
23% precise (`.fields` is a property on `EntityPermissions`, `UiEntitySchema`, `ListQuery`,
`ListConfig`, `ListSearch`, an index definition, a drift record and a PHI decision); a receiver
*named* `entity`/`ent`/`e` fails because `operate-web` reads `entity.fields` eleven times on a
`UiEntitySchema`, so the name is identical on both sides of the question; a file-wide
first-annotation lookup **reproduced ADR-0354's bare-name defect in the rule's own prototype**, so
the lookup is scoped to the enclosing function; and iterating `<x>.entities` type-blind is wrong in
the direction that *invents* members. Three `apps/operate-server` modules project a manifest from
`Record<string, unknown>` and read `entity["fields"]` by bracket access: they hold no `Entity` and no
`Trait[]`, so they **cannot** call the resolver — blocked by *shape* and not by wiring, which is
`pg-unreachable-stores.ts`' distinction, and they are declared as such.
What it **cannot** see is a reader that receives its fields through a structural local type, which
is exactly what `EntityLike` was in `list-query.ts` until this increment deleted it.
The eleventh is `manifest-event-names.ts` (ADR-0362), and it is the first that fences a
**declaration against a producer** rather than a store against the catalog. `matchEventJobs`
compares a job's `eventName` to an emitted event's name with `===`, so the two halves of an event
job are joined by one string that nothing compared — and measured over the real `resolveManifest`,
**28 of 55 (pack, declaration) instances named an event no deployment could emit** — over exactly
**9 distinct names**, which is the number of declarations the rule carries, so the rule's own data
was right. This file said **55 of 55** for two increments and ADR-0362's prose says it too; the
figure is refuted by `producibleEntityEventNames` over the real resolved packs, three ways
(a script, the binary's own survey, and a live `POST /v1/leads` that enqueued a real run). **27 are
producible**, on four names — `lead.created`, `quote.sent`, `salesorder.fulfilled`,
`workorder.completed` — because those four happen to be written in the grammar's own
`<entity>.<verb>` shape. The ADR's *reasoning* survives intact and is in fact confirmed by the
correction: `workorder.completed` is producible on six packs and **not** on `erp-construction`,
whose overlay replaces core's `WorkOrder` lifecycle and takes that transition target with it, which
is precisely why the rule is per resolved pack rather than over the union. It is a
workspace rule and deliberately **not** a `validateJobs` error, which ADR-0348's split would ask
for, on one measurement: `validateManifest` is error-only with no warning channel, so a validation
error would refuse 8 of 12 declarations and with them **all seven packs** — for five the remedy
does not exist and for three it is a domain judgement.
The fence is **per resolved pack and never over the union**, which is the decision rather than a
detail: `mergeRecord` lets an overlay win by workflow key, so `erp-construction` keying its own
`work_order_lifecycle` over `draft → scheduled → in_progress → done` takes core's `… → completed`
away, and `workorder.completed` is addressable on six packs and names nothing on the seventh. A
union would read that job as served, and the direction is what matters — **an over-wide producible
set under-reports findings**. The declaration grain is `(jobId, packs)` for the same reason: at
`(pack, jobId)` grain 21 of 28 residual instances are three core facts repeated across seven packs,
and at `(jobId)` grain the construction member reads `overtaken` on six packs and is needed on one.
Two reasons, each costing something checkable — `witness_named_differently` must name a `witness`
the rule then asserts **is** producible, and `no_producible_counterpart` must name what is
`missing` and the rule asserts it really is absent. **Nine declarations**, compared both ways.
Its grammar is necessarily a second spelling of kernel's, because kernel *and all seven packs*
devDepend on `@crossengin/testing`, so importing either makes `turbo run build`'s graph cyclic and
reading their `dist` would make the rule green only after a build — so it is pinned by reading
`kernel/src/manifest/event-names.ts` **as text** and comparing seven fragments (the two character
classes, the `x_` escape, the three verbs, the separator), which is `pg-column-coverage.ts`'
relationship to `META_TABLES` and the only agreement available across a dependency edge that cannot
exist. Two things it learned the hard way and now fences: a first scan reading only the literal
`: EntityLifecycleWorkflow = {` form answered **180 of core's 230** producible names and **7 of its
19** lifecycles, because twelve are built through a factory — so `lifecycle_unparsed`,
`entity_unreferenced`, `event_trigger_unattributed`, `pack_unresolved` and `workflow_key_ambiguous`
are findings and never skips, since a smaller producible set over-reports and is one regex from the
opposite. And **three mutations survived its first battery**: every `: Entity = {` const in the live
packs is reached by its array, so a test over the real workspace cannot distinguish this scan from
one taking every const it finds — ADR-0355's *a measurement taken once goes stale silently*,
answered with fixture tests beside the live ones.
The twelfth is `pg-unreadable-rows.ts` (ADR-0373), and it is the first that asks **what a read does
with a row its contract refuses** — a question every one of the eleven is blind to, because all of
them compare an artifact against the catalog, a value set, a declaration or a producer, and a
`rows.map(rowToX)` that throws is well-formed SQL naming existing columns with a complete `INSERT`
and a mapper that applies its contract correctly. What is wrong is what happens to the **page** when
one row fails. **110 conversions over 942 source files** (`array_map` 73, `row_loop` 24, `primitive`
13), six verdicts over two total maps, **67 needing a declaration, 67 declared, 0 findings in either
direction** — 44 of them `unmigrated`, which is explicitly the backlog, each naming what a refused
row costs today. Every one of those figures moves with the next slice that migrates a store, and
each was already wrong within its own increment by the one site migrated after the prose was
written; the rule's test asserts one-sided floors for that reason, and these are re-derivable by
calling the module. **Throw-capability decides the fence and the record type only classifies a *silent*
conversion**, which is the module's load-bearing line and was reversed in its own first draft:
evidence that a refusal is possible **is** proof a contract is applied, so it needs no annotation to
confirm it. Each reason costs something checkable — `page_refusal_declared` names a `refusalCode`
the rule then finds in the named file, `record_asserted_not_parsed` names a `fencedBy` symbol some
workspace source must declare or the literal `nothing`, and a reason contradicting the derived
verdict is refused. It reproduced its **own** under-reporting direction while being written:
`rows.map(rowToX)` passes the mapper by reference, so a scan over *calls* found no evidence of a
parse and 12 sites read `record_total` that end in one. Seven generalisations refused with their
figures, the sharpest being that every *invocation* of a row mapper is 114 sites of which **63 are
single-row reads where throwing is correct** — which is why the anchor is an array.
`workspace-sql-scan.ts` is the fs walk extracted out of the column-coverage test so one scan feeds
both SQL rules, and it gained a **reference collector** (`from`/`join`/`into`/`update`/`delete`/
`truncate`, 312 references across 862 files) — without which three tables read as writerless that are
not, because the statement extractor silently skips a `SELECT` with a join, an alias or an unresolved
target. That check changed the census's answer three times and is the one that makes it trustworthy.
`readWorkspaceSources()` is its second product (ADR-0353) — every file's text with its owning
package, for the rules that reason about symbols rather than SQL, and deliberately **not** filtered
by `PG_SCAN_EXEMPT_PACKAGE_DIRS`, since a package with no Postgres store can still export the enum a
catalogued CHECK is about.

Full workspace build + typecheck + test is several minutes; run it backgrounded
into a log rather than blocking on it — but **run only one at a time** (ADR-0336). Packages resolve
each other through `dist/`, so a second `pnpm -r` started before the first finished has one run's
`tsc` writing a file while the other's vitest reads it, and the assertions that come back are about a
module half-built from two trees. That produced **three phantom failures** once — a `kernel-pg`
policy assertion reading `'INSERT'` for an `'ALL'` policy and two `operate-server` CLI tests
expecting a refusal that did not throw — none of which reproduced when those packages were run
alone, before *or* after the change. So: reproduce a sweep failure in isolation before believing it,
and check `pgrep -af "pnpm -r"` is empty before starting one. This is ADR-0307's lesson in a third
form — running vitest is not running the type checker, running vitest is not running the build, and
running two sweeps is not running one.
There **is** a top-level `lint` script (`turbo run lint`) and it passes **vacuously** —
ESLint has not been migrated to v9 flat config. Ignore lint unless asked.

**Run `pnpm -r build` before trusting a consumer's tests after a contract change.**
Packages resolve each other through `dist/`, so `pnpm --filter <consumer> test` runs
against whatever was built last: adding a `superRefine` refusal to a schema and then
testing its consumer reported *219 passed* against a stale `dist`, and the same suite
failed 31 tests and one whole suite once the sweep rebuilt it (ADR-0329). This is
ADR-0307's lesson in a second form — there, running vitest was not running the type
checker; here, it was not running the build.

`.prettierrc.cjs` at the root re-exports `packages/config/prettier`, so a bare
`npx prettier --write` uses the workspace's width. Most of `packages/*/src` is not
Prettier-clean and there is no `format:check`; don't bulk-format.

`apps/operate-web` is a Next.js app outside the vitest workspace: verify it with
`npx next build` (and `npx tsc --noEmit`) from `apps/operate-web`.
**Run only one `next build` at a time too** (ADR-0364), for the `pnpm -r` rule's reason one app
over: `.next/` is shared mutable state, so a second build started while the first is tracing
fails in `collectBuildTraces` on a missing `_not-found/page.js.nft.json` — a phantom failure
naming a file neither build authored. And `pgrep -f "next build"` is not the wait condition: the
pattern matches the waiting shell's own command line, so the loop never exits. The same trap
turned a `pkill -f 'operate-server.js --pack …'` into a killed shell in the same increment.

**Never undo a mutation test with `git checkout --`** (ADR-0367). Mutation-checking a test means
breaking the code, confirming the failure, and restoring — and on an increment with parallel slices
in flight the file you are about to "restore" carries hundreds of uncommitted lines somebody else
wrote. `git checkout --` would discard all of it with no way back. Reverse the edit you made, by the
same string replacement that made it, and assert the mutation was present before you do. A subagent
in that increment refused the instruction for exactly this reason and ran its mutations against an
isolated copy of the package instead, which is the better answer when more than one test is involved.

## Conventions

- **Module structure.** Each package: `package.json`, `tsconfig.json` (extends
  `@crossengin/config/typescript/base`), `vitest.config.ts` (re-exports
  `vitestPreset`), `src/index.ts` re-exporting everything, 4–8 `src/*.ts` modules
  with a matching `src/*.test.ts` each.
- **Naming.** Constants `SCREAMING_SNAKE_CASE`, types `PascalCase`, schemas
  `<Name>Schema`. Stable id prefixes per kind (`INC-YYYY-NNNN`, `EV-`, `PM-`,
  `LH-`, `disp_`, `dlv_`, `dgst_`, `ntpl_`, …).
- **Tests.** 15–35 per module, covering constants, accept *and* reject schema
  paths, helpers, and state-machine transitions. Postgres-backed modules are
  tested offline against a fake `PgConnection` that records `{sql, params}` —
  assert on the recorded SQL and bound parameters, never on a live database.
  **Know what that boundary cannot see** (ADR-0333). It is drawn at the SQL
  *string*, so a fake answers every statement and six separate defects lived
  past it: a column that does not exist, a required column omitted, a policy that
  refuses the statement, a read with no scope predicate, a row that comes back a
  different type, and a module nothing calls. Three of those were found by hand
  in three consecutive increments before anyone looked for the class. So a fake
  is the *floor* and not the ceiling: a store's INSERT column list is now
  asserted against `META_TABLES` (`packages/testing/src/strategy/pg-column-coverage.ts`
  checks every statement in the workspace), a scoped read is asserted to carry
  its predicate and to branch for both arms, and anything touching SQL, auth or
  the request path is verified live as well — **as a non-owner role**, because a
  table's owner bypasses RLS and testing as the owner proves nothing about it.
  A fake that silently ignores a column is worse than no fake: `fakeCertificationPg`
  ignored `tenant_id` entirely, so a store reading one scope and a store reading
  every scope looked identical to it. **A fake's fallback arm should throw, not
  answer `{rows: []}`** (ADR-0350): `shared-table-erasure.test.ts`'s fake answers two
  read-only surveys by shape and raises on anything else, because an empty answer for
  a statement whose shape later changed would make every assertion about what that
  statement *found* pass vacuously — and that is this convention's own blind spot
  applied to the fake itself. **That class had three more members**
  (ADR-0334): `crypto-pg`'s fake modelled `tenant_id` but applied the RLS predicate to
  *writes*, i.e. only ever as a non-owner — so every owner-bypass write defect was
  invisible to it by construction, and it takes `{owner: true}` now and **throws** on a
  write with no `tenant_id` predicate; `feature-flags-pg`'s and `dr-runtime-pg`'s
  `mockConnection` modelled it **not at all**, pure recorders answering `{rowCount: 1}`,
  and now call `assertStatementIsScoped`. **ADR-0363 adds a fifth member and it is the subtlest:
  a fake can answer the *wrong query's* row.** `reconcile.test.ts`'s fake matched
  `SESSION_POLICY_VISIBILITY_QUERY` on `c.relrowsecurity` — which that query selects **and so does
  the RLS-enabled query beside it** — so the confinement probe was handed the other statement's
  row, ADR-0362's strict verdict parse threw, and **every widening proof came back
  `unknown_unreadable`**: a test suite in which the feature being added could not work, passing.
  The fix is a `row_security_active` branch placed *first*, and the lesson is that a shape match
  must be specific to the statement and not merely true of it. So: **a fake that answers a
  statement it could not really serve is a test asserting the wrong thing.**
  **ADR-0370 adds a sixth, and it is the first where the boundary is *below* the SQL rather than
  above it: a statement can be refused before the planner.** `08P01` (more parameters bound than
  referenced) and `42P18` (a referenced position past the end of the array) are raised in the
  **bind** step, so they are not questions about tables, columns, types or rows — the subjects of
  every one of the eleven rules — and no amount of interpreting the SQL reaches them. The fake that
  missed it is one of the better ones here: it models the table's RLS policy, holds rows in a `Map`
  and answers reads from that model, and it served all five of
  `meta.notification_templates`' status transitions while every one of them raised against a real
  database. So `assertBindArity(sql, params)` lives in `packages/testing` and every shared
  `test-fakes.ts` that fakes a `PgConnection` calls it — **both ways** on
  `pg-record-retention.ts`' rule. Neither one-way half is sufficient and the real defect proves
  both: "max referenced ≤ supplied" passes the entire `08P01` family (three transitions bound a
  fifth parameter and referenced four), while "max referenced === supplied" misses the `42P18`
  one, because `deprecate` referenced `{1,2,3,4,6}` of six supplied — the maximum agreed and `$5`
  was referenced by nothing. Only set equality catches a hole in the middle.
  Not under `strategy/`: the supplied count is `params.length` at runtime, built by a `push` loop in
  the offending store itself, so a text scan would have to evaluate the array's construction —
  ADR-0354's refused position-past-a-spread analysis for the same reason. Measured over the nine
  adopters: **1,108 tests, zero further mismatches**, so the class has exactly one live member —
  and **72 `*.test.ts` files build a fake `query` inline** rather than through their package's
  shared module, which is the sweep this did not take.
  Reads stay exempt from
  that tripwire on purpose — `classifyScopedWriteRefusal`'s diagnosing re-read is
  deliberately unscoped, because its whole question is whether the row sits in another
  scope and a scoped read could only answer "absent". A **writerless** table is also a
  failure now unless declared with a reason
  (`pg-storeless-tables.ts`), because a table with no store cannot have a wrong store
  and so never appeared in either SQL rule. And a **callerless store** is a failure unless declared
  too (`pg-unreachable-stores.ts`, ADR-0336), which is the same blindness read the other way: a
  store with no caller passes every SQL rule — its statements are well-formed, its columns exist,
  its `INSERT` is complete — and makes its table read as *written*, so the two rules disagree and
  `table_declared_storeless` is what says so.
  **And a catalogued value-set CHECK with no declared contract domain is a failure too**
  (`pg-value-set-domains.ts`, ADR-0353), which is the same blindness read a third way: a fake
  connection never evaluates a CHECK, so a column whose constraint refuses every value its own record
  schema emits has well-formed SQL, existing columns and a complete `INSERT` — `META_DEPLOYMENTS` was
  in exactly that state on four columns, and the kernel test over one of them asserted three values
  the contract has never had.
  **And a declaration naming a domain the writer does not bind is a failure too**
  (`pg-column-bindings.ts`, ADR-0354), which is the same blindness read a *fourth* way and one level
  past the third: a fake connection cannot see which **symbol** a parameter carries, so a declaration
  naming a coincidentally-equal domain passes every rule above it — the SQL is well-formed, the
  columns exist, the `INSERT` is complete and the member sets match. The one live member was a
  module-private constant typing the schema the writer binds, which made the exported second spelling
  beside it the only thing a ref could name.
  **And a value bound into the wrong column of the right type is a failure too**
  (`pg-binding-names.ts`, ADR-0355), the same blindness read a **fifth** way and the sharpest,
  because a fake connection cannot see it *and neither can a real one*: a transposition inside one
  `VALUES` list is well-formed SQL naming existing columns with a complete `INSERT`, and every value
  is admitted by its CHECK and carries the declared domain — since the two columns' domain is
  frequently the *same* domain. The real `input_data_class`/`output_data_class` pair is the
  demonstration: both TEXT under one six-value CHECK, so no constraint, no type comparison and no
  member comparison could ever separate them. The only remaining signal is the **names**, and a rule
  over them is possible only because agreement is this repo's norm (682 of 764).
  **And a record field read from the wrong column is a failure too** (`pg-record-reads.ts`,
  ADR-0356), the same blindness read a **sixth** way and the one where a fake is at its most
  useless: a fake hands back the rows the test author wrote, so a mapper reading the wrong column
  returns the author's own fixture value and every assertion passes. It is the fifth reading's own
  question asked in the other direction the value moves, and the write half was the half that had a
  rule. Measured: **305 of 336** reads agree exactly, 7 derive through the same imported
  `DERIVATION_RULES`, 23 are declared, 1 is an alias, **0** unexplained.
  **And a reader of an entity's fields asking the entity instead of the resolution is a failure too**
  (`entity-field-aperture.ts`, ADR-0361), the **seventh** reading and the first that is not about SQL.
  A fake connection is irrelevant here: the defect is upstream of any statement, in which *set of
  fields* the question was asked about. `entity.fields` is not what the served table has, so a reader
  over it is answering a narrower question than the artifact — and because the narrow answer needed no
  workaround while the wide one did (a fabricated `{...entity, fields: resolved}`), three of eight
  classification readers took it. The rule records each reader's **direction**, because the same
  narrow read produced a disclosure in the gateway (whose drop set is `redacted` alone, so an
  undescribed key passes through) and a withholding in the audit trail (whose drop set is
  `redacted ∪ undescribed`). Twelve raw readers declared, `fails_open 3 / fails_closed 1 /
  incomplete 8`, 0 findings — and the one thing it cannot see is a reader that receives its fields
  through a structural local type, which is exactly what `EntityLike` was in `list-query.ts` until
  this increment deleted it.
  **And a declaration naming an event no producer can emit is a failure too**
  (`manifest-event-names.ts`, ADR-0362), the **eighth** reading and the first that fences a
  declaration against a *producer* rather than an artifact against the catalog. A fake connection
  is irrelevant again, and so is a real one: `matchEventJobs` compares two strings with `===`, both
  satisfy one permissive regex (`EVENT_NAME_REGEX` types *both* sides of the comparison), and a
  name nothing emits is a perfectly well-formed string. So the two halves of an event job were
  joined by a value nothing compared, and **28 of 55 (pack, declaration) instances named an event
  no deployment could emit** (this file carried **55 of 55** for two increments; see the ADR-0362
  entry above for the re-measurement and why the reasoning survives it) — while the survey written to report it told an operator to register
  a handler. The honest fence is one function building every name and the survey enumerating its
  domain, plus a rule per **resolved pack**, since an overlay replacing a lifecycle takes its
  transition targets with it and an over-wide producible set under-reports.
  **And a page that one refused row takes down, or quietly shortens, is a failure too**
  (`pg-unreadable-rows.ts`, ADR-0373), the **ninth** reading and the first about the read's *control
  flow* rather than its SQL or its names. A fake connection cannot see it and neither can a real one:
  `result.rows.map(rowToX)` is correct for every row it maps, and what is wrong is that the first
  failure takes the other rows' findings with it — so the defect is invisible to any test whose
  fixture holds only representable rows, which is every fixture until somebody writes one that does
  not. Measured: **13 of the 51 multi-row sites are a sweep or an audit**, where the page exists
  *because* a defective row is the thing being looked for. A single-row read that throws is correct
  and is excluded structurally (63 of them), because there the caller asked about that row and
  ADR-0289 says it must not be served past.
  **And a flag the deployment does not pass is outside every one of them** (ADR-0376), which is the
  **tenth** reading and the first that is not about source code at all.
  `deploy/docker-compose.yml` is not typechecked, not linted, imported by nothing and read by no
  rule, so a flag deleted from the `api` command is invisible to all twelve workspace rules and to
  every one of the 20k tests — which is exactly how `docker-compose.ai.yml` came to be ten flags
  behind the base, including `--credential-login`, so the whole self-hosted-AI path shipped with no
  login (ADR-0364's addendum). A fake connection is irrelevant and so is a real one: every flag the
  binary *does* receive is parsed, validated and refused correctly; what is wrong is which flags it
  receives. `deployment-defaults.test.ts` reads the file as text, parses the `command:` list and
  asserts the two defaults with the measurement that earned each **and the absence of the third with
  its reason** — the one *absence* fenced here, because `--read-state-routes` reads as a free win
  and is not. It also fences ADR-0301's `--api-key`-on-argv instance by name and the documented
  bootstrap's step ordering. What it cannot see is whether a flag the compose passes is one this
  deployment should pass, which is the per-flag judgement the register's P0.3 entry holds.
  **And a query that is missing a predicate satisfies all of them** (ADR-0359), which is the blind
  spot the rules share rather than a seventh reading. Every one of them asks whether a column
  exists, whether an `INSERT` is complete, whether a live database admits a value, whether a CHECK
  and a contract enumerate the same members, whether a declaration names the bound symbol, or
  whether a property names the column it is read from — and a `SELECT` whose `WHERE` is
  `tenant_id = $1` because the filter was dropped is well-formed SQL naming existing columns with
  every bound value admitted. What is wrong is which **question** was asked, and no rule over the
  artifact asks that. A **real** database cannot see it either: both stores answered
  `?state=draft` with a 200, one with every row and one with none. The only fences that fit are the
  store refusing before it issues the statement and a boot survey naming the pairs.
  **And a store can opt itself out of all of them by how it names its table** (ADR-0358). The
  scanner resolves `this.x = `${ident}.tbl`` by chasing `ident` back to a literal, and it reads
  `options.schema ?? "meta"` and a `const` but **not a parameter default** — so
  `constructor(conn, schema = "meta")`, which is the obvious shape and perfectly clear to a human,
  leaves every statement in that file an `unresolved_target` and none of its SQL compared against
  the catalog. `PostgresCredentialStore` was written that way and the rule caught it; the fix is the
  options object `PostgresUserStore` already uses, and the thing to know is that **the only symptom
  is a declared scan gap, which looks like an admission rather than a loss of coverage.** Declaring
  the gap would have been the wrong move: it is for genuinely unparseable SQL, not for a resolvable
  name a construction choice made opaque. And making it resolvable immediately bought a **second**
  finding, which is the whole argument: `pg-binding-names.ts` then reported `setCredential`'s
  `encodedHash` parameter as an `undeclared_divergence` against `credential_hash` — renamed to agree
  rather than declared, since agreement is the norm and a declaration is a judgement the next reader
  must re-verify. Neither finding existed while the file was opting itself out.
  **ADR-0335 found two more members and they are the sharpest yet**: a write that sets no tenant
  context. `PostgresLifecycleEventStore` and `PostgresDeletionRequestStore` both issued correct SQL
  that no non-owner database would ever accept — on both tables the isolation policy is the only arm
  carrying a `WITH CHECK`, so the write raised `42501` — and for the second that is **ADR-0321's
  store, meaning the whole asynchronous Article 17 flow could not write a row outside an owner
  connection**. The *reads* worked, which is what hid it. And one defect was invisible even to a live
  *request*: making an actor column TEXT while the other side of its four-eyes CHECK stayed UUID is a
  `uuid <> text` comparison Postgres has no operator for, so the `CREATE TABLE` failed and took the
  whole bootstrap with it — caught only by **applying the catalog to a real cluster**, which is now
  the fourth meta-schema invariant rather than a thing to remember.
- **Comments are rare and earn their place.** No JSDoc on every export. Comment
  a non-obvious invariant — why this order, why fail-closed here, why this
  outcome and not that one — not what the code plainly says.
- **Verify against a real Postgres before claiming done.** The offline fakes
  assert SQL *shape*; they cannot catch type inference, RLS behaviour, or
  ordering bugs. Several real defects in this repo were found only by booting a
  throwaway cluster and the real server. Do that for anything touching SQL or
  the request path.

## Workflow

The user directs one increment at a time, usually as a terse `go with the X`.
Each landed increment follows the same shape:

1. Read the relevant ADR, or design against the conversation if none exists.
2. Build the modules — no placeholders, no partial implementations.
3. Wire `META_*` tables into the kernel meta-schema (+ its test) if persisting.
4. Tests alongside each module; per-package green first.
5. `pnpm -r build && pnpm -r typecheck && pnpm -r test` — all green.
6. **Verify live** against a throwaway Postgres and the real server where the
   change touches SQL, auth, or the request path.
7. Write the ADR in the same session, following `0000-template.md`.
8. Commit with a detailed multi-paragraph message: what was broken, the rule
   that fixes it, what was verified.
9. Push, open a PR, squash-merge, reset the branch to `origin/main`.

Parallel subagents are used for disjoint files with dictated structural
contracts; the orchestrator owns shared files (`node.ts`, `cli.ts`, `index.ts`,
`meta-schema.ts`) to avoid conflicts.

## Git

- Working branch: `claude/eloquent-archimedes-bn69tr`.
- Never force-push except `--force-with-lease` when resetting an already-merged
  branch to `origin/main`. Never skip hooks (`--no-verify`).
- Don't open PRs unless asked; squash-merge when you do.
- Repository scope is restricted to `amoufaq5/crossengin`.

## Deployment

`deploy/` holds the single-VM Docker Compose stack — Postgres (with
`pg_uuidv7`), a one-shot migrate, the API, the UI, and Caddy for TLS. Overlays
add a self-hosted model (`docker-compose.ai.yml`, plus `…ai-gpu.yml`).
`deploy/VERCEL-SUPABASE.md` covers the managed-cloud path.

Two constraints worth knowing before suggesting a host:

- **`operate-server` must be a long-running process.** Its schedulers (cron
  jobs, dangling-link prune, notification drain, JWKS refresh, activation
  polling, chain checkpoints) run in-process, so serverless can host
  `operate-web` but never the API.
- **Managed Postgres usually forbids C extensions**, so `pg_uuidv7` is
  unavailable; `deploy/supabase/00-uuidv7.sql` defines a pure-SQL
  `uuid_generate_v7()` and the migration applier accepts either.
- **The extension file runs on every `up`, not only on first initdb.** `/docker-entrypoint-initdb.d`
  fires **only** on the first initialisation of an empty data directory, so a `db-data` volume that
  already holds a cluster never sees `postgres/init/00-extension.sql` again — and the arm64 defect
  guaranteed a population of such volumes, because the previous image installed `pg_uuidv7` from a
  release whose only prebuilt `.so` is x86_64, so `CREATE EXTENSION` failed under `ON_ERROR_STOP=1`
  *after* initdb had written `PG_VERSION`. Fixing the image does not repair that volume: initdb is
  skipped, `db` reports healthy, and `crossengin apply --confirm` exits **1** with
  `PRECONDITIONS FAILED — no statements were executed … [MISSING_EXTENSION]` on every `up`, forever.
  **A precondition the migrate step needs on every run cannot live only in a hook that runs once.**
  So a one-shot `extensions` service runs the **same file** before `migrate`, which depends on its
  successful completion — the same file rather than a second copy of the SQL, so the two extensions
  keep their deliberate asymmetry. Built from `./postgres` because that image carries `psql`; the
  `.so` has to be on the *server*, so this container only issues the statement. Reproduced and
  verified on PG 16.13: without the function, exit 1 having executed nothing; with it, 964 executed,
  0 failed. `deploy/README.md`'s *If `migrate` exits 1* names the error text, the self-healing path,
  the by-hand form, the destructive `down -v` form and the two other reasons that exit is reached.
- **`pgcrypto` is created at init now, and guarded where `pg_uuidv7` is not** (ADR-0338).
  `deploy/postgres/init/00-extension.sql` created only `pg_uuidv7`, so the self-hosted stack had no
  pgcrypto at all and nothing in `deploy/` ever ran `crossengin-pg encrypt --provision`. The
  asymmetry is the decision: the entrypoint runs these files with `ON_ERROR_STOP=1`, so a failing
  `CREATE EXTENSION` **aborts initialisation and the container never comes up**. `pg_uuidv7` should
  do that — the applier hard-requires it and every `meta.*` id default resolves through it — while
  pgcrypto is needed only by a manifest declaring a `phi`/`regulated` field (none in `erp-core`, the
  compose default) and the serving store already provisions it when a plan needs one. So pgcrypto
  goes in a `DO` block whose handler downgrades a failure to a `WARNING`, and a missing one degrades
  to a boot refusal naming the entity and field rather than a database that will not start. Both arms
  verified on PG 16: `EXECUTE` inside a `DO` block does create the extension, and an unavailable one
  is caught with `psql` still exiting 0.
  **Both of those files carried a claim about the applier that was false**, and the correction is
  what makes the stack build on arm64. They said the applier *"hard-requires the pg_uuidv7
  EXTENSION (it checks `pg_extension`) — a plain SQL function will not satisfy the precondition"*,
  while `checkPgUuidv7Extension` asks `pg_extension` **or** `pg_proc` in one statement — which is
  the whole managed-provider path and what `deploy/README.md`'s own Notes section already said
  correctly. The unguarded `CREATE EXTENSION` is still right, for a narrower reason: this image is
  *built* to install it, so a failure there is a broken build rather than a degraded runtime, and a
  silent fallback would hide it while taking a per-row SQL function on every INSERT.
  **And `pg_uuidv7` now comes from the PGDG apt repository rather than the project's GitHub
  release**, because that release ships one prebuilt `.so` and it is **x86_64 only**
  (fboulnois/pg_uuidv7#24) while `cp` of a file succeeds on every architecture — so an arm64 build
  produced an image that looked correct and whose `CREATE EXTENSION` failed at initdb with a
  wrong-ELF-class error, under `ON_ERROR_STOP=1`, so the container never came up and nothing in the
  output named the architecture. That is every Apple-silicon laptop and the whole of Oracle Cloud's
  Always Free tier, whose only usefully-sized shape is Ampere A1. PGDG publishes
  `postgresql-$PG_MAJOR-pg-uuidv7` for amd64, arm64 and ppc64el and the official `postgres` image
  leaves that repository configured, so apt resolves the right binary and no architecture is named
  anywhere. `$PG_MAJOR` and not a pinned extension version: the `.so` must match the server's major
  ABI, which the package name carries, and that is the only axis on which this can be incompatible.
  `deploy/README.md` gained an **On Oracle Cloud (Always Free)** section with the nine steps, and
  the one that catches everyone is that Oracle filters twice — the subnet security list *and* the
  instance's own persistent `iptables` rules — so fixing one half looks like the fix having failed.
  `COLUMN_ENCRYPTION_SECRET` is in the compose `environment:` block and **never** in `command:`,
  because argv is readable via `ps`; the compose file also says what switching `OPERATE_PACK` to
  `erp-healthcare` or `erp-government` requires, since that is where an operator meets the refusal.
- **Two background flags are defaults now, and a third is deliberately not** (ADR-0376). The `api`
  command passes `--notification-drain-ms 15000` — without which **nothing** is delivered on any
  channel, `in_app` included, since `DeliveryScheduler` is the only delivery path — and
  `--tenant-status-gate`, which converts a **200 over a tenant with no `meta.tenants` row** into a
  403 naming it. Expect one boot **error** line on a fresh stack
  (`[tenant-status] 1 configured API-key tenant(s) have no meta.tenants row …`): it is correct, it
  is about `OPERATE_ADMIN_API_KEY`'s placeholder uuid, `/v1/platform` is exempt so the bootstrap
  still runs, and it is documented in both the compose comment and `README.md` so it does not read
  as the default having broken the deployment. `--read-state-routes` is **withheld with its reason
  written down**: mounting it works and the inbox badge has nothing that can clear what it then
  counts, so it is blocked on a notifications page rather than on a decision.
  `deployment-defaults.test.ts` fences all three — the two presences and the one absence.
- **The documented bootstrap is five curls and no shell** (ADR-0376). `deploy/.env.example` omitted
  **creating the tenant**, so its step 2 was a `422 meta.tenants has no row for the id this grant
  names` on every fresh deployment; the id is minted by the server (`{slug, name}`, and an `id` key
  is a 400), which is why the api-key's tenant uuid is a placeholder that can never name a real
  tenant. And the password step it called shell-only has been an HTTP route since ADR-0364,
  authorised by the `--credential-admin-role` *grant* the compose passes and satisfied by the
  bootstrap api-key — `set-credential` is the documented fallback, not the only path. `ORACLE.md`
  carried ADR-0369's pre-fix one-role claim and told an operator to keep a spare tenant to work
  around it; one membership with `secondaryRoles` is the answer and the commands grant both.
- **The compose file no longer contradicts its own comment** (ADR-0357). It carried that `ps`
  sentence and then passed `--api-key ${OPERATE_ADMIN_API_KEY}` in `command:` nine lines down —
  the one credential on the stack that can provision and delete tenants — because the flag was the
  only route there was. It now passes `OPERATE_API_KEY_SPECS: ${OPERATE_ADMIN_API_KEY}` in the
  `environment:` block, which needs **no `.env` change**: the variable it reads is the one that was
  already there. `CURSOR_ENCRYPTION_SECRET` is beside it and `.env.example` names both it and
  `COLUMN_ENCRYPTION_SECRET`, which the compose file had always passed and the example had never
  mentioned. **Naming them was not setting them** (ADR-0377): both were *commented out* in
  `.env.example`, identically, while their measured facts are opposite — resolved `erp-core` has
  **0** `phi`/`regulated` fields and **1** sortable classified field — so the at-rest one is right
  to stay commented and the cursor one is now uncommented with a generator line and named in
  `README.md`'s first-launch list. Three other deploy documents had treated it as required all
  along; the canonical quickstart was the one that did not.
  `--idempotency-store pg` is on the command, so the replay guard is durable rather
  than a `Map` in one process.
- **The `api` service has a healthcheck and `web` waits on it** (ADR-0357). `/readyz`, not
  `/health`: the question compose is asking is whether `web` and Caddy may be pointed at the API,
  which is readiness. Before it, `web` was `condition: service_started`, so every deliberate boot
  refusal became a public 502 — the stack reported the container `started` the moment it was
  spawned and nothing in it held the opinion that anything was wrong. `start_period: 40s` covers
  the catalog admission survey and per-tenant key provisioning, which both run before the listener
  binds.
- **The UI has a login, and it did not until ADR-0358.** The compose stack no longer carries
  `OPERATE_WEB_API_KEY` — the variable is gone, not unset — and the `web` service passes no API
  key at all; `api` gains `--credential-login` plus `--jwt-issuer` / `--jwt-audience`, and two
  required secrets in the `environment:` block (`CREDENTIAL_PEPPER`, `OPERATE_TOKEN_SIGNING_KEY`,
  never in `command:` — ADR-0301). `deploy/README.md`'s section is retitled *The UI has a login*
  and carries the three things an operator has to know: set the two secrets (the boot line says
  `credential login: enabled (kid login-v1, public key …)`, or `refused` naming the variable);
  **create the first user by hand**, because there is no mail channel so there is no forgot-password
  and no sign-up — `.env.example` has the three commands, ending in `set-credential` with the
  password in the environment; and **a revoked membership stops working within 30 seconds since
  ADR-0381**, where it used to keep working until the token expired — one hour on the shipped
  compose, since `--session-token-ttl` is not passed and `DEFAULT_SESSION_TOKEN_SECONDS` is 3600.
  `withMembershipRevocationCheck` refuses a person-naming principal whose membership does not
  resolve, over **the directory that was already reading that row**: the fact was computed in the
  auth stage on every request and reached only `dischargeAbac`, which acts on it for a grant
  carrying an obligation — of which the measured count across the seven packs is **zero**. So the
  revocation was detected and the detection reached nothing. Default-on under `--credential-login`
  with no flag (ADR-0338's rule — nothing revoked a session correctly before, so refusing one breaks
  nothing that worked), and the window is the directory's 30s value TTL rather than the session TTL,
  which the boot line names because the two differ by two orders of magnitude. Live: 200 → revoke →
  200 (cached) → **401** after 31s, with the api-key unaffected and a restored membership working
  again. What remains open is narrower: 30s is not immediate (a denylist would be), the refusal
  conflates *no row* with *not active*, and **`meta.users.status` itself is still not read** — the
  two statuses are independent columns on independent tables, so a suspended user whose membership
  stays `active` keeps their session. Two stale-doc members rode along and are fixed (ADR-0377):
  `apps/operate-web/README.md` documented `OPERATE_API_KEY` with its `devkey` default as a live
  variable, and `deploy/VERCEL-SUPABASE.md` told a managed-cloud operator to set it on Vercel —
  a variable read **nowhere** in that app, so following that page produced a UI authenticating
  nobody and a troubleshooting entry naming a remedy that could not work. Rotating the signing key
  remains the way to cut every session off at once. The lockout's limits are
  stated rather than overclaimed: it bounds guessing against *one* account and deliberately does
  not address credential stuffing, because behind Caddy every request arrives from the same
  container address so no per-IP limit is available — and it means anyone who knows an email can
  lock that user out for the window, which is why the window lapses and why `set-credential`
  clears a lock. The boot lines an operator should read after the first `up` are now four:
  `[auth]` (twice — api-key specs and credential login), `[pg]` and `[cursor]`.
- **Only the *first* user is a shell step now** (ADR-0364). The compose command gains
  `--credential-admin-role platform_admin`, so Platform → Users sets a password over HTTP and
  `README.md`'s section is retitled *Create the first user by hand — and only the first*: the
  asymmetry is the bootstrap rather than an omission, because the console's set-password route
  needs a session, which needs a password, so exactly one credential has to come from outside the
  web. `.env.example`'s four-step walkthrough is what an operator follows, and **its step 1 could
  never have worked** — the curl sent a flat `{"email":…}` body against a `.strict()`
  `{user, membership?}` schema, a 400 every time, while `README.md` had it right — so the two
  agreed about the feature and disagreed about the request. Step 2 (the membership, with its own
  note that `status` has no default because *"invited" promises access and "active" grants it*) was
  missing entirely. `README.md` also gained a **capability table** for the console with four
  explicit non-capabilities beside it — no user search, no per-user tenant list, no role dropdown,
  no database browser — because a console page that looks complete is read as complete.
  **Three things in `deploy/` could not work and were fixed in the same session** (ADR-0364's
  addendum). `.env.example`'s bootstrap curls named `http://localhost:8787` and the stack **published
  no host port at all** — `api` declared `expose: 8787`, the compose network only, and Caddy's 80/443
  were the only published ports — so the only documented path to the first login was refused by the
  host. The compose publishes **`127.0.0.1:8787:8787`** now, and the loopback binding is the whole of
  it rather than a formality: a bare `8787:8787` publishes on every interface, which on a cloud VM is
  the public one, while loopback is reachable by exactly the population that can already run
  `docker compose exec`. Rewriting the curls against `https://api.$DOMAIN` was the alternative and is
  worse — the bootstrap is precisely the moment DNS may not have propagated and Caddy may hold no
  certificate, so it would make the first user depend on the last thing to come up.
  **`docker-compose.ai.yml` carried its own copy of the entire `api` command and was ten flags
  behind**, including `--credential-login` — so the whole self-hosted-AI path had no login and the web
  app it ships with could authenticate nobody — and it still passed `--api-key` on argv, the exposure
  ADR-0357 removed from the base. Its own comment said *"Keep the two in step when either changes"*,
  which is ADR-0288's maintained list, so the copy is **deleted** rather than re-synced: the model
  gets an environment route and the overlay declares `environment:` alone, which **merges** where a
  command replaces, so it inherits all 16 flags and all 33 variables.
  And **`deploy/ORACLE.md` is the document an Oracle operator actually follows** and the original
  increment did not touch it, so it still told them the first user was a shell step on purpose, to
  hand-edit flags the compose already passes, and granted a different role than `.env.example` —
  a fork that decides what the first person can do, since a session carries exactly one role.
- **The managed-cloud guide says to *try* `PGSSLMODE=verify-full` and names what `require` costs**
  (ADR-0357), where it used to prescribe `require` with the comment *"Supabase requires TLS"*.
  That hop crosses the public internet carrying `app.current_tenant_id`, and `require`
  authenticates nothing — the peer is whoever answered. It is *try* rather than *set* because
  **`verify-full` may not be reachable there**: `PgConfig` has no `ca` field and nothing reads
  `PGSSLROOTCERT`, so it validates against Node's trust store alone, while Supabase's own
  documented path for `verify-full` is to download the project's server root certificate and pass
  it as `sslrootcert`. So accepting CA material is the top follow-up for that member — not for
  `verify-ca`'s sake but because it decides whether the mode the increment prescribes can be used
  at all. Inside the compose stack the hop is a private Docker network, so the `prefer` default
  there is reasonable and the boot line says which was got either way.

## What's actually left

Nothing planned is unbuilt; what remains are follow-ups named in the ADRs that
opened them.

**Load-bearing**

- **A sweep survives the row it exists to find, and what is left of it** (ADR-0373 closed ADR-0372's
  Q2). Measured by calling the rule over the committed tree before and after, which is the only
  figure worth carrying because it is the one the rule produces: **82 sites needing a declaration
  became 67**, so **15** are closed — the chain reader, the audit-anchor read, the tombstone sweep,
  the DR drill/failover/readiness reads, the SLO enforcement reads, the access-review
  campaign/item/decision reads, the workflow event log and the engine's definition load. `kernel-pg`'s `read-rows.ts` is the one spelling, generic in the row
  type, with two shapes the store's contract picks between (**forward** a reporter, or return the
  refused rows **beside** the records when the consumer is a verifier), and
  `packages/testing/src/strategy/pg-unreadable-rows.ts` is the twelfth rule over the whole class.
  What remains, in order: **(1)** **42 of the 65 declared sites are `unmigrated`** (re-derived from
  the module after ADR-0374, which closed `forensics-pg::checkpoint-store::listRecent` — the figure
  this entry carried, 44 of 67, was right when written and wrong one increment later, which is the
  entry above's own warning landing on this one) — the backlog,
  each naming what a refused row costs today, and the sharpest are `column-store::listPageOn` (every
  tenant list request), `crypto-pg::listKeys` and
  `access-reviews-runtime-pg::evidence-store::listByTenant`; nine are latent on declared-callerless
  stores and say so. **(2)** **nothing fences a consumer that reads `.records` and drops
  `.unreadable`** — the direction is right and the figures are not reproducible with a plain grep
  (one pass gets 50 against 45, another 57 against 50, depending on an unstated filter), so what is
  established is the shape and not a count. `audit-log-store::listForTenant` is the live instance,
  and its own stated reason is wrong: it has **zero non-test callers**, so "its consumer is a
  reader" names a consumer that does not exist and the kind is decided by whoever gives it one.
  Dropping a reporter's findings is one level up from a conversion and so outside the twelfth rule
  by construction. **(3)** `unreadableDetail`'s no-value property is **enforced** for a `ZodError`
  and **assumed** for a mapper's own guard, whose message passes through. That assumption has
  exactly **one** live counterexample — `access-reviews-runtime-pg/src/records.ts`' numeric guard,
  which interpolated the value and is fixed — and the honest fence is still a text test over the
  construction sites with a vacuity floor, because the next one is a comment away. **(4)** a new required field on a
  `.strict()` stored shape now turns every pre-existing row into a paging `sev1`, where the same
  change used to be silent — the remedy is a contract-evolution rule (`.optional()`, or a version
  tag) rather than anything in the read. **(5)** `DrReadinessReport` has no field for *this axis's
  evidence was partly unreadable*, so a page of one readable drill beside one refused one still
  reads `ready: true` with `totalIssues: 0`; `unevidencedAxes` cannot say it, because naming
  `failovers` is a compile error by design and naming `drills` renders a false sentence into a SOC 2
  pack. **(6)** two spellings of *forward the reporter* (positional and an options field), each
  matching its own call site's existing signature, with nothing deciding which. **(7)**
  `tombstone-store`'s `listForTenant` and `findForRequest` still throw, and the second is a verdict
  decision rather than a read one: it is the reconciler's *evidence* lookup, where a refused row is
  not a missing proof but an unanswerable question. **(8)** `deletion-request-store`'s
  `UnreadableRequestRow` keeps its own field name (`requestId`, deliberately — it is what its three
  audiences act on) while sharing the primitive's `detail` rule, so the vocabulary is one and the
  shape is two — but its **type** name is not: `UnreadableRowReporter` is now two incompatible
  exported types under one name (`kernel-pg`'s over `UnreadableRow`, `tenant-lifecycle-pg`'s over
  `UnreadableRequestRow`), both re-exported with `export *`, and `node.ts` imports from both. The
  ADR argued the field name and did not notice the type name; this file records exactly that shape
  as a finding for `packages/deploy`'s six colliding flag names. **(9)** `auditRowLimit` bounds the
  anchor check at the newest 500 rows (`ORDER BY occurred_at DESC`), so a refused audit row outside
  that window reaches no axis. Pre-existing, and worth saying now that `anchors.unreadable` is
  framed as *the* detector for an edited audit row.

- **The alarm cannot be cancelled by a write on a third table, and what is left of it** (ADR-0374,
  which ADR-0373 made necessary). A refused *checkpoint* row threw out of **both** of
  `proveScopeIntegrity`'s unguarded `checkpoints.latest(scope)` calls, so the hourly pass filed
  `outcome: "error"` and one `UPDATE` on a column of a different table — reachable by the tenant,
  `UPDATE 1` live as a non-owner — erased the pass that would have reported a genuine chain tamper
  on the same scope. Closed by `anchor_unreadable` (fold from genesis, catching only
  `CheckpointRowUnreadable`), a third refusal axis `integrityVerdictFor` answers `compromised` for,
  and two CHECKs; verified 15/15 live.
  **And then the increment reproduced its own class inside its own fix, which an adversarial pass
  over the commit found and is the most useful thing in it.** Making
  `verifyChainFromCheckpoint` answer `ok: true` instead of throwing is right as a *verification* —
  and `CheckpointScheduler` consumes that same function as its `verify` seam and anchors on
  `verification.ok`, so a refused anchor stopped being an `outcome: "error"` and became a
  **recorded** readable checkpoint at the current tail, which `latest()` then returns because it
  orders by `sequence_number DESC`. The refused row stays and the finding does not. Measured live,
  additive writes only: `compromised` + `[onPass, onFinding, escalate]` before one scheduler pass,
  `verified` + `[onPass, escalate]` after it. **The commit turned a loud error into a silent success
  that erased its own new alarm**, and `node.ts` starts the checkpoint lifecycle *before* the
  integrity proof with both `runOnStart` and both hourly, so on the paired configuration the burial
  happened milliseconds before the proof looked. It also refuted this increment's own Option D
  reasoning: `DO NOTHING` blocks replacement **at that sequence** and the scheduler anchors at the
  **tail**, so "the refused row stays where it is" was true of the row and false of the finding.
  Closed by `CHAIN_FULL_REASON_BLOCKS_ANCHORING`, a total map over the five reasons — only
  `anchor_unreadable` is true, because for `anchor_unverified` and `anchor_provenance_absent`
  anchoring **is** the heal and the other two have nothing to bury — with the scheduler refusing to
  anchor and routing to its **required** `onRefused`. The price is that such a scope folds from
  genesis every pass until the row is corrected, which is the right price and is self-healing in
  the correct direction. The same map fixes the **CLI**, where `verify-chain --from-checkpoint`
  exited **0** printing "OK" for a scope whose anchor this binary cannot read — ADR-0374's own
  Option B rejection, left standing in the by-hand auditor command; measured 0 → 1 against a
  pre-fix worktree, with the full fold correctly still 0 (it never consults the anchor) and
  `no_checkpoint` on a sound chain still 0. **ADR-0375 found that last clause to be the hole rather
  than the control**: "the full fold never consults the anchor" is why `verify-chain` *without*
  `--from-checkpoint` could not see a refused anchor at all, so the weaker command caught it and the
  stronger did not — and reading `fullBecause` is a statement about the **newest** row, so a refused
  or relocated anchor anywhere else exited 0 in both modes. The command audits the whole table in
  both modes now, through `anchorAuditHasFindings`, which is the wider of the audit's two predicates
  because an exit code has no third answer for a scan the ceiling stopped.
  Two more live members came out of the same pass. **A `compromised` verdict driven by
  `truncation.truncated` was discarded as `skipped_empty`** — `isEmptyScope` never had `truncated`
  as a conjunct, and this increment added a fourth axis to `readEveryRowFound` and wrote a long
  comment about which axes fire there without re-examining the other two conjuncts against the
  verdict function. The asymmetry is the sharp part: the **weaker** evidence (an anchor that cannot
  be read) was kept and the **stronger** (a proven total truncation, the thing ADR-0287 built the
  check for) was thrown away, with zero callbacks; only the *maximal* truncation was lost, since one
  surviving entry makes `tailSequence` non-null and the first conjunct already fails. Closed one
  level up — `isEmptyScope` asks the **verdict**, which is total over every condition, rather than a
  conjunct list that must be revisited whenever a condition is added. `readEveryRowFound` stays, and
  the reason first given for keeping it was **wrong**: nothing could reach it was false, since two
  tests across three fixtures override a refusal axis on a fixture whose verdict stays `verified`
  and deleting the call fails exactly those two. The honest statement is that it can no longer
  change the answer *for a report `proveScopeIntegrity` builds* — `verdict` is a claim on the report
  and `prove` is a **seam**, where the refusal lists are the content (ADR-0331 inside one
  predicate), measured both ways: `unproven` cannot reach `skipped_empty` from the producer
  (`checked` *is* `results.length`) and can from the seam.
  **And the fence that was supposed to stop a seventh cause arriving unexplained fenced nothing** —
  refuted by mutation, a seventh `compromised` branch with no payload key gave 83 of 83 passing,
  because nothing enumerated the branches. ADR-0288's maintained list, and ADR-0351's *documented
  the hazard and checked nothing*. So `COMPROMISE_CAUSES` is the six conditions,
  `COMPROMISE_CAUSE_HOLDS` a total map of predicates over it, and **`integrityVerdictFor` is
  implemented through `compromiseCauses`** — six `return "compromised"` became one, so the branch
  list *is* the cause list. Measured: a seventh entry in the predicate map alone is `TS2353`, adding
  the enum member to fix that gives `TS2741` at the payload key and both fence fixtures, and the one
  gap no type can see — a bare `if (…) return "compromised"` in the body — typechecks clean and
  fails a **text fence** over the function, which caught a vacuity hazard on its own first run
  (the prose two functions above quotes the same string, so the lazy fix is to write the expectation
  down to 2 and check nothing).
  And **`checkpointed_at` is a third column
  carrying the same attack**: it is TIMESTAMPTZ with no CHECK, `'infinity'` is admitted as a
  non-owner, node-postgres hands it back as the **number** `Infinity`, and the mapper refuses it —
  so this increment's claim that "the two CHECKs make the write itself fail" was false, and the
  whole-table invariant it added was false under its own predicate. **ADR-0373 missed the same shape
  on its own table, having exempted it by name**: `recorded_at` is inside `canonicalEntryBytes`, so
  a tamper there is signature-breaking exactly as `actor_reference` is, and that ADR's test comment
  called it *"the TIMESTAMPTZ that `Iso8601` parses to"*. Neither was a buried alarm, which lowers
  the severity of both and is the correction this addendum owed itself: ADR-0373's read-path fix
  covers the entries table and `readOne` catches **any** throw rather than only a `ZodError`, so the
  **write fence** was missing on two tables and not the detector.
  What remains, in order: **(1)** **78 `meta` tables carry an `ALL`-scope `*_tenant_isolation` policy
  with a NULL `WITH CHECK`, 0 of them carry a `DELETE` policy, and a tenant-context non-owner deleted
  every row the **owner** can see in its scope, on 6 of 6 scopes measured, across all three
  forensic tables** — so a tenant can destroy
  its own tamper-evident trail, and every argument in this file that reads "`DELETE` is reachable by
  no policy" is about the *named arms*. Narrowing 78 arms from `ALL` to the three commands is one
  decision over the whole catalog and would change what every tenant write path may do; the fix for
  the trail specifically may be narrower (a `FORCE ROW LEVEL SECURITY` plus three arms on the four
  forensic tables). **(2)** the two CHECKs are **standing manual SQL** on every existing deployment,
  reported with their statements until run. **(3)** the remedy for a refused anchor reaches an
  operator in the **log line only** — the identity and the field path, and no route to the row, which
  is the diagnostics console (ADR-0364 Q6) again. **(4)** `anchorRowsRefused` is at most one row by
  construction (`latest()` reads one), so it is a list for uniformity with its two siblings rather
  than because it can hold two; if `listRecent`'s refusals ever reach a verdict, the three axes want
  one shape. **(5)** the general form of the CHECKs is register P2.12b — a contract field's
  refinement against its column's CHECK, which no workspace rule compares (ADR-0362 established that
  none compares a contract *field* to a catalog *column*), over 505 TEXT, 159 JSONB and **444
  TIMESTAMPTZ** columns in the same unconstrained state, the last of which had **zero** CHECKs
  anywhere in the catalog before this increment. ~~**(6)** widen the detector so the scheduler can
  anchor again~~ and ~~**(7)** truncation detection is dark for a scope whose anchor is withheld~~ —
  **both closed by ADR-0375**, which also found that (6)'s own plan does not work: `listRecent` is
  descending-with-a-limit, so the consumer it predicted could not use it and the scan is a new
  ascending-keyset method beside it. See *One witness read, and never compared* below, and note that
  measuring these two is what found the two live defects that increment is actually about.
  **(8)** `pg-record-reads.ts` blanks string bodies before matching, so a **bracket-access** read of
  a catalogued column vanishes — neither column fenced here appears in its 66 reads, against ~1,270
  such reads workspace-wide, 100 of them temporal. Conservative-only, wide, and a thirteenth-rule
  finding rather than a fix. **(9)** the sharpest temporal member is on neither table fenced here:
  `meta.audit_integrity_verdicts.verified_at`, whose helper turns the same tamper into a bare
  `RangeError` rather than a `ZodError`, in a `record_throwing` conversion with no wrapper, in the
  store that holds the verdicts — with `tombstone-store.deleted_at` and `report-store.generated_at`
  beside it.

- **One witness read, and never compared, and what is left of it** (ADR-0375, closing ADR-0374's
  open ends 6 and 7 and finding two live defects in them). The anchor table is read as a **set** now
  — `scanCheckpoints` ascending page by page, `auditAnchors` folding it — and every readable anchor
  is cross-checked against the chain, so a refused row is found wherever it sits and an anchor edited
  into a valid-shaped lie is a named finding rather than a silent `verified` or a false
  `chain_truncated`. The scheduler anchors again and reports what it anchored over, which is why
  `CHAIN_FULL_REASON_BLOCKS_ANCHORING`, `anchoringWouldBury` and `refused_anchor_would_bury` are gone.
  What remains, in order: **(1)** **a two-column `UPDATE` defeats the correspondence rule**, found by
  an adversarial pass over the commit and measured both ways as the same non-owner role: setting
  `sequence_number` and `root_hash` in one statement hides a real truncation under a report
  byte-identical to a healthy scope's, and restores the false `chain_truncated` sev1 the one-column
  form no longer produces. `disagreementFor`'s three questions all fall through to *no finding*, which
  is deliberate for the case the truncation check owns and is also what the two-column edit looks
  like. No dearer to the attacker (the destination entry's hash is readable from the chain, and
  `UNIQUE (tenant_id, sequence_number)` only needs the destination sequence free) and **quieter than
  the `DELETE` below**, which at least leaves `witness=null`. Closing it needs evidence the anchor
  table does not hold, which is the same Option G as (2) or an anchor table that is itself chained;
  the obvious cheap detector — `checkpointed_at` against `sequence_number`'s order, which today is
  compared against nothing — is recorded **with its refutation**, since it reaches neither arm (the
  lowering moves the anchors in order, so both orders are one permutation; the raising moves one row).
  **(2)** **a tenant can `DELETE` its own checkpoint rows**, and that leaves
  no witness, no finding and a remedy that cannot work — measured, all three anchors deleted reads
  `verified witness=null` with the formatter printing *"no checkpoint yet — run the checkpoint
  scheduler"*. The chain already remembers what the last verdict saw (`integrityVerdictPayload`
  commits `truncation.checkpointSequence` to a signed entry) and `witnessSequence` is monotone
  non-decreasing, so a drop is evidence — but reading it makes one pass's verdict an **input** to the
  next, needs an answer for the no-prior-verdict case, and is conditional on `recordVerdict`. Its own
  increment, and the same one that closes (1). **(3)** `verify-chain` asks the correspondence in
  **neither** mode, because neither fold
  hands its entries back and a bounded command must not read the prefix; closing it means a shape
  change or a second whole-chain load for the manual auditor. **(4)** the scan is a sequence of
  per-statement snapshots inside one transaction, so a row whose `sequence_number` is edited between
  two pages can fall between them — `REPEATABLE READ` would close it and `withTenantContext` issues
  `set_config` first, so the isolation level cannot be set late. **(5)** `root_hash_mismatch` cannot
  say whether the anchor or the entry was altered, and saying so is better than guessing; a chained
  anchor table would, at the cost of a second chain — and it is the same mechanism (1) needs, so the
  two compose. **(6)** the aperture half is reachable on a
  deployment that has not run ADR-0374's standing manual `ALTER`s, which is the live population and
  is that increment's own open end 2. **(7)** a deployment with more checkpoints than the ceiling
  reports `unproven` for ever; the default is 1,000,000 rows, which is a century of hourly passes per
  scope, and no flag exposes it because nothing needs one yet. **(8)** the class behind face 2 is
  **a column whose correctness is defined by another table, and which nothing compares** — no
  workspace rule asks it, and it is not P2.12b (a contract field against its own column) but the
  cross-table form. It is partly covered by hand where somebody thought of it: `isAnchoredByChain`
  checks a tombstone's chain coordinates, `verifyAuditAnchors` checks an audit row's, and this
  increment adds the checkpoint's. What has no fence is the question *which such pairs exist*, and
  the answer is not derivable from the catalog, because a foreign key is exactly the case where
  Postgres already enforces it and these are the cases where it cannot.

- **Every money figure is read over the whole set, and what is left of it** (ADR-0367,
  user-directed). Thirteen capped reads drain their cursor to a declared ceiling now, and the
  position decides what reaching it does — a guard refuses, an effect aborts, a report declares.
  What remains, in order: **(1)** a **grouped SQL aggregate** for the two reports, which is the one
  place shape C is wanted rather than refused — they need the totals over *everything* and the rows
  over *a page*, which is two reads, and the 20 000 ceiling exists because both return a row per
  document. **(2)** **no flag reaches any ceiling** — not a CLI flag, not a manifest field, not an
  environment variable — so every refusal deliberately names no remedy (ADR-0334). One flag per
  site is nine and one shared flag is wrong, because the sites differ in kind. **(3)** the recorder
  seam on `HandlerContext` (ADR-0359's open end) now has a second caller: until it exists, an
  effect's ceiling refusal is a 500 whose only diagnosis is its own name. **(4)** a ceiling bounds
  one request and **nothing bounds the fleet** — `createNodePgConnection` sets no `max` so pg-pool
  defaults to 10, and there is no `statement_timeout`, `query_timeout` or
  `idle_in_transaction_session_timeout` anywhere in `kernel-pg`, `api-gateway-runtime` or
  `apps/operate-server`; seven of these sites drain inside a write transaction. **(5)** the two
  mirror-the-rows effects still hold a document's children as derived payloads; streaming them would
  make those O(1) too, at the cost of interleaving reads and writes on one table (safe here, since
  the drain's filter can never match a row the effect creates). **(6)** `type.min`/`type.max` are
  enforced by nothing — **81 fields in `erp-core` alone** — which is the reachability argument for
  two members of this class and is register P1.2's shape inside a money column; it needs a
  `FieldErrorCode` member, a `FieldRule` field and a DDL CHECK. **(7)** `field.indexed` and
  `entity.indexes` are authored, merged, hashed, resolvable and **emitted by nothing** (162 + 50 in
  `erp-core`, 219 + 67 across the seven packs) — ADR-0360's `unique` finding one declaration over,
  and the reason `lookupPeriodEndRate`'s rewrite is *exact* but not *O(1)*. **(8)**
  `computeAging` uses `asOf` only for `daysBetween` while the payments and the open-document set
  carry no date bound, so `?asOf=` in the past subtracts payments made after it and omits documents
  paid after it — both understate a historical snapshot, independently of truncation. **(9)**
  `paymentApplicationEffect` sums payments without consulting `direction`, which its own settlement
  config declares, so an outbound payment carrying the same `invoice_id` counts toward settling it.
  **(10)** `lookupPeriodEndRate`'s filter omits `rate_type`, which has four enum values, so the
  selection among same-date rate types is arbitrary — adding it changes which rows are candidates,
  which is a domain decision.
- **A password is settable over HTTP, and what is left of it** (ADR-0364, user-directed). The
  console provisions a person, moves their status, grants and revokes a membership and sets a first
  password, and `/account` is the self-service change — so onboarding is four console steps after
  one shell step, where it was three and a `docker compose exec`.
  What remains, in order: **(1)** an operator-set password is **permanent, not single-use** — there
  is no `credential_must_change` column, so the person who typed it can keep using it and the
  operator who chose it still knows it. A nullable column, a branch in `verifyLogin`'s outcome and
  one console sentence; the migration is free for ADR-0358's reason, since a CHECK on a column the
  plan is *adding* has no existing rows to validate against. **(2)** the self-service route has
  **no rate limit**, so the record lockout is the whole fence against guessing a current password —
  which bounds guessing against one account and is the right fence, but a per-route policy needs
  `--rate-limit-policy` mounted, which is register P0.3. **(3)** `UiViewer` carries no identity, so
  `/account` names the *role* and not the person and **nobody can be shown their own record**; see
  register P1.16, which this made the blocker for. **(4)** no email filter on the users list, and
  the page says so rather than offering one (ADR-0359's rule). **(5)** the credential surface
  prints what it mounted and does not **survey** — in particular a deployment with
  `--credential-login` and no `--credential-admin-role` is not warned that setting another user's
  password still needs a shell, which is the shape every sibling capability here takes and is not
  taken. **(6)** the **diagnostics half of this console is unbuilt**, and it is a bigger increment
  than this one because it is routes before UI: every boot survey in the binary
  (`surveyCheckAdmission`, `surveyListSurfaces`, `decideCursorDisclosure`, the unique-enforcement
  report, the erasure-coverage report, the job survey) is `console.log` only, and
  `crossengin apply --plan` produces a JSON plan **no route serves**, so an operator reads all of
  it through `docker compose logs`. **(7)** tenant **self-registration**, which this increment is
  the prerequisite for — a signup is "create a tenant, create a user, set a credential", exactly
  the three acts now behind a surface — and which still needs a public route with
  `--rate-limit-policy` mounted, email verification (so a mail channel: register P1.14), and a
  decision about what a self-registered tenant *gets*, since `trial` was removed from the tenant
  lifecycle in ADR-0334 as a plan tier with no producer.
  Five of that ADR's own review findings are closed in its addendum and what they leave is narrower:
  **(a)** the self route still has no *rate* limit, so the lockout is the whole fence — it bounds
  guessing against one account, which is the right fence, and a per-route policy still waits on
  register P0.3. **(b)** `--login-lockout-*` now governs two surfaces and is still named for one;
  renaming it is a flag rename with a deprecation, and the hoisted `loginLockout` is the seam if a
  second policy ever becomes wanted. **(c)** the three 403s on the operator panel
  (`forbidden` / `self_not_permitted` / `user_not_active`) are indistinguishable to the client,
  because `throwProblem` keeps `detail` over `error` — the page names all three remedies rather than
  string-matching a sentence that will be reworded, and the real fix is a client that reads the code,
  which `/account` already does for its own reason. **(d)** `--allow-cursor-disclosure` and the
  loopback publish are both one-line compose decisions an operator inherits without being asked;
  neither is surveyed against what the deployment actually serves. **(e)** nothing compares the two
  compose files, so the next flag added to the base and not to an overlay is found by a reader again
  — the overlay now needs no command, which removes the instance rather than the class, and a rule
  over `deploy/` is what would close it.
- **At-rest PHI encryption works, per tenant, and what is left of it** (ADR-0338 closed ADR-0337's
  top open item; specified across ADR-0070 / ADR-0071 / ADR-0074 / ADR-0091). The key is **derived,
  not stored**: `HKDF-SHA256(ikm = COLUMN_ENCRYPTION_SECRET, salt = tenantId, info =
  "crossengin.column-encryption.v1:gen<N>")`, set as `app.column_encryption_key` transaction-locally
  and **as a bound parameter**, so it reaches no SQL text, no `log_statement` output and no query
  plan. Convergence rather than invention: ADR-0302 had already decided this exact shape for the
  structurally identical problem (a per-tenant key derived from `NOTIFICATION_BOUNCE_SECRET`), and
  following it meant no new table, no CHECK migration on `meta.crypto_keys` — which is structurally a
  *public*-key directory, with no private-material column and an `algorithm` CHECK naming only the two
  signing algorithms — and no cipher added to `packages/crypto`, whose three pins
  (`KEY_ALGORITHMS`, `KEY_PURPOSES`, `CRYPTO_OPERATIONS`, the last with a test asserting
  `isCryptoOperation("encrypt") === false`) say it has none. Verified live as a non-owner on PG 16:
  the `POST /v1/patients` that was a 500 returns 201, `mrn` is `bytea` whose bytes begin `c30d04`
  with the plaintext absent, tenant A's derived key decrypts it and tenant B's is refused
  `Wrong key or corrupt data`, and `crossengin-pg encrypt --verify` reports
  `ciphertext: 4   plaintext: 0`.
  **The GUC is forced, not chosen**: `emitEncryptingViewTriggersSql` bakes the key ref into a plpgsql
  *function body*, so a bind parameter is structurally impossible on the trigger path — which means
  ADR-0091's stated reason for preferring a reference (a bind param "puts key material in the
  application process and the wire") is weaker than it reads, since `set_config($1,$2,true)` does
  both, while the conclusion survives for the trigger reason.
  **And the house GUC idiom would have destroyed PHI, which is what ADR-0070 Q2 proposed.** Measured:
  `current_setting('app.k', true)` is NULL when unset and `pgp_sym_encrypt(x, NULL)` returns **NULL
  silently**, so mirroring the tenant-RLS predicate writes NULL over every PHI value and reports
  success — live on **three of the five** real classified fields, the nullable ones. The one-argument
  form raises instead, and is itself nondeterministic by connection history (`''` after use-and-reset,
  where *pgcrypto* becomes the thing that raises), so `isRaisingKeyRef` + a named refusal for an empty
  resolved key close both arms. It is five fields across **two** packs, not one: ADR-0337's write-up
  named only healthcare, and `erp-government`'s `Citizen.national_id` is `regulated`.
  **A classified field is encrypted or the deployment refuses to serve it** — `decidePhiStorage` is a
  total map over five verdicts with `mayServe` read off `PHI_VERDICT_MAY_SERVE`, so `--store pg` and
  `--store memory` refuse a classified manifest at boot unless `--allow-plaintext-phi` says otherwise,
  and `--store pg-columns` with no secret refuses at boot rather than 500ing on page 1 (ADR-0334's
  `duration` conversion). Refusing by default **inverts** ADR-0334's reasoning for `--tenant-status-gate`
  being opt-in — there, on-by-default would refuse requests of a deployment that works today; here
  nothing served PHI correctly today, so the refusal breaks nothing that worked. The shipped compose is
  `erp-core`, which declares no `phi`/`regulated` field (it has 10 `pii` and 11 `commercial_sensitive` ones, which are classified but not encrypt-at-rest).
  What remains, in order: **(1)** ~~the **DEK envelope** and with it crypto-shredding~~ — **closed by
  ADR-0347**, which also found that this entry's own statement of the gain was **false**: destroying a
  wrapped DEK does *not* make PHI "unrecoverable including from backups", because the wrapped key and
  the ciphertext live in one database and one backup holds both. What it buys is a **bounded deletion
  horizon**, and only for a `random` key. See the next entry. **(2)** rotation has **no executor**
  — `KeyRotationMigrator` has had two callers in `crypto-pg`'s `data-key-rekey.ts` since ADR-0349
  (this file said "still callerless" for two increments after the ADR that wired it), and the
  `generation` parameter is still exposed by no flag or env var because
  exposed by no flag or env var: a deployment that bumped it would make every existing ciphertext
  undecryptable with no way back. **(3)** ~~`unique: true` is unenforced on the column store~~ —
  **closed by ADR-0360**, which plumbed it and took this entry's own instruction: the encrypted case
  is **withheld by name** rather than emitted, because `pgp_sym_encrypt` is non-deterministic and two
  rows with the same plaintext under a UNIQUE `bytea` both insert (verified again). One correction to
  what this entry said — the two members are in **different packs** (`Patient.mrn` in healthcare,
  `Citizen.national_id` in government), so no single deployment holds both and the per-deployment
  withheld count on `pg-columns` is at most 1. ADR-0070's Q4 noticed encrypted columns cannot be
  *searched* and nobody noticed they cannot be *unique*; both are now said at boot. **(4)**
  `packages/security`'s `AT_REST_ALGORITHMS` offers AES and ChaCha AEADs and the mechanism is OpenPGP
  CFB+MDC, which is none of them, and nothing reads the enum. **(5)** no per-tenant BYOK, which
  `KEY_MANAGEMENT_KINDS`' `customer-managed-byok` models; `ColumnEncryptionKeySource` is the seam.
  **(6)** ~~an encrypted field is dropped from `?sort` and filters **silently**~~ — **the silence is
  closed by ADR-0359** and the *capability* gap is not. A filter and a collapsed `?q` are now a 400
  naming the field, the reason and three remedies, and the boot line names every (entity, field)
  pair; `?sort` is still served in an order the caller did not ask for, deliberately, on one stated
  rule — *a surface whose drop changes WHICH rows come back is refused; one whose drop changes only
  their ORDER is reported*. ADR-0091's decision survives as a limitation rather than as a wrong
  answer. What would retire it is decrypt-and-compare (`pgp_sym_decrypt(col, key) = $1`), correct
  and unindexed, so an `eq` on a unique MRN is a sequential scan with a decrypt per row — the cliff
  ADR-0345 refused, worth it for `eq` on a unique field and not for `contains`.
- **The column key can be a stored, wrapped data key, and what that is actually worth** (ADR-0347
  closed the entry above's Q1 and **corrected the claim it was asking for**). ADR-0338 and this file
  recorded the envelope's gain as making a tenant's PHI *"unrecoverable including from backups"*;
  that is false, because the wrapped key and the ciphertext it protects live in **one database**, so
  one backup holds both and restoring it restores the pair. What the envelope buys is a **bounded
  deletion horizon** — afterwards recoverable only from backups predating the destruction, and only
  until those expire, so the bound is the deployment's backup retention — where a derived key gives
  **no horizon at all**, since it exists wherever `COLUMN_ENCRYPTION_SECRET` does. That difference
  is the whole value and is enough to ship for; claiming more is ADR-0337's falsely-true control in
  a new place.
  And it holds **only for a key that is random**, which is what shaped the design: a deployment
  switching modes has tenants already holding ciphertext under the derived key and **nothing records
  which key wrote a column**, so the only safe migration is to *seed* their data key with the bytes
  of the key that ciphertext is already under — and a seeded key stays recomputable from the
  deployment secret. So `provenance` is on the row, shreddability answers over `(mode, provenance)`,
  and `--column-key-mode` is default-`derived` and opt-in.
  What remains, in order: **(1)** ~~the **rekey executor**~~ — **closed by ADR-0349**, which also
  found that `KeyRotationMigrator`'s "decision about a migration that halts partway" was the wrong
  question: a half-rotated tenant is **unserveable either way**, since one key is resolved per
  tenant per operation, so a resume ledger would make an unrecoverable state resumable in principle
  and still unreadable in fact. Per-*tenant* scoping makes one transaction the answer where
  per-schema did not. See the entry after next. **(2)** a **KMS-held KEK**, which
  is what would support ADR-0338's original claim — revoking a key held outside the cluster bounds
  recovery from *every* backup, where destroying an in-database row does not. `kek_generation` is on
  the row for it, so it is a second generation rather than a rewrite, and
  `KEY_MANAGEMENT_KINDS.customer-managed-byok` models the per-tenant form. **(3)** nothing reads a
  **real** provenance: `shreddabilityOf` is called with the mode alone, so the boot line cannot say
  whether a given tenant is shreddable and an operator has no way to ask. A platform route or a CLI
  subcommand would, and it is the surface that makes (1) actionable. **(4)**
  `PostgresDataKeyStore.destroy` has **no caller**, and the reason given here was **wrong twice**:
  the erasure deletes the row **by name** (`eraseSharedTablesWithin` reaches it, and the
  meta-schema's own comment says so), and the `ON DELETE CASCADE` beside it has **never fired and
  cannot**, because nothing in the workspace ever deletes a `meta.tenants` row — retirement is
  `UPDATE … SET status`. So the cascade is not a second fence. The method is still reachable by
  nothing, which is `pg-unreachable-stores.ts`'s question asked of a *method*, which that rule does
  not ask. **(5)** the key-source cache's eviction, where the claim here was **false and cited an
  ADR that rejected its own premise**: it said a destruction happens inside the pipeline that
  retires the tenant row "in the same transaction (ADR-0319, ADR-0320)", and ADR-0320 has a section
  headed *"The tenant row is retired **after** the pipeline commits"* listing that option as
  **rejected** — and both legs were conditional anyway, since the retirement runs in a `try`/`catch`
  reporting `tenantRetired: false` on a **200** and `--tenant-status-gate` is opt-in and off by
  default. ADR-0349 **bounds** it with `--column-key-ttl-ms` (1000..300000, default 30s, the tenant
  status directory's figure) rather than closing it: a rekey changes the key out of process, so
  until the entry lapses a serving process's **reads** raise `Wrong key or corrupt data` — loud, and
  never a wrong answer — while its **writes** would store new values under the previous key and
  split the tenant's columns across two keys with nothing recording which. Closing it needs the
  serving fleet *told*.
  **(6)** no `key_generation` column on the entity tables, so a tenant's encrypted columns must all
  sit under one key and a partial rekey is unsafe — it is what would make a mis-seeded tenant
  recoverable, and it is a kernel change, since it reaches `emitEntityTableDdl`'s column plan and the
  encrypting-view trigger path where the key ref is baked into a plpgsql function body.
- **A seeded tenant can be moved to a random key, and what is left of it** (ADR-0349 closed
  ADR-0347's Q1). The class is **an executor whose only atomic unit was the wrong one**:
  `KeyRotationMigrator` rotates a whole *schema*, one *column* per transaction, and for a per-tenant
  key both axes are wrong. `reencryptColumnSql` emitted `WHERE col IS NOT NULL` and
  `ReencryptColumnInput` had **no field that could carry a predicate**, so under a boot manifest —
  where every tenant's encrypted columns share one schema with a `tenant_id` column — a rekey for
  one tenant would re-encrypt every other tenant's PHI under this tenant's key pair, and in envelope
  mode could not get that far, since `pgp_sym_decrypt` raises on the first foreign row. And the
  per-column split bought nothing: a resume ledger makes a half-applied rotation *resumable* while
  `ColumnEncryptionKeySource` resolves exactly one key per tenant per operation, so a half-rotated
  tenant is unreadable either way. `ReencryptScope` is **required** and discriminated
  (`{kind:"tenant"}` / `{kind:"every_row", because}`), and all three statements the rekey issues are
  built from **one** `scopeWhere`, so the counts it compares cannot be about different row sets.
  `rekeyTenant` lives in `crypto-pg` — the one package depending on both `kernel-pg`'s emitter and
  `@crossengin/crypto`'s wrap — and is **one transaction**: context, per-tenant advisory lock, load
  generation G, mint a **random** DEK, refuse if the two key *values* match, set both key GUCs as
  bound `set_config` parameters, rotate, **confirm every rewritten row reads back under the new
  key**, write G+1 as `random`, delete every earlier generation. Nothing is caught: a returned
  result means the ciphertext and the key row agree, a throw means neither moved.
  `rls_would_confine_this_session` **stays**, and its reason is the subtle part — for a
  tenant-scoped rotation the confinement *is* the scope, which is true of the **rows** and false of
  the **count**, because a confined session reports `0 rows re-encrypted`, byte-identical to "this
  tenant holds no ciphertext", and the rekey's next act is to delete the generation those rows are
  under. So the tenant predicate is **not a second belt beside RLS — it is the only confinement**.
  Verified live as a non-owner: the fence refuses a role that owns nothing; the write-status gate
  refuses an `active` tenant; suspended, the rekey reports `generation 1 → 2, provenance
  seeded_from_derived → random` with 1 row confirmed readable under the new key; tenant A's
  ciphertext then raises `Wrong key or corrupt data` under the derived key it was written with while
  **tenant B's still returns its value** — an exact complement; and destroying A's row makes their
  PHI unreadable **with `COLUMN_ENCRYPTION_SECRET` in hand**, which is what ADR-0347 shipped the
  mechanism for and could not show.
  Three facts the live run produced that nothing offline could. **(a)**
  `--column-key-mode envelope` **cannot provision a key for a tenant with no `meta.tenants` row**:
  `tenant_data_keys_tenant_id_fkey` references `meta.tenants(id)`, so such a deployment accepts the
  boot, logs `column key mode: envelope`, and answers every PHI read and write with that constraint
  violation — as an HTTP **504**, a retryable status for a permanent fault — and `--api-key` names
  an arbitrary UUID, which ADR-0334's survey established has no row in any dev deployment. A boot
  survey in `surveyUserFkReadiness`' shape reports it, three-valued, because a count of 0 means
  either absent or unreadable. **(b)** a `--store pg-columns` deployment's serving role **must own
  its entity tables**, since `ensureSchema` runs on every boot and its `ALTER` and policy statements
  are owner-only — so on the column store RLS is never the confinement *for that role* and the
  `tenant_id` predicates are, which is this increment's conclusion reached from the other end.
  **(c)** `meta.tenants.schema_name` is UNIQUE, so two tenants cannot share one.
  What remains: **(1)** the stale-key window is bounded and not closed — see the envelope entry's
  Q5. **(2)** `--column-key-mode derived` has no rotation at all, and the HKDF generation is still
  exposed by no flag, now for a better reason: a rekey mints a new **data key** generation, so the
  derived seed is only ever the default. **(3)** no `key_generation` column on the entity tables, so
  a partial rekey stays unsafe and the single transaction is the whole defence. **(4)** the rekey is
  a CLI subcommand and not a route, so nothing *schedules* one — a deployment wanting every seeded
  tenant migrated runs it per tenant and reads `shreddabilityOf` to find them.
- **The boot-schema erasure, and what is left of it** (ADR-0350 closed the Article 17 gap on
  `--store pg-columns`). What remains, in order: **(1)** ~~ADR-0329's v2 distinction is closed in the
  *mechanism* and open in the *proof*~~ — **closed by ADR-0351**, which signed a record-storage
  declaration as `crossengin.tombstone.content.v4` and did it in the increment after, not the one
  "the migration Option A was rejected for": the deciding objection to a seventh subsystem was never
  the migration but that the disposition would be a **hand-typed declaration of a derivable fact**,
  since `--deletion-capabilities` is a file an operator writes and `--store` already is the
  deployment's declaration. See the next entry. **(2)**
  statutory retention over a tenant's **own** records is still inexpressible — both retention sets
  are constants over `META_TABLES`, so the boot group is subject to neither, and the boot line says
  so. A per-entity retention declaration is the shape, and ADR-0330's rule says it must not be
  caller-supplied. **(3)** a deployment that served `pg-columns` and now serves `pg` passes `[]`, so
  its leftover entity tables are censused by nothing; closing that needs the boot schema declared
  independently of the targets, which is a deployment declaration rather than something derivable
  from the manifest. **(4)** a relaxed `cascade` edge undercounts the proof's `rowCount` — vacuous
  on all seven packs, whose only relaxations are `set_null`, and closing it needs the child's rows
  counted before the parent's statement. **(5)** a tenant whose per-tenant DDL application was
  *refused* is served from the JSONB fallback (ADR-0314), and nothing says which tenants are in that
  state at deletion time. **(6)** `--schema` still feeds two stores with two different defaults
  (`meta` for JSONB, `public` for columns); `target_collides_with_catalog` refuses the dangerous
  case, and the flag still means two things.
- **A stored proof says where the tenant's records were, and what is left of it** (ADR-0351 closed
  ADR-0350's Q1). `crossengin.tombstone.content.v4` signs `{model, schema, relationCount}`, which
  separates all three cases v3 collapsed; the count is **derived** from the deletion's own target
  list; the three coverage lists became one total map `PROOF_VERSION_COVERAGE`, because adding
  `"v4"` to the enum and nothing else typechecked, passed every test, and made a v4 record
  structurally a **v1** record — a silent regression of both v2 and v3, past a test that documented
  the hazard in its own comment and asserted only that the predicates return a boolean. Live, two
  deployments whose `scope.tables` is the identical `['meta.operate_tenant_settings']` now compose
  `f18eb91d…` (`typed_tables/public/51`) and `ee0f7594…` (`document_rows/null/0`), both verifying,
  where under v3 both were `d8cb6d10…` — the digest ADR-0350's own pre-fix run stored.
  What remains, in order: **(1)** full **coverage** is still outside the bytes for *both* halves —
  the proof says how many typed relations exist, not which relations were examined, and that is
  Option C's shape applying equally to the catalogued half. **(2)** v1, v2 and v3 records on file are
  permanently unprotected in this respect, exactly as they are for the retention claim: nothing can
  retrofit them and re-signing them under v4 would forge the one alarm the chain cannot raise.
  **(3)** `tombstoneMatchesAttestations` cannot check the declaration against evidence, because there
  is none — a cross-check would need the erasure to report its examined count as a *measurement*,
  which is the thing Option B's reasoning refuses, so the v4 digest is the declaration's only
  detector. **(4)** `relationCount` can disagree with `model` in the one direction the derivation
  cannot prevent: a `document_rows` declaration beside a non-empty target list derives a non-zero
  count, so `assembleTombstone` refuses `record_storage_invalid` and the pipeline aborts — correct,
  and a boot-time check would be better than a deletion-time one, since the mismatch is decided by
  `--store` and the manifest. **(5)** ~~the probe reads **one** CHECK on one column~~ — **closed by
  ADR-0352**, which built the general survey and **deleted** that probe rather than keeping it
  beside one. See the next entry. **(6)** `no_durable_store` is unreachable from a stored proof,
  because the deletion routes do not mount on `--store memory` — it exists to keep the map total,
  and is pinned rather than served.
- **The live catalog's admission of what this binary emits is surveyed, and what is left of it**
  (ADR-0352 closed ADR-0351's Q5). The class: ADR-0330 cannot tell a widening CHECK from a narrowing
  one *from the expressions*, so every enum value the catalog adds **was** refused `23514` on every
  already-applied deployment until an operator ran an `ALTER` by hand — found by hand three times
  (ADR-0300, ADR-0334, ADR-0351), detected here, and **planned since ADR-0363**, which asks the rows
  rather than the expressions. Over **777** emitted column CHECKs of which **287** are value sets,
  **263** bounded ranges and **213** patterns. It evaluates the live predicate rather than reading
  it, casts through an allow-list because a modifier-bearing cast truncates, fences the evaluations
  with `SET TRANSACTION READ ONLY` because a CHECK can call a volatile function, reports rather than
  refuses, and proves a widening safe against the rows present while refusing that claim on a
  confined session. 269 ms at boot, verified live as a non-owner.
  What remains, in order: **(1)** ~~the **contract → catalog** half is unbuilt~~ — **closed by
  ADR-0353**, which also found that **both** of the "two real ones" recorded here were *not* defects,
  and for two different reasons the census behind them could not see. `REPORT_ENGINES`' `auto` is a
  report *definition's* engine preference and `meta.report_runs.engine`'s domain is
  `ReportRunRecordSchema.engine`, an inline `z.enum` of exactly the two the column admits;
  `DIGEST_FREQUENCIES`' `immediate`/`never` are refused by `DIGEST_WINDOW_MINUTES`,
  `buildDigestBatch`, `delivery-drain` **and** `DigestBatchSchema`'s `superRefine`. The measurement
  quoted here was also off — 281 of 287 match exactly once inline `z.enum`s, exported `z.enum`
  constants, aliases, module-private constants and import-following are read, and **zero** columns
  match more than one domain once a constant is preferred over a reference to it. The real finding is
  `META_DEPLOYMENTS`; see *The table that could not accept its own record*. **(2)** ~~a widening can
  now be **proved** safe, so `planSchemaReconciliation` could plan it~~ — **closed by ADR-0363**,
  though not with `proveWideningSafe`: *no current row violates this* is weaker than *this is a
  widening*, so the gate is `predicate_implied_by` and that function is the diagnostic beside it.
  Both instructions this entry gave are in (the guard re-checks inside the statement's own
  transaction, and it refuses on a confined session), plus two things neither this entry nor P2
  item 3 had: the proxy had a **second copy in the planner**, and the remedy the class hands over
  destroyed a constraint when pasted. **(3)** `meta.job_runs.status` is reported and not
  refused, and whether that is right depends on `--workflow-workers` being mounted — which `node.ts`
  knows and the survey does not; a second `admissionBlocks` caller there would close it, and the
  question applies to every surface writing a value-set column. **(4)** 11 strict `> N` bounds and
  213 patterns yield no candidate and read `not_probeable` with `diffColumnChecks` named as their
  cover; a generator for an integer `> N` would close the first group cheaply. **(5)**
  `sessionWouldBeConfined` converged **two of eight** call sites — the other six infer confinement
  from ownership without reading `relforcerowsecurity`, which is mechanical and latent until
  something sets that flag. **(6)** the headline count does not separate a proof from a probe, so
  `540 admitted` reads stronger than it is for the 253 range checks. **(7)** `admissionRemedy` reuses
  the live constraint name in its `ADD`, which is right for SQL an operator pastes and perpetuates a
  hand-rename outside Postgres's naming family; `column-check.ts` solves name prediction for the
  reconciler and this deliberately does not use it.
- **The table that could not accept its own record, and what is left of it** (ADR-0353 closed
  ADR-0352's Q1). `META_DEPLOYMENTS`' four CHECKs were authored independently of
  `DeploymentRecordSchema`, the only record that table stores, so four of its seven enum fields
  emitted values the table refused — `target` *entirely disjoint*, `app_kind` differing on 6 of 9 by
  hyphen-versus-underscore, `environment` and `strategy` by one each way — and because none of the
  four is a subset or a superset, every nesting test was blind. Fixed to what `@crossengin/deploy`
  declares, and fenced by `pg-value-set-domains.ts`' 287 declarations. Verified live as a non-owner:
  the same `INSERT` is refused `23514` four times on the old CHECKs and lands on the new ones,
  `surveyCheckAdmission` reports `refuses` on exactly those four in 351 ms over 777 checks, and
  `crossengin-pg apply` plans and executes all four as `replace_column_check [guarded]` with the
  re-plan clean — **no manual SQL**, because a CHECK refusing everything its only writer emits cannot
  have let a row in, so ADR-0330's emptiness guard always holds.
  What remains, in order: **(1)** ~~nothing checks that a ref names the domain the store actually
  **binds**~~ — **closed by ADR-0354**, which also found the stated reason wrong: the
  parameter-to-field link is **not** invisible to a scan, and reading it is what the whole increment
  turned on. See the next entry. **(2)**
  **five spellings of one six-member data classification** (`DATA_CLASSES` in `dr`, `jobs` and
  `ml-training`, `DATA_CLASSIFICATIONS` in `types` and `data-lineage`) and three of one four-member
  environment (`deploy`, `feature-flags`, `finops`, the last with five). ADR-0340 found seven
  spellings of the ABAC concept and left them; this is the same shape, now measured, with four
  catalogued columns pointing at one of the five by declaration. **(3)** a table-level `constraints`
  CHECK is not read — all 288 are column-level today, so a value set written as a table constraint
  would be undeclared *and invisible* rather than undeclared and reported. **(4)**
  `auditColumnDefaults` reads a literal default only; `now()` and a cast are out of scope because
  evaluating them means evaluating SQL, which is `check-admission.ts`'s job, and no value-set column
  carries a non-literal default today. **(5)** `catalog_exceeds_contract` makes `mirrors` stricter
  than safety requires — a catalog deliberately admitting more than the contract emits must narrow or
  gain a fourth link kind, and nothing is in that position, which is why there is no `widens`.
  **(6)** `packages/deploy` still has zero importers (ADR-0336), so `meta.deployments` is writerless
  and this fix is latent; which of that package's two flag models is real is still the product
  decision ADR-0336 declined.
- **A declaration is checked against the symbol its writer binds, and what is left of it** (ADR-0354
  closed ADR-0353's Q1). The class is **a declaration adjudicated by reading, and a writer that
  reads differently**: `mirrors` compares members, so two constants spelling one domain are
  interchangeable to it. `pg-column-bindings.ts` derives the symbol — `VALUES`-positional, `$n` →
  `params[n-1]` out of the enclosing `query(…)` call, the receiver's type → the domain over four
  idioms — and compares it, canonicalising `XSchema.field` and a re-export alias so the two legal
  spellings agree. **66 of 287** columns checked (83 bindings), **164** unreachable because their
  table has no writer.
  The one finding: `MANIFEST_PROPOSAL_SOURCES` was module-private in the module that owns the table
  while `AI_MANIFEST_SOURCES` was exported elsewhere, so the writer bound one and the declaration
  could only name the other. Converged, both pairs. Verified live as a non-owner on PG 16.13: both
  values written through the real `PostgresTenantManifestStore`, read back in tenant context, a third
  refused `23514 operate_tenant_manifests_source_check`, the boot survey reporting
  `catalog admission: admits — 540 admitted, 0 refusing`, and `GET /v1/ai/manifests` returning 200
  with both `source` values through the real route.
  What remains, in order: **(1)** **15 bindings whose receiver the module annotates nowhere**
  (`p.status` in an arrow, `att.kind` from a destructure) are unresolvable without local inference,
  which is the compiler-API option ADR-0337 measured and refused, now for the second time.
  **(2)** ~~the comparison is against the **symbol** and nothing compares it against the parameter
  *position*~~ — **closed by ADR-0355**, which also found that the threshold this entry asked to
  have decided cannot be a similarity score at all: every cutoff is *unsound* and not merely
  arbitrary, since a transposition is precisely a pair of similar names. The two examples it offered
  were also both wrong about this repo — `tenant_id ← scope` and `created_by ← actor` appear
  nowhere; **682 of 764** bindings agree exactly and the real divergences are 28, each now carrying
  what was read to clear it. See the next entry. **(3)** each of the 164 unreachable columns becomes checkable the
  moment a store lands and nothing says so at the time — the inverse of `table_declared_storeless`.
  **(4)** `UNCONSTRAINED_BINDINGS` describes a real weakness and the rule only reports it: typing
  `DispatchInput`'s four `string` fields against `@crossengin/notifications` is the fix, and it is a
  decision about whether `apps/operate-server`'s own persistence shape may depend on that contract.
  **(5)** `collectStoreTypes` and `collectWorkspaceDomains` both walk every source; one
  `workspace-symbol-index.ts`, as `workspace-sql-scan.ts` is for SQL, would halve that and remove the
  need for the cross-check. **(6)** a `DO UPDATE SET` assignment that is neither `$n` nor
  `EXCLUDED.col` — `status = CASE WHEN …` in `digest-store.ts` — is a value the *database* decides
  from the row, a third provenance beside a parameter and a literal, reported as neither.
- **A value bound into the wrong column of the right type is a failure, and what is left of it**
  (ADR-0355 closed ADR-0354's Q2). `pg-binding-names.ts` is the eighth rule: **682 of 764** bindings
  agree exactly, **25** are explained by two derivations whose tightness is re-asked every run,
  **28** declarations carry what was read to clear them, 25 are literals and **0** are uncatalogued.
  Two findings cost the two dangerous declarations something checkable — a sibling collision's note
  must name the sibling, and `column_overloaded` requires a catalog source comment naming the
  column — and `transposed_pair` is resolvable by no declaration. Verified live as a non-owner on
  PG 16.13: 964/964 statements applied with a clean re-plan (so the two new source comments emit no
  SQL), and `enqueueScheduledJobs` at a 09:17 clock against `0 3 * * *` wrote
  `started_at = 03:00:00.000Z` — the cron tick, not `now`, six hours before any handler — which
  `claimDueJobs` then claimed, and did not once it was pushed forward.
  What remains, in order: **(1)** ~~the rule covers the **write** path only~~ — **closed by
  ADR-0356**, whose `pg-record-reads.ts` asks the same question of a row → record mapping, and which
  found that the live member this open end named is genuinely a divergence rather than a defect:
  `ClaimedJob.jobId` reads `run_id` and every consumer uses it as a run id, so the round trip closes
  on the **value** and not on the name. See the next entry. **(2)** `meta.job_runs` wants a `due_at`/`visible_at` column,
  which would retire the one `column_overloaded` member; it changes the claim predicate, the
  `ORDER BY`, `idx_job_runs_due` and the retry path of a fleet `--workflow-workers` mounts live, and
  leaves `started_at` with nothing to hold since no code records when a handler began — a subsystem
  change wearing a column's clothes, declared with its evidence in the meantime (ADR-0307's
  treatment). **(3)** nothing compares the bound property against the column's *meaning*, only its
  name, so a store writing `record.kind` into `status` passes if the property happens to be called
  `status`. **(4)** `BINDING_NAME_DIVERGENCES` is the first list in that directory whose entries are
  **judgements about correctness** rather than structural facts, and whether a declared reason is
  true is unverifiable by machine — as it is for all seven siblings, but here the reasons are the
  whole content. **(5)** the reverse transform is lossy on four catalogued names
  (`minimum_k_anonymity` ×3, `request_count_30d`), asserted **by name** rather than fixed, because a
  general digit rule would turn `fingerprintSha256` into `fingerprint_sha_256` and break a column
  that exists; the forward transform is total and is what decides agreement, and the reverse only
  *finds* a sibling, where a miss is permissive. **(6)** `CatalogColumn` has gained five fields in
  three increments (`check`, `defaultExpression`, `type`, `references`, `unique`, `comment`) and now
  carries most of a `ColumnDefinition`; whether `parseCatalogSource` wants extracting from the
  coverage rule it lives in is undecided, and the reason it has not been is the one that keeps it
  there — one parser is what stops two rules disagreeing about the catalog.
- **A record field read from the wrong column is a failure too, and what is left of it** (ADR-0356
  closed ADR-0355's Q1). `pg-record-reads.ts` is the ninth rule and the eighth read in the other
  direction: **305 of 336** reads agree exactly, 7 derive through the *same imported*
  `DERIVATION_RULES`, **23** are declared across six kinds settled from 35 adjudications, 1 is an
  alias, 2 are read from several columns and compared to none, **0** are unexplained. The anchor is
  the catalog rather than the `SELECT` (measured: zero collision between a column access and any
  other `snake_case` property access in the workspace) and the table comes from the declared row
  interface by containment, 26 of 40 resolving and none ambiguous. Verified live as a non-owner on
  PG 16.13: `claimed.jobId` is a UUID resolving 1 row by `WHERE run_id = $1`,
  `claimed.jobDefinitionId` is `close-period`, and passing the second where the first belongs is
  refused `22P02` — so the declared types catch the swap the names do not.
  What remains, in order: **(1)** `attestation.attestedAt` has a producer and **no enforcement** —
  `AccessReviewDecisionSchema.superRefine` fixes `decidedByUserId === attestation.attestedByUserId`
  and says nothing about `attestedAt`, while `decision-store.ts` binds neither it nor
  `attestationPhrase` (23 columns, 23 params) and no construction site in the workspace varies the
  two, so a refinement pinning it to `decidedAt` would break nothing today and is the cheapest
  moment it will ever have. **(2)** `ClaimedJob.jobId` could simply be renamed `runId`: it is the
  sole holdout against its own package's vocabulary, `jobDefinitionId` beside it has **no consumer
  at all**, and nothing serializes the handle — a mechanical rename across two interfaces and their
  consumers, which would retire the one `field_overloaded` member. **(3)** 21 reads carry no row
  type and 2 carry one no interface was found for, so 23 of 336 reach no derivation; closing that is
  ADR-0337's refused compiler-API answer for the third time. 14 of the 40 interfaces pin no table
  and **all 14 carry two or fewer catalogued columns** — seven are `pg_catalog` introspection rows —
  so they sit *below* `row_table_ambiguous`' three-column floor rather than tripping it, which means
  a row that lost columns until it fell under that floor would be dropped silently. **(4)** nothing
  compares a field against the column's *meaning*, only its name —
  the same gap as the write path's, inherited with the vocabulary. **(5)** `RECORD_READ_DIVERGENCES`
  is the **second** list in that directory whose entries are judgements about correctness rather
  than structural facts, so whether a declared reason is true is unverifiable by machine. **(6)**
  `stripComments` is shared by all ten rules and was wrong about regex literals for four
  increments; nothing fences the shared scanner against its own output, and the symptom surfaced two
  files away in a sibling rule.

- **A reader of an entity's fields asks over the resolution, and what is left of it** (ADR-0361
  closed the register's own P2 item 14, correcting all three of its claims). The class is **a reader
  whose aperture is narrower than the writer's**, and the signature made the narrow read the easy
  one: `entityClassifiedFields(entity)` read `entity.fields`, which is not the set the served table
  has, so five call sites fabricated an entity to widen it and three did not. It takes a **field
  list** now, so there is no entity-shaped call to get wrong, and `resolvedClassifiedFields` in
  `kernel/ddl` is the one answer; the gateway gets a **required** resolver because it cannot depend on
  kernel, and `compile.ts` hands both halves of ADR-0329 **one index** rather than the same narrow
  function twice. Verified live on both stores as a non-owner: the trait-contributed `pii` field and
  the entity-declared control are now an **exact complement** in every direction.
  What remains, in order: **(1)** `manifest-diff.ts`'s `classificationLayer` is `fails_open` **on the
  path a reviewer approves from** — a classification change on a trait field is absent from the
  `ManifestDiffView`, so weakening `phi` → `internal` is approved unseen — and `assessManifestRisk`
  reads raw beside it, answering `level: "low", findings: [], sensitiveFields: 0` for a manifest whose
  only PHI is trait-carried where the entity spelling answers `level: "high"`. **The Architect's
  approval gate is on the narrow side of the split**, which is the sharpest remaining member and
  arguably its own increment. **(2)** `refusal.ts`'s `detectEncryptionWeakening` gates the
  `weaken_encryption_below_pack_minimum` hard refusal and reads raw, and `classifyManifestEditRefusal`
  has no caller outside its own test — so wiring that gate must widen the read in the same change or
  it ships the hole. **(3)** `ui-schema.ts` is the widest `incomplete` member: no trait field reaches
  the web client at all, so `created_at`/`updated_at` are absent from every list, record and form
  view on all **68** `auditable` entities in every deployment, and all 25 of `operate-web`'s own reads
  sit downstream of it. **(4)** `validation.ts`, `defaults.ts`, `sequences.ts` and
  `settings-defaults.ts` read raw, so a trait field is unvalidated, gets no literal default and no
  allocator — each a behaviour change with its own argument (`auditable.created_at` is `required`
  with a `now()` default, so pulling trait fields into the validation plans could make a create demand
  a field the server fills), and **no member on any shipped pack**: the only trait any of the seven
  declares is `auditable`, whose four fields are `datetime`/`uuid` and server-stamped. **(5)** the
  audit trail keeps withholding a trait field, which is a capability decision about what an audit
  payload shows rather than a defect — and must be fixed in **both halves or neither**, since widening
  the key list alone makes every trait field a described, unclassified one and converts a fail-closed
  omission into a fail-open disclosure. **(6)** `@crossengin/auth`'s `ClassifiedField.classification`
  is **optional** and the optionality is load-bearing (it is how `maskWrite` expresses `explicit_only`
  by stripping the classification), so a deployment-supplied resolver may legally return `{name}` with
  none and `planClassifiedRead` then *serves* that field — fail-open, reachable only from a
  hand-written resolver, and the fix is a second type rather than a tightening. **(7)** the whole class
  is **one wiring step from non-zero**: `packages/compliance`'s four packs declare custom traits and
  `resolveCompliancePacks` merges `contributions.traits` into `result.traits`, so wiring the
  compliance-pack resolver is precisely what puts the first custom trait into a shipped manifest.
- **Field-level write authorization exists now, and what is left of it** (ADR-0339 closed ADR-0338's
  Q7). The asymmetry it found was total and in the dangerous direction: of the **46**
  sensitive-classified fields across the seven packs, **39 were unreadable by every role in every
  deployment** and **all 46 were writable by anybody** with entity `update`. The read side was closed by
  an empty policy — `policyForEntity` had no producer in `operate-server`, so `privilegedForClass`
  answered false for everyone and only the 7 fields with an explicit per-field `read` grant came
  back; the write side was open because `validateClassifiedWriteMask` had no caller. **39 is the
  read figure and this entry used to repeat it for the write side**, which understated it by the
  7 fields carrying an explicit `update` grant: a declaration the mask never consulted bought
  them nothing, and that is why ADR-0339's own headline example — `case_worker` changing
  `Citizen.national_id` against `update: ["gov_admin"]` — is a field *outside* the 39. Neither had a
  symptom anybody reported, because total redaction looks exactly like classification working.
  Verified live as a non-owner: `case_worker` changed `Citizen.national_id` against the pack's own
  `update: ["gov_admin"]`, and `front_desk` **blind-overwrote** `Patient.mrn` — replaced a medical
  record identifier it cannot read before or after, in the column ADR-0338 had just made ciphertext.
  Three parts, one of them a new default. **(1)** An explicitly declared per-field `update` grant is
  enforced **always**, no flag: 7 fields, each deliberate — and the clause this entry used to carry,
  *"and it cannot make anything uncreatable"*, is **false about three of the seven** (ADR-0348).
  A `required` classified field whose write grant is narrower than its entity's `create` grant makes
  the entity uncreatable by a role holding that grant, and `Citizen.national_id`,
  `WorkOrder.cost_estimate` and `PerishableLot.cost_per_unit` were all in that shape: a case worker
  could not register a citizen, a foreman could not raise a work order, a receiving clerk could not
  receive a lot. All three are fixed, each by adding only a `create` arm.
  **(2)** `--sensitive-field-role` / `--sensitive-field-class <class>=<role>` declare who is
  privileged per class for entity routes, with `--audit-read-sensitive-*`'s grammar copied byte for
  byte and feeding **one** policy to the redaction registry *and* the write mask — so
  `privilegedForClass` finally keeps the property its own comment claims. Separate flags from the
  audit pair, because reading the trail is reading every tenant's conduct (ADR-0313) and one
  declaration spanning both would hand a deployment's clinicians the platform's audit log.
  **(3)** `--classified-write-mask` adds the classification default and is **opt-in**, because with
  no declaration all 46 are unwritable and **12 are `required: true`**, so `Employee`, `Lead`,
  `Opportunity`, `FixedAsset`, `Patient`, `Student` and `Permit` become uncreatable by every role.
  It **refuses at boot** naming them — ADR-0334's conversion a third time, and the refusal's list
  *is* the migration guide, which is why there is no opt-out past it.
  The mask runs in the **handler**, after entity RBAC and before schema validation, and the gateway
  was refused on measured grounds rather than unavailability: `create` injects settings, literal and
  sequence defaults *after* dispatch, so a pre-handler mask would mask the client's patch and not
  the write; the redaction registry is keyed by response-carrying operationId while a write mask is
  keyed by entity; and the handler already holds four of the five arguments. A 403 precedes the 422,
  so a field you may not write is not answered with a list of which other fields are required.
  What remains: **(1)** ~~the **39 unauthored grants**~~ — **closed by ADR-0348**, which also found
  that they could not be authored as this entry described: one role list answered both write
  moments, so narrowing who may *change* a required field necessarily narrowed who may *create* the
  record. The fix is a third `create` arm plus three kernel coherence rules, and then the 39. See
  the entry after next. **(2)** `computeFieldRedaction`,
  the classification-unaware originals, still have no callers and are probably deletable —
  a mechanical increment, and `pg-unreachable-stores.ts` does not fence *functions* (ADR-0337
  measured why). **(3)** ~~an ABAC-qualified grant grants unconditionally~~ — **closed by
  ADR-0340**, which also corrected two of the three things this entry said: the hole was in **five**
  functions and not one, and the attribute *source* does exist. See the next entry. **(4)** the mask
  answers "may this principal write this field", never "this value", which is the write guards'
  question. **(5)** the survey is boot-time, so a *per-tenant* manifest activated later is not
  surveyed; that check belongs beside ADR-0334's `unservable_field_type` in
  `applyTenantManifestSchema` — though the ABAC obligation check *is* covered per tenant, because
  ADR-0340 put it in `buildOperateHttpServer`.
- **A field grant says who may set a value and who may change it, and what is left of it**
  (ADR-0348 closed ADR-0339's Q1). The class is **one role list consulted at two moments**:
  `FieldPermission` was `{read?, update?}` and the write mask asks the same list on a create and on
  an update. Three consequences, all live. The shipped deployment's classified fields were
  **write-only** — measured through real HTTP on `erp-core`, `ap_clerk` POSTed a Vendor with
  `tax_id` and `contact_email`, the row holds both, and neither the create response nor
  `GET /v1/vendors` returns either **to the credential that just wrote them**, across all 21 of that
  pack's classified fields. **Set once at registration, never changed** was inexpressible, which is
  why ADR-0339 found `front_desk` blind-overwriting `Patient.mrn` and could only have fixed it by
  stopping the desk registering patients. And **three of its seven "deliberate" grants** made their
  entity uncreatable (see the entry above). The fix: `create?` on the arm (absent ⇒ falls back to
  `update`, so no shipped grant changed meaning), `field_create` in the ABAC position maps, three
  kernel coherence rules, and the 39 grants authored by *deciding `read` and letting `update`
  follow*. `update ⊆ read` is enforced, `create` deliberately is not — supplying a value you know
  discloses nothing; changing one you cannot read destroys it.
  What remains, in order: **(1)** `--classified-write-mask` can now become the **default** rather
  than opt-in for the shipped packs, since its boot refusal has nothing left to name there — but a
  *tenant's* own activated manifest can still declare an ungranted classified field, so flipping it
  needs that path surveyed too (ADR-0339's Q5, still open and now the blocker for this). **(2)**
  nothing fences a **new** classified field being granted at all: the three rules check that a
  *declared* grant is coherent, not that one exists. A fourth rule — "a sensitive-classified field
  has a grant" — would refuse **zero** fields today and is the cheapest moment it will ever have,
  which is exactly `pg-storeless-tables.ts`' argument one domain across. That zero was later
  confirmed **on the wider of the two legitimate denominators**, which is worth stating because this
  file quotes only one: **46** is the count of distinct *source* declarations, while across the seven
  **resolved** packs there are **173** sensitive-classified field *instances* — core's fields
  reappear in all seven through `meta.extends` — and all 173 carry a `FieldPermission` entry with
  none ungranted. **(3)** `FieldPermission`
  has no `delete` arm and no per-transition arm, so *"this field may not be changed while the record
  is `posted`"* remains a write **guard** question and not a grant one; the two vocabularies do not
  meet. **(4)** `field_create` is unreachable in practice — a `create`-arm `abac` key is refused at
  boot by ADR-0340's check because its availability is `never` — so the position exists to be
  refused by name rather than served, which is correct and worth knowing before someone "wires" it.
  **(5)** the `read` narrowing is a judgement per field (drop the general-purpose observer roles),
  not a derivable rule, so a pack author adding a classified field gets the three refusals and no
  guidance. **(6)** `computeFieldRedaction` is now *further* from the live pair, since it does not
  know about the third arm, and is the one of the two that really has no caller.
- **The ABAC obligation is enforced now, and what is left of it** (ADR-0340 closed ADR-0339's Q3).
  An ABAC-qualified grant granted unconditionally in **five** functions — `rbacCheck` plus all four
  in `fields.ts`, each reading `rule.roles` and never `rule.abac` — and two of those four are the
  pair ADR-0339 reached for, so the **7 explicitly declared** per-field grants it made authoritative
  were enforced as to roles and silently unconditional as to attributes. Measured by building the
  committed tree in a worktree: `{"allowed":true,"requiresAbac":…}`,
  `{"readable":["mrn"],"redacted":[]}` and `{"ok":true}` — the middle one **disclosing the PHI field
  ADR-0338 had just made ciphertext**. Fixed fail-closed through one `dischargeAbac`, one
  `OperateRuntimeOptions.abacEvaluator` threaded from `compile.ts` (the only module holding all five
  readers), and a boot refusal in `buildOperateHttpServer` with no escape hatch.
  What remains, in order: **(1)** ~~the attributes are not wired~~ and **(2)** ~~which mechanism~~
  are both **closed by ADR-0341** — the directory is live and `--abac-policy` is the narrow option
  taken. See the next entry; that ADR also corrects this one's claim that attributes-first "would
  restore the hole" (it would merely have been inert). **(3)** **seven spellings of one concept** across six packages, with
  three value types for the attributes: `auth.RoleDefinition.abacAttributes`
  (`Record<string,string>`, no producer and no reader), `auth.RbacGrant.abac` (the key),
  `reporting.BaseReport.abac` — a **second** ABAC field on a report that already carries one through
  `permissions: RbacGrantSchema` — `search.PermissionTagInput.abacAttributes`, the only *consumer*
  of attributes anywhere (it flattens them to permission tags) and with its own value type,
  `views.PermissionRef.abac`, `views.PermissionVerdict.requiresAbac` which after ADR-0340 has **no
  possible producer**, and `workflow-engine.ABAC_CHECK_GUARD.policyKey`, the one that was already
  right. **(4)** `defaultGuardEvaluator` still throws on `abac_check` *and* on `expression`; with an
  `AbacEvaluator` now defined, the guard's `policyKey` could route to the same seam. **(5)** a tenant
  whose activated manifest is refused falls back to the deployment's gateway rather than being told
  — `TenantGatewayCache.serverFor` catches a build failure, logs through `reportInvalid` and returns
  `null`, which pre-dates this change (any build failure does it) but an authorization refusal is a
  worse thing to degrade silently. **(6)** `surveySensitiveFields` calls the field functions with no
  `AbacEnforcement`, so an obligated field surveys as writable-by-nobody — correct, and unreachable
  because the obligation refusal fires first, but the survey's output would mislead if that ordering
  ever changed.
- **The attribute source is wired, and what is left of it** (ADR-0341 closed ADR-0340's Q1 and Q2).
  `meta.user_tenant_membership.abac_attributes` has had a writer *and* a reader since ADR-0335 and
  nothing that made a decision, so the ABAC domain had its subject recorded and never consulted; the
  five hardcoded `Principal.abacAttributes: {}` sites are gone and the type (`Record | null`,
  required) no longer lets a sixth appear. Attributes resolve once in the auth stage, the directory
  reads through `PostgresUserStore.membershipFor` (no new SQL, `active` memberships only, cached on
  the tenant gate's three TTL figures with `DEFAULT_MAX_STALE_MS` now shared), a credential naming
  no person gets no lookup, and `--abac-policy` is both the consumer and the switch that builds the
  producer.
  What remains: **(1)** ~~the record gap~~ — **closed by ADR-0342**, and the asymmetry this entry
  predicted is what shaped it: the input gained an optional record, availability became a total map
  over grant positions, and the three positions that can never supply one are refused at boot. See
  the next entry. **(2)** a directory
  failure lands as an unclassified **500** through the listener's top-level catch, where ADR-0334
  deliberately chose **503** for the same could-not-establish condition on the tenant-status gate —
  right in direction, coarser in kind, and the typed error would have to reach a generic catch.
  **(3)** `auth.RoleDefinition.abacAttributes` is now the sharpest of the unreconciled spellings
  rather than merely dead: with a membership source live, a **role-level default** is the obvious
  fallback and nothing merges one. **(4)** attribute *writes* are reachable only through
  `--platform-user-routes`, whose grant is a platform operator, so a tenant administering its own
  members' attributes has no surface. **(5)** the TTL is how long an attribute change takes to bite,
  and a `service_account` can hold no attributes at all by rule. **(6)**
  `search.PermissionTagInput.abacAttributes` is still the only other *consumer* in the workspace,
  with its own value type and no runtime — `deriveSessionTags` would now have a real source to
  flatten.
- **A record-bearing ABAC policy is expressible and enforced, and what is left of it** (ADR-0342
  closed ADR-0341's Q1). The class is **a question the seam could not be asked**: all five readers'
  evaluator inputs carried exactly `{entity, field?, operation, policyKey, principal}` — measured
  against the committed tree in a worktree — so half of all ABAC policies were inexpressible by any
  evaluator, OPA included.
  Putting a record on the input was not the hard part. **No call site had the record at the moment
  it decided**, and the availability is neither uniform nor derivable from the grant: entity
  `create` never has one, `read` loads it immediately *after* the check, `update`/`delete` load it
  *conditionally* (`hasGuards || hasEffects || expectedUpdatedAt`) and after the write mask, a
  transition loads it unconditionally (the cheapest position), `list`'s subject is a **set** so a
  per-row answer is a filter and not a 403, field `read` is redacted **once per response** by a
  generic JSON walk that cannot identify a record boundary, and field `update` sees only the
  caller's patch. So the design is five parts: `record?` on the input with ADR-0331's provenance
  rule; a fourth outcome **`deferred`** mapped `false`, so a call site that ignores it refuses;
  availability as a total map with its reasons; a **boot refusal** at the three `never` positions
  and a **boot report** at the one `sometimes` position (a field `update` obligation is coherent and
  its consequence — the field is not settable at create — is said rather than refused, ADR-0322's
  rule); and `eq_record` / `ne_record` / `in_record` on `--abac-policy`.
  The invariant the handlers implement is **nothing is written before the obligation is
  discharged**: a deferral permits exactly one act before re-asking, loading the record. `read`
  re-asks after `store.get`; `update` and `delete` **force** the conditional load and re-ask
  immediately after it, before the 409 and before the guard; the transition re-asks before its
  from-state 409, because authorization precedes business logic. Re-asking calls `rbacCheck` again
  with the record rather than taking a second path, so one function decides both times.
  A record-level denial is a **403 and not a 404**: a 404 would make a record-predicate refusal
  indistinguishable from a missing record, so neither the caller nor an operator reading the log
  could tell "not yours" from "not there", and a wrong answer is worse than a refusal (ADR-0336).
  The cost is that the caller learns the id exists, and the population that can learn it already
  holds the entity grant.
  What remains: **(1)** ~~field `read` cannot carry a record policy~~ — **closed by ADR-0343**,
  which also corrected this entry twice: the fix did **not** need per-record projection in the
  handler (the gateway already parses the body, and the shape is derivable from the action the route
  was built from), and the refusal was never structural — it was the one of ADR-0342's three
  `never` positions blocked by *ordering* rather than by *shape*, a distinction
  `pg-unreachable-stores.ts` had already drawn and this file had not applied here. See the next
  entry. **(2)** the **principal's own id is not an operand**, so ownership is spelled
  `owns=user_id:eq_record:owner_id` and needs the user's id written into their membership
  attributes; a reserved left-operand spelling would shadow a real attribute of that name, the
  `hasOwnProperty` lesson in a new place. **(3)** **link/unlink could load the owner record and does
  not**, so that association position is unclosed rather than structural — list and count are
  structural, since both answer for a set. Vacuous today: **zero** `many_to_many` relations across
  the seven packs. **(4)** a record-bearing obligation on a `required` classified field makes its
  entity uncreatable, and `--classified-write-mask`'s survey catches it only when that flag is on,
  because `surveySensitiveFields` passes no `AbacEnforcement` (ADR-0340's Q6 made actionable).
  **(5)** the comparison is **scalar to scalar**, so a record field holding an array — a tags list,
  a set of owners — is `structured` and denies for every operator, which leaves "the principal's
  team is one of the record's owners" inexpressible. **(6)** the **422 ordering degrades** for a
  record-bearing field obligation: the mask short-circuits on the first refusing field and a
  deferral is a refusal, so a caller with both a role violation on a later field and an invalid body
  now gets the 422 first. Bounded — ADR-0339's argument is about an *unauthorized* caller harvesting
  the entity's shape, and this one has already passed the entity role check — and pinned by a test
  so the change is visible in the suite rather than only in a comment. **(7)** `validateWriteMask`
  is the only one of the four field functions not routing through the shared `obligationAdmits`
  predicate; no behaviour difference, but that asymmetry is the shape that let the read and write
  halves diverge in the first place.
- **A per-field read policy is answered per record, and what is left of it** (ADR-0343 closed
  ADR-0342's Q1 and corrected two of the things that ADR said about it). The class is **a structural
  refusal that was really a wiring one**: ADR-0342 refused three positions under one reason shape,
  and its `field_read` reason — *"response redaction computes one field set per response and applies
  it by a generic JSON walk, so it cannot identify which record a field belongs to"* — was a true
  statement about the implementation and a false one about the question. A create has no row and a
  list's answer is a row *set*; a `GET /v1/charts/{id}` response **is** the record and a page's
  `data` **is** a list of them. `pg-unreachable-stores.ts` had already drawn exactly that line
  (`prerequisite_of_unbuilt_surface` vs `contract_cannot_carry_the_surface`) on the stated grounds
  that calling both "unwired" sends the next person to write the route that cannot be written
  honestly — and this file had not applied it here.
  The cost is what makes it shippable: the **`deferred` outcome does a second job**. ADR-0342 added
  it so a call site unable to supply a record refuses rather than grants; here it tells a call site
  that *can* supply one that it should, so the fast path is one evaluation and today's bytes and only
  a deferral pays per record. No second list naming which fields are record-bearing — ADR-0288's
  shape, which this repo has found wrong four times.
  What remains: **(1)** ~~`AbacEvaluator` has no batch seam~~ — **closed by ADR-0344**, which also
  corrected three of the things this entry said: **one** reader takes the arm and not five, the shape
  is not `(inputs) => readonly AbacOutcome[]` (an answer echoes its index, because a permutation is
  otherwise undetectable), and the fan-out is records × fields rather than records. See the next
  entry. **(2)** ~~entity `list` still cannot~~ — **closed by ADR-0345**, and this entry's
  prediction was right: it *is* row filtering and it *did* change what `nextCursor` means. See the
  next entry. **(3)** a record with a **nested** object gets the record's own set applied to
  the nested value by `redactJsonValue`'s walk: correct for the flat JSONB documents entity records
  are today, unexamined for a nested shape where the nested object is arguably its own record.
  **(4)** the shape is declared per operation by `compileOperateServer`; a deployment supplying its
  own `RedactionRegistry` declares its own and **nothing checks the declaration against the
  responses that route actually produces**. **(5)** `audit-read-routes.ts` declares
  `recordShape: "record"` and deliberately supplies **no** record and no evaluator, so a
  record-bearing field policy resolves `undischargeable` and stays redacted — because that path's
  "record" is a *historical snapshot* in `before`/`after`, so "only on a patient in your department"
  would be answered against the department the row held when it was written. Whether that is the
  question a trail reader is asking is undecided.
- **The evaluator can be asked a whole set at once, and what is left of it** (ADR-0344 closed
  ADR-0343's Q1). `evaluateBatch` is an optional sibling of `evaluator` — never a replacement, and a
  batch supplied without one refuses everything — answering `AbacBatchAnswer {index, outcome}` whose
  index must be its own position. Measured on the same tree with both arms live: a 500-row page with
  three obligated fields goes from **1,503 evaluator calls to 2**, with identical answers; live, one
  list request makes **2** seam crossings and **zero** on the single arm, and boot makes none.
  **Three** readers batch since ADR-0345 added `rbacCheckForRecords` — the classified read pair and
  the plural entity check — and the write masks must not, because first-refusal-wins means a pool
  would ask about fields whose answers are never needed. The reader counts are deliberately gone
  from the code: ADR-0344's own doc said "five readers" and a sixth landed one increment later.
  What remains: **(1)** a permuted *outcome* list with ascending indices is still accepted — the
  echo catches a reordered answer **list**, not one that mislabels each element, and there is no
  cheap check for the second. **(2)** `rbacCheck` is still one question per call, so a request
  holding an entity grant **and** a field mask asks separately; grouping those is a different seam,
  because the two decisions happen at different points in the handler. ADR-0345 corrected this
  entry's sibling claim — ADR-0344 said the handler path had no reader with a fan-out, which was
  true of the readers that existed and false one increment later. **(3)** the degenerate batch
  in `abac-policy.ts` exists to exercise a branch, so if a real batch producer ever lands it should
  **replace** rather than join it — two producers for one policy layer is the divergence
  `privilegedForClass` is behind one definition to prevent. **(4)** the pool is per *call*, so the
  minimum is 2 crossings per response and not 1; collapsing them would need the record-free pass to
  know what the per-record pass will ask, which is the thing it exists to discover. **(5)** an
  aliased record contributes duplicate cells to the batch, unreachable from the pipeline since
  `JSON.parse` never aliases, and not worth de-duplicating for a case only a direct
  `redactRecords` call can produce.
- **An entity `list` policy filters rows, and what is left of it** (ADR-0345 closed ADR-0343's Q2).
  A record-bearing obligation on a `list` grant drops the refused rows from the page instead of
  refusing the request; `entity_list` is `always` and `never` is now the one-member set
  `{entity_create}`. The store's `nextCursor` passes through **untouched**, which is the whole
  soundness argument: taking it from the last *visible* row leaves a fully-denied page with no
  cursor, so the walk loops or silently truncates, and re-filling to `limit` makes the work per
  request a function of the policy's selectivity (~100 store calls for a caller who may see 1%) — a
  denial of service reachable from a manifest declaration. Verified live: a fully-denied page returns
  **0 rows with a non-null cursor**, the walk still terminates, and two principals holding one role
  see an exact complement of the seven rows.
  **ADR-0346 corrected one thing ADR-0345 claimed**: the per-page withheld count is *derivable*
  despite not being reported. `applyListQuery` sets `hasMore = start + slice.length < rows.length`
  and a slice only stops early at the end of the rows, so a non-null `nextCursor` implies a **full**
  slice and `withheld = limit − data.length` for every page but the last. So not reporting it keeps
  the figure off the last page and keeps it from being a contract, rather than withholding it. The
  association list is what made that visible — its cursor is an `offset` the client sends, advancing
  deterministically by `limit`, so there the count was never hidden at all.
  What remains: **(1)** ~~the cursor discloses the position of withheld rows~~ — **closed by
  ADR-0346**, which sealed it with AES-256-GCM under a per-tenant derived key and found that the
  three pins never forbade a cipher in the first place. See the next entry. **(2)** the withheld set is the entity's classified fields rather
  than this caller's redaction set, so a privileged caller's classified `?sort` is refused too while
  an obligation is outstanding; exact would mean resolving `SensitiveFieldPolicy` and the per-field
  read grants a second time in the handler, which is a second place for the read and write halves to
  drift. **(3)** association **link/unlink** is now an **unclosed** position rather than a structural
  one — the grant is `update` on the owner, the owner's id is in the path, and the record could be
  loaded and the decision re-asked exactly as entity `update` does. Vacuous today: zero
  `many_to_many` across the packs. **(4)** a deployment supplying its own evaluator or its own
  `RedactionRegistry` gets no check that its list grants' policies are record-bearing in the way the
  boot report assumes. **(5)** whether sorting by a field you cannot read should be refused
  **generally**, rather than only while rows are being withheld, is unexamined — today it is
  permitted, and the ordering it reveals is a pre-existing channel this increment did not widen.
- **The entity-list cursor is sealed, and what is left of it** (ADR-0346 closed ADR-0345's Q1).
  AES-256-GCM over a per-tenant HKDF key derived from `CURSOR_ENCRYPTION_SECRET` (environment, never
  argv — ADR-0301), as an **envelope at the handler boundary**, so the stores still produce and
  consume the plaintext keyset. `cursor_discloses_withheld_rows` is the fifth boot refusal, firing
  iff a list grant filters rows and the mode is `absent`, with `--allow-cursor-disclosure` as the
  escape hatch. Sealing is **uniform** when a secret is set — every entity list, not only the
  filtered ones — because one format beats a per-entity matrix and makes cursors stop being a
  readable surface at all. Verified live: the same request yields
  `{"k":["l2"],"id":"rec_…"}` in one mode and `s1.wfHmgacd…` in the other, a different `?sort` and a
  tampered cursor are both 400, and a legacy plaintext cursor still pages.
  **The refusal ordering argument I first gave was wrong** and the real one is better: vacuity from
  `rowFiltered` is equally true of `list_sort_addresses_withheld_field`, so it orders nothing — the
  reason the cursor refusal comes *after* the sort one is that ADR-0345's addressing guard sees the
  manifest's **default** sort and 400s every list request on that entity **before a cursor is
  minted**, so sealing does not rescue a classified default sort and an operator who set the secret
  would find the remedy still owed. Pinned by a test.
  What remains: **(1)** **ADR-0338's DEK envelope and crypto-shredding is now unblocked** — the AEAD
  is the primitive it was waiting on — and still needs a KEK source, an unwrap cache, a decision
  about an unreadable DEK row, and CHECK migrations on `meta.crypto_keys`, which is structurally a
  *public*-key directory. **(2)** no rotation path: a cursor sealed under generation N refuses under
  N+1 (pinned), and the `s1.` tag is there so an envelope naming its generation can land without a
  page-boundary 400. **(3)** `ColumnSecretRefused` and `PLATFORM_COLUMN_KEY_SCOPE` are now narrower
  than their uses — both serve any derived key; the **messages** are parameterised so an operator is
  sent to the right variable, and the class rename is 38 references across four files. **(4)** nothing
  reads `OpenedCursor`'s `plain`-vs-`opened` distinction, so legacy traffic during a rollout is not
  counted and there is no switch to retire the legacy path — which is also the only way to close the
  sort-mismatch hole on that path. **(5)** a wrong-length key would be a 500 rather than a 400, right
  in direction and unreachable today because the one key source derives exactly `AEAD_KEY_BYTES`,
  pinned. **(6)** ADR-0357 found that **the refusal this entry describes is vacuously silent on
  every deployment there is** — it fires only on a row-filtering grant, of which the measured count
  across the seven packs is zero — while the live disclosure is one layer in and about a
  *classified field's value* rather than a withheld row's. See the next entry.
- **A classified field's value in an entity-list cursor, and what is left of it** (ADR-0357). The
  class is **a claim about the deployment that the deployment does not make**, and this is its
  sharpest member: `keysetOf` maps over the whole declared sort and renders `String(row[field])`
  from the record, so `?sort=<classified field>` hands that field's plaintext back in `nextCursor`
  inside a response whose body the gateway redacted on the same caller's grants — the redaction and
  the cursor being two code paths and only the first consulting a grant. **Different from the
  disclosure ADR-0345 and ADR-0346 reasoned about**: those are about a *withheld row's* value and
  are gated on a record policy nothing declares, while here the row is one the caller is shown.
  **14 pairs across the seven packs, 8 distinct, one in every pack**, `Employee.work_email` (`pii`)
  from the compose default and `Patient.mrn` (`phi`) in healthcare. Reported, never refused, and the
  argument is measured rather than preferred — `erp-core` has a member so a refusal would refuse
  every deployment there is, and the hatch an operator would reach for also disarms the sharper row
  check beside it. Verified live as a non-owner: one request, two deployments,
  `{"k":["a1-secret@example.test"],…}` and `s1.-sdvu8Oxt…`, with the body omitting the field in
  both.
  What remains, in order: **(1)** the survey is **boot-time**, so a *per-tenant* activated manifest
  (ADR-0314) that classifies a sortable field is surveyed by nothing. `buildOperateHttpServer` is
  where ADR-0340 put the obligation check for exactly this reason and the same call belongs beside
  it; the only open question is what a per-tenant *report* (not refusal) does when the tenant is not
  the operator reading the log. Same shape as ADR-0339's Q5, which is still open and is the blocker
  for both. **(2)** `--allow-cursor-disclosure` now acknowledges **two** findings — withheld rows
  and a classified field's value — so an operator accepting the second necessarily accepts the
  first; splitting it is one flag and a decision about whether a second hatch earns its surface.
  **(3)** whether sorting by a field you cannot read should be refused **generally** rather than
  only while rows are being withheld (ADR-0345's `withheldAddressing`) is unexamined: today the 14
  members are addressable and the ordering they reveal is a pre-existing channel neither increment
  widened. **(4)** on `--store pg-columns` the cursor carries the **decrypted plaintext of an
  ordering that was never applied** — `columnExpr` answers `null` for an `encryptAtRest` column so
  `?sort=mrn` is dropped from `ORDER BY` while `selectList` decrypts it and `keysetOf` reads the
  record — which is a soundness bug in the keyset beside the disclosure, and sealing hides it rather
  than fixing it.
- **The database channel, the credential route and the probes** (ADR-0357's other three members).
  What remains, in order: **(1)** **nothing accepts CA material**, and that is sharper than it
  looks: `PgConfig` has no `ca` field and nothing reads `PGSSLROOTCERT`, so `verify-full`
  validates against Node's trust store alone — while Supabase's own documented path for
  `verify-full` is to pass the project's downloaded server root certificate as `sslrootcert`. So
  the mode this increment prescribes **may be unreachable on the managed-cloud path the repo
  documents**, which is why the guide says *try it* and names `require` with its cost. Adding CA
  support also makes `verify-ca` implementable, and *that* wants a **fourth** assurance member
  rather than a reclassification of the three — it validates the chain and deliberately does
  **not** check the hostname, so it sits between `encrypted_unauthenticated` and `authenticated`
  (`chain_validated_hostname_unchecked`) — with the composed-map shape making it a compile error
  to add and the text-reading test sending its author to the refusal that must then be deleted.
  **(2)** the
  channel line is printed once, in `resolveStore`; the four maintenance subcommands (`rekey`,
  `replay` and the two survey paths) each build their own connection and say nothing about it.
  **(3)** the probes are wired in `serve()` and so are absent from the Fetch/Workers edge adapter,
  which builds its dispatch target separately — `buildHealthInterceptor` is transport-pure and takes
  a `RawHttpRequest`, so this is a wiring line rather than a design question. **(4)**
  `operate-web`'s own `/api/[...path]` proxy has no probe at all, so compose's `web` service still
  has no healthcheck; the UI's readiness is "can it reach the API", which is the probe it would
  declare. **(5)** nothing fences a *new* credential-bearing flag against ADR-0301: the rule is
  stated in three ADRs and in `deploy/`'s comments, and `--api-key` was the counterexample for four
  phases. A name-based rule over `cli.ts`' flag table is the tenth rule's shape, and measured it
  matches **five** names of which three are real: `--stripe-api-key` and
  `--stripe-webhook-secret` are secrets read straight from argv with no environment route, and
  `--license-key` is a bearer artifact; `--jwks-key` is a **public** key and belongs on argv; and
  `--allow-live-rekey` is a boolean that merely has "key" in its name. So the rule would need
  declarations with reasons like its eight siblings rather than a flat refusal — which is the
  argument for building it rather than against.
- **`packages/workflow-signal-bridge` has zero importers** (ADR-0337), the `api-gateway-pg`
  condition before ADR-0335, invisible until the member predicate stopped being `*-pg`-restricted.
  This file says the package "ships as a registered gateway handler" — it ships the handler and
  **nothing registers it**, so no inbound webhook can deliver a signal to a workflow in any
  deployment, and its two driver classes (`WorkflowSignalBridge`, `StaticSecretResolver`) are
  callerless with it. A wiring increment of its own: it needs the HMAC secret resolver decided, since
  `StaticSecretResolver` is the offline one. `RegionRouter` in `residency-runtime` is the same shape
  one notch smaller, and **the reason this file gave for it was false**: a residency profile *is*
  enforced, pre-auth on every request, because `buildOperateHttpServer`'s region guard calls the
  free `decideRegionRouting` and answers 421 or 403. What has no caller is the `RegionRouter`
  **class** — the stateful half that caches a directory and answers per request — so the gap is a
  cache, not an enforcement; two of the three facts in that store's own `UNREACHABLE_STORES`
  declaration say otherwise and are wrong.
- **Four stores in `workflow-runtime-pg` set no tenant context** (ADR-0337), so as a non-owner
  `ProjectingEventLog.append` raises `42501` on the first child write and the instance upsert writes
  **nothing, silently** (an `UPDATE` matching zero rows). That makes the workflow engine itself
  owner-dependent, and it is live because `--workflow-workers` mounts the fleet. Deliberately not
  fixed in ADR-0337: `claimDueTimers` documents the worker connection as platform-scoped and
  RLS-bypassing so one fleet serves every tenant, which makes scoping these stores a **subsystem**
  decision with the engine on the other end — it changes `append` semantics for `--workflow-workers`
  and `--workflow-cancel-role` — rather than a replayer fix. The scope is available from each row
  (`ProjectedInstance.tenantId` and siblings, ADR-0335's property). `WorkflowReplayer` refuses
  `rls_would_confine_this_session` up front instead, before reading the log, because a confined
  session reads zero events and would otherwise answer "nothing to repair" for every instance.
- **The repairing replayer is not transactional and not guarded against the fleet** (ADR-0337), which
  is why `operate-server replay` offers detection only. Its derivation is conclusive; applying it is
  not safe until `resyncInstance` runs in one `conn.transaction` and its child upserts carry a claim
  guard (`claimed_by IS NULL OR claim_expires_at < now()` in the `DO UPDATE … WHERE`, which is
  checkable, unlike "the operator stopped the fleet"). One sub-case *was* unauthorised and is fixed:
  the timer store cleared a live claim whenever `fire_count` advanced, on a premise true of the engine
  and false of a repair, so resyncing the very timer the detector found would have let a second worker
  fire the same occurrence.
- **Three of the six replayers do not re-parse through zod** (ADR-0337) — `access-reviews` (three of
  four mappers hand-assemble with row-level type assertions), `gateway` (`PipelineExecutionSchema`
  exists and is unused; using it would make `unknown_stage` unnecessary), and partially `workflow`.
  So they re-implement a hand-picked subset of their own contract instead of asking it, and a
  status↔field pairing the schema enforces and the replayer does not is invisible. Only the incident
  replayer treats a parse failure as a **finding** rather than an exception, which is its real
  contribution — and the claim that it is "the only way" to catch such a row is **partly overstated**:
  the re-parse is shared by six read paths and runs on every SLO and integrity tick, but there it
  *throws*, surfacing as a failed escalation pass with no id and no field named. What only the
  replayer adds is the non-throwing sweep over every row and three findings no read path can produce.
- **Nine actor columns became TEXT, and that is standing manual SQL on every existing deployment**
  (ADR-0335). `planSchemaReconciliation` will not drop a foreign key without `--allow-loosening`, and
  a type change on a populated table is its deliberate refusal. The scale, measured against the
  previous catalog rather than counted by hand: **29 foreign keys** the database still enforces and
  the catalog no longer declares — **14** into `meta.users` (17 `USER_FK` references removed, of which
  3 come back as `USER_OWNED_FK`, an `ON DELETE` change that reconciles as a *replace* rather than a
  drop) and **15** into `meta.tenants`. All 29 report as undeclared on **every** drift check until an
  operator clears them once. `--allow-loosening` should **not** go into the compose `migrate`
  command: it converts every *future* undeclared-FK refusal into a silent drop, which is the one
  guardrail between a catalog typo and a dropped constraint, so this is a one-time manual invocation.
  The tables are empty in every
  deployment today, because nothing could write them, which is the cheapest moment this change will
  ever have. `meta.rate_limit_decisions` additionally needs a `DROP COLUMN quota_definition_id`, which
  `allowLoosening` reaches by design **never** (it covers foreign keys only, since that is the one
  loosening that cannot fail against existing rows), so that statement is manual forever and the
  catalog will report it as drift on every drift check until it is run. A **fresh** database gets the
  patched shape straight out of `emitBootstrapSql` with no manual SQL at all. The exact seven
  statements for the decision row, with the measured `steps`/`unreconciled` either side of
  `--allow-loosening`, are in ADR-0335's implementation notes.
- **The console's transition routes now require a `reason`** (ADR-0335), which is caller-visible: the
  three routes previously parsed no body at all and now 400 without one. `LifecycleEvent.reason` is
  `z.string().min(1)` and a transition whose reason is `"(none given)"` is the field ADR-0317 refused
  a default for. Required unconditionally rather than only when a trail store is wired, because an
  API shape that depends on deployment config is worse than a required field.
  **There *was* an in-repo caller and the increment shipped it broken for an hour.**
  `operate-web`'s `setTenantStatus` sent a literal `body: "{}"`, so every Suspend / Archive /
  Reactivate click in the platform console was a guaranteed 400 — fixed in the same commit with a
  required input (trimmed, `maxLength={500}` matching the server's cap, buttons disabled until typed,
  cleared on success, no default string). The lesson is narrower and worse than the break: **neither
  `npx tsc --noEmit` nor `npx next build` can see it**, because `operate-web` types its request bodies
  as `string` — so the boundary is drawn at the *serialized body*, and what is past it is unverified
  by construction. That is ADR-0333's fake-connection finding one layer out, on the other side of the
  process, and nothing in the repo fences it: a server-side body schema and its browser caller are
  two files with no shared type. Changing a request schema means grepping `apps/operate-web` by hand.
- **`ACTION_TARGET_STATE.cancel_deletion` is `"archived"` and the reject route returns a tenant to
  `active`** (ADR-0335), so the action that *means* "the deletion was cancelled" cannot express what
  the route does, and `cancel_deletion` has **no producer** — `lifecycleTrailGaps()` returns exactly
  that one, and the boot line says so. The reject records `restore` instead. ADR-0334's reasoning for
  going to `active` stands (routing through `archived` would cost a tenant their write access for
  somebody else's mistake), so which of the two actions should name the reject is a vocabulary
  decision rather than a defect, and changing `ACTION_TARGET_STATE` forces a workspace rebuild before
  any consumer's tests mean anything (ADR-0329).
- **The storeless rule's inverse is fenced now, and 15 classes plus one member stay unreachable with
  a reason each** (ADR-0335 named the gap, ADR-0336 closed it, ADR-0337 widened it).
  `pg-unreachable-stores.ts` asks *which store has no
  caller*, which `pg-storeless-tables.ts` cannot — it decides a table is written by reading a store's
  SQL as text, so **a store with no caller makes its table read as written while no deployment has
  ever put a row in it**, and `table_declared_storeless` is the cross-rule join that catches the two
  disagreeing. Of ADR-0336's eight, two were wired (`PostgresIdempotencyStore`,
  `PostgresPipelineExecutionStore`) and six declared; ADR-0337's widening added members and `apps/*`
  to the predicate, and the same increment's `operate-server replay` resolved five declarations —
  deleted, not weakened. Count the declarations in the module; this sentence will go stale again.
  What the rule **structurally cannot see**, which is the live part of this entry:
  **a store constructed behind a factory whose factory has nothing calling it.** Flat reachability
  stops at the first non-test `new`, and **ten stores sit in exactly that position today** — the four
  access-review stores via `persisting-runtime.ts`, the four Architect stores via `transcript.ts`,
  `PostgresEventLog` via `replayer.ts`/`persistent-engine.ts`, `PostgresSloLatencyEvaluationStore` via
  `latency-persisting-engine.ts`. All ten are *correctly* called reachable, but if one of those
  factories lost its last caller the rule would keep calling its stores reachable, and ADR-0333's
  `workflow-workers.ts` is the historical member of that class. Also invisible: a symbol not named
  `Postgres*` — `ColumnMappedEntityStore`, `TenantColumnStoreRegistry`, `ProjectingEventLog`,
  `MigrationApplier`, `DeletionRunner`, `DeletionReconciler` and the five `Persistent*Engine`s are all
  impure persistence classes outside its sight, so the prefix is a convention the rule trusts the way
  `pg-storeless-tables.ts` trusts `META_TABLES`; `apps/*`' own stores (`PostgresRecipientResolver`,
  `PostgresReadStateStore`) are out of scope **by declaration**, and an app-internal store the app
  never constructs is the same defect; a dynamic `new (map[kind])()` is counted and reported (0 today,
  with a tripwire that none mentions `Postgres`) but could only ever be named unattributable; a
  construction in a fake not matching `*.test.ts` / `test-*.ts` reads as a real caller, and
  `access-reviews-runtime/src/fixtures.ts` is exactly such a module; a package imported for one
  type-only symbol counts as reachable, since `importedSpecifiers` does not distinguish
  `import type`; and, as with every rule here, **whether a declared reason is true** is unverifiable
  by machine.
  And `packages/feature-flags-pg/src/subsystem-survey.ts`' `CALLERLESS_FLAG_STORES` is a **second list
  naming the same things that no rule reads** — written to be the rule's input and not consumed,
  because `packages/testing` has no workspace dependencies so reading it means importing `dist` (green
  only after a build) or text-parsing another package's source. Two lists without a both-ways
  comparison is ADR-0288's shape; comparing them from disk in both directions, the way
  `pg-record-retention.ts` does, is the follow-up.
- **There is no incident lifecycle surface, and two of its consequences are live** (ADR-0336). No
  `/incidents` route exists anywhere in `apps/`, and `PersistentIncidentEngine` is constructed only by
  `PostgresIncidentDeclarer`, which calls `declare` / `findOpenFor` / `load` / `cancelIfUntriaged` and
  never `assignRole`, `changeSeverity`, `note`, `transition` or `attachPostmortem`. So
  **`human_owned` is unreachable in every deployment** — `cancelIfUntriaged` declines only when the
  status is not `declared`, reaching `triaged` requires on-call roles no route assigns, and
  ADR-0326's "an alert wrongly closed is silence" arm therefore never fires — and **sev1 and sev2
  incidents cannot be closed at all**, since `IncidentRecordSchema` refuses `closed` without a
  `postmortemId` for every severity with `postmortemRequired`, which is every grade the three
  escalators declare at, while the refinement above it refuses any status past `declared` for those
  grades without `publiclyVisible: true` — a status page this platform does not have.
  `declared → cancelled` is the whole reachable lifecycle. `lifecycle-prerequisites.test.ts` pins both
  couplings from the contracts, so a close route added later fails there naming the reason rather than
  at the first sev1. Three further facts sit under it: **there is no runbook** (no
  `Runbook`/`RunbookDefinition` contract anywhere, no `meta.runbooks` table, so `runbookId` is free
  TEXT naming an external document and nothing executes a step); `PostgresCustomerCommsStore`'s table
  is platform-wide with **no tenant-scoped read path** while `affected_tenants` is one of its
  audiences, so a tenant cannot be shown the row; and the schema refuses `publishedAt` later than
  `breachNotificationDeadlineAt`, so **a late GDPR 72-hour breach notification is unrepresentable** and
  `isBreachNotificationTimely` can never answer `false` for a record that parsed — the one fact a
  regulator asks for is the one this table cannot hold. All of it reported and untouched: contracts
  edits with cross-package consumers, and changing one forces a workspace rebuild before any
  consumer's tests mean anything (ADR-0329).
- ~~**`GatewayReplayer` has no caller**~~ — **closed by ADR-0337**, which is why this entry is kept
  rather than deleted: it was ADR-0336's open end and `operate-server replay` is the caller, so
  `--gateway-execution-capture` no longer writes rows only a test reads. The `rate_limit_decisions`
  orphan check ADR-0336 described as half-joined is the half that resolved: it fired six
  `rate_limit_decision_not_found` on the first live run, attributable to the in-memory checker
  persisting no decision row while every execution still stamps an `rld_…` id, so **both** halves of
  that join are now known and a boot warning says it before the sweep does. A *read* route over the
  captured executions is still unbuilt and would still need the `--audit-read-routes` apparatus (a
  role, a recorded read, a tenant refusal); detection by CLI is what shipped.
- **77 of 146 catalogued tables have no writer, and every one is declared with a reason**
  (ADR-0334, ADR-0335). `packages/testing/src/strategy/pg-storeless-tables.ts` classifies them —
  `static_catalog` (2), `out_of_band` (1), `dynamic_writer` (1), `superseded` (8), `unwritten_table`
  (25, ADR-0300's class: a live store writes the siblings), `unbuilt_subsystem` (40) — each with an
  owner package asserted to exist, a note carrying the evidence and, for the two gap reasons, a
  required consequence. Compared against `META_TABLES` **in both directions** every run
  (`undeclared` / `overtaken` / `unknown_table` / `duplicate`), which is the part that matters:
  ADR-0288's list had no forcing function, and *location* was never what made `needsAuditEmitter`
  wrong — the absence of a both-ways comparison was. A new Phase-1 table with no writer is a test
  failure the moment it lands. Vacuity floors include an **upper**-bound-shaped one (`writerless ≥
  65`, the opposite of the usual, lowered from 75 by ADR-0335's six closures), because the dangerous
  direction is over-counting writers: if everything looked written, nothing would need declaring and
  the fence would pass having examined nothing. What it cannot check is whether a declared *reason* is
  true — only shape, referential integrity and both directions of membership.
  **ADR-0335 closed the six judged real**, and each one had a consequence that was live rather than
  theoretical. `meta.users` + `meta.user_tenant_membership` now have a writer behind
  `--platform-user-routes`; with one row provisioned `PostgresRecipientResolver` resolved a real
  audience **for the first time**, so every notification audience in every deployment had been
  resolving to `[]`. `meta.notification_preferences` has one behind `--preference-routes`; it was read
  on every dispatch and written by nothing, so the consent half of `computeDispatchEligibility` was
  unreachable and every user's preferences were the built-in defaults for ever.
  `meta.access_review_evidence` has one, which is why `certifiable` can now be true — the adapter
  answered `null` and the engine read that as *no evidence* rather than *not wired*, so it was
  **false in every certification report ever produced**. `meta.tenant_lifecycle_events` has one,
  unconditionally under `--store pg` and deliberately behind no flag. And
  `meta.feature_flag_targeting_rules` has one, so a flag read back from the database no longer
  round-trips `ftr_…` ids pointing at nothing.
  **The `meta.users` reference class is settled, for the third time.** Nine `NOT NULL ON DELETE
  RESTRICT` references became plain **TEXT** on the rule the repo had already reached in ADR-0318 and
  ADR-0321: *a column recording who performed an act is a record of the past, and a referential
  constraint on it makes the actor undeletable as a consequence of having acted.* ADR-0331 sharpens it
  — a bare `--api-key 'key:role:tenant'` is a `service_account`, so a *person* is not even the normal
  case for most of these. **Three** references were kept and **strengthened** to `CASCADE`
  (`USER_OWNED_FK`): `notification_read_states`, `_read_watermarks` and `notification_digests` hold a
  user's own per-viewer state, which must go when the user does. Two keep `RESTRICT` because they are
  *about* the user rather than about something the user did (`user_tenant_membership`,
  `notification_preferences`). `LIVE_USER_FK_WRITERS` is five now and **derived** rather than
  restated: a table is on it iff the catalog declares a `NOT NULL` `meta.users` reference *and*
  `STORELESS_TABLES` does not declare it writerless — so somebody writing a store for one of the
  other 37 does not fail that test, their increment moves the table into the derived set and the test
  then names it.
  What is **left**: `meta.rate_limit_policies` / `quota_definitions` remain a *decision* rather than a
  gap, and ADR-0335 took the half it could — `rate_limit_decisions.policy_id` is TEXT carrying the
  `rlp_` id `--rate-limit-policy` declares (matching `meta.gateway_routes.rate_limit_policy_id`), and
  `quota_definition_id` was **dropped rather than re-typed**, because unlike a policy an `rlq_` id has
  no declaration site anywhere, so a TEXT column would have been the same hole in a different type.
  A store becomes wanted when `meta.rate_limit_exceptions` is built, whose `policy_id` is NOT NULL.
  `meta.job_costs` still needs a cost model, which is a decision too. `meta.feature_flag_changes` is
  deliberately **not half-built**: to be worth anything it must be written in the same transaction as
  the change it records, which needs a `recordWithin(tx, …)` seam through `insert`/`update`/
  `transition` plus the kill-switch store — a store recording rule additions and not flag toggles
  would make `summarizeChangeHistory` report a history that *looks* complete.
  `meta.feature_flag_evaluations` should **never** get a Postgres writer, measured: 394 bytes per row
  including its four indexes, so a gateway at 1,000 req/s evaluating 10 flags per request writes
  **124 TB/year** into the database that serves the ERP, under RLS, on the request path.
  And the erasure's `PLATFORM_RECORD_TABLES` no longer protects five tables nothing writes — it
  protects **three** (`access_review_exceptions`, `access_review_templates`,
  `compliance_attestations`), so that much of the protection is still vacuous.
- **The tenant-status gate is opt-in, and what that leaves** (ADR-0334). `--tenant-status-gate` is off
  by default because it 403s a credential whose tenant has no `meta.tenants` row and
  `--api-key 'key:role:tenant'` names arbitrary UUIDs — so on-by-default would refuse every request of
  a deployment that works today. The boot survey names them, but an operator has to read it, and
  nothing *enforces* that an api-key tenant is provisioned. The TTL (30s default) is how long a state
  change takes to bite, so a `pending_deletion` tenant can still write for up to that long; a
  per-**tenant** TTL and a per-tenant request-body cap are both unaddressed. And the gate answers for
  the tenant on the *credential*: a request is still not scoped to a data **subject** within a tenant,
  which is the same limitation ADR-0327 recorded for `subjectIdentifier`.
- **The 29-table platform-write class is swept** (ADR-0313, ADR-0331, ADR-0332), and what is left of it
  is narrower. Every one of the 29 single-`ALL`-policy tables now carries a split, on **two orthogonal
  axes**: *shape* decides how many policies (**12 mutable** get four — isolation, `SELECT` read,
  `INSERT` write, `UPDATE` write; **17 append-only** get three, so a platform row is
  immutable-by-RLS once written), and *grant* decides who, over **four** GUCs —
  `app.platform_audit_write` (3), `app.platform_record_write` (17), `app.platform_config_write` (11),
  `app.platform_key_write` (1). `DELETE` is reachable by **no policy on any of them**: nothing deletes
  a platform row (retirement is a status column in every one of these contracts), and the shared-table
  erasure deletes `tenant_id = $1` only, which isolation still covers. The axes are orthogonal and
  conflating them is the trap — `quota_definitions` is append-only in shape but sits on `config`
  because a hard limit decides what the deployment permits, while `dr_failover_executions` is mutable
  in shape but sits on `record`; `feature_flag_targeting_rules` is the second append-only-but-`config`
  case. Verified live as a non-owner role across a **44-case forgery matrix**, all 44 unambiguous,
  plus 13 cases through the real stores, and a fresh-cluster bootstrap of **958/958** statements whose
  re-plan came back clean. The arithmetic that confirms the shape axis is the live policy census —
  `ALL 114`, `SELECT 34`, `INSERT 32`, **`UPDATE 12`** — twelve `UPDATE` arms for twelve mutable
  tables. What remains: **15 of the 29 have no store** (machine-counted in ADR-0334; ADR-0332's
  "fourteen" was the count of those that *do* have one, transposed), so their write arms are
  capability with no caller — and the honest total is **16 of 29**, because `meta.notification_templates`
  has two stores and **neither can ever write a platform row**: both throw
  `"cannot author a platform-wide template: tenantId is null"` before any SQL. The other 13 route
  through a `scopedWrite(conn, tenantId | null, …)` helper that claims the grant on a null scope, so
  they are callable; whether any caller passes null is per-call and unsettled.
  The grants are `PUBLIC`-scoped settings, so any session able to call `set_config` can
  claim one — and that is **forced**, because a policy's `roles` list would have to name roles the
  catalog cannot know a deployment created, which is why no policy in `META_TABLES` narrows `roles` at
  all. So what the split buys is a *declaration* rather than an authorisation: claiming a grant is a
  deliberate, transaction-local act naming which privilege is being exercised, instead of the ambient
  default of every tenant connection. `certification_reports` is the loudest member of the `record`
  group: a forged platform certification report is a compliance claim, not telemetry.
- **`meta.audit_integrity_verdicts` is split too, and the reasoning that looked hard was wrong both
  ways** (ADR-0313, ADR-0332, ADR-0333). Its `ALL` policy ORed in the `app.platform_audit` *read*
  grant, so — the `USING` serving as the `WITH CHECK` — a session holding only the cross-tenant read
  could forge a `verified` verdict at any scope, flip a stored `compromised` one, or delete it.
  Twelve such forgeries succeeded live as a non-owner across a 90-case matrix, and none after.
  ADR-0332 recorded this as needing an isolation policy narrowed from `ALL` to `SELECT`, "a different
  and larger edit than adding arms beside one". **Both halves of that were false.** A command change
  under one name *is* a `replace_policy` — `diff.ts` pushes a `"command"` reason and `reconcile.ts`
  turns it into one `DROP …; CREATE …;`, measured at 4 steps / 0 unreconciled — so it was never the
  harder edit. And the narrowing is not wanted anyway: isolation must stay `ALL`, because a
  tenant-scope verdict is written under that tenant's context and the write grants are
  `PUBLIC`-scoped settings, so a write arm not ANDed with `tenant_id IS NULL` would be a cross-tenant
  insert route for anyone able to call `set_config`. So it is three arms beside one after all —
  isolation `ALL`, the read `SELECT`-scoped on `app.platform_audit` (gated on the flag, **not** on
  `tenant_id IS NULL`, because a platform-chain tamper verdict is the one row that must not be
  visible to every tenant's gateway), and the write `INSERT`-scoped on `app.platform_record_write`.
  The **record** grant and not the audit one, which is ADR-0332's rule read in the direction it has
  to be read here: a grant over the record must not reach the thing that validates the record, since
  a verdict names the chain entry it was committed to and one grant carrying both would let the
  appender certify its own appends. No `UPDATE` arm, because `verdict_id` is `aiv_` + the sha256 of
  the canonical report — changing any field yields a *different row*, so there is no stable handle to
  aim an `UPDATE` at, and an in-place edit would be ADR-0323's `scope_tampered` in the one table
  whose purpose is to be checkable against the chain.
- **The owner-dependent reads are swept, and "seven stores" was the package count** (ADR-0331,
  ADR-0332, ADR-0333). A table's owner bypasses RLS and connecting as the owner is an ordinary
  deployment, so a read leaning on RLS to confine it is correct as the owner and wrong as a
  non-owner **in both directions**. Thirteen tables needed a predicate across **fourteen store
  classes in seven packages**; fifteen of the platform-read tables have no store at all. Pre-fix,
  owner and non-owner diverged on **11 of 12** probes, and the damage was a **wrong scalar** rather
  than a long list: `latestForFramework("soc2_type2")` returned a tenant's *failing* SOC 2 report
  and answered "is this platform certifiable" with `false` while the platform's own passing report
  sat one row behind; `countBreachesSince` answered 3 where the scope's own count is 1, a 3× burn-rate
  input on the path that pages; `loadForIncident` *threw* on healthy data; and
  `summarize({tenantId: null})` typed its parameter `string | undefined`, so `null` reached
  `tenant_id = NULL` and returned `{total: 0, successRate: 1}` — **asking for the platform scope
  returned a confidently healthy empty answer.**
  Two spellings, chosen per table on one rule: **the predicate reproduces what a non-owner would
  have been shown, no wider and no narrower.** `scopeFilter` (strict `tenant_id = $n`) where a
  scope's rows are a closed set; `scopeFilterWithPlatform` (`tenant_id = $n OR tenant_id IS NULL`)
  where a platform row is *meant* to serve a tenant — a feature flag, a public key, a platform-wide
  workflow definition. Strict everywhere would have made these stores owner-independent by
  **destroying** documented behaviour rather than reproducing it, and the catalog says which is
  which: `idx_workflow_definitions_platform_key_version … WHERE tenant_id IS NULL` is the platform
  read arm written down, and the inclusive predicate plans as a **BitmapOr** over it.
  **The measurement to keep**: `IS NOT DISTINCT FROM` — the one operator matching NULL to NULL, and
  so the tempting single code path — *is* index-scanned with a **literal** NULL, because Postgres
  constant-folds it; with a **bound parameter**, which is how a store issues it, it is a sequential
  scan. Measured twice on 45k rows: 10.67 ms vs 0.73 ms, and 24.7 ms vs 1.7 ms. **The penalty is
  invisible in a psql session and real in production.** Branch.
  **Both of ADR-0333's open ends here are closed by ADR-0334, and the counts were wrong.**
  `scopeFilter` / `scopeFilterWithPlatform` / `assertScopeTenantId` now live in `kernel-pg`'s
  `connection.ts` beside `setPlatformWriteSql` and `isoInstant` — and there were **eight** copies, not
  six, two of them added by ADR-0333's own increment (`feature-flags-pg/kill-switch-store.ts`,
  `observability-runtime-pg/records.ts`). Each package re-exports from *the module that held the copy*,
  deliberately: every sibling already imports the rest of its scope vocabulary from there, and the
  **local** rationale — which spelling that package's tables want, and the measurement behind it —
  stays where a reader of that package looks. `dr-runtime-pg`'s guard is the one genuine divergence
  (a strict full-UUID regex) and stays a local wrapper delegating to the shared one.
  The **write** side is closed too: `classifyScopedWriteRefusal` distinguishes `row_absent` /
  `wrong_scope` / `guard_refused` from one zero-row result, re-reading the row **on the failure path
  only** and **with no scope predicate** — the question is whether the row sits in another scope, and
  a scoped read could only answer "absent". Six writes were measured taking a cross-scope row **as the
  owner, before the fix**: a tenant's feature flag *moved into platform scope* with its label and
  default rewritten, a kill switch moved and its releasing user overwritten (the four-eyes
  attribution the status guard exists to protect), a tenant's public key replaced through an
  `ON CONFLICT … DO UPDATE`, a tenant's key revoked, a DR execution advanced, and a `revoke` of an id
  that exists nowhere succeeding silently in **both** roles. As a non-owner the same flag update
  raised `FeatureFlagConflictError` saying *"another writer changed it first"* about a row no writer
  had touched — so the predicate does not create the ambiguity, it makes it reachable for the owner
  too, and the diagnosis resolves it for both.
  The writes are **strict** where the reads are inclusive, and that is the decision rather than an
  inconsistency: `tenant_id = $n OR tenant_id IS NULL` on a read is right (a platform flag is *meant*
  to be evaluated by every tenant's gateway), and on a write it is a route from a tenant's session
  into the platform's row — a tenant flipping `gateway.strict_jwt_aud`, the exact bypass ADR-0332
  separated `config` from `record` to prevent. The one correct use of
  `tenant_id IS NOT DISTINCT FROM` in the repo is inside `register`'s `ON CONFLICT … DO UPDATE WHERE`,
  where both operands come from one located row and no index is consulted.
  **`meta.workflow_definitions` is the exception that proves the rule and keeps the inclusive arm on
  its *write path*.** `planDefinitionPublication`'s `definition_id_reused` and
  `key_shadows_platform_definition` are **defined over cross-scope rows**, and `definition_id` carries
  a table-wide UNIQUE — so narrowing the publish *lookups* turns both named refusals into a raw
  `23505` from the INSERT, measured both ways. The narrowing happens **in the planner**, which filters
  `stored` on `s.tenantId === proposed.tenantId` before deciding, and in `updateRow`'s own predicate.
  That predicate was the third finding and is latent rather than live: `definitionUpdateAssignments`
  includes `tenant_id`, so a cross-scope match would *move* a platform-wide definition into one
  tenant, taking that workflow from every other tenant — prevented today by a conjunction across three
  modules, and now by the predicate, which also closes a real READ COMMITTED race against itself.
- **The split is reconcilable in one pass only because the isolation policy keeps its name**
  (ADR-0331, ADR-0332). `planSchemaReconciliation` creates new policies and **refuses to drop an
  existing one**, because dropping a policy loosens access (ADR-0290's invariant) and `allowLoosening`
  reaches foreign keys only — and permissive policies are **OR'd**, so until the old `DROP` lands a
  split buys *nothing*. So `feature_flags_tenant_or_platform` stays that name with a *narrowed*
  predicate, which is `replace_policy` — one `DROP …; CREATE …;` statement. Measured: **99 steps, 0
  unreconciled, zero manual SQL**, applied 100/100, re-plan clean. ADR-0331's two chain tables took the
  rename path and needed hand-run drops; that is what the 29 avoided, multiplied by fourteen. The cost
  is a policy whose name no longer describes it, and **there is no `renamedFrom` for a policy**.
- **A store that cannot write, or that drops every update, is now a test failure rather than a
  discovery** (ADR-0333). `packages/testing/src/strategy/pg-column-coverage.ts` reads `META_TABLES`
  and every store's SQL **as text** and asserts that each column an `INSERT`/`UPDATE`/`DO UPDATE`/
  `SELECT` names exists, and that each `notNull`-with-no-default column is named by every `INSERT`.
  Modelled on `typecheck-config.ts`: a rule enforced mechanically with its exemptions spelled out as
  lines. As text rather than by importing `@crossengin/kernel`, for two reasons that are both about
  not being conditional — kernel devDepends on `@crossengin/testing`, so an import would make the
  graph cyclic, and reading `kernel/dist` would make the result depend on whether someone ran
  `pnpm -r build`, which is the conditional green this file exists to abolish. It also checks the
  **second axis**: a table with a platform `INSERT` arm, against which some module emits an
  `UPDATE`, must have a platform `UPDATE` arm — mutability read from the existence of a writer, not
  from the store's shape, which is the inversion ADR-0332 got wrong. **An unparsed statement is
  reported, not skipped**, which is the property that matters: a scan with a silent "could not read"
  bucket would be the next member of this class. Coverage: 851 files, 220 statements, 63 of 145
  tables, 25 unresolved all accounted for by 19 declared gap lines. Replayed against history it
  finds every known member (`kind`; the activity store's six; the signal store's two; the flag
  store's `default_value`, **plus three `SELECT` sites a hand search had missed**); against the
  working tree it finds **nothing**, which after three accidental discoveries is the result.
  What it leaves: 82 tables have no SQL at all, so coverage is of what exists; twelve `SET` clauses
  rendered by a helper function are declared gaps, hand-verified once (resolving them means
  evaluating arbitrary functions); and `WHERE`/`RETURNING` columns are deliberately not checked,
  because `$n`, casts, aliases and `EXCLUDED.x` produce both misses and wrong hits without a parser.
- **An API key that names no principal is a `service_account`, and the id collision is unfixable**
  (ADR-0331). `buildPrincipalWiring` hardcoded `principalKind: "user"` for every API key while
  `parseApiKeySpec` defaulted the optional fourth field to one shared placeholder UUID — so a bare
  `key:role:tenant` claimed to be a person who does not exist, and *every* such key claimed to be the
  **same** person. One line, three defects: it satisfied every per-person surface's guard, the
  placeholder is not in `meta.users` so `notification_read_states.user_id` failed its foreign key
  (reported as a 503 for something permanent) and `actorForInstanceCancel` would have handed the id to
  `cancelled_by_user_id`, which has the same key — and two keys in one tenant would have *shared* read
  state, so one person's clicks marked another's notices read. `principalKind` is the fact now, and
  `namesPrincipal` carries it rather than a comparison against the placeholder (a spec may name that
  very UUID, and then it means a real user who holds it). The **collision itself is not fixable in the
  spec**: a bare spec does not carry the information to tell two keys apart, and the one thing that
  would — the credential — must not be hashed into an id, because a principal id is not a secret and
  lands in `meta.audit_log`, which would turn an audit reader into an offline brute-forcer. So it is
  *declared* rather than papered over; a deployment wanting per-person API keys must name the principal.
- **A composite foreign key is declarable but not reconciled** (ADR-0291, ADR-0299).
  `TableConstraint` has a `foreign_key` member now, but the emitter writes column-level foreign keys
  inline and unnamed, which is why ADR-0291 matches them *by column* — so a multi-column one in the
  database still reads as undeclared and is reported. Nothing in the catalog wants one yet.
- **Replacing an index rebuilds it** (ADR-0292), unavoidably — Postgres cannot alter a predicate, a
  column list or an access method in place. The plan names the step before it runs but does not
  estimate the cost. Relatedly, an expression is compared rather than understood, so two logically
  equivalent predicates written differently deparse differently and trigger a rebuild that was not
  needed: correct, not minimal.
- **Type changes on a populated table, and `NOT NULL` backfills, remain manual** (ADR-0291). The
  plan hands over the exact SQL for both; automating either means deciding what happens to existing
  rows, which is the one thing a migrator should not decide.
- **The kill switch's `flag_id` foreign key is addable but not added** (ADR-0300). `meta.feature_flags`
  now has the `flag_id TEXT` unique column ADR-0296 said was needed, and a store that *can* write it,
  which nothing constructs (ADR-0336). ADR-0300's stated reason for building the store —
  "the store is what makes the next drift fail loudly" — was **disproved by ADR-0332**: the store
  named `default_value` where the catalog said `default_value_json`, so it could not round-trip a
  single flag against any real database while every offline test passed. The assertion against
  `META_TABLES` is what makes drift fail loudly; the decision to build the store survives, its
  justification does not. The
  reference still stays off for a different reason: ADR-0291 will not add a foreign key it cannot prove
  every row satisfies, and the table is empty in every deployment — so declaring it would be correct on
  a fresh install and reported as drift on every existing one, forever. It becomes available once a
  deployment has flags.
- **Removing a foreign key from the catalog requires an explicit flag** (ADR-0296, ADR-0308, ADR-0328).
  `ReconciliationOptions.allowLoosening` turns the undeclared-foreign-key refusal into a real drop, which
  is what the four kill-switch `meta.users` references of ADR-0296 needed. It is off by default and
  reaches **foreign keys only** — not a column, table, index, policy or CHECK — because dropping a
  foreign key is the one loosening that cannot fail against existing rows, which is what keeps
  ADR-0290's invariant true. **`--allow-loosening` now reaches it** on both `crossengin apply` and
  `crossengin-pg apply`, announced on stderr before anything runs, since this is the one invocation
  that removes a constraint the database is currently enforcing. ADR-0296's drift can be cleared.
- **Six indexes now have no reader** (ADR-0296) — they existed to make `ON DELETE RESTRICT` cheap on
  the foreign keys that reconciliation removed. Left in place deliberately: removing them from the
  catalog would leave them reported as undeclared on every drift check until someone drops them.
- **A rename is declared, not inferred** (ADR-0308). `ColumnDefinition.renamedFrom` names the column the
  database may still hold this one under; `planSchemaReconciliation` emits the rename *first* for its
  table, so every later statement names the column as the catalog declares it, and it is planned on a
  populated table because no row is read. With **both** names live it refuses — nothing in the catalog
  says which holds the data. The annotation is history that accumulates: it must stay as long as any
  deployment might hold the old name, and nothing says when that is.
- **A unique constraint cannot carry a predicate** (ADR-0302). `UniqueConstraint` is `{name, columns}`,
  so a partial uniqueness rule has to be declared in `indexes` with `unique: true` instead — and the
  predicate cannot mention `now()`, since Postgres requires an IMMUTABLE index predicate. Promoting one
  to the other is reconcilable (the plan drops the constraint and creates the index in one statement) but
  it is a rebuild.
- **Declaring an SLO incident requires the database** (ADR-0293), which is itself the kind of outage
  an SLO breach describes. A failed declaration leaves the surface unopened and the next tick retries,
  so the page is delayed rather than lost; a failed close-out is not retried at all and leaves the row
  open. `FallbackIncidentDeclarer` (ADR-0304) now exists for the trade — an unpersisted record so the
  page still goes out — but only the integrity escalator uses it: an SLO breach has a working retry and
  does not need a possibly-colliding id, while a compromise finding is one-shot.
- **Adding a table constraint to a populated table is manual** (ADR-0299). `TableDefinition.constraints`
  can now declare a cross-column CHECK and the reconciler adds and replaces one, but only under the
  emptiness guard a type change uses — validating against existing rows means deciding what happens to
  the rows that fail. On a populated table the SQL is reported instead.
- **Truncation detection depends on checkpoint cadence** (ADR-0287). Tail removal is
  invisible to hash links, so `--integrity-proof-config` must run alongside
  `--checkpoint-config` or its truncation check has no witness — and entries written
  *and* deleted between two checkpoints leave no trace at all.
- **Four of 18 notification providers are implemented** (ADR-0301, ADR-0310) — SES, Twilio SMS, FCM push
  and Twilio Voice, plus `in_app`. A push payload **may not vary with the notification's content**:
  `pushPayloadViolations` checks that on every send and `send` refuses without calling FCM, because a
  push body renders on a lock screen through Google's and Apple's servers, and opt-in is consent rather
  than confidentiality. All four are built from the environment now (ADR-0328) — `FcmPushSender` from a
  key file or the GCE metadata server, `TwilioVoiceSender` from its own caller id — so the earlier note
  that FCM needed an `FcmAccessTokenProvider` env vars could not express is closed. One platform-wide
  credential set per provider remains, so every tenant sends from one domain and calls from one number.
  Both ends of the loop are wired for all four since ADR-0329. The **page** SMS
  transport (ADR-0326) is a fifth Twilio client and deliberately not this one: it takes its own
  `PAGE_SMS_*` credentials and bypasses preferences, suppressions and quiet hours, which is the whole
  point of a page.
- **A suppression names the provider, and `applied_by` stays nullable** (ADR-0302, ADR-0309). The column
  is now TEXT holding `user:<uuid>` / `system:<slug>` / `provider:<slug>`, structured rather than free
  text because `manual_block` must name a *human* and free text would let `system:ses` satisfy that; the
  bounce webhook writes `provider:ses` / `provider:twilio`. It is still nullable, which is the one place
  we did not tighten: every row written before this was NULL, and requiring an actor would make the
  re-parse-on-read replayer refuse rows that were correct when written.
- **Both suppression readers now fail closed** (ADR-0302). `PostgresRecipientResolver.activeSuppressions`
  used to skip an unparseable row, which mailed the address the row existed to protect; it throws now,
  naming the id and never the address. The cost is bounded by design — `drainAllTenants` catches per
  tenant and continues, so one bad row stops one tenant's sweep and retries, rather than taking delivery
  down platform-wide.
- **Suppression addresses are normalised upstream, in `planSuppression`** (ADR-0302), not in the store —
  the id commits to the exact address, so normalising at write time would make it a lie.
  `normalizeRecipientAddress` folds case per channel (lowercasing an email's local part despite RFC 5321
  §2.4 making it formally case-sensitive, because no production provider distinguishes them and the
  alternative is a row that never matches) and deliberately does **not** collapse subaddressing or parse
  a display name off, since both would widen a suppression to addresses that never bounced.

- **Both ends of voice are wired now** (ADR-0310, ADR-0327, ADR-0328, ADR-0329).
  `buildSenderRegistryFromEnv` constructs `FcmPushSender` from a service-account key **or** from
  the GCE metadata server (`FCM_CREDENTIAL_SOURCE=metadata_server`, declared rather than probed), and
  `TwilioVoiceSender` from `TWILIO_VOICE_FROM_NUMBER` plus the SMS account's credential. Partial
  configuration is still skipped rather than guessed, per ADR-0301, and a refusal costs that channel
  and never the boot — the live state for all four: `in_app, sms, voice_call, push_mobile`.
  ADR-0329 closed the other end: `twilio_voice` is the bounce webhook's third source, the sender asks
  for one terminal callback instead of four, and a missing callback URL is warned about. ADR-0332
  closed the **`fax` verdict**: a *run* of consecutive `fax` answers can suppress, over
  `meta.notification_fax_observations`, which is the state ADR-0329 said a pure module does not hold.
  Opt-in and off by default, because ADR-0302's rule is that a safety record must never widen on an
  inference and `AnsweredBy` is a detector's guess from a few hundred ms of audio; a threshold of 1 is
  **refused by name**, and a single answered call **deletes** the run rather than decrementing it,
  since an absent row and a run of zero are the same fact. The counter performs its rule in one
  `ON CONFLICT … DO UPDATE` (a read-modify-write loses its race in the direction that *advances* a run,
  which is the direction that writes a permanent block), requires `CallSid` because Twilio retries a
  non-2xx callback and a counter has none of a suppression id's natural idempotency, and **warns at
  boot when `TWILIO_VOICE_MACHINE_DETECTION` is unset** — `AnsweredBy` arrives only then, so a
  threshold configured and structurally unreachable is the exact silence that increment was about. What
  it leaves: a fax suppression can be imposed once per address and **never lifted automatically**, and
  no route reads the observation row, so the evidence for a permanent block is only in a log line and
  the suppression's `notes`. Also still one platform-wide credential set per provider, so every tenant
  sends from one domain and calls from one number.
- **Per-tenant column schemas are additive only** (ADR-0314). A removed field's column is never dropped,
  a changed type is never altered, and ADR-0308's rename machinery does not reach there. A **refused**
  application is loud in the log and silent to the tenant: they are served from the JSONB fallback, so
  their data is in a different place than they think until an operator runs the reported SQL.
- **A tenant deletion is atomic, reachable, and now also asynchronous**
  (ADR-0316 – ADR-0321).
  `deleteTenantAtomically` runs erase → attest → assemble → anchor → store in **one transaction**, which
  Postgres allows because DDL is transactional (`probeCascadeCollateral` already depends on it). The
  guarantee: **no outcome destroys a tenant's data without a stored, anchored, verified tombstone
  describing it — either both, or neither.** It does not make the deletion reversible; the *commit* is
  all-or-nothing. An erase refusal is returned (nothing was dropped); an assembly refusal **throws**, so
  the drop rolls back rather than committing a deletion with no record. The erasure measures exactly what it destroys, refuses a cascade that would reach
  another schema (observed by trial-and-rollback, not inferred from `pg_depend` — which was wrong twice,
  in both directions), and confirms absence before it commits. `assembleTombstone` then composes a
  `DeletionScope` **only** from per-subsystem attestations and refuses when a subsystem in scope has not
  attested, because the original defect was a subsystem nobody asked whose silence read as nothing to
  delete. **The scope is no longer caller-supplied** (ADR-0328): `DeletionCapabilities` is declared once
  per deployment through `--deletion-capabilities`, and both the synchronous route and the runner refuse
  to mount without it. That closed a defect worse than the one it was meant to close — the route read
  `requiredSubsystems` from the **request body** with `[]` as its default, so a remote caller chose how
  much of the deployment its Article 17 proof covered and omitting the field covered nothing, while the
  runner's `?? []` did the same unattended on every scheduled deletion.
  **Two of the six subsystems perform a real erasure now** (ADR-0329): `shared_tables` joined
  `tenant_schema`, which closes the worst of what ADR-0328 left — 112 of the 143 `META_TABLES` carry a
  `tenant_id` and nothing erased one of them, so every deployment declared it `absent` and signed a
  proof over data that was still there.
  **And `shared_tables` reaches the boot manifest's own entity tables since ADR-0350**, which it did
  not, so on `--store pg-columns` nothing erased a tenant's records: the catalogued half is `meta.*`
  and the schema erasure only drops a `t_<hex>` schema a boot-manifest tenant does not have. Live, the
  two faces of that — a tenant holding any erasable platform row got a signed anchored `v3` tombstone
  naming only `meta.operate_tenant_settings` while `public.patient` kept its PHI, and one holding none
  got `assemble/scope_empty` saying *"there is no deletion to attest"*. Both are closed, and
  `scope_empty` is now an honest predicate rather than an accidental fence. What that entry leaves is
  below, under **The boot-schema erasure**. **And a declared absence is inside the signed bytes**, as
  `crossengin.tombstone.content.v2`, so "we have no object storage" is part of the claim rather than a
  note beside it. What remains: the other **four** still cannot attest because their erasures do not
  exist, so a deployment declares them `absent` — honest, and now *in the proof* rather than merely
  visible on the assembly — or `erases`, which refuses every deletion until the erasure exists.
  Statutory retention of business records is still **not expressible**: a subsystem attests exactly one
  outcome, so `shared_tables` cannot say "erased these 94 and retained invoices under a 7-year
  obligation", and the retention set is defined as *not the tenant's data at all* precisely so the
  attestation can be `erased` without lying. `storageBytes` for shared tables is tuple bytes only,
  exclusive of index and TOAST overhead, and there is a window between the confirm-absence pass and the
  commit in which a concurrent writer for the tenant could insert a row — no advisory lock closes it,
  only quiescing the tenant does. The ordering against `meta.tenants` is
  **unenforced**: the audit record's `tenant_id` is a foreign key to that table, so retiring the tenant
  row *first* makes every erasure unrecordable — the 500 fires, visibly, and the data is gone with no
  provenance. Erase, record, then retire the row.
  **A stranded request is now reconciled from evidence** (ADR-0322) — `DeletionReconciler` asks whether a
  tombstone names it, which is conclusive because both commit together — but only the *conclusive* half is
  automatic. `never_committed` is an inference from an absence and still needs a human to authorise it
  through `POST .../{id}/reconcile`, and `ambiguous_evidence` is never applied at all. **And a scope tamper
  is invisible to the forensic chain** (ADR-0323): nothing in the chain commits to the scope, so editing it
  leaves every digest and the chain entry byte-identical. `verifyStoredEvidence` catches it, refuses to
  complete a request from it, and (ADR-0324) declares a paging `sev1` for it — the finding the chain
  cannot raise now has the alarm the chain cannot provide, one incident per request and cancelled on
  recovery. **Graded per defect** since ADR-0326 (`severityByDefect`, highest wins, keyed on the real
  `EVIDENCE_DEFECTS` enum so a typo is a parse error rather than an override that never matches), with
  the escalation and its recovery each leaving an anchored `platform.deletion_evidence_escalated` /
  `_resolved` row carrying the grade, the defects and the verdict; and `auditCompleted` runs on a
  schedule (`--deletion-audit-every-ticks`) rather than only when a human loads `GET .../unproven`.
  **And ADR-0327 closes the last hole in that audit**: a tombstone with no `relatedDeletionRequestId` —
  every one the synchronous route of ADR-0320 writes — was outside *both* directions, because both start
  from a request. `auditTombstones` starts from the proofs instead, over a keyset-paged `scanAll`, and it
  found a real unreferenced `scope_tampered` row on the first live run. **Those findings now escalate**
  (ADR-0328), on the rule "one episode per evidence record, whichever handle names it": a tombstone a
  request names keys on the **request**, so the sweep adopts whatever `auditCompleted` already declared
  rather than declaring a second for one tampered row; one no request names keys on
  `deletion_evidence:tombstone:<id>`, namespaced so it cannot collide with a request id; and a
  `dangling` finding keys on the tombstone, because nothing can adopt an episode for a row that no
  longer exists. The sweep also reports its **laps** (`sweepProgress()`), since "every stored proof has
  been verified since ⟨time⟩" is only true per completed lap, with `pagesAdvanced` / `pagesSwept` as the
  pair that distinguishes "pages are not arriving" from "pages arrive but the cursor is pinned".
  `meta.tenant_tombstones` also gained the index `findForRequest` had always lacked, partial because the
  column is NULL for exactly the rows that can never match a lookup by request id.
  **ADR-0329 closes both of those**: `verifyTombstone(id)` is the targeted re-read that substantiates a
  recovery, with `absent` as its own outcome closing nothing — a deleted proof is not a verified one,
  and it is exactly the fact a naive "it stopped appearing" check reads as recovery — and the stall
  detector reads the cursor. **A stall escalates now** (ADR-0330), at `sev2` and keyed per surface.
  ADR-0332 closed the kind flip: the episode's current kind is **read back off its incident's
  timeline** rather than remembered in the process, so a flip is detected after a restart and by a
  different replica, and a note lands once per actual change rather than once per tick. The recovery is
  still **edge-triggered in process**, so a
  server that stalls, restarts, and then recovers never fires it and the `sev2` stays open for a human
  — the fail-closed direction, and the same limitation ADR-0326 accepted for the SLO resolve. And the
  stall incident cannot be turned off independently of tamper escalation: a deployment wanting one and
  not the other has to point `sweepStallSeverity` at a grade its `alertPolicy` does not route, which
  suppresses the page and not the incident.
- **A page now really leaves the process, and closes itself when the finding is put right**
  (ADR-0325, ADR-0326). `PageDispatcher` delivers over PagerDuty, Slack, a signed webhook and SMS, and
  **reports** rather than throws: `delivered === 0` is `undelivered`, logged at error, because the
  incident is already durable. It retries a `failed` page three times two seconds apart (the dispatcher's
  budget, not a sender's), records every attempt to `meta.audit_log` as `platform.page_delivered` /
  `platform.page_undelivered` — two operations, so the failure is directly countable — and **resolves**
  the alert when a recovery closes the record out.
  The rule that took two tries: **a resolve reaches exactly where its trigger did, or it closes
  nothing.** `AlertPolicy` maps a severity to a channel set, so the grade *is* the route, and each
  escalator answers "which grade" from the only source that can be right for it — the deletion escalator
  reads `open.severity` off the record (it grades per defect), the integrity escalator uses
  `config.severity` (one grade for every compromise), and the SLO loop remembers the directives it
  *actually delivered*, because a `recovered` decision carries no severity and nothing to re-plan from.
  `closeOutClosesAlert` (beside `INCIDENT_CLOSE_OUTS`, one definition and three callers) gates all of it:
  `cancelled` and `unpersisted` close the alert, `human_owned` and `failed` do not — an alert left up is
  noise, an alert wrongly closed is silence. And the record's tenant is **supplied by the caller**, since
  ADR-0325's own content rule means a `PageDeliveryReport` carries none and so a `tenantIdFor(report)`
  resolver has nothing to resolve from.
  **All six of ADR-0326's open ends are closed by ADR-0327.** A page is appended to its incident's
  timeline as a `paged` entry, which was the record that still landed when the audit row *could not* —
  an SLO surface is never a tenant and `meta.audit_log.tenant_id` was NOT NULL, so for that escalator
  the row was structurally impossible and the timeline has no tenant column to lie about. (ADR-0331
  made the row possible; the timeline note stays, as the half that survives an unreachable emitter.)
  The retry honours
  `Retry-After` (`max` with the policy's floor; over the 30s ceiling it stops rather than holding a
  page past the point where it is still a page). And a resolve for an episode this process did not
  page is recovered from the store through the declarer's new `findById`, planned from the record's
  own severity — remembered beats recovered, because the remembered directives are what actually went
  out, and all three ways of not knowing answer `[]`, which leaves the alert up for a human.
  **ADR-0328 closes the last three of ADR-0327's open ends**: the retry grows and jitters, bounded by a
  total budget; `assertAppendOnly` moved to `records.ts` so `appendPagedNote` passes it too; and the
  store has an injectable clock. A throw is deliberately *not* given its own cadence — all three HTTP
  senders catch their own transport failures and report them as **results**, so a timeout never reaches
  the dispatcher's `catch`; what does is a sender that broke its contract, and a special cadence would
  go to a bug rather than the network failure it was written for.
  What is left: the jitter spreads load rather than shedding it — the
  call count is unchanged, and a `Retry-After` longer than the jittered gap re-synchronises every
  replica it binds, accepted because the alternative is holding a page longer than the provider asked.
  There is also no tooling to *resolve* an unverified tombstone (the attestations beside it are enough to
  recompute what the scope should have been, but rewriting a proof is not something to automate blindly),
  and a tombstone with no `relatedDeletionRequestId` — every one the synchronous route of ADR-0320 writes —
  is outside both directions of the audit. A request is also submitted for a *tenant*, not for a subject
  within one: `subjectIdentifier` is recorded and not acted on, so a single data subject inside a
  multi-user tenant cannot be erased by this path at all.
- **The AI cost estimator is a heuristic on the input side** (ADR-0311, ADR-0330). `maxTokens` bounds
  the output by construction; the input is a character count at `ESTIMATED_CHARS_PER_TOKEN = 3.5`,
  raised by a script-aware scan where that under-counts. The correction is **durable** now and
  relaxes per observation rather than on time, and `classifyDesignOutput`'s split finally *acts* —
  a wrong answer is not retried. What is left: the ratios are heuristics and **no tokenizer was
  consulted**, so `other_script` lumps Cyrillic with Devanagari and Latin Extended is over-counted
  (the safe direction, not the minimal one); a per-provider override is still unaddressed; the
  relaxation rate (0.9 per observation) and the cap (100x) are defensible and arbitrary, and nothing
  reports the distribution of observed ratios that would let a deployment tune them; the mark is
  per *tenant*, not per prompt shape, so a tenant alternating a tiny English prompt with a huge CJK
  one gets one factor and the CJK one pins it; `observations` is written and nothing reads it; and the
  retry never rewrites the prompt — `runDesignWithRetry` re-calls the same attempt, so the corrective
  machinery staying in `ai-design.ts` means a caller that does not append one collects the same
  failure three times.
- **The audit emitter's flag list is gone, because it was wrong three times** (ADR-0288, ADR-0313,
  ADR-0321, ADR-0327). `needsAuditEmitter` enumerated every flag whose feature writes an audit row.
  ADR-0288 was the first miss; `--audit-read-routes` the second, found by booting the real server; and
  the third got through the per-flag test added after the second — `--deletion-escalation-config` was
  listed **in the test** and **absent from the predicate**, and the test passed because the parser
  happens to turn `--deletion-request-routes` on alongside it. A per-flag test over a hand-maintained
  list cannot catch a flag missing from both copies of itself. So `auditEmitterAvailable` is now
  `store === "pg"` and nothing else: constructing the emitter is an object allocation, so gating it
  never bought anything, and a feature added tomorrow cannot omit itself from a list that does not
  exist. Removing it exposed four `auditEmitter === null` branches that could never fire, three of
  whose messages claimed `--audit-chain-config` was *required* when it was not; two surfaces now warn
  that their rows will be **unanchored** and mount anyway, which is ADR-0322's rule rather than a
  refusal that never fired. That remains the lesson: a surface that degrades rather than refusing has
  to say so out loud.
- **`failed` is both terminal and compensatable** (ADR-0307). It is in `TERMINAL_INSTANCE_STATUSES` and
  `INSTANCE_TRANSITIONS.failed` is `["compensating"]`, so `isInstanceTerminal` answers "done" for a status
  the map says you may still move. Deliberate for sagas, but the two disagree; a test pins the exception
  rather than resolving it, because which side should change is a lifecycle decision.
- **`apps/operate-web` uses its own tsconfig rather than the typecheck overlay** (ADR-0307, corrected).
  It *is* a workspace member and `pnpm -r typecheck` does run it — the earlier claim that it did not was
  wrong. It has no `*.test.ts` files, so there is nothing for the overlay to put back; a test added there
  would not be covered by ADR-0307's rule. Its `npx next build` stays separate because that checks the
  Next build, not the types. The rule itself is now **enforced**:
  `packages/testing/src/strategy/typecheck-config.ts` asserts against the real workspace that every
  package with a `src/` has the file, extends **both** bases, and runs the one script — with the two
  exemptions spelled out as lines, so adding a third is visible in a diff.

**Contained**

- **A cron timer recurs on one row, and what that row still cannot say** (ADR-0334). `fire_count` and
  `next_fire_at` were declared on `meta.workflow_timers` and never written, and a re-arm reset the
  count — so a cron timer fired exactly once and the replayer could not tell a stopped one from a
  healthy one (`timerProjectionSignature` compares `status|fireCount|nextFireAt` now).
  `TIMER_TRANSITIONS.fired` stays `[]` deliberately: recurrence is a **kind** property, so a status
  edge would be false for three of four kinds — which resolves the two axes rather than pinning a
  contradiction, the contrast with ADR-0307's `failed`. The claim is released **exactly when
  `fire_count` advances**, not when the projected status is `scheduled`, because `ProjectingEventLog`
  re-projects every timer on every append and a status-keyed clause would steal a live claim from a
  worker mid-fire. DST is decided per case from this runtime's tzdata: a spring-forward schedule at a
  local time that does not exist **skips that day**, and a fall-back one at a doubled local time
  **fires twice**. An unresolvable timezone is **refused at publication** (`timezone_unresolvable`),
  because `cronNextAfter` silently falls back to UTC — a schedule running on a zone nobody declared,
  in the table the schedule is read back from, is ADR-0331's `delivery_guarantee` argument.
  What it leaves: `nextFireAt` is one occurrence ahead and never two, so the row cannot show a cadence
  while it sits `scheduled`; a cron timer on an instance that terminates in the same fire keeps its
  computed `next_fire_at` as a record and nothing cancels the row (it is `fired`, so no worker claims
  it); `business_hours` is **refused by name** because `isWithinBusinessHours` needs a working-day
  configuration that exists nowhere in the contract, and declaring it means a
  `crossengin.workflow.definition.content.v2` tag; and the same silent-UTC fallback still reaches
  `scheduledJobsDue`, because `JobDeclaration` has no publication-time check. `cron.ts`'s
  per-minute `Intl.DateTimeFormat` construction (314× measured) is mitigated only at the timer layer,
  by mapping the seven UTC-equivalent zone names to `undefined`; a genuinely zoned sparse cron still
  pays, and the fix is a cached formatter on `ParsedCron`.
- **Four self-references in a workflow definition are checked now, three cannot be** (ADR-0334). The
  line drawn: *a reference whose declaration site exists in this document is checked; one whose site
  lives in another document, or does not exist in the contract at all, is reported.* Checked and
  digest-neutral (verified by computing both schemas' digests over the same raw definitions in a
  throwaway worktree — identical for everything still accepted): `schedule_timer`'s and
  **`cancel_timer`'s** `timerName`, `set_variable`'s `variableName`,
  `TimerDefinition.absoluteTimestampVariable`, and that `cronExpression` parses. Not taken:
  **`activityKey`** has no declaration site at all (ADR-0333's missing `ActivityDefinitionSchema`), and
  `childDefinitionKey` / `spawn_child_workflow` resolve against *another* definition. Held back:
  `SignalDefinition.correlationVariable` *does* have a site and is unchecked, but a correlation key
  legitimately arrives in `startInstance`'s input, and that question was not settled. The cost is on
  the other side and is real: four shapes the schema used to accept are now refused, and **the
  engine's own test fixtures were in those shapes and had never been parsed** — `definitionFixture()`
  declared `timers: []` while carrying a `timer_fired` trigger, which `WorkflowDefinitionSchema` has
  *always* refused. 31 engine tests broke on the fix; all were invalid fixtures.
- **A `datetime` crosses the wire as `toISOString()`, uniformly** (ADR-0334) — fixed width 24, always
  `Z`, always three fraction digits, so byte order **is** chronological by construction. Convergence
  rather than invention, as with ADR-0332's `decimal`: it is what every server writer already emits and
  what `isoInstant` produces. `date` is `YYYY-MM-DD` and `time` is Postgres's own `TIME` output. An
  **offset** is normalised (`TIMESTAMPTZ` does not retain it either, so the canonical form holds the
  same value); **sub-millisecond** precision is a 422 from a client and truncated at the store
  boundary, ADR-0332's provenance split; an instant with **no offset** is refused in both directions,
  because Postgres reads it in the session `TimeZone` and ECMAScript in the process's local zone, so it
  names no instant. Nothing goes through `Date.parse`, which succeeds on `"2026"` and fails on
  `"…T19:00:00+09"` that Postgres accepts. `checkType` is a **total map** `FIELD_TYPE_CHECKS` over
  `PrimitiveFieldType["kind"]` now, asserted against the schema's own options: three of the 14 kinds
  that defaulted to `acceptAny` are closed and the other **11 remain as eleven visible lines** rather
  than an invisible fall-through. `"0x10"`, `"0b101"`, `"0o17"`, `true`/`false` and `[5]` stop being
  accepted as numbers (`Number()` coerced them); `" 10.25 "`, `"+10.25"` and `"1e3"` still are.
  `datetime` gets a `timestamptz` `ListValueType` with a guarded cast; **`date` and `time` do not**,
  measured: `date_in`/`time_in` are `STABLE`, so `(text)::date` cannot back an index *and*
  `'01/02/2026'::date` is 2 January under MDY and 1 February under DMY, while their canonical
  spellings already sort as text. **The guard is the sharp part**: a regex alone is not total — seven
  classes match an ISO-ish pattern and *raise* on `::timestamptz` (`2026-02-30`, `2026-02-29` in a
  non-leap year, month 13, minute 60, offset `+99:00`), and **one such legacy row makes every page of
  that entity a 500**, because the sort evaluates the cast on every candidate before `LIMIT`. A regex
  cannot exclude a day beyond its month's length without a leap-year parser in it, so the guard asks
  Postgres for that one conjunct (`EXTRACT(MONTH FROM make_date(y,m,1) + (d-1)) = m`) inside a nested
  `CASE`, because a flat `AND` does not guarantee operand order. `pg_input_is_valid` would be the right
  guard and arrived in PG 16 against a floor of 14; a tripwire test asserts `MIN_POSTGRES_MAJOR < 16`.
  What it leaves: a `datetime` list key is **unindexable by construction**, so a deployment wanting one
  needs a generated column; `DATETIME_SQL_PATTERN` and `parseInstant` are two spellings of one set that
  disagree, so `isDatetimeSqlSafe` must not be used as a SQL guard on its own; and `matchesFilter`'s
  `eq`/`ne` NULL semantics still diverge from SQL, deliberately left.
  Three further defects were found live and fixed in passing: `created_at`/`updated_at` defaulted to
  `now()` (microseconds) while node-postgres yields millisecond `Date`s, so the cursor re-admitted the
  row it came from and a `limit 2` walk **never terminated**; the NULL tail was dropped on every
  ascending walk on both stores; and a forged or `''` cursor component **raised** on the column store,
  where it now reads as the NULL tail.
- **`duration` is refused at plan time, by name** (ADR-0334), not at the first read — which turns
  "serves every other field and 500s on page 1" into a boot failure naming entity and field. A seconds
  count is lossy (`interval '1 mon'` has no fixed second count); an ISO string is lossless but is not
  an ordering key (`PT2H` sorts before `PT10M`) and `interval_in` is `STABLE`, so a guarded cast is
  unindexable *and* `IntervalStyle`-dependent; `interval 'P1M' = interval 'P30D'` is **true**, so
  `interval` is not even a total order on the wire values; and `interval '-PT1H'` raises. What would
  unblock it is a different *field type* (`{kind: "duration", unit: "seconds"}` → `BIGINT`, already
  covered by `numeric`), which is a kernel change. Nothing in the catalog or the seven packs declares
  one. A plan throw would bypass ADR-0314's JSONB degradation, so
  `applyTenantManifestSchema` catches it and reports a blocking `unservable_field_type` change — same
  fact, two situations.
- **`meta.workflow_timers` still accepts a row its contract forbids** (ADR-0333's Option C): a
  `cron_schedule` row with a NULL `cron_expression` commits cleanly. ADR-0334 makes it unreachable
  from the write path, since the kind and its parameter now come out of one `TimerDefinition` — the
  cheaper half of the same guarantee. It is a *tightening*, so it is exactly the case ADR-0363 does
  **not** wave through: the table carries no live constraint on the pair, so `predicate_implied_by`
  has nothing to imply from and answers `not_implied`, and the declaration is reported as
  `constraint_widening_unproven` with the SQL — which **will succeed** on a deployment whose timers
  were all written after ADR-0334 made the offending row unwritable. So it is standing manual SQL
  still, by design, and the finding now says so by name with the statement attached rather than
  leaving an operator to discover it.

- `dispatched_at` is still unused (ADR-0277). A read state can be **stored** since ADR-0330 and no
  route wrote one until ADR-0331, which added the three read-state routes — so the inbox can mark a
  notice read over HTTP now; nothing reads the *template* audit trail over HTTP still (ADR-0279). The store also found both read-state tables had
  drifted (`dispatch_id` UUID against a `disp_…` contract) and **their column CHECK did not reach an
  already-applied database** — caught by this same increment's column-check comparison, which is the
  tidiest demonstration of why that hole mattered. A platform-scoped audit read is recorded against the reader's own
  tenant, because `meta.audit_log.tenant_id` is NOT NULL, so a reader with no resolvable tenant cannot
  read at all (ADR-0313). Per-class sensitive grants are expressible now
  (`--audit-read-sensitive-class <class>=<role>`, ADR-0329), and `--audit-read-sensitive-role` remains
  the wholesale form, reaching only classes no `=` entry names. A job handler that ignores its
  `AbortSignal` runs to completion and commits its effects while the run records `cancelled`; the
  guarantee is deliberately phrased as "no further work will be *started*" (ADR-0315). A **workflow
  instance** can be cancelled over HTTP since ADR-0331, which answered ADR-0330's open question —
  definitions are **authored, not compiled from a manifest**, because every manifest workflow in the
  catalog is `entityLifecycle` (19 in core, 1 in healthcare, zero orchestration or scheduled) so a
  compiler had zero valid inputs, the other two kinds carry `z.unknown()`, and `createdBy` plus
  `publishedBy !== createdBy` would have needed two fabricated constants differing from each other.
  `workflow-worker`'s three workers are mounted behind `--workflow-workers` since ADR-0333, so a
  due timer fires and a deferred activity runs; the **job** worker still refuses
  (`no_job_handlers`), because nothing in this process registers a handler. Entity lifecycle
  transitions are a different mechanism and work. An in-flight activity is only `signalled`, and `signalDelivered` is `false`
  when its handler belongs to another process: nothing propagates the abort across a process boundary.
  A `child_instance` is `not_cascaded` by design, and side effects with no compensation key are
  reported by neither disposition. `ESTIMATED_CHARS_PER_TOKEN` under-counts for CJK,
  which is the unsafe direction for a ceiling (ADR-0311). A per-route request-body limit exists since
  ADR-0331 (`--max-request-body-route`, longest prefix wins); a per-**tenant** one is still
  unaddressed, and the default remains platform-wide (ADR-0312). A refused DDL application is invisible to the
  tenant — they are served from the JSONB fallback rather than the tables they asked for (ADR-0314). A
  refused erasure leaves an operator to drop the collateral by hand; the refusal names it but does not
  hand over the SQL the way ADR-0290's `unreconciled` does (ADR-0316).
- A tombstone-sweep **lap** is the coverage guarantee, so a tamper is found within one pass of the
  table rather than at once (ADR-0327); `sweepProgress()` reports the lap and the stall, and a stall
  declares a `sev2` keyed per surface (ADR-0330) whose current kind is read back off the incident
  timeline (ADR-0332).
  A revoked FCM key can still 401 once before the cached token is discarded. The delete route parses
  `attestations` through the real `DeletionAttestationSchema` now rather than a loose mirror plus a cast
  (ADR-0329) — which immediately caught something the mirror accepted, an `erased` attestation reporting
  no scope at all; the loose mirror survives on the **read** side only, where a stored row that no
  longer satisfies its contract is a finding for the audit path rather than something a display route
  should refuse. `.prettierrc.cjs` at the root re-exports the workspace config, so a bare
  `npx prettier --write` no longer reformats at width 80 — but **983** of `packages/*/src` (and
  **1687** repo-wide) are not Prettier-clean (the config existed since Phase 1 and was never
  applied), so there is deliberately no
  `format:check` script. `FCM_TOKEN_ENDPOINT` and `FCM_BASE_URL` are in `FCM_VARS` since ADR-0330, so
  an endpoint override with no `FCM_PROJECT_ID` warns like every other half-configuration instead of
  skipping push in silence.
- **A retained claim is inside the signed bytes as of `crossengin.tombstone.content.v3`**
  (ADR-0330 found the gap, ADR-0331 closed it — see that ADR's addendum, which exists because the
  work shipped in its commit and its own text omitted it). `contentManifestSha256` used to commit only
  to the composed `DeletionScope`, so `retainedReason` / `retainedDataReference` /
  `retainedObligations` were in **neither** digest and a stored proof's retention prose could be
  edited with both digests and the chain entry byte-identical — ADR-0323's `scope_tampered` in a third
  place, on the one sentence a regulator reads. v3 carries
  `retentionClaim: {obligations, retainedReason, retainedDataReference}` with **explicit `null`**
  rather than an omitted key (`canonicalStringify` drops `undefined`, which would render the empty
  claim and a *stripped* claim identically) and **no figure of any kind**, since a `DeletionScope`'s
  numbers mean "destroyed". `crossengin.tombstone.proof.v1` is unchanged for all three versions.
  "Nothing retained" and "retention not covered" are separated in three agreeing places: the bytes
  (`{"obligations":[],null,null}` is a *signed* assertion no v1/v2 digest can express), storage
  (`retained_obligations` nullable with **no default** — `NULL` is "not covered", `'[]'` is "signed as
  nothing kept"), and the reader (`readRetentionClaim`'s `unknown_not_in_proof` arm carries no list at
  all, so there is no empty array to mistake).
  What it leaves: **v1 and v2 records on file are permanently unprotected** in this respect — nothing
  can retrofit them, and re-signing them under v3 would forge the one alarm the chain cannot raise.
  `tombstoneMatchesAttestations` deliberately does not compare the prose (wording and array-order
  dependence would false-positive into a `sev1` page), so for these fields **the v3 digest is the only
  detector**. And the claim is signed while the **per-table obligation pairing** is not:
  `sharedTableRetention` flattens to a list of obligations plus one `dataReference` string, so a proof
  naming two obligations over three tables does not say which is under which — closing that needs a
  structured `retainedData: [{table, obligation}]`, i.e. a **fifth** tag (`v4` went to ADR-0351's
  record-storage declaration, and the two are independent keys rather than one edit), and it is
  vacuous today because both statutory entries share one obligation. ADR-0330's expectation that a second obligation on the
  pure `retained` outcome would be "refused by `DeletionAttestationSchema`" was **wrong**:
  `retention.obligations[0]` builds a valid attestation, so the second was never written down rather
  than rejected, and the proof would have named one lawful basis for data held under two. That is a
  loud refusal in `sharedTableErasureAttestation` now.
- **`meta.invoices` is the platform's billing *of* the tenant, not the tenant's own books**
  (ADR-0330). The tenant's ERP invoices live in their own schema and `operate_entity_records`, both of
  which are erased — so a tenant with a seven-year obligation over *their* sales invoices gets no
  protection from the statutory set. The mechanism is expressible now; only the platform's own tax
  records use it.
- **A deleted tenant's retained rows are readable by anyone who can set that tenant's context**
  (ADR-0330). RLS confines them per tenant, but the predicate has no status clause and credential→
  tenant resolution is stateless — the token carries the tenant id and nothing consults
  `meta.tenants.status`, so a credential issued before the deletion still resolves. Latent rather than
  live: `meta.invoices` has no wired store in `operate-server` and `meta.tenant_credits` has no reader
  anywhere, so there is no reachable read path today. One wiring step away from being one.
- **A `TIMESTAMPTZ` read back from node-postgres is a `Date`, and the comparison idiom assumed a
  string** (ADR-0330). `compareInstanceProjection` compared six timestamp columns with `!==` against
  ISO strings, so the workflow replayer reported drift on **every healthy instance** that had any of
  them set. Fixed with one normaliser, and the stored row's timestamps typed `unknown` so the type
  system stops asserting something false. The offline fakes hand back strings, which is exactly why no
  test caught it. **It was not unique to that replayer, and ADR-0331 swept the class** after measuring
  what node-postgres really returns: `TIMESTAMP`/`TIMESTAMPTZ`/`DATE` → `Date` (and `DATE` parses to
  **local** midnight, so `toISOString().slice(0,10)` answers `2026-01-31` under `TZ=Asia/Tokyo` for
  `'2026-02-01'::date`), `NUMERIC`/`BIGINT` → **string**, `INTERVAL` → a `PostgresInterval` whose
  `String()` is `[object Object]`, `JSONB` → parsed, `BYTEA` → `Buffer`. The fact that made it more
  than a type lie: **Postgres refuses to parse its own `Date.toString()`**. So
  `ColumnMappedEntityStore.rowToRecord` — which passed values through raw — put a `Date` into a keyset
  cursor via `String(value)`, and page 2 raised `invalid input syntax for type timestamp with time
  zone`. Reproduced live, across 21 `auditable` pack entities plus 43 `date` and 23 `datetime` fields;
  the two implementations of one `EntityStore` disagreed, because `PostgresEntityStore` reads the same
  value out of JSONB where it is already ISO text and *its* page 2 works. Four defects fixed
  (`column-store.ts`, `idempotency-store.ts`, `route-registry.ts`, `event-log.ts`) plus one latent, with
  **one normaliser** — `isoInstant` / `requireIsoInstant` / `isoCalendarDate` in `kernel-pg`'s
  `connection.ts`, the module that defines `PgQueryResult`. The narrower lesson is the useful one:
  **the packages that re-parse through zod were protected by the parse** (a `Date` fails
  `z.string().datetime()` loudly on the first row), so `incident-response-runtime-pg` was never
  affected; the damage landed where a record is hand-assembled from columns, and worst of all in the
  *dynamic* store that has no `StoredXRow` interface for a grep to find. `NUMERIC` and `INTERVAL` are
  deliberately **not** normalised — see the next entry.
- **A `decimal` crosses the wire as a canonical decimal string, uniformly** (ADR-0331, ADR-0332) — the
  exact text Postgres prints for `value::numeric(precision, scale)`, at every precision, through one
  decorator (`withDecimalWireType`) applied in `compileOperateServer`, the single place holding both the
  store and the manifest. That settled ADR-0331's undecided type: `NUMERIC` comes back from
  node-postgres as a string, so `ColumnMappedEntityStore` returned `"10.25"` where
  `PostgresEntityStore` returned `10.25`, across 92 `decimal` fields in the packs — and the cost was
  not the mismatch but three `typeof x === "number"` *presence* tests in the write effects, which
  answered false for every amount the typed store serves: **a partial credit note silently became a
  full one**, in the document and the GL entry. String-everywhere rather than number-everywhere
  because converting a `NUMERIC(38,10)` to a JS number is lossy by construction, which is *why*
  node-postgres returns a string. Refusal is split by provenance — an over-scale literal from a client
  is a 422 at validation, a computed value is quantised at the store boundary, since refusing there
  would turn a correct tax computation into a 500. What it leaves: **arithmetic is still `double`
  arithmetic** (`num()` and the reports' `readonly total: number`), so summing scale-2 amounts still
  drifts; and an unparseable stored decimal now
  makes its record and any page containing it unreadable, which is sharper than before and taken
  deliberately. `INTERVAL` is the third instance and unreached: a `duration` field maps to it and
  nothing in the catalog or the seven packs declares one, so a keyset sort on one would put
  `[object Object]` in the cursor the day somebody does. `readColumn` is the single place it lands.
  **And a `decimal` sorts and filters as a number** (ADR-0333), through a guarded cast, which closed
  something worse than mis-ordering: a row written by a pre-ADR-0332 client as the JSON *number*
  `10.50` is printed by Postgres as `10.50` while the cursor renders `String(10.5)` = `"10.5"`, and
  `'10.50' > '10.5'` is lexicographically true — so **the row re-qualified as coming after itself on
  every page, forever**, and a `limit 1` walk returned 11 rows, skipped 5 of 8 and did not
  terminate. `integer` had it too, with ten fields. The value types travel **on the query, not on
  the store**, because `operate-server`'s per-tenant JSONB fallback is one shared instance serving
  several tenants' own manifests, where A's `Invoice.amount` and B's are different types with the
  same name (ADR-0314) — an index on the instance would be one tenant's answer applied to all. The
  guard is **one pattern with two consumers** (a `RegExp` and a SQL literal), wider than the wire
  form because a row served as a figure must not be ordered as unknown, and narrower than `numeric`
  because `NaN`/`Infinity` cast but are not figures. `pg_input_is_valid` **would** be the right guard
  (ADR-0330's "ask Postgres rather than imitate its parser") and cannot be used: it arrived in PG 16
  and `MIN_POSTGRES_MAJOR` is 14, so a tripwire test asserts `MIN_POSTGRES_MAJOR < 16` and raising
  the floor is the moment to swap. `NULLS LAST` in both directions with the keyset encoding the same
  rule, because Postgres's default moves the tail with the direction and a cursor component cannot
  say which end it is at.
- **A column-level `check` expression is compared now** (ADR-0330), which closes ADR-0329's hole and
  removes the two table-level workarounds it needed. The naming ambiguity that made it look like a
  parser problem is answered by `pg_constraint.conkey` on the probe's own row — Postgres's own parser,
  asked rather than imitated. What it leaves: **one probe per declared column check on every
  `apply` and drift check** (781 as of ADR-0371)
  (~850 ms, flat in row count, not cacheable across runs); `conkey` cannot express a whole-row `Var`,
  so `CHECK (t IS NOT NULL)` reads as an empty column set and gets the right spelling for the wrong
  reason (nothing in the catalog has one); an unrenderable declared expression marks the pass
  incomplete and says nothing, which is conservative but silent; `MAX_CHECK_NAME_PASSES = 32` bounds
  `ChooseConstraintName`'s retry rather than proving it; and a constraint an operator renamed by hand
  outside the naming family reads as undeclared plus missing, because there is no `renamedFrom` for
  constraints. **A widening CHECK still cannot be told from a narrowing one**, so ADR-0329's cost is
  unchanged: a deployment with workflow history runs that `ALTER` by hand. Closing *that* means
  understanding the expressions, which is ADR-0292's refused problem.
- Column-store migration is **additive only** (ADR-0283, ADR-0314): a removed field's column
  is never dropped and a changed type is never altered, since both need a decision
  about existing data. Per-tenant activated manifests now *do* get DDL, into the tenant's
  own schema; `tenant-schema-diff.ts` reports what the additive path will not do, with
  `column_encryption_change` named first because a classification change is a type change
  whose storage consequence is the part that matters.

**Cosmetic** — per-field grant display, data-volume estimates on destructive
diffs, dark theme, per-tenant branding (ADR-0265, 0266, 0271, 0272).

`web-ui/` is three files whose own README calls it a development demo, it sits **outside** the
pnpm workspace, and it has no deployment story. The honest action is deletion, not a guide.
`pnpm-workspace.yaml` also declares `manifests/*` and `tools/*`, neither of which exists.

## The register: what is actually left, ranked

Everything above this line is a follow-up **named by the ADR that opened it**, which means it is
scoped by what the last increment happened to be about. In October 2026 a separate audit asked the
other question — *what is left, ranked by harm, regardless of which ADR would own it* — across nine
domains against the committed tree, with each finding verified before it was ranked and the
over-stated ones demoted with their refuting measurement. **158 raw findings, deduplicated to the
48 ranked items and 13 demotions below.** (The figure first reported for this was 145, which was
the eight-domain subtotal before the cross-domain pass added thirteen — carried forward once
already, which is the subject of P3 item 1 and the reason it is corrected here rather than quietly.)
The conclusion is one sentence:

> **The engine is genuinely complete and hardened. The deployment that ships is not, and breadth is
> the third thing: 14 packages (15,006 source lines) that no deployment can execute, and 8 of 20
> manifest sections that are validated, hashed, and read by nothing.**

What the audit confirmed as genuinely complete, having run the real functions rather than read
about them: the kernel meta-schema and deterministic DDL emit; reconciliation-not-replay migration;
the manifest compiler and `meta.extends` lineage; the 17-stage gateway pipeline; the per-field
grant layer (`surveySensitiveFields` + `checkClassifiedWriteMask` over all seven packs returns
`uncreatable=0, unreadable=0, unwritable=0, asymmetric=0`, so ADR-0348 really did close ADR-0339's
39); the ABAC stack, which is built, wired and fail-closed and simply has no declarations to
enforce; both entity stores, with `ColumnMappedEntityStore` carrying an explicit `tenant_id = $1`
on every read and write, so **tenant isolation does not depend on RLS** and the owner-run compose
does not breach it; at-rest PHI with per-tenant HKDF, the DEK envelope and the single-transaction
rekey; the hash-chained audit and forensic chains; the Article 17 *mechanism* for whole-tenant
erasure with four signed proof versions; the ten workspace rules; and the Architect's
design-to-activation flow.

**This section is a ranking, not a plan.** Nothing below is scheduled, and two entries conflict
with decisions argued in ADRs — where they do, the ADR's reasoning is named so the disagreement is
visible rather than silently overridden.

### P0 — present and wrong on a deployment serving tenants today

Each is reachable on a running deployment and produces a wrong answer, a disclosure, destroyed data
or an authorization bypass. The test against P1 is that **no new capability is needed to be harmed
by it**.

1. ~~**`operate-web` authenticates nobody**~~ — **closed by ADR-0358**, and the scoping claim this
   entry made ("it is a subsystem") was **wrong in the direction that deters the work**: a
   self-minted JWT is accepted by the existing gateway with no verifier change at all, so the API
   side already worked and the increment was a credential, a mint and a browser session. There is a
   `/login`, an httpOnly session cookie and a proxy forwarding the viewer's own token;
   `OPERATE_WEB_API_KEY` is gone from `.env.example` and `OPERATE_API_KEY` from the proxy.
   `deploy/Caddyfile` still has no auth directive and does not need one. ~~What remains is
   **revocation**~~ — **mostly closed by ADR-0381**, which found that **this entry's own named
   precedent would have built the wrong thing**: it pointed at ADR-0334's tenant-status directory,
   i.e. a *second* cached directory, while the membership row was **already being read on every
   request** by `abacAttributeDirectoryFromStore` and already answering `null` for exactly a revoked
   or absent membership. The only consumer of that `null` was `dischargeAbac`, which acts on it for
   a grant carrying an obligation — measured count across the seven packs **zero** — so the
   revocation was detected in the auth stage and the detection reached nothing. This run's
   most-found shape. `withMembershipRevocationCheck` is a sibling decoration over the **same
   directory instance** (two would be two caches with two TTLs that can disagree about one
   membership), default-on under `--credential-login`, and the window is **one hour → 30 seconds**,
   verified live (200 → revoke → 200 from cache → **401** after 31s, with the api-key unaffected and
   a restored membership working again). Three things remain and are narrower: 30s is not immediate,
   the refusal conflates *no row* with *not active*, and **`meta.users.status` is still unread** —
   it and the membership status are independent columns on independent tables, so a suspended user
   whose membership stays `active` keeps their session.
2. **The keyset cursor returns a classified field's plaintext to a caller who cannot read it.**
   ~~Undetected~~ — ADR-0357 surveys and reports it at boot, naming each field; **ADR-0377 closed
   it on the shipped stack** and corrected this entry twice. *"`CURSOR_ENCRYPTION_SECRET` is in the
   compose and `.env.example`"* was true of the compose and **false of `.env.example`**, where it
   was **commented out** — identically to `COLUMN_ENCRYPTION_SECRET`, whose measured facts are the
   opposite (resolved `erp-core`: **0** `phi`/`regulated` fields, **1** sortable classified field),
   and while `ORACLE.md`, `README.md` and `VERCEL-SUPABASE.md` all treat the cursor one as required.
   So the quickstart was the one deploy document telling an operator to leave it unset. It is
   uncommented with a generator line and named in `README.md`'s first-launch list. And this entry's
   second defect — ADR-0357's *"soundness bug in the keyset beside the disclosure"* on the column
   store — **does not exist**: the dropped key contributes no clause to `seekPredicate` and the id
   tiebreaker is pushed unconditionally, so the component is dead payload, which is what made
   `nullDroppedSortComponents` free. Making the secret *mandatory in the binary* is still refused on
   ADR-0357's first ground (the predicate is the same conjunction and `erp-core` has a member, so it
   refuses every deployment there is) and is now gated on splitting the hatch, which is ADR-0377's
   first open question. What is left: **14 (pack, field) pairs on a deployment that has not set the
   secret**, no per-tenant-manifest survey, and `?sort=` on an unreadable field still accepted.
3. **The shipped compose mounts no background subsystem, so nearly everything built since Phase 3
   is off.** Measured against the committed tree: the `api` command passes **18 distinct** flags
   (19 occurrences — `--ai-design-role` twice), not the six
   on record, and `--platform-user-routes` is among them — ADR-0358 added it (with a `deploy/README.md`
   note that the page had told readers to POST to a route the stack did not serve), so that clause of
   this entry was **false**, and so is any claim that the operator provisioning path is unreachable on
   a shipped deployment. What stands is the whole of the *background* half, absent as of this
   measurement: `--schedule-ms`, `--workflow-workers`, `--notification-drain-ms`,
   `--audit-chain-config`, `--integrity-proof-config`, `--checkpoint-config`,
   `--deletion-capabilities` (so neither Article 17 surface can mount), `--tenant-status-gate`,
   `--rate-limit-policy`, `--read-state-routes`, `--preference-routes`. So the request path is
   configured and nothing *recurs*: no job fires, no timer fires, no notification is delivered, no
   audit row is anchored, no integrity proof runs. ~~One increment, and the only question is which
   flags a reference deployment should default to.~~ — **that framing is false for 4 of the 9, and
   the per-flag map below says which.** **This entry's own count has gone stale three
   times in three increments** — 15 when it was written, a 16th from ADR-0364
   (`--credential-admin-role`), and two more from ADR-0368 (`--require-design-review`,
   `--design-review-role`) — every one a request-path flag that arrived with the feature needing it
   and moved nothing here, which is the argument for the entry being about *defaults* rather than
   about a count. Do not carry the figure; measure it.
   **Measuring this item is what found ADR-0370**, and not from the list above:
   `--notification-template-routes` is a *candidate* for the reference set rather than one of the
   absent background flags, and it turned out to mount a surface whose five status transitions **all
   raised at the database** and escaped as unclassified 500s. So "which flags should a reference
   deployment default on" cannot be answered without first asking, per flag, whether it serves what
   it mounts. That is the honest shape of the remaining work here — a flag-by-flag measurement with
   a live boot behind each verdict, not a list to paste into `command:`.
   **And it found ADR-0371, which is the stronger form of the same lesson**: asking whether
   `--integrity-proof-config` and `--checkpoint-config` should default on found that the second
   manufactured the anchor the first trusted and verified nothing, so an hourly proof could record
   `verified` with **zero signatures examined** over a forged prefix. A flag cannot be defaulted on
   while the thing it records can be vacuously true — so the per-flag question is not only *does it
   serve what it mounts* but *is what it records a claim*. Both are now defaultable as far as that
   finding goes, with **one cost to weigh first that the increment measured rather than closed**: a
   legacy anchor sitting at an *idle* chain's tail is never replaced (`DO NOTHING`), so such a scope
   re-folds from genesis every pass, and `includePlatform` defaults to true over a chain that holds
   only escalation rows. At 152 µs of signature CPU per entry that is cheap on a short chain and is
   15.2 s per pass at 100k.
   **And ADR-0374 is a third answer to the same question, which is why the two flags are still not
   defaulted on**: a refused checkpoint row threw out of *both* of `proveScopeIntegrity`'s
   `latest(scope)` calls, so `--integrity-proof-config` on its own filed `outcome: "error"` once an
   hour for ever — a flag that is on and whose finding reaches nobody, which is strictly worse than
   one that is off, because an operator reads the first as covered. So the per-flag question has a
   third clause: *does it serve what it mounts*, *is what it records a claim*, and **does its own
   failure mode reach anybody**. All three now hold for this pair.
   **The remaining nine have now been asked both questions, and the answer refutes this entry's own
   framing: only 3 are a default decision.** *Default on* — `--tenant-status-gate` (`meta.tenants`
   carries zero policies and no `rls` in `META_TABLES`, so the directory read works for any role, and
   the boot survey separates `missing` from `unreachable` from `blocked` before the first request);
   `--read-state-routes` + `--read-state-role`, which has a **live consumer in the shipped UI** —
   `operate-web/lib/notifications.ts:217`/`:272` reached from `Sidebar.tsx:78` for the nav badge, whose
   own comment says the unmounted case "answers 404, and a nav badge must degrade rather than
   disappear", so today every badge fetch 404s and falls back silently to a recency approximation over
   50 notices; and `--notification-drain-ms`, which **serves** because `--ai-design` and
   `--require-design-review` are both already on, so `notifyDecision` writes a real dispatch per review
   decision, and the vacuity check passes (`unroutedResult` answers `outcome: "failed"`, not a
   success). *Default off with the reason already argued in the repo* — `--rate-limit-policy`, on
   `README.md:410`'s *"nothing defaults the ceiling … switching an existing deployment from
   10,000/60s on upgrade would refuse traffic that works today"* (ADR-0338's rule), and declaring it
   retires ADR-0337's six `rate_limit_decision_not_found` replay findings.
   **ADR-0376 landed two of those three and withdrew the read-state one, correcting the citation in
   the process: `:272` has no consumer at all.** `markNoticeRead` (`:241`) and `markReadThrough` (`:272`)
   are both callerless in `operate-web`, **no page lists notifications** — `listNotifications` is
   reached only by the badge's own fallback and by `/setup`, which filters to design-review
   decisions — and `/inbox` is the *approvals* inbox over entity records, which `Sidebar.tsx`'s own
   comment says is a different subject. So mounting the route replaces a **decaying** approximation
   with a true unread count nothing in the UI can ever reduce, which is ADR-0334's
   remedy-that-cannot-work: a number that only goes up is not information. It is blocked on a
   **surface** — a notifications page with a mark-read affordance — and the absence is now fenced
   with that reason in `deployment-defaults.test.ts`. The `--tenant-status-gate` verdict held but
   **not for the reason given**: that the directory read works for any role answers a different
   question, and the decisive measurement is that the shipped `platform_admin` key was already 403
   on every entity route (ADR-0365's 0 of 255) while an api-key naming the placeholder tenant with
   an *ERP* role was served **200** over a tenant with no `meta.tenants` row.
   **Four are blocked by a missing mechanism rather than an undecided default, and the mechanism is
   one line that does not exist: the `api` service declares no `volumes:` key at all** (measured
   top-level keys: `build`, `depends_on`, `environment`, `command`, `expose`, `ports`, `healthcheck`,
   `restart`). So `--audit-chain-config`, `--deletion-capabilities`, `--integrity-proof-config` and
   `--checkpoint-config` — every file-taking flag — have **no path by which an operator supplies a
   file**, and `deploy/ORACLE.md:534`'s instruction *"Each is a line added to that `command:`"* cannot
   be followed for any of them. That is ADR-0364's addendum class (the `.env.example` curl naming a
   port the stack published nowhere) in the document an Oracle operator actually follows, and it wants
   a documented Ed25519 keypair-generation step beside it.
   **ADR-0376 corrected that grouping and it changes the deliverable: the four are not peers.**
   Measured, `CheckpointConfigSchema.safeParse({})` and `IntegrityProofConfigSchema.safeParse({})`
   both succeed **fully defaulted** (every field has a default, `intervalMs: 3600000` and
   `includePlatform: true` among them), and `--deletion-capabilities` is a six-key declaration with
   no secret — so three are ordinary committable config and one `volumes:` mount serves them. The
   fourth is different in kind: `AuditChainConfigSchema` requires `privateKeyBase64` and
   `publicKeyBase64`, validated as real Ed25519 keys rather than merely non-empty, so it is a
   **credential**, which ADR-0301 says reaches this process through the environment and not through a
   file. A volume for three plus an env route for one, not one mount for four.
   **ADR-0377's addendum corrects the next clause, which ADR-0376 over-generalised**: that flag was
   called "the keystone of the whole Article 17 story" because `node.ts` skips
   `--tenant-deletion-routes` when `auditChainProducer === null` — true of **one** of the three
   deletion surfaces and false of the other two, including the destructive one.
   `--deletion-request-routes` **warns and mounts** with rows unanchored, and
   `--tenant-erasure-routes` — the `DROP SCHEMA` surface — warns and mounts **with no
   `deletionCapabilities` gate anywhere in its block**, deliberately, on ADR-0316's rule that an
   unanchored record still beats denying a working surface (ADR-0322). So **the keypair is not an
   interlock on destroying tenant data**, and the error mattered in the direction that an implementer
   would reason from: building the env route while believing it gates the erasure.
   **`--deletion-capabilities` is additionally a category error in the list above**: it mounts
   *nothing* on its own — `--tenant-deletion-routes` needs `conn` **and** an audit chain producer
   **and** the capabilities **and** `--tenant-deletion-role` — and the three surfaces
   (`--tenant-deletion-routes` / `--deletion-request-routes` / `--tenant-erasure-routes`) appear in
   neither this entry's eleven nor any compose file, all measured 0 hits.
   **`--schedule-ms` and `--workflow-workers` are blocked by P1.6**, not by a default: 14 job
   declarations on `erp-core` (`{scheduled: 7, event: 7}`), `buildJobHandlerRegistry({providers: []})`
   answers `servedJobIds: []` with 14 unservable, and `JOB_HANDLER_PROVIDERS` ships empty. The two
   differ in *kind*, which is worth keeping: `--schedule-ms` is **harmful** (scheduled crons include
   `*/15` and `*/30`, so ~149 pending rows per tenant per day accumulate for ever with no consumer)
   and also raises `CliUsageError` without `--schedule-tenant` or `--schedule-all-tenants`, both
   absent; `--workflow-workers` is merely **inert**, because `PostgresWorkflowDefinitionStore` has
   exactly one non-test construction in the workspace and that call only *reads*, so
   `meta.workflow_definitions` is empty in every deployment by construction → `no_definitions` for
   the timer and activity workers, and `jobEngine` is supplied only when `servedJobIds` is non-empty →
   `no_job_handlers`. **Zero of its three workers can start**; it prints three refusals and boots.
   And `--emit-entity-events` cannot rescue either: with the emitter on, the survey moves from
   `{handler_missing: 7, event_unproducible: 7}` to `{handler_missing: 11, event_unproducible: 3}`
   while `servedJobIds` stays `[]` — it changes only the **reason** a job is unserved, never whether
   it runs.
   **The sharpest finding of that measurement is not about defaults at all, and this entry did not
   have it**: `node.ts:3061` gates the drain-absence warning on
   `senderWiring.report.channels.length > 1`, the compose sets no SES or Twilio variable, so
   `channels = ["in_app"]` — length 1 — the warning **never fires**, and boot prints only
   `[notify] channels: in_app`, which reads as working. That is precisely the
   looks-healthy-sends-nothing failure the comment two lines below it says the warning exists to
   prevent, and it makes `README.md:522`'s *"Without the drain flag nothing is sent at all, and the
   API says so at boot"* **false for every deployment that ships**. It belongs in the same change as
   the three defaults.
   **ADR-0376 landed two of the three defaults, fixed that gate, and withdrew the third on a
   measurement** — see *A default that is not a default* below. Two corrections to this entry's own
   figures while it was being measured: the README defect is **two** sentences and not one (`:517`'s
   *"Out of the box only in-app notices are delivered"* is false for the same reason as `:523`'s
   second clause, since the drain is the only delivery path for `in_app` too), and the gate could not
   have been right at **any** value rather than wanting a lower threshold — `in_app` is registered
   unconditionally, so `>= 1` is a tautology dressed as a threshold and the honest axis is the store.
   One further measurement worth carrying, because it is a fence that holds for the wrong reason:
   `enqueueScheduledJobs` is a bare `conn.query` with **no tenant context**, and `meta.job_runs`
   carries exactly one `ALL`-scope isolation policy with no platform arm — so as a non-owner that
   `INSERT` raises `42501` every tick. `--schedule-ms` works on the shipped stack only because the
   compose connects as `POSTGRES_USER`, the same role that ran `migrate`, so the owner bypasses RLS.
   It stops holding the moment a deployment uses a least-privilege serving role, which is the
   configuration every other store in the repo is written for.
4. ~~**An Article 17 request naming one data subject erases the whole tenant.**~~ — **closed by
   ADR-0379**, which corrected this entry a third time and found that **the two readings it had
   settled on were both the wrong fix**. The mechanism is confirmed and the exposure is bounded:
   **no deletion flag appears on any shipped compose `command:`** (both occurrences of the word in
   `docker-compose.yml` are comments), so no shipped deployment ran it, while `ORACLE.md` documents
   how to mount it. What this entry had wrong: `TombstoneRecordSchema` does **not** "require no
   subject for that kind" in the sense that matters — it requires the kind to reference a deletion
   *request*, and the request's `subjectIdentifier` is required, so **the proof names its subject
   transitively and is internally consistent**. What nothing anywhere bounds is that kind's
   **scope**: a `DeletionScope` is a list of schemas and tables, so the contract sees *what* was
   destroyed and never *whose*, and a tenant-wide scope under `data_subject_erasure` parses, hashes,
   verifies and anchors (measured). So no downstream check could have caught it, and **threading
   `subjectIdentifier` would have made the record worse** — a subject named on a proof whose scope is
   every table reads as a per-subject erasure that *verifies*, where the unlabelled one at least lets
   a reader see that scope and claim disagree (ADR-0337's direction). The fix is one level up:
   `TENANT_WIDE_ERASURE_HONOURS`, a total map over `TOMBSTONE_KINDS` answering whether destroying a
   whole tenant truthfully performs that kind, refused at the pipeline's **`input`** stage so a
   returned refusal still means nothing was destroyed; `--deletion-subject-scope tenant|subject`
   required by the runner with no default (ADR-0328's argument — that flag says what the deployment
   *holds*, this one what a request *reaches*), `subject` refused at parse by name because nothing
   can perform it; and the route's kind set narrowed to what the map admits, written down and fenced
   both ways rather than cast (ADR-0362). Live before/after on one cluster: Bob asked, and the
   pre-fix proof read `kind=data_subject_erasure rows=3` with **0 records left** including Carol's,
   who never asked; after, the same flow stores `kind=tenant_deletion` referencing the request.
   What remains is ADR-0379's open ends — chiefly that **per-subject erasure is still unbuilt**
   (P1.4), so this increment makes the platform honest about not having it rather than providing it,
   and that `tenant` is over-deletion for a multi-user tenant with nothing saying which tenants
   those are.
   The original entry, kept because its measurements are what the fix rests on: `subjectIdentifier`
   is required on the submit body and the stored record, `DeletionRunnerOptions.run` has no field
   that could carry it, and `node.ts` calls `deleteTenantAtomically` with
   `kind: "data_subject_erasure"` over a tenant-wide `DELETE` plus `DROP SCHEMA` — while
   `TombstoneRecordSchema` requires no subject for that kind, so the proof parses with none. A
   verified request for one person destroys every person's data. Subsystem, and its honest
   prerequisite is P1 item 4.
   **Two corrections from a later measurement, and the second changes the scope of the fix.** The
   first half of this entry corrects nothing it had not already said — `subjectIdentifier` *is*
   required on the submit body and the stored record, and the genuinely new fact is that
   `DeleteTenantInput.subjectIdentifier?` **exists** on the pipeline and `deletion-pipeline.ts:498` is
   its only use, so the field is threaded one level and then read by nothing that scopes a statement.
   And **there are two `data_subject_erasure` emitters, not one**: besides the runner seam, the
   *synchronous* route admits the kind (`DELETABLE_TOMBSTONE_KINDS` at
   `tenant-deletion-routes.ts:48`), `node.ts:1859` passes `kind: req.kind` straight through, and that
   route's own `.strict()` body schema (`tenant-deletion-routes.ts:243-270`) carries `approvedBy`,
   `confirmTenantId`, `kind`, `attestations` and `relatedDeletionRequestId` and **no
   `subjectIdentifier` field at all**. So "one field across one interface" would leave the sync path
   still emitting a subjectless `data_subject_erasure`, and "stop `node.ts` asserting the kind" would
   leave a caller free to choose it on the sync route. Both paths could recover the subject from the
   `relatedDeletionRequestId` they already require. Threading it fixes the **claim** and not the
   erasure: `input.subjectIdentifier` scopes no statement anywhere, and both the delete and its
   confirm-absence pass stay `WHERE t.tenant_id = $1::uuid` plus `DROP SCHEMA`.
5. ~~**An upgraded deployment owes an undocumented `ALTER`, and until it runs the verify route
   silently fails to make the tenant read-only.**~~ — **closed by ADR-0363**, which also found the
   defect had a *second* copy one layer up that this entry could not see: the planner's own
   `rowCount === 0` short-circuit decided the same question from the same proxy, and that is the
   copy an operator met. The `ALTER` is no longer owed — `apply` plans it once the rows have been
   asked — and a database that has not had it applied yet is reported at boot, refused where
   `--tenant-status-gate` reads the value. What this entry said about the response was exactly
   right and worth keeping: verify returned 202 with `tenantReadOnly: false` while the tenant kept
   writing into data about to be destroyed. One correction: the lifecycle trail recorded
   **nothing** rather than a transition that disagreed, because `recordLifecycle` answers `false`
   when no row moved — so there was never a second record to contradict the first, which is why
   the honest grade for the gate-off case is a warning rather than a refusal.
6. ~~**`Currency.decimal_places` has zero readers while the accounting core hardcodes two.**~~ —
   **closed by ADR-0378**, which found that **two of this entry's three clauses do not survive
   measurement and the third is sharper than it reads**. `Currency.decimal_places` is genuinely inert
   and reading it **could not change a figure**: no money *amount* field in any of the seven packs
   exceeds `scale: 2`, so a 3-decimal currency cannot be *stored* at three decimals anywhere and a
   reader would have nothing to round to — a P1.2-shaped declaration, not a money defect. The
   hardcoded `100` is not the defect either; it is correct for every declared amount field and is the
   same choice `packages/billing/src/tax.ts:84` already made. **The defect is the *rate*** — a double
   times a double — and the reproduction holds (13.40 @ 7.5% posted `1.00` against an exact `1.01`).
   The honest finding is both narrower and worse: measured over **60,000,000 (rate, net) pairs** the
   per-line error is **exactly 0 or −1 cent, never over**, and that one-directional property means
   the reconciliation gate at `write-effects.ts:916` **already protected every regular-tax amount** —
   a line-derived total that ties to an exact stamped total implies every line was exact, since no
   line can be a cent high and no combination of codes can compensate. So for regular tax only the
   **GL account** moved (a correctly-totalled document silently lost its per-code split), while the
   one reachable **money** defect is **withholding**, which the gate excludes by design: the AR
   control amount was **overstated** and the statutory `withholding_total` a WHT certificate is
   prefilled from **understated**, by a cent, in an entry that **balances** — 0.70 against 0.70 —
   which is why no gate, guard or replayer could have caught it. Live before/after on one cluster:
   AR `0.67 → 0.66`, stamped `"0.03" → "0.04"`. What remains is ADR-0378's open ends: the sites that
   *add* (`aging.ts`, `wht-reconciliation.ts`, the FX revaluation) are still `double` arithmetic, and
   `Currency.decimal_places` stays inert because closing it honestly is a **schema** increment.
6b. **A document marked paid by hand clears no control account, on three declared edges** (found by
   ADR-0366, in neither the backlog nor this register before it). Every settlement-side effect is
   gated on `names.has("Payment")` — `paymentSettlementGlPostingEffect` at `compile.ts:473`,
   `paymentApplicationEffect` at `:488` and `:498` — and **no effect `compile.ts` wires triggers on
   `paid` at all**: every `triggerState` is `sent` or `approved`, and `settleableStates` are the
   states a document is settled *from*. Meanwhile three permission-gated transitions reach `paid`
   with no `Payment` row: `Invoice.mark_paid` and `Bill.mark_paid` (`workflows.ts:30-35`, `:147-151`,
   plus the timer transitions `sent_to_paid_30d` and `approved_to_paid_due`) and
   `TaxReturn.mark_paid` (`workflows-ext.ts:200-213`, granted at `:243`), which no effect names at
   all. Measured against the real store: an invoice of 120 with a Payment of 50, hand-marked paid,
   leaves **AR net +70** on a document that reads `paid`; a tax return reaching `paid` moves cash,
   leaves `tax_payable` uncleared and posts nothing. All eleven effects were enumerated and there is
   no other route — the only AR-clearing postings are the Payment-gated settlement, a credit note
   and a reversal, which are different business acts. Reachable since ADR-0365 (`erp_admin` at 79 of
   79 transitions; `GL_WRITERS = ["erp_admin", "controller"]`). The fix is a **new** effect with a
   "no completed Payments cover this document" predicate: re-wiring ADR-0366's deleted
   `paymentGlPostingEffect` is measured harmful on exactly this scenario (**AR net −50, cash +170**),
   because it cannot tell "paid with no Payment rows" from "paid via payment application" and posts
   the document total regardless of what was paid. **ADR-0378 re-measured it and withdrew the fix
   rather than shipping it**, on ADR-0366's rule that a retention is withdrawn *with its
   measurement* and the same discipline applies to an addition: the facts hold (every `triggerState`
   is `sent` or `approved`, and **five** declared transitions reach `paid` — the entry says three,
   counting the two `mark_paid` edges and `TaxReturn`'s while the two timer transitions are the
   fourth and fifth), and the remedy is the harmful one. It stays open, and the shape of a correct
   fix is a ledger question — how a residual effect and the settlement effects share one notion of
   an open control balance — rather than a wiring step.
7. ~~**`unique: true` emits no constraint on any entity table while the UI says the field is
   unique.**~~ — **closed by ADR-0360**, which corrected two of the three things this entry said.
   *"while the UI says the field is unique"* is **false**: `unique` occurs exactly once in the whole
   `apps/operate-web` tree, as the type declaration at `lib/schema.ts:26`, and no component reads it
   — so the defect was one notch **worse** than claimed, because a promise would at least have been a
   promise and this was authored, validated, hashed and serialized to a client that discards it. And
   *"34 in `erp-core`"* is 32 — 34 is the *resolved `erp-healthcare`* figure transposed onto the pack
   that is its base; 47 is right as a count of source declarations and 45 as distinct (entity, field)
   pairs. The instruction to refuse the encrypted case was right and is what shipped. The entry also
   did not know `UniqueHintSchema` admits `{scope: string[]}`, which is read now, or that 14 of the
   45 are sequence-defaulted, which is what gates the 409.
8. **`compliancePacks` is a counted string — and a fifth measurement (2026-10-20) makes the
   deliverable bigger again, so the "one-line fix" named in (d) is withdrawn.** Re-derived against
   the committed tree while scoping it: `resolveCompliancePacks` has **zero** callers outside its
   own test, `@crossengin/compliance` has **zero** importers, there are **four** pack definitions on
   disk (`hipaa`, `gdpr`, `uae-moh`, `21-cfr-part-11`), the seven ERP packs name **six** ids
   (`hipaa`, `pci`, `haccp`, `osha`, `ferpa`, `nist-800-53`) of which **only `hipaa` has a
   definition** — the other five throw `UnknownPackError` — and the three remaining definitions are
   declared by **no pack at all**. All of that confirms (a)–(c). What changes is (d): the
   `compliancePacks: []` at `node.ts:1416` is **one of five fabricated fields in the same literal**
   (`platformVersion: "1.0.0"`, `region: "us-east"`, `planTier: "professional"`,
   `isDedicatedTenant: false`), under a comment that **already declares them a deployment default**
   — *"The tenant context is a deployment default; per-tenant plan/region is a follow-up."* So
   fixing only the compliance field would leave four equally-fabricated siblings and be a count
   reduction inside a defect class, which ADR-0366 established is not progress against the class.
   The honest increment is therefore **the marketplace `TenantContext` is five fabricated facts**,
   which needs a decision about where a tenant's plan, region and compliance posture come from
   (per-tenant settings? the `meta.tenants` row?) before any of the five can be read rather than
   invented — and separately a **report** over the compliance half, since five of six declared ids
   name a pack that does not exist and nothing says so at boot. Both are larger than one line and
   neither is the wiring (b) and (c) refuse. The original entry, whose four corrections still
   stand:
   The core claim holds: `resolveCompliancePacks` has zero non-test callers, `@crossengin/compliance`
   has zero importers, and healthcare's `["hipaa"]` contributes nothing. Four corrections from a
   scout against the committed tree, three of them decisive. **(a)** Only **four** pack definitions
   exist on disk (`hipaa`, `gdpr`, `uae-moh`, `21-cfr-part-11`) while the seven ERP packs name
   **six** ids — and **five of the six have no definition**: retail `pci`, grocery `haccp`,
   construction `osha`, education `ferpa`, government `nist-800-53` all throw `UnknownPackError`.
   Conversely `gdpr`, `uae-moh` and `21-cfr-part-11` are declared by nobody. **(b)** Wiring the
   function where this entry says it belongs **stops the one pack that does resolve from booting**:
   no manifest sets `compliancePackParameters` and 10 of the 27 parameters are required with no
   default, so the real call on resolved healthcare answers `PackParameterError: … parameter
   'coveredEntityType': required but not provided`. **(c)** With the parameters supplied it resolves
   and validates, and **what lands is inert and unprotected**, which inverts the §164.312(b)
   framing: permissions go 53→53 and roles 19→19, so `rbacCheck` refuses all 19 roles × 5 operations
   on each of the three new entities (`no permissions declared for entity 'PhiAccessLog'`) behind 3
   tables and 15 routes, and `grep classification` across all four pack definitions returns **zero**
   occurrences (`encryptAtRest` likewise) against `Patient`'s 7 classified fields. Nothing *writes*
   a `PhiAccessLog` either — resolving the entity yields CRUD routes, not an audit control, while
   `meta.audit_log` already hash-chains entity writes — so the control would be closed in name and
   not in mechanism, which is ADR-0337's falsely-true-control direction. **(d)** There are **four**
   readers, not one, and the field's single live wrong answer is in none of the above:
   `node.ts:1234` hardcodes `compliancePacks: []` into the marketplace `TenantContext`, so a catalog
   pack requiring `hipaa` is refused on a healthcare deployment that declares it. That one is a
   one-line fix and is the only part of this item that is.
8b. ~~**A deployment with no backups is certified DR-ready**, and the rule against it is written out
   twenty lines above the function that breaks it.~~ — **closed by ADR-0372**, and it was never a
   live P0: an adversarial pass over the audit's own verdicts refuted that grade on the discipline
   the same audit had applied one item earlier. `drReadinessSource` returns `[]` with no stored
   snapshot, and neither `--dr-readiness-config` nor `--certification-config` is among the shipped
   compose's 18 flags, so no deployment is certified DR-ready today. What the measurement found is
   **wider than a backup guard**: every axis of `assessDrReadiness` was vacuous on empty input,
   because each count is derived by *filtering* a supplied list — and `failovers` is the one axis
   where empty is a *fact* (nothing failed over) rather than an absence, which is why the fix is a
   total map over the five and not a check on one. A **fourth** adapter in the same file was worse
   and is also closed: `evidenceFromAccessReviewEvidence` answered `satisfied: true` with *"sealed
   at 100% completion"* over a pack covering **zero reviewed items**, reachable from the shipped
   producer rather than from a hand-edited row.
9. **No automated backup, no tested restore** — **the live half is closed by ADR-0380 and the
   backup half is the item's real remainder.** That increment measured this entry's own live
   finding (`verify-chain` exits 0 over an empty chain) rather than taking it on trust, found it
   survives two increments that had touched the command, and found **the sharp case is worse than
   this entry records**: a scope with a checkpoint at sequence 7 and **zero** entries — a state
   ADR-0375 says only the tamper produces — printed `witness 7` beside `signatures: valid (0
   checked)` and concluded `OK` with exit 0. Every fact was on the page and the verdict contradicted
   them. The cause is three things composing, none a bug alone: both halves of the fold are
   **vacuously valid** over zero entries; the anchor audit *deliberately* does not call an unreached
   witness a disagreement (that is the truncation check's subject, and its own doc says so); and
   **the truncation check was computed in exactly one place**, inline inside `proveScopeIntegrity`,
   so the command that holds the witness and prints it never read the tail. `chainTruncation` is one
   definition with two callers now, `verify-chain`'s exit code is a three-way conjunction, and a
   fold that examined nothing prints `NO HISTORY — nothing was examined` rather than `OK` — exiting
   **0**, deliberately, because a new tenant and a tenant whose chain *and* checkpoints were both
   deleted are byte-identical from these two tables, and the repo's exit vocabulary has no third
   value (2 is a usage error). What is left of **that** is ADR-0375's open end 2. The rest of this
   entry stands: ~~and no healthcheck on `api` or `web`~~ — ADR-0357
   added the `api` healthcheck and made `web` wait on it. Backup is still prose only, on a platform
   that models DR tiers with RPO/RTO targets: no backup service in any compose file, no
   `pg_restore` anywhere in `deploy/`, `BackupRecord` with **zero producers**, and
   `meta.backup_records` declared writerless as `unwritten_table`.
   **Two citation corrections, one of which inverts a clause.** `README:181` is about api-key specs
   and `--platform-user-routes`; the backup prose is at `:441-442` and `:821-831`. And *"no cron, no
   retention"* is true of the compose stack and **false of `deploy/ORACLE.md:500-510`**, which ships
   a dump script, a `17 3 * * *` crontab line and a 14-day `-mtime +14 -delete` retention — so the
   document an Oracle operator follows does schedule a backup. What it does **not** do is test the
   restore: its own *"Test the restore now"* block runs `gunzip -c … | head -40`, which restores
   nothing and proves only that the file decompresses. Both `README:830-831` and `ORACLE.md:519-520`
   already say the platform ships no backup scheduler, so the honest finding is the untested
   restore and the absent in-stack scheduler, not an absent cron.

### P1 — the product claims it and no deployment can execute it

Advertised capability with no reachable code path, or delivered at a cost that makes it unusable.
Nothing here gives a wrong answer, which is why it sits below P0. Ordered by leverage — the first
three make the rest honest, cheap or verifiable.

1. **Every list search is an unindexed table scan and a comment asserts the opposite.**
   `list-sql.ts` emits `unaccent(<col>::text) ILIKE …` while `entity-ddl.ts` indexes the bare
   column; the predicate's comment claims a plain-column GIN index still accelerates it and the DDL
   comment two files away notes `unaccent` is not IMMUTABLE. Measured on PG 16.13 at 60k rows:
   **129.6 ms sequential vs 1.95 ms** without the wrapper — 66×, so ~2 s per request at 1M rows,
   issued per keystroke from the shipped search box, over an index no query reads. Days, and the
   evidence is already taken.
2. **Eight manifest sections are read by nothing — but they are not *authored*, and the headline
   this entry gave is inverted.** The core fact holds: `integrations`, `files`, `reports`,
   `dashboards`, `customWidgets`, `theme`, `i18n` and `search` are merged across lineage, committed
   to `manifestHash` and read by no runtime. Five particulars were wrong, measured against the
   resolved packs. **(a)** `ManifestSchema` has **18** keys and **16** content sections, not twenty
   (`manifestVersion` and `meta` are not sections; the extra two were probably `meta.compliancePacks`
   and `meta.compliancePackParameters`). **(b)** All eight carry **zero declarations in all seven
   resolved packs** — the key is absent, not empty — so nothing is discarded at serving time. The
   honest framing is ADR-0336's *modelled domain with no mechanism*, and it changes the deliverable:
   a census reporting "0 declared" is a different thing from one reporting "40 discarded".
   **(c)** Three of the eight are **not validated either** — `validateManifest` is a hand-written
   sequence of eleven calls that never names `customWidgets`, `theme` or `i18n` — and `validateFiles`
   is structurally vacuous (it tests `Object.keys()` for duplicates, which cannot occur), so `files`
   is nominally validated and effectively merge-only too. **(d)** *"A reviewer approves eight
   sections that are discarded"* is **backwards, and the truth is worse**: `ManifestDiffView`, which
   `design-review-routes.ts` shows the approving reviewer, covers **5 of 16** sections — so a
   reviewer is blind to **eleven**, and two of the eleven (`jobs`, `views`) **are served**, which
   means the review is blind to changes that do alter what a request gets. **(e)** The census shape
   has been built **three** times, not twice, and `surveyListSurfaces` is the nearest fit: it already
   pairs a verdict enum with a `*_MAY_SERVE` total map and argues report-vs-refuse from the remedy.
   **And the member this entry was reaching for is one level down**: all **28** authored views carry
   a `permissions` override that *is* validated against `manifest.roles` and enforced by nothing —
   every authorization path reads `manifest.permissions[entity]` — and `ReportDeclaration` carries
   both `permissions` and `abac` in the same state, with the `abac` key outside
   `surveyAbacObligations`, so ADR-0340's by-name boot refusal cannot see a declared obligation no
   deployment can discharge. Those are genuinely authored, validated, hashed and discarded. (Partly
   P2 item 14's third clause, from the other end.)
3. **No CI, no git hook, no smoke, e2e, load or migration test** — while `strategy/ci.ts` models
   triggers, budgets and a topological sort with no reader. No `.github/workflows`, no
   `core.hooksPath`, so the twelve rules and 20,136 tests run only when a human types `pnpm -r test`,
   and this file's instruction never to use `--no-verify` describes a guardrail that does not
   exist. `operate-web` has **zero tests** against 15 pages and 34 unfenced `fetch` sites — the
   serialized-body boundary that shipped a broken console button for an hour (ADR-0335).
4. **GDPR Article 15 access and Article 20 portability have no code path at all**, against fifteen
   increments of Article 17. `@crossengin/data-lineage` has zero importers, its six tables are
   declared `unbuilt_subsystem`, there is no SAR route, store, scheduler or flag, and
   `meta.tenant_data_exports` has no writer. Prerequisite for doing per-subject erasure honestly
   (P0 item 4).
5. **No object storage anywhere**, so no tenant can attach a document to anything.
   `@crossengin/files` is path builders and schemas; no S3/GCS/Azure/MinIO client in any
   `package.json`, no upload route among `operate-server`'s 137 flags. Shared prerequisite for the
   Article 15 export bundle, the marketplace pack bundle, and the `object_storage` deletion
   subsystem every deployment must therefore declare `absent`.
6. **All 25 declared jobs do nothing**, and the blocker is a contract gap rather than wiring:
   `JobDeclaration` carries id, trigger, retry, concurrency, data classes and prose and **no field
   naming the work**. So invoices never go overdue, inventory is never decremented, depreciation is
   never posted, month-end never closes. 17 need an entity-store runtime layer the packs lack; 8
   are third-party integrations with no client here.
7. **No incident route exists**, so `human_owned` is unreachable and every auto-declared incident
   is permanently uncloseable — `declared → cancelled` is the whole reachable lifecycle. Covered in
   detail above; three coupled gaps sit under it (no `Runbook` table, no tenant-scoped comms read
   path, the status-page presumption).
8. **Nothing detects an Article 12(3) deadline breach, and no route lists pending requests.**
   `isOverdue` and `daysUntilDeadline` have zero callers outside their tests, the store has three
   status-filtered queries and none on `deadline_at`, and there is no
   `GET /v1/platform/deletion-requests`. A stalled sweep escalates a `sev2` and a tampered proof a
   paging `sev1`, so **the one condition that is an actual regulatory breach is the one with no
   detector** — and the schema refuses a completed record past its deadline, so a late completion
   cannot even be recorded.
9. **SAML, OIDC and SCIM are contracts-only**: `@crossengin/sso` has zero importers, no runtime or
   pg sibling, five tables declared `unbuilt_subsystem`, and the gateway's auth schemes do not
   include `saml` or `oidc`, so there is no pipeline position for one. Normally a procurement gate.
10. **No outbound webhook delivery**, so a tenant cannot subscribe to any platform event — and with
    the signal bridge unregistered the platform has neither event ingress nor egress. Cheapest item
    in the tier: the HMAC primitive exists and the drain loop is the mechanism.
11. **Five of eight declared auth schemes are denied at runtime**, including both strong schemes
    other than JWT. `bearer_opaque`, `api_key_query`, `basic`, `mtls` and `hmac_signature` all fall
    through to `scheme_unsupported_*`. The refusal is honest and named; `hmac_signature` is cheap.
12. **Reporting and search do not execute**: both packages are imported by manifest validation
    alone, the three shipped reports are hand-built pages, and across 51+ entities the only
    find-a-record mechanism is the ILIKE whose cost is item 1.
13. **Data onboarding is contracts-only** — `@crossengin/migration`, zero importers, 18 callerless
    exports, no parser for any of its 12 declared source kinds. In practice this decides whether
    the product can be sold to anyone who is not greenfield.
14. **14 of 18 notification providers have no client, and credentials are one platform-wide set.**
    Independently of the missing clients, `delivery-senders-env.ts` reads flat process-wide names
    with **no tenant parameter anywhere in resolution**, so every tenant's mail leaves one domain
    and every SMS one number — a commercial blocker on its own.
15. **Nothing evaluates a feature flag** and the only `evaluateFlag()` is in a package with zero
    importers under six colliding names. Blocked on the product decision ADR-0336 declined. Sharp
    edge for later: the two use different bucketing (`hash*31` vs FNV-1a), so wiring the wrong one
    silently re-randomises every in-flight rollout.
16. **The UI is entity CRUD, three reports, a tenant console, a login and — since ADR-0364 — user
    management.** What that increment closed is this entry's own first clause in both halves:
    `/platform/users` + `/platform/users/[id]` + a Members panel provision people, move their
    status, grant and revoke memberships and set a first password, and `/account` is the
    self-service change. Nothing else here moved: no workflow view, no report builder, no incident
    surface, no deletion-request surface, no preferences page — **and no notifications page**, which
    ADR-0376 established while trying to default `--read-state-routes` on: `listNotifications` is
    reached only by `Sidebar.tsx`'s badge fallback and by `/setup` (filtered to design-review
    decisions), `markNoticeRead` and `markReadThrough` are **callerless**, and `/inbox` is the
    *approvals* inbox over entity records rather than a notification inbox. So the nav badge counts a
    set the UI neither displays nor can clear, which is why that flag is withheld rather than
    defaulted; the page plus a mark-read affordance is the smallest piece that makes it landable, and
    it is the one UI gap whose server surface is already built and waiting.
    ADR-0369 made `/account`'s
    **Other roles** field populate for the first time at a cost of **zero** web changes — it reads
    `UiViewer.roles`, which `ui-schema.ts` has always built from the full list, so it had rendered
    `—` for every viewer in every deployment. **The viewer's identity is still
    the sharpest remaining piece and is now the blocker for the obvious next one**: `UiViewer`
    carries `primaryRole` and `roles` and no user id, display name or email, so `/account` can
    name the role you signed in with and not the person holding it, the shell's avatar initial is
    taken from a role name, and — the consequence that bites — **a person cannot be shown their
    own record**, because the detail page is reached by an id the client does not have. A
    server-side `UiSchema` change, two fields wide. The two clauses that stood beside it are
    **closed by ADR-0365**, and all three of their figures were stale: the method is `counts()` and
    not `userCounts`; the tenants list renders **five** tiles and not three; and a `?email=` filter
    is served now rather than dropped, exact and case-folded. That increment also closed, in passing,
    the defect those figures were describing from the wrong side — `TenantCounts` hand-listed **four**
    of `TENANT_STATUSES`' five, so `pending_deletion` was counted by the server on every request and
    shown by no tile, and both it and the users census are derived from their status vocabulary now.
    What remains on that page is the filter chip list, which is still hand-written and still has no
    `pending_deletion` entry — so the state ADR-0363's gate enforces is a figure you can read and a
    set you cannot list. A curation rather than a census, which is why it was left.
17. **14 packages, 15,006 source lines, zero importers**: `active-active`, `compliance`,
    `data-lineage`, `deploy`, `edge`, `finops`, `migration`, `ml-training`, `pwa`, `rate-limiting`,
    `sdk-clients`, `security`, `sso`, `workflow-signal-bridge` — ~17% of the package count, built,
    typechecked and tested on every sweep for code no deployment reaches. Also: **no OpenAPI
    document exists at all** (the cheapest high-leverage piece, derivable from
    `CompiledOperateServer.routeSpecs`), `finops` means per-tenant gross margin is unknowable while
    revenue is metered, `security`'s zero importers take the CSP builder with them (the shipped
    header is one hardcoded string), and one of eight view kinds is rendered while every list view
    advertises an `xlsx` export nothing can produce.

### P2 — wrong the moment a configuration or an unbuilt path opens

Genuine defects gated on a store flavour, a flag, a pack or a subsystem that does not exist, so no
tenant is harmed today — but closing the gate does not fix them, and the ones under a P1 item must
land with or before it.

1. ~~**A filter on an encrypted column is dropped from the `WHERE` clause**~~ — **closed by
   ADR-0359**, which also found it was **one of six members of one class** rather than an item, and
   that the register had missed the sharper one: the same `null` also meant *not a column*, and on
   `erp-construction` the two Postgres stores answered one request **oppositely** (every row, or
   none) over a `state` field no entity has. The root cause was a kernel gap — `stateField` was
   `z.string().min(1)` and nothing checked it against the entity. What is left of it is Q1 of that
   ADR: **decrypt-and-compare** would restore the capability rather than removing it
   (`pgp_sym_decrypt(col, key) = $1` is correct and unindexed, so an `eq` on a unique MRN is a
   sequential scan with a decrypt per row — the cliff ADR-0345 refused), and the partially-narrowed
   `?q` is still silent at request time, so a clinician searching an MRN gets an empty page.
2. **No path surveys an activated per-tenant manifest's classified fields**, so ADR-0339's
   write-open/read-closed asymmetry is still live there — `node.ts` admits it in a comment. Rises
   to **P0 for any deployment serving activated manifests**, which is the headline Architect
   feature. Its cheap companion is a kernel rule requiring a sensitive-classified field to carry a
   grant at all, which would refuse zero fields today.
3. ~~**`proveWideningSafe` is complete, tested and wired to nothing**~~ — **closed by ADR-0363**,
   and the sharpest correction is to this entry's own framing: giving that function a caller is
   **not** the fix, because what it proves (*no current row violates this*) is strictly weaker than
   *this is a widening*, so gating on it planned **narrowings** silently — ordinary writes the live
   rule permits would start failing `23514` with nothing having said the declaration narrows. The
   gate is `predicate_implied_by`, the planner's own prover, reached through
   `constraint_exclusion = on`; `proveWideningSafe` is the diagnostic beside it. Both halves of the
   instruction this entry did give were right and are in: the guard re-checks at apply time, and the
   confinement refusal is the first line of every such guard. Four things it did not have. The proxy
   had a **second copy** in the planner (`rowCount === 0`), which is the one an operator met. A **row
   count is itself confinable**, so the probe had to stop reporting one it could not believe — and
   the structural gate makes that moot for a proven widening, which a confined session can now plan.
   The *remedy* this class hands over was **destructive**: pasted unwrapped, the `DROP`/`ADD` pair
   left a table with zero CHECK constraints and then accepted anything — now a transaction at all
   three sites, with the conclusive arm handing over the violator query alone. And the fix's first
   draft was **wrong in a way only the live run could see**: `EXPLAIN`'s output column is
   `QUERY PLAN`, so reading `rows[0].plan` answered `undefined` and every widening was reported,
   while the fake returned `{ plan }` and agreed with it.
4. ~~**The 12 event-triggered jobs can never match the only event producer's names.**~~ —
   **closed by ADR-0362**, which confirmed the defect and corrected the stated cause in the
   direction that would have misdirected the fix. The shipped producer emits a **two**-part name:
   `eventPrefix` is optional, `--event-prefix` defaults to null and appears nowhere in `deploy/`,
   and the test pinning `retail.salesorder.placed` is titled *"applies an optional event prefix"*
   while five of its six cases pin the two-part form. So arity was never the discriminator — the
   **separator** is (`.` against `_`, with the domain first) — and dropping the prefix would have
   fixed nothing. Measured stronger than this entry claimed, and **wrongly**: ADR-0362
   recorded **0 of 294** producible names matching any of the 12 and **55 of 55** instances
   unreachable, and the real figures are **27 of 55 producible** over four names with **28
   unreachable** over nine — which is the nine declarations the rule actually carries, so only the
   prose was wrong. Trying
   every declared name's own first segment as a prefix across all seven packs gives **0 matches**,
   so the failure is structural rather than a misconfiguration. The verdict claim was right and
   narrower than stated: the survey only runs under `--schedule-ms` or `--workflow-workers`, so
   `--emit-entity-events` alone produced **no** survey and no boot line at all. `event_unproducible`
   is the sixth verdict and the grammar now has one spelling in `kernel/manifest/event-names.ts`.
   What remains is item 6 itself — a handler for any of them — plus two pack changes a domain owner
   could make today (a lifecycle on `Permit`, a `posted` target on `Enrollment`) and three
   declarations whose entities do not exist.
5. **`meta.users` keeps every user's email, display name and phone after a completed tenant
   erasure, and the proof is silent about it.** `partitionSharedTables` skips any catalogued table
   with no `tenant_id`, and of those 31 `meta.users` is the only one holding a *tenant user's*
   contact details — "the only one" full stop is **literally false**, since
   `meta.extension_packs.author_email` is a second contact-detail column among the 31, a marketplace
   publisher rather than a tenant user, which is why it does not change the decision — a natural
   person's
   direct contact details — while `meta.user_tenant_membership` *is* erased in the same
   transaction, so the rows survive **un-attributable**. Neither erased, nor declared retained with
   an obligation, nor listed in `examinedTables`. The decision is erase, cascade with the last
   membership, or declare retained with a reason.
6. ~~**The only deletion disposition that lets a deletion run signs a claim most deployments cannot
   honestly make.**~~ — **closed by ADR-0372** with `present_not_erased`, the fourth disposition: it
   leaves the attester requirement **without** claiming the subsystem is not there, which is
   ADR-0317 inverted rather than an instance of it. The byte **shape** is unchanged, so no content
   tag moves and every stored proof still verifies — measured by assembling the same tombstone
   against a pristine `git archive HEAD` copy and the working tree side by side, identical digests,
   with `tombstone-proof.test.ts`'s literal v1–v4 hex pins unmodified and all 135 passing. A
   `reason`/`horizon` field **would** change the shape and needs `content.v5`, which is the
   follow-up. The original text is kept because its reasoning is what the fix rests on:
   **The only deletion disposition that lets a deletion run signs a claim most deployments cannot
   honestly make.** `ATTESTERS` has two keys; `object_storage`, `backups`, `search_indexes` and
   `caches` have no producer for any scope field, and `CONSERVATIVE_DELETION_CAPABILITIES` declares
   all six `erases`, so the exported starting point refuses every deletion. A real deployment does
   take Postgres backups, so `backups: "absent"` — signed into the v2+ bytes as *this deployment
   does not have this subsystem* — is false for essentially every production install and is the
   only value that lets a deletion proceed. A fourth disposition (`present_not_erased`, carrying
   its reason and horizon) is hours, where the four erasures are each a subsystem.
7. ~~**Every encryption-path exception is served as a retryable 504 echoing the internal error**~~ —
   **closed by ADR-0359**, which corrected this entry **four times**. It is not "every": all four
   write ops route through `writeTxn`, which returned `json(500, {detail: e.message})` *unsliced*
   and `String(e)` for a non-Error — so only reads reached the 504 and the write path's disclosure
   was strictly worse. The **480 slice never bit**: the three real messages measure 190, 391 and
   438 characters, so each was disclosed in full. **Field names with their classification never
   reached a client** — those live only in `ColumnEncryptionUnavailable`'s *constructor* message,
   caught by `TenantGatewayCache`; entity names and tenant UUIDs did. And `ColumnSecretRefused`
   cannot reach the mapping at all, being boot-only. There were **three** defects, and the unnamed
   one was the sharpest: the mapping was **inverted**, with the recorded reason a bare constant and
   the 480 slice sized for `StageResultSchema.reason`'s `max(500)` yet applied to the one string
   that never reached the record. What is left is Q3 of that ADR: `writeTxn`'s 500 now carries no
   diagnosis **anywhere**, because the handler layer has no recorder — the seam is a
   `HandlerContext` field the dispatch stage folds into the stage reason, and it is a contract
   change that increment did not make.
8. **The rekey leaves a stale-key window nothing can evict, no row records which key wrote it, and
   nothing enumerates which tenants still need rekeying.** The cache is a bare `Map` with a 30s TTL
   and no exported eviction, so after a rekey commits out of process a replica *reads* with a loud
   raise (correct) and *writes* under the destroyed generation — rows then unreadable under either
   key, unrecoverable because no entity table carries a `key_generation` column.
   `PostgresDataKeyStore` has no list, scan or provenance query, so an operator switching to
   envelope mode has every tenant seeded and shreddable-in-name-only with no query telling them
   which. Together: the bounded horizon the envelope exists to buy cannot be verified fleet-wide.
9. ~~**A per-tenant gateway that refuses to build is served the deployment's gateway**~~ —
   **closed by ADR-0359**, which found the contradiction is **three-way** and one side is in the
   defective file: `tenant-gateway-cache.ts:81` calls the mechanism *"(fail open to the default
   server)"* while `server.ts:322` calls the same thing *"the fail-closed answer"*. And it
   understates the damage — on the shipped `--store pg` the fallback store is the **same object**
   the boot gateway holds, so the tenant got **their own data under someone else's rules**, with
   their field grants, classification and the obligation that caused the refusal all absent and the
   entity grant unqualified. The branch had **zero** test coverage. `serverFor` is now
   three-valued, a refused tenant gets a 503 naming only the tenant and the refusal kind, and only
   permanent causes are memoised — with the ordering stated at the catch, because memoising before
   fixing the fallback would have *extended* the wrong-answer window from one request to a whole
   TTL. What is left is Q4 and Q5: a **source** throw still resolves `none` and falls back (the
   same class, rarer and uncached — the honest answer is a third disposition), and
   `ai-design-routes.ts` still returns **200** on activation with no build check, so a tenant can
   activate a manifest this deployment cannot serve and learn of it from a 503.
10. **Five workflow stores carry neither tenant context nor a scope predicate**, and the replayer
    that would detect the resulting drift has no caller. Not a cross-tenant HTTP answer today, so
    the live cost is the missing second belt plus the blocked detector — and note **five of six
    replayers are wired, not six**, with `REPLAY_SCOPE_SUPPORT` declaring a `workflow` arm no
    runner serves. Two consecutive increments bug-fixed that detector while nothing called it.
11. **Five residuals in the Article 17 proof**: own-record statutory retention inexpressible; a
    write window between the confirm-absence pass and the commit — **which inverting the retirement
    order would now close, because the foreign key that blocked it is gone — though a later
    measurement found a *second* constraint on that inversion nobody had named: the pipeline reads
    `fromState` from `meta.tenants` inside the transaction and retirement is an `UPDATE`, not a
    `DELETE`, so retiring first makes `fromState` read `deleted`, and any inversion must capture it
    first**; which tables were
    examined is in no digest, so "we looked at all 97" and "we looked at 12" hash identically; a
    deployment that moved from `pg-columns` to `pg` has leftover entity tables nothing censuses;
    and a tampered tombstone can never be put right, so its paging `sev1` re-declares every tick
    with hand-written SQL against an append-only table as the only exit.
12. **The sealed cursor has no rotation path and a sealed deployment still accepts a forged
    plaintext cursor.** And when a rotation path is built, **generation 1 cannot be the first
    rotation**: `deriveTenantCursorKey(secret, tenantId, generation = DEFAULT_KEY_GENERATION)` has
    `DEFAULT_KEY_GENERATION === 1`, so the ternary in `cursor-encryption.ts` derives the *identical*
    key for `undefined` and for `1` — rotating to 1 is a silent no-op and the first generation that
    actually rotates is 2. `buildCursorKeySource` takes a generation and its only caller passes none,
    and `SEALED_CURSOR_PREFIX` is a fixed `"s1."` with no generation field — so rotating the
    secret 400s every walk in flight at the page boundary. Both downstream of P0 item 2.
12b. **A column admits what its contract refuses, on hundreds of columns** — the inverse of item 13
    and a class the register did not have. Measured from the built catalog: **505 TEXT and 159 JSONB
    columns carry no CHECK**, 36+ of the latter `NOT NULL DEFAULT '[]'::jsonb` with no array
    constraint (`plans.metered_prices`, `feature_flags.variants`, `incidents.role_assignments`,
    `incident_postmortems.action_items`). So a row the deployment's own reader refuses is storable
    almost everywhere, and ADR-0373 answered it at the **read** — where the consequence lives — with
    CHECKs on only the three columns whose unreadability defeats an audit. Closing the class means
    comparing a contract field's **refinement** to its column's CHECK, which no rule does: ADR-0362
    established that none compares a contract *field* to a catalog *column*, and this is that
    question's other half. It would also not retire the read-side fix, because a CHECK added to a
    populated table is reported rather than planned when the rows violate it (ADR-0363), so a
    deployment already holding a refused row still needs the read to behave. **ADR-0374 added four
    more members across two tables and they are the second and third instances of its selection
    rule** — each fenced because its unreadability defeats a detector, so the seven CHECKs this
    class has gained were chosen by *what the refusal disables* rather than by surveying the
    columns, and the general rule is still unwritten. The denominator also grew: **444 TIMESTAMPTZ
    columns carried zero CHECKs between them** before that increment, which is a third population
    beside the 505 TEXT and 159 JSONB, and the one where the type is *furthest* from the contract —
    `TIMESTAMPTZ` admits two infinities and years to 294276 against `Iso8601`'s four digits, so the
    gap is not a refinement anybody chose but the full width of the type.
13. **Four contracts admit or assert something structurally false**, each in a subsystem whose job
    is to be checkable: a **late GDPR 72-hour breach notification is unrepresentable** (the
    refinement and the CHECK both refuse `publishedAt` past the deadline, so
    `isBreachNotificationTimely` can never answer false for a record that parsed — the first fact a
    regulator asks for cannot be stored, and this entry names only half of it: that predicate also
    has **zero non-test callers**, so the one function that would report a late GDPR notification
    both cannot answer `false` for a stored record *and* is read by nothing); a forensic checkpoint
    may claim `sha512` or `blake3` over
    a `rootHash` pinned to sha256's shape, neither computable anywhere, in the sole witness for
    truncation detection; `meta.workflow_timers` accepts a `cron_schedule` row with a NULL
    expression; and `meta.job_runs.status` admission is reported and never refused, so a fleet that
    cannot dead-letter boots quietly.
14. ~~**Three authorization defects reachable only from an authored manifest.**~~ — **closed by
    ADR-0361**, which corrected every one of the three and found two omissions that outranked them
    all. The asymmetry was real and reproduced live on both stores: a trait-contributed `pii` field
    was writable *and* readable by a role the boot line in the same process said could do neither,
    with the create response handing the plaintext back. But it is **seven** raw readers of a field's
    classification and seven resolving, not three and two; the **audit trail does the opposite of
    what the entry says** and fails *closed* (`redactAuditPayloads` drops `redacted ∪ undescribed`,
    so the field is withheld even from a `pii`-privileged reader — a capability gap, not a
    disclosure); "two surfaces report it as classified" was **one** in the measured deployment and is
    a property of the manifest rather than a constant; and the `maskWrite` claim describes a shape
    with **zero shipped members** (12 fields carry a `create` arm, all 12 declare `update`, none is
    create-only) while **missing the half that is live on all 12** — a create refused by the *create*
    arm reported `explicit_update_grant`, so an operator was sent to widen a list that already named
    them, verified live where `ap_clerk` PATCHing the same field returns 200. The two omissions:
    `validateClassifications` read raw, so the `phi`-requires-`auditable` invariant was **bypassable
    by moving the declaration into a trait**; and `assessManifestRisk` plus `manifest-diff.ts`'s
    `classificationLayer` read raw, so **the reviewer's approval gate is on the narrow side of the
    split** — trait-carried PHI reports `level: "low", sensitiveFields: 0`, and weakening
    `phi` → `internal` on a trait field is approved unseen. On the third clause: **zero** views carry
    an override (132, every one `"inherit"`, which ADR-0282's own text already recorded), a report's
    and a dashboard's `permissions` are validated by **nothing** rather than being "in the same
    state" as a view's, and the hole is **13 positions of which the survey sees 9** — the entry missed
    `DashboardDeclaration.permissions.abac`. What is left of it is ADR-0361's own open ends: the
    reviewer's diff and `refusal.ts`'s unwired encryption-weakening gate are the sharpest remaining
    members and arguably their own increment, and `ui-schema.ts` is the widest — no trait field
    reaches the web client at all, so `created_at`/`updated_at` are absent from every view on all 68
    `auditable` entities in every deployment.
15. ~~**Six confinement fences infer RLS confinement from ownership without reading
    `relforcerowsecurity`.**~~ — **closed by ADR-0362**, which corrected every figure in this entry.
    It is **three** predicate implementations and **one** defect, not six fences; the refusal string
    appears in **seven** non-test modules of which only three emit it; and "one column in six
    queries" is one column in **one** query plus one branch, the six being probe *invocations*. The
    `sessionWouldBeConfined` two-caller count was right. What this entry could not see is the part
    that mattered: the repo had already converged onto the **wrong winner**, since the copy ADR-0352
    extracted as the only correct one of eight scores **6 of 8** against live ground truth while
    `row_security_active` — Postgres's own answer, sitting unremarked in the Article 17 erasure —
    scores **8 of 8**. The live defect was a third spelling in `probeJobQueueVisibility`, where an
    owner of a FORCEd table read `visible` while seeing none of the rows, confirmed destructively.
    Latency was right and is now irrelevant: the verdict is asked for, so there is no composition
    left for a hardened deployment to break. The one open end is in ADR-0362's own table — whether
    the switch's loosening at the rekey's pre-destruction fence, correct for a
    `SUPERUSER NOBYPASSRLS` session and measured at a population of zero, wants a flag.
16. **Two route families are guarded by a role name no deployment can change**, found while scoping
    ADR-0364 and verified independently. `BuildOperateHttpServerOptions.adminRoles` exists
    (`server.ts:220`) and is forwarded into `compileOperateServer` (`:360`) — and **`node.ts` never
    sets it**, so `DEFAULT_ADMIN_ROLES = ["erp_admin"]` governs `GET`/`PUT /v1/admin/settings` on
    every deployment there is, and **there is no `--admin-role` flag** to pass. Those two routes are
    *always mounted* and ungated even by the subscription gate, deliberately, so that a lapsed tenant
    can still load its billing screen. `node.ts:1336` is the second member and hardcodes the same
    literal for the marketplace admin routes, also with no flag. It fails **closed** — a deployment
    whose administrator role is named anything else simply cannot reach its own tenant settings,
    rather than the wrong principal reaching them — which is why this sits in P2 and not P0: the
    cost is an unreachable surface, not a disclosure. It is this run's recurring class on an
    *option* rather than a column (ADR-0339's `policyForEntity` with no producer, ADR-0336's flag
    subsystem with no evaluator), and the fix is one flag plus **two** wiring lines, with the open
    question being whether the settings routes and the marketplace ones want one grant or two —
    `--notification-admin-role` and `--credential-admin-role` are the precedent for two.
    **One addition from a later measurement, which is why it is two lines and not one**: `node.ts`
    has exactly two `buildOperateHttpServer(` call sites — the boot gateway and the **per-tenant**
    one — and *neither* passes `adminRoles` while *both* pass `settingsStore`. So a tenant serving
    its own activated manifest (ADR-0314) also gets the hardcoded `erp_admin` on its own settings
    routes, even when that manifest declares no such role. The routes are gated on
    `options.settingsStore !== undefined` and `node.ts` always constructs one and always passes it,
    so `GET`/`PUT /v1/admin/settings` are always mounted on both. Fail-closed is confirmed at the
    handler: `authorize` answers `""` on a role miss and the route returns 403 *"admin role
    required"*.

### P3 — debt and stale documentation

None of it produces a wrong answer and most is a trade-off already argued in an ADR. It earns a
place for one reason: several entries **actively misdirect the next reader**, and this file's own
method is that a stale figure misleads.

1. **Thirteen documented claims were false in the direction that wastes an increment. All are
   corrected above as of this register**, and they are listed here because the *pattern* is the
   finding: `KeyRotationMigrator` called callerless two increments after the ADR that wired it;
   `validateWriteMask` called callerless from the commit that gave it a caller; residency called
   unenforced when it answers 421/403 pre-auth; the tenant-retirement order defended by a foreign
   key ADR-0335 removed, with a **stale comment in the catalog contradicting the line below it** —
   and a later measurement found **two more comments citing that same vanished key**, in
   `tenant-deletion-routes.ts:33` and `deletion-pipeline.ts:427`, so the pair that justifies the
   retirement ordering is stale in three places at once;
   `ABAC_GRANT_POSITIONS` counted at eight when it is nine; the callerless declarations counted at
   16 when the array holds 15; "no top-level lint script" when one exists and passes vacuously; and
   the compose telling an operator "there is no rekey executor yet" after ADR-0349 shipped one.
   Six further items were **already closed** and listed as open: ADR-0307's `failed`-is-both-
   terminal-and-compensatable (resolved by deriving `CLOSED_INSTANCE_STATUSES` from the transition
   map), the composite foreign key (reconciled, including on a populated table), per-tenant data-key
   provenance (read by the serving process and by `rekey --plan`), the sev1–5/P0–P3 severity
   collision (a frozen total translation map), `PostgresKillSwitchStore` (wired), and the
   29-foreign-key drift plus the `DROP COLUMN` (documented end to end in `deploy/README.md:193-251`).
   ADR-0361 adds **five comments** to the pattern, and they are the most instructive kind because each
   asserted the correctness of the narrow read it sat on: `write-mask.ts`' *"the same source
   `redactionSpecForEntity` reads, so … cannot drift apart"* was **true and worthless** (both read the
   raw entity, so they agreed *in being wrong*); its *"re-derived from the same two inputs the rule
   itself read"* was false, 57 lines below a `fieldWriteGrant` whose own comment reads *"so no reader
   re-derives it"*; `validate.ts`' *"fails closed at serve time"* was false in the direction that made
   the gap look handled; `searchableFieldsFor`'s *"all text-like fields are searchable"* was false for
   a trait's; and `checkAbacObligations`' affirmative *"none declared"* — the line added so a clean
   survey could not be inferred from silence — was inferring it from a narrower survey. The lesson is
   one sentence: **an invariant two readers agree on is not an invariant either is right about.**
   Two further figures were corrected against measurement: the register's "28 views carry a
   `permissions` override" is 132 views with **zero** overrides (28 is the count of distinct authored
   view *declarations*, and `permissions: "inherit"` is an explicit opt-out written by `erp-core`'s
   own `listView` factory — ADR-0282's text already said so), and the rule's own two `fails_open`
   notes claimed "live" for traits **no pack declares**.
   **ADR-0362 adds three more and they are the sharpest yet, because all three are inside one
   increment and one of them is that increment's own.** (a) A retired test pinned an exhaustive
   truth table over four catalog facts and compared the rule against an `ownershipOnly` derivation
   **written in the test itself**, calling the single disagreement a property — two spellings of one
   composition, agreeing, with no database ever consulted, under a comment claiming it asserted
   "the intended rule and not merely agreement with the code". (b) **Four** comments in four
   packages described the composed confinement rule and the **accurate** one described the
   *defective* code (`node.ts` enumerated three facts, which was true of `job-claim.ts`), while two
   understated a correct read and one was right; three were found by survey and the fourth by the
   new text fence on its first run. (c) A comment **this increment wrote** defended its own
   permissive default with *"every caller checks `rlsEnabled` first"* when only one of three does —
   found by adversarial review twenty minutes after the commit shipped, on the path where the
   unguarded caller is the rekey's pre-destruction fence. Two sibling instances landed in the same
   increment at a one-commit distance: a comment citing a bind position (`$16`) that a parallel
   slice had already shifted to `$17`, and a clause **count** ("eleven") that the same increment
   took to thirteen. A bind position and a count in a comment are volatile by construction.
   **A later pass over this register added four more members, and the shape of the fourth is new.**
   Two were *citations*: this register sent a reader to `README:181` for backup prose that is at
   `:441-442` and `:821-831`, and it called the stack's backup "no cron, no retention" when
   `deploy/ORACLE.md:500-510` ships both — true of the compose stack, false of the document an
   operator follows. One was a *scope*: the retirement-ordering comment is stale in **three** places,
   not one. And the fourth is a **cross-reference off by one**: ADR-0371's own Alternatives cite its
   open questions as 3 and 2 where it means 4 and 3, consistent with Q1 having been inserted at the
   head of the list after the alternatives were written — so a reader following either pointer lands
   on the wrong question, which no figure-checking catches because both numbers are real questions.
   A pointer into a list goes stale when the list is reordered, and nothing in this repo compares the
   two.
2. **Six concepts are modelled several times over, two with non-nesting member sets.** Data
   classification has five declarations — four identical and one, in `data-lineage`, **disjoint past
   two members**, so the moment anything bridges the kernel's classification into the lineage graph
   a hand-written mapping decides whether `pii` becomes `pii_personal`. Environment has three
   non-nesting sets, so you cannot record a flag evaluation in `local` or a deployment to `sandbox`.
   ABAC has nine declarations across six packages with four attribute value types, two honoured by
   nothing — **including the surviving name of the field ADR-0340 deleted on the stated rule that
   such a field must not survive under its old name**. Plus two flag vocabularies sharing six
   names, two runbook contracts joined by a thrice-duplicated regex, and two `Accept-Language`
   parsers.
3. **The twelve rules have seven self-blind spots, including a silent skip and a structural anchor.**
    (This item was written against ten and was already stale at eleven when `manifest-event-names.ts`
    landed in ADR-0362; `pg-unreadable-rows.ts` is the twelfth. Its own limits are declared in it and
    add nothing here, with one exception worth knowing: two inline conversions in one scope share a
    key, which is safe exactly while at most one of them needs a declaration — a workspace test
    asserts that rather than assuming it.)
   `pg-record-reads.ts` drops a row interface with fewer than three catalogued columns with a bare
   `continue` and no finding — the same shape as that increment's own defect, caught only because a
   count moved. `stripComments` is shared by all ten and was wrong about regex literals for four
   increments, and **nothing relates the shared scanner's output to its consumers' counts**. Also:
   no `renamedFrom` for a policy or constraint; table-level value-set CHECKs unread; 11 strict
   bounds and 213 patterns not probeable, so the boot census overstates its own coverage; and the
   tenth rule's anchor is an `Entity`-typed binding, so a reader that receives its fields through a
   **structural local type** is invisible to it — which is exactly what `EntityLike` was in
   `list-query.ts` until ADR-0361 deleted it, and is the same shape as this entry's other members.
4. **Three job record contracts, a scope constant and four fields are constructed or read by
   nothing.** `JobRunRecordSchema`, `DeadLetterRecordSchema` and `JobCostRecordSchema` have no
   construction site anywhere, yet three catalogued CHECKs are adjudicated against them — so
   ADR-0353's `mirrors` compares the catalog against a type no deployment exercises, which is the
   vacuity that rule exists to end. The cost vocabulary also names a serverless platform the repo
   has no client for. Alongside: `PLATFORM_COLUMN_KEY_SCOPE` has no non-test reader,
   `PostgresDataKeyStore.destroy` has no caller, and `ColumnSecretRefused` is narrower than its
   32 uses.
5. **`meta.job_runs` has no `due_at` column**, so `started_at` carries the due time and nothing
   records when a handler began — verified by ADR-0355's live run, where a 09:17 clock against a 3am
   cron wrote `started_at = 03:00:00Z`. A subsystem change wearing a column's clothes: the claim
   predicate, the `ORDER BY`, `idx_job_runs_due` and the retry path move together against a live
   fleet.
6. ~~**The four-eyes attestation enforces identity and not time.**~~ — **closed by ADR-0362**,
   which **refuted this entry's own proposed fix**. One `superRefine` clause pinning
   `attestedAt === decidedAt` would have been vacuous for every persisted row and worse than
   nothing: `rowToDecision` fills *both* from `row.decided_at`, so the equality holds by
   construction on every read, and the clause would have declared the unstored field equal to the
   stored one — making a measured silent three-hour rewrite legal by decree, ADR-0337's
   falsely-true-control direction. "Binds neither" was true and incomplete in the decisive
   direction: **there was no column to bind**, and the `INSERT` was *complete over the catalog*,
   which is why none of the ten workspace rules reported it — they compare SQL↔catalog or
   catalog↔a value set, and **none compares a contract field to a catalog column**. The census of
   five construction sites was also incomplete (seven, two with a non-null `coAttestedAt`, both
   coherent). What shipped instead: `attestation_phrase` gets a column because it duplicates
   nothing and is the only evidence its kind carries, `attested_at` deliberately does not because
   it duplicates `decided_at`, `rowToDecision` **parses**, and the ordering clause lands on the
   pair that *has* columns — `coAttestedAt >= attestedAt`, where a `two_person_attestation` with
   `coAttestedAt` in 2020 and `attestedAt` in 2026 had been parsing and storing. The remaining
   open end is that a signature over an authored attestation is still not recomputable from its
   row, which needs either the second column or dropping the field from
   `canonicalAttestationBytes` under a `.v2` tag.
7. **983 files under `packages/*/src` are unformatted**, not the 882 on record — and re-measuring
   it found the figure was also *scoped* without saying so: repo-wide it is **1687**. Both measured
   just now (`npx prettier --check "packages/*/src/**/*.ts"` and `npx prettier --check .`), which
   is the point of the entry rather than the numbers: a figure carried forward without its scope
   drifts in two directions at once.

### Demoted, with the measurement that demoted them

Kept so nobody re-raises them. A **relaxed `cascade` undercount** is vacuous — all seven packs relax
exactly two `set_null` edges and zero cascades, and the boot warning filters to cascades. A
**`relationCount` vs `model` contradiction** is unformable from the shipped wiring, since `node.ts`
derives both from the same inputs and sets `targets: []` for every store but `pg-columns`. A
**JSONB-fallback tenant's erasure** is not a data-loss risk: such a tenant has no schema, so the
attestation takes the honest `nothing_to_erase` arm and their records sit in one of the 97 erasable
tables. A **permuted ABAC batch** is unreachable: the only producer is a positional map over the
single evaluator, structurally incapable of permuting. The whole **ABAC residual family** is latent
*by construction* — `surveyAbacObligations` over all seven packs returns **0 obligations in all
nine grant positions**, there are **0 `many_to_many` relations**, and `--abac-policy` appears
nowhere in `deploy/`. The **factory blind spot** (ten stores behind a factory) is census hygiene,
not dead capability: all ten factories have real callers, and the compiler-API answer was measured
and refused twice. **v1–v3 proofs being permanently unprotected** is irreducible and correctly so —
re-signing them under v4 would forge the one alarm the chain cannot raise. And **extracting the
catalog parser** is debt with a defensible reason to stay: one parser is what keeps ten rules
agreeing about the catalog.

## ADRs

`docs/adr/index.md` is generated from the ADR files by
`python3 docs/adr/generate-index.py` — run it rather than hand-editing, so a
title or status change cannot drift. 372 records; 293 Accepted, 79 Proposed (the
Proposed ones are largely Phase-1 design ADRs that were never re-statused, and
include `0000-template.md`, which the count has always included).

ADRs **0080–0085** were reserved by ADR-0077 for Phase 3 P3–P8 and never
written; those milestones landed under other numbers. The gap is permanent.

When you ship something, write its ADR in the same session, following
`0000-template.md`: what was broken, the decision and the rule behind it, what
was verified live, and the follow-ups you are explicitly leaving open.
