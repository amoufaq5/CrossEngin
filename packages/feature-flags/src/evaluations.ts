import { z } from "zod";

export const EVALUATION_REASONS = [
  "default_returned",
  "kill_switch_active",
  "flag_not_found",
  "flag_archived",
  "flag_paused",
  "flag_disabled_for_environment",
  "specific_principal_match",
  "specific_tenant_match",
  "tenant_attribute_match",
  "principal_attribute_match",
  "percentage_bucket_match",
  "segment_match",
  "custom_predicate_match",
  "exclusion_rule_hit",
  "fallthrough_to_default",
  "error_returned_default",
  "expired_returned_default",
] as const;
export type EvaluationReason = (typeof EVALUATION_REASONS)[number];

export const TERMINAL_REASONS: ReadonlySet<EvaluationReason> = new Set([
  "default_returned",
  "kill_switch_active",
  "flag_not_found",
  "flag_archived",
  "flag_paused",
  "flag_disabled_for_environment",
  "exclusion_rule_hit",
  "fallthrough_to_default",
  "error_returned_default",
  "expired_returned_default",
]);

export const FlagEvaluationSchema = z
  .object({
    id: z.string().regex(/^fev_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    flagKey: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/),
    flagId: z.string().regex(/^ff_[a-z0-9]{8,32}$/).nullable(),
    flagVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/).nullable(),
    environment: z.enum(["preview", "staging", "production", "sandbox"]),
    principalId: z.string().uuid().nullable(),
    sessionId: z.string().max(120).nullable(),
    evaluatedAt: z.string().datetime({ offset: true }),
    evaluationLatencyUs: z.number().int().min(0).max(10_000_000),
    reason: z.enum(EVALUATION_REASONS),
    matchedRuleId: z.string().regex(/^ftr_[a-z0-9]{8,40}$/).nullable(),
    matchedSegmentId: z.string().regex(/^fseg_[a-z0-9]{8,40}$/).nullable(),
    servedVariantKey: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(80)
      .nullable(),
    servedValueJson: z.string().min(1).max(10_000),
    killSwitchId: z.string().regex(/^fks_[a-z0-9]{8,40}$/).nullable(),
    bucketingValueSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    requestId: z.string().regex(/^req_[A-Za-z0-9_-]{8,64}$/).nullable(),
    correlationId: z.string().max(200).nullable(),
    isSampled: z.boolean().default(true),
    errorCode: z.string().max(80).nullable(),
    errorMessage: z.string().max(500).nullable(),
  })
  .superRefine((e, ctx) => {
    try {
      JSON.parse(e.servedValueJson);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["servedValueJson"],
        message: "servedValueJson must be valid JSON",
      });
    }
    if (e.reason === "kill_switch_active" && e.killSwitchId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["killSwitchId"],
        message: "kill_switch_active reason requires killSwitchId",
      });
    }
    if (e.reason === "segment_match" && e.matchedSegmentId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["matchedSegmentId"],
        message: "segment_match reason requires matchedSegmentId",
      });
    }
    const ruleMatchReasons: ReadonlySet<EvaluationReason> = new Set([
      "specific_principal_match",
      "specific_tenant_match",
      "tenant_attribute_match",
      "principal_attribute_match",
      "percentage_bucket_match",
      "custom_predicate_match",
      "exclusion_rule_hit",
    ]);
    if (ruleMatchReasons.has(e.reason) && e.matchedRuleId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["matchedRuleId"],
        message: `${e.reason} reason requires matchedRuleId`,
      });
    }
    if (
      e.reason === "error_returned_default" &&
      (e.errorCode === null || e.errorMessage === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message:
          "error_returned_default reason requires errorCode + errorMessage",
      });
    }
    if (e.reason === "flag_not_found" && e.flagId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["flagId"],
        message: "flag_not_found reason cannot have flagId",
      });
    }
  });
export type FlagEvaluation = z.infer<typeof FlagEvaluationSchema>;

export interface EvaluationAggregate {
  readonly totalEvaluations: number;
  readonly reasonCounts: Readonly<Partial<Record<EvaluationReason, number>>>;
  readonly variantCounts: Readonly<Record<string, number>>;
  readonly errorCount: number;
  readonly errorRate: number;
  readonly p50LatencyUs: number;
  readonly p99LatencyUs: number;
  readonly killSwitchHitCount: number;
}

const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
};

export const aggregateEvaluations = (
  evaluations: readonly FlagEvaluation[],
): EvaluationAggregate => {
  const reasonCounts: Partial<Record<EvaluationReason, number>> = {};
  const variantCounts: Record<string, number> = {};
  let errorCount = 0;
  let killSwitchHitCount = 0;
  const latencies: number[] = [];
  for (const e of evaluations) {
    reasonCounts[e.reason] = (reasonCounts[e.reason] ?? 0) + 1;
    if (e.servedVariantKey !== null) {
      variantCounts[e.servedVariantKey] =
        (variantCounts[e.servedVariantKey] ?? 0) + 1;
    }
    if (e.reason === "error_returned_default") errorCount++;
    if (e.reason === "kill_switch_active") killSwitchHitCount++;
    latencies.push(e.evaluationLatencyUs);
  }
  latencies.sort((a, b) => a - b);
  return {
    totalEvaluations: evaluations.length,
    reasonCounts,
    variantCounts,
    errorCount,
    errorRate: evaluations.length === 0 ? 0 : errorCount / evaluations.length,
    p50LatencyUs: percentile(latencies, 50),
    p99LatencyUs: percentile(latencies, 99),
    killSwitchHitCount,
  };
};

export const isTerminalReason = (reason: EvaluationReason): boolean =>
  TERMINAL_REASONS.has(reason);

export const isFallbackEvaluation = (
  evaluation: FlagEvaluation,
): boolean =>
  evaluation.reason === "default_returned" ||
  evaluation.reason === "fallthrough_to_default" ||
  evaluation.reason === "error_returned_default" ||
  evaluation.reason === "flag_not_found";
