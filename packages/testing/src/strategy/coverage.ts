import { z } from "zod";

export const COVERAGE_METRICS = ["statements", "branches", "functions", "lines"] as const;
export type CoverageMetric = (typeof COVERAGE_METRICS)[number];

export const CoverageNumbersSchema = z
  .object({
    covered: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    percent: z.number().min(0).max(100),
  })
  .superRefine((v, ctx) => {
    if (v.covered > v.total) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["covered"],
        message: "covered cannot exceed total",
      });
    }
    if (v.total === 0 && v.percent !== 0 && v.percent !== 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["percent"],
        message: "with total=0, percent must be 0 or 100",
      });
    }
    if (v.total > 0) {
      const expected = (v.covered / v.total) * 100;
      if (Math.abs(expected - v.percent) > 0.5) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["percent"],
          message: `percent ${v.percent.toFixed(2)} does not match covered/total ratio ${expected.toFixed(2)}`,
        });
      }
    }
  });
export type CoverageNumbers = z.infer<typeof CoverageNumbersSchema>;

export const PackageCoverageSchema = z.object({
  packageName: z.string().regex(/^@crossengin\/[a-z][a-z0-9-]*$/),
  statements: CoverageNumbersSchema,
  branches: CoverageNumbersSchema,
  functions: CoverageNumbersSchema,
  lines: CoverageNumbersSchema,
});
export type PackageCoverage = z.infer<typeof PackageCoverageSchema>;

export const CoverageReportSchema = z.object({
  reportedAt: z.string().datetime({ offset: true }),
  commit: z.string().min(1),
  packages: z.array(PackageCoverageSchema),
  excludedPaths: z.array(z.string().min(1)).default([]),
});
export type CoverageReport = z.infer<typeof CoverageReportSchema>;

export const CoverageGateSchema = z
  .object({
    minStatementsPercent: z.number().min(0).max(100).default(80),
    minBranchesPercent: z.number().min(0).max(100).default(70),
    minFunctionsPercent: z.number().min(0).max(100).default(80),
    minLinesPercent: z.number().min(0).max(100).default(80),
    maxDropPercent: z.number().min(0).max(50).default(1),
  })
  .superRefine((v, ctx) => {
    if (v.minBranchesPercent > v.minStatementsPercent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minBranchesPercent"],
        message: "minBranchesPercent should not exceed minStatementsPercent",
      });
    }
  });
export type CoverageGate = z.infer<typeof CoverageGateSchema>;

export const DEFAULT_COVERAGE_GATE: CoverageGate = CoverageGateSchema.parse({});

export const COVERAGE_GATE_DECISIONS = ["pass", "fail_minimum", "fail_regression"] as const;
export type CoverageGateDecision = (typeof COVERAGE_GATE_DECISIONS)[number];

export interface CoverageGateOutcome {
  readonly decision: CoverageGateDecision;
  readonly reasons: readonly string[];
  readonly overallStatementsPercent: number;
  readonly overallBranchesPercent: number;
}

export function aggregateReport(
  report: CoverageReport,
): Readonly<Record<CoverageMetric, CoverageNumbers>> {
  const totals: Record<CoverageMetric, { covered: number; total: number }> = {
    statements: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    lines: { covered: 0, total: 0 },
  };
  for (const pkg of report.packages) {
    for (const metric of COVERAGE_METRICS) {
      totals[metric].covered += pkg[metric].covered;
      totals[metric].total += pkg[metric].total;
    }
  }
  const result: Partial<Record<CoverageMetric, CoverageNumbers>> = {};
  for (const metric of COVERAGE_METRICS) {
    const { covered, total } = totals[metric];
    const percent = total === 0 ? 100 : (covered / total) * 100;
    result[metric] = { covered, total, percent };
  }
  return result as Readonly<Record<CoverageMetric, CoverageNumbers>>;
}

export interface CoverageGateInput {
  readonly current: CoverageReport;
  readonly baseline?: CoverageReport;
  readonly gate?: CoverageGate;
}

export function evaluateCoverageGate(input: CoverageGateInput): CoverageGateOutcome {
  const gate = input.gate ?? DEFAULT_COVERAGE_GATE;
  const reasons: string[] = [];
  const current = aggregateReport(input.current);

  if (current.statements.percent < gate.minStatementsPercent) {
    reasons.push(
      `statements ${current.statements.percent.toFixed(2)}% below minimum ${gate.minStatementsPercent}%`,
    );
  }
  if (current.branches.percent < gate.minBranchesPercent) {
    reasons.push(
      `branches ${current.branches.percent.toFixed(2)}% below minimum ${gate.minBranchesPercent}%`,
    );
  }
  if (current.functions.percent < gate.minFunctionsPercent) {
    reasons.push(
      `functions ${current.functions.percent.toFixed(2)}% below minimum ${gate.minFunctionsPercent}%`,
    );
  }
  if (current.lines.percent < gate.minLinesPercent) {
    reasons.push(
      `lines ${current.lines.percent.toFixed(2)}% below minimum ${gate.minLinesPercent}%`,
    );
  }
  if (reasons.length > 0) {
    return {
      decision: "fail_minimum",
      reasons,
      overallStatementsPercent: current.statements.percent,
      overallBranchesPercent: current.branches.percent,
    };
  }
  if (input.baseline !== undefined) {
    const baseline = aggregateReport(input.baseline);
    const dropStatements = baseline.statements.percent - current.statements.percent;
    if (dropStatements > gate.maxDropPercent) {
      reasons.push(
        `statements regressed by ${dropStatements.toFixed(2)}% (max ${gate.maxDropPercent}%)`,
      );
    }
    const dropBranches = baseline.branches.percent - current.branches.percent;
    if (dropBranches > gate.maxDropPercent) {
      reasons.push(
        `branches regressed by ${dropBranches.toFixed(2)}% (max ${gate.maxDropPercent}%)`,
      );
    }
    if (reasons.length > 0) {
      return {
        decision: "fail_regression",
        reasons,
        overallStatementsPercent: current.statements.percent,
        overallBranchesPercent: current.branches.percent,
      };
    }
  }
  return {
    decision: "pass",
    reasons: [],
    overallStatementsPercent: current.statements.percent,
    overallBranchesPercent: current.branches.percent,
  };
}
