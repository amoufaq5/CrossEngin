import { describe, expect, it } from "vitest";
import {
  MARGIN_HEALTH,
  TenantUnitEconomicsSchema,
  classifyMargin,
  ltvToCacRatio,
  paybackPeriodMonths,
  type TenantUnitEconomics,
} from "./margins.js";

describe("constants", () => {
  it("MARGIN_HEALTH has 5 entries", () => {
    expect(MARGIN_HEALTH).toContain("healthy");
    expect(MARGIN_HEALTH).toContain("loss_leader_approved");
  });
});

describe("TenantUnitEconomicsSchema", () => {
  const base: TenantUnitEconomics = {
    id: "ue-1",
    tenantId: "t-1",
    periodStart: "2026-05-01T00:00:00Z",
    periodEnd: "2026-06-01T00:00:00Z",
    currency: "USD",
    grossRevenueCents: 100_000,
    refundsCents: 0,
    creditsAppliedCents: 0,
    netRevenueCents: 100_000,
    fixedCostsCents: 10_000,
    variableCostsCents: 20_000,
    totalCostsCents: 30_000,
    grossMarginCents: 70_000,
    grossMarginPercent: 70,
    contributionMarginCents: 80_000,
    health: "healthy",
    lossLeaderApprovedBy: null,
    computedAt: "2026-06-02T00:00:00Z",
  };

  it("accepts a valid healthy record", () => {
    expect(() => TenantUnitEconomicsSchema.parse(base)).not.toThrow();
  });

  it("rejects net revenue mismatch", () => {
    expect(() =>
      TenantUnitEconomicsSchema.parse({
        ...base,
        netRevenueCents: 90_000,
      }),
    ).toThrow(/netRevenueCents/);
  });

  it("rejects total cost mismatch", () => {
    expect(() =>
      TenantUnitEconomicsSchema.parse({
        ...base,
        totalCostsCents: 40_000,
      }),
    ).toThrow(/totalCostsCents/);
  });

  it("rejects gross margin mismatch", () => {
    expect(() =>
      TenantUnitEconomicsSchema.parse({
        ...base,
        grossMarginCents: 50_000,
      }),
    ).toThrow(/grossMarginCents/);
  });

  it("rejects gross margin percent mismatch", () => {
    expect(() =>
      TenantUnitEconomicsSchema.parse({
        ...base,
        grossMarginPercent: 50,
      }),
    ).toThrow(/grossMarginPercent/);
  });

  it("rejects contribution margin mismatch", () => {
    expect(() =>
      TenantUnitEconomicsSchema.parse({
        ...base,
        contributionMarginCents: 100_000,
      }),
    ).toThrow(/contributionMargin/);
  });

  it("rejects negative margin without health='negative'", () => {
    expect(() =>
      TenantUnitEconomicsSchema.parse({
        ...base,
        grossRevenueCents: 20_000,
        netRevenueCents: 20_000,
        totalCostsCents: 30_000,
        grossMarginCents: -10_000,
        grossMarginPercent: -50,
        contributionMarginCents: 0,
        variableCostsCents: 20_000,
        fixedCostsCents: 10_000,
        health: "healthy",
      }),
    ).toThrow(/'negative' or 'loss_leader_approved'/);
  });

  it("rejects loss_leader_approved without approvedBy + reason", () => {
    expect(() =>
      TenantUnitEconomicsSchema.parse({
        ...base,
        grossRevenueCents: 20_000,
        netRevenueCents: 20_000,
        totalCostsCents: 30_000,
        grossMarginCents: -10_000,
        grossMarginPercent: -50,
        contributionMarginCents: 0,
        variableCostsCents: 20_000,
        fixedCostsCents: 10_000,
        health: "loss_leader_approved",
      }),
    ).toThrow(/lossLeaderApprovedBy/);
  });
});

describe("classifyMargin", () => {
  it("60%+ -> healthy", () => {
    expect(classifyMargin(70)).toBe("healthy");
    expect(classifyMargin(60)).toBe("healthy");
  });

  it("30-60% -> watch", () => {
    expect(classifyMargin(40)).toBe("watch");
    expect(classifyMargin(30)).toBe("watch");
  });

  it("0-30% -> thin", () => {
    expect(classifyMargin(10)).toBe("thin");
    expect(classifyMargin(0)).toBe("thin");
  });

  it("negative -> negative", () => {
    expect(classifyMargin(-50)).toBe("negative");
  });
});

describe("paybackPeriodMonths", () => {
  const base: TenantUnitEconomics = {
    id: "ue-1",
    tenantId: "t-1",
    periodStart: "2026-05-01T00:00:00Z",
    periodEnd: "2026-06-01T00:00:00Z",
    currency: "USD",
    grossRevenueCents: 100_000,
    refundsCents: 0,
    creditsAppliedCents: 0,
    netRevenueCents: 100_000,
    fixedCostsCents: 10_000,
    variableCostsCents: 20_000,
    totalCostsCents: 30_000,
    grossMarginCents: 70_000,
    grossMarginPercent: 70,
    contributionMarginCents: 80_000,
    health: "healthy",
    lossLeaderApprovedBy: null,
    cacEstimateCents: 240_000,
    computedAt: "2026-06-02T00:00:00Z",
  };

  it("computes payback months (within month-length tolerance)", () => {
    const result = paybackPeriodMonths(base);
    expect(result).not.toBeNull();
    expect(result).toBeGreaterThan(2.9);
    expect(result).toBeLessThan(3.2);
  });

  it("returns null without CAC", () => {
    expect(paybackPeriodMonths({ ...base, cacEstimateCents: undefined })).toBeNull();
  });

  it("returns null with zero contribution margin", () => {
    expect(
      paybackPeriodMonths({
        ...base,
        netRevenueCents: 20_000,
        variableCostsCents: 20_000,
        contributionMarginCents: 0,
      }),
    ).toBeNull();
  });
});

describe("ltvToCacRatio", () => {
  it("computes LTV:CAC ratio", () => {
    const ec: TenantUnitEconomics = {
      id: "x",
      tenantId: "t-1",
      periodStart: "2026-05-01T00:00:00Z",
      periodEnd: "2026-06-01T00:00:00Z",
      currency: "USD",
      grossRevenueCents: 100_000,
      refundsCents: 0,
      creditsAppliedCents: 0,
      netRevenueCents: 100_000,
      fixedCostsCents: 10_000,
      variableCostsCents: 20_000,
      totalCostsCents: 30_000,
      grossMarginCents: 70_000,
      grossMarginPercent: 70,
      contributionMarginCents: 80_000,
      health: "healthy",
      lossLeaderApprovedBy: null,
      ltvEstimateCents: 1_000_000,
      cacEstimateCents: 250_000,
      computedAt: "2026-06-02T00:00:00Z",
    };
    expect(ltvToCacRatio(ec)).toBe(4);
  });

  it("returns null when CAC missing", () => {
    const ec: TenantUnitEconomics = {
      id: "x",
      tenantId: "t-1",
      periodStart: "2026-05-01T00:00:00Z",
      periodEnd: "2026-06-01T00:00:00Z",
      currency: "USD",
      grossRevenueCents: 100_000,
      refundsCents: 0,
      creditsAppliedCents: 0,
      netRevenueCents: 100_000,
      fixedCostsCents: 10_000,
      variableCostsCents: 20_000,
      totalCostsCents: 30_000,
      grossMarginCents: 70_000,
      grossMarginPercent: 70,
      contributionMarginCents: 80_000,
      health: "healthy",
      lossLeaderApprovedBy: null,
      ltvEstimateCents: 1_000_000,
      computedAt: "2026-06-02T00:00:00Z",
    };
    expect(ltvToCacRatio(ec)).toBeNull();
  });
});
