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
