import { describe, expect, it } from "vitest";

import { DEFAULT_DRAIN_PAGE_SIZE, isReadCeilingExceeded, ReadCeilingExceeded } from "./list-drain.js";
import { settlementCoverageGuard } from "./write-guards.js";
import { PostingRefused } from "./posting-period.js";
import type { FinanceSettings, TenantSettings } from "./settings.js";
import type { TaxRemittanceWiring } from "./tax-remittance.js";
import { InMemoryEntityStore, ReferenceNotFound, type EntityRecord, type EntityStore } from "./store.js";
import {
  bookingRateStampEffect,
  computeLineTaxBreakdown,
  creditNoteGlPostingEffect,
  invoiceVoidCreditNoteEffect,
  journalReversalEffect,
  paymentApplicationEffect,
  paymentSettlementGlPostingEffect,
  recognitionGlPostingEffect,
  reopenStateFor,
  resolveAccountId,
  runWriteEffects,
  taxRemittanceGlPostingEffect,
  taxRemittanceReversalCheckEffect,
  taxRemittanceStampClearEffect,
  taxReturnFilingCheckEffect,
  unrealizedFxRevaluationEffect,
  whtCertificateClearingEffect,
  type WriteEffectInput,
} from "./write-effects.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const clock = { now: () => new Date("2026-06-21T00:00:00.000Z") };

/**
 * A posted recognition entry `<number>-AR` debiting AR and crediting revenue for `total`, which is
 * what the credit-note effect mirrors — its only path since ADR-0475 deleted the two-line fallback.
 */
async function seedRecognition(store: InMemoryEntityStore, number: string, total: number, currency = "USD"): Promise<void> {
  const entry = await store.create(TENANT, "JournalEntry", { entry_number: `${number}-AR`, state: "posted", source: "invoice" });
  for (const [account, debit, credit] of [["ar", total, 0], ["revenue", 0, total]] as const) {
    await store.create(TENANT, "JournalLine", {
      journal_entry_id: String(entry.id),
      ledger_account_id: account,
      description: account,
      currency,
      fx_rate: 1,
      debit,
      credit,
      functional_debit: debit,
      functional_credit: credit,
    });
  }
}

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

  it("creates a mirror posted entry numbered <orig>-REV in the same book, dated today", async () => {
    const { store, id, entry } = await postedEntryWithLines();
    await effect(reverseInput(store, id, entry));
    const entries = await store.list(TENANT, "JournalEntry");
    expect(entries.length).toBe(2);
    const rev = entries.find((e) => e.entry_number === "JE-2026-00007-REV")!;
    expect(rev.state).toBe("posted");
    expect(rev.book_id).toBe("book1");
    // Not the original's period: a reversal dated today belongs to today's, resolved from the date
    // when a fiscal calendar is configured. With none, it names no period at all.
    expect(rev.fiscal_period_id).toBeUndefined();
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
    // The original's tax is carried in proportion (100 + 5 → 40 is 38.10 net + 1.90 tax), rather
    // than the whole credit being written as net with no tax, which is what this pinned before.
    expect(cn.subtotal).toBe(38.1);
    expect(cn.tax_total).toBe(1.9);
    expect(cnLines[0]?.line_total).toBe(38.1);
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
  const effect = creditNoteGlPostingEffect({ clock, recognitionEntrySuffix: "-AR" });

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
    await seedRecognition(store, "INV-2026-00009", 200, "EUR");
    return { store, id: String(inv.id), inv };
  }
  const voidIt = (store: InMemoryEntityStore, id: string, before: Record<string, unknown>): WriteEffectInput =>
    ({ operation: "transition", entity: "Invoice", tenantId: TENANT, id, before, after: { ...before, state: "void" }, store });
  const linesOf = async (store: InMemoryEntityStore, number: string) => {
    const entry = (await store.list(TENANT, "JournalEntry")).find((e) => e.entry_number === number);
    return entry === undefined ? [] : (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
  };

  it("posts the mirror of the recognition entry for the full credit, on its accounts and currency", async () => {
    const { store, id, inv } = await issued();
    await effect(voidIt(store, id, inv));
    const lines = await linesOf(store, "INV-2026-00009-CN-GL");
    expect(lines.map((l) => [l.ledger_account_id, Number(l.debit), Number(l.credit)]).sort()).toEqual(
      [["ar", 0, 200], ["revenue", 200, 0]].sort(),
    );
    expect(lines.every((l) => l.currency === "EUR")).toBe(true);
  });

  it("posts for the partial amount when credit_amount is set", async () => {
    const { store, id, inv } = await issued(75);
    await effect(voidIt(store, id, inv));
    const lines = await linesOf(store, "INV-2026-00009-CN-GL");
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(75);
    expect(lines.reduce((s, l) => s + Number(l.credit), 0)).toBe(75);
  });

  it("does nothing when voiding a draft invoice", async () => {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { state: "draft", total: 200 });
    await effect(voidIt(store, String(inv.id), inv));
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
  });

  it("posts nothing when the invoice has no posted recognition entry — the deleted fallback posted fx_rate 1", async () => {
    // ADR-0475: the two-line revenue/AR pair this used to fall back to wrote `fx_rate: 1` and
    // `functional = amount`, so a EUR invoice's credit carried EUR as functional, and it reversed no
    // tax. `compile.ts` never selected it; with no recognition there is nothing to mirror.
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-N", state: "sent", document_type: "invoice", currency: "EUR", total: 50 });
    await effect(voidIt(store, String(inv.id), inv));
    expect(await store.list(TENANT, "JournalEntry")).toEqual([]);
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
      { label: "VAT20", tax: 60, accountCode: null, jurisdiction: null, withholding: false, selfAssessed: false },
      { label: "VAT5", tax: 5, accountCode: null, jurisdiction: null, withholding: false, selfAssessed: false },
    ]);
  });

  it("carries the per-code GL account code onto its group", () => {
    const codes = new Map([["wht", { rate: 10, label: "WHT10", accountCode: "2155" }]]);
    const b = computeLineTaxBreakdown([{ net: 100, taxCodeId: "wht", flatRatePct: null }], codes);
    expect(b.groups).toEqual([{ label: "WHT10", tax: 10, accountCode: "2155", jurisdiction: null, withholding: false, selfAssessed: false }]);
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
      { label: "VAT20", tax: 200, accountCode: null, jurisdiction: null, withholding: false, selfAssessed: false },
      { label: "WHT10", tax: 100, accountCode: "2155", jurisdiction: null, withholding: true, selfAssessed: false },
    ]);
  });

  it("falls back to the flat rate when no code, labelled by rate", () => {
    const b = computeLineTaxBreakdown([{ net: 100, taxCodeId: null, flatRatePct: 10 }], new Map());
    expect(b.taxTotal).toBe(10);
    expect(b.withholdingTotal).toBe(0);
    expect(b.groups).toEqual([{ label: "10%", tax: 10, accountCode: null, jurisdiction: null, withholding: false, selfAssessed: false }]);
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
    taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total", withholdingAccountRef: "wht_receivable" },
    stampWithholdingField: "withholding_total",
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
      taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total", withholdingAccountRef: "wht_receivable" },
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
      taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total", withholdingAccountRef: "wht_receivable" },
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
      taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total", withholdingAccountRef: "wht_receivable" },
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
      taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total", withholdingAccountRef: "wht_receivable" },
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
    taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total", withholdingAccountRef: "wht_receivable" },
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
    // The payment's own amount moves on both sides; the cash is worth more in the base currency than
    // the receivable it cleared, and the difference is a functional-only gain. It used to be posted as
    // transaction amounts, which put 5 of base currency into the payment's own currency balance.
    const cash = lines.find((l) => l.ledger_account_id === "cash")!;
    expect([cash.debit, cash.functional_debit, cash.fx_rate]).toEqual([100, 105, "1.0500000000"]);
    const ar = lines.find((l) => l.ledger_account_id === "accounts_receivable")!;
    expect([ar.credit, ar.functional_credit, ar.fx_rate]).toEqual([100, 100, 1]);
    const fx = lines.find((l) => l.ledger_account_id === "fx_gain_loss")!;
    expect([fx.debit, fx.credit, fx.functional_credit]).toEqual([0, 0, 5]); // gain
    const sum = (k: string) => lines.reduce((s, l) => s + Number(l[k]), 0);
    expect(sum("debit")).toBe(sum("credit"));
    expect(sum("functional_debit")).toBe(sum("functional_credit"));
  });

  it("books a realized FX loss when cash received is short of the AR cleared", async () => {
    const store = new InMemoryEntityStore();
    const pay = await store.create(TENANT, "Payment", { payment_number: "PAY-3", state: "pending", direction: "inbound", amount: 100, cash_amount: 95 });
    await complete(store, String(pay.id), pay);
    const entry = (await store.list(TENANT, "JournalEntry"))[0]!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    const fx = lines.find((l) => l.ledger_account_id === "fx_gain_loss")!;
    expect([fx.debit, fx.credit, fx.functional_debit]).toEqual([0, 0, 5]); // loss
    const sum = (k: string) => lines.reduce((s, l) => s + Number(l[k]), 0);
    expect(sum("debit")).toBe(sum("credit"));
    expect(sum("functional_debit")).toBe(sum("functional_credit"));
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
    settledBy: "inbound",
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

  it("reads back only the period's revaluations, not every entry posted in it", async () => {
    // Every posting carries its period now, so a period-only read of the prior revaluations would
    // drain the whole month's journal and refuse a busy tenant's close at the ceiling.
    const { store, usdId, eurId } = await fxStore();
    await store.create(TENANT, "ExchangeRate", { from_currency_id: eurId, to_currency_id: usdId, rate: 1.1, rate_date: "2026-06-29" });
    await store.create(TENANT, "Invoice", { invoice_number: "INV-1", state: "sent", total: 1000, currency: "EUR" });
    const period = await store.create(TENANT, "FiscalPeriod", { status: "closing", end_date: "2026-06-30", name: "2026-06" });
    for (const n of [1, 2, 3]) {
      await store.create(TENANT, "JournalEntry", { entry_number: `INV-${n}-AR`, source: "invoice", state: "posted", fiscal_period_id: String(period.id) });
    }
    await unrealizedFxRevaluationEffect({ functionalCurrency: "USD", clock, maxRows: 2 })(closeInput(store, String(period.id)));
    expect((await store.list(TENANT, "JournalEntry")).filter((e) => e.source === "fx_revaluation").length).toBe(2);
  });

  it("posts a balanced FXREVAL entry for an open foreign-currency invoice (rate > 1)", async () => {
    const { store, usdId, eurId } = await fxStore();
    await store.create(TENANT, "ExchangeRate", { from_currency_id: eurId, to_currency_id: usdId, rate: 1.1, rate_date: "2026-06-29" });
    await store.create(TENANT, "Invoice", { invoice_number: "INV-1", state: "sent", total: 1000, currency: "EUR" });
    const period = await store.create(TENANT, "FiscalPeriod", { status: "closing", end_date: "2026-06-30", name: "2026-06" });

    await effect(closeInput(store, String(period.id)));

    // The revaluation, and its own reversal on the next period's first day — an unreversed one
    // would be counted again by the next close, which revalues from the booking rate afresh.
    const entries = await store.list(TENANT, "JournalEntry");
    expect(entries.map((e) => [e.entry_number, e.entry_date])).toEqual([
      ["2026-06-FXREVAL", "2026-06-30"],
      ["2026-06-FXREVALR", "2026-07-01"],
    ]);
    const entry = entries[0]!;
    expect(entry.state).toBe("posted");
    expect(entry.source).toBe("fx_revaluation");
    expect(entry.fiscal_period_id).toBe(String(period.id));

    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.length).toBe(2);
    const totalDebit = lines.reduce((s, l) => s + Number(l.functional_debit), 0);
    const totalCredit = lines.reduce((s, l) => s + Number(l.functional_credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 6);
    // AR gain (rate 1.1 → +100): debit AR, credit unrealized FX — in the base currency only. The
    // foreign balance did not change, so no line moves a transaction amount.
    const arLine = lines.find((l) => Number(l.functional_debit) > 0)!;
    expect(Number(arLine.functional_debit)).toBeCloseTo(100, 6);
    expect(lines.map((l) => [l.debit, l.credit])).toEqual([
      [0, 0],
      [0, 0],
    ]);
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
    const arLine = (await store.list(TENANT, "JournalLine")).find((l) => Number(l.functional_debit) > 0)!;
    expect(Number(arLine.functional_debit)).toBeCloseTo(200, 6); // 1000 × (1.2 − 1)
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
    await store.create(TENANT, "Payment", { invoice_id: String(inv.id), direction: "inbound", amount: 400, state: "completed" });
    const period = await store.create(TENANT, "FiscalPeriod", { status: "closing", end_date: "2026-06-30", name: "2026-06" });

    await effect(closeInput(store, String(period.id)));
    const arLine = (await store.list(TENANT, "JournalLine")).find((l) => Number(l.functional_debit) > 0)!;
    expect(Number(arLine.functional_debit)).toBeCloseTo(60, 6); // open 600 × (1.1 − 1)
  });

  it("mirrors AP: a higher rate raises a foreign payable → loss → debit unrealized FX, credit AP", async () => {
    const { store, usdId, eurId } = await fxStore();
    await store.create(TENANT, "ExchangeRate", { from_currency_id: eurId, to_currency_id: usdId, rate: 1.1, rate_date: "2026-06-29" });
    await store.create(TENANT, "Bill", { bill_number: "BILL-1", state: "approved", total: 1000, currency: "EUR" });
    const period = await store.create(TENANT, "FiscalPeriod", { status: "closing", end_date: "2026-06-30", name: "2026-06" });

    await effect(closeInput(store, String(period.id)));
    const entry = (await store.list(TENANT, "JournalEntry")).find((e) => e.entry_number === "2026-06-FXREVAL")!;
    const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l.journal_entry_id === entry.id);
    expect(lines.length).toBe(2);
    const totalDebit = lines.reduce((s, l) => s + Number(l.functional_debit), 0);
    const totalCredit = lines.reduce((s, l) => s + Number(l.functional_credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 6);
    // AP control credited (liability grows), unrealized FX debited (loss).
    const apLine = lines.find((l) => l.description === "Unrealized FX revaluation — AP EUR")!;
    expect(Number(apLine.functional_credit)).toBeCloseTo(100, 6);
    const fxLine = lines.find((l) => l.description === "Unrealized FX gain/loss — EUR")!;
    expect(Number(fxLine.functional_debit)).toBeCloseTo(100, 6);
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
    const arLine = (await store.list(TENANT, "JournalLine")).find((l) => Number(l.functional_debit) > 0)!;
    expect(Number(arLine.functional_debit)).toBeCloseTo(100, 6);
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
  const creditGl = creditNoteGlPostingEffect({ clock, recognitionEntrySuffix: "-AR" });

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
    await seedRecognition(store, "INV-WIRE-1", 105, "EUR");
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
    const entry = (await store.list(TENANT, "JournalEntry")).find((e) => e.entry_number === "INV-WIRE-1-CN-GL")!;
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
      taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total", withholdingAccountRef: "wht_receivable" },
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
    updateIf: (t, e, id, patch, expected) => inner.updateIf(t, e, id, patch, expected),
    remove: (t, e, id) => inner.remove(t, e, id),
    removeIf: (t, e, id, x) => inner.removeIf(t, e, id, x),
    getLocked: (t, e, id, l) => inner.getLocked(t, e, id, l),
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
      taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total", withholdingAccountRef: "wht_receivable", ...(maxRows === undefined ? {} : { maxRows }) },
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
      settledBy: "inbound",
      settleableStates: ["sent", "overdue"],
      ...(maxPayments === undefined ? {} : { maxPayments }),
      clock,
    });

  /** 400 covered by three payments of 200, with a stored −300 row that the posting cleared nothing for. */
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

  it("counts a later page's stored negative row as nothing, because the posting cleared nothing for it", async () => {
    // Rewritten rather than deleted (ADR-0372's class). This pinned the −300 as taking the applied
    // total back under 400 — while the settlement posting skips a non-positive amount, so the GL had
    // cleared 600 of the receivable and the invoice stayed `sent`: the subledger and the ledger
    // disagreeing, measured as `mark_paid` refused with the receivable already at zero. The fold
    // counts what the posting cleared now (ADR-0468), so the three 200s settle it on page 2.
    const { store, invId, correctionId, correction } = await correctedInvoice();
    await apply()(complete(pagedAt(store, 2), correctionId, correction));
    const doc = (await store.get(TENANT, "Invoice", invId))!;
    expect(doc.state).toBe("paid"); // applied 600 of 400; the −300 applied nothing
  });

  it("refuses rather than settling from a prefix that happens to cover the total", async () => {
    const { store, invId, correctionId, correction } = await correctedInvoice();
    // A cap of 3 reads three of the four rows. The figure would cover the total either way now (a
    // negative row counts nothing, ADR-0468), and the refusal still stands: a decision from a prefix
    // is not a decision, `READ_CEILING_EFFECT.effect`.
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

  it("reads past the real default page size, where the first page alone would not have settled it", async () => {
    // Rewritten from the negative-correction form (a −250 on page 2 that no longer counts). The
    // property kept is the drain's: a figure from page 1 is not the figure, so 500 × 0.5 (250) on
    // the first page and 150 × 1 on the second settle 400 only because the second page is read.
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-500", state: "sent", total: 400 });
    const invId = String(inv.id);
    for (let i = 0; i < DEFAULT_DRAIN_PAGE_SIZE; i += 1) {
      await store.create(TENANT, "Payment", { invoice_id: invId, direction: "inbound", amount: 0.5, state: "completed" });
    }
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 150; i += 1) {
      last = await store.create(TENANT, "Payment", { invoice_id: invId, direction: "inbound", amount: 1, state: "completed" });
    }
    await apply()(complete(store, String(last.id), last));
    expect((await store.get(TENANT, "Invoice", invId))!.state).toBe("paid"); // 250 + 150 = 400
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
        await store.create(TENANT, "Payment", { invoice_id: String(inv.id), direction: "inbound", amount: 500, state: "completed" });
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
    const arLine = (await store.list(TENANT, "JournalLine")).find((l) => Number(l.functional_debit) > 0)!;
    expect(Number(arLine.functional_debit)).toBeCloseTo(150, 6); // open 3 × 500 = 1500 × (1.1 − 1)
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
    await store.create(TENANT, "Payment", { invoice_id: shared, direction: "inbound", amount: 400, state: "completed" });
    await store.create(TENANT, "Payment", { bill_id: shared, direction: "outbound", amount: 900, state: "completed" });
    const period = await store.create(TENANT, "FiscalPeriod", { status: "closing", end_date: "2026-06-30", name: "2026-06" });
    await unrealizedFxRevaluationEffect({ functionalCurrency: "USD", clock })(close(pagedAt(store, 1), String(period.id)));
    const lines = await store.list(TENANT, "JournalLine");
    // AR open 600 → a 60 gain; AP open 100 → a 10 loss.
    expect(Number(lines.find((l) => l.description === "Unrealized FX revaluation — AR EUR")!.functional_debit)).toBeCloseTo(60, 6);
    expect(Number(lines.find((l) => l.description === "Unrealized FX revaluation — AP EUR")!.functional_credit)).toBeCloseTo(10, 6);
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
      updateIf: (t, e, id, patch, expected) => store.updateIf(t, e, id, patch, expected),
      remove: (t, e, id) => store.remove(t, e, id),
      removeIf: (t, e, id, x) => store.removeIf(t, e, id, x),
      getLocked: (t, e, id, l) => store.getLocked(t, e, id, l),
      list: (t, e) => store.list(t, e),
    };
    // Asked directly: the credit-note effect that carried this test resolved accounts through its
    // two-line fallback, which ADR-0475 deleted. The rule is `resolveAccountId`'s own.
    const input = { tenantId: TENANT, store: unnarrowed } as unknown as WriteEffectInput;
    const ledger = { ledgerAccountEntity: "LedgerAccount", accountCodeField: "account_code" };
    expect(await resolveAccountId(input, ledger, "1100")).toBeNull();
    expect(await resolveAccountId(input, ledger, "9999")).toBe("SOME-OTHER-ACCOUNT");
  });
});

// ---------------------------------------------------------------------------
// The applied-payment fold is one function with three readers (ADR-0391). These pin the two
// properties the convergence has to preserve for *this* module: the effect's settle condition is
// the guard's refusal condition negated, and the FX revaluation's per-side maps stay aligned with
// the specs that asked for them.
// ---------------------------------------------------------------------------

describe("paymentApplicationEffect — one coverage predicate, two readers", () => {
  const effect = paymentApplicationEffect({
    documentEntity: "Invoice",
    refField: "invoice_id",
    settledBy: "inbound",
    settleableStates: ["sent", "overdue"],
    clock,
  });
  const guard = settlementCoverageGuard({ entity: "Invoice", refField: "invoice_id", settledBy: "inbound" });

  async function settleAttempt(total: number, paid: number) {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-P", state: "sent", total });
    const invId = String(inv["id"]);
    const pay = await store.create(TENANT, "Payment", {
      invoice_id: invId,
      direction: "inbound",
      amount: paid,
      state: "completed",
    });
    await effect({
      operation: "transition",
      entity: "Payment",
      tenantId: TENANT,
      id: String(pay["id"]),
      before: { state: "pending" },
      after: { ...(await store.get(TENANT, "Payment", String(pay["id"])))! },
      store,
    });
    const settledByEffect = (await store.get(TENANT, "Invoice", invId))?.["state"] === "paid";
    // Asked of a document still in `sent`, so the guard's own second conjunct cannot mask the
    // answer: a fresh store with the same payment, and the by-hand mark the guard would vet.
    const fresh = new InMemoryEntityStore();
    const inv2 = await fresh.create(TENANT, "Invoice", { invoice_number: "INV-P", state: "sent", total });
    await fresh.create(TENANT, "Payment", {
      invoice_id: String(inv2["id"]),
      direction: "inbound",
      amount: paid,
      state: "completed",
    });
    const block = await guard({
      operation: "transition",
      entity: "Invoice",
      tenantId: TENANT,
      id: String(inv2["id"]),
      before: { state: "sent", total },
      after: { state: "paid", total },
      store: fresh,
    });
    return { settledByEffect, refusedByGuard: block !== null };
  }

  it("settles exactly when the guard would not refuse, on both sides of the epsilon", async () => {
    // If these ever disagreed, a document would be simultaneously auto-marked by the effect and
    // unmarkable by hand — or the reverse. One `settlementIsCovered` is why they cannot.
    for (const [total, paid] of [
      [120, 50],
      [120, 120],
      [120, 119.999],
      [120, 119.98],
      [120, 500],
    ] as const) {
      const r = await settleAttempt(total, paid);
      expect(r.settledByEffect, `${total}/${paid}`).toBe(!r.refusedByGuard);
    }
  });
});

// The FX revaluation's per-side keying needs no new test here: the pre-existing
// "keeps each document side's applied map keyed by that side's own ref field" above already fails
// when the sides are zipped from one shared map, and it does so through the **real effect** rather
// than through the fold — measured, it is the only failure that mutation produces. A second
// assertion over `readAppliedPayments` would have been the bucket test in `write-guards.test.ts`
// written twice.

describe("entersState — a one-step create reaches the state, so the effect fires", () => {
  // Six effects keyed on *arriving* in a state opened with
  // `operation !== "update" && operation !== "transition"`, which reads as "a document reaches this
  // state by being transitioned" and is false: a lifecycle state is an ordinary `enum` field with a
  // literal default and no field-level permissions in any shipped pack, so a caller may POST it
  // directly. Measured live on `--store pg` + `erp-core` as `erp_admin`: an invoice created
  // `{"state":"sent"}` answered 201 and recognised NO revenue, while the AR aging report counted it
  // — 277 open against a general ledger carrying 250. Every figure balances on its own, so
  // `journalPostingGuard` is satisfied and no detector can see it (ADR-0378).
  //
  // None of the 1117 pre-existing tests in this package failed on the defect, because every fixture
  // here reaches its state through `operation: "transition"`. That is the point of this block.

  const create = (entity: string, after: Record<string, unknown>, store: EntityStore, id: string): WriteEffectInput =>
    ({ operation: "create", entity, tenantId: TENANT, id, before: null, after, store });

  it("recognitionGlPostingEffect posts on an invoice created already sent", async () => {
    const store = new InMemoryEntityStore();
    const rec = recognitionGlPostingEffect({
      entity: "Invoice", triggerState: "sent", controlSide: "debit", numberField: "invoice_number",
      controlAccountRef: "ar", netAccountRef: "revenue", taxAccountRef: "tax_payable",
      controlDescription: "AR", netDescription: "Revenue", taxDescription: "Tax", clock,
    });
    const inv = await store.create(TENANT, "Invoice", {
      invoice_number: "INV-BORN-SENT", state: "sent", document_type: "invoice",
      subtotal: 77, tax_total: 0, total: 77,
    });
    await rec(create("Invoice", inv, store, String(inv.id)));
    const lines = await store.list(TENANT, "JournalLine");
    expect(lines.length).toBe(2);
    expect(lines.find((l) => l.ledger_account_id === "ar")!.debit).toBe(77);
    expect(lines.find((l) => l.ledger_account_id === "revenue")!.credit).toBe(77);
  });

  it("bookingRateStampEffect stamps an invoice created already sent", async () => {
    const store = new InMemoryEntityStore();
    const usd = await store.create(TENANT, "Currency", { code: "USD", name: "USD" });
    const eur = await store.create(TENANT, "Currency", { code: "EUR", name: "EUR" });
    await store.create(TENANT, "ExchangeRate", {
      from_currency_id: String(eur.id), to_currency_id: String(usd.id), rate: 1.15, rate_date: "2026-05-20",
    });
    const stamp = bookingRateStampEffect({
      entity: "Invoice", triggerState: "sent", dateField: "issue_date", functionalCurrency: "USD", clock,
    });
    const inv = await store.create(TENANT, "Invoice", {
      invoice_number: "INV-FX", state: "sent", currency: "EUR", issue_date: "2026-06-01", total: 10,
    });
    await stamp(create("Invoice", inv, store, String(inv.id)));
    const after = await store.get(TENANT, "Invoice", String(inv.id));
    expect(Number(after!.booking_rate)).toBeCloseTo(1.15, 6);
  });

  it("paymentSettlementGlPostingEffect posts on a payment created already completed", async () => {
    const store = new InMemoryEntityStore();
    const settle = paymentSettlementGlPostingEffect({ cashAccountRef: "cash", arAccountRef: "ar", clock });
    const pay = await store.create(TENANT, "Payment", {
      payment_number: "PAY-1", state: "completed", direction: "inbound", amount: 50, currency: "USD",
    });
    await settle(create("Payment", pay, store, String(pay.id)));
    const lines = await store.list(TENANT, "JournalLine");
    expect(lines.length).toBe(2);
    expect(lines.find((l) => l.ledger_account_id === "cash")!.debit).toBe(50);
    expect(lines.find((l) => l.ledger_account_id === "ar")!.credit).toBe(50);
  });

  it("paymentApplicationEffect settles the document for a payment created already completed", async () => {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-APP", state: "sent", total: 50 });
    const apply = paymentApplicationEffect({
      refField: "invoice_id", settledBy: "inbound", documentEntity: "Invoice", settleableStates: ["sent", "overdue"], clock,
    });
    const pay = await store.create(TENANT, "Payment", {
      payment_number: "PAY-2", state: "completed", direction: "inbound", amount: 50, invoice_id: String(inv.id),
    });
    await apply(create("Payment", pay, store, String(pay.id)));
    const after = await store.get(TENANT, "Invoice", String(inv.id));
    expect(after!.state).toBe("paid");
    expect(after!.paid_at).toBe("2026-06-21T00:00:00.000Z");
  });

  it("whtCertificateClearingEffect clears for a certificate created already confirmed", async () => {
    const store = new InMemoryEntityStore();
    const clear = whtCertificateClearingEffect({ clock });
    const cert = await store.create(TENANT, "WhtCertificate", {
      certificate_number: "WHT-1", state: "confirmed", amount: 12, currency: "USD",
    });
    await clear(create("WhtCertificate", cert, store, String(cert.id)));
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(1);
  });

  it("a create and a later transition into the same state fire exactly once between them", async () => {
    // The `before` half of the edge is what prevents the double-fire, and it was already present at
    // every site — only the operation test was narrower than the edge. Driving both halves pins
    // that the widening did not introduce a second posting.
    const store = new InMemoryEntityStore();
    const rec = recognitionGlPostingEffect({
      entity: "Invoice", triggerState: "sent", controlSide: "debit", numberField: "invoice_number",
      controlAccountRef: "ar", netAccountRef: "revenue", taxAccountRef: "tax_payable",
      controlDescription: "AR", netDescription: "Revenue", taxDescription: "Tax", clock,
    });
    const inv = await store.create(TENANT, "Invoice", {
      invoice_number: "INV-ONCE", state: "sent", document_type: "invoice", subtotal: 5, tax_total: 0, total: 5,
    });
    const id = String(inv.id);
    await rec(create("Invoice", inv, store, id));
    await rec({ operation: "transition", entity: "Invoice", tenantId: TENANT, id, before: inv, after: { ...inv, state: "sent" }, store });
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(1);
  });
});

describe("entersState — the three prior-state effects stay inert on a create", () => {
  // `journalReversalEffect`, `invoiceVoidCreditNoteEffect` and `creditNoteGlPostingEffect` each
  // require a *specific prior state* (`!wasPosted`, `!wasIssued`), and a create has none — so a
  // record created already `reversed` or `void` was never posted and never issued, and ignoring it
  // is the right answer. Widening these would reverse an entry that was never posted and
  // credit-note an invoice that was never sent. This block is why the sweep is six sites and not
  // nine.
  //
  // What these three fence is the **conjunction**, and that was measured rather than assumed: a
  // create is refused twice over here, by the operation test *and* by the prior-state clause, and
  // either alone suffices — so widening the operation test alone passes all three, and dropping
  // `!wasPosted` / `!wasIssued` alone also passes all three. Both mutations together fail all
  // three. A first draft of this comment claimed they "fail if somebody completes the sweep", which
  // is false, and only the mutation said so: this file's own documented-the-hazard-and-checked-
  // nothing class, in the comment claiming the check. Pinning the *outcome* rather than a
  // particular guard is nonetheless the right property for an inertness claim — what matters is
  // that something refuses the create, not which — but the fence is weaker than a single-mutation
  // one and that is worth knowing before relying on it.

  const create = (entity: string, after: Record<string, unknown>, store: EntityStore, id: string): WriteEffectInput =>
    ({ operation: "create", entity, tenantId: TENANT, id, before: null, after, store });

  it("journalReversalEffect writes nothing for an entry created already reversed", async () => {
    const store = new InMemoryEntityStore();
    const entry = await store.create(TENANT, "JournalEntry", { entry_number: "JE-X", state: "reversed", book_id: "b", fiscal_period_id: "p" });
    await journalReversalEffect({ clock })(create("JournalEntry", entry, store, String(entry.id)));
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(1);
    expect((await store.list(TENANT, "JournalLine")).length).toBe(0);
  });

  it("invoiceVoidCreditNoteEffect writes nothing for an invoice created already void", async () => {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-V", state: "void", document_type: "invoice", total: 10 });
    await invoiceVoidCreditNoteEffect({ clock })(create("Invoice", inv, store, String(inv.id)));
    expect((await store.list(TENANT, "Invoice")).length).toBe(1);
  });

  it("creditNoteGlPostingEffect writes nothing for an invoice created already void", async () => {
    const store = new InMemoryEntityStore();
    const inv = await store.create(TENANT, "Invoice", { invoice_number: "INV-V2", state: "void", document_type: "invoice", total: 10 });
    await creditNoteGlPostingEffect({ clock, recognitionEntrySuffix: "-AR" })(create("Invoice", inv, store, String(inv.id)));
    expect((await store.list(TENANT, "JournalEntry")).length).toBe(0);
  });
});

describe("recognitionGlPostingEffect — where withholding posts", () => {
  function recognition(opts: {
    readonly sale: boolean;
    readonly codes?: { control?: string; net?: string; tax?: string; withholding?: string };
    readonly jurisdictions?: Record<string, string>;
    /** False: the deployment records the withholding on no field (the document does not declare it). */
    readonly stamp?: boolean;
  }) {
    return recognitionGlPostingEffect({
      entity: opts.sale ? "Invoice" : "Bill",
      triggerState: opts.sale ? "sent" : "approved",
      controlSide: opts.sale ? "debit" : "credit",
      numberField: opts.sale ? "invoice_number" : "bill_number",
      controlAccountRef: opts.sale ? "ar" : "ap",
      netAccountRef: opts.sale ? "revenue" : "expense",
      taxAccountRef: opts.sale ? "tax_payable" : "tax_input",
      controlDescription: "Control",
      netDescription: "Net",
      taxDescription: "Tax",
      contraDocumentType: { field: "document_type", value: "credit_note" },
      taxLines: opts.sale
        ? { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total", withholdingAccountRef: "wht_receivable" }
        : { entity: "BillLine", refField: "bill_id", netField: "amount", withholdingAccountRef: "wht_payable" },
      ...(opts.stamp === false ? {} : { stampWithholdingField: "withholding_total" }),
      ...(opts.codes !== undefined ? { resolveAccountCodes: async () => opts.codes ?? {} } : {}),
      ...(opts.jurisdictions !== undefined ? { resolveJurisdictionAccounts: async () => opts.jurisdictions ?? {} } : {}),
      clock,
    });
  }

  const SALE_CODES = { control: "1200", net: "4000", tax: "2200", withholding: "1310" };
  const PURCHASE_CODES = { control: "2100", net: "5000", tax: "1300", withholding: "2210" };

  async function chart(store: InMemoryEntityStore): Promise<void> {
    for (const [id, code] of [
      ["acc_ar", "1200"],
      ["acc_rev", "4000"],
      ["acc_out", "2200"],
      ["acc_whtr", "1310"],
      ["acc_rec", "1320"],
      ["acc_ap", "2100"],
      ["acc_exp", "5000"],
      ["acc_in", "1300"],
      ["acc_whtp", "2210"],
    ] as const) {
      await store.create(TENANT, "LedgerAccount", { id, account_code: code });
    }
  }

  async function balances(store: EntityStore): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const l of await store.list(TENANT, "JournalLine")) {
      const acct = String(l.ledger_account_id);
      out[acct] = Math.round(((out[acct] ?? 0) + Number(l.debit) - Number(l.credit)) * 100) / 100;
    }
    return out;
  }

  /**
   * Net 100, VAT 10, WHT 5, total 110: a line carries one code, so the VAT and the withholding each
   * ride on their own 50 (VAT 20%, WHT 10%), which is the shape the reconciliation gate admits.
   */
  async function document(
    store: InMemoryEntityStore,
    sale: boolean,
    wht: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ): Promise<EntityRecord> {
    await store.create(TENANT, "TaxCode", { id: "vat", code: "VAT20", rate_pct: 20, kind: "vat", jurisdiction: "UK" });
    await store.create(TENANT, "TaxCode", { id: "wht", code: "WHT10", rate_pct: 10, kind: "withholding", ...wht });
    const doc = await store.create(TENANT, sale ? "Invoice" : "Bill", {
      [sale ? "invoice_number" : "bill_number"]: sale ? "INV-1" : "BILL-1",
      state: "draft",
      document_type: "invoice",
      subtotal: 100,
      tax_total: 10,
      total: 110,
      ...extra,
    });
    const line = sale ? "InvoiceLine" : "BillLine";
    const ref = sale ? "invoice_id" : "bill_id";
    const net = sale ? "line_total" : "amount";
    await store.create(TENANT, line, { [ref]: String(doc.id), [net]: 50, tax_code_id: "vat" });
    await store.create(TENANT, line, { [ref]: String(doc.id), [net]: 50, tax_code_id: "wht" });
    return doc;
  }

  const recognise = (effect: ReturnType<typeof recognition>, store: EntityStore, doc: EntityRecord, sale: boolean) =>
    effect({
      operation: "transition",
      entity: sale ? "Invoice" : "Bill",
      tenantId: TENANT,
      id: String(doc.id),
      before: doc,
      after: { ...doc, state: sale ? "sent" : "approved" },
      store,
    });

  it("debits the WHT receivable on a sale, leaves output tax whole, and the certificate clears it to zero", async () => {
    const store = new InMemoryEntityStore();
    await chart(store);
    const inv = await document(store, true);
    await recognise(recognition({ sale: true, codes: SALE_CODES }), store, inv, true);
    expect(await balances(store)).toEqual({ acc_ar: 105, acc_whtr: 5, acc_rev: -100, acc_out: -10 });

    const cert = await store.create(TENANT, "WhtCertificate", { certificate_number: "C-1", state: "draft", amount: 5, currency: "USD" });
    await whtCertificateClearingEffect({
      resolveAccountCodes: async () => ({ whtReceivable: "1310", taxRecoverable: "1320" }),
      clock,
    })({
      operation: "transition",
      entity: "WhtCertificate",
      tenantId: TENANT,
      id: String(cert.id),
      before: cert,
      after: { ...cert, state: "confirmed" },
      store,
    });
    expect(await balances(store)).toEqual({ acc_ar: 105, acc_whtr: 0, acc_rec: 5, acc_rev: -100, acc_out: -10 });
  });

  it("credits the WHT payable on a purchase, not input tax", async () => {
    const store = new InMemoryEntityStore();
    await chart(store);
    const bill = await document(store, false);
    await recognise(recognition({ sale: false, codes: PURCHASE_CODES }), store, bill, false);
    expect(await balances(store)).toEqual({ acc_ap: -105, acc_whtp: -5, acc_exp: 100, acc_in: 10 });
  });

  it("posts to the withholding code's own gl_account_code when it names one", async () => {
    const store = new InMemoryEntityStore();
    await chart(store);
    await store.create(TENANT, "LedgerAccount", { id: "acc_own", account_code: "1399" });
    const inv = await document(store, true, { gl_account_code: "1399" });
    await recognise(recognition({ sale: true, codes: SALE_CODES }), store, inv, true);
    const b = await balances(store);
    expect(b.acc_own).toBe(5);
    expect(b.acc_whtr).toBeUndefined();
  });

  it("falls to the withholding default, not the tax account, when the code's own account does not resolve", async () => {
    const store = new InMemoryEntityStore();
    await chart(store);
    const inv = await document(store, true, { gl_account_code: "9999" });
    await recognise(recognition({ sale: true, codes: SALE_CODES }), store, inv, true);
    expect((await balances(store)).acc_whtr).toBe(5);
  });

  it("never consults the per-jurisdiction tax map for withholding, which stays in force for regular tax", async () => {
    const store = new InMemoryEntityStore();
    await chart(store);
    await store.create(TENANT, "LedgerAccount", { id: "acc_uk", account_code: "2201" });
    const inv = await document(store, true, { jurisdiction: "UK" });
    await recognise(recognition({ sale: true, codes: SALE_CODES, jurisdictions: { UK: "2201" } }), store, inv, true);
    expect(await balances(store)).toEqual({ acc_ar: 105, acc_whtr: 5, acc_rev: -100, acc_uk: -10 });
  });

  it("posts to the literal ref when no withholding code is configured", async () => {
    const store = new InMemoryEntityStore();
    const inv = await document(store, true);
    await recognise(recognition({ sale: true }), store, inv, true);
    expect(await balances(store)).toEqual({ ar: 105, wht_receivable: 5, revenue: -100, tax_payable: -10 });

    const billStore = new InMemoryEntityStore();
    const bill = await document(billStore, false);
    await recognise(recognition({ sale: false }), billStore, bill, false);
    expect((await balances(billStore)).wht_payable).toBe(-5);
  });

  it("is refused by a store that enforces references when the default resolves to no account", async () => {
    class EnforcingStore extends InMemoryEntityStore {
      override async create(tenantId: string, entity: string, record: Record<string, unknown>): Promise<EntityRecord> {
        if (entity === "JournalLine" && (await this.get(tenantId, "LedgerAccount", String(record.ledger_account_id))) === null) {
          throw new ReferenceNotFound("JournalLine", "ledger_account_id", "LedgerAccount");
        }
        return super.create(tenantId, entity, record);
      }
    }
    const store = new EnforcingStore();
    await chart(store);
    const inv = await document(store, true);
    // Every account but the withholding one is configured.
    const { withholding: _unset, ...codes } = SALE_CODES;
    await expect(recognise(recognition({ sale: true, codes }), store, inv, true)).rejects.toBeInstanceOf(ReferenceNotFound);
    // The control: configured, the same document posts.
    const posted = new EnforcingStore();
    await chart(posted);
    const inv2 = await document(posted, true);
    await recognise(recognition({ sale: true, codes: SALE_CODES }), posted, inv2, true);
    expect((await balances(posted)).acc_whtr).toBe(5);
  });

  it("leaves a document with no withholding as it was", async () => {
    const store = new InMemoryEntityStore();
    await chart(store);
    await store.create(TENANT, "TaxCode", { id: "vat", code: "VAT10", rate_pct: 10, kind: "vat" });
    const inv = await store.create(TENANT, "Invoice", {
      invoice_number: "INV-2",
      state: "draft",
      document_type: "invoice",
      subtotal: 100,
      tax_total: 10,
      total: 110,
    });
    await store.create(TENANT, "InvoiceLine", { invoice_id: String(inv.id), line_total: 100, tax_code_id: "vat" });
    await recognise(recognition({ sale: true, codes: SALE_CODES }), store, inv, true);
    expect(await balances(store)).toEqual({ acc_ar: 110, acc_rev: -100, acc_out: -10 });
  });

  it("credits the WHT receivable on a credit note, the mirror of the sale", async () => {
    const store = new InMemoryEntityStore();
    await chart(store);
    const note = await document(store, true, {}, { document_type: "credit_note" });
    await recognise(recognition({ sale: true, codes: SALE_CODES }), store, note, true);
    expect(await balances(store)).toEqual({ acc_ar: -105, acc_whtr: -5, acc_rev: 100, acc_out: 10 });
  });

  /** A bill of 100: one line of `lines` nets each, every line under its own code. */
  async function bill(
    store: InMemoryEntityStore,
    lines: readonly { readonly net: number; readonly code: Record<string, unknown> }[],
  ): Promise<EntityRecord> {
    const total = lines.reduce((s, l) => s + l.net, 0);
    const doc = await store.create(TENANT, "Bill", {
      bill_number: "BILL-W",
      state: "draft",
      subtotal: total,
      tax_total: 0,
      total,
    });
    let n = 0;
    for (const l of lines) {
      n += 1;
      const code = await store.create(TENANT, "TaxCode", { id: `code_${n}`, code: `WHT-${n}`, kind: "withholding", ...l.code });
      await store.create(TENANT, "BillLine", { bill_id: String(doc.id), amount: l.net, tax_code_id: String(code.id) });
    }
    return doc;
  }

  it("stamps a bill's withholding and credits AP net of it", async () => {
    const store = new InMemoryEntityStore();
    await chart(store);
    const doc = await bill(store, [{ net: 100, code: { rate_pct: 10 } }]);
    await recognise(recognition({ sale: false, codes: PURCHASE_CODES }), store, doc, false);
    expect(await balances(store)).toEqual({ acc_ap: -90, acc_whtp: -10, acc_exp: 100 });
    const ap = (await store.list(TENANT, "JournalLine")).find((l) => l.ledger_account_id === "acc_ap")!;
    expect(Number(ap.credit)).toBe(90);
    expect(Number((await store.get(TENANT, "Bill", String(doc.id)))!.withholding_total)).toBe(10);
  });

  it("refuses, writing nothing, a withholding it has no field to record", async () => {
    // The control line would post net of the withholding while every reader of what is owed takes
    // the total less a field nothing stamped — a bill that could never settle.
    const store = new InMemoryEntityStore();
    await chart(store);
    const doc = await bill(store, [{ net: 100, code: { rate_pct: 10 } }]);
    const refused = await recognise(recognition({ sale: false, codes: PURCHASE_CODES, stamp: false }), store, doc, false).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toMatchObject({ name: "PostingRefused", status: 409, error: "withholding_unrecorded" });
    expect((refused as Error).message).toContain("declare withholding_total on Bill");
    expect(await store.list(TENANT, "JournalEntry")).toEqual([]);
    expect(await store.list(TENANT, "JournalLine")).toEqual([]);
    expect((await store.get(TENANT, "Bill", String(doc.id)))!.withholding_total).toBeUndefined();
  });

  it("posts a bill with no withholding whether or not it has a field to record one in", async () => {
    // The refusal is about withholding that would go unrecorded, not about the field's absence.
    const store = new InMemoryEntityStore();
    await chart(store);
    await store.create(TENANT, "TaxCode", { id: "vat", code: "VAT10", rate_pct: 10, kind: "vat" });
    const doc = await store.create(TENANT, "Bill", { bill_number: "BILL-V", state: "draft", subtotal: 100, tax_total: 10, total: 110 });
    await store.create(TENANT, "BillLine", { bill_id: String(doc.id), amount: 100, tax_code_id: "vat" });
    await recognise(recognition({ sale: false, codes: PURCHASE_CODES, stamp: false }), store, doc, false);
    expect(await balances(store)).toEqual({ acc_ap: -110, acc_exp: 100, acc_in: 10 });
  });

  it("stamps the sum of two withholding codes, one posting to its own account", async () => {
    const store = new InMemoryEntityStore();
    await chart(store);
    await store.create(TENANT, "LedgerAccount", { id: "acc_own", account_code: "2215" });
    const doc = await bill(store, [
      { net: 60, code: { rate_pct: 10 } },
      { net: 40, code: { rate_pct: 5, gl_account_code: "2215" } },
    ]);
    await recognise(recognition({ sale: false, codes: PURCHASE_CODES }), store, doc, false);
    const lines = await store.list(TENANT, "JournalLine");
    const withheld = lines.filter((l) => String(l.description).startsWith("Withholding ("));
    expect(withheld.map((l) => [l.ledger_account_id, Number(l.credit)]).sort()).toEqual([
      ["acc_own", 2],
      ["acc_whtp", 6],
    ]);
    expect(Number((await store.get(TENANT, "Bill", String(doc.id)))!.withholding_total)).toBe(8);
    expect((await balances(store)).acc_ap).toBe(-92);
  });

  it("stamps nothing when the withholding rounds to zero, though it has a field to stamp", async () => {
    const store = new InMemoryEntityStore();
    await chart(store);
    // 0.04 at 10% is 0.004, which is no cent.
    const doc = await bill(store, [{ net: 0.04, code: { rate_pct: 10 } }]);
    await recognise(recognition({ sale: false, codes: PURCHASE_CODES }), store, doc, false);
    expect(await balances(store)).toEqual({ acc_ap: -0.04, acc_exp: 0.04 });
    expect((await store.get(TENANT, "Bill", String(doc.id)))!.withholding_total).toBeUndefined();
  });

  it("does not refuse a withholding that rounds to zero when it has no field to record it", async () => {
    const store = new InMemoryEntityStore();
    await chart(store);
    const doc = await bill(store, [{ net: 0.04, code: { rate_pct: 10 } }]);
    await recognise(recognition({ sale: false, codes: PURCHASE_CODES, stamp: false }), store, doc, false);
    expect(await balances(store)).toEqual({ acc_ap: -0.04, acc_exp: 0.04 });
  });

  it("overwrites a stored withholding the entry does not net out, with 0 where none was withheld", async () => {
    // A key a client could write before ADR-0421: left in place, every reader of what is owed would
    // subtract it, and a value equal to the total would read as nothing owed.
    const store = new InMemoryEntityStore();
    await chart(store);
    await store.create(TENANT, "TaxCode", { id: "vat", code: "VAT10", rate_pct: 10, kind: "vat" });
    const doc = await store.create(TENANT, "Bill", {
      bill_number: "BILL-L",
      state: "draft",
      subtotal: 100,
      tax_total: 10,
      total: 110,
      withholding_total: 110,
    });
    await store.create(TENANT, "BillLine", { bill_id: String(doc.id), amount: 100, tax_code_id: "vat" });
    await recognise(recognition({ sale: false, codes: PURCHASE_CODES }), store, doc, false);
    expect(await balances(store)).toEqual({ acc_ap: -110, acc_exp: 100, acc_in: 10 });
    expect(Number((await store.get(TENANT, "Bill", String(doc.id)))!.withholding_total)).toBe(0);
  });

  it("overwrites a stored withholding that disagrees with the one the entry netted out", async () => {
    const store = new InMemoryEntityStore();
    await chart(store);
    const doc = await bill(store, [{ net: 100, code: { rate_pct: 10 } }]);
    await store.update(TENANT, "Bill", String(doc.id), { withholding_total: 99 });
    const legacy = (await store.get(TENANT, "Bill", String(doc.id)))!;
    await recognise(recognition({ sale: false, codes: PURCHASE_CODES }), store, legacy, false);
    expect(Number((await store.get(TENANT, "Bill", String(doc.id)))!.withholding_total)).toBe(10);
  });
});

describe("bill withholding — what is owed is the total less the stamped withholding", () => {
  const apply = paymentApplicationEffect({
    documentEntity: "Bill",
    refField: "bill_id",
    settledBy: "outbound",
    settleableStates: ["approved", "overdue"],
    withholdingField: "withholding_total",
    refundedState: "refunded",
    reopenState: "approved",
    clock,
  });

  async function approvedBill(store: InMemoryEntityStore): Promise<string> {
    const doc = await store.create(TENANT, "Bill", { bill_number: "BILL-P", state: "approved", total: 100, withholding_total: 10 });
    return String(doc.id);
  }
  async function complete(store: InMemoryEntityStore, billId: string, amount: number): Promise<string> {
    const pay = await store.create(TENANT, "Payment", { bill_id: billId, direction: "outbound", amount, state: "completed" });
    await apply({
      operation: "transition",
      entity: "Payment",
      tenantId: TENANT,
      id: String(pay.id),
      before: { state: "pending" },
      after: { ...(await store.get(TENANT, "Payment", String(pay.id)))! },
      store,
    });
    return String(pay.id);
  }
  async function refund(store: InMemoryEntityStore, paymentId: string): Promise<void> {
    const before = (await store.get(TENANT, "Payment", paymentId))!;
    const after = await store.update(TENANT, "Payment", paymentId, { state: "refunded" });
    await apply({ operation: "transition", entity: "Payment", tenantId: TENANT, id: paymentId, before, after: after!, store });
  }
  const state = async (store: InMemoryEntityStore, id: string): Promise<unknown> =>
    (await store.get(TENANT, "Bill", id))!.state;

  it("settles at the net, and not before", async () => {
    const store = new InMemoryEntityStore();
    const id = await approvedBill(store);
    await complete(store, id, 89.99);
    expect(await state(store, id)).toBe("approved");
    await complete(store, id, 0.01);
    expect(await state(store, id)).toBe("paid");
    expect(typeof (await store.get(TENANT, "Bill", id))!.paid_at).toBe("string");
  });

  it("stays settled while what remains covers the net, and reopens when it does not", async () => {
    const store = new InMemoryEntityStore();
    const id = await approvedBill(store);
    const ninety = await complete(store, id, 90);
    const five = await complete(store, id, 5);
    expect(await state(store, id)).toBe("paid");
    await refund(store, five);
    expect(await state(store, id)).toBe("paid");
    await refund(store, ninety);
    expect(await state(store, id)).toBe("approved");
    // Cleared: the in-memory store keeps an assigned null as no key at all.
    expect((await store.get(TENANT, "Bill", id))!.paid_at ?? null).toBeNull();
  });

  it("revalues an open foreign bill on what is owed, not on its gross total", async () => {
    const store = new InMemoryEntityStore();
    const usd = await store.create(TENANT, "Currency", { code: "USD", name: "US Dollar" });
    const eur = await store.create(TENANT, "Currency", { code: "EUR", name: "Euro" });
    await store.create(TENANT, "ExchangeRate", {
      from_currency_id: String(eur.id),
      to_currency_id: String(usd.id),
      rate: 1.2,
      rate_date: "2026-06-29",
    });
    await store.create(TENANT, "Bill", {
      bill_number: "BILL-FX",
      state: "approved",
      total: 100,
      withholding_total: 10,
      currency: "EUR",
      booking_rate: 1.1,
    });
    const period = await store.create(TENANT, "FiscalPeriod", { status: "closing", end_date: "2026-06-30", name: "2026-06" });
    const revalue = async (withholdingField: string | undefined): Promise<number> => {
      await unrealizedFxRevaluationEffect({
        functionalCurrency: "USD",
        clock,
        documents: [
          {
            entity: "Bill",
            openStates: ["approved", "overdue"],
            payment: { refField: "bill_id", settledBy: "outbound" },
            side: "ap",
            ...(withholdingField !== undefined ? { withholdingField } : {}),
          },
        ],
      })({
        operation: "transition",
        entity: "FiscalPeriod",
        tenantId: TENANT,
        id: String(period.id),
        before: { status: "closing" },
        after: { status: "closed", end_date: "2026-06-30", name: "2026-06" },
        store,
      });
      const ap = (await store.list(TENANT, "JournalLine")).find(
        (l) => l.description === "Unrealized FX revaluation — AP EUR",
      )!;
      const credit = Number(ap.functional_credit);
      for (const l of await store.list(TENANT, "JournalLine")) await store.remove(TENANT, "JournalLine", String(l.id));
      for (const e of await store.list(TENANT, "JournalEntry")) await store.remove(TENANT, "JournalEntry", String(e.id));
      return credit;
    };
    // 90 open × (1.2 − 1.1) = 9; reading the gross would revalue 100 and credit AP 10.
    expect(await revalue("withholding_total")).toBeCloseTo(9, 6);
    expect(await revalue(undefined)).toBeCloseTo(10, 6);
  });
});

// ---- Tax remittance: every refusal comes before the first write (ADR-0467) -----------------

/** Records every write once armed, so a refusal can be shown to have preceded the first one. */
class WriteRecordingStore extends InMemoryEntityStore {
  armed = false;
  readonly writes: string[] = [];
  override create(tenantId: string, entity: string, data: EntityRecord): Promise<EntityRecord> {
    if (this.armed) this.writes.push(`create ${entity}`);
    return super.create(tenantId, entity, data);
  }
  override update(tenantId: string, entity: string, id: string, patch: EntityRecord): Promise<EntityRecord | null> {
    if (this.armed) this.writes.push(`update ${entity}`);
    return super.update(tenantId, entity, id, patch);
  }
}

const REMIT_WIRING: TaxRemittanceWiring = { entity: "TaxReturn", stateField: "state", reverseTransition: "reverse_payment" };

function remitSettings(finance: Partial<FinanceSettings> = {}, currency: string | null = "USD"): TenantSettings {
  return {
    ...(currency !== null ? { defaults: { currency } } : {}),
    finance: {
      taxPayableAccountCode: "2200",
      taxInputAccountCode: "1400",
      cashAccountCode: "1000",
      whtPayableAccountCode: "2210",
      taxRemittancePosting: "on_mark_paid",
      ...finance,
    },
  };
}

async function remitFixture(opts: { readonly lines?: ReadonlyArray<{ role: "output" | "input" | "wht"; d: number; c: number; currency?: string; fd?: number; fc?: number; entryState?: string }> } = {}) {
  const store = new WriteRecordingStore();
  const ids: Record<string, string> = {};
  for (const [role, code] of [["output", "2200"], ["input", "1400"], ["cash", "1000"], ["wht", "2210"]] as const) {
    ids[role] = String((await store.create(TENANT, "LedgerAccount", { account_code: code }))["id"]);
  }
  const lines = opts.lines ?? [
    { role: "output", d: 0, c: 1000 },
    { role: "input", d: 300, c: 0 },
  ];
  for (const [i, l] of lines.entries()) {
    const e = await store.create(TENANT, "JournalEntry", { entry_number: `SEED-${i}`, state: l.entryState ?? "posted" });
    await store.create(TENANT, "JournalLine", {
      journal_entry_id: String(e["id"]),
      ledger_account_id: ids[l.role],
      currency: l.currency ?? "USD",
      debit: l.d,
      credit: l.c,
      functional_debit: l.fd ?? (l.currency === undefined ? l.d : 0),
      functional_credit: l.fc ?? (l.currency === undefined ? l.c : 0),
    });
  }
  const filed: EntityRecord = {
    return_number: "TR-9",
    state: "filed",
    return_type: "vat",
    jurisdiction_id: "jur-1",
    period_start: "2026-01-01",
    period_end: "2026-03-31",
    output_tax: 1000,
    input_tax: 300,
    net_payable: 700,
    currency: "USD",
  };
  const tr = await store.create(TENANT, "TaxReturn", filed);
  return { store, ids, returnId: String(tr["id"]), filed: tr };
}

function payInput(store: EntityStore, id: string, before: EntityRecord, changes: EntityRecord = {}): WriteEffectInput {
  const merged = { ...before, ...changes };
  return { operation: "transition", entity: "TaxReturn", tenantId: TENANT, id, before: merged, after: { ...merged, state: "paid" }, store };
}

async function refusalOf(run: Promise<void>): Promise<PostingRefused> {
  try {
    await run;
  } catch (e) {
    if (e instanceof PostingRefused) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("taxRemittanceGlPostingEffect", () => {
  const settled = (settings: TenantSettings) => ({ get: () => Promise.resolve(settings) });

  it("posts the entry, its lines and the stamp, dated by the clock", async () => {
    const { store, ids, returnId, filed } = await remitFixture();
    const effect = taxRemittanceGlPostingEffect({ wiring: REMIT_WIRING, settingsStore: settled(remitSettings()), clock });
    store.armed = true;
    await effect(payInput(store, returnId, filed));
    expect(store.writes).toEqual([
      "create JournalEntry",
      "create JournalLine",
      "create JournalLine",
      "create JournalLine",
      "update TaxReturn",
    ]);
    const entry = (await store.listPage(TENANT, "JournalEntry", { limit: 10, cursor: null, sort: [], filters: [{ field: "entry_number", op: "eq", value: "TR-9-REMIT-1" }] })).records[0]!;
    expect(entry["entry_date"]).toBe("2026-06-21");
    expect(entry["currency"]).toBeUndefined();
    const lines = (await store.listPage(TENANT, "JournalLine", { limit: 10, cursor: null, sort: [], filters: [{ field: "journal_entry_id", op: "eq", value: String(entry["id"]) }] })).records;
    expect(lines.map((l) => [l["ledger_account_id"], l["debit"], l["credit"]])).toEqual([
      [ids["output"], 1000, 0],
      [ids["input"], 0, 300],
      [ids["cash"], 0, 700],
    ]);
    const stamped = await store.get(TENANT, "TaxReturn", returnId);
    expect(stamped?.["remitted_at"]).toBe("2026-06-21T00:00:00.000Z");
    expect(stamped?.["remittance_count"]).toBe(1);
  });

  it("writes nothing in manual_journal mode or with no settings store", async () => {
    const { store, returnId, filed } = await remitFixture();
    store.armed = true;
    await taxRemittanceGlPostingEffect({
      wiring: REMIT_WIRING,
      settingsStore: settled(remitSettings({ taxRemittancePosting: "manual_journal" })),
    })(payInput(store, returnId, filed, { net_payable: 1 }));
    await taxRemittanceGlPostingEffect({ wiring: REMIT_WIRING })(payInput(store, returnId, filed, { net_payable: 1 }));
    expect(store.writes).toEqual([]);
  });

  it.each<[string, TenantSettings, EntityRecord, string]>([
    ["figures that disagree", remitSettings(), { net_payable: 650 }, "tax_return_figures_disagree"],
    ["no functional currency", remitSettings({}, null), {}, "functional_currency_undeclared"],
    ["a foreign-currency return", remitSettings(), { currency: "EUR" }, "tax_return_currency_not_functional"],
    ["an unresolved account", remitSettings({ taxInputAccountCode: "nope" }), {}, "tax_remittance_account_unresolved"],
    ["jurisdiction routing", remitSettings({ taxAccountsByJurisdiction: { x: "2201" } }), {}, "tax_remittance_routing_unsupported"],
    ["more than the ledger holds", remitSettings(), { output_tax: 1001, net_payable: 701 }, "tax_remittance_exceeds_ledger"],
    ["more input tax than the ledger holds", remitSettings(), { input_tax: 301, net_payable: 699 }, "tax_remittance_exceeds_ledger"],
  ])("refuses %s before any write", async (_n, settings, changes, code) => {
    const { store, returnId, filed } = await remitFixture();
    store.armed = true;
    const r = await refusalOf(taxRemittanceGlPostingEffect({ wiring: REMIT_WIRING, settingsStore: settled(settings) })(payInput(store, returnId, filed, changes)));
    expect(r.error).toBe(code);
    expect(store.writes).toEqual([]);
  });

  it("refuses a tax code routing a VAT return's tax to its own account, and ignores a withholding code for it", async () => {
    const { store, returnId, filed } = await remitFixture();
    const effect = taxRemittanceGlPostingEffect({ wiring: REMIT_WIRING, settingsStore: settled(remitSettings()), taxCodes: true });
    await store.create(TENANT, "TaxCode", { code: "WHT", kind: "withholding", gl_account_code: "2299" });
    store.armed = true;
    // A withholding code's account matters only to a withholding return.
    await effect(payInput(store, returnId, filed));
    expect(store.writes[0]).toBe("create JournalEntry");
    const fresh = await remitFixture();
    await fresh.store.create(TENANT, "TaxCode", { code: "S", kind: "standard", gl_account_code: "2201" });
    fresh.store.armed = true;
    const r = await refusalOf(effect(payInput(fresh.store, fresh.returnId, fresh.filed)));
    expect(r.error).toBe("tax_remittance_routing_unsupported");
    expect(fresh.store.writes).toEqual([]);
  });

  it("refuses a withholding return when a withholding code names another account, and posts when it names the default", async () => {
    const effect = taxRemittanceGlPostingEffect({ wiring: REMIT_WIRING, settingsStore: settled(remitSettings()), taxCodes: true });
    const withholding = { return_type: "withholding", output_tax: 0, input_tax: 0, net_payable: 100 };
    const routed = await remitFixture({ lines: [{ role: "wht", d: 0, c: 500 }] });
    await routed.store.create(TENANT, "TaxCode", { code: "WHT", kind: "withholding", gl_account_code: "2299" });
    routed.store.armed = true;
    const r = await refusalOf(effect(payInput(routed.store, routed.returnId, routed.filed, withholding)));
    expect(r.error).toBe("tax_remittance_routing_unsupported");
    expect(routed.store.writes).toEqual([]);

    const own = await remitFixture({ lines: [{ role: "wht", d: 0, c: 500 }] });
    await own.store.create(TENANT, "TaxCode", { code: "WHT", kind: "withholding", gl_account_code: "2210" });
    // A regular code's account is no withholding return's concern.
    await own.store.create(TENANT, "TaxCode", { code: "S", kind: "standard", gl_account_code: "2201" });
    own.store.armed = true;
    await effect(payInput(own.store, own.returnId, own.filed, withholding));
    expect(own.store.writes[0]).toBe("create JournalEntry");
  });

  it("stamps a nil return with no entry number, so no earlier payment's number survives it", async () => {
    const { store, returnId, filed } = await remitFixture();
    await store.update(TENANT, "TaxReturn", returnId, { remittance_entry_number: "TR-9-REMIT-1" });
    const nil = { output_tax: 0, input_tax: 0, net_payable: 0, remittance_entry_number: "TR-9-REMIT-1" };
    await taxRemittanceGlPostingEffect({ wiring: REMIT_WIRING, settingsStore: settled(remitSettings()), clock })(
      payInput(store, returnId, filed, nil),
    );
    const paid = await store.get(TENANT, "TaxReturn", returnId);
    expect(paid?.["remitted_at"]).toBe("2026-06-21T00:00:00.000Z");
    expect(paid?.["remittance_entry_number"] ?? null).toBeNull();
  });

  it("locks every bounded tax account, in id order, before reading any balance", async () => {
    const { store, ids, returnId, filed } = await remitFixture();
    const events: string[] = [];
    const getLocked = store.getLocked.bind(store);
    store.getLocked = (t, entity, id, lock) => {
      events.push(`lock ${entity}${entity === "LedgerAccount" ? ` ${id}` : ""} ${lock}`);
      return getLocked(t, entity, id, lock);
    };
    const listPage = store.listPage.bind(store);
    store.listPage = (t, entity, q) => {
      if (entity === "JournalLine") events.push("read JournalLine");
      return listPage(t, entity, q);
    };
    await taxRemittanceGlPostingEffect({ wiring: REMIT_WIRING, settingsStore: settled(remitSettings()) })(
      payInput(store, returnId, filed),
    );
    const bounded = [ids["output"]!, ids["input"]!].sort();
    const firstRead = events.indexOf("read JournalLine");
    expect(events.slice(0, firstRead)).toEqual([
      "lock TaxJurisdiction exclusive",
      ...bounded.map((id) => `lock LedgerAccount ${id} exclusive`),
    ]);
    // The cash account carries no bound and is not locked.
    expect(events).not.toContain(`lock LedgerAccount ${ids["cash"]!} exclusive`);
  });

  it("counts a reversed entry's lines and not a draft entry's", async () => {
    const reversed = await remitFixture({ lines: [{ role: "output", d: 0, c: 1000, entryState: "reversed" }, { role: "input", d: 300, c: 0 }] });
    await taxRemittanceGlPostingEffect({ wiring: REMIT_WIRING, settingsStore: settled(remitSettings()) })(
      payInput(reversed.store, reversed.returnId, reversed.filed),
    );
    const draft = await remitFixture({ lines: [{ role: "output", d: 0, c: 1000, entryState: "draft" }, { role: "input", d: 300, c: 0 }] });
    draft.store.armed = true;
    const r = await refusalOf(
      taxRemittanceGlPostingEffect({ wiring: REMIT_WIRING, settingsStore: settled(remitSettings()) })(payInput(draft.store, draft.returnId, draft.filed)),
    );
    expect(r.error).toBe("tax_remittance_exceeds_ledger");
    expect(draft.store.writes).toEqual([]);
  });

  it("reads a foreign line at its functional amounts and refuses one that has none", async () => {
    const converted = await remitFixture({ lines: [{ role: "output", d: 0, c: 900, currency: "EUR", fc: 1000 }, { role: "input", d: 300, c: 0 }] });
    await taxRemittanceGlPostingEffect({ wiring: REMIT_WIRING, settingsStore: settled(remitSettings()) })(
      payInput(converted.store, converted.returnId, converted.filed),
    );
    const bare = await remitFixture({ lines: [{ role: "output", d: 0, c: 1000 }, { role: "output", d: 0, c: 5, currency: "EUR", fc: 0 }, { role: "input", d: 300, c: 0 }] });
    bare.store.armed = true;
    const r = await refusalOf(
      taxRemittanceGlPostingEffect({ wiring: REMIT_WIRING, settingsStore: settled(remitSettings()) })(payInput(bare.store, bare.returnId, bare.filed)),
    );
    expect(r.error).toBe("tax_ledger_unconverted");
    expect(bare.store.writes).toEqual([]);
  });

  it("refuses an overlapping return, and a taken entry number, before any write", async () => {
    const overlap = await remitFixture();
    await overlap.store.create(TENANT, "TaxReturn", { ...overlap.filed, id: undefined, return_number: "TR-8", state: "amended", period_start: "2026-03-31", period_end: "2026-06-30" });
    overlap.store.armed = true;
    const o = await refusalOf(
      taxRemittanceGlPostingEffect({ wiring: REMIT_WIRING, settingsStore: settled(remitSettings()) })(payInput(overlap.store, overlap.returnId, overlap.filed)),
    );
    expect(o.error).toBe("tax_return_period_overlaps");
    expect(overlap.store.writes).toEqual([]);

    const taken = await remitFixture();
    await taken.store.create(TENANT, "JournalEntry", { entry_number: "TR-9-REMIT-4", state: "posted" });
    taken.store.armed = true;
    const t = await refusalOf(
      taxRemittanceGlPostingEffect({ wiring: REMIT_WIRING, settingsStore: settled(remitSettings()) })(
        payInput(taken.store, taken.returnId, taken.filed, { remittance_count: 3 }),
      ),
    );
    expect(t.error).toBe("tax_remittance_number_taken");
    expect(taken.store.writes).toEqual([]);
  });

  it("ignores a draft or ready return's period, which has declared nothing yet", async () => {
    const f = await remitFixture();
    await f.store.create(TENANT, "TaxReturn", { ...f.filed, id: undefined, return_number: "TR-8", state: "ready" });
    await taxRemittanceGlPostingEffect({ wiring: REMIT_WIRING, settingsStore: settled(remitSettings()) })(payInput(f.store, f.returnId, f.filed));
    expect((await f.store.get(TENANT, "TaxReturn", f.returnId))?.["remittance_entry_number"]).toBe("TR-9-REMIT-1");
  });

  it("refuses posting into a closed period before any write", async () => {
    const { store, returnId, filed } = await remitFixture();
    await store.create(TENANT, "FiscalPeriod", { start_date: "2026-06-01", end_date: "2026-06-30", status: "closed" });
    store.armed = true;
    const r = await refusalOf(
      taxRemittanceGlPostingEffect({ wiring: REMIT_WIRING, settingsStore: settled(remitSettings()), periods: {}, clock })(payInput(store, returnId, filed)),
    );
    expect(r.error).toBe("period_locked");
    expect(store.writes).toEqual([]);
  });

  it("treats a remittance_count that is not a count as a fault rather than a refusal", async () => {
    const { store, returnId, filed } = await remitFixture();
    store.armed = true;
    const run = taxRemittanceGlPostingEffect({ wiring: REMIT_WIRING, settingsStore: settled(remitSettings()) })(
      payInput(store, returnId, filed, { remittance_count: "two" }),
    );
    await expect(run).rejects.toThrow(/not a count/);
    await expect(run).rejects.not.toBeInstanceOf(PostingRefused);
    expect(store.writes).toEqual([]);
  });
});

describe("the reverse_payment effects", () => {
  const settled = (settings: TenantSettings) => ({ get: () => Promise.resolve(settings) });
  const reverseInput = (store: EntityStore, id: string, record: EntityRecord): WriteEffectInput => ({
    operation: "transition",
    entity: "TaxReturn",
    tenantId: TENANT,
    id,
    before: { ...record, state: "paid" },
    after: { ...record, state: "filed" },
    store,
  });

  it("refuses, in on_mark_paid mode, a return paid with nothing posted or stamped here", async () => {
    const { store, returnId, filed } = await remitFixture();
    const check = taxRemittanceReversalCheckEffect({ wiring: REMIT_WIRING, settingsStore: settled(remitSettings()) });
    const r = await refusalOf(check(reverseInput(store, returnId, filed)));
    expect(r.error).toBe("tax_remittance_paid_outside_posting");
    // Controls: a nil return's stamp, and manual_journal mode, both let it reverse.
    await check(reverseInput(store, returnId, { ...filed, remitted_at: "2026-06-01T00:00:00.000Z" }));
    await taxRemittanceReversalCheckEffect({
      wiring: REMIT_WIRING,
      settingsStore: settled(remitSettings({ taxRemittancePosting: "manual_journal" })),
    })(reverseInput(store, returnId, filed));
  });

  it("clears the entry number with the stamp, and does so on an unstamped return too", async () => {
    const { store, returnId, filed } = await remitFixture();
    await store.update(TENANT, "TaxReturn", returnId, { remittance_entry_number: "TR-9-REMIT-1", remittance_count: 1 });
    const clear = taxRemittanceStampClearEffect({ wiring: REMIT_WIRING, clock });
    await clear(reverseInput(store, returnId, { ...filed, remittance_entry_number: "TR-9-REMIT-1" }));
    const cleared = await store.get(TENANT, "TaxReturn", returnId);
    expect(cleared?.["remittance_entry_number"] ?? null).toBeNull();
    expect(cleared?.["remitted_at"] ?? null).toBeNull();
    expect(cleared?.["remittance_count"]).toBe(1);
  });
});

describe("taxReturnFilingCheckEffect", () => {
  const settings = { get: () => Promise.resolve(remitSettings()) };

  it("refuses filing a return whose figures cannot post", async () => {
    const { store, returnId, filed } = await remitFixture();
    const before = { ...filed, state: "ready", net_payable: 650 };
    const r = await refusalOf(
      taxReturnFilingCheckEffect({ wiring: REMIT_WIRING, settingsStore: settings })({
        operation: "transition",
        entity: "TaxReturn",
        tenantId: TENANT,
        id: returnId,
        before,
        after: { ...before, state: "filed" },
        store,
      }),
    );
    expect(r.error).toBe("tax_return_figures_disagree");
  });

  it("does not ask an undone payment's return to pass what a new filing would", async () => {
    const { store, returnId, filed } = await remitFixture();
    const before = { ...filed, state: "paid", net_payable: 650 };
    store.armed = true;
    await taxReturnFilingCheckEffect({ wiring: REMIT_WIRING, settingsStore: settings })({
      operation: "transition",
      entity: "TaxReturn",
      tenantId: TENANT,
      id: returnId,
      before,
      after: { ...before, state: "filed" },
      store,
    });
    expect(store.writes).toEqual([]);
  });
});

// ADR-0475: what the auto-settlement and the refund re-open write on the document they move, and
// under which lock they read it.
describe("paymentApplicationEffect — attribution, past-due re-open and the document lock", () => {
  const config = {
    documentEntity: "Invoice",
    refField: "invoice_id",
    settledBy: "inbound",
    settleableStates: ["sent", "overdue"],
    refundedState: "refunded",
    reopenState: "sent",
    overdueState: "overdue",
    dueDateField: "due_date",
    clock,
  } as const;
  const apply = paymentApplicationEffect(config);

  /** Records every `getLocked` so the lock mode can be asserted rather than inferred. */
  class LockRecordingStore extends InMemoryEntityStore {
    readonly locks: { readonly entity: string; readonly id: string; readonly lock: string }[] = [];
    readonly plainGets: { readonly entity: string; readonly id: string }[] = [];
    override async getLocked(tenantId: string, entity: string, id: string, lock: "share" | "exclusive"): Promise<EntityRecord | null> {
      this.locks.push({ entity, id, lock });
      return super.getLocked(tenantId, entity, id, lock);
    }
    override async get(tenantId: string, entity: string, id: string): Promise<EntityRecord | null> {
      this.plainGets.push({ entity, id });
      return super.get(tenantId, entity, id);
    }
  }

  async function invoice(store: InMemoryEntityStore, dueDate: string | undefined, state = "sent"): Promise<string> {
    const inv = await store.create(TENANT, "Invoice", {
      invoice_number: "INV-R",
      state,
      total: 100,
      ...(dueDate !== undefined ? { due_date: dueDate } : {}),
      updated_by: "hand-editor",
    });
    return String(inv.id);
  }
  async function complete(store: InMemoryEntityStore, invId: string, actor: string | undefined): Promise<string> {
    const pay = await store.create(TENANT, "Payment", {
      invoice_id: invId,
      direction: "inbound",
      amount: 100,
      state: "completed",
      ...(actor !== undefined ? { updated_by: actor } : {}),
    });
    await apply({
      operation: "transition",
      entity: "Payment",
      tenantId: TENANT,
      id: String(pay.id),
      before: { state: "pending" },
      after: (await store.get(TENANT, "Payment", String(pay.id)))!,
      store,
    });
    return String(pay.id);
  }
  async function refund(store: InMemoryEntityStore, paymentId: string, actor: string): Promise<void> {
    const before = (await store.get(TENANT, "Payment", paymentId))!;
    const after = await store.update(TENANT, "Payment", paymentId, { state: "refunded", updated_by: actor });
    await apply({ operation: "transition", entity: "Payment", tenantId: TENANT, id: paymentId, before, after: after!, store });
  }
  const doc = async (store: InMemoryEntityStore, id: string) => (await store.get(TENANT, "Invoice", id))!;

  it("stamps the settling payment's actor as the document's updated_by", async () => {
    const store = new InMemoryEntityStore();
    const id = await invoice(store, "2026-07-15");
    await complete(store, id, "clerk-a");
    expect((await doc(store, id)).state).toBe("paid");
    expect((await doc(store, id)).updated_by).toBe("clerk-a");
  });

  it("stamps the refunding actor on the re-opened document", async () => {
    const store = new InMemoryEntityStore();
    const id = await invoice(store, "2026-07-15");
    const pay = await complete(store, id, "clerk-a");
    await refund(store, pay, "clerk-b");
    expect((await doc(store, id)).updated_by).toBe("clerk-b");
  });

  it("leaves updated_by alone when the trigger carries no stamp (a non-auditable entity)", async () => {
    const store = new InMemoryEntityStore();
    const id = await invoice(store, "2026-07-15");
    await complete(store, id, undefined);
    expect((await doc(store, id)).state).toBe("paid");
    expect((await doc(store, id)).updated_by).toBe("hand-editor");
  });

  it("re-opens a past-due document as overdue and a not-yet-due one as sent", async () => {
    // The clock reads 2026-06-21.
    const store = new InMemoryEntityStore();
    const pastDue = await invoice(store, "2026-06-01");
    const future = await invoice(store, "2026-07-15");
    const dueToday = await invoice(store, "2026-06-21");
    const undated = await invoice(store, undefined);
    for (const id of [pastDue, future, dueToday, undated]) {
      await refund(store, await complete(store, id, "c"), "r");
    }
    expect((await doc(store, pastDue)).state).toBe("overdue");
    expect((await doc(store, future)).state).toBe("sent");
    // Due today is not past due — `mark_overdue` would not move it either.
    expect((await doc(store, dueToday)).state).toBe("sent");
    expect((await doc(store, undated)).state).toBe("sent");
  });

  it("re-opens into reopenState when no overdue state is configured — the pre-ADR-0475 behaviour", async () => {
    const legacy = paymentApplicationEffect({ ...config, overdueState: undefined, dueDateField: undefined });
    const store = new InMemoryEntityStore();
    const id = await invoice(store, "2026-06-01");
    const pay = await store.create(TENANT, "Payment", { invoice_id: id, direction: "inbound", amount: 100, state: "completed" });
    await legacy({ operation: "transition", entity: "Payment", tenantId: TENANT, id: String(pay.id), before: { state: "pending" }, after: pay, store });
    const after = await store.update(TENANT, "Payment", String(pay.id), { state: "refunded" });
    await legacy({ operation: "transition", entity: "Payment", tenantId: TENANT, id: String(pay.id), before: pay, after: after!, store });
    expect((await doc(store, id)).state).toBe("sent");
  });

  it("refuses to be configured with an overdue state and no due date, or the reverse", () => {
    expect(() => paymentApplicationEffect({ ...config, dueDateField: undefined })).toThrow(/together/);
    expect(() => paymentApplicationEffect({ ...config, overdueState: undefined })).toThrow(/together/);
  });

  it("reopenStateFor compares the due date's day against today", () => {
    const c = { reopenState: "sent", overdueState: "overdue", dueDateField: "due_date" };
    expect(reopenStateFor({ due_date: "2026-06-20" }, "2026-06-21", c)).toBe("overdue");
    expect(reopenStateFor({ due_date: "2026-06-21T23:00:00.000Z" }, "2026-06-21", c)).toBe("sent");
    expect(reopenStateFor({ due_date: "not a date" }, "2026-06-21", c)).toBe("sent");
    expect(reopenStateFor({ due_date: "2026-06-20" }, "2026-06-21", { reopenState: "sent" })).toBe("sent");
  });

  it("reads the document under an exclusive lock on both the settle and the refund path", async () => {
    const store = new LockRecordingStore();
    const id = await invoice(store, "2026-07-15");
    const pay = await complete(store, id, "c");
    await refund(store, pay, "r");
    expect(store.locks.filter((l) => l.entity === "Invoice")).toEqual([
      { entity: "Invoice", id, lock: "exclusive" },
      { entity: "Invoice", id, lock: "exclusive" },
    ]);
    // The lock is the read: no plain `get` of the document decides anything beside it. (The
    // in-memory `getLocked` reads through `get`, so each locked read shows here once.)
    expect(store.plainGets.filter((g) => g.entity === "Invoice")).toHaveLength(2);
  });

  it("serialises a refund behind mark_paid on the document, so the refund sees paid and re-opens it", async () => {
    // The write skew of ADR-0433 Q5 in-process: `mark_paid` holds the document exclusively while it
    // decides, and the refund's re-open asks for the same lock. Under a plain read the refund read
    // `sent`, returned, and the invoice was then marked paid with nothing applied.
    const store = new InMemoryEntityStore();
    const id = await invoice(store, "2026-07-15");
    const pay = await store.create(TENANT, "Payment", { invoice_id: id, direction: "inbound", amount: 100, state: "completed" });
    let releaseMarkPaid!: () => void;
    const markPaidHolds = new Promise<void>((r) => (releaseMarkPaid = r));
    let markPaidLocked!: () => void;
    const locked = new Promise<void>((r) => (markPaidLocked = r));
    const markPaid = store.withTransaction(TENANT, async (tx) => {
      await tx.getLocked(TENANT, "Invoice", id, "exclusive");
      markPaidLocked();
      await markPaidHolds;
      await tx.update(TENANT, "Invoice", id, { state: "paid" });
    });
    await locked;
    const refundDone = store.withTransaction(TENANT, async (tx) => {
      const before = (await tx.get(TENANT, "Payment", String(pay.id)))!;
      const after = await tx.update(TENANT, "Payment", String(pay.id), { state: "refunded" });
      await apply({ operation: "transition", entity: "Payment", tenantId: TENANT, id: String(pay.id), before, after: after!, store: tx });
    });
    // The refund is parked on the lock: the invoice is still `sent` and unreleased.
    await new Promise((r) => setTimeout(r, 20));
    expect((await doc(store, id)).state).toBe("sent");
    releaseMarkPaid();
    await Promise.all([markPaid, refundDone]);
    expect((await doc(store, id)).state).toBe("sent");
  });
});
