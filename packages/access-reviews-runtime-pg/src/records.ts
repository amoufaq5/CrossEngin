import {
  AccessReviewEvidenceSchema,
  type AccessReviewCampaign,
  type AccessReviewDecision,
  type AccessReviewEvidence,
  type AccessReviewItem,
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

/**
 * One `meta.access_review_evidence` row as node-postgres hands it back.
 *
 * The rate columns are typed `unknown` rather than `number` on purpose: they are `NUMERIC(5, 4)`,
 * and node-postgres returns `NUMERIC` as a **string** (ADR-0331's measurement). Typing them `number`
 * would make the type system assert something false and hide the parse this mapper has to do — the
 * same lie `compareInstanceProjection` was telling about `TIMESTAMPTZ` before ADR-0330 found it.
 */
export interface EvidenceRow {
  readonly evidence_id: string;
  readonly tenant_id: string;
  readonly framework: AccessReviewEvidence["framework"];
  readonly period_start_at: Timestampish;
  readonly period_end_at: Timestampish;
  readonly campaign_ids: unknown;
  readonly control_mappings: unknown;
  readonly total_items_across_campaigns: unknown;
  readonly completion_rate: unknown;
  readonly keep_rate: unknown;
  readonly revoke_rate: unknown;
  readonly auto_revoke_rate: unknown;
  readonly exception_rate: unknown;
  readonly strong_attestation_rate: unknown;
  readonly overdue_rate: unknown;
  readonly status: AccessReviewEvidence["status"];
  readonly compiled_at: Timestampish;
  readonly sealed_at: Timestampish;
  readonly sealed_sha256: string | null;
  readonly submitted_at: Timestampish;
  readonly submitted_to_auditor_id: string | null;
  readonly accepted_at: Timestampish;
  readonly rejected_at: Timestampish;
  readonly rejected_reason: string | null;
  readonly storage_uri: string | null;
  readonly created_by: string;
  readonly created_at: Timestampish;
}

/** A `NUMERIC` column as a JS number, refusing rather than yielding `NaN`. */
export function requireNumeric(value: unknown, field: string): number {
  // `Number(null)` and `Number("")` are both `0`, so a finiteness check alone would turn an
  // unreadable rate column into a **0% completion rate** — a figure that fails the control rather
  // than a value nobody can read. Caught by this module's own test, which is the second time the
  // same two-line coercion has been wrong in this increment.
  const n =
    value === null || value === undefined || value === ""
      ? Number.NaN
      : typeof value === "number"
        ? value
        : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`row column ${field} is not a finite number: ${JSON.stringify(value)}`);
  }
  return n;
}

function requireStringArray(value: unknown, field: string): string[] {
  const raw = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(raw) || !raw.every((v): v is string => typeof v === "string")) {
    throw new Error(`row column ${field} is not a string array`);
  }
  return [...raw];
}

/**
 * Re-parses a stored evidence row through `AccessReviewEvidenceSchema`.
 *
 * Through the real schema rather than a loose mirror plus a cast (ADR-0329's rule): the row's
 * status↔required-field pairing — a `sealed` pack carrying `sealedAt` + `sealedSha256` +
 * `storageUri` — is a `superRefine`, not a CHECK, so a row edited into a shape the contract forbids
 * is only caught here.
 */
export function rowToEvidence(row: EvidenceRow): AccessReviewEvidence {
  return AccessReviewEvidenceSchema.parse({
    id: row.evidence_id,
    tenantId: row.tenant_id,
    framework: row.framework,
    periodStartAt: requireIso(row.period_start_at, "period_start_at"),
    periodEndAt: requireIso(row.period_end_at, "period_end_at"),
    campaignIds: requireStringArray(row.campaign_ids, "campaign_ids"),
    controlMappings: requireStringArray(row.control_mappings, "control_mappings"),
    totalItemsAcrossCampaigns: requireNumeric(
      row.total_items_across_campaigns,
      "total_items_across_campaigns",
    ),
    completionRate: requireNumeric(row.completion_rate, "completion_rate"),
    keepRate: requireNumeric(row.keep_rate, "keep_rate"),
    revokeRate: requireNumeric(row.revoke_rate, "revoke_rate"),
    autoRevokeRate: requireNumeric(row.auto_revoke_rate, "auto_revoke_rate"),
    exceptionRate: requireNumeric(row.exception_rate, "exception_rate"),
    strongAttestationRate: requireNumeric(
      row.strong_attestation_rate,
      "strong_attestation_rate",
    ),
    overdueRate: requireNumeric(row.overdue_rate, "overdue_rate"),
    status: row.status,
    compiledAt: toIso(row.compiled_at),
    sealedAt: toIso(row.sealed_at),
    sealedSha256: row.sealed_sha256,
    submittedAt: toIso(row.submitted_at),
    submittedToAuditorId: row.submitted_to_auditor_id,
    acceptedAt: toIso(row.accepted_at),
    rejectedAt: toIso(row.rejected_at),
    rejectedReason: row.rejected_reason,
    storageUri: row.storage_uri,
    createdBy: row.created_by,
    createdAt: requireIso(row.created_at, "created_at"),
  });
}
