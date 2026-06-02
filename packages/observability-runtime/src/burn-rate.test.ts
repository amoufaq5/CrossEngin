import { describe, expect, it } from "vitest";
import {
  BurnRateThresholdSchema,
  DEFAULT_BURN_RATE_THRESHOLDS,
  burnRate,
  evaluateBurnRate,
  evaluateThreshold,
  type BurnRateThreshold,
  type WindowMeasure,
} from "./burn-rate.js";
import type { WindowCounts } from "./window.js";

describe("BurnRateThresholdSchema", () => {
  const valid: BurnRateThreshold = {
    id: "fast",
    longWindow: "1h",
    shortWindow: "5m",
    burnRateMultiplier: 14.4,
    severity: "sev2",
    minSamples: 20,
  };

  it("accepts a well-formed threshold", () => {
    expect(BurnRateThresholdSchema.parse(valid).id).toBe("fast");
  });

  it("rejects a shortWindow that is not shorter than longWindow", () => {
    const res = BurnRateThresholdSchema.safeParse({ ...valid, shortWindow: "1h" });
    expect(res.success).toBe(false);
  });

  it("rejects a longer shortWindow", () => {
    const res = BurnRateThresholdSchema.safeParse({ ...valid, shortWindow: "2h" });
    expect(res.success).toBe(false);
  });

  it("rejects a non-positive multiplier", () => {
    const res = BurnRateThresholdSchema.safeParse({ ...valid, burnRateMultiplier: 0 });
    expect(res.success).toBe(false);
  });
});

describe("DEFAULT_BURN_RATE_THRESHOLDS", () => {
  it("are all valid", () => {
    for (const t of DEFAULT_BURN_RATE_THRESHOLDS) {
      expect(BurnRateThresholdSchema.safeParse(t).success).toBe(true);
    }
  });
  it("declares fast-burn as the most severe", () => {
    const fast = DEFAULT_BURN_RATE_THRESHOLDS.find((t) => t.id === "fast-burn");
    expect(fast?.severity).toBe("sev2");
  });
});

describe("burnRate", () => {
  it("is the failure rate scaled by the error budget", () => {
    expect(burnRate(0.99, { total: 100, failed: 1 })).toBeCloseTo(1);
    expect(burnRate(0.99, { total: 100, failed: 50 })).toBeCloseTo(50);
  });

  it("is 0 with no failures", () => {
    expect(burnRate(0.99, { total: 100, failed: 0 })).toBe(0);
  });

  it("is Infinity when target is 100% and there is a failure", () => {
    expect(burnRate(1, { total: 10, failed: 1 })).toBe(Number.POSITIVE_INFINITY);
  });

  it("rejects an out-of-range target", () => {
    expect(() => burnRate(0, { total: 1, failed: 0 })).toThrow();
    expect(() => burnRate(1.1, { total: 1, failed: 0 })).toThrow();
  });
});

const measureOf = (long: WindowCounts, short: WindowCounts): WindowMeasure => {
  return (windowMs: number) => (windowMs >= 3_600_000 ? long : short);
};

const threshold: BurnRateThreshold = {
  id: "fast",
  longWindow: "1h",
  shortWindow: "5m",
  burnRateMultiplier: 14.4,
  severity: "sev2",
  minSamples: 20,
};

describe("evaluateThreshold", () => {
  it("fires when both windows exceed the multiplier and samples suffice", () => {
    const ev = evaluateThreshold(
      0.99,
      measureOf({ total: 100, failed: 30 }, { total: 40, failed: 12 }),
      threshold,
    );
    expect(ev.firing).toBe(true);
  });

  it("does not fire when the short window is below the multiplier", () => {
    const ev = evaluateThreshold(
      0.99,
      measureOf({ total: 100, failed: 30 }, { total: 40, failed: 1 }),
      threshold,
    );
    expect(ev.firing).toBe(false);
  });

  it("does not fire below the minimum sample count", () => {
    const ev = evaluateThreshold(
      0.99,
      measureOf({ total: 10, failed: 10 }, { total: 10, failed: 10 }),
      threshold,
    );
    expect(ev.firing).toBe(false);
  });
});

describe("evaluateBurnRate", () => {
  const fast: BurnRateThreshold = { ...threshold, id: "fast", severity: "sev2" };
  const slow: BurnRateThreshold = {
    id: "slow",
    longWindow: "6h",
    shortWindow: "30m",
    burnRateMultiplier: 6,
    severity: "sev3",
    minSamples: 0,
  };

  it("reports no breach when nothing fires", () => {
    const verdict = evaluateBurnRate(
      0.99,
      () => ({ total: 100, failed: 0 }),
      [fast, slow],
    );
    expect(verdict.breached).toBe(false);
    expect(verdict.worstSeverity).toBeNull();
  });

  it("selects the most severe firing threshold", () => {
    const verdict = evaluateBurnRate(
      0.99,
      () => ({ total: 100, failed: 100 }),
      [slow, fast],
    );
    expect(verdict.breached).toBe(true);
    expect(verdict.worstSeverity).toBe("sev2");
    expect(verdict.worstThresholdId).toBe("fast");
  });

  it("falls back to a lower severity when only the slow burn fires", () => {
    const verdict = evaluateBurnRate(
      0.99,
      (windowMs) =>
        windowMs >= 3_600_000 ? { total: 100, failed: 8 } : { total: 50, failed: 4 },
      [fast, slow],
    );
    expect(verdict.worstSeverity).toBe("sev3");
  });
});
