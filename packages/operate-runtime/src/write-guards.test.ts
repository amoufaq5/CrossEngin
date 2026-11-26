import { describe, expect, it } from "vitest";

import { InMemoryEntityStore, type ListPage, type ListQuery } from "./store.js";
import {
  currencyPrecisionGuard,
  amountOwed,
  APPLIED_PAYMENT_EPSILON,
  childParentRefs,
  declaredSettlementSpec,
  ENTRY_NUMBER_RESERVED_DETAIL,
  isReservedRemittanceEntryNumber,
  journalPostingGuard,
  reservedRemittanceEntryNumberGuard,
  LIFECYCLE_STATE_ERRORS,
  lifecycleStateGuard,
  PAYMENT_DIRECTION,
  paymentDirectionOf,
  paymentNamesDocument,
  settlementDocumentsFor,
  withArticle,
  lockedDocumentGuard,
  postedEntryImmutabilityGuard,
  readAppliedPayments,
  readAppliedToDocument,
  runWriteGuards,
  SETTLED_DOCUMENT_STATE,
  SETTLEMENT_COVERAGE_DOCUMENTS,
  settlementCoverageGuard,
  settlementIsCovered,
  taxRemittanceJournalReverseGuard,
  type WriteGuardInput,
  type WriteGuardResult,
} from "./write-guards.js";

const TENANT = "11111111-1111-1111-1111-111111111111";

/** One `[debit, credit]` pair per journal line. */
type LineAmounts = readonly [number | string, number | string];

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

  it("refuses a sub-cent difference instead of tolerating it", async () => {
    // This test used to assert the opposite: a 0.005 tolerance over doubles admitted 100 against
    // 100.004. The totals are exact now, so any difference is an imbalance.
    const { store, entryId } = await seed();
    await store.create(TENANT, "JournalLine", { journal_entry_id: entryId, debit: 100, credit: 0 });
    await store.create(TENANT, "JournalLine", { journal_entry_id: entryId, debit: 0, credit: 100.004 });
    expect(await guard(postInput(store, entryId, { fiscal_period_id: "p_open" }))).toEqual({
      status: 422,
      error: "unbalanced_journal_entry",
      detail: "debits (100.00) must equal credits (100.004)",
    });
  });

  it("balances amounts a double cannot add exactly", async () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point; exact decimals make it 0.3.
    const store = new InMemoryEntityStore();
    const entryId = await seedWith(store, [[0.1, 0], [0.2, 0], [0, 0.3]]);
    expect(await guard(postInput(store, entryId, { fiscal_period_id: "p_open" }))).toBeNull();
  });

  it("tells two amounts apart at the top of NUMERIC(16, 2), which a double cannot", async () => {
    // As doubles these two are the same number, so the float comparison posted an entry out by a
    // cent. Strings, because that is the wire form a decimal arrives in (ADR-0332).
    const store = new InMemoryEntityStore();
    const entryId = await seedWith(store, [["99999999999999.99", "0"], ["0", "99999999999999.98"]]);
    expect(await guard(postInput(store, entryId, { fiscal_period_id: "p_open" }))).toEqual({
      status: 422,
      error: "unbalanced_journal_entry",
      detail: "debits (99999999999999.99) must equal credits (99999999999999.98)",
    });
  });

  it("refuses an entry with one line", async () => {
    const store = new InMemoryEntityStore();
    const entryId = await seedWith(store, [[100, 100]]);
    expect((await guard(postInput(store, entryId, { fiscal_period_id: "p_open" })))?.error).toBe(
      "single_line_journal_entry",
    );
  });

  it("refuses unbalanced functional-currency amounts under balanced transaction ones", async () => {
    // Live L11: transaction 100/100 balanced, functional 100 Dr / 7 Cr, and it posted.
    const store = new InMemoryEntityStore();
    const entryId = await seedWith(store, []);
    await store.create(TENANT, "JournalLine", {
      journal_entry_id: entryId, currency: "EUR", debit: "100.00", credit: "0.00", functional_debit: "100.00", functional_credit: "0.00",
    });
    await store.create(TENANT, "JournalLine", {
      journal_entry_id: entryId, currency: "EUR", debit: "0.00", credit: "100.00", functional_debit: "0.00", functional_credit: "7.00",
    });
    expect(await guard(postInput(store, entryId, { fiscal_period_id: "p_open" }))).toEqual({
      status: 422,
      error: "unbalanced_journal_entry",
      detail: "functional-currency debits (100.00) must equal functional-currency credits (7.00)",
    });
  });

  it("balances transaction amounts per currency, not as one sum across currencies", async () => {
    // 100 EUR against 100 USD summed to 100 = 100 under one total; they are not one quantity.
    const store = new InMemoryEntityStore();
    const entryId = await seedWith(store, []);
    await store.create(TENANT, "JournalLine", {
      journal_entry_id: entryId, currency: "EUR", debit: 100, credit: 0, functional_debit: 110, functional_credit: 0,
    });
    await store.create(TENANT, "JournalLine", {
      journal_entry_id: entryId, currency: "USD", debit: 0, credit: 100, functional_debit: 0, functional_credit: 110,
    });
    expect(await guard(postInput(store, entryId, { fiscal_period_id: "p_open" }))).toEqual({
      status: 422,
      error: "unbalanced_journal_entry",
      detail: "in EUR: debits (100.00) must equal credits (0.00)",
    });
  });

  it("admits a multi-currency entry that balances in each currency and in functional amounts", async () => {
    // The trading-account form: each currency balances through a clearing line in that currency.
    // The EUR lines carry their rate: they used to omit it, and a functional 110 against an amount
    // of 100 at the column's default rate of 1 is exactly the line the conversion check refuses.
    const store = new InMemoryEntityStore();
    const entryId = await seedWith(store, []);
    for (const [currency, debit, credit, fd, fc, rate] of [
      ["EUR", 100, 0, 110, 0, "1.1"],
      ["EUR", 0, 100, 0, 110, "1.1"],
      ["USD", 110, 0, 110, 0, "1"],
      ["USD", 0, 110, 0, 110, "1"],
    ] as const) {
      await store.create(TENANT, "JournalLine", {
        journal_entry_id: entryId, currency, debit, credit, functional_debit: fd, functional_credit: fc, fx_rate: rate,
      });
    }
    expect(await guard(postInput(store, entryId, { fiscal_period_id: "p_open" }))).toBeNull();
  });

  describe("functional amount = amount × fx_rate", () => {
    async function twoLines(
      lines: readonly [debit: string, credit: string, fd: string, fc: string, rate: string | null][],
    ): Promise<WriteGuardResult> {
      const store = new InMemoryEntityStore();
      const entryId = await seedWith(store, []);
      for (const [debit, credit, fd, fc, rate] of lines) {
        await store.create(TENANT, "JournalLine", {
          journal_entry_id: entryId, currency: "AED", debit, credit, functional_debit: fd, functional_credit: fc,
          ...(rate === null ? {} : { fx_rate: rate }),
        });
      }
      return guard(postInput(store, entryId, { fiscal_period_id: "p_open" }));
    }

    it("refuses a stated functional amount that is not the line's amount at its rate", async () => {
      // Balanced in AED and balanced in functional amounts, so it posted before: the functional legs
      // agreed with each other and with nothing else.
      expect(
        await twoLines([
          ["100.00", "0.00", "7.00", "0.00", "3.6725"],
          ["0.00", "100.00", "0.00", "7.00", "3.6725"],
        ]),
      ).toEqual({
        status: 422,
        error: "functional_amount_mismatch",
        detail:
          "a line's functional amount 7.00 is not its amount 100.00 at its fx_rate 3.6725 " +
          "(367.250000, to two places) (and 1 more line amount(s) like it)",
      });
    });

    it("admits either rounding of the exact product, and nothing further", async () => {
      // 10.01 × 0.3333333333 = 3.336666666333…: 3.33 and 3.34 are the two figures NUMERIC(16,2) can
      // hold for it, and a preparer balancing rounded legs needs both.
      for (const fd of ["3.33", "3.34"]) {
        expect(
          await twoLines([
            ["10.01", "0.00", fd, "0.00", "0.3333333333"],
            ["0.00", "10.01", "0.00", fd, "0.3333333333"],
          ]),
        ).toBeNull();
      }
      expect(
        (
          await twoLines([
            ["10.01", "0.00", "3.35", "0.00", "0.3333333333"],
            ["0.00", "10.01", "0.00", "3.35", "0.3333333333"],
          ])
        )?.error,
      ).toBe("functional_amount_mismatch");
    });

    it("reads an absent rate as the column's default of 1", async () => {
      expect(
        await twoLines([
          ["50.00", "0.00", "50.00", "0.00", null],
          ["0.00", "50.00", "0.00", "50.00", null],
        ]),
      ).toBeNull();
      expect(
        (
          await twoLines([
            ["50.00", "0.00", "55.00", "0.00", null],
            ["0.00", "50.00", "0.00", "55.00", null],
          ])
        )?.error,
      ).toBe("functional_amount_mismatch");
    });

    it("exempts a line that states no functional amount, as the depreciation job writes them", async () => {
      // Both legs at the column default of 0: refusing these would refuse every posting the job makes.
      expect(
        await twoLines([
          ["120.00", "0.00", "0", "0", "3.6725"],
          ["0.00", "120.00", "0", "0", "3.6725"],
        ]),
      ).toBeNull();
    });

    it("admits a functional-only FX line, which moves no transaction amount, and still balances the legs", async () => {
      // A realized or unrealized FX difference exists only in the base currency: no AED moves, and
      // 5.00 is the whole of the line. Stating it as an AED amount was the `amount = functional`
      // fiction the revaluation used to post.
      expect(
        await twoLines([
          ["0.00", "0.00", "5.00", "0.00", "3.6725"],
          ["0.00", "0.00", "0.00", "5.00", "3.6725"],
        ]),
      ).toBeNull();
      // The exemption is not a hole: the functional legs must still balance.
      expect(
        (
          await twoLines([
            ["0.00", "0.00", "5.00", "0.00", "3.6725"],
            ["0.00", "0.00", "0.00", "4.00", "3.6725"],
          ])
        )?.error,
      ).toBe("unbalanced_journal_entry");
    });

    it("refuses a stated functional amount beside a rate that is not a decimal", async () => {
      const r = await twoLines([
        ["100.00", "0.00", "100.00", "0.00", "n/a"],
        ["0.00", "100.00", "0.00", "100.00", "1"],
      ]);
      expect(r?.error).toBe("unverifiable_journal_entry");
      expect(r?.detail).not.toContain("n/a");
    });
  });

  it("refuses a line amount that is not a decimal rather than reading it as zero", async () => {
    // `Number("n/a")` read as 0, so these three lines balanced at 0/0 and posted with an amount
    // nobody could read. The value itself is not repeated in the refusal.
    const store = new InMemoryEntityStore();
    const entryId = await seedWith(store, [[0, 0], [0, 0]]);
    await store.create(TENANT, "JournalLine", { journal_entry_id: entryId, debit: "n/a", credit: 0 });
    const r = await guard(postInput(store, entryId, { fiscal_period_id: "p_open" }));
    expect(r?.error).toBe("unverifiable_journal_entry");
    expect(r?.detail).toContain("not decimals");
    expect(r?.detail).not.toContain("n/a");
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

  it("refuses a create straight into posted with no id, which cannot have lines", async () => {
    // This test used to pin the opposite as the specification: the guard returned null before it
    // read a line, so `POST {state:"posted"}` with no lines passed (live L12).
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
    expect((await guard(input))?.error).toBe("empty_journal_entry");
    expect((await journalPostingGuard({ maxLines: 0 })(input))?.error).toBe("empty_journal_entry");
  });

  it("checks a create into posted that names its id against the lines already under it", async () => {
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "JournalLine", { journal_entry_id: "je_new", debit: 50, credit: 0 });
    await store.create(TENANT, "JournalLine", { journal_entry_id: "je_new", debit: 0, credit: 40 });
    const input: WriteGuardInput = {
      operation: "create",
      entity: "JournalEntry",
      tenantId: TENANT,
      id: null,
      before: null,
      after: { id: "je_new", state: "posted" },
      store,
    };
    expect((await guard(input))?.error).toBe("unbalanced_journal_entry");
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

describe("lockedDocumentGuard — every parent a child write touches", () => {
  const guard = postedEntryImmutabilityGuard();

  async function seedParents() {
    const s = new InMemoryEntityStore();
    const posted = String((await s.create(TENANT, "JournalEntry", { state: "posted" })).id);
    const draft = String((await s.create(TENANT, "JournalEntry", { state: "draft" })).id);
    const draft2 = String((await s.create(TENANT, "JournalEntry", { state: "draft" })).id);
    return { s, posted, draft, draft2 };
  }

  const line = (
    s: InMemoryEntityStore,
    op: WriteGuardInput["operation"],
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
  ): WriteGuardInput => ({ operation: op, entity: "JournalLine", tenantId: TENANT, id: op === "create" ? null : "l1", before, after, store: s });

  it("refuses moving a line out of a posted entry, which reading only the new parent allowed", async () => {
    const { s, posted, draft } = await seedParents();
    const r = await guard(line(s, "update", { journal_entry_id: posted, credit: 500 }, { journal_entry_id: draft, credit: 500 }));
    expect(r?.error).toBe("posted_entry_locked_lines");
    expect(r?.detail).toBe("cannot move a line out of a posted journal entry");
  });

  it("refuses moving a line into a posted entry", async () => {
    const { s, posted, draft } = await seedParents();
    const r = await guard(line(s, "update", { journal_entry_id: draft }, { journal_entry_id: posted }));
    expect(r?.detail).toBe("cannot modify the lines of a posted journal entry");
  });

  it("refuses deleting a line of a posted entry and creating one under it", async () => {
    const { s, posted } = await seedParents();
    expect((await guard(line(s, "delete", { journal_entry_id: posted }, { journal_entry_id: posted })))?.error).toBe(
      "posted_entry_locked_lines",
    );
    expect((await guard(line(s, "create", null, { journal_entry_id: posted })))?.error).toBe("posted_entry_locked_lines");
  });

  it("refuses unsetting the parent of a line in a posted entry", async () => {
    const { s, posted } = await seedParents();
    expect((await guard(line(s, "update", { journal_entry_id: posted }, { journal_entry_id: null })))?.error).toBe(
      "posted_entry_locked_lines",
    );
  });

  it("allows moving a line between two draft entries", async () => {
    const { s, draft, draft2 } = await seedParents();
    expect(await guard(line(s, "update", { journal_entry_id: draft }, { journal_entry_id: draft2 }))).toBeNull();
  });

  it("childParentRefs answers the stored parent then the written one, de-duplicated", () => {
    const input = (before: Record<string, unknown> | null, after: Record<string, unknown>): WriteGuardInput =>
      ({ operation: "update", entity: "L", tenantId: TENANT, id: "x", before, after, store: new InMemoryEntityStore() });
    expect(childParentRefs(input({ p: "a" }, { p: "b" }), "p")).toEqual(["a", "b"]);
    expect(childParentRefs(input({ p: "a" }, { p: "a" }), "p")).toEqual(["a"]);
    expect(childParentRefs(input(null, { p: "b" }), "p")).toEqual(["b"]);
    expect(childParentRefs(input({ p: "a" }, { p: null }), "p")).toEqual(["a"]);
    expect(childParentRefs(input({ p: "" }, { p: 7 }), "p")).toEqual([]);
  });
});

describe("lifecycleStateGuard", () => {
  const guard = lifecycleStateGuard({
    entity: "Bill",
    stateField: "state",
    initialState: "draft",
    transitions: [
      { name: "approve", from: ["draft"], to: "approved" },
      { name: "mark_paid", from: ["approved", "overdue"], to: "paid" },
      { name: "void", from: ["draft", "approved", "overdue"], to: "void" },
    ],
  });
  const store = new InMemoryEntityStore();
  const inp = (
    op: WriteGuardInput["operation"],
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    entity = "Bill",
  ): WriteGuardInput => ({ operation: op, entity, tenantId: TENANT, id: op === "create" ? null : "b1", before, after, store });

  it("admits a create in the initial state or with the field unset", async () => {
    expect(await guard(inp("create", null, { state: "draft" }))).toBeNull();
    expect(await guard(inp("create", null, {}))).toBeNull();
    expect(await guard(inp("create", null, { state: null }))).toBeNull();
  });

  it("refuses a create past the initial state and names the route", async () => {
    const r = await guard(inp("create", null, { state: "paid" }));
    expect(r?.status).toBe(422);
    expect(r?.error).toBe(LIFECYCLE_STATE_ERRORS.create);
    expect(r?.detail).toContain("from 'draft' fire 'approve' then 'mark_paid'");
  });

  it("says so when no declared transition reaches the requested state", async () => {
    const r = await guard(inp("create", null, { state: "overdue" }));
    expect(r?.detail).toContain("no declared transition leads from 'draft' to 'overdue'");
  });

  it("admits an update that does not change the state, named or not", async () => {
    expect(await guard(inp("update", { state: "approved", total: 1 }, { state: "approved", total: 2 }))).toBeNull();
    expect(await guard(inp("update", { state: "draft" }, { state: "draft" }))).toBeNull();
  });

  it("refuses an update that changes the state, either direction", async () => {
    const fwd = await guard(inp("update", { state: "draft" }, { state: "approved" }));
    expect(fwd?.error).toBe(LIFECYCLE_STATE_ERRORS.update);
    expect(fwd?.detail).toContain("from 'draft' fire 'approve'");
    const back = await guard(inp("update", { state: "approved" }, { state: "draft" }));
    expect(back?.detail).toContain("no declared transition leads from 'approved' to 'draft'");
  });

  it("refuses a state it is handed when the stored record was not loaded", async () => {
    expect((await guard(inp("update", null, { state: "approved" })))?.error).toBe(LIFECYCLE_STATE_ERRORS.update);
    expect(await guard(inp("update", null, { total: 3 }))).toBeNull();
  });

  it("puts the right article before an entity name", async () => {
    // The detail hardcoded `a`, so a lifecycle on Invoice read "a Invoice is created in 'draft'".
    const invoiceGuard = lifecycleStateGuard({
      entity: "Invoice",
      stateField: "state",
      initialState: "draft",
      transitions: [{ name: "send", from: ["draft"], to: "sent" }],
    });
    const r = await invoiceGuard(inp("create", null, { state: "sent" }, "Invoice"));
    expect(r?.detail).toMatch(/^an Invoice is created in 'draft'/);
    expect((await guard(inp("create", null, { state: "approved" })))?.detail).toMatch(/^a Bill is created/);
    expect(withArticle("approved bill")).toBe("an approved bill");
    expect(withArticle("paid bill")).toBe("a paid bill");
  });

  it("reads a loaded record with no state as the initial state, and an unloaded one as nothing", async () => {
    expect(await guard(inp("update", { total: 1 }, { state: "draft" }))).toBeNull();
    expect((await guard(inp("update", { total: 1 }, { state: "approved" })))?.detail).toContain("from 'draft' fire 'approve'");
    expect((await guard(inp("update", null, { state: "draft" })))?.error).toBe(LIFECYCLE_STATE_ERRORS.update);
  });

  it("admits an ordinary edit of a stateless record, whose merged `after` carries no state either", async () => {
    // The handler passes `after: {...before, ...patch}`, so an edit that does not name the state
    // leaves it unset on both sides. Reading only `before` as `initialState` compared 'draft' against
    // `undefined` and refused every edit of such a record, a field nobody had touched.
    expect(await guard(inp("update", { total: 1 }, { total: 2 }))).toBeNull();
    expect(await guard(inp("update", { total: 1, state: null }, { total: 2, state: null }))).toBeNull();
    expect(await guard(inp("update", { total: 1 }, { total: 2, state: null }))).toBeNull();
    // Clearing a set state is still a change.
    expect((await guard(inp("update", { state: "approved" }, { state: null })))?.error).toBe(LIFECYCLE_STATE_ERRORS.update);
  });

  it("leaves a transition, a delete and another entity alone", async () => {
    expect(await guard(inp("transition", { state: "draft" }, { state: "approved" }))).toBeNull();
    expect(await guard(inp("delete", { state: "approved" }, { state: "approved" }))).toBeNull();
    expect(await guard(inp("update", { state: "draft" }, { state: "approved" }, "Invoice"))).toBeNull();
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

/** The declaration's specs, never retyped (ADR-0468). */
const INVOICE_SPEC = declaredSettlementSpec("Invoice");
const BILL_SPEC = declaredSettlementSpec("Bill");

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
    await payment(store, { amount: 30, direction: "inbound", invoice_id: DOC });
    await payment(store, { amount: 70, direction: "inbound", invoice_id: DOC, state: "pending" });
    await payment(store, { amount: 11, direction: "inbound", invoice_id: "other" });
    const read = await readAppliedToDocument(store, TENANT, INVOICE_SPEC, DOC, { ceiling: 100 });
    expect(read).toEqual({ applied: 30, complete: true });
  });

  it("does not stop once the running total crosses a threshold: the sum is what a report prints", async () => {
    // The reason is no longer a negative correction on a later page (ADR-0468: a negative amount
    // counts nothing now — the test below pins that). It is that the fold returns a sum the aging
    // report prints, so a read must cover every page. 1100 payments forces three pages at the 500
    // default, so the total genuinely spans pages after the one that crossed 400.
    const store = new InMemoryEntityStore();
    for (let i = 0; i < 1100; i += 1) await payment(store, { amount: 1, direction: "inbound", invoice_id: DOC });
    const read = await readAppliedToDocument(store, TENANT, INVOICE_SPEC, DOC, { ceiling: 5000 });
    expect(read.applied).toBe(1100);
    expect(read.complete).toBe(true);
  });

  it("counts a stored negative or mis-sided row as nothing, which is what the posting cleared", async () => {
    // Rewritten rather than deleted (ADR-0372's class): this used to pin a −1000 correction as
    // lowering the figure. The settlement posting skips a non-positive amount and clears only the
    // control side its direction names, so each of these rows moved nothing on this invoice's
    // receivable — and the fold now agrees.
    const store = new InMemoryEntityStore();
    await payment(store, { amount: 100, direction: "inbound", invoice_id: DOC });
    await payment(store, { amount: -1000, direction: "inbound", invoice_id: DOC });
    await payment(store, { amount: 0, direction: "inbound", invoice_id: DOC });
    await payment(store, { amount: 40, direction: "outbound", invoice_id: DOC });
    await payment(store, { amount: 25, invoice_id: DOC });
    const read = await readAppliedToDocument(store, TENANT, INVOICE_SPEC, DOC, { ceiling: 100 });
    expect(read).toEqual({ applied: 100, complete: true });
  });

  it("counts a row naming two documents only on the side its direction settles", async () => {
    const store = new InMemoryEntityStore();
    await payment(store, { amount: 70, direction: "inbound", invoice_id: "i", bill_id: "b" });
    const read = await readAppliedPayments(store, TENANT, [INVOICE_SPEC, BILL_SPEC], { ceiling: 9 });
    expect(read.applied[0]!.get("i")).toBe(70);
    expect(read.applied[1]!.get("b")).toBeUndefined();
  });

  it("keeps one map per bucket, so two documents sharing an id never merge", async () => {
    // The invariant three independent spellings of this fold each re-derived in a comment: a
    // caller-supplied `id` is not stripped and records are bucketed per (tenant, entity), so a
    // single map keyed by document id would credit the invoice with the bill's money.
    const store = new InMemoryEntityStore();
    await payment(store, { amount: 40, direction: "outbound", bill_id: "shared" });
    const read = await readAppliedPayments(store, TENANT, [INVOICE_SPEC, BILL_SPEC], {
      ceiling: 100,
    });
    expect(read.applied[0]!.get("shared")).toBeUndefined();
    expect(read.applied[1]!.get("shared")).toBe(40);
  });

  it("answers positionally, one map per requested ref field", async () => {
    const store = new InMemoryEntityStore();
    await payment(store, { amount: 5, direction: "inbound", invoice_id: "i" });
    const read = await readAppliedPayments(store, TENANT, [BILL_SPEC, INVOICE_SPEC], { ceiling: 9 });
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
    await payment(store, { amount: 50, direction: "inbound", invoice_id: 42 });
    const read = await readAppliedToDocument(store, TENANT, INVOICE_SPEC, "42", { ceiling: 100 });
    expect(read.applied).toBe(0);
  });

  it("reports an exceeded ceiling rather than truncating in silence", async () => {
    const store = new InMemoryEntityStore();
    for (let i = 0; i < 5; i += 1) await payment(store, { amount: 1, direction: "inbound", invoice_id: DOC });
    const read = await readAppliedToDocument(store, TENANT, INVOICE_SPEC, DOC, { ceiling: 2 });
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
  const guard = settlementCoverageGuard({ entity: "Invoice", refField: "invoice_id", settledBy: "inbound", noun: "an invoice" });

  it("blocks a transition into paid while payments fall short", async () => {
    const store = new InMemoryEntityStore();
    await payment(store, { amount: 50, direction: "inbound", invoice_id: DOC });
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
    await payment(store, { amount: 120, direction: "inbound", invoice_id: DOC });
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

  it("blocks lowering the withholding of a settled document, which raises what it owes", async () => {
    // What a payer owes is total less withholding, so dropping the withholding raises the debt as
    // surely as raising the total does — and the total-only comparison saw no change at all.
    const wht = settlementCoverageGuard({ entity: "Invoice", refField: "invoice_id", settledBy: "inbound", withholdingField: "withholding_total" });
    const store = new InMemoryEntityStore();
    await payment(store, { amount: 95, direction: "inbound", invoice_id: DOC });
    const settled = { state: "paid", total: 100 };
    const lowered = await wht(
      coverageInput(store, {
        operation: "update",
        before: { ...settled, withholding_total: 5 },
        after: { ...settled, withholding_total: 0 },
      }),
    );
    expect(lowered?.error).toBe("uncovered_settlement");
    expect(lowered?.detail).toContain("5.00 of 100.00");
    // Control: the same write with the withholding unchanged is the stamp-or-note case.
    const unchanged = await wht(
      coverageInput(store, {
        operation: "update",
        before: { ...settled, withholding_total: 5 },
        after: { ...settled, withholding_total: 5, notes: "x" },
      }),
    );
    expect(unchanged).toBeNull();
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
      settledBy: "inbound",
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
    // `READ_CEILING_EFFECT.guard` is `refuses`: a decision from a prefix is not a decision. A
    // negative amount no longer counts (ADR-0468), so a dropped tail can only understate the figure —
    // and understating is how a covered document is wrongly refused, so the prefix is still refused.
    const store = new InMemoryEntityStore();
    for (let i = 0; i < 4; i += 1) await payment(store, { amount: 1000, direction: "inbound", invoice_id: DOC });
    const tight = settlementCoverageGuard({ entity: "Invoice", refField: "invoice_id", settledBy: "inbound", maxPayments: 2 });
    const r = await tight(coverageInput(store, { after: { state: "paid", total: 120 } }));
    expect(r?.error).toBe("settlement_coverage_unverifiable");
    // Would have been *covered* over the whole set (4000 >= 120), so this is not the shortfall
    // block arriving by another name — the prefix is refused on its own account.
    expect(r?.error).not.toBe("uncovered_settlement");
  });

  it("names no remedy for an exceeded ceiling, because maxPayments reaches no flag", async () => {
    const store = new InMemoryEntityStore();
    for (let i = 0; i < 4; i += 1) await payment(store, { amount: 1, direction: "inbound", invoice_id: DOC });
    const tight = settlementCoverageGuard({ entity: "Invoice", refField: "invoice_id", settledBy: "inbound", maxPayments: 2 });
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
    const vacuous = settlementCoverageGuard({ entity: "TaxReturn", refField: "tax_return_id", settledBy: "outbound" });
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

  it("declares which direction settles each document, distinct across entries (ADR-0468)", () => {
    // One direction per control side: were two entries to share one, a single payment naming both
    // would be well-directed for both and settle two documents with one posting — the P2.21 defect.
    const directions = SETTLEMENT_COVERAGE_DOCUMENTS.map((d) => d.settledBy);
    expect(new Set(directions).size).toBe(directions.length);
    expect(Object.fromEntries(SETTLEMENT_COVERAGE_DOCUMENTS.map((d) => [d.entity, d.settledBy]))).toEqual({
      Invoice: "inbound",
      Bill: "outbound",
    });
    // The reference fields are distinct too, so a fold bucket answers for exactly one document.
    const refs = SETTLEMENT_COVERAGE_DOCUMENTS.map((d) => d.refField);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("filters to the documents a manifest declares, in declaration order", () => {
    expect(settlementDocumentsFor(new Set(["Bill", "Invoice", "Payment"])).map((d) => d.entity)).toEqual(["Invoice", "Bill"]);
    expect(settlementDocumentsFor(new Set(["Invoice"])).map((d) => d.entity)).toEqual(["Invoice"]);
    expect(settlementDocumentsFor(new Set())).toEqual([]);
    expect(declaredSettlementSpec("Bill")).toEqual({ refField: "bill_id", settledBy: "outbound" });
    expect(() => declaredSettlementSpec("TaxReturn")).toThrow(/declares no TaxReturn/);
  });
});

describe("PAYMENT_DIRECTION / paymentDirectionOf / paymentNamesDocument", () => {
  it("reads inbound only for the inbound value, and everything else as outbound — the posting's reading", () => {
    expect(paymentDirectionOf({ direction: "inbound" }, PAYMENT_DIRECTION)).toBe("inbound");
    expect(paymentDirectionOf({ direction: "outbound" }, PAYMENT_DIRECTION)).toBe("outbound");
    expect(paymentDirectionOf({}, PAYMENT_DIRECTION)).toBe("outbound");
    expect(paymentDirectionOf({ direction: "in" }, PAYMENT_DIRECTION)).toBe("outbound");
    expect(paymentDirectionOf({ direction: "INBOUND" }, PAYMENT_DIRECTION)).toBe("outbound");
    expect(paymentDirectionOf({ dir: "x" }, { field: "dir", inboundValue: "x" })).toBe("inbound");
  });

  it("takes the reading as a required argument", () => {
    // @ts-expect-error — the direction reading has no default, so a caller cannot read a payment by a
    // spelling it never chose (evaluated by `tsconfig.typecheck.json`; ADR-0307's split).
    expect(() => paymentDirectionOf({ direction: "inbound" })).toThrow();
  });

  it("names a document only by a non-empty string", () => {
    expect(paymentNamesDocument("inv-1")).toBe(true);
    expect(paymentNamesDocument("")).toBe(false);
    expect(paymentNamesDocument(42)).toBe(false);
    expect(paymentNamesDocument(null)).toBe(false);
    expect(paymentNamesDocument(undefined)).toBe(false);
  });
});

describe("amountOwed", () => {
  it("is the total less withholding, and the total when none is declared or withheld", () => {
    expect(amountOwed({ total: 100, withholding_total: 5 }, "total", "withholding_total")).toBe(95);
    expect(amountOwed({ total: 100 }, "total", "withholding_total")).toBe(100);
    expect(amountOwed({ total: 100, withholding_total: 5 }, "total", undefined)).toBe(100);
    expect(amountOwed({ total: 0.3, withholding_total: 0.1 }, "total", "withholding_total")).toBe(0.2);
  });
});

describe("currencyPrecisionGuard", () => {
  const store = new InMemoryEntityStore();
  const input = (operation: "create" | "update" | "delete", after: number, before?: number) => ({
    operation,
    entity: "Currency",
    tenantId: "t",
    id: operation === "create" ? null : "c1",
    before: before === undefined ? null : { decimal_places: before },
    after: { decimal_places: after },
    store,
  });
  const guard = currencyPrecisionGuard();

  it("refuses a minor unit finer than the ledger on create and on a change", async () => {
    expect((await guard(input("create", 3)))?.error).toBe("currency_precision_unsupported");
    expect((await guard(input("update", 3, 2)))?.error).toBe("currency_precision_unsupported");
  });

  it("admits the ledger's own scale and coarser ones", async () => {
    for (const dp of [0, 1, 2]) expect(await guard(input("create", dp))).toBeNull();
  });

  it("leaves a row stored before the guard editable and deletable", async () => {
    expect(await guard(input("update", 3, 3))).toBeNull();
    expect(await guard(input("delete", 3, 3))).toBeNull();
  });

  it("reads no other entity", async () => {
    expect(await guard({ ...input("create", 3), entity: "Invoice" })).toBeNull();
  });
});

describe("taxRemittanceJournalReverseGuard", () => {
  const guard = taxRemittanceJournalReverseGuard({
    wiring: { entity: "TaxReturn", stateField: "state", reverseTransition: "reverse_payment" },
  });
  const entry = { id: "je1", entry_number: "TR-1-REMIT-1", state: "posted" };
  const reverse = (store: InMemoryEntityStore, op: "update" | "transition" = "transition"): WriteGuardInput => ({
    operation: op,
    entity: "JournalEntry",
    tenantId: TENANT,
    id: "je1",
    before: entry,
    after: { ...entry, state: "reversed" },
    store,
  });

  it("refuses reversing a paid return's remittance entry, by transition or by update", async () => {
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "TaxReturn", { return_number: "TR-1", state: "paid", remittance_entry_number: "TR-1-REMIT-1" });
    for (const op of ["transition", "update"] as const) {
      expect(await guard(reverse(store, op))).toEqual({
        status: 409,
        error: "tax_remittance_reverse_via_return",
        detail: "this entry is a paid tax return's remittance; reverse it with the return's reverse_payment transition",
      });
    }
  });

  it("lets the entry be reversed once its return is no longer paid, and leaves other entries alone", async () => {
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "TaxReturn", { return_number: "TR-1", state: "filed", remittance_entry_number: "TR-1-REMIT-1" });
    expect(await guard(reverse(store))).toBeNull();
    // A return naming another entry does not lock this one.
    await store.create(TENANT, "TaxReturn", { return_number: "TR-2", state: "paid", remittance_entry_number: "TR-2-REMIT-1" });
    expect(await guard(reverse(store))).toBeNull();
  });

  it("refuses when more than one return names the entry and none of the first two is paid", async () => {
    const store = new InMemoryEntityStore();
    for (const n of ["TR-1", "TR-1b", "TR-1c"]) {
      await store.create(TENANT, "TaxReturn", { return_number: n, state: "filed", remittance_entry_number: "TR-1-REMIT-1" });
    }
    expect((await guard(reverse(store)))?.error).toBe("posting_ambiguous");
  });

  it("asks nothing of a write that does not take an entry from posted to reversed", async () => {
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "TaxReturn", { return_number: "TR-1", state: "paid", remittance_entry_number: "TR-1-REMIT-1" });
    expect(await guard({ ...reverse(store), after: { ...entry, memo: "x" } })).toBeNull();
    expect(await guard({ ...reverse(store), entity: "TaxReturn" })).toBeNull();
  });
});

describe("journalPostingGuard reads its named period under a share lock (ADR-0480)", () => {
  it("locks the period the entry names, so a concurrent close is serialised against the post", async () => {
    class Recording extends InMemoryEntityStore {
      readonly locked: string[] = [];
      override async getLocked(t: string, e: string, id: string, l: "share" | "exclusive") {
        this.locked.push(`${e}:${id}:${l}`);
        return super.getLocked(t, e, id, l);
      }
    }
    const store = new Recording();
    const entryId = await seedWith(store, [
      [100, 0],
      [0, 100],
    ]);
    expect(await journalPostingGuard()(postInput(store, entryId, { fiscal_period_id: "p_open" }))).toBeNull();
    expect(store.locked).toContain("FiscalPeriod:p_open:share");
  });
});

describe("reservedRemittanceEntryNumberGuard (ADR-0480)", () => {
  const guard = reservedRemittanceEntryNumberGuard();
  const store = new InMemoryEntityStore();
  const create = (n: unknown): WriteGuardInput => ({
    operation: "create",
    entity: "JournalEntry",
    tenantId: TENANT,
    id: null,
    before: null,
    after: { entry_number: n, state: "draft" },
    store,
  });

  it("recognises the remittance form and its reversals, and nothing near it", () => {
    for (const n of ["TR-2026-Q2-REMIT-1", "TR-2026-Q2-REMIT-12", "TR-2026-Q2-REMIT-1-REV", "TR-REMIT-3-REV-REV"]) {
      expect(isReservedRemittanceEntryNumber(n)).toBe(true);
    }
    for (const n of ["-REMIT-1", "TR-REMIT-0", "TR-REMIT-01", "TR-REMIT-", "TR-REMIT-x", "JE-100", "TR-REMIT-1-REVX", "REMIT-1"]) {
      expect(isReservedRemittanceEntryNumber(n)).toBe(false);
    }
  });

  it("refuses a create naming a reserved number, with a detail that names no value", async () => {
    for (const n of ["TR-1-REMIT-1", "TR-1-REMIT-1-REV"]) {
      expect(await guard(create(n))).toEqual({ status: 422, error: "entry_number_reserved", detail: ENTRY_NUMBER_RESERVED_DETAIL });
    }
    expect(ENTRY_NUMBER_RESERVED_DETAIL).not.toContain("TR-1");
    expect(await guard(create("JE-7"))).toBeNull();
    expect(await guard(create(undefined))).toBeNull();
  });

  it("refuses an update that changes the number to a reserved one, and admits one that keeps it", async () => {
    const update = (before: unknown, after: unknown): WriteGuardInput => ({
      operation: "update",
      entity: "JournalEntry",
      tenantId: TENANT,
      id: "je_1",
      before: { entry_number: before },
      after: { entry_number: after },
      store,
    });
    expect((await guard(update("JE-7", "TR-1-REMIT-1")))?.error).toBe("entry_number_reserved");
    expect(await guard(update("TR-1-REMIT-1", "TR-1-REMIT-1"))).toBeNull();
    expect(await guard(update("JE-7", "JE-8"))).toBeNull();
  });

  it("ignores other entities and non-write operations", async () => {
    expect(await guard({ ...create("TR-1-REMIT-1"), entity: "Invoice" })).toBeNull();
    expect(await guard({ ...create("TR-1-REMIT-1"), operation: "delete" })).toBeNull();
  });
});
