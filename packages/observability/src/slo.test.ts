import { describe, expect, it } from "vitest";
import {
  computeErrorBudget,
  LatencyBudgetSchema,
  SloIdSchema,
  SloSchema,
  SloWindowSchema,
} from "./slo.js";

describe("SloIdSchema", () => {
  it("accepts kebab-case ids", () => {
    expect(SloIdSchema.parse("kernel-api")).toBe("kernel-api");
  });

  it("rejects uppercase or leading hyphen", () => {
    expect(() => SloIdSchema.parse("Kernel")).toThrow();
    expect(() => SloIdSchema.parse("-leading")).toThrow();
  });
});

describe("SloWindowSchema", () => {
  it("accepts standard windows", () => {
    expect(SloWindowSchema.parse("30d")).toBe("30d");
    expect(SloWindowSchema.parse("24h")).toBe("24h");
    expect(SloWindowSchema.parse("ever")).toBe("ever");
  });

  it("rejects free text", () => {
    expect(() => SloWindowSchema.parse("thirty days")).toThrow();
  });
});

describe("LatencyBudgetSchema", () => {
  it("accepts ms and s suffixes", () => {
    expect(LatencyBudgetSchema.parse("300ms")).toBe("300ms");
    expect(LatencyBudgetSchema.parse("1.5s")).toBe("1.5s");
  });

  it("rejects bare numbers", () => {
    expect(() => LatencyBudgetSchema.parse("300")).toThrow();
  });
});

describe("SloSchema", () => {
  it("parses an availability + latency slo", () => {
    const slo = {
      id: "kernel-api",
      surface: "kernel-api",
      targets: [
        { kind: "availability" as const, target: 0.999, window: "30d" as const },
        { kind: "latency" as const, p95: "300ms", p99: "1000ms" },
      ],
    };
    const parsed = SloSchema.parse(slo);
    expect(parsed.targets).toHaveLength(2);
  });

  it("rejects duplicate target kinds", () => {
    const slo = {
      id: "kernel-api",
      surface: "x",
      targets: [
        { kind: "availability" as const, target: 0.99, window: "30d" as const },
        { kind: "availability" as const, target: 0.95, window: "30d" as const },
      ],
    };
    expect(() => SloSchema.parse(slo)).toThrow(/duplicate target/);
  });

  it("allows latency targets distinguished by endpointClass", () => {
    const slo = {
      id: "kernel-api",
      surface: "x",
      targets: [
        {
          kind: "latency" as const,
          endpointClass: "read" as const,
          p95: "300ms",
        },
        {
          kind: "latency" as const,
          endpointClass: "write" as const,
          p95: "1000ms",
        },
      ],
    };
    expect(() => SloSchema.parse(slo)).not.toThrow();
  });

  it("rejects a latency target with no percentile", () => {
    expect(() =>
      SloSchema.parse({
        id: "kernel-api",
        surface: "x",
        targets: [{ kind: "latency", endpointClass: "read" }],
      }),
    ).toThrow(/at least one of p50, p95, p99/);
  });

  it("rejects availability target outside [0.5, 1]", () => {
    expect(() =>
      SloSchema.parse({
        id: "kernel-api",
        surface: "x",
        targets: [{ kind: "availability", target: 1.5, window: "30d" }],
      }),
    ).toThrow();
  });

  it("supports incident-count slos with target 0", () => {
    const slo = {
      id: "tenant-isolation",
      surface: "kernel",
      targets: [{ kind: "incidents" as const, target: 0, window: "ever" as const }],
    };
    expect(() => SloSchema.parse(slo)).not.toThrow();
  });
});

describe("computeErrorBudget", () => {
  const slo = SloSchema.parse({
    id: "kernel-api",
    surface: "kernel-api",
    targets: [{ kind: "availability", target: 0.999, window: "30d" }],
  });

  it("returns null when no availability target", () => {
    const latencyOnly = SloSchema.parse({
      id: "kernel-api",
      surface: "x",
      targets: [{ kind: "latency", p95: "300ms" }],
    });
    expect(computeErrorBudget(latencyOnly, 1000, 0)).toBeNull();
  });

  it("returns full budget when zero failures", () => {
    const r = computeErrorBudget(slo, 1_000_000, 0);
    expect(r?.errorBudgetUsed).toBe(0);
    expect(r?.errorBudgetRemaining).toBe(1);
  });

  it("computes 50% burn for half of the budget consumed", () => {
    const r = computeErrorBudget(slo, 1_000_000, 500);
    expect(r?.errorBudgetUsed).toBeCloseTo(0.5, 6);
    expect(r?.errorBudgetRemaining).toBeCloseTo(0.5, 6);
  });

  it("caps remaining at 0 when budget is exceeded", () => {
    const r = computeErrorBudget(slo, 1_000_000, 5_000);
    expect(r?.errorBudgetUsed).toBeGreaterThanOrEqual(1);
    expect(r?.errorBudgetRemaining).toBe(0);
  });

  it("handles zero requests safely", () => {
    const r = computeErrorBudget(slo, 0, 0);
    expect(r?.errorBudgetUsed).toBe(0);
  });

  it("rejects invalid request counts", () => {
    expect(() => computeErrorBudget(slo, -1, 0)).toThrow();
    expect(() => computeErrorBudget(slo, 10, 11)).toThrow();
  });
});
