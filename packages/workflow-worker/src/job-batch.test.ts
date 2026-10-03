import { describe, expect, it } from "vitest";

import { processJobBatch } from "./job-batch.js";
import type {
  ClaimedJob,
  JobCancellationWatcher,
  JobClaimer,
  JobProcessor,
} from "./job-types.js";

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
    expect(result).toEqual({ claimed: 2, succeeded: ["a", "b"], failed: [], skipped: [] });
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
    expect(result).toEqual({ claimed: 0, succeeded: [], failed: [], skipped: [] });
  });
});

function watcher(cancelled: ReadonlySet<string>, probed?: string[]): JobCancellationWatcher {
  return {
    isCancelRequested: async ({ jobId }) => {
      probed?.push(jobId);
      return cancelled.has(jobId);
    },
  };
}

describe("processJobBatch — cancellation between items", () => {
  it("releases a cancel-requested run without ever starting it", async () => {
    const processed: string[] = [];
    const released: string[] = [];
    const result = await processJobBatch(
      claimerOf([job("a")], released),
      { process: async (j) => void processed.push(j.jobId) },
      OPTS,
      { cancellation: watcher(new Set(["a"])) },
    );
    expect(processed).toEqual([]);
    expect(released).toEqual(["a"]);
    expect(result).toEqual({
      claimed: 1,
      succeeded: [],
      failed: [],
      skipped: [{ jobId: "a", reason: "cancel_requested" }],
    });
  });

  it("honours a cancellation that arrives while an earlier item in the same batch is still running", async () => {
    // The batch was claimed with both runs clear. 'b' is cancelled during 'a's handler, so the
    // per-item check — not the claim — is what keeps 'b' from starting.
    const cancelled = new Set<string>();
    const processed: string[] = [];
    const released: string[] = [];
    const probed: string[] = [];
    const processor: JobProcessor = {
      process: async (j) => {
        processed.push(j.jobId);
        if (j.jobId === "a") cancelled.add("b");
      },
    };
    const result = await processJobBatch(claimerOf([job("a"), job("b"), job("c")], released), processor, OPTS, {
      cancellation: watcher(cancelled, probed),
    });
    expect(processed).toEqual(["a", "c"]);
    expect(released).toEqual(["b"]);
    expect(probed).toEqual(["a", "b", "c"]);
    expect(result.skipped).toEqual([{ jobId: "b", reason: "cancel_requested" }]);
    expect(result.succeeded).toEqual(["a", "c"]);
  });

  it("fails closed when the watcher cannot answer: the run is released, not started", async () => {
    const processed: string[] = [];
    const released: string[] = [];
    const result = await processJobBatch(
      claimerOf([job("a")], released),
      { process: async (j) => void processed.push(j.jobId) },
      OPTS,
      {
        cancellation: {
          isCancelRequested: async () => {
            throw new Error("db down");
          },
        },
      },
    );
    expect(processed).toEqual([]);
    expect(released).toEqual(["a"]);
    expect(result.skipped).toEqual([{ jobId: "a", reason: "cancellation_unknown" }]);
  });

  it("reports every skip through onSkipped", async () => {
    const seen: Array<[string, string]> = [];
    await processJobBatch(claimerOf([job("a")]), { process: async () => undefined }, OPTS, {
      cancellation: watcher(new Set(["a"])),
      onSkipped: (j, reason) => void seen.push([j.jobId, reason]),
    });
    expect(seen).toEqual([["a", "cancel_requested"]]);
  });

  it("swallows a release that itself fails — the lease lapses and the reaper finalizes it", async () => {
    const result = await processJobBatch(
      claimerOf([job("a")], [], true),
      { process: async () => undefined },
      OPTS,
      { cancellation: watcher(new Set(["a"])) },
    );
    expect(result.skipped).toEqual([{ jobId: "a", reason: "cancel_requested" }]);
  });

  it("starts every run when no watcher is supplied", async () => {
    const processed: string[] = [];
    const result = await processJobBatch(
      claimerOf([job("a"), job("b")]),
      { process: async (j) => void processed.push(j.jobId) },
      OPTS,
    );
    expect(processed).toEqual(["a", "b"]);
    expect(result.skipped).toEqual([]);
  });
});

describe("processJobBatch — a stopping worker starts nothing further", () => {
  it("releases the rest of the batch once shouldContinue turns false mid-batch", async () => {
    let stop = false;
    const processed: string[] = [];
    const released: string[] = [];
    const result = await processJobBatch(
      claimerOf([job("a"), job("b"), job("c")], released),
      {
        process: async (j) => {
          processed.push(j.jobId);
          stop = true;
        },
      },
      OPTS,
      { shouldContinue: () => !stop },
    );
    expect(processed).toEqual(["a"]);
    expect(released).toEqual(["b", "c"]);
    expect(result.skipped).toEqual([
      { jobId: "b", reason: "worker_stopping" },
      { jobId: "c", reason: "worker_stopping" },
    ]);
  });

  it("does not spend a cancellation probe on a run it will not start anyway", async () => {
    const probed: string[] = [];
    await processJobBatch(claimerOf([job("a")]), { process: async () => undefined }, OPTS, {
      shouldContinue: () => false,
      cancellation: watcher(new Set(), probed),
    });
    expect(probed).toEqual([]);
  });
});
