import { describe, expect, it } from "vitest";

import { DriftSweepWorker, type DriftResyncReport, type DriftResyncer } from "./drift-sweeper.js";
import type { IntervalScheduler } from "./worker.js";

function report(over: Partial<DriftResyncReport["upserts"]> = {}): DriftResyncReport {
  return { upserts: { instance: true, activities: 0, signals: 0, timers: 0, ...over } };
}

function fakeScheduler(): { scheduler: IntervalScheduler; tick: () => void; cleared: () => boolean } {
  let fn: (() => void) | null = null;
  let handle: object | null = null;
  return {
    scheduler: { setInterval(h) { fn = h; handle = {}; return handle; }, clearInterval(h) { if (h === handle) handle = null; } },
    tick: () => fn?.(),
    cleared: () => handle === null,
  };
}

describe("DriftSweepWorker.runOnce", () => {
  it("re-projects a batch and sums the upserts", async () => {
    const inputs: Array<{ batchSize?: number; maxInstances?: number; status?: string }> = [];
    const resyncer: DriftResyncer = {
      async bulkResync(opts) {
        inputs.push(opts);
        return [report({ activities: 2, signals: 1 }), report({ timers: 3 })];
      },
    };
    const worker = new DriftSweepWorker({ resyncer, batchSize: 50, maxInstances: 200, status: "running" });
    const res = await worker.runOnce();
    // 2 instances; upserts = (1+2+1+0) + (1+0+0+3) = 4 + 4 = 8
    expect(res).toEqual({ resynced: 2, upserts: 8 });
    expect(inputs[0]).toEqual({ batchSize: 50, maxInstances: 200, status: "running" });
  });

  it("omits the status filter when not set", async () => {
    let seen: Record<string, unknown> = {};
    const resyncer: DriftResyncer = { async bulkResync(opts) { seen = opts; return []; } };
    await new DriftSweepWorker({ resyncer }).runOnce();
    expect("status" in seen).toBe(false);
    expect(seen).toMatchObject({ batchSize: 100, maxInstances: 500 });
  });
});

describe("DriftSweepWorker — poll loop", () => {
  it("runs on each tick, emits onRun, routes errors, and stops cleanly", async () => {
    let runs = 0;
    const resyncer: DriftResyncer = {
      async bulkResync() {
        runs += 1;
        if (runs === 2) throw new Error("db down");
        return [report({ activities: 1 })];
      },
    };
    const errors: unknown[] = [];
    const outcomes: Array<{ claimed: number; processed: number }> = [];
    const f = fakeScheduler();
    const worker = new DriftSweepWorker({ resyncer, scheduler: f.scheduler, onError: (e) => errors.push(e), onRun: (o) => outcomes.push(o) });
    worker.start(1000);
    f.tick();
    f.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(2);
    expect(errors).toHaveLength(1);
    expect(outcomes).toEqual([{ claimed: 1, processed: 2 }]); // 1 instance, upserts = instance(1)+activities(1)
    worker.stop();
    expect(f.cleared()).toBe(true);
  });
});
