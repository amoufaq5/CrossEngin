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
    expect(result).toEqual({ claimed: 2, succeeded: ["a", "b"], failed: [], skipped: [] });
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
    expect(result).toEqual({ claimed: 0, succeeded: [], failed: [], skipped: [] });
  });
  it("releases the rest of the batch when the worker stops mid-batch", async () => {
    const released: string[] = [];
    const processed: string[] = [];
    let stopping = false;
    const processor: TimerProcessor = {
      process: async (t) => {
        processed.push(t.timerId);
        stopping = true; // the first fire is what the stop lands during
      },
    };
    const result = await processTimerBatch(
      claimerOf([timer("a"), timer("b"), timer("c")], released),
      processor,
      OPTS,
      { shouldContinue: () => !stopping },
    );
    expect(processed).toEqual(["a"]);
    expect(result.succeeded).toEqual(["a"]);
    expect(result.skipped).toEqual([
      { timerId: "b", reason: "worker_stopping" },
      { timerId: "c", reason: "worker_stopping" },
    ]);
    // Released, not abandoned: another replica re-claims at once rather than after the lease.
    expect(released).toEqual(["b", "c"]);
  });

  it("reports each skip through onSkipped with the claimed timer", async () => {
    const seen: string[] = [];
    const result = await processTimerBatch(
      claimerOf([timer("a")]),
      { process: async () => undefined },
      OPTS,
      { shouldContinue: () => false, onSkipped: (t, reason) => void seen.push(`${t.timerId}:${reason}`) },
    );
    expect(seen).toEqual(["a:worker_stopping"]);
    expect(result.succeeded).toEqual([]);
    expect(result.claimed).toBe(1);
  });
});
