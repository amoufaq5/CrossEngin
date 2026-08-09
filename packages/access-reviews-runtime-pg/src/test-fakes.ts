import {
  AccessReviewCampaignSchema,
  AccessReviewDecisionSchema,
  AccessReviewItemSchema,
  type AccessReviewCampaign,
  type AccessReviewDecision,
  type AccessReviewItem,
} from "@crossengin/access-reviews";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

export const UUIDS = {
  tenant: "00000000-0000-4000-8000-000000000001",
  creator: "00000000-0000-4000-8000-000000000002",
  reviewer: "00000000-0000-4000-8000-000000000003",
  principal: "00000000-0000-4000-8000-00000000000a",
  system: "00000000-0000-4000-8000-0000000000ff",
  campaignRow: "00000000-0000-4000-8000-000000000c01",
  itemRow: "00000000-0000-4000-8000-000000000e01",
} as const;

export interface CapturedCall {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

export type QueryResponder = (
  sql: string,
  params: readonly unknown[] | undefined,
) => PgQueryResult<Record<string, unknown>>;

export const defaultResponder: QueryResponder = (sql) => {
  if (sql.includes("INSERT INTO meta.access_review_campaigns")) {
    return { rows: [{ id: UUIDS.campaignRow }], rowCount: 1 };
  }
  if (sql.includes("INSERT INTO meta.access_review_items")) {
    return { rows: [{ id: UUIDS.itemRow }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};

export class FakeConn implements PgConnection {
  readonly calls: CapturedCall[] = [];

  constructor(private readonly responder: QueryResponder = defaultResponder) {}

  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult<T>> {
    this.calls.push({ sql, params });
    return Promise.resolve(this.responder(sql, params) as PgQueryResult<T>);
  }

  transaction<T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> {
    return fn(this);
  }

  withAdvisoryLock<T>(_lockKey: bigint, fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  find(fragment: string): CapturedCall | undefined {
    return this.calls.find((c) => c.sql.includes(fragment));
  }
}

export const makeCampaign = (
  overrides: Partial<AccessReviewCampaign> = {},
): AccessReviewCampaign =>
  AccessReviewCampaignSchema.parse({
    id: "arc_00000001",
    tenantId: UUIDS.tenant,
    label: "Quarterly access review",
    description: "Reviews standing grants.",
    frequency: "quarterly",
    framework: "soc2_type2",
    status: "scheduled",
    scope: { kind: "all_users_with_role", roleSlug: "member", includeInherited: true },
    reviewerAssignment: {
      policy: "principal_manager",
      fallbackReviewerUserId: UUIDS.reviewer,
      reviewerPoolUserIds: [],
      specificReviewerUserId: null,
      roleBasedReviewerRoleSlug: null,
      escalationChainUserIds: [],
      escalationTimeoutHours: 72,
    },
    autoRevokePolicy: "auto_revoke_on_deadline",
    relatedIncidentId: null,
    scheduledStartAt: "2026-01-01T00:00:00.000Z",
    deadlineAt: "2026-01-15T00:00:00.000Z",
    gracePeriodHours: 24,
    remediationDeadlineAt: null,
    createdAt: "2025-12-01T00:00:00.000Z",
    createdBy: UUIDS.creator,
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

export const makeItem = (
  overrides: Partial<AccessReviewItem> = {},
): AccessReviewItem =>
  AccessReviewItemSchema.parse({
    id: "ari_00000001",
    campaignId: "arc_00000001",
    tenantId: UUIDS.tenant,
    principalId: UUIDS.principal,
    principalType: "user",
    principalLabel: "alice@example.com",
    grantKind: "role",
    grantId: "grant-role-admin",
    grantLabel: "admin role",
    grantAttributes: {},
    grantedAt: "2024-01-01T00:00:00.000Z",
    grantedBy: UUIDS.creator,
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
    tenantId: UUIDS.tenant,
    decidedByUserId: UUIDS.system,
    decidedAt: "2026-02-01T00:00:00.000Z",
    kind: "revoke",
    reason: "no_response_auto_default",
    comment: "Auto-revoked.",
    timeBoundExtendUntil: null,
    modifiedGrantAttributes: null,
    attestation: {
      kind: "click_through_acknowledgement",
      attestedAt: "2026-02-01T00:00:00.000Z",
      attestedByUserId: UUIDS.system,
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
