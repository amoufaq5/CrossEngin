import { describe, expect, it } from "vitest";
import {
  DATA_CLASS_TIER,
  DEFAULT_DR_TIERS,
  DR_TIERS,
  DrTierSpecSchema,
  REPLICATION_KINDS,
  tierForDataClass,
  tierMeetsTarget,
  type DrTierSpec,
} from "./tiers.js";

describe("constants", () => {
  it("DR_TIERS has 5 entries", () => {
    expect(DR_TIERS).toHaveLength(5);
    expect(DR_TIERS[0]).toBe("tier_0_mission_critical");
    expect(DR_TIERS[4]).toBe("tier_4_best_effort");
  });

  it("REPLICATION_KINDS has 4 entries", () => {
    expect(REPLICATION_KINDS).toEqual(["sync", "async", "snapshot", "none"]);
  });

  it("DEFAULT_DR_TIERS covers every DrTier", () => {
    for (const tier of DR_TIERS) {
      expect(DEFAULT_DR_TIERS[tier]).toBeDefined();
      expect(DEFAULT_DR_TIERS[tier].tier).toBe(tier);
    }
  });

  it("tier_0 is sync with zero RPO", () => {
    const t0 = DEFAULT_DR_TIERS.tier_0_mission_critical;
    expect(t0.replicationKind).toBe("sync");
    expect(t0.maxRpoSeconds).toBe(0);
    expect(t0.requiresCrossRegion).toBe(true);
  });

  it("tier_4 has no replication", () => {
    const t4 = DEFAULT_DR_TIERS.tier_4_best_effort;
    expect(t4.replicationKind).toBe("none");
    expect(t4.requiresCrossRegion).toBe(false);
  });
});

describe("DATA_CLASS_TIER mapping", () => {
  it("phi and regulated map to tier_0", () => {
    expect(DATA_CLASS_TIER.phi).toBe("tier_0_mission_critical");
    expect(DATA_CLASS_TIER.regulated).toBe("tier_0_mission_critical");
  });

  it("pii and commercial_sensitive map to tier_1", () => {
    expect(DATA_CLASS_TIER.pii).toBe("tier_1_business_critical");
    expect(DATA_CLASS_TIER.commercial_sensitive).toBe("tier_1_business_critical");
  });

  it("internal maps to tier_2", () => {
    expect(DATA_CLASS_TIER.internal).toBe("tier_2_important");
  });

  it("public maps to tier_3", () => {
    expect(DATA_CLASS_TIER.public).toBe("tier_3_recoverable");
  });
});

describe("DrTierSpecSchema", () => {
  const base: DrTierSpec = {
    tier: "tier_1_business_critical",
    label: "Business critical",
    maxRpoSeconds: 60,
    maxRtoSeconds: 900,
    replicationKind: "async",
    backupFrequencySeconds: 3600,
    retentionDays: 365,
    requiresCrossRegion: true,
    requiresDrillCadenceDays: 90,
  };

  it("accepts a valid tier_1 spec", () => {
    expect(() => DrTierSpecSchema.parse(base)).not.toThrow();
  });

  it("rejects sync replication with non-zero RPO", () => {
    expect(() =>
      DrTierSpecSchema.parse({
        ...base,
        replicationKind: "sync",
        maxRpoSeconds: 30,
      }),
    ).toThrow(/sync replication implies zero RPO/);
  });

  it("rejects replicationKind='none' with requiresCrossRegion=true", () => {
    expect(() =>
      DrTierSpecSchema.parse({
        ...base,
        replicationKind: "none",
        maxRpoSeconds: 86_400,
        requiresCrossRegion: true,
      }),
    ).toThrow(/incompatible with requiresCrossRegion/);
  });

  it("rejects retention shorter than one RPO window", () => {
    expect(() =>
      DrTierSpecSchema.parse({
        ...base,
        retentionDays: 1,
        maxRpoSeconds: 200_000,
      }),
    ).toThrow(/retentionDays must cover/);
  });
});

describe("helpers", () => {
  it("tierForDataClass resolves to the right tier spec", () => {
    expect(tierForDataClass("phi").tier).toBe("tier_0_mission_critical");
    expect(tierForDataClass("public").tier).toBe("tier_3_recoverable");
  });

  it("tierMeetsTarget returns true when both targets are met", () => {
    const spec = DEFAULT_DR_TIERS.tier_1_business_critical;
    expect(tierMeetsTarget(spec, 30, 600)).toBe(true);
  });

  it("tierMeetsTarget returns false when RPO is exceeded", () => {
    const spec = DEFAULT_DR_TIERS.tier_1_business_critical;
    expect(tierMeetsTarget(spec, 120, 600)).toBe(false);
  });

  it("tierMeetsTarget returns false when RTO is exceeded", () => {
    const spec = DEFAULT_DR_TIERS.tier_1_business_critical;
    expect(tierMeetsTarget(spec, 30, 1800)).toBe(false);
  });
});
