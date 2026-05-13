import { broadRegionOf, type Region } from "./regions.js";
import type { ResidencyProfile } from "./profile.js";

export type ResidencyCompatibility =
  | { readonly compatible: true }
  | { readonly compatible: false; readonly reason: string };

export function isRegionAllowed(profile: ResidencyProfile, region: Region): ResidencyCompatibility {
  if (profile.forbiddenRegions.includes(region)) {
    return {
      compatible: false,
      reason: `region '${region}' is forbidden by profile '${profile.profile}'`,
    };
  }
  if (!profile.allowedRegions.includes(region)) {
    return {
      compatible: false,
      reason: `region '${region}' is not in allowedRegions for profile '${profile.profile}'`,
    };
  }
  return { compatible: true };
}

export function selectPrimaryRegion(profile: ResidencyProfile): Region {
  return profile.primaryRegion;
}

export function isLlmProviderAllowed(
  profile: ResidencyProfile,
  providerRef: string,
): ResidencyCompatibility {
  if (profile.allowedLlmProviders.includes(providerRef)) {
    return { compatible: true };
  }
  return {
    compatible: false,
    reason: `provider '${providerRef}' not in allowedLlmProviders for profile '${profile.profile}'`,
  };
}

export function assertSameRegion(
  expected: Region,
  actual: Region,
  context: string,
): void {
  if (expected !== actual) {
    throw new Error(
      `cross-region access denied in ${context}: expected '${expected}', got '${actual}'`,
    );
  }
}

export function assertSameBroadRegion(
  a: Region,
  b: Region,
  context: string,
): void {
  if (broadRegionOf(a) !== broadRegionOf(b)) {
    throw new Error(
      `cross-broad-region access denied in ${context}: '${a}' and '${b}' are in different broad regions`,
    );
  }
}

export interface CrossRegionAttempt {
  readonly source: Region;
  readonly target: Region;
  readonly resource: string;
  readonly profile: ResidencyProfile;
}

export function detectCrossRegionViolation(
  attempt: CrossRegionAttempt,
): { readonly violation: true; readonly reason: string } | { readonly violation: false } {
  if (attempt.source === attempt.target) {
    return { violation: false };
  }
  const sourceAllowed = isRegionAllowed(attempt.profile, attempt.source);
  const targetAllowed = isRegionAllowed(attempt.profile, attempt.target);
  if (!sourceAllowed.compatible) {
    return {
      violation: true,
      reason: `source ${sourceAllowed.reason} (resource: ${attempt.resource})`,
    };
  }
  if (!targetAllowed.compatible) {
    return {
      violation: true,
      reason: `target ${targetAllowed.reason} (resource: ${attempt.resource})`,
    };
  }
  return { violation: false };
}
