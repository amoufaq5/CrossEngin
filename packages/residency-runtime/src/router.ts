import { isRegionAllowed, selectPrimaryRegion, type Region, type ResidencyProfile } from "@crossengin/residency";

import type { TenantResidencyDirectory } from "./directory.js";

/**
 * What a serving region should do with a request for a tenant:
 * - `serve` — this region is allowed; handle it here.
 * - `redirect` — this region can't serve the tenant; send it to `region` (the home).
 * - `deny` — no allowed region can serve it here and there's no home to redirect to
 *   (e.g. an unknown tenant, or the home region is itself forbidden — a contradiction).
 */
export type RoutingDecision =
  | { readonly action: "serve"; readonly region: Region }
  | { readonly action: "redirect"; readonly region: Region; readonly reason: string }
  | { readonly action: "deny"; readonly reason: string };

/**
 * Pure routing decision for one tenant's profile at a serving region. Fail-closed:
 * serves only when the region is explicitly allowed; otherwise redirects to the
 * primary (home) region when that is servable, else denies.
 */
export function decideRegionRouting(profile: ResidencyProfile, servingRegion: Region): RoutingDecision {
  const here = isRegionAllowed(profile, servingRegion);
  if (here.compatible) return { action: "serve", region: servingRegion };

  const primary = selectPrimaryRegion(profile);
  if (primary !== servingRegion && isRegionAllowed(profile, primary).compatible) {
    return { action: "redirect", region: primary, reason: here.reason };
  }
  return { action: "deny", reason: here.reason };
}

export interface RegionRouteRequest {
  readonly tenantId: string;
  readonly servingRegion: Region;
}

/**
 * Resolves a tenant's residency profile from a directory and decides how the
 * serving region should handle the request. An unknown tenant denies (fail-closed) —
 * a request is never served without a residency profile to authorize the region.
 */
export class RegionRouter {
  constructor(private readonly directory: TenantResidencyDirectory) {}

  async route(request: RegionRouteRequest): Promise<RoutingDecision> {
    const profile = await this.directory.resolve(request.tenantId);
    if (profile === null) {
      return { action: "deny", reason: `no residency profile for tenant '${request.tenantId}'` };
    }
    return decideRegionRouting(profile, request.servingRegion);
  }
}
