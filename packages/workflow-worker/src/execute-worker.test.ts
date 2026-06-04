import type { ExecuteActivityResult } from "@crossengin/workflow-runtime";
import { describe, expect, it } from "vitest";

import type {
  ActivityExecuteClaim,
  ActivityExecuteClaimStore,
  ClaimScheduledActivitiesInput,
} from "./activity-execute-claim-store.js";
import { ActivityExecutorWorker, type ExecuteActivityEngine } from "./execute-worker.js";
import type { IntervalScheduler } from "./worker.js";

const NOW = new Date("2026-06-04T12:00:00.000Z");
const clock = { now: () => NOW };

function fakeStore(batch: ActivityExecuteClaim[]): ActivityExecuteClaimStore & { released: string[]; inputs: ClaimScheduledActivitiesInput[] } {
  const released: string[] = [];
  const inputs: ClaimScheduledActivitiesInput[] = [];
  return {
    released,
    inputs,
    async claimScheduledActivities(input) {
      inputs.push(input);
      return inputs.length === 1 ? batch : [];
    },
    async releaseActivity(activityId) {
      released.push(activityId);
    },
  };
}

function result(executed: boolean, status: ExecuteActivityResult["status"], activityId: string): ExecuteActivityResult {
  return { executed, status, activityId, instanceId: "wfi_x" };
}

function fakeScheduler(): { scheduler: IntervalScheduler; tick: () => void; cleared: () => boolean } {
  let fn: (() => void) | null = null;
  let handle: object | null = null;
  return {
    scheduler: { setInterval(h) { fn = h; handle = {}; return handle; }, clearInterval(h) { if (h === handle) handle = null; } },
    tick: () => fn?.(),
    cleared: () => handle === null,
  };
}

describe("ActivityExecutorWorker.runOnce", () => {
  it("claims a batch, runs each scheduled activity, releases each lease", async () => {
    const store = fakeStore([{ activityId: "wfa_a", instanceRef: "wfi_1" }, { activityId: "wfa_b", instanceRef: "wfi_2" }]);
    const seen: string[] = [];
    const engine: ExecuteActivityEngine = {
      async executeActivity({ activityId }) {
        seen.push(activityId);
        return result(true, activityId === "wfa_a" ? "succeeded" : "failed", activityId);
      },
    };
    const worker = new ActivityExecutorWorker({ claimStore: store, engine, workerId: "w1", clock, leaseMs: 60_000, batchSize: 25 });
    const res = await worker.runOnce();
    expect(res).toEqual({ claimed: 2, executed: 2, succeeded: 1 });
    expect(seen).toEqual(["wfa_a", "wfa_b"]);
    expect(store.released).toEqual(["wfa_a", "wfa_b"]);
    expect(store.inputs[0]).toMatchObject({ workerId: "w1", limit: 25, leaseMs: 60_000, now: NOW });
  });

  it("releases the lease even if executeActivity throws", async () => {
    const store = fakeStore([{ activityId: "wfa_a", instanceRef: "wfi_1" }]);
    const engine: ExecuteActivityEngine = { async executeActivity() { throw new Error("boom"); } };
    await expect(new ActivityExecutorWorker({ claimStore: store, engine, workerId: "w1", clock }).runOnce()).rejects.toThrow();
    expect(store.released).toEqual(["wfa_a"]);
  });
});

describe("ActivityExecutorWorker — poll loop", () => {
  it("runs on each tick, routes errors, emits onRun, and stops cleanly", async () => {
    let runs = 0;
    const store: ActivityExecuteClaimStore = {
      async claimScheduledActivities() {
        runs += 1;
        if (runs === 2) throw new Error("db down");
        return [];
      },
      async releaseActivity() {},
    };
    const engine: ExecuteActivityEngine = { async executeActivity({ activityId }) { return result(true, "succeeded", activityId); } };
    const errors: unknown[] = [];
    const outcomes: Array<{ claimed: number; processed: number }> = [];
    const f = fakeScheduler();
    const worker = new ActivityExecutorWorker({ claimStore: store, engine, workerId: "w1", clock, scheduler: f.scheduler, onError: (e) => errors.push(e), onRun: (o) => outcomes.push(o) });
    worker.start(1000);
    f.tick();
    f.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(2);
    expect(errors).toHaveLength(1);
    expect(outcomes).toEqual([{ claimed: 0, processed: 0 }]);
    worker.stop();
    expect(f.cleared()).toBe(true);
  });
});
