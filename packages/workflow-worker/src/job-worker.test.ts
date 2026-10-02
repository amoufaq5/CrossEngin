import { describe, expect, it } from "vitest";

import type { ClaimedJob, JobClaimOptions, JobClaimer, JobProcessor } from "./job-types.js";
import { WorkflowJobWorker } from "./job-worker.js";

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

const noopProcessor: JobProcessor = { process: async () => undefined };

function deferred(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("WorkflowJobWorker.runOnce", () => {
  it("claims with the worker id / now / limit / lease and processes the batch", async () => {
    let seen: JobClaimOptions | null = null;
    const claimer: JobClaimer = {
      claim: async (o) => {
        seen = o;
        return [job("a")];
      },
      release: async () => undefined,
    };
    const processed: string[] = [];
    const worker = new WorkflowJobWorker({
      workerId: "worker-A",
      claimer,
      processor: { process: async (j) => void processed.push(j.jobId) },
      batchLimit: 7,
      leaseMs: 15_000,
      now: () => new Date("2026-05-17T12:00:00.000Z"),
    });
    const result = await worker.runOnce();
    expect(seen).toEqual({ workerId: "worker-A", now: "2026-05-17T12:00:00.000Z", limit: 7, leaseMs: 15_000 });
    expect(processed).toEqual(["a"]);
    expect(result.succeeded).toEqual(["a"]);
  });
});

describe("WorkflowJobWorker loop", () => {
  it("drains work with the active delay then backs off idle, until stop()", async () => {
    const batches: readonly ClaimedJob[][] = [[job("a")], [], []];
    let call = 0;
    const claimer: JobClaimer = {
      claim: async () => batches[Math.min(call++, batches.length - 1)] ?? [],
      release: async () => undefined,
    };
    const processed: string[] = [];
    const sleeps: number[] = [];
    let ticks = 0;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));

    const worker = new WorkflowJobWorker({
      workerId: "w",
      claimer,
      processor: { process: async (j) => void processed.push(j.jobId) },
      idlePollMs: 1_000,
      activePollMs: 5,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      sleep: async (ms) => {
        sleeps.push(ms);
        if (++ticks === 3) resolveDone();
      },
    });

    worker.start();
    expect(worker.isRunning).toBe(true);
    await done;
    await worker.stop();

    expect(worker.isRunning).toBe(false);
    expect(processed).toEqual(["a"]);
    expect(sleeps[0]).toBe(5);
    expect(sleeps).toContain(1_000);
  });

  it("reports a claim error via onError and keeps polling", async () => {
    let call = 0;
    const errors: unknown[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const claimer: JobClaimer = {
      claim: async () => {
        call += 1;
        if (call === 1) throw new Error("db blip");
        return [];
      },
      release: async () => undefined,
    };
    const worker = new WorkflowJobWorker({
      workerId: "w",
      claimer,
      processor: noopProcessor,
      idlePollMs: 0,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      sleep: async () => {
        if (call >= 2) resolveDone();
      },
      onError: (e) => errors.push(e),
    });
    worker.start();
    await done;
    await worker.stop();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("db blip");
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it("start() is idempotent and stop() is safe when never started", async () => {
    const worker = new WorkflowJobWorker({
      workerId: "w",
      claimer: { claim: async () => [], release: async () => undefined },
      processor: noopProcessor,
      sleep: async () => undefined,
    });
    await worker.stop();
    expect(worker.isRunning).toBe(false);
  });
});

describe("WorkflowJobWorker and cancellation", () => {
  it("clears every claimed run with the watcher before starting it", async () => {
    const processed: string[] = [];
    const released: string[] = [];
    const worker = new WorkflowJobWorker({
      workerId: "worker-A",
      claimer: {
        claim: async () => [job("a"), job("b")],
        release: async ({ jobId }) => void released.push(jobId),
      },
      processor: { process: async (j) => void processed.push(j.jobId) },
      cancellation: { isCancelRequested: async ({ jobId }) => jobId === "b" },
    });
    const result = await worker.runOnce();
    expect(processed).toEqual(["a"]);
    expect(released).toEqual(["b"]);
    expect(result.skipped).toEqual([{ jobId: "b", reason: "cancel_requested" }]);
  });

  it("does not report a direct runOnce as a shutdown — `stopping` gates the batch, not `running`", async () => {
    const processed: string[] = [];
    const worker = new WorkflowJobWorker({
      workerId: "worker-A",
      claimer: { claim: async () => [job("a")], release: async () => undefined },
      processor: { process: async (j) => void processed.push(j.jobId) },
    });
    expect(worker.isRunning).toBe(false);
    const result = await worker.runOnce();
    expect(processed).toEqual(["a"]);
    expect(result.skipped).toEqual([]);
  });

  it("stop() releases the rest of the in-flight batch instead of draining it", async () => {
    const processed: string[] = [];
    const released: string[] = [];
    const aStarted = deferred();
    const aMayFinish = deferred();
    let claims = 0;
    const worker = new WorkflowJobWorker({
      workerId: "worker-A",
      claimer: {
        claim: async () => {
          claims += 1;
          return claims === 1 ? [job("a"), job("b"), job("c")] : [];
        },
        release: async ({ jobId }) => void released.push(jobId),
      },
      processor: {
        process: async (j) => {
          processed.push(j.jobId);
          if (j.jobId === "a") {
            aStarted.resolve();
            await aMayFinish.promise;
          }
        },
      },
      idlePollMs: 0,
      activePollMs: 0,
      sleep: async () => undefined,
    });

    worker.start();
    await aStarted.promise; // the first run's handler is in flight
    const stopping = worker.stop(); // shutdown requested mid-batch
    aMayFinish.resolve();
    await stopping;

    // 'a' ran to completion — a running handler is never preempted — but 'b' and 'c' never started.
    expect(processed).toEqual(["a"]);
    expect(released).toEqual(["b", "c"]);
  });

  it("reports each skip through onSkipped", async () => {
    const seen: Array<[string, string]> = [];
    const worker = new WorkflowJobWorker({
      workerId: "worker-A",
      claimer: { claim: async () => [job("a")], release: async () => undefined },
      processor: noopProcessor,
      cancellation: { isCancelRequested: async () => true },
      onSkipped: (j, reason) => void seen.push([j.jobId, reason]),
    });
    await worker.runOnce();
    expect(seen).toEqual([["a", "cancel_requested"]]);
  });
});
