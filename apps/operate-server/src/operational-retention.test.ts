import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { assertBindArity } from "@crossengin/testing";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RETENTION_POLICY,
  OperationalRetentionScheduler,
  RETENTION_TABLES,
  RETENTION_TABLE_SPECS,
  RetentionPolicyError,
  formatRetentionPass,
  formatRetentionPolicy,
  pruneOperationalTables,
  resolveRetentionPolicy,
  type RetentionPolicy,
} from "./operational-retention.js";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-19T00:00:00.000Z");

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly tenant: string | null;
}

/**
 * Runs every transaction's callback (a fake that discards it would make every DELETE unobservable,
 * ADR-0389) and answers a DELETE with the next scripted row count for its table and scope.
 */
function fakeConn(opts: {
  readonly counts?: Record<string, number[]>;
  readonly confined?: boolean;
  readonly throwFor?: string;
}): { conn: PgConnection; calls: Call[] } {
  const calls: Call[] = [];
  const counts = new Map(Object.entries(opts.counts ?? {}).map(([k, v]) => [k, [...v]]));
  const make = (tenant: () => string | null): PgConnection => {
    const self: PgConnection = {
      async query<T>(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult<T>> {
        assertBindArity(sql, params);
        if (sql.includes("set_config('app.current_tenant_id'")) {
          current = String(params[0]);
          return { rows: [] as T[], rowCount: 1 };
        }
        if (sql.includes("row_security_active")) {
          return {
            rows: [
              {
                role: "crossengin_app",
                policies_active: opts.confined ?? true,
                bypasses_rls: false,
                is_owner: false,
                rls_enabled: true,
                rls_forced: false,
              },
            ] as T[],
            rowCount: 1,
          };
        }
        const table = RETENTION_TABLES.find((t) => sql.includes(`DELETE FROM meta.${t} `));
        if (table === undefined) throw new Error(`unexpected statement: ${sql}`);
        const scope = tenant() ?? "platform";
        calls.push({ sql, params, tenant: tenant() });
        if (opts.throwFor === `${table}:${scope}`) throw new Error("permission denied");
        const queue = counts.get(`${table}:${scope}`) ?? [];
        const n = queue.shift() ?? 0;
        counts.set(`${table}:${scope}`, queue);
        return { rows: [] as T[], rowCount: n };
      },
      async transaction<T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> {
        const saved = current;
        try {
          return await fn(txConn);
        } finally {
          current = saved;
        }
      },
      async withAdvisoryLock<T>(_key: bigint, fn: () => Promise<T>): Promise<T> {
        return fn();
      },
      async close() {},
    };
    return self;
  };
  let current: string | null = null;
  const txConn = make(() => current);
  const conn = make(() => null);
  return { conn, calls };
}

const tenants = (ids: readonly string[]) => ({ activeTenantIds: () => ids });

describe("RETENTION_TABLE_SPECS", () => {
  it("never names a table the Article 17 erasure retains or the chain", () => {
    for (const t of RETENTION_TABLES) {
      expect(RETENTION_TABLE_SPECS[t].qualified).not.toMatch(
        /audit_log|forensic_chain|tombstone|gdpr_deletion|lifecycle_events|access_review|certification|crypto_keys|invoices|tenant_credits/,
      );
    }
  });

  it("scopes every tenant statement to the tenant and bounds it by a batch", () => {
    for (const t of RETENTION_TABLES) {
      const sql = RETENTION_TABLE_SPECS[t].tenantSql;
      expect(sql).toContain("tenant_id = $1");
      expect(sql).toContain("LIMIT $3");
      expect(sql).toContain(`DELETE FROM ${RETENTION_TABLE_SPECS[t].qualified} `);
    }
  });

  // The row is the cron scheduler's memory: a deleted newest run is re-derived and re-inserted.
  it("keeps every job's newest run and every unfinished one", () => {
    const sql = RETENTION_TABLE_SPECS.job_runs.tenantSql;
    expect(sql).toContain("n.started_at > r.started_at");
    expect(sql).toContain("status IN ('completed', 'failed', 'dead-lettered', 'cancelled')");
    expect(sql).not.toMatch(/'pending'|'running'/);
  });

  it("keeps an undelivered dispatch", () => {
    expect(RETENTION_TABLE_SPECS.notification_dispatches.tenantSql).toContain(
      "status IN ('completed', 'failed', 'cancelled')",
    );
  });

  it("has a platform statement exactly where tenant_id is nullable", () => {
    expect(
      RETENTION_TABLES.filter((t) => RETENTION_TABLE_SPECS[t].platformSql !== null),
    ).toEqual(["gateway_pipeline_executions", "rate_limit_decisions"]);
  });
});

describe("resolveRetentionPolicy", () => {
  it("returns the defaults for no specs", () => {
    expect(resolveRetentionPolicy([])).toEqual(DEFAULT_RETENTION_POLICY);
    expect(DEFAULT_RETENTION_POLICY).toEqual({
      job_runs: 90,
      gateway_pipeline_executions: 30,
      rate_limit_decisions: 30,
      notification_dispatches: 365,
    });
  });

  it("overrides one table and turns another off", () => {
    const p = resolveRetentionPolicy(["job_runs=7", "notification_dispatches=off"]);
    expect(p.job_runs).toBe(7);
    expect(p.notification_dispatches).toBeNull();
    expect(p.gateway_pipeline_executions).toBe(30);
  });

  it("refuses an unknown table, a malformed period, a zero period and a repeat", () => {
    expect(() => resolveRetentionPolicy(["audit_log=30"])).toThrow(RetentionPolicyError);
    expect(() => resolveRetentionPolicy(["job_runs=7d"])).toThrow(/days 1\.\./);
    expect(() => resolveRetentionPolicy(["job_runs=0"])).toThrow(/days 1\.\./);
    expect(() => resolveRetentionPolicy(["job_runs"])).toThrow(/days 1\.\./);
    expect(() => resolveRetentionPolicy(["job_runs=7", "job_runs=8"])).toThrow(/twice/);
  });

  it("refuses pruning rate-limit decisions sooner than the executions that name them", () => {
    expect(() => resolveRetentionPolicy(["rate_limit_decisions=7"])).toThrow(/must not be pruned sooner/);
    expect(() =>
      resolveRetentionPolicy(["gateway_pipeline_executions=off", "rate_limit_decisions=60"]),
    ).toThrow(/off/);
    expect(
      resolveRetentionPolicy(["gateway_pipeline_executions=7", "rate_limit_decisions=7"])
        .rate_limit_decisions,
    ).toBe(7);
    expect(resolveRetentionPolicy(["rate_limit_decisions=off"]).rate_limit_decisions).toBeNull();
  });
});

describe("formatRetentionPolicy", () => {
  it("names every table, what each keeps, and the platform-scope limit", () => {
    const line = formatRetentionPolicy(resolveRetentionPolicy(["job_runs=off"]), 3_600_000);
    expect(line).toContain("every 60 min");
    expect(line).toContain("job_runs off");
    expect(line).toContain("notification_dispatches 365d (keeps undelivered dispatches");
    expect(line).toContain("gateway_pipeline_executions and rate_limit_decisions");
    expect(line).toContain("--retention <table>=<days|off>");
  });
});

describe("pruneOperationalTables", () => {
  const policy: RetentionPolicy = DEFAULT_RETENTION_POLICY;

  it("deletes per tenant under that tenant's own context with the period's cutoff", async () => {
    const { conn, calls } = fakeConn({ counts: { [`job_runs:${T1}`]: [3] } });
    const result = await pruneOperationalTables({
      conn,
      tenants: tenants([T1, T2]),
      policy,
      now: () => NOW,
    });
    const jobCalls = calls.filter((c) => c.sql.includes("meta.job_runs"));
    expect(jobCalls.map((c) => c.tenant)).toEqual([T1, T2]);
    expect(jobCalls[0]?.params).toEqual([T1, "2026-08-21T00:00:00.000Z", 1000]);
    expect(result.tables.find((t) => t.table === "job_runs")?.deleted).toBe(3);
    expect(result.tenantsSwept).toBe(2);
  });

  it("keeps deleting a scope until a short batch, then stops", async () => {
    const { conn, calls } = fakeConn({
      counts: { [`gateway_pipeline_executions:${T1}`]: [2, 2, 1] },
    });
    const result = await pruneOperationalTables({
      conn,
      tenants: tenants([T1]),
      policy,
      now: () => NOW,
      batchSize: 2,
    });
    expect(calls.filter((c) => c.sql.includes("gateway_pipeline") && c.tenant === T1)).toHaveLength(3);
    const g = result.tables.find((t) => t.table === "gateway_pipeline_executions");
    expect(g?.deleted).toBe(5);
    expect(g?.truncatedScopes).toBe(0);
  });

  it("stops at the batch budget and says the scope has rows left", async () => {
    const { conn } = fakeConn({ counts: { [`rate_limit_decisions:${T1}`]: [2, 2, 2] } });
    const result = await pruneOperationalTables({
      conn,
      tenants: tenants([T1]),
      policy,
      now: () => NOW,
      batchSize: 2,
      maxBatches: 2,
    });
    const r = result.tables.find((t) => t.table === "rate_limit_decisions");
    expect(r?.deleted).toBe(4);
    expect(r?.truncatedScopes).toBe(1);
  });

  it("does not touch platform rows from a confined session, and says so", async () => {
    const { conn, calls } = fakeConn({ confined: true });
    const result = await pruneOperationalTables({ conn, tenants: tenants([]), policy, now: () => NOW });
    expect(calls).toHaveLength(0);
    expect(result.tables.find((t) => t.table === "rate_limit_decisions")?.platform).toBe("confined");
    expect(result.tables.find((t) => t.table === "job_runs")?.platform).toBe("not_applicable");
  });

  it("prunes platform rows, unscoped, from a session RLS does not confine", async () => {
    const { conn, calls } = fakeConn({ confined: false, counts: { "rate_limit_decisions:platform": [4] } });
    const result = await pruneOperationalTables({ conn, tenants: tenants([]), policy, now: () => NOW });
    const platformCalls = calls.filter((c) => c.tenant === null);
    expect(platformCalls.map((c) => c.sql.includes("tenant_id IS NULL"))).toEqual([true, true]);
    expect(result.tables.find((t) => t.table === "rate_limit_decisions")).toMatchObject({
      deleted: 4,
      platform: "pruned",
    });
  });

  it("skips a table that is off, issuing nothing for it", async () => {
    const { conn, calls } = fakeConn({});
    const result = await pruneOperationalTables({
      conn,
      tenants: tenants([T1]),
      policy: resolveRetentionPolicy(["notification_dispatches=off"]),
      now: () => NOW,
    });
    expect(calls.some((c) => c.sql.includes("notification_dispatches"))).toBe(false);
    expect(result.tables.find((t) => t.table === "notification_dispatches")?.platform).toBe("off");
  });

  it("collects one tenant's failure and goes on to the next", async () => {
    const { conn, calls } = fakeConn({ throwFor: `job_runs:${T1}` });
    const result = await pruneOperationalTables({
      conn,
      tenants: tenants([T1, T2]),
      policy,
      now: () => NOW,
    });
    const jobs = result.tables.find((t) => t.table === "job_runs");
    expect(jobs?.failures).toEqual([{ scope: T1, message: "permission denied" }]);
    expect(calls.some((c) => c.sql.includes("meta.job_runs") && c.tenant === T2)).toBe(true);
  });
});

describe("OperationalRetentionScheduler", () => {
  it("passes at start and on each tick, and a tick during a pass is a no-op", async () => {
    let tick: (() => void) | null = null;
    const passes: number[] = [];
    const { conn } = fakeConn({});
    const scheduler = new OperationalRetentionScheduler({
      conn,
      tenants: tenants([T1]),
      policy: DEFAULT_RETENTION_POLICY,
      now: () => NOW,
      scheduler: {
        setInterval(handler) {
          tick = handler;
          return 1;
        },
        clearInterval() {},
      },
      onPass: (r) => passes.push(r.tenantsSwept),
      onError: (err) => {
        throw err;
      },
    });
    scheduler.start();
    const overlapping = await scheduler.passOnce();
    expect(overlapping).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(passes).toEqual([1]);
    expect(tick).not.toBeNull();
    scheduler.stop();
  });

  it("routes a thrown pass to onError rather than out of the timer", async () => {
    const errors: unknown[] = [];
    const scheduler = new OperationalRetentionScheduler({
      conn: fakeConn({}).conn,
      tenants: {
        activeTenantIds: () => {
          throw new Error("tenants unreadable");
        },
      },
      policy: DEFAULT_RETENTION_POLICY,
      scheduler: { setInterval: () => 1, clearInterval() {} },
      onPass: () => undefined,
      onError: (err) => errors.push(err),
    });
    expect(await scheduler.passOnce()).toBeNull();
    expect(String(errors[0])).toContain("tenants unreadable");
  });
});

describe("formatRetentionPass", () => {
  it("names every table including the quiet and the off ones", () => {
    const line = formatRetentionPass({
      tenantsSwept: 2,
      tables: [
        { table: "job_runs", deleted: 0, truncatedScopes: 0, platform: "not_applicable", failures: [] },
        { table: "gateway_pipeline_executions", deleted: 5, truncatedScopes: 1, platform: "confined", failures: [] },
        { table: "rate_limit_decisions", deleted: 0, truncatedScopes: 0, platform: "pruned", failures: [] },
        { table: "notification_dispatches", deleted: 0, truncatedScopes: 0, platform: "off", failures: [] },
      ],
    });
    expect(line).toContain("over 2 tenant(s)");
    expect(line).toContain("job_runs 0 deleted");
    expect(line).toContain("1 scope(s) left for the next pass");
    expect(line).toContain("platform rows not pruned (confined)");
    expect(line).toContain("notification_dispatches off");
  });
});
