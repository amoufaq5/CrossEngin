import { z } from "zod";

export const QUOTA_PERIODS = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "billing_period",
  "lifetime",
] as const;
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];

export const QUOTA_CLASSES = [
  "free_tier",
  "starter",
  "pro",
  "enterprise",
  "internal",
  "custom",
] as const;
export type QuotaClass = (typeof QUOTA_CLASSES)[number];

export const QUOTA_TARGETS = [
  "api_requests",
  "ai_tokens",
  "storage_bytes",
  "compute_seconds",
  "notification_dispatches",
  "search_queries",
  "report_runs",
  "ml_training_minutes",
  "webhook_deliveries",
  "rows_exported",
] as const;
export type QuotaTarget = (typeof QUOTA_TARGETS)[number];

export const PERIOD_SECONDS: Readonly<Record<QuotaPeriod, number | null>> = {
  minute: 60,
  hour: 3600,
  day: 86_400,
  week: 604_800,
  month: 2_592_000,
  billing_period: 2_592_000,
  lifetime: null,
};

export const QuotaDefinitionSchema = z
  .object({
    id: z.string().regex(/^rlq_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    label: z.string().min(1).max(200),
    target: z.enum(QUOTA_TARGETS),
    quotaClass: z.enum(QUOTA_CLASSES),
    period: z.enum(QUOTA_PERIODS),
    hardLimit: z.number().int().min(0),
    softLimit: z.number().int().min(0).nullable(),
    overageAllowed: z.boolean(),
    overageUnitPriceCents: z.number().int().min(0).nullable(),
    appliesAfterPlanSwitchSeconds: z
      .number()
      .int()
      .min(0)
      .max(86_400)
      .default(0),
    createdAt: z.string().datetime({ offset: true }),
    createdBy: z.string().uuid(),
  })
  .superRefine((q, ctx) => {
    if (q.softLimit !== null && q.softLimit >= q.hardLimit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["softLimit"],
        message: "softLimit must be less than hardLimit",
      });
    }
    if (q.overageAllowed && q.overageUnitPriceCents === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["overageUnitPriceCents"],
        message: "overageAllowed requires overageUnitPriceCents",
      });
    }
    if (q.quotaClass === "free_tier" && q.overageAllowed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["overageAllowed"],
        message: "free_tier quotas cannot allow overage",
      });
    }
    if (q.period === "lifetime" && q.target === "api_requests") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["period"],
        message:
          "lifetime period is only valid for cumulative targets (storage_bytes, rows_exported)",
      });
    }
  });
export type QuotaDefinition = z.infer<typeof QuotaDefinitionSchema>;

export const QuotaUsageSchema = z
  .object({
    id: z.string().regex(/^rlu_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid(),
    quotaDefinitionId: z.string().regex(/^rlq_[a-z0-9]{8,40}$/),
    target: z.enum(QUOTA_TARGETS),
    period: z.enum(QUOTA_PERIODS),
    periodStartAt: z.string().datetime({ offset: true }),
    periodEndAt: z.string().datetime({ offset: true }).nullable(),
    consumedUnits: z.number().int().min(0),
    softLimitBreachedAt: z.string().datetime({ offset: true }).nullable(),
    hardLimitBreachedAt: z.string().datetime({ offset: true }).nullable(),
    overageUnitsConsumed: z.number().int().min(0).default(0),
    overageBilledAt: z.string().datetime({ offset: true }).nullable(),
    lastUpdatedAt: z.string().datetime({ offset: true }),
  })
  .superRefine((u, ctx) => {
    if (
      u.periodEndAt !== null &&
      Date.parse(u.periodEndAt) <= Date.parse(u.periodStartAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["periodEndAt"],
        message: "periodEndAt must be after periodStartAt",
      });
    }
    if (u.period === "lifetime" && u.periodEndAt !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["periodEndAt"],
        message: "lifetime period must have null periodEndAt",
      });
    }
    if (u.period !== "lifetime" && u.periodEndAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["periodEndAt"],
        message: `${u.period} period requires periodEndAt`,
      });
    }
    if (
      u.hardLimitBreachedAt !== null &&
      u.softLimitBreachedAt !== null &&
      Date.parse(u.hardLimitBreachedAt) < Date.parse(u.softLimitBreachedAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hardLimitBreachedAt"],
        message: "hardLimitBreachedAt cannot precede softLimitBreachedAt",
      });
    }
  });
export type QuotaUsage = z.infer<typeof QuotaUsageSchema>;

export const computePeriodStart = (
  period: QuotaPeriod,
  now: Date,
  billingCycleStartAt: Date | null,
): string => {
  const nowMs = now.getTime();
  if (period === "lifetime") {
    return new Date(0).toISOString();
  }
  if (period === "billing_period" && billingCycleStartAt !== null) {
    return billingCycleStartAt.toISOString();
  }
  const periodSec = PERIOD_SECONDS[period];
  if (periodSec === null) return new Date(0).toISOString();
  const nowSec = Math.floor(nowMs / 1000);
  const startSec = nowSec - (nowSec % periodSec);
  return new Date(startSec * 1000).toISOString();
};

export const computePeriodEnd = (
  period: QuotaPeriod,
  periodStart: Date,
): string | null => {
  if (period === "lifetime") return null;
  const periodSec = PERIOD_SECONDS[period];
  if (periodSec === null) return null;
  return new Date(periodStart.getTime() + periodSec * 1000).toISOString();
};

export interface QuotaCheckInput {
  readonly definition: QuotaDefinition;
  readonly currentUsage: number;
  readonly costUnits: number;
  readonly now: Date;
}

export interface QuotaCheckResult {
  readonly allowed: boolean;
  readonly outcome:
    | "within_soft_limit"
    | "soft_limit_exceeded"
    | "hard_limit_blocked"
    | "overage_billable";
  readonly remainingBeforeHard: number;
  readonly overageUnits: number;
}

export const evaluateQuota = (input: QuotaCheckInput): QuotaCheckResult => {
  const projected = input.currentUsage + input.costUnits;
  const remainingBeforeHard = Math.max(
    0,
    input.definition.hardLimit - projected,
  );
  if (projected <= input.definition.hardLimit) {
    if (
      input.definition.softLimit !== null &&
      projected > input.definition.softLimit
    ) {
      return {
        allowed: true,
        outcome: "soft_limit_exceeded",
        remainingBeforeHard,
        overageUnits: 0,
      };
    }
    return {
      allowed: true,
      outcome: "within_soft_limit",
      remainingBeforeHard,
      overageUnits: 0,
    };
  }
  if (input.definition.overageAllowed) {
    return {
      allowed: true,
      outcome: "overage_billable",
      remainingBeforeHard: 0,
      overageUnits: projected - input.definition.hardLimit,
    };
  }
  return {
    allowed: false,
    outcome: "hard_limit_blocked",
    remainingBeforeHard: 0,
    overageUnits: 0,
  };
};
