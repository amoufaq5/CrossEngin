import { describe, expect, it } from "vitest";
import type { SloLatencyTarget } from "@crossengin/observability";
import type { LatencyStats } from "./window.js";
import {
  DEFAULT_LATENCY_THRESHOLDS,
  LatencyThresholdSchema,
  evaluateLatencyTarget,
  parseLatencyBudgetMs,
  type LatencyThreshold,
} from "./latency.js";

describe("parseLatencyBudgetMs", () => {
  it.each([
    ["300ms", 300],
    ["5s", 5_000],
    ["1.5s", 1_500],
    ["250.5ms", 250.5],
  ])("parses %s", (input, expected) => {
    expect(parseLatencyBudgetMs(input)).toBe(expected);
  });

  it.each(["", "300", "ms", "5m", "0ms", "-3s", "5 s"])("rejects %s", (input) => {
    expect(() => parseLatencyBudgetMs(input)).toThrow();
  });
});

describe("LatencyThresholdSchema + defaults", () => {
  it("validates the default thresholds", () => {
    for (const t of DEFAULT_LATENCY_THRESHOLDS) {
      expect(LatencyThresholdSchema.safeParse(t).success).toBe(true);
    }
  });
  it("orders the page threshold above the ticket threshold", () => {
    const page = DEFAULT_LATENCY_THRESHOLDS.find((t) => t.id === "latency-page");
    expect(page?.severity).toBe("sev2");
    expect(page?.multiplier).toBe(2);
  });
});

const target: SloLatencyTarget = {
  kind: "latency",
  p95: "300ms",
  p99: "800ms",
  window: "30d",
};

const stats = (overrides: Partial<LatencyStats>): LatencyStats => ({
  p50: 100,
  p95: 200,
  p99: 500,
  count: 50,
  ...overrides,
});

describe("evaluateLatencyTarget", () => {
  it("does not breach when percentiles are within budget", () => {
    const verdict = evaluateLatencyTarget(target, stats({}));
    expect(verdict.breached).toBe(false);
    expect(verdict.worstSeverity).toBeNull();
  });

  it("opens a sev3 ticket when p95 exceeds its budget by less than 2x", () => {
    const verdict = evaluateLatencyTarget(target, stats({ p95: 400 }));
    expect(verdict.breached).toBe(true);
    expect(verdict.worstSeverity).toBe("sev3");
    expect(verdict.worstPercentile).toBe("p95");
  });

  it("pages sev2 when p95 is at least 2x its budget", () => {
    const verdict = evaluateLatencyTarget(target, stats({ p95: 650 }));
    expect(verdict.worstSeverity).toBe("sev2");
    expect(verdict.worstThresholdId).toBe("latency-page");
  });

  it("ignores percentiles the target does not declare", () => {
    const verdict = evaluateLatencyTarget(
      { kind: "latency", p95: "300ms", window: "30d" },
      stats({ p50: 9_999, p99: 9_999 }),
    );
    expect(verdict.breached).toBe(false);
  });

  it("suppresses breaches below the minimum sample count", () => {
    const verdict = evaluateLatencyTarget(target, stats({ p95: 650, count: 5 }));
    expect(verdict.breached).toBe(false);
  });

  it("respects a custom single threshold", () => {
    const thresholds: LatencyThreshold[] = [
      { id: "strict", multiplier: 1, severity: "sev1", minSamples: 0 },
    ];
    const verdict = evaluateLatencyTarget(target, stats({ p99: 1_000 }), thresholds);
    expect(verdict.worstSeverity).toBe("sev1");
    expect(verdict.worstPercentile).toBe("p99");
  });

  it("treats a null observed percentile as no data", () => {
    const verdict = evaluateLatencyTarget(target, stats({ p95: null, p99: null }));
    expect(verdict.breached).toBe(false);
  });
});
