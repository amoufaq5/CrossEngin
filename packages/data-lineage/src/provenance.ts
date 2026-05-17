import { z } from "zod";
import { EDGE_KINDS } from "./edges.js";

export const PROVENANCE_OPERATION_KINDS = [
  "ingest",
  "transform",
  "join",
  "aggregate",
  "redact",
  "anonymize",
  "train",
  "evaluate",
  "predict",
  "export",
  "query",
  "index",
  "ai_inference",
  "copy_to_region",
  "tombstone",
] as const;
export type ProvenanceOperationKind =
  (typeof PROVENANCE_OPERATION_KINDS)[number];

export const PROVENANCE_OUTCOMES = [
  "succeeded",
  "partial_succeeded",
  "failed",
  "rolled_back",
] as const;
export type ProvenanceOutcome = (typeof PROVENANCE_OUTCOMES)[number];

export const REGULATED_OPERATIONS: ReadonlySet<ProvenanceOperationKind> = new Set([
  "redact",
  "anonymize",
  "export",
  "ai_inference",
  "tombstone",
]);

export const ProvenanceRecordSchema = z
  .object({
    id: z.string().regex(/^prv_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    operationKind: z.enum(PROVENANCE_OPERATION_KINDS),
    edgeKind: z.enum(EDGE_KINDS).nullable(),
    occurredAt: z.string().datetime({ offset: true }),
    actorPrincipalId: z.string().uuid().nullable(),
    actorSystemId: z.string().min(1).max(120).nullable(),
    actorPackage: z
      .string()
      .regex(/^@crossengin\/[a-z][a-z0-9-]*$/)
      .nullable(),
    inputNodeIds: z.array(z.string().regex(/^lng_[a-z0-9]{8,40}$/)).default([]),
    outputNodeIds: z
      .array(z.string().regex(/^lng_[a-z0-9]{8,40}$/))
      .min(1)
      .max(1000),
    operationParametersSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    operationCodeSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    relatedWorkflowInstanceId: z
      .string()
      .regex(/^wfi_[a-z0-9]{8,40}$/)
      .nullable(),
    relatedActivityId: z
      .string()
      .regex(/^wfa_[a-z0-9]{8,40}$/)
      .nullable(),
    relatedJobRunId: z
      .string()
      .max(120)
      .nullable(),
    outcome: z.enum(PROVENANCE_OUTCOMES),
    durationMs: z.number().int().min(0).max(86_400_000).nullable(),
    rowsRead: z.number().int().min(0).nullable(),
    rowsWritten: z.number().int().min(0).nullable(),
    errorCode: z.string().max(80).nullable(),
    errorMessage: z.string().max(500).nullable(),
    rolledBackAt: z.string().datetime({ offset: true }).nullable(),
    rolledBackReason: z.string().max(500).nullable(),
    causedByProvenanceId: z
      .string()
      .regex(/^prv_[a-z0-9]{8,40}$/)
      .nullable(),
  })
  .superRefine((p, ctx) => {
    if (p.actorPrincipalId === null && p.actorSystemId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actorPrincipalId"],
        message: "either actorPrincipalId or actorSystemId must be set",
      });
    }
    if (
      p.operationKind === "ingest" &&
      p.inputNodeIds.length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputNodeIds"],
        message: "ingest operation cannot have inputNodeIds (it is the entry point)",
      });
    }
    if (
      p.operationKind !== "ingest" &&
      p.operationKind !== "tombstone" &&
      p.inputNodeIds.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputNodeIds"],
        message: `${p.operationKind} operation requires at least one inputNodeId`,
      });
    }
    if (p.outcome === "failed") {
      if (p.errorCode === null || p.errorMessage === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["errorCode"],
          message: "failed outcome requires errorCode + errorMessage",
        });
      }
    }
    if (p.outcome === "rolled_back") {
      if (p.rolledBackAt === null || p.rolledBackReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rolledBackReason"],
          message: "rolled_back outcome requires rolledBackAt + rolledBackReason",
        });
      }
    }
    if (
      REGULATED_OPERATIONS.has(p.operationKind) &&
      p.operationParametersSha256 === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operationParametersSha256"],
        message:
          "regulated operations require operationParametersSha256 for audit reproducibility",
      });
    }
    const outputSet = new Set(p.outputNodeIds);
    for (const id of p.inputNodeIds) {
      if (outputSet.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputNodeIds"],
          message: `node ${id} cannot be both input and output of the same provenance record`,
        });
        return;
      }
    }
  });
export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>;

export const isProvenanceImmutable = (
  record: ProvenanceRecord,
): boolean =>
  record.outcome === "succeeded" || record.outcome === "partial_succeeded";

export const requiresRegulatoryAudit = (
  record: ProvenanceRecord,
): boolean => REGULATED_OPERATIONS.has(record.operationKind);

export interface ProvenanceAggregateStats {
  readonly totalRecords: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly rolledBackCount: number;
  readonly operationCounts: Readonly<
    Partial<Record<ProvenanceOperationKind, number>>
  >;
  readonly regulatedOperationCount: number;
  readonly totalRowsRead: number;
  readonly totalRowsWritten: number;
}

export const aggregateProvenance = (
  records: readonly ProvenanceRecord[],
): ProvenanceAggregateStats => {
  const operationCounts: Partial<Record<ProvenanceOperationKind, number>> = {};
  let succeededCount = 0;
  let failedCount = 0;
  let rolledBackCount = 0;
  let regulatedOperationCount = 0;
  let totalRowsRead = 0;
  let totalRowsWritten = 0;
  for (const r of records) {
    operationCounts[r.operationKind] =
      (operationCounts[r.operationKind] ?? 0) + 1;
    if (r.outcome === "succeeded" || r.outcome === "partial_succeeded") {
      succeededCount++;
    }
    if (r.outcome === "failed") failedCount++;
    if (r.outcome === "rolled_back") rolledBackCount++;
    if (REGULATED_OPERATIONS.has(r.operationKind)) regulatedOperationCount++;
    totalRowsRead += r.rowsRead ?? 0;
    totalRowsWritten += r.rowsWritten ?? 0;
  }
  return {
    totalRecords: records.length,
    succeededCount,
    failedCount,
    rolledBackCount,
    operationCounts,
    regulatedOperationCount,
    totalRowsRead,
    totalRowsWritten,
  };
};
