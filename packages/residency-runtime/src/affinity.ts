import { broadRegionOf, isRegionAllowed, type Region, type ResidencyProfile } from "@crossengin/residency";

/**
 * Picks the best serving region for a tenant from the currently-available regions —
 * the failover selection when the primary is down. Preference order, all constrained
 * to regions the profile *allows*:
 *   1. the primary region, if available;
 *   2. an available allowed region in the same broad region as the primary (closest
 *      residency-compatible fallback — e.g. eu-west for an eu-central primary);
 *   3. any available allowed region.
 * Returns `null` when no available region is allowed (the tenant cannot be served
 * anywhere right now — fail-closed, never leaks to a forbidden region). Ties break
 * on the order of `available`, so the caller controls priority.
 */
export function selectServingRegion(profile: ResidencyProfile, available: readonly Region[]): Region | null {
  const allowedAvailable = available.filter((r) => isRegionAllowed(profile, r).compatible);
  if (allowedAvailable.length === 0) return null;

  const primary = profile.primaryRegion;
  if (allowedAvailable.includes(primary)) return primary;

  const primaryBroad = broadRegionOf(primary);
  const sameBroad = allowedAvailable.find((r) => broadRegionOf(r) === primaryBroad);
  return sameBroad ?? allowedAvailable[0] ?? null;
}
