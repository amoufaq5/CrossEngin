import { z } from "zod";
import { DataClassSchema, TrainingPurposeSchema } from "./consent.js";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;
const DATASET_ID_REGEX = /^ds_[a-z0-9-]{4,40}$/;

export const DATASET_STATUSES = ["drafting", "frozen", "deprecated", "purged"] as const;
export type DatasetStatus = (typeof DATASET_STATUSES)[number];
export const DatasetStatusSchema = z.enum(DATASET_STATUSES);

export const DATASET_TRANSITIONS: Readonly<Record<DatasetStatus, readonly DatasetStatus[]>> =
  Object.freeze({
    drafting: ["frozen", "purged"],
    frozen: ["deprecated", "purged"],
    deprecated: ["purged"],
    purged: [],
  });

export function canTransitionDataset(from: DatasetStatus, to: DatasetStatus): boolean {
  return DATASET_TRANSITIONS[from].includes(to);
}

export const DatasetSplitSchema = z
  .object({
    name: z.enum(["train", "validation", "test", "holdout"]),
    sampleCount: z.number().int().nonnegative(),
    sha256: z.string().regex(SHA256_REGEX),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type DatasetSplit = z.infer<typeof DatasetSplitSchema>;

export const REDACTION_STRATEGIES = [
  "drop_row",
  "mask_token",
  "fake_replacement",
  "differential_privacy",
] as const;
export type RedactionStrategy = (typeof REDACTION_STRATEGIES)[number];

export const DatasetSchema = z
  .object({
    id: z.string().regex(DATASET_ID_REGEX),
    label: z.string().min(1),
    description: z.string().min(1),
    purpose: TrainingPurposeSchema,
    status: DatasetStatusSchema,
    sourceConsentIds: z.array(z.string().min(1)).min(1),
    dataClasses: z.array(DataClassSchema).min(1),
    redactionStrategy: z.enum(REDACTION_STRATEGIES),
    minimumKAnonymity: z.number().int().min(1).max(1000).default(5),
    splits: z.array(DatasetSplitSchema).min(1),
    totalSampleCount: z.number().int().min(1),
    totalSizeBytes: z.number().int().min(1),
    storageUri: z.string().regex(/^s3:\/\/[a-z0-9.-]+\/[A-Za-z0-9._\-/]+$/),
    createdAt: Iso8601,
    createdBy: z.string().min(1),
    frozenAt: Iso8601.nullable().default(null),
    frozenBy: z.string().min(1).nullable().default(null),
    frozenSha256: z.string().regex(SHA256_REGEX).nullable().default(null),
    deprecatedAt: Iso8601.nullable().default(null),
    deprecatedReason: z.string().min(1).optional(),
    purgedAt: Iso8601.nullable().default(null),
    purgedReason: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    const splitNames = new Set<string>();
    v.splits.forEach((s, i) => {
      if (splitNames.has(s.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["splits", i, "name"],
          message: `duplicate split '${s.name}'`,
        });
      }
      splitNames.add(s.name);
    });
    if (!splitNames.has("train")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["splits"],
        message: "dataset must include a 'train' split",
      });
    }
    const splitSum = v.splits.reduce((acc, s) => acc + s.sampleCount, 0);
    if (splitSum !== v.totalSampleCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalSampleCount"],
        message: `totalSampleCount (${v.totalSampleCount}) must equal sum of split sampleCount (${splitSum})`,
      });
    }
    const classSeen = new Set<string>();
    v.dataClasses.forEach((c, i) => {
      if (classSeen.has(c)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dataClasses", i],
          message: `duplicate data class '${c}'`,
        });
      }
      classSeen.add(c);
    });
    if (v.dataClasses.includes("phi") || v.dataClasses.includes("regulated")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dataClasses"],
        message: "datasets cannot include 'phi' or 'regulated' data classes",
      });
    }
    if (v.dataClasses.includes("pii") && v.redactionStrategy === "drop_row") {
      // OK
    } else if (
      v.dataClasses.includes("pii") &&
      v.redactionStrategy === "differential_privacy" &&
      v.minimumKAnonymity < 10
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minimumKAnonymity"],
        message: "PII + differential_privacy redaction requires minimumKAnonymity >= 10",
      });
    }
    if (v.status === "frozen") {
      if (v.frozenAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["frozenAt"],
          message: "frozen status requires frozenAt",
        });
      }
      if (v.frozenBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["frozenBy"],
          message: "frozen status requires frozenBy",
        });
      }
      if (v.frozenSha256 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["frozenSha256"],
          message: "frozen status requires frozenSha256 (content addressable hash)",
        });
      }
    }
    if (v.status === "deprecated") {
      if (v.deprecatedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deprecatedAt"],
          message: "deprecated status requires deprecatedAt",
        });
      }
      if (v.deprecatedReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deprecatedReason"],
          message: "deprecated status requires deprecatedReason",
        });
      }
    }
    if (v.status === "purged") {
      if (v.purgedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["purgedAt"],
          message: "purged status requires purgedAt",
        });
      }
      if (v.purgedReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["purgedReason"],
          message: "purged status requires purgedReason",
        });
      }
    }
    const consentSeen = new Set<string>();
    v.sourceConsentIds.forEach((c, i) => {
      if (consentSeen.has(c)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sourceConsentIds", i],
          message: `duplicate consent id '${c}'`,
        });
      }
      consentSeen.add(c);
    });
  });
export type Dataset = z.infer<typeof DatasetSchema>;

export function splitSampleCount(dataset: Dataset, name: DatasetSplit["name"]): number {
  return dataset.splits.find((s) => s.name === name)?.sampleCount ?? 0;
}

export function splitRatio(dataset: Dataset, name: DatasetSplit["name"]): number {
  if (dataset.totalSampleCount === 0) return 0;
  return splitSampleCount(dataset, name) / dataset.totalSampleCount;
}

export function isDatasetUsableForTraining(dataset: Dataset): boolean {
  return dataset.status === "frozen" && dataset.frozenSha256 !== null;
}
