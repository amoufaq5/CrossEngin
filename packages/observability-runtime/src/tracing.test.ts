import { describe, expect, it } from "vitest";
import type { SpanContext } from "@crossengin/observability";
import {
  RecordedSpanSchema,
  TraceCollector,
  childContext,
  type RecordedSpan,
} from "./tracing.js";

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const gatewaySpanId = "b7ad6b7169203331";
const workflowSpanId = "00f067aa0ba902b7";
const notifySpanId = "1234567890abcdef";

const gatewayCtx: SpanContext = { traceId: TRACE, spanId: gatewaySpanId, sampled: true };

const span = (
  ctx: SpanContext,
  service: string,
  name: string,
  startMs: number,
  endMs: number,
  status: "ok" | "error" = "ok",
): RecordedSpan => ({
  context: ctx,
  name,
  kind: "server",
  service,
  startMs,
  endMs,
  status,
  attributes: {},
});

describe("RecordedSpanSchema", () => {
  it("accepts a valid span", () => {
    expect(RecordedSpanSchema.safeParse(span(gatewayCtx, "gateway", "POST /v1/orders", 0, 100)).success).toBe(true);
  });
  it("rejects endMs before startMs", () => {
    expect(RecordedSpanSchema.safeParse(span(gatewayCtx, "gateway", "x", 100, 10)).success).toBe(false);
  });
  it("rejects a malformed trace id", () => {
    const bad = span({ traceId: "short", spanId: gatewaySpanId, sampled: true }, "g", "x", 0, 1);
    expect(RecordedSpanSchema.safeParse(bad).success).toBe(false);
  });
});

describe("childContext", () => {
  it("inherits the trace id and links the parent span", () => {
    const child = childContext(gatewayCtx, workflowSpanId);
    expect(child.traceId).toBe(TRACE);
    expect(child.parentSpanId).toBe(gatewaySpanId);
    expect(child.sampled).toBe(true);
  });
});

describe("TraceCollector", () => {
  function gatewayToNotificationsTrace(): TraceCollector {
    const collector = new TraceCollector();
    const workflowCtx = childContext(gatewayCtx, workflowSpanId);
    const notifyCtx = childContext(workflowCtx, notifySpanId);
    collector.record(span(gatewayCtx, "api-gateway", "POST /v1/orders", 0, 300, "error"));
    collector.record(span(workflowCtx, "workflow-runtime", "order.process", 20, 250));
    collector.record(span(notifyCtx, "notifications", "dispatch.page", 200, 240));
    return collector;
  }

  it("stitches a gateway → workflow → notifications tree", () => {
    const tree = gatewayToNotificationsTrace().buildTree(TRACE);
    expect(tree?.span.service).toBe("api-gateway");
    expect(tree?.children).toHaveLength(1);
    expect(tree?.children[0]?.span.service).toBe("workflow-runtime");
    expect(tree?.children[0]?.children[0]?.span.service).toBe("notifications");
  });

  it("computes total trace duration from span extents", () => {
    expect(gatewayToNotificationsTrace().traceDurationMs(TRACE)).toBe(300);
  });

  it("reports an error anywhere in the trace", () => {
    expect(gatewayToNotificationsTrace().hasError(TRACE)).toBe(true);
  });

  it("lists distinct services", () => {
    expect([...gatewayToNotificationsTrace().services(TRACE)].sort()).toEqual([
      "api-gateway",
      "notifications",
      "workflow-runtime",
    ]);
  });

  it("returns null for an unknown trace", () => {
    expect(new TraceCollector().buildTree("ffffffffffffffffffffffffffffffff")).toBeNull();
    expect(new TraceCollector().traceDurationMs("ffffffffffffffffffffffffffffffff")).toBeNull();
  });

  it("validates spans on record", () => {
    expect(() => new TraceCollector().record(span(gatewayCtx, "g", "x", 100, 1))).toThrow();
  });
});

describe("TraceCollector partial traces", () => {
  const workflowCtx = childContext(gatewayCtx, workflowSpanId);
  const notifyCtx = childContext(workflowCtx, notifySpanId);

  it("reports every root of a trace whose gateway span never arrived", () => {
    // The cross-process case: the workflow and notification processes reported, the gateway's own
    // span did not. Before `buildForest` this answered the workflow span as the whole trace.
    const c = new TraceCollector();
    c.record(span(workflowCtx, "workflow-runtime", "order.process", 20, 250));
    c.record(span(notifyCtx, "notifications", "dispatch.page", 200, 240));
    const forest = c.buildForest(TRACE);
    expect(forest).toHaveLength(1);
    expect(forest[0]?.span.service).toBe("workflow-runtime");
    expect(c.orphanCount(TRACE)).toBe(1);
    expect(c.buildTree(TRACE)).toBeNull();
  });

  it("does not stitch across a missing intermediate span", () => {
    const c = new TraceCollector();
    c.record(span(gatewayCtx, "api-gateway", "POST /v1/orders", 0, 300));
    c.record(span(notifyCtx, "notifications", "dispatch.page", 200, 240));
    const forest = c.buildForest(TRACE);
    expect(forest.map((r) => r.span.service).sort()).toEqual(["api-gateway", "notifications"]);
    expect(c.orphanCount(TRACE)).toBe(1);
    expect(c.buildTree(TRACE)).toBeNull();
  });

  it("keeps the first of two spans sharing a span id", () => {
    const c = new TraceCollector();
    c.record(span(gatewayCtx, "api-gateway", "first", 0, 10));
    c.record(span(gatewayCtx, "impostor", "second", 0, 10));
    expect(c.buildForest(TRACE)).toHaveLength(1);
    expect(c.buildForest(TRACE)[0]?.span.service).toBe("api-gateway");
  });

  it("does not build a cycle from a self-parenting span", () => {
    const c = new TraceCollector();
    c.record(span({ traceId: TRACE, spanId: gatewaySpanId, parentSpanId: gatewaySpanId, sampled: true }, "g", "loop", 0, 1));
    const forest = c.buildForest(TRACE);
    expect(forest).toHaveLength(1);
    expect(forest[0]?.children).toHaveLength(0);
  });
});

describe("TraceCollector bounds", () => {
  const otherTrace = (n: number): SpanContext => ({
    traceId: n.toString(16).padStart(32, "0"),
    spanId: gatewaySpanId,
    sampled: true,
  });

  it("evicts the oldest trace rather than growing without bound", () => {
    const c = new TraceCollector({ maxTraces: 3 });
    for (let i = 1; i <= 5; i += 1) c.record(span(otherTrace(i), "g", "x", 0, 1));
    expect(c.stats().traces).toBe(3);
    expect(c.stats().evictedTraces).toBe(2);
    expect(c.spansForTrace(otherTrace(1).traceId)).toHaveLength(0);
    expect(c.spansForTrace(otherTrace(5).traceId)).toHaveLength(1);
  });

  it("caps spans per trace and counts what it dropped", () => {
    const c = new TraceCollector({ maxSpansPerTrace: 2 });
    c.record(span(gatewayCtx, "api-gateway", "root", 0, 10));
    c.record(span(childContext(gatewayCtx, workflowSpanId), "w", "a", 1, 2));
    c.record(span(childContext(gatewayCtx, notifySpanId), "n", "b", 3, 4));
    expect(c.spansForTrace(TRACE)).toHaveLength(2);
    expect(c.stats().droppedSpans).toBe(1);
    // The root survives, so the trace is still stitched rather than reduced to a flat forest.
    expect(c.buildTree(TRACE)?.span.service).toBe("api-gateway");
  });

  it("refuses a non-positive bound", () => {
    expect(() => new TraceCollector({ maxTraces: 0 })).toThrow(/maxTraces/);
    expect(() => new TraceCollector({ maxSpansPerTrace: -1 })).toThrow(/maxSpansPerTrace/);
  });
});
