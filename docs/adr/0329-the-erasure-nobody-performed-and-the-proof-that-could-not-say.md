# ADR-0329: The erasure nobody performed, and the proof that could not say

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-05 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0287, ADR-0289, ADR-0290, ADR-0292, ADR-0299, ADR-0302, ADR-0310, ADR-0313, ADR-0315, ADR-0316, ADR-0317, ADR-0319, ADR-0320, ADR-0321, ADR-0322, ADR-0323, ADR-0324, ADR-0326, ADR-0327, ADR-0328 |

## Context

ADR-0328 closed the hole where an Article 17 proof's *scope* was chosen by the HTTP request body.
`DeletionCapabilities` became a deployment-declared total map, and `--deletion-capabilities` became
mandatory for the deletion flow. It left four things on the table, and this ADR is about what
happened when we went to pick them up.

**First, the declaration was honest and unprovable.** ADR-0328's own text: "a declared absence is
**not** inside the signed bytes yet; carrying it there needs a `crossengin.tombstone.content.v1` →
`v2` domain tag rather than an edit in place, or every stored digest stops verifying." So a
deployment could declare `object_storage: "absent"`, the assembler would carry the declaration out
*beside* the record, and the proof committed to nothing about it. Two deployments that destroyed
exactly the same rows — one with no cache layer at all, one whose cache layer happened to be empty —
produced **byte-identical** content manifests, because `nothing_to_erase` may carry no figures
(ADR-0317) and the declaration was not in the bytes. The harder claim and the cheaper one were the
same proof.

**Second, four of the six subsystems could not attest, because their erasures did not exist.** The
honest reading of that is in ADR-0328: a deployment had to declare them `absent` or get no deletions
at all. But one of the four was not a missing integration — it was the platform's own database.
**112 of the 143 `META_TABLES` carry a `tenant_id`**, and nothing erased a single one of them.
`shared_tables` had no implementation, so every deployment declared it `absent`, and an Article 17
tombstone was signed over a tenant whose rows were still sitting in `meta.operate_entity_records`.

Worse, ADR-0319's protection against a caller attesting for work it did not perform was written for
exactly one subsystem and spelled `.filter((a) => a.subsystem !== "tenant_schema")`. A deployment
that declared `shared_tables: "erases"` could hand in its own attestation about an erasure nothing
performed, and the pipeline would fold it into a signed, anchored proof.

**Third, the tombstone sweep could stop and nobody would know.** ADR-0327 gave the sweep laps and
ADR-0328 gave it `pagesAdvanced`, and then said plainly: "nothing reads `pagesAdvanced` either, so a
stalled sweep is detectable and undetected." That is the worst shape a verifier can fail in, because
the findings surface goes quiet in precisely the same way whether every proof verifies or none is
being read. And `onTombstoneResolved` existed with no caller, because a clean sweep page does not say
a *particular* tombstone verifies — it may simply not have been on the page.

**Fourth, voice could not bounce.** ADR-0328 wired `TwilioVoiceSender` from the environment and left
the other end: "`bounce-webhook.ts` has no voice source, so Twilio's `CallStatus`/`AnsweredBy` posts
land on a route that does not know their shape and a carrier failure produces no suppression."

And one follow-up named in ADR-0313 — "`--audit-read-sensitive-role` grants unredacted payloads
wholesale; per-class grants (pii but not phi) are not expressible."

## Decision

**1. The capability declaration goes inside the signed bytes, as a new proof version.**

`crossengin.tombstone.content.v2` is a second domain tag over the scope *and* the declaration. v1's
bytes and tag are untouched, and `crossengin.tombstone.proof.v1` is unchanged for both versions —
the proof payload commits to `contentManifestSha256`, which is version-bound by its own tag, so the
proof inherits the version without its own bytes moving. Every stored `proofSha256` and every
forensic chain payload still verifies, and the chain transitively witnesses the declaration.

A verifier selects the version from the record's **explicit `proofVersion` field**, never by
inferring it from whether a declaration is attached: an inference would read a declaration somebody
*deleted* as an older record, which is a tamper that covers its own tracks. The contract pairs the
two fields in both directions — v2 must carry a declaration, v1 must not — so a relabelling is
refused rather than hashed best-effort.

**2. `shared_tables` is a real erasure, and a performed subsystem.**

`eraseSharedTablesWithin` derives its targets from `META_TABLES` — every table carrying a
`tenant_id`, minus a **compile-time** retention set of 16 — deletes in reverse catalog order (relying
on the meta-schema invariant that an FK resolves to a table declared earlier), measures what it
destroyed in the same statement that destroys it, and confirms absence before returning. The
retention set is a constant and not configuration, because a caller-supplied retention list would be
ADR-0328's defect in a new field.

The rule that decides the set: **a retained table holds the platform's record of what happened to the
tenant; everything else is the tenant's data and goes.** So the tombstone, the deletion request, the
forensic chain and its checkpoints, the audit log and its verdicts, the lifecycle events, the
compliance attestations and certification reports, the public-key registry the chain's signatures
resolve against, and the six access-review tables stay. `tenant_data_exports` does not — a copy of
the subject's own data behind a TTL'd link is reached by Article 17 as much as the original.

ADR-0319's single-subsystem filter becomes a **refusal**, keyed on `Object.keys(ATTESTERS)` so a
subsystem the pipeline performs cannot be missing from the protected set. A caller that attests for a
performed subsystem gets a refusal at a new pre-transaction `input` stage rather than a silent drop,
because a caller that believes it is contributing evidence and silently is not is ADR-0317's defect
exactly.

**3. A stalled sweep is a reported condition.**

`attemptsWithoutAdvance` counts audit ticks that did not move the cursor, built on ADR-0328's rule
that **reaching the end of the table counts as motion** — so an empty table and a single-page table,
which lap on every tick, reset it forever rather than reading as stalled. The two kinds split on
whether any page came back at all: `no_pages` (the store is unreachable or every page is throwing)
versus `pinned_cursor` (pages arrive and the position does not move). It is reported through *both* a
callback and `sweepProgress().stall`, because the half that matters most never reaches the findings
surface — a `no_pages` stall *is* a throwing sweep, so there is no page to hand over.

`verifyTombstone(id)` is the targeted re-read that gives `onTombstoneResolved` a caller that can
substantiate a recovery, and `tombstoneStanding` is the extraction of the rule the sweep already
applied inline, so a targeted check cannot be stricter or laxer than the sweep.

**4. `twilio_voice` is the bounce webhook's third source**, and the boundary is **not** "will it
recur" — almost everything recurs. **It is whose fact it is.** A permanent code is a statement about
the *destination* (not dialable, invalid destination, unallocated); a transient one is a statement
about *us* or the moment (geo-permissions, an unverified trial number, a `From` we do not own), and
produces **nothing** rather than a bounded soft row. `13225` (Twilio forbids calls to this number)
and `21216` (our account is not allowed to call it) are near-identical English on opposite sides of
that line, and both are spelled out.

`busy` and `no-answer` suppress nothing and are checked *before* the code table, so a code riding
along cannot route around them: the line is live, a handset is on it, and `hard_bounce` is
unconditional — the row would outrank a security alert on the channel an on-call rotation reaches a
person by.

**5. Per-class sensitive grants.** `privilegedRolesByClass` makes "pii but not phi" expressible, on
one rule: **a class with an entry is authoritative for that class**, and the wholesale
`privilegedRoles` applies only to classes with no entry. Read as a union instead, a wholesale
grantee could never be withheld from `phi`, which is the one narrowing the feature exists for.
`{phi: []}` is a refusal, not a fall-through.

## Alternatives considered

- **Option A: add `capabilityDeclaration` to the v1 content manifest in place.**
  - **Pros:** one version, no `proofVersion` field, no second code path.
  - **Cons:** every stored tombstone's `contentManifestSha256` stops matching, so
    `verifyStoredEvidence` reports `scope_tampered` on every honest proof on file — and
    `scope_tampered` is the one defect the forensic chain structurally cannot refute (ADR-0323), so
    the deployment would page a `sev1` per record about a tamper that never happened.
  - **Why not:** it converts a correctness improvement into a mass false accusation. ADR-0328
    already named the domain tag as the required mechanism.

- **Option B: infer the proof version from whether a declaration is present.**
  - **Pros:** no new column, no new field, no pairing refinement.
  - **Cons:** deleting the declaration from a stored row would read as "this is an older record"
    rather than as a tamper, and the v1 digest it then recomputes is the one the attacker wants.
  - **Why not:** the version is the thing that selects the hash function. Making it inferable from
    the data it ranges over lets the data choose how it is checked.

- **Option C: make the shared-table retention set configurable.**
  - **Pros:** a deployment with extra tenant-scoped tables could extend it.
  - **Cons:** it is exactly ADR-0328's defect in a new field — the reach of an Article 17 proof
    chosen by whoever writes the config, with silence meaning "retain", the safest-looking and most
    wrong default.
  - **Why not:** a table is either the tenant's data or the platform's record of what happened to
    it, and that is a property of the catalog, which is compiled in. A new tenant-scoped table that
    joins neither set fails a test that names it and says which set to join.

- **Option D: let `shared_tables` report `retained` for statutory business records (invoices under a
  7-year obligation) and `erased` for everything else.**
  - **Pros:** legally the most accurate description of what a real deployment does.
  - **Cons:** a subsystem may attest exactly **one** outcome, so this needs either per-table
    attestations or a composite outcome — both of which change what a `DeletionScope` is.
  - **Why not:** out of scope here, and the alternative of smuggling it in as a quiet retention is
    worse than not expressing it. Recorded as an open end rather than approximated.

- **Option E: escalate a stalled sweep as a paging `sev1`, like a tamper finding.**
  - **Pros:** a log line in a process nobody tails is close to silence, which is the complaint this
    ADR opens with.
  - **Cons:** ADR-0324's `sev1` is for a *detected* falsified proof — a fact in hand. A stall is the
    opposite shape: nothing has been found and nothing may be concluded about any row. It also
    persists for as long as the misconfiguration does, so it would compete with real tamper pages on
    the same rotation and train people to ignore the channel the real finding arrives on.
  - **Why not:** declare-not-page is probably right and it needs a severity-selection decision and a
    third `EscalationSubject` kind, which is its own increment. The detector, the two reporting
    surfaces and the error-level log close ADR-0328's named follow-up; the escalation is new ground
    and is left open with the recommended shape written down.

- **Option F: suppress voice on `busy` / `no-answer` with a bounded soft row.**
  - **Pros:** a number that is always busy is, practically, not reachable.
  - **Cons:** `soft_bounce_exceeded` means a *threshold was crossed*, and counting needs state a
    pure module does not hold; it is also in `UNCONDITIONAL_SUPPRESSION_REASONS`, so a bounded row
    would still outrank a `security_alert` for its whole window.
  - **Why not:** it blames the callee for a moment, and keeps blaming them. The transients are
    *named* rather than merely omitted, so nobody "completes the table" later.

- **Option G: widen `meta.workflow_events.kind`'s inline column CHECK for the two new event kinds.**
  - **Pros:** the obvious one-line edit, matching all 741 other column-level checks.
  - **Cons:** `declaredCheckConstraints` reads only `table.constraints`, so a column-level `check`
    expression is **never compared** — `expectedCheckConstraintNames` adds its name to the expected
    set purely so a correct database is not reported as drifted. A fresh install would get 27 values
    and every already-migrated database would silently keep its 25 and reject both new kinds at the
    first append.
  - **Why not:** the constraint moved to a named table-level one instead, which the reconciler
    matches by name and compares through ADR-0292's deparser. The name chosen is exactly the one
    Postgres gives a single-column column check, so on a database that applied the column form the
    declaration matches the live constraint and reports a changed *expression* rather than a missing
    constraint plus an undeclared one. Verified both ways against a real cluster by recreating the
    25-value constraint under its Postgres-given name: on an **empty** table the plan is a single
    guarded `replace_table_constraint` and applies automatically; on a **populated** one it is
    reported `constraint_needs_validation` with the `DROP`/`ADD` pair *and* a ready-made
    `SELECT … WHERE NOT (…)` naming the rows that would refuse it.

    Worth stating plainly, because it is the operational cost: a *widening* CHECK can never fail
    against existing rows — every row satisfying 25 values satisfies 27 — but the reconciler cannot
    tell widening from narrowing without understanding the expressions, so any deployment with
    workflow history runs that `ALTER` by hand. Reported and refused beats planned and wrong, and
    the alternative was not reported at all.

## Consequences

- **Positive.** A declared absence is now part of the claim: "we have no object storage" and "our
  object storage held nothing" are different proofs. 112 tenant-scoped platform tables are actually
  erased, and the proof says so with figures it measured itself. A caller can no longer contribute
  evidence about work the pipeline performs. A sweep that stops says so. Voice bounces. A reader can
  be granted pii and withheld phi in the same response.

- **Negative.** `shared_tables` can no longer be declared `absent`, so every deployment's
  `--deletion-capabilities` must name it `erases` or `retains` — a breaking configuration change,
  caught at boot by the contract rather than at the first deletion. The v2 path is a second code
  path in the proof module, and the two columns it needs are load-bearing in a way the others are
  not: a row written v2 and read back as v1 recomputes the v1 digest and reports `scope_tampered` on
  an honest proof. Three test row-builders had to learn the columns, and the failure they produced
  before they did is pinned as a regression guard in each.

- **Neutral.** `TombstoneAssembly.ok.declaration` is now redundant on the v2 path and kept as a
  convenience. Narrowing Twilio's voice `StatusCallbackEvent` from four events to `completed` is
  strictly fewer callbacks for the same information.

- **Reversibility.** The proof version is the hard part: a v2 record cannot be read as v1 without
  recomputing its digest, so reverting means a migration over every v2 row, not a code change. The
  shared-table erasure is reversible as code but not in effect — the rows are gone. The stall
  detector, the per-class grants and the voice source are all additive and removable.

## Implementation notes

- **Ordering.** `eraseSharedTablesWithin` runs **before** the schema erasure in
  `deleteTenantAtomically`, because every one of its refusals lands before it writes anything —
  that is what keeps "a returned refusal means nothing was destroyed" true for both erasures. The
  consequence is that a *schema*-erase refusal now surfaces as `DeletionPipelineAborted` rather than
  `{ok: false}`; the route maps both to 409 and only the error code changes.

- **`rls_would_confine_this_session` is not theoretical.** Verified live: as a non-owner role with
  grants but no tenant context, the `DELETE` matched 0 rows, reported 0, and the confirm-absence
  `count(*)` also saw 0 — while the rows were still there. Both read through the same policy, so the
  confirmation cannot catch it. The probe refuses up front, naming all 96 erasable tables.

- **The two new columns.** `proof_version TEXT NOT NULL DEFAULT 'v1'` — not nullable, because the
  version selects which bytes the digest commits to and a NULL makes that unanswerable; the default
  is correct because every row written before the column existed was genuinely v1.
  `capability_declaration JSONB` nullable, paired with the version by the contract rather than a
  CHECK, since adding one to a populated table is ADR-0299's manual case.

- **The stall threshold is 3, and a malformed `stallAfterAttempts` reads as the default, not off** —
  the opposite of `auditEveryTicks`, because there "off" is the status quo and here "off" is
  precisely the silence this ADR exists to end.

- **Voice idempotency is nowhere, deliberately.** Only a terminal `failed` plans anything, so at most
  one callback per call can; `suppressionIdFor` commits to (tenant, channel, normalised address,
  reason) and *not* the `CallSid`, so a repost plans the identical record and the store's
  `ON CONFLICT … DO NOTHING` declines it. Adding `CallSid` would **destroy** that property — two
  calls to one dead number would plan two ids for one fact.

- **Live verification.** A throwaway Postgres 16 with all 874 bootstrap statements applied.

  The shared erasure across two tenants (rows erased, the second tenant untouched, the audit log and
  chain retained, a second run reporting `nothingToErase`); delete order surviving a
  self-referencing `ON DELETE RESTRICT`; a dropped table reported `table_missing` with nothing
  deleted; a throwing transaction leaving every row in place. `partitionSharedTables` over the real
  catalog: **112 tenant-scoped, 96 erasable, 16 retained, 0 unclassified.**

  The v2 round-trip end to end, which is the claim the two columns exist for: assembled
  `proofVersion=v2` carrying the declaration, written and anchored at a real chain sequence, read
  back `proofVersion=v2 declarationPresent=true digestMatches=true`, and `verify` answering
  `{contentManifestOk: true, proofOk: true, anchored: true, matchesAttestations: true}`. Then the
  tamper the chain cannot see, applied with a bare `UPDATE … jsonb_set(scope, '{rowCount}', '99')`:
  `contentManifestOk` flips to `false` while **`proofOk` stays `true`** — ADR-0323's division of
  labour, unchanged by the new version, and the reason `verifyStoredEvidence` is the only detector.

  The voice bounce source against the real server with `--bounce-webhook` and a genuine per-tenant
  HMAC: a `CallStatus=failed` with `ErrorCode=21214` landed one row as
  `voice_call | hard_bounce | provider:twilio_voice | +1555…` — the actor slug being exactly
  `TwilioVoiceSender.provider`, so the suppression names the same string the delivery attempt
  recorded. Then the four judgement calls, each live: a repost under a **different `CallSid`** planned
  the *identical* suppression id and answered `already_present` / `duplicates: 1`, which is the
  property adding `CallSid` to the id would have destroyed; `busy` answered `422` with "the line was
  reachable and nobody answered"; the transient `21216` answered `422` with "describes our own
  configuration, not the number", which is the `13225`/`21216` distinction working; and a *messaging*
  callback posted to the voice source answered **400** naming the misroute, which is the one
  misconfiguration that will actually happen.

  The per-class grant against the real server with the `erp-healthcare` pack, in both directions: a
  named `phi=` withholding beside a `pii` grant, and then the same withholding beside a
  **wholesale** `--audit-read-sensitive-role`, which is the direction that proves the
  authoritative-class rule rather than merely exercising it. Both returned
  `after: {"status": "active", "given_name": "Alice"}` with `redactedFields: ["mrn"]` — pii readable
  and phi withheld from one reader in one response, including when that reader held the wholesale
  grant.

  Two of this session's own defects were found only here and not by any test: a hand-rolled
  `DeletionScope` from `erasure.erasedTables` (which is `SharedTableRowsErased[]`, not strings)
  instead of the `sharedTableErasureScope` handoff that exists for it, and
  `shared-table-erasure.js` missing from `packages/tenant-lifecycle-pg/src/index.ts` — the whole
  erasure was unreachable from outside its own package, and every in-package test imported it by
  relative path and so could not notice.

- **A green per-package test run is not evidence when a contract changed.** Adding the
  `shared_tables: "absent"` refusal to `DeletionCapabilitiesSchema` and then running
  `pnpm --filter @crossengin/tenant-lifecycle-pg test` reported **219 passed** — against a `dist/`
  built before the refusal existed. The workspace sweep rebuilt it and the same suite failed 31
  tests and one whole suite, because four fixtures declared exactly the disposition now refused.
  This is ADR-0307's lesson in a second form: there, running vitest was not running the type
  checker; here, running vitest was not running the *build*. A cross-package contract change needs
  `pnpm -r build` before its consumers' tests mean anything.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Should a stalled sweep declare an incident (recommended: `sev2`, keyed `deletion_evidence:sweep`, kind as a timeline note so a flapping database is one episode)? | Platform | 2026-11-30 |
| How should statutory retention of business records be expressed, given one outcome per subsystem? | Platform | 2026-12-31 |
| Should workflow instance cancellation get an HTTP route, as job cancellation has? | Platform | 2026-11-15 |
| Should column-level CHECK expressions be compared generally, or should the catalog's 741 of them migrate to named table-level constraints? | Platform | 2026-12-31 |
| Does a declared `absent` belong in the chain payload as well as the content manifest? | Platform | 2026-12-31 |

## References

- GDPR Article 17 (right to erasure), Article 12(3) (deadline).
- Twilio Programmable Voice: call status callbacks, `AnsweredBy`, voice error codes.
- RFC 9110 §10.2.3 (`Retry-After`), for the retry vocabulary this ADR inherits.
- ADR-0317 (a tombstone is composed from attestations), ADR-0319 (the pipeline attests what it did),
  ADR-0323 (the tamper the chain cannot see), ADR-0328 (the scope is declared by the deployment).
