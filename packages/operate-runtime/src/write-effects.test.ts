import { describe, expect, it } from "vitest";

import { InMemoryEntityStore } from "./store.js";
import {
  billGlPostingEffect,
  bookingRateStampEffect,
  computeLineTaxBreakdown,
  creditNoteGlPostingEffect,
  invoiceVoidCreditNoteEffect,
  journalReversalEffect,
  paymentApplicationEffect,
  paymentGlPostingEffect,
  paymentSettlementGlPostingEffect,
  recognitionGlPostingEffect,
  runWriteEffects,
  unrealizedFxRevaluationEffect,
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

describe("billGlPostingEffect (AP↔GL bridge)", () => {
  const effect = billGlPostingEffect({ clock });
  const approve = (store: InMemoryEntityStore, id: string, before: Record<string, unknown>): WriteEffectInput =>
    ({ operation: "transition", entity: "Bill", tenantId: TENANT, id, before, after: { ...before, state: "approved" }, store });

  it("posts a balanced debit-expense / credit-AP entry on bill approval", async () => {
    const store = new InMemoryEntityStore();
    const bill = await store.create(TENANT, "Bill", { bill_number: "BILL-77", state: "draft", currency: "USD", total: 300 });
    await effect(approve(store, String(bill.id), bill));
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    expect(entry.entry_number).toBe("BILL-77-GL");
    expect(entry.state).toBe("posted");
    expect(entry.source).toBe("bill");
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(300);
    expect(lines.reduce((s, l) => s + Number(l.credit), 0)).toBe(300);
  });

  it("resolves AP/expense codes to real LedgerAccount ids", async () => {
    const store = new InMemoryEntityStore();
    const ap = await store.create(TENANT, "LedgerAccount", { account_code: "2000", name: "AP" });
    const exp = await store.create(TENANT, "LedgerAccount", { account_code: "5000", name: "Expense" });
    const bill = await store.create(TENANT, "Bill", { bill_number: "BILL-78", state: "draft", total: 90 });
    const resolving = billGlPostingEffect({ clock, resolveAccountCodes: async () => ({ ap: "2000", expense: "5000" }) });
    await resolving(approve(store, String(bill.id), bill));
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.find((l) => Number(l.debit) > 0)!.ledger_account_id).toBe(String(exp.id));
    expect(lines.find((l) => Number(l.credit) > 0)!.ledger_account_id).toBe(String(ap.id));
  });

  it("does nothing unless the bill moves into approved", async () => {
    const store = new InMemoryEntityStore();
    const bill = await store.create(TENANT, "Bill", { state: "approved", total: 90 });
    await effect(approve(store, String(bill.id), bill)); // already approved → no-op
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
  });
});

describe("paymentGlPostingEffect", () => {
  const invoicePay = paymentGlPostingEffect({
    entity: "Invoice",
    numberField: "invoice_number",
    skipDocumentType: { field: "document_type", value: "credit_note" },
    debitAccountRef: "cash",
    creditAccountRef: "accounts_receivable",
    debitDescription: "Payment — cash",
    creditDescription: "Payment — AR",
    clock,
  });
  const pay = (entity: string, eff: typeof invoicePay) => async (store: InMemoryEntityStore, id: string, before: Record<string, unknown>) =>
    eff({ operation: "transition", entity, tenantId: TENANT, id, before, after: { ...before, state: "paid" }, store });

  it("posts debit cash / credit AR when an invoice is paid", async () => {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-P", state: "sent", document_type: "invoice", total: 120 });
    await pay("Invoice", invoicePay)(store, String(inv.id), inv);
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    expect(entry.entry_number).toBe("INV-P-PAY");
    expect(entry.source).toBe("payment");
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.find((l) => Number(l.debit) > 0)!.ledger_account_id).toBe("cash");
    expect(lines.find((l) => Number(l.credit) > 0)!.ledger_account_id).toBe("accounts_receivable");
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(120);
    expect(lines.reduce((s, l) => s + Number(l.credit), 0)).toBe(120);
  });

  it("skips a credit note reaching paid (only real invoices settle to cash)", async () => {
    const store = new InMemoryEntityStore();
    const cn = await store.create(TENANT, "Invoice", { invoice_number: "CN-P", state: "sent", document_type: "credit_note", total: 50 });
    await pay("Invoice", invoicePay)(store, String(cn.id), cn);
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
  });

  it("posts debit AP / credit cash when a bill is paid", async () => {
    const billPay = paymentGlPostingEffect({
      entity: "Bill",
      numberField: "bill_number",
      debitAccountRef: "accounts_payable",
      creditAccountRef: "cash",
      debitDescription: "Payment — AP",
      creditDescription: "Payment — cash",
      clock,
    });
    const store = new InMemoryEntityStore();
    const bill = await store.create(TENANT, "Bill", { bill_number: "BILL-P", state: "approved", total: 80 });
    await pay("Bill", billPay)(store, String(bill.id), bill);
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.find((l) => Number(l.debit) > 0)!.ledger_account_id).toBe("accounts_payable");
    expect(lines.find((l) => Number(l.credit) > 0)!.ledger_account_id).toBe("cash");
  });

  it("does nothing unless the document moves into paid", async () => {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-Q", state: "paid", document_type: "invoice", total: 10 });
    await pay("Invoice", invoicePay)(store, String(inv.id), inv);
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
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
      { label: "VAT20", tax: 60, accountCode: null, withholding: false },
      { label: "VAT5", tax: 5, accountCode: null, withholding: false },
    ]);
  });

  it("carries the per-code GL account code onto its group", () => {
    const codes = new Map([["wht", { rate: 10, label: "WHT10", accountCode: "2155" }]]);
    const b = computeLineTaxBreakdown([{ net: 100, taxCodeId: "wht", flatRatePct: null }], codes);
    expect(b.groups).toEqual([{ label: "WHT10", tax: 10, accountCode: "2155", withholding: false }]);
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
      { label: "VAT20", tax: 200, accountCode: null, withholding: false },
      { label: "WHT10", tax: 100, accountCode: "2155", withholding: true },
    ]);
  });

  it("falls back to the flat rate when no code, labelled by rate", () => {
    const b = computeLineTaxBreakdown([{ net: 100, taxCodeId: null, flatRatePct: 10 }], new Map());
    expect(b.taxTotal).toBe(10);
    expect(b.withholdingTotal).toBe(0);
    expect(b.groups).toEqual([{ label: "10%", tax: 10, accountCode: null, withholding: false }]);
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
