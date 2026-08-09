import { describe, expect, it } from "vitest";

import {
  requireIso,
  rowToCampaign,
  rowToDecision,
  rowToItem,
  toIso,
  type CampaignRow,
  type DecisionRow,
  type ItemRow,
} from "./records.js";
import { UUIDS } from "./test-fakes.js";

describe("toIso / requireIso", () => {
  it("converts a Date to an ISO string", () => {
    expect(toIso(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z");
  });

  it("passes a string through unchanged", () => {
    expect(toIso("2026-01-02T03:04:05.000Z")).toBe("2026-01-02T03:04:05.000Z");
  });

  it("maps null/undefined to null", () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
  });

  it("requireIso throws on a missing value", () => {
    expect(() => requireIso(null, "created_at")).toThrow(/created_at/);
  });
});

const campaignRow: CampaignRow = {
  campaign_id: "arc_00000001",
  tenant_id: UUIDS.tenant,
  label: "Q review",
  description: "desc",
  frequency: "quarterly",
  framework: "soc2_type2",
  status: "in_progress",
  scope: { kind: "all_users_with_role", roleSlug: "member", includeInherited: true },
  reviewer_assignment: {
    policy: "principal_manager",
    fallbackReviewerUserId: UUIDS.reviewer,
    reviewerPoolUserIds: [],
    specificReviewerUserId: null,
    roleBasedReviewerRoleSlug: null,
    escalationChainUserIds: [],
    escalationTimeoutHours: 72,
  },
  auto_revoke_policy: "auto_revoke_on_deadline",
  related_incident_id: null,
  scheduled_start_at: "2026-01-01T00:00:00.000Z",
  deadline_at: "2026-01-15T00:00:00.000Z",
  grace_period_hours: 24,
  remediation_deadline_at: null,
  created_at: new Date("2025-12-01T00:00:00.000Z"),
  created_by: UUIDS.creator,
  started_at: "2026-01-01T00:00:00.000Z",
  completed_at: null,
  archived_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  template_id: null,
  total_items: 3,
  decided_items: 1,
  auto_revoked_items: 0,
  exception_items: 0,
};

describe("rowToCampaign", () => {
  it("maps snake_case columns to the contract record", () => {
    const c = rowToCampaign(campaignRow);
    expect(c.id).toBe("arc_00000001");
    expect(c.tenantId).toBe(UUIDS.tenant);
    expect(c.autoRevokePolicy).toBe("auto_revoke_on_deadline");
    expect(c.createdAt).toBe("2025-12-01T00:00:00.000Z");
    expect(c.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(c.totalItems).toBe(3);
  });
});

const itemRow: ItemRow = {
  item_id: "ari_00000001",
  tenant_id: UUIDS.tenant,
  campaign_natural_id: "arc_00000001",
  principal_id: UUIDS.principal,
  principal_type: "user",
  principal_label: "alice",
  grant_kind: "role",
  grant_id: "grant-1",
  grant_label: "admin",
  grant_attributes: {},
  granted_at: "2024-01-01T00:00:00.000Z",
  granted_by: UUIDS.creator,
  last_used_at: null,
  risk_level: "high",
  status: "in_review",
  current_reviewer_user_id: UUIDS.reviewer,
  current_reviewer_kind: "human_user",
  reviewer_assigned_at: "2026-01-02T00:00:00.000Z",
  reminder_count: 2,
  last_reminder_at: "2026-01-03T00:00:00.000Z",
  escalation_level: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  opened_for_review_at: "2026-01-02T00:00:00.000Z",
  decided_at: null,
  decision_id: null,
  auto_revoked_at: null,
  auto_revoke_reason: null,
  due_at: "2026-01-10T00:00:00.000Z",
  notes: null,
};

describe("rowToItem", () => {
  it("reconstructs a nested currentReviewer from flat columns", () => {
    const it_ = rowToItem(itemRow);
    expect(it_.campaignId).toBe("arc_00000001");
    expect(it_.currentReviewer).toEqual({
      reviewerUserId: UUIDS.reviewer,
      reviewerKind: "human_user",
      assignedAt: "2026-01-02T00:00:00.000Z",
      reminderCount: 2,
      lastReminderAt: "2026-01-03T00:00:00.000Z",
      escalationLevel: 1,
    });
    expect("notes" in it_).toBe(false);
  });

  it("returns a null currentReviewer when the reviewer columns are null", () => {
    const it_ = rowToItem({
      ...itemRow,
      current_reviewer_user_id: null,
      current_reviewer_kind: null,
      reviewer_assigned_at: null,
      status: "pending",
    });
    expect(it_.currentReviewer).toBeNull();
  });
});

const decisionRow: DecisionRow = {
  decision_id: "ard_00000001",
  item_natural_id: "ari_00000001",
  campaign_natural_id: "arc_00000001",
  tenant_id: UUIDS.tenant,
  decided_by_user_id: UUIDS.system,
  decided_at: "2026-02-01T00:00:00.000Z",
  kind: "revoke",
  reason: "no_response_auto_default",
  comment: "auto",
  time_bound_extend_until: null,
  modified_grant_attributes: null,
  attestation_kind: "click_through_acknowledgement",
  attestation_signature_sha256: null,
  attestation_signing_key_fingerprint: null,
  co_attesting_user_id: null,
  co_attested_at: null,
  ip_address: "127.0.0.1",
  user_agent: "runtime",
  supersedes_decision_id: null,
  related_exception_id: null,
  applied_at: null,
  application_failed_at: null,
  application_failure_reason: null,
};

describe("rowToDecision", () => {
  it("rebuilds the nested attestation, deriving attestedBy/attestedAt from decided_*", () => {
    const d = rowToDecision(decisionRow);
    expect(d.itemId).toBe("ari_00000001");
    expect(d.campaignId).toBe("arc_00000001");
    expect(d.attestation.attestedByUserId).toBe(UUIDS.system);
    expect(d.attestation.attestedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(d.attestation.ipAddress).toBe("127.0.0.1");
  });
});
