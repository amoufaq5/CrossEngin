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
});
