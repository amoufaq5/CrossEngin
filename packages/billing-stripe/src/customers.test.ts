import { describe, expect, it } from "vitest";

import { mapStripeCustomer } from "./customers.js";

describe("mapStripeCustomer", () => {
  it("maps a Stripe customer object", () => {
    const c = mapStripeCustomer({
      id: "cus_123",
      object: "customer",
      email: "a@example.com",
      name: "Acme Co",
    });
    expect(c.id).toBe("cus_123");
    expect(c.email).toBe("a@example.com");
    expect(c.name).toBe("Acme Co");
  });

  it("nulls out absent email/name", () => {
    const c = mapStripeCustomer({ id: "cus_1" });
    expect(c.email).toBeNull();
    expect(c.name).toBeNull();
  });

  it("throws on a missing id or non-object", () => {
    expect(() => mapStripeCustomer({ email: "x@y.z" })).toThrow(/missing id/);
    expect(() => mapStripeCustomer(null)).toThrow(/was not an object/);
  });
});
