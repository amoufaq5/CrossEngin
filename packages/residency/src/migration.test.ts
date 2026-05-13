import { describe, expect, it } from "vitest";
import {
  buildMigrationPlan,
  isMigrationComplete,
  MIGRATION_STEPS,
  nextPendingStep,
  RegionMigrationPlanSchema,
} from "./migration.js";

const now = "2026-05-13T10:00:00.000Z";

describe("buildMigrationPlan", () => {
  it("produces a 7-step plan in canonical order", () => {
    const plan = buildMigrationPlan({
      tenantId: "t_1",
      sourceRegion: "eu-central",
      targetRegion: "us-east",
      triggeredBy: "u_admin",
      triggerReason: "HIPAA contract signed",
      estimatedBytes: 1024 * 1024 * 1024,
      createdAt: now,
    });
    expect(plan.steps).toHaveLength(MIGRATION_STEPS.length);
    plan.steps.forEach((s, i) => {
      expect(s.step).toBe(MIGRATION_STEPS[i]);
      expect(s.status).toBe("pending");
    });
  });

  it("estimates ~1 min per GB for offline migration", () => {
    const plan = buildMigrationPlan({
      tenantId: "t_1",
      sourceRegion: "eu-central",
      targetRegion: "us-east",
      triggeredBy: "u",
      triggerReason: "x",
      estimatedBytes: 5 * 1024 * 1024 * 1024,
      createdAt: now,
    });
    expect(plan.estimatedDowntimeSeconds).toBe(5 * 60);
  });

  it("live mode estimates a flat 60s cutover", () => {
    const plan = buildMigrationPlan({
      tenantId: "t_1",
      sourceRegion: "eu-central",
      targetRegion: "us-east",
      mode: "live",
      triggeredBy: "u",
      triggerReason: "x",
      estimatedBytes: 100 * 1024 * 1024 * 1024,
      createdAt: now,
    });
    expect(plan.estimatedDowntimeSeconds).toBe(60);
  });

  it("rejects same-region migration", () => {
    expect(() =>
      buildMigrationPlan({
        tenantId: "t_1",
        sourceRegion: "eu-central",
        targetRegion: "eu-central",
        triggeredBy: "u",
        triggerReason: "x",
        estimatedBytes: 1,
        createdAt: now,
      }),
    ).toThrow(/targetRegion must differ/);
  });
});

describe("RegionMigrationPlanSchema", () => {
  it("rejects out-of-order steps", () => {
    const plan = buildMigrationPlan({
      tenantId: "t_1",
      sourceRegion: "eu-central",
      targetRegion: "us-east",
      triggeredBy: "u",
      triggerReason: "x",
      estimatedBytes: 1,
      createdAt: now,
    });
    const reordered = {
      ...plan,
      steps: [...plan.steps].reverse(),
    };
    expect(() => RegionMigrationPlanSchema.parse(reordered)).toThrow(/must be/);
  });
});

describe("nextPendingStep", () => {
  const plan = buildMigrationPlan({
    tenantId: "t_1",
    sourceRegion: "eu-central",
    targetRegion: "us-east",
    triggeredBy: "u",
    triggerReason: "x",
    estimatedBytes: 1,
    createdAt: now,
  });

  it("returns the first step on a fresh plan", () => {
    expect(nextPendingStep(plan)).toBe(MIGRATION_STEPS[0]);
  });

  it("advances after completing earlier steps", () => {
    const advanced = {
      ...plan,
      steps: plan.steps.map((s, i) =>
        i < 3 ? { ...s, status: "completed" as const } : s,
      ),
    };
    expect(nextPendingStep(advanced)).toBe(MIGRATION_STEPS[3]);
  });

  it("returns null when every step is completed or skipped", () => {
    const done = {
      ...plan,
      steps: plan.steps.map((s) => ({ ...s, status: "completed" as const })),
    };
    expect(nextPendingStep(done)).toBeNull();
    expect(isMigrationComplete(done)).toBe(true);
  });
});
