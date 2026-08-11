import { describe, expect, it } from "vitest";
import { CountingUuidGenerator, FixedClock } from "@crossengin/billing-runtime";
import { PlanSchema, SubscriptionSchema, type Plan, type Subscription } from "@crossengin/billing";

import { buildPersistentBillingEngine } from "./persisting-engine.js";
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

const subscription: Subscription = SubscriptionSchema.parse({
  id: SUB,
  tenantId: TENANT,
  planId: plan.id,
  status: "active",
  stripeCustomerId: "cus_abc",
  currentPeriodStart: period.start,
  currentPeriodEnd: period.end,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
});

function engine(conn: Parameters<typeof buildPersistentBillingEngine>[0]) {
  return buildPersistentBillingEngine(conn, {
    clock: new FixedClock(new Date("2026-07-01T00:00:00.000Z")),
    ids: new CountingUuidGenerator(),
  });
}

describe("buildPersistentBillingEngine", () => {
  it("persists usage records + the draft invoice on closePeriod", async () => {
    const { conn, calls } = fakePg();
    const e = engine(conn);
    for (let i = 0; i < 700; i += 1) {
      e.recordUsage({
        idempotencyKey: `evt-${i.toString()}`,
        tenantId: TENANT,
        subscriptionId: SUB,
        meter: "ai_call",
        quantity: 1,
        source: "ai_provider_calls",
        occurredAt: "2026-06-15T12:00:00.000Z",
      });
    }
    const result = await e.closePeriod({ subscription, plan, period, number: "INV-2026-06-0001", source: "ai_provider_calls" });

    expect(result.usageRecords).toHaveLength(1);
    expect(result.invoice?.totalCents).toBe(21500);

    const usageInsert = calls.find((c) => c.sql.includes("billing_usage_records"));
    const invoiceInsert = calls.find((c) => c.sql.includes("meta.invoices"));
    expect(usageInsert?.sql).toContain("ON CONFLICT (idempotency_key)");
    expect(invoiceInsert?.sql).toContain("ON CONFLICT (tenant_id, number)");
  });

  it("persists only usage records when there is no invoice to draft", async () => {
    const { conn, calls } = fakePg();
    const zeroBasePlan = { ...plan, basePriceCents: 0 };
    const e = engine(conn);
    e.recordUsage({
      idempotencyKey: "a",
      tenantId: TENANT,
      subscriptionId: SUB,
      meter: "ai_call",
      quantity: 100,
      source: "ai_provider_calls",
      occurredAt: "2026-06-15T12:00:00.000Z",
    });
    const result = await e.closePeriod({ subscription, plan: zeroBasePlan, period, number: "INV-A" });
    expect(result.invoice).toBeNull();
    expect(result.usageRecords).toHaveLength(1);
    expect(calls.some((c) => c.sql.includes("billing_usage_records"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("meta.invoices"))).toBe(false);
  });
});
