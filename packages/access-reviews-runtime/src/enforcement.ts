import {
  AccessReviewDecisionSchema,
  AccessReviewItemSchema,
  canTransitionItem,
  isItemOverdue,
  isPastGracePeriod,
  type AccessReviewCampaign,
  type AccessReviewDecision,
  type AccessReviewItem,
  type AutoRevokePolicy,
  type ReviewItemStatus,
} from "@crossengin/access-reviews";
import type { IdGenerator } from "./clock.js";

export const REVOKING_AUTO_POLICIES: ReadonlySet<AutoRevokePolicy> = new Set([
  "auto_revoke_on_deadline",
  "default_revoke",
]);

export const UNATTESTED_ITEM_STATUSES: ReadonlySet<ReviewItemStatus> = new Set([
  "pending",
  "in_review",
  "escalated",
  "exception_pending",
]);

export interface AutoRevocationOptions {
  readonly ids: IdGenerator;
  readonly now: Date;
  readonly systemActorUserId: string;
  readonly requireGracePeriod?: boolean;
}

const SYSTEM_USER_AGENT = "crossengin-access-reviews-runtime";
const SYSTEM_IP = "127.0.0.1";

export const isAutoRevocable = (
  item: AccessReviewItem,
  campaign: AccessReviewCampaign,
  now: Date,
  requireGracePeriod: boolean,
): boolean => {
  if (!UNATTESTED_ITEM_STATUSES.has(item.status)) return false;
  if (requireGracePeriod) return isPastGracePeriod(campaign, now);
  return isItemOverdue(item, now);
};

const buildRevokeDecision = (
  item: AccessReviewItem,
  campaign: AccessReviewCampaign,
  opts: AutoRevocationOptions,
): AccessReviewDecision => {
  const nowIso = opts.now.toISOString();
  return AccessReviewDecisionSchema.parse({
    id: opts.ids.next("ard"),
    itemId: item.id,
    campaignId: campaign.id,
    tenantId: campaign.tenantId,
    decidedByUserId: opts.systemActorUserId,
    decidedAt: nowIso,
    kind: "revoke",
    reason: "no_response_auto_default",
    comment: `Auto-revoked by access-review runtime: no attestation before deadline (${campaign.autoRevokePolicy}).`,
    timeBoundExtendUntil: null,
    modifiedGrantAttributes: null,
    attestation: {
      kind: "click_through_acknowledgement",
      attestedAt: nowIso,
      attestedByUserId: opts.systemActorUserId,
      signatureSha256: null,
      signingKeyFingerprint: null,
      coAttestingUserId: null,
      coAttestedAt: null,
      ipAddress: SYSTEM_IP,
      userAgent: SYSTEM_USER_AGENT,
    },
    supersedesDecisionId: null,
    relatedExceptionId: null,
    appliedAt: null,
    applicationFailedAt: null,
    applicationFailureReason: null,
  });
};

export const planAutoRevocations = (
  items: readonly AccessReviewItem[],
  campaign: AccessReviewCampaign,
  opts: AutoRevocationOptions,
): readonly AccessReviewDecision[] => {
  if (!REVOKING_AUTO_POLICIES.has(campaign.autoRevokePolicy)) return [];
  const requireGracePeriod = opts.requireGracePeriod ?? false;
  return items
    .filter((item) =>
      isAutoRevocable(item, campaign, opts.now, requireGracePeriod),
    )
    .map((item) => buildRevokeDecision(item, campaign, opts));
};

/**
 * The item an auto-revocation decision resolves (H-19). Recording the decision alone left the item
 * in its unattested status, so the next tick planned and recorded another decision for the same
 * grant, the campaign could never complete through auto-revocation, and a boot line counting
 * decisions read as a count of revocations. Throws on an edge the transition map does not admit,
 * because a decision whose item cannot move is the defect this exists to end.
 */
export const autoRevokedItem = (
  item: AccessReviewItem,
  decision: AccessReviewDecision,
  now: Date,
): AccessReviewItem => {
  if (decision.itemId !== item.id) {
    throw new Error(`auto-revocation decision ${decision.id} is for ${decision.itemId}, not ${item.id}`);
  }
  if (!canTransitionItem(item.status, "auto_revoked")) {
    throw new Error(`access-review item ${item.id} cannot move from ${item.status} to auto_revoked`);
  }
  return AccessReviewItemSchema.parse({
    ...item,
    status: "auto_revoked",
    decisionId: decision.id,
    autoRevokedAt: now.toISOString(),
    autoRevokeReason: decision.reason,
  });
};
