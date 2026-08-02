import type { SubscriptionStatus } from "@crossengin/billing";

export const STRIPE_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
  "incomplete",
  "incomplete_expired",
] as const;
export type StripeSubscriptionStatus = (typeof STRIPE_SUBSCRIPTION_STATUSES)[number];

export const STRIPE_TO_SUBSCRIPTION_STATUS: Readonly<
  Record<StripeSubscriptionStatus, SubscriptionStatus>
> = Object.freeze({
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  canceled: "canceled",
  unpaid: "unpaid",
  paused: "paused",
  incomplete: "incomplete",
  incomplete_expired: "incomplete",
});

export function mapStripeSubscriptionStatus(raw: string): SubscriptionStatus {
  if ((STRIPE_SUBSCRIPTION_STATUSES as readonly string[]).includes(raw)) {
    return STRIPE_TO_SUBSCRIPTION_STATUS[raw as StripeSubscriptionStatus];
  }
  throw new Error(`Unknown Stripe subscription status: ${raw}`);
}

export interface StripeSubscription {
  readonly id: string;
  readonly customerId: string;
  readonly status: SubscriptionStatus;
  readonly rawStatus: string;
  readonly priceId: string | null;
  readonly currentPeriodStart: number | null;
  readonly currentPeriodEnd: number | null;
  readonly trialEnd: number | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: number | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractPriceId(json: Record<string, unknown>): string | null {
  const items = json["items"];
  if (items !== null && typeof items === "object") {
    const data = (items as Record<string, unknown>)["data"];
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0] as Record<string, unknown> | undefined;
      const price = first?.["price"];
      if (price !== null && typeof price === "object") {
        const priceId = asString((price as Record<string, unknown>)["id"]);
        if (priceId !== null) return priceId;
      }
    }
  }
  return null;
}

function extractPeriod(
  json: Record<string, unknown>,
  key: "current_period_start" | "current_period_end",
): number | null {
  const top = asNumber(json[key]);
  if (top !== null) return top;
  // Newer Stripe API versions expose the period on the first item.
  const items = json["items"];
  if (items !== null && typeof items === "object") {
    const data = (items as Record<string, unknown>)["data"];
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0] as Record<string, unknown> | undefined;
      if (first !== undefined) {
        return asNumber(first[key]);
      }
    }
  }
  return null;
}

export function mapStripeSubscription(json: unknown): StripeSubscription {
  if (json === null || typeof json !== "object") {
    throw new Error("Stripe subscription response was not an object");
  }
  const obj = json as Record<string, unknown>;
  const id = asString(obj["id"]);
  if (id === null) {
    throw new Error("Stripe subscription response missing id");
  }
  const rawStatus = asString(obj["status"]);
  if (rawStatus === null) {
    throw new Error("Stripe subscription response missing status");
  }
  const customerId = asString(obj["customer"]) ?? "";
  return {
    id,
    customerId,
    status: mapStripeSubscriptionStatus(rawStatus),
    rawStatus,
    priceId: extractPriceId(obj),
    currentPeriodStart: extractPeriod(obj, "current_period_start"),
    currentPeriodEnd: extractPeriod(obj, "current_period_end"),
    trialEnd: asNumber(obj["trial_end"]),
    cancelAtPeriodEnd: obj["cancel_at_period_end"] === true,
    canceledAt: asNumber(obj["canceled_at"]),
  };
}
