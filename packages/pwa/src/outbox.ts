import { z } from "zod";
import { HTTP_METHODS, type HttpMethod } from "./service-worker.js";

const Iso8601 = z.string().datetime({ offset: true });
const Uuid = z.string().min(1);

export const OUTBOX_STATUSES = [
  "pending",
  "in_flight",
  "succeeded",
  "permanent_failure",
  "abandoned",
] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const OUTBOX_ENTRY_TRANSITIONS: Readonly<Record<OutboxStatus, readonly OutboxStatus[]>> =
  Object.freeze({
    pending: ["in_flight", "abandoned"],
    in_flight: ["succeeded", "pending", "permanent_failure"],
    succeeded: [],
    permanent_failure: [],
    abandoned: [],
  });

export function canTransitionOutbox(from: OutboxStatus, to: OutboxStatus): boolean {
  return OUTBOX_ENTRY_TRANSITIONS[from].includes(to);
}

export const OutboxEntrySchema = z
  .object({
    id: Uuid,
    tenantId: Uuid,
    method: z.enum(HTTP_METHODS),
    path: z.string().min(1),
    headers: z.record(z.string(), z.string()).default({}),
    bodyJson: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1),
    enqueuedAt: Iso8601,
    attempts: z.number().int().nonnegative().default(0),
    lastAttemptAt: Iso8601.nullable().default(null),
    nextRetryAt: Iso8601.nullable().default(null),
    status: z.enum(OUTBOX_STATUSES),
    lastErrorMessage: z.string().min(1).nullable().default(null),
    lastErrorStatusCode: z.number().int().min(100).max(599).nullable().default(null),
    optimisticEntityId: Uuid.optional(),
    canonicalEntityId: Uuid.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.method === "GET" || v.method === "HEAD") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["method"],
        message: `outbox entries must be mutating; '${v.method}' is read-only`,
      });
    }
    if (v.status === "in_flight" && v.lastAttemptAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastAttemptAt"],
        message: "in_flight entries must declare lastAttemptAt",
      });
    }
    if (
      v.status === "succeeded" &&
      v.canonicalEntityId === undefined &&
      v.optimisticEntityId !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canonicalEntityId"],
        message:
          "succeeded entries with optimisticEntityId should record canonicalEntityId for reconciliation",
      });
    }
  });
export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;

export const MAX_ATTEMPTS_BEFORE_ABANDON = 12;

export interface RetryPolicy {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  readonly jitter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  initialDelayMs: 1_000,
  maxDelayMs: 5 * 60 * 1_000,
  multiplier: 2,
  jitter: true,
});

export function nextRetryDelayMs(
  attempts: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number {
  if (attempts < 0) throw new Error("attempts must be non-negative");
  const exponential = policy.initialDelayMs * Math.pow(policy.multiplier, attempts);
  const capped = Math.min(exponential, policy.maxDelayMs);
  if (!policy.jitter) return Math.round(capped);
  const jitterFactor = 0.5 + Math.random() * 0.5;
  return Math.round(capped * jitterFactor);
}

export function isPermanentFailureCode(statusCode: number): boolean {
  if (statusCode === 408 || statusCode === 425 || statusCode === 429) return false;
  if (statusCode >= 500 && statusCode <= 599) return false;
  return statusCode >= 400 && statusCode <= 499;
}

export interface ClassifyResult {
  readonly nextStatus: OutboxStatus;
  readonly reason: string;
}

export function classifyResponse(entry: OutboxEntry, statusCode: number): ClassifyResult {
  if (statusCode >= 200 && statusCode < 300) {
    return { nextStatus: "succeeded", reason: `HTTP ${statusCode}` };
  }
  if (isPermanentFailureCode(statusCode)) {
    return {
      nextStatus: "permanent_failure",
      reason: `HTTP ${statusCode} (non-retryable)`,
    };
  }
  if (entry.attempts + 1 >= MAX_ATTEMPTS_BEFORE_ABANDON) {
    return {
      nextStatus: "abandoned",
      reason: `attempts exhausted (${entry.attempts + 1}/${MAX_ATTEMPTS_BEFORE_ABANDON})`,
    };
  }
  return { nextStatus: "pending", reason: `HTTP ${statusCode} (retry scheduled)` };
}

export function method(entry: OutboxEntry): HttpMethod {
  return entry.method;
}
