import { describe, expect, it } from "vitest";
import {
  ALLOCATION_METHODS,
  CURRENCY_CODES,
  CostAttributionRecordSchema,
  aggregateByCategory,
  aggregateByTenant,
  filterAttributions,
  totalCostCents,
  type CostAttributionRecord,
} from "./attribution.js";

describe("constants", () => {
  it("ALLOCATION_METHODS has 5 entries", () => {
    expect(ALLOCATION_METHODS).toEqual([
      "direct",
      "proportional_usage",
      "even_split",
      "flat_rate",
      "estimated",
    ]);
  });

  it("CURRENCY_CODES covers major regions", () => {
    expect(CURRENCY_CODES).toContain("USD");
    expect(CURRENCY_CODES).toContain("AED");
    expect(CURRENCY_CODES).toContain("SAR");
  });
});

describe("CostAttributionRecordSchema", () => {
  const base: CostAttributionRecord = {
    id: "attr-1",
    periodStart: "2026-05-01T00:00:00Z",
    periodEnd: "2026-06-01T00:00:00Z",
    tenantId: "t-1",
    appId: "web",
    region: "eu-central",
    environment: "production",
    category: "compute_serverless",
    allocationMethod: "direct",
    currency: "USD",
    costCents: 10_000,
    usageQuantity: 1000,
    usageUnit: "request-seconds",
    providerCostCents: 9_500,
    providerName: "vercel",
    sourceLedgerRef: "vercel-invoice-2026-05",
    isEstimated: false,
  };

  it("accepts a valid attribution record", () => {
    expect(() => CostAttributionRecordSchema.parse(base)).not.toThrow();
  });

  it("rejects periodEnd <= periodStart", () => {
    expect(() =>
      CostAttributionRecordSchema.parse({
        ...base,
        periodEnd: "2026-05-01T00:00:00Z",
      }),
    ).toThrow(/after periodStart/);
  });

  it("rejects tenant-attributable category without tenantId", () => {
    expect(() => CostAttributionRecordSchema.parse({ ...base, tenantId: null })).toThrow(
      /attribute to a tenant/,
    );
  });

  it("accepts ai_training without tenantId (non-tenant-attributable)", () => {
    expect(() =>
      CostAttributionRecordSchema.parse({
        ...base,
        category: "ai_training",
        tenantId: null,
        appId: "ml-trainer",
        region: null,
        environment: null,
      }),
    ).not.toThrow();
  });

  it("rejects isEstimated without estimatedConfidence", () => {
    expect(() => CostAttributionRecordSchema.parse({ ...base, isEstimated: true })).toThrow(
      /estimatedConfidence/,
    );
  });

  it("rejects allocationMethod='estimated' without isEstimated=true", () => {
    expect(() =>
      CostAttributionRecordSchema.parse({
        ...base,
        allocationMethod: "estimated",
      }),
    ).toThrow(/isEstimated=true/);
  });

  it("rejects non-zero cost with zero usage", () => {
    expect(() => CostAttributionRecordSchema.parse({ ...base, usageQuantity: 0 })).toThrow(
      /zero usage/,
    );
  });

  it("rejects provider cost > 2x attributed cost", () => {
    expect(() =>
      CostAttributionRecordSchema.parse({
        ...base,
        providerCostCents: 100_000,
      }),
    ).toThrow(/2x attributed/);
  });
});

describe("helpers", () => {
  const records: CostAttributionRecord[] = [
    {
      id: "a",
      periodStart: "2026-05-01T00:00:00Z",
      periodEnd: "2026-06-01T00:00:00Z",
      tenantId: "t-1",
      appId: "web",
      region: "eu-central",
      environment: "production",
      category: "compute_serverless",
      allocationMethod: "direct",
      currency: "USD",
      costCents: 10_000,
      usageQuantity: 1000,
      usageUnit: "req-s",
      providerCostCents: 9_500,
      providerName: "vercel",
      sourceLedgerRef: "x",
      isEstimated: false,
    },
    {
      id: "b",
      periodStart: "2026-05-01T00:00:00Z",
      periodEnd: "2026-06-01T00:00:00Z",
      tenantId: "t-2",
      appId: "web",
      region: "eu-central",
      environment: "production",
      category: "ai_inference",
      allocationMethod: "direct",
      currency: "USD",
      costCents: 5_000,
      usageQuantity: 100_000,
      usageUnit: "tokens",
      providerCostCents: 4_800,
      providerName: "anthropic",
      sourceLedgerRef: "y",
      isEstimated: false,
    },
  ];

  it("totalCostCents sums all records", () => {
    expect(totalCostCents(records)).toBe(15_000);
  });

  it("filterAttributions filters by tenant", () => {
    expect(filterAttributions(records, { tenantId: "t-1" }).length).toBe(1);
  });

  it("filterAttributions filters by category", () => {
    expect(filterAttributions(records, { category: "ai_inference" }).length).toBe(1);
  });

  it("aggregateByCategory sums per category", () => {
    const out = aggregateByCategory(records);
    expect(out.compute_serverless).toBe(10_000);
    expect(out.ai_inference).toBe(5_000);
  });

  it("aggregateByTenant sums per tenant", () => {
    const out = aggregateByTenant(records);
    expect(out["t-1"]).toBe(10_000);
    expect(out["t-2"]).toBe(5_000);
  });
});
