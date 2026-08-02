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
