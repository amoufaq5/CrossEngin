import { z } from "zod";

export const FRONTEND_METRICS = ["fcp", "tti", "lcp", "cls", "tbt", "speed_index"] as const;
export type FrontendMetric = (typeof FRONTEND_METRICS)[number];

export const FrontendBudgetSchema = z.object({
  fcpMs: z.number().int().positive().default(1_500),
  ttiMs: z.number().int().positive().default(3_000),
  lcpMs: z.number().int().positive().default(2_500),
  cls: z.number().nonnegative().default(0.1),
  tbtMs: z.number().int().nonnegative().default(200),
  perRouteJsBundleKb: z.number().int().positive().default(250),
  regressionTolerancePercent: z.number().min(0).max(50).default(20),
});
export type FrontendBudget = z.infer<typeof FrontendBudgetSchema>;

export const DEFAULT_FRONTEND_BUDGET: FrontendBudget = FrontendBudgetSchema.parse({});

export const RendererBudgetSchema = z
  .object({
    renderer: z.enum(["list", "record", "form", "kanban", "calendar", "map", "dashboard", "pivot"]),
    representativeRows: z.number().int().nonnegative(),
    targetRenderMs: z.number().int().positive(),
  })
  .superRefine((v, ctx) => {
    const minPerKind: Readonly<Record<string, number>> = {
      list: 50,
      record: 200,
      form: 100,
      kanban: 100,
      calendar: 100,
      map: 250,
      dashboard: 300,
      pivot: 500,
    };
    const ceiling = minPerKind[v.renderer];
    if (ceiling !== undefined && v.targetRenderMs > ceiling * 4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetRenderMs"],
        message: `targetRenderMs ${v.targetRenderMs}ms is unusually high for renderer '${v.renderer}' (typical ceiling ~${ceiling}ms)`,
      });
    }
  });
export type RendererBudget = z.infer<typeof RendererBudgetSchema>;

export const BackendBudgetSchema = z.object({
  apiReadP95Ms: z.number().int().positive().default(300),
  apiWriteP95Ms: z.number().int().positive().default(1_000),
  dbQueryP95Ms: z.number().int().positive().default(100),
});
export type BackendBudget = z.infer<typeof BackendBudgetSchema>;

export const DEFAULT_BACKEND_BUDGET: BackendBudget = BackendBudgetSchema.parse({});

export interface FrontendBudgetCheckInput {
  readonly budget: FrontendBudget;
  readonly measured: {
    readonly fcpMs: number;
    readonly ttiMs: number;
    readonly lcpMs: number;
    readonly cls: number;
    readonly tbtMs: number;
    readonly perRouteJsBundleKb: number;
  };
}

export interface FrontendBudgetCheckOutcome {
  readonly decision: "pass" | "warn" | "block";
  readonly violations: readonly string[];
}

export function checkFrontendBudget(input: FrontendBudgetCheckInput): FrontendBudgetCheckOutcome {
  const violations: string[] = [];
  const tolerance = 1 + input.budget.regressionTolerancePercent / 100;

  if (input.measured.fcpMs > input.budget.fcpMs * tolerance) {
    violations.push(`FCP ${input.measured.fcpMs}ms exceeds budget ${input.budget.fcpMs}ms`);
  }
  if (input.measured.ttiMs > input.budget.ttiMs * tolerance) {
    violations.push(`TTI ${input.measured.ttiMs}ms exceeds budget ${input.budget.ttiMs}ms`);
  }
  if (input.measured.lcpMs > input.budget.lcpMs * tolerance) {
    violations.push(`LCP ${input.measured.lcpMs}ms exceeds budget ${input.budget.lcpMs}ms`);
  }
  if (input.measured.cls > input.budget.cls * tolerance) {
    violations.push(
      `CLS ${input.measured.cls.toFixed(3)} exceeds budget ${input.budget.cls.toFixed(3)}`,
    );
  }
  if (input.measured.tbtMs > input.budget.tbtMs * tolerance) {
    violations.push(`TBT ${input.measured.tbtMs}ms exceeds budget ${input.budget.tbtMs}ms`);
  }
  if (input.measured.perRouteJsBundleKb > input.budget.perRouteJsBundleKb * tolerance) {
    violations.push(
      `bundle ${input.measured.perRouteJsBundleKb}KB exceeds budget ${input.budget.perRouteJsBundleKb}KB`,
    );
  }
  if (violations.length === 0) return { decision: "pass", violations: [] };
  if (violations.length >= 3) return { decision: "block", violations };
  return { decision: "warn", violations };
}

export const AccessibilityImpactSchema = z.enum(["minor", "moderate", "serious", "critical"]);
export type AccessibilityImpact = z.infer<typeof AccessibilityImpactSchema>;

export const AccessibilityBudgetSchema = z.object({
  wcagLevel: z.enum(["A", "AA", "AAA"]).default("AA"),
  failOnImpact: z.enum(["minor", "moderate", "serious", "critical"]).default("serious"),
  maxViolationsPerPage: z.number().int().nonnegative().default(0),
});
export type AccessibilityBudget = z.infer<typeof AccessibilityBudgetSchema>;

export interface AccessibilityViolation {
  readonly ruleId: string;
  readonly impact: AccessibilityImpact;
  readonly count: number;
}

export const IMPACT_ORDER: Readonly<Record<AccessibilityImpact, number>> = Object.freeze({
  minor: 0,
  moderate: 1,
  serious: 2,
  critical: 3,
});

export function checkAccessibilityBudget(
  violations: readonly AccessibilityViolation[],
  budget: AccessibilityBudget,
): { readonly decision: "pass" | "block"; readonly failingRules: readonly string[] } {
  const threshold = IMPACT_ORDER[budget.failOnImpact];
  let failingCount = 0;
  const failingRules: string[] = [];
  for (const v of violations) {
    if (IMPACT_ORDER[v.impact] >= threshold) {
      failingCount += v.count;
      failingRules.push(v.ruleId);
    }
  }
  if (failingCount > budget.maxViolationsPerPage) {
    return { decision: "block", failingRules };
  }
  return { decision: "pass", failingRules: [] };
}
