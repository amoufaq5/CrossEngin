# ADR-0208: marketplace install HTTP surface (Phase 3 P5.2)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0081 (marketplace install runtime), ADR-0207 (marketplace CLI), ADR-0180 (report routes — the non-entity gateway-route precedent) |

## Context

P5.1 (ADR-0207) gave the marketplace install runtime an operator CLI. The remaining
surface is **HTTP**: a tenant should manage its own pack installs through the serving
API, riding the same gateway pipeline (auth → principal → tenant → RBAC → rate-limit
→ audit) as the entity routes — not a side channel.

## Decision

Three tenant-facing gateway routes on `apps/operate-server`, registered via a new
generic `extraRoutes` hook on the runtime.

- **`@crossengin/operate-runtime`** — `OperateRuntimeOptions.extraRoutes?: ExtraRoute[]`
  (`{ definition, operationId, handler }`). `compileOperateServer` registers each
  alongside the entity + report + openapi routes, so they ride the full pipeline.
  This keeps operate-runtime free of any marketplace concept — it's just a hook for
  additional non-entity routes (the report route is the precedent, ADR-0180).
- **`apps/operate-server` `marketplace-routes.ts`** — `buildMarketplaceRoutes(store,
  {now, newId})` returns three `ExtraRoute`s:
  - `GET /v1/marketplace/installations` (`?status=`) → `{ installations }` for the
    principal's tenant.
  - `POST /v1/marketplace/installations` (body `{ packId, version, updatePolicy? }`)
    → `409` if an active install exists, `422` on a bad request, else drives the
    engine `newInstallationRequest → beginInstall → completeInstall` and `201`s the
    `{ installation }`.
  - `DELETE /v1/marketplace/installations/:packId` → `404` if not installed, else
    `requestUninstall → completeUninstall` and `200`s.

  The **tenant is the authenticated principal's tenant** (`principal.tenantId`, never
  a request parameter) and the actor is `principal.principalId`, so a caller can only
  manage its own tenant's installs; the RLS-scoped store enforces it again at the DB.
- **`serve()`** under `--marketplace` opens a dedicated PG conn, builds the store +
  routes, threads them through `buildOperateHttpServer`, and closes the conn on
  shutdown.

## Consequences

- **68 packages + 4 apps, 126 meta-schema tables, ~7,309 offline tests + 54 gated
  real-Postgres integration tests + six CI gates.** New tests: operate-server
  `marketplace-routes.test.ts` (the 3 handlers — list 200, install 201/409/422,
  uninstall 200/404, 401 with no tenant, over a structural fake store), a `cli.test.ts`
  `--marketplace` case, and a `server.test.ts` e2e (GET over the gateway with an API
  key → 200 / 401 unauthenticated). No new META_ tables.
- A tenant can now install/uninstall packs over HTTP, gateway-authenticated +
  RLS-isolated, with every write driven through the guarded lifecycle engine.
  Resolving an `installed` pack's manifest into the tenant's *served* entity surface
  (the deeper marketplace↔serving integration) + a gated PG test remain the
  follow-ups.
