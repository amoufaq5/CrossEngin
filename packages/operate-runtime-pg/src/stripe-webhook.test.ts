import { computeStripeSignatureHeader } from "@crossengin/billing-stripe";
import { describe, expect, it } from "vitest";

import { ingestStripeWebhook, subscriptionRowFromStripeEvent } from "./stripe-webhook.js";
import type { SubscriptionUpsertRow } from "./subscription-store.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const SECRET = "whsec_test_secret_0123456789abcdef";
const TS = 1_780_000_000;
const NOW = new Date(TS * 1000);

function subscriptionEvent(overrides: Record<string, unknown> = {}, type = "customer.subscription.updated"): string {
  return JSON.stringify({
    type,
    data: {
      object: {
        id: "sub_123",
        customer: "cus_123",
        status: "active",
        items: { data: [{ price: { id: "price_pro" }, current_period_end: TS + 2_592_000 }] },
        metadata: { tenant_id: TENANT, ...(overrides["metadata"] as object ?? {}) },
        ...overrides,
      },
    },
  });
}

class FakeStore {
  readonly inserted: SubscriptionUpsertRow[] = [];
  async insert(row: SubscriptionUpsertRow): Promise<void> {
    this.inserted.push(row);
  }
}

describe("subscriptionRowFromStripeEvent", () => {
  it("maps a subscription event to a row (tenant from metadata, plan from price, cap from metadata)", () => {
    const row = subscriptionRowFromStripeEvent(
      JSON.parse(subscriptionEvent({ metadata: { tenant_id: TENANT, max_records_per_entity: "500", features: "a,b" } })),
    );
    expect(row).toMatchObject({
      tenantId: TENANT,
      planId: "price_pro",
      status: "active",
      maxRecordsPerEntity: 500,
      features: ["a", "b"],
      stripeSubscriptionId: "sub_123",
      stripeCustomerId: "cus_123",
    });
    expect(row?.currentPeriodEnd).toBe(new Date((TS + 2_592_000) * 1000).toISOString());
  });

  it("prefers the planLimits catalog over metadata", () => {
    const row = subscriptionRowFromStripeEvent(JSON.parse(subscriptionEvent()), {
      planLimits: (planId) => (planId === "price_pro" ? { maxRecordsPerEntity: 10, features: ["x"] } : undefined),
    });
    expect(row).toMatchObject({ maxRecordsPerEntity: 10, features: ["x"] });
  });

  it("returns null for a non-subscription event", () => {
    expect(subscriptionRowFromStripeEvent(JSON.parse(JSON.stringify({ type: "invoice.paid", data: { object: {} } })))).toBeNull();
  });

  it("returns null when the subscription has no tenant metadata", () => {
    const noTenant = JSON.stringify({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", status: "active", metadata: {} } },
    });
    expect(subscriptionRowFromStripeEvent(JSON.parse(noTenant))).toBeNull();
  });

  it("maps a deleted (canceled) subscription to a canceled row", () => {
    const row = subscriptionRowFromStripeEvent(
      JSON.parse(subscriptionEvent({ status: "canceled" }, "customer.subscription.deleted")),
    );
    expect(row?.status).toBe("canceled");
  });
});

describe("ingestStripeWebhook", () => {
  function signed(payload: string): string {
    return computeStripeSignatureHeader(payload, SECRET, TS);
  }

  it("verifies + persists a subscription snapshot", async () => {
    const payload = subscriptionEvent();
    const store = new FakeStore();
    const result = await ingestStripeWebhook({ payload, signatureHeader: signed(payload), secret: SECRET, store, now: NOW });
    expect(result).toMatchObject({ ok: true, applied: true, tenantId: TENANT, status: "active" });
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]).toMatchObject({ tenantId: TENANT, planId: "price_pro", status: "active" });
  });

  it("rejects an invalid signature without touching the store", async () => {
    const payload = subscriptionEvent();
    const store = new FakeStore();
    const result = await ingestStripeWebhook({ payload, signatureHeader: "t=1,v1=deadbeef", secret: SECRET, store, now: NOW });
    expect(result.ok).toBe(false);
    expect(store.inserted).toHaveLength(0);
  });

  it("is applied:false for a verified non-subscription event", async () => {
    const payload = JSON.stringify({ type: "invoice.paid", data: { object: {} } });
    const store = new FakeStore();
    const result = await ingestStripeWebhook({ payload, signatureHeader: signed(payload), secret: SECRET, store, now: NOW });
    expect(result).toEqual({ ok: true, applied: false });
    expect(store.inserted).toHaveLength(0);
  });

  it("is applied:false for a subscription event with no tenant attribution", async () => {
    const payload = JSON.stringify({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_x", status: "active", metadata: {} } },
    });
    const store = new FakeStore();
    const result = await ingestStripeWebhook({ payload, signatureHeader: signed(payload), secret: SECRET, store, now: NOW });
    expect(result).toEqual({ ok: true, applied: false });
  });
});
