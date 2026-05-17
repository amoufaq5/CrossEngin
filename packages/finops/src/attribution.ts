import { z } from "zod";
import { RegionSchema } from "@crossengin/residency";
import { CostCategorySchema, attributesTenant, type CostCategory } from "./categories.js";

const Iso8601 = z.string().datetime({ offset: true });

export const ALLOCATION_METHODS = [
  "direct",
  "proportional_usage",
  "even_split",
  "flat_rate",
  "estimated",
] as const;
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];
export const AllocationMethodSchema = z.enum(ALLOCATION_METHODS);

export const CURRENCY_CODES = ["USD", "EUR", "GBP", "AED", "SAR", "SGD", "INR", "JPY"] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];
export const CurrencyCodeSchema = z.enum(CURRENCY_CODES);

export const CostAttributionRecordSchema = z
  .object({
    id: z.string().min(1),
    periodStart: Iso8601,
    periodEnd: Iso8601,
    tenantId: z.string().min(1).nullable(),
    appId: z.string().min(1).nullable().default(null),
    region: RegionSchema.nullable().default(null),
    environment: z
      .enum(["local", "preview", "staging", "production", "sandbox"])
      .nullable()
      .default(null),
    category: CostCategorySchema,
    allocationMethod: AllocationMethodSchema,
    currency: CurrencyCodeSchema,
    costCents: z.number().int().nonnegative(),
    usageQuantity: z.number().nonnegative(),
    usageUnit: z.string().min(1),
    providerCostCents: z.number().int().nonnegative(),
    providerName: z.string().min(1),
    sourceLedgerRef: z.string().min(1),
    isEstimated: z.boolean().default(false),
    estimatedConfidence: z.number().min(0).max(1).optional(),
    sourceDataClass: z
      .enum([
        "public",
        "internal",
        "commercial_sensitive",
        "pii",
        "phi",
        "regulated",
      ])
      .optional(),
    notes: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (new Date(v.periodEnd).getTime() <= new Date(v.periodStart).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["periodEnd"],
        message: "periodEnd must be after periodStart",
      });
    }
    if (attributesTenant(v.category) && v.tenantId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tenantId"],
        message: `category '${v.category}' must attribute to a tenant`,
      });
    }
    if (v.isEstimated && v.estimatedConfidence === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["estimatedConfidence"],
        message: "isEstimated=true requires estimatedConfidence",
      });
    }
    if (v.allocationMethod === "estimated" && !v.isEstimated) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["isEstimated"],
        message: "allocationMethod='estimated' requires isEstimated=true",
      });
    }
    if (v.costCents > 0 && v.usageQuantity === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["usageQuantity"],
        message: "non-zero cost requires non-zero usageQuantity (cannot bill for zero usage)",
      });
    }
    if (v.providerCostCents > v.costCents * 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerCostCents"],
        message: "providerCostCents > 2x attributed costCents is suspicious; investigate before recording",
      });
    }
  });
export type CostAttributionRecord = z.infer<typeof CostAttributionRecordSchema>;

export interface AttributionFilter {
  readonly tenantId?: string;
  readonly category?: CostCategory;
  readonly periodStart?: Date;
  readonly periodEnd?: Date;
}

export function filterAttributions(
  records: readonly CostAttributionRecord[],
  filter: AttributionFilter,
): readonly CostAttributionRecord[] {
  return records.filter((r) => {
    if (filter.tenantId !== undefined && r.tenantId !== filter.tenantId) return false;
    if (filter.category !== undefined && r.category !== filter.category) return false;
    if (filter.periodStart !== undefined) {
      if (new Date(r.periodEnd).getTime() < filter.periodStart.getTime()) return false;
    }
    if (filter.periodEnd !== undefined) {
      if (new Date(r.periodStart).getTime() > filter.periodEnd.getTime()) return false;
    }
    return true;
  });
}

export function totalCostCents(
  records: readonly CostAttributionRecord[],
): number {
  return records.reduce((acc, r) => acc + r.costCents, 0);
}

export function aggregateByCategory(
  records: readonly CostAttributionRecord[],
): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const r of records) {
    out[r.category] = (out[r.category] ?? 0) + r.costCents;
  }
  return out;
}

export function aggregateByTenant(
  records: readonly CostAttributionRecord[],
): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const r of records) {
    if (r.tenantId === null) continue;
    out[r.tenantId] = (out[r.tenantId] ?? 0) + r.costCents;
  }
  return out;
}
