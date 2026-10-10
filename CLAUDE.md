# CLAUDE.md

Project state for AI assistants resuming work on this codebase. Read top to
bottom once, then keep nearby.

**This file describes the shape of the system, not its history.** History lives
in `docs/adr/index.md` (generated — 349 records). Earlier versions of this file
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

**87 packages + 3 apps, 146 meta-schema tables, ~18,250 tests**, all green, no
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
  empty policy refused everyone and only an explicit per-field `read` grant came back) and **39
  were writable by anybody** with entity `update` (the mask had no caller). Neither side had a
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
  `planSchemaReconciliation` reports `constraint_needs_validation` on a populated table rather than
  planning it — which means **every enum value the catalog has ever added is refused `23514` on every
  already-applied deployment until an operator runs an `ALTER` by hand**, with nothing saying so until
  a write fails. Three increments did exactly that and each was found by hand: ADR-0300 (three flag
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
  that class has been found (ADR-0330's erasure, ADR-0349's rekey), and converging it found that the
  rule had **eight spellings** of which only `KeyRotationMigrator`'s private copy read
  `relforcerowsecurity`, the one input that overrides ownership.

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
  machinery than a fence. So `pg-value-set-domains.ts` is the sixth strategy rule and all 287
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
  immutable-by-RLS once written. `DELETE` is reachable by no policy on any of the 32. The one
  remaining member of the class is `meta.audit_integrity_verdicts`, whose hole is differently shaped —
  see *What's actually left*.
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
  without executing. The plan holds one invariant — **every step in it is expected to succeed** — so
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
  `replace_column_check` on an empty table — safe because **neither identifier in the statement is
  inferred** — and reported `constraint_needs_validation` with the SQL on a populated one. A name the
  plan would have to *predict*, `ChooseConstraintName`'s numeric suffix inside a shared family, is
  never written and reads `column_check_name_unavailable`. Costs one probe per declared column
  check (**777** as of ADR-0352, ~850 ms, flat in row count).
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
  measured, the owner counts 1 and a non-owner 0 while the `ALTER` genuinely raises.
  `sessionWouldBeConfined` in `introspection.ts` is the rule that decides it, extracted because it had
  **eight spellings** and only `KeyRotationMigrator`'s private copy read `relforcerowsecurity`, the
  one input that overrides ownership. Only the *rule* is shared; each call site keeps its own query,
  since `commonRefusals` wants `has_scope_column` in the same round trip.
- **`types`** — deliberately tiny: branded primitive id types (`TenantId`, `UserId`,
  `RequestId`, `ManifestId`). One file.
- **`config`** — shared TypeScript / ESLint / Prettier config bases. No `src/`.
- **`testing`** — the shared `vitestPreset`. One file.

### Serving a manifest (the Operate stack)

- **`operate-runtime`** — the largest package and the heart of the product: it compiles a
  resolved manifest into a live multi-tenant API. Route/operation derivation and slugs,
  an `EntityStore` interface with typed list filters + keyset pagination + projection,
  RBAC-enforcing CRUD/lifecycle handlers — which **filter rows** since ADR-0345, when a
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
- **`operate-runtime-pg`** — Postgres `EntityStore` implementations plus the serving-side
  stores. Two store flavours behind one contract: `PostgresEntityStore` (tenant-scoped
  JSONB document table) and `ColumnMappedEntityStore` (real per-entity typed tables with
  DDL derived from the manifest — topological create order, composite tenant-scoped FKs
  with per-relation `ON DELETE`, m2m join tables, pgcrypto-encrypted PHI columns, SQL-level
  filter/sort/keyset/projection pushdown). Its column plan comes from the kernel's
  `resolvedFields`, the same function `validateManifest` uses, so **trait fields are real
  columns** and validation cannot accept a field the served table lacks; `ensureSchema`
  migrates additively (`ADD COLUMN IF NOT EXISTS`), so a manifest that gains a field no
  longer bricks the boot. Plus sequence allocator, settings, entitlement, subscription
  stores, Stripe webhook ingest and dangling-link pruning.
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
  `survey.ts` (ADR-0334) is `surveyManifestWorkflows`' shape for jobs — five verdicts
  (`handler_registered` / `served_by_kind_handler` / `deprecated` / `no_producer` / `handler_missing`)
  over `JOB_KIND_PRODUCERS`, a **total map over `JOB_KINDS`** naming which producer enqueues each
  kind. `workflow` and `cdc` are `"none"`, so a job of those kinds reports `no_producer` **in
  preference to** `handler_missing`: naming a fix that would not work is worse than naming none.
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
  registry gets. `computeFieldRedaction` and `validateWriteMask` — the classification-unaware
  originals — are still callerless and superseded by the classified pair.
  **A field grant has three arms since ADR-0348** — `read`, `update` and `create` — because the
  first two were *one list consulted at two moments*, so a grant could not say **set once at
  registration, never changed** and narrowing who may change a `required` field necessarily narrowed
  who may create the record. `create` **absent falls back to `update`**, which is what let the arm
  land without changing the meaning of a single shipped declaration, and `fieldWriteGrant(perm,
  writeOp)` is the one spelling of that fallback so no reader re-derives it. `update ⊆ read` is
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
  **Availability is part of the contract**: `ABAC_RECORD_AVAILABILITY` over the eight
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
  **`ABAC_DENIAL_EFFECT` is that second axis** (ADR-0345), a total map over the eight positions to
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
- **`access-reviews`** — periodic attestation campaigns (SOC 2 / ISO 27001 / HIPAA / PCI /
  GDPR / 21 CFR Part 11): campaigns, scoped items, decisions with attestation kinds and
  four-eyes, exceptions with per-reason duration caps, templates, sealed evidence with
  per-framework control mappings.
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
  and ships a replayer. `evidence-store.ts` (ADR-0335) is the writer `meta.access_review_evidence`
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
- **`i18n`** — locales (11 on the roadmap, incl. RTL Arabic variants), ICU MessageFormat
  parsing, CLDR plural categories, bundles, resolution chains, calendar/numbering systems,
  per-tenant config.
- **`search`** — Typesense/pgvector-style contracts: index manifest, 4 search kinds, facets,
  permission tags, embedding models and vector index kinds, reindex jobs.
- **`reporting`** — 7 report kinds (tabular, pivot, timeseries, kpi, funnel, cohort,
  custom), aggregations, dashboards on a grid layout, schedules and exports, ClickHouse
  audit sink, CDC pipeline health.
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
  as markup and `z.string().url()` accepts `javascript:alert(1)` (ADR-0313);
  the **read-only audit trail** (`--audit-read-routes`) whose reads are themselves recorded, where an
  unrecordable granted read is a 503 and a tenant naming another tenant is a 403 rather than a quietly
  narrowed query (ADR-0313); **job-run cancellation** (`POST /v1/meta/jobs/runs/{id}/cancel`, gated on the
  job-invoke roles, tenant from the credential, outcome reported as 200/202/409/404 — ADR-0315);
  the **GDPR Article 17 deletion flow** (`--tenant-deletion-routes`) — the only route that reaches
  `deleted`, which `platform-admin`'s transition map excludes on purpose; its own grant separate from
  the erasure's (erasing a schema is a step this contains), four-eyes at three layers, and the **only**
  route here that *requires* an idempotency key, because a retried delete generates a new tombstone id,
  erases nothing the second time and would 409 `scope_empty` for a request that had already succeeded.
  The tenant row is retired **after** the pipeline commits (ADR-0316's ordering: the anchor references
  `meta.tenants`), so a failed retire is `tenantRetired: false` on a **200** rather than an error that
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
- **`apps/operate-web`** — **long-running process** (Next.js app router + Tailwind, `next
  dev`/`next start` on :3000). The generic manifest-driven UI: a catch-all `/api/[...path]`
  proxy to operate-server, dynamic entity list/record/form pages under `/e/[slug]` rendered
  from the server's `UiSchema`, an inbox, reports (aging, WHT, period close), tenant admin
  (settings, billing), a setup wizard, and a platform console for tenant provisioning and
  design reviews. No package `bin`; deployed as a web server, not a CLI.

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
The constraint is **not** inert, though, and that is its live consequence: a tenant with no
`meta.tenants` row cannot have a data key at all, so `--column-key-mode envelope` answers every PHI
read and write for an unprovisioned api-key tenant with `tenant_data_keys_tenant_id_fkey` — reported
as a 504. A boot survey names them. It carries **no platform
arm**: a data key is never platform-scoped, `tenant_id` is NOT NULL, and a platform read arm would
let any tenant's gateway session read every tenant's wrapped key.

**`meta.tenant_tombstones.record_storage` is nullable with no default, and that is the whole
decision** (ADR-0351) — `retained_obligations`' choice for a sharper reason. NULL means *this
record's bytes do not cover a record-storage declaration*, true of every v1, v2 and v3 row, and
there is no honest default to give them: all three `RECORD_STORAGE_MODELS` are *claims*, so
`{"model":"document_rows",…}` would assert that the deployment had no typed relations — precisely
the assertion ADR-0350's gap made unavailable — written onto rows whose digests never covered it,
and then refused by the contract's version pairing anyway. The column's sibling is the widened
`proof_version` CHECK, and the two migrate **differently**: on an empty table the plan is
`2 steps, 0 unreconciled`, and on a populated one `1 step, 1 unreconciled` — the column lands and
the CHECK is handed over as SQL, because ADR-0330 cannot tell a widening CHECK from a narrowing one.
`apps/operate-server/src/proof-version-probe.ts` is the boot fence that makes the gap between them
survivable; see the `operate-server` entry.

**Every column-level value-set CHECK declares which contract domain governs it** (ADR-0353), in
`packages/testing/src/strategy/pg-value-set-domains.ts` rather than in the catalog — a ref is a
string either way, since the kernel cannot import *all* of the packages it would name, so the
declaration buys nothing by living here and would cost a `ColumnDefinition` field the emitter reads
nothing from. 287 of them, compared both ways every run. `META_DEPLOYMENTS` is why: its `app_kind`,
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

**`packages/testing/src/strategy/` holds the workspace-level rules**, and there are **seven** now:
`typecheck-config.ts` (ADR-0307), `pg-column-coverage.ts` (ADR-0333), which reads `META_TABLES`
and every store's SQL *as text* and asserts the two things a fake `PgConnection` structurally
cannot — that every column a statement names exists, and that every `notNull`-with-no-default
column is named by every `INSERT` — and whose `parseCatalogSource` carries `check` and
`defaultExpression` too (ADR-0353), because one catalog parser is what keeps two rules from
disagreeing about what the catalog says; `pg-storeless-tables.ts` (ADR-0334), which declares every
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
persistence is not a test double), **15 callerless classes declared** plus one callerless *member*,
so 16 declarations. (ADR-0337's own text records 285 / 19 / 21: that was measured before the same
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
declares, for each of the **287** catalogued value-set CHECKs, which workspace domain governs it —
**281** `mirrors`, **5** `catalog_only`, **1** `narrows` — and `mirrors` asserts **equality**, which
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
There is **no top-level lint script** —
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
  and now call `assertStatementIsScoped`. So: **a fake that answers a statement it
  could not really serve is a test asserting the wrong thing.** Reads stay exempt from
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
  `COLUMN_ENCRYPTION_SECRET` is in the compose `environment:` block and **never** in `command:`,
  because argv is readable via `ps`; the compose file also says what switching `OPERATE_PACK` to
  `erp-healthcare` or `erp-government` requires, since that is where an operator meets the refusal.

## What's actually left

Nothing planned is unbuilt; what remains are follow-ups named in the ADRs that
opened them.

**Load-bearing**

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
  — `KeyRotationMigrator` is still callerless, which is exactly why the `generation` parameter is
  exposed by no flag or env var: a deployment that bumped it would make every existing ciphertext
  undecryptable with no way back. **(3)** `unique: true` is unenforced on the column store
  (**zero** UNIQUE constraints across all 54 tables — it is simply not plumbed into the entity DDL, so
  this changed nothing) and *unenforceable* on an encrypted column, since `pgp_sym_encrypt` is
  non-deterministic: two rows with the same plaintext under a UNIQUE `bytea` both insert, verified.
  `Citizen.national_id` is both `unique` and `regulated`, so whoever plumbs `unique` must **refuse**
  the encrypted case rather than emit a constraint that silently never fires — ADR-0070's Q4 noticed
  encrypted columns cannot be *searched* and nobody noticed they cannot be *unique*. **(4)**
  `packages/security`'s `AT_REST_ALGORITHMS` offers AES and ChaCha AEADs and the mechanism is OpenPGP
  CFB+MDC, which is none of them, and nothing reads the enum. **(5)** no per-tenant BYOK, which
  `KEY_MANAGEMENT_KINDS`' `customer-managed-byok` models; `ColumnEncryptionKeySource` is the seam.
  **(6)** an encrypted field is dropped from `?sort` and filters **silently**, which ADR-0091 decided
  and matters more now that the ciphertext is real.
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
  one, so every enum value the catalog adds is refused `23514` on every already-applied deployment
  until an operator runs an `ALTER` by hand — found by hand three times (ADR-0300, ADR-0334,
  ADR-0351) and now detected, over **777** emitted column CHECKs of which **287** are value sets,
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
  `META_DEPLOYMENTS`; see *The table that could not accept its own record*. **(2)** a widening can now
  be **proved** safe, so `planSchemaReconciliation` could plan it instead of reporting
  `constraint_needs_validation` — ADR-0330's open end closed rather than merely measured. It needs
  the proof re-checked inside the statement's own transaction (`replace_column_check`'s `DO`-block
  pattern) and must refuse on a confined session. **(3)** `meta.job_runs.status` is reported and not
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
  CHECK is not read — all 287 are column-level today, so a value set written as a table constraint
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
  **(2)** the comparison is against the **symbol** and nothing compares it against the parameter
  *position*: a store writing `record.kind` into the `status` column passes this rule and
  `pg-column-coverage.ts` both. Column-to-property name agreement is measurable and legitimately
  violated often enough (`tenant_id` ← `scope`, `created_by` ← `actor`) that the threshold needs
  deciding before it can be a rule. **(3)** each of the 164 unreachable columns becomes checkable the
  moment a store lands and nothing says so at the time — the inverse of `table_declared_storeless`.
  **(4)** `UNCONSTRAINED_BINDINGS` describes a real weakness and the rule only reports it: typing
  `DispatchInput`'s four `string` fields against `@crossengin/notifications` is the fix, and it is a
  decision about whether `apps/operate-server`'s own persistence shape may depend on that contract.
  **(5)** `collectStoreTypes` and `collectWorkspaceDomains` both walk every source; one
  `workspace-symbol-index.ts`, as `workspace-sql-scan.ts` is for SQL, would halve that and remove the
  need for the cross-check. **(6)** a `DO UPDATE SET` assignment that is neither `$n` nor
  `EXCLUDED.col` — `status = CASE WHEN …` in `digest-store.ts` — is a value the *database* decides
  from the row, a third provenance beside a parameter and a literal, reported as neither.

- **Field-level write authorization exists now, and what is left of it** (ADR-0339 closed ADR-0338's
  Q7). The asymmetry it found was total and in the dangerous direction: of the **46**
  sensitive-classified fields across the seven packs, **39 were unreadable by every role in every
  deployment** and **39 were writable by anybody** with entity `update`. The read side was closed by
  an empty policy — `policyForEntity` had no producer in `operate-server`, so `privilegedForClass`
  answered false for everyone and only the 7 fields with an explicit per-field `read` grant came
  back; the write side was open because `validateClassifiedWriteMask` had no caller. Neither had a
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
  the entry after next. **(2)** `computeFieldRedaction` and `validateWriteMask`,
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
  which is exactly `pg-storeless-tables.ts`' argument one domain across. **(3)** `FieldPermission`
  has no `delete` arm and no per-transition arm, so *"this field may not be changed while the record
  is `posted`"* remains a write **guard** question and not a grant one; the two vocabularies do not
  meet. **(4)** `field_create` is unreachable in practice — a `create`-arm `abac` key is refused at
  boot by ADR-0340's check because its availability is `never` — so the position exists to be
  refused by name rather than served, which is correct and worth knowing before someone "wires" it.
  **(5)** the `read` narrowing is a judgement per field (drop the general-purpose observer roles),
  not a derivable rule, so a pack author adding a classified field gets the three refusals and no
  guidance. **(6)** `computeFieldRedaction` and `validateWriteMask` are now *further* from the live
  pair, since neither knows about the third arm, and still callerless.
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
  pinned.
- **`packages/workflow-signal-bridge` has zero importers** (ADR-0337), the `api-gateway-pg`
  condition before ADR-0335, invisible until the member predicate stopped being `*-pg`-restricted.
  This file says the package "ships as a registered gateway handler" — it ships the handler and
  **nothing registers it**, so no inbound webhook can deliver a signal to a workflow in any
  deployment, and its two driver classes (`WorkflowSignalBridge`, `StaticSecretResolver`) are
  callerless with it. A wiring increment of its own: it needs the HMAC secret resolver decided, since
  `StaticSecretResolver` is the offline one. `RegionRouter` in `residency-runtime` is the same shape
  one notch smaller — a residency profile is stored and never enforced.
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
  cheaper half of the same guarantee. Still a tightening that would land as standing manual SQL.

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
  `npx prettier --write` no longer reformats at width 80 — but **882** of `packages/*/src` are not
  Prettier-clean (the config existed since Phase 1 and was never applied), so there is deliberately no
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
  `apply` and drift check** (777 as of ADR-0352)
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

`web-ui/` (a separate static app) has **no deployment story** and is not in any
compose file or guide.

## ADRs

`docs/adr/index.md` is generated from the ADR files by
`python3 docs/adr/generate-index.py` — run it rather than hand-editing, so a
title or status change cannot drift. 349 records; 270 Accepted, 79 Proposed (the
Proposed ones are largely Phase-1 design ADRs that were never re-statused, and
include `0000-template.md`, which the count has always included).

ADRs **0080–0085** were reserved by ADR-0077 for Phase 3 P3–P8 and never
written; those milestones landed under other numbers. The gap is permanent.

When you ship something, write its ADR in the same session, following
`0000-template.md`: what was broken, the decision and the rule behind it, what
was verified live, and the follow-ups you are explicitly leaving open.
