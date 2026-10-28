import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { JobDeclarationSchema, type JobDeclaration } from "@crossengin/jobs";
import { SET_TENANT_CONTEXT_SQL } from "@crossengin/workflow-runtime-pg";
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

/** The two statement kinds this producer emits, selected by predicate rather than by index. */
const inserts = (calls: readonly Call[]): readonly Call[] =>
  calls.filter((c) => c.sql.includes("INSERT INTO meta.job_runs"));
const contexts = (calls: readonly Call[]): readonly Call[] =>
  calls.filter((c) => c.sql.includes(SET_TENANT_CONTEXT_SQL));

/**
 * `transaction` must RUN its callback, handing it this same recording connection, or the whole
 * producer body is unobservable: `enqueueScheduledJobs` wraps its batch in `withTenantContext`, so a
 * `transaction` that discarded its callback recorded nothing and returned `undefined` — and neither
 * reads as "the fake skipped the work" (CLAUDE.md's `Tests` convention, seventh member).
 *
 * The `set_config` branch is **first** and returns before the fault injection, for two reasons. It
 * begins with `SELECT`, so any later branch keying on that word would hand it another statement's
 * rows (ADR-0363); and `throwOnce` exists to fail an *enqueue*, which is the INSERT — before the
 * producer became tenant-scoped the first statement it issued was that INSERT, so failing the
 * context statement instead would quietly change what the error test is about.
 */
function mockConn(calls: Call[], opts: { throwOnce?: boolean } = {}): PgConnection {
  let thrown = false;
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      calls.push({ sql, params });
      if (sql.includes(SET_TENANT_CONTEXT_SQL)) return { rows: [], rowCount: 1 };
      if (opts.throwOnce === true && !thrown) {
        thrown = true;
        throw new Error("db blip");
      }
      return { rows: [{ run_id: params?.[2] }], rowCount: 1 };
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
}

/**
 * Drains what a `void this.tick()` leaves pending. Every await in the producer's chain resolves
 * immediately, so one macrotask turn settles the whole tick however deep that chain is.
 *
 * The counted drain this replaced — two `await Promise.resolve()` hops — **does** still pass, and
 * with exactly **zero slack**: measured on this file, one hop records 0 inserts and two records the
 * first, so the assertion sits precisely on the boundary. That is the argument, and it is the same
 * one as for selecting statements by predicate rather than by index: the next await added anywhere
 * in the producer's chain moves a counted drain silently, and this chain has already gained two (the
 * transaction, and the `set_config` inside it) in one increment.
 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
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
    expect(inserts(calls)).toHaveLength(4);
    expect(inserts(calls).every((c) => c.sql.includes("'scheduled'"))).toBe(true);
    // Nothing but those inserts and their tenant contexts is issued.
    expect(calls).toHaveLength(inserts(calls).length + contexts(calls).length);
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
    expect(inserts(calls)).toHaveLength(1); // only the scheduled job
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
    expect(inserts(calls)).toHaveLength(2); // T1's insert threw, T2's still ran
    expect(contexts(calls)).toHaveLength(2); // each tenant's batch opened its own scoped transaction
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
    await flush();
    const afterStart = inserts(calls).length;
    expect(afterStart).toBeGreaterThanOrEqual(1);
    fire(); // an interval tick
    await flush();
    expect(inserts(calls).length).toBeGreaterThan(afterStart);
    s.stop();
    expect(cleared()).toBe(true);
  });

  it("PostgresTenantSource selects active tenants from meta.tenants", async () => {
    const calls: Call[] = [];
    const conn: PgConnection = {
      query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
        calls.push({ sql, params });
        return { rows: [{ id: T1 }, { id: T2 }], rowCount: 2 };
      }) as PgConnection["query"],
      transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
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
    const conn: PgConnection = {
      query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }) as PgConnection["query"],
      transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
      withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    await new PostgresTenantSource(conn, { statuses: ["active", "suspended"] }).activeTenantIds();
    expect(calls[0]!.params).toEqual([["active", "suspended"]]);
    expect(() => new PostgresTenantSource(conn, { schema: "x;y" })).toThrow(/invalid schema/);
  });

  it("establishes the tenant RLS context per tenant, with the tenant bound rather than interpolated", async () => {
    const calls: Call[] = [];
    const s = new JobScheduler({
      conn: mockConn(calls),
      jobs: [scheduledJob("nightly", "0 0 * * *")],
      tenants: new StaticTenantSource([T1]),
      intervalMs: 60_000,
      now: NOW,
      runOnStart: false,
    });
    await s.tick();

    // `meta.job_runs` carries exactly one ALL-scope isolation policy with a NULL WITH CHECK, so its
    // USING doubles as the write check: with no context the predicate is `tenant_id = NULL`, never
    // true, and the INSERT is refused 42501 as any role but the table's owner (ADR-0389). Nothing in
    // these three consumer tests asserted the context before, which is how the gap reached production.
    const ctx = contexts(calls);
    expect(ctx).toHaveLength(1);
    expect(ctx[0]!.sql).toBe(SET_TENANT_CONTEXT_SQL);
    // Bound as `$1`, never interpolated — a tenant id must not reach SQL text.
    expect(ctx[0]!.params).toEqual([T1]);
    expect(ctx[0]!.sql).not.toContain(T1);
    expect(ctx[0]!.sql).toContain("$1");
    // And it precedes the insert it exists to admit.
    expect(calls.indexOf(ctx[0]!)).toBeLessThan(calls.indexOf(inserts(calls)[0]!));
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
