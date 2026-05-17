import { z } from "zod";
import { Iso4217CurrencySchema } from "@crossengin/i18n";

const Iso8601 = z.string().datetime({ offset: true });
const Uuid = z.string().min(1);

export const BILLING_EVENT_KINDS = [
  "subscription_created",
  "subscription_changed",
  "subscription_canceled",
  "subscription_paused",
  "subscription_resumed",
  "trial_started",
  "trial_converted",
  "trial_expired",
  "invoice_issued",
  "invoice_paid",
  "invoice_failed",
  "invoice_voided",
  "payment_method_added",
  "payment_method_removed",
  "refund_issued",
  "credit_applied",
  "credit_issued",
  "plan_changed",
  "dunning_advanced",
  "usage_synced",
] as const;
export type BillingEventKind = (typeof BILLING_EVENT_KINDS)[number];

export const BillingActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: Uuid }),
  z.object({ kind: z.literal("system"), component: z.string().min(1) }),
  z.object({ kind: z.literal("stripe_webhook"), eventId: z.string().min(1) }),
]);
export type BillingActor = z.infer<typeof BillingActorSchema>;

export const BillingEventSchema = z.object({
  id: Uuid,
  tenantId: Uuid,
  kind: z.enum(BILLING_EVENT_KINDS),
  actor: BillingActorSchema,
  occurredAt: Iso8601,
  subscriptionId: Uuid.nullable().default(null),
  invoiceId: Uuid.nullable().default(null),
  amountCents: z.number().int().nullable().default(null),
  currency: Iso4217CurrencySchema.nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type BillingEvent = z.infer<typeof BillingEventSchema>;

export interface RetentionPolicy {
  readonly minYears: number;
  readonly hotDays: number;
}

export const FINANCIAL_AUDIT_RETENTION: RetentionPolicy = Object.freeze({
  minYears: 7,
  hotDays: 365,
});

export function affectsBilling(event: BillingEvent): boolean {
  return event.amountCents !== null && event.amountCents !== 0;
}

export function isLifecycleEvent(event: BillingEvent): boolean {
  return (
    event.kind === "subscription_created" ||
    event.kind === "subscription_changed" ||
    event.kind === "subscription_canceled" ||
    event.kind === "subscription_paused" ||
    event.kind === "subscription_resumed"
  );
}
