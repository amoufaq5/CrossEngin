import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;
const EVALSET_ID_REGEX = /^eval_[a-z0-9-]{4,40}$/;

export const EVAL_TASK_KINDS = [
  "manifest_proposal",
  "sql_generation",
  "permission_decision",
  "redaction_decision",
  "summarization",
  "intent_classification",
  "safety_refusal",
  "regression_replay",
] as const;
export type EvalTaskKind = (typeof EVAL_TASK_KINDS)[number];
export const EvalTaskKindSchema = z.enum(EVAL_TASK_KINDS);

export const SCORING_METRICS = [
  "exact_match",
  "json_equality",
  "embedding_cosine",
  "rouge_l",
  "binary_correctness",
  "rubric_grade",
  "structural_diff",
] as const;
export type ScoringMetric = (typeof SCORING_METRICS)[number];
export const ScoringMetricSchema = z.enum(SCORING_METRICS);

export const EvalExampleSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    prompt: z.string().min(1),
    expectedOutput: z.string().min(1),
    expectedOutputSha256: z.string().regex(SHA256_REGEX),
    metric: ScoringMetricSchema,
    passThreshold: z.number().min(0).max(1).default(1),
    tags: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
    isGoldenRegressionGuard: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.metric === "binary_correctness" && v.passThreshold !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["passThreshold"],
        message: "binary_correctness metric must use passThreshold=1",
      });
    }
    if (v.metric === "exact_match" && v.passThreshold !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["passThreshold"],
        message: "exact_match metric must use passThreshold=1",
      });
    }
    const tagSeen = new Set<string>();
    v.tags.forEach((t, i) => {
      if (tagSeen.has(t)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tags", i],
          message: `duplicate tag '${t}'`,
        });
      }
      tagSeen.add(t);
    });
  });
export type EvalExample = z.infer<typeof EvalExampleSchema>;

export const EvalSetSchema = z
  .object({
    id: z.string().regex(EVALSET_ID_REGEX),
    label: z.string().min(1),
    description: z.string().min(1),
    taskKind: EvalTaskKindSchema,
    examples: z.array(EvalExampleSchema).min(1),
    frozenAt: Iso8601,
    frozenBy: z.string().min(1),
    frozenSha256: z.string().regex(SHA256_REGEX),
    requiredPassRate: z.number().min(0).max(1),
    blocksProductionPromotion: z.boolean().default(false),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    supersededBy: z.string().regex(EVALSET_ID_REGEX).optional(),
    retiredAt: Iso8601.nullable().default(null),
    retiredReason: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.examples.forEach((e, i) => {
      if (seen.has(e.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["examples", i, "id"],
          message: `duplicate example id '${e.id}'`,
        });
      }
      seen.add(e.id);
    });
    if (v.taskKind === "safety_refusal" && !v.blocksProductionPromotion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blocksProductionPromotion"],
        message:
          "safety_refusal eval sets must blocksProductionPromotion=true (safety regression is a release blocker)",
      });
    }
    if (v.taskKind === "permission_decision" && !v.blocksProductionPromotion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blocksProductionPromotion"],
        message: "permission_decision eval sets must blocksProductionPromotion=true",
      });
    }
    if (v.retiredAt !== null && v.retiredReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retiredReason"],
        message: "retiredAt requires retiredReason",
      });
    }
    if (v.retiredAt !== null && v.supersededBy === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supersededBy"],
        message: "retired eval sets must reference supersededBy",
      });
    }
    if (v.taskKind === "safety_refusal" || v.taskKind === "permission_decision") {
      if (v.requiredPassRate < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredPassRate"],
          message: `taskKind '${v.taskKind}' must require 100% pass rate`,
        });
      }
    }
  });
export type EvalSet = z.infer<typeof EvalSetSchema>;

export function regressionGuards(set: EvalSet): readonly EvalExample[] {
  return set.examples.filter((e) => e.isGoldenRegressionGuard);
}

export function exampleCountByTag(set: EvalSet, tag: string): number {
  return set.examples.filter((e) => e.tags.includes(tag)).length;
}

export function isEvalSetReleaseBlocker(set: EvalSet): boolean {
  if (!set.blocksProductionPromotion) return false;
  if (set.retiredAt !== null) return false;
  return true;
}
