import { z } from "zod";
import { SeveritySchema, type Severity } from "@crossengin/incident-response";
import type { SloLatencyTarget } from "@crossengin/observability";
import type { LatencyStats } from "./window.js";

const LATENCY_BUDGET_REGEX = /^(\d+(?:\.\d+)?)(ms|s)$/;

export function parseLatencyBudgetMs(budget: string): number {
  const match = budget.match(LATENCY_BUDGET_REGEX);
  if (match === null) {
    throw new Error(`invalid latency budget '${budget}' (expected like '300ms' or '5s')`);
  }
  const amount = Number.parseFloat(match[1] as string);
  const unit = match[2] as string;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`invalid latency budget '${budget}'`);
  }
  return unit === "s" ? amount * 1_000 : amount;
}

export const LatencyThresholdSchema = z
  .object({
    id: z.string().min(1),
    multiplier: z.number().positive(),
    severity: SeveritySchema,
    minSamples: z.number().int().nonnegative().default(0),
    description: z.string().min(1).optional(),
  })
  .strict();
export type LatencyThreshold = z.infer<typeof LatencyThresholdSchema>;

export const DEFAULT_LATENCY_THRESHOLDS: readonly LatencyThreshold[] = Object.freeze([
  {
    id: "latency-page",
    multiplier: 2,
    severity: "sev2" as Severity,
    minSamples: 20,
    description: "Observed percentile is 2x the budget — page.",
  },
  {
    id: "latency-ticket",
    multiplier: 1,
    severity: "sev3" as Severity,
    minSamples: 20,
    description: "Observed percentile exceeds the budget — open a ticket.",
  },
]);

export const LATENCY_PERCENTILES = ["p50", "p95", "p99"] as const;
export type LatencyPercentile = (typeof LATENCY_PERCENTILES)[number];

export interface LatencyBreachDetail {
  readonly percentile: LatencyPercentile;
  readonly observedMs: number;
  readonly budgetMs: number;
  readonly thresholdMs: number;
  readonly multiplier: number;
  readonly severity: Severity;
  readonly thresholdId: string;
}

export interface LatencyVerdict {
  readonly breached: boolean;
  readonly worstSeverity: Severity | null;
  readonly worstThresholdId: string | null;
  readonly worstPercentile: LatencyPercentile | null;
  readonly breaches: readonly LatencyBreachDetail[];
  readonly sampleCount: number;
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({
  sev1: 1,
  sev2: 2,
  sev3: 3,
  sev4: 4,
  sev5: 5,
});

export function evaluateLatencyTarget(
  target: SloLatencyTarget,
  observed: LatencyStats,
  thresholds: readonly LatencyThreshold[] = DEFAULT_LATENCY_THRESHOLDS,
): LatencyVerdict {
  const budgets: ReadonlyArray<readonly [LatencyPercentile, string | undefined, number | null]> = [
    ["p50", target.p50, observed.p50],
    ["p95", target.p95, observed.p95],
    ["p99", target.p99, observed.p99],
  ];

  const breaches: LatencyBreachDetail[] = [];
  for (const threshold of thresholds) {
    if (observed.count < threshold.minSamples) continue;
    for (const [percentile, budget, observedMs] of budgets) {
      if (budget === undefined || observedMs === null) continue;
      const budgetMs = parseLatencyBudgetMs(budget);
      const thresholdMs = budgetMs * threshold.multiplier;
      if (observedMs > thresholdMs) {
        breaches.push({
          percentile,
          observedMs,
          budgetMs,
          thresholdMs,
          multiplier: threshold.multiplier,
          severity: threshold.severity,
          thresholdId: threshold.id,
        });
      }
    }
  }

  let worst: LatencyBreachDetail | null = null;
  for (const breach of breaches) {
    if (worst === null || SEVERITY_RANK[breach.severity] < SEVERITY_RANK[worst.severity]) {
      worst = breach;
    }
  }

  return {
    breached: worst !== null,
    worstSeverity: worst?.severity ?? null,
    worstThresholdId: worst?.thresholdId ?? null,
    worstPercentile: worst?.percentile ?? null,
    breaches,
    sampleCount: observed.count,
  };
}
