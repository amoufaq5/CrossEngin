import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { JobDeclarationSchema, type JobDeclaration } from "@crossengin/jobs";
import { describe, expect, it } from "vitest";

import type { IntervalScheduler } from "./jwks.js";
import { JobScheduler, PostgresTenantSource, StaticTenantSource } from "./scheduler.js";

const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";

function scheduledJob(id: string, cron: string): JobDeclaration {
  return JobDeclarationSchema.parse({
    id,
    name: id,
    trigger: { kind: "scheduled", cron },
    onFailure: { strategy: "dead-letter" },
  });
}

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

function mockConn(calls: Call[], opts: { throwOnce?: boolean } = {}): PgConnection {
  let thrown = false;
  return {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      calls.push({ sql, params });
      if (opts.throwOnce === true && !thrown) {
        thrown = true;
        throw new Error("db blip");
      }
      return { rows: [{ run_id: params?.[2] }], rowCount: 1 };
    }) as PgConnection["query"],
    transaction: (async () => undefined) as unknown as PgConnection["transaction"],
    withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
}

/** A manual interval scheduler so tests drive ticks explicitly. */
function manualScheduler(): { scheduler: IntervalScheduler; fire: () => void; cleared: () => boolean } {
  let handler: (() => void) | null = null;
  let clearedFlag = false;
  return {
    scheduler: {
      setInterval: (h) => {
        handler = h;
        return 1;
      },
      clearInterval: () => {
        clearedFlag = true;
      },
    },
    fire: () => handler?.(),
    cleared: () => clearedFlag,
  };
}

const NOW = () => new Date("2026-05-17T14:23:00.000Z");

describe("JobScheduler", () => {
  it("enqueues the current cron tick for every tenant on a tick", async () => {
    const calls: Call[] = [];
    const results: Array<{ tenantId: string; count: number }> = [];
    const s = new JobScheduler({
      conn: mockConn(calls),
      jobs: [scheduledJob("overdue-reminder", "0 9 * * *"), scheduledJob("nightly", "0 0 * * *")],
      tenants: new StaticTenantSource([T1, T2]),
      intervalMs: 60_000,
      now: NOW,
      runOnStart: false,
      onTick: (r) => results.push({ tenantId: r.tenantId, count: r.enqueued.length }),
    });

    await s.tick();

    // 2 tenants × 2 scheduled jobs = 4 inserts, all pending scheduled runs.
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.sql.includes("INSERT INTO meta.job_runs"))).toBe(true);
    expect(calls.every((c) => c.params?.[2] === undefined || c.sql.includes("'scheduled'"))).toBe(true);
    expect(results).toEqual([
      { tenantId: T1, count: 2 },
      { tenantId: T2, count: 2 },
    ]);
  });

  it("ignores non-scheduled jobs (only scheduled ones are enqueued)", async () => {
    const calls: Call[] = [];
    const eventJob = JobDeclarationSchema.parse({
      id: "on-order",
      name: "on-order",
      trigger: { kind: "event", eventName: "retail.order_placed" },
      onFailure: { strategy: "dead-letter" },
    });
    const s = new JobScheduler({
      conn: mockConn(calls),
      jobs: [eventJob, scheduledJob("nightly", "0 0 * * *")],
      tenants: new StaticTenantSource([T1]),
      intervalMs: 60_000,
      now: NOW,
      runOnStart: false,
    });
    await s.tick();
    expect(calls).toHaveLength(1); // only the scheduled job
  });

  it("routes a per-tenant enqueue error to onError and keeps going", async () => {
    const calls: Call[] = [];
    const errors: unknown[] = [];
    const s = new JobScheduler({
      conn: mockConn(calls, { throwOnce: true }),
      jobs: [scheduledJob("nightly", "0 0 * * *")],
      tenants: new StaticTenantSource([T1, T2]),
      intervalMs: 60_000,
      now: NOW,
      runOnStart: false,
      onError: (e) => errors.push(e),
    });
    await s.tick();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("db blip");
    expect(calls.length).toBeGreaterThanOrEqual(2); // T1 threw, T2 still ran
  });

  it("start() runs an immediate tick then schedules the interval; stop() clears it", async () => {
    const calls: Call[] = [];
    const { scheduler, fire, cleared } = manualScheduler();
    const s = new JobScheduler({
      conn: mockConn(calls),
      jobs: [scheduledJob("nightly", "0 0 * * *")],
      tenants: new StaticTenantSource([T1]),
      intervalMs: 60_000,
      now: NOW,
      scheduler,
    });
    s.start(); // runOnStart default true → one immediate tick
    await Promise.resolve();
    await Promise.resolve();
    const afterStart = calls.length;
    expect(afterStart).toBeGreaterThanOrEqual(1);
    fire(); // an interval tick
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBeGreaterThan(afterStart);
    s.stop();
    expect(cleared()).toBe(true);
  });

  it("PostgresTenantSource selects active tenants from meta.tenants", async () => {
    const calls: Call[] = [];
    const conn = {
      query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
        calls.push({ sql, params });
        return { rows: [{ id: T1 }, { id: T2 }], rowCount: 2 };
      }) as PgConnection["query"],
      transaction: (async () => undefined) as unknown as PgConnection["transaction"],
      withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    const source = new PostgresTenantSource(conn);
    const ids = await source.activeTenantIds();
    expect(ids).toEqual([T1, T2]);
    expect(calls[0]!.sql).toContain("FROM meta.tenants");
    expect(calls[0]!.sql).toContain("status = ANY($1::text[])");
    expect(calls[0]!.params).toEqual([["active"]]);
  });

  it("PostgresTenantSource honors custom active statuses and rejects a bad schema", async () => {
    const calls: Call[] = [];
    const conn = {
      query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }) as PgConnection["query"],
      transaction: (async () => undefined) as unknown as PgConnection["transaction"],
      withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    await new PostgresTenantSource(conn, { statuses: ["active", "suspended"] }).activeTenantIds();
    expect(calls[0]!.params).toEqual([["active", "suspended"]]);
    expect(() => new PostgresTenantSource(conn, { schema: "x;y" })).toThrow(/invalid schema/);
  });

  it("start() is idempotent", () => {
    const { scheduler } = manualScheduler();
    let setCount = 0;
    const counting: IntervalScheduler = {
      setInterval: (h) => {
        setCount += 1;
        return scheduler.setInterval(h, 0);
      },
      clearInterval: (x) => scheduler.clearInterval(x),
    };
    const s = new JobScheduler({
      conn: mockConn([]),
      jobs: [],
      tenants: new StaticTenantSource([T1]),
      intervalMs: 60_000,
      now: NOW,
      runOnStart: false,
      scheduler: counting,
    });
    s.start();
    s.start();
    expect(setCount).toBe(1);
  });
});
