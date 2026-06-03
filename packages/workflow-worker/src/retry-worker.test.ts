import type { RetryActivityResult } from "@crossengin/workflow-runtime";
import { describe, expect, it } from "vitest";

import type { ActivityRetryClaim, ActivityRetryClaimStore, ClaimDueRetriesInput } from "./activity-claim-store.js";
import { RetryExecutorWorker, type RetryActivityEngine } from "./retry-worker.js";
import type { IntervalScheduler } from "./worker.js";

const NOW = new Date("2026-06-03T12:00:00.000Z");
const clock = { now: () => NOW };

function fakeStore(batch: ActivityRetryClaim[]): ActivityRetryClaimStore & { released: string[]; inputs: ClaimDueRetriesInput[] } {
  const released: string[] = [];
  const inputs: ClaimDueRetriesInput[] = [];
  return {
    released,
    inputs,
    async claimDueRetries(input) {
      inputs.push(input);
      return inputs.length === 1 ? batch : [];
    },
    async releaseActivity(activityId) {
      released.push(activityId);
    },
  };
}

function retryResult(retried: boolean, status: RetryActivityResult["status"], activityId: string): RetryActivityResult {
  return { retried, status, activityId, instanceId: "wfi_x" };
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

describe("RetryExecutorWorker.runOnce", () => {
  it("claims a batch, re-runs each activity, and releases each lease", async () => {
    const store = fakeStore([{ activityId: "wfa_a", instanceRef: "wfi_1" }, { activityId: "wfa_b", instanceRef: "wfi_2" }]);
    const seen: string[] = [];
    const engine: RetryActivityEngine = {
      async retryActivity({ activityId }) {
        seen.push(activityId);
        return retryResult(true, activityId === "wfa_a" ? "succeeded" : "failed", activityId);
      },
    };
    const worker = new RetryExecutorWorker({ claimStore: store, engine, workerId: "w1", clock, leaseMs: 60_000, batchSize: 25 });
    const result = await worker.runOnce();
    expect(result).toEqual({ claimed: 2, retried: 2, succeeded: 1 });
    expect(seen).toEqual(["wfa_a", "wfa_b"]);
    expect(store.released).toEqual(["wfa_a", "wfa_b"]); // lease released after each attempt
    expect(store.inputs[0]).toMatchObject({ workerId: "w1", limit: 25, leaseMs: 60_000, now: NOW });
  });

  it("releases the lease even when the activity wasn't retried (already settled)", async () => {
    const store = fakeStore([{ activityId: "wfa_a", instanceRef: "wfi_1" }]);
    const engine: RetryActivityEngine = { async retryActivity({ activityId }) { return retryResult(false, null, activityId); } };
    const result = await new RetryExecutorWorker({ claimStore: store, engine, workerId: "w1", clock }).runOnce();
    expect(result).toEqual({ claimed: 1, retried: 0, succeeded: 0 });
    expect(store.released).toEqual(["wfa_a"]);
  });

  it("releases the lease even if retryActivity throws", async () => {
    const store = fakeStore([{ activityId: "wfa_a", instanceRef: "wfi_1" }]);
    const engine: RetryActivityEngine = { async retryActivity() { throw new Error("handler blew up"); } };
    await expect(new RetryExecutorWorker({ claimStore: store, engine, workerId: "w1", clock }).runOnce()).rejects.toThrow();
    expect(store.released).toEqual(["wfa_a"]); // finally released
  });
});

describe("RetryExecutorWorker — poll loop", () => {
  it("runs on each tick, routes errors, and stops cleanly", async () => {
    let runs = 0;
    const store: ActivityRetryClaimStore = {
      async claimDueRetries() {
        runs += 1;
        if (runs === 2) throw new Error("db down");
        return [];
      },
      async releaseActivity() {},
    };
    const engine: RetryActivityEngine = { async retryActivity({ activityId }) { return retryResult(true, "succeeded", activityId); } };
    const errors: unknown[] = [];
    const f = fakeScheduler();
    const worker = new RetryExecutorWorker({ claimStore: store, engine, workerId: "w1", clock, scheduler: f.scheduler, onError: (e) => errors.push(e) });
    worker.start(1000);
    f.tick();
    f.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(2);
    expect(errors).toHaveLength(1);
    worker.stop();
    expect(f.cleared()).toBe(true);
  });
});
