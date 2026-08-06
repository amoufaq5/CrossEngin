# ADR-0216: `residency-runtime` — region routing + failover selection (Phase 3 P6)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0077 (P3 plan — P6 multi-region); `residency` + `active-active` + `edge` contracts |

## Context

Phase 3 P6 (ADR-0077) is multi-region. The `residency` package already models the region catalog,
residency profiles (primary / allowed / forbidden regions), and pure compatibility helpers
(`isRegionAllowed`, `selectPrimaryRegion`, `detectCrossRegionViolation`, `broadRegionOf`), but nothing
turns them into serving-edge decisions. This adds the first P6 runtime — a pure region-routing engine —
mirroring how `marketplace-runtime` (pure) preceded its persistence + HTTP wiring. It has no META tables
and no serving-app wiring yet; those are the P6.5/P6.6 follow-ups.

## Decision

`@crossengin/residency-runtime` — pure, over the `residency` contracts. 3 modules:

- **directory** — `TenantResidencyDirectory` (structural `resolve(tenantId) → ResidencyProfile | null`,
  sync or async so a Postgres-backed directory drops in later) + `InMemoryTenantResidencyDirectory`.
- **router** — `decideRegionRouting(profile, servingRegion) → RoutingDecision` where a decision is
  `serve(region)` / `redirect(region, reason)` / `deny(reason)`. **Fail-closed**: it serves only when the
  region is explicitly allowed; otherwise it redirects to the primary (home) region when that is
  servable, else denies. `RegionRouter(directory).route({tenantId, servingRegion})` resolves the profile
  first — an **unknown tenant denies** (never served without a residency profile to authorize the
  region).
- **affinity** — `selectServingRegion(profile, available) → Region | null`, the failover pick when the
  primary is down: prefer the primary if available, else an available *allowed* region in the same broad
  region as the primary (the closest residency-compatible fallback — e.g. `eu-west` for an `eu-central`
  primary), else any available allowed region; **`null`** when no available region is allowed (never
  leaks a tenant to a forbidden region). Ties break on `available` order, so the caller controls priority.

## Consequences

- The serving edge now has the decision primitives for data residency: given "which region am I" + a
  tenant's profile, it knows whether to serve, where to redirect, or to deny — and, for active-active
  failover, which live region may take over without violating residency.
- Every path is fail-closed: no profile → deny; region not explicitly allowed → never served here; no
  allowed region available → `null` rather than a forbidden fallback. Residency is enforced by
  construction, not by convention.
- Pure and dependency-light (only `residency`), so it composes into `operate-server` (a pre-dispatch
  region guard using the resolved principal's tenant) and into the `active-active`/`edge` runtimes
  without pulling persistence.
- 7,254 tests pass (+14: serve/redirect on allowed/forbidden regions, router serve/redirect/deny +
  async directory, affinity primary-preferred / same-broad-fallback / null-when-none-allowed /
  empty / unrestricted). Full build + typecheck green.
- Follow-ups: a Postgres `TenantResidencyDirectory` over a tenant-region table; an `operate-server`
  region guard (`--region <id>`) that redirects/denies per this engine before dispatch; wiring the
  `active-active` failover to `selectServingRegion`.
