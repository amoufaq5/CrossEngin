import { describe, expect, it } from "vitest";

import { DeletionScheduler, type DeletionRunnerLike } from "./deletion-scheduler.js";
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
