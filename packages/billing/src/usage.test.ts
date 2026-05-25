import { describe, expect, it } from "vitest";
import {
  buildIdempotencyKey,
  isUsageAnomalous,
  rollupUsage,
  UsageRecordSchema,
  UsagePeriodSchema,
} from "./usage.js";

const now = "2026-05-13T10:00:00.000Z";

describe("UsagePeriodSchema", () => {
  it("rejects end <= start", () => {
    expect(() => UsagePeriodSchema.parse({ start: now, end: now })).toThrow(
      /period.end must be after/,
    );
  });
});

describe("buildIdempotencyKey", () => {
  it("produces a stable per-tenant per-meter per-day key", () => {
    const a = buildIdempotencyKey({
      tenantId: "t_1",
      meter: "ai_call",
      periodStart: "2026-05-13T10:00:00.000Z",
    });
    const b = buildIdempotencyKey({
      tenantId: "t_1",
      meter: "ai_call",
      periodStart: "2026-05-13T23:59:59.000Z",
    });
    expect(a).toBe(b);
    expect(a).toContain("tenant=t_1");
    expect(a).toContain("meter=ai_call");
    expect(a).toContain("day=2026-05-13");
  });

  it("changes when the day rolls over", () => {
    const a = buildIdempotencyKey({
      tenantId: "t_1",
      meter: "ai_call",
      periodStart: "2026-05-13T00:00:00.000Z",
    });
    const b = buildIdempotencyKey({
      tenantId: "t_1",
      meter: "ai_call",
      periodStart: "2026-05-14T00:00:00.000Z",
    });
    expect(a).not.toBe(b);
  });
});

describe("UsageRecordSchema", () => {
  const base = {
    id: "u_1",
    tenantId: "t_1",
    subscriptionId: "sub_1",
    meter: "ai_call" as const,
    period: {
      start: "2026-05-13T00:00:00.000Z",
      end: "2026-05-14T00:00:00.000Z",
    },
    quantity: 42,
    source: "ai_provider_calls" as const,
    recordedAt: now,
    idempotencyKey: "tenant=t_1:meter=ai_call:day=2026-05-13",
  };

  it("parses a fresh record", () => {
    const r = UsageRecordSchema.parse(base);
    expect(r.syncedToStripeAt).toBeNull();
  });

  it("rejects negative quantity", () => {
    expect(() => UsageRecordSchema.parse({ ...base, quantity: -1 })).toThrow();
  });
});

describe("rollupUsage", () => {
  const period = {
    start: "2026-05-13T00:00:00.000Z",
    end: "2026-05-14T00:00:00.000Z",
  };

  it("sums quantities per (tenant, meter, period)", () => {
    const buckets = rollupUsage([
      { tenantId: "t_1", meter: "ai_call", period, quantity: 5 },
      { tenantId: "t_1", meter: "ai_call", period, quantity: 7 },
      { tenantId: "t_1", meter: "storage_gb_month", period, quantity: 2 },
      { tenantId: "t_2", meter: "ai_call", period, quantity: 9 },
    ]);
    expect(buckets).toHaveLength(3);
    const aiCallBucket = buckets.find((b) => b.tenantId === "t_1" && b.meter === "ai_call");
    expect(aiCallBucket?.quantity).toBe(12);
  });
});

describe("isUsageAnomalous", () => {
  it("flags ai_call usage at 10x the rolling average", () => {
    expect(isUsageAnomalous({ meter: "ai_call", currentQuantity: 5000, rollingAverage: 500 })).toBe(
      true,
    );
  });

  it("does not flag at 5x for ai_call (threshold 10x)", () => {
    expect(isUsageAnomalous({ meter: "ai_call", currentQuantity: 2500, rollingAverage: 500 })).toBe(
      false,
    );
  });

  it("storage threshold is more sensitive (5x)", () => {
    expect(
      isUsageAnomalous({ meter: "storage_gb_month", currentQuantity: 5, rollingAverage: 1 }),
    ).toBe(true);
  });

  it("returns false with zero rolling average", () => {
    expect(
      isUsageAnomalous({ meter: "ai_call", currentQuantity: 1_000_000, rollingAverage: 0 }),
    ).toBe(false);
  });
});
