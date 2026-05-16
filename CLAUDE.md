# CLAUDE.md

Project state snapshot for AI assistants resuming work on this
codebase. Concise on purpose. Read top to bottom once, then keep
nearby.

## What this is

CrossEngin: AI-native multi-tenant platform. Three layers — a
kernel (multi-tenancy + meta-schema + DDL emit), declarative
manifests, and an AI Architect agent that authors them. ERP and
healthcare verticals ride on top.

## Where we are

Phase 2 M1 + M2 + M2.5 + M3 landed: **43 packages, 115 meta-
schema tables, 5,102 tests**, all green, no type errors. M1 added
`@crossengin/kernel-pg` (Postgres-backed migration applier). M2
added `@crossengin/crypto` (real SHA-256 / BLAKE2b-512 /
HMAC-SHA256 / Ed25519). M2.5 wired crypto into marketplace +
sdk + forensics + tenant-lifecycle. M3 added `@crossengin/
workflow-runtime` — in-process event-sourced executor consuming
`@crossengin/workflow-engine` contracts; turns workflow
definitions into actually-running instances with append-only
event log, deterministic replay-style projection, registered
activity handlers, signal correlation, timer firing, automatic
transitions, on-entry actions (set_variable / schedule_activity /
schedule_timer), and saga compensation planning.

ADRs 0001-0049 are fully drafted in `docs/adr/` — no reserved
gaps. ADR-0046 is the Phase 2 implementation plan (M1 DDL → M2
crypto → M3 workflow runtime → M4 gateway runtime → M5 architect-
cli → M6 notifications + workflow bridge → M7 first vertical pack
→ M8 SLO enforcement); ADR-0047 covers M1, ADR-0048 covers M2,
ADR-0049 covers M3.

## Architecture in 90 seconds

- **`zod` schemas are the source of truth.** Types derive via
  `z.infer`. Every package exports `XSchema` + `type X` pairs.
- **Pure contracts + deterministic helpers only.** A package
  defines record shapes, state machines, and pure functions
  (validators, predicates, comparators). It does not open
  sockets, hit databases, or shell out.
- **Kernel meta-schema is the integration point.** Every package
  that needs persisted records wires `META_*` table definitions
  into `packages/kernel/src/bootstrap/meta-schema.ts`. The kernel
  emits DDL deterministically from those.
- **Tenant isolation by RLS.** Tenant-scoped tables enable PG
  row-level security with `tenant_id = current_setting(
  'app.current_tenant_id', true)::UUID`. Platform-wide tables
  skip RLS. Both are tested by the meta-schema test suite.
- **Strict TypeScript.** No `any`. No `--no-verify`. Use explicit
  return types for exported functions when inference is murky.

## Package map

Grouped by concern. Each is `packages/<name>` with `src/index.ts`
re-exporting everything.

### Substrate (the kernel itself)
- **`kernel`** — meta-schema (113 tables), DDL emit, manifest
  validate/diff/patch/topology/hash, bootstrap SQL generator.
- **`kernel-pg`** — Postgres-backed migration applier (first
  impure package). 7 modules: connection (PgConnection interface
  + `parsePgEnvConfig` + node-postgres binding), statement-hash
  (sha256 of normalized SQL), migration-log (`_meta_migrations`
  bookkeeping), preconditions (`pg_uuidv7` extension + PG ≥ 14 +
  CREATE privilege checks), applier (advisory-lock-gated, per-
  statement transactions, halt-on-first-failure, hash-based
  skip), introspection (pg_catalog queries + pure parsers), diff
  (pure `diffSchema` vs `META_TABLES`). Ships `crossengin-pg`
  CLI with `apply`, `apply --dry-run`, `drift`, `inspect`,
  `version` commands.
- **`workflow-runtime`** — in-process event-sourced workflow
  executor (third impure package). 7 modules: clock (Clock +
  IdGenerator interfaces, SystemClock + FixedClock,
  RandomIdGenerator + CountingIdGenerator), event-log (append-
  only `EventLog` interface + InMemoryEventLog with monotonic-
  per-instance sequence enforcement), projection (pure
  `projectInstance` / `projectActivities` / `projectSignals` /
  `projectTimers` — definition-aware projection refines status
  to waiting_for_signal/timer/manual based on outgoing transition
  triggers), transitions (pure trigger matching + guard
  evaluation, defaultGuardEvaluator covers always_true /
  variable_equals / variable_predicate with 8 operators /
  role_required), activity-handlers (`ActivityRegistry` with
  specific + per-kind fallback resolution, built-in handlers for
  audit_emit + transformation), engine (`WorkflowEngine.start
  Instance` / `submitSignal` / `tickTimers` / `cancelInstance` /
  `getInstanceState` / `listEvents`; step loop runs automatic
  transitions + on-entry actions until quiescent; signals
  matched by tenant + correlationKey with exactly_once
  idempotency dedup), saga (pure `planCompensation` /
  `listCompensatableActivities` / `hasOutstandingCompensation`
  handling immediate_reverse_order / parallel / manual_review /
  no_compensation strategies).
- **`crypto`** — real cryptography over `node:crypto`. 7 modules:
  algorithms (`HashAlgorithm`/`MacAlgorithm`/`SignatureAlgorithm`
  + `KeyPurpose` allow-list), hashing (SHA-256, BLAKE2b-512, hash
  chain step, content addressing, constant-time compare), hmac
  (HMAC-SHA256 + webhook signing in `t=...,v1=...` format with
  replay-window verify), signing (Ed25519 sign/verify/keypair via
  Node JWK, public key fingerprint), key-handles (opaque
  `KeyHandle` with tenant-scoped `KeyId` and `assertHandleTenant`
  guard), key-store (`KeyStore` interface + `InMemoryKeyStore`
  with rotate + revoke + per-tenant isolation), audit (auto-audit
  for management ops, schema-validated `CryptoAuditRecord`).
- **`types`** — primitive zod types shared across the workspace
  (UUIDs, ISO 8601, slugs, etc.).
- **`config`** — shared TypeScript + lint config base.
- **`testing`** — `vitestPreset` re-export used by every package.

### Identity, security, data
- **`auth`** — RBAC + ABAC + field-level permissions + write
  masks. RoleDefinition, RbacGrant, principals.
- **`sso`** — federated identity: SAML 2.0 + OIDC providers,
  SCIM 2.0 provisioning, claim mappings + JIT policies, session
  lifecycle, login audit.
- **`security`** — data classification, encryption keys, CSP,
  backup policy, incident classification, threat model,
  certifications.
- **`compliance`** — compliance pack architecture (21 CFR 11,
  HIPAA, GDPR, UAE-MoH). Packs contribute clauses to manifests.
- **`residency`** — 8 regions (eu-central/west, us-east/west,
  me-uae, gcc-ksa, apac-sg, ap-south), broad regions,
  residency profiles, routing.
- **`files`** — file lifecycle (upload → scan → available →
  archived), storage tier transitions, OCR, quota, audit.

### AI surface
- **`ai-providers`** — provider router, pricing tables, fallback
  policy, latency budgets.
- **`ai-architect`** — AI Architect session contract, safety
  policy (refusals, gates, refusal copy, tenant settings, cost
  ceilings, eval gate, incidents, redteam).

### Runtime + operations
- **`jobs`** — Inngest-style job kinds, idempotency keys, dead
  letters, cost ledger.
- **`observability`** — SLO definitions, error budget compute,
  redaction, synthetics, OTel-style tracing.
- **`integrations`** — integration call audit, idempotency at the
  integration boundary, HMAC signatures, retry policy.
- **`rate-limiting`** — unified rate-limit + quota contracts. 6
  algorithms (token_bucket, leaky_bucket, fixed/sliding window,
  sliding_log, concurrent_request) × 10 scope kinds × policies
  with 5 overage handling kinds; 10 quota targets × 7 periods × 6
  classes; RFC 9457 problem details + IETF rate-limit headers on
  every denial; 6 exception kinds with per-kind duration caps +
  four-eyes; throttle event audit.
- **`api-gateway`** — per-request edge pipeline composing auth +
  sso + rate-limiting + sdk. 17-stage pipeline (receive → ... →
  emit_audit) with state-machine ordering. 8 auth schemes × 15
  outcomes with clock-skew + audience + issuer + hmac-replay
  validation. Route matching with version negotiation + sunset.
  RFC-9457 problem details with 14 problem types. Idempotency
  with replay detection. Content + encoding + language negotiation.
  CORS + default security headers.
- **`feature-flags`** — 7 flag kinds (boolean, string, number,
  json, multivariate, percentage_rollout, kill_switch). 10
  targeting rule kinds with FNV-1a sticky percentage bucketing.
  9-stage rollout state machine (1pct → 5pct → ... → 100pct or
  rolled_back). 8-trigger kill switches with full separation of
  duties (armer ≠ trigger ≠ co-trigger). 17 evaluation reasons.
  23-kind append-only change audit with four-eyes gate.
- **`workflow-engine`** — runtime contracts for the manifest-level
  workflows declared in kernel: definitions (canonical executable
  form), instances (12 statuses), activities (10 kinds, retry
  policies, saga compensation), signals (3 delivery guarantees),
  timers (4 kinds), compensation plans, append-only event history.

### Reporting / search / UI
- **`reporting`** — reports, dashboards, schedules, ClickHouse
  audit, CDC.
- **`search`** — Typesense-style manifest, query, permission tags,
  embeddings, reindex.
- **`views`** — frontend renderer types (columns, views, theme,
  i18n, permissions, widgets).
- **`i18n`** — locales, ICU MessageFormat, CLDR plurals, bundle,
  resolution, calendar, tenant config.
- **`notifications`** — 6 channels × 18 providers, 5 content
  categories, template + audience + preference/suppression
  contracts, dispatch + delivery audit with retry/throttle/digest
  + quiet-hours decisions.

### Business operations
- **`billing`** — plans, subscriptions, metered usage, invoices,
  payments, dunning, tax, events.
- **`finops`** — 17 cost categories × 5 allocation methods,
  per-tenant attribution, budgets + breach actions, unit
  economics (LTV/CAC/contribution margin), chargeback
  statements, cost reports.
- **`tenant-lifecycle`** — 7-state lifecycle (trial → … →
  deleted), grace periods, GDPR Article 17 deletion requests,
  data exports, cryptographic tombstones.

### Delivery + operations infrastructure
- **`deploy`** — apps × environments × strategies; migrations;
  feature flags; releases; artifacts; on-prem/BYOC packaging.
- **`dr`** — 5 DR tiers (mission-critical → best-effort), RPO/
  RTO targets, replication topology, backups, failover
  records, drills, runbooks.
- **`edge`** — region routing, latency budgets per route,
  autoscaling policies, edge cache, throttling, region
  affinity.
- **`active-active`** — multi-region active-active topology, 7
  consistency levels, vector clocks, 6 CRDT kinds (G/PN counters,
  OR-set, LWW register/map, MV register), conflict detection +
  resolution, split-brain lifecycle.
- **`pwa`** — PWA manifest, service worker, IndexedDB outbox,
  sync, push notifications (PHI-safe stubs), Capacitor wrapper.

### Developer / partner surface
- **`sdk`** — public API contract (versioning, scopes, operations,
  RFC 9457 problem details, cursor pagination, idempotency,
  webhooks with HMAC-SHA256).
- **`sdk-clients`** — language-specific client generation
  contract (10 target languages × 10 registries × 3 tiers,
  generator pipeline, semver release lifecycle, compatibility
  matrix, auth + retry helpers, client telemetry with W3C
  trace context).
- **`marketplace`** — installable extension packs, pack registry
  with ed25519 signing + security review, per-tenant install
  lifecycle, permission grants, marketplace listings + reviews.
- **`migration`** — 12 source kinds (CSV, JSONL, Salesforce,
  ServiceNow, SQL dumps, FHIR, etc.), schema inference, field
  mapping, preview/dry-run, idempotent backfill ledger,
  onboarding flow (workspace_setup → … → go_live).
- **`ml-training`** — opt-in consent (phi/regulated permanently
  forbidden), training datasets, eval sets (safety_refusal
  requires 100% pass), training runs, evaluations, model
  registry with shadow/canary/production lifecycle.

### Audit + compliance operations
- **`incident-response`** — 5 SEV levels with SLA profiles, 7
  incident roles, 8-state incident lifecycle, runbook
  executions, blameless postmortems with action items,
  customer comms with GDPR 72h breach notification deadline.
- **`forensics`** — hash-chained tamper-evident logs, evidence
  with sealed/retention/destruction lifecycle, chain-of-custody
  with sha256-verified transfers, legal holds with separation of
  duties, e-discovery requests, court-admissible attestations.
- **`access-reviews`** — periodic attestation campaigns (SOC 2 /
  ISO 27001 / HIPAA / PCI / GDPR / 21 CFR Part 11). Campaigns,
  items, decisions with attestation + four-eyes, exceptions with
  per-reason duration caps, templates, sealed evidence with
  per-framework control mappings.
- **`data-lineage`** — provenance graph for GDPR Article 15 right
  of access (+ CCPA / LGPD / PIPEDA / UAE peers). 14 node kinds ×
  10 edge kinds with classification propagation rules
  (pii → public via anonymized_from with k≥5, phi → internal via
  aggregated_from with k≥11). Provenance records, data subject
  registry (sha256-only identifiers), subject access requests,
  graph traversal (ancestors/descendants/path/cycle/subject impact),
  retention policies + Article 15 evidence packs.

## Cross-cutting invariants

Recurring patterns enforced by zod `superRefine`:

- **Four-eyes principle.** Anywhere an action is privileged
  (deletion, hold release, postmortem review, four-eyes
  approvals), the actor must not also be the approver. Check
  for `executedBy !== approvedBy`, `author ∉ reviewers`,
  `releasedBy !== issuedBy`.
- **State machines.** Most lifecycle types export a `*_STATUSES`
  enum, a `*_TRANSITIONS` map, and a `canTransition*` helper.
  The schema enforces status↔required-fields pairing.
- **Cryptographic anchoring.** Sha256 hashes for content
  addressing show up everywhere: dataset freezing, deletion
  proofs, evidence sealing, postmortem storage, webhook signing,
  pack signing (ed25519 there).
- **Tenant scoping.** Records with `tenant_id` get RLS. Cross-
  tenant audit/compliance records are platform-wide (cdc
  checkpoints, regions, plans, deployments, ediscovery,
  tombstones).
- **Forbidden lists.** PHI/regulated data can never be used for
  ML training (`FORBIDDEN_TRAINING_DATA_CLASSES`). Latest docker
  tag is forbidden (deploy). Two-person integrity for human
  evidence collection.
- **Deadlines.** Where regulation imposes timing (GDPR 72h
  breach, Article 12(3) 3-month deletion deadline), schemas
  enforce it.

## Meta-schema

`packages/kernel/src/bootstrap/meta-schema.ts` is the central
catalog of 115 platform-level Postgres tables. Each new package
adds tables there + updates `meta-schema.test.ts` (table count,
expected names list sorted alphabetically, column-check
assertions).

The test suite enforces two invariants:
1. Every `tenant_id`-bearing table has RLS enabled.
2. Foreign-key references resolve to a table declared earlier
   in `META_TABLES`.

When adding tables, **append them to the array at the bottom in
the order the package was built**, not alphabetically. The
expected-names test sorts independently.

## Build + test commands

```bash
# Install
pnpm install

# Per-package
pnpm --filter @crossengin/<name> build
pnpm --filter @crossengin/<name> test
pnpm --filter @crossengin/<name> typecheck

# Workspace
pnpm -r build
pnpm -r test
pnpm -r typecheck

# Build is fast; full workspace test ≈ 30s
```

There is **no top-level lint script**. ESLint config has not
been migrated to v9 flat config yet; ignore lint until asked.

## Conventions

- **Module structure.** Each package: `package.json`,
  `tsconfig.json` (extends `@crossengin/config/typescript/base`),
  `vitest.config.ts` (re-exports `vitestPreset`), `src/index.ts`
  (re-exports all source modules), 4–7 `src/*.ts` source modules,
  matching `src/*.test.ts` files.
- **Naming.** Constants `SCREAMING_SNAKE_CASE`, types `PascalCase`,
  schemas `<Name>Schema`. Stable id prefixes per kind:
  `INC-YYYY-NNNN` for incidents, `EV-` for evidence, `PM-` for
  postmortems, `LH-` for legal holds, etc.
- **Tests.** Each module gets its own `*.test.ts`. Tests cover
  constants, schema validation (accept + reject paths), helper
  functions, and state-machine transitions. Aim for 15–30 tests
  per module.
- **No comments.** The codebase generally doesn't have JSDoc or
  inline comments. Don't add them unless explaining a non-obvious
  invariant.

## Workflow

The user drives construction with `go [letter]` commands. After
each completed package, propose 6–8 next options labeled A–H and
recommend one. The user picks. Each landed package follows this
shape:

1. Read the relevant ADR (or design fresh against the
   conversation context if no ADR exists yet).
2. Scaffold `package.json` + `tsconfig.json` + `vitest.config.ts`.
3. Build 4–7 source modules with comprehensive zod schemas +
   deterministic helpers. No placeholders.
4. Build `src/index.ts` re-exporting everything.
5. Wire `META_*` tables into kernel meta-schema (+ test).
6. Write `*.test.ts` files alongside each source module.
7. Run `pnpm --filter @crossengin/<name> test` until green.
8. Run `pnpm -r test` to confirm no regression.
9. Run `pnpm -r typecheck`.
10. `git commit` with a detailed multi-paragraph message
    describing each module's enums + invariants + helpers.
11. `git push -u origin claude/crossengin-development-LXLNw`.

## Git

- Working branch: `claude/crossengin-development-LXLNw`.
- Never force-push. Never skip hooks (`--no-verify`).
- Don't create PRs unless the user asks.
- Repository scope is restricted to `amoufaq5/crossengin` and
  `amoufaq5/erp`.

## What's deferred to Phase 2+

The current packages model the *shape* of the platform. The
following are intentionally out of scope until contracts settle:

- Real provider clients (Stripe, Salesforce, ServiceNow,
  Anthropic). Today the packages have credential refs + record
  types only.
- Real cryptography. Signature fields are typed as strings; the
  actual HMAC/ed25519 computation is not in this codebase.
- Apps under `apps/`. The directory is empty; UI lives in `views`
  as type definitions only.

**No longer deferred (as of M1):** kernel DDL execution. The
`kernel-pg` package executes meta-schema DDL against a real
Postgres, with `_meta_migrations` bookkeeping for idempotent
re-runs and pg_catalog introspection for drift detection.

**No longer deferred (as of M2):** real cryptography. The
`crypto` package produces verifiable SHA-256 / BLAKE2b-512
hashes, real HMAC-SHA256 / Ed25519 signatures over `node:crypto`,
with an opaque `KeyHandle` contract that hides raw key material
behind a `KeyStore` interface.

**No longer deferred (as of M2.5):** downstream wiring. The
crypto package is now called from four existing packages, so the
previously-string-only signature fields are populated by real
verifiable values: marketplace pack manifests carry real
Ed25519 signatures with sha256 public key fingerprints; sdk
webhook deliveries carry real HMAC-SHA256 signatures bound to
timestamps for replay protection; forensics chain entries carry
real hash chains rooted at GENESIS_HASH plus Ed25519 entry
signatures, and evidence is sealed with real sha256 + Ed25519;
tenant-lifecycle tombstones carry canonical-JSON-derived
contentManifestSha256 + proofSha256 that round-trip via
`verifyTombstoneHashes`.

**No longer deferred (as of M3):** workflow execution. The
`workflow-runtime` package consumes `WorkflowDefinition` shapes
and actually runs them: starts instances, threads variables,
runs automatic transitions, schedules + executes activities via
a registered handler registry, fires timers when their fireAt is
reached, accepts signals matched by tenant + correlationKey,
emits the documented 24 event kinds (instance_started /
state_transitioned / activity_* / signal_* / timer_* /
variable_updated / compensation_* / instance_completed/failed/
cancelled/suspended/resumed), and replays state by left-folding
the event stream. Distributed (Postgres-backed) execution is
M3.5 — same engine over a `PostgresEventLog` adapter.

## ADRs

ADRs 0001-0049 exist as markdown in `docs/adr/`. Every shipped
package has a corresponding ADR; no reserved gaps. ADR-0046 is
the bridge from Phase 1 contracts to Phase 2 runtime (8
milestones). ADR-0047 covers Phase 2 M1 (`kernel-pg`), ADR-0048
covers Phase 2 M2 (`crypto`), ADR-0049 covers Phase 2 M3
(`workflow-runtime`). When you ship a new package, write the
matching ADR in the same session, following `0000-template.md`
and the style of the existing 0026-0037 batch.
