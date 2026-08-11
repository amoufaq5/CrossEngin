import { describe, expect, it } from "vitest";
import { CountingUuidGenerator, draftInvoice } from "@crossengin/billing-runtime";
import { PlanSchema, type Plan } from "@crossengin/billing";

import { PostgresInvoiceStore } from "./invoice-store.js";
import { fakePg } from "./test-fakes.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const SUB = "22222222-2222-2222-2222-222222222222";
const period = { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" };

const plan: Plan = PlanSchema.parse({
  id: "operate-base-monthly",
  family: "operate",
  tier: "base",
  label: "Operate Base",
  currency: "USD",
  basePriceCents: 19900,
  billingInterval: "month",
  stripeProductId: "prod_abc",
  stripeBasePriceId: "price_abc",
  includedQuotas: { ai_calls_per_month: 500 },
  meteredPrices: [{ meter: "ai_call", stripePriceId: "price_overage", perUnitCents: 8 }],
  availableInRegions: ["eu-central"],
  minKernelVersion: "0.18.0",
});

function invoice() {
  return draftInvoice({
    tenantId: TENANT,
    subscriptionId: SUB,
    plan,
    usage: [{ meter: "ai_call", usedUnits: 700 }],
    period,
    number: "INV-2026-06-0001",
    issuedAt: "2026-07-01T00:00:00.000Z",
    dueAt: "2026-07-31T00:00:00.000Z",
    ids: new CountingUuidGenerator(),
  });
}

describe("PostgresInvoiceStore.upsert", () => {
  it("sets the tenant RLS context then UPSERTs on (tenant_id, number)", async () => {
    const { conn, calls } = fakePg();
    await new PostgresInvoiceStore(conn).upsert(invoice());
    expect(calls[0]?.sql).toContain("set_config('app.current_tenant_id'");
    expect(calls[0]?.params[0]).toBe(TENANT);
    const insert = calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(insert.sql).toContain("meta.invoices");
    expect(insert.sql).toContain("ON CONFLICT (tenant_id, number) DO UPDATE");
    expect(insert.params).toContain("INV-2026-06-0001");
    expect(insert.params).toContain(21500); // base 19900 + overage 1600
    expect(insert.sql).toContain("$20::jsonb");
  });
});

describe("PostgresInvoiceStore.getByNumber", () => {
  it("round-trips a row back into a valid Invoice", async () => {
    const inv = invoice();
    const row = {
      id: inv.id,
      tenant_id: inv.tenantId,
      subscription_id: inv.subscriptionId,
      number: inv.number,
      stripe_invoice_id: null,
      status: inv.status,
      currency: inv.currency,
      subtotal_cents: inv.subtotalCents,
      tax_cents: inv.taxCents,
      discount_cents: inv.discountCents,
      total_cents: inv.totalCents,
      amount_paid_cents: inv.amountPaidCents,
      amount_remaining_cents: inv.amountRemainingCents,
      issued_at: inv.issuedAt,
      due_at: inv.dueAt,
      paid_at: null,
      voided_at: null,
      period_start: inv.periodStart,
      period_end: inv.periodEnd,
      line_items: JSON.stringify(inv.lineItems),
      pdf_url: null,
    };
    const { conn } = fakePg([[row]]);
    const got = await new PostgresInvoiceStore(conn).getByNumber(TENANT, inv.number);
    expect(got?.number).toBe(inv.number);
    expect(got?.totalCents).toBe(21500);
    expect(got?.lineItems.length).toBe(inv.lineItems.length);
  });

  it("returns null when the invoice is absent", async () => {
    const { conn } = fakePg([[]]);
    expect(await new PostgresInvoiceStore(conn).getByNumber(TENANT, "INV-NONE")).toBeNull();
  });
});
