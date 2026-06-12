# ADR-0221: AI-provider residency via the residency profile (Phase 3 P6.3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0220 (data-residency enforcement), ADR-0059 (ai-router), ADR-0010 (residency) |

## Context

P6.2 enforces a tenant's `ResidencyProfile` for **data** at the serving edge. The P6 exit
criterion's other half — "its AI calls routed to an EU-resident provider" — needs the
**same** profile to govern LLM provider selection. The `ai-router` already filters a
provider chain by a `TenantResidency` (`residencyAllowsProvider`, by the provider's served
regions), and `TenantResidency`'s values (`eu-only` / `us-only` / `me-only` /
`unrestricted`) are exactly the `@crossengin/residency` profile *templates* — but nothing
bridged a `ResidencyProfile` object to it, so the data-residency profile and the AI-routing
residency were configured independently.

## Decision

A pure bridge module in `@crossengin/ai-router` (new dep `@crossengin/residency`):

- **`residencyProfileToTenantResidency(profile)`** maps a `ResidencyProfile` to the
  router's `TenantResidency`: the named templates map directly; a `custom` profile bridges
  via `broadRegionOf(profile.primaryRegion)` (`eu` → `eu-only`, `us` → `us-only`, `me` →
  `me-only`). A profile in a broad region the router can't express (`ap` / `sa`, since
  `TenantResidency` has no such value) throws **`UnsupportedResidencyError`** — fail-closed,
  rather than silently routing to a non-resident provider.
- **`resolveProvidersForProfile(input, profile)`** is the convenience that closes the loop:
  it resolves the task's provider chain under `residencyProfileToTenantResidency(profile)`,
  so the same profile that pins a tenant's data (P6.2's `ResidencyGuard`) also confines its
  AI calls to residency-compliant providers (via the router's existing
  `residencyAllowsProvider`). It throws `ProviderResolutionError` when no compliant provider
  serves the task.

## Consequences

- **70 packages + 4 apps, 126 meta-schema tables.** `@crossengin/ai-router` gained a
  `@crossengin/residency` dep. New tests: `residency-profile.test.ts` (5 — the four named
  templates map directly; a `custom` profile bridges via its primary's broad region; `ap` /
  `sa` fail closed; `resolveProvidersForProfile` filters an EU profile's chain to the EU
  provider and throws when none serves the region). No new META_ tables (pure).
- **One residency profile now governs both halves of the P6 exit criterion** — an
  `eu-only` tenant's data is served from the EU (P6.2) *and* its AI calls resolve only to
  EU-resident providers (P6.3). The remaining P6 work is a tenant→profile store (vs. the
  CLI map / per-call argument), the geo `RegionRouter` front door, and a PG persistence
  sibling for the replication runtime.
