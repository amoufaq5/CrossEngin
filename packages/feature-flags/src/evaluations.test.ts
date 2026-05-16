import { describe, expect, it } from "vitest";
import {
  EVALUATION_REASONS,
  FlagEvaluationSchema,
  TERMINAL_REASONS,
  aggregateEvaluations,
  isFallbackEvaluation,
  isTerminalReason,
  type FlagEvaluation,
} from "./evaluations.js";

const baseEvaluation: FlagEvaluation = {
  id: "fev_eval000001",
  tenantId: "11111111-1111-1111-1111-111111111111",
  flagKey: "checkout.new_flow",
  flagId: "ff_newcheck01",
  flagVersion: "1.0.0",
  environment: "production",
  principalId: "22222222-2222-2222-2222-222222222222",
  sessionId: null,
  evaluatedAt: "2026-05-16T10:00:00.000Z",
  evaluationLatencyUs: 150,
  reason: "percentage_bucket_match",
  matchedRuleId: "ftr_rollout0001",
  matchedSegmentId: null,
  servedVariantKey: "treatment",
  servedValueJson: "true",
  killSwitchId: null,
  bucketingValueSha256: "a".repeat(64),
  requestId: null,
  correlationId: null,
  isSampled: true,
  errorCode: null,
  errorMessage: null,
};

describe("constants", () => {
  it("has 17 evaluation reasons", () => {
    expect(EVALUATION_REASONS).toHaveLength(17);
  });
  it("TERMINAL_REASONS includes default + error + kill", () => {
    expect(TERMINAL_REASONS.has("default_returned")).toBe(true);
    expect(TERMINAL_REASONS.has("kill_switch_active")).toBe(true);
    expect(TERMINAL_REASONS.has("error_returned_default")).toBe(true);
  });
});

describe("FlagEvaluationSchema", () => {
  it("accepts a percentage_bucket_match eval", () => {
    expect(() => FlagEvaluationSchema.parse(baseEvaluation)).not.toThrow();
  });

  it("rejects kill_switch_active without killSwitchId", () => {
    expect(() =>
      FlagEvaluationSchema.parse({
        ...baseEvaluation,
        reason: "kill_switch_active",
      }),
    ).toThrow(/killSwitchId/);
  });

  it("rejects segment_match without matchedSegmentId", () => {
    expect(() =>
      FlagEvaluationSchema.parse({
        ...baseEvaluation,
        reason: "segment_match",
        matchedRuleId: null,
      }),
    ).toThrow(/matchedSegmentId/);
  });

  it("rejects rule-match reason without matchedRuleId", () => {
    expect(() =>
      FlagEvaluationSchema.parse({
        ...baseEvaluation,
        matchedRuleId: null,
      }),
    ).toThrow(/matchedRuleId/);
  });

  it("rejects error_returned_default without errorCode + message", () => {
    expect(() =>
      FlagEvaluationSchema.parse({
        ...baseEvaluation,
        reason: "error_returned_default",
        matchedRuleId: null,
        servedVariantKey: null,
      }),
    ).toThrow(/errorCode/);
  });

  it("rejects flag_not_found with flagId set", () => {
    expect(() =>
      FlagEvaluationSchema.parse({
        ...baseEvaluation,
        reason: "flag_not_found",
        matchedRuleId: null,
        servedVariantKey: null,
      }),
    ).toThrow(/flag_not_found reason cannot have flagId/);
  });

  it("rejects invalid servedValueJson", () => {
    expect(() =>
      FlagEvaluationSchema.parse({
        ...baseEvaluation,
        servedValueJson: "{not valid",
      }),
    ).toThrow(/must be valid JSON/);
  });
});

describe("aggregateEvaluations", () => {
  it("returns zeros for empty input", () => {
    const a = aggregateEvaluations([]);
    expect(a.totalEvaluations).toBe(0);
    expect(a.errorRate).toBe(0);
  });

  it("counts by reason + variant", () => {
    const e1 = baseEvaluation;
    const e2: FlagEvaluation = {
      ...baseEvaluation,
      id: "fev_eval000002",
      servedVariantKey: "control",
      servedValueJson: "false",
    };
    const e3: FlagEvaluation = {
      ...baseEvaluation,
      id: "fev_eval000003",
      reason: "kill_switch_active",
      matchedRuleId: null,
      killSwitchId: "fks_kill00001",
      servedValueJson: "false",
      servedVariantKey: null,
    };
    const a = aggregateEvaluations([e1, e2, e3]);
    expect(a.totalEvaluations).toBe(3);
    expect(a.reasonCounts.percentage_bucket_match).toBe(2);
    expect(a.killSwitchHitCount).toBe(1);
    expect(a.variantCounts.treatment).toBe(1);
    expect(a.variantCounts.control).toBe(1);
  });

  it("computes p99 latency", () => {
    const evals: FlagEvaluation[] = [50, 100, 200, 500].map((us, i) => ({
      ...baseEvaluation,
      id: `fev_lat0000${i.toString().padStart(2, "0")}`,
      evaluationLatencyUs: us,
    }));
    const a = aggregateEvaluations(evals);
    expect(a.p99LatencyUs).toBe(500);
  });
});

describe("isTerminalReason / isFallbackEvaluation", () => {
  it("default_returned is terminal", () => {
    expect(isTerminalReason("default_returned")).toBe(true);
  });
  it("specific_principal_match is not terminal", () => {
    expect(isTerminalReason("specific_principal_match")).toBe(false);
  });
  it("isFallbackEvaluation true for default_returned", () => {
    expect(
      isFallbackEvaluation({
        ...baseEvaluation,
        reason: "default_returned",
        matchedRuleId: null,
        servedVariantKey: null,
      }),
    ).toBe(true);
  });
  it("isFallbackEvaluation false for percentage_bucket_match", () => {
    expect(isFallbackEvaluation(baseEvaluation)).toBe(false);
  });
});
