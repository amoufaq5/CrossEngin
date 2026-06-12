# ADR-0215: gated per-tenant dispatch integration test (Phase 3 P5.9)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0211 (per-tenant dispatch), ADR-0212 (cache invalidation), ADR-0081 (marketplace-pg) |

## Context

P5.5–P5.8 built per-tenant serving (dispatch · invalidation · JWT pre-resolution ·
report runner) and proved each offline with in-memory fakes (a `TenantPackSource` stub).
The one path no offline test could cover is the **real RLS-scoped read** of a tenant's
install set from `meta.pack_installations` through `buildPgTenantPackSource` — the seam
the live `--marketplace` dispatcher actually uses.

## Decision

A gated real-Postgres integration test (`integration-tenant-dispatch.test.ts`, gated on
`CROSSENGIN_PG_TEST=1`, skipped offline) drives the full install → serve → uninstall loop
over a live `PostgresPackInstallationStore` + `PostgresEntityStore`.

- A fresh tenant + user; a `TenantDispatcher` whose `source` is
  `buildPgTenantPackSource(installs, buildBuiltinPackResolver())` (the production seam),
  `tenantOf` is `apiKeyTenantResolver`, and `buildFor` composes
  `composeTenantManifest(retail, packs)` over a shared `PostgresEntityStore`.
- **Before install:** `GET /v1/courses` routes to the base retail gateway → `>= 400`
  (no Course route).
- **Install** drives the marketplace engine (`newInstallationRequest → beginInstall →
  completeInstall`) and records to `meta.pack_installations` (RLS-scoped), then
  `dispatcher.invalidate(tenant)`; `GET /v1/courses` now `200` on the composed gateway. A
  `Course` is seeded through the store and read back in the list (`CS101` present).
- **Uninstall** records the `uninstalled` transition + invalidates; `GET /v1/courses` is
  `>= 400` again (the route is gone with the install).

## Consequences

- **68 packages + 4 apps, 126 meta-schema tables, ~7,341 offline tests + 55 gated
  real-Postgres integration tests (17 worker + 26 operate-server + 12 operate-web) + six
  CI gates.** The new case ran green against a live Postgres 16 alongside the full gated
  operate-server suite (29 test files). No new META_ tables; tests-only.
- The marketplace install loop is now verified end-to-end against a real database — the
  RLS-scoped install read, the engine-driven lifecycle, and per-tenant route
  composition/dispatch all exercised in one test. `.github/workflows/ci.yml` picks it up
  automatically under the existing `CROSSENGIN_PG_TEST=1` gated step.
