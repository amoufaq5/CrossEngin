import { describe, expect, it } from "vitest";

import { InMemoryEntityStore, type ListPage, type ListQuery } from "./store.js";
import {
  journalPostingGuard,
  lockedDocumentGuard,
  postedEntryImmutabilityGuard,
  runWriteGuards,
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
