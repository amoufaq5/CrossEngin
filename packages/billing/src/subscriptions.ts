import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const Uuid = z.string().min(1);
const STRIPE_SUB_REGEX = /^sub_[A-Za-z0-9]+$/;
const STRIPE_CUSTOMER_REGEX = /^cus_[A-Za-z0-9]+$/;

export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
  "unpaid",
  "incomplete",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SubscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);

export const SUBSCRIPTION_TRANSITIONS: Readonly<
  Record<SubscriptionStatus, readonly SubscriptionStatus[]>
> = Object.freeze({
  incomplete: ["trialing", "active", "canceled"],
  trialing: ["active", "canceled", "incomplete"],
  active: ["past_due", "paused", "canceled"],
  past_due: ["active", "unpaid", "canceled"],
  paused: ["active", "canceled"],
  unpaid: ["canceled", "active"],
  canceled: [],
});

export function canTransitionSubscription(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): boolean {
  return SUBSCRIPTION_TRANSITIONS[from].includes(to);
}

export const SubscriptionSchema = z
  .object({
    id: Uuid,
    tenantId: Uuid,
    planId: z.string().min(1),
    status: SubscriptionStatusSchema,
    stripeSubscriptionId: z.string().regex(STRIPE_SUB_REGEX).optional(),
    stripeCustomerId: z.string().regex(STRIPE_CUSTOMER_REGEX),
    currentPeriodStart: Iso8601,
    currentPeriodEnd: Iso8601,
    trialEnd: Iso8601.nullable().default(null),
    cancelAtPeriodEnd: z.boolean().default(false),
    canceledAt: Iso8601.nullable().default(null),
    pausedAt: Iso8601.nullable().default(null),
    createdAt: Iso8601,
    updatedAt: Iso8601,
  })
  .superRefine((v, ctx) => {
    if (new Date(v.currentPeriodEnd) <= new Date(v.currentPeriodStart)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentPeriodEnd"],
        message: "currentPeriodEnd must be after currentPeriodStart",
      });
    }
    if (v.status === "trialing" && v.trialEnd === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trialEnd"],
        message: "trialing subscriptions must declare trialEnd",
      });
    }
    if (v.status === "canceled" && v.canceledAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canceledAt"],
        message: "canceled subscriptions must declare canceledAt",
      });
    }
    if (v.status === "paused" && v.pausedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pausedAt"],
        message: "paused subscriptions must declare pausedAt",
      });
    }
  });
export type Subscription = z.infer<typeof SubscriptionSchema>;

export function daysIntoCurrentPeriod(subscription: Subscription, now: Date = new Date()): number {
  const start = new Date(subscription.currentPeriodStart).getTime();
  if (now.getTime() < start) return 0;
  return Math.floor((now.getTime() - start) / 86_400_000);
}

export function daysInCurrentPeriod(subscription: Subscription): number {
  const start = new Date(subscription.currentPeriodStart).getTime();
  const end = new Date(subscription.currentPeriodEnd).getTime();
  return Math.max(1, Math.round((end - start) / 86_400_000));
}

export function isWithinTrial(subscription: Subscription, now: Date = new Date()): boolean {
  if (subscription.trialEnd === null) return false;
  return now.getTime() < new Date(subscription.trialEnd).getTime();
}

export function isPayable(subscription: Subscription): boolean {
  return (
    subscription.status === "active" ||
    subscription.status === "trialing" ||
    subscription.status === "past_due"
  );
}
