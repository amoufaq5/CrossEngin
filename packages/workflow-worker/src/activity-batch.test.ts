import { describe, expect, it } from "vitest";

import { processActivityBatch } from "./activity-batch.js";
import type { ActivityClaimer, ActivityProcessor, ClaimedActivity } from "./activity-types.js";

const OPTS = { workerId: "worker-A", now: "2026-05-17T12:00:00.000Z", limit: 10, leaseMs: 30_000 };

function activity(id: string): ClaimedActivity {
  return {
    activityId: id,
    instanceId: "inst-1",
    tenantId: "00000000-0000-4000-8000-000000000001",
    definitionActivityKey: "charge_card",
    kind: "integration_call",
    attemptNumber: 1,
    maxAttempts: 3,
    claimExpiresAt: "2026-05-17T12:00:30.000Z",
  };
}

function claimerOf(
  activities: readonly ClaimedActivity[],
  released: string[] = [],
  releaseThrows = false,
): ActivityClaimer {
  return {
    claim: async () => activities,
    release: async ({ activityId }) => {
      if (releaseThrows) throw new Error("release failed");
      released.push(activityId);
    },
  };
}

describe("processActivityBatch", () => {
  it("processes every claimed activity and reports success", async () => {
    const processed: string[] = [];
    const processor: ActivityProcessor = { process: async (a) => void processed.push(a.activityId) };
    const result = await processActivityBatch(claimerOf([activity("a"), activity("b")]), processor, OPTS);
    expect(processed).toEqual(["a", "b"]);
    expect(result).toEqual({ claimed: 2, succeeded: ["a", "b"], failed: [] });
  });

  it("releases an activity whose processing throws, and records the failure", async () => {
    const released: string[] = [];
    const processor: ActivityProcessor = {
      process: async (a) => {
        if (a.activityId === "b") throw new Error("boom");
      },
    };
    const result = await processActivityBatch(claimerOf([activity("a"), activity("b")], released), processor, OPTS);
    expect(result.succeeded).toEqual(["a"]);
    expect(result.failed).toEqual([{ activityId: "b", error: "boom" }]);
    expect(released).toEqual(["b"]); // handed back for retry
  });

  it("swallows a release failure (the lease recovers the activity anyway)", async () => {
    const processor: ActivityProcessor = { process: async () => Promise.reject(new Error("boom")) };
    const result = await processActivityBatch(claimerOf([activity("a")], [], true), processor, OPTS);
    expect(result.failed.map((f) => f.activityId)).toEqual(["a"]);
    expect(result.claimed).toBe(1);
  });

  it("reports an empty batch when nothing is claimed", async () => {
    const result = await processActivityBatch(claimerOf([]), { process: async () => undefined }, OPTS);
    expect(result).toEqual({ claimed: 0, succeeded: [], failed: [] });
  });
});
