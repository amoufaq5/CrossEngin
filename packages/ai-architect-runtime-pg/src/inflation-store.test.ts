import type { PgConnection } from "@crossengin/kernel-pg";
import { SessionCostTracker } from "@crossengin/ai-architect-runtime";
import { describe, expect, it } from "vitest";

import {
  INFLATION_RELAXATION_PER_OBSERVATION,
  INITIAL_ESTIMATE_INFLATION,
  MAX_ESTIMATE_INFLATION,
  UNREADABLE_INFLATION_FALLBACK,
  nextInflation,
  nextWorstObserved,
} from "./inflation.js";
import { PostgresEstimateInflationStore, seedEstimateInflation } from "./inflation-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

interface Row {
  tenant_id: string;
  inflation: number;
  worst_observed: number;
  observations: number;
}

/**
 * A fake PgConnection over an in-memory tenant → row map with RLS context.
 *
 * The upsert's arithmetic is expressed here by calling `nextInflation` / `nextWorstObserved`,
 * which is the rule the real statement's `GREATEST`/`LEAST` expression spells in SQL. That
 * pins the store's *behaviour* to the pure function; a separate test pins that the statement
 * binds the same constants, which is the part a fake cannot check.
 */
function fakePg(seed?: Partial<Row>): {
  conn: PgConnection;
  calls: { sql: string; params: readonly unknown[] }[];
  rows: Map<string, Row>;
} {
  const rows = new Map<string, Row>();
  if (seed?.tenant_id !== undefined) {
    rows.set(seed.tenant_id, {
      tenant_id: seed.tenant_id,
      inflation: seed.inflation ?? 1,
      worst_observed: seed.worst_observed ?? 1,
      observations: seed.observations ?? 0,
    });
  }
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  let ctx: string | null = null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    const p = params ?? [];
    calls.push({ sql, params: p });
    if (sql.includes("set_config")) {
      ctx = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO")) {
      const tenant = String(p[0]);
      const ratio = Number(p[1]);
      const existing = rows.get(tenant);
      const next: Row =
        existing === undefined
          ? {
              tenant_id: tenant,
              inflation: nextInflation(INITIAL_ESTIMATE_INFLATION, ratio),
              worst_observed: nextWorstObserved(INITIAL_ESTIMATE_INFLATION, ratio),
              observations: 1,
            }
          : {
              tenant_id: tenant,
              inflation: nextInflation(existing.inflation, ratio),
              worst_observed: nextWorstObserved(existing.worst_observed, ratio),
              observations: existing.observations + 1,
            };
      rows.set(tenant, next);
      return {
        rows: [
          {
            inflation: String(next.inflation),
            worst_observed: String(next.worst_observed),
            observations: String(next.observations),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT inflation")) {
      const row = rows.get(String(p[0]));
      // RLS: only visible when the tenant context matches the row's tenant.
      const visible = row !== undefined && ctx === row.tenant_id;
      return {
        rows: visible
          ? [
              {
                inflation: String(row.inflation),
                worst_observed: String(row.worst_observed),
                observations: String(row.observations),
              },
            ]
          : [],
        rowCount: visible ? 1 : 0,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      const before = ctx;
      try {
        return await fn(conn);
      } finally {
        ctx = before;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, calls, rows };
}

describe("PostgresEstimateInflationStore", () => {
  it("targets meta.architect_estimate_inflation by default", async () => {
    const { conn, calls } = fakePg();
    await new PostgresEstimateInflationStore(conn).load(TENANT);
    expect(calls.some((c) => c.sql.includes("meta.architect_estimate_inflation"))).toBe(true);
  });

  it("is a table of its own, never the periodic cost table", async () => {
    const { conn, calls } = fakePg();
    await new PostgresEstimateInflationStore(conn).load(TENANT);
    expect(calls.some((c) => c.sql.includes("architect_tenant_cost"))).toBe(false);
  });

  it("validates the schema name and the tenant id", async () => {
    expect(() => new PostgresEstimateInflationStore(fakePg().conn, { schema: "meta; DROP" })).toThrow(
      /invalid schema/,
    );
    const store = new PostgresEstimateInflationStore(fakePg().conn);
    await expect(store.load("not-a-uuid!!")).rejects.toThrow(/invalid tenantId/);
  });

  it("honours a custom schema", async () => {
    const { conn, calls } = fakePg();
    await new PostgresEstimateInflationStore(conn, { schema: "other" }).load(TENANT);
    expect(calls.some((c) => c.sql.includes("other.architect_estimate_inflation"))).toBe(true);
  });

  it("reads a missing row as no_history with no correction", async () => {
    const store = new PostgresEstimateInflationStore(fakePg().conn);
    const r = await store.load(TENANT);
    expect(r.provenance).toBe("no_history");
    expect(r.inflation).toBe(INITIAL_ESTIMATE_INFLATION);
    expect(r.observations).toBe(0);
  });

  it("reads back a stored figure as learned", async () => {
    const store = new PostgresEstimateInflationStore(
      fakePg({ tenant_id: TENANT, inflation: 2.5, worst_observed: 4, observations: 7 }).conn,
    );
    const r = await store.load(TENANT);
    expect(r.provenance).toBe("learned");
    expect(r.inflation).toBeCloseTo(2.5, 10);
    expect(r.worstObserved).toBeCloseTo(4, 10);
    expect(r.observations).toBe(7);
  });

  it("falls PESSIMISTIC on an unreadable stored figure, not back to no correction", async () => {
    const store = new PostgresEstimateInflationStore(
      fakePg({ tenant_id: TENANT, inflation: Number.NaN, worst_observed: 1, observations: 3 }).conn,
    );
    const r = await store.load(TENANT);
    expect(r.provenance).toBe("unreadable");
    expect(r.inflation).toBe(UNREADABLE_INFLATION_FALLBACK);
    expect(r.inflation).toBeGreaterThan(INITIAL_ESTIMATE_INFLATION);
  });

  it("falls pessimistic on a stored figure below 1, which would deflate the estimate", async () => {
    const store = new PostgresEstimateInflationStore(
      fakePg({ tenant_id: TENANT, inflation: 0.25, worst_observed: 1 }).conn,
    );
    const r = await store.load(TENANT);
    expect(r.provenance).toBe("unreadable");
    expect(r.inflation).toBe(UNREADABLE_INFLATION_FALLBACK);
  });

  it("clamps an absurd stored figure instead of refusing every request forever", async () => {
    const store = new PostgresEstimateInflationStore(
      fakePg({ tenant_id: TENANT, inflation: 1e9, worst_observed: 1e9 }).conn,
    );
    const r = await store.load(TENANT);
    expect(r.provenance).toBe("clamped");
    expect(r.inflation).toBe(MAX_ESTIMATE_INFLATION);
  });

  it("another tenant's figure is invisible (RLS context)", async () => {
    const store = new PostgresEstimateInflationStore(
      fakePg({ tenant_id: TENANT, inflation: 6 }).conn,
    );
    expect((await store.load(OTHER)).provenance).toBe("no_history");
  });

  it("sets the RLS context before reading", async () => {
    const { conn, calls } = fakePg();
    await new PostgresEstimateInflationStore(conn).load(TENANT);
    expect(calls[0]?.sql).toContain("set_config");
    expect(calls[0]?.params[0]).toBe(TENANT);
  });

  it("records a first observation as the tenant's factor", async () => {
    const store = new PostgresEstimateInflationStore(fakePg().conn);
    const r = await store.observe(TENANT, 3);
    expect(r.inflation).toBeCloseTo(3, 10);
    expect(r.worstObserved).toBeCloseTo(3, 10);
    expect(r.observations).toBe(1);
  });

  it("the figure survives the read that follows the write — which is the whole point", async () => {
    const { conn } = fakePg();
    const store = new PostgresEstimateInflationStore(conn);
    await store.observe(TENANT, 4);
    const reread = await store.load(TENANT);
    expect(reread.provenance).toBe("learned");
    expect(reread.inflation).toBeCloseTo(4, 10);
  });

  it("rises to a worse observation and relaxes on a better one", async () => {
    const store = new PostgresEstimateInflationStore(fakePg().conn);
    await store.observe(TENANT, 5);
    const worse = await store.observe(TENANT, 8);
    expect(worse.inflation).toBeCloseTo(8, 10);
    const better = await store.observe(TENANT, 1.1);
    expect(better.inflation).toBeCloseTo(8 * INFLATION_RELAXATION_PER_OBSERVATION, 10);
    expect(better.worstObserved).toBeCloseTo(8, 10);
  });

  it("a single pathological request does not pin the tenant forever", async () => {
    const store = new PostgresEstimateInflationStore(fakePg().conn);
    await store.observe(TENANT, 40);
    let latest = await store.load(TENANT);
    let observations = 0;
    while (latest.inflation > INITIAL_ESTIMATE_INFLATION && observations < 500) {
      latest = await store.observe(TENANT, 0.8);
      observations += 1;
    }
    expect(latest.inflation).toBe(INITIAL_ESTIMATE_INFLATION);
    expect(observations).toBeLessThan(80);
    // …but the peak is still on the record.
    expect(latest.worstObserved).toBeCloseTo(40, 10);
  });

  it("caps what it will store, so a pricing bug cannot brick the feature", async () => {
    const store = new PostgresEstimateInflationStore(fakePg().conn);
    const r = await store.observe(TENANT, 1e9);
    expect(r.inflation).toBe(MAX_ESTIMATE_INFLATION);
  });

  it("writes nothing for an unusable ratio: a failed call is not evidence", async () => {
    const { conn, calls } = fakePg();
    const store = new PostgresEstimateInflationStore(conn);
    for (const bad of [Number.NaN, 0, -2, Number.POSITIVE_INFINITY]) {
      await store.observe(TENANT, bad);
    }
    expect(calls.some((c) => c.sql.includes("INSERT INTO"))).toBe(false);
  });

  it("does not relax the stored factor when handed an unusable ratio", async () => {
    const { conn } = fakePg();
    const store = new PostgresEstimateInflationStore(conn);
    await store.observe(TENANT, 6);
    const after = await store.observe(TENANT, Number.NaN);
    expect(after.inflation).toBeCloseTo(6, 10);
    expect(after.observations).toBe(1);
  });

  it("a write that returns no row reads as unreadable, never as no_history", async () => {
    const { conn } = fakePg();
    // A connection whose upsert reports success and returns nothing. Resolving that to
    // `no_history` would answer "no correction", which is the admitting direction.
    const mute: PgConnection = {
      ...conn,
      query: (async (sql: string, params?: readonly unknown[]) =>
        sql.includes("INSERT INTO")
          ? { rows: [], rowCount: 1 }
          : conn.query(sql, params)) as PgConnection["query"],
    };
    const muteConn: PgConnection = {
      ...mute,
      transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
        fn(muteConn)) as PgConnection["transaction"],
    };
    const r = await new PostgresEstimateInflationStore(muteConn).observe(TENANT, 5);
    expect(r.provenance).toBe("unreadable");
    expect(r.inflation).toBe(UNREADABLE_INFLATION_FALLBACK);
    expect(r.inflation).toBeGreaterThan(INITIAL_ESTIMATE_INFLATION);
  });

  it("upserts in one statement and binds its constants rather than inlining them", async () => {
    const { conn, calls } = fakePg();
    await new PostgresEstimateInflationStore(conn).observe(TENANT, 2);
    const insert = calls.find((c) => c.sql.includes("INSERT INTO"));
    expect(insert).toBeDefined();
    if (insert === undefined) return;
    expect(insert.sql).toContain("ON CONFLICT (tenant_id) DO UPDATE");
    expect(insert.sql).toContain("GREATEST");
    expect(insert.sql).toContain("LEAST");
    expect(insert.params).toEqual([
      TENANT,
      2,
      MAX_ESTIMATE_INFLATION,
      INITIAL_ESTIMATE_INFLATION,
      INFLATION_RELAXATION_PER_OBSERVATION,
    ]);
  });
});

describe("seedEstimateInflation", () => {
  it("installs the tenant's stored factor as the session's starting inflation", async () => {
    const { conn } = fakePg();
    const store = new PostgresEstimateInflationStore(conn);
    await store.observe(TENANT, 3.5);
    const tracker = new SessionCostTracker();
    const record = await seedEstimateInflation(store, tracker, TENANT, "sess-1");
    expect(record.inflation).toBeCloseTo(3.5, 10);
    expect(tracker.estimateInflation("sess-1")).toBeCloseTo(3.5, 10);
  });

  it("leaves a fresh session uncorrected when nothing was ever learned", async () => {
    const tracker = new SessionCostTracker();
    const record = await seedEstimateInflation(
      new PostgresEstimateInflationStore(fakePg().conn),
      tracker,
      TENANT,
      "sess-2",
    );
    expect(record.provenance).toBe("no_history");
    expect(tracker.estimateInflation("sess-2")).toBe(INITIAL_ESTIMATE_INFLATION);
  });

  it("seeds the pessimistic fallback when the stored figure is unreadable", async () => {
    const tracker = new SessionCostTracker();
    const store = new PostgresEstimateInflationStore(
      fakePg({ tenant_id: TENANT, inflation: Number.NaN }).conn,
    );
    await seedEstimateInflation(store, tracker, TENANT, "sess-3");
    expect(tracker.estimateInflation("sess-3")).toBe(UNREADABLE_INFLATION_FALLBACK);
  });

  it("never lowers a session that has already observed something worse", async () => {
    const tracker = new SessionCostTracker();
    tracker.observeEstimateRatio("sess-4", 9);
    const store = new PostgresEstimateInflationStore(fakePg().conn);
    await store.observe(TENANT, 2);
    await seedEstimateInflation(store, tracker, TENANT, "sess-4");
    expect(tracker.estimateInflation("sess-4")).toBe(9);
  });
});
