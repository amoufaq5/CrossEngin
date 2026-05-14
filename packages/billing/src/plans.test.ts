import { describe, expect, it } from "vitest";
import {
  computeOverage,
  METER_IDS,
  PLAN_FAMILIES,
  PLAN_TIERS,
  PlanSchema,
  prorateUpgrade,
  quotaUtilization,
} from "./plans.js";

const basePlan = PlanSchema.parse({
  id: "operate-base-monthly",
  family: "operate",
  tier: "base",
  label: "Operate Base",
  currency: "USD",
  basePriceCents: 19900,
  billingInterval: "month",
  stripeProductId: "prod_abc",
  stripeBasePriceId: "price_abc",
  includedQuotas: { ai_calls_per_month: 500, storage_gb: 10 },
  meteredPrices: [
    {
      meter: "ai_call",
      stripePriceId: "price_overage",
      perUnitCents: 8,
    },
  ],
  availableInRegions: ["eu-central"],
  minKernelVersion: "0.18.0",
});

const proPlan = PlanSchema.parse({
  ...basePlan,
  id: "operate-pro-monthly",
  tier: "professional",
  basePriceCents: 59900,
  includedQuotas: { ai_calls_per_month: 2000, storage_gb: 100 },
  stripeProductId: "prod_proABC",
  stripeBasePriceId: "price_proBASE",
});

describe("PlanSchema", () => {
  it("declares the seven families + five tiers + five meter ids", () => {
    expect(PLAN_FAMILIES).toHaveLength(7);
    expect(PLAN_TIERS).toHaveLength(5);
    expect(METER_IDS).toHaveLength(5);
  });

  it("rejects trial-tier plans with non-zero base price", () => {
    expect(() =>
      PlanSchema.parse({ ...basePlan, id: "x-trial", tier: "trial", basePriceCents: 100 }),
    ).toThrow(/trial-tier plans must have basePriceCents=0/);
  });

  it("rejects annualDiscountPercent on monthly plans", () => {
    expect(() =>
      PlanSchema.parse({ ...basePlan, annualDiscountPercent: 15 }),
    ).toThrow(/applies only to year-interval plans/);
  });

  it("rejects duplicate metered-price meters", () => {
    expect(() =>
      PlanSchema.parse({
        ...basePlan,
        meteredPrices: [
          { meter: "ai_call", stripePriceId: "price_a", perUnitCents: 8 },
          { meter: "ai_call", stripePriceId: "price_b", perUnitCents: 9 },
        ],
      }),
    ).toThrow(/duplicate metered price/);
  });

  it("rejects malformed stripe ids", () => {
    expect(() =>
      PlanSchema.parse({ ...basePlan, stripeProductId: "bad_id" }),
    ).toThrow();
  });
});

describe("computeOverage", () => {
  it("returns zero when usage stays within quota", () => {
    const r = computeOverage({ plan: basePlan, meter: "ai_call", usedUnits: 300 });
    expect(r.billableUnits).toBe(0);
    expect(r.overageCents).toBe(0);
  });

  it("computes overage at perUnitCents", () => {
    const r = computeOverage({ plan: basePlan, meter: "ai_call", usedUnits: 700 });
    expect(r.includedUnits).toBe(500);
    expect(r.billableUnits).toBe(200);
    expect(r.overageCents).toBe(200 * 8);
    expect(r.currency).toBe("USD");
  });

  it("returns zero for a meter with no metered price", () => {
    const r = computeOverage({ plan: basePlan, meter: "job_run", usedUnits: 9999 });
    expect(r.overageCents).toBe(0);
  });

  it("rejects negative usage", () => {
    expect(() =>
      computeOverage({ plan: basePlan, meter: "ai_call", usedUnits: -1 }),
    ).toThrow();
  });
});

describe("prorateUpgrade", () => {
  it("credits the unused portion of the old plan + charges the new", () => {
    const r = prorateUpgrade({
      oldPlan: basePlan,
      newPlan: proPlan,
      daysIntoCycle: 10,
      daysInCycle: 30,
    });
    expect(r.creditCents).toBe(Math.round(19900 * (20 / 30)));
    expect(r.newChargeCents).toBe(Math.round(59900 * (20 / 30)));
    expect(r.netCents).toBe(r.newChargeCents - r.creditCents);
    expect(r.currency).toBe("USD");
  });

  it("rejects cross-currency upgrades", () => {
    const eurPlan = PlanSchema.parse({ ...proPlan, id: "p-eur", currency: "EUR" });
    expect(() =>
      prorateUpgrade({
        oldPlan: basePlan,
        newPlan: eurPlan,
        daysIntoCycle: 1,
        daysInCycle: 30,
      }),
    ).toThrow(/share a currency/);
  });

  it("rejects daysIntoCycle > daysInCycle", () => {
    expect(() =>
      prorateUpgrade({
        oldPlan: basePlan,
        newPlan: proPlan,
        daysIntoCycle: 40,
        daysInCycle: 30,
      }),
    ).toThrow();
  });
});

describe("quotaUtilization", () => {
  it("returns ok under the warn threshold", () => {
    expect(quotaUtilization(100, 30).status).toBe("ok");
  });

  it("returns approaching at >= warn threshold", () => {
    expect(quotaUtilization(100, 80).status).toBe("approaching");
    expect(quotaUtilization(100, 95).status).toBe("approaching");
  });

  it("returns over when used exceeds included", () => {
    expect(quotaUtilization(100, 150).status).toBe("over");
  });

  it("handles zero quota", () => {
    expect(quotaUtilization(0, 0).status).toBe("ok");
    expect(quotaUtilization(0, 1).status).toBe("over");
  });
});
