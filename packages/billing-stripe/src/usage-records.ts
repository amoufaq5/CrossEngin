export interface CreateUsageRecordInput {
  readonly subscriptionItemId: string;
  readonly quantity: number;
  /** Unix seconds for the usage; omit for "now". */
  readonly timestamp?: number;
  /** `increment` (default) adds to the period total; `set` overwrites the timestamp's value. */
  readonly action?: "increment" | "set";
  /** Sent as Stripe's `Idempotency-Key` header so a retried report is de-duplicated. */
  readonly idempotencyKey?: string;
}

export interface StripeUsageRecord {
  readonly id: string;
  readonly quantity: number;
  readonly subscriptionItemId: string;
}

export function mapStripeUsageRecord(json: unknown): StripeUsageRecord {
  if (typeof json !== "object" || json === null) {
    throw new Error("mapStripeUsageRecord: expected an object");
  }
  const obj = json as Record<string, unknown>;
  const id = obj["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("mapStripeUsageRecord: missing id");
  }
  const quantity = typeof obj["quantity"] === "number" ? obj["quantity"] : 0;
  const subscriptionItemId =
    typeof obj["subscription_item"] === "string" ? obj["subscription_item"] : "";
  return { id, quantity, subscriptionItemId };
}
