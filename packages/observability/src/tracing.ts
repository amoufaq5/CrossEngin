import { z } from "zod";

export const SPAN_ATTRIBUTES = Object.freeze({
  tenantId: "crossengin.tenant_id",
  userId: "crossengin.user_id",
  sessionId: "crossengin.session_id",
  workflowId: "crossengin.workflow_id",
  workflowRunId: "crossengin.workflow_run_id",
  jobId: "crossengin.job_id",
  jobRunId: "crossengin.job_run_id",
  integrationId: "crossengin.integration_id",
  manifestSlug: "crossengin.manifest_slug",
  manifestVersion: "crossengin.manifest_version",
  manifestHash: "crossengin.manifest_hash",
  region: "crossengin.region",
  dataClass: "crossengin.data_class",
  aiProvider: "crossengin.ai.provider",
  aiModel: "crossengin.ai.model",
  aiCostUsd: "crossengin.ai.cost_usd",
  errorClass: "crossengin.error_class",
} as const);
export type SpanAttributeKey = (typeof SPAN_ATTRIBUTES)[keyof typeof SPAN_ATTRIBUTES];

const TRACE_ID_REGEX = /^[0-9a-f]{32}$/;
const SPAN_ID_REGEX = /^[0-9a-f]{16}$/;

export const TraceIdSchema = z.string().regex(TRACE_ID_REGEX, {
  message: "W3C trace_id must be 32 lowercase hex chars",
});
export type TraceId = z.infer<typeof TraceIdSchema>;

export const SpanIdSchema = z.string().regex(SPAN_ID_REGEX, {
  message: "W3C span_id must be 16 lowercase hex chars",
});
export type SpanId = z.infer<typeof SpanIdSchema>;

export const SpanKindSchema = z.enum(["server", "client", "producer", "consumer", "internal"]);
export type SpanKind = z.infer<typeof SpanKindSchema>;

export const SpanContextSchema = z.object({
  traceId: TraceIdSchema,
  spanId: SpanIdSchema,
  parentSpanId: SpanIdSchema.optional(),
  sampled: z.boolean(),
});
export type SpanContext = z.infer<typeof SpanContextSchema>;

export const BaggageSchema = z.object({
  tenantId: z.string().min(1),
  userId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
});
export type Baggage = z.infer<typeof BaggageSchema>;

const TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(header: string): SpanContext | null {
  const match = header.match(TRACEPARENT_REGEX);
  if (match === null) return null;
  const [, traceId, spanId, flags] = match;
  if (traceId === undefined || spanId === undefined || flags === undefined) return null;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 0x01) === 0x01 };
}

export function formatTraceparent(ctx: SpanContext): string {
  const flags = ctx.sampled ? "01" : "00";
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}
