import { describe, expect, it } from "vitest";
import {
  EVAL_VERDICTS,
  EXAMPLE_OUTCOMES,
  EvaluationRunSchema,
  ExampleResultSchema,
  blocksPromotion,
  failedExampleIds,
  isRegression,
  passRateDelta,
  type EvaluationRun,
} from "./evaluations.js";

const SHA = "a".repeat(64);

describe("constants", () => {
  it("EVAL_VERDICTS has 4 entries", () => {
    expect(EVAL_VERDICTS).toEqual(["passed", "failed", "regressed", "improved"]);
  });

  it("EXAMPLE_OUTCOMES has 4 entries", () => {
    expect(EXAMPLE_OUTCOMES).toEqual(["pass", "fail", "error", "skipped"]);
  });
});

describe("ExampleResultSchema", () => {
  it("accepts a passing result", () => {
    expect(() =>
      ExampleResultSchema.parse({
        exampleId: "ex-1",
        outcome: "pass",
        score: 1,
        actualOutputSha256: SHA,
        latencyMs: 250,
      }),
    ).not.toThrow();
  });

  it("rejects error without errorMessage", () => {
    expect(() =>
      ExampleResultSchema.parse({
        exampleId: "ex-1",
        outcome: "error",
        score: null,
        actualOutputSha256: null,
        latencyMs: 0,
      }),
    ).toThrow(/errorMessage/);
  });

  it("rejects pass without score", () => {
    expect(() =>
      ExampleResultSchema.parse({
        exampleId: "ex-1",
        outcome: "pass",
        score: null,
        actualOutputSha256: SHA,
        latencyMs: 100,
      }),
    ).toThrow(/numeric score/);
  });

  it("rejects pass without actualOutputSha256", () => {
    expect(() =>
      ExampleResultSchema.parse({
        exampleId: "ex-1",
        outcome: "pass",
        score: 1,
        actualOutputSha256: null,
        latencyMs: 100,
      }),
    ).toThrow(/actualOutputSha256/);
  });

  it("rejects skipped with score", () => {
    expect(() =>
      ExampleResultSchema.parse({
        exampleId: "ex-1",
        outcome: "skipped",
        score: 1,
        actualOutputSha256: null,
        latencyMs: 0,
      }),
    ).toThrow(/skipped.*score=null/);
  });
});

describe("EvaluationRunSchema", () => {
  const base: EvaluationRun = {
    id: "evalrun_abc12345",
    evalSetId: "eval_sql-001",
    evalSetSha256: SHA,
    modelId: "mdl_sql-001",
    modelVersion: "1.0.0",
    baselineRunId: null,
    startedAt: "2026-05-14T10:00:00Z",
    completedAt: "2026-05-14T10:05:00Z",
    durationSeconds: 300,
    examplesEvaluated: 100,
    examplesPassed: 95,
    examplesFailed: 4,
    examplesErrored: 1,
    examplesSkipped: 0,
    passRate: 0.95,
    requiredPassRate: 0.9,
    verdict: "passed",
    totalCostUsd: 5,
    p50LatencyMs: 200,
    p99LatencyMs: 500,
    results: [],
    blocksPromotion: false,
    triggeredBy: "u-1",
    trigger: "manual",
  };

  it("accepts a valid passed run", () => {
    expect(() => EvaluationRunSchema.parse(base)).not.toThrow();
  });

  it("rejects counter sum mismatch", () => {
    expect(() =>
      EvaluationRunSchema.parse({ ...base, examplesEvaluated: 200 }),
    ).toThrow(/must equal examplesEvaluated/);
  });

  it("rejects passRate not matching passed/evaluated", () => {
    expect(() =>
      EvaluationRunSchema.parse({ ...base, passRate: 0.5 }),
    ).toThrow(/does not match/);
  });

  it("rejects p99 < p50", () => {
    expect(() =>
      EvaluationRunSchema.parse({
        ...base,
        p50LatencyMs: 1000,
        p99LatencyMs: 500,
      }),
    ).toThrow(/p99LatencyMs must be >= p50LatencyMs/);
  });

  it("rejects regressed without baselineRunId", () => {
    expect(() =>
      EvaluationRunSchema.parse({
        ...base,
        verdict: "regressed",
        examplesPassed: 80,
        examplesFailed: 20,
        passRate: 0.8,
        requiredPassRate: 0.9,
        blocksPromotion: true,
      }),
    ).toThrow(/baselineRunId/);
  });

  it("rejects verdict='passed' with passRate < required", () => {
    expect(() =>
      EvaluationRunSchema.parse({
        ...base,
        examplesPassed: 80,
        examplesFailed: 20,
        passRate: 0.8,
        requiredPassRate: 0.9,
      }),
    ).toThrow(/verdict='passed' requires passRate/);
  });

  it("rejects verdict='failed' with passRate >= required", () => {
    expect(() =>
      EvaluationRunSchema.parse({
        ...base,
        verdict: "failed",
        blocksPromotion: true,
      }),
    ).toThrow(/verdict='failed' requires passRate/);
  });

  it("rejects regressed/failed without blocksPromotion=true", () => {
    expect(() =>
      EvaluationRunSchema.parse({
        ...base,
        examplesPassed: 80,
        examplesFailed: 20,
        passRate: 0.8,
        verdict: "failed",
        blocksPromotion: false,
      }),
    ).toThrow(/blocksPromotion=true/);
  });

  it("rejects completedAt without durationSeconds", () => {
    expect(() =>
      EvaluationRunSchema.parse({ ...base, durationSeconds: null }),
    ).toThrow(/durationSeconds/);
  });
});

describe("helpers", () => {
  const base: EvaluationRun = {
    id: "evalrun_a",
    evalSetId: "eval_a",
    evalSetSha256: SHA,
    modelId: "m",
    modelVersion: "1.0.0",
    baselineRunId: null,
    startedAt: "2026-05-14T10:00:00Z",
    completedAt: "2026-05-14T10:05:00Z",
    durationSeconds: 300,
    examplesEvaluated: 100,
    examplesPassed: 90,
    examplesFailed: 10,
    examplesErrored: 0,
    examplesSkipped: 0,
    passRate: 0.9,
    requiredPassRate: 0.8,
    verdict: "passed",
    totalCostUsd: 5,
    p50LatencyMs: 200,
    p99LatencyMs: 500,
    results: [
      {
        exampleId: "ex-1",
        outcome: "pass",
        score: 1,
        actualOutputSha256: SHA,
        latencyMs: 100,
        costUsd: 0.01,
      },
      {
        exampleId: "ex-2",
        outcome: "fail",
        score: 0,
        actualOutputSha256: SHA,
        latencyMs: 100,
        costUsd: 0.01,
      },
    ],
    blocksPromotion: false,
    triggeredBy: "u-1",
    trigger: "manual",
  };

  it("isRegression compares pass rate vs baseline", () => {
    const baseline: EvaluationRun = { ...base, id: "evalrun_b", passRate: 0.95, examplesPassed: 95, examplesFailed: 5 };
    expect(isRegression(base, baseline)).toBe(true);
  });

  it("isRegression false for different eval set", () => {
    const other: EvaluationRun = { ...base, id: "evalrun_b", evalSetId: "eval_b", passRate: 0.95, examplesPassed: 95, examplesFailed: 5 };
    expect(isRegression(base, other)).toBe(false);
  });

  it("passRateDelta computes signed delta", () => {
    const baseline: EvaluationRun = { ...base, id: "evalrun_b", passRate: 0.85, examplesPassed: 85, examplesFailed: 15 };
    expect(passRateDelta(base, baseline)).toBeCloseTo(0.05);
  });

  it("blocksPromotion false when verdict=passed", () => {
    expect(blocksPromotion(base)).toBe(false);
  });

  it("blocksPromotion true when failed + blocks=true", () => {
    expect(
      blocksPromotion({ ...base, verdict: "failed", blocksPromotion: true, examplesPassed: 50, examplesFailed: 50, passRate: 0.5 }),
    ).toBe(true);
  });

  it("failedExampleIds returns failed + errored ids", () => {
    expect(failedExampleIds(base)).toEqual(["ex-2"]);
  });
});
