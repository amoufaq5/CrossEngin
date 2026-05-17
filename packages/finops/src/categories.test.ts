import { describe, expect, it } from "vitest";
import {
  CATEGORY_DIMENSION,
  COST_CATEGORIES,
  COST_DIMENSIONS,
  FIXED_CATEGORIES,
  VARIABLE_CATEGORIES,
  attributesTenant,
  dimensionsFor,
  isFixedCost,
  isVariableCost,
} from "./categories.js";

describe("constants", () => {
  it("COST_CATEGORIES has 17 entries", () => {
    expect(COST_CATEGORIES).toHaveLength(17);
    expect(COST_CATEGORIES).toContain("compute_gpu");
    expect(COST_CATEGORIES).toContain("ai_inference");
    expect(COST_CATEGORIES).toContain("license_fees");
  });

  it("COST_DIMENSIONS has 6 entries", () => {
    expect(COST_DIMENSIONS).toEqual([
      "tenant",
      "app",
      "region",
      "environment",
      "data_class",
      "provider",
    ]);
  });

  it("VARIABLE_CATEGORIES + FIXED_CATEGORIES are mutually exclusive", () => {
    for (const c of VARIABLE_CATEGORIES) {
      expect(FIXED_CATEGORIES.has(c)).toBe(false);
    }
    for (const c of FIXED_CATEGORIES) {
      expect(VARIABLE_CATEGORIES.has(c)).toBe(false);
    }
  });

  it("CATEGORY_DIMENSION covers every category", () => {
    for (const c of COST_CATEGORIES) {
      expect(CATEGORY_DIMENSION[c]).toBeDefined();
      expect(CATEGORY_DIMENSION[c].length).toBeGreaterThan(0);
    }
  });
});

describe("helpers", () => {
  it("isVariableCost true for compute/ai/network/etc", () => {
    expect(isVariableCost("compute_serverless")).toBe(true);
    expect(isVariableCost("ai_inference")).toBe(true);
    expect(isVariableCost("egress_bandwidth")).toBe(true);
  });

  it("isVariableCost false for fixed categories", () => {
    expect(isVariableCost("license_fees")).toBe(false);
    expect(isVariableCost("support_hours")).toBe(false);
  });

  it("isFixedCost true for license_fees and support_hours", () => {
    expect(isFixedCost("license_fees")).toBe(true);
    expect(isFixedCost("support_hours")).toBe(true);
    expect(isFixedCost("ai_inference")).toBe(false);
  });

  it("dimensionsFor returns category-specific dimensions", () => {
    expect(dimensionsFor("compute_serverless")).toContain("tenant");
    expect(dimensionsFor("compute_serverless")).toContain("app");
    expect(dimensionsFor("ai_training")).not.toContain("tenant");
  });

  it("attributesTenant true for tenant-bearing categories", () => {
    expect(attributesTenant("compute_serverless")).toBe(true);
    expect(attributesTenant("ai_training")).toBe(false);
  });
});
