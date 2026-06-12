# ADR-0212: per-tenant cache invalidation on install/uninstall (Phase 3 P5.6)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0211 (per-tenant dispatch), ADR-0208 (install HTTP surface) |

## Context

P5.5's `TenantDispatcher` caches a per-tenant composed gateway (TTL-bounded, default
30s) so each request serves its tenant's installed-pack entities. ADR-0211 flagged the
staleness window as a deferred limitation: an install through `POST
/v1/marketplace/installations` wasn't reflected on that tenant's served surface until
its cache entry expired (up to the TTL). Two coupled gaps:

1. **No eviction.** Nothing dropped a tenant's cached server when its install set
   changed, so a fresh install waited out the TTL before its entities appeared (and an
   uninstall's entities lingered just as long).
2. **Marketplace routes only on the base server.** The install/uninstall routes were
   wired into the base server only, not the per-tenant `buildFor` gateways. Once a
   tenant had any install (so the dispatcher routed it to a composed gateway), a
   subsequent `DELETE` could 404 — the composed gateway didn't carry the route.

## Decision

A write notifies the dispatcher to evict the affected tenant, and the marketplace
routes ride every per-tenant gateway.

- **`TenantDispatcher.invalidate(tenantId)`** deletes that tenant's cache entry, so the
  next request rebuilds the composed gateway from the current install set.
- **`MarketplaceRouteDeps.onInstallChange?(tenantId)`** — the install (201) and
  uninstall (200) handlers call it after a successful `store.record`, so a *rejected*
  write (409 duplicate / 422 invalid / 404 not-installed) doesn't evict.
- **`serve()` wiring** — `buildMarketplaceRoutes` is given
  `onInstallChange: (t) => tenantDispatcher?.invalidate(t)` (a late-bound ref, since the
  dispatcher is built after the base server; the callback only fires at request time),
  and the per-tenant `buildFor` servers now also receive the `extraRoutes`, so a tenant
  already on a composed gateway can still list/install/uninstall (and trigger the
  eviction) without falling back to the base server.

## Consequences

- **68 packages + 4 apps, 126 meta-schema tables.** New tests:
  `tenant-dispatcher.test.ts` proves `invalidate()` forces a rebuild — with the TTL
  pinned wide, a tenant 404s `GET /v1/courses` while cached on the base server, still
  404s after the install lands in the source, then serves 200 once `invalidate()` is
  called; `marketplace-routes.test.ts` proves `onInstallChange` fires with the tenant
  after install + uninstall and *not* on a rejected (409) install. No new META_ tables.
- An install/uninstall is now reflected on the next request, not after the TTL; the TTL
  remains a backstop for any change that doesn't flow through these handlers (e.g. the
  `marketplace` CLI writing directly to the store, or a write on a different process).
  JWT pre-resolution and a cross-process invalidation channel stay the follow-ups.
