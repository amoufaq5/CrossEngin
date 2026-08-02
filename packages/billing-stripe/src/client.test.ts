import { describe, expect, it } from "vitest";

import { StripeClient, type FetchLike, encodeForm } from "./client.js";
import { StripeError } from "./errors.js";

const API_KEY = "sk_test_key";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function buildFetch(opts: {
  status?: number;
  responseBody?: string;
  capture?: CapturedCall[];
  throwErr?: Error;
}): FetchLike {
  const status = opts.status ?? 200;
  return async (url, init) => {
    if (opts.capture !== undefined) {
      opts.capture.push({ url, method: init.method, headers: init.headers, body: init.body });
    }
    if (opts.throwErr !== undefined) {
      throw opts.throwErr;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => opts.responseBody ?? "{}",
    };
  };
}

const SUBSCRIPTION_JSON = JSON.stringify({
  id: "sub_abc",
  object: "subscription",
  customer: "cus_abc",
  status: "active",
  cancel_at_period_end: false,
  current_period_start: 1_700_000_000,
  current_period_end: 1_702_592_000,
  trial_end: null,
  items: { data: [{ price: { id: "price_gold" } }] },
});

describe("encodeForm", () => {
  it("form-encodes flat and nested (metadata) fields", () => {
    const encoded = encodeForm({
      customer: "cus_1",
      "items[0][price]": "price_1",
      metadata: { tenant: "t-1", plan: "gold" },
    });
    expect(encoded).toContain("customer=cus_1");
    expect(encoded).toContain("items%5B0%5D%5Bprice%5D=price_1");
    expect(encoded).toContain("metadata%5Btenant%5D=t-1");
    expect(encoded).toContain("metadata%5Bplan%5D=gold");
  });
});

describe("StripeClient constructor", () => {
  it("rejects an empty apiKey", () => {
    expect(() => new StripeClient({ apiKey: "" })).toThrow(/apiKey is required/);
  });
});

describe("StripeClient.createSubscription", () => {
  it("posts a form-encoded body and maps the response", async () => {
    const capture: CapturedCall[] = [];
    const client = new StripeClient({ apiKey: API_KEY, fetchImpl: buildFetch({ responseBody: SUBSCRIPTION_JSON, capture }) });
    const sub = await client.createSubscription({ customerId: "cus_abc", priceId: "price_gold", trialPeriodDays: 14 });

    expect(sub.id).toBe("sub_abc");
    expect(sub.status).toBe("active");
    expect(sub.priceId).toBe("price_gold");

    const call = capture[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.stripe.com/v1/subscriptions");
    expect(call.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call.body).toContain("customer=cus_abc");
    expect(call.body).toContain("items%5B0%5D%5Bprice%5D=price_gold");
    expect(call.body).toContain("trial_period_days=14");
  });
});

describe("StripeClient.getSubscription", () => {
  it("issues a GET without a body", async () => {
    const capture: CapturedCall[] = [];
    const client = new StripeClient({ apiKey: API_KEY, fetchImpl: buildFetch({ responseBody: SUBSCRIPTION_JSON, capture }) });
    const sub = await client.getSubscription("sub_abc");
    expect(sub.id).toBe("sub_abc");
    const call = capture[0]!;
    expect(call.method).toBe("GET");
    expect(call.url).toBe("https://api.stripe.com/v1/subscriptions/sub_abc");
    expect(call.body).toBeUndefined();
    expect(call.headers["content-type"]).toBeUndefined();
  });
});

describe("StripeClient.cancelSubscription", () => {
  it("DELETEs by default", async () => {
    const capture: CapturedCall[] = [];
    const client = new StripeClient({ apiKey: API_KEY, fetchImpl: buildFetch({ responseBody: SUBSCRIPTION_JSON, capture }) });
    await client.cancelSubscription("sub_abc");
    expect(capture[0]!.method).toBe("DELETE");
    expect(capture[0]!.body).toBeUndefined();
  });

  it("POSTs cancel_at_period_end when atPeriodEnd is set", async () => {
    const capture: CapturedCall[] = [];
    const client = new StripeClient({ apiKey: API_KEY, fetchImpl: buildFetch({ responseBody: SUBSCRIPTION_JSON, capture }) });
    await client.cancelSubscription("sub_abc", { atPeriodEnd: true });
    expect(capture[0]!.method).toBe("POST");
    expect(capture[0]!.body).toContain("cancel_at_period_end=true");
  });
});

describe("StripeClient.createCustomer", () => {
  it("maps the created customer", async () => {
    const capture: CapturedCall[] = [];
    const body = JSON.stringify({ id: "cus_new", email: "a@b.co", name: "Acme" });
    const client = new StripeClient({ apiKey: API_KEY, fetchImpl: buildFetch({ responseBody: body, capture }) });
    const c = await client.createCustomer({ email: "a@b.co", name: "Acme", metadata: { tenant: "t-1" } });
    expect(c.id).toBe("cus_new");
    expect(capture[0]!.body).toContain("email=a%40b.co");
    expect(capture[0]!.body).toContain("metadata%5Btenant%5D=t-1");
  });
});

describe("StripeClient error handling", () => {
  it("throws a StripeError on a 402 card error", async () => {
    const body = JSON.stringify({ error: { type: "card_error", code: "card_declined", message: "declined" } });
    const client = new StripeClient({ apiKey: API_KEY, fetchImpl: buildFetch({ status: 402, responseBody: body }) });
    await expect(client.createSubscription({ customerId: "cus_1", priceId: "price_1" })).rejects.toMatchObject({
      name: "StripeError",
      type: "card_error",
      code: "card_declined",
      httpStatus: 402,
    });
  });

  it("throws a StripeError on a 400 invalid request", async () => {
    const body = JSON.stringify({ error: { type: "invalid_request_error", message: "no such price" } });
    const client = new StripeClient({ apiKey: API_KEY, fetchImpl: buildFetch({ status: 400, responseBody: body }) });
    await expect(client.getSubscription("sub_x")).rejects.toBeInstanceOf(StripeError);
  });

  it("marks a 500 error as retryable", async () => {
    const client = new StripeClient({ apiKey: API_KEY, fetchImpl: buildFetch({ status: 500, responseBody: "" }) });
    try {
      await client.getSubscription("sub_x");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StripeError);
      expect((err as StripeError).isRetryable()).toBe(true);
    }
  });

  it("normalizes a thrown network error", async () => {
    const client = new StripeClient({ apiKey: API_KEY, fetchImpl: buildFetch({ throwErr: new Error("ECONNRESET") }) });
    await expect(client.getSubscription("sub_x")).rejects.toMatchObject({ name: "StripeError", type: "network_error" });
  });
});
