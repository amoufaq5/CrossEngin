import { validateWorkflow } from "@crossengin/kernel/workflow";
import { EntitySchema } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import {
  ACCOUNTING_BOOK_ENTITY,
  ERP_CORE_ACCOUNTING_ENTITIES,
  EXCHANGE_RATE_ENTITY,
  FISCAL_PERIOD_ENTITY,
  TAX_RETURN_ENTITY,
  TAX_RULE_ENTITY,
} from "./entities-accounting.js";
import { JOURNAL_LINE_ENTITY } from "./entities-finance.js";
import { ERP_EXT_PERMISSIONS } from "./permissions-ext.js";
import {
  ERP_EXT_TRANSITIONS,
  ERP_EXT_WORKFLOWS,
  FISCAL_PERIOD_LIFECYCLE,
  TAX_RETURN_LIFECYCLE,
} from "./workflows-ext.js";

describe("accounting-depth entities", () => {
  it("all nine parse against EntitySchema and are auditable", () => {
    expect(ERP_CORE_ACCOUNTING_ENTITIES).toHaveLength(9);
    for (const e of ERP_CORE_ACCOUNTING_ENTITIES) {
      expect(() => EntitySchema.parse(e)).not.toThrow();
      expect(e.traits).toContain("auditable");
    }
  });

  it("AccountingBook supports IFRS / local GAAP / tax parallel books", () => {
    const f = ACCOUNTING_BOOK_ENTITY.fields.find((f) => f.name === "accounting_standard");
    if (f?.type.kind !== "enum") throw new Error("not an enum");
    expect(f.type.values).toEqual(["ifrs", "us_gaap", "local_gaap", "tax", "management"]);
  });

  it("ExchangeRate references Currency on both legs", () => {
    for (const name of ["from_currency_id", "to_currency_id"]) {
      const f = EXCHANGE_RATE_ENTITY.fields.find((f) => f.name === name);
      if (f?.type.kind !== "reference") throw new Error(`${name} not a reference`);
      expect(f.type.target).toBe("Currency");
    }
  });

  it("FiscalPeriod has a four-state close lifecycle", () => {
    const f = FISCAL_PERIOD_ENTITY.fields.find((f) => f.name === "status");
    if (f?.type.kind !== "enum") throw new Error("not an enum");
    expect(f.type.values).toEqual(["open", "closing", "closed", "locked"]);
    // The title was a claim about the enum alone until a workflow drove it: with no lifecycle the
    // status was an ordinary field, and a `PATCH {"status":"open"}` reopened a closed book.
    if (FISCAL_PERIOD_LIFECYCLE.kind !== "entityLifecycle") throw new Error("not a lifecycle");
    expect(FISCAL_PERIOD_LIFECYCLE.stateField).toBe("status");
    expect(FISCAL_PERIOD_LIFECYCLE.states.map((s) => s.name)).toEqual(f.type.values);
  });

  it("reopens a closed period only through a named transition, and nothing leaves locked", () => {
    if (FISCAL_PERIOD_LIFECYCLE.kind !== "entityLifecycle") throw new Error("not a lifecycle");
    const edges = FISCAL_PERIOD_LIFECYCLE.transitions.map((t) => [t.name, t.from, t.to]);
    expect(edges).toEqual([
      ["start_close", "open", "closing"],
      ["close", ["open", "closing"], "closed"],
      ["reopen", "closed", "open"],
      ["lock", "closed", "locked"],
    ]);
    const leavesLocked = FISCAL_PERIOD_LIFECYCLE.transitions.filter((t) =>
      (Array.isArray(t.from) ? t.from : [t.from]).includes("locked"),
    );
    expect(leavesLocked).toEqual([]);
    expect(FISCAL_PERIOD_LIFECYCLE.states.find((s) => s.name === "locked")?.category).toBe("terminal");
    expect(ERP_EXT_PERMISSIONS["FiscalPeriod"]?.transitions?.["reopen"]?.roles).toEqual(["erp_admin", "controller"]);
  });

  it("TaxRule carries effective dating + rate categories + reverse charge", () => {
    const names = TAX_RULE_ENTITY.fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["effective_from", "rate_category", "reverse_charge", "is_compound"]));
  });

  it("TaxReturn carries the three figures, the credit disposition and the remittance stamps", () => {
    // The title used to be "nets output minus input tax" over a test that asserted three names
    // exist; nothing in the pack nets anything. What the pack does own is the field set the
    // remittance posting reads (ADR-0467), with each kind pinned because the posting is typed on it.
    const kindOf = (name: string): string | undefined =>
      TAX_RETURN_ENTITY.fields.find((f) => f.name === name)?.type.kind;
    expect(kindOf("output_tax")).toBe("decimal");
    expect(kindOf("input_tax")).toBe("decimal");
    expect(kindOf("net_payable")).toBe("decimal");
    expect(kindOf("credit_disposition")).toBe("enum");
    expect(kindOf("remitted_at")).toBe("datetime");
    expect(kindOf("remittance_entry_number")).toBe("text");
    expect(kindOf("remittance_count")).toBe("integer");

    const disposition = TAX_RETURN_ENTITY.fields.find((f) => f.name === "credit_disposition");
    if (disposition?.type.kind !== "enum") throw new Error("not an enum");
    expect(disposition.type.values).toEqual(["refund_received", "carried_forward"]);

    // None of the four is required or defaulted: a default disposition would decide a refund nobody
    // asserted, and a defaulted stamp would read as a remittance that never posted.
    for (const name of ["credit_disposition", "remitted_at", "remittance_entry_number", "remittance_count"]) {
      const f = TAX_RETURN_ENTITY.fields.find((x) => x.name === name);
      expect(f?.required, name).toBeUndefined();
      expect(f?.default, name).toBeUndefined();
    }
    const entryNumber = TAX_RETURN_ENTITY.fields.find((f) => f.name === "remittance_entry_number");
    if (entryNumber?.type.kind !== "text") throw new Error("not text");
    expect(entryNumber.type.maxLength).toBe(64);
    expect(entryNumber.indexed).toBe(true);
    // `net_payable` stays signed, because a refund or a carried-forward credit is a negative net.
    const net = TAX_RETURN_ENTITY.fields.find((f) => f.name === "net_payable");
    if (net?.type.kind !== "decimal") throw new Error("not a decimal");
    expect(net.type.min).toBeUndefined();
  });

  it("TaxReturn's lifecycle has no terminal state and leaves paid only by reverse_payment", () => {
    if (TAX_RETURN_LIFECYCLE.kind !== "entityLifecycle") throw new Error("not a lifecycle");
    expect(() => validateWorkflow("tax_return_lifecycle", TAX_RETURN_LIFECYCLE)).not.toThrow();
    expect(TAX_RETURN_LIFECYCLE.states.filter((s) => s.category === "terminal")).toEqual([]);
    const state = TAX_RETURN_ENTITY.fields.find((f) => f.name === "state");
    if (state?.type.kind !== "enum") throw new Error("not an enum");
    expect(TAX_RETURN_LIFECYCLE.states.map((s) => s.name)).toEqual(state.type.values);
    const leavesPaid = TAX_RETURN_LIFECYCLE.transitions
      .filter((t) => (Array.isArray(t.from) ? t.from : [t.from]).includes("paid"))
      .map((t) => [t.name, t.to]);
    expect(leavesPaid).toEqual([["reverse_payment", "filed"]]);
    // Granted to the same three writers as every other TaxReturn transition.
    expect(ERP_EXT_PERMISSIONS["TaxReturn"]?.transitions?.["reverse_payment"]?.roles).toEqual(
      ERP_EXT_PERMISSIONS["TaxReturn"]?.transitions?.["mark_paid"]?.roles,
    );
  });

  it("names every lifecycle's transitions exactly once more, in ERP_EXT_TRANSITIONS", () => {
    // The permission sets grant from `ERP_EXT_TRANSITIONS`, a second spelling of each lifecycle's
    // names: a transition added to one and not the other is either ungrantable or a grant for an
    // edge that does not exist. Compared both ways, so neither list can outgrow the other.
    const lifecycles = Object.values(ERP_EXT_WORKFLOWS).filter((w) => w.kind === "entityLifecycle");
    expect(lifecycles.length).toBeGreaterThanOrEqual(13);
    const fromWorkflows: Record<string, string[]> = {};
    for (const wf of lifecycles) {
      if (wf.kind !== "entityLifecycle") continue;
      fromWorkflows[wf.entity] = wf.transitions.map((t) => t.name);
    }
    expect(Object.fromEntries(Object.entries(ERP_EXT_TRANSITIONS).map(([k, v]) => [k, [...v]]))).toEqual(
      fromWorkflows,
    );
  });

  it("JournalLine carries both transaction and functional-currency amounts", () => {
    const names = JOURNAL_LINE_ENTITY.fields.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(["currency", "fx_rate", "functional_debit", "functional_credit", "cost_center_id"]),
    );
  });
});
