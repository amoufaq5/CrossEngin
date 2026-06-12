import {
  pickRegion,
  rulesForCountry,
  type RoutingDecision,
  type RoutingStrategy,
  type RoutingTable,
} from "@crossengin/edge";
import {
  isRegionAllowed,
  selectPrimaryRegion,
  type Region,
  type ResidencyProfile,
} from "@crossengin/residency";

/** One inbound request to resolve to a serving region. */
export interface RouteRequest {
  /** ISO-3166 country of the caller (drives the routing table). */
  readonly country: string;
  /** The tenant's residency profile, when it is residency-bound. Absent ⇒ no residency constraint. */
  readonly profile?: ResidencyProfile;
  /** A sticky-session region preference (e.g. from an affinity cookie). */
  readonly affinityRegion?: Region;
}

export const ROUTE_REASONS = [
  "affinity",
  "routing_table",
  "residency_override",
  "residency_primary",
  "blackhole",
  "no_rule",
] as const;
export type RouteReason = (typeof ROUTE_REASONS)[number];

/** The router's verdict for one request. */
export interface RouteResult {
  /** The chosen serving region, or `null` when the request is dropped (blackhole / no rule + no residency). */
  readonly region: Region | null;
  readonly decision: RoutingDecision;
  readonly strategy: RoutingStrategy | null;
  readonly reason: RouteReason;
  /** Whether a residency profile constrained the choice (the region is guaranteed residency-allowed). */
  readonly residencyEnforced: boolean;
}

export interface RegionRouterOptions {
  readonly table: RoutingTable;
  /** Injected RNG for the `weighted` strategy (deterministic in tests). */
  readonly random?: () => number;
}

/** True when `region` is permitted by the profile (or there is no profile). */
function residencyAllows(profile: ResidencyProfile | undefined, region: Region): boolean {
  return profile === undefined || isRegionAllowed(profile, region).compatible;
}

/**
 * Resolves an inbound request to a serving region, honoring (in order) sticky
 * affinity, the geo routing table, and — authoritatively — the tenant's residency
 * profile. **Residency is non-negotiable:** a sticky/geo pick outside the profile's
 * allowed regions is overridden to the profile's primary region (`residency_override`),
 * and a residency-bound request with no matching routing rule still serves the
 * residency primary rather than dropping. A `blackhole` rule (or no rule + no
 * residency) yields `region: null` (the request is dropped).
 */
export class RegionRouter {
  private readonly table: RoutingTable;
  private readonly random: () => number;

  constructor(opts: RegionRouterOptions) {
    this.table = opts.table;
    this.random = opts.random ?? ((): number => Math.random());
  }

  resolve(request: RouteRequest): RouteResult {
    const profile = request.profile;
    const enforced = profile !== undefined;

    // 1. Sticky affinity wins when it is residency-allowed.
    if (request.affinityRegion !== undefined && residencyAllows(profile, request.affinityRegion)) {
      return { region: request.affinityRegion, decision: "primary", strategy: null, reason: "affinity", residencyEnforced: enforced };
    }

    // 2. Geo routing table: the first (lowest-priority-number) rule for the country.
    const rule = rulesForCountry(this.table, request.country)[0];
    if (rule === undefined) {
      // No rule: a residency-bound tenant still serves its primary; otherwise drop.
      if (profile !== undefined) {
        return { region: selectPrimaryRegion(profile), decision: "primary", strategy: null, reason: "residency_primary", residencyEnforced: true };
      }
      return { region: null, decision: "blackhole", strategy: null, reason: "no_rule", residencyEnforced: false };
    }

    const picked = pickRegion(rule, this.random());
    if (picked === null) {
      return { region: null, decision: "blackhole", strategy: rule.strategy, reason: "blackhole", residencyEnforced: false };
    }

    // 3. Residency enforcement: override an out-of-profile pick to the primary.
    if (profile !== undefined && !isRegionAllowed(profile, picked).compatible) {
      return { region: selectPrimaryRegion(profile), decision: "redirect", strategy: rule.strategy, reason: "residency_override", residencyEnforced: true };
    }
    return { region: picked, decision: rule.decision, strategy: rule.strategy, reason: "routing_table", residencyEnforced: enforced };
  }
}
