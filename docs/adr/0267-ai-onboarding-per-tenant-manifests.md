# ADR-0267: In-product AI onboarding — per-tenant manifests, design endpoint, activation, wizard (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0078 (operate-runtime), ADR-0086 (operate-runtime-pg), ADR-0087 (operate-server), ADR-0263 (--openai-base-url), ADR-0265 (platform console), ADR-0077 (Phase 4) |

## Context

The platform served ONE manifest (`--pack`) to every tenant, and the AI Architect existed only
as a local CLI. The product vision — "create your company, describe it, AI builds and serves
your system" — needed two missing pieces: per-tenant custom manifests in the serving path, and
an in-product AI design flow. Built as five parallel modules (four operate-server, one
operate-web) against dictated structural contracts, integrated by the orchestrator.

## Decision

- **`meta.operate_tenant_manifests` (table #137)** — tenant-RLS proposals: manifest JSONB +
  hash, status `draft|active|archived`, source `ai|manual`, provider label, activated_at. FK to
  `meta.tenants` (a proposal requires a registered tenant).
- **`tenant-manifests.ts`** — `PostgresTenantManifestStore` (every op inside `withTenantContext`
  + a bound tenant_id predicate), `activate` demotes the prior active row and promotes the target
  in one transaction; `canTransitionManifest`; `manifestSummary` (kernel array-shaped AND
  record-shaped docs).
- **`ai-design.ts`** — `designManifest`: description → LLM (structural `DesignCompletionProvider`)
  → `extractJsonObject` → `normalizeGeneratedManifest` → **`ensureRolesInManifest`** →
  kernel `ManifestSchema` + `tryValidateManifest`, feeding validation issues back for up to 3
  attempts; caps (4k description / 256k response); usage accumulation.
  `buildDesignProviderFromEnv`: `ANTHROPIC_API_KEY` → Anthropic, else `OPENAI_API_KEY` (+
  `OPENAI_BASE_URL` for self-hosted OSS servers), else null → routes answer 503.
  The role graft exists because activating a system whose AI-invented roles exclude the
  operator's own role would sever the operator from the API they just created (found live:
  `unknown role 'erp_admin'`).
- **`ai-design-routes.ts`** — `/v1/ai/design` (POST), `/v1/ai/manifests` (+ `:id`,
  `:id/activate`, `:id/archive`), role-gated fail-closed (`--ai-design-role`, default
  erp_admin + platform_admin), tenant always from the authenticated principal.
- **`tenant-gateway-cache.ts`** — `resolveRequestTenant` (x-tenant-id header → api-key/Bearer
  token → tenant), `TenantGatewayCache` (kernel-validates the stored doc, compiles a gateway per
  tenant, positive+negative TTL caching, fail-open to the default server on invalid docs, source
  errors uncached), `buildPerTenantDispatch`. Activation invalidates the tenant's entry.
- **`node.ts serve()`** — `--ai-design` / `--per-tenant-manifests` / `--ai-model` wiring. Tenant
  gateways carry auth + store + numbering + settings + the deployment's **extraRoutes** and the
  subscription gate (without extraRoutes, activation would sever a tenant from `/v1/ai` itself —
  found in the live run). Peripheral observers (SLO, audit chain, metering, billing webhook,
  region guard) stay on the default server — a documented follow-up.
- **`operate-web /setup` ("AI Studio")** — describe → review (KPI tiles + entity tiles + issues)
  → activate → live; previous proposals table with activate/archive. Fiori style; Sidebar link.

## Consequences

- **The full loop was proven live**, not just unit-tested: on a real Postgres 16 (with the
  Supabase UUIDv7 polyfill — revalidated at 137 tables), a stubbed OpenAI-compatible server on
  `OPENAI_BASE_URL` designed "Field Service"; the proposal persisted under RLS; activation
  flipped the tenant's live API — boot-pack routes 404, `/v1/customers` 201 (a record with the
  designed schema enforcing its own required fields and enum values), a `WorkOrder`
  referencing the created customer, `/v1/meta/schema` returning Customer/WorkOrder, and the
  whole web console (dashboard, sidebar, quick-create) re-driven by the AI-designed system.
- Guardrails: kernel validation is the hard gate (nothing invalid can be stored or activated);
  activation is an explicit human act via role-gated routes; every proposal row is an audit
  record (description, provider label, hash, timestamps); no provider configured → 503, never a
  silent fallback. Per-request cost ceilings and a platform-level review queue are follow-ups.
- Per-tenant manifests currently serve via the JSONB entity store path (manifest-agnostic).
  Column-mapped per-tenant tables, peripheral observers on tenant gateways, multi-replica cache
  invalidation (TTL-bounded staleness today), and design-time streaming progress are follow-ups.
- 3 integration defects found by the live run and fixed with tests: kernel array-shaped
  entities in `manifestSummary` (entityCount 0 → correct), missing extraRoutes on tenant
  gateways, and the operator-role graft. +8 tests across the two modules; architect-cli table
  count 136 → 137.
- A four-lens adversarial review (tenant isolation / authorization / injection /
  correctness) ran before merge. Isolation, authorization, and injection returned no
  confirmed findings (the P1.18 tenant cross-check provably defuses `x-tenant-id` spoofing;
  the role graft cannot reach field-level grants, so classification redaction stays
  fail-closed; SQL fully parameterized; React escapes AI strings). Six review findings were
  fixed with tests: (1) the residency region guard now rides tenant gateways; (2) a
  `--store pg-columns` deployment serves custom-manifest tenants from a JSONB store over the
  same connection (the column store only plans the boot pack's entities); (3) `activate`
  takes a per-tenant `pg_advisory_xact_lock` so concurrent activates cannot commit two
  active rows (a partial unique index needs kernel emitter support — follow-up); (4) tenant
  resolution is credential-first — the `x-tenant-id` header only routes requests carrying an
  unknown Bearer credential (JWT mode) and only as a canonical UUID, so unauthenticated
  header floods never reach the manifest source; (5) the gateway cache is capped
  (default 1000 entries, expired-then-oldest eviction); (6) the Node intake caps request
  bodies at 10 MiB → 413 problem doc (a pre-existing platform-wide gap since P1.7).
