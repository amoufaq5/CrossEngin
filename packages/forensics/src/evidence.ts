import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;
const EVIDENCE_ID_REGEX = /^EV-\d{4}-\d{4,8}$/;

export const EVIDENCE_KINDS = [
  "log_export",
  "database_snapshot",
  "file_artifact",
  "network_capture",
  "memory_dump",
  "configuration_snapshot",
  "screenshot",
  "video_recording",
  "witness_statement",
  "expert_report",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);

export const EVIDENCE_SENSITIVITY = [
  "public",
  "internal",
  "confidential",
  "phi_protected",
  "attorney_client_privileged",
  "national_security",
] as const;
export type EvidenceSensitivity = (typeof EVIDENCE_SENSITIVITY)[number];

export const EVIDENCE_PROVENANCE = [
  "automated_collection",
  "human_collection",
  "forensic_imaging",
  "subpoena_response",
  "third_party_provided",
] as const;
export type EvidenceProvenance = (typeof EVIDENCE_PROVENANCE)[number];

export const EvidenceItemSchema = z
  .object({
    id: z.string().regex(EVIDENCE_ID_REGEX, {
      message: "evidence id must match 'EV-YYYY-NNNN'",
    }),
    caseId: z.string().min(1),
    kind: EvidenceKindSchema,
    sensitivity: z.enum(EVIDENCE_SENSITIVITY),
    provenance: z.enum(EVIDENCE_PROVENANCE),
    label: z.string().min(1),
    description: z.string().min(1),
    sourceSystem: z.string().min(1),
    collectedAt: Iso8601,
    collectedBy: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(SHA256_REGEX),
    storageUri: z.string().min(1),
    encryptionKeyFingerprint: z.string().regex(SHA256_REGEX),
    sealedAt: Iso8601,
    sealedBy: z.string().min(1),
    contentRedactedSha256: z.string().regex(SHA256_REGEX).nullable().default(null),
    relatedIncidentId: z.string().min(1).optional(),
    relatedTenantId: z.string().min(1).optional(),
    retentionUntil: Iso8601,
    legalHoldIds: z.array(z.string().min(1)).default([]),
    destroyedAt: Iso8601.nullable().default(null),
    destroyedReason: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (new Date(v.sealedAt).getTime() < new Date(v.collectedAt).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sealedAt"],
        message: "sealedAt cannot be before collectedAt",
      });
    }
    if (new Date(v.retentionUntil).getTime() <= new Date(v.collectedAt).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retentionUntil"],
        message: "retentionUntil must be after collectedAt",
      });
    }
    if (v.collectedBy === v.sealedBy && v.kind !== "automated_collection" as never) {
      // collectedBy and sealedBy must differ for human collection (two-person integrity)
      if (v.provenance === "human_collection" || v.provenance === "forensic_imaging") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sealedBy"],
          message: "collectedBy and sealedBy must differ (two-person integrity)",
        });
      }
    }
    if (v.destroyedAt !== null) {
      if (v.destroyedReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["destroyedReason"],
          message: "destroyedAt requires destroyedReason",
        });
      }
      if (v.legalHoldIds.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["destroyedAt"],
          message: "cannot destroy evidence subject to legal hold",
        });
      }
    }
    if (
      v.sensitivity === "attorney_client_privileged" &&
      v.provenance === "automated_collection"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provenance"],
        message:
          "attorney_client_privileged evidence cannot be 'automated_collection' (privilege requires human attestation)",
      });
    }
    const holds = new Set<string>();
    v.legalHoldIds.forEach((h, i) => {
      if (holds.has(h)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["legalHoldIds", i],
          message: `duplicate legal hold '${h}'`,
        });
      }
      holds.add(h);
    });
  });
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export function isEvidenceSealed(item: EvidenceItem): boolean {
  return item.destroyedAt === null;
}

export function isEvidenceRetentionExpired(
  item: EvidenceItem,
  now: Date = new Date(),
): boolean {
  return now.getTime() >= new Date(item.retentionUntil).getTime();
}

export function canDestroyEvidence(
  item: EvidenceItem,
  now: Date = new Date(),
): boolean {
  if (item.destroyedAt !== null) return false;
  if (item.legalHoldIds.length > 0) return false;
  return isEvidenceRetentionExpired(item, now);
}
