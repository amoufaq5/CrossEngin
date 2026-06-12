# ADR-0209: marketplace tenant surface resolution (Phase 3 P5.3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0081 (install runtime), ADR-0207/0208 (install CLI + HTTP), ADR-0080 (Phase 3 P5) |

## Context

P5–P5.2 let a tenant install/uninstall packs (engine + store + CLI + HTTP), but an
`installed` record didn't yet connect to anything served — the question "what is this
tenant's effective surface given its installs" had no answer. Full per-tenant entity
*serving* (different tenants seeing different routes) is a large architectural change
(routes are compiled once, globally). This increment ships the bounded, foundational
slice: **resolving a tenant's installed packs into a composed surface descriptor**.

## Decision

A `PackManifestResolver` seam + a pure surface composer + a read route.

- **`apps/operate-server` `tenant-surface.ts`** — `PackManifestResolver.resolve(packId,
  version) → Manifest | null` is the seam (the real pack-manifest registry —
  third-party / signed packs — is deployment-specific).
  `buildBuiltinPackResolver()` maps marketplace pack ids
  (`BUILTIN_PACK_MARKETPLACE_IDS`, e.g. `crossengin.erp.education`) to the
  `loadBuiltinPack` aliases, returning the fully lineage-resolved manifest (or `null`
  for an unknown id). `resolveTenantSurface(installations, resolver)` composes the
  tenant's **installed** packs (a `requested`/`installing`/… pack isn't live) into a
  `TenantSurface` — each pack resolved to its entity/view contribution, plus the
  deduped + sorted union. Pure given the installations + resolver.
- **`buildMarketplaceRoutes`** — when a `resolver` is supplied, registers
  `GET /v1/marketplace/surface` → `{ surface }` for the authenticated principal's
  tenant (reads the tenant's `installed` installs from the RLS-scoped store, then
  composes). `serve()` under `--marketplace` wires `buildBuiltinPackResolver()`.

## Consequences

- **68 packages + 4 apps, 126 meta-schema tables, ~7,323 offline tests + 54 gated
  real-Postgres integration tests + six CI gates.** New tests: `tenant-surface.test.ts`
  (the composer — installed-only, unresolved unknown packs, dedupe/sort; the built-in
  resolver maps the six verticals + resolves education to its merged 8 entities) +
  `marketplace-routes.test.ts` surface cases (route registered only with a resolver;
  the handler returns the composed surface). No new META_ tables.
- A tenant/operator can now see the effective entity/view surface their installs
  contribute, resolved from the pack manifests. The deeper follow-up — compiling
  those resolved manifests into the tenant's *served* routes (per-tenant route
  matching, or a per-tenant compiled gateway) — builds directly on this resolver.
