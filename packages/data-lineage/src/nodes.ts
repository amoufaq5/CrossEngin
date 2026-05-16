import { z } from "zod";

export const LINEAGE_NODE_KINDS = [
  "source_table",
  "derived_table",
  "dataset",
  "ml_model",
  "ml_evaluation",
  "report",
  "dashboard",
  "tenant_export",
  "ai_call_output",
  "search_index_document",
  "materialized_view",
  "file_artifact",
  "aggregation_result",
  "redacted_view",
] as const;
export type LineageNodeKind = (typeof LINEAGE_NODE_KINDS)[number];

export const DATA_CLASSIFICATIONS = [
  "public",
  "internal",
  "confidential",
  "pii_personal",
  "phi_protected",
  "regulated_financial",
] as const;
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export const CLASSIFICATION_SENSITIVITY: Readonly<
  Record<DataClassification, number>
> = {
  public: 0,
  internal: 1,
  confidential: 2,
  pii_personal: 3,
  regulated_financial: 4,
  phi_protected: 5,
};

export const REGULATED_CLASSIFICATIONS: ReadonlySet<DataClassification> = new Set(
  ["pii_personal", "phi_protected", "regulated_financial"],
);

export const NODE_LIFECYCLE_STATUSES = [
  "active",
  "frozen",
  "archived",
  "purged",
  "tombstoned",
] as const;
export type NodeLifecycleStatus = (typeof NODE_LIFECYCLE_STATUSES)[number];

export const NODE_LIFECYCLE_TRANSITIONS: Readonly<
  Record<NodeLifecycleStatus, readonly NodeLifecycleStatus[]>
> = {
  active: ["frozen", "archived", "purged", "tombstoned"],
  frozen: ["archived", "purged", "tombstoned"],
  archived: ["purged", "tombstoned"],
  purged: ["tombstoned"],
  tombstoned: [],
};

export const canTransitionNode = (
  from: NodeLifecycleStatus,
  to: NodeLifecycleStatus,
): boolean => NODE_LIFECYCLE_TRANSITIONS[from].includes(to);

export const LineageNodeSchema = z
  .object({
    id: z.string().regex(/^lng_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    kind: z.enum(LINEAGE_NODE_KINDS),
    label: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    status: z.enum(NODE_LIFECYCLE_STATUSES),
    classification: z.enum(DATA_CLASSIFICATIONS),
    rowCount: z.number().int().min(0).nullable(),
    columnCount: z.number().int().min(0).max(10_000).nullable(),
    sizeBytes: z.number().int().min(0).nullable(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    storageUri: z.string().min(1).max(500).nullable(),
    externalRef: z.object({
      kind: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80),
      id: z.string().min(1).max(200),
    }).nullable(),
    sourcePackage: z.string().regex(/^@crossengin\/[a-z][a-z0-9-]*$/).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    createdByUserId: z.string().uuid().nullable(),
    createdBySystem: z.string().min(1).max(120).nullable(),
    frozenAt: z.string().datetime({ offset: true }).nullable(),
    frozenSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    purgedAt: z.string().datetime({ offset: true }).nullable(),
    tombstonedAt: z.string().datetime({ offset: true }).nullable(),
    retentionUntil: z.string().datetime({ offset: true }).nullable(),
    minimumKAnonymity: z.number().int().min(1).max(10_000).nullable(),
  })
  .superRefine((n, ctx) => {
    if (n.createdByUserId === null && n.createdBySystem === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["createdByUserId"],
        message: "either createdByUserId or createdBySystem must be set",
      });
    }
    if (n.status === "frozen") {
      if (n.frozenAt === null || n.frozenSha256 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["frozenAt"],
          message: "frozen node requires frozenAt + frozenSha256",
        });
      }
    }
    if (n.status === "purged" && n.purgedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["purgedAt"],
        message: "purged node requires purgedAt",
      });
    }
    if (n.status === "tombstoned" && n.tombstonedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tombstonedAt"],
        message: "tombstoned node requires tombstonedAt",
      });
    }
    if (n.kind === "aggregation_result" && n.minimumKAnonymity === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minimumKAnonymity"],
        message:
          "aggregation_result requires minimumKAnonymity (k-anonymity floor)",
      });
    }
    if (
      n.kind === "redacted_view" &&
      n.classification === "pii_personal"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["classification"],
        message:
          "redacted_view classification must downgrade from pii_personal (use internal/public)",
      });
    }
    if (
      n.kind === "tenant_export" &&
      n.tenantId === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tenantId"],
        message: "tenant_export requires tenantId",
      });
    }
  });
export type LineageNode = z.infer<typeof LineageNodeSchema>;

export const isRegulatedNode = (node: LineageNode): boolean =>
  REGULATED_CLASSIFICATIONS.has(node.classification);

export const isHigherSensitivity = (
  a: DataClassification,
  b: DataClassification,
): boolean => CLASSIFICATION_SENSITIVITY[a] > CLASSIFICATION_SENSITIVITY[b];

export const maxSensitivityOf = (
  classifications: readonly DataClassification[],
): DataClassification => {
  if (classifications.length === 0) return "public";
  let max: DataClassification = "public";
  for (const c of classifications) {
    if (isHigherSensitivity(c, max)) max = c;
  }
  return max;
};

export const isWithinRetention = (
  node: LineageNode,
  now: Date,
): boolean => {
  if (node.retentionUntil === null) return true;
  return now.getTime() < Date.parse(node.retentionUntil);
};
