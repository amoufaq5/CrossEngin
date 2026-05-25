import { z } from "zod";
import { Iso4217CurrencySchema, type Iso4217Currency } from "@crossengin/i18n";
import { RegionSchema } from "@crossengin/residency";

const PLAN_ID_REGEX = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const STRIPE_PRODUCT_REGEX = /^prod_[A-Za-z0-9]+$/;
const STRIPE_PRICE_REGEX = /^price_[A-Za-z0-9]+$/;
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

export const PlanIdSchema = z.string().regex(PLAN_ID_REGEX, {
  message: "plan id must be lowercase kebab-case (e.g., 'operate-base-monthly')",
});
export type PlanId = z.infer<typeof PlanIdSchema>;

export const PLAN_FAMILIES = [
  "operate",
  "govern",
  "heal",
  "educate",
  "serve",
  "build",
  "partner",
] as const;
export type PlanFamily = (typeof PLAN_FAMILIES)[number];

export const PLAN_TIERS = ["trial", "base", "professional", "enterprise", "non_profit"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const BILLING_INTERVALS = ["month", "year"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const QuotaSchema = z.object({
  users: z.number().int().nonnegative().optional(),
  tenants_per_org: z.number().int().nonnegative().optional(),
  ai_calls_per_month: z.number().int().nonnegative().optional(),
  storage_gb: z.number().nonnegative().optional(),
  integrations: z.number().int().nonnegative().optional(),
  scheduled_exports: z.number().int().nonnegative().optional(),
  workflow_runs_per_month: z.number().int().nonnegative().optional(),
});
export type Quota = z.infer<typeof QuotaSchema>;

export const METER_IDS = [
  "ai_call",
  "ai_token",
  "storage_gb_month",
  "integration_call",
  "job_run",
] as const;
export type MeterId = (typeof METER_IDS)[number];

export const MeteredPriceSchema = z.object({
  meter: z.enum(METER_IDS),
  stripePriceId: z.string().regex(STRIPE_PRICE_REGEX),
  perUnitCents: z.number().int().nonnegative(),
  freeTierUnits: z.number().int().nonnegative().default(0),
  aggregation: z.enum(["sum", "last_during_period", "max", "increment"]).default("sum"),
});
export type MeteredPrice = z.infer<typeof MeteredPriceSchema>;

export const PlanSchema = z
  .object({
    id: PlanIdSchema,
    family: z.enum(PLAN_FAMILIES),
    tier: z.enum(PLAN_TIERS),
    label: z.string().min(1),
    description: z.string().optional(),
    currency: Iso4217CurrencySchema,
    basePriceCents: z.number().int().nonnegative(),
    billingInterval: z.enum(BILLING_INTERVALS),
    stripeProductId: z.string().regex(STRIPE_PRODUCT_REGEX),
    stripeBasePriceId: z.string().regex(STRIPE_PRICE_REGEX),
    includedQuotas: QuotaSchema.default({}),
    meteredPrices: z.array(MeteredPriceSchema).default([]),
    availableInRegions: z.array(RegionSchema).min(1),
    minKernelVersion: z.string().regex(SEMVER_REGEX),
    trialDays: z.number().int().min(0).max(180).default(0),
    annualDiscountPercent: z.number().min(0).max(50).optional(),
    deprecated: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.tier === "trial" && v.basePriceCents !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["basePriceCents"],
        message: "trial-tier plans must have basePriceCents=0",
      });
    }
    if (v.billingInterval === "month" && v.annualDiscountPercent !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["annualDiscountPercent"],
        message: "annualDiscountPercent applies only to year-interval plans",
      });
    }
    const meters = new Set<MeterId>();
    v.meteredPrices.forEach((m, i) => {
      if (meters.has(m.meter)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["meteredPrices", i, "meter"],
          message: `duplicate metered price for '${m.meter}'`,
        });
      }
      meters.add(m.meter);
    });
  });
export type Plan = z.infer<typeof PlanSchema>;

export interface OverageInput {
  readonly plan: Plan;
  readonly meter: MeterId;
  readonly usedUnits: number;
}

export interface OverageResult {
  readonly meter: MeterId;
  readonly includedUnits: number;
  readonly billableUnits: number;
  readonly overageCents: number;
  readonly currency: Iso4217Currency;
}

const METER_TO_QUOTA: Readonly<Record<MeterId, keyof Quota | null>> = Object.freeze({
  ai_call: "ai_calls_per_month",
  ai_token: null,
  storage_gb_month: "storage_gb",
  integration_call: "integrations",
  job_run: "workflow_runs_per_month",
});

export function computeOverage(input: OverageInput): OverageResult {
  if (input.usedUnits < 0) {
    throw new Error("usedUnits must be non-negative");
  }
  const metered = input.plan.meteredPrices.find((m) => m.meter === input.meter);
  const quotaKey = METER_TO_QUOTA[input.meter];
  const quotaIncluded = quotaKey !== null ? (input.plan.includedQuotas[quotaKey] ?? 0) : 0;
  const freeTier = metered?.freeTierUnits ?? 0;
  const includedUnits = Math.max(quotaIncluded, freeTier);
  const billableUnits = Math.max(0, input.usedUnits - includedUnits);
  const overageCents = metered !== undefined ? billableUnits * metered.perUnitCents : 0;
  return {
    meter: input.meter,
    includedUnits,
    billableUnits,
    overageCents,
    currency: input.plan.currency,
  };
}

export interface ProrationInput {
  readonly oldPlan: Plan;
  readonly newPlan: Plan;
  readonly daysIntoCycle: number;
  readonly daysInCycle: number;
}

export interface ProrationResult {
  readonly creditCents: number;
  readonly newChargeCents: number;
  readonly netCents: number;
  readonly currency: Iso4217Currency;
}

export function prorateUpgrade(input: ProrationInput): ProrationResult {
  if (input.oldPlan.currency !== input.newPlan.currency) {
    throw new Error("prorateUpgrade requires both plans to share a currency");
  }
  if (input.daysInCycle <= 0 || input.daysIntoCycle < 0) {
    throw new Error("invalid daysInCycle / daysIntoCycle");
  }
  if (input.daysIntoCycle > input.daysInCycle) {
    throw new Error("daysIntoCycle cannot exceed daysInCycle");
  }
  const remaining = input.daysInCycle - input.daysIntoCycle;
  const remainingFraction = remaining / input.daysInCycle;
  const creditCents = Math.round(input.oldPlan.basePriceCents * remainingFraction);
  const newChargeCents = Math.round(input.newPlan.basePriceCents * remainingFraction);
  return {
    creditCents,
    newChargeCents,
    netCents: newChargeCents - creditCents,
    currency: input.newPlan.currency,
  };
}

export type QuotaUtilization =
  | { readonly status: "ok"; readonly percentUsed: number }
  | { readonly status: "approaching"; readonly percentUsed: number }
  | { readonly status: "over"; readonly percentUsed: number };

export function quotaUtilization(
  included: number,
  used: number,
  warnAtPercent = 80,
): QuotaUtilization {
  if (included <= 0) {
    return { status: used > 0 ? "over" : "ok", percentUsed: used > 0 ? 100 : 0 };
  }
  if (used < 0) throw new Error("used cannot be negative");
  const percentUsed = (used / included) * 100;
  if (used > included) return { status: "over", percentUsed };
  if (percentUsed >= warnAtPercent) return { status: "approaching", percentUsed };
  return { status: "ok", percentUsed };
}
