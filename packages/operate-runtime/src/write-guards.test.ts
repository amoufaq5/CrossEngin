import { describe, expect, it } from "vitest";

import { InMemoryEntityStore, type ListPage, type ListQuery } from "./store.js";
import {
  APPLIED_PAYMENT_EPSILON,
  journalPostingGuard,
  lockedDocumentGuard,
  postedEntryImmutabilityGuard,
  readAppliedPayments,
  readAppliedToDocument,
  runWriteGuards,
  SETTLED_DOCUMENT_STATE,
  SETTLEMENT_COVERAGE_DOCUMENTS,
  settlementCoverageGuard,
  settlementIsCovered,
  type WriteGuardInput,
} from "./write-guards.js";

const TENANT = "11111111-1111-1111-1111-111111111111";

/** One `[debit, credit]` pair per journal line. */
type LineAmounts = readonly [number, number];

function rep(n: number, row: LineAmounts): LineAmounts[] {
  return Array.from({ length: n }, () => row);
}

async function seedWith(store: InMemoryEntityStore, rows: readonly LineAmounts[]): Promise<string> {
  const entry = await store.create(TENANT, "JournalEntry", { state: "draft", fiscal_period_id: "p_open" });
  await store.create(TENANT, "FiscalPeriod", { id: "p_open", status: "open" });
  const entryId = String(entry.id);
  for (const [debit, credit] of rows) {
    await store.create(TENANT, "JournalLine", { journal_entry_id: entryId, debit, credit });
  }
  return entryId;
}

async function seed() {
  const store = new InMemoryEntityStore();
  const entryId = await seedWith(store, []);
  await store.create(TENANT, "FiscalPeriod", { id: "p_locked", status: "locked" });
  return { store, entryId };
}

function postInput(store: InMemoryEntityStore, entryId: string, after: Record<string, unknown>): WriteGuardInput {
  return {
    operation: "update",
    entity: "JournalEntry",
    tenantId: TENANT,
    id: entryId,
    before: { state: "draft" },
    after: { state: "posted", ...after },
    store,
  };
}

describe("journalPostingGuard", () => {
  const guard = journalPostingGuard();

  it("passes a write that isn't a draft→posted transition", async () => {
    const { store, entryId } = await seed();
    const input: WriteGuardInput = {
      operation: "update",
      entity: "JournalEntry",
      tenantId: TENANT,
      id: entryId,
      before: { state: "draft" },
      after: { state: "draft", memo: "x" },
      store,
    };
    expect(await guard(input)).toBeNull();
  });

  it("ignores entities other than JournalEntry", async () => {
    const { store } = await seed();
    expect(
      await guard({ operation: "create", entity: "Invoice", tenantId: TENANT, id: null, before: null, after: { state: "posted" }, store }),
    ).toBeNull();
  });

  it("blocks posting an entry with no lines", async () => {
    const { store, entryId } = await seed();
    const r = await guard(postInput(store, entryId, { fiscal_period_id: "p_open" }));
    expect(r?.error).toBe("empty_journal_entry");
  });

  it("blocks an unbalanced entry", async () => {
    const { store, entryId } = await seed();
    await store.create(TENANT, "JournalLine", { journal_entry_id: entryId, debit: 100, credit: 0 });
    await store.create(TENANT, "JournalLine", { journal_entry_id: entryId, debit: 0, credit: 60 });
    const r = await guard(postInput(store, entryId, { fiscal_period_id: "p_open" }));
    expect(r?.status).toBe(422);
    expect(r?.error).toBe("unbalanced_journal_entry");
  });

  it("allows a balanced entry into an open period", async () => {
    const { store, entryId } = await seed();
    await store.create(TENANT, "JournalLine", { journal_entry_id: entryId, debit: 100, credit: 0 });
    await store.create(TENANT, "JournalLine", { journal_entry_id: entryId, debit: 0, credit: 100 });
    expect(await guard(postInput(store, entryId, { fiscal_period_id: "p_open" }))).toBeNull();
  });

  it("blocks posting into a locked period before checking balance", async () => {
    const { store, entryId } = await seed();
    await store.create(TENANT, "JournalLine", { journal_entry_id: entryId, debit: 100, credit: 100 });
    const r = await guard(postInput(store, entryId, { fiscal_period_id: "p_locked" }));
    expect(r?.error).toBe("period_locked");
  });

  it("tolerates sub-cent rounding noise", async () => {
    const { store, entryId } = await seed();
    await store.create(TENANT, "JournalLine", { journal_entry_id: entryId, debit: 100, credit: 0 });
    await store.create(TENANT, "JournalLine", { journal_entry_id: entryId, debit: 0, credit: 100.004 });
    expect(await guard(postInput(store, entryId, { fiscal_period_id: "p_open" }))).toBeNull();
  });

  // The two directions a capped prefix got wrong, pinned at the cap that produced them and again at
  // a ceiling the set fits under. Both shapes are 1001 lines, which is how they were measured.
  it("no longer lets a balancing prefix hide a later imbalance", async () => {
    // 500 debits of 100 and 500 credits of 100 balance exactly; the 1001st line is a debit of 9999,
    // so the entry is really out by 9999. At a cap of 1000 the guard used to answer `null` and the
    // entry posted unbalanced — a balancing prefix is the ordinary shape, because every GL posting
    // effect writes its lines as a balanced group.
    const store = new InMemoryEntityStore();
    const entryId = await seedWith(store, [...rep(500, [100, 0]), ...rep(500, [0, 100]), [9999, 0]]);
    const post = postInput(store, entryId, { fiscal_period_id: "p_open" });
    expect(await journalPostingGuard({ maxLines: 1000 })(post)).toEqual({
      status: 422,
      error: "unverifiable_journal_entry",
      detail: expect.stringContaining("more than 1000 lines"),
    });
    // Read in full, the imbalance is the verdict and the detail carries the entry's real totals.
    expect(await guard(post)).toEqual({
      status: 422,
      error: "unbalanced_journal_entry",
      detail: "debits (59999.00) must equal credits (50000.00)",
    });
  });

  it("no longer refuses a balanced entry with a detail describing only its prefix", async () => {
    // 1000 debits of 10 then one credit of 10000. At a cap of 1000 this correct entry was refused
    // `unbalanced_journal_entry: debits (10000.00) must equal credits (0.00)`.
    const store = new InMemoryEntityStore();
    const entryId = await seedWith(store, [...rep(1000, [10, 0]), [0, 10_000]]);
    const post = postInput(store, entryId, { fiscal_period_id: "p_open" });
    expect(await guard(post)).toBeNull();
    expect((await journalPostingGuard({ maxLines: 1000 })(post))?.error).toBe("unverifiable_journal_entry");
  });

  it("names the ceiling and no remedy when the line set exceeds it", async () => {
    const store = new InMemoryEntityStore();
    const entryId = await seedWith(store, rep(12, [10, 10]));
    const r = await journalPostingGuard({ maxLines: 4 })(postInput(store, entryId, { fiscal_period_id: "p_open" }));
    expect(r?.status).toBe(422);
    expect(r?.error).toBe("unverifiable_journal_entry");
    expect(r?.detail).toContain("more than 4 lines");
    expect(r?.detail).toContain("whole set");
    // `maxLines` is reachable by no CLI flag, no manifest field and no environment variable, so a
    // detail telling an operator to raise it would name a remedy they cannot perform.
    expect(r?.detail).not.toMatch(/maxLines|raise|increase|retry/i);
  });

  it("refuses an incomplete read rather than a balance verdict over the prefix", async () => {
    // The prefix balances exactly, so both balance verdicts are reachable from it and neither is
    // the entry's: the first four lines are 10/10 pairs and the fifth is a bare debit of 500.
    const store = new InMemoryEntityStore();
    const entryId = await seedWith(store, [...rep(4, [10, 10]), [500, 0]]);
    const r = await journalPostingGuard({ maxLines: 4 })(postInput(store, entryId, { fiscal_period_id: "p_open" }));
    expect(r?.error).toBe("unverifiable_journal_entry");
  });

  it("still names an empty entry when the empty set fit under the ceiling", async () => {
    // Zero matched lines with nothing left to read is a complete read of an empty set, so the
    // ceiling refusal must not swallow the message that names what to fix.
    const { store, entryId } = await seed();
    const r = await journalPostingGuard({ maxLines: 1 })(postInput(store, entryId, { fiscal_period_id: "p_open" }));
    expect(r?.error).toBe("empty_journal_entry");
  });

  it("does not call an entry empty on the strength of a read that never ran", async () => {
    // A ceiling of 0 reads no rows at all, so "this entry has no lines" is not a fact in hand —
    // and without the completeness conjunct on the empty check, nothing distinguishes the two.
    const store = new InMemoryEntityStore();
    const entryId = await seedWith(store, rep(2, [10, 10]));
    const r = await journalPostingGuard({ maxLines: 0 })(postInput(store, entryId, { fiscal_period_id: "p_open" }));
    expect(r?.error).toBe("unverifiable_journal_entry");
  });

  it("totals a balanced entry that spans several pages", async () => {
    class CountingStore extends InMemoryEntityStore {
      linePages = 0;
      override async listPage(tenantId: string, entity: string, query: ListQuery): Promise<ListPage> {
        if (entity === "JournalLine") this.linePages += 1;
        return super.listPage(tenantId, entity, query);
      }
    }
    const store = new CountingStore();
    const entryId = await seedWith(store, [...rep(1200, [10, 0]), [0, 12_000]]);
    expect(await guard(postInput(store, entryId, { fiscal_period_id: "p_open" }))).toBeNull();
    // 1201 lines at the drain's 500-row page: measured at exactly three round trips, the third
    // short and carrying the null cursor that ends the walk.
    expect(store.linePages).toBe(3);
  });

  it("leaves the create path alone: the balance arm is unreachable without an entry id", async () => {
    // `input.id` is null on a create and the body carries no id either, so the guard returns before
    // it reads a line — a `POST {state:"posted"}` with no lines passes. That is a separate defect
    // and this refusal must not have moved it in either direction.
    const store = new InMemoryEntityStore();
    const input: WriteGuardInput = {
      operation: "create",
      entity: "JournalEntry",
      tenantId: TENANT,
      id: null,
      before: null,
      after: { state: "posted" },
      store,
    };
    expect(await guard(input)).toBeNull();
    expect(await journalPostingGuard({ maxLines: 0 })(input)).toBeNull();
  });
});

describe("postedEntryImmutabilityGuard", () => {
  const guard = postedEntryImmutabilityGuard();
  const store = new InMemoryEntityStore();

  function entryInput(op: WriteGuardInput["operation"], before: Record<string, unknown>, after: Record<string, unknown>): WriteGuardInput {
    return { operation: op, entity: "JournalEntry", tenantId: TENANT, id: "e1", before, after, store };
  }

  it("ignores entries that aren't posted", async () => {
    expect(await guard(entryInput("update", { state: "draft" }, { state: "draft", memo: "x" }))).toBeNull();
  });

  it("blocks deleting a posted entry", async () => {
    const r = await guard(entryInput("delete", { state: "posted" }, { state: "posted" }));
    expect(r?.error).toBe("posted_entry_immutable");
  });

  it("blocks editing a posted entry's fields", async () => {
    const r = await guard(entryInput("update", { state: "posted", memo: "a" }, { state: "posted", memo: "b", updated_at: "t" }));
    expect(r?.error).toBe("posted_entry_immutable");
  });

  it("allows reversing a posted entry (state -> reversed, nothing else)", async () => {
    expect(await guard(entryInput("update", { state: "posted", memo: "a" }, { state: "reversed", memo: "a", updated_at: "t" }))).toBeNull();
  });

  it("blocks a reversal that also edits other fields", async () => {
    const r = await guard(entryInput("update", { state: "posted", memo: "a" }, { state: "reversed", memo: "b" }));
    expect(r?.error).toBe("posted_entry_immutable");
  });

  it("locks lines of a posted parent entry", async () => {
    const s = new InMemoryEntityStore();
    const posted = await s.create(TENANT, "JournalEntry", { state: "posted" });
    const draft = await s.create(TENANT, "JournalEntry", { state: "draft" });
    const lineInput = (entryId: string): WriteGuardInput => ({
      operation: "create",
      entity: "JournalLine",
      tenantId: TENANT,
      id: null,
      before: null,
      after: { journal_entry_id: entryId, debit: 10, credit: 0 },
      store: s,
    });
    expect((await postedEntryImmutabilityGuard()(lineInput(String(posted.id))))?.error).toBe("posted_entry_locked_lines");
    expect(await postedEntryImmutabilityGuard()(lineInput(String(draft.id)))).toBeNull();
  });
});

describe("lockedDocumentGuard — issued invoice", () => {
  const guard = lockedDocumentGuard({
    entity: "Invoice",
    lockedStates: ["sent", "overdue", "paid", "void"],
    childEntity: "InvoiceLine",
    childParentField: "invoice_id",
    lockedError: "invoice_locked",
    childLockedError: "invoice_locked_lines",
    noun: "issued invoice",
  });
  const store = new InMemoryEntityStore();
  const inv = (op: WriteGuardInput["operation"], before: Record<string, unknown>, after: Record<string, unknown>): WriteGuardInput =>
    ({ operation: op, entity: "Invoice", tenantId: TENANT, id: "i1", before, after, store });

  it("allows editing a draft invoice", async () => {
    expect(await guard(inv("update", { state: "draft" }, { state: "draft", total: 9 }))).toBeNull();
  });

  it("blocks editing a sent invoice", async () => {
    expect((await guard(inv("update", { state: "sent", total: 5 }, { state: "sent", total: 9 })))?.error).toBe("invoice_locked");
  });

  it("blocks deleting a paid invoice", async () => {
    expect((await guard(inv("delete", { state: "paid" }, { state: "paid" })))?.error).toBe("invoice_locked");
  });

  it("allows a lifecycle transition on a sent invoice (e.g. void/mark_paid)", async () => {
    expect(await guard(inv("transition", { state: "sent" }, { state: "void" }))).toBeNull();
  });

  it("locks the lines of an issued invoice", async () => {
    const s = new InMemoryEntityStore();
    const sent = await s.create(TENANT, "Invoice", { state: "sent" });
    const draft = await s.create(TENANT, "Invoice", { state: "draft" });
    const line = (invoiceId: string): WriteGuardInput => ({
      operation: "update",
      entity: "InvoiceLine",
      tenantId: TENANT,
      id: "l1",
      before: { invoice_id: invoiceId, amount: 1 },
      after: { invoice_id: invoiceId, amount: 2 },
      store: s,
    });
    expect((await guard(line(String(sent.id))))?.error).toBe("invoice_locked_lines");
    expect(await guard(line(String(draft.id)))).toBeNull();
  });
});

describe("lockedDocumentGuard — filed tax return", () => {
  const guard = lockedDocumentGuard({ entity: "TaxReturn", lockedStates: ["filed", "paid"], lockedError: "tax_return_locked", noun: "filed tax return" });
  const store = new InMemoryEntityStore();
  const tr = (op: WriteGuardInput["operation"], before: Record<string, unknown>, after: Record<string, unknown>): WriteGuardInput =>
    ({ operation: op, entity: "TaxReturn", tenantId: TENANT, id: "t1", before, after, store });

  it("allows editing a draft/ready return", async () => {
    expect(await guard(tr("update", { state: "ready" }, { state: "ready", net_payable: 5 }))).toBeNull();
  });

  it("blocks editing a filed return", async () => {
    expect((await guard(tr("update", { state: "filed" }, { state: "filed", net_payable: 9 })))?.error).toBe("tax_return_locked");
  });

  it("blocks deleting a filed return", async () => {
    expect((await guard(tr("delete", { state: "filed" }, { state: "filed" })))?.error).toBe("tax_return_locked");
  });

  it("allows the amend transition on a filed return", async () => {
    expect(await guard(tr("transition", { state: "filed" }, { state: "amended" }))).toBeNull();
  });
});

describe("lockedDocumentGuard — committed sales / purchase orders", () => {
  const store = new InMemoryEntityStore();
  const so = lockedDocumentGuard({
    entity: "SalesOrder",
    lockedStates: ["confirmed", "fulfilled", "invoiced", "closed", "placed", "returned"],
    childEntity: "SalesOrderLine",
    childParentField: "sales_order_id",
    lockedError: "sales_order_locked",
    childLockedError: "sales_order_locked_lines",
  });
  const po = lockedDocumentGuard({
    entity: "PurchaseOrder",
    lockedStates: ["submitted", "approved", "received", "closed"],
    childEntity: "PurchaseOrderLine",
    childParentField: "purchase_order_id",
    lockedError: "purchase_order_locked",
    childLockedError: "purchase_order_locked_lines",
  });
  const inp = (entity: string, op: WriteGuardInput["operation"], before: Record<string, unknown>, after: Record<string, unknown>): WriteGuardInput =>
    ({ operation: op, entity, tenantId: TENANT, id: "x1", before, after, store });

  it("allows editing a draft order, blocks editing/deleting a committed one", async () => {
    expect(await so(inp("SalesOrder", "update", { state: "draft" }, { state: "draft", total: 5 }))).toBeNull();
    expect((await so(inp("SalesOrder", "update", { state: "confirmed" }, { state: "confirmed", total: 9 })))?.error).toBe("sales_order_locked");
    expect((await po(inp("PurchaseOrder", "delete", { state: "approved" }, { state: "approved" })))?.error).toBe("purchase_order_locked");
  });

  it("allows lifecycle transitions (e.g. cancel) on a committed order", async () => {
    expect(await so(inp("SalesOrder", "transition", { state: "confirmed" }, { state: "cancelled" }))).toBeNull();
    expect(await po(inp("PurchaseOrder", "transition", { state: "approved" }, { state: "cancelled" }))).toBeNull();
  });

  it("locks the lines of a committed order", async () => {
    const s = new InMemoryEntityStore();
    const order = await s.create(TENANT, "PurchaseOrder", { state: "approved" });
    const g = lockedDocumentGuard({
      entity: "PurchaseOrder",
      lockedStates: ["approved"],
      childEntity: "PurchaseOrderLine",
      childParentField: "purchase_order_id",
      childLockedError: "purchase_order_locked_lines",
    });
    const line: WriteGuardInput = {
      operation: "update",
      entity: "PurchaseOrderLine",
      tenantId: TENANT,
      id: "pl1",
      before: { purchase_order_id: String(order.id), qty: 1 },
      after: { purchase_order_id: String(order.id), qty: 2 },
      store: s,
    };
    expect((await g(line))?.error).toBe("purchase_order_locked_lines");
  });
});

describe("runWriteGuards", () => {
  it("returns the first block and short-circuits", async () => {
    const calls: string[] = [];
    const ok = async () => {
      calls.push("ok");
      return null;
    };
    const block = async () => {
      calls.push("block");
      return { status: 422, error: "nope" };
    };
    const never = async () => {
      calls.push("never");
      return null;
    };
    const input = {} as WriteGuardInput;
    const r = await runWriteGuards([ok, block, never], input);
    expect(r?.error).toBe("nope");
    expect(calls).toEqual(["ok", "block"]);
  });
});

// ---- Applied payments + settlement coverage ---------------------------------

const DOC = "doc-1";

async function payment(
  store: InMemoryEntityStore,
  row: Record<string, unknown>,
): Promise<void> {
  await store.create(TENANT, "Payment", { state: "completed", amount: 0, ...row });
}

function coverageInput(
  store: InMemoryEntityStore,
  over: Partial<WriteGuardInput> & { readonly after: Record<string, unknown> },
): WriteGuardInput {
  return {
    operation: "transition",
    entity: "Invoice",
    tenantId: TENANT,
    id: DOC,
    before: { state: "sent", total: 100 },
    store,
    ...over,
  };
}

describe("readAppliedPayments / readAppliedToDocument", () => {
  it("sums only completed payments, and only ones naming the document", async () => {
    const store = new InMemoryEntityStore();
    await payment(store, { amount: 30, invoice_id: DOC });
    await payment(store, { amount: 70, invoice_id: DOC, state: "pending" });
    await payment(store, { amount: 11, invoice_id: "other" });
    const read = await readAppliedToDocument(store, TENANT, "invoice_id", DOC, { ceiling: 100 });
    expect(read).toEqual({ applied: 30, complete: true });
  });

  it("does not stop once the running total crosses a threshold", async () => {
    // The measured defect the no-early-stop rule exists for: a later page carrying a negative
    // correction takes the total back under. 1100 payments forces three pages at the 500 default,
    // so the correction is genuinely on a page after the one that crossed 400.
    const store = new InMemoryEntityStore();
    for (let i = 0; i < 1099; i += 1) await payment(store, { amount: 1, invoice_id: DOC });
    await payment(store, { amount: -1000, invoice_id: DOC });
    const read = await readAppliedToDocument(store, TENANT, "invoice_id", DOC, { ceiling: 5000 });
    expect(read.applied).toBe(99);
    expect(read.complete).toBe(true);
  });

  it("keeps one map per bucket, so two documents sharing an id never merge", async () => {
    // The invariant three independent spellings of this fold each re-derived in a comment: a
    // caller-supplied `id` is not stripped and records are bucketed per (tenant, entity), so a
    // single map keyed by document id would credit the invoice with the bill's money.
    const store = new InMemoryEntityStore();
    await payment(store, { amount: 40, bill_id: "shared" });
    const read = await readAppliedPayments(store, TENANT, ["invoice_id", "bill_id"], {
      ceiling: 100,
    });
    expect(read.applied[0]!.get("shared")).toBeUndefined();
    expect(read.applied[1]!.get("shared")).toBe(40);
  });

  it("answers positionally, one map per requested ref field", async () => {
    const store = new InMemoryEntityStore();
    await payment(store, { amount: 5, invoice_id: "i" });
    const read = await readAppliedPayments(store, TENANT, ["bill_id", "invoice_id"], { ceiling: 9 });
    expect(read.applied).toHaveLength(2);
    expect(read.applied[0]!.size).toBe(0);
    expect(read.applied[1]!.get("i")).toBe(5);
  });

  it("skips a non-string reference rather than coercing it", async () => {
    // `reference` is `acceptAny` in FIELD_TYPE_CHECKS, so `{"invoice_id": 42}` is a body the
    // validator admits and the JSONB store round-trips as a number. Of the three spellings this
    // replaced, two skipped such a row and one counted it — so they disagreed about a reachable
    // record, and the strict form is fail-closed for both readers: `applied` understated makes the
    // guard refuse and the effect decline to settle.
    const store = new InMemoryEntityStore();
    await payment(store, { amount: 50, invoice_id: 42 });
    const read = await readAppliedToDocument(store, TENANT, "invoice_id", "42", { ceiling: 100 });
    expect(read.applied).toBe(0);
  });

  it("reports an exceeded ceiling rather than truncating in silence", async () => {
    const store = new InMemoryEntityStore();
    for (let i = 0; i < 5; i += 1) await payment(store, { amount: 1, invoice_id: DOC });
    const read = await readAppliedToDocument(store, TENANT, "invoice_id", DOC, { ceiling: 2 });
    expect(read.complete).toBe(false);
  });
});

describe("settlementIsCovered", () => {
  it("is the exact complement of the effect's settle condition", () => {
    // The pair is only sound if the two agree exactly, which is why this is one function:
    // `paymentApplicationEffect` settles when this is true and the guard refuses when it is false.
    expect(settlementIsCovered(100, 100)).toBe(true);
    expect(settlementIsCovered(100, 99.996)).toBe(true); // inside the epsilon
    expect(settlementIsCovered(100, 99.99)).toBe(false);
    expect(settlementIsCovered(100, 101)).toBe(true);
  });

  it("covers a total of zero or less, which is what makes an absent total unguardable", () => {
    // `num(undefined)` is 0, so a guard built for an entity with no total field would pass every
    // write — the reason `TaxReturn` is declared uncoverable rather than given a weaker predicate.
    expect(settlementIsCovered(0, 0)).toBe(true);
    expect(settlementIsCovered(-50, 0)).toBe(true);
  });

  it("uses the epsilon the module exports, not a second constant", () => {
    expect(settlementIsCovered(100, 100 - APPLIED_PAYMENT_EPSILON)).toBe(true);
    expect(settlementIsCovered(100, 100 - APPLIED_PAYMENT_EPSILON * 2)).toBe(false);
  });
});

describe("settlementCoverageGuard", () => {
  const guard = settlementCoverageGuard({ entity: "Invoice", refField: "invoice_id", noun: "an invoice" });

  it("blocks a transition into paid while payments fall short", async () => {
    const store = new InMemoryEntityStore();
    await payment(store, { amount: 50, invoice_id: DOC });
    const r = await guard(coverageInput(store, { after: { state: "paid", total: 120 } }));
    expect(r?.status).toBe(422);
    expect(r?.error).toBe("uncovered_settlement");
    // The figure is in the detail: the caller holds `update`/`mark_paid` on this document, which on
    // every shipped pack is a subset of its `read` grant, so 70.00 of 120.00 discloses nothing they
    // could not already compute.
    expect(r?.detail).toContain("70.00 of 120.00");
    expect(r?.detail).toContain("record the remaining payment");
  });

  it("allows it once completed payments cover the total", async () => {
    const store = new InMemoryEntityStore();
    await payment(store, { amount: 120, invoice_id: DOC });
    expect(await guard(coverageInput(store, { after: { state: "paid", total: 120 } }))).toBeNull();
  });

  it("blocks a plain PATCH that sets state=paid, not only a transition", async () => {
    // The largest thing an operation-keyed guard would miss. `state` is an ordinary enum field,
    // neither Invoice nor Bill declares a field-level permission, and `lockedDocumentGuard` returns
    // null when the BEFORE state is unlocked — so `PATCH {"state":"paid"}` from `draft` lands.
    const store = new InMemoryEntityStore();
    const r = await guard(
      coverageInput(store, {
        operation: "update",
        before: { state: "draft", total: 120 },
        after: { state: "paid", total: 120 },
      }),
    );
    expect(r?.error).toBe("uncovered_settlement");
  });

  it("blocks a create that carries state=paid", async () => {
    // `before` is null, so the `!==` arm admits it by construction rather than by a third clause.
    const store = new InMemoryEntityStore();
    const r = await guard(
      coverageInput(store, {
        operation: "create",
        id: null,
        before: null,
        after: { state: "paid", total: 10 },
      }),
    );
    expect(r?.error).toBe("uncovered_settlement");
  });

  it("passes a write that is not entering the settled state", async () => {
    const store = new InMemoryEntityStore();
    expect(await guard(coverageInput(store, { after: { state: "overdue", total: 120 } }))).toBeNull();
  });

  it("passes a write of an already-settled document", async () => {
    // The second conjunct. Re-saving a paid document must not be refused for a shortfall that was
    // accepted when it was marked paid — otherwise the hatch would be the only way to edit one.
    // This is also the control for the raised-total arm below: the total is unchanged here.
    const store = new InMemoryEntityStore();
    const r = await guard(
      coverageInput(store, {
        operation: "update",
        before: { state: "paid", total: 120 },
        after: { state: "paid", total: 120, notes: "x" },
      }),
    );
    expect(r).toBeNull();
  });

  it("blocks raising the total of a document that is already settled", async () => {
    // The edge-only predicate let this through, and an adversarial pass reached it in **two
    // ordinary writes** as `ap_clerk` on the shipped pack: create a Bill `approved, total 0`,
    // `mark_paid` (allowed by the nothing-owed arm, correctly), then `PATCH {"total":120}`. The
    // result was `paid` with 120 owed and no payments — the exact divergence this guard exists to
    // close — on the one entity nothing else protects, since `Invoice` is incidentally covered by
    // `paid` being one of its `lockedStates` and `Bill` has no locked-document guard at all.
    const store = new InMemoryEntityStore();
    const r = await guard(
      coverageInput(store, {
        operation: "update",
        before: { state: "paid", total: 0 },
        after: { state: "paid", total: 120 },
      }),
    );
    expect(r?.error).toBe("uncovered_settlement");
    expect(r?.detail).toContain("120.00 of 120.00");
    // "leave" rather than "mark": on this arm the document is already settled and the caller is
    // raising what it owes, so the old wording described a write nobody made.
    expect(r?.detail).toContain("cannot leave");
  });

  it("passes a correction that lowers the total of a settled document", async () => {
    // `owesMore` is a comparison and not a presence test, so a write-down of a paid document — the
    // ordinary correction — is still allowed. Without this the only way to reduce a paid
    // document's total would be the deployment-wide hatch.
    const store = new InMemoryEntityStore();
    const r = await guard(
      coverageInput(store, {
        operation: "update",
        before: { state: "paid", total: 120 },
        after: { state: "paid", total: 90 },
      }),
    );
    expect(r).toBeNull();
  });

  it("refuses a total it cannot read rather than treating it as nothing owed", async () => {
    // `num` collapses a non-numeric value to 0, so without this the `total <= 0` arm allowed the
    // write: a document whose stored total is `"n/a"` was marked paid, read `paid`, and was dropped
    // by the aging report in silence. ADR-0367's rule — a decision from a quantity that could not
    // be read is not a decision — and the fourth cause of an unreadable figure, the only one where
    // allowing is the wrong answer.
    const store = new InMemoryEntityStore();
    const r = await guard(coverageInput(store, { after: { state: "paid", total: "n/a" } }));
    expect(r?.status).toBe(422);
    expect(r?.error).toBe("settlement_coverage_unverifiable");
    expect(r?.detail).toContain("is not a number");
  });

  it("reads the state field it was configured with, not the fallback", async () => {
    // The guard reads the state field BY NAME, so a manifest whose lifecycle drives `status` got an
    // inert guard — `after["state"]` is undefined, every write answers null — while the boot survey
    // went on naming the entity as guarded. `defaultWriteGuards` sets this from the lifecycle now;
    // this is the config arm that makes that wiring mean something.
    const store = new InMemoryEntityStore();
    const statusKeyed = settlementCoverageGuard({
      entity: "Invoice",
      refField: "invoice_id",
      stateField: "status",
    });
    const r = await statusKeyed(coverageInput(store, { after: { status: "paid", total: 120 } }));
    expect(r?.error).toBe("uncovered_settlement");
    // And the fallback-keyed guard is blind to exactly that document, which is the defect.
    expect(await guard(coverageInput(store, { after: { status: "paid", total: 120 } }))).toBeNull();
  });

  it("can never fire on a delete, because the handler passes after = before", async () => {
    const store = new InMemoryEntityStore();
    const r = await guard(
      coverageInput(store, {
        operation: "delete",
        before: { state: "paid", total: 120 },
        after: { state: "paid", total: 120 },
      }),
    );
    expect(r).toBeNull();
  });

  it("ignores another entity", async () => {
    const store = new InMemoryEntityStore();
    const r = await guard(coverageInput(store, { entity: "Bill", after: { state: "paid", total: 120 } }));
    expect(r).toBeNull();
  });

  it("passes a document with nothing owed without reading any payment", async () => {
    class CountingStore extends InMemoryEntityStore {
      reads = 0;
      override async listPage(t: string, e: string, q: ListQuery): Promise<ListPage> {
        this.reads += 1;
        return super.listPage(t, e, q);
      }
    }
    const store = new CountingStore();
    expect(await guard(coverageInput(store, { after: { state: "paid", total: 0 } }))).toBeNull();
    expect(store.reads).toBe(0);
  });

  it("REFUSES on an exceeded ceiling rather than deciding from a prefix", async () => {
    // `READ_CEILING_EFFECT.guard` is `refuses`: a decision from a prefix is not a decision, and the
    // direction is not even bounded, since nothing enforces `Payment.amount`'s `min: 0`.
    const store = new InMemoryEntityStore();
    for (let i = 0; i < 4; i += 1) await payment(store, { amount: 1000, invoice_id: DOC });
    const tight = settlementCoverageGuard({ entity: "Invoice", refField: "invoice_id", maxPayments: 2 });
    const r = await tight(coverageInput(store, { after: { state: "paid", total: 120 } }));
    expect(r?.error).toBe("settlement_coverage_unverifiable");
    // Would have been *covered* over the whole set (4000 >= 120), so this is not the shortfall
    // block arriving by another name — the prefix is refused on its own account.
    expect(r?.error).not.toBe("uncovered_settlement");
  });

  it("names no remedy for an exceeded ceiling, because maxPayments reaches no flag", async () => {
    const store = new InMemoryEntityStore();
    for (let i = 0; i < 4; i += 1) await payment(store, { amount: 1, invoice_id: DOC });
    const tight = settlementCoverageGuard({ entity: "Invoice", refField: "invoice_id", maxPayments: 2 });
    const r = await tight(coverageInput(store, { after: { state: "paid", total: 120 } }));
    expect(r?.detail).not.toContain("remedy");
    expect(r?.detail).not.toContain("--");
  });

  it("refuses a create whose id the store has not assigned yet", async () => {
    // Nothing can reference a document that does not exist, so `applied` is 0 and the predicate
    // decides — rather than an absent id falling through to an allow.
    const store = new InMemoryEntityStore();
    const r = await guard(
      coverageInput(store, { operation: "create", id: null, before: null, after: { state: "paid", total: 1 } }),
    );
    expect(r?.error).toBe("uncovered_settlement");
  });
});

describe("SETTLEMENT_COVERAGE_DOCUMENTS", () => {
  it("names exactly the two documents whose coverage predicate is expressible", async () => {
    expect(SETTLEMENT_COVERAGE_DOCUMENTS.map((d) => d.entity)).toEqual(["Invoice", "Bill"]);
  });

  it("would be vacuous over TaxReturn, which is the reason for the omission", async () => {
    // Shown rather than asserted in prose, because it is the whole argument: a guard built for an
    // entity with no `total` reads `num(undefined)` as 0, finds every document covered, and passes
    // every write while appearing in the guard list as a control. `net_payable: 500` is genuinely
    // owed and no payment can name this document, so the honest answer is a refusal and this
    // returns null — which is why `TaxReturn` is declared uncoverable and surveyed instead.
    //
    // It is also what a mutation adding `TaxReturn` to the declaration produces: measured, that
    // mutation leaves `compile.test.ts` entirely green, because a 200 cannot tell *no guard* from
    // *a guard that checks nothing*. The declaration tests below are what catch it.
    const store = new InMemoryEntityStore();
    const vacuous = settlementCoverageGuard({ entity: "TaxReturn", refField: "tax_return_id" });
    const r = await vacuous({
      operation: "transition",
      entity: "TaxReturn",
      tenantId: TENANT,
      id: "tr-1",
      before: { state: "filed", net_payable: 500 },
      after: { state: "paid", net_payable: 500 },
      store,
    });
    expect(r).toBeNull();
  });

  it("omits TaxReturn deliberately, and the resolved pack is why", async () => {
    // Measured on resolved erp-core: TaxReturn has no `total` field and `Payment` carries
    // `invoice_id`/`bill_id` and nothing naming it, so BOTH operands of `total - applied` are
    // missing. The survey in apps/operate-server reports it; a guard would read every filing as
    // covered (`num(undefined)` is 0) and pass every write while looking like a control.
    expect(SETTLEMENT_COVERAGE_DOCUMENTS.some((d) => d.entity === "TaxReturn")).toBe(false);
  });

  it("gives every entry a payment reference field and a caller-actionable remedy", async () => {
    for (const doc of SETTLEMENT_COVERAGE_DOCUMENTS) {
      expect(doc.refField, doc.entity).toMatch(/_id$/);
      expect(doc.remedy, doc.entity).toBeTruthy();
      // Never a server flag: a 4xx naming one tells a client to ask for the guard to be switched off.
      expect(doc.remedy, doc.entity).not.toContain("--");
    }
  });

  it("settles on the state the guard and the survey both read", async () => {
    expect(SETTLED_DOCUMENT_STATE).toBe("paid");
  });
});
