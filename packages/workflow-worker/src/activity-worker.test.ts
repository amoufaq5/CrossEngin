import { describe, expect, it } from "vitest";

import type { ActivityClaimOptions, ActivityClaimer, ActivityProcessor, ClaimedActivity } from "./activity-types.js";
import { WorkflowActivityWorker } from "./activity-worker.js";

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

const noopProcessor: ActivityProcessor = { process: async () => undefined };

describe("WorkflowActivityWorker.runOnce", () => {
  it("claims with the worker id / now / limit / lease and processes the batch", async () => {
    let seen: ActivityClaimOptions | null = null;
    const claimer: ActivityClaimer = {
      claim: async (o) => {
        seen = o;
        return [activity("a")];
      },
      release: async () => undefined,
    };
    const processed: string[] = [];
    const worker = new WorkflowActivityWorker({
      claimRenewer: null,
      workerId: "worker-A",
      claimer,
      processor: { process: async (a) => void processed.push(a.activityId) },
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

describe("WorkflowActivityWorker — per-item reaffirm and the poll gate", () => {
  it("passes its claim renewer to the batch, so a queued activity is reaffirmed before it runs", async () => {
    const asked: string[] = [];
    const ran: string[] = [];
    const worker = new WorkflowActivityWorker({
      claimRenewer: {
        renew: async (o) => {
          asked.push(o.timerId);
          return false;
        },
      },
      workerId: "w",
      claimer: { claim: async () => [activity("a")], release: async () => undefined },
      processor: { process: async (a) => void ran.push(a.activityId) },
    });
    const result = await worker.runOnce();
    expect(asked).toEqual(["a"]);
    expect(ran).toEqual([]);
    expect(result.skipped).toEqual([{ activityId: "a", reason: "lease_lost" }]);
  });

  it("backs off to the idle delay after a batch that claimed activities and finished none of them", async () => {
    const sleeps: number[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const worker = new WorkflowActivityWorker({
      claimRenewer: null,
      workerId: "w",
      claimer: { claim: async () => [activity("poison")], release: async () => undefined },
      processor: {
        process: async () => {
          throw new Error("deterministic bug");
        },
      },
      idlePollMs: 1_000,
      activePollMs: 0,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) resolveDone();
      },
    });
    worker.start();
    await done;
    await worker.stop();
    expect(sleeps).toEqual([1_000, 1_000]);
  });
});

describe("WorkflowActivityWorker loop", () => {
  it("drains work with the active delay then backs off idle, until stop()", async () => {
    const batches: readonly ClaimedActivity[][] = [[activity("a")], [], []];
    let call = 0;
    const claimer: ActivityClaimer = {
      claim: async () => batches[Math.min(call++, batches.length - 1)] ?? [],
      release: async () => undefined,
    };
    const processed: string[] = [];
    const sleeps: number[] = [];
    let ticks = 0;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));

    const worker = new WorkflowActivityWorker({
      claimRenewer: null,
      workerId: "w",
      claimer,
      processor: { process: async (a) => void processed.push(a.activityId) },
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
    const claimer: ActivityClaimer = {
      claim: async () => {
        call += 1;
        if (call === 1) throw new Error("db blip");
        return [];
      },
      release: async () => undefined,
    };
    const worker = new WorkflowActivityWorker({
      claimRenewer: null,
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
    const worker = new WorkflowActivityWorker({
      claimRenewer: null,
      workerId: "w",
      claimer: { claim: async () => [], release: async () => undefined },
      processor: noopProcessor,
      sleep: async () => undefined,
    });
    await worker.stop(); // never started → no-op
    expect(worker.isRunning).toBe(false);
  });
  it("stop() releases the rest of the in-flight batch instead of executing it", async () => {
    const released: string[] = [];
    const processed: string[] = [];
    const skipped: string[] = [];
    let firstStarted!: () => void;
    const started = new Promise<void>((r) => (firstStarted = r));
    let finishFirst!: () => void;
    const held = new Promise<void>((r) => (finishFirst = r));
    const worker = new WorkflowActivityWorker({
      claimRenewer: null,
      workerId: "w",
      claimer: {
        claim: async () => [activity("a"), activity("b")],
        release: async ({ activityId }) => void released.push(activityId),
      },
      processor: {
        process: async (a) => {
          processed.push(a.activityId);
          if (a.activityId === "a") {
            firstStarted();
            await held;
          }
        },
      },
      idlePollMs: 0,
      activePollMs: 0,
      sleep: async () => undefined,
      onSkipped: (a, reason) => void skipped.push(`${a.activityId}:${reason}`),
    });
    worker.start();
    await started;
    const stopping = worker.stop();
    finishFirst();
    await stopping;
    expect(processed).toEqual(["a"]);
    expect(skipped).toEqual(["b:worker_stopping"]);
    expect(released).toEqual(["b"]);
  });
});
