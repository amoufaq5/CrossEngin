import { describe, expect, it } from "vitest";

import type { ClaimOptions, ClaimedTimer, TimerClaimer, TimerProcessor } from "./types.js";
import { WorkflowTimerWorker } from "./worker.js";

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

const noopProcessor: TimerProcessor = { process: async () => undefined };

describe("WorkflowTimerWorker.runOnce", () => {
  it("claims with the worker id / now / limit / lease and processes the batch", async () => {
    let seen: ClaimOptions | null = null;
    const claimer: TimerClaimer = {
      claim: async (o) => {
        seen = o;
        return [timer("a")];
      },
      release: async () => undefined,
    };
    const processed: string[] = [];
    const worker = new WorkflowTimerWorker({
      workerId: "worker-A",
      claimer,
      processor: { process: async (t) => void processed.push(t.timerId) },
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

describe("WorkflowTimerWorker loop", () => {
  it("drains work with the active delay then backs off idle, until stop()", async () => {
    const batches: readonly ClaimedTimer[][] = [[timer("a")], [], []];
    let call = 0;
    const claimer: TimerClaimer = {
      claim: async () => batches[Math.min(call++, batches.length - 1)] ?? [],
      release: async () => undefined,
    };
    const processed: string[] = [];
    const sleeps: number[] = [];
    let ticks = 0;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));

    const worker = new WorkflowTimerWorker({
      workerId: "w",
      claimer,
      processor: { process: async (t) => void processed.push(t.timerId) },
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
    expect(processed).toEqual(["a"]); // only the first poll had work
    expect(sleeps[0]).toBe(5); // first batch found work → active delay
    expect(sleeps).toContain(1_000); // later empty polls → idle backoff
  });

  it("reports a claim error via onError and keeps polling", async () => {
    let call = 0;
    const errors: unknown[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const claimer: TimerClaimer = {
      claim: async () => {
        call += 1;
        if (call === 1) throw new Error("db blip");
        return [];
      },
      release: async () => undefined,
    };
    const worker = new WorkflowTimerWorker({
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
    expect(call).toBeGreaterThanOrEqual(2); // survived the error and polled again
  });

  it("start() is idempotent and stop() is safe when never started", async () => {
    const worker = new WorkflowTimerWorker({
      workerId: "w",
      claimer: { claim: async () => [], release: async () => undefined },
      processor: noopProcessor,
      sleep: async () => undefined,
    });
    await worker.stop(); // never started → no-op
    expect(worker.isRunning).toBe(false);
  });
});
