import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const INCIDENT_ID_REGEX = /^INC-\d{4}-\d{4,8}$/;
const RUNBOOK_ID_REGEX = /^RB-\d{4}$/;

export const EXECUTION_STATUSES = [
  "queued",
  "running",
  "paused",
  "succeeded",
  "failed",
  "aborted",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export const ExecutionStatusSchema = z.enum(EXECUTION_STATUSES);

export const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> =
  Object.freeze({
    queued: ["running", "aborted"],
    running: ["paused", "succeeded", "failed", "aborted"],
    paused: ["running", "aborted"],
    succeeded: [],
    failed: ["running"],
    aborted: [],
  });

export function canTransitionExecution(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return EXECUTION_TRANSITIONS[from].includes(to);
}

export const STEP_OUTCOMES = ["passed", "failed", "skipped", "manual_override"] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];

export const RunbookStepRecordSchema = z
  .object({
    stepNumber: z.number().int().positive(),
    title: z.string().min(1),
    startedAt: Iso8601,
    completedAt: Iso8601.nullable().default(null),
    outcome: z.enum(STEP_OUTCOMES).nullable().default(null),
    notes: z.string().min(1).optional(),
    executedByUserId: z.string().min(1),
    automated: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.completedAt !== null && v.outcome === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "completedAt requires outcome",
      });
    }
    if (v.outcome !== null && v.completedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "outcome requires completedAt",
      });
    }
    if (v.outcome === "manual_override" && v.notes === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["notes"],
        message: "manual_override outcome requires notes",
      });
    }
    if (v.completedAt !== null) {
      const startMs = new Date(v.startedAt).getTime();
      const endMs = new Date(v.completedAt).getTime();
      if (endMs < startMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: "completedAt cannot be before startedAt",
        });
      }
    }
  });
export type RunbookStepRecord = z.infer<typeof RunbookStepRecordSchema>;

export const RunbookExecutionSchema = z
  .object({
    id: z.string().min(1),
    incidentId: z.string().regex(INCIDENT_ID_REGEX),
    runbookId: z.string().regex(RUNBOOK_ID_REGEX, {
      message: "runbookId must match dr package RB-NNNN pattern",
    }),
    runbookVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    invokedAt: Iso8601,
    invokedBy: z.string().min(1),
    status: ExecutionStatusSchema,
    startedAt: Iso8601.nullable().default(null),
    completedAt: Iso8601.nullable().default(null),
    durationSeconds: z.number().int().nonnegative().nullable().default(null),
    steps: z.array(RunbookStepRecordSchema).default([]),
    abortedAt: Iso8601.nullable().default(null),
    abortedReason: z.string().min(1).optional(),
    pageOncallTriggered: z.boolean().default(false),
    incidentCommanderApprovalUserId: z.string().min(1).nullable().default(null),
    artifactStorageUri: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "running" || v.status === "paused") {
      if (v.startedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["startedAt"],
          message: `status '${v.status}' requires startedAt`,
        });
      }
    }
    if (v.status === "succeeded" || v.status === "failed") {
      if (v.startedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["startedAt"],
          message: `status '${v.status}' requires startedAt`,
        });
      }
      if (v.completedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: `status '${v.status}' requires completedAt`,
        });
      }
      if (v.durationSeconds === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["durationSeconds"],
          message: `status '${v.status}' requires durationSeconds`,
        });
      }
    }
    if (v.status === "aborted") {
      if (v.abortedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["abortedAt"],
          message: "aborted status requires abortedAt",
        });
      }
      if (v.abortedReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["abortedReason"],
          message: "aborted status requires abortedReason",
        });
      }
    }
    if (v.status === "succeeded" && v.steps.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps"],
        message: "succeeded execution must record step results",
      });
    }
    const stepNums = new Set<number>();
    v.steps.forEach((s, i) => {
      if (stepNums.has(s.stepNumber)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "stepNumber"],
          message: `duplicate stepNumber ${s.stepNumber.toString()}`,
        });
      }
      stepNums.add(s.stepNumber);
    });
    if (v.status === "succeeded") {
      const allDone = v.steps.every((s) => s.outcome !== null && s.outcome !== "failed");
      if (!allDone) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps"],
          message: "succeeded execution must have all steps non-failed and with outcomes recorded",
        });
      }
    }
  });
export type RunbookExecution = z.infer<typeof RunbookExecutionSchema>;

export function manualOverrideCount(exec: RunbookExecution): number {
  return exec.steps.filter((s) => s.outcome === "manual_override").length;
}

export function failedStepCount(exec: RunbookExecution): number {
  return exec.steps.filter((s) => s.outcome === "failed").length;
}

export function isExecutionComplete(status: ExecutionStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "aborted";
}
