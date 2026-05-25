import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;

export const GDPR_LEGAL_BASES = [
  "article_17_right_to_erasure",
  "article_21_objection_to_processing",
  "data_subject_request",
  "consent_withdrawn",
  "contract_terminated",
  "no_lawful_basis_remaining",
] as const;
export type GdprLegalBasis = (typeof GDPR_LEGAL_BASES)[number];
export const GdprLegalBasisSchema = z.enum(GDPR_LEGAL_BASES);

export const RETENTION_OBLIGATIONS = [
  "tax_records_7y",
  "medical_records_10y",
  "audit_logs_3y",
  "financial_transactions_7y",
  "anti_money_laundering_5y",
  "none",
] as const;
export type RetentionObligation = (typeof RETENTION_OBLIGATIONS)[number];

export const DELETION_REQUEST_STATUSES = [
  "submitted",
  "verified",
  "in_progress",
  "completed",
  "rejected",
  "deferred",
] as const;
export type DeletionRequestStatus = (typeof DELETION_REQUEST_STATUSES)[number];
export const DeletionRequestStatusSchema = z.enum(DELETION_REQUEST_STATUSES);

export const DELETION_REQUEST_TRANSITIONS: Readonly<
  Record<DeletionRequestStatus, readonly DeletionRequestStatus[]>
> = Object.freeze({
  submitted: ["verified", "rejected"],
  verified: ["in_progress", "deferred", "rejected"],
  in_progress: ["completed", "rejected"],
  deferred: ["in_progress", "rejected"],
  completed: [],
  rejected: [],
});

export function canTransitionDeletionRequest(
  from: DeletionRequestStatus,
  to: DeletionRequestStatus,
): boolean {
  return DELETION_REQUEST_TRANSITIONS[from].includes(to);
}

export const VERIFICATION_METHODS = [
  "email_link",
  "phone_otp",
  "in_app_re_authentication",
  "government_id_check",
  "in_person",
] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export const GdprDeletionRequestSchema = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    subjectIdentifier: z.string().min(1),
    legalBasis: GdprLegalBasisSchema,
    status: DeletionRequestStatusSchema,
    submittedAt: Iso8601,
    submittedBy: z.string().min(1),
    deadlineAt: Iso8601,
    verificationMethod: z.enum(VERIFICATION_METHODS).nullable().default(null),
    verifiedAt: Iso8601.nullable().default(null),
    verifiedBy: z.string().min(1).nullable().default(null),
    inProgressAt: Iso8601.nullable().default(null),
    completedAt: Iso8601.nullable().default(null),
    completionSha256: z.string().regex(SHA256_REGEX).nullable().default(null),
    rejectedAt: Iso8601.nullable().default(null),
    rejectedReason: z.string().min(1).optional(),
    deferredUntil: Iso8601.nullable().default(null),
    deferralReason: z.string().min(1).optional(),
    retentionObligations: z.array(z.enum(RETENTION_OBLIGATIONS)).default(["none"]),
    retainedDataCategories: z.array(z.string().min(1)).default([]),
    notes: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    const submittedMs = new Date(v.submittedAt).getTime();
    const deadlineMs = new Date(v.deadlineAt).getTime();
    if (deadlineMs <= submittedMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadlineAt"],
        message: "deadlineAt must be after submittedAt",
      });
    }
    const oneMonthMs = 30 * 86_400_000;
    if (deadlineMs - submittedMs > oneMonthMs * 3.1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadlineAt"],
        message: "GDPR Article 12(3) caps deadlineAt at 3 months from submittedAt",
      });
    }
    if (
      v.status === "verified" ||
      v.status === "in_progress" ||
      v.status === "completed" ||
      v.status === "deferred"
    ) {
      if (v.verifiedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verifiedAt"],
          message: `status '${v.status}' requires verifiedAt`,
        });
      }
      if (v.verifiedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verifiedBy"],
          message: `status '${v.status}' requires verifiedBy`,
        });
      }
      if (v.verificationMethod === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verificationMethod"],
          message: `status '${v.status}' requires verificationMethod`,
        });
      }
    }
    if (v.status === "in_progress" && v.inProgressAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inProgressAt"],
        message: "in_progress status requires inProgressAt",
      });
    }
    if (v.status === "completed") {
      if (v.completedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: "completed status requires completedAt",
        });
      }
      if (v.completionSha256 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completionSha256"],
          message: "completed status requires completionSha256 (cryptographic proof)",
        });
      }
      if (v.completedAt !== null) {
        const completedMs = new Date(v.completedAt).getTime();
        if (completedMs > deadlineMs) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["completedAt"],
            message: "completion missed Article 12(3) deadline",
          });
        }
      }
    }
    if (v.status === "rejected") {
      if (v.rejectedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rejectedAt"],
          message: "rejected status requires rejectedAt",
        });
      }
      if (v.rejectedReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rejectedReason"],
          message: "rejected status requires rejectedReason",
        });
      }
    }
    if (v.status === "deferred") {
      if (v.deferredUntil === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deferredUntil"],
          message: "deferred status requires deferredUntil",
        });
      }
      if (v.deferralReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deferralReason"],
          message: "deferred status requires deferralReason",
        });
      }
    }
    const obs = new Set<RetentionObligation>();
    v.retentionObligations.forEach((o, i) => {
      if (obs.has(o)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retentionObligations", i],
          message: `duplicate obligation '${o}'`,
        });
      }
      obs.add(o);
    });
    const hasRealObligation = v.retentionObligations.some((o) => o !== "none");
    if (hasRealObligation && v.retainedDataCategories.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retainedDataCategories"],
        message: "retentionObligations beyond 'none' must list retainedDataCategories",
      });
    }
    if (!hasRealObligation && v.retainedDataCategories.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retainedDataCategories"],
        message: "cannot retain data categories without a stated obligation",
      });
    }
  });
export type GdprDeletionRequest = z.infer<typeof GdprDeletionRequestSchema>;

export function isOverdue(request: GdprDeletionRequest, now: Date = new Date()): boolean {
  if (request.status === "completed" || request.status === "rejected") return false;
  return now.getTime() > new Date(request.deadlineAt).getTime();
}

export function daysUntilDeadline(request: GdprDeletionRequest, now: Date = new Date()): number {
  const ms = new Date(request.deadlineAt).getTime() - now.getTime();
  return Math.floor(ms / 1000 / 86_400);
}

export function hasRetainedData(request: GdprDeletionRequest): boolean {
  return request.retainedDataCategories.length > 0;
}
