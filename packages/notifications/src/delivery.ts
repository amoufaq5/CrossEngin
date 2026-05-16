import { z } from "zod";
import { NOTIFICATION_CHANNELS, PROVIDER_KINDS } from "./channels.js";
import { CONTENT_CATEGORIES } from "./templates.js";

export const DISPATCH_STATUSES = [
  "queued",
  "rendering",
  "rendered",
  "sending",
  "completed",
  "failed",
  "cancelled",
] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

export const DISPATCH_TRANSITIONS: Readonly<
  Record<DispatchStatus, readonly DispatchStatus[]>
> = {
  queued: ["rendering", "cancelled"],
  rendering: ["rendered", "failed", "cancelled"],
  rendered: ["sending", "failed", "cancelled"],
  sending: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const canTransitionDispatch = (
  from: DispatchStatus,
  to: DispatchStatus,
): boolean => DISPATCH_TRANSITIONS[from].includes(to);

export const DELIVERY_OUTCOMES = [
  "queued",
  "delivered",
  "deferred",
  "bounced_hard",
  "bounced_soft",
  "complained",
  "dropped",
  "failed",
  "suppressed",
  "rate_limited",
] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

export const TERMINAL_DELIVERY_OUTCOMES: ReadonlySet<DeliveryOutcome> = new Set([
  "delivered",
  "bounced_hard",
  "complained",
  "dropped",
  "suppressed",
]);

export const RETRYABLE_DELIVERY_OUTCOMES: ReadonlySet<DeliveryOutcome> = new Set(
  ["deferred", "bounced_soft", "failed", "rate_limited"],
);

export const ATTEMPT_KINDS = ["initial", "retry", "escalation"] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

export const PRIORITY_LEVELS = [
  "critical",
  "high",
  "normal",
  "low",
  "background",
] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

export const PRIORITY_MAX_LATENCY_SECONDS: Readonly<
  Record<PriorityLevel, number>
> = {
  critical: 60,
  high: 300,
  normal: 1800,
  low: 14_400,
  background: 86_400,
};

export const NotificationDispatchSchema = z
  .object({
    id: z.string().regex(/^disp_[A-Za-z0-9_-]{8,40}$/),
    tenantId: z.string().uuid(),
    templateId: z.string().min(1).max(120),
    templateVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
    channel: z.enum(NOTIFICATION_CHANNELS),
    category: z.enum(CONTENT_CATEGORIES),
    priority: z.enum(PRIORITY_LEVELS),
    audienceJson: z.record(z.string(), z.unknown()),
    variablesSha256: z.string().regex(/^[0-9a-f]{64}$/),
    correlationId: z.string().max(128).nullable(),
    idempotencyKey: z.string().min(1).max(255),
    status: z.enum(DISPATCH_STATUSES),
    queuedAt: z.string().datetime({ offset: true }),
    startedAt: z.string().datetime({ offset: true }).nullable(),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    recipientCount: z.number().int().min(0),
    deliveredCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
    suppressedCount: z.number().int().min(0),
    cancelledReason: z.string().max(500).nullable(),
    requestedBy: z.string().uuid().nullable(),
    requestingSystem: z.string().min(1).max(80),
  })
  .superRefine((d, ctx) => {
    if (d.status === "completed" && d.completedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completed dispatch requires completedAt",
      });
    }
    if (d.status === "cancelled" && d.cancelledReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cancelledReason"],
        message: "cancelled dispatch requires cancelledReason",
      });
    }
    if (
      d.deliveredCount + d.failedCount + d.suppressedCount >
      d.recipientCount
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipientCount"],
        message:
          "delivered + failed + suppressed cannot exceed recipientCount",
      });
    }
    if (d.startedAt !== null && d.completedAt !== null) {
      if (Date.parse(d.completedAt) < Date.parse(d.startedAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: "completedAt cannot precede startedAt",
        });
      }
    }
  });
export type NotificationDispatch = z.infer<typeof NotificationDispatchSchema>;

export const DeliveryAttemptSchema = z
  .object({
    id: z.string().regex(/^dlv_[A-Za-z0-9_-]{8,40}$/),
    dispatchId: z.string().regex(/^disp_[A-Za-z0-9_-]{8,40}$/),
    tenantId: z.string().uuid(),
    channel: z.enum(NOTIFICATION_CHANNELS),
    provider: z.enum(PROVIDER_KINDS),
    recipientAddressSha256: z.string().regex(/^[0-9a-f]{64}$/),
    attemptKind: z.enum(ATTEMPT_KINDS),
    attemptNumber: z.number().int().min(1).max(20),
    queuedAt: z.string().datetime({ offset: true }),
    sentAt: z.string().datetime({ offset: true }).nullable(),
    finalizedAt: z.string().datetime({ offset: true }).nullable(),
    latencyMs: z.number().int().min(0).max(600_000).nullable(),
    outcome: z.enum(DELIVERY_OUTCOMES),
    providerMessageId: z.string().max(255).nullable(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    bytesSent: z.number().int().min(0).nullable(),
    smsSegments: z.number().int().min(0).max(20).nullable(),
    errorCode: z.string().max(80).nullable(),
    errorMessage: z.string().max(500).nullable(),
    nextRetryAt: z.string().datetime({ offset: true }).nullable(),
  })
  .superRefine((a, ctx) => {
    if (a.attemptKind === "initial" && a.attemptNumber !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attemptNumber"],
        message: "initial attempt must have attemptNumber=1",
      });
    }
    if (a.attemptKind === "retry" && a.attemptNumber < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attemptNumber"],
        message: "retry attempt must have attemptNumber>=2",
      });
    }
    if (RETRYABLE_DELIVERY_OUTCOMES.has(a.outcome) && a.nextRetryAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextRetryAt"],
        message: `outcome ${a.outcome} requires nextRetryAt`,
      });
    }
    if (TERMINAL_DELIVERY_OUTCOMES.has(a.outcome) && a.nextRetryAt !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextRetryAt"],
        message: `terminal outcome ${a.outcome} must not have nextRetryAt`,
      });
    }
    if (
      (a.outcome === "bounced_hard" ||
        a.outcome === "bounced_soft" ||
        a.outcome === "failed") &&
      a.errorCode === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message: `outcome ${a.outcome} requires errorCode`,
      });
    }
    if (a.channel === "sms" && a.outcome === "delivered" && a.smsSegments === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["smsSegments"],
        message: "delivered SMS requires smsSegments",
      });
    }
    if (a.sentAt !== null && a.finalizedAt !== null) {
      const sent = Date.parse(a.sentAt);
      const fin = Date.parse(a.finalizedAt);
      if (fin < sent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["finalizedAt"],
          message: "finalizedAt cannot precede sentAt",
        });
      }
      if (a.latencyMs !== null) {
        const expected = fin - sent;
        if (Math.abs(expected - a.latencyMs) > 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["latencyMs"],
            message: `latencyMs ${a.latencyMs} does not match finalizedAt - sentAt (${expected})`,
          });
        }
      }
    }
  });
export type DeliveryAttempt = z.infer<typeof DeliveryAttemptSchema>;

export interface RetryDecisionInput {
  readonly outcome: DeliveryOutcome;
  readonly attemptNumber: number;
  readonly maxAttempts: number;
  readonly initialBackoffSeconds: number;
  readonly now: Date;
}

export interface RetryDecision {
  readonly shouldRetry: boolean;
  readonly nextRetryAt: string | null;
  readonly reason: string;
}

export const decideRetry = (input: RetryDecisionInput): RetryDecision => {
  if (!RETRYABLE_DELIVERY_OUTCOMES.has(input.outcome)) {
    return {
      shouldRetry: false,
      nextRetryAt: null,
      reason: "outcome_not_retryable",
    };
  }
  if (input.attemptNumber >= input.maxAttempts) {
    return {
      shouldRetry: false,
      nextRetryAt: null,
      reason: "max_attempts_exhausted",
    };
  }
  const backoffSec =
    input.initialBackoffSeconds * Math.pow(2, input.attemptNumber - 1);
  const cappedSec = Math.min(backoffSec, 3600);
  const nextRetry = new Date(input.now.getTime() + cappedSec * 1000);
  return {
    shouldRetry: true,
    nextRetryAt: nextRetry.toISOString(),
    reason: `retry_in_${cappedSec}s`,
  };
};

export interface DispatchSummary {
  readonly totalDispatches: number;
  readonly totalRecipients: number;
  readonly totalDelivered: number;
  readonly totalFailed: number;
  readonly totalSuppressed: number;
  readonly deliveryRate: number;
  readonly p50LatencyMs: number;
  readonly p99LatencyMs: number;
}

const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
};

export const summarizeDispatches = (
  dispatches: readonly NotificationDispatch[],
  attempts: readonly DeliveryAttempt[],
): DispatchSummary => {
  if (dispatches.length === 0 && attempts.length === 0) {
    return {
      totalDispatches: 0,
      totalRecipients: 0,
      totalDelivered: 0,
      totalFailed: 0,
      totalSuppressed: 0,
      deliveryRate: 0,
      p50LatencyMs: 0,
      p99LatencyMs: 0,
    };
  }
  const totalRecipients = dispatches.reduce(
    (sum, d) => sum + d.recipientCount,
    0,
  );
  const totalDelivered = dispatches.reduce(
    (sum, d) => sum + d.deliveredCount,
    0,
  );
  const totalFailed = dispatches.reduce((sum, d) => sum + d.failedCount, 0);
  const totalSuppressed = dispatches.reduce(
    (sum, d) => sum + d.suppressedCount,
    0,
  );
  const latencies = attempts
    .filter((a) => a.latencyMs !== null)
    .map((a) => a.latencyMs as number)
    .sort((a, b) => a - b);
  return {
    totalDispatches: dispatches.length,
    totalRecipients,
    totalDelivered,
    totalFailed,
    totalSuppressed,
    deliveryRate: totalRecipients > 0 ? totalDelivered / totalRecipients : 0,
    p50LatencyMs: percentile(latencies, 50),
    p99LatencyMs: percentile(latencies, 99),
  };
};
