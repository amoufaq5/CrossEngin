import { z } from "zod";
import { COMPENSATION_STRATEGIES, type CompensationStrategy } from "./definitions.js";

export const COMPENSATION_PLAN_STATUSES = [
  "computed",
  "executing",
  "completed",
  "failed",
  "abandoned",
] as const;
export type CompensationPlanStatus = (typeof COMPENSATION_PLAN_STATUSES)[number];

export const COMPENSATION_PLAN_TRANSITIONS: Readonly<
  Record<CompensationPlanStatus, readonly CompensationPlanStatus[]>
> = {
  computed: ["executing", "abandoned"],
  executing: ["completed", "failed", "abandoned"],
  completed: [],
  failed: ["executing"],
  abandoned: [],
};

export const canTransitionCompensationPlan = (
  from: CompensationPlanStatus,
  to: CompensationPlanStatus,
): boolean => COMPENSATION_PLAN_TRANSITIONS[from].includes(to);

export interface ExecutedActivity {
  readonly activityId: string;
  readonly definitionActivityKey: string;
  readonly compensationActivityKey: string | null;
  readonly status: string;
  readonly kind: string;
  readonly completedAt: string | null;
  readonly sequenceCursor: number;
}

export interface CompensationStep {
  readonly executedActivityId: string;
  readonly compensationActivityKey: string;
  readonly orderIndex: number;
}

export const computeCompensationPlan = (input: {
  readonly executedActivities: readonly ExecutedActivity[];
  readonly strategy: CompensationStrategy;
}): readonly CompensationStep[] => {
  if (input.strategy === "no_compensation") return [];
  const succeededSideEffects = input.executedActivities
    .filter((a) => a.status === "succeeded" && a.compensationActivityKey !== null)
    .slice();
  if (input.strategy === "immediate_reverse_order") {
    succeededSideEffects.sort((a, b) => b.sequenceCursor - a.sequenceCursor);
  } else if (input.strategy === "parallel") {
    succeededSideEffects.sort((a, b) => a.sequenceCursor - b.sequenceCursor);
  }
  return succeededSideEffects.map((a, idx) => ({
    executedActivityId: a.activityId,
    compensationActivityKey: a.compensationActivityKey as string,
    orderIndex: idx,
  }));
};

export const CompensationPlanSchema = z
  .object({
    id: z.string().regex(/^wfc_[a-z0-9]{8,40}$/),
    instanceId: z.string().regex(/^wfi_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid(),
    strategy: z.enum(COMPENSATION_STRATEGIES),
    status: z.enum(COMPENSATION_PLAN_STATUSES),
    triggeredAt: z.string().datetime({ offset: true }),
    triggerReason: z.string().min(1).max(500),
    triggeredByUserId: z.string().uuid().nullable(),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    abandonedAt: z.string().datetime({ offset: true }).nullable(),
    abandonedReason: z.string().max(500).nullable(),
    steps: z
      .array(
        z.object({
          executedActivityId: z.string().regex(/^wfa_[a-z0-9]{8,40}$/),
          compensationActivityKey: z
            .string()
            .regex(/^[a-z][a-z0-9_]*$/)
            .max(80),
          orderIndex: z.number().int().min(0).max(10_000),
          compensationActivityId: z
            .string()
            .regex(/^wfa_[a-z0-9]{8,40}$/)
            .nullable(),
          startedAt: z.string().datetime({ offset: true }).nullable(),
          completedAt: z.string().datetime({ offset: true }).nullable(),
          stepStatus: z.enum(["pending", "running", "succeeded", "failed", "skipped"]),
          errorMessage: z.string().max(500).nullable(),
        }),
      )
      .max(1000),
    totalSteps: z.number().int().min(0).max(1000),
    succeededSteps: z.number().int().min(0).max(1000),
    failedSteps: z.number().int().min(0).max(1000),
    requiresManualReview: z.boolean().default(false),
  })
  .superRefine((p, ctx) => {
    if (p.strategy === "no_compensation" && p.steps.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps"],
        message: "no_compensation strategy must produce an empty steps array",
      });
    }
    if (p.strategy === "manual_review" && !p.requiresManualReview) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiresManualReview"],
        message: "manual_review strategy requires requiresManualReview=true",
      });
    }
    if (p.totalSteps !== p.steps.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalSteps"],
        message: "totalSteps must equal steps array length",
      });
    }
    if (p.succeededSteps + p.failedSteps > p.totalSteps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalSteps"],
        message: "succeededSteps + failedSteps cannot exceed totalSteps",
      });
    }
    if (p.status === "completed") {
      if (p.completedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: "completed compensation plan requires completedAt",
        });
      }
      if (p.succeededSteps + p.failedSteps !== p.totalSteps) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["status"],
          message: "completed plan must have all steps resolved",
        });
      }
    }
    if (p.status === "abandoned") {
      if (p.abandonedAt === null || p.abandonedReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["abandonedReason"],
          message: "abandoned compensation plan requires abandonedAt + abandonedReason",
        });
      }
    }
    if (p.strategy === "immediate_reverse_order") {
      const indexes = p.steps.map((s) => s.orderIndex);
      const sorted = [...indexes].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i] !== i) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps"],
            message: "immediate_reverse_order strategy requires dense orderIndex (0..n-1)",
          });
          return;
        }
      }
    }
  });
export type CompensationPlan = z.infer<typeof CompensationPlanSchema>;

export const isCompensationComplete = (plan: CompensationPlan): boolean =>
  plan.status === "completed";

export const compensationSuccessRate = (plan: CompensationPlan): number => {
  if (plan.totalSteps === 0) return 1;
  return plan.succeededSteps / plan.totalSteps;
};

export const findUnreversibleSideEffects = (
  activities: readonly ExecutedActivity[],
): readonly ExecutedActivity[] =>
  activities.filter(
    (a) =>
      a.status === "succeeded" &&
      a.compensationActivityKey === null &&
      (a.kind === "http_call" ||
        a.kind === "db_write" ||
        a.kind === "send_notification" ||
        a.kind === "ai_call"),
  );
