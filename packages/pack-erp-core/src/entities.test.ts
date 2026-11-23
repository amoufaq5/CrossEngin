import { EntitySchema } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_ENTITY,
  CONTACT_ENTITY,
  ERP_CORE_ENTITIES,
  INVOICE_ENTITY,
  INVOICE_LINE_ENTITY,
} from "./entities.js";
import { BILL_ENTITY } from "./entities-finance.js";

describe("ERP_CORE_ENTITIES", () => {
  it("each entity parses against EntitySchema", () => {
    for (const e of ERP_CORE_ENTITIES) {
      expect(() => EntitySchema.parse(e)).not.toThrow();
    }
  });

  it("each entity uses the auditable trait", () => {
    for (const e of ERP_CORE_ENTITIES) {
      expect(e.traits).toContain("auditable");
    }
  });

  it("no entity declares the implicit id field", () => {
    for (const e of ERP_CORE_ENTITIES) {
      expect(e.fields.map((f) => f.name)).not.toContain("id");
    }
  });
});

describe("Account → Contact reference", () => {
  it("Contact.account_id references Account", () => {
    const f = CONTACT_ENTITY.fields.find((f) => f.name === "account_id");
    if (f?.type.kind !== "reference") throw new Error("not a reference field");
    expect(f.type.target).toBe("Account");
  });
});

describe("Invoice → Account reference", () => {
  it("Invoice.account_id references Account", () => {
    const f = INVOICE_ENTITY.fields.find((f) => f.name === "account_id");
    if (f?.type.kind !== "reference") throw new Error("not a reference field");
    expect(f.type.target).toBe("Account");
  });
});

describe("InvoiceLine → Invoice reference", () => {
  it("InvoiceLine.invoice_id references Invoice", () => {
    const f = INVOICE_LINE_ENTITY.fields.find((f) => f.name === "invoice_id");
    if (f?.type.kind !== "reference") throw new Error("not a reference field");
    expect(f.type.target).toBe("Invoice");
  });
});

describe("Account.country is a country_code", () => {
  it("supports country code field type", () => {
    const f = ACCOUNT_ENTITY.fields.find((f) => f.name === "country");
    expect(f?.type.kind).toBe("country_code");
  });
});

describe("Bill carries the fields its effects stamp", () => {
  it("declares withholding_total at the precision of its total, and paid_at", () => {
    // Recognition credits AP net of withholding and stamps the amount here; settlement and aging
    // subtract it. Undeclared, the stamp is a JSONB key on one store and dropped on the other.
    const field = (n: string) => BILL_ENTITY.fields.find((f) => f.name === n);
    expect(field("withholding_total")?.type).toEqual(field("total")?.type);
    expect(field("withholding_total")?.required).toBeUndefined();
    expect(field("withholding_total")?.default).toBeUndefined();
    expect(field("paid_at")?.type).toEqual({ kind: "datetime" });
  });
});
