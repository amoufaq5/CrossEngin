import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const ENDPOINT_ID_REGEX = /^whk_[A-Za-z0-9]{8,32}$/;
const SHA256_REGEX = /^[0-9a-f]{64}$/;

export const WEBHOOK_EVENTS = [
  "tenant.created",
  "tenant.updated",
  "tenant.suspended",
  "manifest.applied",
  "manifest.proposed",
  "user.invited",
  "user.activated",
  "user.deactivated",
  "billing.invoice_issued",
  "billing.invoice_paid",
  "billing.invoice_failed",
  "billing.subscription_changed",
  "audit.high_severity_event",
  "deployment.succeeded",
  "deployment.failed",
  "deployment.rolled_back",
  "ai_architect.session_aborted",
  "compliance.attestation_recorded",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const WebhookEventSchema = z.enum(WEBHOOK_EVENTS);

export const WEBHOOK_DELIVERY_STATUSES = [
  "pending",
  "delivering",
  "delivered",
  "retrying",
  "failed",
  "dropped",
] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];
export const WebhookDeliveryStatusSchema = z.enum(WEBHOOK_DELIVERY_STATUSES);

export const WEBHOOK_DELIVERY_TRANSITIONS: Readonly<
  Record<WebhookDeliveryStatus, readonly WebhookDeliveryStatus[]>
> = Object.freeze({
  pending: ["delivering", "dropped"],
  delivering: ["delivered", "retrying", "failed"],
  delivered: [],
  retrying: ["delivering", "failed", "dropped"],
  failed: ["retrying"],
  dropped: [],
});

export function canTransitionWebhookDelivery(
  from: WebhookDeliveryStatus,
  to: WebhookDeliveryStatus,
): boolean {
  return WEBHOOK_DELIVERY_TRANSITIONS[from].includes(to);
}

export const WebhookEndpointSchema = z
  .object({
    id: z.string().regex(ENDPOINT_ID_REGEX, {
      message: "endpoint id must be 'whk_' followed by 8..32 alphanumeric chars",
    }),
    tenantId: z.string().min(1),
    url: z.string().url(),
    events: z.array(WebhookEventSchema).min(1),
    signingSecretHash: z.string().regex(SHA256_REGEX),
    signingAlgorithm: z.literal("hmac-sha256"),
    enabled: z.boolean().default(true),
    description: z.string().min(1).optional(),
    createdAt: Iso8601,
    createdBy: z.string().min(1),
    lastDeliveredAt: Iso8601.nullable().default(null),
    lastFailureAt: Iso8601.nullable().default(null),
    consecutiveFailures: z.number().int().nonnegative().default(0),
    disabledReason: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.url.startsWith("https://")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "webhook URL must use HTTPS",
      });
    }
    const seen = new Set<WebhookEvent>();
    v.events.forEach((e, i) => {
      if (seen.has(e)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["events", i],
          message: `duplicate event '${e}'`,
        });
      }
      seen.add(e);
    });
    if (!v.enabled && v.disabledReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["disabledReason"],
        message: "disabled endpoints must declare disabledReason",
      });
    }
    if (v.consecutiveFailures > 0 && v.lastFailureAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastFailureAt"],
        message: "consecutiveFailures > 0 requires lastFailureAt",
      });
    }
  });
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;

export const WebhookDeliveryRecordSchema = z
  .object({
    id: z.string().min(1),
    endpointId: z.string().regex(ENDPOINT_ID_REGEX),
    event: WebhookEventSchema,
    payloadHash: z.string().regex(SHA256_REGEX),
    signature: z.string().regex(/^t=[0-9]+,v1=[0-9a-f]{64}$/, {
      message: "signature must be 't=<unix_seconds>,v1=<sha256_hex>'",
    }),
    signedAt: Iso8601,
    status: WebhookDeliveryStatusSchema,
    attempt: z.number().int().min(1),
    maxAttempts: z.number().int().min(1).default(8),
    responseStatus: z.number().int().min(100).max(599).nullable().default(null),
    responseBodySha256: z.string().regex(SHA256_REGEX).nullable().default(null),
    deliveredAt: Iso8601.nullable().default(null),
    failedAt: Iso8601.nullable().default(null),
    failureReason: z.string().min(1).optional(),
    nextRetryAt: Iso8601.nullable().default(null),
    droppedReason: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.attempt > v.maxAttempts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attempt"],
        message: "attempt cannot exceed maxAttempts",
      });
    }
    if (v.status === "delivered") {
      if (v.deliveredAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deliveredAt"],
          message: "delivered status requires deliveredAt",
        });
      }
      if (v.responseStatus === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["responseStatus"],
          message: "delivered status requires responseStatus",
        });
      }
    }
    if (v.status === "failed") {
      if (v.failedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failedAt"],
          message: "failed status requires failedAt",
        });
      }
      if (v.failureReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failureReason"],
          message: "failed status requires failureReason",
        });
      }
    }
    if (v.status === "retrying" && v.nextRetryAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextRetryAt"],
        message: "retrying status requires nextRetryAt",
      });
    }
    if (v.status === "dropped" && v.droppedReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["droppedReason"],
        message: "dropped status requires droppedReason",
      });
    }
  });
export type WebhookDeliveryRecord = z.infer<typeof WebhookDeliveryRecordSchema>;

export const DEFAULT_MAX_ATTEMPTS = 8;
export const RETRY_INITIAL_DELAY_MS = 1_000;
export const RETRY_MAX_DELAY_MS = 3_600_000;

export function nextRetryDelayMs(attempt: number): number {
  const exp = Math.min(attempt - 1, 12);
  const delay = RETRY_INITIAL_DELAY_MS * Math.pow(2, exp);
  return Math.min(delay, RETRY_MAX_DELAY_MS);
}

export function shouldRetry(
  record: WebhookDeliveryRecord,
  httpStatus: number,
): boolean {
  if (record.attempt >= record.maxAttempts) return false;
  if (httpStatus >= 200 && httpStatus < 300) return false;
  if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429) {
    return false;
  }
  return true;
}

export function canonicalSignaturePayload(input: {
  readonly timestampSeconds: number;
  readonly body: string;
}): string {
  return `${input.timestampSeconds.toString()}.${input.body}`;
}

export function formatSignatureHeader(
  timestampSeconds: number,
  sha256Hex: string,
): string {
  return `t=${timestampSeconds.toString()},v1=${sha256Hex}`;
}

const SIGNATURE_REGEX = /^t=([0-9]+),v1=([0-9a-f]{64})$/;

export function parseSignatureHeader(
  header: string,
): { readonly timestampSeconds: number; readonly sha256: string } | null {
  const match = header.match(SIGNATURE_REGEX);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  return {
    timestampSeconds: Number.parseInt(match[1], 10),
    sha256: match[2],
  };
}

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function isSignatureFresh(
  signedAtSeconds: number,
  nowSeconds: number,
): boolean {
  const drift = Math.abs(nowSeconds - signedAtSeconds);
  return drift <= SIGNATURE_TOLERANCE_SECONDS;
}

export const SIGNATURE_HEADER_NAME = "CrossEngin-Signature";
export const EVENT_HEADER_NAME = "CrossEngin-Event";
export const DELIVERY_HEADER_NAME = "CrossEngin-Delivery";
