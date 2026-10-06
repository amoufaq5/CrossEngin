import {
  AccessReviewCampaignSchema,
  AccessReviewDecisionSchema,
  AccessReviewEvidenceSchema,
  AccessReviewItemSchema,
  type AccessReviewCampaign,
  type AccessReviewDecision,
  type AccessReviewEvidence,
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

const MUTATING_RE = /^\s*(INSERT|UPDATE|DELETE)\b/i;

/**
 * Which statements must name `tenant_id`, and the one thing a recorder fake *can* check about scope.
 *
 * `FakeConn` does not model rows, so it cannot tell a scoped store from an unscoped one — which is
 * precisely how ADR-0331's and ADR-0333's owner-bypass class survived everywhere it was found: a
 * fake answering `{rowCount: 1}` to everything is as happy with `WHERE evidence_id = $4` as with
 * `WHERE evidence_id = $4 AND tenant_id = $5`, so a write landing on another tenant's row looked
 * identical to one that could not. Copied verbatim from `feature-flags-pg`'s fake, where ADR-0334
 * installed it, rather than invented here.
 *
 * It is a tripwire and not a simulation: it cannot say the predicate is *right*. Reads are exempt on
 * purpose, because `classifyScopedWriteRefusal`'s diagnosing re-read is deliberately unscoped — its
 * whole question is whether the row sits in another scope, which a scoped read could only answer
 * "absent".
 */
export function assertStatementIsScoped(sql: string): void {
  if (!MUTATING_RE.test(sql)) return;
  if (sql.includes("tenant_id")) return;
  throw new Error(
    "this fake refuses an unscoped write: a statement that changes rows in a tenant-scoped table " +
      "must name tenant_id, as a supplied column or as a predicate — " +
      `got: ${sql.replace(/\s+/g, " ").slice(0, 120)}`,
  );
}

export class FakeConn implements PgConnection {
  readonly calls: CapturedCall[] = [];

  constructor(
    private readonly responder: QueryResponder = defaultResponder,
    private readonly opts: { readonly allowUnscopedWrites?: boolean } = {},
  ) {}

  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult<T>> {
    this.calls.push({ sql, params });
    if (this.opts.allowUnscopedWrites !== true) assertStatementIsScoped(sql);
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

export const makeCompiledEvidence = (
  overrides: Partial<AccessReviewEvidence> = {},
): AccessReviewEvidence =>
  AccessReviewEvidenceSchema.parse({
    id: "arv_aaaaaaaabbbbbbbbcccccccc",
    tenantId: UUIDS.tenant,
    framework: "soc2_type2",
    periodStartAt: "2026-01-01T00:00:00.000Z",
    periodEndAt: "2026-03-31T00:00:00.000Z",
    campaignIds: ["arc_00000001"],
    controlMappings: ["CC6.1", "CC6.2"],
    totalItemsAcrossCampaigns: 3,
    completionRate: 0.6667,
    keepRate: 0.5,
    revokeRate: 0.5,
    autoRevokeRate: 0.3333,
    exceptionRate: 0,
    strongAttestationRate: 0.5,
    overdueRate: 0,
    status: "compiled",
    compiledAt: "2026-04-01T00:00:00.000Z",
    sealedAt: null,
    sealedSha256: null,
    submittedAt: null,
    submittedToAuditorId: null,
    acceptedAt: null,
    rejectedAt: null,
    rejectedReason: null,
    storageUri: null,
    createdBy: UUIDS.creator,
    createdAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  });

export const makeSealedEvidence = (
  overrides: Partial<AccessReviewEvidence> = {},
): AccessReviewEvidence =>
  makeCompiledEvidence({
    status: "sealed",
    sealedAt: "2026-04-01T00:00:00.000Z",
    sealedSha256: "a".repeat(64),
    storageUri: "crossengin+pg:access-review-bundle/v1/arv_aaaaaaaabbbbbbbbcccccccc",
    ...overrides,
  });

/** One stored row, in the spelling node-postgres really hands back: NUMERIC as text, dates as Date. */
export const evidenceRowFor = (
  evidence: AccessReviewEvidence,
): Record<string, unknown> => ({
  evidence_id: evidence.id,
  tenant_id: evidence.tenantId,
  framework: evidence.framework,
  period_start_at: new Date(evidence.periodStartAt),
  period_end_at: new Date(evidence.periodEndAt),
  campaign_ids: [...evidence.campaignIds],
  control_mappings: [...evidence.controlMappings],
  total_items_across_campaigns: evidence.totalItemsAcrossCampaigns,
  completion_rate: evidence.completionRate.toFixed(4),
  keep_rate: evidence.keepRate.toFixed(4),
  revoke_rate: evidence.revokeRate.toFixed(4),
  auto_revoke_rate: evidence.autoRevokeRate.toFixed(4),
  exception_rate: evidence.exceptionRate.toFixed(4),
  strong_attestation_rate: evidence.strongAttestationRate.toFixed(4),
  overdue_rate: evidence.overdueRate.toFixed(4),
  status: evidence.status,
  compiled_at: evidence.compiledAt === null ? null : new Date(evidence.compiledAt),
  sealed_at: evidence.sealedAt === null ? null : new Date(evidence.sealedAt),
  sealed_sha256: evidence.sealedSha256,
  submitted_at: null,
  submitted_to_auditor_id: null,
  accepted_at: null,
  rejected_at: null,
  rejected_reason: null,
  storage_uri: evidence.storageUri,
  created_by: evidence.createdBy,
  created_at: new Date(evidence.createdAt),
});
