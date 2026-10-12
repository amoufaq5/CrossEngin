# ADR-0336: The store nobody constructed

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Authors** | Platform engineering |
| **Reviewers** | Platform engineering |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0288, ADR-0293, ADR-0294, ADR-0296, ADR-0300, ADR-0313, ADR-0326, ADR-0328, ADR-0330, ADR-0331, ADR-0332, ADR-0333, ADR-0334, ADR-0335 |

## Context

ADR-0335 closed six of the 83 writerless tables ADR-0334's census had named, and in doing so it
**moved** a defect rather than closing it. `meta.feature_flag_targeting_rules` was on the writerless
census; it gained `PostgresTargetingRuleStore`, so the census stopped reporting it — and that store
is constructed only in its own test file. The table went from a place a rule watches to a place
nothing watches, and the fence read greener for it.

ADR-0335 named the gap in its own open ends: `pg-storeless-tables.ts` asks *which catalogued table
has no writer*. Nothing asks *which writer has no caller*, and the two are not the same question.
That is this increment's class.

### The measurement, and a finding about the measurement

The whole thesis rested on a grep, so it was checked against an independent reachability oracle
walking the real import graph — relative specifiers and `@crossengin/*` package roots resolved to
each package's `src/index.ts`.

The first oracle run disagreed with the grep by five, and **the oracle was wrong**. It had been
given `apps/architect-cli/src/cli.ts` as an entrypoint, which is the argv *parser* and does not
import the command bodies; the real binary is `apps/architect-cli/bin/crossengin.ts`, which imports
`src/commands.ts`, which constructs `PostgresTranscript` at line 505 under `--persist`, whose
constructor constructs the four Architect stores at `transcript.ts:99-102`. So `ai-architect-pg`'s
entire transcript subsystem read as unreachable when it is reachable.

That is worth recording because it is the failure mode a reachability rule must not have:
**over-reporting fails CI on correct code**. The entrypoints must be read from each
`package.json`'s `"bin"` field, never from a filename that looks like a CLI, and a hardcoded
entrypoint list would be ADR-0288's `needsAuditEmitter` in a new place.

Re-run from the three real binaries — `apps/operate-server/bin/operate-server.ts`,
`apps/architect-cli/bin/crossengin.ts`, `packages/kernel-pg/bin/crossengin-pg.ts` — the oracle
reaches 760 files, finds 55 exported `Postgres*` classes, 47 constructed reachably, and **8 not
constructed anywhere outside their own tests**, agreeing with the grep exactly.

### The eight, and the distinction a census cannot make

| Store | Package |
|---|---|
| `PostgresIdempotencyStore` | `api-gateway-pg` |
| `PostgresRouteRegistry` | `api-gateway-pg` |
| `PostgresPipelineExecutionStore` | `api-gateway-pg` |
| `PostgresRunbookExecutionStore` | `incident-response-runtime-pg` |
| `PostgresPostmortemStore` | `incident-response-runtime-pg` |
| `PostgresCustomerCommsStore` | `incident-response-runtime-pg` |
| `PostgresFeatureFlagStore` | `feature-flags-pg` |
| `PostgresTargetingRuleStore` | `feature-flags-pg` |

None of the eight tables appears in `pg-storeless-tables.ts`, and that rule is **correct** to omit
them: each has a store whose `INSERT` names the table, so the scan resolves a writer. The rule is
honest about its own question. What it cannot see is that the writer is never built.

The thing the eight do not share is why. Three are a **missing wire** — the store is the right
answer and nobody called it. Five are a **missing subsystem one level up**, where a wire would be a
surface reporting success and recording a typed-in claim. A callerless store is usually a symptom,
not the disease, and a census that only counts cannot tell those apart. That is why the deliverable
here is partly routes and partly declarations with their reasons.

## Decision

### 1. The three gateway stores: two wired, one declared

`@crossengin/api-gateway-pg` had zero importers until ADR-0335 wired
`PostgresRateLimitChecker`. The other three were still unreachable, and they are not one answer.

**`PostgresIdempotencyStore` — wired behind `--idempotency-store pg`, and it had two defects that
would have made it *worse* than what it replaces.** `compile.ts:760` reads
`options.idempotencyStore ?? new InMemoryIdempotencyStore()` and `server.ts` did not have the
option, so **no path existed to pass one**: every deployment's replay guard has been a `Map` in one
process. A retried `POST` landing on another replica, or on the same one after a restart, is not
deduplicated — including on `--tenant-deletion-routes`, the one route here that *requires* a key,
because a retry mints a second tombstone id, erases nothing the second time, and answers
`409 scope_empty` for a request that had already succeeded.

Both defects are ADR-0335's class — a write that sets no tenant context — and both were verified
live, as a non-owner, by issuing the unfixed statements by hand:

- `meta.gateway_idempotency_records` carries `tenant_id UUID NOT NULL` under **one `ALL`-scope
  isolation policy and no platform arm**, and all three statements were bare `conn.query` calls.
  The unfixed `get` **returned 0 rows for a row that demonstrably exists**, because
  `current_setting('app.current_tenant_id', true)` with no context is NULL — so
  `evaluateIdempotency` reads `first_seen` for *every* request and the store silently guarantees
  nothing. Not an error: a replay guard that always answers "never seen".
- the unfixed `put` was refused `new row violates row-level security policy` (`42501`), because on
  an `ALL`-scope policy the `USING` also serves as the `WITH CHECK`. And `persistIdempotency` runs
  **after** the handler's transaction committed, with no try/catch anywhere in `handleRequest`'s 17
  stages — so the throw escapes as a **500 for a mutation that succeeded**, and a client retrying
  that 500 gets the second execution. **The store as shipped would have caused the exact harm the
  record exists to prevent.**

`deleteExpired(now)` also took **no scope at all**: as the owner it reaps every tenant's rows while
naming none, and as a non-owner RLS confines it to 0 and it *reports* 0, which a reaper cannot tell
from an already-clean table — `rls_would_confine_this_session` in a new place. It is
`deleteExpired(now, tenantId)` now, required and with no default, predicate in the statement as well
as the session.

**The two halves get opposite failure policies, and that split is the decision.** `get` runs at
stage 10, before the handler: not knowing whether a request is a replay must not admit it, nothing
has happened yet, so the throw **propagates** — `processJobBatch`'s `cancellation_unknown`. `put`
runs after the commit, where throwing causes the double execution it would prevent, so it is
**reported and swallowed** — ADR-0333's rule. Swallowing is a hole, so it is said out loud: the
first failure logged in full, all counted, `report()` for a shutdown line.

The guarantee is **bounded and stated** rather than implied (`IDEMPOTENCY_GUARANTEE`). There is no
reserve step between the stage-10 read and the post-handler write, so two *concurrent* retries of
one key both read "unseen" and both execute. What Postgres buys is the **sequential** case — a
timeout, then a retry seconds later, anywhere in the fleet — which is what clients actually produce.
`IdempotencyPruneScheduler` is mounted by the store and **deliberately not by a second flag**: a
durable store that needs another opt-in to stop growing is a feature with a trap in it.
`IDEMPOTENCY_FK_HINT` is said at boot for the same reason `CAPTURE_FK_HINT` is, and here it is
worse: the table's `tenant_id` references `meta.tenants` and `--api-key 'key:role:tenant'` names an
arbitrary UUID, so on such a deployment every `put` fails its foreign key — and because `put` is
swallowed, the result is a guard that is mounted, logged as working, and stores nothing. The
capture's equivalent failure loses an observation; this one loses the guarantee the flag was turned
on for.

**`PostgresPipelineExecutionStore` — wired behind `--gateway-execution-capture <rate>`, default off,
rate required.** `node.ts` composed `executionSinks` from SLO, metering and the audit chain and
**none persisted a `PipelineExecution`**, so `meta.gateway_pipeline_executions` had never held a
row. The reason it is not simply on is the figure, derived rather than guessed: 17 `StageResult`
objects as JSON at ~232 B each is 3,952 B, plus 18 scalar columns at 286 B, is a ~4,270 B
uncompressed row; `stages` is past the 2 KB TOAST threshold and pglz on this repetitive JSON takes
it to ~1,900 B; the PK, the `request_id` unique and five declared indexes add 207 B. **≈2,100 B per
request** — **6.6 TB/year at 100 req/s, 66 TB/year at 1,000 req/s**, the same order as the 124 TB/yr
that refused `meta.feature_flag_evaluations` a writer altogether, into the same database that serves
the ERP, under RLS, on the request path.

So `sampleRate` has **no `z.default()`**: a write volume must not be chosen by silence (ADR-0328),
and `sampleRate: 0` is **refused by name** — omitting the flag already means off, and a sink that is
mounted and writes nothing is the class this increment closes, not a setting. `describeCaptureCost`
prints the rate and both projections at boot, so an accepted cost is a chosen one.

Three decisions inside it are worth recording. **A sample rate, deliberately not an outcome
filter**: the cheap-looking default is "keep the denials and errors", and it is wrong, because
`pass_with_4xx_or_5xx` and `deny_without_4xx_or_5xx` are drift codes about a row whose
`finalOutcome` *disagrees* with its status — filtering on the outcome the gateway claims discards
exactly the rows where that claim is false. A uniform sample keeps every drift code detectable in
proportion; an `operations` allowlist is offered instead, because narrowing the population blinds
nothing. **`sampleValue` is imported from `audit-chain.ts` rather than re-derived**, so the two
samples nest: at an equal rate both keep the same requests and at a lower rate the capture is a
strict subset, so a captured execution always has a chain entry beside it. And **shedding rather
than `AuditChainObserver`'s per-scope promise chain**: that chain exists because a hash chain has an
order, while an execution row is independent under `ON CONFLICT (request_id) DO NOTHING`, so
serialising buys nothing and costs two things — it pins a tenant to one write at a time and grows an
unbounded promise chain when the database is slower than the traffic, turning a slow disk into an
OOM. Past `maxInFlight` (8) an execution is shed and counted; `record` never throws and never awaits.

**`PostgresRouteRegistry` — declared, not wired, and the SQL is not the reason.** The table is
platform-wide with no `tenant_id` and no RLS, so none of the owner-bypass defects apply. It answers
a different question. `compileOperateServer` derives routes **and their handlers in one pass** from
the manifest, keyed on `operationId`, so substituting a row-backed registry breaks that silently in
both directions: a row the manifest did not produce has **no handler**, so it matches,
authenticates, consumes its rate-limit budget and resolves to `no_handler`; a manifest route
**absent** from the table stops matching, so activating a manifest would quietly un-serve part of
it. `lookup` is also synchronous and returns `null` on a cold cache, so the first requests after a
boot or a TTL lapse are unroutable unless `ensureLoaded()` is awaited off the request path — a
requirement the `RouteRegistry` interface cannot express. And `node.ts` reads `gateway.routes.list()`
for `surveyRoutePolicies`, which is deliberately not on that interface. The one piece with
standalone value is `upsert` — publishing the compiled surface, since `rate_limit_policy_id` is the
only persisted statement of which policy governs a route — and it is not taken, because rows nothing
reads would make `meta.gateway_routes` *look* like the authority on the served surface when the
manifest is, which is worse than an empty table. So it is a **different serving model**, not a
missing wire.

**What wiring the writer leaves open, said plainly:** `GatewayReplayer` has zero importers outside
its own test — no route, no CLI subcommand, no scheduler. Capturing executions without wiring the
replayer puts ADR-0335's shape in a new place: a store with a writer and a reader with no caller,
which is precisely what `targeting-rule-store.ts` did. The difference argued here is real but not
decisive — the rows themselves are the product, a queryable forensic record of request handling,
whereas a targeting rule is inert until a flag engine evaluates it — and a read route would need the
`--audit-read-routes` apparatus (a role, a recorded read, a tenant refusal) and is its own
increment. Recorded as an open end rather than settled by assertion.

### 2. The three incident stores are declared, because there is no incident lifecycle surface

The parent fact reframes all three: **`operate-server` has no incident lifecycle surface at all.**
No `/incidents` route exists anywhere in `apps/`, and `PersistentIncidentEngine` is constructed only
by `PostgresIncidentDeclarer`, which calls `declare`, `findOpenFor`, `load` and `cancelIfUntriaged`
and never `assignRole`, `changeSeverity`, `note`, `transition` or `attachPostmortem`. Incidents are
declared by automation, paged, given a `paged` timeline note, and auto-cancelled. The three stores
are leaves of a trunk that does not exist.

Two consequences are live rather than theoretical:

- **`human_owned` is unreachable in every deployment.** `cancelIfUntriaged` declines only when the
  status is not `declared`; reaching `triaged` requires the on-call roles assigned and no route
  assigns one. So every automated recovery cancels, and `closeOutClosesAlert`'s deliberate
  `human_owned` arm — ADR-0326's "an alert left up is noise, an alert wrongly closed is silence" —
  never fires.
- **sev1 and sev2 incidents cannot be closed at all.** `IncidentRecordSchema` refuses `closed`
  without a `postmortemId` for every severity whose profile sets `postmortemRequired`, which is sev1
  and sev2 — **every grade the three escalators declare at**. The refinement immediately above it
  refuses any status past `declared` for those grades without `publiclyVisible: true`, i.e. a status
  page this platform does not have. `declared → cancelled` is the whole reachable lifecycle.

Per store, each reason recorded in the store's own header where the local rationale belongs:

**`PostgresRunbookExecutionStore` — there is no runbook.** No `Runbook` or `RunbookDefinition`
contract exists anywhere in the workspace and there is no `meta.runbooks` table;
`incident-response/src/executions.ts` declares `RunbookExecution` and `RunbookStepRecord` and
nothing a step could be read from, so `runbookId`/`runbookVersion` are free TEXT naming a document
outside this system and no module executes a step. A route over this store would accept an
operator's transcription of outcomes the platform did not produce — a row that reads as a record and
is a typed-in claim. The writer this table wants is a runbook executor; the thing that must exist
before the executor is a runbook. (The store's existing header asserted *"a scheduler drives an
execution while an operator watches it"* as present fact; corrected.)

**`PostgresPostmortemStore` — an ordering decision, and load-bearing.** It is a prerequisite of
closing an incident, so it and a close route have to land in one increment: a write route here
*without* a close route mints a postmortem nothing can attach, because the only thing that sets
`postmortem_id` is `IncidentExecutor.attachPostmortem` and nothing reaches it — ADR-0335's dangling
`ftr_…` ids in a new table; a close route *without* this store leaves an operator a sev1 they can
triage, mitigate and resolve and then never close. Every field is prose a person writes and
publishing needs two reviewers with the author excluded, so the surface that fills it is an
authoring UI, not a JSON POST, and `operate-web` has no incident pages.

**`PostgresCustomerCommsStore` — the contract cannot carry the surface.**
`IncidentCommunicationSchema` models only a communication that has **already been published** —
`publishedAt`, `publishedBy`, `deliveryChannels` and `recipientCount` all required, **no draft
status** — while `requiresLegalReview` is forced true for `breach_notification`, `regulators` and
`law_enforcement` and then demands `legalReviewedBy` *and* `legalReviewedAt` on the same record. So
there is no state in which the platform holds a drafted notice awaiting review, and a single-POST
route would take the legal-review attestation **from the request body**, manufacturing the proof of
review the field exists to carry. That is exactly what `--notification-template-routes` built an
author grant, an approver grant and a `created_by <> $actor` predicate to prevent (ADR-0313), and
this contract has no two-step state to hang that apparatus on.

Two mismatches confirm the record predates the delivery stack rather than describing it:
`deliveryChannels` admits `rss` and `status_page`, neither of which is in `NOTIFICATION_CHANNELS`
and neither of which anything here delivers, and it spells push `push` against the stack's
`push_mobile`; and `regulators` / `law_enforcement` are not resolvable audiences, since
`PostgresRecipientResolver` resolves tenant users.

**Incidental, and the sharpest thing found in that file:** the schema refuses `publishedAt` later
than `breachNotificationDeadlineAt` (`comms.ts:105–113`), so a **late** GDPR 72-hour breach
notification is unrepresentable — the one fact a regulator would ask for is the record this table
cannot hold, and `isBreachNotificationTimely` can therefore never answer `false` for a record that
parsed. Reported, not changed: it is a contracts edit with cross-package consumers and a product
decision, and changing a contract forces a workspace rebuild before any consumer's tests mean
anything (ADR-0329).

`lifecycle-prerequisites.test.ts` encodes the two couplings from the contracts rather than from
prose, walking `SEVERITIES` × `requiresPostmortem` rather than hardcoding grades, with both sides
asserted non-empty as a vacuity guard, so a close route added later fails there naming the reason
instead of at the first sev1.

### 3. The two flag stores are declared, because nothing evaluates a flag

**Nothing in the workspace evaluates a feature flag** — not "nothing in `operate-server`", and there
is no evaluator function to call. `packages/feature-flags/src/` models every ingredient and composes
none of them: `isFlagActive`, `isFlagInEnvironment`, `parseDefaultValue`, `parseKilledValue`,
`findActiveKillSwitch`, `isKillSwitchActive`, `chooseTargetingRule`, `computeStableBucket`, and
`FlagEvaluationSchema` with 17 `EVALUATION_REASONS` for the record one would write. No function
anywhere takes a flag plus a context and returns a value or a `FlagEvaluation`.
`chooseTargetingRule`'s own comment says *"every would-be caller had to re-decide first match or
every match"* — **would-be** is exact.

Proved mechanically rather than by reading: each of the 17 reasons appears **only** in
`evaluations.ts`, its own test, and the CHECK constraint on `meta.feature_flag_evaluations.reason`.
Zero producers, which is ADR-0334's `JOB_KIND_PRODUCERS` shape, so
`FLAG_EVALUATION_REASON_PRODUCERS` is a **total map** over `EVALUATION_REASONS` answering `"none"`
seventeen times, with `stored_flags` and `declared_flags` reserved in the union so the product choice
is expressible rather than implicit. An eighteenth reason is a compile error, and
`flagEvaluationIsImplemented()` is the single call that answers the question — false today.

And there is no *source* either, so the design question has a third answer. A flag has no manifest
field, no CLI flag, no env var, no HTTP route and no writer caller. **A feature flag in this
architecture is neither a database record nor a deployment declaration. It is a modelled domain with
no mechanism** — so the absent evaluator is the disease and the two callerless stores are symptoms.

**The finding that matters most is on the store that *is* reachable.** `PostgresKillSwitchStore` is
constructed by `observability-runtime-pg`'s two persisting engines, so a callerless-store census
clears it on the first question. But `KillSwitchLookup`, the only seam between the SLO engine and
this package, has exactly **one** method: `findForIncident` — *which incident did this switch open*,
so a restart adopts the episode (ADR-0294, ADR-0296). It does not answer *is this flag killed*.
`listActiveForFlag`, `findActiveKillSwitch`, `isKillSwitchActive` and `parseKilledValue` are called
only by their own tests. So the SLO loop's third enforcement action — the kill-switch flag rollback,
beside a declared incident and a real page — **writes a row and stops there**, naming a `flag_id`
whose flag row cannot exist because nothing writes `meta.feature_flags`. ADR-0333's class on a
constructed store, invisible to the rule this increment is about.

**A second, complete flag subsystem exists.** `packages/deploy/src/feature-flags.ts` has the
workspace's only `evaluateFlag()` (line 153), its own 4-member `FLAG_KINDS` against the other's 7 — a
strict subset — its own `TargetingRuleSchema` and `FlagVariantSchema`, and a `hash*31` bucket rather
than FNV-1a. Measured: **six colliding exported names** (`FLAG_KINDS`, `FlagKind`, `FlagVariant`,
`FlagVariantSchema`, `TargetingRule`, `TargetingRuleSchema`), and **`packages/deploy` has zero
importers** — the `api-gateway-pg` condition before ADR-0335. Two flag subsystems, zero evaluation
sites. Which of the two is the real model is a product decision, not a wiring step, and this
increment does not take it.

So: `PostgresFeatureFlagStore` is declared `no_consumer_exists` — there is no wire to run — and
`PostgresTargetingRuleStore` `awaiting_authoring_grant`, where ADR-0335's reasoning stands (a
targeting rule changes what the deployment serves, so an authoring route is config-grade and wants
ADR-0313's author/approver split) and the missing evaluator is the larger half.

No boot survey line was added, on `--rate-limit-policy`'s own precedent read the other way: ADR-0334
warned about an unserved job queue because the deployment was *already filling it*. Nothing fills
anything here, so a line on every boot announcing that a subsystem nobody asked for is absent would
be noise where that one was signal. `surveyFlagSubsystem()` is a value a caller can hold the day one
wants it.

### 4. The rule: `pg-unreachable-stores.ts`, the storeless rule's inverse

`packages/testing/src/strategy/pg-unreachable-stores.ts` is the fifth workspace rule, and like the
other four it reads the real workspace from disk rather than importing it — `packages/testing` has
no workspace dependencies, so importing `@crossengin/kernel` would make the graph cyclic and reading
`kernel/dist` would make the answer depend on whether someone ran `pnpm -r build`. **A rule that is
green only after a build is not a rule.**

Measured state: **55 exported `Postgres*` classes, 49 reachable, 6 declared**, zero symbol
collisions, 1,740 files scanned across 18 pg packages. The declarations are the only place a name is
written down and there is **no count equality anywhere** — the floors are one-sided
(`stores ≥ 50`, **`reachable ≥ 40`**, `unreachable ≤ 12`), and the floor is on the *reachable* side
deliberately: a site matcher that stopped matching would report all 55 unreachable, and
over-reporting is the direction that fails CI on correct code.

**The rule caught a live wiring commit while it was being written.** The gateway lane landed
`new PostgresIdempotencyStore(conn)` and `new PostgresPipelineExecutionStore(conn)` in `node.ts` and
three workspace tests went red with `[overtaken] api-gateway-pg:PostgresIdempotencyStore`. The fix
is to delete the declaration, not to weaken the check — which is the mechanism working, and is why
the final list has six members and not eight.

Five reasons, each with a required field that cannot be left to prose:

| reason | required field | members |
|---|---|---|
| `no_caller_by_design` | `decidedIn`, an `ADR-NNNN` asserted to exist on disk | 1 |
| `substitute_in_use` | `substitutedBy`, asserted itself constructed outside tests | 1 |
| `unpersisted_record` | — | 0 |
| `prerequisite_of_unbuilt_surface` | `blockedBy` | 3 |
| `contract_cannot_carry_the_surface` | `blockedBy` | 1 |

The two blocked reasons split on **ordering versus shape**, adopted from the incident lane on
ADR-0330's reasoning: a store blocked by ordering will be wired and its note says what must land
beside it, while one blocked by its contract's shape needs a schema change first, and calling both
"unwired" sends the next person to write the route that cannot be written honestly.
`no_caller_by_design` is the one reason that must never be assumed, so it is the only one required
to cite where it was decided. `unpersisted_record` is kept with **no member** and the reason is in
its doc: its single member was wired within the hour, which is the category doing its job.
`tables` is required on every declaration and **may be empty**, because `[]` is a signed assertion
that the store writes no catalogued table while an absent field would mean nobody looked
(ADR-0331's distinction, in a third place).

Twelve finding kinds, compared **in both directions** every run — fences read from the facts
(`store_test_only`, `store_unconstructed`, `package_unimported`, `package_test_only_importer`,
`package_declared_unused`), staleness from the declarations (`overtaken`, `unknown_symbol` — which
says if the symbol merely moved package, `unknown_package`, `duplicate`, `unsupported_substitute`,
`unknown_table`, `table_declared_storeless`). Both directions is the part that carries the weight,
for ADR-0334's reason: *location* was never what made ADR-0288's `needsAuditEmitter` wrong, the
absence of a both-ways comparison was.

**`table_declared_storeless` is the cross-rule join, and the sharpest statement of why two rules are
needed at all**: `pg-storeless-tables.ts` decides a table is written by reading a store's SQL as
text, so **a store with no caller makes its table read as written while no deployment has ever put a
row in it.** A table appearing in both lists means the two rules disagree, which is a finding.

**The transitive version was implemented as a measurement and refused as a fence, and the
measurement is what refuses it.** Entrypoints from every `package.json` `"bin"` — never from a
filename that looks like a CLI, because `src/cli.ts` is the argv *parser* and does not import the
command bodies — resolve with zero unresolvable imports and reach 760 of 1,026 non-test files,
matching the independent oracle exactly. And then the modules holding `PostgresTargetingRuleStore`,
`PostgresRouteRegistry` and `PostgresCustomerCommsStore` all come back **reached**, because an
`index.ts` carrying `export * from "./targeting-rule-store.js"` is imported by package root. **Module
reachability is not symbol reachability**, and in this workspace it answers "reached" for precisely
the stores the rule exists to report. Answering it honestly needs symbol-level use analysis through
`export *`, which is a type-aware pass and not a text scan. (The same run shows `apps/operate-web`
absent from the graph entirely — a Next app declares no `bin` — so 266 non-test files would read as
orphaned.) Both figures and the `src/cli.ts` lesson are written into the module so nobody repeats
either attempt. The flat signal is sound **because** it is conservative: it can only under-report,
so whatever it declares is a lower bound.

Signal 2 — a pg package with no importer — is **vacuous today**: all 18 classify `reachable`, since
ADR-0335 wired `api-gateway-pg`. So its floor asserts the scan **resolved** every package and that
the distinct package count equals the list length, rather than "finds ≥ 1", because an unresolved
entrypoint silently makes everything downstream read as callerless. Its negative control strips
`api-gateway-pg`'s import edges and demands exactly `package_unimported` — literally its
pre-ADR-0335 state, which is the only way to exercise a signal with no live member.

## Alternatives considered

**Wire all eight.** Rejected for five of them, and the reason is the increment's point: three CRUD
route families added because a census complained would be precisely the "surface reports success and
records nothing" class ADR-0332 and ADR-0333 exist to end. A runbook-execution route with no runbook
records a transcription; a comms route manufactures its own legal-review attestation; a flag
administration surface serves an evaluator that does not exist.

**Declare all eight.** Rejected for the gateway three: there the store *is* the answer, the
subsystem above it exists and is running, and the only thing missing was the call.

**One flat "unwired" reason.** Rejected on ADR-0330's split-one-set-in-two reasoning. A store
blocked by *ordering* will be wired and its note says what must land beside it; a store blocked by
its *contract's shape* needs a schema change first. Calling both the same thing sends the next
person to write the route that cannot be written honestly.

**Extend `pg-storeless-tables.ts` instead of a new rule.** Rejected: it answers a different
question, correctly. Its unit is a catalogued table; this rule's unit is an exported symbol, and its
input is the dependency graph rather than SQL text. Folding them would make one rule answer two
questions and report a finding under the wrong name.

## Consequences

**Two tables hold rows for the first time in any deployment.** `meta.gateway_idempotency_records`
and `meta.gateway_pipeline_executions` were both empty everywhere before this.

**The replay guard is durable, and the proof is the pair.** Verified live on a throwaway PG 16
cluster, booted as a **non-owner role** (`rolbypassrls = f`) against a provisioned tenant, with the
same key POSTed three times across a process restart:

| | `--idempotency-store pg` | default (in-memory) |
|---|---|---|
| first request | `first_seen` | `first_seen` |
| retry, same process | `replay_hit_match` | `replay_hit_match` |
| retry, **after restart** | **`replay_hit_match`** | **`first_seen`** |
| rows in `meta.gateway_idempotency_records` | 1 | **0** |

The negative control is the half that makes it attributable: with the guard every deployment has had
today, the key is forgotten by the restart and the mutation would re-execute.

**Scoping holds as a non-owner.** Two tenants POSTing the *same* `Idempotency-Key` get
`first_seen` → `replay_hit_match` for the first and `first_seen` for the second, with one row each —
so the durable guard does not leak a key across tenants.

**A defect in the cost line, found on the first live boot.** `--gateway-execution-capture 1` printed
`capturing 1% of executions` beside a byte figure that was right for 100%, understating the volume
a hundredfold in the one line whose entire job is to make an operator see the cost before accepting
it. `(1 × 100).toPrecision(3)` is the integer `"100"` with no decimal point, and a trailing-zero
strip of `/\.?0+$/` ate the two zeros. Zeros are now stripped only *after* a decimal point. The
reason the module's own five `describeCaptureCost` tests could not see it is worth more than the
fix: every one asserted a byte figure or the operation count and **none asserted the percentage**.
Two tests now pin it, one of them across eight rates.

**The deployment gains nothing it did not ask for.** Both flags are off by default, both refuse
`--store memory` by name, `--gateway-execution-capture 0` is refused rather than honoured, and a
`--gateway-execution-capture-operation` with no capture mounted is refused rather than silently
inert.

**Five stores stay unreachable, each with its reason on disk in two places** — the store's own header
and `UNREACHABLE_STORES` — and a sixth, `PostgresRouteRegistry`, is declared a different serving
model rather than a queue position.

**Two live defects are now documented that nobody had stated**, both consequences of there being no
incident lifecycle surface: `human_owned` is unreachable in every deployment, so ADR-0326's
"an alert wrongly closed is silence" arm never fires; and sev1 and sev2 incidents — every grade the
three escalators declare at — **cannot be closed at all**. Neither is fixed here; both are product
decisions on contracts with cross-package consumers.

**One contract defect is recorded and not fixed:** a late GDPR 72-hour breach notification is
unrepresentable, so `isBreachNotificationTimely` can never answer `false` for a record that parsed.

**Four CLAUDE.md claims were wrong in the optimistic direction** and are corrected, one of them
shipped by ADR-0335 itself.

## Implementation notes

**Live verification**, on a throwaway PG 16.13 cluster, as a non-owner role except where an owner
connection is named:

- fresh bootstrap **960/960 executed, 0 failed**;
- a non-owner role (`rolbypassrls = f`) with table grants and no tenant context;
- the idempotency matrix and the negative control above, and the two-tenant scoping result;
- the **pre-fix defects reproduced by hand**: the unfixed `SELECT` answered `0` for a row that
  exists while the same read inside a transaction with `set_config('app.current_tenant_id', …, true)`
  answered `1`; the unfixed `INSERT` was refused `new row violates row-level security policy`;
- the capture wrote a row per request, correctly tenant-scoped, with `stages` holding 7 stage
  results at 546–584 B of `pg_column_size` — against a header estimate of ~1,900 B for a full
  17-stage pass, so the estimate is conservative for a request that denies early at `match_route`;
- the corrected boot line reads `capturing 100% of executions`.

Two wrong turns worth recording. `--api-key 'k1:admin:…'` boots fine and then answers **504
`unknown role 'admin'`** on the first request, because the pack's roles are `erp_admin`,
`erp_accountant`, `erp_viewer` and so on — a role name that no manifest declares is not refused at
boot. And `meta.tenants`' columns are `id` / `slug` / `name` / `schema_name`, not
`tenant_id` / `display_name`, which is worth knowing before writing a fixture against it.

**The ADR-0336 census was checked against an independent oracle**, and the oracle was wrong first.
Its figures, after the entrypoint fix: 3 binaries, 0 unresolvable imports, 760 of 1,026 non-test
files reached, 55 exported `Postgres*` classes, 47 constructed reachably, **8 test-only** — agreeing
with the grep exactly. The strategy rule, written independently, found the same eight by name on its
first run.

**The two declaration lists disagreed about one store and were reconciled** rather than both
shipped, which would have been ADR-0288's shape. `pg-unreachable-stores.ts` had
`PostgresFeatureFlagStore` blocked on "a flag-authoring surface … this is ordering"; the flag lane
proved the harder fact, that no evaluator exists anywhere, so a route alone would store flags
nothing reads. Its `blockedBy` now names the evaluator **first** and says why building the route
first is the one ordering that cannot work. `packages/feature-flags-pg/src/subsystem-survey.ts`'
`CALLERLESS_FLAG_STORES` remains a second list the rule does not read — a declared follow-up, to be
compared from disk in both directions the way `pg-record-retention.ts` does.

**Two concurrent `pnpm -r` runs tear `dist/`, and the failures look real.** Backgrounding a second
sweep before the first had finished produced **three phantom failures** — a `kernel-pg` policy
canonicalization assertion reading `'INSERT'` where the catalog says `'ALL'`, and two
`operate-server` CLI tests expecting a refusal that did not throw — none of which reproduced when
the same packages were run alone, before *or* after the change. Packages resolve each other through
`dist/`, so one run's `tsc` writing a file while another run's vitest reads it yields assertions
about a module half-built from two trees. This is ADR-0307's lesson in a third form (running vitest
is not running the type checker; running vitest is not running the build; **running two sweeps is
not running one**): a failure has to be reproduced in isolation before it is believed, and a sweep
has to be the only thing running.

**Workspace**: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test` all green, run alone.

## Open questions

- **Which of the two flag subsystems is the real one**, and whether a flag is a stored record or a
  boot declaration. `FLAG_EVALUATION_REASON_PRODUCERS` reserves both answers; neither is taken.
  `packages/deploy`'s six colliding names are latent only because nothing imports it.
- **Whether CrossEngin runs its own incident response through its own API.** The design the code
  supports is that the platform detects and pages while the human response happens in the operator's
  own tooling — the page transports are PagerDuty/Slack/webhook/SMS, the incident id is PagerDuty's
  `dedup_key`, and `runbookId` is free text naming an external document. Under that reading the
  incident record is a paging correlation handle with two reachable states and the three tables are
  the persistence of a half that was never built.
- **Two contract contradictions in `@crossengin/incident-response`**, both reported and untouched:
  sev1/sev2 requiring `publiclyVisible` against a status page that does not exist, and a late GDPR
  breach notification being unrepresentable.
- **The rule's own blind spot**: it answers "is this symbol constructed on a path reachable from a
  binary", which is not "is it constructed on a path any deployment takes". A store constructed only
  under a flag nobody sets is reachable by this rule and dead in practice — the condition
  `--workflow-workers` was in before ADR-0333.

## References

- ADR-0335 — the record nobody could write (named this gap in its open ends)
- ADR-0334 — the writerless census, and `JOB_KIND_PRODUCERS`' total-map shape
- ADR-0333 — built, tested, never connected; the fake-connection boundary
- ADR-0330 — splitting one set in two rather than merging two reasons
- ADR-0296 — the three incident stores, and its own note that nothing exposes them over HTTP
- ADR-0300 — `PostgresFeatureFlagStore`, built and never wired
- ADR-0313 — the author/approver apparatus a config-grade write needs
- ADR-0326 — `closeOutClosesAlert` and the `human_owned` arm
- ADR-0288 — why a hand-maintained list is the wrong forcing function
