import { z } from "zod";
import {
  AccessReviewItemSchema,
  ReviewGrantSchema,
  assignReviewer,
  canTransitionItem,
  computeRiskLevel,
  principalMatchesScope,
  type AccessReviewCampaign,
  type AccessReviewItem,
  type PrincipalUnderReview,
  type ReviewerAssignment,
  type ReviewerKind,
} from "@crossengin/access-reviews";
import type { IdGenerator } from "./clock.js";

export const LiveGrantSchema = ReviewGrantSchema.extend({
  principalId: z.string().uuid(),
});
export type LiveGrant = z.infer<typeof LiveGrantSchema>;

export interface GenerateItemsOptions {
  readonly ids: IdGenerator;
  readonly now: Date;
  readonly assignReviewers?: boolean;
}

const MS_PER_DAY = 86_400_000;

const grantAgeDays = (grantedAt: string, now: Date): number => {
  const elapsed = now.getTime() - Date.parse(grantedAt);
  return elapsed <= 0 ? 0 : Math.floor(elapsed / MS_PER_DAY);
};

export const reviewerKindForPolicy = (
  assignment: ReviewerAssignment,
): ReviewerKind =>
  assignment.policy === "ai_suggested_human_confirmed"
    ? "ai_suggested_pending_human"
    : "human_user";

export const resolveReviewerUserId = (
  assignment: ReviewerAssignment,
  principal: PrincipalUnderReview,
  ordinal: number,
): string | null => {
  switch (assignment.policy) {
    case "principal_manager":
      return principal.managerUserId ?? assignment.fallbackReviewerUserId;
    case "specific_user":
      return assignment.specificReviewerUserId ?? assignment.fallbackReviewerUserId;
    case "round_robin_pool": {
      const pool = assignment.reviewerPoolUserIds;
      if (pool.length === 0) return assignment.fallbackReviewerUserId;
      return pool[ordinal % pool.length] as string;
    }
    case "role_based":
    case "ai_suggested_human_confirmed":
      return assignment.fallbackReviewerUserId;
  }
};

export const generateItems = (
  campaign: AccessReviewCampaign,
  grants: readonly LiveGrant[],
  principals: readonly PrincipalUnderReview[],
  opts: GenerateItemsOptions,
): readonly AccessReviewItem[] => {
  const { ids, now } = opts;
  const assign = opts.assignReviewers ?? true;
  const inScope = principals.filter((principal) =>
    principalMatchesScope(campaign.scope, principal, now),
  );
  const nowIso = now.toISOString();
  const items: AccessReviewItem[] = [];
  let ordinal = 0;

  for (const principal of inScope) {
    const principalGrants = grants.filter(
      (grant) => grant.principalId === principal.principalId,
    );
    for (const grant of principalGrants) {
      const riskLevel = computeRiskLevel({
        grantKind: grant.kind,
        principalType: principal.principalType,
        lastUsedAt: grant.lastUsedAt,
        mfaStatus: principal.mfaStatus,
        grantAgeDays: grantAgeDays(grant.grantedAt, now),
      });
      const base = AccessReviewItemSchema.parse({
        id: ids.next("ari"),
        campaignId: campaign.id,
        tenantId: campaign.tenantId,
        principalId: principal.principalId,
        principalType: principal.principalType,
        principalLabel: principal.displayLabel,
        grantKind: grant.kind,
        grantId: grant.grantId,
        grantLabel: grant.resourceLabel,
        grantAttributes: grant.attributes,
        grantedAt: grant.grantedAt,
        grantedBy: grant.grantedBy,
        lastUsedAt: grant.lastUsedAt,
        riskLevel,
        status: "pending",
        currentReviewer: null,
        createdAt: nowIso,
        openedForReviewAt: null,
        decidedAt: null,
        decisionId: null,
        autoRevokedAt: null,
        autoRevokeReason: null,
        dueAt: campaign.deadlineAt,
      });

      let item = base;
      if (assign) {
        const reviewerUserId = resolveReviewerUserId(
          campaign.reviewerAssignment,
          principal,
          ordinal,
        );
        if (
          reviewerUserId !== null &&
          reviewerUserId !== principal.principalId &&
          canTransitionItem(item.status, "in_review")
        ) {
          item = assignReviewer(
            item,
            reviewerUserId,
            reviewerKindForPolicy(campaign.reviewerAssignment),
            now,
          );
        }
      }
      items.push(item);
      ordinal += 1;
    }
  }

  return items;
};
