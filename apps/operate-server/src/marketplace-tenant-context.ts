import { COMPLIANCE_PACKS, type TenantContext } from "@crossengin/marketplace";
import type { Region } from "@crossengin/residency";
import type { TenantResidencyDirectory } from "@crossengin/residency-runtime";

/**
 * Where each fact a pack's compatibility envelope can constrain comes from, for one deployment.
 *
 * Two of the five have a source and three do not, and the three are `null` on every tenant rather
 * than a default: a fabricated `planTier: "professional"` admitted a pack requiring that tier for a
 * tenant on any plan, and a fabricated `region: "us-east"` admitted a pack that blocks an EU region
 * for an EU tenant. `null` refuses only a pack that constrains the fact (`checkCompatibility`), so a
 * pack that names no plan tier installs and one that names one is refused with the reason.
 */
export interface MarketplaceTenantFactSources {
  /** `--marketplace-platform-version`; the build carries no version of its own worth comparing. */
  readonly platformVersion: string | null;
  /** `--region`: where a tenant's data lives when no residency profile says otherwise. */
  readonly deploymentRegion: Region | null;
  /** A tenant's residency profile, whose primary region outranks the deployment's. */
  readonly residency: () => TenantResidencyDirectory | undefined;
}

/** Why each fact with no source has none — printed at boot so the refusal is not a surprise. */
export const MARKETPLACE_UNSOURCED_FACTS = Object.freeze({
  planTier: "no plan catalog in this deployment carries a tier in the marketplace's vocabulary",
  compliancePacks:
    "no compliance-pack resolver runs, so a manifest's meta.compliancePacks is a declaration and not evidence",
  isDedicatedTenant: "nothing in this deployment records whether a tenant is dedicated",
});

export function buildMarketplaceTenantContext(
  sources: MarketplaceTenantFactSources,
): (tenantId: string) => Promise<TenantContext> {
  return async (tenantId) => ({
    platformVersion: sources.platformVersion,
    region: await regionFor(sources, tenantId),
    planTier: null,
    compliancePacks: null,
    isDedicatedTenant: null,
  });
}

async function regionFor(sources: MarketplaceTenantFactSources, tenantId: string): Promise<Region | null> {
  const directory = sources.residency();
  if (directory !== undefined) {
    // A lookup that fails reads as *not known*, which can only refuse a region-constrained pack; it
    // must not fall through to the deployment's region, which is the guess this module exists to stop.
    try {
      const profile = await directory.resolve(tenantId);
      if (profile !== null) return profile.primaryRegion;
    } catch {
      return null;
    }
  }
  return sources.deploymentRegion;
}

/**
 * The `[marketplace]` boot line: which facts this deployment can supply and why the others are
 * unknown, plus the manifest's declared compliance ids against the marketplace's vocabulary — the
 * two spell some packs differently (`uae-moh` / `uae_moh`) and most declared ids have no marketplace
 * counterpart at all, which is worth seeing before a `requiredCompliancePacks` refusal.
 */
export function formatMarketplaceTenantFacts(
  sources: Omit<MarketplaceTenantFactSources, "residency"> & { readonly residencyConfigured: boolean },
  declaredCompliancePacks: readonly string[],
): string {
  const vocabulary = new Set<string>(COMPLIANCE_PACKS);
  const outside = declaredCompliancePacks.filter((id) => !vocabulary.has(id));
  const region =
    sources.residencyConfigured
      ? `a tenant's residency primary region, else ${sources.deploymentRegion ?? "unknown"}`
      : (sources.deploymentRegion ?? "unknown (no --region)");
  return [
    `[marketplace] tenant facts for pack compatibility: platform version ${sources.platformVersion ?? "unknown (no --marketplace-platform-version)"}; region ${region}`,
    ...Object.entries(MARKETPLACE_UNSOURCED_FACTS).map(
      ([fact, why]) => `[marketplace]   ${fact}: unknown — ${why}; a pack constraining it is refused`,
    ),
    `[marketplace]   manifest declares compliance packs: ${declaredCompliancePacks.length === 0 ? "none" : declaredCompliancePacks.join(", ")}` +
      (outside.length > 0 ? ` (${outside.length.toString()} outside the marketplace vocabulary: ${outside.join(", ")})` : ""),
  ].join("\n");
}
