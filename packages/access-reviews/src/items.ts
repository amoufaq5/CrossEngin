import { z } from "zod";
import { PRINCIPAL_TYPES, GRANT_KINDS } from "./scope.js";

export const REVIEW_ITEM_STATUSES = [
  "pending",
  "in_review",
  "decided",
  "escalated",
  "auto_revoked",
  "exception_pending",
  "deferred_to_next_campaign",
  "withdrawn",
] as const;
export type ReviewItemStatus = (typeof REVIEW_ITEM_STATUSES)[number];

export const REVIEW_ITEM_TRANSITIONS: Readonly<
  Record<ReviewItemStatus, readonly ReviewItemStatus[]>
> = {
  pending: ["in_review", "deferred_to_next_campaign", "withdrawn"],
  in_review: ["decided", "escalated", "exception_pending", "deferred_to_next_campaign"],
  escalated: ["decided", "auto_revoked", "exception_pending"],
  exception_pending: ["decided", "auto_revoked"],
  decided: [],
  auto_revoked: [],
  deferred_to_next_campaign: [],
  withdrawn: [],
};

export const canTransitionItem = (from: ReviewItemStatus, to: ReviewItemStatus): boolean =>
  REVIEW_ITEM_TRANSITIONS[from].includes(to);

export const REVIEWER_KINDS = [
  "human_user",
  "ai_suggested_pending_human",
  "system_automated",
] as const;
export type ReviewerKind = (typeof REVIEWER_KINDS)[number];

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const ReviewerAssignmentStateSchema = z.object({
  reviewerUserId: z.string().uuid(),
  reviewerKind: z.enum(REVIEWER_KINDS),
  assignedAt: z.string().datetime({ offset: true }),
  reminderCount: z.number().int().min(0).max(20),
  lastReminderAt: z.string().datetime({ offset: true }).nullable(),
  escalationLevel: z.number().int().min(0).max(10),
});
export type ReviewerAssignmentState = z.infer<typeof ReviewerAssignmentStateSchema>;

export const AccessReviewItemSchema = z
  .object({
    id: z.string().regex(/^ari_[a-z0-9]{8,32}$/),
    campaignId: z.string().regex(/^arc_[a-z0-9]{8,32}$/),
    tenantId: z.string().uuid(),
    principalId: z.string().uuid(),
    principalType: z.enum(PRINCIPAL_TYPES),
    principalLabel: z.string().min(1).max(200),
    grantKind: z.enum(GRANT_KINDS),
    grantId: z.string().min(1).max(200),
    grantLabel: z.string().min(1).max(200),
    grantAttributes: z.record(z.string(), z.string()).default({}),
    grantedAt: z.string().datetime({ offset: true }),
    grantedBy: z.string().uuid().nullable(),
    lastUsedAt: z.string().datetime({ offset: true }).nullable(),
    riskLevel: z.enum(RISK_LEVELS),
    status: z.enum(REVIEW_ITEM_STATUSES),
    currentReviewer: ReviewerAssignmentStateSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
    openedForReviewAt: z.string().datetime({ offset: true }).nullable(),
    decidedAt: z.string().datetime({ offset: true }).nullable(),
    decisionId: z.string().nullable(),
    autoRevokedAt: z.string().datetime({ offset: true }).nullable(),
    autoRevokeReason: z.string().max(500).nullable(),
    dueAt: z.string().datetime({ offset: true }),
    notes: z.string().max(2000).optional(),
  })
  .superRefine((it, ctx) => {
    if (it.principalId === it.currentReviewer?.reviewerUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentReviewer", "reviewerUserId"],
        message: "four-eyes: reviewer cannot review their own grant",
      });
    }
    if (it.status === "decided" && it.decisionId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decisionId"],
        message: "decided item requires decisionId",
      });
    }
    if (it.status === "decided" && it.decidedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decidedAt"],
        message: "decided item requires decidedAt",
      });
    }
    if (it.status === "auto_revoked") {
      if (it.autoRevokedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["autoRevokedAt"],
          message: "auto_revoked item requires autoRevokedAt",
        });
      }
      if (it.autoRevokeReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["autoRevokeReason"],
          message: "auto_revoked item requires autoRevokeReason",
        });
      }
    }
    if ((it.status === "in_review" || it.status === "escalated") && it.currentReviewer === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentReviewer"],
        message: `${it.status} item requires currentReviewer`,
      });
    }
    if (it.openedForReviewAt !== null) {
      const opened = Date.parse(it.openedForReviewAt);
      if (opened < Date.parse(it.createdAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["openedForReviewAt"],
          message: "openedForReviewAt cannot precede createdAt",
        });
      }
    }
  });
export type AccessReviewItem = z.infer<typeof AccessReviewItemSchema>;

export const computeRiskLevel = (input: {
  readonly grantKind: string;
  readonly principalType: string;
  readonly lastUsedAt: string | null;
  readonly mfaStatus: string;
  readonly grantAgeDays: number;
}): RiskLevel => {
  let score = 0;
  if (input.principalType === "service_account") score += 2;
  if (input.principalType === "external_partner") score += 3;
  if (input.grantKind === "role" || input.grantKind === "tenant_membership") score += 2;
  if (input.grantKind === "api_key_scope") score += 2;
  if (input.mfaStatus === "none") score += 3;
  if (input.mfaStatus === "weak_only_sms") score += 1;
  if (input.lastUsedAt === null) score += 2;
  if (input.grantAgeDays > 365) score += 1;
  if (input.grantAgeDays > 730) score += 1;
  if (score >= 7) return "critical";
  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
};

export const isItemOverdue = (item: AccessReviewItem, now: Date): boolean => {
  if (
    item.status === "decided" ||
    item.status === "auto_revoked" ||
    item.status === "withdrawn" ||
    item.status === "deferred_to_next_campaign"
  ) {
    return false;
  }
  return now.getTime() > Date.parse(item.dueAt);
};

export const shouldEscalate = (
  item: AccessReviewItem,
  now: Date,
  escalationTimeoutHours: number,
): boolean => {
  if (item.status !== "in_review") return false;
  if (item.currentReviewer === null) return false;
  const assignedMs = Date.parse(item.currentReviewer.assignedAt);
  const elapsedMs = now.getTime() - assignedMs;
  return elapsedMs >= escalationTimeoutHours * 3_600_000;
};

export const assignReviewer = (
  item: AccessReviewItem,
  reviewerUserId: string,
  reviewerKind: ReviewerKind,
  now: Date,
): AccessReviewItem => {
  if (reviewerUserId === item.principalId) {
    throw new Error("four-eyes: cannot assign principal as reviewer of their own grant");
  }
  if (!canTransitionItem(item.status, "in_review")) {
    throw new Error(`cannot transition item from ${item.status} to in_review`);
  }
  return {
    ...item,
    status: "in_review",
    openedForReviewAt: item.openedForReviewAt ?? now.toISOString(),
    currentReviewer: {
      reviewerUserId,
      reviewerKind,
      assignedAt: now.toISOString(),
      reminderCount: 0,
      lastReminderAt: null,
      escalationLevel: 0,
    },
  };
};
