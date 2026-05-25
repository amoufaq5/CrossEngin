import { z } from "zod";

export const SUBJECT_IDENTIFIER_KINDS = [
  "email_address",
  "user_id",
  "external_user_id",
  "patient_mrn",
  "national_id",
  "tax_id",
  "phone_e164",
  "device_fingerprint",
  "ip_address",
  "pseudonymous_id",
] as const;
export type SubjectIdentifierKind = (typeof SUBJECT_IDENTIFIER_KINDS)[number];

export const STRONG_SUBJECT_IDENTIFIERS: ReadonlySet<SubjectIdentifierKind> = new Set([
  "email_address",
  "user_id",
  "patient_mrn",
  "national_id",
  "tax_id",
]);

export const SUBJECT_ACCESS_STATUSES = [
  "submitted",
  "verified",
  "in_progress",
  "partial_complete",
  "complete",
  "rejected",
  "deferred",
] as const;
export type SubjectAccessStatus = (typeof SUBJECT_ACCESS_STATUSES)[number];

export const SUBJECT_ACCESS_TRANSITIONS: Readonly<
  Record<SubjectAccessStatus, readonly SubjectAccessStatus[]>
> = {
  submitted: ["verified", "rejected"],
  verified: ["in_progress", "rejected"],
  in_progress: ["partial_complete", "complete", "rejected", "deferred"],
  partial_complete: ["complete", "rejected", "deferred"],
  deferred: ["in_progress", "rejected"],
  complete: [],
  rejected: [],
};

export const canTransitionSubjectAccess = (
  from: SubjectAccessStatus,
  to: SubjectAccessStatus,
): boolean => SUBJECT_ACCESS_TRANSITIONS[from].includes(to);

export const SUBJECT_ACCESS_LEGAL_BASES = [
  "gdpr_article_15",
  "ccpa_right_to_know",
  "lgpd_article_18",
  "pipeda_principle_9",
  "uae_data_protection_law",
  "custom_contract_obligation",
] as const;
export type SubjectAccessLegalBasis = (typeof SUBJECT_ACCESS_LEGAL_BASES)[number];

export const DELIVERY_FORMATS = [
  "json",
  "ndjson",
  "csv",
  "pdf_report",
  "machine_readable_archive",
] as const;
export type DeliveryFormat = (typeof DELIVERY_FORMATS)[number];

export const SUBJECT_DEADLINE_DAYS: Readonly<Record<SubjectAccessLegalBasis, number>> = {
  gdpr_article_15: 30,
  ccpa_right_to_know: 45,
  lgpd_article_18: 15,
  pipeda_principle_9: 30,
  uae_data_protection_law: 30,
  custom_contract_obligation: 30,
};

export const DataSubjectSchema = z
  .object({
    id: z.string().regex(/^ds_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid(),
    primaryIdentifierKind: z.enum(SUBJECT_IDENTIFIER_KINDS),
    primaryIdentifierSha256: z.string().regex(/^[0-9a-f]{64}$/),
    alternateIdentifiers: z
      .array(
        z.object({
          kind: z.enum(SUBJECT_IDENTIFIER_KINDS),
          identifierSha256: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      )
      .max(20)
      .default([]),
    isVerified: z.boolean(),
    verifiedAt: z.string().datetime({ offset: true }).nullable(),
    verificationMethod: z
      .enum([
        "email_link",
        "phone_otp",
        "in_app_re_authentication",
        "government_id_check",
        "in_person",
      ])
      .nullable(),
    firstSeenAt: z.string().datetime({ offset: true }),
    lastSeenAt: z.string().datetime({ offset: true }),
    nodeOccurrenceCount: z.number().int().min(0).default(0),
  })
  .superRefine((s, ctx) => {
    if (s.isVerified) {
      if (s.verifiedAt === null || s.verificationMethod === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verifiedAt"],
          message: "verified subject requires verifiedAt + verificationMethod",
        });
      }
    }
    const kinds = new Set<string>([s.primaryIdentifierKind]);
    for (const alt of s.alternateIdentifiers) {
      if (kinds.has(alt.kind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["alternateIdentifiers"],
          message: `duplicate identifier kind: ${alt.kind}`,
        });
        return;
      }
      kinds.add(alt.kind);
    }
    if (Date.parse(s.lastSeenAt) < Date.parse(s.firstSeenAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastSeenAt"],
        message: "lastSeenAt cannot precede firstSeenAt",
      });
    }
  });
export type DataSubject = z.infer<typeof DataSubjectSchema>;

export const SubjectNodeOccurrenceSchema = z.object({
  id: z.string().regex(/^sno_[a-z0-9]{8,40}$/),
  subjectId: z.string().regex(/^ds_[a-z0-9]{8,40}$/),
  nodeId: z.string().regex(/^lng_[a-z0-9]{8,40}$/),
  tenantId: z.string().uuid(),
  firstObservedAt: z.string().datetime({ offset: true }),
  lastObservedAt: z.string().datetime({ offset: true }),
  occurrenceCount: z.number().int().min(1),
  columnsContaining: z.array(z.string().max(120)).default([]),
  derivedThroughEdgeIds: z.array(z.string().regex(/^lne_[a-z0-9]{8,40}$/)).default([]),
});
export type SubjectNodeOccurrence = z.infer<typeof SubjectNodeOccurrenceSchema>;

export const SubjectAccessRequestSchema = z
  .object({
    id: z.string().regex(/^sar_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid(),
    subjectId: z.string().regex(/^ds_[a-z0-9]{8,40}$/),
    legalBasis: z.enum(SUBJECT_ACCESS_LEGAL_BASES),
    status: z.enum(SUBJECT_ACCESS_STATUSES),
    submittedAt: z.string().datetime({ offset: true }),
    submittedByContact: z.string().min(1).max(200),
    deadlineAt: z.string().datetime({ offset: true }),
    verifiedAt: z.string().datetime({ offset: true }).nullable(),
    inProgressAt: z.string().datetime({ offset: true }).nullable(),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    rejectedAt: z.string().datetime({ offset: true }).nullable(),
    rejectedReason: z.string().max(500).nullable(),
    deferredUntil: z.string().datetime({ offset: true }).nullable(),
    deferralReason: z.string().max(500).nullable(),
    requestedFormat: z.enum(DELIVERY_FORMATS),
    includeDerivedData: z.boolean(),
    nodeCount: z.number().int().min(0),
    edgeCount: z.number().int().min(0),
    bytesProduced: z.number().int().min(0).nullable(),
    bundleSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    bundleStorageUri: z.string().min(1).max(500).nullable(),
    bundleEncryptionKeyFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    deliveredAt: z.string().datetime({ offset: true }).nullable(),
    downloadCount: z.number().int().min(0).default(0),
    maxDownloads: z.number().int().min(1).max(10).default(3),
    notes: z.string().max(2000).optional(),
  })
  .superRefine((r, ctx) => {
    const expectedDeadlineDays = SUBJECT_DEADLINE_DAYS[r.legalBasis];
    const expectedDeadlineMs = Date.parse(r.submittedAt) + expectedDeadlineDays * 86_400_000;
    if (Date.parse(r.deadlineAt) > expectedDeadlineMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadlineAt"],
        message: `deadlineAt exceeds legal basis ${r.legalBasis} max (${expectedDeadlineDays} days from submission)`,
      });
    }
    if (r.status === "rejected") {
      if (r.rejectedAt === null || r.rejectedReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rejectedReason"],
          message: "rejected request requires rejectedAt + rejectedReason",
        });
      }
    }
    if (r.status === "deferred") {
      if (r.deferredUntil === null || r.deferralReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deferralReason"],
          message: "deferred request requires deferredUntil + deferralReason",
        });
      }
    }
    if (r.status === "complete") {
      if (r.completedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: "complete request requires completedAt",
        });
      }
      if (
        r.bundleSha256 === null ||
        r.bundleStorageUri === null ||
        r.bundleEncryptionKeyFingerprint === null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bundleSha256"],
          message:
            "complete request requires bundleSha256 + bundleStorageUri + bundleEncryptionKeyFingerprint",
        });
      }
    }
    if (r.downloadCount > r.maxDownloads) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["downloadCount"],
        message: "downloadCount cannot exceed maxDownloads",
      });
    }
  });
export type SubjectAccessRequest = z.infer<typeof SubjectAccessRequestSchema>;

export const isRequestOverdue = (request: SubjectAccessRequest, now: Date): boolean => {
  if (request.status === "complete" || request.status === "rejected") {
    return false;
  }
  return now.getTime() > Date.parse(request.deadlineAt);
};

export const computeDeadline = (submittedAt: Date, legalBasis: SubjectAccessLegalBasis): string => {
  const days = SUBJECT_DEADLINE_DAYS[legalBasis];
  return new Date(submittedAt.getTime() + days * 86_400_000).toISOString();
};

export const isStrongIdentifier = (kind: SubjectIdentifierKind): boolean =>
  STRONG_SUBJECT_IDENTIFIERS.has(kind);
