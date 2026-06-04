import type { PgConnection } from "@crossengin/kernel-pg";
import type { ExecuteActivityResult, FireTimerResult, RetryActivityResult, TickTimersResult, TimeoutActivityResult, TimeoutInstanceResult } from "@crossengin/workflow-runtime";
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
  async timeoutInstance(): Promise<TimeoutInstanceResult> {
    return { timedOut: false, instanceId: "wfi_x", previousStatus: null };
  },
  async executeActivity(): Promise<ExecuteActivityResult> {
    return { executed: false, status: null, activityId: "wfa_x", instanceId: "wfi_x" };
  },
  async timeoutActivity(): Promise<TimeoutActivityResult> {
    return { timedOut: false, activityId: "wfa_x", instanceId: "wfi_x" };
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
  timeoutIntervalMs: 12000,
  executeIntervalMs: 3000,
  reapIntervalMs: 20000,
  resyncIntervalMs: 120000,
  resyncMax: 250,
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

  it("mode=timeout wires the instance + activity timeout sweepers, polling timeoutIntervalMs", () => {
    const { scheduler, registered } = recordingScheduler();
    const set = buildWorkerSet({ ...baseInput, conn: fakeConn(), mode: "timeout", scheduler });
    expect(set.labels).toEqual(["timeout", "activity-timeout"]);
    set.start();
    expect(registered.map((r) => r.ms)).toEqual([12000, 12000]);
  });

  it("mode=execute wires the async activity executor, polling executeIntervalMs", () => {
    const { scheduler, registered } = recordingScheduler();
    const set = buildWorkerSet({ ...baseInput, conn: fakeConn(), mode: "execute", scheduler });
    expect(set.labels).toEqual(["execute"]);
    set.start();
    expect(registered.map((r) => r.ms)).toEqual([3000]);
  });

  it("mode=reap wires the lease reaper, polling reapIntervalMs", () => {
    const { scheduler, registered } = recordingScheduler();
    const set = buildWorkerSet({ ...baseInput, conn: fakeConn(), mode: "reap", scheduler });
    expect(set.labels).toEqual(["reap"]);
    set.start();
    expect(registered.map((r) => r.ms)).toEqual([20000]);
  });

  it("mode=all wires claim + retry + timeout (instance+activity) + execute + reap, each on its own interval", () => {
    const { scheduler, registered } = recordingScheduler();
    const set = buildWorkerSet({ ...baseInput, conn: fakeConn(), mode: "all", scheduler });
    expect(set.labels).toEqual(["claim", "retry", "timeout", "activity-timeout", "execute", "reap"]);
    set.start();
    expect(registered.map((r) => r.ms)).toEqual([1000, 8000, 12000, 12000, 3000, 20000]);
  });

  it("stop() clears every registered interval", () => {
    const { scheduler, registered } = recordingScheduler();
    const set = buildWorkerSet({ ...baseInput, conn: fakeConn(), mode: "all", scheduler });
    set.start();
    set.stop();
    expect(registered.every((r) => r.cleared)).toBe(true);
  });

  it("mode=resync wires the drift sweeper over the resyncer, polling resyncIntervalMs", () => {
    const { scheduler, registered } = recordingScheduler();
    const resyncer = { async bulkResync() { return []; } };
    const set = buildWorkerSet({ ...baseInput, conn: fakeConn(), mode: "resync", scheduler, resyncer });
    expect(set.labels).toEqual(["resync"]);
    set.start();
    expect(registered.map((r) => r.ms)).toEqual([120000]);
  });

  it("mode=resync without a resyncer throws", () => {
    expect(() => buildWorkerSet({ ...baseInput, conn: fakeConn(), mode: "resync" })).toThrow(/requires a resyncer/);
  });

  it("mode=all does NOT include resync (opt-in only)", () => {
    const { scheduler } = recordingScheduler();
    const set = buildWorkerSet({ ...baseInput, conn: fakeConn(), mode: "all", scheduler });
    expect(set.labels).not.toContain("resync");
  });

  it("rejects an invalid schema name (via the claim store)", () => {
    expect(() =>
      buildWorkerSet({ ...baseInput, conn: fakeConn(), mode: "claim", schema: "bad; DROP" }),
    ).toThrow(/invalid schema/);
  });

  it("threads onRun into the workers (invoked per poll with a normalized outcome)", async () => {
    const { scheduler, registered } = recordingScheduler();
    const outcomes: Array<{ claimed: number; processed: number }> = [];
    const set = buildWorkerSet({ ...baseInput, conn: fakeConn(), mode: "claim", scheduler, onRun: (o) => outcomes.push(o) });
    set.start();
    registered[0]?.handler(); // simulate a poll tick
    await new Promise((r) => setTimeout(r, 0));
    expect(outcomes).toEqual([{ claimed: 0, processed: 0 }]); // fakeConn returns no rows
  });
});
