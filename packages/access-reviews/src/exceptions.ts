import { z } from "zod";

export const EXCEPTION_STATUSES = [
  "requested",
  "approved",
  "rejected",
  "expired",
  "revoked_early",
  "superseded",
] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

export const EXCEPTION_TRANSITIONS: Readonly<Record<ExceptionStatus, readonly ExceptionStatus[]>> =
  {
    requested: ["approved", "rejected"],
    approved: ["expired", "revoked_early", "superseded"],
    rejected: [],
    expired: [],
    revoked_early: [],
    superseded: [],
  };

export const canTransitionException = (from: ExceptionStatus, to: ExceptionStatus): boolean =>
  EXCEPTION_TRANSITIONS[from].includes(to);

export const EXCEPTION_REASONS = [
  "emergency_break_glass",
  "regulatory_exemption",
  "system_account_required",
  "contractor_renewal_pending",
  "dual_role_business_need",
  "audit_trail_required",
  "migration_in_progress",
  "vendor_support_requirement",
] as const;
export type ExceptionReason = (typeof EXCEPTION_REASONS)[number];

export const RESTRICTED_EXCEPTION_REASONS: ReadonlySet<ExceptionReason> = new Set([
  "emergency_break_glass",
  "regulatory_exemption",
]);

export const MAX_EXCEPTION_DURATION_DAYS: Readonly<Record<ExceptionReason, number>> = {
  emergency_break_glass: 7,
  regulatory_exemption: 365,
  system_account_required: 365,
  contractor_renewal_pending: 90,
  dual_role_business_need: 180,
  audit_trail_required: 730,
  migration_in_progress: 180,
  vendor_support_requirement: 30,
};

export const AccessReviewExceptionSchema = z
  .object({
    id: z.string().regex(/^are_[a-z0-9]{8,32}$/),
    itemId: z.string().regex(/^ari_[a-z0-9]{8,32}$/),
    campaignId: z.string().regex(/^arc_[a-z0-9]{8,32}$/),
    tenantId: z.string().uuid(),
    status: z.enum(EXCEPTION_STATUSES),
    reason: z.enum(EXCEPTION_REASONS),
    justification: z.string().min(20).max(2000),
    requestedAt: z.string().datetime({ offset: true }),
    requestedByUserId: z.string().uuid(),
    requestedExpiresAt: z.string().datetime({ offset: true }),
    approvedAt: z.string().datetime({ offset: true }).nullable(),
    approvedByUserId: z.string().uuid().nullable(),
    approvedJustification: z.string().max(2000).nullable(),
    grantedExpiresAt: z.string().datetime({ offset: true }).nullable(),
    rejectedAt: z.string().datetime({ offset: true }).nullable(),
    rejectedByUserId: z.string().uuid().nullable(),
    rejectedReason: z.string().max(500).nullable(),
    expiredAt: z.string().datetime({ offset: true }).nullable(),
    revokedEarlyAt: z.string().datetime({ offset: true }).nullable(),
    revokedEarlyByUserId: z.string().uuid().nullable(),
    revokedEarlyReason: z.string().max(500).nullable(),
    supersededByExceptionId: z.string().nullable(),
    notificationCount: z.number().int().min(0).max(50).default(0),
    lastNotificationAt: z.string().datetime({ offset: true }).nullable(),
    requiresQuarterlyReattestation: z.boolean().default(false),
    lastReattestedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .superRefine((e, ctx) => {
    if (Date.parse(e.requestedExpiresAt) <= Date.parse(e.requestedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestedExpiresAt"],
        message: "requestedExpiresAt must be after requestedAt",
      });
    }
    const maxDays = MAX_EXCEPTION_DURATION_DAYS[e.reason];
    const requestedDurationMs = Date.parse(e.requestedExpiresAt) - Date.parse(e.requestedAt);
    if (requestedDurationMs > maxDays * 86_400_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestedExpiresAt"],
        message: `reason ${e.reason} caps exception at ${maxDays} days`,
      });
    }
    if (e.requestedByUserId === e.approvedByUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvedByUserId"],
        message: "four-eyes: approver must differ from requester",
      });
    }
    if (e.status === "approved") {
      if (e.approvedAt === null || e.approvedByUserId === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approvedAt"],
          message: "approved exception requires approvedAt + approvedByUserId",
        });
      }
      if (e.grantedExpiresAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["grantedExpiresAt"],
          message: "approved exception requires grantedExpiresAt",
        });
      }
    }
    if (e.status === "rejected") {
      if (e.rejectedAt === null || e.rejectedByUserId === null || e.rejectedReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rejectedReason"],
          message: "rejected exception requires rejectedAt + rejectedByUserId + rejectedReason",
        });
      }
    }
    if (e.status === "revoked_early") {
      if (
        e.revokedEarlyAt === null ||
        e.revokedEarlyByUserId === null ||
        e.revokedEarlyReason === null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["revokedEarlyReason"],
          message:
            "revoked_early exception requires revokedEarlyAt + revokedEarlyByUserId + revokedEarlyReason",
        });
      }
    }
    if (
      e.grantedExpiresAt !== null &&
      e.approvedAt !== null &&
      Date.parse(e.grantedExpiresAt) <= Date.parse(e.approvedAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["grantedExpiresAt"],
        message: "grantedExpiresAt must be after approvedAt",
      });
    }
    if (
      e.reason === "emergency_break_glass" &&
      !e.requiresQuarterlyReattestation &&
      e.status === "approved"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiresQuarterlyReattestation"],
        message: "emergency_break_glass exception requires quarterly re-attestation",
      });
    }
  });
export type AccessReviewException = z.infer<typeof AccessReviewExceptionSchema>;

export const isExceptionExpired = (exception: AccessReviewException, now: Date): boolean => {
  if (exception.status !== "approved") return false;
  if (exception.grantedExpiresAt === null) return false;
  return now.getTime() >= Date.parse(exception.grantedExpiresAt);
};

export const daysRemainingOnException = (
  exception: AccessReviewException,
  now: Date,
): number | null => {
  if (exception.status !== "approved") return null;
  if (exception.grantedExpiresAt === null) return null;
  const remainingMs = Date.parse(exception.grantedExpiresAt) - now.getTime();
  return Math.max(0, Math.ceil(remainingMs / 86_400_000));
};

export const requiresReattestation = (
  exception: AccessReviewException,
  now: Date,
  reattestationIntervalDays = 90,
): boolean => {
  if (!exception.requiresQuarterlyReattestation) return false;
  if (exception.status !== "approved") return false;
  if (exception.lastReattestedAt === null) return true;
  const elapsedMs = now.getTime() - Date.parse(exception.lastReattestedAt);
  return elapsedMs >= reattestationIntervalDays * 86_400_000;
};

export const isRestrictedReason = (reason: ExceptionReason): boolean =>
  RESTRICTED_EXCEPTION_REASONS.has(reason);
