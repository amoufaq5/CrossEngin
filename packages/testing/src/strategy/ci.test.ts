import { describe, expect, it } from "vitest";
import {
  CI_PIPELINE_BUDGET_MINUTES,
  CiJobSchema,
  CiPipelineSchema,
  criticalPathMinutes,
  FAST_CI_BUDGET_MINUTES,
  fitsBudget,
  kindsCovered,
  topologicalOrder,
} from "./ci.js";

describe("CI budget constants", () => {
  it("ADR-0023 targets: 10 min PR / 20 min main", () => {
    expect(FAST_CI_BUDGET_MINUTES).toBe(10);
    expect(CI_PIPELINE_BUDGET_MINUTES).toBe(20);
  });
});

describe("CiJobSchema", () => {
  it("parses a unit-test job", () => {
    expect(() =>
      CiJobSchema.parse({
        id: "unit",
        runs: ["unit", "property", "snapshot"],
        triggers: ["pull_request"],
        targetMinutes: 3,
      }),
    ).not.toThrow();
  });

  it("rejects self-dependency", () => {
    expect(() =>
      CiJobSchema.parse({
        id: "x",
        runs: ["unit"],
        triggers: ["pull_request"],
        targetMinutes: 1,
        dependsOn: ["x"],
      }),
    ).toThrow(/cannot depend on itself/);
  });
});

describe("CiPipelineSchema", () => {
  const pipeline = CiPipelineSchema.parse({
    name: "ci",
    jobs: [
      { id: "install", runs: ["unit"], triggers: ["pull_request"], targetMinutes: 1 },
      {
        id: "lint",
        runs: ["unit"],
        triggers: ["pull_request"],
        targetMinutes: 2,
        dependsOn: ["install"],
      },
      {
        id: "unit",
        runs: ["unit", "property", "snapshot"],
        triggers: ["pull_request"],
        targetMinutes: 3,
        dependsOn: ["install"],
      },
      {
        id: "integration",
        runs: ["integration"],
        triggers: ["pull_request"],
        targetMinutes: 5,
        dependsOn: ["install"],
      },
      {
        id: "e2e",
        runs: ["e2e", "accessibility"],
        triggers: ["pull_request"],
        targetMinutes: 4,
        dependsOn: ["unit", "integration"],
      },
    ],
  });

  it("topologicalOrder respects dependsOn", () => {
    const order = topologicalOrder(pipeline);
    const installIdx = order.indexOf("install");
    const unitIdx = order.indexOf("unit");
    const e2eIdx = order.indexOf("e2e");
    expect(installIdx).toBeLessThan(unitIdx);
    expect(unitIdx).toBeLessThan(e2eIdx);
  });

  it("criticalPathMinutes computes total along the longest path", () => {
    expect(criticalPathMinutes(pipeline)).toBe(1 + 5 + 4);
  });

  it("fitsBudget returns true for the documented 10-minute PR budget", () => {
    expect(fitsBudget(pipeline, "pull_request")).toBe(true);
  });

  it("fitsBudget returns false when critical path > budget", () => {
    const slow = CiPipelineSchema.parse({
      ...pipeline,
      jobs: pipeline.jobs.map((j) => (j.id === "e2e" ? { ...j, targetMinutes: 30 } : j)),
    });
    expect(fitsBudget(slow, "pull_request")).toBe(false);
  });

  it("kindsCovered returns the set of test kinds the pipeline exercises", () => {
    const covered = kindsCovered(pipeline);
    expect(covered.has("unit")).toBe(true);
    expect(covered.has("integration")).toBe(true);
    expect(covered.has("e2e")).toBe(true);
    expect(covered.has("eval")).toBe(false);
  });

  it("rejects dependsOn referencing an unknown job", () => {
    expect(() =>
      CiPipelineSchema.parse({
        name: "broken",
        jobs: [
          {
            id: "x",
            runs: ["unit"],
            triggers: ["pull_request"],
            targetMinutes: 1,
            dependsOn: ["nonexistent"],
          },
        ],
      }),
    ).toThrow(/unknown job 'nonexistent'/);
  });
});
