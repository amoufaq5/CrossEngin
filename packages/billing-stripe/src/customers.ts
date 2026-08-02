export interface StripeCustomer {
  readonly id: string;
  readonly email: string | null;
  readonly name: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function mapStripeCustomer(json: unknown): StripeCustomer {
  if (json === null || typeof json !== "object") {
    throw new Error("Stripe customer response was not an object");
  }
  const obj = json as Record<string, unknown>;
  const id = asString(obj["id"]);
  if (id === null) {
    throw new Error("Stripe customer response missing id");
  }
  return {
    id,
    email: asString(obj["email"]),
    name: asString(obj["name"]),
  };
}
