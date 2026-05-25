import { z } from "zod";
import {
  DATA_CLASSIFICATIONS,
  isHigherSensitivity,
  maxSensitivityOf,
  type DataClassification,
} from "./nodes.js";

export const EDGE_KINDS = [
  "derived_from",
  "joined_with",
  "aggregated_from",
  "transformed_by",
  "redacted_from",
  "anonymized_from",
  "referenced_by",
  "copied_to",
  "predicted_by",
  "trained_on",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const CLASSIFICATION_DOWNGRADING_EDGES: ReadonlySet<EdgeKind> = new Set([
  "redacted_from",
  "anonymized_from",
  "aggregated_from",
]);

export const EDGE_KIND_OPERATIONS: Readonly<Record<EdgeKind, string>> = {
  derived_from: "transform",
  joined_with: "join",
  aggregated_from: "aggregate",
  transformed_by: "transform",
  redacted_from: "redact",
  anonymized_from: "anonymize",
  referenced_by: "reference",
  copied_to: "copy",
  predicted_by: "predict",
  trained_on: "train",
};

export const LineageEdgeSchema = z
  .object({
    id: z.string().regex(/^lne_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    kind: z.enum(EDGE_KINDS),
    sourceNodeId: z.string().regex(/^lng_[a-z0-9]{8,40}$/),
    targetNodeId: z.string().regex(/^lng_[a-z0-9]{8,40}$/),
    sourceClassification: z.enum(DATA_CLASSIFICATIONS),
    targetClassification: z.enum(DATA_CLASSIFICATIONS),
    columnsContributing: z.array(z.string().max(120)).default([]),
    columnsConsumed: z.array(z.string().max(120)).default([]),
    transformExpressionSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    rowCountConsumed: z.number().int().min(0).nullable(),
    rowCountProduced: z.number().int().min(0).nullable(),
    kAnonymityAchieved: z.number().int().min(1).nullable(),
    redactionRules: z.array(z.string().max(200)).default([]),
    provenanceRecordId: z
      .string()
      .regex(/^prv_[a-z0-9]{8,40}$/)
      .nullable(),
    createdAt: z.string().datetime({ offset: true }),
    createdByUserId: z.string().uuid().nullable(),
    createdBySystem: z.string().min(1).max(120).nullable(),
  })
  .superRefine((e, ctx) => {
    if (e.sourceNodeId === e.targetNodeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetNodeId"],
        message: "edge cannot connect node to itself",
      });
    }
    if (e.createdByUserId === null && e.createdBySystem === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["createdByUserId"],
        message: "either createdByUserId or createdBySystem must be set",
      });
    }
    if (
      !CLASSIFICATION_DOWNGRADING_EDGES.has(e.kind) &&
      isHigherSensitivity(e.sourceClassification, e.targetClassification)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetClassification"],
        message: `edge kind ${e.kind} cannot downgrade classification from ${e.sourceClassification} to ${e.targetClassification}`,
      });
    }
    if (
      (e.kind === "anonymized_from" || e.kind === "aggregated_from") &&
      e.kAnonymityAchieved === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kAnonymityAchieved"],
        message: `${e.kind} edge requires kAnonymityAchieved`,
      });
    }
    if (e.kind === "redacted_from" && e.redactionRules.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["redactionRules"],
        message: "redacted_from edge requires at least one redactionRule",
      });
    }
    if (e.kAnonymityAchieved !== null && e.kind === "anonymized_from" && e.kAnonymityAchieved < 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kAnonymityAchieved"],
        message:
          "anonymized_from edge requires kAnonymityAchieved >= 5 to downgrade classification",
      });
    }
  });
export type LineageEdge = z.infer<typeof LineageEdgeSchema>;

export interface PropagationInput {
  readonly edgeKind: EdgeKind;
  readonly inputClassifications: readonly DataClassification[];
  readonly kAnonymityAchieved: number | null;
  readonly allColumnsRedacted: boolean;
}

export const propagateClassification = (input: PropagationInput): DataClassification => {
  const inputMax = maxSensitivityOf(input.inputClassifications);
  if (input.edgeKind === "redacted_from" && input.allColumnsRedacted) {
    if (inputMax === "pii_personal" || inputMax === "phi_protected") {
      return "internal";
    }
  }
  if (
    input.edgeKind === "anonymized_from" &&
    input.kAnonymityAchieved !== null &&
    input.kAnonymityAchieved >= 5
  ) {
    if (inputMax === "pii_personal") return "public";
    if (inputMax === "phi_protected") return "internal";
  }
  if (
    input.edgeKind === "aggregated_from" &&
    input.kAnonymityAchieved !== null &&
    input.kAnonymityAchieved >= 11
  ) {
    if (inputMax === "phi_protected") return "internal";
    if (inputMax === "pii_personal") return "public";
  }
  return inputMax;
};

export const isValidDowngrade = (
  source: DataClassification,
  target: DataClassification,
  edgeKind: EdgeKind,
  kAnonymity: number | null,
): boolean => {
  if (!isHigherSensitivity(source, target)) return true;
  if (!CLASSIFICATION_DOWNGRADING_EDGES.has(edgeKind)) return false;
  if (edgeKind === "anonymized_from") {
    return kAnonymity !== null && kAnonymity >= 5;
  }
  if (edgeKind === "aggregated_from") {
    return kAnonymity !== null && kAnonymity >= 11;
  }
  return true;
};
