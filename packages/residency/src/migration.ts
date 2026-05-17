import { z } from "zod";
import { RegionSchema, type Region } from "./regions.js";

const Iso8601 = z.string().datetime({ offset: true });

export const MIGRATION_STEPS = [
  "provision_target_schema",
  "dump_source_postgres",
  "restore_target_postgres",
  "copy_files",
  "copy_audit_log",
  "switch_routing",
  "verify_and_purge",
] as const;
export type MigrationStep = (typeof MIGRATION_STEPS)[number];

export const MIGRATION_STEP_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
] as const;
export type MigrationStepStatus = (typeof MIGRATION_STEP_STATUSES)[number];

export const MigrationStepRecordSchema = z.object({
  step: z.enum(MIGRATION_STEPS),
  status: z.enum(MIGRATION_STEP_STATUSES),
  startedAt: Iso8601.nullable().default(null),
  completedAt: Iso8601.nullable().default(null),
  errorMessage: z.string().min(1).nullable().default(null),
});
export type MigrationStepRecord = z.infer<typeof MigrationStepRecordSchema>;

export const MIGRATION_MODES = ["offline", "live"] as const;
export type MigrationMode = (typeof MIGRATION_MODES)[number];

export const RegionMigrationPlanSchema = z
  .object({
    tenantId: z.string().min(1),
    sourceRegion: RegionSchema,
    targetRegion: RegionSchema,
    mode: z.enum(MIGRATION_MODES).default("offline"),
    triggeredBy: z.string().min(1),
    triggerReason: z.string().min(1),
    estimatedBytes: z.number().int().nonnegative(),
    estimatedDowntimeSeconds: z.number().int().nonnegative(),
    verificationWindowDays: z.number().int().min(1).max(90).default(7),
    steps: z.array(MigrationStepRecordSchema).length(MIGRATION_STEPS.length),
    createdAt: Iso8601,
    completedAt: Iso8601.nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.sourceRegion === v.targetRegion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetRegion"],
        message: "targetRegion must differ from sourceRegion",
      });
    }
    for (let i = 0; i < MIGRATION_STEPS.length; i++) {
      const expected = MIGRATION_STEPS[i];
      const actual = v.steps[i]?.step;
      if (expected !== actual) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "step"],
          message: `step[${i}] must be '${expected}' (got '${String(actual)}')`,
        });
      }
    }
  });
export type RegionMigrationPlan = z.infer<typeof RegionMigrationPlanSchema>;

export function buildMigrationPlan(input: {
  readonly tenantId: string;
  readonly sourceRegion: Region;
  readonly targetRegion: Region;
  readonly mode?: MigrationMode;
  readonly triggeredBy: string;
  readonly triggerReason: string;
  readonly estimatedBytes: number;
  readonly createdAt: string;
  readonly verificationWindowDays?: number;
}): RegionMigrationPlan {
  const estimatedDowntimeSeconds =
    input.mode === "live" ? 60 : Math.ceil(input.estimatedBytes / (1024 * 1024 * 1024)) * 60;
  return RegionMigrationPlanSchema.parse({
    tenantId: input.tenantId,
    sourceRegion: input.sourceRegion,
    targetRegion: input.targetRegion,
    mode: input.mode ?? "offline",
    triggeredBy: input.triggeredBy,
    triggerReason: input.triggerReason,
    estimatedBytes: input.estimatedBytes,
    estimatedDowntimeSeconds,
    verificationWindowDays: input.verificationWindowDays ?? 7,
    steps: MIGRATION_STEPS.map((step) => ({
      step,
      status: "pending" as const,
      startedAt: null,
      completedAt: null,
      errorMessage: null,
    })),
    createdAt: input.createdAt,
    completedAt: null,
  });
}

export function nextPendingStep(plan: RegionMigrationPlan): MigrationStep | null {
  for (const record of plan.steps) {
    if (record.status === "pending" || record.status === "running") {
      return record.step;
    }
  }
  return null;
}

export function isMigrationComplete(plan: RegionMigrationPlan): boolean {
  return plan.steps.every((s) => s.status === "completed" || s.status === "skipped");
}
