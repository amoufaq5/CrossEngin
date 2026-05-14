import { z } from "zod";
import {
  ENDPOINT_CLASSES,
  LatencyBudgetSchema,
  SloWindowSchema,
  type EndpointClass,
} from "@crossengin/observability";

const Iso8601 = z.string().datetime({ offset: true });
const ROUTE_ID_REGEX = /^[a-z][a-z0-9-]*$/;

export const LATENCY_PERCENTILES = ["p50", "p95", "p99"] as const;
export type LatencyPercentile = (typeof LATENCY_PERCENTILES)[number];

export const BUDGET_SEVERITIES = ["info", "warning", "critical"] as const;
export type BudgetSeverity = (typeof BUDGET_SEVERITIES)[number];

const LATENCY_TO_MS_REGEX = /^(\d+(?:\.\d+)?)(ms|s)$/;

export function latencyToMs(budget: string): number {
  const match = budget.match(LATENCY_TO_MS_REGEX);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`malformed latency budget '${budget}'`);
  }
  const value = Number.parseFloat(match[1]);
  return match[2] === "s" ? value * 1000 : value;
}

export const RouteLatencyBudgetSchema = z
  .object({
    routeId: z.string().regex(ROUTE_ID_REGEX),
    endpointClass: z.enum(ENDPOINT_CLASSES),
    p50: LatencyBudgetSchema.optional(),
    p95: LatencyBudgetSchema.optional(),
    p99: LatencyBudgetSchema.optional(),
    window: SloWindowSchema.default("30d"),
    syntheticOnly: z.boolean().default(false),
    alertSeverity: z.enum(BUDGET_SEVERITIES).default("warning"),
    pagerOnBreach: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.p50 === undefined && v.p95 === undefined && v.p99 === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["p50"],
        message: "must declare at least one of p50, p95, p99",
      });
      return;
    }
    const p50 = v.p50 === undefined ? null : latencyToMs(v.p50);
    const p95 = v.p95 === undefined ? null : latencyToMs(v.p95);
    const p99 = v.p99 === undefined ? null : latencyToMs(v.p99);
    if (p50 !== null && p95 !== null && p95 < p50) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["p95"],
        message: "p95 must be >= p50",
      });
    }
    if (p95 !== null && p99 !== null && p99 < p95) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["p99"],
        message: "p99 must be >= p95",
      });
    }
    if (p50 !== null && p99 !== null && p99 < p50) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["p99"],
        message: "p99 must be >= p50",
      });
    }
    if (v.pagerOnBreach && v.alertSeverity !== "critical") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["alertSeverity"],
        message: "pagerOnBreach=true requires alertSeverity='critical'",
      });
    }
  });
export type RouteLatencyBudget = z.infer<typeof RouteLatencyBudgetSchema>;

export const RouteLatencyBudgetSetSchema = z
  .array(RouteLatencyBudgetSchema)
  .superRefine((entries, ctx) => {
    const keys = new Map<string, number>();
    entries.forEach((e, i) => {
      const key = `${e.routeId}|${e.endpointClass}`;
      const prior = keys.get(key);
      if (prior !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: `duplicate (routeId, endpointClass) '${key}' (already declared at index ${prior})`,
        });
      }
      keys.set(key, i);
    });
  });
export type RouteLatencyBudgetSet = z.infer<typeof RouteLatencyBudgetSetSchema>;

export const BudgetBreachRecordSchema = z
  .object({
    id: z.string().min(1),
    routeId: z.string().regex(ROUTE_ID_REGEX),
    percentile: z.enum(LATENCY_PERCENTILES),
    budgetMs: z.number().positive(),
    observedMs: z.number().positive(),
    severity: z.enum(BUDGET_SEVERITIES),
    observedAt: Iso8601,
    windowStart: Iso8601,
    windowEnd: Iso8601,
    sampleCount: z.number().int().positive(),
    alertSent: z.boolean().default(false),
    pagedAt: Iso8601.nullable().default(null),
    resolvedAt: Iso8601.nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.observedMs <= v.budgetMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observedMs"],
        message: "breach record requires observedMs > budgetMs",
      });
    }
    if (new Date(v.windowEnd).getTime() <= new Date(v.windowStart).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["windowEnd"],
        message: "windowEnd must be after windowStart",
      });
    }
    if (v.severity === "critical" && !v.alertSent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["alertSent"],
        message: "critical breaches must have alertSent=true",
      });
    }
    if (
      v.resolvedAt !== null &&
      new Date(v.resolvedAt).getTime() < new Date(v.observedAt).getTime()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolvedAt"],
        message: "resolvedAt cannot be before observedAt",
      });
    }
  });
export type BudgetBreachRecord = z.infer<typeof BudgetBreachRecordSchema>;

export interface BreachCheckResult {
  readonly breached: boolean;
  readonly percentile: LatencyPercentile;
  readonly budgetMs: number;
  readonly observedMs: number;
  readonly exceededByMs: number;
}

export function evaluateBudget(
  budget: RouteLatencyBudget,
  observed: {
    readonly p50Ms?: number;
    readonly p95Ms?: number;
    readonly p99Ms?: number;
  },
): readonly BreachCheckResult[] {
  const results: BreachCheckResult[] = [];
  if (budget.p50 !== undefined && observed.p50Ms !== undefined) {
    const budgetMs = latencyToMs(budget.p50);
    results.push({
      breached: observed.p50Ms > budgetMs,
      percentile: "p50",
      budgetMs,
      observedMs: observed.p50Ms,
      exceededByMs: Math.max(0, observed.p50Ms - budgetMs),
    });
  }
  if (budget.p95 !== undefined && observed.p95Ms !== undefined) {
    const budgetMs = latencyToMs(budget.p95);
    results.push({
      breached: observed.p95Ms > budgetMs,
      percentile: "p95",
      budgetMs,
      observedMs: observed.p95Ms,
      exceededByMs: Math.max(0, observed.p95Ms - budgetMs),
    });
  }
  if (budget.p99 !== undefined && observed.p99Ms !== undefined) {
    const budgetMs = latencyToMs(budget.p99);
    results.push({
      breached: observed.p99Ms > budgetMs,
      percentile: "p99",
      budgetMs,
      observedMs: observed.p99Ms,
      exceededByMs: Math.max(0, observed.p99Ms - budgetMs),
    });
  }
  return results;
}

export function budgetsByEndpointClass(
  set: RouteLatencyBudgetSet,
  endpointClass: EndpointClass,
): readonly RouteLatencyBudget[] {
  return set.filter((b) => b.endpointClass === endpointClass);
}
