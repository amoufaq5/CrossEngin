import { describe, expect, it } from "vitest";

import { processJobBatch } from "./job-batch.js";
import type { ClaimedJob, JobClaimer, JobProcessor } from "./job-types.js";

const OPTS = { workerId: "worker-A", now: "2026-05-17T12:00:00.000Z", limit: 10, leaseMs: 30_000 };

function job(id: string): ClaimedJob {
  return {
    jobId: id,
    tenantId: "00000000-0000-4000-8000-000000000001",
    jobDefinitionId: "overdue-invoice-reminder",
    jobKind: "scheduled",
    attempts: 1,
    claimExpiresAt: "2026-05-17T12:00:30.000Z",
  };
}

function claimerOf(
  jobs: readonly ClaimedJob[],
  released: string[] = [],
  releaseThrows = false,
): JobClaimer {
  return {
    claim: async () => jobs,
    release: async ({ jobId }) => {
      if (releaseThrows) throw new Error("release failed");
      released.push(jobId);
    },
  };
}

describe("processJobBatch", () => {
  it("processes every claimed run and reports success", async () => {
    const processed: string[] = [];
    const processor: JobProcessor = { process: async (j) => void processed.push(j.jobId) };
    const result = await processJobBatch(claimerOf([job("a"), job("b")]), processor, OPTS);
    expect(processed).toEqual(["a", "b"]);
    expect(result).toEqual({ claimed: 2, succeeded: ["a", "b"], failed: [] });
  });

  it("releases a run whose processing throws, and records the failure", async () => {
    const released: string[] = [];
    const processor: JobProcessor = {
      process: async (j) => {
        if (j.jobId === "b") throw new Error("boom");
      },
    };
    const result = await processJobBatch(claimerOf([job("a"), job("b")], released), processor, OPTS);
    expect(released).toEqual(["b"]);
    expect(result.succeeded).toEqual(["a"]);
    expect(result.failed).toEqual([{ jobId: "b", error: "boom" }]);
  });

  it("swallows a release that itself throws (the lease recovers the run)", async () => {
    const processor: JobProcessor = {
      process: async () => {
        throw new Error("boom");
      },
    };
    const result = await processJobBatch(claimerOf([job("a")], [], true), processor, OPTS);
    expect(result.failed).toEqual([{ jobId: "a", error: "boom" }]);
  });

  it("reports an empty batch when nothing was claimed", async () => {
    const result = await processJobBatch(claimerOf([]), { process: async () => undefined }, OPTS);
    expect(result).toEqual({ claimed: 0, succeeded: [], failed: [] });
  });
});
