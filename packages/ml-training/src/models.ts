import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;
const MODEL_ID_REGEX = /^mdl_[a-z0-9-]{4,40}$/;
const RUN_ID_REGEX = /^train_[a-z0-9]{8,32}$/;

export const MODEL_LIFECYCLE_STATUSES = [
  "draft",
  "evaluating",
  "approved",
  "shadow",
  "canary",
  "production",
  "deprecated",
  "retired",
] as const;
export type ModelLifecycleStatus = (typeof MODEL_LIFECYCLE_STATUSES)[number];
export const ModelLifecycleStatusSchema = z.enum(MODEL_LIFECYCLE_STATUSES);

export const MODEL_TRANSITIONS: Readonly<
  Record<ModelLifecycleStatus, readonly ModelLifecycleStatus[]>
> = Object.freeze({
  draft: ["evaluating", "retired"],
  evaluating: ["approved", "draft", "retired"],
  approved: ["shadow", "canary", "production", "retired"],
  shadow: ["canary", "approved", "retired"],
  canary: ["production", "approved", "retired"],
  production: ["deprecated"],
  deprecated: ["retired"],
  retired: [],
});

export function canTransitionModel(
  from: ModelLifecycleStatus,
  to: ModelLifecycleStatus,
): boolean {
  return MODEL_TRANSITIONS[from].includes(to);
}

export const MODEL_FAMILIES = [
  "manifest_proposer",
  "sql_codegen",
  "permission_classifier",
  "redaction_classifier",
  "summarizer",
  "embeddings",
  "safety_filter",
  "intent_classifier",
] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];
export const ModelFamilySchema = z.enum(MODEL_FAMILIES);

export const ModelCardSchema = z
  .object({
    intendedUse: z.string().min(1),
    knownLimitations: z.array(z.string().min(1)).min(1),
    trainingDataSummary: z.string().min(1),
    fairnessConsiderations: z.string().min(1).optional(),
    evaluationSummary: z.string().min(1),
    contactOwner: z.string().min(1),
  })
  .strict();
export type ModelCard = z.infer<typeof ModelCardSchema>;

export const ModelRegistryEntrySchema = z
  .object({
    id: z.string().regex(MODEL_ID_REGEX),
    family: ModelFamilySchema,
    label: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    baseModelId: z.string().min(1),
    trainingRunId: z.string().regex(RUN_ID_REGEX).nullable(),
    artifactSha256: z.string().regex(SHA256_REGEX),
    artifactStorageUri: z.string().min(1),
    sizeBytes: z.number().int().min(1),
    status: ModelLifecycleStatusSchema,
    card: ModelCardSchema,
    blockingEvalRunIds: z.array(z.string().min(1)).default([]),
    canaryTrafficPercent: z.number().int().min(0).max(100).nullable().default(null),
    promotedToProductionAt: Iso8601.nullable().default(null),
    promotedToProductionBy: z.string().min(1).nullable().default(null),
    deprecatedAt: Iso8601.nullable().default(null),
    deprecatedReason: z.string().min(1).optional(),
    supersededBy: z.string().regex(MODEL_ID_REGEX).optional(),
    retiredAt: Iso8601.nullable().default(null),
    retiredReason: z.string().min(1).optional(),
    createdAt: Iso8601,
    createdBy: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.status === "canary") {
      if (v.canaryTrafficPercent === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["canaryTrafficPercent"],
          message: "canary status requires canaryTrafficPercent",
        });
      } else if (v.canaryTrafficPercent === 0 || v.canaryTrafficPercent >= 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["canaryTrafficPercent"],
          message: "canary canaryTrafficPercent must be in (0, 100)",
        });
      }
    }
    if (v.status !== "canary" && v.canaryTrafficPercent !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canaryTrafficPercent"],
        message: `non-canary status '${v.status}' must have canaryTrafficPercent=null`,
      });
    }
    if (v.status === "production") {
      if (v.promotedToProductionAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["promotedToProductionAt"],
          message: "production status requires promotedToProductionAt",
        });
      }
      if (v.promotedToProductionBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["promotedToProductionBy"],
          message: "production status requires promotedToProductionBy",
        });
      }
      if (v.blockingEvalRunIds.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["blockingEvalRunIds"],
          message:
            "production models must reference at least one passing blocking eval run",
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
    if (v.status === "retired") {
      if (v.retiredAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retiredAt"],
          message: "retired status requires retiredAt",
        });
      }
      if (v.retiredReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retiredReason"],
          message: "retired status requires retiredReason",
        });
      }
    }
    const evalSet = new Set<string>();
    v.blockingEvalRunIds.forEach((id, i) => {
      if (evalSet.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["blockingEvalRunIds", i],
          message: `duplicate eval run id '${id}'`,
        });
      }
      evalSet.add(id);
    });
    if (v.card.knownLimitations.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["card", "knownLimitations"],
        message: "model card must list at least one known limitation",
      });
    }
    if (
      (v.family === "safety_filter" ||
        v.family === "permission_classifier" ||
        v.family === "redaction_classifier") &&
      v.card.fairnessConsiderations === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["card", "fairnessConsiderations"],
        message: `model family '${v.family}' requires fairnessConsiderations`,
      });
    }
  });
export type ModelRegistryEntry = z.infer<typeof ModelRegistryEntrySchema>;

export const ModelRegistrySchema = z
  .array(ModelRegistryEntrySchema)
  .superRefine((entries, ctx) => {
    const ids = new Set<string>();
    entries.forEach((e, i) => {
      if (ids.has(e.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "id"],
          message: `duplicate model id '${e.id}'`,
        });
      }
      ids.add(e.id);
    });
    const productionPerFamily = new Map<string, number>();
    for (const e of entries) {
      if (e.status === "production") {
        productionPerFamily.set(e.family, (productionPerFamily.get(e.family) ?? 0) + 1);
      }
    }
    for (const [family, count] of productionPerFamily) {
      if (count > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [],
          message: `family '${family}' has ${count.toString()} production models; only one is allowed at a time`,
        });
      }
    }
  });
export type ModelRegistry = z.infer<typeof ModelRegistrySchema>;

export function currentProductionModel(
  registry: ModelRegistry,
  family: ModelFamily,
): ModelRegistryEntry | null {
  return (
    registry.find(
      (e) => e.family === family && e.status === "production",
    ) ?? null
  );
}

export function isModelServable(entry: ModelRegistryEntry): boolean {
  return (
    entry.status === "production" ||
    entry.status === "canary" ||
    entry.status === "shadow"
  );
}

export function canaryAggregate(
  registry: ModelRegistry,
  family: ModelFamily,
): number {
  return registry
    .filter((e) => e.family === family && e.status === "canary")
    .reduce((acc, e) => acc + (e.canaryTrafficPercent ?? 0), 0);
}
