# ADR-0265: Platform super-admin tenant-management console (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0243 (marketplace authoring routes), `operate-web`, `meta.tenants`, ADR-0077 (Phase 4) |

## Context

CrossEngin was fully multi-tenant at the API layer, but there was no way to *manage* the tenant
population: `meta.tenants` was created and mutated by hand (SQL), and `operate-web` was a single-tenant
operator UI bound to one API key. There was no platform super-admin surface to list / create / suspend /
archive / reactivate tenants. This adds one — an HTTP API + a UI.

## Decision

- **`platform-tenants.ts` (operate-server, pure)** — the tenant contract: `TenantRecordSchema`
  (id/slug/name/status/tier/region/schemaName/searchLocale/timestamps), the status vocabularies
  (`TENANT_STATUSES` active|suspended|archived|deleted, tiers, regions, locales), a console status
  machine (`TENANT_STATUS_TRANSITIONS` + `canTransitionTenant`: active↔suspended, active/suspended →
  archived; `deleted` is *not* reachable from the console — GDPR deletion lives in `tenant-lifecycle`),
  `CreateTenantInputSchema`, and `deriveSchemaName(slug)` (a valid, unique-ish pg identifier when
  `schema_name` isn't supplied).
- **`platform-admin.ts` (operate-server, impure)** — `PostgresTenantStore` over the **platform-wide**
  `meta.tenants` registry (no RLS / no tenant context — plain queries): `list` (status filter, keyset/
  offset cursor, clamped limit), `getById` / `getBySlug`, `create` (unique-violation → typed
  `DuplicateTenantError`), `setStatus`, `counts`. `buildPlatformAdminRoutes` returns seven gated
  `ExtraGatewayRoute`s under `/v1/platform` (`tenants.list|create|get|suspend|archive|reactivate` +
  `stats`), mirroring the marketplace-authoring routes — **fail-closed** role gating (401 unauth / 403
  wrong role) against a configured admin-role set, with clean 400 / 404 / 409 mapping.
- **`--platform-admin` (+ repeatable `--platform-admin-role`, default `platform_admin`)** —
  `serve()` injects the routes into the gateway's `extraRoutes` over the pg connection; requires
  `--store pg|pg-columns`. The routes ride the normal 17-stage pipeline (auth, audit, problem docs).
- **`operate-web` `/platform` console (UI)** — a `lib/platform.ts` typed client + three pages:
  the console home (status-count tiles + a filterable tenants table + "New tenant"), a create form
  (slug/name/tier/region with inline 400/409 handling), and a tenant detail page with
  suspend/reactivate/archive actions (only the valid transitions shown; illegal ones surface the 409).
  A "Platform" nav section links it in. It calls the API through the app's existing `/api` proxy, so a
  platform-admin deployment simply configures a `platform_admin` API key.

## Consequences

- The multi-tenant platform now has a real management surface: an operator lists every tenant, sees the
  population at a glance (counts by status), provisions a new tenant (slug/name/tier/region, schema name
  auto-derived), and suspends / archives / reactivates one — through a gated API and a matching UI,
  instead of hand-written SQL. New tenants are immediately picked up by the DB-backed schedulers
  (`--schedule-all-tenants`, checkpoint `allTenants`) that enumerate `meta.tenants` live.
- Separation of authority is explicit: the `/v1/platform` routes are gated to platform-admin roles
  (distinct from any tenant role), fail-closed, and operate on the platform-wide registry — a tenant
  principal can never reach them. Deletion is deliberately excluded (the console can't hard-delete a
  tenant; that stays the audited GDPR flow).
- Reuses the proven `ExtraGatewayRoute` seam + `operate-web` shell — no new gateway machinery, no new
  META table (the registry `meta.tenants` already existed), no schema-count change. +28 operate-server
  tests (13 pure contract/transition/schema-derive + 15 store/route/gating over a fake PG) + 1 CLI test →
  420; the UI is typecheck-gated (`operate-web` has no test suite). Full build + typecheck + workspace
  tests green. `serve()` injection stays offline-untestable, like the other admin routes.
- Follow-up (open): per-tenant health/usage on the detail page (record counts, subscription, last
  activity) sourced from the runtime; a tenant-scoped API-key / principal management surface; bulk
  status actions; the GDPR delete flow surfaced (read-only) for visibility.
