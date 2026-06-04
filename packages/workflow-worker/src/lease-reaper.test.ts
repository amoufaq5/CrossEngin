import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { LeaseReaperWorker, PostgresLeaseReaper, type LeaseReaper } from "./lease-reaper.js";
import type { IntervalScheduler } from "./worker.js";

const NOW = new Date("2026-06-04T12:00:00.000Z");
const clock = { now: () => NOW };

function capturePg(rowCounts: number[]): { conn: PgConnection; calls: Array<{ sql: string; params: readonly unknown[] }> } {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const query = (async (sql: string, params?: readonly unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    return { rows: [], rowCount: rowCounts[calls.length - 1] ?? 0 };
  }) as PgConnection["query"];
  return { conn: { query, transaction: vi.fn() as PgConnection["transaction"], withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"], close: vi.fn() as PgConnection["close"] }, calls };
}

describe("PostgresLeaseReaper.reapExpired", () => {
  it("clears expired leases on the three lease tables and sums the counts", async () => {
    const cap = capturePg([2, 3, 1]); // timers, activities, instances
    const result = await new PostgresLeaseReaper(cap.conn).reapExpired(NOW);
    expect(result).toEqual({ timers: 2, activities: 3, instances: 1, total: 6 });
    expect(cap.calls).toHaveLength(3);
    expect(cap.calls[0]?.sql).toContain("meta.workflow_timers");
    expect(cap.calls[1]?.sql).toContain("meta.workflow_activities");
    expect(cap.calls[2]?.sql).toContain("meta.workflow_instances");
    for (const c of cap.calls) {
      expect(c.sql).toContain("SET claimed_by = NULL, lease_expires_at = NULL");
      expect(c.sql).toContain("lease_expires_at IS NOT NULL AND lease_expires_at < $1");
      expect(c.params).toEqual([NOW.toISOString()]);
    }
  });

  it("honors a custom schema and rejects an invalid one", async () => {
    const cap = capturePg([0, 0, 0]);
    await new PostgresLeaseReaper(cap.conn, { schema: "wf" }).reapExpired(NOW);
    expect(cap.calls[0]?.sql).toContain("wf.workflow_timers");
    expect(() => new PostgresLeaseReaper(cap.conn, { schema: "x; DROP" })).toThrow(/invalid schema/);
  });
});

function fakeScheduler(): { scheduler: IntervalScheduler; tick: () => void; cleared: () => boolean } {
  let fn: (() => void) | null = null;
  let handle: object | null = null;
  return {
    scheduler: { setInterval(h) { fn = h; handle = {}; return handle; }, clearInterval(h) { if (h === handle) handle = null; } },
    tick: () => fn?.(),
    cleared: () => handle === null,
  };
}

describe("LeaseReaperWorker", () => {
  it("runOnce returns the total reaped", async () => {
    const reaper: LeaseReaper = { async reapExpired() { return { timers: 1, activities: 2, instances: 0, total: 3 }; } };
    const res = await new LeaseReaperWorker({ reaper, clock }).runOnce();
    expect(res).toEqual({ reaped: 3 });
  });

  it("polls each tick, emits onRun, routes errors, and stops cleanly", async () => {
    let runs = 0;
    const reaper: LeaseReaper = {
      async reapExpired() {
        runs += 1;
        if (runs === 2) throw new Error("db down");
        return { timers: 1, activities: 0, instances: 0, total: 1 };
      },
    };
    const errors: unknown[] = [];
    const outcomes: Array<{ claimed: number; processed: number }> = [];
    const f = fakeScheduler();
    const worker = new LeaseReaperWorker({ reaper, clock, scheduler: f.scheduler, onError: (e) => errors.push(e), onRun: (o) => outcomes.push(o) });
    worker.start(1000);
    f.tick();
    f.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(2);
    expect(errors).toHaveLength(1);
    expect(outcomes).toEqual([{ claimed: 0, processed: 1 }]);
    worker.stop();
    expect(f.cleared()).toBe(true);
  });
});
