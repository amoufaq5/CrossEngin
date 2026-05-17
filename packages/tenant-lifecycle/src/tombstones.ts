import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;
const TOMBSTONE_ID_REGEX = /^tomb_[A-Za-z0-9_-]{12,40}$/;

export const TOMBSTONE_KINDS = [
  "tenant_deletion",
  "user_deletion",
  "data_subject_erasure",
  "scheduled_purge",
  "abandoned_export_purge",
] as const;
export type TombstoneKind = (typeof TOMBSTONE_KINDS)[number];
export const TombstoneKindSchema = z.enum(TOMBSTONE_KINDS);

export const ANCHOR_KINDS = [
  "internal_audit_log",
  "trillian_log",
  "blockchain_anchor",
  "rfc3161_timestamp",
] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

export const TombstoneAnchorSchema = z
  .object({
    kind: z.enum(ANCHOR_KINDS),
    reference: z.string().min(1),
    anchoredAt: Iso8601,
    proofUrl: z.string().url().optional(),
  })
  .strict();
export type TombstoneAnchor = z.infer<typeof TombstoneAnchorSchema>;

export const DeletionScopeSchema = z
  .object({
    schemas: z.array(z.string().min(1)).default([]),
    tables: z.array(z.string().min(1)).default([]),
    objectStorageBuckets: z.array(z.string().min(1)).default([]),
    backupGenerations: z.array(z.string().min(1)).default([]),
    searchIndexes: z.array(z.string().min(1)).default([]),
    cacheKeys: z.array(z.string().min(1)).default([]),
    rowCount: z.number().int().nonnegative(),
    storageBytes: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
  })
  .strict();
export type DeletionScope = z.infer<typeof DeletionScopeSchema>;

export const TombstoneRecordSchema = z
  .object({
    id: z.string().regex(TOMBSTONE_ID_REGEX),
    kind: TombstoneKindSchema,
    tenantId: z.string().min(1),
    subjectIdentifier: z.string().min(1).optional(),
    relatedDeletionRequestId: z.string().min(1).optional(),
    deletedAt: Iso8601,
    executedBy: z.string().min(1),
    approvedBy: z.string().min(1),
    scope: DeletionScopeSchema,
    contentManifestSha256: z.string().regex(SHA256_REGEX),
    proofSha256: z.string().regex(SHA256_REGEX),
    anchors: z.array(TombstoneAnchorSchema).min(1),
    retainedReason: z.string().min(1).optional(),
    retainedDataReference: z.string().min(1).optional(),
    invalidationOfPriorTombstoneId: z
      .string()
      .regex(TOMBSTONE_ID_REGEX)
      .nullable()
      .default(null),
  })
  .superRefine((v, ctx) => {
    if (v.executedBy === v.approvedBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvedBy"],
        message: "executedBy and approvedBy must differ (four-eyes principle)",
      });
    }
    if (
      v.kind === "data_subject_erasure" &&
      v.relatedDeletionRequestId === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relatedDeletionRequestId"],
        message: "data_subject_erasure tombstones must reference a deletion request",
      });
    }
    if (v.kind === "user_deletion" && v.subjectIdentifier === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subjectIdentifier"],
        message: "user_deletion tombstones must declare subjectIdentifier",
      });
    }
    if (v.kind === "tenant_deletion" || v.kind === "scheduled_purge") {
      const totalScope =
        v.scope.schemas.length +
        v.scope.tables.length +
        v.scope.objectStorageBuckets.length +
        v.scope.backupGenerations.length;
      if (totalScope === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scope"],
          message: `kind '${v.kind}' must declare at least one schema/table/bucket/backup`,
        });
      }
    }
    if (v.scope.rowCount > 0 && v.scope.tables.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope", "tables"],
        message: "rowCount > 0 requires at least one table in scope",
      });
    }
    if (v.scope.fileCount > 0 && v.scope.objectStorageBuckets.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope", "objectStorageBuckets"],
        message: "fileCount > 0 requires at least one objectStorageBucket in scope",
      });
    }
    if (v.retainedReason !== undefined && v.retainedDataReference === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retainedDataReference"],
        message: "retainedReason requires retainedDataReference (audit trail)",
      });
    }
    const anchorKinds = new Set<string>();
    v.anchors.forEach((a, i) => {
      const dedupKey = `${a.kind}|${a.reference}`;
      if (anchorKinds.has(dedupKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["anchors", i],
          message: `duplicate anchor (${a.kind}, ${a.reference})`,
        });
      }
      anchorKinds.add(dedupKey);
    });
  });
export type TombstoneRecord = z.infer<typeof TombstoneRecordSchema>;

export function tombstoneAge(
  record: TombstoneRecord,
  now: Date = new Date(),
): number {
  return Math.floor(
    (now.getTime() - new Date(record.deletedAt).getTime()) / 1000 / 86_400,
  );
}

export function tombstonesByKind(
  records: readonly TombstoneRecord[],
  kind: TombstoneKind,
): readonly TombstoneRecord[] {
  return records.filter((r) => r.kind === kind);
}

export function tombstoneChainFor(
  records: readonly TombstoneRecord[],
  tenantId: string,
): readonly TombstoneRecord[] {
  return [...records]
    .filter((r) => r.tenantId === tenantId)
    .sort((a, b) => new Date(a.deletedAt).getTime() - new Date(b.deletedAt).getTime());
}

export function isCryptographicallyAnchored(record: TombstoneRecord): boolean {
  return record.anchors.some(
    (a) =>
      a.kind === "trillian_log" ||
      a.kind === "blockchain_anchor" ||
      a.kind === "rfc3161_timestamp",
  );
}
