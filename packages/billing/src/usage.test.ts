import { describe, expect, it } from "vitest";
import {
  buildIdempotencyKey,
  USAGE_WRITER_REGEX,
  isUsageAnomalous,
  rollupUsage,
  UsageRecordSchema,
  UsagePeriodSchema,
} from "./usage.js";

const now = "2026-05-13T10:00:00.000Z";

describe("UsagePeriodSchema", () => {
  it("rejects end <= start", () => {
    expect(() =>
      UsagePeriodSchema.parse({ start: now, end: now }),
    ).toThrow(/period.end must be after/);
  });
});

describe("buildIdempotencyKey", () => {
  const base = { tenantId: "t_1", subscriptionId: "sub_1", meter: "ai_call" as const, writer: null };

  it("is stable for one window and names tenant, subscription, meter and start", () => {
    const a = buildIdempotencyKey({ ...base, periodStart: "2026-05-13T10:00:00.000Z" });
    const b = buildIdempotencyKey({ ...base, periodStart: "2026-05-13T10:00:00Z" });
    expect(a).toBe(b);
    expect(a).toContain("tenant=t_1");
    expect(a).toContain("subscription=sub_1");
    expect(a).toContain("meter=ai_call");
    expect(a).toContain("start=2026-05-13T10:00:00.000Z");
  });

  it("separates two windows that open on the same day — the overwrite this key used to cause", () => {
    const a = buildIdempotencyKey({ ...base, periodStart: "2026-05-13T10:00:00.000Z" });
    const b = buildIdempotencyKey({ ...base, periodStart: "2026-05-13T23:59:59.000Z" });
    expect(a).not.toBe(b);
  });

  it("separates two subscriptions of one tenant on one meter and window", () => {
    const a = buildIdempotencyKey({ ...base, periodStart: "2026-05-13T00:00:00.000Z" });
    const b = buildIdempotencyKey({ ...base, subscriptionId: "sub_2", periodStart: "2026-05-13T00:00:00.000Z" });
    expect(a).not.toBe(b);
  });

  it("separates two writers' windows that start in the same millisecond (ADR-0483)", () => {
    // Two replicas metering one subscription cut windows from their own clocks; one key for both
    // made `ON CONFLICT DO NOTHING` drop the second replica's usage.
    const start = "2026-05-13T10:00:00.000Z";
    const a = buildIdempotencyKey({ ...base, periodStart: start, writer: "replica-a" });
    const b = buildIdempotencyKey({ ...base, periodStart: start, writer: "replica-b" });
    expect(a).not.toBe(b);
    expect(a).toBe(`${buildIdempotencyKey({ ...base, periodStart: start })}:writer=replica-a`);
    // Stable within a writer, so a retried window is still a no-op.
    expect(buildIdempotencyKey({ ...base, periodStart: start, writer: "replica-a" })).toBe(a);
  });

  it("keeps the writer-less form for a period's own record, and refuses a writer that could break the key", () => {
    expect(buildIdempotencyKey({ ...base, periodStart: "2026-05-13T10:00:00.000Z" })).not.toContain("writer=");
    expect(() => buildIdempotencyKey({ ...base, periodStart: "2026-05-13T10:00:00.000Z", writer: "a:b" })).toThrow(
      /writer id/,
    );
    expect(() => buildIdempotencyKey({ ...base, periodStart: "2026-05-13T10:00:00.000Z", writer: "" })).toThrow();
    expect(USAGE_WRITER_REGEX.test("0c7f4c2e-8a41-4a8e-9b2d-2c8d6b1b9a10")).toBe(true);
  });

  it("requires the writer to be stated, so no caller inherits the colliding form by omission", () => {
    // @ts-expect-error writer is required: null is a claim, absence is not
    const key = buildIdempotencyKey({ tenantId: "t", subscriptionId: "s", meter: "ai_call", periodStart: "2026-05-13T10:00:00.000Z" });
    expect(typeof key).toBe("string");
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
    const aiCallBucket = buckets.find(
      (b) => b.tenantId === "t_1" && b.meter === "ai_call",
    );
    expect(aiCallBucket?.quantity).toBe(12);
  });
});

describe("isUsageAnomalous", () => {
  it("flags ai_call usage at 10x the rolling average", () => {
    expect(
      isUsageAnomalous({ meter: "ai_call", currentQuantity: 5000, rollingAverage: 500 }),
    ).toBe(true);
  });

  it("does not flag at 5x for ai_call (threshold 10x)", () => {
    expect(
      isUsageAnomalous({ meter: "ai_call", currentQuantity: 2500, rollingAverage: 500 }),
    ).toBe(false);
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
