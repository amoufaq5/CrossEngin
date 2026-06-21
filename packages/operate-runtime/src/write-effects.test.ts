import { describe, expect, it } from "vitest";

import { InMemoryEntityStore } from "./store.js";
import { journalReversalEffect, runWriteEffects, type WriteEffectInput } from "./write-effects.js";

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
