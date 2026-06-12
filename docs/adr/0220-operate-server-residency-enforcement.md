# ADR-0220: residency enforcement at the serving edge (Phase 3 P6.2)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0219 (edge runtime), ADR-0010 (residency), ADR-0211 (per-tenant dispatch) |

## Context

P6.1 built `edge-runtime` (residency-aware routing) as a pure package, but nothing
*enforced* residency in the running serving binary. The P6 exit criterion's data half — "a
tenant pinned to `eu-central` has its writes served + stored in EU" — needs the serving
instance to **refuse** a residency-bound tenant whose data may not be served from this
instance's region.

## Decision

`apps/operate-server` gains a `ResidencyGuard` dispatcher wrapper (the outermost layer over
the base server / `TenantDispatcher`) that enforces residency before the gateway runs.

- **`residency-guard.ts`** — `parseTenantResidencySpec("<tenantId>:<template>")` binds a
  tenant to a residency profile via `@crossengin/residency`'s `buildProfileFromTemplate`
  (templates `eu-only` / `us-only` / `me-only` / `unrestricted`); `parseRegion` validates a
  region against the 8 known regions. `ResidencyGuard.dispatchWithMatch` pre-resolves the
  request's tenant (the **same** credential→tenant resolver the per-tenant dispatcher uses
  — `firstTenantOf([apiKeyTenantResolver, bearerJwtTenantResolver])`, a map lookup, no
  crypto) and, if that tenant is residency-bound and `isRegionAllowed(profile, thisRegion)`
  is false, short-circuits with a **`421 Misdirected Request`** RFC-9457 problem document
  naming the region it should route to (`selectPrimaryRegion(profile)`, in both the body
  `extensions` and an `x-crossengin-required-region` header). Unbound tenants — or tenants
  this region *is* allowed to serve — pass through unchanged; the inner gateway still runs
  the full auth + RBAC.
- **CLI** — `--region <region>` (the region this instance serves; enables enforcement) +
  repeatable `--tenant-residency <tenantId>:<template>` (requires `--region`). `serve()`
  wraps `dispatchTarget` in the guard when both are set, composing cleanly with the
  marketplace `TenantDispatcher` (the guard is the outer layer, so a misdirected request is
  rejected before any per-tenant gateway work).

## Consequences

- **70 packages + 4 apps, 126 meta-schema tables.** `apps/operate-server` gained a
  `@crossengin/residency` dep. New tests: `residency-guard.test.ts` (spec/region parsing;
  a 421 with the primary region + `reached:false` for a forbidden region; pass-through for
  an allowed region / unbound tenant / unresolvable credential) + a CLI case. No new META_
  tables (enforcement is request-time, stateless).
- **Data residency is now enforced at the API edge** — an `eu-only` tenant hitting a
  `us-east` instance is told (421) to route to `eu-central`, before any data is read or
  written. The AI-provider residency half (`isLlmProviderAllowed` over the router's chosen
  region) and a tenant→profile *store* (vs. the CLI map) — plus the geo `RegionRouter`
  driving an actual multi-region front door — are the remaining P6 increments.
