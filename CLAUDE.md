# CLAUDE.md

Project state for AI assistants resuming work on this codebase. Read top to
bottom once, then keep nearby.

**This file describes the shape of the system, not its history.** History lives
in `docs/adr/index.md` (generated — 276 records). Earlier versions of this file
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

**82 packages + 3 apps, 139 meta-schema tables, ~9,280 tests**, all green, no
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
  Note: a table's **owner bypasses RLS** — verified empirically — so
  cross-tenant reads are granted explicitly (e.g. `app.platform_review`), never
  assumed from role.
- **Strict TypeScript.** No `any`. No `--no-verify`. Explicit return types on
  exported functions.

## Package map

82 packages under `packages/`, 3 apps under `apps/`. Almost every package is
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
  (`META_TABLES`, the catalog of **139** platform Postgres tables, plus deterministic DDL
  emit), `ddl/` (manifest entity → column/table DDL, field types, built-in traits,
  identifier quoting, schema diff), `manifest/` (zod manifest types, validate,
  cross-validate, diff, patch, topology, `manifestHash`, `meta.extends` resolution), and
  `tenancy/` + `workflow/` (tenant resolution, workflow definition validation).
- **`kernel-pg`** — the impure applier. `PgConnection` + `parsePgEnvConfig` + node-postgres
  binding, advisory-lock-gated per-statement migration application with `_meta_migrations`
  hash bookkeeping, preconditions, `pg_catalog` introspection + `diffSchema` drift, and the
  pgcrypto at-rest encryption stack (coverage report, encrypt-on-write column migration,
  encrypting-view triggers, key rotation planner). Ships the `crossengin-pg` CLI.
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
  filter/sort/keyset/projection pushdown). Plus sequence allocator, settings, entitlement,
  subscription stores, Stripe webhook ingest and dangling-link pruning.

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
  Small by design — the logic lives in `workflow-runtime-pg`.
- **`workflow-signal-bridge`** — verifies an inbound webhook's HMAC, extracts a correlation
  key by field path, and submits a signal to the workflow runtime; ships as a registered
  gateway handler with typed bridge outcomes → HTTP statuses.
- **`jobs`** — contracts for background work: 6 job kinds, cron expressions, idempotency
  keys, retry strategies, dead letters, per-run cost ledger, data-class tagging.

### Identity, security, data protection

- **`auth`** — RBAC + ABAC. Role definitions with inheritance, grants, per-entity and
  per-field permissions, write masks, and the classification-aware redaction
  (`computeClassifiedFieldRedaction`) that fails closed on pii/phi/regulated fields.
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
- **`ai-architect-runtime`** — small: a per-session cost tracker and an
  `ArchitectGuardRuntime` that admits or refuses a design request against budget and policy.
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
- **`observability-runtime-pg`** — persists evaluations and enforcement actions for both the
  availability and latency engines (one action table with a `signal` column), plus a
  replayer that flags ongoing-without-open, duplicate-open and paged-without-channels.
- **`incident-response`** — 5 SEV levels with SLA profiles, 7 incident roles, an 8-state
  incident lifecycle, runbook executions with per-step outcomes, blameless postmortems with
  prioritized action items, and customer comms carrying the GDPR 72h breach deadline.
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
  and dispatch/delivery audit with retry, throttle, digest and quiet-hours decisions.
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
  largest app (63 modules). A Node `http` listener over `buildOperateGateway` plus a
  framework-neutral `dispatch` core with a Fetch/Workers edge adapter. Loads a builtin pack
  or a manifest file (optionally per-tenant manifests with an activation poller), serves
  from the in-memory / JSONB / column-mapped store, and wires in: API-key and JWT auth with
  local or remote JWKS and a background refresh poller; the hash-chained audit log with
  checkpointing and chain verification; notification delivery (planning, throttling,
  digests, senders, drain loop); the in-production AI Architect (`--ai-design`) with a
  budget guard, design jobs, and a design-review approval gate; access-review campaign
  lifecycle; certification reports; DR readiness; SLO evaluation; usage metering and Stripe
  usage sync; marketplace admin/authoring; platform-tenant administration; residency
  routing; and background schedulers for jobs, pruning and checkpoints.
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

`packages/kernel/src/bootstrap/meta-schema.ts` is the central catalog of **139**
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
```

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

- **Audit entries are neither chained nor signed** (ADR-0279), while the
  `forensics` package ships a hash-chained signed log and the audit-chain config
  writes one per request. Two audit paths that don't know about each other;
  reconciling them is the most consequential open item.
- **No real email/SMS senders** (ADR-0274). The `ChannelSender` seam, retry
  ladder and suppression handling all work; only `in_app` has an implementation.
- **No provider webhooks feeding bounces into suppressions** (ADR-0274) — the
  suppression table exists for exactly this and nothing populates it.
- **`ai-providers-local` is unused by `operate-server`.** A purpose-built provider
  for Ollama/vLLM endpoints exists, with zero-cost pricing already built in, but
  only `architect-cli` depends on it. The in-product Architect
  (`buildDesignProviderFromEnv`) knows Anthropic and OpenAI only, so the
  self-hosted path runs through `ai-providers-openai` pointed at a custom base
  URL (ADR-0280). That works and the custom-base-URL fix was needed anyway for
  proxies, but routing the in-product designer through the local provider is the
  cleaner arrangement and is still open.

**Contained**

- No per-user notification *read state*; "unread" is a recency approximation
  (ADR-0273, 0278). Quiet hours is per-tenant only — no per-user window or
  timezone (ADR-0275). `dedup_sha256` and `dispatched_at` unused (ADR-0276,
  0277). No route authors a template or reads the audit trail over HTTP
  (ADR-0277, 0279). Job cancellation is client-side only (ADR-0269). Per-request
  AI cost ceilings (ADR-0267). Request bodies cap at 10 MiB → 413, a
  platform-wide gap since P1.7 (ADR-0267). A weak model that drifts out of JSON
  fails indistinguishably from any other design failure (ADR-0280).
- `packages/workflow-runtime/src/engine.ts` still throws on one unimplemented
  action kind — the only genuine stub in the TypeScript.

**Cosmetic** — per-field grant display, data-volume estimates on destructive
diffs, dark theme, per-tenant branding (ADR-0265, 0266, 0271, 0272).

`web-ui/` (a separate static app) has **no deployment story** and is not in any
compose file or guide.

## ADRs

`docs/adr/index.md` is generated from the ADR files — regenerate it rather than
hand-editing, so a title or status change cannot drift. 276 records; 197
Accepted, 79 Proposed (the Proposed ones are largely Phase-1 design ADRs that
were never re-statused).

ADRs **0080–0085** were reserved by ADR-0077 for Phase 3 P3–P8 and never
written; those milestones landed under other numbers. The gap is permanent.

When you ship something, write its ADR in the same session, following
`0000-template.md`: what was broken, the decision and the rule behind it, what
was verified live, and the follow-ups you are explicitly leaving open.
