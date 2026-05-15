import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const HOLD_ID_REGEX = /^LH-\d{4}-\d{4,8}$/;

export const HOLD_KINDS = [
  "litigation",
  "regulatory_inquiry",
  "internal_investigation",
  "tax_audit",
  "merger_acquisition_diligence",
  "subpoena",
  "preservation_letter",
] as const;
export type HoldKind = (typeof HOLD_KINDS)[number];
export const HoldKindSchema = z.enum(HOLD_KINDS);

export const HOLD_STATUSES = [
  "draft",
  "active",
  "suspended",
  "released",
  "expired",
] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];
export const HoldStatusSchema = z.enum(HOLD_STATUSES);

export const HOLD_TRANSITIONS: Readonly<
  Record<HoldStatus, readonly HoldStatus[]>
> = Object.freeze({
  draft: ["active"],
  active: ["suspended", "released", "expired"],
  suspended: ["active", "released"],
  released: [],
  expired: ["released"],
});

export function canTransitionHold(from: HoldStatus, to: HoldStatus): boolean {
  return HOLD_TRANSITIONS[from].includes(to);
}

export const HOLD_SCOPE_KINDS = [
  "all_tenant_data",
  "specific_tenants",
  "specific_users",
  "specific_data_classes",
  "specific_date_range",
  "specific_evidence_ids",
] as const;
export type HoldScopeKind = (typeof HOLD_SCOPE_KINDS)[number];

export const HoldScopeSchema = z
  .object({
    kind: z.enum(HOLD_SCOPE_KINDS),
    tenantIds: z.array(z.string().min(1)).default([]),
    userIds: z.array(z.string().min(1)).default([]),
    dataClasses: z.array(z.string().min(1)).default([]),
    dateRangeStart: Iso8601.optional(),
    dateRangeEnd: Iso8601.optional(),
    evidenceIds: z.array(z.string().min(1)).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "specific_tenants" && v.tenantIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tenantIds"],
        message: "specific_tenants scope requires tenantIds",
      });
    }
    if (v.kind === "specific_users" && v.userIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userIds"],
        message: "specific_users scope requires userIds",
      });
    }
    if (v.kind === "specific_data_classes" && v.dataClasses.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dataClasses"],
        message: "specific_data_classes scope requires dataClasses",
      });
    }
    if (v.kind === "specific_evidence_ids" && v.evidenceIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceIds"],
        message: "specific_evidence_ids scope requires evidenceIds",
      });
    }
    if (v.kind === "specific_date_range") {
      if (v.dateRangeStart === undefined || v.dateRangeEnd === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dateRangeStart"],
          message: "specific_date_range scope requires both dateRangeStart + dateRangeEnd",
        });
      } else if (new Date(v.dateRangeEnd).getTime() <= new Date(v.dateRangeStart).getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dateRangeEnd"],
          message: "dateRangeEnd must be after dateRangeStart",
        });
      }
    }
  });
export type HoldScope = z.infer<typeof HoldScopeSchema>;

export const LegalHoldSchema = z
  .object({
    id: z.string().regex(HOLD_ID_REGEX, {
      message: "legal hold id must match 'LH-YYYY-NNNN'",
    }),
    kind: HoldKindSchema,
    status: HoldStatusSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    matterReference: z.string().min(1),
    legalCounselId: z.string().min(1),
    scope: HoldScopeSchema,
    issuedAt: Iso8601,
    issuedBy: z.string().min(1),
    activatedAt: Iso8601.nullable().default(null),
    suspendedAt: Iso8601.nullable().default(null),
    suspendedReason: z.string().min(1).optional(),
    releasedAt: Iso8601.nullable().default(null),
    releasedBy: z.string().min(1).nullable().default(null),
    releasedReason: z.string().min(1).optional(),
    expiresAt: Iso8601.optional(),
    blocksAutomaticDeletion: z.boolean().default(true),
    affectedCustodianCount: z.number().int().nonnegative(),
    custodianNotificationsSent: z.boolean().default(false),
    custodianAcknowledgementCount: z.number().int().nonnegative().default(0),
  })
  .superRefine((v, ctx) => {
    if (v.status === "active" && v.activatedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activatedAt"],
        message: "active status requires activatedAt",
      });
    }
    if (v.status === "suspended") {
      if (v.suspendedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["suspendedAt"],
          message: "suspended status requires suspendedAt",
        });
      }
      if (v.suspendedReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["suspendedReason"],
          message: "suspended status requires suspendedReason",
        });
      }
    }
    if (v.status === "released") {
      if (v.releasedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["releasedAt"],
          message: "released status requires releasedAt",
        });
      }
      if (v.releasedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["releasedBy"],
          message: "released status requires releasedBy",
        });
      }
      if (v.releasedReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["releasedReason"],
          message: "released status requires releasedReason",
        });
      }
    }
    if (v.releasedBy !== null && v.releasedBy === v.issuedBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["releasedBy"],
        message:
          "releasedBy must differ from issuedBy (separation of duties: cannot release your own hold)",
      });
    }
    if (
      v.expiresAt !== undefined &&
      new Date(v.expiresAt).getTime() <= new Date(v.issuedAt).getTime()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after issuedAt",
      });
    }
    if (v.custodianAcknowledgementCount > v.affectedCustodianCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["custodianAcknowledgementCount"],
        message: "custodianAcknowledgementCount cannot exceed affectedCustodianCount",
      });
    }
    if (v.status === "active" && !v.custodianNotificationsSent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["custodianNotificationsSent"],
        message: "active holds must have custodianNotificationsSent=true",
      });
    }
  });
export type LegalHold = z.infer<typeof LegalHoldSchema>;

export function isHoldEnforced(hold: LegalHold): boolean {
  return hold.status === "active" && hold.blocksAutomaticDeletion;
}

export function acknowledgementRate(hold: LegalHold): number {
  if (hold.affectedCustodianCount === 0) return 1;
  return (
    Math.round((hold.custodianAcknowledgementCount / hold.affectedCustodianCount) * 100) / 100
  );
}

export function isHoldOverdue(
  hold: LegalHold,
  now: Date = new Date(),
): boolean {
  if (hold.expiresAt === undefined) return false;
  if (hold.status === "released") return false;
  return now.getTime() >= new Date(hold.expiresAt).getTime();
}
