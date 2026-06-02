import { z } from "zod";
import { SeveritySchema, type Severity } from "@crossengin/incident-response";
import { parseDurationMs } from "./clock.js";
import { failureRate, type WindowCounts } from "./window.js";

const WINDOW_REGEX = /^\d+[smhdw]$/;

export const BurnRateThresholdSchema = z
  .object({
    id: z.string().min(1),
    longWindow: z.string().regex(WINDOW_REGEX),
    shortWindow: z.string().regex(WINDOW_REGEX),
    burnRateMultiplier: z.number().positive(),
    severity: SeveritySchema,
    minSamples: z.number().int().nonnegative().default(0),
    description: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (parseDurationMs(v.shortWindow) >= parseDurationMs(v.longWindow)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["shortWindow"],
        message: "shortWindow must be strictly shorter than longWindow",
      });
    }
  });
export type BurnRateThreshold = z.infer<typeof BurnRateThresholdSchema>;

export const DEFAULT_BURN_RATE_THRESHOLDS: readonly BurnRateThreshold[] =
  Object.freeze([
    {
      id: "fast-burn",
      longWindow: "1h",
      shortWindow: "5m",
      burnRateMultiplier: 14.4,
      severity: "sev2" as Severity,
      minSamples: 20,
      description: "Consumes 2% of a 30d budget in 1h — page immediately.",
    },
    {
      id: "slow-burn",
      longWindow: "6h",
      shortWindow: "30m",
      burnRateMultiplier: 6,
      severity: "sev3" as Severity,
      minSamples: 50,
      description: "Consumes 10% of a 30d budget in 6h — open a ticket.",
    },
  ]);

export function burnRate(target: number, counts: WindowCounts): number {
  if (target <= 0 || target > 1) {
    throw new Error("availability target must be in (0, 1]");
  }
  const allowed = 1 - target;
  if (allowed === 0) return counts.failed > 0 ? Number.POSITIVE_INFINITY : 0;
  return failureRate(counts) / allowed;
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({
  sev1: 1,
  sev2: 2,
  sev3: 3,
  sev4: 4,
  sev5: 5,
});

export interface ThresholdEvaluation {
  readonly threshold: BurnRateThreshold;
  readonly longBurn: number;
  readonly shortBurn: number;
  readonly longCounts: WindowCounts;
  readonly shortCounts: WindowCounts;
  readonly firing: boolean;
}

export interface BurnRateVerdict {
  readonly breached: boolean;
  readonly worstSeverity: Severity | null;
  readonly worstThresholdId: string | null;
  readonly evaluations: readonly ThresholdEvaluation[];
}

export type WindowMeasure = (windowMs: number) => WindowCounts;

export function evaluateThreshold(
  target: number,
  measure: WindowMeasure,
  threshold: BurnRateThreshold,
): ThresholdEvaluation {
  const longCounts = measure(parseDurationMs(threshold.longWindow));
  const shortCounts = measure(parseDurationMs(threshold.shortWindow));
  const longBurn = burnRate(target, longCounts);
  const shortBurn = burnRate(target, shortCounts);
  const enoughSamples = longCounts.total >= threshold.minSamples;
  const firing =
    enoughSamples &&
    longBurn >= threshold.burnRateMultiplier &&
    shortBurn >= threshold.burnRateMultiplier;
  return { threshold, longBurn, shortBurn, longCounts, shortCounts, firing };
}

export function evaluateBurnRate(
  target: number,
  measure: WindowMeasure,
  thresholds: readonly BurnRateThreshold[],
): BurnRateVerdict {
  const evaluations = thresholds.map((t) => evaluateThreshold(target, measure, t));
  let worst: ThresholdEvaluation | null = null;
  for (const ev of evaluations) {
    if (!ev.firing) continue;
    if (worst === null || SEVERITY_RANK[ev.threshold.severity] < SEVERITY_RANK[worst.threshold.severity]) {
      worst = ev;
    }
  }
  return {
    breached: worst !== null,
    worstSeverity: worst?.threshold.severity ?? null,
    worstThresholdId: worst?.threshold.id ?? null,
    evaluations,
  };
}
