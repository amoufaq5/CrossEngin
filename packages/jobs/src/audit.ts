import { z } from "zod";
import { DATA_CLASSES, EventNameSchema, JobIdSchema, JOB_KINDS } from "./types.js";

const UuidLike = z.string().min(1);
const Iso8601 = z.string().datetime({ offset: true });

export const JOB_RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "dead-lettered",
  "cancelled",
] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

export const JobRunTriggerInfoSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("event"),
    eventName: EventNameSchema,
    eventId: UuidLike,
  }),
  z.object({
    kind: z.literal("scheduled"),
    scheduledFor: Iso8601,
  }),
  z.object({
    kind: z.literal("delayed"),
    afterEventName: EventNameSchema,
    afterEventId: UuidLike,
    delayMillis: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("userInvoked"),
    action: z.string().min(1),
    invokedBy: UuidLike,
  }),
  z.object({
    kind: z.literal("workflow"),
    workflow: z.string().min(1),
    step: z.string().min(1),
    runId: UuidLike,
  }),
  z.object({
    kind: z.literal("cdc"),
    table: z.string().min(1),
    operation: z.enum(["insert", "update", "delete"]),
    primaryKey: z.string().min(1),
  }),
]);
export type JobRunTriggerInfo = z.infer<typeof JobRunTriggerInfoSchema>;

export const JobRunRecordSchema = z.object({
  jobId: JobIdSchema,
  jobKind: z.enum(JOB_KINDS),
  tenantId: UuidLike,
  runId: UuidLike,
  trigger: JobRunTriggerInfoSchema,
  startedAt: Iso8601,
  completedAt: Iso8601.nullable(),
  durationMillis: z.number().int().nonnegative().nullable(),
  attempts: z.number().int().min(1),
  status: z.enum(JOB_RUN_STATUSES),
  inputRedacted: z.unknown().optional(),
  outputRedacted: z.unknown().optional(),
  inputDataClass: z.enum(DATA_CLASSES),
  outputDataClass: z.enum(DATA_CLASSES),
  error: z
    .object({
      kind: z.enum(["retryable", "permanent", "unknown"]),
      message: z.string().min(1),
      stack: z.string().optional(),
    })
    .nullable(),
});
export type JobRunRecord = z.infer<typeof JobRunRecordSchema>;

export const DeadLetterReasonSchema = z.enum([
  "max-retries-exceeded",
  "permanent-error",
  "cancelled",
  "timeout",
]);
export type DeadLetterReason = z.infer<typeof DeadLetterReasonSchema>;

export const DeadLetterRecordSchema = z.object({
  jobId: JobIdSchema,
  tenantId: UuidLike,
  runId: UuidLike,
  deadLetteredAt: Iso8601,
  reason: DeadLetterReasonSchema,
  attemptCount: z.number().int().min(1),
  finalError: z.object({
    kind: z.enum(["retryable", "permanent", "unknown"]),
    message: z.string().min(1),
    stack: z.string().optional(),
  }),
  inputRedacted: z.unknown().optional(),
  reprocessable: z.boolean(),
  reprocessedAt: Iso8601.nullable(),
});
export type DeadLetterRecord = z.infer<typeof DeadLetterRecordSchema>;

export const JobCostRecordSchema = z.object({
  jobId: JobIdSchema,
  tenantId: UuidLike,
  runId: UuidLike,
  estimatedCostUsd: z.number().nonnegative(),
  occurredAt: Iso8601,
  costBasis: z.enum([
    "inngest-execution",
    "inngest-step",
    "external-api",
    "compute-seconds",
    "storage",
  ]),
});
export type JobCostRecord = z.infer<typeof JobCostRecordSchema>;
