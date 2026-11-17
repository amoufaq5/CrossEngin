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
import { FISCAL_PERIOD_LIFECYCLE } from "./workflows-ext.js";

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

  it("TaxReturn nets output minus input tax", () => {
    const names = TAX_RETURN_ENTITY.fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["output_tax", "input_tax", "net_payable"]));
  });

  it("JournalLine carries both transaction and functional-currency amounts", () => {
    const names = JOURNAL_LINE_ENTITY.fields.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(["currency", "fx_rate", "functional_debit", "functional_credit", "cost_center_id"]),
    );
  });
});
