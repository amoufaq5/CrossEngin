import { z } from "zod";
import { CurrencyCodeSchema } from "./attribution.js";

const Iso8601 = z.string().datetime({ offset: true });

export const MARGIN_HEALTH = [
  "healthy",
  "watch",
  "thin",
  "negative",
  "loss_leader_approved",
] as const;
export type MarginHealth = (typeof MARGIN_HEALTH)[number];
export const MarginHealthSchema = z.enum(MARGIN_HEALTH);

export const TenantUnitEconomicsSchema = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    periodStart: Iso8601,
    periodEnd: Iso8601,
    currency: CurrencyCodeSchema,
    grossRevenueCents: z.number().int().nonnegative(),
    refundsCents: z.number().int().nonnegative().default(0),
    creditsAppliedCents: z.number().int().nonnegative().default(0),
    netRevenueCents: z.number().int().nonnegative(),
    fixedCostsCents: z.number().int().nonnegative(),
    variableCostsCents: z.number().int().nonnegative(),
    totalCostsCents: z.number().int().nonnegative(),
    grossMarginCents: z.number().int(),
    grossMarginPercent: z.number().min(-1000).max(100),
    contributionMarginCents: z.number().int(),
    health: MarginHealthSchema,
    lossLeaderApprovedBy: z.string().min(1).nullable().default(null),
    lossLeaderApprovedReason: z.string().min(1).optional(),
    ltvEstimateCents: z.number().int().nonnegative().optional(),
    cacEstimateCents: z.number().int().nonnegative().optional(),
    computedAt: Iso8601,
  })
  .superRefine((v, ctx) => {
    if (new Date(v.periodEnd).getTime() <= new Date(v.periodStart).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["periodEnd"],
        message: "periodEnd must be after periodStart",
      });
    }
    const expectedNet = v.grossRevenueCents - v.refundsCents - v.creditsAppliedCents;
    if (expectedNet !== v.netRevenueCents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["netRevenueCents"],
        message: `netRevenueCents ${v.netRevenueCents.toString()} must equal grossRevenue (${v.grossRevenueCents.toString()}) - refunds (${v.refundsCents.toString()}) - credits (${v.creditsAppliedCents.toString()})`,
      });
    }
    const expectedTotal = v.fixedCostsCents + v.variableCostsCents;
    if (expectedTotal !== v.totalCostsCents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalCostsCents"],
        message: `totalCostsCents ${v.totalCostsCents.toString()} must equal fixed (${v.fixedCostsCents.toString()}) + variable (${v.variableCostsCents.toString()})`,
      });
    }
    const expectedMargin = v.netRevenueCents - v.totalCostsCents;
    if (expectedMargin !== v.grossMarginCents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["grossMarginCents"],
        message: `grossMarginCents ${v.grossMarginCents.toString()} must equal netRevenue (${v.netRevenueCents.toString()}) - totalCosts (${v.totalCostsCents.toString()})`,
      });
    }
    if (v.netRevenueCents > 0) {
      const computedPct = Math.round((v.grossMarginCents / v.netRevenueCents) * 1000) / 10;
      if (Math.abs(computedPct - v.grossMarginPercent) > 0.5) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["grossMarginPercent"],
          message: `grossMarginPercent ${v.grossMarginPercent.toString()} does not match computed (${computedPct.toString()})`,
        });
      }
    }
    const expectedContrib = v.netRevenueCents - v.variableCostsCents;
    if (expectedContrib !== v.contributionMarginCents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributionMarginCents"],
        message: `contributionMarginCents must equal netRevenue - variableCosts`,
      });
    }
    if (v.health === "loss_leader_approved") {
      if (v.lossLeaderApprovedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lossLeaderApprovedBy"],
          message: "loss_leader_approved requires lossLeaderApprovedBy",
        });
      }
      if (v.lossLeaderApprovedReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lossLeaderApprovedReason"],
          message: "loss_leader_approved requires lossLeaderApprovedReason",
        });
      }
    }
    if (v.grossMarginCents < 0 && v.health !== "negative" && v.health !== "loss_leader_approved") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["health"],
        message: "negative grossMargin requires health='negative' or 'loss_leader_approved'",
      });
    }
  });
export type TenantUnitEconomics = z.infer<typeof TenantUnitEconomicsSchema>;

const HEALTH_THRESHOLDS: ReadonlyArray<{
  readonly minPercent: number;
  readonly health: MarginHealth;
}> = Object.freeze([
  { minPercent: 60, health: "healthy" },
  { minPercent: 30, health: "watch" },
  { minPercent: 0, health: "thin" },
]);

export function classifyMargin(grossMarginPercent: number): MarginHealth {
  if (grossMarginPercent < 0) return "negative";
  for (const threshold of HEALTH_THRESHOLDS) {
    if (grossMarginPercent >= threshold.minPercent) return threshold.health;
  }
  return "thin";
}

export function paybackPeriodMonths(economics: TenantUnitEconomics): number | null {
  if (
    economics.cacEstimateCents === undefined ||
    economics.cacEstimateCents === 0 ||
    economics.contributionMarginCents <= 0
  ) {
    return null;
  }
  const periodMs =
    new Date(economics.periodEnd).getTime() - new Date(economics.periodStart).getTime();
  const periodMonths = periodMs / (30.4375 * 24 * 60 * 60 * 1000);
  if (periodMonths === 0) return null;
  const monthlyMarginCents = economics.contributionMarginCents / periodMonths;
  if (monthlyMarginCents === 0) return null;
  return Math.round((economics.cacEstimateCents / monthlyMarginCents) * 10) / 10;
}

export function ltvToCacRatio(economics: TenantUnitEconomics): number | null {
  if (
    economics.ltvEstimateCents === undefined ||
    economics.cacEstimateCents === undefined ||
    economics.cacEstimateCents === 0
  ) {
    return null;
  }
  return Math.round((economics.ltvEstimateCents / economics.cacEstimateCents) * 10) / 10;
}
