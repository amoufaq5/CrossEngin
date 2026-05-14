import { describe, expect, it } from "vitest";
import {
  COMPLIANCE_PACKS,
  PLAN_TIERS,
  PLAN_TIER_RANK,
  PackCompatibilitySchema,
  checkCompatibility,
  packMatchesPlatform,
  type PackCompatibility,
  type TenantContext,
} from "./compatibility.js";

describe("constants", () => {
  it("PLAN_TIERS has 5 entries", () => {
    expect(PLAN_TIERS).toContain("trial");
    expect(PLAN_TIERS).toContain("enterprise");
  });

  it("PLAN_TIER_RANK orders enterprise > professional > base > non_profit > trial", () => {
    expect(PLAN_TIER_RANK.enterprise).toBeGreaterThan(PLAN_TIER_RANK.professional);
    expect(PLAN_TIER_RANK.professional).toBeGreaterThan(PLAN_TIER_RANK.base);
    expect(PLAN_TIER_RANK.base).toBeGreaterThan(PLAN_TIER_RANK.non_profit);
    expect(PLAN_TIER_RANK.non_profit).toBeGreaterThan(PLAN_TIER_RANK.trial);
  });

  it("COMPLIANCE_PACKS has 5 entries", () => {
    expect(COMPLIANCE_PACKS).toContain("hipaa");
    expect(COMPLIANCE_PACKS).toContain("gdpr");
    expect(COMPLIANCE_PACKS).toContain("uae_moh");
  });
});

describe("PackCompatibilitySchema", () => {
  const base: PackCompatibility = {
    minPlatformVersion: "1.0.0",
    allowedRegions: ["eu-central"],
    blockedRegions: [],
    requiredCompliancePacks: ["hipaa"],
    requiresDedicatedTenant: false,
  };

  it("accepts a valid spec", () => {
    expect(() => PackCompatibilitySchema.parse(base)).not.toThrow();
  });

  it("rejects maxPlatformVersion <= minPlatformVersion", () => {
    expect(() =>
      PackCompatibilitySchema.parse({
        ...base,
        minPlatformVersion: "2.0.0",
        maxPlatformVersion: "1.0.0",
      }),
    ).toThrow(/strictly greater than minPlatformVersion/);
  });

  it("rejects region appearing in both allowed and blocked", () => {
    expect(() =>
      PackCompatibilitySchema.parse({
        ...base,
        blockedRegions: ["eu-central"],
      }),
    ).toThrow(/cannot appear in both/);
  });

  it("rejects duplicate compliance packs", () => {
    expect(() =>
      PackCompatibilitySchema.parse({
        ...base,
        requiredCompliancePacks: ["hipaa", "hipaa"],
      }),
    ).toThrow(/duplicate compliance pack/);
  });
});

describe("checkCompatibility", () => {
  const tenant: TenantContext = {
    platformVersion: "1.2.0",
    region: "eu-central",
    planTier: "professional",
    compliancePacks: ["hipaa", "gdpr"],
    isDedicatedTenant: false,
  };

  it("returns compatible when all checks pass", () => {
    const r = checkCompatibility(
      {
        minPlatformVersion: "1.0.0",
        allowedRegions: ["eu-central"],
        blockedRegions: [],
        requiredCompliancePacks: ["hipaa"],
        requiresDedicatedTenant: false,
      },
      tenant,
    );
    expect(r.compatible).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("flags platform version too old", () => {
    const r = checkCompatibility(
      {
        minPlatformVersion: "2.0.0",
        allowedRegions: [],
        blockedRegions: [],
        requiredCompliancePacks: [],
        requiresDedicatedTenant: false,
      },
      tenant,
    );
    expect(r.compatible).toBe(false);
    expect(r.reasons[0]).toContain("below minPlatformVersion");
  });

  it("flags platform version too new", () => {
    const r = checkCompatibility(
      {
        minPlatformVersion: "1.0.0",
        maxPlatformVersion: "1.1.0",
        allowedRegions: [],
        blockedRegions: [],
        requiredCompliancePacks: [],
        requiresDedicatedTenant: false,
      },
      tenant,
    );
    expect(r.compatible).toBe(false);
    expect(r.reasons[0]).toContain("exceeds maxPlatformVersion");
  });

  it("flags blocked region", () => {
    const r = checkCompatibility(
      {
        minPlatformVersion: "1.0.0",
        allowedRegions: [],
        blockedRegions: ["eu-central"],
        requiredCompliancePacks: [],
        requiresDedicatedTenant: false,
      },
      tenant,
    );
    expect(r.compatible).toBe(false);
    expect(r.reasons[0]).toContain("blocked");
  });

  it("flags region not in allowed list", () => {
    const r = checkCompatibility(
      {
        minPlatformVersion: "1.0.0",
        allowedRegions: ["us-east"],
        blockedRegions: [],
        requiredCompliancePacks: [],
        requiresDedicatedTenant: false,
      },
      tenant,
    );
    expect(r.compatible).toBe(false);
    expect(r.reasons[0]).toContain("not in allowedRegions");
  });

  it("flags plan tier too low", () => {
    const r = checkCompatibility(
      {
        minPlatformVersion: "1.0.0",
        allowedRegions: [],
        blockedRegions: [],
        requiredPlanTier: "enterprise",
        requiredCompliancePacks: [],
        requiresDedicatedTenant: false,
      },
      tenant,
    );
    expect(r.compatible).toBe(false);
    expect(r.reasons[0]).toContain("below required 'enterprise'");
  });

  it("flags missing compliance pack", () => {
    const r = checkCompatibility(
      {
        minPlatformVersion: "1.0.0",
        allowedRegions: [],
        blockedRegions: [],
        requiredCompliancePacks: ["uae_moh"],
        requiresDedicatedTenant: false,
      },
      tenant,
    );
    expect(r.compatible).toBe(false);
    expect(r.reasons[0]).toContain("uae_moh");
  });

  it("flags requiresDedicatedTenant on shared tenant", () => {
    const r = checkCompatibility(
      {
        minPlatformVersion: "1.0.0",
        allowedRegions: [],
        blockedRegions: [],
        requiredCompliancePacks: [],
        requiresDedicatedTenant: true,
      },
      tenant,
    );
    expect(r.compatible).toBe(false);
    expect(r.reasons[0]).toContain("dedicated tenant");
  });

  it("collects multiple reasons", () => {
    const r = checkCompatibility(
      {
        minPlatformVersion: "2.0.0",
        allowedRegions: [],
        blockedRegions: ["eu-central"],
        requiredCompliancePacks: ["uae_moh"],
        requiresDedicatedTenant: false,
      },
      tenant,
    );
    expect(r.compatible).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe("packMatchesPlatform", () => {
  const minOnly = {
    id: "com.crossengin.x" as const,
    name: "x",
    description: "x",
    kind: "ai_tool" as const,
    author: {
      kind: "crossengin_official" as const,
      name: "x",
      verifiedAt: "2026-01-01T00:00:00Z",
    },
    license: "MIT" as const,
    keywords: [],
    requiredScopes: [],
    optionalScopes: [],
    dependencies: [],
    minPlatformVersion: "1.0.0",
    requiresNetworkAccess: false,
    requiresPhiAccess: false,
    handlesUserData: false,
  };

  it("returns true when platform >= min", () => {
    expect(packMatchesPlatform(minOnly, "1.5.0")).toBe(true);
  });

  it("returns false when platform < min", () => {
    expect(packMatchesPlatform(minOnly, "0.9.0")).toBe(false);
  });

  it("returns false when platform > max", () => {
    expect(
      packMatchesPlatform({ ...minOnly, maxPlatformVersion: "1.5.0" }, "2.0.0"),
    ).toBe(false);
  });
});
