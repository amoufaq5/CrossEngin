import { isRegionAllowed, selectPrimaryRegion, type Region, type ResidencyProfile } from "@crossengin/residency";

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

/*
 * `RegionRouter` — the stateful class that resolved a profile from a directory and denied a tenant
 * with none — is deleted (ADR-0472). It was constructed only by its own test, and the post-auth
 * residency decision it was declared as waiting for exists: `apps/operate-server`'s
 * `residency-gate.ts` (`applyResidencyGate`, ADR-0451) wraps every handler, reads the
 * **authenticated** tenant, and calls `decideRegionRouting` above. A callerless second spelling of
 * live code is deleted rather than kept (ADR-0337), and the one real difference between the two —
 * the class denied an unprofiled tenant where the gate serves one — is a decision the gate makes
 * and documents, not one a class nothing constructs can make for it.
 */
