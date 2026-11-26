# ADR-0483: An SLO declaration cannot fail silently, a replay default can pass, and one refused usage record no longer stops billing

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-25 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0415 (every step after a declaration is reported), ADR-0416 (incident lifecycle survey), ADR-0364 (an optional reporter defaulting to silence), ADR-0337 (operate-server replay), ADR-0451 (usage windows), ADR-0360 (savepoint per statement), ADR-0373 (no row values in a refusal), ADR-0338 (refusing breaks nothing that worked) |

## Context

Seven open items from ADR-0415, ADR-0416, ADR-0417 and ADR-0451, each re-measured against the tree
before anything was changed. Three of the briefs' own remedies were corrected by that measurement.

1. **`onDeclarationError` was optional on both SLO engines and on `BuildSloEnforcementOptions`.**
   ADR-0415 made every step after an incident declaration *reported, never thrown*, and the report
   goes through `onDeclarationError`. Optional, so an engine built without it reported a refused
   kill-switch write, an unrecorded action or a failed close-out to nobody. `node.ts` passes one; the
   tests and any second caller did not have to.
2. **An SLO registration's `tenantId` was `z.string().min(1)`.** A config naming `"acme"` parsed and
   booted; every record the breach then wrote (`KillSwitchSchema.tenantId`, the enforcement action,
   the evaluation) is a uuid column and refused it, after the incident had been declared.
   `slo-defaults.ts` already used `.uuid()`.
3. **The `[incident]` boot line printed grades from the default threshold constants**, not from the
   engines it was describing. Latent rather than live: `buildSloEnforcement` passes no `thresholds`,
   so every shipped engine runs on those defaults and the line was right — held true by a text fence
   over `slo-config.ts` rather than by reading the engine, so the first caller that passed its own
   thresholds would have been described wrongly. And
   the integrity escalator was rendered as *stored* when its declarer is a
   `FallbackIncidentDeclarer` — stored when the store accepts the row, held in memory on refusal.
4. **`IncidentRecord.postmortemId` was `z.string().min(1)`** while `meta.incident_postmortems`'
   `postmortem_id` is `^PM-[0-9]{4}-[0-9]{4,8}$` and UNIQUE, so an incident could cite an id the
   postmortem table could never hold (register *What's actually left*, item 8). The brief named
   `executor.test.ts` as the test pinning `"anything"`; the pin that asserted the defect as the
   specification is `incident-response-runtime-pg/src/lifecycle-prerequisites.test.ts`.
5. **`operate-server replay` with no `--subsystem` exited 1 on every deployment** — measured live:
   the default selection is `REPLAY_SUBSYSTEMS`, `workflow` has no runner, and its section reads
   `NOT READ`, so the report is never ok. The brief said only that; the measurement found a second
   cause it did not have: under `--tenant` the default **also** includes `incidents`, which has no
   `tenant_id` and refuses any scope, so even with a workflow runner `replay --tenant <id>` would
   exit 1. The `--help` text's *"the default is every subsystem the chosen scope can serve"* was
   false for `--tenant` and `--platform`.
6. **`PostgresUsageRecordStore.recordWindow` was all-or-nothing.** Its own comment argued that a
   window half-written would leave the caller unable to tell which half to retry; every insert is
   `ON CONFLICT (idempotency_key) DO NOTHING`, so a half-landed window is already exact to retry, and
   what all-or-nothing actually bought was that **one record's refusal rolled back every tenant's**.
   Reproduced live as `crossengin_app`: one transaction inserting a provisioned tenant's record and
   then an unprovisioned one's raised `23503` on `billing_usage_records_tenant_id_fkey` and committed
   **0** rows. That refusal stands until an operator provisions the tenant, so the window stayed
   pending, every later tick failed the same way, and every later window queued behind it: no tenant
   was billed meanwhile. Separately, `record()`'s re-close check compared
   `Number.parseFloat(stored) !== valid.quantity` — a JS double against a `NUMERIC(20, 4)` the write
   had rounded — so a re-close of `0.1 + 0.2` (stored `0.3000`) was refused as a changed quantity.
7. **`buildIdempotencyKey` had no writer.** Two replicas cut windows whose start instants can be
   equal, and the second replica's insert under the same key was a silent `DO NOTHING`: its usage was
   never billed.

## Decision

**A reporter whose absence is silence is required.** `onDeclarationError` is required on
`SloEnforcementEngineOptions`, `LatencySloEngineOptions` (and so on both persisting
builders, whose options extend them) and on `BuildSloEnforcementOptions`; `buildSloEnforcement`'s
options argument has no default. `@ts-expect-error` fences in three packages make an engine built
without it a compile error.

**A registration's tenant is a uuid or null.** `SloRegistrationConfigSchema.tenantId` is
`.uuid({ message: "tenantId must be a tenant uuid (meta.tenants.id), or null for the platform" })`,
so the refusal lands at parse, naming the path. Nothing ever stored a non-uuid tenant there, so the
refusal breaks no working config (ADR-0338).

**The survey reads what the engines will do.** Both engines expose a readonly `declaredSeverities`
getter over their own thresholds, and the lifecycle survey takes the SLO grades from it. Escalator
storage is a three-valued `EscalatorStorage` (`stored` / `stored_unless_refused` / `memory`) rendered
through a total map; the integrity escalator over a `PostgresIncidentDeclarer` is
`stored_unless_refused`, *"stored when the store accepts it, held in process memory on refusal"*.

**One postmortem-id spelling.** `POSTMORTEM_ID_REGEX` is exported from `postmortems.ts` and
`IncidentRecordSchema.postmortemId` uses it; a test asserts the two schemas agree on every probe.
Tightening a contract over stored rows can make a stored row unreadable, and here the population is
zero: `attachPostmortem` has no non-test caller, so no deployment has ever written a
`meta.incidents.postmortem_id`.

**The replay default selects what can be read.** `selectReplaySubsystems(requested, runners,
coverage)` in `replay.ts` is pure: an explicit `--subsystem` list is run as asked (so an unwired or
unservable one is still refused and still exits 1 — naming one is a request to see that refusal); the
default is `REPLAY_SUBSYSTEMS` minus the unwired and, when a scope is given, minus what that scope
cannot serve, with one info line naming each omission and its reason. It never selects nothing: if
every subsystem would be omitted it falls back to all of them, so the refusals are printed rather
than an empty pass reading as ok. `--all-tenants` passes `coverage: null` because that sweep visits
every scope.

**A usage window refuses records, not windows.** Each record goes behind `SAVEPOINT
usage_window_record`. A refusal *of the record* — SQLSTATE class 22 or 23 — is `ROLLBACK TO` then
`RELEASE` (the savepoint survives a rollback, ADR-0360) and is returned in `refused` with its
SQLSTATE and constraint and no row value (ADR-0373); anything else (privilege, serialization, a lost
connection) is not about the record and propagates, failing the window so it is retried unchanged.
`recordWindow` returns `{ inserted, refused }`. `MeteringFlushScheduler` drops refused records from
pending — re-sending cannot succeed until somebody changes the database — and reports them through
a **required** `onRefused`; `buildRequestMetering` defaults that to one `console.error` line carrying
`UsageRecordsRefused`'s message (count, meter, SQLSTATE and constraint; no tenant, no quantity). It is
deliberately not routed to `onError`, which means *a window did not write and is retried* and which
`node.ts` prints as "flush error"; and `UsageRecordsRefused.refused` is non-enumerable, so logging the
error object cannot print the rows it carries. The re-close compare is in
SQL: `SELECT quantity = $2::NUMERIC(20, 4) AS same`, which applies the same rounding the write did.

**A usage key names its writer.** `buildIdempotencyKey` takes `writer: string | null`, appending
`:writer=<id>` when non-null, and throws on a writer outside `^[A-Za-z0-9._-]{1,64}$`.
`MeteringFlushScheduler` uses one random id per instance (one per process), stable for the life of
the process because a pending window is retried under the keys it was cut with. `closePeriod` passes
`null`: a period's own record must keep colliding with itself, since that is how a re-close is found.

## Alternatives considered

- **Keep all-or-nothing and skip a refused record on the next attempt.** Would need the store to know
  which record failed, which is exactly what a per-record savepoint answers; and it costs a full
  failed transaction per tick for as long as the refusal stands.
- **Treat every error as a record refusal.** Refused: a `42501` or `40001` says nothing about the
  record, and dropping on it loses usage. A test fences both.
- **Compare against the value rounded to 4 dp in JS.** Equivalent for this column and a second
  spelling of `NUMERIC(20, 4)`'s rounding; asking Postgres is the house rule (ADR-0330).
- **Make the replay default exclude only unwired subsystems**, as the brief said. Measured
  insufficient: under `--tenant`, `incidents` still makes every default run exit 1.
- **Writer from `hostname()` and pid.** Hostnames are not guaranteed to fit the key grammar, and pid 1
  collides across containers sharing a hostname pattern; a random uuid per process cannot collide.

## Consequences

- A caller constructing an SLO engine must say where declaration errors go; three tests that built
  one without it (`slo.test.ts`, `slo-rollback-survey.test.ts`, the survey test) were updated.
- An existing SLO config with a non-uuid `tenantId` now fails at boot rather than on its first breach.
- Metered usage for an unprovisioned tenant is dropped and reported rather than blocking every other
  tenant's billing until that tenant is provisioned. It is not billed — the report is the only record of it.
- Usage keys change shape for request metering (`…:writer=<uuid>`); keys already stored are
  unaffected, and `closePeriod`'s keys are byte-identical to before.
- The `[incident]` line can now be read as a statement about the configured thresholds.

## Implementation notes

- `packages/observability-runtime/src/{engine,latency-engine}.ts`: required option, `declaredSeverities`.
- `apps/operate-server/src/slo-config.ts`: uuid tenant, required option.
- `apps/operate-server/src/incident-lifecycle-survey.ts`: grades from the engines, `EscalatorStorage`.
- `packages/incident-response/src/{postmortems,incidents}.ts`: `POSTMORTEM_ID_REGEX`.
- `apps/operate-server/src/replay.ts`: `selectReplaySubsystems`, `ReplaySelection`, `ReplayOmission`.
- `packages/billing/src/usage.ts`, `packages/billing-runtime/src/{ingest,engine}.ts`: the writer.
- `packages/billing-runtime-pg/src/usage-store.ts`: savepoints, `UsageWindowWrite`,
  `RefusedUsageRecord`, the SQL compare.
- `apps/operate-server/src/metering.ts`: writer, `onRefused`, `UsageRecordsRefused`.
- **Not done here, because the files are shared**: `node.ts`'s `runReplay` must call
  `selectReplaySubsystems(options.subsystems, runners, options.allTenants ? null : coverage)` after
  building the runners, print `selection.info`, and run `selection.selected` — until it does the
  binary's default replay still exits 1; `cli.ts`'s replay `--help` must say the default is the wired
  subsystems the scope can serve; and `META_INCIDENTS.postmortem_id` wants
  `check: "postmortem_id ~ '^PM-[0-9]{4}-[0-9]{4,8}$'"` with its meta-schema test (a CHECK on a
  populated column, so ADR-0363's widening proof decides whether it is planned).

## Verification

Per package (build, `tsconfig.typecheck.json`, tests): billing 102, billing-runtime 33,
billing-runtime-pg 29, incident-response 157, incident-response-runtime 195,
incident-response-runtime-pg 330, observability-runtime 226, observability-runtime-pg 176 — all
green; operate-server's eight files this slice touches or depends on (metering, replay, slo-config,
slo, slo-rollback-survey, incident-lifecycle-survey, slo-defaults, cli) 495 green, and the whole operate-server suite 6,877 across 185 files after the review's fixes. operate-server's typecheck carries two errors at
`node.ts:3798/3919`, which belong to another slice's change and none of this one's.

Mutations, each reverted by its inverse and confirmed byte-identical: `onDeclarationError` made
optional → `TS2578` on the fence and `TS2322` in the engine; the postmortem regex loosened → 2 tests
fail; `RELEASE` after `ROLLBACK TO` removed → 1 fails; classes 40/42 counted as record refusals → 1
fails; the writer dropped from the key → 1 fails; the scope arm removed from the default selection → 1
fails.

Live on PG 16 (port 5455), schema applied by `crossengin apply --confirm` (994 statements) and
`deploy/postgres/roles/app-role.sql`, as `crossengin_app` (`rolsuper = f, rolbypassrls = f`, owns 0
tables):

- **Control**: one transaction inserting tenant A's usage and then an unprovisioned tenant's →
  `23503`, `ROLLBACK`, **0** rows.
- `recordWindow([A, unprovisioned, B])` through the built store → `{inserted: 2, refused:
  [{sqlstate: "23503", detail: "SQLSTATE 23503 on billing_usage_records_tenant_id_fkey"}]}`; A and B
  stored.
- Two writers, one window start, one subscription → 2 rows, distinct keys.
- A row stored as `0.3000` and marked synced: a re-close with `0.1 + 0.2` is accepted (the old JS
  compare would refuse it), with `0.31` is `UsageAlreadyReported`.
- `operate-server replay --tenant <id>` (unchanged binary) → exit **1**, `workflow` and `incidents`
  `NOT READ`. `selectReplaySubsystems` over the binary's five wired runners and that scope selects
  `dr, slo, access_reviews, gateway` with the info line naming both omissions; the binary run with
  exactly that selection → exit **0**, *"every selected subsystem was readable and found no drift"*.
  An explicit `--subsystem workflow` → exit 1.
- Boot with `--slo-config` naming `tenantId: "acme"` → `fatal:` with *"tenantId must be a tenant uuid
  (meta.tenants.id), or null for the platform"* at path `tenantId`, exit 1; the same config with a
  tenant uuid → listening, and `[incident]` reads *"declared by slo-availability at sev2/sev3"*.

### Adversarial review

The review re-read every diff against the brief and the shipped configuration and found:

- **A refused usage record was reported as a flush error.** The default `onRefused` routed
  `UsageRecordsRefused` to `onError`, which `node.ts` prints as `[metering] flush error` — for a
  window that did write. And `refused` was a constructor parameter property, so it was an own
  enumerable property and `console.error(err)` printed the rows (default depth showed `[Object]`;
  any deeper inspect showed tenant ids and quantities, against the class's own doc). Fixed: the
  default is its own `console.error` line carrying only the message, and `refused` is
  non-enumerable; a test inspects the error at depth 10 and finds no tenant id.
- **"A foreign-key refusal is permanent" overstated it** in the ADR and two comments: it stands until
  an operator provisions the tenant. Reworded; the drop is still right, because holding the record
  holds every other tenant's windows behind it meanwhile.
- **The custom-thresholds defect was latent, not live** (no caller passes `thresholds`); the context
  item says so now.
- **A type name was wrong**: the latency options are `LatencySloEngineOptions`.
- **Re-verified live** on the same cluster as `crossengin_app`: `recordWindow([A, unprovisioned, B])`
  inserted 2 and refused 1 with `SQLSTATE 23503 on billing_usage_records_tenant_id_fkey`; the
  identical window re-sent inserted 0 and refused the same record again (a retry is a no-op); and
  with `INSERT` revoked from the role the window threw `42501` rather than reporting it as a record
  refusal. One instrument note: a count of `meta.billing_usage_records` as `crossengin_app` with no
  tenant context answers **0** whatever the table holds (RLS), so emptiness was read as the owner.

## Open questions

1. `node.ts` does not yet call `selectReplaySubsystems`, so the shipped default replay still exits 1.
2. A dropped usage record is reported and not retained; a deployment wanting to bill it after
   provisioning the tenant has nowhere to read it from but the log line.
3. `meta.incidents.postmortem_id` still accepts any text at the database until the CHECK lands.
4. The writer is per process, so a restarted process cuts its first window under a new writer; that
   is correct (the window is new) but means key cardinality grows with restarts.

## References

- `packages/billing-runtime-pg/src/usage-store.ts`, `apps/operate-server/src/metering.ts`
- `apps/operate-server/src/replay.ts`, `apps/operate-server/src/incident-lifecycle-survey.ts`
- `packages/observability-runtime/src/engine.ts`, `packages/incident-response/src/postmortems.ts`

## Addendum: the wiring the slice could not make

The orchestrator made the shared-file edits. `node.ts`' `runReplay` now calls
`selectReplaySubsystems` before choosing what to run. When no `--subsystem` is named it prints the
selection's info line and runs only the wired subsystems the scope can serve, so the shipped default
no longer exits 1 on `workflow`. `cli.ts`' replay help says the default is the wired subsystems the
chosen scope can serve and that an explicit `--subsystem` runs as asked. `META_INCIDENTS.postmortem_id`
carries the postmortem table's own pattern CHECK; on an existing deployment that is standing manual
SQL. This addendum describes the wiring as built and unit-tested; it was not verified live.
