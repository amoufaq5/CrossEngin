import { describe, expect, it } from "vitest";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import {
  BILL_CONTROL_DESCRIPTION,
  EntityAuditUnrecorded,
  InMemoryEntityStore,
  WITHHOLDING_LINE_DESCRIPTION_PREFIX,
  type EntityRecord,
  type EntityStore,
  type EntityWriteAuditEvent,
  type EntityWriteAuditor,
  type ListPage,
  type ListQuery,
  type RowLock,
} from "@crossengin/operate-runtime";
import type { Manifest } from "@crossengin/kernel";
import {
  BACKFILL_BILL_REFUSALS,
  BACKFILL_BILL_REFUSAL_REMEDY,
  BACKFILL_TENANT_REFUSALS,
  BACKFILL_TENANT_REFUSAL_REMEDY,
  backfillRefusedAnything,
  backfillTenantBills,
  billWithholdingStampedFor,
  classifyCoverage,
  compareStoredWithholding,
  deriveBillWithholding,
  formatBillWithholdingBackfill,
  type BillBackfillOutcome,
  type BillWithholdingBackfillReport,
  type TenantBackfillInput,
} from "./bill-withholding-backfill.js";

const TENANT = "00000000-0000-4000-8000-00000000000a";
const WHT = `${WITHHOLDING_LINE_DESCRIPTION_PREFIX}WHT 10%)`;

function line(overrides: Partial<EntityRecord> & { id: string }): EntityRecord {
  return {
    journal_entry_id: "je_1",
    currency: "USD",
    debit: 0,
    credit: 0,
    fx_rate: "1",
    ...overrides,
  };
}

/** The lines bill recognition writes for a bill of 100 with 10 withheld, plus the expense debit. */
function recognitionLines(): EntityRecord[] {
  return [
    line({ id: "jl_exp", ledger_account_id: "acc_expense", description: "Bill — expense", debit: 100 }),
    line({ id: "jl_ap", ledger_account_id: "acc_ap", description: BILL_CONTROL_DESCRIPTION, credit: 90 }),
    line({ id: "jl_wht", ledger_account_id: "acc_wht", description: WHT, credit: 10 }),
  ];
}

interface Seed {
  readonly bill?: Partial<EntityRecord>;
  readonly entry?: Partial<EntityRecord> | null;
  readonly lines?: readonly EntityRecord[];
  readonly payments?: readonly number[];
}

async function seeded(store: InMemoryEntityStore, seed: Seed = {}): Promise<void> {
  await store.create(TENANT, "Bill", {
    id: "bill_1",
    bill_number: "BILL-001",
    state: "approved",
    total: "100.00",
    currency: "USD",
    ...seed.bill,
  });
  if (seed.entry !== null) {
    await store.create(TENANT, "JournalEntry", {
      id: "je_1",
      entry_number: "BILL-001-GL",
      state: "posted",
      source: "bill",
      ...seed.entry,
    });
  }
  for (const l of seed.lines ?? recognitionLines()) await store.create(TENANT, "JournalLine", l);
  let n = 0;
  for (const amount of seed.payments ?? []) {
    n += 1;
    await store.create(TENANT, "Payment", { id: `pay_${n}`, bill_id: "bill_1", amount, state: "completed" });
  }
}

class RecordingAuditor implements EntityWriteAuditor {
  readonly events: EntityWriteAuditEvent[] = [];
  async record(event: EntityWriteAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class RefusingAuditor implements EntityWriteAuditor {
  async record(): Promise<void> {
    throw new EntityAuditUnrecorded("the sink refused the row");
  }
}

function input(store: EntityStore & Pick<InMemoryEntityStore, "withTransaction">, overrides: Partial<TenantBackfillInput> = {}): TenantBackfillInput {
  let n = 0;
  return {
    store,
    tenantId: TENANT,
    plan: false,
    auditor: new RecordingAuditor(),
    origin: { kind: "maintenance", operation: "bill_withholding_backfill", runId: "run_test" },
    classified: [],
    paymentEntity: "Payment",
    now: () => new Date("2026-11-23T10:00:00.000Z"),
    newRequestId: () => {
      n += 1;
      return `req_maint_run_test_${n}`;
    },
    ...overrides,
  };
}

async function onlyOutcome(store: InMemoryEntityStore, overrides: Partial<TenantBackfillInput> = {}): Promise<BillBackfillOutcome> {
  const report = await backfillTenantBills(input(store, overrides));
  expect(report.refusal).toBeNull();
  expect(report.bills).toHaveLength(1);
  return report.bills[0]!;
}

function refusalOf(outcome: BillBackfillOutcome): string | null {
  return outcome.kind === "refused" ? outcome.reason : null;
}

describe("deriveBillWithholding", () => {
  it("derives total less the control line, confirmed by the withholding lines", () => {
    const d = deriveBillWithholding({ total: "100.00", currency: "USD", lines: recognitionLines() });
    expect(d).toEqual({
      kind: "derived",
      withholdingUnits: 1000n,
      controlUnits: 9000n,
      controlLineId: "jl_ap",
      withholdingLineIds: ["jl_wht"],
    });
  });

  it("accepts a bill withheld in full, which has no control line because zero lines are dropped", () => {
    const d = deriveBillWithholding({
      total: "100.00",
      currency: "USD",
      lines: [line({ id: "jl_wht", description: WHT, credit: 100 })],
    });
    expect(d).toMatchObject({ kind: "derived", withholdingUnits: 10000n, controlLineId: null });
  });

  it("matches a legacy withholding line by description, whatever account it was posted to", () => {
    // Before ADR-0465 an uncoded withholding group posted to the input-tax account.
    const lines = recognitionLines().map((l) =>
      l["id"] === "jl_wht" ? { ...l, ledger_account_id: "tax_input" } : l,
    );
    expect(deriveBillWithholding({ total: 100, currency: "USD", lines })).toMatchObject({
      kind: "derived",
      withholdingUnits: 1000n,
    });
  });

  it("reads the document-currency columns and never the functional ones", () => {
    const lines = [
      line({ id: "jl_ap", currency: "EUR", description: BILL_CONTROL_DESCRIPTION, credit: 90, fx_rate: "1.1", functional_credit: 99 }),
      line({ id: "jl_wht", currency: "EUR", description: WHT, credit: 10, fx_rate: "1.1", functional_credit: 11 }),
    ];
    expect(deriveBillWithholding({ total: "100.00", currency: "EUR", lines })).toMatchObject({
      kind: "derived",
      withholdingUnits: 1000n,
      controlUnits: 9000n,
    });
  });

  it("derives zero for a degraded split, whose control line carries the whole total", () => {
    const lines = [line({ id: "jl_ap", description: BILL_CONTROL_DESCRIPTION, credit: 100 })];
    expect(deriveBillWithholding({ total: 100, currency: "USD", lines })).toMatchObject({
      kind: "derived",
      withholdingUnits: 0n,
    });
  });

  it("refuses a debit on a line recognition posts as a credit, even when the identity holds", () => {
    // 100 − 90 = 10 = the withholding line's credit, so only the off-side check can refuse this.
    const lines = [
      line({ id: "jl_ap", description: BILL_CONTROL_DESCRIPTION, credit: 90 }),
      line({ id: "jl_wht", description: WHT, debit: 5, credit: 10 }),
    ];
    const d = deriveBillWithholding({ total: 100, currency: "USD", lines });
    expect(d).toMatchObject({ kind: "refused", reason: "derivation_disagrees" });
    expect(d.kind === "refused" ? d.detail : "").toContain("jl_wht carries a debit");
  });

  it("ignores a self-assessed pair on the same credit side, which is not withholding", () => {
    const lines = [
      ...recognitionLines(),
      line({ id: "jl_rc_in", description: "Bill — input tax (VAT RC (reverse charge))", debit: 5 }),
      line({ id: "jl_rc_out", description: "Self-assessed tax payable (VAT RC (reverse charge))", credit: 5 }),
    ];
    expect(deriveBillWithholding({ total: "100.00", currency: "USD", lines })).toEqual({
      kind: "derived",
      withholdingUnits: 1000n,
      controlUnits: 9000n,
      controlLineId: "jl_ap",
      withholdingLineIds: ["jl_wht"],
    });
  });

  it("sums two withholding lines rather than taking the first", () => {
    const lines = [
      line({ id: "jl_exp", description: "Bill — expense", debit: 100 }),
      line({ id: "jl_ap", description: BILL_CONTROL_DESCRIPTION, credit: 90 }),
      line({ id: "jl_wht_a", description: `${WITHHOLDING_LINE_DESCRIPTION_PREFIX}WHT 6%)`, credit: 6 }),
      line({ id: "jl_wht_b", description: `${WITHHOLDING_LINE_DESCRIPTION_PREFIX}WHT 4%)`, credit: 4 }),
    ];
    expect(deriveBillWithholding({ total: "100.00", currency: "USD", lines })).toEqual({
      kind: "derived",
      withholdingUnits: 1000n,
      controlUnits: 9000n,
      controlLineId: "jl_ap",
      withholdingLineIds: ["jl_wht_a", "jl_wht_b"],
    });
  });
});

describe("compareStoredWithholding and classifyCoverage", () => {
  it("treats an unreadable stored value as a disagreement and never as absent", () => {
    expect(compareStoredWithholding(undefined, 1000n)).toBe("absent");
    expect(compareStoredWithholding(null, 1000n)).toBe("absent");
    expect(compareStoredWithholding("10.00", 1000n)).toBe("equal");
    expect(compareStoredWithholding(10, 1000n)).toBe("equal");
    expect(compareStoredWithholding("9.99", 1000n)).toBe("disagrees");
    expect(compareStoredWithholding("n/a", 1000n)).toBe("disagrees");
  });

  it("classifies the four coverage outcomes against total less withholding", () => {
    const base = { totalUnits: 10000n, withholdingUnits: 1000n };
    expect(classifyCoverage({ ...base, applied: 50, state: "approved" })).toEqual({
      kind: "still_open",
      owed: "90.00",
      applied: "50.00",
      outstanding: "40.00",
    });
    expect(classifyCoverage({ ...base, applied: 90, state: "approved" }).kind).toBe("now_covered");
    expect(classifyCoverage({ ...base, applied: 90, state: "paid" }).kind).toBe("settled");
    expect(classifyCoverage({ ...base, applied: 95, state: "approved" })).toMatchObject({
      kind: "overpaid",
      overpaidBy: "5.00",
    });
  });
});

describe("billWithholdingStampedFor", () => {
  it("is true for erp-core, which declares the field and stamps it on recognition", () => {
    expect(billWithholdingStampedFor(buildErpCorePack())).toBe(true);
  });

  it("is false for a manifest whose Bill does not declare the field", () => {
    const core = buildErpCorePack();
    const stripped: Manifest = {
      ...core,
      entities: (core.entities ?? []).map((e) =>
        e.name === "Bill" ? { ...e, fields: e.fields.filter((f) => f.name !== "withholding_total") } : e,
      ),
    };
    expect(billWithholdingStampedFor(stripped)).toBe(false);
  });
});

describe("backfillTenantBills", () => {
  it("stamps the derived figure with one audit row naming the entry and the control line", async () => {
    const store = new InMemoryEntityStore();
    await seeded(store, { payments: [90] });
    const auditor = new RecordingAuditor();
    const outcome = await onlyOutcome(store, { auditor });
    expect(outcome).toMatchObject({
      kind: "stamped",
      withholding: "10.00",
      written: true,
      entryId: "je_1",
      controlLineId: "jl_ap",
      withholdingLineIds: ["jl_wht"],
      coverage: { kind: "now_covered", owed: "90.00", applied: "90.00" },
    });
    expect((await store.get(TENANT, "Bill", "bill_1"))?.["withholding_total"]).toBe(10);
    expect(auditor.events).toHaveLength(1);
    expect(auditor.events[0]).toMatchObject({
      operationId: "bill.withholding_backfill",
      action: "update",
      entity: "Bill",
      recordId: "bill_1",
      actorUserId: null,
      detail: "entry je_1 control jl_ap",
      inTransaction: true,
      origin: { kind: "maintenance", operation: "bill_withholding_backfill", runId: "run_test" },
      before: { withholding_total: null },
      after: { withholding_total: "10.00" },
    });
  });

  it("is idempotent: a second run finds the same figure and writes nothing", async () => {
    const store = new InMemoryEntityStore();
    await seeded(store);
    const auditor = new RecordingAuditor();
    expect((await onlyOutcome(store, { auditor })).kind).toBe("stamped");
    const second = await onlyOutcome(store, { auditor });
    expect(second).toMatchObject({ kind: "already_stamped", withholding: "10.00" });
    expect(auditor.events).toHaveLength(1);
  });

  it("writes nothing and records nothing under --plan", async () => {
    const store = new InMemoryEntityStore();
    await seeded(store);
    const auditor = new RecordingAuditor();
    const outcome = await onlyOutcome(store, { auditor, plan: true });
    expect(outcome).toMatchObject({ kind: "stamped", written: false });
    expect((await store.get(TENANT, "Bill", "bill_1"))?.["withholding_total"]).toBeUndefined();
    expect(auditor.events).toHaveLength(0);
  });

  it("rolls the stamp back when the audit row cannot be written", async () => {
    const store = new InMemoryEntityStore();
    await seeded(store);
    const outcome = await onlyOutcome(store, { auditor: new RefusingAuditor() });
    expect(refusalOf(outcome)).toBe("audit_unrecorded");
    expect((await store.get(TENANT, "Bill", "bill_1"))?.["withholding_total"]).toBeUndefined();
  });

  it("stamps a bill withheld in full, whose entry has no control line", async () => {
    const store = new InMemoryEntityStore();
    await seeded(store, { lines: [line({ id: "jl_wht", description: WHT, credit: 100 })] });
    expect(await onlyOutcome(store)).toMatchObject({
      kind: "stamped",
      withholding: "100.00",
      controlLineId: null,
      coverage: { kind: "now_covered", owed: "0.00" },
    });
  });

  it("leaves a degraded split alone, since there is nothing withheld to record", async () => {
    const store = new InMemoryEntityStore();
    await seeded(store, { lines: [line({ id: "jl_ap", description: BILL_CONTROL_DESCRIPTION, credit: 100 })] });
    expect((await onlyOutcome(store)).kind).toBe("nothing_withheld");
    expect((await store.get(TENANT, "Bill", "bill_1"))?.["withholding_total"]).toBeUndefined();
  });

  it("reports a partly paid and an overpaid bill rather than refusing them", async () => {
    const partly = new InMemoryEntityStore();
    await seeded(partly, { payments: [50] });
    expect(await onlyOutcome(partly)).toMatchObject({
      kind: "stamped",
      coverage: { kind: "still_open", owed: "90.00", applied: "50.00", outstanding: "40.00" },
    });
    const over = new InMemoryEntityStore();
    await seeded(over, { payments: [100] });
    const outcome = await onlyOutcome(over);
    expect(outcome).toMatchObject({ kind: "stamped", coverage: { kind: "overpaid", overpaidBy: "10.00" } });
  });

  it("reads nothing applied when the manifest declares no payment entity", async () => {
    const store = new InMemoryEntityStore();
    await seeded(store, { payments: [90] });
    expect(await onlyOutcome(store, { paymentEntity: null })).toMatchObject({
      kind: "stamped",
      coverage: { kind: "still_open", owed: "90.00", applied: "0.00", outstanding: "90.00" },
    });
  });

  it("reports coverage unread when the payments cannot be read in full, and still stamps", async () => {
    let cursor = 0;
    const store = new (class extends InMemoryEntityStore {
      override async listPage(t: string, e: string, q: ListQuery): Promise<ListPage> {
        if (e !== "Payment") return super.listPage(t, e, q);
        const limit = q.limit;
        cursor += 1;
        return {
          records: Array.from({ length: limit }, (_, i) => ({
            id: `pay_${cursor}_${i}`,
            bill_id: "bill_1",
            amount: 1,
            state: "completed",
          })),
          nextCursor: `c${cursor}`,
        };
      }
    })();
    await seeded(store);
    expect(await onlyOutcome(store)).toMatchObject({ kind: "stamped", written: true, coverage: { kind: "unread" } });
  });

  it("leaves a zero-total bill alone: recognition posted no entry for it, and nothing is owed", async () => {
    const store = new InMemoryEntityStore();
    await seeded(store, { bill: { total: "0.00" }, entry: null, lines: [] });
    expect((await onlyOutcome(store)).kind).toBe("nothing_withheld");
    const report = await backfillTenantBills(input(store));
    expect(backfillRefusedAnything(null, [report])).toBe(false);
  });

  it("corrects a zero-total bill that nonetheless carries a withholding figure, to zero", async () => {
    const store = new InMemoryEntityStore();
    await seeded(store, { bill: { total: 0, withholding_total: 5 }, entry: null, lines: [] });
    const auditor = new RecordingAuditor();
    expect(await onlyOutcome(store, { auditor })).toMatchObject({
      kind: "stamped",
      withholding: "0.00",
      replaced: "5.00",
      entryId: null,
    });
    expect((await store.get(TENANT, "Bill", "bill_1"))?.["withholding_total"]).toBe(0);
    expect(auditor.events[0]).toMatchObject({ before: { withholding_total: "5.00" }, after: { withholding_total: "0.00" } });
  });

  it("replaces a stored figure the entry does not support with the ledger's, recording what it replaced", async () => {
    // A key a client typed into the document before the field was server-owned: every reader now
    // trusts it, so leaving it would let mark_paid through with nothing paid.
    const store = new InMemoryEntityStore();
    await seeded(store, { bill: { withholding_total: 100 } });
    const auditor = new RecordingAuditor();
    expect(await onlyOutcome(store, { auditor })).toMatchObject({
      kind: "stamped",
      withholding: "10.00",
      replaced: "100.00",
      written: true,
    });
    expect((await store.get(TENANT, "Bill", "bill_1"))?.["withholding_total"]).toBe(10);
    expect(auditor.events).toHaveLength(1);
    expect(auditor.events[0]).toMatchObject({ before: { withholding_total: "100.00" }, after: { withholding_total: "10.00" } });
  });

  it("replaces a stored figure on a bill whose entry withheld nothing, with zero", async () => {
    const store = new InMemoryEntityStore();
    await seeded(store, {
      bill: { withholding_total: 7 },
      lines: [line({ id: "jl_ap", description: BILL_CONTROL_DESCRIPTION, credit: 100 })],
    });
    expect(await onlyOutcome(store)).toMatchObject({ kind: "stamped", withholding: "0.00", replaced: "7.00" });
    expect((await store.get(TENANT, "Bill", "bill_1"))?.["withholding_total"]).toBe(0);
  });

  it("writes no replacement under --plan", async () => {
    const store = new InMemoryEntityStore();
    await seeded(store, { bill: { withholding_total: 100 } });
    expect(await onlyOutcome(store, { plan: true })).toMatchObject({ kind: "stamped", written: false, replaced: "100.00" });
    expect((await store.get(TENANT, "Bill", "bill_1"))?.["withholding_total"]).toBe(100);
  });

  it("skips draft and void bills entirely", async () => {
    const store = new InMemoryEntityStore();
    await seeded(store, { bill: { state: "draft" } });
    await store.create(TENANT, "Bill", { id: "bill_2", bill_number: "BILL-002", state: "void", total: 5 });
    const report = await backfillTenantBills(input(store));
    expect(report.bills).toEqual([]);
  });

  it("reports a bill whose state moved between the listing and the lock", async () => {
    const store = new (class extends InMemoryEntityStore {
      override async getLocked(t: string, e: string, id: string, lock: RowLock): Promise<EntityRecord | null> {
        const r = await super.getLocked(t, e, id, lock);
        return r === null ? null : { ...r, state: "void" };
      }
    })();
    await seeded(store);
    expect(await onlyOutcome(store)).toMatchObject({ kind: "state_changed", state: "void" });
  });

  it("refuses a tenant whose bills cannot be listed, and stamps none of them", async () => {
    const store = new (class extends InMemoryEntityStore {
      override async listPage(t: string, e: string, q: ListQuery): Promise<ListPage> {
        if (e === "Bill") throw new Error("connection reset");
        return super.listPage(t, e, q);
      }
    })();
    await seeded(store);
    const report = await backfillTenantBills(input(store));
    expect(report.refusal).toMatchObject({ reason: "bills_unreadable", detail: "Error" });
    expect(report.bills).toEqual([]);
  });
});

/**
 * Every bill refusal has a producer, driven through `backfillTenantBills` and not through the pure
 * derivation alone, so a reason no path can reach fails here rather than sitting in the vocabulary.
 */
interface RefusedRun {
  readonly outcome: BillBackfillOutcome;
  readonly store: InMemoryEntityStore;
  /** The bill as seeded, read before the pass ran. */
  readonly before: EntityRecord | null;
  /** Every audit event an auditor accepted: none, for a refusal. */
  readonly recorded: readonly EntityWriteAuditEvent[];
}

/** One pass over a seeded store, keeping what is needed to show a refusal wrote nothing. */
async function refusedRun(
  store: InMemoryEntityStore,
  overrides: Partial<TenantBackfillInput> = {},
): Promise<RefusedRun> {
  const before = await store.get(TENANT, "Bill", "bill_1");
  const recording = new RecordingAuditor();
  const outcome = await onlyOutcome(store, { auditor: recording, ...overrides });
  return { outcome, store, before, recorded: recording.events };
}

describe("every bill refusal has a producer", () => {
  const cases: Record<(typeof BACKFILL_BILL_REFUSALS)[number], () => Promise<RefusedRun>> = {
    bill_absent: async () => {
      const store = new (class extends InMemoryEntityStore {
        override async getLocked(): Promise<EntityRecord | null> {
          return null;
        }
      })();
      await seeded(store);
      return refusedRun(store);
    },
    bill_unreadable: async () => {
      const store = new (class extends InMemoryEntityStore {
        override async getLocked(): Promise<EntityRecord | null> {
          throw new Error("value too long: SECRET-VALUE");
        }
      })();
      await seeded(store);
      const run = await refusedRun(store);
      expect(run.outcome).toMatchObject({ detail: "Error" });
      return run;
    },
    bill_total_unreadable: async () => {
      const store = new InMemoryEntityStore();
      await seeded(store, { bill: { total: "n/a" } });
      return refusedRun(store);
    },
    bill_number_shared: async () => {
      const store = new InMemoryEntityStore();
      await seeded(store);
      await store.create(TENANT, "Bill", { id: "bill_2", bill_number: "BILL-001", state: "draft", total: 1 });
      return refusedRun(store);
    },
    recognition_entry_absent: async () => {
      const store = new InMemoryEntityStore();
      await seeded(store, { entry: null, lines: [] });
      return refusedRun(store);
    },
    recognition_entry_ambiguous: async () => {
      const store = new InMemoryEntityStore();
      await seeded(store);
      await store.create(TENANT, "JournalEntry", { id: "je_2", entry_number: "BILL-001-GL", state: "posted", source: "bill" });
      return refusedRun(store);
    },
    entry_not_posted: async () => {
      const store = new InMemoryEntityStore();
      await seeded(store, { entry: { state: "reversed" } });
      return refusedRun(store);
    },
    entry_source_mismatch: async () => {
      const store = new InMemoryEntityStore();
      await seeded(store, { entry: { source: "manual" } });
      return refusedRun(store);
    },
    entry_lines_unreadable: async () => {
      const store = new InMemoryEntityStore();
      const lines = [...recognitionLines()];
      for (let i = 0; i < 1000; i += 1) lines.push(line({ id: `jl_x${i}`, description: "note", debit: 0 }));
      await seeded(store, { lines });
      return refusedRun(store);
    },
    line_amount_unreadable: async () => {
      const store = new InMemoryEntityStore();
      await seeded(store, {
        lines: [line({ id: "jl_ap", description: BILL_CONTROL_DESCRIPTION, credit: "ninety" })],
      });
      return refusedRun(store);
    },
    control_line_absent: async () => {
      const store = new InMemoryEntityStore();
      await seeded(store, { lines: [line({ id: "jl_wht", description: WHT, credit: 10 })] });
      return refusedRun(store);
    },
    control_line_ambiguous: async () => {
      const store = new InMemoryEntityStore();
      await seeded(store, {
        lines: [
          line({ id: "jl_ap", description: BILL_CONTROL_DESCRIPTION, credit: 45 }),
          line({ id: "jl_ap2", description: BILL_CONTROL_DESCRIPTION, credit: 45 }),
          line({ id: "jl_wht", description: WHT, credit: 10 }),
        ],
      });
      return refusedRun(store);
    },
    currency_mismatch: async () => {
      const store = new InMemoryEntityStore();
      await seeded(store, { lines: recognitionLines().map((l) => ({ ...l, currency: "EUR" })) });
      return refusedRun(store);
    },
    derivation_disagrees: async () => {
      const store = new InMemoryEntityStore();
      // An approved bill edited after posting (before ADR-0419): the entry no longer sums to it.
      await seeded(store, { bill: { total: "105.00" } });
      return refusedRun(store);
    },
    audit_unrecorded: async () => {
      const store = new InMemoryEntityStore();
      await seeded(store);
      return refusedRun(store, { auditor: new RefusingAuditor() });
    },
  };

  for (const reason of BACKFILL_BILL_REFUSALS) {
    it(`produces ${reason}, and writes nothing`, async () => {
      const run = await cases[reason]();
      expect(refusalOf(run.outcome)).toBe(reason);
      expect(await run.store.get(TENANT, "Bill", "bill_1")).toEqual(run.before);
      expect(run.recorded).toEqual([]);
    });
  }

  it("covers the vocabulary exactly, with a remedy for each member", () => {
    expect(Object.keys(cases).sort()).toEqual([...BACKFILL_BILL_REFUSALS].sort());
    for (const reason of BACKFILL_BILL_REFUSALS) expect(BACKFILL_BILL_REFUSAL_REMEDY[reason].length).toBeGreaterThan(0);
  });

  it("leaves the stored figure untouched when the derivation refuses", async () => {
    const store = new InMemoryEntityStore();
    await seeded(store, { bill: { total: "105.00", withholding_total: 5 } });
    expect(refusalOf(await onlyOutcome(store))).toBe("derivation_disagrees");
    expect((await store.get(TENANT, "Bill", "bill_1"))?.["withholding_total"]).toBe(5);
  });
});

describe("report verdict and formatting", () => {
  const stamped: BillBackfillOutcome = {
    kind: "stamped",
    billId: "bill_1",
    billNumber: "BILL-001",
    withholding: "10.00",
    written: true,
    replaced: null,
    entryId: "je_1",
    controlLineId: "jl_ap",
    withholdingLineIds: ["jl_wht"],
    coverage: { kind: "now_covered", owed: "90.00", applied: "90.00" },
  };
  const report = (bills: readonly BillBackfillOutcome[]): BillWithholdingBackfillReport => ({
    runId: "run_test",
    plan: false,
    store: "pg",
    anchored: false,
    refusal: null,
    tenants: [{ tenantId: TENANT, refusal: null, bills }],
    ok: !backfillRefusedAnything(null, [{ tenantId: TENANT, refusal: null, bills }]),
  });

  it("is OK only when nothing at any level was refused", () => {
    expect(report([stamped]).ok).toBe(true);
    const refused: BillBackfillOutcome = {
      kind: "refused",
      billId: "bill_2",
      billNumber: "BILL-002",
      reason: "derivation_disagrees",
      detail: "x",
    };
    expect(report([stamped, refused]).ok).toBe(false);
    expect(backfillRefusedAnything(null, [{ tenantId: TENANT, refusal: { reason: "bills_unreadable", detail: "x" }, bills: [] }])).toBe(true);
    expect(backfillRefusedAnything({ reason: "not_stamped_here", detail: "x" }, [])).toBe(true);
  });

  it("names the run, the unanchored audit rows, each bill and the verdict", () => {
    const text = formatBillWithholdingBackfill(report([stamped]));
    expect(text).toContain("run run_test (applied)");
    expect(text).toContain("UNANCHORED");
    expect(text).toContain("BILL-001");
    expect(text).toContain("verdict: OK");
  });

  it("prints a run refusal and nothing else", () => {
    const text = formatBillWithholdingBackfill({
      ...report([]),
      tenants: [],
      refusal: { reason: "schema_not_provisioned", detail: "table_absent public.bill" },
      ok: false,
    });
    expect(text).toContain("REFUSED schema_not_provisioned: table_absent public.bill");
    expect(text).not.toContain("verdict");
  });

  it("tells the operator to re-run for bills paid while the pass ran, only when it stamped something", () => {
    expect(formatBillWithholdingBackfill(report([stamped]))).toContain("re-run to re-check the coverage");
    expect(formatBillWithholdingBackfill({ ...report([stamped]), plan: true })).not.toContain("re-run to re-check");
    expect(formatBillWithholdingBackfill(report([]))).not.toContain("re-run to re-check");
  });

  it("prints each tenant refusal with its remedy, and says a tenant on its own manifest is not covered", () => {
    for (const reason of BACKFILL_TENANT_REFUSALS) expect(BACKFILL_TENANT_REFUSAL_REMEDY[reason].length).toBeGreaterThan(0);
    const text = formatBillWithholdingBackfill({
      ...report([]),
      tenants: [{ tenantId: TENANT, refusal: { reason: "tenant_manifest_unsupported", detail: "own" }, bills: [] }],
      ok: false,
    });
    expect(text).toContain("REFUSED tenant_manifest_unsupported — own; not covered");
  });

  it("declares exactly three tenant refusals", () => {
    expect([...BACKFILL_TENANT_REFUSALS].sort()).toEqual(
      ["bills_unreadable", "tenant_manifest_unreadable", "tenant_manifest_unsupported"].sort(),
    );
  });
});
