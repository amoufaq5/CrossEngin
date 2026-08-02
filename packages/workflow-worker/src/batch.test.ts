import { describe, expect, it } from "vitest";

import { processTimerBatch } from "./batch.js";
import type { ClaimedTimer, TimerClaimer, TimerProcessor } from "./types.js";

const OPTS = { workerId: "worker-A", now: "2026-05-17T12:00:00.000Z", limit: 10, leaseMs: 30_000 };

function timer(id: string): ClaimedTimer {
  return {
    timerId: id,
    instanceId: "inst-1",
    tenantId: "00000000-0000-4000-8000-000000000001",
    timerName: "deadline",
    fireAt: "2026-05-17T11:59:00.000Z",
    transitionToTrigger: null,
    claimExpiresAt: "2026-05-17T12:00:30.000Z",
  };
}

function claimerOf(timers: readonly ClaimedTimer[], released: string[] = [], releaseThrows = false): TimerClaimer {
  return {
    claim: async () => timers,
    release: async ({ timerId }) => {
      if (releaseThrows) throw new Error("release failed");
      released.push(timerId);
    },
  };
}

describe("processTimerBatch", () => {
  it("processes every claimed timer and reports success", async () => {
    const processed: string[] = [];
    const processor: TimerProcessor = { process: async (t) => void processed.push(t.timerId) };
    const result = await processTimerBatch(claimerOf([timer("a"), timer("b")]), processor, OPTS);
    expect(processed).toEqual(["a", "b"]);
    expect(result).toEqual({ claimed: 2, succeeded: ["a", "b"], failed: [] });
  });

  it("releases a timer whose processing throws, and records the failure", async () => {
    const released: string[] = [];
    const processor: TimerProcessor = {
      process: async (t) => {
        if (t.timerId === "b") throw new Error("boom");
      },
    };
    const result = await processTimerBatch(claimerOf([timer("a"), timer("b")], released), processor, OPTS);
    expect(result.succeeded).toEqual(["a"]);
    expect(result.failed).toEqual([{ timerId: "b", error: "boom" }]);
    expect(released).toEqual(["b"]); // handed back for retry
  });

  it("swallows a release failure (the lease recovers the timer anyway)", async () => {
    const processor: TimerProcessor = { process: async () => Promise.reject(new Error("boom")) };
    const result = await processTimerBatch(claimerOf([timer("a")], [], true), processor, OPTS);
    expect(result.failed.map((f) => f.timerId)).toEqual(["a"]);
    expect(result.claimed).toBe(1);
  });

  it("reports an empty batch when nothing is claimed", async () => {
    const result = await processTimerBatch(claimerOf([]), { process: async () => undefined }, OPTS);
    expect(result).toEqual({ claimed: 0, succeeded: [], failed: [] });
  });
});
