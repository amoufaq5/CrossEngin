import {
  AccessReviewCampaignSchema,
  AccessReviewDecisionSchema,
  AccessReviewItemSchema,
  type AccessReviewCampaign,
  type AccessReviewDecision,
  type AccessReviewItem,
  type CampaignScope,
  type PrincipalUnderReview,
  type ReviewerAssignment,
} from "@crossengin/access-reviews";
import type { LiveGrant } from "./item-generation.js";

export const UUID = {
  tenant: "00000000-0000-4000-8000-000000000001",
  creator: "00000000-0000-4000-8000-000000000002",
  reviewer: "00000000-0000-4000-8000-000000000003",
  manager: "00000000-0000-4000-8000-000000000004",
  principalA: "00000000-0000-4000-8000-00000000000a",
  principalB: "00000000-0000-4000-8000-00000000000b",
  system: "00000000-0000-4000-8000-0000000000ff",
  poolOne: "00000000-0000-4000-8000-000000000010",
  poolTwo: "00000000-0000-4000-8000-000000000011",
} as const;

export const defaultReviewerAssignment = (
  overrides: Partial<ReviewerAssignment> = {},
): ReviewerAssignment => ({
  policy: "principal_manager",
  fallbackReviewerUserId: UUID.reviewer,
  reviewerPoolUserIds: [],
  specificReviewerUserId: null,
  roleBasedReviewerRoleSlug: null,
  escalationChainUserIds: [],
  escalationTimeoutHours: 72,
  ...overrides,
});

export const defaultScope = (): CampaignScope => ({
  kind: "all_users_with_role",
  roleSlug: "member",
  includeInherited: true,
});

export const makeCampaign = (
  overrides: Partial<AccessReviewCampaign> = {},
): AccessReviewCampaign =>
  AccessReviewCampaignSchema.parse({
    id: "arc_00000001",
    tenantId: UUID.tenant,
    label: "Quarterly access review",
    description: "Reviews standing grants.",
    frequency: "quarterly",
    framework: "soc2_type2",
    status: "scheduled",
    scope: defaultScope(),
    reviewerAssignment: defaultReviewerAssignment(),
    autoRevokePolicy: "auto_revoke_on_deadline",
    relatedIncidentId: null,
    scheduledStartAt: "2026-01-01T00:00:00.000Z",
    deadlineAt: "2026-01-15T00:00:00.000Z",
    gracePeriodHours: 24,
    remediationDeadlineAt: null,
    createdAt: "2025-12-01T00:00:00.000Z",
    createdBy: UUID.creator,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    cancelledAt: null,
    cancelledReason: null,
    templateId: null,
    totalItems: 0,
    decidedItems: 0,
    autoRevokedItems: 0,
    exceptionItems: 0,
    ...overrides,
  });

export const makePrincipal = (
  overrides: Partial<PrincipalUnderReview> = {},
): PrincipalUnderReview => ({
  principalId: UUID.principalA,
  principalType: "user",
  displayLabel: "alice@example.com",
  tenantId: UUID.tenant,
  isExternal: false,
  managerUserId: UUID.manager,
  mfaStatus: "any_strong",
  lastLoginAt: "2025-12-20T00:00:00.000Z",
  ...overrides,
});

export const makeGrant = (
  overrides: Partial<LiveGrant> = {},
): LiveGrant => ({
  principalId: UUID.principalA,
  kind: "role",
  grantId: "grant-role-admin",
  resourceLabel: "admin role",
  attributes: {},
  grantedAt: "2024-01-01T00:00:00.000Z",
  grantedBy: UUID.creator,
  lastUsedAt: "2025-12-20T00:00:00.000Z",
  ...overrides,
});

export const makeItem = (
  overrides: Partial<AccessReviewItem> = {},
): AccessReviewItem =>
  AccessReviewItemSchema.parse({
    id: "ari_00000001",
    campaignId: "arc_00000001",
    tenantId: UUID.tenant,
    principalId: UUID.principalA,
    principalType: "user",
    principalLabel: "alice@example.com",
    grantKind: "role",
    grantId: "grant-role-admin",
    grantLabel: "admin role",
    grantAttributes: {},
    grantedAt: "2024-01-01T00:00:00.000Z",
    grantedBy: UUID.creator,
    lastUsedAt: "2025-12-20T00:00:00.000Z",
    riskLevel: "high",
    status: "pending",
    currentReviewer: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    openedForReviewAt: null,
    decidedAt: null,
    decisionId: null,
    autoRevokedAt: null,
    autoRevokeReason: null,
    dueAt: "2026-01-10T00:00:00.000Z",
    ...overrides,
  });

export const makeDecision = (
  overrides: Partial<AccessReviewDecision> = {},
): AccessReviewDecision =>
  AccessReviewDecisionSchema.parse({
    id: "ard_00000001",
    itemId: "ari_00000001",
    campaignId: "arc_00000001",
    tenantId: UUID.tenant,
    decidedByUserId: UUID.reviewer,
    decidedAt: "2026-01-09T00:00:00.000Z",
    kind: "keep",
    reason: "role_appropriate",
    comment: "Still required.",
    timeBoundExtendUntil: null,
    modifiedGrantAttributes: null,
    attestation: {
      kind: "click_through_acknowledgement",
      attestedAt: "2026-01-09T00:00:00.000Z",
      attestedByUserId: UUID.reviewer,
      signatureSha256: null,
      signingKeyFingerprint: null,
      coAttestingUserId: null,
      coAttestedAt: null,
      ipAddress: "127.0.0.1",
      userAgent: "crossengin-access-reviews-runtime",
    },
    supersedesDecisionId: null,
    relatedExceptionId: null,
    appliedAt: null,
    applicationFailedAt: null,
    applicationFailureReason: null,
    ...overrides,
  });
