import {
  AccessReviewDecisionSchema,
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
