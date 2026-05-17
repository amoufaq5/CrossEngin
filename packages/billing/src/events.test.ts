import { describe, expect, it } from "vitest";
import {
  affectsBilling,
  BILLING_EVENT_KINDS,
  BillingEventSchema,
  FINANCIAL_AUDIT_RETENTION,
  isLifecycleEvent,
} from "./events.js";

const now = "2026-05-13T10:00:00.000Z";

describe("BillingEventSchema", () => {
  it("parses a user-issued plan_changed event", () => {
    expect(() =>
      BillingEventSchema.parse({
        id: "be_1",
        tenantId: "t_1",
        kind: "plan_changed",
        actor: { kind: "user", userId: "u_admin" },
        occurredAt: now,
        subscriptionId: "sub_1",
      }),
    ).not.toThrow();
  });

  it("parses a Stripe-webhook invoice_paid event", () => {
    const e = BillingEventSchema.parse({
      id: "be_2",
      tenantId: "t_1",
      kind: "invoice_paid",
      actor: { kind: "stripe_webhook", eventId: "evt_abc" },
      occurredAt: now,
      invoiceId: "inv_1",
      amountCents: 20895,
      currency: "USD",
    });
    expect(e.actor.kind).toBe("stripe_webhook");
  });

  it("parses a system-issued usage_synced event", () => {
    expect(() =>
      BillingEventSchema.parse({
        id: "be_3",
        tenantId: "t_1",
        kind: "usage_synced",
        actor: { kind: "system", component: "metering-sync" },
        occurredAt: now,
      }),
    ).not.toThrow();
  });

  it("rejects an unknown event kind", () => {
    expect(() =>
      BillingEventSchema.parse({
        id: "be_4",
        tenantId: "t_1",
        kind: "subscription_celebrated",
        actor: { kind: "user", userId: "u" },
        occurredAt: now,
      }),
    ).toThrow();
  });

  it("BILLING_EVENT_KINDS includes the 20 documented kinds", () => {
    expect(BILLING_EVENT_KINDS).toHaveLength(20);
    expect(BILLING_EVENT_KINDS).toContain("dunning_advanced");
    expect(BILLING_EVENT_KINDS).toContain("trial_converted");
  });
});

describe("affectsBilling / isLifecycleEvent", () => {
  it("affectsBilling is true when amountCents is non-zero", () => {
    const e = BillingEventSchema.parse({
      id: "be",
      tenantId: "t",
      kind: "invoice_paid",
      actor: { kind: "stripe_webhook", eventId: "evt" },
      occurredAt: now,
      amountCents: 100,
      currency: "USD",
    });
    expect(affectsBilling(e)).toBe(true);
  });

  it("affectsBilling is false when amountCents is null", () => {
    const e = BillingEventSchema.parse({
      id: "be",
      tenantId: "t",
      kind: "trial_started",
      actor: { kind: "user", userId: "u" },
      occurredAt: now,
    });
    expect(affectsBilling(e)).toBe(false);
  });

  it("isLifecycleEvent recognises subscription_* events", () => {
    const e = BillingEventSchema.parse({
      id: "be",
      tenantId: "t",
      kind: "subscription_changed",
      actor: { kind: "user", userId: "u" },
      occurredAt: now,
    });
    expect(isLifecycleEvent(e)).toBe(true);
  });
});

describe("FINANCIAL_AUDIT_RETENTION", () => {
  it("retains 7 years (financial audit requirement)", () => {
    expect(FINANCIAL_AUDIT_RETENTION.minYears).toBe(7);
  });
});
