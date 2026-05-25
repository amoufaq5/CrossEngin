import { z } from "zod";
import { TenantLifecycleStateSchema, type TenantLifecycleState } from "./states.js";

const Iso8601 = z.string().datetime({ offset: true });
const SECONDS_PER_DAY = 86_400;

export const GRACE_KINDS = [
  "billing_grace",
  "suspension_grace",
  "archive_grace",
  "deletion_grace",
  "appeal_window",
] as const;
export type GraceKind = (typeof GRACE_KINDS)[number];
export const GraceKindSchema = z.enum(GRACE_KINDS);

export const GRACE_DEFAULT_DAYS: Readonly<Record<GraceKind, number>> = Object.freeze({
  billing_grace: 14,
  suspension_grace: 30,
  archive_grace: 90,
  deletion_grace: 30,
  appeal_window: 14,
});

const GRACE_MIN_DAYS: Readonly<Record<GraceKind, number>> = Object.freeze({
  billing_grace: 1,
  suspension_grace: 7,
  archive_grace: 30,
  deletion_grace: 14,
  appeal_window: 3,
});

const GRACE_MAX_DAYS: Readonly<Record<GraceKind, number>> = Object.freeze({
  billing_grace: 60,
  suspension_grace: 90,
  archive_grace: 365,
  deletion_grace: 90,
  appeal_window: 60,
});

export const GRACE_FROM_STATE: Readonly<Record<GraceKind, TenantLifecycleState>> = Object.freeze({
  billing_grace: "past_due",
  suspension_grace: "suspended",
  archive_grace: "archived",
  deletion_grace: "pending_deletion",
  appeal_window: "pending_deletion",
});

export const GracePeriodSchema = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    kind: GraceKindSchema,
    fromState: TenantLifecycleStateSchema,
    startedAt: Iso8601,
    expiresAt: Iso8601,
    durationDays: z.number().int().positive(),
    triggerEventId: z.string().min(1),
    autoActionOnExpiry: z.enum(["advance_state", "send_reminder", "no_op"]),
    nextStateOnExpiry: TenantLifecycleStateSchema.optional(),
    reminderSentAt: Iso8601.nullable().default(null),
    customerExtendedAt: Iso8601.nullable().default(null),
    customerExtendedToExpiresAt: Iso8601.nullable().default(null),
    cancelledAt: Iso8601.nullable().default(null),
    cancelledReason: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    const startMs = new Date(v.startedAt).getTime();
    const expireMs = new Date(v.expiresAt).getTime();
    if (expireMs <= startMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after startedAt",
      });
    }
    const computedDays = Math.round((expireMs - startMs) / 1000 / SECONDS_PER_DAY);
    if (Math.abs(computedDays - v.durationDays) > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationDays"],
        message: `durationDays ${v.durationDays.toString()} should match expiresAt-startedAt (${computedDays.toString()})`,
      });
    }
    const min = GRACE_MIN_DAYS[v.kind];
    const max = GRACE_MAX_DAYS[v.kind];
    if (v.durationDays < min) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationDays"],
        message: `kind '${v.kind}' requires durationDays >= ${min.toString()}`,
      });
    }
    if (v.durationDays > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationDays"],
        message: `kind '${v.kind}' caps durationDays at ${max.toString()}`,
      });
    }
    const expectedFromState = GRACE_FROM_STATE[v.kind];
    if (v.fromState !== expectedFromState) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fromState"],
        message: `kind '${v.kind}' applies to fromState '${expectedFromState}', not '${v.fromState}'`,
      });
    }
    if (v.autoActionOnExpiry === "advance_state" && v.nextStateOnExpiry === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextStateOnExpiry"],
        message: "autoActionOnExpiry='advance_state' requires nextStateOnExpiry",
      });
    }
    if (v.customerExtendedAt !== null) {
      if (v.customerExtendedToExpiresAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["customerExtendedToExpiresAt"],
          message: "customerExtendedAt requires customerExtendedToExpiresAt",
        });
      } else {
        const extendedMs = new Date(v.customerExtendedToExpiresAt).getTime();
        if (extendedMs <= expireMs) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["customerExtendedToExpiresAt"],
            message: "extension must push expiresAt later, not earlier",
          });
        }
      }
    }
    if (v.cancelledAt !== null && v.cancelledReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cancelledReason"],
        message: "cancelledAt requires cancelledReason",
      });
    }
  });
export type GracePeriod = z.infer<typeof GracePeriodSchema>;

export function effectiveExpiresAt(grace: GracePeriod): string {
  return grace.customerExtendedToExpiresAt ?? grace.expiresAt;
}

export function isGraceExpired(grace: GracePeriod, now: Date = new Date()): boolean {
  if (grace.cancelledAt !== null) return false;
  return now.getTime() >= new Date(effectiveExpiresAt(grace)).getTime();
}

export function daysRemaining(grace: GracePeriod, now: Date = new Date()): number {
  if (grace.cancelledAt !== null) return 0;
  const expireMs = new Date(effectiveExpiresAt(grace)).getTime();
  const remainingMs = expireMs - now.getTime();
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000 / SECONDS_PER_DAY);
}

export function defaultGraceDays(kind: GraceKind): number {
  return GRACE_DEFAULT_DAYS[kind];
}
