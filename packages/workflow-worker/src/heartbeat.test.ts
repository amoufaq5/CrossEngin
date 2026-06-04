import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import {
  HeartbeatReporter,
  PostgresWorkerHeartbeatStore,
  WorkerHeartbeat,
  type HeartbeatSnapshot,
  type WorkerHeartbeatStore,
} from "./heartbeat.js";
import type { IntervalScheduler } from "./worker.js";

const NOW = new Date("2026-06-04T12:00:00.000Z");
const clock = { now: () => NOW };

describe("WorkerHeartbeat", () => {
  it("folds run outcomes + errors into cumulative counters", () => {
    const hb = new WorkerHeartbeat({ workerId: "w1", mode: "all", hostname: "host-a", clock });
    hb.recordRun({ claimed: 3, processed: 2 });
    hb.recordRun({ claimed: 5, processed: 5 });
    hb.recordError(new Error("db down"));
    const s = hb.snapshot();
    expect(s).toMatchObject({
      workerId: "w1",
      mode: "all",
      status: "starting",
      hostname: "host-a",
      pollCount: 2,
      claimedTotal: 8,
      processedTotal: 7,
      errorCount: 1,
      lastError: "db down",
      lastRunAt: NOW.toISOString(),
      lastHeartbeatAt: NOW.toISOString(),
    });
  });

  it("starts in 'starting' and reflects setStatus", () => {
    const hb = new WorkerHeartbeat({ workerId: "w1", mode: "claim", clock });
    expect(hb.snapshot().status).toBe("starting");
    expect(hb.snapshot().lastRunAt).toBeNull();
    hb.setStatus("running");
    expect(hb.snapshot().status).toBe("running");
  });
});

describe("PostgresWorkerHeartbeatStore", () => {
  function capture(): { conn: PgConnection; last: { sql: string; params: readonly unknown[] } } {
    const last = { sql: "", params: [] as readonly unknown[] };
    const query = (async (sql: string, params?: readonly unknown[]) => {
      last.sql = sql;
      last.params = params ?? [];
      return { rows: [], rowCount: 1 };
    }) as PgConnection["query"];
    return { conn: { query, transaction: vi.fn() as PgConnection["transaction"], withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"], close: vi.fn() as PgConnection["close"] }, last };
  }

  const snap: HeartbeatSnapshot = {
    workerId: "w1", mode: "all", status: "running", hostname: "h", startedAt: NOW.toISOString(),
    lastHeartbeatAt: NOW.toISOString(), lastRunAt: NOW.toISOString(), pollCount: 4,
    claimedTotal: 10, processedTotal: 9, errorCount: 0, lastError: null,
  };

  it("upserts on worker_id with all counters bound", async () => {
    const cap = capture();
    await new PostgresWorkerHeartbeatStore(cap.conn).upsert(snap);
    expect(cap.last.sql).toContain("INSERT INTO meta.worker_heartbeats");
    expect(cap.last.sql).toContain("ON CONFLICT (worker_id) DO UPDATE");
    expect(cap.last.params).toEqual([
      "w1", "all", "running", "h", NOW.toISOString(), NOW.toISOString(),
      NOW.toISOString(), 4, 10, 9, 0, null,
    ]);
  });

  it("honors a custom schema and rejects an invalid one", async () => {
    const cap = capture();
    await new PostgresWorkerHeartbeatStore(cap.conn, { schema: "wf" }).upsert(snap);
    expect(cap.last.sql).toContain("wf.worker_heartbeats");
    expect(() => new PostgresWorkerHeartbeatStore(cap.conn, { schema: "x; DROP" })).toThrow(/invalid schema/);
  });
});

function fakeScheduler(): { scheduler: IntervalScheduler; tick: () => void; cleared: () => boolean } {
  let fn: (() => void) | null = null;
  let handle: object | null = null;
  return {
    scheduler: { setInterval(h) { fn = h; handle = {}; return handle; }, clearInterval(h) { if (h === handle) handle = null; } },
    tick: () => fn?.(),
    cleared: () => handle === null,
  };
}

describe("HeartbeatReporter", () => {
  it("flushes immediately on start (running), on each tick, and a final stopped flush", async () => {
    const writes: HeartbeatSnapshot[] = [];
    const store: WorkerHeartbeatStore = { async upsert(s) { writes.push(s); } };
    const hb = new WorkerHeartbeat({ workerId: "w1", mode: "all", clock });
    const f = fakeScheduler();
    const reporter = new HeartbeatReporter({ heartbeat: hb, store, scheduler: f.scheduler });

    reporter.onRun({ claimed: 2, processed: 1 });
    reporter.start(1000);
    await Promise.resolve();
    expect(writes.at(-1)?.status).toBe("running");
    expect(writes.at(-1)?.claimedTotal).toBe(2);

    f.tick();
    await Promise.resolve();
    await reporter.stop();
    expect(writes.at(-1)?.status).toBe("stopped");
    expect(f.cleared()).toBe(true);
    expect(writes.length).toBeGreaterThanOrEqual(3); // start + tick + stop
  });

  it("routes a failing flush to onError instead of throwing", async () => {
    const store: WorkerHeartbeatStore = { async upsert() { throw new Error("write failed"); } };
    const hb = new WorkerHeartbeat({ workerId: "w1", mode: "tick", clock });
    const errors: unknown[] = [];
    const f = fakeScheduler();
    const reporter = new HeartbeatReporter({ heartbeat: hb, store, scheduler: f.scheduler, onError: (e) => errors.push(e) });
    reporter.start(1000);
    await Promise.resolve();
    await reporter.stop();
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
