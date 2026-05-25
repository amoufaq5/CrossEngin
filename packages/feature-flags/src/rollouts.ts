import { z } from "zod";
import { computeStableBucket } from "./targeting.js";

export const ROLLOUT_STAGES = [
  "paused",
  "ramping_1pct",
  "ramping_5pct",
  "ramping_10pct",
  "ramping_25pct",
  "ramping_50pct",
  "ramping_75pct",
  "full_100pct",
  "rolled_back",
] as const;
export type RolloutStage = (typeof ROLLOUT_STAGES)[number];

export const ROLLOUT_STAGE_PERCENTAGES: Readonly<Record<RolloutStage, number>> = {
  paused: 0,
  ramping_1pct: 1,
  ramping_5pct: 5,
  ramping_10pct: 10,
  ramping_25pct: 25,
  ramping_50pct: 50,
  ramping_75pct: 75,
  full_100pct: 100,
  rolled_back: 0,
};

export const ROLLOUT_STAGE_TRANSITIONS: Readonly<Record<RolloutStage, readonly RolloutStage[]>> = {
  paused: ["ramping_1pct", "rolled_back"],
  ramping_1pct: ["ramping_5pct", "paused", "rolled_back"],
  ramping_5pct: ["ramping_10pct", "paused", "rolled_back"],
  ramping_10pct: ["ramping_25pct", "paused", "rolled_back"],
  ramping_25pct: ["ramping_50pct", "paused", "rolled_back"],
  ramping_50pct: ["ramping_75pct", "paused", "rolled_back"],
  ramping_75pct: ["full_100pct", "paused", "rolled_back"],
  full_100pct: ["paused", "rolled_back"],
  rolled_back: ["paused"],
};

export const canTransitionStage = (from: RolloutStage, to: RolloutStage): boolean =>
  ROLLOUT_STAGE_TRANSITIONS[from].includes(to);

export const ROLLOUT_RAMP_STRATEGIES = [
  "manual",
  "scheduled_linear",
  "scheduled_exponential",
  "metric_driven_auto",
] as const;
export type RolloutRampStrategy = (typeof ROLLOUT_RAMP_STRATEGIES)[number];

export const RolloutScheduleStepSchema = z.object({
  stage: z.enum(ROLLOUT_STAGES),
  scheduledAt: z.string().datetime({ offset: true }),
  minObservationHours: z.number().int().min(0).max(720).default(0),
});
export type RolloutScheduleStep = z.infer<typeof RolloutScheduleStepSchema>;

export const RolloutPlanSchema = z
  .object({
    id: z.string().regex(/^fro_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    flagId: z.string().regex(/^ff_[a-z0-9]{8,32}$/),
    rampStrategy: z.enum(ROLLOUT_RAMP_STRATEGIES),
    bucketingKey: z.enum(["tenant_id", "principal_id", "session_id"]),
    salt: z.string().min(4).max(120),
    currentStage: z.enum(ROLLOUT_STAGES),
    schedule: z.array(RolloutScheduleStepSchema).max(20).default([]),
    autoAdvanceOnSuccessfulObservation: z.boolean().default(false),
    blockingMetricSloIds: z.array(z.string().max(120)).default([]),
    pausedAt: z.string().datetime({ offset: true }).nullable(),
    pausedByUserId: z.string().uuid().nullable(),
    pausedReason: z.string().max(500).nullable(),
    rolledBackAt: z.string().datetime({ offset: true }).nullable(),
    rolledBackByUserId: z.string().uuid().nullable(),
    rolledBackReason: z.string().max(500).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    createdBy: z.string().uuid(),
    lastStageTransitionAt: z.string().datetime({ offset: true }),
  })
  .superRefine((r, ctx) => {
    if (r.currentStage === "paused") {
      if (r.pausedAt === null || r.pausedReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pausedAt"],
          message: "paused stage requires pausedAt + pausedReason",
        });
      }
    }
    if (r.currentStage === "rolled_back") {
      if (r.rolledBackAt === null || r.rolledBackByUserId === null || r.rolledBackReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rolledBackAt"],
          message:
            "rolled_back stage requires rolledBackAt + rolledBackByUserId + rolledBackReason",
        });
      }
    }
    if (r.rampStrategy === "metric_driven_auto") {
      if (r.blockingMetricSloIds.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["blockingMetricSloIds"],
          message: "metric_driven_auto strategy requires at least one blockingMetricSloIds entry",
        });
      }
      if (!r.autoAdvanceOnSuccessfulObservation) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["autoAdvanceOnSuccessfulObservation"],
          message: "metric_driven_auto requires autoAdvanceOnSuccessfulObservation=true",
        });
      }
    }
    if (r.schedule.length > 1) {
      for (let i = 1; i < r.schedule.length; i++) {
        const prev = r.schedule[i - 1];
        const curr = r.schedule[i];
        if (prev === undefined || curr === undefined) continue;
        if (Date.parse(curr.scheduledAt) <= Date.parse(prev.scheduledAt)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["schedule"],
            message: `schedule step ${i} scheduledAt must be after step ${i - 1}`,
          });
          return;
        }
        const prevPct = ROLLOUT_STAGE_PERCENTAGES[prev.stage];
        const currPct = ROLLOUT_STAGE_PERCENTAGES[curr.stage];
        if (curr.stage !== "rolled_back" && currPct < prevPct) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["schedule"],
            message: `schedule cannot ramp down (step ${i - 1} → ${i})`,
          });
          return;
        }
      }
    }
  });
export type RolloutPlan = z.infer<typeof RolloutPlanSchema>;

export const isInRollout = (plan: RolloutPlan, bucketingValue: string): boolean => {
  if (plan.currentStage === "paused" || plan.currentStage === "rolled_back") {
    return false;
  }
  const percentage = ROLLOUT_STAGE_PERCENTAGES[plan.currentStage];
  if (percentage === 100) return true;
  const bucket = computeStableBucket(bucketingValue, plan.salt);
  return bucket < percentage * 100;
};

export const nextScheduledStage = (plan: RolloutPlan, now: Date): RolloutScheduleStep | null => {
  const nowMs = now.getTime();
  for (const step of plan.schedule) {
    if (Date.parse(step.scheduledAt) > nowMs) return step;
  }
  return null;
};

export const isObservationWindowSatisfied = (
  plan: RolloutPlan,
  now: Date,
  minObservationHours: number,
): boolean => {
  const elapsedMs = now.getTime() - Date.parse(plan.lastStageTransitionAt);
  return elapsedMs >= minObservationHours * 3_600_000;
};

export const computeCurrentPercentage = (plan: RolloutPlan): number =>
  ROLLOUT_STAGE_PERCENTAGES[plan.currentStage];
