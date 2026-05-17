import { z } from "zod";

export const EXCEPTION_KINDS = [
  "principal_overage",
  "tenant_burst_allowance",
  "scheduled_event_uplift",
  "compliance_override",
  "incident_response_bypass",
  "load_test_temporary",
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const EXCEPTION_STATUSES = [
  "requested",
  "approved",
  "active",
  "expired",
  "rejected",
  "revoked_early",
] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

export const EXCEPTION_TRANSITIONS: Readonly<
  Record<ExceptionStatus, readonly ExceptionStatus[]>
> = {
  requested: ["approved", "rejected"],
  approved: ["active", "revoked_early"],
  active: ["expired", "revoked_early"],
  expired: [],
  rejected: [],
  revoked_early: [],
};

export const canTransitionException = (
  from: ExceptionStatus,
  to: ExceptionStatus,
): boolean => EXCEPTION_TRANSITIONS[from].includes(to);

export const MAX_EXCEPTION_DURATION_HOURS: Readonly<
  Record<ExceptionKind, number>
> = {
  principal_overage: 24 * 30,
  tenant_burst_allowance: 24 * 7,
  scheduled_event_uplift: 24 * 14,
  compliance_override: 24 * 90,
  incident_response_bypass: 24,
  load_test_temporary: 8,
};

export const RateLimitExceptionSchema = z
  .object({
    id: z.string().regex(/^rle_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    policyId: z.string().regex(/^rlp_[a-z0-9]{8,40}$/),
    scopeKey: z.string().min(1).max(500),
    kind: z.enum(EXCEPTION_KINDS),
    status: z.enum(EXCEPTION_STATUSES),
    multiplier: z.number().min(0.1).max(100),
    additiveBurst: z.number().int().min(0).max(1_000_000),
    justification: z.string().min(20).max(2000),
    requestedAt: z.string().datetime({ offset: true }),
    requestedBy: z.string().uuid(),
    approvedAt: z.string().datetime({ offset: true }).nullable(),
    approvedBy: z.string().uuid().nullable(),
    rejectedAt: z.string().datetime({ offset: true }).nullable(),
    rejectedBy: z.string().uuid().nullable(),
    rejectedReason: z.string().max(500).nullable(),
    activatedAt: z.string().datetime({ offset: true }).nullable(),
    expiresAt: z.string().datetime({ offset: true }),
    revokedEarlyAt: z.string().datetime({ offset: true }).nullable(),
    revokedEarlyBy: z.string().uuid().nullable(),
    revokedEarlyReason: z.string().max(500).nullable(),
    relatedIncidentId: z.string().max(120).nullable(),
  })
  .superRefine((e, ctx) => {
    if (Date.parse(e.expiresAt) <= Date.parse(e.requestedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after requestedAt",
      });
    }
    const maxDurationMs = MAX_EXCEPTION_DURATION_HOURS[e.kind] * 3_600_000;
    const requestedDurationMs =
      Date.parse(e.expiresAt) - Date.parse(e.requestedAt);
    if (requestedDurationMs > maxDurationMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: `kind ${e.kind} caps exception at ${MAX_EXCEPTION_DURATION_HOURS[e.kind]} hours`,
      });
    }
    if (e.approvedBy === e.requestedBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvedBy"],
        message: "four-eyes: approvedBy must differ from requestedBy",
      });
    }
    if (e.multiplier < 1 && e.additiveBurst === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["multiplier"],
        message:
          "exception with multiplier < 1 requires additiveBurst > 0 to be meaningful (otherwise it tightens, not loosens)",
      });
    }
    if (e.status === "approved" || e.status === "active") {
      if (e.approvedAt === null || e.approvedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approvedAt"],
          message: `${e.status} exception requires approvedAt + approvedBy`,
        });
      }
    }
    if (e.status === "rejected") {
      if (
        e.rejectedAt === null ||
        e.rejectedBy === null ||
        e.rejectedReason === null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rejectedReason"],
          message:
            "rejected exception requires rejectedAt + rejectedBy + rejectedReason",
        });
      }
    }
    if (e.status === "revoked_early") {
      if (
        e.revokedEarlyAt === null ||
        e.revokedEarlyBy === null ||
        e.revokedEarlyReason === null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["revokedEarlyReason"],
          message:
            "revoked_early exception requires revokedEarlyAt + revokedEarlyBy + revokedEarlyReason",
        });
      }
    }
    if (
      e.kind === "incident_response_bypass" &&
      e.relatedIncidentId === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relatedIncidentId"],
        message:
          "incident_response_bypass exception requires relatedIncidentId",
      });
    }
  });
export type RateLimitException = z.infer<typeof RateLimitExceptionSchema>;

export const isExceptionActive = (
  exception: RateLimitException,
  now: Date,
): boolean => {
  if (exception.status !== "active") return false;
  return now.getTime() < Date.parse(exception.expiresAt);
};

export const applyException = (
  baseLimit: number,
  exception: RateLimitException,
): number =>
  Math.max(0, Math.floor(baseLimit * exception.multiplier)) +
  exception.additiveBurst;

export const findActiveException = (
  exceptions: readonly RateLimitException[],
  policyId: string,
  scopeKey: string,
  now: Date,
): RateLimitException | null => {
  for (const e of exceptions) {
    if (e.policyId !== policyId) continue;
    if (e.scopeKey !== scopeKey) continue;
    if (isExceptionActive(e, now)) return e;
  }
  return null;
};
