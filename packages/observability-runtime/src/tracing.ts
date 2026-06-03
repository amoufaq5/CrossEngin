import { z } from "zod";
import {
  SpanContextSchema,
  SpanKindSchema,
  type SpanContext,
} from "@crossengin/observability";

export const SPAN_STATUSES = ["unset", "ok", "error"] as const;
export type SpanStatus = (typeof SPAN_STATUSES)[number];

export const RecordedSpanSchema = z
  .object({
    context: SpanContextSchema,
    name: z.string().min(1),
    kind: SpanKindSchema,
    service: z.string().min(1),
    startMs: z.number().nonnegative(),
    endMs: z.number().nonnegative(),
    status: z.enum(SPAN_STATUSES).default("unset"),
    attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.endMs < v.startMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endMs"],
        message: "endMs cannot be before startMs",
      });
    }
  });
export type RecordedSpan = z.infer<typeof RecordedSpanSchema>;

export interface SpanNode {
  readonly span: RecordedSpan;
  readonly children: SpanNode[];
}

export function childContext(parent: SpanContext, spanId: string): SpanContext {
  return {
    traceId: parent.traceId,
    spanId,
    parentSpanId: parent.spanId,
    sampled: parent.sampled,
  };
}

export class TraceCollector {
  private readonly byTrace: Map<string, RecordedSpan[]> = new Map();

  record(span: RecordedSpan): void {
    const parsed = RecordedSpanSchema.parse(span);
    const list = this.byTrace.get(parsed.context.traceId) ?? [];
    list.push(parsed);
    this.byTrace.set(parsed.context.traceId, list);
  }

  spansForTrace(traceId: string): readonly RecordedSpan[] {
    return this.byTrace.get(traceId) ?? [];
  }

  traceIds(): readonly string[] {
    return [...this.byTrace.keys()];
  }

  buildTree(traceId: string): SpanNode | null {
    const spans = this.byTrace.get(traceId);
    if (spans === undefined || spans.length === 0) return null;
    const nodes = new Map<string, SpanNode>();
    for (const span of spans) {
      nodes.set(span.context.spanId, { span, children: [] });
    }
    let root: SpanNode | null = null;
    for (const node of nodes.values()) {
      const parentId = node.span.context.parentSpanId;
      if (parentId !== undefined && nodes.has(parentId)) {
        nodes.get(parentId)?.children.push(node);
      } else if (root === null) {
        root = node;
      }
    }
    return root;
  }

  traceDurationMs(traceId: string): number | null {
    const spans = this.byTrace.get(traceId);
    if (spans === undefined || spans.length === 0) return null;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const span of spans) {
      if (span.startMs < min) min = span.startMs;
      if (span.endMs > max) max = span.endMs;
    }
    return max - min;
  }

  hasError(traceId: string): boolean {
    const spans = this.byTrace.get(traceId);
    if (spans === undefined) return false;
    return spans.some((s) => s.status === "error");
  }

  services(traceId: string): readonly string[] {
    const spans = this.byTrace.get(traceId);
    if (spans === undefined) return [];
    return [...new Set(spans.map((s) => s.service))];
  }

  clear(): void {
    this.byTrace.clear();
  }
}
