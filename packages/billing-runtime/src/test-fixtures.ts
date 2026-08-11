import {
  PlanSchema,
  SubscriptionSchema,
  type Plan,
  type Subscription,
  type UsagePeriod,
} from "@crossengin/billing";

import type { MeteredUsageEvent } from "./ingest.js";

export const TENANT = "11111111-1111-1111-1111-111111111111";
export const SUBSCRIPTION = "22222222-2222-2222-2222-222222222222";

export const period: UsagePeriod = {
  start: "2026-06-01T00:00:00.000Z",
  end: "2026-07-01T00:00:00.000Z",
};

export const basePlan: Plan = PlanSchema.parse({
  id: "operate-base-monthly",
  family: "operate",
  tier: "base",
  label: "Operate Base",
  currency: "USD",
  basePriceCents: 19900,
  billingInterval: "month",
  stripeProductId: "prod_abc",
  stripeBasePriceId: "price_abc",
  includedQuotas: { ai_calls_per_month: 500, storage_gb: 10 },
  meteredPrices: [{ meter: "ai_call", stripePriceId: "price_overage", perUnitCents: 8 }],
  availableInRegions: ["eu-central"],
  minKernelVersion: "0.18.0",
});

export const subscription: Subscription = SubscriptionSchema.parse({
  id: SUBSCRIPTION,
  tenantId: TENANT,
  planId: basePlan.id,
  status: "active",
  stripeCustomerId: "cus_abc",
  currentPeriodStart: period.start,
  currentPeriodEnd: period.end,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
});

export function aiCall(overrides: Partial<MeteredUsageEvent> = {}): MeteredUsageEvent {
  return {
    idempotencyKey: `evt-${Math.random().toString(36).slice(2)}`,
    tenantId: TENANT,
    subscriptionId: SUBSCRIPTION,
    meter: "ai_call",
    quantity: 1,
    source: "ai_provider_calls",
    occurredAt: "2026-06-15T12:00:00.000Z",
    ...overrides,
  };
}
