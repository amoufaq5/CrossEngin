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
      // Postgres checks the *proposed* row against `dollars_used >= 0` before conflict
      // resolution, so a negative value is refused even when the row already exists.
      if (Number(p[2]) < 0) {
        throw new Error('new row violates check constraint "architect_tenant_cost_dollars_used_check"');
      }
      const k = key(String(p[0]), String(p[1]));
      const existing = rows.get(k);
      const next = (existing?.dollars ?? 0) + Number(p[2]);
      // The conditional reservation: a fourth parameter is the limit the total may not pass.
      if (p.length === 4 && next > Number(p[3])) return { rows: [], rowCount: 0 };
      rows.set(k, { tenant_id: String(p[0]), period_key: String(p[1]), dollars: next });
      return { rows: [{ dollars_used: next }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE")) {
      const row = rows.get(key(String(p[0]), String(p[1])));
      if (row === undefined || ctx !== row.tenant_id) return { rows: [], rowCount: 0 };
      row.dollars = Math.max(0, row.dollars + Number(p[2]));
      return { rows: [{ dollars_used: row.dollars }], rowCount: 1 };
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

  it("settles a reservation downwards with an UPDATE that never proposes a negative row", async () => {
    const { conn, calls } = fakePg();
    const store = new PostgresTenantCostStore(conn);
    const reserved = await store.reserveMonthly(TENANT, "2026-07", 2, 10);
    expect(reserved.reserved).toBe(true);
    expect(await store.addMonthly(TENANT, "2026-07", -1.25)).toBeCloseTo(0.75, 6);
    expect(calls.some((sql) => sql.startsWith("UPDATE") && sql.includes("GREATEST(0"))).toBe(true);
    // Floored at zero, and a refund for a month with no row invents nothing.
    expect(await store.addMonthly(TENANT, "2026-07", -5)).toBe(0);
    expect(await store.addMonthly(TENANT, "2026-09", -1)).toBe(0);
    expect(await store.getMonthly(TENANT, "2026-09")).toBe(0);
    await expect(store.addMonthly(TENANT, "2026-07", Number.NaN)).rejects.toThrow(/finite/);
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

describe("PostgresTenantCostStore.reserveMonthly", () => {
  it("charges while the total stays within the limit and refuses the charge that would pass it", async () => {
    const { conn } = fakePg();
    const store = new PostgresTenantCostStore(conn);
    expect(await store.reserveMonthly(TENANT, "2026-11", 3, 5)).toEqual({ reserved: true, dollarsUsed: 3 });
    expect(await store.reserveMonthly(TENANT, "2026-11", 2, 5)).toEqual({ reserved: true, dollarsUsed: 5 });
    expect(await store.reserveMonthly(TENANT, "2026-11", 0.01, 5)).toEqual({ reserved: false, dollarsUsed: null });
    expect(await store.getMonthly(TENANT, "2026-11")).toBe(5);
  });

  it("refuses a first charge of the month that alone passes the limit", async () => {
    const { conn } = fakePg();
    const store = new PostgresTenantCostStore(conn);
    expect(await store.reserveMonthly(TENANT, "2026-11", 6, 5)).toEqual({ reserved: false, dollarsUsed: null });
    expect(await store.getMonthly(TENANT, "2026-11")).toBe(0);
  });

  it("is one conditional statement, so the decision is made by the row the increment locks", async () => {
    const { conn, calls } = fakePg();
    await new PostgresTenantCostStore(conn).reserveMonthly(TENANT, "2026-11", 1, 5);
    const insert = calls.find((c) => c.includes("INSERT INTO")) ?? "";
    expect(insert).toMatch(/SELECT \$1, \$2, \$3::numeric WHERE \$3::numeric <= \$4::numeric/);
    expect(insert).toMatch(/DO UPDATE SET[\s\S]*WHERE architect_tenant_cost\.dollars_used \+ EXCLUDED\.dollars_used <= \$4::numeric/);
    expect(calls.filter((c) => c.includes("SELECT dollars_used"))).toHaveLength(0);
  });

  it("refuses a negative or non-finite amount rather than letting it credit the month", async () => {
    const store = new PostgresTenantCostStore(fakePg().conn);
    await expect(store.reserveMonthly(TENANT, "2026-11", -1, 5)).rejects.toThrow(/non-negative/);
    await expect(store.reserveMonthly(TENANT, "2026-11", Number.NaN, 5)).rejects.toThrow(/non-negative/);
    await expect(store.reserveMonthly(TENANT, "2026-11", 1, Number.POSITIVE_INFINITY)).rejects.toThrow(/limit/);
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
