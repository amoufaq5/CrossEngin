import type { TimeoutInstanceResult } from "@crossengin/workflow-runtime";
import { describe, expect, it } from "vitest";

import type {
  ClaimTimedOutInstancesInput,
  InstanceTimeoutClaim,
  InstanceTimeoutClaimStore,
} from "./instance-timeout-claim-store.js";
import { TimeoutSweeperWorker, type TimeoutInstanceEngine } from "./timeout-worker.js";
import type { IntervalScheduler } from "./worker.js";

const NOW = new Date("2026-06-04T12:00:00.000Z");
const clock = { now: () => NOW };

function fakeStore(batch: InstanceTimeoutClaim[]): InstanceTimeoutClaimStore & { released: string[]; inputs: ClaimTimedOutInstancesInput[] } {
  const released: string[] = [];
  const inputs: ClaimTimedOutInstancesInput[] = [];
  return {
    released,
    inputs,
    async claimTimedOutInstances(input) {
      inputs.push(input);
      return inputs.length === 1 ? batch : [];
    },
    async releaseInstance(instanceRef) {
      released.push(instanceRef);
    },
  };
}

function result(timedOut: boolean, instanceId: string): TimeoutInstanceResult {
  return { timedOut, instanceId, previousStatus: timedOut ? "waiting_for_signal" : "completed" };
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

describe("TimeoutSweeperWorker.runOnce", () => {
  it("claims a batch, times out each instance, and releases each lease", async () => {
    const store = fakeStore([{ instanceRef: "wfi_1" }, { instanceRef: "wfi_2" }]);
    const seen: string[] = [];
    const engine: TimeoutInstanceEngine = {
      async timeoutInstance({ instanceId }) {
        seen.push(instanceId);
        return result(instanceId === "wfi_1", instanceId);
      },
    };
    const worker = new TimeoutSweeperWorker({ claimStore: store, engine, workerId: "w1", clock, leaseMs: 60_000, batchSize: 25 });
    const res = await worker.runOnce();
    expect(res).toEqual({ claimed: 2, timedOut: 1 });
    expect(seen).toEqual(["wfi_1", "wfi_2"]);
    expect(store.released).toEqual(["wfi_1", "wfi_2"]);
    expect(store.inputs[0]).toMatchObject({ workerId: "w1", limit: 25, leaseMs: 60_000, now: NOW });
  });

  it("releases the lease even if timeoutInstance throws", async () => {
    const store = fakeStore([{ instanceRef: "wfi_1" }]);
    const engine: TimeoutInstanceEngine = { async timeoutInstance() { throw new Error("boom"); } };
    await expect(new TimeoutSweeperWorker({ claimStore: store, engine, workerId: "w1", clock }).runOnce()).rejects.toThrow();
    expect(store.released).toEqual(["wfi_1"]);
  });
});

describe("TimeoutSweeperWorker — poll loop", () => {
  it("runs on each tick, routes errors, and stops cleanly", async () => {
    let runs = 0;
    const store: InstanceTimeoutClaimStore = {
      async claimTimedOutInstances() {
        runs += 1;
        if (runs === 2) throw new Error("db down");
        return [];
      },
      async releaseInstance() {},
    };
    const engine: TimeoutInstanceEngine = { async timeoutInstance({ instanceId }) { return result(true, instanceId); } };
    const errors: unknown[] = [];
    const f = fakeScheduler();
    const worker = new TimeoutSweeperWorker({ claimStore: store, engine, workerId: "w1", clock, scheduler: f.scheduler, onError: (e) => errors.push(e) });
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
