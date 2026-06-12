import { BudgetBreachRecordSchema, RouteLatencyBudgetSchema, type RouteLatencyBudget } from "@crossengin/edge";
import { describe, expect, it } from "vitest";

import { LatencyBudgetMonitor, percentile, toBudgetBreachRecord, type BudgetBreach } from "./budget.js";

const BUDGET: RouteLatencyBudget = RouteLatencyBudgetSchema.parse({
  routeId: "products-list",
  endpointClass: "read",
  p95: "300ms",
});

describe("percentile", () => {
  it("computes nearest-rank percentiles", () => {
    const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(100);
    expect(percentile([], 95)).toBe(0);
  });
});

describe("LatencyBudgetMonitor", () => {
  function fastSamples(monitor: LatencyBudgetMonitor): void {
    for (let i = 0; i < 100; i++) monitor.record("products-list", 80);
  }
  function slowTail(monitor: LatencyBudgetMonitor): void {
    for (let i = 0; i < 90; i++) monitor.record("products-list", 100);
    for (let i = 0; i < 10; i++) monitor.record("products-list", 600);
  }

  it("snapshot returns null for an unseen route, percentiles once sampled", () => {
    const m = new LatencyBudgetMonitor();
    expect(m.snapshot("products-list")).toBeNull();
    fastSamples(m);
    expect(m.snapshot("products-list")).toMatchObject({ routeId: "products-list", count: 100, p95Ms: 80 });
  });

  it("emits no breach within budget", () => {
    const breaches: BudgetBreach[] = [];
    const m = new LatencyBudgetMonitor({ onBreach: (b) => breaches.push(b) });
    fastSamples(m);
    expect(m.evaluate(BUDGET)).toEqual([]);
    expect(breaches).toHaveLength(0);
  });

  it("emits a breach when the observed p95 exceeds the budget", () => {
    const breaches: BudgetBreach[] = [];
    const m = new LatencyBudgetMonitor({ onBreach: (b) => breaches.push(b) });
    slowTail(m);
    const result = m.evaluate(BUDGET);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ routeId: "products-list", percentile: "p95", budgetMs: 300, observedMs: 600, severity: "warning" });
    expect(breaches).toHaveLength(1);
  });

  it("bounds the rolling window to windowSize (oldest samples evicted)", () => {
    const m = new LatencyBudgetMonitor({ windowSize: 50 });
    for (let i = 0; i < 100; i++) m.record("r", 100);
    expect(m.snapshot("r")?.count).toBe(50);
  });
});

describe("toBudgetBreachRecord", () => {
  it("promotes a breach to a schema-valid audit record", () => {
    const m = new LatencyBudgetMonitor({ now: () => new Date("2026-06-12T00:01:00.000Z") });
    for (let i = 0; i < 90; i++) m.record("products-list", 100);
    for (let i = 0; i < 10; i++) m.record("products-list", 600);
    const breach = m.evaluate(BUDGET)[0]!;
    const record = toBudgetBreachRecord(breach, { id: "brc-1", windowStart: "2026-06-12T00:00:00.000Z" });
    expect(() => BudgetBreachRecordSchema.parse(record)).not.toThrow();
    expect(record).toMatchObject({ id: "brc-1", routeId: "products-list", percentile: "p95", budgetMs: 300, observedMs: 600, alertSent: true });
  });
});
