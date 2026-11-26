import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ACCOUNT_CODE_FIELDS, FORM_FINANCE_KEYS, buildFinance, unmanagedFinance } from "./finance-settings";

// The six codes the depreciation, inventory and receiving postings read (ADR-0430, ADR-0431), which
// the form used to neither show nor set.
const POSTING_CODES = [
  "depreciationExpenseAccountCode",
  "accumulatedDepreciationAccountCode",
  "inventoryAccountCode",
  "cogsAccountCode",
  "grniAccountCode",
  "inventoryVarianceAccountCode",
] as const;

describe("the finance form's account codes", () => {
  it.each(POSTING_CODES)("shows and saves %s", (key) => {
    expect(ACCOUNT_CODE_FIELDS.some((f) => f.key === key)).toBe(true);
    expect(FORM_FINANCE_KEYS.has(key)).toBe(true);
    expect(buildFinance({ [key]: " 5100 " })).toEqual({ [key]: "5100" });
  });

  it("names every code once, with a label", () => {
    const keys = ACCOUNT_CODE_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of ACCOUNT_CODE_FIELDS) {
      expect(f.key).toMatch(/AccountCode$/);
      expect(f.label.trim().length).toBeGreaterThan(3);
    }
  });

  it("omits a blank code rather than saving an empty string", () => {
    expect(buildFinance({ arAccountCode: "  ", inventoryAccountCode: "" })).toEqual({});
  });
});

describe("a save keeps what the form does not edit", () => {
  it("carries an unknown finance key through and drops every edited one", () => {
    const loaded = {
      arAccountCode: "1100",
      inventoryAccountCode: "1300",
      someFutureKey: { nested: true },
      taxAccountsByJurisdiction: { AE: "2100" },
    };
    expect(unmanagedFinance(loaded)).toEqual({ someFutureKey: { nested: true } });
  });

  it("composes to the document a save sends: unmanaged keys plus the form's", () => {
    const loaded = { someFutureKey: 7, cogsAccountCode: "5000" };
    const saved = { ...unmanagedFinance(loaded), ...buildFinance({ cogsAccountCode: "5010", arAccountCode: "1100" }) };
    expect(saved).toEqual({ someFutureKey: 7, cogsAccountCode: "5010", arAccountCode: "1100" });
  });

  it("clears a code the form emptied, since the form now owns it", () => {
    const loaded = { grniAccountCode: "2150" };
    const saved = { ...unmanagedFinance(loaded), ...buildFinance({ grniAccountCode: "" }) };
    expect(saved).toEqual({});
  });

  it("reads a non-object finance section as empty", () => {
    expect(unmanagedFinance(null)).toEqual({});
    expect(unmanagedFinance("x")).toEqual({});
  });

  it("parses the other finance fields as the server types them", () => {
    expect(
      buildFinance({
        defaultPaymentTermsDays: "30",
        multiCurrencyEnabled: "true",
        pricesIncludeTax: "",
        taxRemittancePosting: "on_mark_paid",
      }),
    ).toEqual({ defaultPaymentTermsDays: 30, multiCurrencyEnabled: true, taxRemittancePosting: "on_mark_paid" });
    expect(buildFinance({ defaultPaymentTermsDays: "soon", taxRemittancePosting: "bogus" })).toEqual({});
  });
});

describe("the form and the server agree on which account codes exist", () => {
  // Read as text: this app does not depend on `@crossengin/operate-runtime`, and the defect this file
  // closed was exactly a code the server reads that the form did not know about. Both directions,
  // because a code removed from the server and kept here would be a picker saving a key nothing reads.
  const settingsSource = readFileSync(
    fileURLToPath(new URL("../../../packages/operate-runtime/src/settings.ts", import.meta.url)),
    "utf8",
  );
  const serverCodes = [...settingsSource.matchAll(/^ {4}(\w+AccountCode): z\./gm)].map((m) => m[1] ?? "");

  it("finds the server's finance account codes (a floor, so a moved schema cannot pass empty)", () => {
    expect(serverCodes.length).toBeGreaterThanOrEqual(18);
  });

  it("shows every code FinanceSettingsSchema declares, and no code it does not", () => {
    expect(ACCOUNT_CODE_FIELDS.map((f) => f.key).sort()).toEqual([...serverCodes].sort());
  });
});
