# ADR-0210: per-tenant route composition (Phase 3 P5.4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0209 (tenant surface resolution), ADR-0078 (operate-runtime route compilation), ADR-0080 (Phase 3 P5) |

## Context

P5.3 resolved a tenant's installed packs into an entity/view surface. The next step
toward marketplace-served entities is turning that surface into **routes** — the
actual REST endpoints the tenant's installs would serve. Full per-request gateway
*dispatch* selection is a larger change (the gateway resolves the tenant inside the
pipeline, so per-tenant route registries need a dispatch restructure); this increment
ships the bounded, foundational compilation primitive + a served descriptor.

## Decision

A pure manifest-composition primitive + per-tenant route derivation, surfaced on the
existing endpoint.

- **`apps/operate-server` `tenant-compile.ts`** — `composeTenantManifest(base,
  packManifests)` merges a tenant's base served manifest with its installed packs'
  (resolved) manifests into one: **entities dedupe by name** (so the shared core
  appears once across distinct verticals), relations dedupe by `kind:from.field->to`,
  and roles / permissions / workflows / views / reports / dashboards merge by key
  (base authoritative on a collision); the base `meta` identity is kept. Distinct
  verticals (each over the shared core) compose cleanly — no entity-name or role
  collisions — and the result **cross-validates** (`tryValidateManifest`).
  `tenantRouteSummaries(base, packManifests)` derives the composed manifest's REST
  routes using the **same `manifestRouteSpecs`** the gateway compiles, so the routes
  reported are exactly the CRUD + lifecycle routes the installs would serve.
- **`GET /v1/marketplace/surface`** — when `buildMarketplaceRoutes` is given a
  `baseManifest` (alongside the `resolver`), the surface now also reports the
  composed `routes` (`{operationId, method, path, entity, action}`). `serve()` under
  `--marketplace` passes the served manifest.

## Consequences

- **68 packages + 4 apps, 126 meta-schema tables, ~7,335 offline tests + 54 gated
  real-Postgres integration tests + six CI gates.** New tests: `tenant-compile.test.ts`
  (compose retail + education → 12 deduped entities that cross-validate; +construction
  → 16; merged roles/workflows; route summaries include the installed pack's CRUD +
  lifecycle routes; an empty install set → base routes only) + a `marketplace-routes.test.ts`
  surface case (the composed `routes` appear when a base manifest is supplied). No new
  META_ tables.
- A tenant's surface now reports the exact routes its installs would serve, derived
  from the same compilation the gateway uses. The remaining deep step — selecting a
  per-tenant compiled gateway at dispatch (so those routes actually serve the pack
  entities, gated by install) — builds directly on `composeTenantManifest`.
