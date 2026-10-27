import { describe, expect, it } from "vitest";
import {
  CI_MEASURED_STEP_SECONDS,
  CI_PIPELINE,
  CI_PIPELINE_BUDGET_MINUTES,
  CiJobSchema,
  CiPipelineSchema,
  CiStepSchema,
  criticalPathMinutes,
  FAST_CI_BUDGET_MINUTES,
  fitsBudget,
  kindsCovered,
  measuredStepDisagreements,
  measuredSuiteSeconds,
  topologicalOrder,
} from "./ci.js";

describe("CI budget constants", () => {
  it("ADR-0023 targets: 10 min PR / 20 min main", () => {
    expect(FAST_CI_BUDGET_MINUTES).toBe(10);
    expect(CI_PIPELINE_BUDGET_MINUTES).toBe(20);
  });
});

describe("CiStepSchema", () => {
  it("parses an action and defaults its inputs to none", () => {
    const step = CiStepSchema.parse({ kind: "action", uses: "actions/checkout@v4" });
    expect(step).toEqual({ kind: "action", uses: "actions/checkout@v4", with: {} });
  });

  it("parses a command", () => {
    expect(CiStepSchema.parse({ kind: "command", run: "pnpm -r test" })).toEqual({
      kind: "command",
      run: "pnpm -r test",
    });
  });

  it("rejects a step that is neither", () => {
    // The discriminator is what lets `renderDeclaredStep` be total; without it a step carrying
    // both a `uses` and a `run` would be representable and the fence would compare one of them.
    expect(() => CiStepSchema.parse({ uses: "actions/checkout@v4" })).toThrow();
    expect(() => CiStepSchema.parse({ kind: "script", run: "x" })).toThrow();
  });

  it("has exactly the two members, read off the schema and not off a parallel array", () => {
    // A `CI_STEP_KINDS` array shipped here briefly and was deleted: its only reader was this
    // assertion comparing it with its own literal, while the schema below spells its members with
    // `z.literal(...)` and never read it — so a third member added to one and not the other was not
    // a compile error. Asserting the *schema's* own options is the version that fences something: a
    // third member fails here, in the one file that would then have to consider `renderDeclaredStep`.
    expect(CiStepSchema.options.map((o) => o.shape.kind.value)).toEqual(["action", "command"]);
  });
});

describe("the measurement the budget is derived from", () => {
  it("has a figure for every declared command step, and none for a step nobody runs", () => {
    // Both directions, because a one-way comparison is what ADR-0335's original defect was made of
    // — and the direction that matters is a *new* sweep step with no figure, which would otherwise
    // let the budget go on describing a shorter suite than the one that runs.
    expect(measuredStepDisagreements(CI_PIPELINE)).toEqual([]);
  });

  it("is non-vacuous: the fence fires when a step is declared without a measurement", () => {
    const grown = CiPipelineSchema.parse({
      ...CI_PIPELINE,
      jobs: CI_PIPELINE.jobs.map((j) => ({
        ...j,
        steps: [...j.steps, { kind: "command", run: "pnpm -r smoke" }],
      })),
    });
    expect(measuredStepDisagreements(grown)).toEqual([
      "no figure in CI_MEASURED_STEP_SECONDS for declared command step 'pnpm -r smoke'",
    ]);
  });

  it("excludes install as the null claim rather than by omitting the key", () => {
    // ADR-0331's distinction, and it is load-bearing here: an omitted key would be reported by
    // `measuredStepDisagreements` as an unmeasured step, so `null` is what lets *deliberately
    // unmeasured* be a thing the declaration can say. The budget therefore bounds the suite and
    // makes no claim about a pull request's wall clock.
    //
    // Deliberately no `toBeCloseTo(526.7)` beside this. One was here for a commit and it is
    // arithmetic over the four literals above compared with a fifth literal — so it fenced
    // nothing, went stale on any re-measurement, and made the mutation that proves the *budget*
    // fires report a third unrelated failure. The one failure mode it could have caught, `?? 0`
    // dropped so the sum is `NaN`, is caught earlier and louder: `Math.ceil(NaN)` fails
    // `CiJobSchema`'s `z.number().int()` at module load.
    expect(CI_MEASURED_STEP_SECONDS["pnpm install --frozen-lockfile"]).toBeNull();
    expect(Object.keys(CI_MEASURED_STEP_SECONDS)).toContain("pnpm install --frozen-lockfile");
  });

  it("derives the declared ceiling rather than restating it", () => {
    // The literal `targetMinutes: 9` this replaced was the declaration compared against itself by
    // `criticalPathMinutes` — one job, so the critical path *is* that number.
    expect(CI_PIPELINE.jobs.map((j) => j.targetMinutes)).toEqual([
      Math.ceil(measuredSuiteSeconds() / 60),
    ]);
  });

  it("crosses the budget at a re-measured 601 s, which is the event the check fires on", () => {
    // Named rather than implied: 600 s ceilings to 10 and fits; 601 ceilings to 11 and does not.
    // So the slack is 73.3 s of *re-measured* suite, and nothing here can see an existing step
    // getting slower — that is the runner's `timeout-minutes:`, a follow-up with its refutation in
    // `CI_PIPELINE`'s doc comment.
    expect(Math.ceil(600 / 60)).toBeLessThanOrEqual(FAST_CI_BUDGET_MINUTES);
    expect(Math.ceil(601 / 60)).toBeGreaterThan(FAST_CI_BUDGET_MINUTES);
  });
});

describe("CiJobSchema", () => {
  it("defaults the two fields ADR-0382 added, so every prior declaration still parses", () => {
    // `steps` and `runsOn` arrived with `CI_PIPELINE`; defaulting them is what kept the nine tests
    // in this file — and any other pipeline declaring only budgets and a graph — unchanged.
    const job = CiJobSchema.parse({
      id: "unit",
      runs: ["unit"],
      triggers: ["pull_request"],
      targetMinutes: 3,
    });
    expect(job.steps).toEqual([]);
    expect(job.runsOn).toBe("ubuntu-latest");
  });

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
      jobs: pipeline.jobs.map((j) =>
        j.id === "e2e" ? { ...j, targetMinutes: 30 } : j,
      ),
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
