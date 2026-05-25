import { describe, expect, it } from "vitest";
import {
  computeInvoiceTotals,
  InvoiceLineItemSchema,
  InvoiceSchema,
  isInvoiceOverdue,
} from "./invoices.js";

const now = "2026-05-13T10:00:00.000Z";

const baseLineItem = {
  id: "li_base",
  kind: "subscription_base" as const,
  description: "Operate Base — May 2026",
  quantity: 1,
  unitAmountCents: 19900,
  amountCents: 19900,
  currency: "USD",
};

const baseInvoice = {
  id: "inv_1",
  tenantId: "t_1",
  subscriptionId: "sub_1",
  number: "INV-0001",
  stripeInvoiceId: null,
  status: "open" as const,
  currency: "USD",
  subtotalCents: 19900,
  taxCents: 995,
  discountCents: 0,
  totalCents: 20895,
  amountPaidCents: 0,
  amountRemainingCents: 20895,
  issuedAt: now,
  dueAt: "2026-06-12T10:00:00.000Z",
  paidAt: null,
  voidedAt: null,
  periodStart: "2026-05-01T00:00:00.000Z",
  periodEnd: "2026-06-01T00:00:00.000Z",
  lineItems: [baseLineItem],
  pdfUrl: null,
};

describe("InvoiceLineItemSchema + InvoiceSchema", () => {
  it("parses an open invoice with a single subscription line", () => {
    expect(() => InvoiceSchema.parse(baseInvoice)).not.toThrow();
  });

  it("rejects dueAt < issuedAt", () => {
    expect(() =>
      InvoiceSchema.parse({ ...baseInvoice, dueAt: "2026-04-01T00:00:00.000Z" }),
    ).toThrow(/dueAt must be >= issuedAt/);
  });

  it("requires paidAt + amountRemainingCents=0 for paid invoices", () => {
    expect(() => InvoiceSchema.parse({ ...baseInvoice, status: "paid" })).toThrow(
      /paid invoices must declare paidAt/,
    );
  });

  it("rejects mismatched line-item currency", () => {
    expect(() =>
      InvoiceSchema.parse({
        ...baseInvoice,
        lineItems: [{ ...baseLineItem, id: "li_mismatch", currency: "EUR" }],
      }),
    ).toThrow(/does not match invoice currency/);
  });

  it("InvoiceLineItem allows negative amount for proration credit", () => {
    expect(() =>
      InvoiceLineItemSchema.parse({
        id: "li_credit",
        kind: "proration_credit",
        description: "Credit for unused base plan",
        quantity: 1,
        unitAmountCents: -5000,
        amountCents: -5000,
        currency: "USD",
      }),
    ).not.toThrow();
  });

  it("rejects malformed stripeInvoiceId", () => {
    expect(() => InvoiceSchema.parse({ ...baseInvoice, stripeInvoiceId: "not-an-id" })).toThrow();
  });
});

describe("computeInvoiceTotals", () => {
  it("sums base + tax + discount + credits correctly", () => {
    const totals = computeInvoiceTotals([
      baseLineItem,
      {
        id: "li_overage",
        kind: "usage_overage",
        description: "AI call overage",
        quantity: 100,
        unitAmountCents: 8,
        amountCents: 800,
        currency: "USD",
      },
      {
        id: "li_tax",
        kind: "tax",
        description: "VAT 5%",
        quantity: 1,
        unitAmountCents: 1035,
        amountCents: 1035,
        currency: "USD",
      },
      {
        id: "li_credit",
        kind: "credit",
        description: "SLA credit",
        quantity: 1,
        unitAmountCents: -500,
        amountCents: -500,
        currency: "USD",
      },
    ]);
    expect(totals.subtotalCents).toBe(19900 + 800);
    expect(totals.taxCents).toBe(1035);
    expect(totals.discountCents).toBe(500);
    expect(totals.totalCents).toBe(19900 + 800 + 1035 - 500);
  });
});

describe("isInvoiceOverdue", () => {
  const open = InvoiceSchema.parse(baseInvoice);

  it("returns true past the due date for open invoices", () => {
    expect(isInvoiceOverdue(open, new Date("2026-07-01T00:00:00.000Z"))).toBe(true);
  });

  it("returns false before the due date", () => {
    expect(isInvoiceOverdue(open, new Date(now))).toBe(false);
  });

  it("returns false for paid invoices regardless of date", () => {
    const paid = InvoiceSchema.parse({
      ...baseInvoice,
      status: "paid",
      paidAt: now,
      amountPaidCents: 20895,
      amountRemainingCents: 0,
    });
    expect(isInvoiceOverdue(paid, new Date("2027-01-01T00:00:00.000Z"))).toBe(false);
  });
});
