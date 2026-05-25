import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresCostTracker } from "./cost-tracker.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

interface Capture {
  sql: string;
  params: readonly unknown[] | undefined;
}

function mockConnection(
  handler: (sql: string, params: readonly unknown[] | undefined) => PgQueryResult,
  capture?: Capture[],
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (capture !== undefined) capture.push({ sql, params });
      return handler(sql, params);
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

describe("PostgresCostTracker.getWindow", () => {
  it("returns null when no row exists for the tenant", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const tracker = new PostgresCostTracker({ conn, clock: () => 1_000_000 });
    expect(await tracker.getWindow(TENANT)).toBeNull();
  });

  it("returns the parsed window when within the configured window", async () => {
    const now = 2_000_000;
    const conn = mockConnection(() => ({
      rows: [{ window_start_ms: "1990000", window_cost_usd: "0.42" }],
      rowCount: 1,
    }));
    const tracker = new PostgresCostTracker({
      conn,
      windowSeconds: 60,
      clock: () => now,
    });
    const window = await tracker.getWindow(TENANT);
    expect(window).toEqual({
      tenantId: TENANT,
      windowStartUnixMs: 1_990_000,
      costUsd: 0.42,
    });
  });

  it("returns null when the row has expired (now - start_ms >= windowSeconds * 1000)", async () => {
    const now = 1_000_000_000;
    const conn = mockConnection(() => ({
      rows: [{ window_start_ms: "0", window_cost_usd: "5.0" }],
      rowCount: 1,
    }));
    const tracker = new PostgresCostTracker({
      conn,
      windowSeconds: 86_400,
      clock: () => now,
    });
    expect(await tracker.getWindow(TENANT)).toBeNull();
  });

  it("treats the boundary moment (now - start_ms == windowMs) as expired", async () => {
    const now = 100_000;
    const conn = mockConnection(() => ({
      rows: [{ window_start_ms: "40000", window_cost_usd: "1.0" }],
      rowCount: 1,
    }));
    const tracker = new PostgresCostTracker({
      conn,
      windowSeconds: 60,
      clock: () => now,
    });
    expect(await tracker.getWindow(TENANT)).toBeNull();
  });

  it("filters by tenant_id in the SELECT", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const tracker = new PostgresCostTracker({ conn });
    await tracker.getWindow(TENANT);
    expect(capture[0]?.sql).toContain("FROM meta.llm_cost_windows");
    expect(capture[0]?.sql).toContain("WHERE tenant_id = $1");
    expect(capture[0]?.params).toEqual([TENANT]);
  });
});

describe("PostgresCostTracker.recordUsage", () => {
  it("issues an UPSERT into meta.llm_cost_windows", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const tracker = new PostgresCostTracker({ conn, clock: () => 12_345 });
    await tracker.recordUsage({ tenantId: TENANT, costUsd: 0.5 });
    expect(capture.length).toBe(1);
    expect(capture[0]?.sql).toContain("INSERT INTO meta.llm_cost_windows");
    expect(capture[0]?.sql).toContain("ON CONFLICT (tenant_id) DO UPDATE");
  });

  it("threads tenantId, nowMs, costUsd, windowMs as params", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const tracker = new PostgresCostTracker({
      conn,
      windowSeconds: 60,
      clock: () => 12_345,
    });
    await tracker.recordUsage({ tenantId: TENANT, costUsd: 0.5 });
    expect(capture[0]?.params).toEqual([TENANT, 12_345, 0.5, 60_000]);
  });

  it("uses the injected clock (not Date.now)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const tracker = new PostgresCostTracker({
      conn,
      clock: () => 999_999_999,
    });
    await tracker.recordUsage({ tenantId: TENANT, costUsd: 0.01 });
    expect(capture[0]?.params?.[1]).toBe(999_999_999);
  });

  it("uses the default window (86400s) when windowSeconds is omitted", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const tracker = new PostgresCostTracker({ conn, clock: () => 0 });
    await tracker.recordUsage({ tenantId: TENANT, costUsd: 1.0 });
    expect(capture[0]?.params?.[3]).toBe(86_400_000);
  });

  it("encodes the expiry CASE branch (CASE WHEN ... THEN EXCLUDED ELSE existing)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const tracker = new PostgresCostTracker({ conn, clock: () => 0 });
    await tracker.recordUsage({ tenantId: TENANT, costUsd: 0.1 });
    const sql = capture[0]?.sql ?? "";
    expect(sql).toContain("EXCLUDED.window_start_at");
    expect(sql).toContain("EXCLUDED.window_cost_usd");
    expect(sql).toContain("meta.llm_cost_windows.window_cost_usd + EXCLUDED.window_cost_usd");
  });
});

describe("PostgresCostTracker.checkCeiling", () => {
  it("returns per_request_exceeded without hitting the DB when over the per-request cap", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const tracker = new PostgresCostTracker({ conn });
    const check = await tracker.checkCeiling({
      tenantId: TENANT,
      estimatedCostUsd: 2.5,
      ceiling: { maxUsdPerRequest: 1.0 },
    });
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("per_request_exceeded");
    expect(check.limitUsd).toBe(1.0);
    expect(capture.length).toBe(0);
  });

  it("short-circuits when no maxUsdPerWindow is configured (no DB read)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const tracker = new PostgresCostTracker({ conn });
    const check = await tracker.checkCeiling({
      tenantId: TENANT,
      estimatedCostUsd: 1.0,
      ceiling: {},
    });
    expect(check.allowed).toBe(true);
    expect(check.limitUsd).toBe(Number.POSITIVE_INFINITY);
    expect(capture.length).toBe(0);
  });

  it("reads the window and reports allowed when current + estimated <= cap", async () => {
    const now = 2_000_000;
    const conn = mockConnection(() => ({
      rows: [{ window_start_ms: "1995000", window_cost_usd: "1.0" }],
      rowCount: 1,
    }));
    const tracker = new PostgresCostTracker({
      conn,
      windowSeconds: 60,
      clock: () => now,
    });
    const check = await tracker.checkCeiling({
      tenantId: TENANT,
      estimatedCostUsd: 0.5,
      ceiling: { maxUsdPerWindow: 10.0 },
    });
    expect(check.allowed).toBe(true);
    expect(check.currentWindowUsd).toBe(1.0);
    expect(check.limitUsd).toBe(10.0);
  });

  it("reports window_exceeded when current + estimated > cap", async () => {
    const now = 2_000_000;
    const conn = mockConnection(() => ({
      rows: [{ window_start_ms: "1995000", window_cost_usd: "9.5" }],
      rowCount: 1,
    }));
    const tracker = new PostgresCostTracker({
      conn,
      windowSeconds: 60,
      clock: () => now,
    });
    const check = await tracker.checkCeiling({
      tenantId: TENANT,
      estimatedCostUsd: 1.0,
      ceiling: { maxUsdPerWindow: 10.0 },
    });
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("window_exceeded");
    expect(check.currentWindowUsd).toBe(9.5);
    expect(check.limitUsd).toBe(10.0);
  });

  it("treats an expired window as zero accumulated cost", async () => {
    const now = 1_000_000_000;
    const conn = mockConnection(() => ({
      rows: [{ window_start_ms: "0", window_cost_usd: "100.0" }],
      rowCount: 1,
    }));
    const tracker = new PostgresCostTracker({
      conn,
      windowSeconds: 60,
      clock: () => now,
    });
    const check = await tracker.checkCeiling({
      tenantId: TENANT,
      estimatedCostUsd: 5.0,
      ceiling: { maxUsdPerWindow: 10.0 },
    });
    expect(check.allowed).toBe(true);
    expect(check.currentWindowUsd).toBe(0);
  });

  it("evaluates per-request gate before window gate (fails on per-request even if window is fine)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [{ window_start_ms: "0", window_cost_usd: "0" }], rowCount: 1 }),
      capture,
    );
    const tracker = new PostgresCostTracker({ conn, clock: () => 0 });
    const check = await tracker.checkCeiling({
      tenantId: TENANT,
      estimatedCostUsd: 10.0,
      ceiling: { maxUsdPerRequest: 1.0, maxUsdPerWindow: 1000.0 },
    });
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("per_request_exceeded");
    expect(capture.length).toBe(0);
  });
});

describe("PostgresCostTracker — InMemory parity", () => {
  it("treats numeric-string column responses (PG NUMERIC) the same as plain numbers", async () => {
    const conn = mockConnection(() => ({
      rows: [{ window_start_ms: "100", window_cost_usd: "0.000123" }],
      rowCount: 1,
    }));
    const tracker = new PostgresCostTracker({
      conn,
      windowSeconds: 60,
      clock: () => 200,
    });
    const window = await tracker.getWindow(TENANT);
    expect(window?.costUsd).toBeCloseTo(0.000_123, 9);
  });

  it("CostUsageWindow shape matches @crossengin/ai-router contract", async () => {
    const conn = mockConnection(() => ({
      rows: [{ window_start_ms: "100", window_cost_usd: "0.5" }],
      rowCount: 1,
    }));
    const tracker = new PostgresCostTracker({
      conn,
      windowSeconds: 60,
      clock: () => 200,
    });
    const window = await tracker.getWindow(TENANT);
    expect(window).not.toBeNull();
    expect(window?.tenantId).toBe(TENANT);
    expect(typeof window?.windowStartUnixMs).toBe("number");
    expect(typeof window?.costUsd).toBe("number");
  });
});
