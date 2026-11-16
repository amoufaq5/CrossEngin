# ADR-0416: A boot line that read as working

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-16 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0383 (`public.ce_unaccent` and its two maps), ADR-0413 (a survey that assumed its producer, and required inputs), ADR-0334 (a remedy that cannot work is worse than none), ADR-0361 (a boot line read off the live object, never the flags), ADR-0386 (a forwarded field dropped silently), ADR-0126 (the finance reports' role set), ADR-0388 (`MANIFEST_SECTION_REACH`), ADR-0274 (the delivery drain and its retryability, which carries the false backlog sentence first), ADR-0301 (channel senders from the environment), ADR-0376 (the drain-absence warning), ADR-0336 (no incident lifecycle surface), ADR-0326 (a close-out that closes the alert), ADR-0372 (a silence read as a clean result) |

## Context

Three register items (P1.12, P1.14, P1.7) read as unrelated capability gaps: search does not
execute, 14 notification providers have no client, nothing closes an incident. Measuring them
before designing found that each had a **live** half that was not a missing capability at all. In
each, a boot line on the shipped deployment was either **false** or **absent**, and an operator
reading the boot would conclude something worked that did not. The capabilities themselves are
still missing. What this increment changes is what the boot says about them.

### Member 1 (P1.12): the `[search]` line described the other store

On a healthy boot, `searchExtensionLine` printed two lines, and both were true of `--store
pg-columns` only. The pre-change boot log on `--store pg` (slice C, `0414-serve-pg.log` lines 5–6)
read:

```
[search] unaccent: present — ?q= and [contains] are serveable
[search] public.ce_unaccent: created — the predicate and the trigram index are one expression…
```

`--store pg` is the shipped compose default, and its predicate **names `public.ce_unaccent`
nowhere**. `entity-ops.ts` declares `foldText: (sql) => rawFoldCall(sql)`, which folds through
`public.unaccent` with the dictionary pinned. That function is not IMMUTABLE, so no index can serve
it, and this store creates no trigram index. Measured live by slice C on PG 16.15 with the real
`listPageOp` `?q=` SQL over a 60k-row replica: `Rows Removed by Filter: 10000` of the tenant's
10000 Invoice rows, identically as owner and as the non-owner `serving` with tenant context, and
`pg_trgm` count 0. Every `?q=` and `[contains]` on the document store reads every row the tenant
holds for that entity, and the boot line said the opposite.

Checking the unhealthy arms on both stores refuted the sibling claim in `search-function.ts`,
*"--store pg is unaffected in every state"*. In `dictionary_absent`, the document store's own fold
pins the same dictionary, so it raises exactly as the wrapper would. Measured live with `unaccent`
installed in schema `ext`: `public.unaccent('public.unaccent'::regdictionary,'é')` raises `text
search dictionary "public.unaccent" does not exist`. The remedy printed for that state was also a
no-op in the shape that reaches it. `CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public` printed
`NOTICE: extension "unaccent" already exists, skipping` and the dictionary stayed absent. `ALTER
EXTENSION unaccent SET SCHEMA public` restored it (the query returned `e`).

Both the "one expression" sentence and "unaffected in every state" were **wrong when written**.
`git log -S` puts both in `b96eb93` (ADR-0383). In that commit `entity-ops.ts` already folds
through `rawFoldCall`, the pinned two-argument form, and `node.ts:832` calls
`searchExtensionLine(searchExt)` once, with no store argument, on every store. This is not drift.
The line never knew which store it was describing.

Two adjacent silences sat in the same member:

- **The server-side reports and the entity grants disagree, and nothing said so.** Through the real
  `rbacCheck` on all seven resolved packs, the two report routes yield 5 (report, role, entity)
  triples over 3 distinct (role, entity) pairs where an admitted role cannot list an entity the
  report reads: `ap_clerk→Invoice`, `controller→Invoice`, `ap_clerk→WhtCertificate`. The report
  routes admit a compile-time role list (ADR-0126's four finance roles). The manifest's per-entity
  grants are a different vocabulary, and the role list is the only check on those routes.
- **Eight of seventeen manifest sections are read by no request path** (`MANIFEST_SECTION_REACH`,
  ADR-0388). No boot line said which of them a given manifest declares.

### Member 2 (P1.14): `[notify]` listed senders, and senders are the last hop

The boot line was `[notify] channels: ${senderWiring.report.channels.join(", ")}`, the list of
**registered senders**. `deploy/README.md` showed `in_app, email, sms` as the check to run after
filling the SES and Twilio block. Slice D measured what the binary can actually deliver:

- `scanWorkspaceSql` over 941 files and 267 statements finds exactly **one** `INSERT` into
  `meta.notification_dispatches`, in `notification-store.ts`.
- `new PostgresNotificationStore(` occurs in non-test sources only in `node.ts`, twice.
- The one builder that *originates* a dispatch is `buildDesignDecisionDispatch`, which hardcodes
  `channel: "in_app"`. `buildDigestDispatch` uses `input.digest.channel`, so it re-emits a pooled
  dispatch's channel and originates none.

So filling SES and Twilio registered idle senders. Nothing in the binary writes an email or SMS
dispatch, and the boot line read as "email and SMS work".

The claim beside it, *"configuring the channel and re-draining delivers the backlog"*, was false in
mechanism. `decideRetry` at the drain's defaults (`DEFAULT_MAX_DELIVERY_ATTEMPTS = 5`,
`DEFAULT_INITIAL_BACKOFF_SECONDS = 30`) answers `retry_in_30s`, `60s`, `120s` and `240s`. Attempt 5
is `max_attempts_exhausted`, which `terminalOutcomeFor` records as `dropped`: about 450 s of
backoff. `node.ts` passes no `maxAttempts` (0 hits in `node.ts` and `cli.ts`). This one is also
**wrong when written**. `git log -S "re-draining"` puts the claim first in `b5e4007` (2026-08-23,
ADR-0274's commit), which introduced both ADR-0274's *"configuring the sender later and re-draining
delivers"* and the test title quoted below; `d316d31` (2026-10-02) repeated it in the code comments
and the deploy documents. At `b5e4007` `delivery-plan.ts` already carries
`DEFAULT_MAX_DELIVERY_ATTEMPTS = 5` and `DEFAULT_INITIAL_BACKOFF_SECONDS = 30`, `delivery-drain.ts`'s
`terminalOutcomeFor` already maps a retryable outcome to `dropped`, and `node.ts` has 0
`maxAttempts`. That test title, `delivery-senders.test.ts`' *"is retryable — configuring the sender
and re-draining should deliver"*, asserted only `RETRYABLE_DELIVERY_OUTCOMES` membership, so the property in its title was
never checked.

### Member 3 (P1.7): `[incident]` did not exist

No HTTP route and no console page can acknowledge, assign, advance, attach a postmortem to or close
an incident, and no boot line said so. On the shipped compose the gap was sharper than the register
had it. `--integrity-proof` resolves to a config whose `escalation` is `undefined`
(`IntegrityProofConfigSchema.parse({allTenants: true})`, asserted in slice G's test). A COMPROMISED
verdict is therefore an error line and a stored verdict row: it declares no incident and pages
nobody. Escalation needs `--integrity-proof-config` with an `escalation` block, which `cli.ts`
refuses beside `--integrity-proof` as mutually exclusive.

`lifecycle-prerequisites.test.ts`, the test the register leaned on, carried two false things:

- A comment said *"every incident this deployment can declare is one that cannot be closed until
  PostgresPostmortemStore has a caller"*. That is false because the SLO escalator declares at sev3,
  which needs neither a postmortem nor a status page.
- The block titled *"which no route in this repo performs"* asserted only properties of its own
  fixture. It read no route, so it could not have seen one land. This is the documented-the-hazard
  -and-checked-nothing shape again (ADR-0351, ADR-0362, ADR-0372).

## Decision

**One rule, applied three times: a boot line states what *this* deployment will do, computed from
the objects the server built, and it is printed either way.** It is never computed from the flags
(ADR-0361), and it never assumes an input it was not handed (ADR-0413).

### `[search]`: the store is a required argument

`SearchStoreKind = "pg" | "pg-columns"` is threaded through `searchExtensionLine` →
`searchFunctionLine` as a **required** argument. An optional argument defaulting to the column
store would be the defect kept as a default. A private total map,
`STORE_PREDICATE_CALLS_SEARCH_FUNCTION = {pg: false, "pg-columns": true}`, decides the healthy
clause. A store whose predicate does not call the wrapper gets its own sentence, and the wrapper's
state is reported as irrelevant to it except in the one state that is not (`dictionary_absent`).

- That arm now names `--store pg` too.
- Its remedy gains `ALTER EXTENSION unaccent SET SCHEMA public`.
- Line 1's *"?q= and [contains] are serveable"* is dropped. Extension presence never decided it: on
  `pg` dictionary placement decides, and on `pg-columns` the wrapper state does. Line 2 already
  answers per store.

The map is checked against the SQL the real `listPageOp` emits, so deleting `rawFoldCall`'s
declaration fails a test rather than leaving the line describing a predicate the store no longer
issues.

### `[reports]`: the enforced set, compared with the entity grants and not ranked

`CompiledOperateServer.reportSurfaces` carries **the very `Set` each report handler enforces**, from
one `financeRoles` derivation, with the entity constants passed explicitly into both handlers. The
boot block reads it off `gateway.reportSurfaces`, so it cannot re-derive `financeRoles ??
DEFAULT_FINANCE_ROLES` and drift from the request path (ADR-0361, ADR-0386).
`report-surface-survey.ts` is pure and calls the real `rbacCheck`. It counts in both units (5
triples, 3 distinct pairs), names both vocabularies, offers no remedy, and logs at info level either
way. Which vocabulary governs a finance report is a product decision. The survey says the two
disagree and declines to rank them.

### `[manifest]`: members, not keys

`manifest-section-survey.ts` derives the unserved sections from the kernel's `MANIFEST_SECTION_REACH`
and its sentences from `MANIFEST_SECTION_REACH_MEANINGS`. "Declared" means a section has a member:
`countAfter > 0` via `diffManifestSections(null, m)`. Key presence is the wrong test because the
extending packs carry these sections as **own keys holding `undefined`** (`'reports' in retail` is
true, `retail.reports` is `undefined`). The register had said `{}`, which was wrong, though either
way it is a non-declaration. Counting keys would have reported five false declarations on six of
seven packs. The line is printed either way.

### `[notify]`: a per-channel reach survey with four required inputs

`notification-channel-survey.ts` replaces the bare line with an answer, per channel in
`NOTIFICATION_CHANNELS`, to whether this deployment can deliver on it. Its inputs are all
**required**:

- the registered channels;
- the mounted producers, derived from the exact condition `node.ts` wires the notifier under:
  `options.designReview && conn !== undefined && notificationStore !== null`;
- whether the drain is mounted;
- the store kind.

"Delivers" is therefore never printed with no producer mounted or no drain, and it cannot
contradict ADR-0376's no-drain warning. This is ADR-0413's rule one subsystem across: a survey that
assumes its producer is mounted would print *in_app delivers* on a `--read-state-routes`-only
deployment that has a store, a drain and zero producers.

`CHANNEL_DISPATCH_PRODUCERS` is a total map over the channels, so a seventh channel is a compile
error. There are seven verdicts: `delivers`, `no_durable_store`, `producer_unmounted`, `no_drain`,
`produced_without_sender`, `registered_without_producer` and `not_registered`. They sit under a
total disposition map, and two of them warn:

- `registered_without_producer` is the live operator trap. It names **no remedy** and says no flag
  or variable changes it.
- `produced_without_sender` is unreachable today. Its "~450 s then dropped" is **derived from the
  drain's own `planRetry`**, not declared.

The precedence puts *registered but nothing produces it* first, because no store, drain or flag
changes it. The survey reports and never refuses.

The false backlog sentence is corrected wherever it was code: `delivery-senders-env.ts`,
`email-ses.ts`, `push-fcm.ts`, `sms-twilio.ts` and the replaced `node.ts` comment. The test whose
title asserted it is retitled *"is a retryable outcome"*. A new behavioural test walks the real
drain ladder end to end through `drainTenant`: four `failed` with `no_sender_configured`, gaps
`[30,60,120,240]`, then `dropped`. The deploy documents' copy was corrected by the deploy-docs
slice (`96ce874`).

### `[incident]`: derived from the escalators the server built

`incident-lifecycle-survey.ts` produces one info-level line on every boot, computed from four
sources: the built `SloEnforcement` (engines and `persisted`), the integrity proof's parsed config
plus its escalator and declarer when escalation is configured, the deletion escalator with its
declarer and parsed config, and `gateway.routes.list()`.

- **Grades come from parsed configs.** The deletion escalator declares at a **set** of grades, not
  one: `severity`, every `severityByDefect` value, and `sweepStallSeverity`. `config.severity` stays
  reachable even when every defect is overridden, because `severityForDefects([])` falls back to it.
- **Whether a record is stored** comes from `SloEnforcement.persisted` for the two SLO engines, and
  from `declarer instanceof PostgresIncidentDeclarer` for the integrity and deletion escalators.
- **The reachable lifecycle is derived, not declared.** The survey runs the three automated writers
  (the declarer's close-out, `notePage`, the stall-kind `note`) from a freshly declared record until
  no new status appears. It counts the result against `INCIDENT_TRANSITIONS`: **1 of 12 edges**,
  `declared → cancelled`, by the declarer's close-out.
- **Whether an incident route exists** is read from the live registry, so the line changes by itself
  when one is registered.

The one operator-run reader it names is `operate-server replay --all-tenants`. Both `--platform` and
`--tenant` refuse the incidents subsystem, and a scopeless invocation is a usage error, so naming
`replay` generically would send an operator to a command that answers `NOT READ`. A workspace census
fences which files construct an incident engine, store or declarer, or call the note writers, so a
new writer fails a test until the writer map knows it. The line names **no remedy for closing**:
the contract permits closing every grade, and no flag supplies a caller.

`lifecycle-prerequisites.test.ts` now drives the real `IncidentExecutor` across every grade. Every
grade closes when `rootCause` is supplied. sev1 and sev2 also need `publiclyVisible` on leaving
`declared` and a `postmortemId` at close, and a missing `rootCause` is refused at `resolved →
closed` for all five. So there are **three** closing conditions, not two. The vacuous *"grades the
escalators declare at"* assertion moved to the survey test, because the escalator schemas live in
the app and that package cannot import them. A `@ts-expect-error` pins that `DeclareIncidentInput`
carries no `roleAssignments`.

## Consequences

**Verified live.** The orchestrator ran HEAD `51b81a7`'s dist on PG 16 (127.0.0.1:5498) as the
non-owner `serving` role (`rolsuper f`, `rolbypassrls f`), with the shipped compose's flags minus
the `--ai-design` family, and with `--scheme http` in place of the compose's `--scheme https`, on
both stores.

`--store pg`:

```
[search] unaccent: present
[search] public.ce_unaccent: created — unused by --store pg, whose predicate folds through public.unaccent directly and names this function nowhere. That fold is not IMMUTABLE, so no index can serve it: every ?q= and [contains] reads every row the tenant holds for that entity.
[manifest] 8 of 17 manifest sections are read by no request path in this binary (validated_only: integrations, files, reports, dashboards, search; unread: customWidgets, theme, i18n) — this manifest declares a member in none of them
[notify] channels — in_app: nothing is enqueued, because its producer is not mounted
[notify] in_app is produced in this binary only by a design-review decision, mounted by --design-review or --require-design-review
[reports] server-side reports mounted: 2. … Admitted roles the entity grants do not let list an entity the report reads: 5 (report, role, entity) over 3 distinct (role, entity) pair(s)
[reports]   meta.aging.read reads Invoice, Bill, Payment; admits ap_clerk, controller, erp_accountant, erp_admin; admitted without list: ap_clerk→Invoice, controller→Invoice
[reports]   meta.whtReconciliation.read reads Invoice, WhtCertificate; admits ap_clerk, controller, erp_accountant, erp_admin; admitted without list: ap_clerk→Invoice, controller→Invoice, ap_clerk→WhtCertificate
[incident] no incident escalator is built, so nothing in this process declares an incident; --integrity-proof runs with no escalation, so a COMPROMISED verdict is an error line and a stored verdict row, declares no incident and pages nobody — escalation needs --integrity-proof-config with an `escalation` block, which is mutually exclusive with --integrity-proof
```

`--store pg-columns`:

```
[search] unaccent: present
[search] public.ce_unaccent: present — the predicate and the trigram index are one expression, reached on tables this role owns — RLS confines ILIKE to a sequential scan because texticlike is not LEAKPROOF
[manifest] 8 of 17 manifest sections … this manifest declares a member in none of them
[notify] channels — in_app: nothing is enqueued, because its producer is not mounted
[incident] no incident escalator is built, so nothing in this process declares an incident; --integrity-proof runs with no escalation, …
```

The two `[search]` lines now differ by store and each is true of its own. The `[notify]` line
contains no "delivers" because that run did not pass `--require-design-review`, and the line is
true for the configuration booted. On the shipped compose, which passes `--ai-design`,
`--require-design-review` and `--notification-drain-ms`, the line is `[notify] channels — in_app:
delivers to the recipients each audience resolves to`. That string is pinned by `toBe` in
`notification-channel-survey.test.ts`, but it was **not** booted live in this increment. The
curated excerpt of the `pg-columns` run omits the `[reports]` block, but the raw log of that same run
(`0414-live-cols.log`) shows the same three lines, so the block was observed on both stores.

Slice C's own live arms (PG 16.15, port 5487) covered the document store's full scan, the
`dictionary_absent` raise on `--store pg`, and both remedies (the no-op and the `ALTER EXTENSION`
that works). Slices D and G produced no live boot: D's checks are workspace scans and the real drain
walked in-process, and G's throwaway cluster was down, so its arms are unit-level. The `--slo-defaults`,
`--store memory` and SES-plus-Twilio arms each slice listed under "needs live verification" were not
booted. They are open below.

Tests:

- `operate-runtime-pg`: search-function, search-extension and list-sql together, 129.
- `operate-runtime`: `compile.test.ts`, 40.
- `operate-server`: report- and manifest-section surveys, 16; `notification-channel-survey.test.ts`,
  14; with the three drain and sender files beside it, 185; `incident-lifecycle-survey.test.ts`, 26.
- `notification-providers`: SES, FCM and Twilio, 123.
- `incident-response-runtime-pg`: `lifecycle-prerequisites.test.ts` 37, and the package 328.

Mutation checks, each restored byte-identically (md5-checked per file, or by a final md5 check):

- `STORE_PREDICATE_CALLS_SEARCH_FUNCTION.pg := true` fails 6. Dropping the `dictionary_absent`
  document-store arm fails 3. Restoring *"serveable"* fails 1. Removing the `ALTER EXTENSION`
  remedy fails 1.
- A second spelling of the WHT surface's role set fails 1. `allowed || true` in the report survey
  fails 4. Collapsing distinct pairs into the triple count fails 3. Dropping the `countAfter > 0`
  filter fails 1. Dropping the `reach !== served` filter fails 5.
- Adding `email` to the design-review producer's channels fails 5, including the workspace fence.
  Disabling `no_drain` or `producer_unmounted` each fails its "does not say delivers" test and the
  totality test.
- Making the declarer step decline fails 2. Removing the path-based route match fails 1. Removing
  the operationId namespace guard fails 1. Dropping `sweepStallSeverity` from the deletion grades
  fails 2. Injecting `new PersistentIncidentEngine(` into the module fails the census, naming the
  file. Inverting the shipped-stack condition fails 2.
- `rootCause: false` fails all five "reaches closed" tests, plus the `publiclyVisible`-split tests
  for sev3–5. Renaming the `@ts-expect-error` key is
  `TS2578`, exit 2.

**The fence caught a real transient.** One run of slice D's construction census failed with
`apps/operate-server/src/zz-node-probe.ts: 2`. That file was another agent's temporary copy of
`node.ts`, and it was gone on re-run. A third construction site is exactly what the fence exists to
see, so this is the fence working rather than a flake.

Two handed-off corrections landed in `d23a9f4` rather than here, and both were false declarations
in `packages/testing`. `pg-storeless-tables.ts`' `meta.report_runs` consequence said *"the seven
report kinds are rendered on request"*, when `REPORT_KINDS` has no reader outside
`@crossengin/reporting` and no pack declares a report. `pg-unreachable-stores.ts` said
`attachPostmortem` was reachable, when `PersistentIncidentEngine.attachPostmortem` has no non-test
caller.

## Alternatives

**Append one clause to the healthy `[search]` line.** Refused on the pre-change log: line 1
("serveable") and line 2 ("one expression") would both stay, giving two contradicting lines in one
boot. The line has to branch on the store.

**A `--finance-role` flag, or routing the report handlers through `rbacCheck`.** Both refused. The
flag would desync `operate-web`'s own `FINANCE_ROLES` copy. Routing would 403 `controller` on aging
against ADR-0126's stated intent. Either one picks a side in a disagreement the survey exists to
show.

**Count manifest-section key presence.** Refused on measurement: it reports five false declarations
on six of seven packs, because the resolved extending packs carry those sections as own keys holding
`undefined`.

**Fence notification producers by a `channel:` literal census, or by counting `.record(` receivers.**
Refused. The literal census counts a `TemplateContent` and misses the digest's variable channel. A
receiver-name count is ADR-0361's refused anchor. The refuter's own two anchors, the `INSERT` and
the store constructions, miss a new builder recorded on the existing store instance. The third
anchor that closes that gap is the required `audienceJson` field every `DispatchInput` must carry:
a census of the five modules whose source names the `audienceJson` property, each with a declared
role (declares the shape, maps a stored row, originates, or inherits), compared both ways.

**Delete the README's backlog sentence as merely vacuous.** Refused: it is false in mechanism, and
the first real producer would inherit the false belief from the code comments.

**Refuse to register sms, voice or push senders.** Refused: that would be scaffolding for a path
with no inlet, and it would change what a working deployment boots.

**A declared incident edge map checked against `node.ts` and `declarer.ts` as text.** Refused: it
would miss an incident route landing in a new file. The survey reads the live registry instead.

**Take the incident grades from schema defaults.** Refused: those would describe escalators that
were not built.

## Open questions

1. **No producer writes a dispatch on any channel but `in_app`.** Before per-tenant sender
   credentials or any of the missing provider clients can matter, three gaps sit upstream:
   - which events notify whom on which channel (a product decision);
   - a recipient address for sms, voice and push (the resolver selects no phone column although
     `meta.users.phone_e164` exists and is written, and no push device-token table exists);
   - a template body on the send path.
2. **The sms and voice suppression loop cannot close.** A Twilio bounce writes a suppression keyed on
   the callback's E.164 `To`, while the drain matches suppressions by exact string against
   `addressFor(channel, recipient)`, which is the recipient's email. Separately, `TwilioSmsSender`
   posts whatever address it is handed while the voice sender refuses non-E.164 locally. The fix is
   handed off. It needs `isE164` moved into `sms-twilio.ts`, because the reverse import is a module
   cycle. It is unreachable today because nothing produces an sms dispatch.
3. **`docs/adr/0274-notification-delivery-drain.md:40-42` and
   `docs/adr/0301-real-channel-senders.md:32-33` still state the false backlog sentence.** Both ADRs
   are historical, so whether either owes an addendum is left to the records' owners.
4. **Which vocabulary governs the finance reports** — the compile-time role set or the entity grants
   — and whether **Period Close** gets a server surface. It is assembled client-side, so
   `reportSurfaces` cannot see it.
5. **The `[reports]`, `[manifest]` and `[incident]` lines are boot-only.** A tenant's own activated
   manifest would need them on `buildOperateHttpServer`'s `onSurvey` path (ADR-0397).
6. **`--store pg` has no index-backed fold.** One needs an IMMUTABLE expression over JSONB, which is
   the column store's answer one store over. `SEARCH_EXTENSION_SERVES` has no non-test reader, and
   whether it should get one or be deleted is open.
7. **The SLO grades rest on a text fence.** The engines keep `thresholds` private, so the survey
   reads `DEFAULT_*_THRESHOLDS` and fences that `buildSloEnforcement` passes none. When the Postgres
   store refuses a declaration, `IntegrityEscalator`'s fallback holds the incident in memory, yet the
   line reports that escalator as stored by its primary declarer.
8. **`meta.incidents.postmortem_id` is unconstrained `TEXT`, while
   `meta.incident_postmortems.postmortem_id` carries `^PM-[0-9]{4}-[0-9]{4,8}$` and `UNIQUE`.** An
   incident can therefore cite an id the postmortem table could never hold, and `attachPostmortem`
   accepts `"anything"` (pinned in the rewritten test). This is a cross-table member of register
   P2.12b.
9. **The default `operate-server replay` selection exits 1 on every deployment**, because
   `buildReplayRunners` wires no `workflow` runner, so a stranded `declared` incident matters only to
   an operator already scoping with `--subsystem`. This was established from code and unit tests, not
   end to end.
10. **The arms not booted live:**
    - `--slo-defaults` on `pg`, expecting the grades, `1 of 12` and `replay --all-tenants`;
    - `--slo-defaults` on `--store memory`, expecting *held in process memory*;
    - complete SES and Twilio variables, expecting the `registered_without_producer` warning;
    - `--store pg` with `unaccent` moved to another schema, booted.

    Each is a boot of the shipped binary with one flag changed, and none has been run.
