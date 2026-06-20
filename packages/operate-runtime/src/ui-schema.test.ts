import { describe, expect, it } from "vitest";
import { buildErpCorePack } from "@crossengin/pack-erp-core";

import { buildUiSchema } from "./ui-schema.js";

const schema = buildUiSchema(buildErpCorePack(), new Date("2026-06-20T00:00:00Z"));

function entity(name: string) {
  const e = schema.entities.find((x) => x.name === name);
  if (e === undefined) throw new Error(`no entity ${name}`);
  return e;
}

describe("buildUiSchema", () => {
  it("covers every manifest entity", () => {
    expect(schema.entities.length).toBe(buildErpCorePack().entities.length);
  });

  it("derives kebab-plural slugs", () => {
    expect(entity("SalesOrder").slug).toBe("sales-orders");
    expect(entity("Invoice").slug).toBe("invoices");
  });

  it("maps field input types from kernel field kinds", () => {
    const invoice = entity("Invoice");
    const total = invoice.fields.find((f) => f.name === "total");
    expect(total?.input).toBe("number");
    const state = invoice.fields.find((f) => f.name === "state");
    expect(state?.input).toBe("select");
    expect(state?.enumValues).toContain("draft");
    const acct = invoice.fields.find((f) => f.name === "account_id");
    expect(acct?.input).toBe("reference");
    expect(acct?.referenceTarget).toBe("Account");
  });

  it("flags sequence-defaulted fields read-only", () => {
    const num = entity("Invoice").fields.find((f) => f.name === "invoice_number");
    expect(num?.readOnly).toBe(true);
  });

  it("carries field classifications", () => {
    const lead = entity("Lead");
    expect(lead.fields.find((f) => f.name === "email")?.classification).toBe("pii");
  });

  it("exposes lifecycle transitions with operationIds", () => {
    const so = entity("SalesOrder");
    expect(so.stateField).toBe("state");
    const confirm = so.transitions.find((t) => t.name === "confirm");
    expect(confirm?.operationId).toBe("salesOrder.confirm");
    expect(confirm?.from).toContain("draft");
    expect(confirm?.to).toBe("confirmed");
  });

  it("provides CRUD operationIds", () => {
    expect(entity("Quote").operationIds.create).toBe("quote.create");
    expect(entity("Quote").operationIds.list).toBe("quote.list");
  });

  it("picks a bounded set of list columns", () => {
    for (const e of schema.entities) {
      expect(e.listColumns.length).toBeGreaterThan(0);
      expect(e.listColumns.length).toBeLessThanOrEqual(7);
    }
  });
});
