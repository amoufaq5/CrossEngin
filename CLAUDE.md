# CLAUDE.md

Project state for AI assistants resuming work on this codebase. Read top to
bottom once, then keep nearby.

**This file describes the shape of the system, not its history.** History lives
in `docs/adr/index.md` (generated — 327 records). Earlier versions of this file
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

**87 packages + 3 apps, 145 meta-schema tables, ~14,230 tests**, all green, no
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
  The last three increments (ADR-0330, ADR-0331) have been **sweeps rather than features**: taking a
  defect that was found once and asking how many other members its class has. That turned up a
  column-level CHECK nobody compared across 765 of them, a `Date`-vs-string assumption in four stores
  (one of them breaking keyset pagination in production), 29 tables letting a tenant write a
  platform-wide row, a signal store that could never succeed against a real database, and a workflow
  orchestration layer that was unreachable from the deployed binary. The recurring shape is that
  **the honest fix usually sits one level up from where the pain was felt.**

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
  (`META_TABLES`, the catalog of **145** platform Postgres tables, plus deterministic DDL
  emit), `ddl/` (the DDL *vocabulary* — `resolvedFields`, field→Postgres types, built-in
  traits, column naming, default rendering, identifier quoting, structural entity diff;
  it does **not** emit entity tables, `operate-runtime-pg` does — ADR-0284),
  `manifest/` (zod manifest types, validate,
  cross-validate, diff, patch, `manifestHash`, `meta.extends` resolution — entity
  *ordering* lives with the store that creates tables, ADR-0285), and
  `tenancy/` + `workflow/` (tenant resolution, workflow definition validation).
- **`kernel-pg`** — the impure applier. `PgConnection` + `parsePgEnvConfig` + node-postgres
  binding, advisory-lock-gated per-statement migration application with `_meta_migrations`
  hash bookkeeping, preconditions, and the pgcrypto at-rest encryption stack (coverage report,
  encrypt-on-write column migration, encrypting-view triggers, key rotation planner). Ships the
  `crossengin-pg` CLI.
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
  never written and reads `column_check_name_unavailable`. Costs +765 probes (~850 ms, flat in row
  count).
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
- **`types`** — deliberately tiny: branded primitive id types (`TenantId`, `UserId`,
  `RequestId`, `ManifestId`). One file.
- **`config`** — shared TypeScript / ESLint / Prettier config bases. No `src/`.
- **`testing`** — the shared `vitestPreset`. One file.

### Serving a manifest (the Operate stack)

- **`operate-runtime`** — the largest package and the heart of the product: it compiles a
  resolved manifest into a live multi-tenant API. Route/operation derivation and slugs,
  an `EntityStore` interface with typed list filters + keyset pagination + projection,
  RBAC-enforcing CRUD/lifecycle handlers, association (m2m) routes, numbering sequences,
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
- **`api-gateway-pg`** — Postgres implementations of the runtime's four store interfaces
  (idempotency, route registry with TTL cache, sliding-window rate-limit checker,
  pipeline-execution store) plus a replayer that flags out-of-order stages, pass-with-4xx,
  orphaned rate-limit decisions, and summarizes p50/p95 latency.
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
  it may not read.
- **`sso`** — federated identity contracts: SAML 2.0 + OIDC provider configs, SCIM 2.0
  provisioning, claim mappings with transforms and JIT user policies, session lifecycle,
  login audit.
- **`security`** — field/entity data classification resolution, at-rest encryption + key
  management options, CSP builder, backup policy, incident classification, threat model,
  certification standards, and a `SECURITY.md` disclosure-policy emitter.
- **`crypto`** — real cryptography over `node:crypto`: SHA-256/BLAKE2b-512 hashing and hash
  chains, HMAC-SHA256 webhook signing with replay windows, Ed25519 sign/verify/keypair,
  opaque tenant-scoped `KeyHandle`s behind a `KeyStore`, and auto-audit of key management.
- **`crypto-pg`** — a Postgres key registry for those handles (tenant-scoped rows, rotate /
  revoke / list). Thin: registry, records, tenant context.
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
- **`tenant-lifecycle`** — 7-state tenant lifecycle (trial → … → deleted), grace periods,
  GDPR Article 17 deletion requests with legal bases and retention obligations, data
  exports with TTL-bounded download links, cryptographic tombstones with proof hashes.
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
  is unchanged for *both* versions: the proof payload commits to `contentManifestSha256`, which is
  version-bound by its own tag, so the proof inherits the version without its own bytes moving and the
  chain transitively witnesses the declaration. A verifier selects the version from the explicit
  `proofVersion` field and **never** by inferring it from whether a declaration is attached — an
  inference would read a *deleted* declaration as an older record, a tamper that covers its own tracks
  — and the contract pairs the two in both directions, so a relabelling is refused rather than hashed
  best-effort. What this buys is the one distinction v1 could not make: "we have no cache layer" and
  "we have a cache layer and it held nothing" compose **byte-identical** scopes, since
  `nothing_to_erase` may carry no figures at all, so under v1 a deployment could answer the harder
  claim with the cheaper one.
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
  whose rows were still in `meta.operate_entity_records`. Targets are derived from `META_TABLES` minus
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
  that were dead since Phase 1 — `PostgresRunbookExecutionStore`, `PostgresPostmortemStore`,
  `PostgresCustomerCommsStore` (ADR-0296) — each with its own revision guard, since a postmortem edited
  by two people over days was last-writer-wins. `appendPagedNote` (ADR-0327) is the paged timeline
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
- **`deploy`** — apps × 4 environments × 4 strategies, artifact kinds, migration records,
  release channels, on-prem/BYOC packaging (Helm/Terraform).
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
- **`access-reviews`** — periodic attestation campaigns (SOC 2 / ISO 27001 / HIPAA / PCI /
  GDPR / 21 CFR Part 11): campaigns, scoped items, decisions with attestation kinds and
  four-eyes, exceptions with per-reason duration caps, templates, sealed evidence with
  per-framework control mappings.
- **`access-reviews-runtime`** — drives them: due-campaign scheduling and next-occurrence
  planning, item generation from live grants with reviewer resolution, overdue/past-grace
  detection, and auto-revocation planning for unattested items.
- **`access-reviews-runtime-pg`** — persists campaigns/items/decisions, wraps the runtime,
  and ships a replayer.
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
  in this binary**. The job worker is still refused — nothing here registers a job handler, and
  passing an engine would finalize every claimed run `failed` with `handler_not_found` where leaving
  them `pending` is recoverable.
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
  **The fax run counter is opt-in** (`--bounce-fax-observations`, `--bounce-fax-suppress-after`,
  `--bounce-fax-window-hours`, ADR-0332): a threshold below `MIN_FAX_SUPPRESSION_THRESHOLD` is
  **refused rather than clamped**, because a threshold of 1 is the inference ADR-0302 forbids and
  silently raising it would make the deployment believe something it did not ask for. It warns at boot
  when `TWILIO_VOICE_MACHINE_DETECTION` is unset, since `AnsweredBy` arrives only then.
  `--workflow-cancel-role` now refuses only under `--store memory` (ADR-0331), and the decimal wire
  type is applied by `compileOperateServer` itself (ADR-0332) rather than by a flag — the decorator
  needs both the store and the manifest, and that is the one place holding both, so no app wiring was
  needed and the write effects are covered by the same seam as a client request.
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

`packages/kernel/src/bootstrap/meta-schema.ts` is the central catalog of **145**
platform-level Postgres tables. Each new package adds tables there and updates
`meta-schema.test.ts` (count, sorted expected-names list, column assertions).

**A fresh database holds one more table than the catalog does**, and it is not a stale count:
`information_schema` reports 146 `meta` base tables against `META_TABLES`' 145, because
`_meta_migrations` is created by `kernel-pg`'s applier for its own per-statement hash bookkeeping and
is deliberately not emitted from the catalog. Verified. Count the catalog, not the database.

Three invariants the test suite enforces:

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

Full workspace build + typecheck + test is several minutes; run it backgrounded
into a log rather than blocking on it. There is **no top-level lint script** —
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

## What's actually left

Nothing planned is unbuilt; what remains are follow-ups named in the ADRs that
opened them.

**Load-bearing**

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
  tables. What remains: **14 of the 29 have no store**, so their write arms are capability
  with no caller; the grants are `PUBLIC`-scoped settings, so any session able to call `set_config` can
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
  **Reads are still owner-dependent** in the stores that set no scope, which is ADR-0331's
  `scopeFilter` lesson un-swept outside the chain.
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
  now has the `flag_id TEXT` unique column ADR-0296 said was needed, and a store that writes it. The
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
  proof over data that was still there. **And a declared absence is inside the signed bytes**, as
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
  structured `retainedData: [{table, obligation}]`, i.e. a **v4** tag, and it is vacuous today because
  both statutory entries share one obligation. ADR-0330's expectation that a second obligation on the
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
  asked rather than imitated. What it leaves: **+765 probes on every `apply` and drift check**
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
title or status change cannot drift. 327 records; 248 Accepted, 79 Proposed (the
Proposed ones are largely Phase-1 design ADRs that were never re-statused, and
include `0000-template.md`, which the count has always included).

ADRs **0080–0085** were reserved by ADR-0077 for Phase 3 P3–P8 and never
written; those milestones landed under other numbers. The gap is permanent.

When you ship something, write its ADR in the same session, following
`0000-template.md`: what was broken, the decision and the rule behind it, what
was verified live, and the follow-ups you are explicitly leaving open.
