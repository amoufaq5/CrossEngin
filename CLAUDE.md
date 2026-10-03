# CLAUDE.md

Project state for AI assistants resuming work on this codebase. Read top to
bottom once, then keep nearby.

**This file describes the shape of the system, not its history.** History lives
in `docs/adr/index.md` (generated — 320 records). Earlier versions of this file
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

**87 packages + 3 apps, 143 meta-schema tables, ~12,018 tests**, all green, no
type errors.

- **Phase 1** (contracts) and **Phase 2** (M1–M8, runtime pillars) are complete.
- **Phase 3** (ADR-0077, P1–P8: serving app → distributed workers → web renderer
  → more packs → marketplace → multi-region → AI in prod → hardening) is
  complete. P6 (multi-region) is deliberately thin — ADR-0077 Q6 gates it on
  demand.
- **Phase 4** (commercialisation) is in progress and has **no plan ADR**. It has
  proceeded one shipped increment at a time since ADR-0236 — billing, third-party
  marketplace, SOC 2 / HIPAA certification, the forensics chain, deployment, the
  platform console, AI onboarding, and the notification stack.

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
  (`META_TABLES`, the catalog of **143** platform Postgres tables, plus deterministic DDL
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
  25-kind append-only event history.
- **`workflow-runtime`** — the in-process event-sourced executor. Append-only event log,
  deterministic left-fold projection, automatic transitions + on-entry actions until
  quiescent, registered activity handlers, signal correlation with exactly-once dedup,
  timer firing, saga compensation planning.
- **`workflow-runtime-pg`** — persistence *and* distributed execution. `PostgresEventLog` +
  four projection stores + `ProjectingEventLog` (every append re-projects and upserts) +
  `buildPersistentEngine`, a replayer for drift repair, and the claim/lease layer that makes
  multiple workers safe: `claimDueTimers`/`Activities`/`Jobs` with renew + release, plus a
  `PostgresJobRunEngine` with a job handler registry and enqueue path.
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
  one audit entry (ADR-0286).
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
  bucket.
- **`ai-architect-runtime-pg`** — thin: a Postgres per-tenant monthly AI cost store backing
  that guard.

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
  a list has one provenance, and only an `erased` outcome may carry figures — a `nothing_to_erase` that
  could would smuggle numbers into the proof. `retainedReason`/`retainedDataReference` are *derived* from
  a `retained` attestation rather than remembered. Every refusal lands before a hash is computed, and the
  assembler re-verifies its own output. `tombstoneMatchesAttestations` answers the question a hash cannot:
  whether a stored record still agrees with its evidence — a tampered scope flips `contentManifestOk`
  while `proofOk` stays true, since the proof commits to the stored digest.
- **`tenant-lifecycle-pg`** — the tombstone's store (ADR-0318), and the first writer
  `meta.tenant_tombstones` ever had: declared in Phase 1, it had drifted behind its contract in the way
  ADR-0300 found for `meta.feature_flags`, and in the table where it mattered most. `executed_by` and
  `approved_by` referenced `meta.users`, which a tenant deletion *erases* — so the tombstone would have
  named rows it had just destroyed, and `ON DELETE RESTRICT` would have made those users undeletable
  because a tombstone named them; a `scheduled_purge` has no human executor at all. They are TEXT and
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
  prioritized action items, and customer comms carrying the GDPR 72h breach deadline. Also owns
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
  offline implementation, which finds nothing because nothing it declared survived.
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
  by two people over days was last-writer-wins.
- **`dr`** — 5 DR tiers with RPO/RTO targets, replication topology, backup kinds, failover
  records, drills with finding severities, runbooks.
- **`dr-runtime`** — executes it: a `FailoverExecutor` state machine (plan → start →
  complete / fail / abort / revert), a `DrillExecutor`, and `assessDrReadiness` which scores
  replication lag, drill recency and runbook staleness into a breach report.
- **`dr-runtime-pg`** — persists failovers, drills and readiness reports; wraps the runtime
  and ships a replayer.
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
  commit together (ADR-0286).
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
  for VPC endpoints and proxies. **A push payload may not vary with the notification's content**
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
  16 bytes), and `PageDispatcher` over them. **A page is not a notification and must not travel as one:**
  the notification stack exists to *withhold* delivery — preferences, suppressions, quiet hours — and a
  `sev1` is the one thing none of those may apply to, so `email_digest`/`sms` are reported `unroutable`
  rather than adapted. `PageContent` is three fields (incident id, severity, a deployment-declared
  `signal`) and nothing from the finding, which names a tenant and a tombstone — ADR-0310's rule on
  another surface. Five dispositions, every channel attempted even if one throws, and
  `delivered === 0` is `undelivered`: logged at error, never thrown, because the incident is already
  durable and a throw would make a successful declaration look like a failed escalation.
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
  rather than lost (ADR-0324);
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
  has triaged it; ADR-0287, ADR-0288, ADR-0289). The escalator declares through the same
  `IncidentDeclarer` the SLO loop uses (ADR-0297), with `CountingIncidentDeclarer` as both the offline
  default and the fallback that keeps the page going out when the record cannot be stored.
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

`packages/kernel/src/bootstrap/meta-schema.ts` is the central catalog of **143**
platform-level Postgres tables. Each new package adds tables there and updates
`meta-schema.test.ts` (count, sorted expected-names list, column assertions).

Two invariants the test suite enforces:

1. Every `tenant_id`-bearing table has RLS enabled.
2. Foreign-key references resolve to a table declared **earlier** in
   `META_TABLES`. If a new FK points at a table declared later, move the target
   earlier rather than dropping the FK.

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
- **Removing a foreign key from the catalog requires an explicit flag** (ADR-0296, ADR-0308).
  `ReconciliationOptions.allowLoosening` turns the undeclared-foreign-key refusal into a real drop, which
  is what the four kill-switch `meta.users` references of ADR-0296 needed. It is off by default and
  reaches **foreign keys only** — not a column, table, index, policy or CHECK — because dropping a
  foreign key is the one loosening that cannot fail against existing rows, which is what keeps
  ADR-0290's invariant true. Nothing passes it yet; `crossengin-pg apply` would need a flag.
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
- **`planIntegrityEscalation` is now unused** (ADR-0297) — still exported and tested, nothing calls it.
  Deleting public API is a separate decision.
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
  than confidentiality. The two new senders are **not yet constructed from the environment** — FCM needs
  an `FcmAccessTokenProvider`, which env vars cannot express. One platform-wide credential set per
  provider, so every tenant still sends from one domain and calls from one number.
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

- **The push senders are built and unwired** (ADR-0310). `FcmPushSender` and `TwilioVoiceSender` exist and
  are tested; `buildSenderRegistryFromEnv` does not construct them, because FCM takes an
  `FcmAccessTokenProvider` (RS256-signing a JWT, a second endpoint, a refresh cache — or the instance
  metadata server on GKE) and ADR-0301's rule is that a partially-configured provider is skipped rather
  than guessed. Voice status callbacks are unused.
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
  delete. What remains: `requiredSubsystems` is still caller-supplied, so omitting one yields a tombstone
  that visibly covers less rather than one that silently claims everything — better, not done; and four
  of the six subsystems cannot attest because their erasures do not exist, so every deletion today
  declares object storage, backups, search and caches out of scope by omission — now on a schedule as
  well, since the runner supplies no attestations but the schema's. The ordering against `meta.tenants` is
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
  recovery. What is left there: every finding is graded `sev1` with no per-defect gradation, the
  escalation leaves no anchored `meta.audit_log` row of its own the way `IntegrityEscalator`'s does, and
  nothing *schedules* `auditCompleted`, so the reverse direction escalates only when a human loads
  `GET .../unproven`.
- **A page now really leaves the process, and what remains is the record of it** (ADR-0325).
  `PageDispatcher` delivers over PagerDuty, Slack and a signed webhook, and **reports** rather than
  throws: `delivered === 0` is `undelivered`, logged at error, because the incident is already durable.
  What is left: a page is **not recorded durably** — no `meta.audit_log` row and no incident-timeline
  note, so "we paged at 03:14 and PagerDuty accepted it" lives only in a log line, which is exactly the
  claim an incident review needs; **nothing retries** a failed page, which is survivable for the two
  escalators that re-derive their finding every tick and not for the one-shot integrity escalator;
  `email_digest`/`sms` are `unroutable` by the deliberate decision that a page must not travel as a
  notification, so the senders that could serve them stay unused; the **SLO loop still logs** its page
  rather than dispatching it, so two of three planners deliver and one does not; and a PagerDuty alert
  is only ever *triggered* — `event_action: "resolve"` on the same `dedup_key` would close it when an
  escalator cancels its incident, and nothing sends it.
  There is also no tooling to *resolve* an unverified tombstone (the attestations beside it are enough to
  recompute what the scope should have been, but rewriting a proof is not something to automate blindly),
  and a tombstone with no `relatedDeletionRequestId` — every one the synchronous route of ADR-0320 writes —
  is outside both directions of the audit. A request is also submitted for a *tenant*, not for a subject
  within one: `subjectIdentifier` is recorded and not acted on, so a single data subject inside a
  multi-user tenant cannot be erased by this path at all.
- **The AI cost estimator is a heuristic on the input side** (ADR-0311). `maxTokens` bounds the output by
  construction; the input is `ESTIMATED_CHARS_PER_TOKEN = 3.5`, deliberately pessimistic because the
  number feeds a ceiling. `reconcileRequestCost` corrects it from the worst observed ratio, but only
  **per session** — a restart forgets that the estimator was optimistic. `classifyDesignOutput` diagnoses
  a recoverable wrapper and nothing retries selectively on it yet.
- **A feature flag that writes audit rows must be in `needsAuditEmitter`** (ADR-0288, ADR-0313, ADR-0321).
  The emitter is built behind a list of flags, and the list was forgotten twice — the second time
  silently skipping `--audit-read-routes` entirely, found by booting the real server rather than by a
  test. It is a named predicate with a test per flag now and the list is up to **nine**, which has caught
  every flag added since; but nothing *derives* it, so the next feature can still omit itself. The same
  class bit again in ADR-0322: the emitter does **not** require the chain, so `--deletion-request-routes`
  without `--audit-chain-config` mounted the routes, wrote *unanchored* audit rows and had no evidence to
  reconcile from — a 501 nobody was warned about. It warns at boot now, but the pattern is the lesson:
  a surface that degrades rather than refusing has to say so out loud.
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

- `dispatched_at` is still unused (ADR-0277). No route writes a read state or reads the *template*
  audit trail over HTTP (ADR-0279). A platform-scoped audit read is recorded against the reader's own
  tenant, because `meta.audit_log.tenant_id` is NOT NULL, so a reader with no resolvable tenant cannot
  read at all (ADR-0313). `--audit-read-sensitive-role` grants unredacted payloads wholesale — per-class
  grants (pii but not phi) are not expressible. A job handler that ignores its `AbortSignal` runs to
  completion and commits its effects while the run records `cancelled`; the guarantee is deliberately
  phrased as "no further work will be *started*" (ADR-0315). Nothing cancels a *workflow* instance's
  timers or activities — cancellation is jobs only. `ESTIMATED_CHARS_PER_TOKEN` under-counts for CJK,
  which is the unsafe direction for a ceiling (ADR-0311). A per-route or per-tenant request-body limit
  is unaddressed; the cap is platform-wide (ADR-0312). A refused DDL application is invisible to the
  tenant — they are served from the JSONB fallback rather than the tables they asked for (ADR-0314). A
  refused erasure leaves an operator to drop the collateral by hand; the refusal names it but does not
  hand over the SQL the way ADR-0290's `unreconciled` does (ADR-0316).
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
title or status change cannot drift. 320 records; 241 Accepted, 79 Proposed (the
Proposed ones are largely Phase-1 design ADRs that were never re-statused, and
include `0000-template.md`, which the count has always included).

ADRs **0080–0085** were reserved by ADR-0077 for Phase 3 P3–P8 and never
written; those milestones landed under other numbers. The gap is permanent.

When you ship something, write its ADR in the same session, following
`0000-template.md`: what was broken, the decision and the rule behind it, what
was verified live, and the follow-ups you are explicitly leaving open.
