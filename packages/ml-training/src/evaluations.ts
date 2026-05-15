import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const EVAL_RUN_ID_REGEX = /^evalrun_[a-z0-9]{8,32}$/;
const EVALSET_ID_REGEX = /^eval_[a-z0-9-]{4,40}$/;
const SHA256_REGEX = /^[0-9a-f]{64}$/;

export const EVAL_VERDICTS = ["passed", "failed", "regressed", "improved"] as const;
export type EvalVerdict = (typeof EVAL_VERDICTS)[number];
export const EvalVerdictSchema = z.enum(EVAL_VERDICTS);

export const EXAMPLE_OUTCOMES = ["pass", "fail", "error", "skipped"] as const;
export type ExampleOutcome = (typeof EXAMPLE_OUTCOMES)[number];
export const ExampleOutcomeSchema = z.enum(EXAMPLE_OUTCOMES);

export const ExampleResultSchema = z
  .object({
    exampleId: z.string().regex(/^[a-z][a-z0-9-]*$/),
    outcome: ExampleOutcomeSchema,
    score: z.number().min(0).max(1).nullable(),
    actualOutputSha256: z.string().regex(SHA256_REGEX).nullable(),
    latencyMs: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().default(0),
    errorMessage: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.outcome === "error" && v.errorMessage === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorMessage"],
        message: "error outcome requires errorMessage",
      });
    }
    if (
      (v.outcome === "pass" || v.outcome === "fail") &&
      v.actualOutputSha256 === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actualOutputSha256"],
        message: `outcome '${v.outcome}' requires actualOutputSha256`,
      });
    }
    if (
      (v.outcome === "pass" || v.outcome === "fail") &&
      v.score === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["score"],
        message: `outcome '${v.outcome}' requires a numeric score`,
      });
    }
    if (v.outcome === "skipped" && v.score !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["score"],
        message: "skipped outcome must have score=null",
      });
    }
  });
export type ExampleResult = z.infer<typeof ExampleResultSchema>;

export const EvaluationRunSchema = z
  .object({
    id: z.string().regex(EVAL_RUN_ID_REGEX),
    evalSetId: z.string().regex(EVALSET_ID_REGEX),
    evalSetSha256: z.string().regex(SHA256_REGEX),
    modelId: z.string().min(1),
    modelVersion: z.string().min(1),
    baselineRunId: z.string().regex(EVAL_RUN_ID_REGEX).nullable().default(null),
    startedAt: Iso8601,
    completedAt: Iso8601.nullable().default(null),
    durationSeconds: z.number().int().nonnegative().nullable().default(null),
    examplesEvaluated: z.number().int().nonnegative(),
    examplesPassed: z.number().int().nonnegative(),
    examplesFailed: z.number().int().nonnegative(),
    examplesErrored: z.number().int().nonnegative(),
    examplesSkipped: z.number().int().nonnegative(),
    passRate: z.number().min(0).max(1),
    requiredPassRate: z.number().min(0).max(1),
    verdict: EvalVerdictSchema,
    totalCostUsd: z.number().nonnegative(),
    p50LatencyMs: z.number().int().nonnegative(),
    p99LatencyMs: z.number().int().nonnegative(),
    results: z.array(ExampleResultSchema).default([]),
    blocksPromotion: z.boolean(),
    triggeredBy: z.string().min(1),
    trigger: z.enum([
      "manual",
      "ci_pipeline",
      "training_completed",
      "scheduled_regression",
    ]),
  })
  .superRefine((v, ctx) => {
    const sum =
      v.examplesPassed + v.examplesFailed + v.examplesErrored + v.examplesSkipped;
    if (sum !== v.examplesEvaluated) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["examplesEvaluated"],
        message: `passed+failed+errored+skipped (${sum}) must equal examplesEvaluated (${v.examplesEvaluated})`,
      });
    }
    if (v.examplesEvaluated > 0) {
      const computed = v.examplesPassed / v.examplesEvaluated;
      if (Math.abs(computed - v.passRate) > 0.001) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["passRate"],
          message: `passRate ${v.passRate.toString()} does not match passed/evaluated (${computed.toString()})`,
        });
      }
    }
    if (v.p99LatencyMs < v.p50LatencyMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["p99LatencyMs"],
        message: "p99LatencyMs must be >= p50LatencyMs",
      });
    }
    if (
      v.verdict === "regressed" || v.verdict === "improved"
    ) {
      if (v.baselineRunId === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["baselineRunId"],
          message: `verdict '${v.verdict}' requires baselineRunId for comparison`,
        });
      }
    }
    if (v.verdict === "passed" && v.passRate < v.requiredPassRate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verdict"],
        message: `verdict='passed' requires passRate (${v.passRate.toString()}) >= requiredPassRate (${v.requiredPassRate.toString()})`,
      });
    }
    if (v.verdict === "failed" && v.passRate >= v.requiredPassRate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verdict"],
        message: `verdict='failed' requires passRate (${v.passRate.toString()}) < requiredPassRate (${v.requiredPassRate.toString()})`,
      });
    }
    if (
      (v.verdict === "failed" || v.verdict === "regressed") &&
      !v.blocksPromotion
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blocksPromotion"],
        message: `verdict '${v.verdict}' must set blocksPromotion=true`,
      });
    }
    if (v.completedAt !== null && v.durationSeconds === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationSeconds"],
        message: "completedAt requires durationSeconds",
      });
    }
  });
export type EvaluationRun = z.infer<typeof EvaluationRunSchema>;

export function isRegression(
  current: EvaluationRun,
  baseline: EvaluationRun,
): boolean {
  if (current.evalSetId !== baseline.evalSetId) return false;
  return current.passRate < baseline.passRate;
}

export function passRateDelta(
  current: EvaluationRun,
  baseline: EvaluationRun,
): number {
  return current.passRate - baseline.passRate;
}

export function blocksPromotion(run: EvaluationRun): boolean {
  if (!run.blocksPromotion) return false;
  return run.verdict === "failed" || run.verdict === "regressed";
}

export function failedExampleIds(
  run: EvaluationRun,
): readonly string[] {
  return run.results
    .filter((r) => r.outcome === "fail" || r.outcome === "error")
    .map((r) => r.exampleId);
}
