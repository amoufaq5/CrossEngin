import {
  InvoiceSchema,
  computeInvoiceTotals,
  type Invoice,
  type InvoiceLineItem,
  type MeterId,
  type Plan,
  type UsagePeriod,
} from "@crossengin/billing";

import type { UuidGenerator } from "./clock.js";
import { subscriptionBaseLine, usageOverageLine } from "./rating.js";

export interface MeterUsage {
  readonly meter: MeterId;
  readonly usedUnits: number;
}

export interface DraftInvoiceInput {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly plan: Plan;
  readonly usage: readonly MeterUsage[];
  readonly period: UsagePeriod;
  readonly number: string;
  readonly issuedAt: string;
  readonly dueAt: string;
  readonly ids: UuidGenerator;
}

/**
 * Composes a metered period into a `draft` `Invoice`: the plan's base line (if
 * any) plus one `usage_overage` line per meter with billable overage, totalled
 * via the contract's `computeInvoiceTotals`. A period with no base fee and no
 * overage produces a single zero-amount base line so the invoice stays
 * schema-valid (`lineItems` must be non-empty) — callers can skip drafting when
 * `hasBillableUsage` is false.
 */
export function draftInvoice(input: DraftInvoiceInput): Invoice {
  const lineItems: InvoiceLineItem[] = [];
  const base = subscriptionBaseLine({ plan: input.plan, period: input.period, id: input.ids.next() });
  if (base !== null) lineItems.push(base);
  for (const { meter, usedUnits } of input.usage) {
    const line = usageOverageLine({
      plan: input.plan,
      meter,
      usedUnits,
      period: input.period,
      id: input.ids.next(),
    });
    if (line !== null) lineItems.push(line);
  }
  if (lineItems.length === 0) {
    lineItems.push({
      id: input.ids.next(),
      kind: "subscription_base",
      description: `${input.plan.id} subscription`,
      quantity: 1,
      unitAmountCents: 0,
      amountCents: 0,
      currency: input.plan.currency,
      periodStart: input.period.start,
      periodEnd: input.period.end,
    });
  }
  const totals = computeInvoiceTotals(lineItems);
  return InvoiceSchema.parse({
    id: input.ids.next(),
    tenantId: input.tenantId,
    subscriptionId: input.subscriptionId,
    number: input.number,
    status: "draft",
    currency: input.plan.currency,
    subtotalCents: totals.subtotalCents,
    taxCents: totals.taxCents,
    discountCents: totals.discountCents,
    totalCents: totals.totalCents,
    amountRemainingCents: Math.max(0, totals.totalCents),
    issuedAt: input.issuedAt,
    dueAt: input.dueAt,
    periodStart: input.period.start,
    periodEnd: input.period.end,
    lineItems,
  });
}

/** Whether any meter has billable overage against the plan (drives whether to draft). */
export function hasBillableUsage(plan: Plan, usage: readonly MeterUsage[]): boolean {
  if (plan.basePriceCents > 0) return true;
  return usage.some((u) => {
    const line = usageOverageLine({
      plan,
      meter: u.meter,
      usedUnits: u.usedUnits,
      period: { start: "1970-01-01T00:00:00.000Z", end: "1970-01-02T00:00:00.000Z" },
      id: "00000000-0000-4000-8000-000000000000",
    });
    return line !== null;
  });
}
