import type { PgConnection } from "@crossengin/kernel-pg";
import { SessionCostTracker } from "@crossengin/ai-architect-runtime";
import { describe, expect, it } from "vitest";

import { PostgresTenantCostStore, seedTenantMonthlyCost } from "./cost-store.js";
import { monthlyPeriodKey } from "./period.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

/** A fake PgConnection over an in-memory (tenant, period) → dollars map with RLS context. */
function fakePg(): { conn: PgConnection; calls: string[] } {
  const rows = new Map<string, { tenant_id: string; period_key: string; dollars: number }>();
  const calls: string[] = [];
  let ctx: string | null = null;
  const key = (t: string, p: string) => `${t}::${p}`;
  const run = async (sql: string, params?: readonly unknown[]) => {
    calls.push(sql);
    const p = params ?? [];
    if (sql.includes("set_config")) {
      ctx = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO")) {
      const k = key(String(p[0]), String(p[1]));
      const existing = rows.get(k);
      const next = (existing?.dollars ?? 0) + Number(p[2]);
      rows.set(k, { tenant_id: String(p[0]), period_key: String(p[1]), dollars: next });
      return { rows: [{ dollars_used: next }], rowCount: 1 };
    }
    if (sql.includes("SELECT dollars_used")) {
      const row = rows.get(key(String(p[0]), String(p[1])));
      // RLS: only visible when the tenant context matches the row's tenant.
      const visible = row !== undefined && ctx === row.tenant_id;
      return { rows: visible ? [{ dollars_used: row.dollars }] : [], rowCount: visible ? 1 : 0 };
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
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, calls };
}

describe("monthlyPeriodKey", () => {
  it("formats YYYY-MM in UTC, zero-padded", () => {
    expect(monthlyPeriodKey(new Date("2026-07-03T12:00:00.000Z"))).toBe("2026-07");
    expect(monthlyPeriodKey(new Date("2026-01-31T23:59:59.000Z"))).toBe("2026-01");
  });
});

describe("PostgresTenantCostStore", () => {
  it("getMonthly returns 0 for an unrecorded period", async () => {
    const store = new PostgresTenantCostStore(fakePg().conn);
    expect(await store.getMonthly(TENANT, "2026-07")).toBe(0);
  });

  it("addMonthly atomically accumulates and returns the new total", async () => {
    const store = new PostgresTenantCostStore(fakePg().conn);
    expect(await store.addMonthly(TENANT, "2026-07", 1.5)).toBeCloseTo(1.5, 6);
    expect(await store.addMonthly(TENANT, "2026-07", 2.25)).toBeCloseTo(3.75, 6);
    expect(await store.getMonthly(TENANT, "2026-07")).toBeCloseTo(3.75, 6);
  });

  it("buckets spend per period", async () => {
    const store = new PostgresTenantCostStore(fakePg().conn);
    await store.addMonthly(TENANT, "2026-07", 5);
    await store.addMonthly(TENANT, "2026-08", 2);
    expect(await store.getMonthly(TENANT, "2026-07")).toBe(5);
    expect(await store.getMonthly(TENANT, "2026-08")).toBe(2);
  });

  it("a tenant's spend is invisible to another (RLS context)", async () => {
    const store = new PostgresTenantCostStore(fakePg().conn);
    await store.addMonthly(TENANT, "2026-07", 10);
    expect(await store.getMonthly(OTHER, "2026-07")).toBe(0);
  });

  it("validates schema name + tenant id", async () => {
    expect(() => new PostgresTenantCostStore(fakePg().conn, { schema: "meta; DROP" })).toThrow(/invalid schema/);
    const store = new PostgresTenantCostStore(fakePg().conn);
    await expect(store.getMonthly("not-a-uuid!!", "2026-07")).rejects.toThrow(/invalid tenantId/);
  });

  it("targets meta.architect_tenant_cost by default", async () => {
    const { conn, calls } = fakePg();
    await new PostgresTenantCostStore(conn).getMonthly(TENANT, "2026-07");
    expect(calls.some((s) => s.includes("meta.architect_tenant_cost"))).toBe(true);
  });
});

describe("seedTenantMonthlyCost", () => {
  it("loads the persisted monthly total into an in-memory tracker", async () => {
    const store = new PostgresTenantCostStore(fakePg().conn);
    await store.addMonthly(TENANT, monthlyPeriodKey(new Date("2026-07-10T00:00:00.000Z")), 42);
    const tracker = new SessionCostTracker();
    const seeded = await seedTenantMonthlyCost(store, tracker, TENANT, new Date("2026-07-20T00:00:00.000Z"));
    expect(seeded).toBe(42);
    expect(tracker.tenant(TENANT).monthlyDollarsUsed).toBe(42);
  });
});
