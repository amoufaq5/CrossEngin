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
    expect(result).toEqual({ claimed: 2, succeeded: ["a", "b"], failed: [], skipped: [] });
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

  it("releases under the claimed activity's own tenant", async () => {
    const seen: string[] = [];
    const claimer: ActivityClaimer = {
      claim: async () => [
        activity("a"),
        { ...activity("b"), tenantId: "00000000-0000-4000-8000-000000000002" },
      ],
      release: async ({ activityId, tenantId }) => void seen.push(`${activityId}@${tenantId}`),
    };
    const processor: ActivityProcessor = {
      process: async () => {
        throw new Error("boom");
      },
    };
    await processActivityBatch(claimer, processor, OPTS);
    expect(seen).toEqual([
      "a@00000000-0000-4000-8000-000000000001",
      "b@00000000-0000-4000-8000-000000000002",
    ]);
  });

  it("swallows a release failure (the lease recovers the activity anyway)", async () => {
    const processor: ActivityProcessor = { process: async () => Promise.reject(new Error("boom")) };
    const result = await processActivityBatch(claimerOf([activity("a")], [], true), processor, OPTS);
    expect(result.failed.map((f) => f.activityId)).toEqual(["a"]);
    expect(result.claimed).toBe(1);
  });

  it("reports an empty batch when nothing is claimed", async () => {
    const result = await processActivityBatch(claimerOf([]), { process: async () => undefined }, OPTS);
    expect(result).toEqual({ claimed: 0, succeeded: [], failed: [], skipped: [] });
  });
  it("releases the rest of the batch when the worker stops mid-batch", async () => {
    const released: string[] = [];
    const processed: string[] = [];
    let stopping = false;
    const processor: ActivityProcessor = {
      process: async (a) => {
        processed.push(a.activityId);
        stopping = true;
      },
    };
    const result = await processActivityBatch(
      claimerOf([activity("a"), activity("b")], released),
      processor,
      OPTS,
      { shouldContinue: () => !stopping },
    );
    expect(processed).toEqual(["a"]);
    expect(result.skipped).toEqual([{ activityId: "b", reason: "worker_stopping" }]);
    expect(released).toEqual(["b"]);
  });

  it("reports each skip through onSkipped with the claimed activity", async () => {
    const seen: string[] = [];
    await processActivityBatch(
      claimerOf([activity("a")]),
      { process: async () => undefined },
      OPTS,
      {
        shouldContinue: () => false,
        onSkipped: (a, reason) => void seen.push(`${a.activityId}:${reason}`),
      },
    );
    expect(seen).toEqual(["a:worker_stopping"]);
  });
});

describe("processActivityBatch — each activity's claim is reaffirmed before it executes", () => {
  it("executes an activity it still holds and skips one whose claim was taken", async () => {
    const processed: string[] = [];
    const released: string[] = [];
    const result = await processActivityBatch(
      claimerOf([activity("a"), activity("b")], released),
      { process: async (a) => void processed.push(a.activityId) },
      OPTS,
      { claimRenewer: { renew: async (o) => o.timerId === "a" } },
    );
    expect(processed).toEqual(["a"]);
    expect(result.skipped).toEqual([{ activityId: "b", reason: "lease_lost" }]);
    expect(released).toEqual([]);
  });
});
