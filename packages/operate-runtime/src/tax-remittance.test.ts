import { describe, expect, it } from "vitest";

import type { Manifest } from "@crossengin/kernel/manifest";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import type { Entity, Field } from "@crossengin/types/meta-schema";

import {
  isTaxRemittanceRefusal,
  planTaxRemittance,
  TAX_CREDIT_DISPOSITIONS,
  TAX_REMITTANCE_ACCOUNT_SETTINGS,
  TAX_REMITTANCE_ENTRY_INFIX,
  TAX_REMITTANCE_FIGURE_REFUSAL_CODES,
  TAX_REMITTANCE_REFUSAL_CODES,
  TAX_REMITTANCE_REFUSALS,
  TAX_REMITTANCE_REVERSAL_SUFFIX,
  TAX_RETURN_REMITTANCE_FIELDS,
  TAX_RETURN_REMITTANCE_SHAPE,
  taxRemittanceAccountUnresolvedDetail,
  taxRemittanceEntryNumber,
  taxRemittanceUnwiredReasons,
  taxRemittanceWiring,
  type TaxRemittanceLeg,
  type TaxRemittancePlan,
  type TaxRemittancePlanResult,
  type TaxRemittanceRefusalCode,
} from "./tax-remittance.js";
import { FINANCE_ACCOUNT_CODE_KEYS } from "./settings.js";
import type { EntityRecord } from "./store.js";

/** A return as the store hands it back; figures as decimal text, the wire type of a `decimal`. */
function taxReturn(overrides: Readonly<Record<string, unknown>> = {}): EntityRecord {
  return {
    id: "rec_tr1",
    return_number: "TAX-2026-00001",
    jurisdiction_id: "rec_j1",
    fiscal_period_id: "rec_fp1",
    return_type: "vat",
    period_start: "2026-01-01",
    period_end: "2026-03-31",
    output_tax: "120.00",
    input_tax: "20.00",
    net_payable: "100.00",
    currency: "USD",
    state: "filed",
    ...overrides,
  };
}

function plan(overrides: Readonly<Record<string, unknown>> = {}): TaxRemittancePlan {
  const result = planTaxRemittance(taxReturn(overrides));
  if (isTaxRemittanceRefusal(result)) throw new Error(`refused ${result.refusal}`);
  return result;
}

function refusalOf(overrides: Readonly<Record<string, unknown>>): TaxRemittanceRefusalCode | null {
  const result = planTaxRemittance(taxReturn(overrides));
  return isTaxRemittanceRefusal(result) ? result.refusal : null;
}

const leg = (role: TaxRemittanceLeg["role"], side: TaxRemittanceLeg["side"], units: bigint): TaxRemittanceLeg => ({
  role,
  side,
  units,
});

function balance(legs: readonly TaxRemittanceLeg[]): bigint {
  return legs.reduce((sum, l) => sum + (l.side === "debit" ? l.units : -l.units), 0n);
}

describe("the shape map and the field contract", () => {
  it("covers exactly the return types erp-core declares", () => {
    const entity = (buildErpCorePack().entities ?? []).find((e) => e.name === "TaxReturn");
    const field = entity?.fields.find((f) => f.name === "return_type");
    const values = field?.type.kind === "enum" ? [...field.type.values].sort() : [];
    expect(Object.keys(TAX_RETURN_REMITTANCE_SHAPE).sort()).toEqual(values);
    expect(TAX_RETURN_REMITTANCE_SHAPE).toEqual({
      vat: "credit_invoice",
      gst: "credit_invoice",
      consumption_tax: "credit_invoice",
      sales_tax: "sales_tax",
      withholding: "withholding",
    });
  });

  it("names the eleven fields it reads and the three it stamps", () => {
    expect(TAX_RETURN_REMITTANCE_FIELDS.required).toEqual([
      "return_number",
      "jurisdiction_id",
      "fiscal_period_id",
      "return_type",
      "period_start",
      "period_end",
      "output_tax",
      "input_tax",
      "net_payable",
      "currency",
      "credit_disposition",
    ]);
    expect(TAX_RETURN_REMITTANCE_FIELDS.stamps).toEqual(["remitted_at", "remittance_entry_number", "remittance_count"]);
    expect(TAX_CREDIT_DISPOSITIONS).toEqual(["refund_received", "carried_forward"]);
  });

  it("maps every leg role to a finance account setting that exists", () => {
    for (const key of Object.values(TAX_REMITTANCE_ACCOUNT_SETTINGS)) expect(FINANCE_ACCOUNT_CODE_KEYS).toContain(key);
    expect(TAX_REMITTANCE_ACCOUNT_SETTINGS).toEqual({
      output: "taxPayableAccountCode",
      input: "taxInputAccountCode",
      withholding: "whtPayableAccountCode",
      cash: "cashAccountCode",
    });
  });
});

describe("taxRemittanceEntryNumber", () => {
  it("counts from the stored remittance count", () => {
    expect(taxRemittanceEntryNumber("TAX-2026-00001", 0)).toBe("TAX-2026-00001-REMIT-1");
    expect(taxRemittanceEntryNumber("TAX-2026-00001", 1)).toBe("TAX-2026-00001-REMIT-2");
    expect(TAX_REMITTANCE_ENTRY_INFIX).toBe("-REMIT-");
    expect(TAX_REMITTANCE_REVERSAL_SUFFIX).toBe("-REV");
  });

  it("refuses a count that is not a non-negative integer", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => taxRemittanceEntryNumber("TAX-1", bad)).toThrow(RangeError);
    }
  });
});

describe("planTaxRemittance: the postings", () => {
  it("credit invoice, net payable: Dr output O, Cr input I, Cr cash N", () => {
    expect(plan()).toEqual({
      shape: "credit_invoice",
      legs: [leg("output", "debit", 12000n), leg("input", "credit", 2000n), leg("cash", "credit", 10000n)],
    });
  });

  it("gst and consumption tax take the credit-invoice shape too", () => {
    expect(plan({ return_type: "gst" }).shape).toBe("credit_invoice");
    expect(plan({ return_type: "consumption_tax" }).shape).toBe("credit_invoice");
  });

  it("credit invoice, refund received: Dr output O, Dr cash |N|, Cr input I", () => {
    expect(
      plan({ output_tax: "30.00", input_tax: "80.00", net_payable: "-50.00", credit_disposition: "refund_received" }),
    ).toEqual({
      shape: "credit_invoice",
      legs: [leg("output", "debit", 3000n), leg("cash", "debit", 5000n), leg("input", "credit", 8000n)],
    });
  });

  it("credit invoice, carried forward: Dr output O, Cr input O, leaving the credit in the input account", () => {
    expect(
      plan({ output_tax: "30.00", input_tax: "80.00", net_payable: "-50.00", credit_disposition: "carried_forward" }),
    ).toEqual({
      shape: "credit_invoice",
      legs: [leg("output", "debit", 3000n), leg("input", "credit", 3000n)],
    });
  });

  it("sales tax: Dr output O, Cr cash O", () => {
    expect(plan({ return_type: "sales_tax", output_tax: "45.10", input_tax: "0", net_payable: "45.10" })).toEqual({
      shape: "sales_tax",
      legs: [leg("output", "debit", 4510n), leg("cash", "credit", 4510n)],
    });
  });

  it("withholding: Dr withholding N, Cr cash N", () => {
    expect(plan({ return_type: "withholding", output_tax: "0", input_tax: "0", net_payable: "30.00" })).toEqual({
      shape: "withholding",
      legs: [leg("withholding", "debit", 3000n), leg("cash", "credit", 3000n)],
    });
  });

  it("drops a zero leg rather than posting it", () => {
    expect(plan({ output_tax: "100.00", input_tax: "0", net_payable: "100.00" }).legs).toEqual([
      leg("output", "debit", 10000n),
      leg("cash", "credit", 10000n),
    ]);
    // Input tax exactly offsets output tax: nothing to pay, both accounts cleared.
    expect(plan({ output_tax: "20.00", input_tax: "20.00", net_payable: "0" }).legs).toEqual([
      leg("output", "debit", 2000n),
      leg("input", "credit", 2000n),
    ]);
  });

  it("plans no legs for a nil return", () => {
    expect(plan({ output_tax: "0", input_tax: "0", net_payable: "0" })).toEqual({ shape: "credit_invoice", legs: [] });
    expect(plan({ return_type: "withholding", output_tax: 0, input_tax: 0, net_payable: 0 }).legs).toEqual([]);
    expect(
      plan({ output_tax: "0", input_tax: "50.00", net_payable: "-50.00", credit_disposition: "carried_forward" }).legs,
    ).toEqual([]);
  });

  it("is exact in cents: no double arithmetic", () => {
    expect(plan({ output_tax: "0.30", input_tax: "0.10", net_payable: "0.20" }).legs).toEqual([
      leg("output", "debit", 30n),
      leg("input", "credit", 10n),
      leg("cash", "credit", 20n),
    ]);
  });

  it("reads numbers as well as decimal text", () => {
    expect(plan({ output_tax: 120, input_tax: 20, net_payable: 100 }).legs).toEqual(plan().legs);
  });

  it("treats an empty disposition as none", () => {
    expect(plan({ credit_disposition: "" }).legs).toEqual(plan().legs);
    expect(plan({ credit_disposition: null }).legs).toEqual(plan().legs);
  });
});

describe("planTaxRemittance: the refusals, each beside a passing control", () => {
  it("tax_return_type_unsupported", () => {
    expect(refusalOf({ return_type: "excise" })).toBe("tax_return_type_unsupported");
    expect(refusalOf({ return_type: undefined })).toBe("tax_return_type_unsupported");
    // A prototype key is not a return type.
    expect(refusalOf({ return_type: "constructor" })).toBe("tax_return_type_unsupported");
    expect(refusalOf({ return_type: "vat" })).toBeNull();
  });

  it("tax_return_figures_invalid: unreadable or negative output or input", () => {
    expect(refusalOf({ output_tax: "abc" })).toBe("tax_return_figures_invalid");
    expect(refusalOf({ net_payable: undefined })).toBe("tax_return_figures_invalid");
    expect(refusalOf({ output_tax: "-1.00", net_payable: "-21.00" })).toBe("tax_return_figures_invalid");
    expect(refusalOf({ input_tax: "-1.00", net_payable: "121.00" })).toBe("tax_return_figures_invalid");
    expect(refusalOf({})).toBeNull();
  });

  it("tax_return_figures_disagree: N must equal O - I for a credit invoice", () => {
    expect(refusalOf({ net_payable: "99.99" })).toBe("tax_return_figures_disagree");
    expect(refusalOf({ net_payable: "100.00" })).toBeNull();
  });

  it("tax_return_figures_disagree: sales tax needs I = 0 and N = O", () => {
    const sales = { return_type: "sales_tax", output_tax: "50.00", input_tax: "0", net_payable: "50.00" };
    expect(refusalOf({ ...sales, input_tax: "5.00", net_payable: "45.00" })).toBe("tax_return_figures_disagree");
    expect(refusalOf({ ...sales, net_payable: "40.00" })).toBe("tax_return_figures_disagree");
    expect(refusalOf(sales)).toBeNull();
  });

  it("tax_return_figures_disagree: withholding needs O = 0 and I = 0", () => {
    const wht = { return_type: "withholding", output_tax: "0", input_tax: "0", net_payable: "30.00" };
    expect(refusalOf({ ...wht, output_tax: "30.00" })).toBe("tax_return_figures_disagree");
    expect(refusalOf({ ...wht, input_tax: "1.00" })).toBe("tax_return_figures_disagree");
    expect(refusalOf(wht)).toBeNull();
  });

  it("tax_return_withholding_negative", () => {
    const wht = { return_type: "withholding", output_tax: "0", input_tax: "0" };
    expect(refusalOf({ ...wht, net_payable: "-1.00" })).toBe("tax_return_withholding_negative");
    expect(refusalOf({ ...wht, net_payable: "0" })).toBeNull();
  });

  it("tax_return_credit_disposition_required: a negative net with no disposition", () => {
    const credit = { output_tax: "30.00", input_tax: "80.00", net_payable: "-50.00" };
    expect(refusalOf(credit)).toBe("tax_return_credit_disposition_required");
    expect(refusalOf({ ...credit, credit_disposition: "" })).toBe("tax_return_credit_disposition_required");
    expect(refusalOf({ ...credit, credit_disposition: "refund_received" })).toBeNull();
  });

  it("tax_return_credit_disposition_unexpected: set on a payable return, on another shape, or out of the enum", () => {
    expect(refusalOf({ credit_disposition: "refund_received" })).toBe("tax_return_credit_disposition_unexpected");
    expect(
      refusalOf({ return_type: "sales_tax", input_tax: "0", net_payable: "120.00", credit_disposition: "carried_forward" }),
    ).toBe("tax_return_credit_disposition_unexpected");
    expect(
      refusalOf({
        return_type: "withholding",
        output_tax: "0",
        input_tax: "0",
        net_payable: "5.00",
        credit_disposition: "refund_received",
      }),
    ).toBe("tax_return_credit_disposition_unexpected");
    expect(
      refusalOf({ output_tax: "30.00", input_tax: "80.00", net_payable: "-50.00", credit_disposition: "refund_pending" }),
    ).toBe("tax_return_credit_disposition_unexpected");
    expect(refusalOf({})).toBeNull();
  });

  it("tax_return_period_invalid: start after end, or not a real date", () => {
    expect(refusalOf({ period_start: "2026-04-01", period_end: "2026-03-31" })).toBe("tax_return_period_invalid");
    expect(refusalOf({ period_end: "2026-02-30" })).toBe("tax_return_period_invalid");
    expect(refusalOf({ period_start: undefined })).toBe("tax_return_period_invalid");
    expect(refusalOf({ period_start: "2026-03-31", period_end: "2026-03-31" })).toBeNull();
  });

  it("produces exactly the figure refusals, every one reached above", () => {
    const reached = new Set<TaxRemittanceRefusalCode>();
    const cases: Readonly<Record<string, unknown>>[] = [
      { return_type: "excise" },
      { output_tax: "abc" },
      { net_payable: "1.00" },
      { return_type: "withholding", output_tax: "0", input_tax: "0", net_payable: "-1.00" },
      { output_tax: "0", input_tax: "1.00", net_payable: "-1.00" },
      { credit_disposition: "carried_forward" },
      { period_start: "2026-12-31" },
    ];
    for (const c of cases) {
      const code = refusalOf(c);
      if (code !== null) reached.add(code);
    }
    expect([...reached].sort()).toEqual([...TAX_REMITTANCE_FIGURE_REFUSAL_CODES].sort());
  });
});

describe("the refusal map", () => {
  it("is total over the codes, with a status and a non-empty literal detail each", () => {
    expect(Object.keys(TAX_REMITTANCE_REFUSALS).sort()).toEqual([...TAX_REMITTANCE_REFUSAL_CODES].sort());
    for (const code of TAX_REMITTANCE_REFUSAL_CODES) {
      const { status, detail } = TAX_REMITTANCE_REFUSALS[code];
      expect([409, 422]).toContain(status);
      expect(detail.length).toBeGreaterThan(0);
      expect(detail).not.toMatch(/\$\{|undefined|null/);
    }
  });

  it("answers a return that is wrong in itself with 422 and one its configuration cannot serve with 409", () => {
    for (const code of TAX_REMITTANCE_FIGURE_REFUSAL_CODES) expect(TAX_REMITTANCE_REFUSALS[code].status).toBe(422);
    const configuration = TAX_REMITTANCE_REFUSAL_CODES.filter(
      (c) => !(TAX_REMITTANCE_FIGURE_REFUSAL_CODES as readonly string[]).includes(c),
    );
    for (const code of configuration) expect(TAX_REMITTANCE_REFUSALS[code].status).toBe(409);
  });

  it("names the setting in the account-unresolved detail and nothing a record carries", () => {
    expect(taxRemittanceAccountUnresolvedDetail("cash")).toMatch(/set finance\.cashAccountCode$/);
    expect(taxRemittanceAccountUnresolvedDetail("withholding")).toMatch(/finance\.whtPayableAccountCode$/);
  });

});

describe("no admitted return posts legs that do not balance", () => {
  it("holds over a grid of shapes, signs and dispositions", () => {
    const figures = ["0", "0.01", "20.00", "120.00", "999999.99"];
    const nets = ["-120.00", "-0.01", "0", "0.01", "100.00", "120.00"];
    let admitted = 0;
    for (const return_type of Object.keys(TAX_RETURN_REMITTANCE_SHAPE)) {
      for (const output_tax of figures) {
        for (const input_tax of figures) {
          for (const net_payable of nets) {
            for (const credit_disposition of [undefined, ...TAX_CREDIT_DISPOSITIONS]) {
              const result: TaxRemittancePlanResult = planTaxRemittance(
                taxReturn({ return_type, output_tax, input_tax, net_payable, credit_disposition }),
              );
              if (isTaxRemittanceRefusal(result)) continue;
              admitted += 1;
              expect(balance(result.legs)).toBe(0n);
              for (const l of result.legs) expect(l.units > 0n).toBe(true);
            }
          }
        }
      }
    }
    // Non-vacuity: the grid admits returns of every shape, so the balance assertion ran.
    expect(admitted).toBeGreaterThan(20);
  });
});

/**
 * A manifest carrying everything the posting needs, built from erp-core with any missing field added,
 * so these tests do not depend on which version of the pack is built.
 */
function wiredManifest(): Manifest {
  const base = buildErpCorePack();
  const extra: Readonly<Record<string, Field>> = {
    credit_disposition: { name: "credit_disposition", type: { kind: "enum", values: ["refund_received", "carried_forward"] } },
    remitted_at: { name: "remitted_at", type: { kind: "datetime" } },
    remittance_entry_number: { name: "remittance_entry_number", type: { kind: "text", maxLength: 64 } },
    remittance_count: { name: "remittance_count", type: { kind: "integer" } },
  };
  const entities = (base.entities ?? []).map((e): Entity => {
    if (e.name !== "TaxReturn") return e;
    const names = new Set(e.fields.map((f) => f.name));
    return { ...e, fields: [...e.fields, ...Object.values(extra).filter((f) => !names.has(f.name))] };
  });
  const workflows = Object.fromEntries(
    Object.entries(base.workflows ?? {}).map(([key, wf]) => {
      if (wf.kind !== "entityLifecycle" || wf.entity !== "TaxReturn") return [key, wf];
      const has = wf.transitions.some((t) => t.name === "reverse_payment");
      return [
        key,
        has ? wf : { ...wf, transitions: [...wf.transitions, { name: "reverse_payment", from: "paid", to: "filed" }] },
      ];
    }),
  );
  return { ...base, entities, workflows };
}

function withoutTaxReturnField(manifest: Manifest, field: string): Manifest {
  return {
    ...manifest,
    entities: (manifest.entities ?? []).map((e) =>
      e.name === "TaxReturn" ? { ...e, fields: e.fields.filter((f) => f.name !== field) } : e,
    ),
  };
}

function withTaxReturnTransitions(
  manifest: Manifest,
  edit: (t: readonly { name: string; from: string | string[]; to: string }[]) => {
    name: string;
    from: string | string[];
    to: string;
  }[],
): Manifest {
  return {
    ...manifest,
    workflows: Object.fromEntries(
      Object.entries(manifest.workflows ?? {}).map(([key, wf]) =>
        wf.kind === "entityLifecycle" && wf.entity === "TaxReturn" ? [key, { ...wf, transitions: edit(wf.transitions) }] : [key, wf],
      ),
    ),
  };
}

describe("taxRemittanceWiring", () => {
  it("is non-null for a manifest carrying every field, entity and transition, and names the state field", () => {
    const m = wiredManifest();
    expect(taxRemittanceUnwiredReasons(m)).toEqual([]);
    expect(taxRemittanceWiring(m)).toEqual({ entity: "TaxReturn", stateField: "state", reverseTransition: "reverse_payment" });
  });

  it("is null when any single required field or stamp is missing, and the reason names it", () => {
    for (const field of [...TAX_RETURN_REMITTANCE_FIELDS.required, ...TAX_RETURN_REMITTANCE_FIELDS.stamps]) {
      const m = withoutTaxReturnField(wiredManifest(), field);
      expect(taxRemittanceWiring(m)).toBeNull();
      expect(taxRemittanceUnwiredReasons(m)).toEqual([`TaxReturn declares no field '${field}'`]);
    }
  });

  it("is null when any entity the posting touches is missing", () => {
    for (const name of ["TaxReturn", "JournalEntry", "JournalLine", "LedgerAccount", "TaxJurisdiction", "FiscalPeriod"]) {
      const m = { ...wiredManifest(), entities: (wiredManifest().entities ?? []).filter((e) => e.name !== name) };
      expect(taxRemittanceWiring(m)).toBeNull();
      expect(taxRemittanceUnwiredReasons(m)).toContain(`the manifest declares no ${name} entity`);
    }
  });

  it("is null with no lifecycle, or no transition into filed or into paid", () => {
    const noLifecycle = {
      ...wiredManifest(),
      workflows: Object.fromEntries(
        Object.entries(wiredManifest().workflows ?? {}).filter(([, wf]) => !(wf.kind === "entityLifecycle" && wf.entity === "TaxReturn")),
      ),
    };
    expect(taxRemittanceWiring(noLifecycle)).toBeNull();
    expect(taxRemittanceUnwiredReasons(noLifecycle)).toEqual(["TaxReturn has no entityLifecycle workflow"]);

    const noPaid = withTaxReturnTransitions(wiredManifest(), (ts) => ts.filter((t) => t.to !== "paid"));
    expect(taxRemittanceWiring(noPaid)).toBeNull();
    expect(taxRemittanceUnwiredReasons(noPaid)).toEqual(["TaxReturn's lifecycle has no transition into 'paid'"]);

    const noFiled = withTaxReturnTransitions(wiredManifest(), (ts) => ts.filter((t) => t.to !== "filed"));
    expect(taxRemittanceWiring(noFiled)).toBeNull();
    expect(taxRemittanceUnwiredReasons(noFiled)).toContain("TaxReturn's lifecycle has no transition into 'filed'");
  });

  // A remittance it could not undo would be refused from the journal and from the return alike.
  const NO_REVERSE = "TaxReturn's lifecycle has no 'reverse_payment' transition from 'paid' to 'filed'";

  it("is null without reverse_payment, so nothing posts that could not be undone", () => {
    const m = withTaxReturnTransitions(wiredManifest(), (ts) => ts.filter((t) => t.name !== "reverse_payment"));
    expect(taxRemittanceWiring(m)).toBeNull();
    expect(taxRemittanceUnwiredReasons(m)).toEqual([NO_REVERSE]);
  });

  it("does not take a reverse_payment that does not run paid to filed", () => {
    const m = withTaxReturnTransitions(wiredManifest(), (ts) => [
      ...ts.filter((t) => t.name !== "reverse_payment"),
      { name: "reverse_payment", from: "paid", to: "amended" },
    ]);
    expect(taxRemittanceWiring(m)).toBeNull();
    expect(taxRemittanceUnwiredReasons(m)).toEqual([NO_REVERSE]);
  });
});
