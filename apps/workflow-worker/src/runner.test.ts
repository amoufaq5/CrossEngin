import type { PgConnection } from "@crossengin/kernel-pg";
import type { FireTimerResult, RetryActivityResult, TickTimersResult } from "@crossengin/workflow-runtime";
import type { IntervalHandle, IntervalScheduler } from "@crossengin/workflow-worker";
import { describe, expect, it } from "vitest";

import { buildWorkerSet, type WorkerEngine } from "./runner.js";

function fakeConn(): PgConnection {
  return {
    async query() {
      return { rows: [], rowCount: 0 };
    },
    async transaction(fn) {
      return fn(fakeConn());
    },
    async withAdvisoryLock(_key, fn) {
      return fn();
    },
    async close() {},
  };
}

const engine: WorkerEngine = {
  async tickTimers(): Promise<TickTimersResult> {
    return { firedTimerIds: [], affectedInstanceIds: [] };
  },
  async fireTimer(): Promise<FireTimerResult> {
    return { fired: false, instanceId: "wfi_x", timerId: "wft_x", timerName: null };
  },
  async retryActivity(): Promise<RetryActivityResult> {
    return { retried: false, status: null, activityId: "wfa_x", instanceId: "wfi_x" };
  },
};

interface Registered {
  readonly handler: () => void;
  readonly ms: number;
  cleared: boolean;
}

function recordingScheduler(): { scheduler: IntervalScheduler; registered: Registered[] } {
  const registered: Registered[] = [];
  return {
    registered,
    scheduler: {
      setInterval(handler, ms): IntervalHandle {
        const entry: Registered = { handler, ms, cleared: false };
        registered.push(entry);
        return entry;
      },
      clearInterval(handle) {
        (handle as Registered).cleared = true;
      },
    },
  };
}

const baseInput = {
  engine,
  workerId: "w1",
  schema: null,
  tickIntervalMs: 5000,
  claimIntervalMs: 1000,
  retryIntervalMs: 8000,
  batchSize: 50,
  leaseMs: 30000,
};

describe("buildWorkerSet", () => {
  it("mode=tick wires the advisory-lock bulk worker only, polling tickIntervalMs", () => {
    const { scheduler, registered } = recordingScheduler();
    const set = buildWorkerSet({ ...baseInput, conn: fakeConn(), mode: "tick", scheduler });
    expect(set.labels).toEqual(["tick"]);
    set.start();
    expect(registered).toHaveLength(1);
    expect(registered[0]?.ms).toBe(5000);
  });

  it("mode=claim wires the timer claim worker, polling claimIntervalMs", () => {
    const { scheduler, registered } = recordingScheduler();
    const set = buildWorkerSet({ ...baseInput, conn: fakeConn(), mode: "claim", scheduler });
    expect(set.labels).toEqual(["claim"]);
    set.start();
    expect(registered.map((r) => r.ms)).toEqual([1000]);
  });

  it("mode=retry wires the retry executor, polling retryIntervalMs", () => {
    const { scheduler, registered } = recordingScheduler();
    const set = buildWorkerSet({ ...baseInput, conn: fakeConn(), mode: "retry", scheduler });
    expect(set.labels).toEqual(["retry"]);
    set.start();
    expect(registered.map((r) => r.ms)).toEqual([8000]);
  });

  it("mode=all wires claim + retry (the parallel combo), each on its own interval", () => {
    const { scheduler, registered } = recordingScheduler();
    const set = buildWorkerSet({ ...baseInput, conn: fakeConn(), mode: "all", scheduler });
    expect(set.labels).toEqual(["claim", "retry"]);
    set.start();
    expect(registered.map((r) => r.ms)).toEqual([1000, 8000]);
  });

  it("stop() clears every registered interval", () => {
    const { scheduler, registered } = recordingScheduler();
    const set = buildWorkerSet({ ...baseInput, conn: fakeConn(), mode: "all", scheduler });
    set.start();
    set.stop();
    expect(registered.every((r) => r.cleared)).toBe(true);
  });

  it("rejects an invalid schema name (via the claim store)", () => {
    expect(() =>
      buildWorkerSet({ ...baseInput, conn: fakeConn(), mode: "claim", schema: "bad; DROP" }),
    ).toThrow(/invalid schema/);
  });
});
