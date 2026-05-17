import { z } from "zod";
import { CampaignScopeSchema } from "./scope.js";

export const CAMPAIGN_FREQUENCIES = [
  "one_time",
  "monthly",
  "quarterly",
  "semi_annual",
  "annual",
  "sox_quarterly",
  "post_incident",
  "ad_hoc",
] as const;
export type CampaignFrequency = (typeof CAMPAIGN_FREQUENCIES)[number];

export const CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "in_progress",
  "in_remediation",
  "completed",
  "archived",
  "cancelled",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_TRANSITIONS: Readonly<
  Record<CampaignStatus, readonly CampaignStatus[]>
> = {
  draft: ["scheduled", "cancelled"],
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["in_remediation", "completed", "cancelled"],
  in_remediation: ["completed", "cancelled"],
  completed: ["archived"],
  archived: [],
  cancelled: [],
};

export const canTransitionCampaign = (
  from: CampaignStatus,
  to: CampaignStatus,
): boolean => CAMPAIGN_TRANSITIONS[from].includes(to);

export const REVIEWER_ASSIGNMENT_POLICIES = [
  "principal_manager",
  "specific_user",
  "role_based",
  "ai_suggested_human_confirmed",
  "round_robin_pool",
] as const;
export type ReviewerAssignmentPolicy =
  (typeof REVIEWER_ASSIGNMENT_POLICIES)[number];

export const AUTO_REVOKE_POLICIES = [
  "auto_revoke_on_deadline",
  "escalate_to_manager",
  "default_keep",
  "default_revoke",
] as const;
export type AutoRevokePolicy = (typeof AUTO_REVOKE_POLICIES)[number];

export const COMPLIANCE_FRAMEWORKS = [
  "soc2_type2",
  "iso27001",
  "hipaa_security_rule",
  "pci_dss_v4",
  "gdpr_article_32",
  "cfr_21_part_11",
  "custom",
] as const;
export type ComplianceFramework = (typeof COMPLIANCE_FRAMEWORKS)[number];

export const ReviewerAssignmentSchema = z
  .object({
    policy: z.enum(REVIEWER_ASSIGNMENT_POLICIES),
    fallbackReviewerUserId: z.string().uuid().nullable(),
    reviewerPoolUserIds: z.array(z.string().uuid()).default([]),
    specificReviewerUserId: z.string().uuid().nullable(),
    roleBasedReviewerRoleSlug: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*$/)
      .nullable(),
    escalationChainUserIds: z.array(z.string().uuid()).max(10).default([]),
    escalationTimeoutHours: z
      .number()
      .int()
      .min(1)
      .max(720)
      .default(72),
  })
  .superRefine((r, ctx) => {
    if (r.policy === "specific_user" && r.specificReviewerUserId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["specificReviewerUserId"],
        message: "specific_user policy requires specificReviewerUserId",
      });
    }
    if (r.policy === "role_based" && r.roleBasedReviewerRoleSlug === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roleBasedReviewerRoleSlug"],
        message: "role_based policy requires roleBasedReviewerRoleSlug",
      });
    }
    if (
      r.policy === "round_robin_pool" &&
      r.reviewerPoolUserIds.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewerPoolUserIds"],
        message: "round_robin_pool policy requires non-empty reviewerPoolUserIds",
      });
    }
    const allReviewers = [
      ...(r.specificReviewerUserId ? [r.specificReviewerUserId] : []),
      ...r.reviewerPoolUserIds,
      ...r.escalationChainUserIds,
    ];
    if (new Set(allReviewers).size !== allReviewers.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["escalationChainUserIds"],
        message: "reviewer ids must be unique across reviewer pool + escalation chain",
      });
    }
  });
export type ReviewerAssignment = z.infer<typeof ReviewerAssignmentSchema>;

export const AccessReviewCampaignSchema = z
  .object({
    id: z.string().regex(/^arc_[a-z0-9]{8,32}$/),
    tenantId: z.string().uuid(),
    label: z.string().min(1).max(200),
    description: z.string().max(2000),
    frequency: z.enum(CAMPAIGN_FREQUENCIES),
    framework: z.enum(COMPLIANCE_FRAMEWORKS),
    status: z.enum(CAMPAIGN_STATUSES),
    scope: CampaignScopeSchema,
    reviewerAssignment: ReviewerAssignmentSchema,
    autoRevokePolicy: z.enum(AUTO_REVOKE_POLICIES),
    relatedIncidentId: z.string().nullable(),
    scheduledStartAt: z.string().datetime({ offset: true }),
    deadlineAt: z.string().datetime({ offset: true }),
    gracePeriodHours: z.number().int().min(0).max(720).default(24),
    remediationDeadlineAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    createdBy: z.string().uuid(),
    startedAt: z.string().datetime({ offset: true }).nullable(),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    archivedAt: z.string().datetime({ offset: true }).nullable(),
    cancelledAt: z.string().datetime({ offset: true }).nullable(),
    cancelledReason: z.string().max(500).nullable(),
    templateId: z.string().nullable(),
    totalItems: z.number().int().min(0),
    decidedItems: z.number().int().min(0),
    autoRevokedItems: z.number().int().min(0),
    exceptionItems: z.number().int().min(0),
  })
  .superRefine((c, ctx) => {
    if (Date.parse(c.deadlineAt) <= Date.parse(c.scheduledStartAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadlineAt"],
        message: "deadlineAt must be after scheduledStartAt",
      });
    }
    if (c.frequency === "post_incident" && c.relatedIncidentId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relatedIncidentId"],
        message: "post_incident frequency requires relatedIncidentId",
      });
    }
    if (c.status === "completed" && c.completedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completed campaign requires completedAt",
      });
    }
    if (c.status === "cancelled" && c.cancelledReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cancelledReason"],
        message: "cancelled campaign requires cancelledReason",
      });
    }
    if (
      c.decidedItems + c.autoRevokedItems + c.exceptionItems >
      c.totalItems
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalItems"],
        message:
          "decided + auto_revoked + exception counts cannot exceed totalItems",
      });
    }
    if (
      c.status === "completed" &&
      c.decidedItems + c.autoRevokedItems + c.exceptionItems < c.totalItems
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message:
          "completed campaign must have all items decided/auto-revoked/excepted",
      });
    }
    if (
      c.framework === "sox_quarterly" as never &&
      c.frequency !== "sox_quarterly"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["frequency"],
        message: "SOX framework requires sox_quarterly frequency",
      });
    }
    const startedAt = c.startedAt ? Date.parse(c.startedAt) : null;
    const completedAt = c.completedAt ? Date.parse(c.completedAt) : null;
    if (
      startedAt !== null &&
      completedAt !== null &&
      completedAt < startedAt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completedAt cannot precede startedAt",
      });
    }
  });
export type AccessReviewCampaign = z.infer<typeof AccessReviewCampaignSchema>;

export const computeCampaignProgress = (
  campaign: AccessReviewCampaign,
): number => {
  if (campaign.totalItems === 0) return 1;
  const resolved =
    campaign.decidedItems + campaign.autoRevokedItems + campaign.exceptionItems;
  return resolved / campaign.totalItems;
};

export const isPastDeadline = (
  campaign: AccessReviewCampaign,
  now: Date,
): boolean => now.getTime() > Date.parse(campaign.deadlineAt);

export const isPastGracePeriod = (
  campaign: AccessReviewCampaign,
  now: Date,
): boolean => {
  const deadlineMs = Date.parse(campaign.deadlineAt);
  const graceMs = campaign.gracePeriodHours * 3_600_000;
  return now.getTime() > deadlineMs + graceMs;
};

export const computeNextScheduledStart = (
  current: AccessReviewCampaign,
): string | null => {
  if (current.frequency === "one_time") return null;
  if (current.frequency === "ad_hoc") return null;
  if (current.frequency === "post_incident") return null;
  const currentStart = Date.parse(current.scheduledStartAt);
  const stepDays: Record<string, number> = {
    monthly: 30,
    quarterly: 91,
    semi_annual: 182,
    annual: 365,
    sox_quarterly: 91,
  };
  const days = stepDays[current.frequency];
  if (days === undefined) return null;
  const next = new Date(currentStart + days * 86_400_000);
  return next.toISOString();
};
