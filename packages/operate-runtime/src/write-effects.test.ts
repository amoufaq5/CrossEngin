import { describe, expect, it } from "vitest";

import { InMemoryEntityStore } from "./store.js";
import {
  creditNoteGlPostingEffect,
  invoiceVoidCreditNoteEffect,
  journalReversalEffect,
  runWriteEffects,
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
