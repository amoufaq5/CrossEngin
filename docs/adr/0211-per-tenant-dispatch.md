# ADR-0211: per-tenant gateway dispatch (Phase 3 P5.5)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0210 (route composition), ADR-0209 (surface resolution), ADR-0087 (operate-server) |

## Context

P5.4 composes a tenant's installed packs into a manifest + derives its routes, but
those routes weren't *served* — operate-server runs one gateway over one manifest for
all tenants. The crux of serving them: **auth resolves the tenant inside the gateway
pipeline**, so the gateway can't be chosen by tenant up front.

## Decision

A `TenantDispatcher` that pre-resolves the tenant from the API-key credential (a map
lookup, no crypto) and routes the request to a cached per-tenant composed gateway.

- **`apps/operate-server` `tenant-dispatcher.ts`** — an `OperateDispatcher` interface
  (`dispatchWithMatch`) satisfied by both the base `OperateHttpServer` and the
  dispatcher (a drop-in). `apiKeyTenantResolver(apiKeys)` reads the `x-api-key` /
  `Authorization: Bearer <opaque>` token and maps it to its tenant (the key spec
  carries the tenant); a JWT bearer isn't in the map → `null` (those callers fall
  through to the base server — JWT pre-resolution is a follow-up). `TenantDispatcher`
  caches a per-tenant server (TTL-bounded, default 30s): on a request it resolves the
  tenant, fetches its installed-pack manifests (`buildPgTenantPackSource` over the
  RLS-scoped store + the resolver), and dispatches through
  `buildFor(composeTenantManifest(base, packs))` — or the base server when there are
  no installs / no tenant. The chosen gateway still runs the **full** auth + RBAC +
  pipeline; the pre-resolution only *picks* the gateway.
- **`serve()` under `--marketplace`** wraps the base server in a `TenantDispatcher`
  (the entity store + API keys are shared; per-tenant servers are built lazily) and
  the Node listener dispatches through it (its param widened to `OperateDispatcher`).

## Consequences

- **68 packages + 4 apps, 126 meta-schema tables, ~7,341 offline tests + 54 gated
  real-Postgres integration tests + six CI gates.** New tests: `tenant-dispatcher.test.ts`
  — a tenant with education installed serves `GET /v1/courses` (200) while a tenant
  without it gets the base 404 (the route doesn't exist there); cross-vertical RBAC is
  correctly enforced (an `education_admin` hits the composed gateway's `Product` route
  but is denied 403, not 404); an unknown credential falls through to the base server
  (401); the resolver maps known keys + nulls unknown/JWT. No new META_ tables.
- **Installing a pack now actually adds its entities to that tenant's served API** —
  the marketplace install loop is end-to-end (engine → store → CLI/HTTP → surface →
  composed routes → per-tenant serving). Limitations / follow-ups: per-tenant serving
  applies to API-key auth (JWT pre-resolution + cache invalidation on install/uninstall
  are deferred; a TTL bounds staleness today); per-tenant servers don't yet wire the
  report runner (CRUD + lifecycle only). A gated PG e2e is the natural next test.
