import { z } from "zod";
import { DATA_CLASSES } from "@crossengin/jobs";

export const FILE_STATUSES = [
  "uploading",
  "scanning",
  "available",
  "quarantined",
  "archived",
  "deleting",
] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export const FileStatusSchema = z.enum(FILE_STATUSES);

export const OCR_STATUSES = ["pending", "done", "skipped", "failed"] as const;
export type OcrStatus = (typeof OCR_STATUSES)[number];

export const EMBEDDING_STATUSES = ["pending", "done", "skipped", "failed"] as const;
export type EmbeddingStatus = (typeof EMBEDDING_STATUSES)[number];

export const LIFECYCLE_PHASES = ["hot", "archive", "cold", "delete"] as const;
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

const Iso8601 = z.string().datetime({ offset: true });
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, {
  message: "checksum_sha256 must be 64 lowercase hex chars",
});
const Uuid = z.string().min(1);
const MimeType = z.string().regex(/^[a-z0-9-]+\/[a-z0-9.+\-_]+$/i, {
  message: "mime_type must be 'type/subtype'",
});

export const FileReferenceSchema = z
  .object({
    id: Uuid,
    tenantId: Uuid,
    storageKey: z.string().min(1),
    filename: z.string().min(1).max(512),
    mimeType: MimeType,
    sizeBytes: z.number().int().nonnegative(),
    checksumSha256: Sha256,
    status: FileStatusSchema,
    uploadedBy: Uuid,
    uploadedAt: Iso8601,
    scannedAt: Iso8601.nullable().default(null),
    ocrStatus: z.enum(OCR_STATUSES).nullable().default(null),
    ocrTextKey: z.string().min(1).nullable().default(null),
    embeddingStatus: z.enum(EMBEDDING_STATUSES).nullable().default(null),
    retentionClass: z.string().min(1),
    archiveAfter: Iso8601.nullable().default(null),
    deleteAfter: Iso8601.nullable().default(null),
    dataClass: z.enum(DATA_CLASSES),
    fileTypeId: z.string().min(1),
    region: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((v, ctx) => {
    if (
      v.archiveAfter !== null &&
      v.deleteAfter !== null &&
      new Date(v.archiveAfter) > new Date(v.deleteAfter)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["archiveAfter"],
        message: "archiveAfter must be <= deleteAfter",
      });
    }
    if (v.status === "available" && v.scannedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scannedAt"],
        message: "files in 'available' status must have scannedAt set",
      });
    }
  });
export type FileReference = z.infer<typeof FileReferenceSchema>;

export const FILE_STATUS_TRANSITIONS: Readonly<Record<FileStatus, readonly FileStatus[]>> =
  Object.freeze({
    uploading: ["scanning", "deleting"],
    scanning: ["available", "quarantined", "deleting"],
    available: ["archived", "quarantined", "deleting"],
    archived: ["available", "deleting"],
    quarantined: ["deleting"],
    deleting: [],
  });

export function canTransition(from: FileStatus, to: FileStatus): boolean {
  return FILE_STATUS_TRANSITIONS[from].includes(to);
}
