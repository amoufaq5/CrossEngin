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

  it("groups entities by department module", () => {
    expect(entity("Invoice").module).toBe("Finance");
    expect(entity("LedgerAccount").module).toBe("Accounting & GL");
    expect(entity("Employee").module).toBe("Human Resources");
    expect(entity("Vendor").module).toBe("Procurement");
    for (const e of schema.entities) expect(e.module.length).toBeGreaterThan(0);
  });

  it("picks a bounded set of list columns", () => {
    for (const e of schema.entities) {
      expect(e.listColumns.length).toBeGreaterThan(0);
      expect(e.listColumns.length).toBeLessThanOrEqual(7);
    }
  });

  it("exposes per-entity access roles from manifest permissions", () => {
    const inv = entity("Invoice");
    expect(inv.access.read).toContain("erp_admin");
    // A cashier-style role must not appear on a finance entity it can't see.
    expect(inv.access.read).not.toContain("warehouse_clerk");
    const tax = entity("TaxReturn");
    expect(tax.access.create).toContain("tax_manager");
  });

  it("carries the roles catalog with labels", () => {
    const tax = schema.roles.find((r) => r.name === "tax_manager");
    expect(tax?.label).toBe("Tax Manager");
    expect(schema.roles.length).toBe(Object.keys(buildErpCorePack().roles ?? {}).length);
  });

  it("tags each lifecycle transition with the roles that may fire it", () => {
    const file = entity("TaxReturn").transitions.find((t) => t.name === "file");
    expect(file?.roles).toContain("tax_manager");
  });

  it("exposes the lifecycle state field as filterable even without a list view (inbox pushdown)", () => {
    // TaxReturn has a lifecycle but no list view; SalesOrder likewise in core.
    expect(entity("TaxReturn").filterableFields).toContain("state");
    expect(entity("SalesOrder").filterableFields).toContain("state");
    // Invoice has a list view AND a lifecycle — still filterable on state.
    expect(entity("Invoice").filterableFields).toContain("state");
  });
});
