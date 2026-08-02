import { describe, expect, it } from "vitest";

import {
  STRIPE_SUBSCRIPTION_STATUSES,
  mapStripeSubscription,
  mapStripeSubscriptionStatus,
} from "./subscriptions.js";

describe("mapStripeSubscriptionStatus", () => {
  it("maps every Stripe status to a billing SubscriptionStatus", () => {
    const table = {
      active: "active",
      trialing: "trialing",
      past_due: "past_due",
      canceled: "canceled",
      unpaid: "unpaid",
      paused: "paused",
      incomplete: "incomplete",
      incomplete_expired: "incomplete",
    } as const;
    for (const raw of STRIPE_SUBSCRIPTION_STATUSES) {
      expect(mapStripeSubscriptionStatus(raw)).toBe(table[raw]);
    }
  });

  it("collapses incomplete_expired to incomplete", () => {
    expect(mapStripeSubscriptionStatus("incomplete_expired")).toBe("incomplete");
  });

  it("throws on an unknown status", () => {
    expect(() => mapStripeSubscriptionStatus("mystery")).toThrow(/Unknown Stripe subscription status/);
  });
});

describe("mapStripeSubscription", () => {
  it("maps a canonical Stripe subscription object", () => {
    const shape = mapStripeSubscription({
      id: "sub_123",
      object: "subscription",
      customer: "cus_456",
      status: "trialing",
      cancel_at_period_end: false,
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_592_000,
      trial_end: 1_701_000_000,
      canceled_at: null,
      items: { data: [{ price: { id: "price_789" } }] },
    });
    expect(shape.id).toBe("sub_123");
    expect(shape.customerId).toBe("cus_456");
    expect(shape.status).toBe("trialing");
    expect(shape.rawStatus).toBe("trialing");
    expect(shape.priceId).toBe("price_789");
    expect(shape.currentPeriodStart).toBe(1_700_000_000);
    expect(shape.currentPeriodEnd).toBe(1_702_592_000);
    expect(shape.trialEnd).toBe(1_701_000_000);
    expect(shape.cancelAtPeriodEnd).toBe(false);
    expect(shape.canceledAt).toBeNull();
  });

  it("reads the period from items.data when absent at the top level", () => {
    const shape = mapStripeSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      cancel_at_period_end: true,
      items: {
        data: [{ price: { id: "price_1" }, current_period_start: 111, current_period_end: 222 }],
      },
    });
    expect(shape.currentPeriodStart).toBe(111);
    expect(shape.currentPeriodEnd).toBe(222);
    expect(shape.cancelAtPeriodEnd).toBe(true);
  });

  it("throws when the response is missing id or status", () => {
    expect(() => mapStripeSubscription({ status: "active" })).toThrow(/missing id/);
    expect(() => mapStripeSubscription({ id: "sub_x" })).toThrow(/missing status/);
    expect(() => mapStripeSubscription(null)).toThrow(/was not an object/);
  });
});
