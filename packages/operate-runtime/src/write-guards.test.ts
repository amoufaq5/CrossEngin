import { describe, expect, it } from "vitest";

import { InMemoryEntityStore } from "./store.js";
import {
  journalPostingGuard,
  lockedDocumentGuard,
  postedEntryImmutabilityGuard,
  runWriteGuards,
  type WriteGuardInput,
} from "./write-guards.js";

const TENANT = "11111111-1111-1111-1111-111111111111";

async function seed() {
  const store = new InMemoryEntityStore();
  const entry = await store.create(TENANT, "JournalEntry", { state: "draft", fiscal_period_id: "p_open" });
  await store.create(TENANT, "FiscalPeriod", { id: "p_open", status: "open" });
  await store.create(TENANT, "FiscalPeriod", { id: "p_locked", status: "locked" });
  return { store, entryId: String(entry.id) };
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
