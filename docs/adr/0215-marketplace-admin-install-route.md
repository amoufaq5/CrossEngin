# ADR-0215: Marketplace admin install routes at the HTTP edge (Phase 3 P5.6)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0214 (marketplace-runtime-pg), ADR-0213 (marketplace-runtime), ADR-0087 (operate-server), ADR-0077 (P3 plan — P5) |

## Context

ADR-0214 made the install engine durable, but nothing drove it over HTTP — a tenant admin couldn't
install a pack. This closes the P5 loop with admin routes on `operate-server`. The routes must run
*through* the gateway (for auth + the audited pipeline), but gateway routes are compiled inside
`operate-runtime` (`compileOperateServer`), which has no marketplace knowledge. So the enabling change is
a small generic extension seam.

## Decision

- **Generic `extraRoutes` seam** (`operate-runtime`, `compile.ts`). `OperateGatewayOptions.extraRoutes` is
  a list of `{route: RouteDefinition, handler: Handler}` the gateway registers **ungated** (each handler
  self-authorizes) after the built-in routes. The runtime treats them as opaque — no domain knowledge —
  so any deployment can inject an admin surface. Threaded through `operate-server`'s
  `buildOperateHttpServer`.
- **Marketplace admin module** (`operate-server`, `marketplace-admin.ts`):
  - **`PackCatalog`** — the set of installable pack versions. `PackCatalogEntry` = `{pack, version,
    signature, publisherPublicKeyBase64, compatibility, securityReviewStatus}`; `InMemoryPackCatalog`
    keyed by `<packId>@<version>`; `loadPackCatalog(json)` parses + validates a `{packs:[…]}` document
    through the marketplace zod schemas.
  - **Handlers** (each admin-gated via a `principalRoles` → `adminRoles` check, fail-closed):
    `POST /v1/admin/packs/install` (body `{packId, version}`) looks the entry up (`404` if absent),
    builds the `InstallRequest` from the catalog entry + the deployment `tenantContext`, drives
    `PersistentMarketplaceInstallEngine.install`, and maps the outcome — `admitted → 201`,
    `permission_pending → 200`, `rejected → 409 {reason}`; `GET /v1/admin/packs` lists the tenant's
    installs; `POST /v1/admin/packs/{id}/uninstall` runs `beginUninstall → completeUninstall` (`409` on
    an invalid transition, e.g. uninstalling mid-install). `buildMarketplaceAdminRoutes` assembles the
    three as `ExtraGatewayRoute`s.
- **Wiring** (`node.ts` + `cli.ts`). `--pack-catalog <file>` (requires a pg store for the connection)
  loads the catalog, builds a `PersistentMarketplaceInstallEngine` over a `PostgresInstallationStore`,
  and injects the routes via `extraRoutes`. The `tenantContext` is a deployment default
  (`platformVersion`/`region`/`planTier`/`compliancePacks`/`isDedicatedTenant`) — per-tenant plan/region
  is the noted follow-up.

## Consequences

- P5 is serveable end-to-end: `operate-server --pack erp-retail --store pg --pack-catalog packs.json`
  exposes install/list/uninstall, each authenticated + RBAC-gated through the real gateway pipeline and
  persisted per tenant — a tenant admin installs a signed marketplace pack over HTTP, and the
  already-installed guard + signature/review checks all fire.
- The `extraRoutes` seam keeps `operate-runtime` domain-agnostic: it gained a generic route-injection
  hook, not marketplace concepts. The same hook can carry any future deployment-specific admin surface.
- The install route only *admits* (status `installing`/`permission_pending`); executing the install and
  advancing to `installed` stays a separate concern, so uninstalling mid-install correctly `409`s.
- 7,240 tests pass (+14: `extraRoutes` registration + 404-when-absent in operate-runtime; catalog
  parse/reject, install 401/403/404/400/201, already-installed 409, list, uninstall 404/200/409-mid-install,
  route derivation, and the `--pack-catalog` CLI parse/store-gate). Full build + typecheck green.
- Follow-ups: per-tenant `tenantContext` from the subscription/residency records; a grant route for
  `permission_pending` installs; surfacing the catalog + installs in `operate-web`.
