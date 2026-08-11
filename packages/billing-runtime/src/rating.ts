import {
  InvoiceLineItemSchema,
  computeOverage,
  type InvoiceLineItem,
  type MeterId,
  type OverageResult,
  type Plan,
  type UsagePeriod,
} from "@crossengin/billing";

export interface RatedMeter {
  readonly meter: MeterId;
  readonly usedUnits: number;
  readonly overage: OverageResult;
}

/** Rates one meter's used units against the plan (included quota + free tier → billable overage). */
export function rateMeter(plan: Plan, meter: MeterId, usedUnits: number): RatedMeter {
  const overage = computeOverage({ plan, meter, usedUnits });
  return { meter, usedUnits, overage };
}

export interface UsageLineInput {
  readonly plan: Plan;
  readonly meter: MeterId;
  readonly usedUnits: number;
  readonly period: UsagePeriod;
  readonly id: string;
}

/**
 * A `usage_overage` line item for a meter, or `null` when nothing is billable
 * (usage within the included quota). `unitAmountCents` is the plan's per-unit
 * rate; `amountCents` the total overage.
 */
export function usageOverageLine(input: UsageLineInput): InvoiceLineItem | null {
  const rated = rateMeter(input.plan, input.meter, input.usedUnits);
  if (rated.overage.billableUnits <= 0) return null;
  const metered = input.plan.meteredPrices.find((m) => m.meter === input.meter);
  const unitAmountCents = metered?.perUnitCents ?? 0;
  return InvoiceLineItemSchema.parse({
    id: input.id,
    kind: "usage_overage",
    description: `${input.meter} overage: ${rated.overage.billableUnits.toString()} units`,
    quantity: rated.overage.billableUnits,
    unitAmountCents,
    amountCents: rated.overage.overageCents,
    currency: input.plan.currency,
    periodStart: input.period.start,
    periodEnd: input.period.end,
    meter: input.meter,
  });
}

export interface BaseLineInput {
  readonly plan: Plan;
  readonly period: UsagePeriod;
  readonly id: string;
}

/** The recurring `subscription_base` line for the plan's flat fee (null for a $0 base). */
export function subscriptionBaseLine(input: BaseLineInput): InvoiceLineItem | null {
  if (input.plan.basePriceCents <= 0) return null;
  return InvoiceLineItemSchema.parse({
    id: input.id,
    kind: "subscription_base",
    description: `${input.plan.id} subscription`,
    quantity: 1,
    unitAmountCents: input.plan.basePriceCents,
    amountCents: input.plan.basePriceCents,
    currency: input.plan.currency,
    periodStart: input.period.start,
    periodEnd: input.period.end,
  });
}
