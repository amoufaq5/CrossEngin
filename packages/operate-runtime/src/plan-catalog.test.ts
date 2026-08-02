import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLAN_CATALOG,
  PlanCatalog,
  PlanCatalogDocumentSchema,
  buildPlanCatalog,
} from "./plan-catalog.js";

describe("PlanCatalog", () => {
  const catalog = new PlanCatalog([
    { id: "free", name: "Free", maxRecordsPerEntity: 1000, features: ["core"], stripePriceIds: [] },
    {
      id: "pro",
      name: "Pro",
      maxRecordsPerEntity: 50000,
      features: ["core", "reporting"],
      stripePriceIds: ["price_pro_month", "price_pro_year"],
    },
    { id: "enterprise", name: "Enterprise", features: ["core", "reporting", "sso"], stripePriceIds: ["price_ent"] },
  ]);

  it("resolves a plan by its id", () => {
    expect(catalog.resolve("pro")?.name).toBe("Pro");
  });

  it("resolves a plan by a mapped Stripe price id", () => {
    expect(catalog.resolve("price_pro_year")?.id).toBe("pro");
    expect(catalog.resolve("price_ent")?.id).toBe("enterprise");
  });

  it("returns undefined for an unknown id", () => {
    expect(catalog.resolve("nope")).toBeUndefined();
    expect(catalog.limitsFor("nope")).toBeUndefined();
  });

  it("returns the record cap + features for a plan", () => {
    expect(catalog.limitsFor("pro")).toEqual({ maxRecordsPerEntity: 50000, features: ["core", "reporting"] });
  });

  it("omits maxRecordsPerEntity for an unlimited plan", () => {
    expect(catalog.limitsFor("enterprise")).toEqual({ features: ["core", "reporting", "sso"] });
  });

  it("resolves limits by Stripe price id too (webhook path)", () => {
    expect(catalog.limitsFor("price_pro_month")).toEqual({
      maxRecordsPerEntity: 50000,
      features: ["core", "reporting"],
    });
  });

  it("exposes a PlanLimitsLookup usable as the webhook's planLimits", () => {
    const lookup = catalog.toLookup();
    expect(lookup("price_ent")).toEqual({ features: ["core", "reporting", "sso"] });
    expect(lookup("unknown")).toBeUndefined();
  });

  it("lists all plans", () => {
    expect(catalog.plans.map((p) => p.id)).toEqual(["free", "pro", "enterprise"]);
  });
});

describe("buildPlanCatalog", () => {
  it("parses + validates a document", () => {
    const cat = buildPlanCatalog({
      plans: [{ id: "solo", name: "Solo", maxRecordsPerEntity: 100 }],
    });
    expect(cat.limitsFor("solo")).toEqual({ maxRecordsPerEntity: 100 });
    expect(cat.resolve("solo")?.features).toEqual([]);
  });

  it("rejects an empty plan list", () => {
    expect(() => buildPlanCatalog({ plans: [] })).toThrow();
  });

  it("rejects a plan without an id", () => {
    expect(() => PlanCatalogDocumentSchema.parse({ plans: [{ name: "No Id" }] })).toThrow();
  });
});

describe("DEFAULT_PLAN_CATALOG", () => {
  it("ships free / pro / enterprise", () => {
    expect(DEFAULT_PLAN_CATALOG.plans.map((p) => p.id)).toEqual(["free", "pro", "enterprise"]);
  });

  it("caps free, leaves enterprise unlimited", () => {
    expect(DEFAULT_PLAN_CATALOG.limitsFor("free")?.maxRecordsPerEntity).toBe(1000);
    expect(DEFAULT_PLAN_CATALOG.limitsFor("enterprise")?.maxRecordsPerEntity).toBeUndefined();
  });
});
