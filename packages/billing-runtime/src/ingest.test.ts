import { describe, expect, it } from "vitest";

import { bucketKey, parseMeteredUsageEvent, usageRecordFrom } from "./ingest.js";
import { aiCall, period, SUBSCRIPTION, TENANT } from "./test-fixtures.js";

describe("parseMeteredUsageEvent", () => {
  it("accepts a valid event and rejects unknown keys / bad meters", () => {
    expect(() => parseMeteredUsageEvent(aiCall())).not.toThrow();
    expect(() => parseMeteredUsageEvent({ ...aiCall(), bogus: 1 })).toThrow();
    expect(() => parseMeteredUsageEvent({ ...aiCall(), meter: "not_a_meter" })).toThrow();
  });

  it("rejects a negative quantity", () => {
    expect(() => parseMeteredUsageEvent({ ...aiCall(), quantity: -1 })).toThrow();
  });
});

describe("bucketKey", () => {
  it("keys by tenant + subscription + meter", () => {
    expect(bucketKey({ tenantId: "t", subscriptionId: "s", meter: "ai_call" })).toBe("t|s|ai_call");
  });
});

describe("usageRecordFrom", () => {
  it("projects an accumulated total into a schema-valid UsageRecord", () => {
    const record = usageRecordFrom({
      tenantId: TENANT,
      subscriptionId: SUBSCRIPTION,
      meter: "ai_call",
      quantity: 700,
      source: "ai_provider_calls",
      period,
      id: "33333333-3333-3333-3333-333333333333",
      recordedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(record.quantity).toBe(700);
    expect(record.meter).toBe("ai_call");
    expect(record.idempotencyKey.length).toBeGreaterThan(0);
    expect(record.syncedToStripeAt).toBeNull();
  });
});
