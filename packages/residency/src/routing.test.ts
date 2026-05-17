import { describe, expect, it } from "vitest";
import { buildProfileFromTemplate } from "./profile.js";
import {
  assertSameBroadRegion,
  assertSameRegion,
  detectCrossRegionViolation,
  isLlmProviderAllowed,
  isRegionAllowed,
  selectPrimaryRegion,
} from "./routing.js";

const now = "2026-05-13T10:00:00.000Z";
const euOnly = buildProfileFromTemplate("eu-only", { establishedAt: now });
const meOnly = buildProfileFromTemplate("me-only", { establishedAt: now });

describe("isRegionAllowed", () => {
  it("approves an allowed region", () => {
    expect(isRegionAllowed(euOnly, "eu-central")).toEqual({ compatible: true });
  });

  it("rejects a forbidden region", () => {
    const r = isRegionAllowed(euOnly, "us-east");
    expect(r.compatible).toBe(false);
    if (!r.compatible) expect(r.reason).toMatch(/forbidden/);
  });

  it("rejects an unlisted (not allowed, not forbidden) region", () => {
    const custom = {
      ...euOnly,
      forbiddenRegions: [],
    };
    const r = isRegionAllowed(custom, "us-east");
    expect(r.compatible).toBe(false);
    if (!r.compatible) expect(r.reason).toMatch(/not in allowedRegions/);
  });
});

describe("selectPrimaryRegion", () => {
  it("returns the profile primary region", () => {
    expect(selectPrimaryRegion(euOnly)).toBe("eu-central");
    expect(selectPrimaryRegion(meOnly)).toBe("me-uae");
  });
});

describe("isLlmProviderAllowed", () => {
  it("approves a profile-listed provider", () => {
    expect(isLlmProviderAllowed(euOnly, "fireworks:eu").compatible).toBe(true);
  });

  it("rejects an off-profile provider", () => {
    const r = isLlmProviderAllowed(euOnly, "fireworks:us");
    expect(r.compatible).toBe(false);
    if (!r.compatible) expect(r.reason).toMatch(/not in allowedLlmProviders/);
  });
});

describe("assertSameRegion", () => {
  it("passes for identical regions", () => {
    expect(() => assertSameRegion("eu-central", "eu-central", "test")).not.toThrow();
  });

  it("throws for mismatched regions", () => {
    expect(() => assertSameRegion("eu-central", "us-east", "test")).toThrow(
      /cross-region access denied/,
    );
  });
});

describe("assertSameBroadRegion", () => {
  it("passes for two EU regions", () => {
    expect(() => assertSameBroadRegion("eu-central", "eu-west", "test")).not.toThrow();
  });

  it("throws for EU vs US", () => {
    expect(() => assertSameBroadRegion("eu-central", "us-east", "test")).toThrow(
      /cross-broad-region access denied/,
    );
  });
});

describe("detectCrossRegionViolation", () => {
  it("returns no violation for same-region attempt", () => {
    const r = detectCrossRegionViolation({
      source: "eu-central",
      target: "eu-central",
      resource: "/api/x",
      profile: euOnly,
    });
    expect(r.violation).toBe(false);
  });

  it("flags violation when target is forbidden", () => {
    const r = detectCrossRegionViolation({
      source: "eu-central",
      target: "us-east",
      resource: "/api/x",
      profile: euOnly,
    });
    expect(r.violation).toBe(true);
    if (r.violation) expect(r.reason).toMatch(/forbidden/);
  });

  it("allows cross-region within allowedRegions", () => {
    const r = detectCrossRegionViolation({
      source: "eu-central",
      target: "eu-west",
      resource: "/api/x",
      profile: euOnly,
    });
    expect(r.violation).toBe(false);
  });
});
