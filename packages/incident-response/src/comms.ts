import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const INCIDENT_ID_REGEX = /^INC-\d{4}-\d{4,8}$/;

export const COMM_AUDIENCES = [
  "status_page_public",
  "affected_tenants",
  "all_customers",
  "internal_eng",
  "internal_exec",
  "regulators",
  "law_enforcement",
] as const;
export type CommAudience = (typeof COMM_AUDIENCES)[number];
export const CommAudienceSchema = z.enum(COMM_AUDIENCES);

export const COMM_KINDS = [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
  "postmortem_published",
  "scheduled_maintenance",
  "breach_notification",
] as const;
export type CommKind = (typeof COMM_KINDS)[number];
export const CommKindSchema = z.enum(COMM_KINDS);

export const STATUS_PAGE_LEVELS = [
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "under_maintenance",
] as const;
export type StatusPageLevel = (typeof STATUS_PAGE_LEVELS)[number];

export const IncidentCommunicationSchema = z
  .object({
    id: z.string().min(1),
    incidentId: z.string().regex(INCIDENT_ID_REGEX),
    audience: CommAudienceSchema,
    kind: CommKindSchema,
    statusPageLevel: z.enum(STATUS_PAGE_LEVELS).optional(),
    title: z.string().min(1).max(160),
    body: z.string().min(1).max(10_000),
    publishedAt: Iso8601,
    publishedBy: z.string().min(1),
    languages: z.array(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/)).default(["en"]),
    requiresLegalReview: z.boolean().default(false),
    legalReviewedBy: z.string().min(1).nullable().default(null),
    legalReviewedAt: Iso8601.nullable().default(null),
    requiresExecutiveApproval: z.boolean().default(false),
    executiveApprovedBy: z.string().min(1).nullable().default(null),
    executiveApprovedAt: Iso8601.nullable().default(null),
    deliveryChannels: z
      .array(z.enum(["email", "sms", "in_app", "rss", "status_page", "webhook", "push"]))
      .min(1),
    recipientCount: z.number().int().nonnegative(),
    bouncesCount: z.number().int().nonnegative().default(0),
    supersedesId: z.string().min(1).nullable().default(null),
    retractedAt: Iso8601.nullable().default(null),
    retractedReason: z.string().min(1).optional(),
    breachNotificationDeadlineAt: Iso8601.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.audience === "status_page_public" && v.statusPageLevel === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["statusPageLevel"],
        message: "audience='status_page_public' requires statusPageLevel",
      });
    }
    if (v.audience !== "status_page_public" && v.statusPageLevel !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["statusPageLevel"],
        message: "statusPageLevel is only valid for status_page_public audience",
      });
    }
    if (v.kind === "breach_notification") {
      if (v.audience !== "affected_tenants" && v.audience !== "regulators") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["audience"],
          message: "breach_notification audience must be 'affected_tenants' or 'regulators'",
        });
      }
      if (!v.requiresLegalReview) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiresLegalReview"],
          message: "breach_notification must requiresLegalReview=true",
        });
      }
      if (v.breachNotificationDeadlineAt === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["breachNotificationDeadlineAt"],
          message: "breach_notification requires breachNotificationDeadlineAt (GDPR 72h)",
        });
      } else {
        const deadlineMs = new Date(v.breachNotificationDeadlineAt).getTime();
        const publishedMs = new Date(v.publishedAt).getTime();
        if (deadlineMs < publishedMs) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["publishedAt"],
            message:
              "publishedAt cannot be after breachNotificationDeadlineAt (notification was late)",
          });
        }
      }
    }
    if (v.requiresLegalReview) {
      if (v.legalReviewedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["legalReviewedBy"],
          message: "requiresLegalReview requires legalReviewedBy",
        });
      }
      if (v.legalReviewedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["legalReviewedAt"],
          message: "requiresLegalReview requires legalReviewedAt",
        });
      }
    }
    if (v.requiresExecutiveApproval) {
      if (v.executiveApprovedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["executiveApprovedBy"],
          message: "requiresExecutiveApproval requires executiveApprovedBy",
        });
      }
      if (v.executiveApprovedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["executiveApprovedAt"],
          message: "requiresExecutiveApproval requires executiveApprovedAt",
        });
      }
    }
    if (
      (v.audience === "regulators" || v.audience === "law_enforcement") &&
      !v.requiresLegalReview
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiresLegalReview"],
        message: `audience '${v.audience}' must requiresLegalReview=true`,
      });
    }
    if (v.bouncesCount > v.recipientCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bouncesCount"],
        message: "bouncesCount cannot exceed recipientCount",
      });
    }
    if (v.retractedAt !== null && v.retractedReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retractedReason"],
        message: "retractedAt requires retractedReason",
      });
    }
    if (v.languages.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["languages"],
        message: "must declare at least one language",
      });
    }
    const langSet = new Set<string>();
    v.languages.forEach((l, i) => {
      if (langSet.has(l)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["languages", i],
          message: `duplicate language '${l}'`,
        });
      }
      langSet.add(l);
    });
  });
export type IncidentCommunication = z.infer<typeof IncidentCommunicationSchema>;

export function bounceRate(c: IncidentCommunication): number {
  if (c.recipientCount === 0) return 0;
  return Math.round((c.bouncesCount / c.recipientCount) * 1000) / 10;
}

export function isBreachNotificationTimely(c: IncidentCommunication): boolean {
  if (c.kind !== "breach_notification") return true;
  if (c.breachNotificationDeadlineAt === undefined) return false;
  return new Date(c.publishedAt).getTime() <= new Date(c.breachNotificationDeadlineAt).getTime();
}

export function publishedCommsFor(
  comms: readonly IncidentCommunication[],
  incidentId: string,
): readonly IncidentCommunication[] {
  return [...comms]
    .filter((c) => c.incidentId === incidentId && c.retractedAt === null)
    .sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
}
