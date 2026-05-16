import { describe, expect, it } from "vitest";
import {
  COMPENSATION_PLAN_STATUSES,
  COMPENSATION_PLAN_TRANSITIONS,
  CompensationPlanSchema,
  canTransitionCompensationPlan,
  compensationSuccessRate,
  computeCompensationPlan,
  findUnreversibleSideEffects,
  isCompensationComplete,
  type CompensationPlan,
  type ExecutedActivity,
} from "./compensation.js";

const executedActivities: ExecutedActivity[] = [
  {
    activityId: "wfa_step1a001",
    definitionActivityKey: "reserve_inventory",
    compensationActivityKey: "release_inventory",
    status: "succeeded",
    kind: "db_write",
    completedAt: "2026-05-16T10:00:05.000Z",
    sequenceCursor: 1,
  },
  {
    activityId: "wfa_step2a001",
    definitionActivityKey: "charge_card",
    compensationActivityKey: "refund_charge",
    status: "succeeded",
    kind: "http_call",
    completedAt: "2026-05-16T10:00:08.000Z",
    sequenceCursor: 2,
  },
  {
    activityId: "wfa_step3a001",
    definitionActivityKey: "send_confirmation",
    compensationActivityKey: null,
    status: "succeeded",
    kind: "send_notification",
    completedAt: "2026-05-16T10:00:10.000Z",
    sequenceCursor: 3,
  },
];

describe("constants", () => {
  it("has 5 plan statuses", () => {
    expect(COMPENSATION_PLAN_STATUSES).toHaveLength(5);
  });
  it("completed is terminal", () => {
    expect(COMPENSATION_PLAN_TRANSITIONS.completed).toEqual([]);
  });
});

describe("canTransitionCompensationPlan", () => {
  it("allows computed → executing", () => {
    expect(canTransitionCompensationPlan("computed", "executing")).toBe(true);
  });
  it("allows failed → executing (retry)", () => {
    expect(canTransitionCompensationPlan("failed", "executing")).toBe(true);
  });
});

describe("computeCompensationPlan", () => {
  it("returns empty for no_compensation strategy", () => {
    expect(
      computeCompensationPlan({
        executedActivities,
        strategy: "no_compensation",
      }),
    ).toEqual([]);
  });

  it("returns reverse-order steps for immediate_reverse_order", () => {
    const plan = computeCompensationPlan({
      executedActivities,
      strategy: "immediate_reverse_order",
    });
    expect(plan).toHaveLength(2);
    expect(plan[0]?.executedActivityId).toBe("wfa_step2a001");
    expect(plan[1]?.executedActivityId).toBe("wfa_step1a001");
  });

  it("returns forward-order steps for parallel strategy", () => {
    const plan = computeCompensationPlan({
      executedActivities,
      strategy: "parallel",
    });
    expect(plan).toHaveLength(2);
    expect(plan[0]?.executedActivityId).toBe("wfa_step1a001");
    expect(plan[1]?.executedActivityId).toBe("wfa_step2a001");
  });

  it("excludes activities without compensationActivityKey", () => {
    const plan = computeCompensationPlan({
      executedActivities,
      strategy: "immediate_reverse_order",
    });
    expect(plan.map((s) => s.executedActivityId)).not.toContain(
      "wfa_step3a001",
    );
  });
});

const basePlan: CompensationPlan = {
  id: "wfc_compen01",
  instanceId: "wfi_pr00000001",
  tenantId: "11111111-1111-1111-1111-111111111111",
  strategy: "immediate_reverse_order",
  status: "computed",
  triggeredAt: "2026-05-16T11:00:00.000Z",
  triggerReason: "activity_failure_in_step_4",
  triggeredByUserId: null,
  completedAt: null,
  abandonedAt: null,
  abandonedReason: null,
  steps: [
    {
      executedActivityId: "wfa_step2a001",
      compensationActivityKey: "refund_charge",
      orderIndex: 0,
      compensationActivityId: null,
      startedAt: null,
      completedAt: null,
      stepStatus: "pending",
      errorMessage: null,
    },
    {
      executedActivityId: "wfa_step1a001",
      compensationActivityKey: "release_inventory",
      orderIndex: 1,
      compensationActivityId: null,
      startedAt: null,
      completedAt: null,
      stepStatus: "pending",
      errorMessage: null,
    },
  ],
  totalSteps: 2,
  succeededSteps: 0,
  failedSteps: 0,
  requiresManualReview: false,
};

describe("CompensationPlanSchema", () => {
  it("accepts a computed plan", () => {
    expect(() => CompensationPlanSchema.parse(basePlan)).not.toThrow();
  });

  it("rejects no_compensation strategy with non-empty steps", () => {
    expect(() =>
      CompensationPlanSchema.parse({
        ...basePlan,
        strategy: "no_compensation",
      }),
    ).toThrow(/no_compensation strategy must produce an empty steps array/);
  });

  it("rejects manual_review strategy without requiresManualReview=true", () => {
    expect(() =>
      CompensationPlanSchema.parse({
        ...basePlan,
        strategy: "manual_review",
      }),
    ).toThrow(/requiresManualReview=true/);
  });

  it("rejects totalSteps != steps.length", () => {
    expect(() =>
      CompensationPlanSchema.parse({
        ...basePlan,
        totalSteps: 99,
      }),
    ).toThrow(/totalSteps must equal/);
  });

  it("rejects succeeded + failed > totalSteps", () => {
    expect(() =>
      CompensationPlanSchema.parse({
        ...basePlan,
        succeededSteps: 2,
        failedSteps: 5,
      }),
    ).toThrow(/cannot exceed totalSteps/);
  });

  it("rejects completed plan without completedAt", () => {
    expect(() =>
      CompensationPlanSchema.parse({
        ...basePlan,
        status: "completed",
        succeededSteps: 2,
        steps: basePlan.steps.map((s) => ({
          ...s,
          stepStatus: "succeeded" as const,
          startedAt: "2026-05-16T11:01:00.000Z",
          completedAt: "2026-05-16T11:02:00.000Z",
        })),
      }),
    ).toThrow(/completed compensation plan requires completedAt/);
  });

  it("rejects abandoned without abandonedReason", () => {
    expect(() =>
      CompensationPlanSchema.parse({
        ...basePlan,
        status: "abandoned",
        abandonedAt: "2026-05-16T12:00:00.000Z",
      }),
    ).toThrow(/abandoned compensation plan/);
  });

  it("rejects immediate_reverse_order with non-dense orderIndex", () => {
    expect(() =>
      CompensationPlanSchema.parse({
        ...basePlan,
        steps: basePlan.steps.map((s, i) => ({
          ...s,
          orderIndex: i + 5,
        })),
      }),
    ).toThrow(/dense orderIndex/);
  });
});

describe("isCompensationComplete", () => {
  it("returns true for completed plan", () => {
    expect(
      isCompensationComplete({
        ...basePlan,
        status: "completed",
        completedAt: "2026-05-16T11:30:00.000Z",
      }),
    ).toBe(true);
  });
  it("returns false for executing plan", () => {
    expect(
      isCompensationComplete({ ...basePlan, status: "executing" }),
    ).toBe(false);
  });
});

describe("compensationSuccessRate", () => {
  it("returns 1.0 for zero steps", () => {
    expect(
      compensationSuccessRate({ ...basePlan, totalSteps: 0, steps: [] }),
    ).toBe(1);
  });
  it("returns success ratio", () => {
    expect(
      compensationSuccessRate({
        ...basePlan,
        succeededSteps: 1,
        failedSteps: 1,
      }),
    ).toBe(0.5);
  });
});

describe("findUnreversibleSideEffects", () => {
  it("returns activities without compensationActivityKey", () => {
    const r = findUnreversibleSideEffects(executedActivities);
    expect(r).toHaveLength(1);
    expect(r[0]?.activityId).toBe("wfa_step3a001");
  });
});
