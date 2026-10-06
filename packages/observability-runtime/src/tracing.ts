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

/** Defaults sized so a full collector is tens of MB, not unbounded. */
export const DEFAULT_MAX_TRACES = 1_024;
export const DEFAULT_MAX_SPANS_PER_TRACE = 512;

export interface TraceCollectorOptions {
  readonly maxTraces?: number;
  readonly maxSpansPerTrace?: number;
}

/** What a collector has thrown away, so the loss is countable rather than silent. */
export interface TraceCollectorStats {
  readonly traces: number;
  readonly evictedTraces: number;
  readonly droppedSpans: number;
}

export class TraceCollector {
  private readonly byTrace: Map<string, RecordedSpan[]> = new Map();
  private readonly maxTraces: number;
  private readonly maxSpansPerTrace: number;
  private evictedTraces = 0;
  private droppedSpans = 0;

  /**
   * Both bounds exist because this is a sink in a long-running process.
   *
   * `operate-server` is a long-running process by design (its schedulers run in-process), and a map
   * keyed by trace id with no eviction grows once per request for the life of the process — an OOM
   * with a request counter in front of it. `clear()` existed and nothing was going to call it on a
   * cadence, so the bound is the constructor's business rather than the caller's. Eviction is FIFO
   * on insertion order, which for traces is arrival order, so the oldest *started* trace goes
   * first; that can evict a long trace still receiving spans, which is why the count is reported.
   */
  constructor(options: TraceCollectorOptions = {}) {
    const maxTraces = options.maxTraces ?? DEFAULT_MAX_TRACES;
    const maxSpansPerTrace = options.maxSpansPerTrace ?? DEFAULT_MAX_SPANS_PER_TRACE;
    if (!Number.isInteger(maxTraces) || maxTraces <= 0) {
      throw new Error("maxTraces must be a positive integer");
    }
    if (!Number.isInteger(maxSpansPerTrace) || maxSpansPerTrace <= 0) {
      throw new Error("maxSpansPerTrace must be a positive integer");
    }
    this.maxTraces = maxTraces;
    this.maxSpansPerTrace = maxSpansPerTrace;
  }

  record(span: RecordedSpan): void {
    const parsed = RecordedSpanSchema.parse(span);
    const traceId = parsed.context.traceId;
    const existing = this.byTrace.get(traceId);
    if (existing === undefined) {
      this.evictIfFull();
      this.byTrace.set(traceId, [parsed]);
      return;
    }
    if (existing.length >= this.maxSpansPerTrace) {
      // The newest span is dropped rather than the oldest, deliberately: the oldest span of a trace
      // is normally its root, and dropping that turns every remaining span into an orphan and the
      // whole trace into a forest with no stitching — the one thing this class exists to produce.
      this.droppedSpans += 1;
      return;
    }
    existing.push(parsed);
  }

  stats(): TraceCollectorStats {
    return {
      traces: this.byTrace.size,
      evictedTraces: this.evictedTraces,
      droppedSpans: this.droppedSpans,
    };
  }

  private evictIfFull(): void {
    while (this.byTrace.size >= this.maxTraces) {
      const oldest = this.byTrace.keys().next();
      if (oldest.done === true) return;
      this.byTrace.delete(oldest.value);
      this.evictedTraces += 1;
    }
  }

  spansForTrace(traceId: string): readonly RecordedSpan[] {
    return this.byTrace.get(traceId) ?? [];
  }

  traceIds(): readonly string[] {
    return [...this.byTrace.keys()];
  }

  /**
   * Every span of a trace that has no parent *in this collector*, each with its subtree.
   *
   * A forest and not a tree, because the advertised job — stitching gateway → workflow →
   * notification spans — is **cross-process**, and whether all three processes' spans reached one
   * collector is exactly what cannot be assumed. `buildTree` kept the first root it happened to
   * meet and discarded the rest, so a trace whose gateway span had not arrived yet reported the
   * workflow span as the whole trace, and a trace missing an intermediate span reported a root
   * whose subtree was silently short of everything below the gap. Both read as a complete trace.
   */
  buildForest(traceId: string): readonly SpanNode[] {
    const spans = this.byTrace.get(traceId);
    if (spans === undefined || spans.length === 0) return [];
    const nodes = new Map<string, SpanNode>();
    for (const span of spans) {
      // First writer wins: two spans sharing a span id is a producer bug, and overwriting would
      // drop one from the tree while it still counted in traceDurationMs/services/hasError — the
      // tree and the aggregates would then disagree about the same trace.
      if (!nodes.has(span.context.spanId)) {
        nodes.set(span.context.spanId, { span, children: [] });
      }
    }
    const roots: SpanNode[] = [];
    for (const node of nodes.values()) {
      const parentId = node.span.context.parentSpanId;
      const parent =
        // A span that is its own parent would be pushed into its own children, and any recursive
        // walk of the result — which is what a consumer does with a tree — would never terminate.
        parentId === undefined || parentId === node.span.context.spanId
          ? undefined
          : nodes.get(parentId);
      if (parent === undefined) roots.push(node);
      else parent.children.push(node);
    }
    return roots;
  }

  /**
   * The trace's root, or `null` when this collector does not hold a whole trace.
   *
   * Two conditions, and the second is the one that matters. `null` for a *multi-root* trace rather
   * than a guess, because the callers of a tree are a renderer and a latency attribution and both
   * are wrong in a way nobody would notice if handed one arbitrary root of several. And `null` when
   * the single root **claims a parent**: a span whose `parentSpanId` never arrived is not the root
   * of the trace, it is evidence that the root is somewhere this collector cannot see — so
   * returning it would report a subtree as the whole trace and a 40 ms notification dispatch as a
   * 40 ms request. Use `buildForest` where a partial trace is the expected case.
   */
  buildTree(traceId: string): SpanNode | null {
    const roots = this.buildForest(traceId);
    if (roots.length !== 1) return null;
    const only = roots[0];
    if (only === undefined || only.span.context.parentSpanId !== undefined) return null;
    return only;
  }

  /** How many spans of a trace have a parent this collector never received. */
  orphanCount(traceId: string): number {
    const roots = this.buildForest(traceId);
    return roots.filter((r) => r.span.context.parentSpanId !== undefined).length;
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
