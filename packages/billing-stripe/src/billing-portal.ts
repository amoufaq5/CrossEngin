/** A Stripe Billing Portal session — the hosted page where a customer manages their subscription. */
export interface StripeBillingPortalSession {
  readonly id: string;
  readonly url: string;
  readonly customerId: string;
  readonly returnUrl: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function mapBillingPortalSession(json: unknown): StripeBillingPortalSession {
  if (json === null || typeof json !== "object") {
    throw new Error("Stripe billing portal session response was not an object");
  }
  const obj = json as Record<string, unknown>;
  const id = asString(obj["id"]);
  const url = asString(obj["url"]);
  if (id === null) throw new Error("Stripe billing portal session response missing id");
  if (url === null) throw new Error("Stripe billing portal session response missing url");
  return {
    id,
    url,
    customerId: asString(obj["customer"]) ?? "",
    returnUrl: asString(obj["return_url"]),
  };
}
