# ADR-0077: Phase 3 implementation plan

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0046 (Phase 2 plan, the previous bridge), every Phase 2 ADR (0047-0076) |

## Context

Phase 2 is complete. **57 packages + 1 app, 122 meta-schema tables, 6,170 tests, zero type errors.** All eight Phase 2 milestones (M1 DDL execution → M8 SLO enforcement) landed, plus a long tail of `M*.x` follow-ons: the OpenAI provider + multi-vendor chat router, the full data-classification arc (field classification → default redaction → gateway edge redaction → manifest-derived registry → pgcrypto at-rest coverage/migration + CLI), the SLO persistence + latency siblings, and four vertical packs (core, healthcare, retail, grocery) that prove `meta.extends` at single-parent and transitive three-level depth.

What's true today: every runtime *pillar* exists and is tested in isolation. The kernel applies DDL (`kernel-pg`). The gateway runs its 17-stage pipeline (`api-gateway-runtime`). Workflows execute in-process (`workflow-runtime`). Crypto is real. The AI Architect chats against a real router. The SLO loop declares incidents. A manifest resolves, validates, and emits SQL.

What's **not** true today: nothing is *deployed*, and nothing is *composed end-to-end into a serving product*. There is no app that takes a resolved manifest pack and stands it up as a live multi-tenant API a real tenant can call. The workflow runtime is in-process only (ADR-0046 Q3 deferred distributed). The `views` package is types-only — there is no renderer, no human surface. The marketplace declares the install lifecycle but no pack is actually published and installed. The `active-active` / `edge` / `residency` packages are pure contracts with no runtime.

Phase 1 got the *shape* right. Phase 2 made the pillars *run*. **Phase 3 composes the pillars into a deployed, multi-vertical product** — the same way Phase 2 turned contracts into runtimes, Phase 3 turns runtimes into a serving system, then scales and expands it.

This ADR defines the milestone order, exit criteria, and the per-milestone ADRs. It does **not** pick hosting (Vercel vs Fly vs self-host), the web framework, or the queue technology — those are per-milestone ADRs.

## Decision

Phase 3 ships in **eight milestones (P1–P8)**. The order is dictated by dependency: the serving application (P1) is the substrate everything else deploys onto; scale (P2) and the human surface (P3) come next; vertical breadth (P4), distribution (P5), geography (P6), the AI authoring loop in production (P7), and GA hardening (P8) follow.

### Milestone P1 — The runtime application (`apps/operate-server`)

- **Goal.** The first *deployed* app: take a resolved manifest pack and serve it as a live multi-tenant HTTP API. This is the keystone — it composes `kernel-pg` (apply the pack's entity DDL into a tenant schema) + `api-gateway-runtime` (the request pipeline) + `auth` (RBAC/ABAC + classification redaction) + `workflow-runtime` (entity lifecycles) + `redactionRegistryFromManifest` into one serving binary.
- **What lands.** `apps/operate-server` — a Node HTTP server that, given a resolved `Manifest`, registers CRUD handlers per entity (backed by tenant-schema tables), wires the gateway pipeline (auth → rate-limit → idempotency → validate → dispatch → **redact** → audit), enforces RLS via `app.current_tenant_id`, and runs entity-lifecycle transitions through the workflow runtime. A `pack-to-routes` compiler that turns manifest entities/permissions/views into operationIds + handlers + the redaction registry.
- **Exit criterion.** `buildErpRetailPack` resolved + applied → `POST /v1/products` creates a row under the tenant's RLS; a cashier `GET /v1/products` gets `unit_cost` **redacted**; a manager gets it; `POST /v1/sales-orders/{id}:place` advances the lifecycle and writes a `PipelineExecution`. All from the manifest, no hand-written endpoint.
- **ADR.** ADR-0078 (serving architecture, pack→routes compiler, tenant-schema provisioning).

### Milestone P2 — Distributed workflow + job execution

- **Goal.** Workflows and jobs run across processes and survive restarts — the in-process executor (M3) becomes a durable, horizontally-scaled worker fleet (ADR-0046 Q3, finally).
- **What lands.** `@crossengin/workflow-worker` + `@crossengin/jobs-runtime` — a Postgres-queue-backed worker (`SELECT … FOR UPDATE SKIP LOCKED`) consuming `workflow-runtime-pg`'s event log + the `jobs` declarations (cron + event triggers), with at-least-once delivery, idempotency keys, dead-letter handling, and the saga compensation actually running on failure.
- **Exit criterion.** A retail `sales_order_lifecycle` instance started on worker A, with worker A killed mid-flight, resumes on worker B and completes; the `order-placed-handler` job fires from a `retail.order_placed` event, decrements inventory exactly once under concurrent workers, and dead-letters after max retries.
- **ADR.** ADR-0079 (distributed execution, queue semantics, exactly-once vs at-least-once, worker lifecycle).

### Milestone P3 — The frontend renderer (`apps/operate-web`)

- **Goal.** The `views` package (types-only) gets a real renderer — a web app that renders list/detail/form views from a manifest, calling `operate-server`, honoring permissions + redaction + i18n.
- **What lands.** `apps/operate-web` — a manifest-driven UI: `ListView` → a data table (columns, sort, pagination, export), `FormView` → a create/edit form (field types, validations), detail + workflow-transition buttons gated by permissions. Reads the resolved manifest's `views` + `i18n` + `theme`; never hand-codes a screen. Redacted fields render as absent (the server already stripped them).
- **Exit criterion.** A tenant opens the retail pack's `product.list` view in a browser, sees a paginated table (no `unit_cost` column for a cashier), opens a product, edits it through the form, and places a sales order via the lifecycle button — all generated from the manifest.
- **ADR.** ADR-0080 (renderer architecture, view→component mapping, client-side permission/i18n handling).

### Milestone P4 — Vertical pack expansion (Government, Education, Construction)

- **Goal.** Three more production-grade vertical packs on `operate-erp/core`, broadening the catalog and stress-testing the manifest contracts against unfamiliar domains.
- **What lands.** `pack-gov-permitting` (PII + regulated, FOIA/records-retention posture), `pack-edu-sis` (a student information system — PII/FERPA, enrollment workflows), `pack-erp-construction` (projects, bids, change-orders; commercial_sensitive). Each follows the healthcare/retail template: `meta.extends`, classified fields, lifecycle workflows, jobs, views; each cross-validates and deploys via P1.
- **Exit criterion.** Each of the three packs resolves against core, passes `tryValidateManifest`, deploys through `operate-server`, and renders through `operate-web` — three new working verticals from manifest alone.
- **ADR.** ADR-0081 (vertical pack catalog, domain-modeling conventions, compliance-pack mapping per vertical).

### Milestone P5 — Marketplace activation

- **Goal.** Packs are *published* and *installed* for real — the marketplace's declared lifecycle (ed25519 signing, security review, per-tenant install) executes end-to-end.
- **What lands.** `@crossengin/marketplace-runtime` — sign a pack manifest (`crypto` ed25519), publish a `PackVersion` to the registry (with the security-review gate), and install it into a tenant: `resolveManifest` against the registry → `kernel-pg` apply the entity DDL into the tenant schema → register routes in `operate-server` → grant the pack's permissions. Upgrade = diff + migration.
- **Exit criterion.** The grocery pack is signed, published, security-reviewed, and installed into a fresh tenant in one flow; a tampered pack fails signature verification at install; an upgrade from v0.1.0 → v0.2.0 applies only the diff.
- **ADR.** ADR-0082 (publish/install pipeline, signing & review gates, upgrade/rollback semantics).

### Milestone P6 — Multi-region / active-active

- **Goal.** The `active-active` / `edge` / `residency` contracts get a runtime — region routing, residency-pinned data, and CRDT conflict resolution.
- **What lands.** `@crossengin/edge-runtime` (region routing + latency-budget enforcement, composing `observability-runtime`'s latency engine) + `@crossengin/active-active-runtime` (the 6 CRDT kinds applied to replicated records, vector-clock conflict detection, split-brain lifecycle). Residency profiles pin a tenant's data + AI provider (the router's residency filter, already built) to its region.
- **Exit criterion.** A tenant pinned to `eu-central` has its writes served + stored in EU and its AI calls routed to an EU-resident provider; a concurrent two-region write to a counter resolves via the PN-counter CRDT; a simulated split-brain detects + heals.
- **ADR.** ADR-0083 (multi-region topology, CRDT application, residency enforcement at the data + AI layers).

### Milestone P7 — AI Architect in production

- **Goal.** The AI Architect authors + deploys packs against real tenants, with the safety policy enforced, transcripts persisted, and cost ceilings live via the router.
- **What lands.** `apps/architect-cli`'s authoring loop (already tool-driven + persisted) wired to `marketplace-runtime` (P5) so an approved `propose_manifest_edit` can *publish + install* the pack; the `ai-architect` safety policy (refusals, eval gates, redteam, cost ceilings) enforced in the loop; the router's `onResolved` attribution + cost tracker feeding per-tenant AI budgets.
- **Exit criterion.** A developer asks the Architect to "add a loyalty program to the retail pack"; the agent proposes a manifest edit (new `LoyaltyMember` entity, classified PII), the developer approves, and the agent publishes + installs the upgrade into a sandbox tenant — refusing if the eval gate or cost ceiling trips.
- **ADR.** ADR-0084 (production authoring loop, safety-gate enforcement, agent→marketplace integration).

### Milestone P8 — Production hardening + GA

- **Goal.** The platform is operable in production: transparent column encryption, key rotation, executed DR drills, the live SLO enforcement loop, and access-review campaigns running.
- **What lands.** The encryption *write* path (the `INSTEAD OF` triggers / encrypting view over the M7.8.5 BYTEA columns) + key rotation (`reencryptColumnSql`); `@crossengin/dr-runtime` executing failover records + drills against the deployment; the M8 SLO loop wired to `operate-server`'s real request stream (not a test harness); `access-reviews` campaigns run on a schedule against live grants.
- **Exit criterion.** A staging deployment survives a region-failover drill (RPO/RTO met), a key rotation re-encrypts PHI columns with zero downtime, a 5xx burst trips the live SLO loop (incident + page + flag rollback), and a quarterly access-review campaign attests every grant — all on real infrastructure.
- **ADR.** ADR-0085 (production hardening, encryption write-path, DR execution, GA readiness checklist).

## Cross-cutting principles for Phase 3

These extend the Phase 2 principles (which still hold):

1. **Apps compose runtimes; they don't reimplement them.** `operate-server` wires `kernel-pg` + `api-gateway-runtime` + `workflow-runtime` + `auth`; it adds the *composition* (pack→routes), not new pipeline logic. The pillars stay where they are.
2. **The manifest is the only source of truth — at runtime too.** A served API's routes, a UI's screens, a tenant's permissions, and a column's redaction all derive from the resolved manifest. "Hand-write an endpoint/screen" is a smell; the generator is the contract.
3. **Multi-tenancy is RLS, end to end.** Every served request sets `app.current_tenant_id`; every tenant's pack lives in its schema; no query crosses a tenant without a platform-wide audit record. The serving layer enforces what the meta-schema declares.
4. **Deploy a vertical, not a feature.** Phase 3's unit of delivery is a *working vertical* (a pack served + rendered + installable), not a runtime knob. Each milestone exits on "a tenant can use X."
5. **Production safety is a gate, not a hope.** Encryption, key rotation, DR, SLO enforcement, and access reviews are *executed* in P8 against real infra — GA means the safety mechanisms have run, not just compiled.
6. **One milestone = one or more ADRs.** ADR-0078–0085 lock each milestone's concrete choices before code, same as Phase 2.

## Alternatives considered

- **Build the web renderer (P3) before the serving app (P1).**
  - **Cons.** A UI with nothing to call is a mock. The server is the substrate; the UI is a client of it.
  - **Why not.** P1 is the keystone — it makes a manifest *serve*; P3 renders what P1 serves.
- **Skip the dedicated serving app; make each vertical pack its own service.**
  - **Cons.** Every pack would re-wire the gateway + DDL + workflow runtime — duplication, drift, and no shared multi-tenancy. The pack→routes compiler is the whole point: one server, many packs.
  - **Why not.** A single `operate-server` that loads any resolved pack is the multi-tenant product; per-pack services are the anti-pattern.
- **Do multi-region (P6) early for a global-from-day-one story.**
  - **Cons.** Multi-region is meaningless before there's a single-region serving app to replicate. It also multiplies the surface for every earlier bug.
  - **Why not.** Geography scales a working product; it doesn't create one. P6 after P1–P5.
- **Adopt a low-code/no-code platform (Retool, Budibase) for the UI instead of building `operate-web`.**
  - **Cons.** The UI must honor manifest-derived permissions, classification redaction, i18n, and workflow transitions — all CrossEngin-specific. Bridging an external builder to the manifest loses the "UI is generated from the contract" invariant.
  - **Why not.** The renderer *is* the product surface; it has to speak manifest natively.
- **Defer distributed execution (P2) to "when load grows" (as Phase 2 did).**
  - **Cons.** A deployed product can't lose in-flight workflows on a deploy/restart. Durability is table stakes for serving real tenants, not a scale optimization.
  - **Why not.** P1 makes it real; P2 makes it survivable — they're adjacent for a reason.

## Consequences

- **Phase 3 is 8 milestones, ~1–2 months each, ~12 months.** Each exits on a demoable, tenant-facing behavior. ADRs 0078–0085 are coming, one (or more) per milestone, gated before code.
- **Two new `apps/` (`operate-server`, `operate-web`)** join `architect-cli` — CrossEngin gets a serving backend and a human surface, not just a CLI.
- **~10–14 new packages** — mostly `*-runtime` siblings (`marketplace-runtime`, `edge-runtime`, `active-active-runtime`, `dr-runtime`, `jobs-runtime`, `workflow-worker`) + 3 vertical packs. Final state: ~70 packages + 3 apps.
- **The first production-tenant demo is P1** (~2 months): a real tenant calling a real retail API generated from a manifest. The first *self-service* vertical install is P5; the first *agent-authored* deploy is P7.
- **Phase 4 (after P8)** is commercialization: billing-runtime wired to real metering, the marketplace opened to third-party pack authors, and SOC 2 / HIPAA certification against the running system.

## Open questions

- **Q1:** One `operate-server` process per tenant (isolation) or one multi-tenant process (density)?
  - _Current direction:_ Multi-tenant process with RLS isolation (density); per-tenant processes are a deployment option for high-isolation tenants (BYOC/on-prem, already modeled in `deploy`). Decided in ADR-0078.
- **Q2:** Does the pack→routes compiler generate handlers at build time or interpret the manifest at request time?
  - _Current direction:_ Interpret at startup (load the resolved manifest, build the route table once), so a pack install is a hot reload, not a redeploy. Code-gen is a later optimization if startup cost matters.
- **Q3:** Web framework for `operate-web` — SSR (Next/Remix) or SPA?
  - _Current direction:_ Out of scope for this ADR; decided in ADR-0080. The renderer logic (view→component) is framework-agnostic and tested independently of the shell.
- **Q4:** Queue technology for P2 — Postgres `SKIP LOCKED`, Redis, or a managed queue?
  - _Current direction:_ Postgres `SKIP LOCKED` first (no new infra dependency; the event log already lives in PG), with the worker behind an interface so a managed queue can swap in. Decided in ADR-0079.
- **Q5:** Do the new verticals (P4) need new compliance packs (FERPA, FOIA) authored, or do existing ones cover them?
  - _Current direction:_ New compliance packs as needed — `compliance` already models the pack architecture; FERPA/FOIA clauses are content, not new mechanism. Scoped in ADR-0081.
- **Q6:** Is P6 (multi-region) gated on a customer with a residency requirement, or built speculatively?
  - _Current direction:_ Built when the first residency-bound customer is in the pipeline; the contracts (`residency`, `active-active`, `edge`) are ready, so it's runtime-only work that can slot in on demand rather than rigidly at P6.

## References

- **ADR-0046** — the Phase 2 plan; this ADR is its successor bridge.
- **Phase 2 ADRs (0047-0076)** — every runtime pillar Phase 3 composes.
- **CLAUDE.md** — current state snapshot (57 packages + 1 app, 6,170 tests).
