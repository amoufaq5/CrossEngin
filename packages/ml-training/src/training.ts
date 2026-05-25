import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;
const RUN_ID_REGEX = /^train_[a-z0-9]{8,32}$/;
const DATASET_ID_REGEX = /^ds_[a-z0-9-]{4,40}$/;

export const TRAINING_KINDS = [
  "supervised_finetune",
  "preference_finetune",
  "embedding_train",
  "lora_adapter",
  "qlora_adapter",
  "full_pretrain_continue",
] as const;
export type TrainingKind = (typeof TRAINING_KINDS)[number];
export const TrainingKindSchema = z.enum(TRAINING_KINDS);

export const TRAINING_STATUSES = [
  "queued",
  "preparing",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type TrainingStatus = (typeof TRAINING_STATUSES)[number];
export const TrainingStatusSchema = z.enum(TRAINING_STATUSES);

export const TRAINING_TRANSITIONS: Readonly<Record<TrainingStatus, readonly TrainingStatus[]>> =
  Object.freeze({
    queued: ["preparing", "cancelled"],
    preparing: ["running", "failed", "cancelled"],
    running: ["succeeded", "failed", "cancelled"],
    succeeded: [],
    failed: [],
    cancelled: [],
  });

export function canTransitionTraining(from: TrainingStatus, to: TrainingStatus): boolean {
  return TRAINING_TRANSITIONS[from].includes(to);
}

export const HyperparametersSchema = z
  .object({
    learningRate: z.number().positive().max(1),
    batchSize: z.number().int().min(1).max(8192),
    epochs: z.number().int().min(1).max(100),
    warmupSteps: z.number().int().nonnegative().default(0),
    weightDecay: z.number().nonnegative().max(1).default(0),
    gradientAccumulationSteps: z.number().int().min(1).default(1),
    seed: z.number().int().nonnegative(),
    loraRank: z.number().int().min(1).max(256).optional(),
    loraAlpha: z.number().int().min(1).max(512).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.loraRank !== undefined && v.loraAlpha === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["loraAlpha"],
        message: "loraRank requires loraAlpha",
      });
    }
    if (v.loraAlpha !== undefined && v.loraRank === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["loraRank"],
        message: "loraAlpha requires loraRank",
      });
    }
  });
export type Hyperparameters = z.infer<typeof HyperparametersSchema>;

export const TrainingRunSchema = z
  .object({
    id: z.string().regex(RUN_ID_REGEX),
    label: z.string().min(1),
    kind: TrainingKindSchema,
    status: TrainingStatusSchema,
    baseModelId: z.string().min(1),
    datasetId: z.string().regex(DATASET_ID_REGEX),
    datasetSha256: z.string().regex(SHA256_REGEX),
    hyperparameters: HyperparametersSchema,
    estimatedCostUsd: z.number().nonnegative(),
    actualCostUsd: z.number().nonnegative().nullable().default(null),
    estimatedDurationMinutes: z.number().int().positive(),
    actualDurationMinutes: z.number().int().nonnegative().nullable().default(null),
    queuedAt: Iso8601,
    startedAt: Iso8601.nullable().default(null),
    completedAt: Iso8601.nullable().default(null),
    requestedBy: z.string().min(1),
    approvedBy: z.string().min(1).nullable().default(null),
    cancelledBy: z.string().min(1).nullable().default(null),
    cancelledReason: z.string().min(1).optional(),
    failureReason: z.string().min(1).optional(),
    outputModelArtifactSha256: z.string().regex(SHA256_REGEX).nullable().default(null),
    outputModelStorageUri: z.string().min(1).nullable().default(null),
    trainLossFinal: z.number().nullable().default(null),
    validationLossFinal: z.number().nullable().default(null),
    tokensConsumed: z.number().int().nonnegative().nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (
      (v.kind === "lora_adapter" || v.kind === "qlora_adapter") &&
      v.hyperparameters.loraRank === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hyperparameters", "loraRank"],
        message: `kind '${v.kind}' requires hyperparameters.loraRank`,
      });
    }
    if (v.kind === "full_pretrain_continue" && v.approvedBy === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvedBy"],
        message:
          "full_pretrain_continue requires explicit approval (approvedBy) due to cost + risk",
      });
    }
    if (v.status === "running" || v.status === "succeeded" || v.status === "failed") {
      if (v.startedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["startedAt"],
          message: `status '${v.status}' requires startedAt`,
        });
      }
    }
    if (v.status === "succeeded") {
      if (v.completedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: "succeeded status requires completedAt",
        });
      }
      if (v.outputModelArtifactSha256 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputModelArtifactSha256"],
          message: "succeeded training must produce outputModelArtifactSha256",
        });
      }
      if (v.outputModelStorageUri === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputModelStorageUri"],
          message: "succeeded training must declare outputModelStorageUri",
        });
      }
      if (v.actualCostUsd === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["actualCostUsd"],
          message: "succeeded training must record actualCostUsd",
        });
      }
    }
    if (v.status === "failed" && v.failureReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failureReason"],
        message: "failed training requires failureReason",
      });
    }
    if (v.status === "cancelled") {
      if (v.cancelledBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cancelledBy"],
          message: "cancelled training requires cancelledBy",
        });
      }
      if (v.cancelledReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cancelledReason"],
          message: "cancelled training requires cancelledReason",
        });
      }
    }
    if (v.actualCostUsd !== null && v.actualCostUsd > v.estimatedCostUsd * 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actualCostUsd"],
        message: `actualCostUsd ${v.actualCostUsd.toString()} exceeds 3x estimate ${v.estimatedCostUsd.toString()}; record budget breach incident before saving`,
      });
    }
  });
export type TrainingRun = z.infer<typeof TrainingRunSchema>;

export function isTrainingTerminal(status: TrainingStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function costOverrunRatio(run: TrainingRun): number | null {
  if (run.actualCostUsd === null) return null;
  if (run.estimatedCostUsd === 0) return null;
  return run.actualCostUsd / run.estimatedCostUsd;
}

export function expectedLossImprovement(
  run: TrainingRun,
  baseValidationLoss: number,
): number | null {
  if (run.validationLossFinal === null) return null;
  return baseValidationLoss - run.validationLossFinal;
}
