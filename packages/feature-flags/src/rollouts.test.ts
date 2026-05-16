import { describe, expect, it } from "vitest";
import {
  ROLLOUT_RAMP_STRATEGIES,
  ROLLOUT_STAGES,
  ROLLOUT_STAGE_PERCENTAGES,
  ROLLOUT_STAGE_TRANSITIONS,
  RolloutPlanSchema,
  canTransitionStage,
  computeCurrentPercentage,
  isInRollout,
  isObservationWindowSatisfied,
  nextScheduledStage,
  type RolloutPlan,
} from "./rollouts.js";

const basePlan: RolloutPlan = {
  id: "fro_checkout01",
  tenantId: null,
  flagId: "ff_newcheck01",
  rampStrategy: "manual",
  bucketingKey: "tenant_id",
  salt: "checkout-rollout-2026",
  currentStage: "ramping_10pct",
  schedule: [],
  autoAdvanceOnSuccessfulObservation: false,
  blockingMetricSloIds: [],
  pausedAt: null,
  pausedByUserId: null,
  pausedReason: null,
  rolledBackAt: null,
  rolledBackByUserId: null,
  rolledBackReason: null,
  createdAt: "2026-05-15T10:00:00.000Z",
  createdBy: "22222222-2222-2222-2222-222222222222",
  lastStageTransitionAt: "2026-05-16T10:00:00.000Z",
};

describe("constants", () => {
  it("has 9 rollout stages", () => {
    expect(ROLLOUT_STAGES).toHaveLength(9);
  });
  it("ramping_10pct = 10%", () => {
    expect(ROLLOUT_STAGE_PERCENTAGES.ramping_10pct).toBe(10);
  });
  it("full_100pct = 100%", () => {
    expect(ROLLOUT_STAGE_PERCENTAGES.full_100pct).toBe(100);
  });
  it("rolled_back = 0%", () => {
    expect(ROLLOUT_STAGE_PERCENTAGES.rolled_back).toBe(0);
  });
  it("has 4 ramp strategies", () => {
    expect(ROLLOUT_RAMP_STRATEGIES).toHaveLength(4);
  });
});

describe("canTransitionStage", () => {
  it("allows ramping_10pct → ramping_25pct", () => {
    expect(canTransitionStage("ramping_10pct", "ramping_25pct")).toBe(true);
  });
  it("blocks ramping_10pct → full_100pct (skip stages)", () => {
    expect(canTransitionStage("ramping_10pct", "full_100pct")).toBe(false);
  });
  it("allows any stage → rolled_back", () => {
    expect(canTransitionStage("ramping_50pct", "rolled_back")).toBe(true);
    expect(canTransitionStage("full_100pct", "rolled_back")).toBe(true);
  });
  it("rolled_back can only go to paused (re-evaluate)", () => {
    expect(ROLLOUT_STAGE_TRANSITIONS.rolled_back).toEqual(["paused"]);
  });
});

describe("RolloutPlanSchema", () => {
  it("accepts a valid manual ramp plan", () => {
    expect(() => RolloutPlanSchema.parse(basePlan)).not.toThrow();
  });

  it("rejects paused stage without pausedAt + reason", () => {
    expect(() =>
      RolloutPlanSchema.parse({ ...basePlan, currentStage: "paused" }),
    ).toThrow(/paused stage requires/);
  });

  it("rejects rolled_back without full audit", () => {
    expect(() =>
      RolloutPlanSchema.parse({ ...basePlan, currentStage: "rolled_back" }),
    ).toThrow(/rolled_back stage requires/);
  });

  it("rejects metric_driven_auto without blockingMetricSloIds", () => {
    expect(() =>
      RolloutPlanSchema.parse({
        ...basePlan,
        rampStrategy: "metric_driven_auto",
        autoAdvanceOnSuccessfulObservation: true,
      }),
    ).toThrow(/blockingMetricSloIds/);
  });

  it("rejects metric_driven_auto without autoAdvance flag", () => {
    expect(() =>
      RolloutPlanSchema.parse({
        ...basePlan,
        rampStrategy: "metric_driven_auto",
        blockingMetricSloIds: ["slo-error-rate"],
      }),
    ).toThrow(/autoAdvanceOnSuccessfulObservation/);
  });

  it("rejects schedule with ramp-down", () => {
    expect(() =>
      RolloutPlanSchema.parse({
        ...basePlan,
        schedule: [
          {
            stage: "ramping_25pct",
            scheduledAt: "2026-05-17T10:00:00.000Z",
            minObservationHours: 24,
          },
          {
            stage: "ramping_10pct",
            scheduledAt: "2026-05-18T10:00:00.000Z",
            minObservationHours: 0,
          },
        ],
      }),
    ).toThrow(/cannot ramp down/);
  });

  it("rejects schedule with out-of-order timestamps", () => {
    expect(() =>
      RolloutPlanSchema.parse({
        ...basePlan,
        schedule: [
          {
            stage: "ramping_25pct",
            scheduledAt: "2026-05-18T10:00:00.000Z",
            minObservationHours: 24,
          },
          {
            stage: "ramping_50pct",
            scheduledAt: "2026-05-17T10:00:00.000Z",
            minObservationHours: 0,
          },
        ],
      }),
    ).toThrow(/scheduledAt must be after/);
  });
});

describe("isInRollout", () => {
  it("returns false for paused stage", () => {
    expect(
      isInRollout(
        {
          ...basePlan,
          currentStage: "paused",
          pausedAt: "2026-05-16T11:00:00.000Z",
          pausedReason: "stop and observe",
        },
        "tenant-1",
      ),
    ).toBe(false);
  });

  it("returns true always for full_100pct", () => {
    expect(
      isInRollout({ ...basePlan, currentStage: "full_100pct" }, "tenant-1"),
    ).toBe(true);
  });

  it("returns deterministic value per bucketing key", () => {
    const a = isInRollout(basePlan, "tenant-stable-1");
    const b = isInRollout(basePlan, "tenant-stable-1");
    expect(a).toBe(b);
  });

  it("distributes across many tenants close to target percentage", () => {
    let inCount = 0;
    const target = 50;
    const plan: RolloutPlan = { ...basePlan, currentStage: "ramping_50pct" };
    const n = 5000;
    for (let i = 0; i < n; i++) {
      if (isInRollout(plan, `tenant-${i}`)) inCount++;
    }
    const actualPct = (inCount / n) * 100;
    expect(actualPct).toBeGreaterThan(target - 5);
    expect(actualPct).toBeLessThan(target + 5);
  });
});

describe("nextScheduledStage", () => {
  it("returns next future step", () => {
    const plan: RolloutPlan = {
      ...basePlan,
      schedule: [
        {
          stage: "ramping_25pct",
          scheduledAt: "2026-05-18T10:00:00.000Z",
          minObservationHours: 24,
        },
        {
          stage: "ramping_50pct",
          scheduledAt: "2026-05-20T10:00:00.000Z",
          minObservationHours: 24,
        },
      ],
    };
    const r = nextScheduledStage(plan, new Date("2026-05-19T00:00:00Z"));
    expect(r?.stage).toBe("ramping_50pct");
  });

  it("returns null when no future steps", () => {
    expect(nextScheduledStage(basePlan, new Date())).toBeNull();
  });
});

describe("isObservationWindowSatisfied / computeCurrentPercentage", () => {
  it("isObservationWindowSatisfied true past threshold", () => {
    expect(
      isObservationWindowSatisfied(
        basePlan,
        new Date("2026-05-18T10:00:00Z"),
        24,
      ),
    ).toBe(true);
  });
  it("isObservationWindowSatisfied false within threshold", () => {
    expect(
      isObservationWindowSatisfied(
        basePlan,
        new Date("2026-05-16T15:00:00Z"),
        24,
      ),
    ).toBe(false);
  });
  it("computeCurrentPercentage returns stage percentage", () => {
    expect(computeCurrentPercentage(basePlan)).toBe(10);
  });
});
