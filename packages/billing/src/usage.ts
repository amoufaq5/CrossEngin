import { z } from "zod";
import { METER_IDS, type MeterId } from "./plans.js";

const Iso8601 = z.string().datetime({ offset: true });
const Uuid = z.string().min(1);
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const DateOnlySchema = z.string().regex(DATE_REGEX, {
  message: "date must be YYYY-MM-DD",
});

export const UsagePeriodSchema = z
  .object({
    start: Iso8601,
    end: Iso8601,
  })
  .superRefine((v, ctx) => {
    if (new Date(v.end) <= new Date(v.start)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end"],
        message: "period.end must be after period.start",
      });
    }
  });
export type UsagePeriod = z.infer<typeof UsagePeriodSchema>;

export const USAGE_SOURCES = [
  "ai_provider_calls",
  "job_costs",
  "integration_calls",
  "tenant_storage_usage",
  "manual",
] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export const UsageRecordSchema = z.object({
  id: Uuid,
  tenantId: Uuid,
  subscriptionId: Uuid,
  meter: z.enum(METER_IDS),
  period: UsagePeriodSchema,
  quantity: z.number().nonnegative(),
  source: z.enum(USAGE_SOURCES),
  recordedAt: Iso8601,
  idempotencyKey: z.string().min(1),
  syncedToStripeAt: Iso8601.nullable().default(null),
  stripeUsageRecordId: z.string().min(1).nullable().default(null),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

export function buildIdempotencyKey(input: {
  readonly tenantId: string;
  readonly meter: MeterId;
  readonly periodStart: string;
}): string {
  const day = input.periodStart.slice(0, 10);
  return `tenant=${input.tenantId}:meter=${input.meter}:day=${day}`;
}

export interface UsageRollupBucket {
  readonly tenantId: string;
  readonly meter: MeterId;
  readonly period: UsagePeriod;
  readonly quantity: number;
}

export function rollupUsage(
  records: readonly Pick<UsageRecord, "tenantId" | "meter" | "period" | "quantity">[],
): readonly UsageRollupBucket[] {
  const buckets = new Map<string, UsageRollupBucket>();
  for (const record of records) {
    const key = `${record.tenantId}|${record.meter}|${record.period.start}|${record.period.end}`;
    const existing = buckets.get(key);
    if (existing === undefined) {
      buckets.set(key, { ...record });
    } else {
      buckets.set(key, { ...existing, quantity: existing.quantity + record.quantity });
    }
  }
  return Array.from(buckets.values());
}

export const SUSPICIOUS_USAGE_THRESHOLDS: Readonly<Record<MeterId, number>> = Object.freeze({
  ai_call: 10,
  ai_token: 10,
  storage_gb_month: 5,
  integration_call: 20,
  job_run: 20,
});

export interface AnomalyInput {
  readonly meter: MeterId;
  readonly currentQuantity: number;
  readonly rollingAverage: number;
}

export function isUsageAnomalous(input: AnomalyInput): boolean {
  if (input.rollingAverage <= 0) return false;
  const ratio = input.currentQuantity / input.rollingAverage;
  return ratio >= SUSPICIOUS_USAGE_THRESHOLDS[input.meter];
}
