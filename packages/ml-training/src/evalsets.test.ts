import { describe, expect, it } from "vitest";
import {
  EVAL_TASK_KINDS,
  EvalExampleSchema,
  EvalSetSchema,
  SCORING_METRICS,
  exampleCountByTag,
  isEvalSetReleaseBlocker,
  regressionGuards,
  type EvalExample,
  type EvalSet,
} from "./evalsets.js";

const SHA = "a".repeat(64);

describe("constants", () => {
  it("EVAL_TASK_KINDS has 8 entries", () => {
    expect(EVAL_TASK_KINDS).toContain("manifest_proposal");
    expect(EVAL_TASK_KINDS).toContain("safety_refusal");
    expect(EVAL_TASK_KINDS).toContain("regression_replay");
  });

  it("SCORING_METRICS has 7 entries", () => {
    expect(SCORING_METRICS).toContain("exact_match");
    expect(SCORING_METRICS).toContain("rouge_l");
    expect(SCORING_METRICS).toContain("rubric_grade");
  });
});

describe("EvalExampleSchema", () => {
  const base: EvalExample = {
    id: "ex-1",
    prompt: "Generate a SQL query for…",
    expectedOutput: "SELECT * FROM x",
    expectedOutputSha256: SHA,
    metric: "exact_match",
    passThreshold: 1,
    tags: ["sql", "select"],
    isGoldenRegressionGuard: true,
  };

  it("accepts a valid example", () => {
    expect(() => EvalExampleSchema.parse(base)).not.toThrow();
  });

  it("rejects binary_correctness with threshold < 1", () => {
    expect(() =>
      EvalExampleSchema.parse({
        ...base,
        metric: "binary_correctness",
        passThreshold: 0.8,
      }),
    ).toThrow(/binary_correctness.*passThreshold=1/);
  });

  it("rejects exact_match with threshold < 1", () => {
    expect(() =>
      EvalExampleSchema.parse({ ...base, passThreshold: 0.5 }),
    ).toThrow(/exact_match.*passThreshold=1/);
  });

  it("rejects duplicate tags", () => {
    expect(() =>
      EvalExampleSchema.parse({ ...base, tags: ["sql", "sql"] }),
    ).toThrow(/duplicate tag/);
  });

  it("rejects malformed example id", () => {
    expect(() =>
      EvalExampleSchema.parse({ ...base, id: "EX-1" }),
    ).toThrow();
  });
});

describe("EvalSetSchema", () => {
  const example = (id: string, metric: EvalExample["metric"] = "exact_match"): EvalExample => ({
    id,
    prompt: "p",
    expectedOutput: "o",
    expectedOutputSha256: SHA,
    metric,
    passThreshold: 1,
    tags: [],
    isGoldenRegressionGuard: false,
  });

  const base: EvalSet = {
    id: "eval_sql-001",
    label: "SQL Generation v1",
    description: "Basic SQL generation",
    taskKind: "sql_generation",
    examples: [example("ex-1"), example("ex-2")],
    frozenAt: "2026-05-14T10:00:00Z",
    frozenBy: "u-1",
    frozenSha256: SHA,
    requiredPassRate: 0.95,
    blocksProductionPromotion: false,
    version: "1.0.0",
    retiredAt: null,
  };

  it("accepts a valid eval set", () => {
    expect(() => EvalSetSchema.parse(base)).not.toThrow();
  });

  it("rejects duplicate example ids", () => {
    expect(() =>
      EvalSetSchema.parse({
        ...base,
        examples: [example("dup"), example("dup")],
      }),
    ).toThrow(/duplicate example id/);
  });

  it("rejects safety_refusal without blocksProductionPromotion=true", () => {
    expect(() =>
      EvalSetSchema.parse({
        ...base,
        taskKind: "safety_refusal",
        requiredPassRate: 1,
      }),
    ).toThrow(/safety_refusal.*blocksProductionPromotion=true/);
  });

  it("rejects safety_refusal with requiredPassRate < 1", () => {
    expect(() =>
      EvalSetSchema.parse({
        ...base,
        taskKind: "safety_refusal",
        blocksProductionPromotion: true,
        requiredPassRate: 0.99,
      }),
    ).toThrow(/100% pass rate/);
  });

  it("rejects permission_decision without 100% pass rate", () => {
    expect(() =>
      EvalSetSchema.parse({
        ...base,
        taskKind: "permission_decision",
        blocksProductionPromotion: true,
        requiredPassRate: 0.95,
      }),
    ).toThrow(/100% pass rate/);
  });

  it("rejects retired without reason + supersededBy", () => {
    expect(() =>
      EvalSetSchema.parse({
        ...base,
        retiredAt: "2026-06-01T00:00:00Z",
      }),
    ).toThrow(/retiredReason/);
  });
});

describe("helpers", () => {
  const example = (id: string, guard: boolean = false, tags: string[] = []): EvalExample => ({
    id,
    prompt: "p",
    expectedOutput: "o",
    expectedOutputSha256: SHA,
    metric: "exact_match",
    passThreshold: 1,
    tags,
    isGoldenRegressionGuard: guard,
  });

  const set: EvalSet = {
    id: "eval_test-001",
    label: "x",
    description: "x",
    taskKind: "sql_generation",
    examples: [
      example("ex-1", true, ["sql"]),
      example("ex-2", false, ["sql", "select"]),
      example("ex-3", true, ["update"]),
    ],
    frozenAt: "2026-05-14T10:00:00Z",
    frozenBy: "u-1",
    frozenSha256: SHA,
    requiredPassRate: 1,
    blocksProductionPromotion: true,
    version: "1.0.0",
    retiredAt: null,
  };

  it("regressionGuards filters guards", () => {
    expect(regressionGuards(set).map((e) => e.id)).toEqual(["ex-1", "ex-3"]);
  });

  it("exampleCountByTag counts tagged examples", () => {
    expect(exampleCountByTag(set, "sql")).toBe(2);
    expect(exampleCountByTag(set, "update")).toBe(1);
  });

  it("isEvalSetReleaseBlocker true when blocking + not retired", () => {
    expect(isEvalSetReleaseBlocker(set)).toBe(true);
  });

  it("isEvalSetReleaseBlocker false after retirement", () => {
    expect(
      isEvalSetReleaseBlocker({
        ...set,
        retiredAt: "2026-06-01T00:00:00Z",
        retiredReason: "x",
        supersededBy: "eval_test-002",
      }),
    ).toBe(false);
  });
});
