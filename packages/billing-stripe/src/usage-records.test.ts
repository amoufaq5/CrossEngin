import { describe, expect, it } from "vitest";

import { StripeClient, type FetchLike } from "./client.js";
import { mapStripeUsageRecord } from "./usage-records.js";

const API_KEY = "sk_test_key";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function buildFetch(capture: CapturedCall[], responseBody: string): FetchLike {
  return async (url, init) => {
    capture.push({ url, method: init.method, headers: init.headers, body: init.body });
    return { ok: true, status: 200, text: async () => responseBody };
  };
}

const USAGE_JSON = JSON.stringify({
  id: "mbur_123",
  object: "usage_record",
  quantity: 200,
  subscription_item: "si_abc",
});

describe("StripeClient.createUsageRecord", () => {
  it("POSTs to the subscription item's usage_records with the quantity + action", async () => {
    const capture: CapturedCall[] = [];
    const client = new StripeClient({ apiKey: API_KEY, fetchImpl: buildFetch(capture, USAGE_JSON) });
    const record = await client.createUsageRecord({
      subscriptionItemId: "si_abc",
      quantity: 200,
      timestamp: 1_700_000_000,
      idempotencyKey: "usg_key_1",
    });
    expect(record.id).toBe("mbur_123");
    expect(record.subscriptionItemId).toBe("si_abc");
    const call = capture[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toContain("/v1/subscription_items/si_abc/usage_records");
    expect(call.body).toContain("quantity=200");
    expect(call.body).toContain("action=increment");
    expect(call.body).toContain("timestamp=1700000000");
  });

  it("sends the idempotency key as Stripe's Idempotency-Key header", async () => {
    const capture: CapturedCall[] = [];
    const client = new StripeClient({ apiKey: API_KEY, fetchImpl: buildFetch(capture, USAGE_JSON) });
    await client.createUsageRecord({ subscriptionItemId: "si_abc", quantity: 5, idempotencyKey: "usg_key_2" });
    expect(capture[0]?.headers["idempotency-key"]).toBe("usg_key_2");
  });

  it("defaults action to increment and omits the header when no key is given", async () => {
    const capture: CapturedCall[] = [];
    const client = new StripeClient({ apiKey: API_KEY, fetchImpl: buildFetch(capture, USAGE_JSON) });
    await client.createUsageRecord({ subscriptionItemId: "si_abc", quantity: 5 });
    expect(capture[0]?.body).toContain("action=increment");
    expect(capture[0]?.headers["idempotency-key"]).toBeUndefined();
  });
});

describe("mapStripeUsageRecord", () => {
  it("maps the id + quantity + subscription item", () => {
    expect(mapStripeUsageRecord(JSON.parse(USAGE_JSON))).toEqual({
      id: "mbur_123",
      quantity: 200,
      subscriptionItemId: "si_abc",
    });
  });

  it("throws when the id is missing", () => {
    expect(() => mapStripeUsageRecord({ quantity: 1 })).toThrow(/missing id/);
  });
});
