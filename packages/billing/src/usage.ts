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

/**
 * The writer segment's shape: a short opaque token (a uuid fits), so it cannot carry a `:` into the
 * key's field grammar.
 */
export const USAGE_WRITER_REGEX = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The natural key of one usage record: a tenant's subscription, a meter, the **instant** its window
 * starts, and — for a record a flush window wrote — **which writer cut the window**.
 *
 * It was the start's calendar day, so every window opening on one day shared a key — two flushes of
 * the request meter on one day upserted the same row and the second overwrote the first's quantity,
 * and two subscriptions of one tenant on one meter collided outright. The instant fixed that for one
 * writer, and it is not unique across writers: two replicas metering one subscription each cut
 * windows from their own clock, so two windows starting in the same millisecond carried one key and
 * `recordWindow`'s `ON CONFLICT … DO NOTHING` silently dropped the second replica's usage — an
 * under-billing nothing reported (ADR-0451 Q3, closed by ADR-0483). So a flush window's key carries
 * its writer's id, which is stable within a process: a retry of the same window carries the same
 * key, which is the only property an idempotency key needs.
 *
 * `writer` is **required** and `null` is the claim that the record is the period's own — one record
 * per (subscription, meter, period) by construction, as `closePeriod` emits — where a second write
 * is meant to collide with the first. An optional field defaulting to *no writer* would be the
 * collision restated as a default. The start is canonicalised so two spellings of one instant are
 * one key.
 */
export function buildIdempotencyKey(input: {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly meter: MeterId;
  readonly periodStart: string;
  readonly writer: string | null;
}): string {
  const start = new Date(input.periodStart).toISOString();
  const base = `tenant=${input.tenantId}:subscription=${input.subscriptionId}:meter=${input.meter}:start=${start}`;
  if (input.writer === null) return base;
  if (!USAGE_WRITER_REGEX.test(input.writer)) {
    throw new Error(`usage writer id must match ${USAGE_WRITER_REGEX.source}`);
  }
  return `${base}:writer=${input.writer}`;
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
