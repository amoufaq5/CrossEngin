import { z } from "zod";
import { CostCategorySchema, type CostCategory } from "./categories.js";
import { CurrencyCodeSchema } from "./attribution.js";

const Iso8601 = z.string().datetime({ offset: true });
const BUDGET_ID_REGEX = /^[a-z][a-z0-9-]*$/;

export const BUDGET_PERIODS = ["daily", "weekly", "monthly", "quarterly", "annual"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];
export const BudgetPeriodSchema = z.enum(BUDGET_PERIODS);

export const BUDGET_ACTIONS = ["alert_only", "throttle", "block_new_usage", "page_oncall"] as const;
export type BudgetAction = (typeof BUDGET_ACTIONS)[number];
export const BudgetActionSchema = z.enum(BUDGET_ACTIONS);

export const BudgetThresholdSchema = z
  .object({
    percentOfBudget: z.number().int().min(1).max(200),
    action: BudgetActionSchema,
    notifyChannels: z.array(z.enum(["email", "slack", "pagerduty", "webhook"])).min(1),
  })
  .superRefine((v, ctx) => {
    if ((v.action === "block_new_usage" || v.action === "throttle") && v.percentOfBudget < 80) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["percentOfBudget"],
        message: `action '${v.action}' must trigger at >=80% (throttling earlier is too aggressive)`,
      });
    }
    if (v.action === "page_oncall" && !v.notifyChannels.includes("pagerduty")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["notifyChannels"],
        message: "action='page_oncall' must include 'pagerduty' channel",
      });
    }
  });
export type BudgetThreshold = z.infer<typeof BudgetThresholdSchema>;

export const CostBudgetSchema = z
  .object({
    id: z.string().regex(BUDGET_ID_REGEX),
    tenantId: z.string().min(1).nullable(),
    label: z.string().min(1),
    period: BudgetPeriodSchema,
    amountCents: z.number().int().positive(),
    currency: CurrencyCodeSchema,
    appliesToCategories: z.array(CostCategorySchema).default([]),
    thresholds: z.array(BudgetThresholdSchema).min(1),
    autoResetAtPeriodEnd: z.boolean().default(true),
    enabled: z.boolean().default(true),
    createdAt: Iso8601,
    createdBy: z.string().min(1),
    updatedAt: Iso8601,
    notes: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<CostCategory>();
    v.appliesToCategories.forEach((c, i) => {
      if (seen.has(c)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["appliesToCategories", i],
          message: `duplicate category '${c}'`,
        });
      }
      seen.add(c);
    });
    const percents = new Set<number>();
    v.thresholds.forEach((t, i) => {
      if (percents.has(t.percentOfBudget)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["thresholds", i, "percentOfBudget"],
          message: `duplicate threshold at ${t.percentOfBudget.toString()}%`,
        });
      }
      percents.add(t.percentOfBudget);
    });
    if (v.tenantId === null && v.label.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["label"],
        message: "platform-wide budgets (tenantId=null) require a descriptive label",
      });
    }
  });
export type CostBudget = z.infer<typeof CostBudgetSchema>;

export const BudgetBreachRecordSchema = z
  .object({
    id: z.string().min(1),
    budgetId: z.string().regex(BUDGET_ID_REGEX),
    tenantId: z.string().min(1).nullable(),
    periodStart: Iso8601,
    periodEnd: Iso8601,
    budgetAmountCents: z.number().int().positive(),
    actualSpendCents: z.number().int().nonnegative(),
    breachPercent: z.number().int().min(1),
    triggeredAction: BudgetActionSchema,
    detectedAt: Iso8601,
    notifiedChannels: z.array(z.enum(["email", "slack", "pagerduty", "webhook"])).default([]),
    acknowledgedAt: Iso8601.nullable().default(null),
    acknowledgedBy: z.string().min(1).nullable().default(null),
    resolvedAt: Iso8601.nullable().default(null),
    resolvedReason: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.actualSpendCents < v.budgetAmountCents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actualSpendCents"],
        message: "breach record requires actualSpendCents >= budgetAmountCents",
      });
    }
    const computedPercent = Math.floor((v.actualSpendCents * 100) / v.budgetAmountCents);
    if (Math.abs(computedPercent - v.breachPercent) > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["breachPercent"],
        message: `breachPercent ${v.breachPercent.toString()} does not match actualSpend/budget (${computedPercent.toString()}%)`,
      });
    }
    if (v.acknowledgedAt !== null && v.acknowledgedBy === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acknowledgedBy"],
        message: "acknowledgedAt requires acknowledgedBy",
      });
    }
    if (v.resolvedAt !== null && v.resolvedReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolvedReason"],
        message: "resolvedAt requires resolvedReason",
      });
    }
    if (v.triggeredAction === "page_oncall" && !v.notifiedChannels.includes("pagerduty")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["notifiedChannels"],
        message: "page_oncall action must record 'pagerduty' in notifiedChannels",
      });
    }
  });
export type BudgetBreachRecord = z.infer<typeof BudgetBreachRecordSchema>;

export function currentSpendPercent(budget: CostBudget, actualSpendCents: number): number {
  if (budget.amountCents === 0) return 0;
  return Math.floor((actualSpendCents * 100) / budget.amountCents);
}

export function thresholdsCrossed(
  budget: CostBudget,
  actualSpendCents: number,
): readonly BudgetThreshold[] {
  const percent = currentSpendPercent(budget, actualSpendCents);
  return budget.thresholds
    .filter((t) => percent >= t.percentOfBudget)
    .sort((a, b) => a.percentOfBudget - b.percentOfBudget);
}

export function highestSeverityAction(thresholds: readonly BudgetThreshold[]): BudgetAction | null {
  const ranking: Readonly<Record<BudgetAction, number>> = {
    alert_only: 0,
    throttle: 1,
    page_oncall: 2,
    block_new_usage: 3,
  };
  let best: BudgetAction | null = null;
  let bestRank = -1;
  for (const t of thresholds) {
    const rank = ranking[t.action];
    if (rank > bestRank) {
      bestRank = rank;
      best = t.action;
    }
  }
  return best;
}
