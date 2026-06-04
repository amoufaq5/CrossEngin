import type { TimeoutActivityResult } from "@crossengin/workflow-runtime";
import { describe, expect, it } from "vitest";

import type {
  ActivityTimeoutClaim,
  ActivityTimeoutClaimStore,
  ClaimTimedOutActivitiesInput,
} from "./activity-timeout-claim-store.js";
import { ActivityTimeoutSweeperWorker, type TimeoutActivityEngine } from "./activity-timeout-worker.js";
import type { IntervalScheduler } from "./worker.js";

const NOW = new Date("2026-06-04T12:00:00.000Z");
const clock = { now: () => NOW };

function fakeStore(batch: ActivityTimeoutClaim[]): ActivityTimeoutClaimStore & { released: string[]; inputs: ClaimTimedOutActivitiesInput[] } {
  const released: string[] = [];
  const inputs: ClaimTimedOutActivitiesInput[] = [];
  return {
    released,
    inputs,
    async claimTimedOutActivities(input) {
      inputs.push(input);
      return inputs.length === 1 ? batch : [];
    },
    async releaseActivity(activityId) {
      released.push(activityId);
    },
  };
}

function result(timedOut: boolean, activityId: string): TimeoutActivityResult {
  return { timedOut, activityId, instanceId: "wfi_x" };
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

describe("ActivityTimeoutSweeperWorker.runOnce", () => {
  it("claims a batch, times out each, releases each lease", async () => {
    const store = fakeStore([{ activityId: "wfa_a", instanceRef: "wfi_1" }, { activityId: "wfa_b", instanceRef: "wfi_2" }]);
    const seen: string[] = [];
    const engine: TimeoutActivityEngine = {
      async timeoutActivity({ activityId }) {
        seen.push(activityId);
        return result(activityId === "wfa_a", activityId);
      },
    };
    const worker = new ActivityTimeoutSweeperWorker({ claimStore: store, engine, workerId: "w1", clock, leaseMs: 60_000, batchSize: 25 });
    const res = await worker.runOnce();
    expect(res).toEqual({ claimed: 2, timedOut: 1 });
    expect(seen).toEqual(["wfa_a", "wfa_b"]);
    expect(store.released).toEqual(["wfa_a", "wfa_b"]);
    expect(store.inputs[0]).toMatchObject({ workerId: "w1", limit: 25, leaseMs: 60_000, now: NOW });
  });

  it("releases the lease even if timeoutActivity throws", async () => {
    const store = fakeStore([{ activityId: "wfa_a", instanceRef: "wfi_1" }]);
    const engine: TimeoutActivityEngine = { async timeoutActivity() { throw new Error("boom"); } };
    await expect(new ActivityTimeoutSweeperWorker({ claimStore: store, engine, workerId: "w1", clock }).runOnce()).rejects.toThrow();
    expect(store.released).toEqual(["wfa_a"]);
  });
});

describe("ActivityTimeoutSweeperWorker — poll loop", () => {
  it("runs on each tick, routes errors, emits onRun, and stops cleanly", async () => {
    let runs = 0;
    const store: ActivityTimeoutClaimStore = {
      async claimTimedOutActivities() {
        runs += 1;
        if (runs === 2) throw new Error("db down");
        return [];
      },
      async releaseActivity() {},
    };
    const engine: TimeoutActivityEngine = { async timeoutActivity({ activityId }) { return result(true, activityId); } };
    const errors: unknown[] = [];
    const outcomes: Array<{ claimed: number; processed: number }> = [];
    const f = fakeScheduler();
    const worker = new ActivityTimeoutSweeperWorker({ claimStore: store, engine, workerId: "w1", clock, scheduler: f.scheduler, onError: (e) => errors.push(e), onRun: (o) => outcomes.push(o) });
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
