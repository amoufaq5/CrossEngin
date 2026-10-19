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
    /**
     * The tombstone that completed this request (ADR-0321).
     *
     * `completionSha256` commits to the proof and cannot find it — a digest is not a lookup key — so
     * without this a `completed` request and the record of the deletion it asked for could not be
     * joined. The superRefine below makes the pair load-bearing in both directions: a completed
     * request must name its tombstone, and an uncompleted one must not.
     */
    tombstoneId: z
      .string()
      .regex(/^tomb_[A-Za-z0-9_-]{12,40}$/)
      .nullable()
      .default(null),
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
    if (v.status === "completed" && v.tombstoneId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tombstoneId"],
        message: "a completed deletion request must name the tombstone that completed it",
      });
    }
    if (v.status !== "completed" && v.tombstoneId !== null) {
      // A request that names a tombstone it has not been completed by is claiming a proof it does not
      // have, which is the ADR-0317 defect in a different record.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tombstoneId"],
        message: `status '${v.status}' must not name a tombstone`,
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
    if (v.status === "verified" || v.status === "in_progress" || v.status === "completed" || v.status === "deferred") {
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
      // There is deliberately **no** refusal for `completedAt > deadlineAt`, and the absence is the
      // decision rather than an omission: a late completion is a fact that happened. Nothing in this
      // system prevents one — how long erasing a large tenant takes is not something a schema can
      // refuse — so the refusal that used to be here never prevented the breach. It only made the
      // record of it unreadable. A contract that refuses to represent a fact that happened does not
      // prevent the fact; it destroys the evidence.
      //
      // Measured, because the consequence was worse than an unwritable row.
      // `PostgresDeletionRequestStore.transition` runs its `UPDATE … RETURNING` inside
      // `conn.transaction`, which **commits**, and parses the returned row only afterwards. So for a
      // deletion that finished past its deadline: the tenant's data was destroyed, the tombstone was
      // written and anchored, the row was committed `completed` — and the call threw. `read()` then
      // threw for that row for ever, and `completedWithTombstone()` threw inside its own `.map()`, so
      // one late deletion stopped the reconciler auditing every *other* completed request.
      //
      // The breach is representable, therefore readable, therefore reportable: `isCompletedLate` is
      // what answers for it, and `isOverdue`'s doc comment names it as the other half of the pair.
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

/**
 * Whether this request is **still running** past its Article 12(3) deadline.
 *
 * `completed` and `rejected` answer `false` because neither is still running — and for `completed`
 * that is emphatically not the same statement as "it was answered on time". `isCompletedLate` is the
 * companion that answers for that case, and the two are total over the statuses that can breach the
 * deadline: this one for a request that has not finished, that one for a request that has. The pair
 * is why this function's `false` for `completed` is honest rather than silent; on its own it was the
 * only reading available, and it looks identical to compliance.
 *
 * `rejected` is the one terminal status neither reports, which is right: a refused request was
 * answered rather than answered late, and `rejectedReason` carries why.
 */
export function isOverdue(
  request: GdprDeletionRequest,
  now: Date = new Date(),
): boolean {
  if (request.status === "completed" || request.status === "rejected") return false;
  return now.getTime() > new Date(request.deadlineAt).getTime();
}

/**
 * Whether this request **finished** after its Article 12(3) deadline — the breach, after the fact.
 *
 * The schema used to refuse such a record outright; the comment in `GdprDeletionRequestSchema`'s
 * `completed` branch says what that cost and why it is gone. This is the reading that replaces it.
 *
 * It takes **no clock**, where `isOverdue` and `daysUntilDeadline` both do, and the asymmetry is the
 * decision rather than an oversight: both operands are stored on the record, so the answer is a
 * property of the request itself and not of when anyone asks. A `now` parameter would be unread at
 * best, and at worst would invite a reader to make a settled historical fact drift with the clock.
 *
 * Strictly `>`, matching the deadline's own meaning: completing exactly at it is on time.
 *
 * A `completed` request carrying no `completedAt` answers `false`. The schema refuses that pairing,
 * so it is unreachable past validation — and a boolean cannot say "the record does not state when it
 * finished", while answering `true` would assert a breach from a record that gives no completion
 * time at all. That is the opposite false claim, and the one a regulator would be shown.
 */
export function isCompletedLate(request: GdprDeletionRequest): boolean {
  if (request.status !== "completed" || request.completedAt === null) return false;
  return new Date(request.completedAt).getTime() > new Date(request.deadlineAt).getTime();
}

export function daysUntilDeadline(
  request: GdprDeletionRequest,
  now: Date = new Date(),
): number {
  const ms = new Date(request.deadlineAt).getTime() - now.getTime();
  return Math.floor(ms / 1000 / 86_400);
}

export function hasRetainedData(request: GdprDeletionRequest): boolean {
  return request.retainedDataCategories.length > 0;
}
