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

  it("releases under the claimed run's own tenant, so a confined session can find the row", async () => {
    const seen: string[] = [];
    const other: ClaimedJob = { ...job("b"), tenantId: "00000000-0000-4000-8000-000000000002" };
    const claimer: JobClaimer = {
      claim: async () => [job("a"), other],
      release: async ({ jobId, tenantId }) => void seen.push(`${jobId}@${tenantId}`),
    };
    const processor: JobProcessor = {
      process: async () => {
        throw new Error("boom");
      },
    };
    await processJobBatch(claimer, processor, OPTS);
    expect(seen).toEqual([
      "a@00000000-0000-4000-8000-000000000001",
      "b@00000000-0000-4000-8000-000000000002",
    ]);
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

describe("processJobBatch — each run's claim is reaffirmed before it starts", () => {
  function renewerOf(held: ReadonlySet<string>, asked: string[] = [], throws = false) {
    return {
      renew: async (o: { timerId: string; workerId: string; tenantId: string }) => {
        asked.push(`${o.timerId}|${o.workerId}|${o.tenantId}`);
        if (throws) throw new Error("connection reset");
        return held.has(o.timerId);
      },
    };
  }

  it("skips a run whose claim another worker took while an earlier run was executing", async () => {
    const processed: string[] = [];
    const released: string[] = [];
    const asked: string[] = [];
    const result = await processJobBatch(
      claimerOf([job("a"), job("b")], released),
      { process: async (j) => void processed.push(j.jobId) },
      OPTS,
      { claimRenewer: renewerOf(new Set(["a"]), asked) },
    );
    expect(processed).toEqual(["a"]);
    expect(result.skipped).toEqual([{ jobId: "b", reason: "lease_lost" }]);
    // The claim is somebody else's now, so nothing of this worker's is handed back.
    expect(released).toEqual([]);
    expect(asked).toEqual([
      "a|worker-A|00000000-0000-4000-8000-000000000001",
      "b|worker-A|00000000-0000-4000-8000-000000000001",
    ]);
  });

  it("does not start a run when the renew itself fails — a lease nobody established is not held", async () => {
    const processed: string[] = [];
    const result = await processJobBatch(
      claimerOf([job("a")]),
      { process: async (j) => void processed.push(j.jobId) },
      OPTS,
      { claimRenewer: renewerOf(new Set(["a"]), [], true) },
    );
    expect(processed).toEqual([]);
    expect(result.skipped).toEqual([{ jobId: "a", reason: "lease_lost" }]);
  });

  it("does not spend a renew on a run it will not start", async () => {
    const asked: string[] = [];
    await processJobBatch(claimerOf([job("a")]), { process: async () => undefined }, OPTS, {
      shouldContinue: () => false,
      claimRenewer: renewerOf(new Set(["a"]), asked),
    });
    expect(asked).toEqual([]);
  });
});
