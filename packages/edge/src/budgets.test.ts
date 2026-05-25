import { describe, expect, it } from "vitest";
import {
  BUDGET_SEVERITIES,
  BudgetBreachRecordSchema,
  LATENCY_PERCENTILES,
  RouteLatencyBudgetSchema,
  RouteLatencyBudgetSetSchema,
  budgetsByEndpointClass,
  evaluateBudget,
  latencyToMs,
  type BudgetBreachRecord,
  type RouteLatencyBudget,
} from "./budgets.js";

describe("constants", () => {
  it("LATENCY_PERCENTILES has 3 entries", () => {
    expect(LATENCY_PERCENTILES).toEqual(["p50", "p95", "p99"]);
  });

  it("BUDGET_SEVERITIES has 3 entries", () => {
    expect(BUDGET_SEVERITIES).toEqual(["info", "warning", "critical"]);
  });
});

describe("latencyToMs", () => {
  it("parses ms", () => {
    expect(latencyToMs("300ms")).toBe(300);
  });

  it("parses fractional ms", () => {
    expect(latencyToMs("250.5ms")).toBe(250.5);
  });

  it("parses seconds and converts", () => {
    expect(latencyToMs("2s")).toBe(2000);
    expect(latencyToMs("1.5s")).toBe(1500);
  });

  it("throws on malformed input", () => {
    expect(() => latencyToMs("300")).toThrow();
  });
});

describe("RouteLatencyBudgetSchema", () => {
  const base: RouteLatencyBudget = {
    routeId: "api-list-tenants",
    endpointClass: "read",
    p50: "100ms",
    p95: "300ms",
    p99: "1s",
    window: "30d",
    syntheticOnly: false,
    alertSeverity: "warning",
    pagerOnBreach: false,
  };

  it("accepts a valid budget", () => {
    expect(() => RouteLatencyBudgetSchema.parse(base)).not.toThrow();
  });

  it("rejects budget without any percentile", () => {
    expect(() =>
      RouteLatencyBudgetSchema.parse({
        ...base,
        p50: undefined,
        p95: undefined,
        p99: undefined,
      }),
    ).toThrow(/at least one of p50/);
  });

  it("rejects p95 < p50", () => {
    expect(() => RouteLatencyBudgetSchema.parse({ ...base, p50: "300ms", p95: "100ms" })).toThrow(
      /p95 must be >= p50/,
    );
  });

  it("rejects p99 < p95", () => {
    expect(() => RouteLatencyBudgetSchema.parse({ ...base, p95: "1s", p99: "500ms" })).toThrow(
      /p99 must be >= p95/,
    );
  });

  it("rejects pagerOnBreach=true without critical severity", () => {
    expect(() =>
      RouteLatencyBudgetSchema.parse({
        ...base,
        pagerOnBreach: true,
        alertSeverity: "warning",
      }),
    ).toThrow(/pagerOnBreach=true requires alertSeverity='critical'/);
  });

  it("accepts pagerOnBreach=true with critical severity", () => {
    expect(() =>
      RouteLatencyBudgetSchema.parse({
        ...base,
        pagerOnBreach: true,
        alertSeverity: "critical",
      }),
    ).not.toThrow();
  });
});

describe("RouteLatencyBudgetSetSchema", () => {
  const budget = (routeId: string, endpointClass: "read" | "write"): RouteLatencyBudget => ({
    routeId,
    endpointClass,
    p99: "1s",
    window: "30d",
    syntheticOnly: false,
    alertSeverity: "warning",
    pagerOnBreach: false,
  });

  it("accepts non-overlapping budgets", () => {
    expect(() =>
      RouteLatencyBudgetSetSchema.parse([budget("r1", "read"), budget("r1", "write")]),
    ).not.toThrow();
  });

  it("rejects duplicate (routeId, endpointClass)", () => {
    expect(() =>
      RouteLatencyBudgetSetSchema.parse([budget("r1", "read"), budget("r1", "read")]),
    ).toThrow(/duplicate \(routeId, endpointClass\)/);
  });
});

describe("BudgetBreachRecordSchema", () => {
  const base: BudgetBreachRecord = {
    id: "breach-1",
    routeId: "api-list-tenants",
    percentile: "p99",
    budgetMs: 1000,
    observedMs: 1500,
    severity: "critical",
    observedAt: "2026-05-14T10:00:00Z",
    windowStart: "2026-05-14T09:30:00Z",
    windowEnd: "2026-05-14T10:00:00Z",
    sampleCount: 1000,
    alertSent: true,
    pagedAt: null,
    resolvedAt: null,
  };

  it("accepts a valid breach record", () => {
    expect(() => BudgetBreachRecordSchema.parse(base)).not.toThrow();
  });

  it("rejects observedMs <= budgetMs", () => {
    expect(() => BudgetBreachRecordSchema.parse({ ...base, observedMs: 500 })).toThrow(
      /observedMs > budgetMs/,
    );
  });

  it("rejects windowEnd <= windowStart", () => {
    expect(() =>
      BudgetBreachRecordSchema.parse({
        ...base,
        windowEnd: "2026-05-14T09:00:00Z",
      }),
    ).toThrow(/windowEnd must be after/);
  });

  it("rejects critical severity without alertSent=true", () => {
    expect(() => BudgetBreachRecordSchema.parse({ ...base, alertSent: false })).toThrow(
      /alertSent=true/,
    );
  });

  it("rejects resolvedAt before observedAt", () => {
    expect(() =>
      BudgetBreachRecordSchema.parse({
        ...base,
        resolvedAt: "2026-05-14T09:00:00Z",
      }),
    ).toThrow(/resolvedAt cannot be before/);
  });
});

describe("evaluateBudget", () => {
  const budget: RouteLatencyBudget = {
    routeId: "r1",
    endpointClass: "read",
    p50: "100ms",
    p95: "300ms",
    p99: "1s",
    window: "30d",
    syntheticOnly: false,
    alertSeverity: "warning",
    pagerOnBreach: false,
  };

  it("returns breached=true when observed exceeds budget", () => {
    const results = evaluateBudget(budget, { p99Ms: 1500 });
    expect(results).toHaveLength(1);
    expect(results[0]?.breached).toBe(true);
    expect(results[0]?.exceededByMs).toBe(500);
  });

  it("returns breached=false when observed is within budget", () => {
    const results = evaluateBudget(budget, { p99Ms: 800 });
    expect(results[0]?.breached).toBe(false);
    expect(results[0]?.exceededByMs).toBe(0);
  });

  it("evaluates each declared percentile when observed values are present", () => {
    const results = evaluateBudget(budget, { p50Ms: 50, p95Ms: 250, p99Ms: 1500 });
    expect(results).toHaveLength(3);
    expect(results.find((r) => r.percentile === "p50")?.breached).toBe(false);
    expect(results.find((r) => r.percentile === "p95")?.breached).toBe(false);
    expect(results.find((r) => r.percentile === "p99")?.breached).toBe(true);
  });
});

describe("budgetsByEndpointClass", () => {
  const set = [
    {
      routeId: "r1",
      endpointClass: "read" as const,
      p99: "1s" as const,
      window: "30d" as const,
      syntheticOnly: false,
      alertSeverity: "warning" as const,
      pagerOnBreach: false,
    },
    {
      routeId: "r1",
      endpointClass: "write" as const,
      p99: "2s" as const,
      window: "30d" as const,
      syntheticOnly: false,
      alertSeverity: "warning" as const,
      pagerOnBreach: false,
    },
  ];

  it("filters by endpoint class", () => {
    expect(budgetsByEndpointClass(set, "read")).toHaveLength(1);
    expect(budgetsByEndpointClass(set, "admin")).toHaveLength(0);
  });
});
