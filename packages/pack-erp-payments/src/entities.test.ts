import { EntitySchema } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { ERP_PAYMENTS_ENTITIES, PAYMENT_ENTITY, PAYMENT_PROVIDERS } from "./entities.js";

describe("PAYMENT_ENTITY", () => {
  it("parses against EntitySchema", () => {
    expect(() => EntitySchema.parse(PAYMENT_ENTITY)).not.toThrow();
  });

  it("uses both auditable and tenant_owned traits", () => {
    expect(PAYMENT_ENTITY.traits).toContain("auditable");
    expect(PAYMENT_ENTITY.traits).toContain("tenant_owned");
  });

  it("invoice_id references Invoice", () => {
    const f = PAYMENT_ENTITY.fields.find((f) => f.name === "invoice_id");
    if (f?.type.kind !== "reference") throw new Error("not a reference");
    expect(f.type.target).toBe("Invoice");
    expect(f.required).toBe(true);
  });

  it("state enum matches the documented 6-state machine", () => {
    const f = PAYMENT_ENTITY.fields.find((f) => f.name === "state");
    if (f?.type.kind !== "enum") throw new Error("not an enum");
    expect([...f.type.values].sort()).toEqual([
      "cancelled",
      "captured",
      "failed",
      "pending",
      "refunded",
      "settled",
    ]);
  });

  it("amount + refund_amount are non-negative decimal(14,2)", () => {
    const amount = PAYMENT_ENTITY.fields.find((f) => f.name === "amount");
    if (amount?.type.kind !== "decimal") throw new Error("amount not decimal");
    expect(amount.type.precision).toBe(14);
    expect(amount.type.scale).toBe(2);
    expect(amount.type.min).toBe(0);
    const refund = PAYMENT_ENTITY.fields.find((f) => f.name === "refund_amount");
    if (refund?.type.kind !== "decimal") throw new Error("refund_amount not decimal");
    expect(refund.type.min).toBe(0);
  });

  it("provider_reference is unique within a provider scope", () => {
    const f = PAYMENT_ENTITY.fields.find((f) => f.name === "provider_reference");
    if (typeof f?.unique !== "object" || f.unique === null) {
      throw new Error("provider_reference unique scope missing");
    }
    expect(f.unique.scope).toEqual(["provider"]);
  });
});

describe("PAYMENT_PROVIDERS", () => {
  it("lists the supported provider integrations", () => {
    expect(PAYMENT_PROVIDERS).toContain("stripe");
    expect(PAYMENT_PROVIDERS).toContain("adyen");
    expect(PAYMENT_PROVIDERS).toContain("manual");
  });
});

describe("ERP_PAYMENTS_ENTITIES", () => {
  it("exports exactly the Payment entity", () => {
    expect(ERP_PAYMENTS_ENTITIES.map((e) => e.name)).toEqual(["Payment"]);
  });
});
