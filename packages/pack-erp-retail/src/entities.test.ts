import { EntitySchema } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";
import {
  ERP_RETAIL_ENTITIES,
  PRODUCT_ENTITY,
  SALES_ORDER_ENTITY,
  STORE_ENTITY,
} from "./entities.js";

describe("retail entities", () => {
  it("all parse against the kernel EntitySchema", () => {
    for (const e of ERP_RETAIL_ENTITIES) {
      expect(() => EntitySchema.parse(e)).not.toThrow();
    }
  });

  it("are all on the auditable trait", () => {
    for (const e of ERP_RETAIL_ENTITIES) {
      expect(e.traits).toContain("auditable");
    }
  });

  it("classifies wholesale cost as commercial_sensitive", () => {
    expect(PRODUCT_ENTITY.fields.find((f) => f.name === "unit_cost")?.classification).toBe(
      "commercial_sensitive",
    );
    // the public price is NOT sensitive
    expect(PRODUCT_ENTITY.fields.find((f) => f.name === "unit_price")?.classification).toBeUndefined();
  });

  it("classifies the customer email as PII", () => {
    expect(SALES_ORDER_ENTITY.fields.find((f) => f.name === "customer_email")?.classification).toBe(
      "pii",
    );
  });

  it("Store references the core Account; SalesOrder references core Invoice (optional)", () => {
    expect(STORE_ENTITY.fields.find((f) => f.name === "account_id")?.type).toEqual({
      kind: "reference",
      target: "Account",
    });
    const invoice = SALES_ORDER_ENTITY.fields.find((f) => f.name === "invoice_id");
    expect(invoice?.type).toEqual({ kind: "reference", target: "Invoice" });
    expect(invoice?.required).toBeUndefined();
  });

  it("does not require auditing for commercial_sensitive/pii (no phi/regulated)", () => {
    const classes = ERP_RETAIL_ENTITIES.flatMap((e) =>
      e.fields.map((f) => f.classification).filter((c) => c !== undefined),
    );
    expect(classes).not.toContain("phi");
    expect(classes).not.toContain("regulated");
  });
});
