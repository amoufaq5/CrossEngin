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
