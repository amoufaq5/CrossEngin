import {
  AccessReviewItemSchema,
  computeRiskLevel,
  type AccessReviewItem,
  type GrantKind,
  type PrincipalType,
} from "@crossengin/access-reviews";

const MS_PER_DAY = 86_400_000;

/** A live grant pulled from the platform's authorization state, to be reviewed. */
export interface LiveGrant {
  readonly principalId: string;
  readonly principalType: PrincipalType;
  readonly principalLabel: string;
  readonly grantKind: GrantKind;
  readonly grantId: string;
  readonly grantLabel: string;
  readonly grantAttributes?: Record<string, string>;
  readonly grantedAt: string;
  readonly grantedBy: string | null;
  readonly lastUsedAt: string | null;
  /** The principal's MFA posture (drives the risk score; not stored on the item). */
  readonly mfaStatus: string;
}

/** The campaign context every generated item shares. */
export interface CampaignItemContext {
  readonly campaignId: string;
  readonly tenantId: string;
  /** The review deadline for each item. */
  readonly dueAt: string;
  /** Item creation time (also the reference for grant-age risk). */
  readonly now: string;
  /** Mints a fresh `ari_…` item id. */
  readonly newItemId: () => string;
}

/**
 * Generates a `pending` review item for one **live grant**: derives the grant's age
 * from `grantedAt`→`now`, scores its risk via the contract's `computeRiskLevel`
 * (principal type + grant kind + MFA posture + staleness + age), and builds a
 * schema-valid `AccessReviewItem` (reviewer unassigned, undecided). This is the
 * "campaign runs against live grants" step — turn the authorization snapshot into
 * reviewable items.
 */
export function generateReviewItem(grant: LiveGrant, ctx: CampaignItemContext): AccessReviewItem {
  const grantAgeDays = Math.max(0, Math.floor((Date.parse(ctx.now) - Date.parse(grant.grantedAt)) / MS_PER_DAY));
  const riskLevel = computeRiskLevel({
    grantKind: grant.grantKind,
    principalType: grant.principalType,
    lastUsedAt: grant.lastUsedAt,
    mfaStatus: grant.mfaStatus,
    grantAgeDays,
  });
  return AccessReviewItemSchema.parse({
    id: ctx.newItemId(),
    campaignId: ctx.campaignId,
    tenantId: ctx.tenantId,
    principalId: grant.principalId,
    principalType: grant.principalType,
    principalLabel: grant.principalLabel,
    grantKind: grant.grantKind,
    grantId: grant.grantId,
    grantLabel: grant.grantLabel,
    grantAttributes: grant.grantAttributes ?? {},
    grantedAt: grant.grantedAt,
    grantedBy: grant.grantedBy,
    lastUsedAt: grant.lastUsedAt,
    riskLevel,
    status: "pending",
    currentReviewer: null,
    createdAt: ctx.now,
    openedForReviewAt: null,
    decidedAt: null,
    decisionId: null,
    autoRevokedAt: null,
    autoRevokeReason: null,
    dueAt: ctx.dueAt,
  });
}

/** Generates a review item per live grant for a campaign. */
export function generateReviewItems(grants: readonly LiveGrant[], ctx: CampaignItemContext): readonly AccessReviewItem[] {
  return grants.map((grant) => generateReviewItem(grant, ctx));
}
