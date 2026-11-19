import { describe, expect, it } from "vitest";

import { UsageMeter } from "./meter.js";
import { aiCall, SUBSCRIPTION } from "./test-fixtures.js";

describe("UsageMeter", () => {
  it("accumulates quantity per (tenant, subscription, meter)", () => {
    const meter = new UsageMeter();
    meter.record(aiCall({ idempotencyKey: "a", quantity: 3 }));
    meter.record(aiCall({ idempotencyKey: "b", quantity: 5 }));
    expect(meter.quantityFor(SUBSCRIPTION, "ai_call")).toBe(8);
    const buckets = meter.bucketsFor(SUBSCRIPTION);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.eventCount).toBe(2);
  });

  it("ignores a duplicate idempotencyKey (no double-count)", () => {
    const meter = new UsageMeter();
    expect(meter.record(aiCall({ idempotencyKey: "dup", quantity: 4 }))).toEqual({ accepted: true, duplicate: false });
    expect(meter.record(aiCall({ idempotencyKey: "dup", quantity: 4 }))).toEqual({ accepted: false, duplicate: true });
    expect(meter.quantityFor(SUBSCRIPTION, "ai_call")).toBe(4);
  });

  it("separates buckets by meter", () => {
    const meter = new UsageMeter();
    meter.record(aiCall({ idempotencyKey: "a", quantity: 2 }));
    meter.record(aiCall({ idempotencyKey: "b", meter: "job_run", source: "job_costs", quantity: 7 }));
    expect(meter.quantityFor(SUBSCRIPTION, "ai_call")).toBe(2);
    expect(meter.quantityFor(SUBSCRIPTION, "job_run")).toBe(7);
    expect(meter.bucketsFor(SUBSCRIPTION)).toHaveLength(2);
  });

  it("clears a subscription's buckets", () => {
    const meter = new UsageMeter();
    meter.record(aiCall({ idempotencyKey: "a", quantity: 2 }));
    meter.clearSubscription(SUBSCRIPTION);
    expect(meter.bucketsFor(SUBSCRIPTION)).toEqual([]);
    // A previously-seen key stays de-duplicated even after clearing buckets.
    expect(meter.record(aiCall({ idempotencyKey: "a", quantity: 2 })).duplicate).toBe(true);
  });

  it("forgets a key once it falls outside the retention window — the set no longer grows for ever", () => {
    const meter = new UsageMeter({ dedupRetentionMs: 60_000 });
    meter.record(aiCall({ idempotencyKey: "old", occurredAt: "2026-06-15T12:00:00.000Z" }));
    meter.record(aiCall({ idempotencyKey: "new", occurredAt: "2026-06-15T12:05:00.000Z" }));
    expect(meter.dedupStats()).toEqual({ remembered: 1, evictedWithinRetention: 0 });
    // Inside the window a retry is still refused.
    expect(meter.record(aiCall({ idempotencyKey: "new", occurredAt: "2026-06-15T12:05:00.000Z" })).duplicate).toBe(true);
  });

  it("caps the remembered keys and counts an eviction that was still inside the window", () => {
    const meter = new UsageMeter({ maxDedupKeys: 2 });
    for (const k of ["a", "b", "c"]) meter.record(aiCall({ idempotencyKey: k }));
    expect(meter.dedupStats()).toEqual({ remembered: 2, evictedWithinRetention: 1 });
    expect(meter.record(aiCall({ idempotencyKey: "c" })).duplicate).toBe(true);
    expect(meter.record(aiCall({ idempotencyKey: "a" })).duplicate).toBe(false);
  });

  it("refuses a non-positive retention or cap", () => {
    expect(() => new UsageMeter({ dedupRetentionMs: 0 })).toThrow(/dedupRetentionMs/);
    expect(() => new UsageMeter({ maxDedupKeys: 0 })).toThrow(/maxDedupKeys/);
  });

  it("takes a subscription's buckets in one step and keeps later events apart", () => {
    const meter = new UsageMeter();
    meter.record(aiCall({ idempotencyKey: "a", quantity: 2 }));
    const taken = meter.takeSubscription(SUBSCRIPTION);
    expect(taken.map((b) => b.quantity)).toEqual([2]);
    meter.record(aiCall({ idempotencyKey: "b", quantity: 5 }));
    expect(meter.quantityFor(SUBSCRIPTION, "ai_call")).toBe(5);
    expect(meter.record(aiCall({ idempotencyKey: "a", quantity: 2 })).duplicate).toBe(true);
  });
});
