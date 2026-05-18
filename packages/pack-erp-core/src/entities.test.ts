import { EntitySchema } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_ENTITY,
  CONTACT_ENTITY,
  ERP_CORE_ENTITIES,
  INVOICE_ENTITY,
  INVOICE_LINE_ENTITY,
} from "./entities.js";

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

  it("each entity uses the tenant_owned trait (M7.7 — RLS + tenant_id auto-injected)", () => {
    for (const e of ERP_CORE_ENTITIES) {
      expect(e.traits).toContain("tenant_owned");
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
