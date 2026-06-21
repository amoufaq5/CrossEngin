import { describe, expect, it } from "vitest";

import { InMemoryEntityStore } from "./store.js";
import { journalPostingGuard, runWriteGuards, type WriteGuardInput } from "./write-guards.js";

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
