import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresCostCeilingResolver } from "./cost-ceiling-resolver.js";

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

describe("PostgresCostCeilingResolver.resolve", () => {
  it("returns undefined when no row exists for the tenant", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const resolver = new PostgresCostCeilingResolver({ conn });
    expect(await resolver.resolve(TENANT)).toBeUndefined();
  });

  it("returns a fully-populated ceiling when all fields are set", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          max_usd_per_request: "1.5",
          max_usd_per_window: "100.0",
          window_seconds: 3600,
        },
      ],
      rowCount: 1,
    }));
    const resolver = new PostgresCostCeilingResolver({ conn });
    const ceiling = await resolver.resolve(TENANT);
    expect(ceiling).toEqual({
      maxUsdPerRequest: 1.5,
      maxUsdPerWindow: 100.0,
      windowSeconds: 3600,
    });
  });

  it("omits maxUsdPerRequest when the column is NULL", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          max_usd_per_request: null,
          max_usd_per_window: "100.0",
          window_seconds: 3600,
        },
      ],
      rowCount: 1,
    }));
    const resolver = new PostgresCostCeilingResolver({ conn });
    const ceiling = await resolver.resolve(TENANT);
    expect(ceiling).toEqual({
      maxUsdPerWindow: 100.0,
      windowSeconds: 3600,
    });
    expect("maxUsdPerRequest" in (ceiling ?? {})).toBe(false);
  });

  it("omits maxUsdPerWindow when the column is NULL", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          max_usd_per_request: "1.5",
          max_usd_per_window: null,
          window_seconds: 3600,
        },
      ],
      rowCount: 1,
    }));
    const resolver = new PostgresCostCeilingResolver({ conn });
    const ceiling = await resolver.resolve(TENANT);
    expect(ceiling).toEqual({ maxUsdPerRequest: 1.5, windowSeconds: 3600 });
    expect("maxUsdPerWindow" in (ceiling ?? {})).toBe(false);
  });

  it("omits windowSeconds when the column is NULL", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          max_usd_per_request: "1.5",
          max_usd_per_window: "100.0",
          window_seconds: null,
        },
      ],
      rowCount: 1,
    }));
    const resolver = new PostgresCostCeilingResolver({ conn });
    const ceiling = await resolver.resolve(TENANT);
    expect(ceiling).toEqual({ maxUsdPerRequest: 1.5, maxUsdPerWindow: 100.0 });
    expect("windowSeconds" in (ceiling ?? {})).toBe(false);
  });

  it("returns an empty ceiling object when ALL columns are NULL (row exists, all unbounded)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          max_usd_per_request: null,
          max_usd_per_window: null,
          window_seconds: null,
        },
      ],
      rowCount: 1,
    }));
    const resolver = new PostgresCostCeilingResolver({ conn });
    const ceiling = await resolver.resolve(TENANT);
    expect(ceiling).toEqual({});
  });

  it("filters by tenant_id and SELECTs from meta.llm_cost_ceilings", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const resolver = new PostgresCostCeilingResolver({ conn });
    await resolver.resolve(TENANT);
    expect(capture[0]?.sql).toContain("FROM meta.llm_cost_ceilings");
    expect(capture[0]?.sql).toContain("WHERE tenant_id = $1");
    expect(capture[0]?.params).toEqual([TENANT]);
  });

  it("preserves NUMERIC sub-cent precision via ::TEXT cast + Number() parse", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          max_usd_per_request: "0.00012345",
          max_usd_per_window: "999999.99999999",
          window_seconds: 86400,
        },
      ],
      rowCount: 1,
    }));
    const resolver = new PostgresCostCeilingResolver({ conn });
    const ceiling = await resolver.resolve(TENANT);
    expect(ceiling?.maxUsdPerRequest).toBeCloseTo(0.000_123_45, 9);
    expect(ceiling?.maxUsdPerWindow).toBeCloseTo(999_999.999_999_99, 6);
  });
});

describe("PostgresCostCeilingResolver — drop-in for router getTenantCostCeiling", () => {
  it("the resolve method matches the (tenantId: string) => Promise<CostCeiling | undefined> shape", () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const resolver = new PostgresCostCeilingResolver({ conn });
    const fn: (tenantId: string) => Promise<
      { readonly maxUsdPerRequest?: number; readonly maxUsdPerWindow?: number; readonly windowSeconds?: number } | undefined
    > = resolver.resolve;
    expect(typeof fn).toBe("function");
  });
});

describe("PostgresCostCeilingResolver — tier fallback (M6.8)", () => {
  it("returns the tier's ceiling when no per-tenant row exists but tenant has a tier membership", async () => {
    const conn: PgConnection = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM meta.llm_cost_ceilings")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM meta.llm_tenant_tier_memberships")) {
          return {
            rows: [
              {
                max_usd_per_request: "5.0",
                max_usd_per_window: "100.0",
                window_seconds: 86400,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }) as PgConnection["query"],
      transaction: vi.fn() as PgConnection["transaction"],
      withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
      close: vi.fn() as PgConnection["close"],
    };
    const resolver = new PostgresCostCeilingResolver({ conn });
    const ceiling = await resolver.resolve(TENANT);
    expect(ceiling).toEqual({
      maxUsdPerRequest: 5.0,
      maxUsdPerWindow: 100.0,
      windowSeconds: 86400,
    });
  });

  it("per-tenant ceiling takes precedence over tier (no tier lookup issued)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection((sql) => {
      capture.push({ sql, params: undefined });
      if (sql.includes("FROM meta.llm_cost_ceilings")) {
        return {
          rows: [
            {
              max_usd_per_request: "1.0",
              max_usd_per_window: null,
              window_seconds: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const resolver = new PostgresCostCeilingResolver({ conn });
    const ceiling = await resolver.resolve(TENANT);
    expect(ceiling).toEqual({ maxUsdPerRequest: 1.0 });
    const tierQueries = capture.filter((c) =>
      c.sql.includes("llm_tenant_tier_memberships"),
    );
    expect(tierQueries).toHaveLength(0);
  });

  it("returns undefined when neither per-tenant row nor tier membership exists", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const resolver = new PostgresCostCeilingResolver({ conn });
    expect(await resolver.resolve(TENANT)).toBeUndefined();
  });

  it("tier-fallback query JOINs tiers + memberships filtered by tenant_id", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection((sql, params) => {
      capture.push({ sql, params });
      return { rows: [], rowCount: 0 };
    });
    const resolver = new PostgresCostCeilingResolver({ conn });
    await resolver.resolve(TENANT);
    const tierQuery = capture.find((c) =>
      c.sql.includes("llm_tenant_tier_memberships"),
    );
    expect(tierQuery?.sql).toContain("INNER JOIN meta.llm_cost_tiers");
    expect(tierQuery?.sql).toContain("ON t.tier_id = m.tier_id");
    expect(tierQuery?.sql).toContain("WHERE m.tenant_id = $1");
    expect(tierQuery?.params).toEqual([TENANT]);
  });

  it("tier with NULL fields produces an empty ceiling (explicit unbounded)", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.llm_cost_ceilings")) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [
          {
            max_usd_per_request: null,
            max_usd_per_window: null,
            window_seconds: null,
          },
        ],
        rowCount: 1,
      };
    });
    const resolver = new PostgresCostCeilingResolver({ conn });
    const ceiling = await resolver.resolve(TENANT);
    expect(ceiling).toEqual({});
  });

  it("tier preserves NUMERIC precision via ::TEXT cast", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.llm_cost_ceilings")) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [
          {
            max_usd_per_request: "0.00000123",
            max_usd_per_window: "12345.67890123",
            window_seconds: 3600,
          },
        ],
        rowCount: 1,
      };
    });
    const resolver = new PostgresCostCeilingResolver({ conn });
    const ceiling = await resolver.resolve(TENANT);
    expect(ceiling?.maxUsdPerRequest).toBeCloseTo(0.000_001_23, 9);
    expect(ceiling?.maxUsdPerWindow).toBeCloseTo(12_345.678_901_23, 6);
  });

  it("issues exactly one query when per-tenant ceiling exists (tier lookup skipped)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection((sql) => {
      capture.push({ sql, params: undefined });
      if (sql.includes("FROM meta.llm_cost_ceilings")) {
        return {
          rows: [
            { max_usd_per_request: "1.0", max_usd_per_window: null, window_seconds: null },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const resolver = new PostgresCostCeilingResolver({ conn });
    await resolver.resolve(TENANT);
    expect(capture).toHaveLength(1);
  });

  it("issues exactly two queries when per-tenant ceiling absent (tier lookup runs)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection((sql) => {
      capture.push({ sql, params: undefined });
      return { rows: [], rowCount: 0 };
    });
    const resolver = new PostgresCostCeilingResolver({ conn });
    await resolver.resolve(TENANT);
    expect(capture).toHaveLength(2);
    expect(capture[0]?.sql).toContain("llm_cost_ceilings");
    expect(capture[1]?.sql).toContain("llm_tenant_tier_memberships");
  });
});

describe("PostgresCostCeilingResolver.resolveDetailed (M6.8.x)", () => {
  it("reports source='override' when a per-tenant ceiling exists", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.llm_cost_ceilings")) {
        return {
          rows: [
            {
              max_usd_per_request: "1.0",
              max_usd_per_window: "100.0",
              window_seconds: 3600,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const resolver = new PostgresCostCeilingResolver({ conn });
    const result = await resolver.resolveDetailed(TENANT);
    expect(result.source).toBe("override");
    expect(result.ceiling).toEqual({
      maxUsdPerRequest: 1.0,
      maxUsdPerWindow: 100.0,
      windowSeconds: 3600,
    });
    expect(result.tierId).toBeUndefined();
  });

  it("reports source='tier' + the matching tierId when tier fallback wins", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.llm_cost_ceilings")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM meta.llm_tenant_tier_memberships")) {
        return {
          rows: [
            {
              tier_id: "pro",
              max_usd_per_request: "5.0",
              max_usd_per_window: "500.0",
              window_seconds: 86400,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const resolver = new PostgresCostCeilingResolver({ conn });
    const result = await resolver.resolveDetailed(TENANT);
    expect(result.source).toBe("tier");
    expect(result.tierId).toBe("pro");
    expect(result.ceiling).toEqual({
      maxUsdPerRequest: 5.0,
      maxUsdPerWindow: 500.0,
      windowSeconds: 86400,
    });
  });

  it("reports source='none' + undefined ceiling when neither override nor tier matches", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const resolver = new PostgresCostCeilingResolver({ conn });
    const result = await resolver.resolveDetailed(TENANT);
    expect(result.source).toBe("none");
    expect(result.ceiling).toBeUndefined();
    expect(result.tierId).toBeUndefined();
  });

  it("returns an empty ceiling object for source='override' when row exists with all-NULL fields", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.llm_cost_ceilings")) {
        return {
          rows: [
            {
              max_usd_per_request: null,
              max_usd_per_window: null,
              window_seconds: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const resolver = new PostgresCostCeilingResolver({ conn });
    const result = await resolver.resolveDetailed(TENANT);
    expect(result.source).toBe("override");
    expect(result.ceiling).toEqual({});
    expect(result.tierId).toBeUndefined();
  });

  it("override takes precedence: tier query NOT issued when override row exists", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection((sql) => {
      capture.push({ sql, params: undefined });
      if (sql.includes("FROM meta.llm_cost_ceilings")) {
        return {
          rows: [
            { max_usd_per_request: "2.0", max_usd_per_window: null, window_seconds: null },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const resolver = new PostgresCostCeilingResolver({ conn });
    await resolver.resolveDetailed(TENANT);
    expect(
      capture.filter((c) => c.sql.includes("llm_tenant_tier_memberships")),
    ).toHaveLength(0);
  });

  it("tier query selects tier_id alongside the policy columns", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection((sql, params) => {
      capture.push({ sql, params });
      return { rows: [], rowCount: 0 };
    });
    const resolver = new PostgresCostCeilingResolver({ conn });
    await resolver.resolveDetailed(TENANT);
    const tierQuery = capture.find((c) =>
      c.sql.includes("llm_tenant_tier_memberships"),
    );
    expect(tierQuery?.sql).toContain("t.tier_id");
    expect(tierQuery?.sql).toContain("INNER JOIN meta.llm_cost_tiers");
  });

  it("preserves NUMERIC precision on the tier-source ceiling", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.llm_cost_ceilings")) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [
          {
            tier_id: "enterprise",
            max_usd_per_request: "0.00000123",
            max_usd_per_window: "12345.67890123",
            window_seconds: 3600,
          },
        ],
        rowCount: 1,
      };
    });
    const resolver = new PostgresCostCeilingResolver({ conn });
    const result = await resolver.resolveDetailed(TENANT);
    expect(result.ceiling?.maxUsdPerRequest).toBeCloseTo(0.000_001_23, 9);
    expect(result.ceiling?.maxUsdPerWindow).toBeCloseTo(12_345.678_901_23, 6);
    expect(result.tierId).toBe("enterprise");
  });

  it("resolve() delegates to resolveDetailed() (same ceiling value)", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.llm_cost_ceilings")) {
        return {
          rows: [
            {
              max_usd_per_request: "3.0",
              max_usd_per_window: "300.0",
              window_seconds: 7200,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const resolver = new PostgresCostCeilingResolver({ conn });
    const ceiling = await resolver.resolve(TENANT);
    const detailed = await resolver.resolveDetailed(TENANT);
    expect(ceiling).toEqual(detailed.ceiling);
  });

  it("resolveDetailed return type is plumbed through resolve() unchanged for legacy callers", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.llm_cost_ceilings")) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [
          {
            tier_id: "free",
            max_usd_per_request: "0.10",
            max_usd_per_window: "1.0",
            window_seconds: 86400,
          },
        ],
        rowCount: 1,
      };
    });
    const resolver = new PostgresCostCeilingResolver({ conn });
    const ceiling = await resolver.resolve(TENANT);
    expect(ceiling).toEqual({
      maxUsdPerRequest: 0.1,
      maxUsdPerWindow: 1.0,
      windowSeconds: 86400,
    });
  });

  it("source='none' result is the canonical 'no policy at any level' signal", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const resolver = new PostgresCostCeilingResolver({ conn });
    const result = await resolver.resolveDetailed(TENANT);
    expect(result).toEqual({
      ceiling: undefined,
      source: "none",
    });
  });
});
