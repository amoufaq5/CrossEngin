import { z } from "zod";

export const COST_CATEGORIES = [
  "compute_serverless",
  "compute_long_running",
  "compute_gpu",
  "storage_hot",
  "storage_archive",
  "storage_cold",
  "egress_bandwidth",
  "ingress_bandwidth",
  "database_compute",
  "database_storage",
  "ai_inference",
  "ai_training",
  "third_party_api",
  "search_index",
  "observability",
  "support_hours",
  "license_fees",
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];
export const CostCategorySchema = z.enum(COST_CATEGORIES);

export const COST_DIMENSIONS = [
  "tenant",
  "app",
  "region",
  "environment",
  "data_class",
  "provider",
] as const;
export type CostDimension = (typeof COST_DIMENSIONS)[number];

export const CATEGORY_DIMENSION: Readonly<Record<CostCategory, ReadonlyArray<CostDimension>>> =
  Object.freeze({
    compute_serverless: ["tenant", "app", "region", "environment"],
    compute_long_running: ["tenant", "app", "region", "environment"],
    compute_gpu: ["tenant", "app", "region", "environment"],
    storage_hot: ["tenant", "region", "data_class"],
    storage_archive: ["tenant", "region", "data_class"],
    storage_cold: ["tenant", "region", "data_class"],
    egress_bandwidth: ["tenant", "region", "provider"],
    ingress_bandwidth: ["tenant", "region", "provider"],
    database_compute: ["tenant", "region", "environment"],
    database_storage: ["tenant", "region", "environment"],
    ai_inference: ["tenant", "app", "provider"],
    ai_training: ["app", "provider"],
    third_party_api: ["tenant", "provider"],
    search_index: ["tenant", "region"],
    observability: ["tenant", "region"],
    support_hours: ["tenant"],
    license_fees: ["tenant"],
  });

export const VARIABLE_CATEGORIES: ReadonlySet<CostCategory> = new Set([
  "compute_serverless",
  "compute_long_running",
  "compute_gpu",
  "egress_bandwidth",
  "ingress_bandwidth",
  "ai_inference",
  "third_party_api",
  "database_compute",
]);

export const FIXED_CATEGORIES: ReadonlySet<CostCategory> = new Set([
  "license_fees",
  "support_hours",
]);

export function isVariableCost(category: CostCategory): boolean {
  return VARIABLE_CATEGORIES.has(category);
}

export function isFixedCost(category: CostCategory): boolean {
  return FIXED_CATEGORIES.has(category);
}

export function dimensionsFor(category: CostCategory): ReadonlyArray<CostDimension> {
  return CATEGORY_DIMENSION[category];
}

export function attributesTenant(category: CostCategory): boolean {
  return dimensionsFor(category).includes("tenant");
}
