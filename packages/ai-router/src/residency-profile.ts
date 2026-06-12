import type { TenantResidency } from "@crossengin/ai-providers";
import { broadRegionOf, type BroadRegion, type ResidencyProfile } from "@crossengin/residency";

import { resolveProviders, type ResolveInput, type ResolvedProviderChoice } from "./resolve.js";

/**
 * Thrown when a residency profile cannot be expressed in the AI router's coarser
 * `TenantResidency` model (which covers only eu / us / me + unrestricted), so the
 * router can't *guarantee* a residency-compliant provider — fail-closed.
 */
export class UnsupportedResidencyError extends Error {
  readonly kind = "unsupported_residency" as const;

  constructor(message: string) {
    super(message);
    this.name = "UnsupportedResidencyError";
  }

  isRetryable(): boolean {
    return false;
  }
}

const BROAD_TO_RESIDENCY: Partial<Record<BroadRegion, TenantResidency>> = {
  eu: "eu-only",
  us: "us-only",
  me: "me-only",
};

/**
 * Bridges a `@crossengin/residency` `ResidencyProfile` (the same profile that pins a
 * tenant's *data* residency — see operate-server's ResidencyGuard, P6.2) to the AI
 * router's `TenantResidency`, so one profile governs both where a tenant's data lives
 * and which LLM providers its AI calls may use. The named templates map directly; a
 * `custom` profile is bridged via the broad region of its `primaryRegion`. A profile
 * in a broad region the router can't express (`ap` / `sa`) throws
 * `UnsupportedResidencyError` rather than silently routing to a non-resident provider.
 */
export function residencyProfileToTenantResidency(profile: ResidencyProfile): TenantResidency {
  switch (profile.profile) {
    case "eu-only":
    case "us-only":
    case "me-only":
    case "unrestricted":
      return profile.profile;
    case "custom": {
      const broad = broadRegionOf(profile.primaryRegion);
      const mapped = BROAD_TO_RESIDENCY[broad];
      if (mapped === undefined) {
        throw new UnsupportedResidencyError(
          `custom residency profile in broad region '${broad}' has no AI-router residency equivalent (only eu/us/me)`,
        );
      }
      return mapped;
    }
  }
}

/**
 * Resolves the provider chain for a task **under a tenant's residency profile** — the
 * convenience that closes the P6 loop: pass the same `ResidencyProfile` used for data
 * residency and the AI calls are filtered to residency-compliant providers (via the
 * router's existing `residencyAllowsProvider`). Throws `ProviderResolutionError` when
 * no residency-compliant provider serves the task.
 */
export function resolveProvidersForProfile(
  input: Omit<ResolveInput, "residency">,
  profile: ResidencyProfile,
): readonly ResolvedProviderChoice[] {
  return resolveProviders({ ...input, residency: residencyProfileToTenantResidency(profile) });
}
