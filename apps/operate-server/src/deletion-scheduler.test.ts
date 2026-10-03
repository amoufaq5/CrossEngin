import { describe, expect, it } from "vitest";

import {
  DeletionScheduler,
  type StrandedReconcilerLike,
  type DeletionRunnerLike,
} from "./deletion-scheduler.js";
import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

interface FakeScheduler extends IntervalScheduler {
  readonly fire: () => void;
  readonly intervals: number[];
  readonly cleared: number;
}

function fakeScheduler(): FakeScheduler {
  let handler: (() => void) | null = null;
  const intervals: number[] = [];
  let cleared = 0;
  const s = {
    setInterval(h: () => void, ms: number): IntervalHandle {
      handler = h;
      intervals.push(ms);
      return 1 as unknown as IntervalHandle;
    },
    clearInterval(): void {
      cleared += 1;
      handler = null;
    },
    fire: (): void => handler?.(),
    intervals,
    get cleared(): number {
      return cleared;
    },
  };
  return s as FakeScheduler;
}

function runner(behaviour: { throws?: boolean; results?: number } = {}): {
  readonly runner: DeletionRunnerLike;
  readonly limits: (number | undefined)[];
} {
  const limits: (number | undefined)[] = [];
  return {
    limits,
    runner: {
      runDue: async (limit) => {
        limits.push(limit);
        if (behaviour.throws === true) throw new Error("the database is gone");
        return Array.from({ length: behaviour.results ?? 0 }, (_v, i) => ({
          requestId: `dreq_abcdefgh123${i.toString()}`,
          tenantId: "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
          outcome: "completed",
          tombstoneId: "tomb_aaaabbbbccccdddd",
          detail: null,
        }));
      },
    },
  };
}

describe("DeletionScheduler", () => {
  it("does NOT run on start, unlike every sibling scheduler", () => {
    const sched = fakeScheduler();
    const r = runner();
    new DeletionScheduler({ runner: r.runner, intervalMs: 60_000, scheduler: sched }).start();
    // A boot is when a misconfiguration is most likely and the work here is irreversible, so an
    // operator who restarts to fix something gets a full interval's grace.
    expect(r.limits).toEqual([]);
    expect(sched.intervals).toEqual([60_000]);
  });

  it("runs the due batch on each tick", async () => {
    const sched = fakeScheduler();
    const r = runner({ results: 1 });
    const seen: string[][] = [];
    const s = new DeletionScheduler({
      runner: r.runner,
      intervalMs: 1000,
      scheduler: sched,
      onRun: (results) => seen.push(results.map((x) => x.requestId)),
    });
    s.start();
    await s.runOnce();
    expect(r.limits).toEqual([5]);
    expect(seen).toEqual([["dreq_abcdefgh1230"]]);
  });

  it("stays quiet when nothing is due", async () => {
    const sched = fakeScheduler();
    const r = runner({ results: 0 });
    let called = 0;
    const s = new DeletionScheduler({
      runner: r.runner,
      intervalMs: 1000,
      scheduler: sched,
      onRun: () => {
        called += 1;
      },
    });
    await s.runOnce();
    expect(called).toBe(0);
  });

  it("uses the configured batch size", async () => {
    const r = runner();
    const s = new DeletionScheduler({
      runner: r.runner,
      intervalMs: 1000,
      batchSize: 1,
      scheduler: fakeScheduler(),
    });
    await s.runOnce();
    expect(r.limits).toEqual([1]);
  });

  it("routes a failed tick to onError rather than throwing out of the timer", async () => {
    const errors: unknown[] = [];
    const r = runner({ throws: true });
    const s = new DeletionScheduler({
      runner: r.runner,
      intervalMs: 1000,
      scheduler: fakeScheduler(),
      onError: (e) => errors.push(e),
    });
    await expect(s.runOnce()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("is idempotent on start and stops cleanly", () => {
    const sched = fakeScheduler();
    const s = new DeletionScheduler({ runner: runner().runner, intervalMs: 1000, scheduler: sched });
    s.start();
    s.start();
    expect(sched.intervals).toEqual([1000]);
    s.stop();
    s.stop();
    expect(sched.cleared).toBe(1);
  });
});

describe("DeletionScheduler — reconciliation", () => {
  function reconciler(behaviour: { throws?: boolean; repaired?: number } = {}): {
    readonly reconciler: StrandedReconcilerLike;
    readonly limits: (number | undefined)[];
  } {
    const limits: (number | undefined)[] = [];
    return {
      limits,
      reconciler: {
        reconcileStranded: async (limit) => {
          limits.push(limit);
          if (behaviour.throws === true) throw new Error("evidence unreadable");
          return Array.from({ length: behaviour.repaired ?? 0 }, (_v, i) => ({
            requestId: `dreq_repaired1234${i.toString()}`,
            tenantId: "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
            verdict: "completed_by_evidence",
            applied: true,
            tombstoneId: "tomb_aaaabbbbccccdddd",
            tombstoneIds: ["tomb_aaaabbbbccccdddd"],
            detail: null,
          }));
        },
      },
    };
  }

  it("reconciles on each tick, after the due run", async () => {
    const order: string[] = [];
    const rec = reconciler({ repaired: 1 });
    const seen: string[][] = [];
    const s = new DeletionScheduler({
      runner: {
        runDue: async () => {
          order.push("runDue");
          return [];
        },
      },
      reconciler: {
        reconcileStranded: async (limit) => {
          order.push("reconcile");
          return rec.reconciler.reconcileStranded(limit);
        },
      },
      intervalMs: 1000,
      scheduler: fakeScheduler(),
      onReconciled: (r) => seen.push(r.map((x) => x.requestId)),
    });
    await s.runOnce();
    expect(order).toEqual(["runDue", "reconcile"]);
    expect(seen).toEqual([["dreq_repaired12340"]]);
  });

  it("still reconciles on a tick whose due run threw", async () => {
    const errors: unknown[] = [];
    const rec = reconciler({ repaired: 1 });
    const s = new DeletionScheduler({
      runner: runner({ throws: true }).runner,
      reconciler: rec.reconciler,
      intervalMs: 1000,
      scheduler: fakeScheduler(),
      onError: (e) => errors.push(e),
    });
    await s.runOnce();
    // The most likely reason a request is stranded is that a run failed, so the repair pass must not
    // be skipped by the failure that caused it.
    expect(rec.limits).toEqual([5]);
    expect(errors).toHaveLength(1);
  });

  it("routes a failed reconciliation to onError without failing the tick", async () => {
    const errors: unknown[] = [];
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: reconciler({ throws: true }).reconciler,
      intervalMs: 1000,
      scheduler: fakeScheduler(),
      onError: (e) => errors.push(e),
    });
    await expect(s.runOnce()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("stays quiet when nothing needed repairing", async () => {
    let called = 0;
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: reconciler({ repaired: 0 }).reconciler,
      intervalMs: 1000,
      scheduler: fakeScheduler(),
      onReconciled: () => {
        called += 1;
      },
    });
    await s.runOnce();
    expect(called).toBe(0);
  });

  it("reports nothing for a verdict it did not apply, however many ticks run", async () => {
    const seen: unknown[] = [];
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: {
        reconcileStranded: async () => [
          {
            requestId: "dreq_pending12345",
            tenantId: "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
            verdict: "too_recent",
            applied: false,
            tombstoneId: null,
            tombstoneIds: [],
            detail: null,
          },
        ],
      },
      intervalMs: 1000,
      scheduler: fakeScheduler(),
      onReconciled: (r) => seen.push(r),
    });
    await s.runOnce();
    await s.runOnce();
    // A standing fact about a row would otherwise be logged every interval for as long as the row
    // exists; the stranded listing is where an operator reads it.
    expect(seen).toEqual([]);
  });

  it("works with no reconciler wired at all", async () => {
    const s = new DeletionScheduler({
      runner: runner().runner,
      intervalMs: 1000,
      scheduler: fakeScheduler(),
    });
    await expect(s.runOnce()).resolves.toBeUndefined();
  });
});
