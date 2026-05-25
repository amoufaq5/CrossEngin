import { describe, expect, it } from "vitest";
import {
  aggregateReport,
  CoverageGateSchema,
  CoverageNumbersSchema,
  CoverageReportSchema,
  DEFAULT_COVERAGE_GATE,
  evaluateCoverageGate,
} from "./coverage.js";

const now = "2026-05-13T10:00:00.000Z";

function nums(
  covered: number,
  total: number,
): {
  covered: number;
  total: number;
  percent: number;
} {
  const percent = total === 0 ? 100 : (covered / total) * 100;
  return { covered, total, percent };
}

const baseReport = CoverageReportSchema.parse({
  reportedAt: now,
  commit: "abc123",
  packages: [
    {
      packageName: "@crossengin/kernel",
      statements: nums(900, 1_000),
      branches: nums(700, 1_000),
      functions: nums(180, 200),
      lines: nums(900, 1_000),
    },
  ],
});

describe("CoverageNumbersSchema", () => {
  it("rejects covered > total", () => {
    expect(() => CoverageNumbersSchema.parse({ covered: 110, total: 100, percent: 100 })).toThrow();
  });

  it("rejects mismatched percent", () => {
    expect(() => CoverageNumbersSchema.parse({ covered: 50, total: 100, percent: 25 })).toThrow(
      /does not match/,
    );
  });

  it("accepts total=0 with percent=100", () => {
    expect(() => CoverageNumbersSchema.parse({ covered: 0, total: 0, percent: 100 })).not.toThrow();
  });
});

describe("CoverageGateSchema", () => {
  it("applies ADR-0023 defaults (80% statements, 1% drop)", () => {
    expect(DEFAULT_COVERAGE_GATE.minStatementsPercent).toBe(80);
    expect(DEFAULT_COVERAGE_GATE.maxDropPercent).toBe(1);
  });

  it("rejects branches threshold higher than statements", () => {
    expect(() =>
      CoverageGateSchema.parse({
        minBranchesPercent: 90,
        minStatementsPercent: 80,
      }),
    ).toThrow(/should not exceed/);
  });
});

describe("aggregateReport", () => {
  it("sums across packages", () => {
    const multi = CoverageReportSchema.parse({
      reportedAt: now,
      commit: "abc",
      packages: [
        {
          packageName: "@crossengin/kernel",
          statements: nums(80, 100),
          branches: nums(60, 100),
          functions: nums(8, 10),
          lines: nums(80, 100),
        },
        {
          packageName: "@crossengin/auth",
          statements: nums(180, 200),
          branches: nums(140, 200),
          functions: nums(18, 20),
          lines: nums(180, 200),
        },
      ],
    });
    const aggregate = aggregateReport(multi);
    expect(aggregate.statements.covered).toBe(260);
    expect(aggregate.statements.total).toBe(300);
  });
});

describe("evaluateCoverageGate", () => {
  it("passes when current >= minimums", () => {
    const outcome = evaluateCoverageGate({ current: baseReport });
    expect(outcome.decision).toBe("pass");
  });

  it("fails minimum when statements < 80%", () => {
    const low = CoverageReportSchema.parse({
      reportedAt: now,
      commit: "abc",
      packages: [
        {
          packageName: "@crossengin/kernel",
          statements: nums(70, 100),
          branches: nums(60, 100),
          functions: nums(16, 20),
          lines: nums(70, 100),
        },
      ],
    });
    const outcome = evaluateCoverageGate({ current: low });
    expect(outcome.decision).toBe("fail_minimum");
    expect(outcome.reasons.some((r) => r.includes("statements"))).toBe(true);
  });

  it("fails regression when statements drop > maxDropPercent", () => {
    const baseline = CoverageReportSchema.parse({
      reportedAt: now,
      commit: "abc",
      packages: [
        {
          packageName: "@crossengin/kernel",
          statements: nums(950, 1_000),
          branches: nums(800, 1_000),
          functions: nums(190, 200),
          lines: nums(950, 1_000),
        },
      ],
    });
    const outcome = evaluateCoverageGate({ current: baseReport, baseline });
    expect(outcome.decision).toBe("fail_regression");
    expect(outcome.reasons.some((r) => r.includes("regressed"))).toBe(true);
  });
});
