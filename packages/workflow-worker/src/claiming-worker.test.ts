import type { FireTimerResult } from "@crossengin/workflow-runtime";
import { describe, expect, it } from "vitest";

import type { ClaimDueTimersInput, TimerClaim, TimerClaimStore } from "./claim-store.js";
import { ClaimingTimerWorker, type FireTimerEngine } from "./claiming-worker.js";
import type { IntervalScheduler } from "./worker.js";

const NOW = new Date("2026-06-03T12:00:00.000Z");
const clock = { now: () => NOW };

function fakeClaimStore(batches: TimerClaim[][]): TimerClaimStore & { released: string[]; claimInputs: ClaimDueTimersInput[] } {
  let n = 0;
  const released: string[] = [];
  const claimInputs: ClaimDueTimersInput[] = [];
  return {
    released,
    claimInputs,
    async claimDueTimers(input) {
      claimInputs.push(input);
      return batches[Math.min(n++, batches.length - 1)] ?? [];
    },
    async releaseTimer(timerId) {
      released.push(timerId);
    },
  };
}

function fireResult(fired: boolean, timerId: string): FireTimerResult {
  return { fired, timerId, instanceId: "wfi_x", timerName: fired ? "deadline" : null };
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

describe("ClaimingTimerWorker.runOnce", () => {
  it("claims a batch and fires each timer via the engine", async () => {
    const store = fakeClaimStore([[{ timerId: "wft_a", instanceRef: "wfi_1" }, { timerId: "wft_b", instanceRef: "wfi_2" }]]);
    const fired: string[] = [];
    const engine: FireTimerEngine = {
      async fireTimer({ timerId }) {
        fired.push(timerId);
        return fireResult(true, timerId);
      },
    };
    const worker = new ClaimingTimerWorker({ claimStore: store, engine, workerId: "w1", clock, leaseMs: 30_000, batchSize: 50 });
    const result = await worker.runOnce();
    expect(result).toEqual({ claimed: 2, fired: 2 });
    expect(fired).toEqual(["wft_a", "wft_b"]);
    // passes its workerId + lease + the clock's now to the claim
    expect(store.claimInputs[0]).toMatchObject({ workerId: "w1", limit: 50, leaseMs: 30_000, now: NOW });
    expect(store.released).toEqual([]);
  });

  it("releases the lease for a claimed timer that didn't fire (raced / not due)", async () => {
    const store = fakeClaimStore([[{ timerId: "wft_a", instanceRef: "wfi_1" }]]);
    const engine: FireTimerEngine = { async fireTimer({ timerId }) { return fireResult(false, timerId); } };
    const worker = new ClaimingTimerWorker({ claimStore: store, engine, workerId: "w1", clock });
    const result = await worker.runOnce();
    expect(result).toEqual({ claimed: 1, fired: 0 });
    expect(store.released).toEqual(["wft_a"]);
  });

  it("returns empty when nothing is due", async () => {
    const store = fakeClaimStore([[]]);
    const engine: FireTimerEngine = { async fireTimer({ timerId }) { return fireResult(true, timerId); } };
    expect(await new ClaimingTimerWorker({ claimStore: store, engine, workerId: "w1", clock }).runOnce()).toEqual({ claimed: 0, fired: 0 });
  });
});

describe("ClaimingTimerWorker — poll loop", () => {
  it("runs on each tick, routes errors, and stops cleanly", async () => {
    const store = fakeClaimStore([[]]);
    let runs = 0;
    const engine: FireTimerEngine = { async fireTimer({ timerId }) { return fireResult(true, timerId); } };
    const errors: unknown[] = [];
    const f = fakeScheduler();
    const worker = new ClaimingTimerWorker({
      claimStore: { ...store, claimDueTimers: async () => { runs += 1; if (runs === 2) throw new Error("boom"); return []; } },
      engine,
      workerId: "w1",
      clock,
      scheduler: f.scheduler,
      onError: (e) => errors.push(e),
    });
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
