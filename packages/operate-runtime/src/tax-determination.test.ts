import { describe, expect, it } from "vitest";

import { isPostingRefused } from "./posting-period.js";
import { InMemoryEntityStore } from "./store.js";
import {
  applicableTaxRules,
  determineLines,
  taxRuleFacts,
  type TaxDeterminationConfig,
  type TaxRuleFacts,
} from "./tax-determination.js";
import { recognitionGlPostingEffect } from "./write-effects.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const clock = { now: () => new Date("2026-06-15T09:00:00Z") };

const rule = (over: Partial<TaxRuleFacts>): TaxRuleFacts => ({
  id: "r1",
  taxCodeId: "vat",
  appliesTo: "sales",
  rateCategory: "standard",
  ratePct: 20,
  reverseCharge: false,
  effectiveFrom: "2020-01-01",
  effectiveTo: null,
  ...over,
});

describe("taxRuleFacts", () => {
  it("reads a stored rule, decimals as strings included", () => {
    expect(
      taxRuleFacts({
        id: "r1",
        tax_code_id: "vat",
        applies_to: "both",
        rate_category: "reduced",
        rate_pct: "7.500",
        reverse_charge: true,
        effective_from: "2026-01-01",
        effective_to: "2026-12-31",
      }),
    ).toEqual({
      id: "r1",
      taxCodeId: "vat",
      appliesTo: "both",
      rateCategory: "reduced",
      ratePct: 7.5,
      reverseCharge: true,
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
    });
  });

  it("refuses a rule with no start date, a non-numeric rate, an unknown side or a malformed end", () => {
    const base = { id: "r1", tax_code_id: "vat", rate_pct: 20, effective_from: "2026-01-01" };
    expect(taxRuleFacts(base)).not.toBeNull();
    expect(taxRuleFacts({ ...base, effective_from: undefined })).toBeNull();
    expect(taxRuleFacts({ ...base, rate_pct: "n/a" })).toBeNull();
    expect(taxRuleFacts({ ...base, rate_pct: -1 })).toBeNull();
    expect(taxRuleFacts({ ...base, rate_pct: 100 })).not.toBeNull();
    expect(taxRuleFacts({ ...base, rate_pct: "100.001" })).toBeNull();
    expect(taxRuleFacts({ ...base, applies_to: "withholding" })).toBeNull();
    expect(taxRuleFacts({ ...base, effective_to: "soon" })).toBeNull();
    expect(taxRuleFacts({ ...base, tax_code_id: "" })).toBeNull();
  });
});

describe("applicableTaxRules", () => {
  const rules = [
    rule({ id: "sales", appliesTo: "sales" }),
    rule({ id: "purchase", appliesTo: "purchase" }),
    rule({ id: "both", appliesTo: "both" }),
    rule({ id: "ended", effectiveTo: "2026-06-14" }),
    rule({ id: "future", effectiveFrom: "2026-06-16" }),
    rule({ id: "edge", effectiveFrom: "2026-06-15", effectiveTo: "2026-06-15" }),
  ];

  it("keeps the side's rules and `both`, in force on the date with both bounds inclusive", () => {
    expect(applicableTaxRules(rules, "sales", "2026-06-15").map((r) => r.id)).toEqual(["sales", "both", "edge"]);
    expect(applicableTaxRules(rules, "purchase", "2026-06-15").map((r) => r.id)).toEqual(["purchase", "both"]);
  });
});

describe("determineLines", () => {
  const ctx = { side: "sales" as const, jurisdictionCode: "UK", date: "2026-06-15", codeLabel: (id: string) => id };
  const refusal = (fn: () => unknown): { status: number; error: string } => {
    try {
      fn();
    } catch (err) {
      if (isPostingRefused(err)) return { status: err.status, error: err.error };
      throw err;
    }
    throw new Error("expected a refusal");
  };

  it("takes the rule's rate for an explicit code", () => {
    const out = determineLines({ ...ctx, lines: [{ net: 100, taxCodeId: "vat", flatRatePct: 0 }], applicable: [rule({ ratePct: 17.5 })] });
    expect(out.rates.get("vat")).toEqual({ rate: 17.5, selfAssessed: false });
  });

  it("refuses an explicit code no rule in force names", () => {
    expect(
      refusal(() => determineLines({ ...ctx, lines: [{ net: 100, taxCodeId: "other", flatRatePct: 0 }], applicable: [rule({})] })),
    ).toEqual({ status: 422, error: "tax_code_not_applicable" });
  });

  it("gives a line with no code and no flat rate the one standard rule's code", () => {
    const out = determineLines({ ...ctx, lines: [{ net: 100, taxCodeId: null, flatRatePct: 0 }], applicable: [rule({}), rule({ id: "z", taxCodeId: "zero", rateCategory: "zero", ratePct: 0 })] });
    expect(out.lines[0]!.taxCodeId).toBe("vat");
    expect(out.rates.get("vat")?.rate).toBe(20);
  });

  it("leaves a line with an explicit flat rate, or with no standard rule to take, as it is", () => {
    const flat = determineLines({ ...ctx, lines: [{ net: 100, taxCodeId: null, flatRatePct: 5 }], applicable: [rule({})] });
    expect(flat.lines[0]!.taxCodeId).toBeNull();
    const none = determineLines({ ...ctx, lines: [{ net: 100, taxCodeId: null, flatRatePct: null }], applicable: [rule({ rateCategory: "reduced" })] });
    expect(none.lines[0]!.taxCodeId).toBeNull();
  });

  it("refuses two standard codes rather than ranking them by an undeclared priority direction", () => {
    expect(
      refusal(() =>
        determineLines({ ...ctx, lines: [{ net: 100, taxCodeId: null, flatRatePct: 0 }], applicable: [rule({}), rule({ id: "r2", taxCodeId: "vat2" })] }),
      ),
    ).toEqual({ status: 409, error: "tax_rule_ambiguous" });
  });

  it("refuses two rules in force for one code that disagree, and accepts two that agree", () => {
    expect(
      refusal(() => determineLines({ ...ctx, lines: [{ net: 1, taxCodeId: "vat", flatRatePct: 0 }], applicable: [rule({}), rule({ id: "r2", ratePct: 21 })] })),
    ).toEqual({ status: 409, error: "tax_rule_ambiguous" });
    const agree = determineLines({ ...ctx, lines: [{ net: 1, taxCodeId: "vat", flatRatePct: 0 }], applicable: [rule({}), rule({ id: "r2", appliesTo: "both" })] });
    expect(agree.rates.get("vat")?.rate).toBe(20);
  });

  it("charges nothing on a sales reverse charge and self-assesses a purchase one", () => {
    const rc = [rule({ appliesTo: "both", reverseCharge: true })];
    const line = [{ net: 100, taxCodeId: "vat", flatRatePct: 0 }];
    expect(determineLines({ ...ctx, lines: line, applicable: rc }).rates.get("vat")).toEqual({ rate: 0, selfAssessed: false });
    expect(determineLines({ ...ctx, side: "purchase", lines: line, applicable: rc }).rates.get("vat")).toEqual({ rate: 20, selfAssessed: true });
  });
});

describe("recognition with a declared jurisdiction", () => {
  const sales = (jurisdiction: string | undefined): TaxDeterminationConfig => ({
    side: "sales",
    dateField: "issue_date",
    resolveJurisdictionCode: () => Promise.resolve(jurisdiction),
  });
  const invoiceEffect = (jurisdiction: string | undefined) =>
    recognitionGlPostingEffect({
      entity: "Invoice",
      triggerState: "sent",
      controlSide: "debit",
      numberField: "invoice_number",
      controlAccountRef: "ar",
      netAccountRef: "revenue",
      taxAccountRef: "tax_payable",
      controlDescription: "AR",
      netDescription: "Revenue",
      taxDescription: "Tax payable",
      taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total", withholdingAccountRef: "wht_receivable", determination: sales(jurisdiction) },
      clock,
    });

  async function seed(opts: { readonly lineCode: string | null; readonly total: number; readonly issueDate?: string }) {
    const store = new InMemoryEntityStore();
    const j = await store.create(TENANT, "TaxJurisdiction", { code: "UK", is_active: true });
    await store.create(TENANT, "TaxCode", { id: "vat", code: "VAT", rate_pct: 20, is_active: true });
    await store.create(TENANT, "TaxCode", { id: "old", code: "OLDVAT", rate_pct: 20, is_active: true });
    // The code says 20; the rule for 2010 says 17.5. A document dated 2010 is taxed at 17.5.
    await store.create(TENANT, "TaxRule", { jurisdiction_id: j.id, tax_code_id: "vat", applies_to: "sales", rate_category: "standard", rate_pct: 17.5, effective_from: "2008-12-01", effective_to: "2010-12-31" });
    await store.create(TENANT, "TaxRule", { jurisdiction_id: j.id, tax_code_id: "vat", applies_to: "sales", rate_category: "standard", rate_pct: 20, effective_from: "2011-01-04" });
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-T", state: "draft", document_type: "invoice", issue_date: opts.issueDate ?? "2026-06-01", total: opts.total });
    await store.create(TENANT, "InvoiceLine", { invoice_id: String(inv.id), line_total: 100, tax_rate_pct: 0, tax_code_id: opts.lineCode });
    return { store, inv };
  }

  const send = (effect: ReturnType<typeof invoiceEffect>, store: InMemoryEntityStore, inv: Record<string, unknown>) =>
    effect({ operation: "transition", entity: "Invoice", tenantId: TENANT, id: String(inv["id"]), before: inv, after: { ...inv, state: "sent" }, store });

  async function postedLines(store: InMemoryEntityStore) {
    return store.list(TENANT, "JournalLine");
  }

  async function refusalOf(p: Promise<unknown>): Promise<{ status: number; error: string }> {
    try {
      await p;
    } catch (err) {
      if (isPostingRefused(err)) return { status: err.status, error: err.error };
      throw err;
    }
    throw new Error("expected a refusal");
  }

  it("taxes an uncoded line at the standard rule's rate and posts a balanced entry", async () => {
    const { store, inv } = await seed({ lineCode: null, total: 120 });
    await send(invoiceEffect("UK"), store, inv);
    const lines = await postedLines(store);
    expect(lines.find((l) => l["description"] === "Tax payable (VAT)")?.["credit"]).toBe(20);
    expect(lines.reduce((s, l) => s + Number(l["debit"]), 0)).toBe(lines.reduce((s, l) => s + Number(l["credit"]), 0));
  });

  it("taxes a back-dated document at the rate the rule in force on its date states", async () => {
    const { store, inv } = await seed({ lineCode: "vat", total: 117.5, issueDate: "2010-06-01" });
    await send(invoiceEffect("UK"), store, inv);
    expect((await postedLines(store)).find((l) => l["description"] === "Tax payable (VAT)")?.["credit"]).toBe(17.5);
  });

  it("refuses a code with no rule in force on the document's date, writing nothing", async () => {
    const { store, inv } = await seed({ lineCode: "old", total: 120 });
    expect(await refusalOf(send(invoiceEffect("UK"), store, inv))).toEqual({ status: 422, error: "tax_code_not_applicable" });
    expect(await store.list(TENANT, "JournalEntry")).toHaveLength(0);
  });

  it("refuses a total that disagrees with the determined tax instead of posting one untaxed line", async () => {
    const { store, inv } = await seed({ lineCode: "vat", total: 100 });
    expect(await refusalOf(send(invoiceEffect("UK"), store, inv))).toEqual({ status: 422, error: "tax_total_disagrees" });
    expect(await store.list(TENANT, "JournalEntry")).toHaveLength(0);
  });

  it("refuses a declared jurisdiction this tenant does not have, or has inactive", async () => {
    const { store, inv } = await seed({ lineCode: "vat", total: 120 });
    expect(await refusalOf(send(invoiceEffect("FR"), store, inv))).toEqual({ status: 409, error: "tax_jurisdiction_unresolved" });
    const uk = (await store.list(TENANT, "TaxJurisdiction"))[0]!;
    await store.update(TENANT, "TaxJurisdiction", String(uk["id"]), { is_active: false });
    expect(await refusalOf(send(invoiceEffect("UK"), store, inv))).toEqual({ status: 409, error: "tax_jurisdiction_unresolved" });
  });

  it("refuses an unreadable rule of the jurisdiction rather than deciding without it", async () => {
    const { store, inv } = await seed({ lineCode: "vat", total: 120 });
    const uk = (await store.list(TENANT, "TaxJurisdiction"))[0]!;
    await store.create(TENANT, "TaxRule", { jurisdiction_id: uk["id"], tax_code_id: "vat", rate_pct: "x", effective_from: "2026-01-01" });
    expect(await refusalOf(send(invoiceEffect("UK"), store, inv))).toEqual({ status: 409, error: "tax_rule_unreadable" });
  });

  it("refuses an inactive code even when a rule names it", async () => {
    const { store, inv } = await seed({ lineCode: "vat", total: 120 });
    await store.update(TENANT, "TaxCode", "vat", { is_active: false });
    expect(await refusalOf(send(invoiceEffect("UK"), store, inv))).toEqual({ status: 422, error: "tax_code_not_applicable" });
  });

  it("never gives an uncoded line a withholding code, though its rule's category defaults to standard", async () => {
    // `rate_category` defaults to `standard`, so a withholding rule written with the defaults reads
    // as a second standard rule. An uncoded line is ordinary tax, never withheld: counting it would
    // refuse every uncoded line as ambiguous, or — with no VAT rule — withhold one silently.
    const { store, inv } = await seed({ lineCode: null, total: 120 });
    const uk = (await store.list(TENANT, "TaxJurisdiction"))[0]!;
    await store.create(TENANT, "TaxCode", { id: "wht", code: "WHT5", rate_pct: 5, kind: "withholding", is_active: true });
    await store.create(TENANT, "TaxRule", { jurisdiction_id: uk["id"], tax_code_id: "wht", applies_to: "sales", rate_pct: 5, effective_from: "2020-01-01" });
    await send(invoiceEffect("UK"), store, inv);
    const lines = await postedLines(store);
    expect(lines.find((l) => l["description"] === "Tax payable (VAT)")?.["credit"]).toBe(20);
    expect(lines.some((l) => String(l["description"]).startsWith("Withholding"))).toBe(false);

    const alone = await seed({ lineCode: null, total: 100 });
    await alone.store.update(TENANT, "TaxCode", "vat", { kind: "withholding" });
    await send(invoiceEffect("UK"), alone.store, alone.inv);
    const aloneLines = await postedLines(alone.store);
    expect(aloneLines.some((l) => String(l["description"]).startsWith("Withholding"))).toBe(false);
    expect(aloneLines.find((l) => l["description"] === "Revenue")?.["credit"]).toBe(100);
  });

  it("posts exactly as before when the tenant declares no jurisdiction", async () => {
    // The code's own rate, and a non-reconciling total degrades to one untaxed line as it always did.
    const a = await seed({ lineCode: "old", total: 120 });
    await send(invoiceEffect(undefined), a.store, a.inv);
    expect((await postedLines(a.store)).find((l) => l["description"] === "Tax payable (OLDVAT)")?.["credit"]).toBe(20);
    const b = await seed({ lineCode: "vat", total: 100 });
    await send(invoiceEffect(""), b.store, b.inv);
    const lines = await postedLines(b.store);
    expect(lines.some((l) => String(l["description"]).startsWith("Tax payable"))).toBe(false);
    expect(lines.find((l) => l["description"] === "Revenue")?.["credit"]).toBe(100);
  });
});

describe("recognition of a purchase reverse charge", () => {
  const billEffect = (selfAssessedAccountRef: string | undefined) =>
    recognitionGlPostingEffect({
      entity: "Bill",
      triggerState: "approved",
      controlSide: "credit",
      numberField: "bill_number",
      controlAccountRef: "accounts_payable",
      netAccountRef: "expense",
      taxAccountRef: "tax_input",
      controlDescription: "AP",
      netDescription: "Expense",
      taxDescription: "Input tax",
      taxLines: {
        entity: "BillLine",
        refField: "bill_id",
        netField: "amount",
        withholdingAccountRef: "wht_payable",
        determination: {
          side: "purchase",
          dateField: "bill_date",
          resolveJurisdictionCode: () => Promise.resolve("DE"),
          ...(selfAssessedAccountRef !== undefined ? { selfAssessedAccountRef } : {}),
        },
      },
      clock,
    });

  async function seed() {
    const store = new InMemoryEntityStore();
    const j = await store.create(TENANT, "TaxJurisdiction", { code: "DE", is_active: true });
    await store.create(TENANT, "TaxCode", { id: "rc", code: "RC19", rate_pct: 19, is_active: true });
    await store.create(TENANT, "TaxRule", { jurisdiction_id: j.id, tax_code_id: "rc", applies_to: "purchase", rate_category: "standard", rate_pct: 19, reverse_charge: true, effective_from: "2020-01-01" });
    // The vendor charged no tax, so the bill's total is its net.
    const bill = await store.create(TENANT, "Bill", { bill_number: "BILL-RC", state: "draft", bill_date: "2026-06-01", total: 100 });
    await store.create(TENANT, "BillLine", { bill_id: String(bill.id), amount: 100, tax_code_id: "rc" });
    return { store, bill };
  }

  it("posts input tax against an equal self-assessed liability, outside the payable", async () => {
    const { store, bill } = await seed();
    await billEffect("tax_payable")({ operation: "transition", entity: "Bill", tenantId: TENANT, id: String(bill.id), before: bill, after: { ...bill, state: "approved" }, store });
    const lines = await store.list(TENANT, "JournalLine");
    const by = (d: string) => lines.find((l) => l["description"] === d);
    expect(by("AP")?.["credit"]).toBe(100);
    expect(by("Expense")?.["debit"]).toBe(100);
    expect(by("Input tax (RC19 (reverse charge))")).toMatchObject({ debit: 19, ledger_account_id: "tax_input" });
    expect(by("Self-assessed tax payable (RC19 (reverse charge))")).toMatchObject({ credit: 19, ledger_account_id: "tax_payable" });
    const cents = (k: string) => lines.reduce((s, l) => s + Math.round(Number(l[k]) * 100), 0);
    expect(cents("debit")).toBe(cents("credit"));
  });

  it("refuses to post a reverse charge with no account to self-assess it to, writing nothing", async () => {
    const { store, bill } = await seed();
    let error = "";
    try {
      await billEffect(undefined)({ operation: "transition", entity: "Bill", tenantId: TENANT, id: String(bill.id), before: bill, after: { ...bill, state: "approved" }, store });
    } catch (err) {
      if (isPostingRefused(err)) error = err.error;
      else throw err;
    }
    expect(error).toBe("tax_reverse_charge_unposted");
    expect(await store.list(TENANT, "JournalEntry")).toHaveLength(0);
  });
});

describe("computeLineTaxBreakdown with a self-assessed code", () => {
  it("keeps self-assessed tax out of the regular and withholding totals", async () => {
    const { computeLineTaxBreakdown } = await import("./write-effects.js");
    const b = computeLineTaxBreakdown(
      [
        { net: 100, taxCodeId: "rc", flatRatePct: null },
        { net: 50, taxCodeId: "vat", flatRatePct: null },
      ],
      new Map([
        ["rc", { rate: 19, label: "RC19", selfAssessed: true }],
        ["vat", { rate: 10, label: "VAT10" }],
      ]),
    );
    expect(b.taxTotal).toBe(5);
    expect(b.withholdingTotal).toBe(0);
    expect(b.selfAssessedTotal).toBe(19);
    expect(b.groups.map((g) => [g.label, g.selfAssessed])).toEqual([
      ["RC19 (reverse charge)", true],
      ["VAT10", false],
    ]);
  });
});
