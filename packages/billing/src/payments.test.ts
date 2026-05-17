import { describe, expect, it } from "vitest";
import {
  applyCredit,
  isCardExpired,
  PaymentMethodSchema,
  RefundSchema,
  TenantCreditSchema,
} from "./payments.js";

const now = "2026-05-13T10:00:00.000Z";

describe("PaymentMethodSchema", () => {
  it("parses a Visa card", () => {
    const pm = PaymentMethodSchema.parse({
      id: "pm_1",
      tenantId: "t_1",
      kind: "card",
      stripePaymentMethodId: "pm_abc",
      last4: "4242",
      brand: "visa",
      expMonth: 12,
      expYear: 2028,
      createdAt: now,
    });
    expect(pm.brand).toBe("visa");
  });

  it("requires last4 + brand + expMonth + expYear for card kind", () => {
    expect(() =>
      PaymentMethodSchema.parse({
        id: "pm_1",
        tenantId: "t_1",
        kind: "card",
        stripePaymentMethodId: "pm_abc",
        createdAt: now,
      }),
    ).toThrow(/card payment methods must declare/);
  });

  it("parses a SEPA debit without card fields", () => {
    expect(() =>
      PaymentMethodSchema.parse({
        id: "pm_2",
        tenantId: "t_1",
        kind: "sepa_debit",
        stripePaymentMethodId: "pm_def",
        createdAt: now,
      }),
    ).not.toThrow();
  });

  it("rejects malformed last4", () => {
    expect(() =>
      PaymentMethodSchema.parse({
        id: "pm_1",
        tenantId: "t_1",
        kind: "card",
        stripePaymentMethodId: "pm_abc",
        last4: "42",
        brand: "visa",
        expMonth: 12,
        expYear: 2028,
        createdAt: now,
      }),
    ).toThrow();
  });
});

describe("isCardExpired", () => {
  const cardFor = (expMonth: number, expYear: number) =>
    PaymentMethodSchema.parse({
      id: "pm",
      tenantId: "t",
      kind: "card",
      stripePaymentMethodId: "pm_abc",
      last4: "4242",
      brand: "visa",
      expMonth,
      expYear,
      createdAt: now,
    });

  it("returns false on the last day of the expiry month", () => {
    expect(isCardExpired(cardFor(12, 2028), new Date("2028-12-31T23:59:59.000Z"))).toBe(false);
  });

  it("returns true on the first day of the month after expiry", () => {
    expect(isCardExpired(cardFor(12, 2028), new Date("2029-01-01T00:00:01.000Z"))).toBe(true);
  });
});

describe("RefundSchema", () => {
  it("parses a customer-requested refund", () => {
    expect(() =>
      RefundSchema.parse({
        id: "ref_1",
        tenantId: "t_1",
        invoiceId: "inv_1",
        amountCents: 5000,
        currency: "USD",
        reason: "requested_by_customer",
        status: "succeeded",
        issuedBy: "u_admin",
        issuedAt: now,
        succeededAt: now,
        stripeRefundId: "re_abc",
      }),
    ).not.toThrow();
  });
});

describe("TenantCreditSchema + applyCredit", () => {
  const credit = TenantCreditSchema.parse({
    id: "c_1",
    tenantId: "t_1",
    amountCents: 10_000,
    remainingCents: 10_000,
    currency: "USD",
    kind: "sla_credit",
    reason: "Q2 2026 uptime SLA breach",
    issuedBy: "u_admin",
    issuedAt: now,
  });

  it("applies up to the invoice amount when credit is sufficient", () => {
    const r = applyCredit(credit, 3000);
    expect(r.applyCents).toBe(3000);
    expect(r.remainingAfter).toBe(7000);
  });

  it("applies only what's remaining when invoice exceeds credit", () => {
    const small = TenantCreditSchema.parse({
      ...credit,
      remainingCents: 1500,
    });
    const r = applyCredit(small, 5000);
    expect(r.applyCents).toBe(1500);
    expect(r.remainingAfter).toBe(0);
  });

  it("rejects remainingCents > amountCents at parse time", () => {
    expect(() =>
      TenantCreditSchema.parse({
        ...credit,
        remainingCents: 20_000,
      }),
    ).toThrow(/cannot exceed amountCents/);
  });
});
