import { describe, expect, it } from "vitest";
import {
  ONBOARDING_PATHS,
  ONBOARDING_STAGES,
  OnboardingRunSchema,
  STAGE_ORDER,
  StageRecordSchema,
  isReadyForGoLive,
  nextStage,
  onboardingProgressPercent,
  stagesRemaining,
  type OnboardingRun,
  type StageRecord,
} from "./onboarding.js";

describe("constants", () => {
  it("ONBOARDING_STAGES has 7 entries", () => {
    expect(ONBOARDING_STAGES).toHaveLength(7);
    expect(ONBOARDING_STAGES[0]).toBe("workspace_setup");
    expect(ONBOARDING_STAGES[ONBOARDING_STAGES.length - 1]).toBe("go_live");
  });

  it("ONBOARDING_PATHS has 3 entries", () => {
    expect(ONBOARDING_PATHS).toEqual([
      "bring_my_data",
      "vertical_template",
      "blank_workspace",
    ]);
  });

  it("STAGE_ORDER is monotonic", () => {
    for (let i = 1; i < ONBOARDING_STAGES.length; i++) {
      const prev = ONBOARDING_STAGES[i - 1]!;
      const curr = ONBOARDING_STAGES[i]!;
      expect(STAGE_ORDER[curr]).toBeGreaterThan(STAGE_ORDER[prev]);
    }
  });
});

describe("StageRecordSchema", () => {
  const stage = (stage: StageRecord["stage"], status: StageRecord["status"]): StageRecord => ({
    stage,
    status,
    startedAt: status === "pending" ? null : "2026-05-14T10:00:00Z",
    completedAt: status === "completed" ? "2026-05-14T10:30:00Z" : null,
    completedBy: status === "completed" ? "u-1" : null,
  });

  it("accepts a completed stage", () => {
    expect(() => StageRecordSchema.parse(stage("workspace_setup", "completed"))).not.toThrow();
  });

  it("rejects in_progress without startedAt", () => {
    expect(() =>
      StageRecordSchema.parse({
        stage: "schema_design",
        status: "in_progress",
        startedAt: null,
        completedAt: null,
        completedBy: null,
      }),
    ).toThrow(/startedAt/);
  });

  it("rejects completed without completedBy", () => {
    expect(() =>
      StageRecordSchema.parse({
        stage: "schema_design",
        status: "completed",
        startedAt: "2026-05-14T10:00:00Z",
        completedAt: "2026-05-14T10:30:00Z",
        completedBy: null,
      }),
    ).toThrow(/completedBy/);
  });

  it("rejects skipping a non-skippable stage", () => {
    expect(() =>
      StageRecordSchema.parse({
        stage: "workspace_setup",
        status: "skipped",
        startedAt: null,
        completedAt: null,
        completedBy: null,
        skippedReason: "x",
      }),
    ).toThrow(/not skippable/);
  });

  it("accepts skipping user_invites with reason", () => {
    expect(() =>
      StageRecordSchema.parse({
        stage: "user_invites",
        status: "skipped",
        startedAt: null,
        completedAt: null,
        completedBy: null,
        skippedReason: "solo user",
      }),
    ).not.toThrow();
  });

  it("rejects skipped without skippedReason", () => {
    expect(() =>
      StageRecordSchema.parse({
        stage: "user_invites",
        status: "skipped",
        startedAt: null,
        completedAt: null,
        completedBy: null,
      }),
    ).toThrow(/skippedReason/);
  });

  it("rejects failed without failureReason", () => {
    expect(() =>
      StageRecordSchema.parse({
        stage: "first_import",
        status: "failed",
        startedAt: "2026-05-14T10:00:00Z",
        completedAt: null,
        completedBy: null,
      }),
    ).toThrow(/failureReason/);
  });
});

describe("OnboardingRunSchema", () => {
  const completed = (stage: StageRecord["stage"]): StageRecord => ({
    stage,
    status: "completed",
    startedAt: "2026-05-14T10:00:00Z",
    completedAt: "2026-05-14T10:30:00Z",
    completedBy: "u-1",
  });
  const pending = (stage: StageRecord["stage"]): StageRecord => ({
    stage,
    status: "pending",
    startedAt: null,
    completedAt: null,
    completedBy: null,
  });

  const base: OnboardingRun = {
    id: "ob-1",
    tenantId: "t-1",
    path: "blank_workspace",
    currentStage: "schema_design",
    stages: [
      completed("workspace_setup"),
      completed("plan_selection"),
      {
        stage: "schema_design",
        status: "in_progress",
        startedAt: "2026-05-14T11:00:00Z",
        completedAt: null,
        completedBy: null,
      },
      pending("user_invites"),
      pending("first_import"),
      pending("validate"),
      pending("go_live"),
    ],
    startedAt: "2026-05-14T09:00:00Z",
    startedBy: "u-1",
    completedAt: null,
    abandonedAt: null,
  };

  it("accepts a valid in-flight run", () => {
    expect(() => OnboardingRunSchema.parse(base)).not.toThrow();
  });

  it("rejects duplicate stage entries", () => {
    expect(() =>
      OnboardingRunSchema.parse({
        ...base,
        stages: [...base.stages, base.stages[0]!],
      }),
    ).toThrow(/duplicate stage/);
  });

  it("rejects currentStage not in stages list", () => {
    expect(() =>
      OnboardingRunSchema.parse({
        ...base,
        stages: base.stages.filter((s) => s.stage !== "schema_design"),
      }),
    ).toThrow(/currentStage 'schema_design' is not in stages/);
  });

  it("rejects advancing past an incomplete prior stage", () => {
    const bad = {
      ...base,
      stages: [
        pending("workspace_setup"),
        completed("plan_selection"),
        completed("schema_design"),
        pending("user_invites"),
        pending("first_import"),
        pending("validate"),
        pending("go_live"),
      ],
      currentStage: "schema_design" as const,
    };
    expect(() => OnboardingRunSchema.parse(bad)).toThrow(/prior stage.*must be completed/);
  });

  it("rejects vertical_template path without sourcePackId", () => {
    expect(() =>
      OnboardingRunSchema.parse({
        ...base,
        path: "vertical_template",
      }),
    ).toThrow(/sourcePackId/);
  });

  it("rejects bring_my_data with import in progress but no sourceImportId", () => {
    expect(() =>
      OnboardingRunSchema.parse({
        ...base,
        path: "bring_my_data",
        stages: [
          completed("workspace_setup"),
          completed("plan_selection"),
          completed("schema_design"),
          completed("user_invites"),
          {
            stage: "first_import",
            status: "in_progress",
            startedAt: "2026-05-14T12:00:00Z",
            completedAt: null,
            completedBy: null,
          },
          pending("validate"),
          pending("go_live"),
        ],
        currentStage: "first_import",
      }),
    ).toThrow(/sourceImportId/);
  });

  it("rejects completedAt when not at go_live", () => {
    expect(() =>
      OnboardingRunSchema.parse({
        ...base,
        completedAt: "2026-05-14T15:00:00Z",
      }),
    ).toThrow(/currentStage='go_live'/);
  });

  it("rejects abandonedAt without abandonedReason", () => {
    expect(() =>
      OnboardingRunSchema.parse({
        ...base,
        abandonedAt: "2026-05-14T15:00:00Z",
      }),
    ).toThrow(/abandonedReason/);
  });

  it("rejects abandonedAt + completedAt together", () => {
    expect(() =>
      OnboardingRunSchema.parse({
        ...base,
        stages: ONBOARDING_STAGES.map((s) => completed(s)),
        currentStage: "go_live",
        completedAt: "2026-05-14T15:00:00Z",
        abandonedAt: "2026-05-14T16:00:00Z",
        abandonedReason: "x",
      }),
    ).toThrow(/mutually exclusive/);
  });
});

describe("helpers", () => {
  it("nextStage walks forward", () => {
    expect(nextStage("workspace_setup")).toBe("plan_selection");
    expect(nextStage("validate")).toBe("go_live");
    expect(nextStage("go_live")).toBeNull();
  });

  const completed = (stage: StageRecord["stage"]): StageRecord => ({
    stage,
    status: "completed",
    startedAt: "2026-05-14T10:00:00Z",
    completedAt: "2026-05-14T10:30:00Z",
    completedBy: "u-1",
  });
  const pending = (stage: StageRecord["stage"]): StageRecord => ({
    stage,
    status: "pending",
    startedAt: null,
    completedAt: null,
    completedBy: null,
  });

  const partial: OnboardingRun = {
    id: "ob-1",
    tenantId: "t-1",
    path: "blank_workspace",
    currentStage: "schema_design",
    stages: [
      completed("workspace_setup"),
      completed("plan_selection"),
      pending("schema_design"),
      pending("user_invites"),
      pending("first_import"),
      pending("validate"),
      pending("go_live"),
    ],
    startedAt: "2026-05-14T09:00:00Z",
    startedBy: "u-1",
    completedAt: null,
    abandonedAt: null,
  };

  it("stagesRemaining excludes completed", () => {
    expect(stagesRemaining(partial)).toEqual([
      "schema_design",
      "user_invites",
      "first_import",
      "validate",
      "go_live",
    ]);
  });

  it("onboardingProgressPercent reflects completion", () => {
    expect(onboardingProgressPercent(partial)).toBe(Math.round((2 / 7) * 100));
  });

  it("isReadyForGoLive false when validate isn't complete", () => {
    expect(isReadyForGoLive(partial)).toBe(false);
  });

  it("isReadyForGoLive true when all gating stages complete", () => {
    const ready: OnboardingRun = {
      ...partial,
      stages: [
        completed("workspace_setup"),
        completed("plan_selection"),
        completed("schema_design"),
        pending("user_invites"),
        pending("first_import"),
        completed("validate"),
        pending("go_live"),
      ],
      currentStage: "go_live",
    };
    expect(isReadyForGoLive(ready)).toBe(true);
  });
});
