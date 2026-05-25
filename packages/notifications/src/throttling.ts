import { z } from "zod";
import { NOTIFICATION_CHANNELS, type NotificationChannel } from "./channels.js";
import { CONTENT_CATEGORIES, isCategorySuppressible, type ContentCategory } from "./templates.js";
import { PRIORITY_LEVELS, type DeliveryAttempt, type PriorityLevel } from "./delivery.js";

export const DIGEST_FREQUENCIES = [
  "immediate",
  "every_15_minutes",
  "hourly",
  "daily",
  "weekly",
  "never",
] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

export const QUIET_HOURS_BEHAVIORS = [
  "deliver_anyway",
  "defer_to_morning",
  "batch_until_morning",
  "drop_silently",
] as const;
export type QuietHoursBehavior = (typeof QUIET_HOURS_BEHAVIORS)[number];

export const DIGEST_STATUSES = [
  "open",
  "queued_for_assembly",
  "assembled",
  "dispatched",
  "expired",
] as const;
export type DigestStatus = (typeof DIGEST_STATUSES)[number];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const QuietHoursConfigSchema = z
  .object({
    startTime: z.string().regex(HHMM),
    endTime: z.string().regex(HHMM),
    timezone: z.string().min(1),
    behavior: z.enum(QUIET_HOURS_BEHAVIORS),
    bypassCategories: z.array(z.enum(CONTENT_CATEGORIES)).default([]),
  })
  .superRefine((q, ctx) => {
    if (q.startTime === q.endTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: "quiet hours startTime and endTime must differ",
      });
    }
    for (const cat of q.bypassCategories) {
      if (isCategorySuppressible(cat) === false) continue;
      if (cat === "marketing") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bypassCategories"],
          message: "marketing cannot bypass quiet hours",
        });
        return;
      }
    }
  });
export type QuietHoursConfig = z.infer<typeof QuietHoursConfigSchema>;

const minutesSinceMidnight = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export const isWithinQuietHours = (
  config: QuietHoursConfig,
  localMinutesSinceMidnight: number,
): boolean => {
  const start = minutesSinceMidnight(config.startTime);
  const end = minutesSinceMidnight(config.endTime);
  if (start < end) {
    return localMinutesSinceMidnight >= start && localMinutesSinceMidnight < end;
  }
  return localMinutesSinceMidnight >= start || localMinutesSinceMidnight < end;
};

export interface QuietHoursDecision {
  readonly action: "send_now" | "defer" | "batch" | "drop";
  readonly reason: string;
}

export const decideQuietHoursAction = (input: {
  readonly config: QuietHoursConfig | null;
  readonly category: ContentCategory;
  readonly priority: PriorityLevel;
  readonly localMinutesSinceMidnight: number;
}): QuietHoursDecision => {
  if (input.config === null) {
    return { action: "send_now", reason: "no_quiet_hours_configured" };
  }
  if (!isWithinQuietHours(input.config, input.localMinutesSinceMidnight)) {
    return { action: "send_now", reason: "outside_quiet_hours" };
  }
  if (input.config.bypassCategories.includes(input.category)) {
    return { action: "send_now", reason: "category_bypasses_quiet_hours" };
  }
  if (input.priority === "critical") {
    return { action: "send_now", reason: "critical_priority_bypasses" };
  }
  switch (input.config.behavior) {
    case "deliver_anyway":
      return { action: "send_now", reason: "behavior_deliver_anyway" };
    case "defer_to_morning":
      return { action: "defer", reason: "behavior_defer_to_morning" };
    case "batch_until_morning":
      return { action: "batch", reason: "behavior_batch_until_morning" };
    case "drop_silently":
      return { action: "drop", reason: "behavior_drop_silently" };
  }
};

export const RateLimitPolicySchema = z
  .object({
    id: z.string().regex(/^rlp_[a-z0-9-]{4,40}$/),
    tenantId: z.string().uuid().nullable(),
    channel: z.enum(NOTIFICATION_CHANNELS),
    perRecipientPerHour: z.number().int().min(1).max(10_000),
    perRecipientPerDay: z.number().int().min(1).max(100_000),
    perTenantPerSecond: z.number().int().min(1).max(100_000),
    burstAllowance: z.number().int().min(0).max(10_000),
    appliesToCategories: z.array(z.enum(CONTENT_CATEGORIES)).min(1),
    overrideForPriorities: z.array(z.enum(PRIORITY_LEVELS)).default(["critical"]),
  })
  .superRefine((p, ctx) => {
    if (p.perRecipientPerDay < p.perRecipientPerHour) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["perRecipientPerDay"],
        message: "perRecipientPerDay must be >= perRecipientPerHour",
      });
    }
  });
export type RateLimitPolicy = z.infer<typeof RateLimitPolicySchema>;

export const countRecentDeliveries = (
  attempts: readonly DeliveryAttempt[],
  recipientAddressSha256: string,
  channel: NotificationChannel,
  windowStart: Date,
  now: Date,
): number => {
  const startMs = windowStart.getTime();
  const endMs = now.getTime();
  let count = 0;
  for (const a of attempts) {
    if (a.channel !== channel) continue;
    if (a.recipientAddressSha256 !== recipientAddressSha256) continue;
    if (a.outcome === "suppressed" || a.outcome === "rate_limited") continue;
    const t = Date.parse(a.queuedAt);
    if (t >= startMs && t <= endMs) count++;
  }
  return count;
};

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly reason: "ok" | "hourly_quota_exceeded" | "daily_quota_exceeded" | "tenant_rps_exceeded";
}

export const evaluateRateLimit = (input: {
  readonly policy: RateLimitPolicy;
  readonly priority: PriorityLevel;
  readonly hourlyCount: number;
  readonly dailyCount: number;
  readonly tenantPerSecondCount: number;
}): RateLimitDecision => {
  if (input.policy.overrideForPriorities.includes(input.priority)) {
    return { allowed: true, reason: "ok" };
  }
  if (input.tenantPerSecondCount >= input.policy.perTenantPerSecond) {
    return { allowed: false, reason: "tenant_rps_exceeded" };
  }
  if (input.hourlyCount >= input.policy.perRecipientPerHour) {
    return { allowed: false, reason: "hourly_quota_exceeded" };
  }
  if (input.dailyCount >= input.policy.perRecipientPerDay) {
    return { allowed: false, reason: "daily_quota_exceeded" };
  }
  return { allowed: true, reason: "ok" };
};

export const DigestBatchSchema = z
  .object({
    id: z.string().regex(/^dgst_[A-Za-z0-9_-]{8,40}$/),
    tenantId: z.string().uuid(),
    userId: z.string().uuid(),
    channel: z.enum(NOTIFICATION_CHANNELS),
    frequency: z.enum(DIGEST_FREQUENCIES),
    status: z.enum(DIGEST_STATUSES),
    openedAt: z.string().datetime({ offset: true }),
    scheduledDispatchAt: z.string().datetime({ offset: true }),
    assembledAt: z.string().datetime({ offset: true }).nullable(),
    dispatchedAt: z.string().datetime({ offset: true }).nullable(),
    itemCount: z.number().int().min(0),
    maxItems: z.number().int().min(1).max(1000),
    dedupSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .superRefine((d, ctx) => {
    if (d.frequency === "immediate" || d.frequency === "never") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["frequency"],
        message: "digest batches require non-immediate, non-never frequency",
      });
    }
    if (d.itemCount > d.maxItems) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["itemCount"],
        message: "itemCount exceeds maxItems",
      });
    }
    if (Date.parse(d.scheduledDispatchAt) <= Date.parse(d.openedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scheduledDispatchAt"],
        message: "scheduledDispatchAt must be after openedAt",
      });
    }
    if (d.status === "dispatched" && d.dispatchedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dispatchedAt"],
        message: "dispatched digest requires dispatchedAt",
      });
    }
  });
export type DigestBatch = z.infer<typeof DigestBatchSchema>;
