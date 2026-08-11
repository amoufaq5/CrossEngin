import { describe, expect, it } from "vitest";

import { CountingUuidGenerator, FixedClock } from "./clock.js";
import { BillingMeteringEngine } from "./engine.js";
import { aiCall, basePlan, period, subscription, SUBSCRIPTION } from "./test-fixtures.js";

function engine(): BillingMeteringEngine {
  return new BillingMeteringEngine({
    clock: new FixedClock(new Date("2026-07-01T00:00:00.000Z")),
    ids: new CountingUuidGenerator(),
  });
}

describe("BillingMeteringEngine — exit criterion", () => {
  it("meters usage idempotently and drafts an invoice with base + overage", () => {
    const e = engine();
    // 700 ai_calls (as 700 unit events) + a duplicate that must not double-count.
    for (let i = 0; i < 700; i += 1) {
      e.recordUsage(aiCall({ idempotencyKey: `evt-${i.toString()}`, quantity: 1 }));
    }
    e.recordUsage(aiCall({ idempotencyKey: "evt-0", quantity: 1 })); // duplicate

    expect(e.usage(SUBSCRIPTION)[0]?.quantity).toBe(700);

    const result = e.closePeriod({
      subscription,
      plan: basePlan,
      period,
      number: "INV-2026-06-0001",
      source: "ai_provider_calls",
    });

    expect(result.usageRecords).toHaveLength(1);
    expect(result.usageRecords[0]?.quantity).toBe(700);

    const invoice = result.invoice;
    expect(invoice).not.toBeNull();
    expect(invoice?.status).toBe("draft");
    // base 19900 + (700-500)*8 = 1600 ⇒ 21500.
    expect(invoice?.totalCents).toBe(21500);
    const overageLine = invoice?.lineItems.find((l) => l.kind === "usage_overage");
    expect(overageLine?.amountCents).toBe(1600);
    expect(overageLine?.meter).toBe("ai_call");
  });

  it("clears the subscription's buckets after closing (default)", () => {
    const e = engine();
    e.recordUsage(aiCall({ idempotencyKey: "a", quantity: 10 }));
    e.closePeriod({ subscription, plan: basePlan, period, number: "INV-A" });
    expect(e.usage(SUBSCRIPTION)).toEqual([]);
  });

  it("keeps buckets when clearAfter is false", () => {
    const e = engine();
    e.recordUsage(aiCall({ idempotencyKey: "a", quantity: 10 }));
    e.closePeriod({ subscription, plan: basePlan, period, number: "INV-A", clearAfter: false });
    expect(e.usage(SUBSCRIPTION)[0]?.quantity).toBe(10);
  });

  it("still drafts a base-only invoice when usage is within quota", () => {
    const e = engine();
    e.recordUsage(aiCall({ idempotencyKey: "a", quantity: 100 }));
    const result = e.closePeriod({ subscription, plan: basePlan, period, number: "INV-A" });
    expect(result.invoice?.totalCents).toBe(19900);
    expect(result.invoice?.lineItems.every((l) => l.kind !== "usage_overage")).toBe(true);
  });

  it("clearSubscription drops a subscription's buckets without invoicing", () => {
    const e = engine();
    e.recordUsage(aiCall({ idempotencyKey: "a", quantity: 5 }));
    expect(e.usage(SUBSCRIPTION)).toHaveLength(1);
    e.clearSubscription(SUBSCRIPTION);
    expect(e.usage(SUBSCRIPTION)).toEqual([]);
  });

  it("fires onAnomaly when a bucket spikes past the meter threshold", () => {
    const anomalies: number[] = [];
    const e = new BillingMeteringEngine({
      clock: new FixedClock(new Date("2026-07-01T00:00:00.000Z")),
      ids: new CountingUuidGenerator(),
      rollingAverages: new Map([["ai_call", 1]]),
      onAnomaly: (_event, qty) => anomalies.push(qty),
    });
    e.recordUsage(aiCall({ idempotencyKey: "spike", quantity: 1_000_000 }));
    expect(anomalies.length).toBeGreaterThan(0);
  });
});
