import {
  AccessReviewDecisionSchema,
  AccessReviewItemSchema,
  type AccessReviewDecision,
  type AccessReviewItem,
} from "@crossengin/access-reviews";

/** Coerce a node-postgres `Date` / string / null timestamp to an ISO string (or null). */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

/** Parse a JSONB column that node-postgres may hand back as a string or an object. */
export function parseJson(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined) return fallback;
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * Reconstructs an `AccessReviewItem` from a `meta.access_review_items` row joined with
 * its campaign (so the UUID `campaign_id` FK is read back as the contract's `arc_…`
 * business id, supplied as `campaign_business_id`). The flattened reviewer columns
 * (`current_reviewer_user_id` / `current_reviewer_kind` / `reviewer_assigned_at` /
 * `reminder_count` / `last_reminder_at` / `escalation_level`) collapse back into the
 * nullable `currentReviewer` object — null reviewer columns mean no current reviewer.
 */
export function rowToReviewItem(row: Record<string, unknown>): AccessReviewItem {
  const reviewerUserId = row["current_reviewer_user_id"] as string | null;
  const currentReviewer =
    reviewerUserId === null || reviewerUserId === undefined
      ? null
      : {
          reviewerUserId,
          reviewerKind: row["current_reviewer_kind"],
          assignedAt: toIso(row["reviewer_assigned_at"]),
          reminderCount: Number(row["reminder_count"]),
          lastReminderAt: toIso(row["last_reminder_at"]),
          escalationLevel: Number(row["escalation_level"]),
        };
  const notes = row["notes"] as string | null;
  return AccessReviewItemSchema.parse({
    id: row["item_id"],
    campaignId: row["campaign_business_id"],
    tenantId: row["tenant_id"],
    principalId: row["principal_id"],
    principalType: row["principal_type"],
    principalLabel: row["principal_label"],
    grantKind: row["grant_kind"],
    grantId: row["grant_id"],
    grantLabel: row["grant_label"],
    grantAttributes: parseJson(row["grant_attributes"], {}),
    grantedAt: toIso(row["granted_at"]),
    grantedBy: (row["granted_by"] as string | null) ?? null,
    lastUsedAt: toIso(row["last_used_at"]),
    riskLevel: row["risk_level"],
    status: row["status"],
    currentReviewer,
    createdAt: toIso(row["created_at"]),
    openedForReviewAt: toIso(row["opened_for_review_at"]),
    decidedAt: toIso(row["decided_at"]),
    decisionId: (row["decision_id"] as string | null) ?? null,
    autoRevokedAt: toIso(row["auto_revoked_at"]),
    autoRevokeReason: (row["auto_revoke_reason"] as string | null) ?? null,
    dueAt: toIso(row["due_at"]),
    ...(notes !== null && notes !== undefined ? { notes } : {}),
  });
}

/**
 * Reconstructs an `AccessReviewDecision` from a `meta.access_review_decisions` row joined
 * with its item + campaign (UUID FKs read back as the `ari_…` / `arc_…` business ids,
 * supplied as `item_business_id` / `campaign_business_id`).
 *
 * The decisions table flattens the attestation but stores neither `attestedAt` nor
 * `attestedByUserId` (the contract pins `attestedByUserId === decidedByUserId`, and
 * `attestedAt` is taken as `decided_at`); an optional `attestationPhrase` is not
 * persisted. The reconstructed attestation re-validates through the contract schema.
 */
export function rowToDecision(row: Record<string, unknown>): AccessReviewDecision {
  const decidedAt = toIso(row["decided_at"]);
  const comment = row["comment"] as string | null;
  return AccessReviewDecisionSchema.parse({
    id: row["decision_id"],
    itemId: row["item_business_id"],
    campaignId: row["campaign_business_id"],
    tenantId: row["tenant_id"],
    decidedByUserId: row["decided_by_user_id"],
    decidedAt,
    kind: row["kind"],
    reason: row["reason"],
    ...(comment !== null && comment !== undefined ? { comment } : {}),
    timeBoundExtendUntil: toIso(row["time_bound_extend_until"]),
    modifiedGrantAttributes:
      row["modified_grant_attributes"] === null || row["modified_grant_attributes"] === undefined
        ? null
        : (parseJson(row["modified_grant_attributes"], null) as Record<string, string> | null),
    attestation: {
      kind: row["attestation_kind"],
      attestedAt: decidedAt,
      attestedByUserId: row["decided_by_user_id"],
      signatureSha256: (row["attestation_signature_sha256"] as string | null) ?? null,
      signingKeyFingerprint: (row["attestation_signing_key_fingerprint"] as string | null) ?? null,
      coAttestingUserId: (row["co_attesting_user_id"] as string | null) ?? null,
      coAttestedAt: toIso(row["co_attested_at"]),
      ipAddress: row["ip_address"],
      userAgent: row["user_agent"],
    },
    supersedesDecisionId: (row["supersedes_decision_id"] as string | null) ?? null,
    relatedExceptionId: (row["related_exception_id"] as string | null) ?? null,
    appliedAt: toIso(row["applied_at"]),
    applicationFailedAt: toIso(row["application_failed_at"]),
    applicationFailureReason: (row["application_failure_reason"] as string | null) ?? null,
  });
}
