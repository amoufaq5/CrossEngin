import { describe, expect, it } from "vitest";

import { DEFAULT_DRAIN_PAGE_SIZE, isReadCeilingExceeded, ReadCeilingExceeded } from "./list-drain.js";
import { InMemoryEntityStore, type EntityStore } from "./store.js";
import {
  bookingRateStampEffect,
  computeLineTaxBreakdown,
  creditNoteGlPostingEffect,
  invoiceVoidCreditNoteEffect,
  journalReversalEffect,
  paymentApplicationEffect,
  paymentSettlementGlPostingEffect,
  recognitionGlPostingEffect,
  runWriteEffects,
  unrealizedFxRevaluationEffect,
  whtCertificateClearingEffect,
  type WriteEffectInput,
} from "./write-effects.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const clock = { now: () => new Date("2026-06-21T00:00:00.000Z") };

async function postedEntryWithLines() {
  const store = new InMemoryEntityStore();
  const entry = await store.create(TENANT, "JournalEntry", {
    entry_number: "JE-2026-00007",
    state: "posted",
    book_id: "book1",
    fiscal_period_id: "p1",
  });
  const id = String(entry.id);
  await store.create(TENANT, "JournalLine", {
    journal_entry_id: id,
    ledger_account_id: "cash",
    cost_center_id: "cc1",
    description: "Cash in",
    debit: 100,
    credit: 0,
    currency: "USD",
    fx_rate: 1,
    functional_debit: 100,
    functional_credit: 0,
  });
  await store.create(TENANT, "JournalLine", {
    journal_entry_id: id,
    ledger_account_id: "revenue",
    description: "Revenue",
    debit: 0,
    credit: 100,
    currency: "USD",
    fx_rate: 1,
    functional_debit: 0,
    functional_credit: 100,
  });
  return { store, id, entry };
}

function reverseInput(store: InMemoryEntityStore, id: string, before: Record<string, unknown>): WriteEffectInput {
  return {
    operation: "update",
    entity: "JournalEntry",
    tenantId: TENANT,
    id,
    before,
    after: { ...before, state: "reversed" },
    store,
  };
}

describe("journalReversalEffect", () => {
  const effect = journalReversalEffect({ clock });

  it("does nothing unless an entry moves posted→reversed", async () => {
    const { store, id, entry } = await postedEntryWithLines();
    await effect({ ...reverseInput(store, id, entry), after: { ...entry, memo: "x" } });
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(1);
  });

  it("creates a mirror posted entry numbered <orig>-REV in the same book/period", async () => {
    const { store, id, entry } = await postedEntryWithLines();
    await effect(reverseInput(store, id, entry));
    const entries = await store.list(TENANT, "JournalEntry");
    expect(entries.length).toBe(2);
    const rev = entries.find((e) => e.entry_number === "JE-2026-00007-REV")!;
    expect(rev.state).toBe("posted");
    expect(rev.book_id).toBe("book1");
    expect(rev.fiscal_period_id).toBe("p1");
    expect(rev.memo).toBe("Reversal of JE-2026-00007");
    expect(rev.entry_date).toBe("2026-06-21");
  });

  it("negates each line by swapping debit↔credit (and the functional pair)", async () => {
    const { store, id, entry } = await postedEntryWithLines();
    await effect(reverseInput(store, id, entry));
    const rev = (await store.list(TENANT, "JournalEntry")).find((e) => e.entry_number === "JE-2026-00007-REV")!;
    const revLines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === rev.id);
    expect(revLines.length).toBe(2);
    const cash = revLines.find((l) => l.ledger_account_id === "cash")!;
    expect(cash.debit).toBe(0);
    expect(cash.credit).toBe(100);
    expect(cash.functional_debit).toBe(0);
    expect(cash.functional_credit).toBe(100);
    expect(cash.cost_center_id).toBe("cc1");
    expect(cash.description).toBe("Reversal: Cash in");
    // The mirror is itself balanced.
    const debit = revLines.reduce((s, l) => s + Number(l.debit), 0);
    const credit = revLines.reduce((s, l) => s + Number(l.credit), 0);
    expect(debit).toBe(credit);
  });
});

describe("invoiceVoidCreditNoteEffect", () => {
  const effect = invoiceVoidCreditNoteEffect({ lineEntity: "InvoiceLine", clock });

  async function issuedInvoice(state = "sent") {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", {
      invoice_number: "INV-2026-00005",
      state,
      document_type: "invoice",
      account_id: "acct1",
      currency: "USD",
      subtotal: 100,
      tax_total: 5,
      total: 105,
    });
    const id = String(inv.id);
    await store.create(TENANT, "InvoiceLine", {
      invoice_id: id,
      position: 1,
      description: "Widget",
      quantity: 2,
      unit_price: 50,
      tax_rate_pct: 5,
      line_total: 105,
    });
    return { store, id, inv };
  }

  function voidInput(store: InMemoryEntityStore, id: string, before: Record<string, unknown>): WriteEffectInput {
    return { operation: "transition", entity: "Invoice", tenantId: TENANT, id, before, after: { ...before, state: "void" }, store };
  }

  it("creates a credit note linked to the voided invoice with mirrored totals", async () => {
    const { store, id, inv } = await issuedInvoice();
    await effect(voidInput(store, id, inv));
    const invoices = await store.list(TENANT, "Invoice");
    expect(invoices.length).toBe(2);
    const cn = invoices.find((i) => i.document_type === "credit_note")!;
    expect(cn.invoice_number).toBe("INV-2026-00005-CN");
    expect(cn.credit_note_of).toBe(id);
    expect(cn.account_id).toBe("acct1");
    expect(cn.total).toBe(105);
    expect(cn.state).toBe("sent");
    expect(cn.notes).toBe("Credit note for INV-2026-00005");
  });

  it("mirrors each invoice line onto the credit note", async () => {
    const { store, id, inv } = await issuedInvoice();
    await effect(voidInput(store, id, inv));
    const cn = (await store.list(TENANT, "Invoice")).find((i) => i.document_type === "credit_note")!;
    const cnLines = (await store.list(TENANT, "InvoiceLine")).filter((l) => l.invoice_id === cn.id);
    expect(cnLines.length).toBe(1);
    expect(cnLines[0]?.line_total).toBe(105);
    expect(cnLines[0]?.description).toBe("Credit: Widget");
  });

  it("does nothing when voiding a never-issued draft", async () => {
    const { store, id, inv } = await issuedInvoice("draft");
    await effect(voidInput(store, id, inv));
    expect((await store.list(TENANT, "Invoice")).length).toBe(1);
  });

  it("never credit-notes a credit note", async () => {
    const { store, id, inv } = await issuedInvoice();
    await effect(voidInput(store, id, { ...inv, document_type: "credit_note" }));
    expect((await store.list(TENANT, "Invoice")).length).toBe(1);
  });

  it("issues a partial credit note for a credit_amount below the total", async () => {
    const { store, id, inv } = await issuedInvoice();
    await effect(voidInput(store, id, { ...inv, credit_amount: 40 }));
    const cn = (await store.list(TENANT, "Invoice")).find((i) => i.document_type === "credit_note")!;
    expect(cn.total).toBe(40);
    expect(cn.notes).toBe("Partial credit note for INV-2026-00005");
    const cnLines = (await store.list(TENANT, "InvoiceLine")).filter((l) => l.invoice_id === cn.id);
    expect(cnLines.length).toBe(1);
    expect(cnLines[0]?.description).toBe("Partial credit");
    expect(cnLines[0]?.line_total).toBe(40);
  });

  it("credits the full total when credit_amount >= total", async () => {
    const { store, id, inv } = await issuedInvoice();
    await effect(voidInput(store, id, { ...inv, credit_amount: 999 }));
    const cn = (await store.list(TENANT, "Invoice")).find((i) => i.document_type === "credit_note")!;
    expect(cn.total).toBe(105);
    expect(cn.notes).toBe("Credit note for INV-2026-00005");
  });
});

describe("creditNoteGlPostingEffect (AR↔GL bridge)", () => {
  const effect = creditNoteGlPostingEffect({ clock });

  async function issued(amountField?: number) {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", {
      invoice_number: "INV-2026-00009",
      state: "sent",
      document_type: "invoice",
      currency: "EUR",
      total: 200,
      ...(amountField !== undefined ? { credit_amount: amountField } : {}),
    });
    return { store, id: String(inv.id), inv };
  }
  const voidIt = (store: InMemoryEntityStore, id: string, before: Record<string, unknown>): WriteEffectInput =>
    ({ operation: "transition", entity: "Invoice", tenantId: TENANT, id, before, after: { ...before, state: "void" }, store });

  it("posts a balanced journal entry reversing revenue and AR for the full credit", async () => {
    const { store, id, inv } = await issued();
    await effect(voidIt(store, id, inv));
    const entries = await store.list(TENANT, "JournalEntry");
    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    expect(entry.entry_number).toBe("INV-2026-00009-CN-GL");
    expect(entry.state).toBe("posted");
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.length).toBe(2);
    const debit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const credit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(debit).toBe(200);
    expect(credit).toBe(200);
    expect(debit).toBe(credit); // balanced
    expect(lines.every((l) => l.currency === "EUR")).toBe(true);
  });

  it("posts for the partial amount when credit_amount is set", async () => {
    const { store, id, inv } = await issued(75);
    await effect(voidIt(store, id, inv));
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(75);
    expect(lines.reduce((s, l) => s + Number(l.credit), 0)).toBe(75);
  });

  it("does nothing when voiding a draft invoice", async () => {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { state: "draft", total: 200 });
    await effect(voidIt(store, String(inv.id), inv));
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
  });

  it("posts to the resolved chart-of-accounts ids when codes are configured", async () => {
    const store = new InMemoryEntityStore();
    const ar = await store.create(TENANT, "LedgerAccount", { account_code: "1100", name: "AR" });
    const rev = await store.create(TENANT, "LedgerAccount", { account_code: "4000", name: "Revenue" });
    const inv = await store.create(TENANT, "Invoice", {
      invoice_number: "INV-X",
      state: "sent",
      document_type: "invoice",
      currency: "USD",
      total: 50,
    });
    const resolving = creditNoteGlPostingEffect({
      clock,
      resolveAccountCodes: async () => ({ ar: "1100", revenue: "4000" }),
    });
    await resolving(voidIt(store, String(inv.id), inv));
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    const arLine = lines.find((l) => Number(l.credit) > 0)!;
    const revLine = lines.find((l) => Number(l.debit) > 0)!;
    expect(arLine.ledger_account_id).toBe(String(ar.id));
    expect(revLine.ledger_account_id).toBe(String(rev.id));
  });

  it("falls back to placeholder refs when a code resolves to no account", async () => {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-Y", state: "sent", document_type: "invoice", total: 50 });
    const resolving = creditNoteGlPostingEffect({ clock, resolveAccountCodes: async () => ({ ar: "9999", revenue: "8888" }) });
    await resolving(voidIt(store, String(inv.id), inv));
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.find((l) => Number(l.credit) > 0)!.ledger_account_id).toBe("accounts_receivable");
    expect(lines.find((l) => Number(l.debit) > 0)!.ledger_account_id).toBe("revenue");
  });
});

describe("recognitionGlPostingEffect (tax split)", () => {
  const invoiceRec = recognitionGlPostingEffect({
    entity: "Invoice",
    triggerState: "sent",
    controlSide: "debit",
    numberField: "invoice_number",
    skipDocumentType: { field: "document_type", value: "credit_note" },
    controlAccountRef: "ar",
    netAccountRef: "revenue",
    taxAccountRef: "tax_payable",
    controlDescription: "AR",
    netDescription: "Revenue",
    taxDescription: "Tax payable",
    clock,
  });
  const issue = (store: InMemoryEntityStore, id: string, before: Record<string, unknown>) =>
    invoiceRec({ operation: "transition", entity: "Invoice", tenantId: TENANT, id, before, after: { ...before, state: "sent" }, store });

  it("splits revenue and tax on a taxed invoice (AR = subtotal + tax)", async () => {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-T", state: "draft", document_type: "invoice", subtotal: 100, tax_total: 20, total: 120 });
    await issue(store, String(inv.id), inv);
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.length).toBe(3);
    expect(lines.find((l) => l.ledger_account_id === "ar")!.debit).toBe(120);
    expect(lines.find((l) => l.ledger_account_id === "revenue")!.credit).toBe(100);
    expect(lines.find((l) => l.ledger_account_id === "tax_payable")!.credit).toBe(20);
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(lines.reduce((s, l) => s + Number(l.credit), 0));
  });

  // Ported from the deleted `paymentGlPostingEffect` block, which held the only assertion anywhere
  // that a skipped document type suppresses the posting — against its own copy of the branch, while
  // this live one went uncovered: `invoiceRec` above has configured `skipDocumentType` since it was
  // written and asserted nothing about it, and deleting the live check left all 848 tests green.
  // The branch is reachable through the shipped Invoice wiring (compile.ts sets it for credit_note).
  it("skips a credit note reaching its recognized state (a credit note reverses, it doesn't recognize)", async () => {
    const store = new InMemoryEntityStore();
    const cn = await store.create(TENANT, "Invoice", { invoice_number: "CN-R", state: "draft", document_type: "credit_note", subtotal: 100, tax_total: 20, total: 120 });
    await issue(store, String(cn.id), cn);
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
    expect((await store.list(TENANT, "JournalLine")).length).toBe(0);
  });

  it("degrades to a single net line when there's no tax / the split doesn't reconcile", async () => {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-U", state: "draft", document_type: "invoice", total: 50 });
    await issue(store, String(inv.id), inv);
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.length).toBe(2);
    expect(lines.find((l) => l.ledger_account_id === "ar")!.debit).toBe(50);
    expect(lines.find((l) => l.ledger_account_id === "revenue")!.credit).toBe(50);
  });

  it("credits AP and debits expense + input tax for a bill (control on credit side)", async () => {
    const billRec = recognitionGlPostingEffect({
      entity: "Bill",
      triggerState: "approved",
      controlSide: "credit",
      numberField: "bill_number",
      controlAccountRef: "ap",
      netAccountRef: "expense",
      taxAccountRef: "tax_input",
      controlDescription: "AP",
      netDescription: "Expense",
      taxDescription: "Input tax",
      clock,
    });
    const store = new InMemoryEntityStore();
    const bill = await store.create(TENANT, "Bill", { bill_number: "BILL-T", state: "draft", subtotal: 200, tax_total: 10, total: 210 });
    await billRec({ operation: "transition", entity: "Bill", tenantId: TENANT, id: String(bill.id), before: bill, after: { ...bill, state: "approved" }, store });
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.find((l) => l.ledger_account_id === "ap")!.credit).toBe(210);
    expect(lines.find((l) => l.ledger_account_id === "expense")!.debit).toBe(200);
    expect(lines.find((l) => l.ledger_account_id === "tax_input")!.debit).toBe(10);
  });
});

describe("computeLineTaxBreakdown", () => {
  it("groups tax by TaxCode label and sums net", () => {
    const codes = new Map([
      ["std", { rate: 20, label: "VAT20" }],
      ["red", { rate: 5, label: "VAT5" }],
    ]);
    const b = computeLineTaxBreakdown(
      [
        { net: 100, taxCodeId: "std", flatRatePct: null },
        { net: 200, taxCodeId: "std", flatRatePct: null },
        { net: 100, taxCodeId: "red", flatRatePct: null },
      ],
      codes,
    );
    expect(b.netTotal).toBe(400);
    expect(b.taxTotal).toBe(65); // (300×20%) + (100×5%) = 60 + 5
    expect(b.groups).toEqual([
      { label: "VAT20", tax: 60, accountCode: null, jurisdiction: null, withholding: false },
      { label: "VAT5", tax: 5, accountCode: null, jurisdiction: null, withholding: false },
    ]);
  });

  it("carries the per-code GL account code onto its group", () => {
    const codes = new Map([["wht", { rate: 10, label: "WHT10", accountCode: "2155" }]]);
    const b = computeLineTaxBreakdown([{ net: 100, taxCodeId: "wht", flatRatePct: null }], codes);
    expect(b.groups).toEqual([{ label: "WHT10", tax: 10, accountCode: "2155", jurisdiction: null, withholding: false }]);
  });

  it("separates withholding tax from regular tax in the totals", () => {
    const codes = new Map([
      ["vat", { rate: 20, label: "VAT20", accountCode: null, withholding: false }],
      ["wht", { rate: 10, label: "WHT10", accountCode: "2155", withholding: true }],
    ]);
    const b = computeLineTaxBreakdown(
      [
        { net: 1000, taxCodeId: "vat", flatRatePct: null },
        { net: 1000, taxCodeId: "wht", flatRatePct: null },
      ],
      codes,
    );
    expect(b.netTotal).toBe(2000);
    expect(b.taxTotal).toBe(200); // VAT only, part of total
    expect(b.withholdingTotal).toBe(100); // WHT contra, not part of total
    expect(b.groups).toEqual([
      { label: "VAT20", tax: 200, accountCode: null, jurisdiction: null, withholding: false },
      { label: "WHT10", tax: 100, accountCode: "2155", jurisdiction: null, withholding: true },
    ]);
  });

  it("falls back to the flat rate when no code, labelled by rate", () => {
    const b = computeLineTaxBreakdown([{ net: 100, taxCodeId: null, flatRatePct: 10 }], new Map());
    expect(b.taxTotal).toBe(10);
    expect(b.withholdingTotal).toBe(0);
    expect(b.groups).toEqual([{ label: "10%", tax: 10, accountCode: null, jurisdiction: null, withholding: false }]);
  });

  it("ignores zero-rate lines", () => {
    const b = computeLineTaxBreakdown(
      [
        { net: 100, taxCodeId: null, flatRatePct: 0 },
        { net: 50, taxCodeId: null, flatRatePct: null },
      ],
      new Map(),
    );
    expect(b.netTotal).toBe(150);
    expect(b.taxTotal).toBe(0);
    expect(b.groups).toEqual([]);
  });
});

/**
 * Every fixture above uses a round net against a round rate, so every one of them is exact and
 * none of them moved when the minor-unit arithmetic landed. These are the boundary this function
 * is actually wrong at, and they are the whole fence over `lineTaxCents`.
 */
describe("computeLineTaxBreakdown — the half-cent boundary", () => {
  /**
   * Exact tax in cents by rational arithmetic over the operands' declared scales, independent of
   * the implementation's scaled-integer doubles: a genuinely different algorithm rather than a
   * re-derivation of the code under test (ADR-0362's retired truth table).
   */
  const exactCents = (netCents: number, rate: number): number => {
    const s = rate.toString();
    const dot = s.indexOf(".");
    const k = dot < 0 ? 0 : s.length - dot - 1;
    const num = BigInt(netCents) * BigInt(s.replace(".", ""));
    const den = 100n * 10n ** BigInt(k);
    return Number((2n * num + den) / (2n * den));
  };

  it("owes the cent up when the true tax is an exact half-cent", () => {
    // 0.70 × 5% = 0.035 exactly. Half-away-from-zero owes 0.04; the double form answered 0.03.
    const b = computeLineTaxBreakdown([{ net: 0.7, taxCodeId: null, flatRatePct: 5 }], new Map());
    expect(b.taxTotal).toBe(0.04);
    // 13.40 × 7.5% = 1.005 exactly -> 1.01, not 1.00.
    const c = computeLineTaxBreakdown([{ net: 13.4, taxCodeId: null, flatRatePct: 7.5 }], new Map());
    expect(c.taxTotal).toBe(1.01);
  });

  it("is exact over a declared-domain sweep, and never errs upward", () => {
    let divergent = 0;
    let over = 0;
    let pairs = 0;
    // decimal(6,3) rates an ERP carries, against nets spanning four magnitudes.
    for (const rate of [5, 7.5, 2.28, 0.175, 12.5, 19, 20]) {
      for (const netCents of [7, 70, 1250, 1340, 99999, 1000001, 123456789]) {
        pairs++;
        const want = exactCents(netCents, rate);
        const got = Math.round(
          computeLineTaxBreakdown([{ net: netCents / 100, taxCodeId: null, flatRatePct: rate }], new Map())
            .taxTotal * 100,
        );
        if (got !== want) {
          divergent++;
          if (got > want) over++;
        }
      }
    }
    expect(pairs).toBe(49);
    expect(divergent).toBe(0);
    expect(over).toBe(0);
  });

  it("keeps a rate it cannot scale faithfully rather than truncating it", () => {
    // No declared field can produce a 4th decimal, but truncating one is not the safe failure:
    // 1234.56 @ 0.0625% truncated to 0.063% answers 0.78 where the exact figure is 0.77 — wrong,
    // and in the over direction. The fallback keeps the rate the caller stated.
    const b = computeLineTaxBreakdown([{ net: 1234.56, taxCodeId: null, flatRatePct: 0.0625 }], new Map());
    expect(b.taxTotal).toBe(0.77);
    expect(b.taxTotal).not.toBe(0.78);
  });

  it("multiplies the per-line cent across a document", () => {
    // The per-line rounding is the whole of the live defect, and a document is where it becomes
    // visible as money: 100 lines of 0.70 at 5% each owe a cent up, so the old form's 0.03 a line
    // reported 3.00 against an exact 4.00 — a quarter of the tax on the document, not a rounding
    // crumb. (The *accumulation* half of this change is belt-and-braces rather than a fix:
    // measured, summing 2-dp doubles and rounding once first disagrees with an integer sum at
    // 10^6 lines of ~1000 units, which no document reaches.)
    const lines = Array.from({ length: 100 }, () => ({ net: 0.7, taxCodeId: null, flatRatePct: 5 }));
    const b = computeLineTaxBreakdown(lines, new Map());
    expect(b.netTotal).toBe(70);
    expect(b.taxTotal).toBe(4);
  });

  it("moves the control line and the stamped withholding figure, not just a tax line", () => {
    // Withholding is deliberately NOT part of taxTotal, so a withholding line passes the
    // recognition effect's reconciliation gate and the cent lands unmitigated on the AR control
    // amount (total − withholdingTotal) and on the document's stamped withholding_total, which a
    // WHT certificate's amount is prefilled from. 0.70 @ 5% withholding: 0.04, so AR is 0.66.
    const codes = new Map([["wht", { rate: 5, label: "WHT5", accountCode: "2155", withholding: true }]]);
    const b = computeLineTaxBreakdown([{ net: 0.7, taxCodeId: "wht", flatRatePct: null }], codes);
    expect(b.withholdingTotal).toBe(0.04);
    expect(b.taxTotal).toBe(0);
    // In minor units, and deliberately: `0.7 - 0.04` is 0.6599999999999999, which is the drift this
    // increment is about one subtraction further on — the control amount is computed in major units
    // at the posting site, so pinning the cents here says what the breakdown owes without asserting
    // a double comparison that is false for a reason this function cannot fix.
    expect(Math.round(b.netTotal * 100) - Math.round(b.withholdingTotal * 100)).toBe(66);
    expect(b.netTotal - b.withholdingTotal).not.toBe(0.66);
  });
});

describe("recognitionGlPostingEffect — per-TaxCode GL account", () => {
  const invoiceRec = recognitionGlPostingEffect({
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
    taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total" },
    clock,
  });
  const issue = (store: InMemoryEntityStore, id: string, before: Record<string, unknown>) =>
    invoiceRec({ operation: "transition", entity: "Invoice", tenantId: TENANT, id, before, after: { ...before, state: "sent" }, store });

  it("posts a code's tax line to its own GL account, others to the default", async () => {
    const store = new InMemoryEntityStore();
    // The output-VAT code carries its own liability account; the reduced code doesn't.
    await store.create(TENANT, "LedgerAccount", { id: "acc_vat_out", account_code: "2150" });
    await store.create(TENANT, "TaxCode", { id: "std", code: "VAT20", rate_pct: 20, gl_account_code: "2150" });
    await store.create(TENANT, "TaxCode", { id: "red", code: "VAT5", rate_pct: 5 });
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-PA", state: "draft", document_type: "invoice", subtotal: 400, tax_total: 65, total: 465 });
    const invId = String(inv.id);
    await store.create(TENANT, "InvoiceLine", { invoice_id: invId, line_total: 300, tax_code_id: "std" });
    await store.create(TENANT, "InvoiceLine", { invoice_id: invId, line_total: 100, tax_code_id: "red" });

    await issue(store, invId, inv);
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    // VAT20 → its own account; VAT5 → the default tax_payable.
    const vat20 = lines.find((l) => l.description === "Tax payable (VAT20)")!;
    const vat5 = lines.find((l) => l.description === "Tax payable (VAT5)")!;
    expect(vat20.ledger_account_id).toBe("acc_vat_out");
    expect(vat20.credit).toBe(60);
    expect(vat5.ledger_account_id).toBe("tax_payable");
    expect(vat5.credit).toBe(5);
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(lines.reduce((s, l) => s + Number(l.credit), 0));
  });

  it("uses the per-jurisdiction default account when the code has no own account", async () => {
    const jurisRec = recognitionGlPostingEffect({
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
      taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total" },
      resolveJurisdictionAccounts: async () => ({ UK: "2201", DE: "2202" }),
      clock,
    });
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "LedgerAccount", { id: "acc_uk", account_code: "2201" });
    // A UK-jurisdiction code with no gl_account_code → posts to the UK default (2201).
    await store.create(TENANT, "TaxCode", { id: "ukvat", code: "UKVAT", rate_pct: 20, jurisdiction: "UK" });
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-J", state: "draft", document_type: "invoice", subtotal: 100, tax_total: 20, total: 120 });
    const invId = String(inv.id);
    await store.create(TENANT, "InvoiceLine", { invoice_id: invId, line_total: 100, tax_code_id: "ukvat" });
    await jurisRec({ operation: "transition", entity: "Invoice", tenantId: TENANT, id: invId, before: inv, after: { ...inv, state: "sent" }, store });
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.find((l) => l.description === "Tax payable (UKVAT)")!.ledger_account_id).toBe("acc_uk");
  });

  it("prefers the code's own gl_account_code over the per-jurisdiction default", async () => {
    const jurisRec = recognitionGlPostingEffect({
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
      taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total" },
      resolveJurisdictionAccounts: async () => ({ UK: "2201" }),
      clock,
    });
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "LedgerAccount", { id: "acc_uk", account_code: "2201" });
    await store.create(TENANT, "LedgerAccount", { id: "acc_own", account_code: "2250" });
    await store.create(TENANT, "TaxCode", { id: "ukvat", code: "UKVAT", rate_pct: 20, jurisdiction: "UK", gl_account_code: "2250" });
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-JO", state: "draft", document_type: "invoice", subtotal: 100, tax_total: 20, total: 120 });
    const invId = String(inv.id);
    await store.create(TENANT, "InvoiceLine", { invoice_id: invId, line_total: 100, tax_code_id: "ukvat" });
    await jurisRec({ operation: "transition", entity: "Invoice", tenantId: TENANT, id: invId, before: inv, after: { ...inv, state: "sent" }, store });
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.find((l) => l.description === "Tax payable (UKVAT)")!.ledger_account_id).toBe("acc_own");
  });

  it("falls back to the default tax account when the code's gl_account_code doesn't resolve", async () => {
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "TaxCode", { id: "std", code: "VAT20", rate_pct: 20, gl_account_code: "9999" });
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-PB", state: "draft", document_type: "invoice", subtotal: 100, tax_total: 20, total: 120 });
    const invId = String(inv.id);
    await store.create(TENANT, "InvoiceLine", { invoice_id: invId, line_total: 100, tax_code_id: "std" });
    await issue(store, invId, inv);
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.find((l) => l.description === "Tax payable (VAT20)")!.ledger_account_id).toBe("tax_payable");
  });

  it("withholds from AR as a control-side contra when a withholding code is applied", async () => {
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "LedgerAccount", { id: "acc_wht", account_code: "1450" });
    await store.create(TENANT, "TaxCode", { id: "wht", code: "WHT5", rate_pct: 5, kind: "withholding", gl_account_code: "1450" });
    // Net 1000, no VAT → total = 1000. WHT 5% = 50 withheld: AR 950 + WHT receivable 50.
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-W2", state: "draft", document_type: "invoice", subtotal: 1000, tax_total: 0, total: 1000 });
    const invId = String(inv.id);
    await store.create(TENANT, "InvoiceLine", { invoice_id: invId, line_total: 1000, tax_code_id: "wht" });
    await issue(store, invId, inv);
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.find((l) => l.ledger_account_id === "ar")!.debit).toBe(950);
    const wht = lines.find((l) => l.description === "Withholding (WHT5)")!;
    expect(wht.ledger_account_id).toBe("acc_wht");
    expect(wht.debit).toBe(50); // same side as the control (debit), a contra asset
    expect(lines.find((l) => l.ledger_account_id === "revenue")!.credit).toBe(1000);
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(lines.reduce((s, l) => s + Number(l.credit), 0));
  });

  it("stamps the withholding total onto the invoice when configured", async () => {
    const stampingRec = recognitionGlPostingEffect({
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
      taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total" },
      stampWithholdingField: "withholding_total",
      clock,
    });
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "TaxCode", { id: "wht", code: "WHT5", rate_pct: 5, kind: "withholding" });
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-WS", state: "draft", document_type: "invoice", subtotal: 1000, tax_total: 0, total: 1000 });
    const invId = String(inv.id);
    await store.create(TENANT, "InvoiceLine", { invoice_id: invId, line_total: 1000, tax_code_id: "wht" });
    await stampingRec({ operation: "transition", entity: "Invoice", tenantId: TENANT, id: invId, before: inv, after: { ...inv, state: "sent" }, store });
    const after = await store.get(TENANT, "Invoice", invId);
    expect(after?.withholding_total).toBe(50);
  });

  it("does not stamp withholding when there is none", async () => {
    const stampingRec = recognitionGlPostingEffect({
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
      taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total" },
      stampWithholdingField: "withholding_total",
      clock,
    });
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "TaxCode", { id: "vat", code: "VAT20", rate_pct: 20, kind: "vat" });
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-NS", state: "draft", document_type: "invoice", subtotal: 100, tax_total: 20, total: 120 });
    const invId = String(inv.id);
    await store.create(TENANT, "InvoiceLine", { invoice_id: invId, line_total: 100, tax_code_id: "vat" });
    await stampingRec({ operation: "transition", entity: "Invoice", tenantId: TENANT, id: invId, before: inv, after: { ...inv, state: "sent" }, store });
    const after = await store.get(TENANT, "Invoice", invId);
    expect(after?.withholding_total).toBeUndefined();
  });
});

describe("recognitionGlPostingEffect — line-level tax codes", () => {
  const invoiceRec = recognitionGlPostingEffect({
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
    taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total" },
    clock,
  });
  const issue = (store: InMemoryEntityStore, id: string, before: Record<string, unknown>) =>
    invoiceRec({ operation: "transition", entity: "Invoice", tenantId: TENANT, id, before, after: { ...before, state: "sent" }, store });

  it("posts one tax line per TaxCode from the invoice's lines", async () => {
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "TaxCode", { id: "std", code: "VAT20", rate_pct: 20 });
    await store.create(TENANT, "TaxCode", { id: "red", code: "VAT5", rate_pct: 5 });
    // 300 @ 20% = 60, 100 @ 5% = 5 → subtotal 400, tax 65, total 465
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-LT", state: "draft", document_type: "invoice", subtotal: 400, tax_total: 65, total: 465 });
    const invId = String(inv.id);
    await store.create(TENANT, "InvoiceLine", { invoice_id: invId, line_total: 300, tax_code_id: "std" });
    await store.create(TENANT, "InvoiceLine", { invoice_id: invId, line_total: 100, tax_code_id: "red" });

    await issue(store, invId, inv);
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.length).toBe(4); // AR + revenue + 2 tax lines
    expect(lines.find((l) => l.ledger_account_id === "ar")!.debit).toBe(465);
    expect(lines.find((l) => l.ledger_account_id === "revenue")!.credit).toBe(400);
    const taxLines = lines.filter((l) => l.ledger_account_id === "tax_payable");
    expect(taxLines.map((l) => l.description).sort()).toEqual(["Tax payable (VAT20)", "Tax payable (VAT5)"]);
    expect(taxLines.reduce((s, l) => s + Number(l.credit), 0)).toBe(65);
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(lines.reduce((s, l) => s + Number(l.credit), 0));
  });

  it("falls back to the document-level split when lines don't reconcile to total", async () => {
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "TaxCode", { id: "std", code: "VAT20", rate_pct: 20 });
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-MM", state: "draft", document_type: "invoice", subtotal: 100, tax_total: 20, total: 120 });
    const invId = String(inv.id);
    // A line that doesn't add up to the document total → use the document split.
    await store.create(TENANT, "InvoiceLine", { invoice_id: invId, line_total: 999, tax_code_id: "std" });
    await issue(store, invId, inv);
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.length).toBe(3);
    expect(lines.find((l) => l.ledger_account_id === "tax_payable")!.credit).toBe(20);
    expect(lines.find((l) => l.ledger_account_id === "tax_payable")!.description).toBe("Tax payable");
  });
});

describe("paymentSettlementGlPostingEffect (partial + FX)", () => {
  const effect = paymentSettlementGlPostingEffect({ clock });
  const complete = (store: InMemoryEntityStore, id: string, before: Record<string, unknown>) =>
    effect({ operation: "transition", entity: "Payment", tenantId: TENANT, id, before, after: { ...before, state: "completed" }, store });

  it("settles an inbound payment: debit cash, credit AR (partial amount)", async () => {
    const store = new InMemoryEntityStore();
    const pay = await store.create(TENANT, "Payment", { payment_number: "PAY-1", state: "pending", direction: "inbound", amount: 40 });
    await complete(store, String(pay.id), pay);
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.length).toBe(2);
    expect(lines.find((l) => l.ledger_account_id === "cash")!.debit).toBe(40);
    expect(lines.find((l) => l.ledger_account_id === "accounts_receivable")!.credit).toBe(40);
  });

  it("books a realized FX gain when cash received exceeds the AR cleared", async () => {
    const store = new InMemoryEntityStore();
    const pay = await store.create(TENANT, "Payment", { payment_number: "PAY-2", state: "pending", direction: "inbound", amount: 100, cash_amount: 105 });
    await complete(store, String(pay.id), pay);
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.find((l) => l.ledger_account_id === "cash")!.debit).toBe(105);
    expect(lines.find((l) => l.ledger_account_id === "accounts_receivable")!.credit).toBe(100);
    const fx = lines.find((l) => l.ledger_account_id === "fx_gain_loss")!;
    expect(fx.credit).toBe(5); // gain
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(lines.reduce((s, l) => s + Number(l.credit), 0));
  });

  it("books a realized FX loss when cash received is short of the AR cleared", async () => {
    const store = new InMemoryEntityStore();
    const pay = await store.create(TENANT, "Payment", { payment_number: "PAY-3", state: "pending", direction: "inbound", amount: 100, cash_amount: 95 });
    await complete(store, String(pay.id), pay);
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    const fx = lines.find((l) => l.ledger_account_id === "fx_gain_loss")!;
    expect(fx.debit).toBe(5); // loss
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(lines.reduce((s, l) => s + Number(l.credit), 0));
  });

  it("settles an outbound payment: debit AP, credit cash", async () => {
    const store = new InMemoryEntityStore();
    const pay = await store.create(TENANT, "Payment", { payment_number: "PAY-4", state: "pending", direction: "outbound", amount: 80 });
    await complete(store, String(pay.id), pay);
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.find((l) => l.ledger_account_id === "accounts_payable")!.debit).toBe(80);
    expect(lines.find((l) => l.ledger_account_id === "cash")!.credit).toBe(80);
  });

  it("does nothing unless the payment moves into completed", async () => {
    const store = new InMemoryEntityStore();
    const pay = await store.create(TENANT, "Payment", { state: "completed", direction: "inbound", amount: 10 });
    await complete(store, String(pay.id), pay);
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
  });
});

describe("paymentApplicationEffect", () => {
  const effect = paymentApplicationEffect({
    documentEntity: "Invoice",
    refField: "invoice_id",
    settleableStates: ["sent", "overdue"],
    clock,
  });
  async function setup() {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-A", state: "sent", total: 120 });
    return { store, invId: String(inv.id) };
  }
  const completePayment = async (store: InMemoryEntityStore, invId: string, amount: number) => {
    const pay = await store.create(TENANT, "Payment", { invoice_id: invId, direction: "inbound", amount, state: "completed" });
    return effect({ operation: "transition", entity: "Payment", tenantId: TENANT, id: String(pay.id), before: { state: "pending" }, after: { ...(await store.get(TENANT, "Payment", String(pay.id)))! }, store });
  };

  it("leaves the invoice unsettled while partial payments don't cover the total", async () => {
    const { store, invId } = await setup();
    await completePayment(store, invId, 60);
    expect((await store.get(TENANT, "Invoice", invId))!.state).toBe("sent");
  });

  it("auto-settles the invoice once accumulated payments cover the total", async () => {
    const { store, invId } = await setup();
    await completePayment(store, invId, 60);
    await completePayment(store, invId, 60); // now 120 == total
    const inv = (await store.get(TENANT, "Invoice", invId))!;
    expect(inv.state).toBe("paid");
    expect(typeof inv.paid_at).toBe("string");
  });

  it("does not settle a document in a non-settleable state", async () => {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { state: "draft", total: 50 });
    await completePayment(store, String(inv.id), 50);
    expect((await store.get(TENANT, "Invoice", String(inv.id)))!.state).toBe("draft");
  });

  it("ignores a payment with no document link", async () => {
    const store = new InMemoryEntityStore();
    const pay = await store.create(TENANT, "Payment", { direction: "inbound", amount: 10, state: "completed" });
    await effect({ operation: "transition", entity: "Payment", tenantId: TENANT, id: String(pay.id), before: { state: "pending" }, after: { ...pay }, store });
    // no throw, nothing to settle
    expect((await store.list(TENANT, "Invoice")).length).toBe(0);
  });
});

describe("unrealizedFxRevaluationEffect", () => {
  const effect = unrealizedFxRevaluationEffect({ functionalCurrency: "USD", clock });

  async function fxStore() {
    const store = new InMemoryEntityStore();
    const usd = await store.create(TENANT, "Currency", { code: "USD", name: "US Dollar" });
    const eur = await store.create(TENANT, "Currency", { code: "EUR", name: "Euro" });
    return { store, usdId: String(usd.id), eurId: String(eur.id) };
  }

  function closeInput(store: InMemoryEntityStore, id: string, extra: Record<string, unknown> = {}): WriteEffectInput {
    return {
      operation: "transition",
      entity: "FiscalPeriod",
      tenantId: TENANT,
      id,
      before: { status: "closing", end_date: "2026-06-30", name: "2026-06" },
      after: { status: "closed", end_date: "2026-06-30", name: "2026-06", ...extra },
      store,
    };
  }

  it("does nothing unless a period moves into closed", async () => {
    const { store } = await fxStore();
    const period = await store.create(TENANT, "FiscalPeriod", { status: "open", end_date: "2026-06-30", name: "2026-06" });
    await effect({
      operation: "transition",
      entity: "FiscalPeriod",
      tenantId: TENANT,
      id: String(period.id),
      before: { status: "open" },
      after: { status: "closing", end_date: "2026-06-30", name: "2026-06" },
      store,
    });
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
  });

  it("posts a balanced FXREVAL entry for an open foreign-currency invoice (rate > 1)", async () => {
    const { store, usdId, eurId } = await fxStore();
    await store.create(TENANT, "ExchangeRate", { from_currency_id: eurId, to_currency_id: usdId, rate: 1.1, rate_date: "2026-06-29" });
    await store.create(TENANT, "Invoice", { invoice_number: "INV-1", state: "sent", total: 1000, currency: "EUR" });
    const period = await store.create(TENANT, "FiscalPeriod", { status: "closing", end_date: "2026-06-30", name: "2026-06" });

    await effect(closeInput(store, String(period.id)));

    const entries = await store.list(TENANT, "JournalEntry");
    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    expect(entry.entry_number).toBe("2026-06-FXREVAL");
    expect(entry.state).toBe("posted");
    expect(entry.source).toBe("fx_revaluation");
    expect(entry.entry_date).toBe("2026-06-30");

    const lines = await store.list(TENANT, "JournalLine");
    expect(lines.length).toBe(2);
    const totalDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 6);
    // AR gain (rate 1.1 → +100): debit AR, credit unrealized FX.
    const arLine = lines.find((l) => Number(l.debit) > 0)!;
    expect(Number(arLine.debit)).toBeCloseTo(100, 6);
  });

  it("uses the latest rate on/before the period end date", async () => {
    const { store, usdId, eurId } = await fxStore();
    await store.create(TENANT, "ExchangeRate", { from_currency_id: eurId, to_currency_id: usdId, rate: 1.1, rate_date: "2026-05-01" });
    await store.create(TENANT, "ExchangeRate", { from_currency_id: eurId, to_currency_id: usdId, rate: 1.2, rate_date: "2026-06-29" });
    // A later rate after the period end must be ignored.
    await store.create(TENANT, "ExchangeRate", { from_currency_id: eurId, to_currency_id: usdId, rate: 2.0, rate_date: "2026-07-15" });
    await store.create(TENANT, "Invoice", { invoice_number: "INV-1", state: "sent", total: 1000, currency: "EUR" });
    const period = await store.create(TENANT, "FiscalPeriod", { status: "closing", end_date: "2026-06-30", name: "2026-06" });

    await effect(closeInput(store, String(period.id)));
    const arLine = (await store.list(TENANT, "JournalLine")).find((l) => Number(l.debit) > 0)!;
    expect(Number(arLine.debit)).toBeCloseTo(200, 6); // 1000 × (1.2 − 1)
  });

  it("posts no entry when there are no foreign-currency documents", async () => {
    const { store, usdId, eurId } = await fxStore();
    await store.create(TENANT, "ExchangeRate", { from_currency_id: eurId, to_currency_id: usdId, rate: 1.1, rate_date: "2026-06-29" });
    await store.create(TENANT, "Invoice", { invoice_number: "INV-1", state: "sent", total: 1000, currency: "USD" });
    const period = await store.create(TENANT, "FiscalPeriod", { status: "closing", end_date: "2026-06-30", name: "2026-06" });

    await effect(closeInput(store, String(period.id)));
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
  });

  it("skips a currency with no eligible period-end rate (no entry)", async () => {
    const { store } = await fxStore();
    // No ExchangeRate rows at all → the EUR balance cannot be revalued.
    await store.create(TENANT, "Invoice", { invoice_number: "INV-1", state: "sent", total: 1000, currency: "EUR" });
    const period = await store.create(TENANT, "FiscalPeriod", { status: "closing", end_date: "2026-06-30", name: "2026-06" });

    await effect(closeInput(store, String(period.id)));
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
  });

  it("nets open balance against completed payments before revaluing", async () => {
    const { store, usdId, eurId } = await fxStore();
    await store.create(TENANT, "ExchangeRate", { from_currency_id: eurId, to_currency_id: usdId, rate: 1.1, rate_date: "2026-06-29" });
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-1", state: "sent", total: 1000, currency: "EUR" });
    await store.create(TENANT, "Payment", { invoice_id: String(inv.id), amount: 400, state: "completed" });
    const period = await store.create(TENANT, "FiscalPeriod", { status: "closing", end_date: "2026-06-30", name: "2026-06" });

    await effect(closeInput(store, String(period.id)));
    const arLine = (await store.list(TENANT, "JournalLine")).find((l) => Number(l.debit) > 0)!;
    expect(Number(arLine.debit)).toBeCloseTo(60, 6); // open 600 × (1.1 − 1)
  });

  it("mirrors AP: a higher rate raises a foreign payable → loss → debit unrealized FX, credit AP", async () => {
    const { store, usdId, eurId } = await fxStore();
    await store.create(TENANT, "ExchangeRate", { from_currency_id: eurId, to_currency_id: usdId, rate: 1.1, rate_date: "2026-06-29" });
    await store.create(TENANT, "Bill", { bill_number: "BILL-1", state: "approved", total: 1000, currency: "EUR" });
    const period = await store.create(TENANT, "FiscalPeriod", { status: "closing", end_date: "2026-06-30", name: "2026-06" });

    await effect(closeInput(store, String(period.id)));
    const lines = await store.list(TENANT, "JournalLine");
    expect(lines.length).toBe(2);
    const totalDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 6);
    // AP control credited (liability grows), unrealized FX debited (loss).
    const apLine = lines.find((l) => l.description === "Unrealized FX revaluation — AP EUR")!;
    expect(Number(apLine.credit)).toBeCloseTo(100, 6);
    const fxLine = lines.find((l) => l.description === "Unrealized FX gain/loss — EUR")!;
    expect(Number(fxLine.debit)).toBeCloseTo(100, 6);
  });
});

describe("unrealizedFxRevaluationEffect — booking rate", () => {
  const effect = unrealizedFxRevaluationEffect({ functionalCurrency: "USD", clock });

  async function fxStore() {
    const store = new InMemoryEntityStore();
    const usd = await store.create(TENANT, "Currency", { code: "USD", name: "US Dollar" });
    const eur = await store.create(TENANT, "Currency", { code: "EUR", name: "Euro" });
    return { store, usdId: String(usd.id), eurId: String(eur.id) };
  }
  const close = (store: InMemoryEntityStore, id: string): WriteEffectInput => ({
    operation: "transition",
    entity: "FiscalPeriod",
    tenantId: TENANT,
    id,
    before: { status: "closing" },
    after: { status: "closed", end_date: "2026-06-30", name: "2026-06" },
    store,
  });

  it("revalues against the document's booking_rate, not a flat 1", async () => {
    const { store, usdId, eurId } = await fxStore();
    await store.create(TENANT, "ExchangeRate", { from_currency_id: eurId, to_currency_id: usdId, rate: 1.2, rate_date: "2026-06-29" });
    // Booked at 1.1; period-end 1.2 → delta = 1000 × (1.2 − 1.1) = 100 (not 200).
    await store.create(TENANT, "Invoice", { invoice_number: "INV-1", state: "sent", total: 1000, currency: "EUR", booking_rate: 1.1 });
    const period = await store.create(TENANT, "FiscalPeriod", { status: "closing", end_date: "2026-06-30", name: "2026-06" });
    await effect(close(store, String(period.id)));
    const arLine = (await store.list(TENANT, "JournalLine")).find((l) => Number(l.debit) > 0)!;
    expect(Number(arLine.debit)).toBeCloseTo(100, 6);
  });

  it("posts no entry when the period-end rate equals the booking rate (no movement)", async () => {
    const { store, usdId, eurId } = await fxStore();
    await store.create(TENANT, "ExchangeRate", { from_currency_id: eurId, to_currency_id: usdId, rate: 1.1, rate_date: "2026-06-29" });
    await store.create(TENANT, "Invoice", { invoice_number: "INV-1", state: "sent", total: 1000, currency: "EUR", booking_rate: 1.1 });
    const period = await store.create(TENANT, "FiscalPeriod", { status: "closing", end_date: "2026-06-30", name: "2026-06" });
    await effect(close(store, String(period.id)));
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
  });
});

describe("bookingRateStampEffect", () => {
  const effect = bookingRateStampEffect({ entity: "Invoice", triggerState: "sent", dateField: "issue_date", functionalCurrency: "USD", clock });

  async function store() {
    const s = new InMemoryEntityStore();
    const usd = await s.create(TENANT, "Currency", { code: "USD", name: "USD" });
    const eur = await s.create(TENANT, "Currency", { code: "EUR", name: "EUR" });
    await s.create(TENANT, "ExchangeRate", { from_currency_id: String(eur.id), to_currency_id: String(usd.id), rate: 1.15, rate_date: "2026-05-20" });
    await s.create(TENANT, "ExchangeRate", { from_currency_id: String(eur.id), to_currency_id: String(usd.id), rate: 1.25, rate_date: "2026-07-01" });
    return s;
  }
  const issue = (s: InMemoryEntityStore, id: string, before: Record<string, unknown>): WriteEffectInput =>
    ({ operation: "transition", entity: "Invoice", tenantId: TENANT, id, before, after: { ...before, state: "sent" }, store: s });

  it("stamps the latest rate on/before the issue date for a foreign invoice", async () => {
    const s = await store();
    const inv = await s.create(TENANT, "Invoice", { invoice_number: "INV-1", state: "draft", currency: "EUR", issue_date: "2026-06-01", total: 100 });
    await effect(issue(s, String(inv.id), { invoice_number: "INV-1", state: "draft", currency: "EUR", issue_date: "2026-06-01", total: 100 }));
    expect(Number((await s.get(TENANT, "Invoice", String(inv.id)))!.booking_rate)).toBeCloseTo(1.15, 6); // not the 2026-07 rate
  });

  it("leaves a functional-currency invoice unstamped", async () => {
    const s = await store();
    const inv = await s.create(TENANT, "Invoice", { invoice_number: "INV-2", state: "draft", currency: "USD", issue_date: "2026-06-01", total: 100 });
    await effect(issue(s, String(inv.id), { invoice_number: "INV-2", state: "draft", currency: "USD", issue_date: "2026-06-01", total: 100 }));
    expect((await s.get(TENANT, "Invoice", String(inv.id)))!.booking_rate).toBeUndefined();
  });
});

describe("runWriteEffects", () => {
  it("runs effects in order and propagates a throw", async () => {
    const calls: string[] = [];
    const ok = async () => {
      calls.push("ok");
    };
    const boom = async () => {
      throw new Error("boom");
    };
    await expect(runWriteEffects([ok, boom], {} as WriteEffectInput)).rejects.toThrow("boom");
    expect(calls).toEqual(["ok"]);
  });
});

describe("whtCertificateClearingEffect", () => {
  const effect = whtCertificateClearingEffect({
    resolveAccountCodes: async () => ({ whtReceivable: "1450", taxRecoverable: "1460" }),
    clock,
  });
  const confirm = (store: InMemoryEntityStore, id: string, before: Record<string, unknown>) =>
    effect({ operation: "transition", entity: "WhtCertificate", tenantId: TENANT, id, before, after: { ...before, state: "confirmed" }, store });

  async function setup() {
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "LedgerAccount", { id: "acc_wht", account_code: "1450" });
    await store.create(TENANT, "LedgerAccount", { id: "acc_rec", account_code: "1460" });
    const cert = await store.create(TENANT, "WhtCertificate", { certificate_number: "WHT-1", state: "draft", amount: 50, currency: "USD" });
    return { store, cert };
  }

  it("reclasses the withheld tax: debit recoverable, credit WHT receivable", async () => {
    const { store, cert } = await setup();
    await confirm(store, String(cert.id), cert);
    const entry = (await store.list(TENANT, "JournalEntry")).find((e) => e.entry_number === "WHT-1-WHT")!;
    expect(entry.state).toBe("posted");
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.length).toBe(2);
    expect(lines.find((l) => l.ledger_account_id === "acc_rec")!.debit).toBe(50);
    expect(lines.find((l) => l.ledger_account_id === "acc_wht")!.credit).toBe(50);
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(lines.reduce((s, l) => s + Number(l.credit), 0));
  });

  it("fires only on the →confirmed edge, once", async () => {
    const { store, cert } = await setup();
    // A non-confirming update does nothing.
    await effect({ operation: "update", entity: "WhtCertificate", tenantId: TENANT, id: String(cert.id), before: cert, after: { ...cert, certificate_ref: "X" }, store });
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
    // Confirm posts once; re-confirming (already confirmed) does not double-post.
    await confirm(store, String(cert.id), cert);
    const confirmed = { ...cert, state: "confirmed" };
    await effect({ operation: "update", entity: "WhtCertificate", tenantId: TENANT, id: String(cert.id), before: confirmed, after: { ...confirmed, certificate_ref: "Y" }, store });
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(1);
  });

  it("skips a zero-amount certificate", async () => {
    const store = new InMemoryEntityStore();
    const cert = await store.create(TENANT, "WhtCertificate", { certificate_number: "WHT-0", state: "draft", amount: 0, currency: "USD" });
    await confirm(store, String(cert.id), cert);
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
  });
});

// A `decimal` field crosses the store as its canonical wire string. Three effect sites used to
// ask `typeof v === "number"`, which answered false for every amount the typed store served —
// so these are regressions against a wrong *posting*, not against a wrong type.
describe("amounts that arrive as wire decimals", () => {
  const credit = invoiceVoidCreditNoteEffect({ clock });
  const creditGl = creditNoteGlPostingEffect({ clock });

  const voidIt = (
    store: InMemoryEntityStore,
    id: string,
    before: Record<string, unknown>,
  ): WriteEffectInput => ({
    operation: "transition",
    entity: "Invoice",
    tenantId: TENANT,
    id,
    before,
    after: { ...before, state: "void" },
    store,
  });

  async function issuedWithStringCreditAmount(): Promise<{
    store: InMemoryEntityStore;
    id: string;
    inv: Record<string, unknown>;
  }> {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", {
      invoice_number: "INV-WIRE-1",
      state: "sent",
      document_type: "invoice",
      currency: "EUR",
      subtotal: "100.00",
      tax_total: "5.00",
      total: "105.00",
      credit_amount: "40.00",
    });
    return { store, id: String(inv.id), inv };
  }

  it("issues a PARTIAL credit note for a string credit_amount (was silently crediting the full total)", async () => {
    const { store, id, inv } = await issuedWithStringCreditAmount();
    await credit(voidIt(store, id, inv));
    const cn = (await store.list(TENANT, "Invoice")).find((i) => i.document_type === "credit_note")!;
    // Asserted through `Number` deliberately: an effect still *computes* in doubles and writes
    // whatever it computed, and the partial branch writes a number where the full branch copies
    // the source string. The store boundary is what makes the stored value canonical, so these
    // tests run against a bare store and see the effect's own output.
    expect(Number(cn.total)).toBe(40);
    expect(cn.notes).toBe("Partial credit note for INV-WIRE-1");
  });

  it("posts the GL entry for the string partial amount, not the full total", async () => {
    const { store, id, inv } = await issuedWithStringCreditAmount();
    await creditGl(voidIt(store, id, inv));
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(40);
    expect(lines.reduce((s, l) => s + Number(l.credit), 0)).toBe(40);
  });

  it("still credits the full total when the string credit_amount is at or above it", async () => {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", {
      invoice_number: "INV-WIRE-2",
      state: "sent",
      document_type: "invoice",
      total: "105.00",
      credit_amount: "999.00",
    });
    await credit(voidIt(store, String(inv.id), inv));
    const cn = (await store.list(TENANT, "Invoice")).find((i) => i.document_type === "credit_note")!;
    expect(Number(cn.total)).toBe(105);
    expect(cn.notes).toBe("Credit note for INV-WIRE-2");
  });

  it("honours a line's flat tax rate given as a wire decimal (was read as 'no flat rate')", async () => {
    const effect = recognitionGlPostingEffect({
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
      taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total" },
      clock,
    });
    const store = new InMemoryEntityStore();
    // No tax code; the split can only come from the line's own flat rate: 200 @ 10% = 20.
    const inv = await store.create(TENANT, "Invoice", {
      invoice_number: "INV-WIRE-3",
      state: "draft",
      document_type: "invoice",
      subtotal: "200.00",
      tax_total: "20.00",
      total: "220.00",
    });
    const invId = String(inv.id);
    await store.create(TENANT, "InvoiceLine", {
      invoice_id: invId,
      line_total: "200.00",
      tax_rate_pct: "10.000",
    });
    await effect({
      operation: "transition",
      entity: "Invoice",
      tenantId: TENANT,
      id: invId,
      before: inv,
      after: { ...inv, state: "sent" },
      store,
    });
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.find((l) => l.ledger_account_id === "revenue")!.credit).toBe(200);
    expect(
      lines.filter((l) => l.ledger_account_id === "tax_payable").reduce((s, l) => s + Number(l.credit), 0),
    ).toBe(20);
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(
      lines.reduce((s, l) => s + Number(l.credit), 0),
    );
  });
});

/**
 * A store whose pages hold at most `size` rows however many were asked for — a legal short page
 * carrying a cursor, which is what makes a drain genuinely page over a small fixture. It cannot
 * shorten a walk: the drain's termination is `nextCursor === null` and nothing else.
 */
/**
 * Runs `fn` and hands back the refusal it rejected with, narrowed by `isReadCeilingExceeded`
 * rather than by an assertion — a cast here would be a type annotation standing in for the check
 * the assertions below are about, and resolving at all is itself the failure.
 */
async function refusalFrom(fn: () => Promise<void>): Promise<ReadCeilingExceeded> {
  try {
    await fn();
  } catch (err) {
    if (isReadCeilingExceeded(err)) return err;
    throw err;
  }
  throw new Error("expected a ReadCeilingExceeded; the effect resolved");
}

function pagedAt(inner: InMemoryEntityStore, size: number): EntityStore {
  return {
    listPage: (t, e, q) => inner.listPage(t, e, { ...q, limit: Math.min(q.limit, size) }),
    get: (t, e, id) => inner.get(t, e, id),
    create: (t, e, r) => inner.create(t, e, r),
    update: (t, e, id, patch) => inner.update(t, e, id, patch),
    remove: (t, e, id) => inner.remove(t, e, id),
    list: (t, e) => inner.list(t, e),
  };
}

describe("journalReversalEffect — the whole line set", () => {
  async function fiveLineEntry() {
    const store = new InMemoryEntityStore();
    const entry = await store.create(TENANT, "JournalEntry", { entry_number: "JE-BIG", state: "posted" });
    const id = String(entry.id);
    for (const debit of [10, 10, 10]) {
      await store.create(TENANT, "JournalLine", { journal_entry_id: id, ledger_account_id: "cash", debit, credit: 0 });
    }
    for (const credit of [15, 15]) {
      await store.create(TENANT, "JournalLine", { journal_entry_id: id, ledger_account_id: "revenue", debit: 0, credit });
    }
    return { store, id, entry };
  }
  const reverse = (store: EntityStore, id: string, before: Record<string, unknown>): WriteEffectInput => ({
    operation: "transition",
    entity: "JournalEntry",
    tenantId: TENANT,
    id,
    before,
    after: { ...before, state: "reversed" },
    store,
  });

  it("mirrors every line across a multi-page read, so the reversal balances", async () => {
    const { store, id, entry } = await fiveLineEntry();
    await journalReversalEffect({ clock })(reverse(pagedAt(store, 2), id, entry));
    const rev = (await store.list(TENANT, "JournalEntry")).find((e) => e.entry_number === "JE-BIG-REV")!;
    const revLines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === rev.id);
    expect(revLines.length).toBe(5);
    expect(revLines.reduce((s, l) => s + Number(l.debit), 0)).toBe(30);
    expect(revLines.reduce((s, l) => s + Number(l.credit), 0)).toBe(30);
  });

  it("refuses rather than posting an unbalanced mirror when the line ceiling is reached", async () => {
    const { store, id, entry } = await fiveLineEntry();
    await expect(journalReversalEffect({ clock, maxLines: 3 })(reverse(store, id, entry))).rejects.toThrow(
      ReadCeilingExceeded,
    );
    // **Nothing at all was written — the reversal entry included.** The header's `create` sits below
    // the drain for exactly this: `writeTxn` falls through to `body(ctx.store)` on a store that is
    // not transactional, so a refusal there rolls nothing back, and a header written first would
    // leave a second posted entry with no lines behind every refusal (and a third on retry).
    expect((await store.list(TENANT, "JournalEntry")).some((e) => e.entry_number === "JE-BIG-REV")).toBe(false);
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(1);
    expect((await store.list(TENANT, "JournalLine")).length).toBe(5);
  });

  it("names the entity, the ceiling and what it could not compute", async () => {
    const { store, id, entry } = await fiveLineEntry();
    const err = await refusalFrom(() => journalReversalEffect({ clock, maxLines: 3 })(reverse(store, id, entry)));
    expect(err.entity).toBe("JournalLine");
    expect(err.ceiling).toBe(3);
    // A literal, never the document number it used to interpolate: `writeTxn` puts this string in a
    // 500 body on the stated premise that the refusal carries no value read from a record.
    expect(err.computing).toBe("a journal reversal");
  });
});

describe("invoiceVoidCreditNoteEffect — the whole line set", () => {
  async function fourLineInvoice() {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", {
      invoice_number: "INV-BIG",
      state: "sent",
      document_type: "invoice",
      subtotal: 400,
      tax_total: 0,
      total: 400,
    });
    const id = String(inv.id);
    for (let i = 0; i < 4; i += 1) {
      await store.create(TENANT, "InvoiceLine", {
        invoice_id: id,
        position: i + 1,
        description: `L${String(i)}`,
        quantity: 1,
        unit_price: 100,
        line_total: 100,
      });
    }
    return { store, id, inv };
  }
  const voidIt = (store: EntityStore, id: string, before: Record<string, unknown>): WriteEffectInput => ({
    operation: "transition",
    entity: "Invoice",
    tenantId: TENANT,
    id,
    before,
    after: { ...before, state: "void" },
    store,
  });

  it("copies every line across a multi-page read, so the header total equals the sum of lines", async () => {
    const { store, id, inv } = await fourLineInvoice();
    await invoiceVoidCreditNoteEffect({ lineEntity: "InvoiceLine", clock })(voidIt(pagedAt(store, 2), id, inv));
    const cn = (await store.list(TENANT, "Invoice")).find((r) => r.document_type === "credit_note")!;
    const cnLines = (await store.list(TENANT, "InvoiceLine")).filter((l) => l.invoice_id === cn.id);
    expect(cnLines.length).toBe(4);
    expect(cnLines.reduce((s, l) => s + Number(l.line_total), 0)).toBe(Number(cn.total));
  });

  it("refuses rather than issuing a credit note whose lines do not add up to its total", async () => {
    const { store, id, inv } = await fourLineInvoice();
    await expect(
      invoiceVoidCreditNoteEffect({ lineEntity: "InvoiceLine", clock, maxLines: 2 })(voidIt(store, id, inv)),
    ).rejects.toThrow(ReadCeilingExceeded);
    // No credit note either: the header is written below the drain, so a refusal leaves the voided
    // invoice alone rather than leaving a credit note the customer could be sent.
    expect((await store.list(TENANT, "Invoice")).some((r) => r.document_type === "credit_note")).toBe(false);
    expect((await store.list(TENANT, "InvoiceLine")).length).toBe(4);
  });
});

describe("recognitionGlPostingEffect — the whole line set (withholding past the gate)", () => {
  /**
   * The reconciliation gate covers `netTotal + taxTotal` and NOT `withholdingTotal`, so a dropped
   * tail that nets to ~0 passes it and applies a truncated withholding — to the control line, the
   * WHT line and the document stamp, all of which balance. The fixture is exactly that shape: a
   * first line carrying 40 of withholding on net 400, then a tail of +1000 withholding-coded and
   * −1000 untaxed that nets to 0 and carries another 100.
   */
  async function withholdingInvoice() {
    const store = new InMemoryEntityStore();
    const wht = await store.create(TENANT, "TaxCode", { code: "WHT10", rate_pct: 10, kind: "withholding" });
    const inv = await store.create(TENANT, "Invoice", {
      invoice_number: "INV-WHT",
      state: "draft",
      document_type: "invoice",
      subtotal: 400,
      tax_total: 0,
      total: 400,
    });
    const id = String(inv.id);
    await store.create(TENANT, "InvoiceLine", { invoice_id: id, position: 1, line_total: 400, tax_code_id: String(wht.id) });
    await store.create(TENANT, "InvoiceLine", { invoice_id: id, position: 2, line_total: 1000, tax_code_id: String(wht.id) });
    await store.create(TENANT, "InvoiceLine", { invoice_id: id, position: 3, line_total: -1000 });
    return { store, id, inv };
  }
  const recognize = (maxRows?: number) =>
    recognitionGlPostingEffect({
      entity: "Invoice",
      triggerState: "sent",
      numberField: "invoice_number",
      controlSide: "debit",
      controlAccountRef: "ar",
      netAccountRef: "revenue",
      taxAccountRef: "tax",
      controlDescription: "AR",
      netDescription: "Revenue",
      taxDescription: "Tax",
      taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total", ...(maxRows === undefined ? {} : { maxRows }) },
      stampWithholdingField: "withholding_total",
      clock,
    });
  const issue = (store: EntityStore, id: string, before: Record<string, unknown>): WriteEffectInput => ({
    operation: "transition",
    entity: "Invoice",
    tenantId: TENANT,
    id,
    before,
    after: { ...before, state: "sent" },
    store,
  });

  it("withholds the whole set's 140 across a multi-page read, not the first page's 40", async () => {
    const { store, id, inv } = await withholdingInvoice();
    await recognize()(issue(pagedAt(store, 1), id, inv));
    const lines = await store.list(TENANT, "JournalLine");
    expect(Number(lines.find((l) => l.ledger_account_id === "ar")!.debit)).toBeCloseTo(260, 6);
    expect(Number(lines.find((l) => l.ledger_account_id === "revenue")!.credit)).toBeCloseTo(400, 6);
    expect(
      lines.filter((l) => String(l.description ?? "").startsWith("Withholding")).reduce((s, l) => s + Number(l.debit), 0),
    ).toBeCloseTo(140, 6);
    expect(Number((await store.get(TENANT, "Invoice", id))!.withholding_total)).toBeCloseTo(140, 6);
  });

  it("refuses rather than posting a balanced entry built from a truncated withholding", async () => {
    const { store, id, inv } = await withholdingInvoice();
    await expect(recognize(1)(issue(store, id, inv))).rejects.toThrow(ReadCeilingExceeded);
    // The read precedes every write in this effect, so the refusal writes nothing at all.
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
    expect((await store.get(TENANT, "Invoice", id))!.withholding_total).toBeUndefined();
  });
});

describe("paymentApplicationEffect — the whole payment set", () => {
  const apply = (maxPayments?: number) =>
    paymentApplicationEffect({
      documentEntity: "Invoice",
      refField: "invoice_id",
      settleableStates: ["sent", "overdue"],
      ...(maxPayments === undefined ? {} : { maxPayments }),
      clock,
    });

  /** 400 covered by three payments of 200 and taken back under by a −300 correction. */
  async function correctedInvoice() {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-NEG", state: "sent", total: 400 });
    const invId = String(inv.id);
    for (const amount of [200, 200, 200]) {
      await store.create(TENANT, "Payment", { invoice_id: invId, direction: "inbound", amount, state: "completed" });
    }
    const correction = await store.create(TENANT, "Payment", {
      invoice_id: invId,
      direction: "inbound",
      amount: -300,
      state: "completed",
    });
    return { store, invId, correctionId: String(correction.id), correction };
  }
  const complete = (store: EntityStore, id: string, record: Record<string, unknown>): WriteEffectInput => ({
    operation: "transition",
    entity: "Payment",
    tenantId: TENANT,
    id,
    before: { state: "pending" },
    after: { ...record },
    store,
  });

  it("leaves the invoice unsettled when a later page's negative correction takes the applied total back under", async () => {
    const { store, invId, correctionId, correction } = await correctedInvoice();
    await apply()(complete(pagedAt(store, 2), correctionId, correction));
    const doc = (await store.get(TENANT, "Invoice", invId))!;
    expect(doc.state).toBe("sent"); // applied 300 of 400
    expect(doc.paid_at).toBeUndefined();
  });

  it("refuses rather than settling from a prefix that happens to cover the total", async () => {
    const { store, invId, correctionId, correction } = await correctedInvoice();
    // A cap of 3 reads the three 200s and not the correction — the measured wrong write.
    await expect(apply(3)(complete(store, correctionId, correction))).rejects.toThrow(ReadCeilingExceeded);
    const doc = (await store.get(TENANT, "Invoice", invId))!;
    expect(doc.state).toBe("sent");
    expect(doc.paid_at).toBeUndefined();
  });

  it("still settles a document its payments genuinely cover", async () => {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-OK", state: "sent", total: 400 });
    const invId = String(inv.id);
    let last: Record<string, unknown> = {};
    for (const amount of [100, 100, 100, 100]) {
      last = await store.create(TENANT, "Payment", { invoice_id: invId, direction: "inbound", amount, state: "completed" });
    }
    await apply()(complete(pagedAt(store, 1), String(last.id), last));
    expect((await store.get(TENANT, "Invoice", invId))!.state).toBe("paid");
  });

  it("reads past the real default page size, where the first page alone would have settled it", async () => {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-500", state: "sent", total: 400 });
    const invId = String(inv.id);
    // 599 × 1 covers the total within the first page of 500; the correction is only on the second.
    for (let i = 0; i < DEFAULT_DRAIN_PAGE_SIZE + 99; i += 1) {
      await store.create(TENANT, "Payment", { invoice_id: invId, direction: "inbound", amount: 1, state: "completed" });
    }
    const correction = await store.create(TENANT, "Payment", {
      invoice_id: invId,
      direction: "inbound",
      amount: -250,
      state: "completed",
    });
    await apply()(complete(store, String(correction.id), correction));
    expect((await store.get(TENANT, "Invoice", invId))!.state).toBe("sent"); // applied 349 of 400
  });
});

describe("unrealizedFxRevaluationEffect — the whole payment and document sets", () => {
  async function threeHalfPaidInvoices(withPayments: boolean) {
    const store = new InMemoryEntityStore();
    const usd = await store.create(TENANT, "Currency", { code: "USD" });
    const eur = await store.create(TENANT, "Currency", { code: "EUR" });
    await store.create(TENANT, "ExchangeRate", {
      from_currency_id: String(eur.id),
      to_currency_id: String(usd.id),
      rate: 1.1,
      rate_date: "2026-06-29",
    });
    for (let i = 0; i < 3; i += 1) {
      const inv = await store.create(TENANT, "Invoice", {
        invoice_number: `INV-FX-${String(i)}`,
        state: "sent",
        total: 1000,
        currency: "EUR",
      });
      if (withPayments) {
        await store.create(TENANT, "Payment", { invoice_id: String(inv.id), amount: 500, state: "completed" });
      }
    }
    const period = await store.create(TENANT, "FiscalPeriod", { status: "closing", end_date: "2026-06-30", name: "2026-06" });
    return { store, periodId: String(period.id) };
  }
  const close = (store: EntityStore, id: string): WriteEffectInput => ({
    operation: "transition",
    entity: "FiscalPeriod",
    tenantId: TENANT,
    id,
    before: { status: "closing" },
    after: { status: "closed", end_date: "2026-06-30", name: "2026-06" },
    store,
  });

  it("nets every payment page against every document page (one pass, no payment rows retained)", async () => {
    const { store, periodId } = await threeHalfPaidInvoices(true);
    await unrealizedFxRevaluationEffect({ functionalCurrency: "USD", clock })(close(pagedAt(store, 1), periodId));
    const arLine = (await store.list(TENANT, "JournalLine")).find((l) => Number(l.debit) > 0)!;
    expect(Number(arLine.debit)).toBeCloseTo(150, 6); // open 3 × 500 = 1500 × (1.1 − 1)
  });

  it("refuses on the payment read rather than revaluing documents as if unpaid", async () => {
    const { store, periodId } = await threeHalfPaidInvoices(true);
    const err = await refusalFrom(() =>
      unrealizedFxRevaluationEffect({ functionalCurrency: "USD", clock, maxRows: 1 })(close(store, periodId)),
    );
    expect(err.entity).toBe("Payment");
    expect(err.computing).toBe("an unrealized FX revaluation");
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
  });

  it("refuses on the document read, naming the document entity", async () => {
    // No payments, so the payment drain completes and the three open invoices exceed the ceiling.
    const { store, periodId } = await threeHalfPaidInvoices(false);
    const err = await refusalFrom(() =>
      unrealizedFxRevaluationEffect({ functionalCurrency: "USD", clock, maxRows: 2 })(close(store, periodId)),
    );
    expect(err.entity).toBe("Invoice");
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
  });

  it("keeps each document side's applied payments apart when two entities hold one id", async () => {
    const store = new InMemoryEntityStore();
    const usd = await store.create(TENANT, "Currency", { code: "USD" });
    const eur = await store.create(TENANT, "Currency", { code: "EUR" });
    await store.create(TENANT, "ExchangeRate", {
      from_currency_id: String(eur.id),
      to_currency_id: String(usd.id),
      rate: 1.1,
      rate_date: "2026-06-29",
    });
    // Records are bucketed per `(tenant, entity)` and a supplied `id` is kept, so one id across
    // two entities is representable — and it is what separates a per-side accumulator from one
    // shared map keyed by document id, which would see 400 + 900 against this id and skip both
    // documents as overpaid.
    const shared = "shared-doc-id";
    await store.create(TENANT, "Invoice", { id: shared, invoice_number: "INV-1", state: "sent", total: 1000, currency: "EUR" });
    await store.create(TENANT, "Bill", { id: shared, bill_number: "BILL-1", state: "approved", total: 1000, currency: "EUR" });
    await store.create(TENANT, "Payment", { invoice_id: shared, amount: 400, state: "completed" });
    await store.create(TENANT, "Payment", { bill_id: shared, amount: 900, state: "completed" });
    const period = await store.create(TENANT, "FiscalPeriod", { status: "closing", end_date: "2026-06-30", name: "2026-06" });
    await unrealizedFxRevaluationEffect({ functionalCurrency: "USD", clock })(close(pagedAt(store, 1), String(period.id)));
    const lines = await store.list(TENANT, "JournalLine");
    // AR open 600 → a 60 gain; AP open 100 → a 10 loss.
    expect(Number(lines.find((l) => l.description === "Unrealized FX revaluation — AR EUR")!.debit)).toBeCloseTo(60, 6);
    expect(Number(lines.find((l) => l.description === "Unrealized FX revaluation — AP EUR")!.credit)).toBeCloseTo(10, 6);
  });
});

describe("lookupPeriodEndRate — the latest eligible rate, asked for rather than scanned", () => {
  /**
   * Ids are time-ordered, so under `sort: []` a capped page kept the OLDEST rates and dropped the
   * ones nearest the date. Inserting oldest-first is what made that the wrong answer, so the
   * fixture inserts in exactly that order.
   */
  async function dailyRates(count: number) {
    const store = new InMemoryEntityStore();
    const usd = await store.create(TENANT, "Currency", { code: "USD" });
    const eur = await store.create(TENANT, "Currency", { code: "EUR" });
    const end = Date.UTC(2026, 5, 30);
    for (let i = count - 1; i >= 0; i -= 1) {
      await store.create(TENANT, "ExchangeRate", {
        from_currency_id: String(eur.id),
        to_currency_id: String(usd.id),
        rate: 1 + (count - 1 - i) / 100,
        rate_date: new Date(end - i * 86_400_000).toISOString().slice(0, 10),
      });
    }
    // A rate after the date must still be excluded.
    await store.create(TENANT, "ExchangeRate", {
      from_currency_id: String(eur.id),
      to_currency_id: String(usd.id),
      rate: 9.9,
      rate_date: "2026-07-15",
    });
    const inv = await store.create(TENANT, "Invoice", {
      invoice_number: "INV-RATE",
      state: "draft",
      currency: "EUR",
      issue_date: "2026-06-30",
    });
    return { store, invId: String(inv.id), inv, latest: 1 + (count - 1) / 100 };
  }
  const stamp = bookingRateStampEffect({
    entity: "Invoice",
    triggerState: "sent",
    dateField: "issue_date",
    functionalCurrency: "USD",
    clock,
  });

  it("stamps the latest eligible rate from a set larger than any page", async () => {
    const { store, invId, inv, latest } = await dailyRates(DEFAULT_DRAIN_PAGE_SIZE + 100);
    await stamp({
      operation: "transition",
      entity: "Invoice",
      tenantId: TENANT,
      id: invId,
      before: inv,
      after: { ...inv, state: "sent" },
      store,
    });
    expect(Number((await store.get(TENANT, "Invoice", invId))!.booking_rate)).toBeCloseTo(latest, 6);
  });

  it("asks for one row, so the answer does not depend on how the store pages", async () => {
    const { store, invId, inv, latest } = await dailyRates(40);
    await stamp({
      operation: "transition",
      entity: "Invoice",
      tenantId: TENANT,
      id: invId,
      before: inv,
      after: { ...inv, state: "sent" },
      store: pagedAt(store, 1),
    });
    expect(Number((await store.get(TENANT, "Invoice", invId))!.booking_rate)).toBeCloseTo(latest, 6);
  });
});

describe("resolveAccountId — no positional fallback", () => {
  it("declines a row that does not carry the code asked for, rather than posting to it", async () => {
    const store = new InMemoryEntityStore();
    // A store whose filter did not narrow — what `--store pg` gives when two LedgerAccount rows
    // share an `account_code`, since the document store enforces no `unique` declaration.
    const unnarrowed: EntityStore = {
      listPage: (t, e, q) =>
        e === "LedgerAccount"
          ? Promise.resolve({ records: [{ id: "SOME-OTHER-ACCOUNT", account_code: "9999" }], nextCursor: null })
          : store.listPage(t, e, q),
      get: (t, e, id) => store.get(t, e, id),
      create: (t, e, r) => store.create(t, e, r),
      update: (t, e, id, patch) => store.update(t, e, id, patch),
      remove: (t, e, id) => store.remove(t, e, id),
      list: (t, e) => store.list(t, e),
    };
    const inv = await store.create(TENANT, "Invoice", {
      invoice_number: "INV-ACCT",
      state: "sent",
      document_type: "invoice",
      total: 100,
    });
    await creditNoteGlPostingEffect({ clock, resolveAccountCodes: () => Promise.resolve({ ar: "1100", revenue: "4000" }) })({
      operation: "transition",
      entity: "Invoice",
      tenantId: TENANT,
      id: String(inv.id),
      before: inv,
      after: { ...inv, state: "void" },
      store: unnarrowed,
    });
    const accounts = (await store.list(TENANT, "JournalLine")).map((l) => l.ledger_account_id);
    expect(accounts).not.toContain("SOME-OTHER-ACCOUNT");
    expect(accounts.sort()).toEqual(["accounts_receivable", "revenue"]);
  });
});
