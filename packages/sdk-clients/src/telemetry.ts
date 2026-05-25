import { z } from "zod";
import { TargetLanguageSchema } from "./languages.js";

const Iso8601 = z.string().datetime({ offset: true });
const SEMVER_REGEX =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const TRACE_ID_REGEX = /^[0-9a-f]{32}$/;
const SPAN_ID_REGEX = /^[0-9a-f]{16}$/;

export const REQUEST_OUTCOMES = [
  "success",
  "client_error",
  "server_error",
  "timeout",
  "network_error",
  "auth_failure",
  "cancelled",
] as const;
export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];
export const RequestOutcomeSchema = z.enum(REQUEST_OUTCOMES);

export const BREADCRUMB_KINDS = [
  "request_sent",
  "response_received",
  "retry_scheduled",
  "auth_refreshed",
  "rate_limited",
  "redirect_followed",
  "cache_hit",
  "cache_miss",
] as const;
export type BreadcrumbKind = (typeof BREADCRUMB_KINDS)[number];

export const BreadcrumbSchema = z
  .object({
    kind: z.enum(BREADCRUMB_KINDS),
    occurredAt: Iso8601,
    message: z.string().min(1),
    attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  })
  .strict();
export type Breadcrumb = z.infer<typeof BreadcrumbSchema>;

const REDACTABLE_KEYS = [
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "password",
  "secret",
  "token",
];

export function isRedactableHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return REDACTABLE_KEYS.some((k) => lower.includes(k));
}

export const ClientRequestRecordSchema = z
  .object({
    requestId: z.string().min(1),
    parentRequestId: z.string().min(1).optional(),
    operationId: z.string().min(1),
    method: z.string().min(1),
    pathPattern: z.string().regex(/^\/[A-Za-z0-9_:\-/.]*$/),
    apiVersion: z.string().min(1),
    clientLanguage: TargetLanguageSchema,
    clientVersion: z.string().regex(SEMVER_REGEX),
    startedAt: Iso8601,
    completedAt: Iso8601,
    latencyMs: z.number().int().nonnegative(),
    attemptNumber: z.number().int().min(1),
    totalAttempts: z.number().int().min(1),
    outcome: RequestOutcomeSchema,
    responseStatus: z.number().int().min(100).max(599).nullable(),
    bytesSent: z.number().int().nonnegative(),
    bytesReceived: z.number().int().nonnegative(),
    traceId: z.string().regex(TRACE_ID_REGEX).optional(),
    spanId: z.string().regex(SPAN_ID_REGEX).optional(),
    breadcrumbs: z.array(BreadcrumbSchema).max(50).default([]),
    idempotencyKey: z.string().min(1).optional(),
    userAgent: z.string().min(1),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    errorMessage: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    const startMs = new Date(v.startedAt).getTime();
    const endMs = new Date(v.completedAt).getTime();
    if (endMs < startMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completedAt cannot be before startedAt",
      });
    }
    const computed = endMs - startMs;
    if (Math.abs(computed - v.latencyMs) > 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["latencyMs"],
        message: `latencyMs (${v.latencyMs.toString()}) does not match completedAt - startedAt (${computed.toString()})`,
      });
    }
    if (v.attemptNumber > v.totalAttempts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attemptNumber"],
        message: "attemptNumber cannot exceed totalAttempts",
      });
    }
    if (v.outcome === "success") {
      if (v.responseStatus === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["responseStatus"],
          message: "success outcome requires responseStatus",
        });
      } else if (v.responseStatus < 200 || v.responseStatus >= 300) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["responseStatus"],
          message: "success outcome requires 2xx responseStatus",
        });
      }
    }
    if (v.outcome === "client_error" && v.responseStatus !== null) {
      if (v.responseStatus < 400 || v.responseStatus >= 500) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["responseStatus"],
          message: "client_error outcome requires 4xx responseStatus",
        });
      }
    }
    if (v.outcome === "server_error" && v.responseStatus !== null) {
      if (v.responseStatus < 500) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["responseStatus"],
          message: "server_error outcome requires 5xx responseStatus",
        });
      }
    }
    if (
      (v.outcome === "client_error" ||
        v.outcome === "server_error" ||
        v.outcome === "auth_failure") &&
      v.errorCode === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message: `outcome '${v.outcome}' requires errorCode`,
      });
    }
    if ((v.outcome === "network_error" || v.outcome === "timeout") && v.responseStatus !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["responseStatus"],
        message: `outcome '${v.outcome}' must have responseStatus=null`,
      });
    }
    if ((v.spanId !== undefined) !== (v.traceId !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["spanId"],
        message: "traceId and spanId must both be present or both absent (W3C trace context)",
      });
    }
  });
export type ClientRequestRecord = z.infer<typeof ClientRequestRecordSchema>;

export interface UsageAggregate {
  readonly totalRequests: number;
  readonly successfulRequests: number;
  readonly failedRequests: number;
  readonly successRate: number;
  readonly p50LatencyMs: number;
  readonly p99LatencyMs: number;
  readonly totalRetries: number;
}

export function aggregateUsage(records: readonly ClientRequestRecord[]): UsageAggregate {
  if (records.length === 0) {
    return {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      successRate: 0,
      p50LatencyMs: 0,
      p99LatencyMs: 0,
      totalRetries: 0,
    };
  }
  const successful = records.filter((r) => r.outcome === "success").length;
  const failed = records.length - successful;
  const latencies = [...records.map((r) => r.latencyMs)].sort((a, b) => a - b);
  const p50Index = Math.floor(latencies.length * 0.5);
  const p99Index = Math.floor(latencies.length * 0.99);
  const p50 = latencies[p50Index] ?? 0;
  const p99 = latencies[p99Index] ?? 0;
  const totalRetries = records.reduce((acc, r) => acc + (r.attemptNumber - 1), 0);
  return {
    totalRequests: records.length,
    successfulRequests: successful,
    failedRequests: failed,
    successRate: Math.round((successful / records.length) * 10_000) / 10_000,
    p50LatencyMs: p50,
    p99LatencyMs: p99,
    totalRetries,
  };
}

export function redactSensitiveAttributes(
  attributes: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string | number | boolean>> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    out[key] = isRedactableHeader(key) ? "[REDACTED]" : value;
  }
  return out;
}
