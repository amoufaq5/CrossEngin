import type { PgConnection } from "@crossengin/kernel-pg";
import type { TickTimersResult } from "@crossengin/workflow-runtime";
import { describe, expect, it, vi } from "vitest";

import { advisoryLockKey } from "./lock-key.js";
import { WorkflowWorker, type IntervalScheduler, type TimerTickEngine } from "./worker.js";

const NOW = new Date("2026-06-03T12:00:00.000Z");
const clock = { now: () => NOW };

function emptyResult(fired: string[] = []): TickTimersResult {
  return { firedTimerIds: fired, affectedInstanceIds: [] };
}

/** A PgConnection whose withAdvisoryLock is a real async mutex (shared lock state). */
function lockingConn(state: { held: boolean; queue: Array<() => void>; calls: bigint[] }): PgConnection {
  return {
    query: vi.fn() as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(key: bigint, fn: () => Promise<T>) => {
      state.calls.push(key);
      if (state.held) await new Promise<void>((res) => state.queue.push(res));
      state.held = true;
      try {
        return await fn();
      } finally {
        state.held = false;
        const next = state.queue.shift();
        if (next) next();
      }
    }) as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

function fakeScheduler(): { scheduler: IntervalScheduler; tick: () => void; cleared: () => boolean } {
  let fn: (() => void) | null = null;
  let handle: object | null = null;
  return {
    scheduler: {
      setInterval(handler) {
        fn = handler;
        handle = {};
        return handle;
      },
      clearInterval(h) {
        if (h === handle) handle = null;
      },
    },
    tick: () => fn?.(),
    cleared: () => handle === null,
  };
}

describe("WorkflowWorker.tickOnce", () => {
  it("ticks timers under the advisory lock and reports the result", async () => {
    const state = { held: false, queue: [], calls: [] as bigint[] };
    const conn = lockingConn(state);
    const engine: TimerTickEngine = { tickTimers: async () => emptyResult(["wft_a", "wft_b"]) };
    const ticks: TickTimersResult[] = [];
    const worker = new WorkflowWorker({ conn, engine, clock, onTick: (r) => ticks.push(r) });

    const result = await worker.tickOnce();
    expect(result.firedTimerIds).toEqual(["wft_a", "wft_b"]);
    expect(state.calls).toEqual([advisoryLockKey("crossengin.workflow.tick")]); // default lock key
    expect(ticks).toHaveLength(1);
    expect(worker.status()).toMatchObject({ tickCount: 1, lastFiredCount: 2, lastTickAt: NOW.toISOString() });
  });

  it("passes the engine the clock's now in ms", async () => {
    const state = { held: false, queue: [], calls: [] as bigint[] };
    const seen: number[] = [];
    const engine: TimerTickEngine = {
      tickTimers: async (nowMs) => {
        seen.push(nowMs);
        return emptyResult();
      },
    };
    await new WorkflowWorker({ conn: lockingConn(state), engine, clock }).tickOnce();
    expect(seen).toEqual([NOW.getTime()]);
  });

  it("honors a custom lock key", async () => {
    const state = { held: false, queue: [], calls: [] as bigint[] };
    const engine: TimerTickEngine = { tickTimers: async () => emptyResult() };
    await new WorkflowWorker({ conn: lockingConn(state), engine, clock, lockKey: 42n }).tickOnce();
    expect(state.calls).toEqual([42n]);
  });
});

describe("WorkflowWorker — distributed coordination", () => {
  it("serializes concurrent ticks across workers sharing the lock (no overlap)", async () => {
    const state = { held: false, queue: [], calls: [] as bigint[] };
    let active = 0;
    let maxActive = 0;
    const engine: TimerTickEngine = {
      tickTimers: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve(); // yield while "running"
        active -= 1;
        return emptyResult();
      },
    };
    // two workers, two connections that share one lock state (same Postgres advisory lock)
    const a = new WorkflowWorker({ conn: lockingConn(state), engine, clock });
    const b = new WorkflowWorker({ conn: lockingConn(state), engine, clock });
    await Promise.all([a.tickOnce(), b.tickOnce()]);
    expect(maxActive).toBe(1); // the advisory lock prevented overlapping ticks
  });
});

describe("WorkflowWorker — poll loop", () => {
  it("ticks on each interval and stops cleanly", async () => {
    const state = { held: false, queue: [], calls: [] as bigint[] };
    let count = 0;
    const engine: TimerTickEngine = {
      tickTimers: async () => {
        count += 1;
        return emptyResult();
      },
    };
    const f = fakeScheduler();
    const worker = new WorkflowWorker({ conn: lockingConn(state), engine, clock, scheduler: f.scheduler });
    worker.start(1000);
    expect(worker.status().running).toBe(true);
    f.tick();
    f.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(count).toBe(2);
    worker.stop();
    expect(f.cleared()).toBe(true);
  });

  it("routes a tick error to onError without throwing from the loop", async () => {
    const state = { held: false, queue: [], calls: [] as bigint[] };
    const engine: TimerTickEngine = {
      tickTimers: async () => {
        throw new Error("boom");
      },
    };
    const errors: unknown[] = [];
    const f = fakeScheduler();
    const worker = new WorkflowWorker({ conn: lockingConn(state), engine, clock, scheduler: f.scheduler, onError: (e) => errors.push(e) });
    worker.start(1000);
    f.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    expect(worker.status().tickCount).toBe(0); // failed tick didn't count
  });
});
