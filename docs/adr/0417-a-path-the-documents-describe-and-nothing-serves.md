# ADR-0417: A path the documents describe and nothing serves

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-16 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0336 (`pg-unreachable-stores.ts`, and a store nobody constructed), ADR-0334 (`pg-storeless-tables.ts`, and a remedy that cannot work), ADR-0376 (`deployment-defaults.test.ts`, the first fence over `deploy/`), ADR-0390 (a document that destroys what it tells you to keep, and fencing prose by content), ADR-0381 (the membership revocation gate), ADR-0098 (the JWT tenant cross-check), ADR-0077 (Q6, multi-region gated on demand), ADR-0335 (the first `meta.users` writer), ADR-0301 (credentials never on argv), ADR-0362 (`manifest-event-names.ts`, a declaration fenced against a producer) |

## Context

Two kinds of text in this repository tell an engineer or an operator what a deployment can do,
and neither was checked for truth. The deploy documents (`deploy/README.md`, `deploy/ORACLE.md`,
`deploy/VERCEL-SUPABASE.md`, `deploy/.env.example` and the root `README.md`) are what an operator
follows. The `note`, `consequence` and `blockedBy` strings in `pg-storeless-tables.ts` and
`pg-unreachable-stores.ts` are the engineer-facing record of each gap, and those two rules check a
declaration's **shape** and never whether its sentence is true. Measuring register items P1.4,
P1.7, P1.9, P1.10, P1.12, P1.13, P1.14 and P1.17 against the tree found the same defect in both
kinds: **a sentence describing a path that cannot be followed.**

### Face 1: the deploy documents (slice E, `96ce874`)

**Production auth.** `deploy/README.md`'s *Going to production (auth)* told an operator to add
`--jwks-url https://your-idp/.well-known/jwks.json` with a second `--jwt-issuer`/`--jwt-audience`
for "real end-users". That command does not start: `cli.ts` refuses
`--credential-login and --jwks-url are mutually exclusive`, and the shipped compose passes
`--credential-login`. And had it started, it would not have authenticated anyone from an ordinary
identity provider: `verifyBearerJwt` refuses any `alg` other than `EdDSA` as
`credential_malformed`, and the JWKS parser keeps only `OKP`/`Ed25519` keys, so an RS256 OIDC
issuer — the default — gets a 401 on every request. `deploy/VERCEL-SUPABASE.md` §5 carried the same
prescription. Checked with `git log -S`, the two halves have different provenance: the section was
written in `98750e8` (2026-08-19) and the `EdDSA`-only check is already in `auth.ts` at `3e67a22`
(2026-08-17) — the clone is shallow and `3e67a22` is its boundary, so "at" means "no later than" —
so the RS256 half was **wrong when written**; the mutual exclusion arrived in `2b98f46`
(2026-10-13) together with the compose's `--credential-login`, so that half **drifted**.

**A login the managed guide never mounted.** `VERCEL-SUPABASE.md`'s troubleshooting told a reader
whose UI showed 401s to open `/login` and sign in, while its §2 API command passed no
`--credential-login` — so `POST /v1/auth/token`, the only thing the UI's `/login` form talks to, was
never mounted, and the form refused every password in a way indistinguishable from a wrong one.
Wrong when written: the `/login` sentence entered in `9687c3a` (2026-10-20) and `--credential-login`
first appears in that file at `96ce874`.

**A backlog that is dropped.** `deploy/README.md` and `.env.example` said an email or SMS dispatch
made before a channel is configured is retried as `no_sender_configured`, *"so configuring a channel
later delivers the backlog rather than losing it"*. False in two ways. Nothing in the binary
produces an email or SMS dispatch at all — the producers are the design-review decision notice
(`in_app`) and the digest assembler, which inherits its channel. And an unrouted dispatch does not
wait: `unroutedResult` answers `failed`, it is retried at 30, 60, 120 and 240 seconds, and
`terminalOutcomeFor` records the fifth attempt `dropped` — about seven and a half minutes after it
was queued (`DEFAULT_MAX_DELIVERY_ATTEMPTS = 5`, `DEFAULT_INITIAL_BACKOFF_SECONDS = 30`). Both
constants are already in `delivery-plan.ts` at `d316d31` (2026-10-02), the commit that wrote the
sentence, so the mechanism was **wrong when written**. The sharper half: ADR-0376's commit
(`86d50a9`, 2026-10-20) added a paragraph beginning *"That sentence was false until the drain flag
became a default"* directly beneath it — it corrected the sentence's drain half and kept the backlog
half one line above its own correction.

**GDPR rights and the root README.** The root `README.md` said *"Three compliance triangles closed at
the contract layer"*, pairing `data-lineage` with *"Art. 15 access"* and `sso` with *"federation"*,
and that *"M6 closed the HTTP-webhook → workflow-signal chain"*. `data-lineage`, `sso` and
`workflow-signal-bridge` have **zero workspace dependents**, measured over every `package.json`. The
triangles sentence was qualified (*at the contract layer*), so it is a true sentence read as a false
one rather than a false one; the M6 sentence is false as written. `deploy/ORACLE.md` said nothing
about which data-subject rights have a route.

**Data onboarding.** The console's capability section listed what it deliberately does not do and
omitted that **there is no import, backfill or bulk route** at all: the `migration` package is
contracts-only with zero importers, so loading another system's records is a script issuing one
`POST` per record, and nothing told an operator what such a script meets.

**A boolean among file-taking flags.** `ORACLE.md`'s list of *"the eight other file-taking flags"*
named `--slo-defaults`, a boolean; the file flag is `--slo-defaults-override`. Wrong when written:
the list entered in `94fb26e` (2026-11-09), and `cli.ts` at that commit already parses
`--slo-defaults` with no value and `--slo-defaults-override` with one.

### Face 2: the declarations (slice F, `d23a9f4`)

Eleven declarations were false or stale — thirteen strings, since the `PostgresPostmortemStore` and
`RegionRouter` declarations each had both their `blockedBy` and their `consequence` replaced — and
two declarations in one directory
**contradicted each other**: the storeless rule said inbound webhooks were live through
`workflow-signal-bridge`, while the unreachable-store rule declares that same package as having zero
importers.

| Declaration | Said | Measured |
|---|---|---|
| `meta.tenant_data_exports` | *"Article 15 portability has no implementation"* | Portability is Article **20**; and the table has no subject column and no legal basis — its five `EXPORT_TRIGGERS` are whole-tenant ones — so it is not the missing Article 15/20 answer either |
| `meta.sso_providers` | *"which is why meta.users has no writer either"* | `PostgresUserStore` inserts into `meta.users` (`platform-users.ts:539`) since ADR-0335 |
| `meta.sso_sessions` | *"nothing can be revoked centrally"* | True of a *federated* session only; the credential login's sessions are re-checked through the attribute directory (ADR-0381) |
| `meta.scim_clients` | the mechanism *"that would populate meta.users"* | The *automated* one; an operator populates it today |
| `meta.rate_limit_policies` | a store becomes wanted *"when meta.users has a writer"* | It has one |
| `meta.webhook_endpoints` | *"The inbound direction is live (workflow-signal-bridge, the bounce webhook)"* | The bridge has zero importers; the bounce and Stripe webhooks are wired behind flags no compose passes |
| `meta.report_runs` | *"The seven report kinds are rendered on request"* | None of the seven `REPORT_KINDS` is rendered by anything: no pack declares a report, and `@crossengin/reporting` is imported only by `packages/kernel` |
| `meta.import_sources` | mappings are never stored *because* the table has no writer | The table has no column for them, and 3 of `migration`'s 7 record shapes (`InferredSchema`, `EntityMapping`, `PreviewRun`) have no table, so a writer would not change it |
| `PostgresRunbookExecutionStore` note | *"`operate-server` grew the incident record routes"* | No HTTP route over incidents exists at any commit from the `3e67a22` boundary to `HEAD` (`git grep` over `git rev-list --all`, with a positive control) |
| `PostgresPostmortemStore` | *"`attachPostmortem` exists and is reachable"*; a postmortem *"lives only in the in-memory incident record"* | `PersistentIncidentEngine.attachPostmortem` has no non-test caller, and the incident record carries only a `postmortemId` |
| `RegionRouter` | *"nothing consults `decideRegionRouting` before serving a request"* | `OperateHttpServer.checkResidency` does, pre-dispatch, answering 421/403 under `--region` plus a residency source — on the unverified `x-tenant-id` hint |

Provenance, with `git log -S` over every ref — and the clone is **shallow**: `3e67a22`
(2026-08-17) is its graft boundary, so `git log -S` reports it as adding every file and the history
it can see is the 167 commits from there to `HEAD`. The incident-route note is **wrong when
written** (no incident route at any visible commit), and so is the `RegionRouter` sentence
(`decideRegionRouting` is in `server.ts` no later than `3e67a22`, and the sentence from `2b98f46`,
2026-10-13), and so is the webhook one (the only visible commit that changes the count of
`workflow-signal-bridge"` across `package.json` files is the `3e67a22` boundary, which already holds
the package's 14 files, so no dependent exists at any visible commit). All three verdicts hold
regardless of the shallow boundary, because each sentence entered at `2b98f46`, after it. The `meta.users` clause **cannot be classified from `main`'s history**:
the sentence and `PostgresUserStore` both enter `main` in `2b98f46`, a single-parent commit carrying a
41-ADR run, so in the first tree on `main` holding the sentence it was already false and `git log -S`
cannot order them further. The Article 15 mis-citation is wrong independently of any code.

Two further gaps rode with these. **`active-active` and `edge`**, two of the 13 members the
unreachable-store rule classifies `contracts_only`, are deliberately unbuilt — ADR-0077's Q6 gates
multi-region on demand and names both packages by name — and nothing recorded that decision in the
rule that would go red if it changed. And `shared-table-erasure.ts`' comment called
`tenant_data_exports` *"a copy of the subject's own data"* about a table with no subject column.

## Decision

**A deploy document states only what the binary does, and each load-bearing sentence is fenced
against the source fact that makes it true.** `deployment-defaults.test.ts` gains the fences
(`71` tests in that file after the change), reading the documents as text and the source they rest
on: the `cli.ts` refusal string, the runtime's idempotency TTL expression
(`opts.idempotencyTtlSeconds ?? 86_400`, which no app source sets), the two `delivery-plan.ts`
constants, the workspace import graph (`workspaceDependents`) and the compose command. The "no
import, backfill or bulk route" fence is **not** a biconditional, though its own comment says it is:
after `expect(claimsAbsent).toBe(importFlags.length === 0)` the same test asserts
`expect(claimsAbsent).toBe(true)` and that `@crossengin/migration` has no dependents, which together
pin the absence — once an import flag lands no edit to the README can make it pass. It is an
**absence pin**, ADR-0412's specification shape, and must be edited together with any importer (see
open questions). Each fence carries a **non-vacuity floor**: more than
100 CLI flags parsed, `@crossengin/kernel` with more than 5 dependents, at least one serve command
found, and a design-notifications producer control for the channel census. The rewritten text:

- **Auth**: *Going to production (auth)* starts from the fact that the shipped stack is already on
  credential login, and re-describes `--jwks-*` as an **API-client** path with its preconditions —
  EdDSA only; one issuer and audience shared with the login; **no `tenant_id` claim means the caller
  picks the tenant by the `x-tenant-id` header** (ADR-0098's recorded decision, and the
  highest-stakes of the five); `scope` read as role names; `--jwks-url` excluded while
  `--jwks-key`/`--jwks-file` keep the revocation gate, so `sub` must be a provisioned member; and the
  UI cannot present such a token. Federated login is stated unavailable. `VERCEL-SUPABASE.md`'s
  command now passes `--credential-login`, `--credential-admin-role`, `--jwt-issuer` and
  `--jwt-audience`, and its environment block both login secrets (in the environment, not argv —
  ADR-0301).
- **Email/SMS**: configuring SES or Twilio registers a *sender* and changes no delivery outcome; the
  drop schedule is stated with its figures.
- **GDPR**: `ORACLE.md` states that erasure is the only data-subject right with a route; the root
  README says *"modelled at the contract layer — which is not the same as served"* and calls
  `data-lineage` and `sso` contracts-only, and M6 *"built … a gateway handler that nothing in the
  deployed binary registers"*.
- **Onboarding**: a *Loading existing records* section with five hazards, each measured against a
  running server (below).
- `--slo-defaults` → `--slo-defaults-override` in `ORACLE.md`'s list.

**A declaration's sentence is replaced by one a command confirmed before it was written**, and where
the sentence is a census it is made **machine-checked**. `webhook-event-producers.ts` is the
**fourteenth** workspace rule: it reads `WEBHOOK_EVENTS` out of `packages/sdk/src/webhooks.ts` as
text (importing it would make the build graph cyclic, `manifest-event-names.ts`' reason), counts
quoted literals of each of the **18** declared events in non-test source outside the declaration
file, and asserts the census equals the `<n> of the <m> declared WEBHOOK_EVENTS` figure the
`meta.webhook_endpoints` consequence states — today `0 of the 18`. It **throws** rather than
answering an empty declared set, because an empty set makes every census vacuously clean, and a
**positive control** re-runs the matcher over the declaration file itself, because without it a
matcher that matched nothing would pass the real census. Its reach is stated in its header: it
cannot see a runtime-assembled name or `apps/operate-web`.

**A `no_caller_by_design` declaration must cite an ADR that names its subject as code** — the class
in backticks, or the member as `name` or `@crossengin/name`, never a bare English word, because
`edge` is a common word in this repo's ADRs (44 of the 127 that mention a gateway). The existing check required only that the cited file
exist, which admitted a citation of an ADR about something else. `active-active` and `edge` get
**member-scope** `no_caller_by_design` declarations citing ADR-0077, so the deferral lives where it
goes red: as `overtaken` the day a runtime imports either. Member-scope declarations go from 1 to 3;
the `contracts_only` classification is unchanged at 13.

The corrected declarations carry facts a first store would meet, not only the correction:
`subject_access_requests` now records five — its contract **refuses an Article 12(3) extension**
(`deadlineAt` at submission + 30 days parses for `gdpr_article_15`, + 31 days does not), there is no
catalogued table for `Article15EvidencePackSchema` or `RetentionPolicySchema`, the table carries no
table-level constraint against the contract's five cross-field clauses, it is in neither retention
set and has no DELETE fence (unlike `meta.gdpr_deletion_requests`), and its `deadline_at` is read
by nothing. The webhook declarations record that outbound delivery is **modelled three times** (the
sdk's `whk_` endpoints, the `outbound.webhook` integration whose vault-referenced secret nothing
resolves, and the notifications `webhook` channel, for which `resolveUserAddress` answers `null`),
and that a delivery row stores only a payload digest, so a retry cannot resume from the rows after a
restart.

## Consequences

**Verified live**, slice E, on PG 16. The JWKS arm and the `--store pg` arms ran as the non-owner
`serving` role; the slice's report does not state the role of the `--store pg-columns` server
(which, on that store, must own its entity tables), so those halves are not claimed as non-owner:

| arm | result |
|---|---|
| `--jwks-key` EdDSA token, no `tenant_id`, unprovisioned `sub`, plus `x-tenant-id` | **401 `principal_disabled`**, log `[auth] session refused: … holds no active membership` |
| two `POST`s with one declared-unique value | `--store pg` **201 / 201**; `--store pg-columns` **201 / 409** |
| re-`POST` of an existing caller-supplied `id` | **500 `write_failed` on both stores** — not a 409 |
| a caller-supplied sequence value | the allocator does not advance: a silent duplicate on `pg`, a 500 on `pg-columns` |
| repeated `Idempotency-Key` | original status with `x-idempotent-replay: true` and **an empty body** |
| the bootstrap `platform_admin` api-key on `GET`/`POST /v1/warehouses` | **403** both |

Those six are the documented loading hazards and the JWKS gate. The first row also corrects a
premise ADR-0381 recorded: the revocation gate *"never sees a foreign subject"* because the login and
`--jwks-url` are mutually exclusive — true of `--jwks-url` only. `--jwks-key` and `--jwks-file` run
beside the login, so the gate does see foreign subjects there and refuses any `sub` without an active
membership. The probes ran against the `dist` present in the slice while `HEAD` moved from `455a41f`
to `2e82f53` under it, so they want re-running after a rebuild (see open questions).

The orchestrator's own run at `51b81a7` (PG 16, non-owner `serving`, both stores) is consistent with
the corrected email/SMS and reporting text: its boot prints *"[notify] in_app is produced in this
binary only by a design-review decision"* and *"[notify] email (SES): needs SES_REGION, …; partial
configuration is ignored rather than guessed"*, and
*"[manifest] 8 of 17 manifest sections are read by no request path … (validated_only: …, reports,
dashboards, …)"*. It did not exercise the documents themselves.

Tests: `deployment-defaults.test.ts` 71 passed; `pg-storeless-tables.test.ts` 31,
`pg-unreachable-stores.test.ts` 73, `webhook-event-producers.test.ts` 8; the whole
`@crossengin/testing` package — the pre-commit hook's suite — 22 files, 758 tests. The testing
package typechecked clean; for `operate-server` the slice reports only that its typecheck showed no
errors in `deployment-defaults.test.ts`, which is a file-scoped statement and not a clean package.

Mutation-checked. Slice E ran the mutations its report numbers M1–M15, in their actual directions:
**restoring** false text — a `--jwks-url` line into a fenced serve block (M1), *"Three compliance
triangles closed"* (M6), the backlog sentence into `.env.example` (M10), the *"closed the
HTTP-webhook → workflow-signal chain"* sentence (M11/M11b), `--slo-defaults` into `ORACLE.md`'s file
list (M12); **removing** text — both `EdDSA` mentions from `VERCEL-SUPABASE.md` (M2c; removing one
alone passes, because the other remains, which is intended), the `tenant_id` bullet (M3),
`--credential-login` and then `CREDENTIAL_PEPPER` from the Vercel command (M4/M4b), the Article 15/20
paragraph (M5), the import row (M7), the `platform_admin` 403 hazard (M9); **changing** a figure —
`86,400` (M8) and the retry seconds (M13). Each failed its fence, and the six edited files were
restored byte-identically (`md5sum -c` over all six at the end). M14 and M15 were **temporary new
source files**, not edits to the six — one setting `idempotencyTtlSeconds`, one producing an
email-channel dispatch — and each failed its fence and was deleted. Slice F ran five: a wrong `decidedIn` fails the citation test; dropping the
word-boundary lookahead fails the `active-active-runtime` case; a temporary
`export const MUTATION_PROBE = "tenant.created"` fails the census with
`{ produced: 1, declared: 18 }` and names the file; forcing the matcher off fails both the matcher
test and the positive control; and `0 of the 18` → `1 of the 18` fails the stated-figure test.

### One fence was vacuous on its first run, which is ADR-0390's class again

The M6 fence was first written as `toContain('M6 closed')`, and restoring the false sentence
**passed**: the README line is a blockquote, so the text carries a `>` and a line break between the
two words. It is a regex on the phrase now and the mutation fails. That is ADR-0390's
*a fence resting on formatting is one the next author satisfies by changing the formatting*, met by
the slice that read it — and found, as there, only because every fence was mutated.

## Alternatives

**Document the open defects as behaviour.** Refused: P2.18's ledger postings, P2.19's undeclared
fields, the existing-`id` 500 and the empty-body replay are written into *Loading existing records*
as **hazards with remedies** — check the id before deciding the record failed, record the id from
the first response — and not as features, because a document that describes a defect as behaviour
is the next sentence a refuter has to correct.

**Make `contracts_only` a finding, so all 13 such members need a declaration.** Proposed by the
P1.17 refuter and refused on measurement: only 2 of the 13 carry a true existing reason. The other
11 would need a reason that is false or invented — `data-lineage` is blocked both by ordering (no
runtime) and by shape (no evidence-pack table; the extension is unrepresentable), `deploy` is blocked
on the product decision of which flag model is real (a disposition the vocabulary lacks),
`rate-limiting` is only partly substituted, `security`'s substitute is a header string rather than a
class, `compliance` is unwireable as is, and the remaining six would need
`prerequisite_of_unbuilt_surface`, which asserts ordering, about contracts nobody has shown adequate.
A rule that forces false declarations is worse than an exemption.

**A parallel list of unimported contract members.** Refused: `UNREACHABLE_STORES` already takes
member scope and already audits `overtaken`, so a second list would be ADR-0288's maintained list.

**A total map from each `WEBHOOK_EVENTS` member to its producer.** Refused: the compiler would keep
it total and nothing would keep it true — the same argument `manifest-event-names.ts` made against
trusting a declaration. The census is against the code.

**Write *"targetEntity accepts 0 of 51 entity names"* into the `migration` declaration**, as the
P1.13 measurement proposed. Refused: it is a PascalCase artefact — `ENTITY_REGEX` is lowercase and
kernel's `toTableName` output passes it for all 51 — so it would have been a false sentence in the
increment correcting false sentences.

**Keep `--jwks-url` documented, with a note that it excludes the login.** Refused: an operator
reaching for it wants federated login, and the path does not provide it on any arm — RS256 is
refused, the UI cannot present a token, and the one thing that would make it federated is the `sso`
runtime, which does not exist.

## Open questions

1. **Code still carries the backlog claim.** Comments in `node.ts`, `delivery-senders-env.ts`,
   `email-ses.ts`, `push-fcm.ts` and `sms-twilio.ts`, and a test title in
   `delivery-senders.test.ts`, say the same false thing the documents no longer do. Outside both
   slices' files; `node.ts` is orchestrator-owned.
2. **Two engine defects surfaced as hazards and are in no register entry**: re-`POST` of an existing
   caller-supplied `id` is a 500 on both stores rather than a 409, and an idempotent replay returns
   an empty body. Both are documented with remedies; neither is fixed.
3. **`--schema` means at least three things on `--store pg-columns`**: a non-default value also
   retargets the meta-table reads, and measured with `--schema slicee` every write was a 500. The
   register records two.
4. **The live probes ran against a moving `dist`.** Re-run the duplicate, existing-id, sequence,
   idempotency and `platform_admin` arms after a workspace rebuild, and add the two JWKS arms not yet
   run through the shipped compose: an RS256 token → 401 `credential_malformed`, and an EdDSA token
   with no `tenant_id` plus `x-tenant-id` for a provisioned member → 200. `VERCEL-SUPABASE.md`'s §2
   command was verified by reading `node.ts` and `cli.ts`, not by a deploy.
5. **May `no_caller_by_design` cite a Proposed ADR's "current direction"?** ADR-0077 is Proposed and
   its Q6 is a direction rather than a decision; both new declarations rest on it.
6. **The vocabulary may need a *blocked on a product decision* reason** — `deploy` (register P1.15)
   is the member that has no true reason without one.
7. **`RegionRouter` keeps `prerequisite_of_unbuilt_surface`** with an honest `blockedBy` (a
   post-authentication residency check is unbuilt, and wiring it is a choice between the guard's and
   the router's answer to an unprofiled tenant), but whether *ordering* is the right label is
   arguable and no existing reason fits better.
8. **The census cannot see a runtime-assembled event name or `apps/operate-web`**, so a producer
   written as `` `tenant.${verb}` `` would leave `0 of the 18` reading true while false.
9. **A `[notify]` boot line saying no email or SMS producer exists** would carry the documents'
   corrected sentence to the place an operator reads at boot; it needs `node.ts`.
10. **The import-row fence is an absence pin under a comment calling it a biconditional.** Making it
    what the comment says means dropping the unconditional `toBe(true)` (or conditioning it on
    `importFlags.length === 0`) and the `workspaceDependents("@crossengin/migration")` equality;
    until then whoever adds an importer must edit this test and the README in the same change.
