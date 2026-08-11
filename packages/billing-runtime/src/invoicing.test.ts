import { describe, expect, it } from "vitest";

import { CountingUuidGenerator } from "./clock.js";
import { draftInvoice, hasBillableUsage } from "./invoicing.js";
import { basePlan, period, SUBSCRIPTION, TENANT } from "./test-fixtures.js";

describe("draftInvoice", () => {
  it("composes a draft invoice with a base line + overage line and correct totals", () => {
    const invoice = draftInvoice({
      tenantId: TENANT,
      subscriptionId: SUBSCRIPTION,
      plan: basePlan,
      usage: [{ meter: "ai_call", usedUnits: 700 }],
      period,
      number: "INV-2026-06-0001",
      issuedAt: "2026-07-01T00:00:00.000Z",
      dueAt: "2026-07-31T00:00:00.000Z",
      ids: new CountingUuidGenerator(),
    });
    expect(invoice.status).toBe("draft");
    expect(invoice.lineItems).toHaveLength(2);
    // base 19900 + overage 1600 = 21500 subtotal, no tax.
    expect(invoice.subtotalCents).toBe(21500);
    expect(invoice.taxCents).toBe(0);
    expect(invoice.totalCents).toBe(21500);
    expect(invoice.amountRemainingCents).toBe(21500);
  });

  it("emits a single zero base line when there is nothing billable", () => {
    const invoice = draftInvoice({
      tenantId: TENANT,
      subscriptionId: SUBSCRIPTION,
      plan: { ...basePlan, basePriceCents: 0 },
      usage: [{ meter: "ai_call", usedUnits: 100 }],
      period,
      number: "INV-2026-06-0002",
      issuedAt: "2026-07-01T00:00:00.000Z",
      dueAt: "2026-07-31T00:00:00.000Z",
      ids: new CountingUuidGenerator(),
    });
    expect(invoice.lineItems).toHaveLength(1);
    expect(invoice.totalCents).toBe(0);
  });
});

describe("hasBillableUsage", () => {
  it("is true when the plan has a base fee", () => {
    expect(hasBillableUsage(basePlan, [])).toBe(true);
  });

  it("is true when a meter has overage on a zero-base plan", () => {
    expect(hasBillableUsage({ ...basePlan, basePriceCents: 0 }, [{ meter: "ai_call", usedUnits: 700 }])).toBe(true);
  });

  it("is false for a zero-base plan with in-quota usage", () => {
    expect(hasBillableUsage({ ...basePlan, basePriceCents: 0 }, [{ meter: "ai_call", usedUnits: 100 }])).toBe(false);
  });
});
