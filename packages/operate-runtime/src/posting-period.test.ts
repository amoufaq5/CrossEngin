import { describe, expect, it } from "vitest";

import { isPostingRefused, postingPeriodFor, PostingRefused, resolvePostingPeriod } from "./posting-period.js";
import { InMemoryEntityStore } from "./store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

async function calendar(rows: Record<string, unknown>[]): Promise<{ store: InMemoryEntityStore; ids: string[] }> {
  const store = new InMemoryEntityStore();
  const ids: string[] = [];
  for (const r of rows) ids.push(String((await store.create(TENANT, "FiscalPeriod", r))["id"]));
  return { store, ids };
}

describe("resolvePostingPeriod", () => {
  it("answers the one ordinary period covering the date, by its id", async () => {
    const { store, ids } = await calendar([
      { start_date: "2026-05-01", end_date: "2026-05-31", status: "open" },
      { start_date: "2026-06-01", end_date: "2026-06-30", status: "open" },
    ]);
    expect(await resolvePostingPeriod(store, TENANT, "2026-06-30")).toEqual({ kind: "open", periodId: ids[1] });
    expect(await resolvePostingPeriod(store, TENANT, "2026-06-01T23:00:00.000Z")).toEqual({ kind: "open", periodId: ids[1] });
  });

  it("answers no period for a date no period covers", async () => {
    const { store } = await calendar([{ start_date: "2026-06-01", end_date: "2026-06-30", status: "closed" }]);
    expect(await resolvePostingPeriod(store, TENANT, "2026-07-01")).toEqual({ kind: "open", periodId: null });
  });

  it("refuses a date in a closed or locked period, and admits one in a closing period", async () => {
    for (const status of ["closed", "locked"]) {
      const { store } = await calendar([{ start_date: "2026-06-01", end_date: "2026-06-30", status }]);
      expect(await resolvePostingPeriod(store, TENANT, "2026-06-15")).toEqual({ kind: "locked", status });
    }
    const { store, ids } = await calendar([{ start_date: "2026-06-01", end_date: "2026-06-30", status: "closing" }]);
    expect(await resolvePostingPeriod(store, TENANT, "2026-06-15")).toEqual({ kind: "open", periodId: ids[0] });
  });

  it("prefers the ordinary period over an adjustment period sharing its dates", async () => {
    const { store, ids } = await calendar([
      { start_date: "2026-12-01", end_date: "2026-12-31", status: "open" },
      { start_date: "2026-12-31", end_date: "2026-12-31", status: "closed", is_adjustment: true },
    ]);
    expect(await resolvePostingPeriod(store, TENANT, "2026-12-31")).toEqual({ kind: "open", periodId: ids[0] });
  });

  it("falls back to the adjustment period when it is the only one covering the date", async () => {
    const { store } = await calendar([{ start_date: "2026-12-31", end_date: "2026-12-31", status: "locked", is_adjustment: true }]);
    expect(await resolvePostingPeriod(store, TENANT, "2026-12-31")).toEqual({ kind: "locked", status: "locked" });
  });

  it("refuses when any of two overlapping ordinary periods is locked, and stamps neither when both are open", async () => {
    const locked = await calendar([
      { start_date: "2026-06-01", end_date: "2026-06-30", status: "open" },
      { start_date: "2026-06-15", end_date: "2026-07-15", status: "closed" },
    ]);
    expect(await resolvePostingPeriod(locked.store, TENANT, "2026-06-20")).toEqual({ kind: "locked", status: "closed" });
    const open = await calendar([
      { start_date: "2026-06-01", end_date: "2026-06-30", status: "open" },
      { start_date: "2026-06-15", end_date: "2026-07-15", status: "open" },
    ]);
    expect(await resolvePostingPeriod(open.store, TENANT, "2026-06-20")).toEqual({ kind: "open", periodId: null });
  });

  it("refuses rather than decides past its ceiling", async () => {
    const { store } = await calendar([
      { start_date: "2026-06-01", end_date: "2026-06-30", status: "open" },
      { start_date: "2026-06-01", end_date: "2026-06-30", status: "open" },
    ]);
    const err = await resolvePostingPeriod(store, TENANT, "2026-06-10", { ceiling: 1 }).catch((e: unknown) => e);
    expect(isPostingRefused(err) && err.error).toBe("period_unresolvable");
  });
});

describe("postingPeriodFor", () => {
  it("resolves nothing when the manifest keeps no calendar", async () => {
    const { store } = await calendar([{ start_date: "2026-06-01", end_date: "2026-06-30", status: "closed" }]);
    expect(await postingPeriodFor(store, TENANT, "2026-06-15", undefined)).toBeNull();
  });

  it("throws a named 422 for a locked period, carrying only the date and the state", async () => {
    const { store } = await calendar([{ start_date: "2026-06-01", end_date: "2026-06-30", status: "closed", name: "SECRET" }]);
    const err = await postingPeriodFor(store, TENANT, "2026-06-15", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PostingRefused);
    expect(isPostingRefused(err) && [err.status, err.error, err.detail]).toEqual([
      422,
      "period_locked",
      "the posting date 2026-06-15 falls in a fiscal period that is 'closed'",
    ]);
  });
});

/** Records each `getLocked` so a test can see which rows the decision was taken under. */
class RecordingStore extends InMemoryEntityStore {
  readonly locked: { entity: string; id: string; lock: string }[] = [];
  override async getLocked(
    tenantId: string,
    entity: string,
    id: string,
    lock: "share" | "exclusive",
  ): Promise<Record<string, unknown> | null> {
    this.locked.push({ entity, id, lock });
    return super.getLocked(tenantId, entity, id, lock);
  }
}

describe("resolvePostingPeriod under a concurrent close (ADR-0480, ADR-0432 Q6)", () => {
  it("takes a share lock on every covering period, in id order, and on nothing else", async () => {
    const store = new RecordingStore();
    const a = await store.create(TENANT, "FiscalPeriod", { start_date: "2026-06-01", end_date: "2026-06-30", status: "open" });
    const b = await store.create(TENANT, "FiscalPeriod", {
      start_date: "2026-06-30",
      end_date: "2026-06-30",
      status: "open",
      is_adjustment: true,
    });
    await store.create(TENANT, "FiscalPeriod", { start_date: "2026-07-01", end_date: "2026-07-31", status: "open" });
    await resolvePostingPeriod(store, TENANT, "2026-06-30");
    const expected = [String(a["id"]), String(b["id"])].sort();
    expect(store.locked).toEqual(expected.map((id) => ({ entity: "FiscalPeriod", id, lock: "share" })));
  });

  it("decides from the period as the close commits it, not from the row the scan read before", async () => {
    const store = new InMemoryEntityStore();
    const period = await store.create(TENANT, "FiscalPeriod", { start_date: "2026-06-01", end_date: "2026-06-30", status: "open" });
    const id = String(period["id"]);
    let releaseClose!: () => void;
    const closeMayCommit = new Promise<void>((r) => (releaseClose = r));
    let closeHolds!: () => void;
    const closeHoldsLock = new Promise<void>((r) => (closeHolds = r));

    // The close: a transition holding the period exclusively until it commits.
    const close = store.withTransaction(TENANT, async (tx) => {
      await tx.getLocked(TENANT, "FiscalPeriod", id, "exclusive");
      closeHolds();
      await closeMayCommit;
      await tx.update(TENANT, "FiscalPeriod", id, { status: "closed" });
    });
    await closeHoldsLock;
    // The post: resolves its period inside its own transaction while the close is in flight.
    const post = store.withTransaction(TENANT, (tx) => resolvePostingPeriod(tx, TENANT, "2026-06-15"));
    await new Promise((r) => setTimeout(r, 10));
    releaseClose();
    await close;
    expect(await post).toEqual({ kind: "locked", status: "closed" });
  });

  it("drops a covering row that a concurrent write moved off the date", async () => {
    const store = new InMemoryEntityStore();
    const period = await store.create(TENANT, "FiscalPeriod", { start_date: "2026-06-01", end_date: "2026-06-30", status: "closed" });
    const id = String(period["id"]);
    let released!: () => void;
    const mayCommit = new Promise<void>((r) => (released = r));
    let holds!: () => void;
    const holding = new Promise<void>((r) => (holds = r));
    const move = store.withTransaction(TENANT, async (tx) => {
      await tx.getLocked(TENANT, "FiscalPeriod", id, "exclusive");
      holds();
      await mayCommit;
      await tx.update(TENANT, "FiscalPeriod", id, { start_date: "2026-07-01", end_date: "2026-07-31" });
    });
    await holding;
    const post = store.withTransaction(TENANT, (tx) => resolvePostingPeriod(tx, TENANT, "2026-06-15"));
    await new Promise((r) => setTimeout(r, 10));
    released();
    await move;
    expect(await post).toEqual({ kind: "open", periodId: null });
  });
});
