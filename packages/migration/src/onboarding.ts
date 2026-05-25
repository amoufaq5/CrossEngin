import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });

export const ONBOARDING_STAGES = [
  "workspace_setup",
  "plan_selection",
  "schema_design",
  "user_invites",
  "first_import",
  "validate",
  "go_live",
] as const;
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];
export const OnboardingStageSchema = z.enum(ONBOARDING_STAGES);

export const STAGE_ORDER: Readonly<Record<OnboardingStage, number>> = Object.freeze({
  workspace_setup: 0,
  plan_selection: 1,
  schema_design: 2,
  user_invites: 3,
  first_import: 4,
  validate: 5,
  go_live: 6,
});

export const STAGE_STATUSES = ["pending", "in_progress", "completed", "skipped", "failed"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];
export const StageStatusSchema = z.enum(STAGE_STATUSES);

export const ONBOARDING_PATHS = ["bring_my_data", "vertical_template", "blank_workspace"] as const;
export type OnboardingPath = (typeof ONBOARDING_PATHS)[number];
export const OnboardingPathSchema = z.enum(ONBOARDING_PATHS);

const SKIPPABLE_STAGES: ReadonlySet<OnboardingStage> = new Set(["user_invites", "first_import"]);

export const StageRecordSchema = z
  .object({
    stage: OnboardingStageSchema,
    status: StageStatusSchema,
    startedAt: Iso8601.nullable().default(null),
    completedAt: Iso8601.nullable().default(null),
    skippedReason: z.string().min(1).optional(),
    failureReason: z.string().min(1).optional(),
    completedBy: z.string().min(1).nullable().default(null),
    artifactRef: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "in_progress" && v.startedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startedAt"],
        message: "in_progress stage requires startedAt",
      });
    }
    if (v.status === "completed") {
      if (v.completedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: "completed stage requires completedAt",
        });
      }
      if (v.completedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedBy"],
          message: "completed stage requires completedBy",
        });
      }
    }
    if (v.status === "skipped") {
      if (!SKIPPABLE_STAGES.has(v.stage)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["status"],
          message: `stage '${v.stage}' is not skippable`,
        });
      }
      if (v.skippedReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["skippedReason"],
          message: "skipped stage requires skippedReason",
        });
      }
    }
    if (v.status === "failed" && v.failureReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failureReason"],
        message: "failed stage requires failureReason",
      });
    }
  });
export type StageRecord = z.infer<typeof StageRecordSchema>;

export const OnboardingRunSchema = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    path: OnboardingPathSchema,
    currentStage: OnboardingStageSchema,
    stages: z.array(StageRecordSchema).min(1),
    startedAt: Iso8601,
    startedBy: z.string().min(1),
    completedAt: Iso8601.nullable().default(null),
    abandonedAt: Iso8601.nullable().default(null),
    abandonedReason: z.string().min(1).optional(),
    sourcePackId: z.string().min(1).optional(),
    sourceImportId: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    const stagesSeen = new Set<OnboardingStage>();
    v.stages.forEach((s, i) => {
      if (stagesSeen.has(s.stage)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", i, "stage"],
          message: `duplicate stage '${s.stage}'`,
        });
      }
      stagesSeen.add(s.stage);
    });
    if (!stagesSeen.has(v.currentStage)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentStage"],
        message: `currentStage '${v.currentStage}' is not in stages`,
      });
    }
    const currentOrder = STAGE_ORDER[v.currentStage];
    for (const stage of v.stages) {
      const order = STAGE_ORDER[stage.stage];
      if (order < currentOrder && stage.status !== "completed" && stage.status !== "skipped") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages"],
          message: `prior stage '${stage.stage}' must be completed or skipped before advancing to '${v.currentStage}'`,
        });
      }
    }
    if (v.path === "bring_my_data" && v.sourceImportId === undefined) {
      const firstImport = v.stages.find((s) => s.stage === "first_import");
      if (
        firstImport !== undefined &&
        (firstImport.status === "completed" || firstImport.status === "in_progress")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sourceImportId"],
          message:
            "path='bring_my_data' with first_import in progress/completed requires sourceImportId",
        });
      }
    }
    if (v.path === "vertical_template" && v.sourcePackId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourcePackId"],
        message: "path='vertical_template' requires sourcePackId",
      });
    }
    if (v.completedAt !== null && v.currentStage !== "go_live") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentStage"],
        message: "completedAt requires currentStage='go_live'",
      });
    }
    if (v.abandonedAt !== null && v.abandonedReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["abandonedReason"],
        message: "abandonedAt requires abandonedReason",
      });
    }
    if (v.abandonedAt !== null && v.completedAt !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["abandonedAt"],
        message: "abandonedAt and completedAt are mutually exclusive",
      });
    }
  });
export type OnboardingRun = z.infer<typeof OnboardingRunSchema>;

export function nextStage(current: OnboardingStage): OnboardingStage | null {
  const idx = STAGE_ORDER[current];
  const stages = [...ONBOARDING_STAGES];
  const next = stages.find((s) => STAGE_ORDER[s] === idx + 1);
  return next ?? null;
}

export function stagesRemaining(run: OnboardingRun): readonly OnboardingStage[] {
  const completed = new Set<OnboardingStage>();
  for (const s of run.stages) {
    if (s.status === "completed" || s.status === "skipped") completed.add(s.stage);
  }
  return ONBOARDING_STAGES.filter((s) => !completed.has(s));
}

export function isReadyForGoLive(run: OnboardingRun): boolean {
  const requiredBeforeGoLive: ReadonlyArray<OnboardingStage> = [
    "workspace_setup",
    "plan_selection",
    "schema_design",
    "validate",
  ];
  const statusByStage = new Map<OnboardingStage, StageRecord["status"]>();
  for (const s of run.stages) statusByStage.set(s.stage, s.status);
  for (const stage of requiredBeforeGoLive) {
    const status = statusByStage.get(stage);
    if (status !== "completed") return false;
  }
  return true;
}

export function onboardingProgressPercent(run: OnboardingRun): number {
  const total = ONBOARDING_STAGES.length;
  const advanced = run.stages.filter(
    (s) => s.status === "completed" || s.status === "skipped",
  ).length;
  return Math.round((advanced / total) * 100);
}
