import { describe, expect, it } from "vitest";
import {
  BaggageSchema,
  formatTraceparent,
  parseTraceparent,
  SPAN_ATTRIBUTES,
  SpanContextSchema,
  SpanIdSchema,
  TraceIdSchema,
} from "./tracing.js";

describe("SPAN_ATTRIBUTES", () => {
  it("namespaces every key under crossengin.", () => {
    for (const value of Object.values(SPAN_ATTRIBUTES)) {
      expect(value.startsWith("crossengin.")).toBe(true);
    }
  });

  it("declares tenant_id and data_class", () => {
    expect(SPAN_ATTRIBUTES.tenantId).toBe("crossengin.tenant_id");
    expect(SPAN_ATTRIBUTES.dataClass).toBe("crossengin.data_class");
  });
});

describe("TraceIdSchema / SpanIdSchema", () => {
  it("accepts W3C-shaped ids", () => {
    expect(() => TraceIdSchema.parse("0123456789abcdef0123456789abcdef")).not.toThrow();
    expect(() => SpanIdSchema.parse("0123456789abcdef")).not.toThrow();
  });

  it("rejects uppercase hex", () => {
    expect(() => TraceIdSchema.parse("ABCDEF0123456789ABCDEF0123456789")).toThrow();
  });

  it("rejects wrong length", () => {
    expect(() => TraceIdSchema.parse("abc")).toThrow();
    expect(() => SpanIdSchema.parse("0123456789abcdef00")).toThrow();
  });
});

describe("SpanContextSchema", () => {
  it("parses a minimal span context", () => {
    const c = SpanContextSchema.parse({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      sampled: true,
    });
    expect(c.sampled).toBe(true);
  });

  it("accepts an optional parentSpanId", () => {
    const c = SpanContextSchema.parse({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      parentSpanId: "fedcba9876543210",
      sampled: false,
    });
    expect(c.parentSpanId).toBe("fedcba9876543210");
  });
});

describe("BaggageSchema", () => {
  it("requires tenantId", () => {
    expect(() => BaggageSchema.parse({})).toThrow();
    expect(BaggageSchema.parse({ tenantId: "t_1" }).tenantId).toBe("t_1");
  });
});

describe("traceparent helpers", () => {
  const example = {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "fedcba9876543210",
    sampled: true,
  };

  it("formats a W3C traceparent header", () => {
    expect(formatTraceparent(example)).toBe(
      "00-0123456789abcdef0123456789abcdef-fedcba9876543210-01",
    );
  });

  it("emits flags 00 when not sampled", () => {
    expect(formatTraceparent({ ...example, sampled: false })).toMatch(/-00$/);
  });

  it("round-trips parse + format", () => {
    const header = formatTraceparent(example);
    const parsed = parseTraceparent(header);
    expect(parsed?.traceId).toBe(example.traceId);
    expect(parsed?.spanId).toBe(example.spanId);
    expect(parsed?.sampled).toBe(example.sampled);
  });

  it("returns null for malformed headers", () => {
    expect(parseTraceparent("not-a-traceparent")).toBeNull();
    expect(parseTraceparent("01-aa-bb-cc")).toBeNull();
  });
});
