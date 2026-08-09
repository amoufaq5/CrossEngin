import type {
  AccessReviewCampaign,
  AccessReviewDecision,
  AccessReviewItem,
} from "@crossengin/access-reviews";

type Timestampish = string | Date | null | undefined;

export function toIso(value: Timestampish): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function requireIso(value: Timestampish, field: string): string {
  const iso = toIso(value);
  if (iso === null) throw new Error(`row is missing required timestamp: ${field}`);
  return iso;
}

export interface CampaignRow {
  readonly campaign_id: string;
  readonly tenant_id: string;
  readonly label: string;
  readonly description: string;
  readonly frequency: AccessReviewCampaign["frequency"];
  readonly framework: AccessReviewCampaign["framework"];
  readonly status: AccessReviewCampaign["status"];
  readonly scope: AccessReviewCampaign["scope"];
  readonly reviewer_assignment: AccessReviewCampaign["reviewerAssignment"];
  readonly auto_revoke_policy: AccessReviewCampaign["autoRevokePolicy"];
  readonly related_incident_id: string | null;
  readonly scheduled_start_at: Timestampish;
  readonly deadline_at: Timestampish;
  readonly grace_period_hours: number;
  readonly remediation_deadline_at: Timestampish;
  readonly created_at: Timestampish;
  readonly created_by: string;
  readonly started_at: Timestampish;
  readonly completed_at: Timestampish;
  readonly archived_at: Timestampish;
  readonly cancelled_at: Timestampish;
  readonly cancelled_reason: string | null;
  readonly template_id: string | null;
  readonly total_items: number;
  readonly decided_items: number;
  readonly auto_revoked_items: number;
  readonly exception_items: number;
}

export function rowToCampaign(row: CampaignRow): AccessReviewCampaign {
  return {
    id: row.campaign_id,
    tenantId: row.tenant_id,
    label: row.label,
    description: row.description,
    frequency: row.frequency,
    framework: row.framework,
    status: row.status,
    scope: row.scope,
    reviewerAssignment: row.reviewer_assignment,
    autoRevokePolicy: row.auto_revoke_policy,
    relatedIncidentId: row.related_incident_id,
    scheduledStartAt: requireIso(row.scheduled_start_at, "scheduled_start_at"),
    deadlineAt: requireIso(row.deadline_at, "deadline_at"),
    gracePeriodHours: row.grace_period_hours,
    remediationDeadlineAt: toIso(row.remediation_deadline_at),
    createdAt: requireIso(row.created_at, "created_at"),
    createdBy: row.created_by,
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    archivedAt: toIso(row.archived_at),
    cancelledAt: toIso(row.cancelled_at),
    cancelledReason: row.cancelled_reason,
    templateId: row.template_id,
    totalItems: row.total_items,
    decidedItems: row.decided_items,
    autoRevokedItems: row.auto_revoked_items,
    exceptionItems: row.exception_items,
  };
}

export interface ItemRow {
  readonly item_id: string;
  readonly tenant_id: string;
  readonly campaign_natural_id: string;
  readonly principal_id: string;
  readonly principal_type: AccessReviewItem["principalType"];
  readonly principal_label: string;
  readonly grant_kind: AccessReviewItem["grantKind"];
  readonly grant_id: string;
  readonly grant_label: string;
  readonly grant_attributes: Record<string, string>;
  readonly granted_at: Timestampish;
  readonly granted_by: string | null;
  readonly last_used_at: Timestampish;
  readonly risk_level: AccessReviewItem["riskLevel"];
  readonly status: AccessReviewItem["status"];
  readonly current_reviewer_user_id: string | null;
  readonly current_reviewer_kind:
    | NonNullable<AccessReviewItem["currentReviewer"]>["reviewerKind"]
    | null;
  readonly reviewer_assigned_at: Timestampish;
  readonly reminder_count: number;
  readonly last_reminder_at: Timestampish;
  readonly escalation_level: number;
  readonly created_at: Timestampish;
  readonly opened_for_review_at: Timestampish;
  readonly decided_at: Timestampish;
  readonly decision_id: string | null;
  readonly auto_revoked_at: Timestampish;
  readonly auto_revoke_reason: string | null;
  readonly due_at: Timestampish;
  readonly notes: string | null;
}

export function rowToItem(row: ItemRow): AccessReviewItem {
  const currentReviewer: AccessReviewItem["currentReviewer"] =
    row.current_reviewer_user_id === null || row.current_reviewer_kind === null
      ? null
      : {
          reviewerUserId: row.current_reviewer_user_id,
          reviewerKind: row.current_reviewer_kind,
          assignedAt: requireIso(row.reviewer_assigned_at, "reviewer_assigned_at"),
          reminderCount: row.reminder_count,
          lastReminderAt: toIso(row.last_reminder_at),
          escalationLevel: row.escalation_level,
        };
  return {
    id: row.item_id,
    campaignId: row.campaign_natural_id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    principalType: row.principal_type,
    principalLabel: row.principal_label,
    grantKind: row.grant_kind,
    grantId: row.grant_id,
    grantLabel: row.grant_label,
    grantAttributes: row.grant_attributes,
    grantedAt: requireIso(row.granted_at, "granted_at"),
    grantedBy: row.granted_by,
    lastUsedAt: toIso(row.last_used_at),
    riskLevel: row.risk_level,
    status: row.status,
    currentReviewer,
    createdAt: requireIso(row.created_at, "created_at"),
    openedForReviewAt: toIso(row.opened_for_review_at),
    decidedAt: toIso(row.decided_at),
    decisionId: row.decision_id,
    autoRevokedAt: toIso(row.auto_revoked_at),
    autoRevokeReason: row.auto_revoke_reason,
    dueAt: requireIso(row.due_at, "due_at"),
    ...(row.notes === null ? {} : { notes: row.notes }),
  };
}

export interface DecisionRow {
  readonly decision_id: string;
  readonly item_natural_id: string;
  readonly campaign_natural_id: string;
  readonly tenant_id: string;
  readonly decided_by_user_id: string;
  readonly decided_at: Timestampish;
  readonly kind: AccessReviewDecision["kind"];
  readonly reason: AccessReviewDecision["reason"];
  readonly comment: string | null;
  readonly time_bound_extend_until: Timestampish;
  readonly modified_grant_attributes: Record<string, string> | null;
  readonly attestation_kind: AccessReviewDecision["attestation"]["kind"];
  readonly attestation_signature_sha256: string | null;
  readonly attestation_signing_key_fingerprint: string | null;
  readonly co_attesting_user_id: string | null;
  readonly co_attested_at: Timestampish;
  readonly ip_address: string;
  readonly user_agent: string;
  readonly supersedes_decision_id: string | null;
  readonly related_exception_id: string | null;
  readonly applied_at: Timestampish;
  readonly application_failed_at: Timestampish;
  readonly application_failure_reason: string | null;
}

export function rowToDecision(row: DecisionRow): AccessReviewDecision {
  return {
    id: row.decision_id,
    itemId: row.item_natural_id,
    campaignId: row.campaign_natural_id,
    tenantId: row.tenant_id,
    decidedByUserId: row.decided_by_user_id,
    decidedAt: requireIso(row.decided_at, "decided_at"),
    kind: row.kind,
    reason: row.reason,
    ...(row.comment === null ? {} : { comment: row.comment }),
    timeBoundExtendUntil: toIso(row.time_bound_extend_until),
    modifiedGrantAttributes: row.modified_grant_attributes,
    attestation: {
      kind: row.attestation_kind,
      attestedAt: requireIso(row.decided_at, "decided_at"),
      attestedByUserId: row.decided_by_user_id,
      signatureSha256: row.attestation_signature_sha256,
      signingKeyFingerprint: row.attestation_signing_key_fingerprint,
      coAttestingUserId: row.co_attesting_user_id,
      coAttestedAt: toIso(row.co_attested_at),
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
    },
    supersedesDecisionId: row.supersedes_decision_id,
    relatedExceptionId: row.related_exception_id,
    appliedAt: toIso(row.applied_at),
    applicationFailedAt: toIso(row.application_failed_at),
    applicationFailureReason: row.application_failure_reason,
  };
}
