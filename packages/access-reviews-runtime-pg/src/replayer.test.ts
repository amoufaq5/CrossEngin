import { describe, expect, it } from "vitest";

import { PostgresAccessReviewCampaignStore } from "./campaign-store.js";
import { PostgresAccessReviewDecisionStore } from "./decision-store.js";
import { PostgresAccessReviewItemStore } from "./item-store.js";
import {
  AccessReviewReplayer,
  verifyCampaignRowShape,
  verifyDecisionRowShape,
  verifyItemRowShape,
} from "./replayer.js";
import { FakeConn, UUIDS, makeCampaign, makeDecision, makeItem } from "./test-fakes.js";

describe("verifyCampaignRowShape", () => {
  it("passes a well-formed campaign", () => {
    expect(verifyCampaignRowShape(makeCampaign())).toHaveLength(0);
  });

  it("flags a counter overflow", () => {
    const forced = { ...makeCampaign(), totalItems: 2, decidedItems: 2, autoRevokedItems: 1 };
    const issues = verifyCampaignRowShape(forced);
    expect(issues.map((i) => i.kind)).toContain("counter_overflow");
  });

  it("flags a cancelled campaign missing a reason", () => {
    const c = makeCampaign({ status: "scheduled" });
    const forced = { ...c, status: "cancelled" as const, cancelledReason: null };
    expect(verifyCampaignRowShape(forced).map((i) => i.kind)).toContain(
      "cancelled_without_reason",
    );
  });

  it("flags a completed campaign with open items", () => {
    const c = makeCampaign();
    const forced = {
      ...c,
      status: "completed" as const,
      completedAt: "2026-02-01T00:00:00.000Z",
      totalItems: 5,
      decidedItems: 1,
    };
    expect(verifyCampaignRowShape(forced).map((i) => i.kind)).toContain(
      "completed_with_open_items",
    );
  });
});

describe("verifyItemRowShape", () => {
  it("passes a well-formed item", () => {
    expect(verifyItemRowShape(makeItem())).toHaveLength(0);
  });

  it("flags a decided item without a decisionId", () => {
    const forced = { ...makeItem(), status: "decided" as const, decisionId: null };
    expect(verifyItemRowShape(forced).map((i) => i.kind)).toContain(
      "decided_without_decision_id",
    );
  });

  it("flags an item whose campaignId disagrees with its campaign", () => {
    const item = makeItem();
    const campaign = makeCampaign({ id: "arc_00000099" });
    expect(verifyItemRowShape(item, campaign).map((i) => i.kind)).toContain(
      "item_campaign_mismatch",
    );
  });
});

describe("verifyDecisionRowShape", () => {
  it("passes a decision consistent with its item", () => {
    expect(verifyDecisionRowShape(makeDecision(), makeItem())).toHaveLength(0);
  });

  it("flags a decision whose itemId disagrees", () => {
    const decision = makeDecision();
    const item = makeItem({ id: "ari_00000099" });
    expect(verifyDecisionRowShape(decision, item).map((i) => i.kind)).toContain(
      "decision_item_mismatch",
    );
  });
});

function stores(campaignRows: unknown[], itemRows: unknown[], decisionRows: unknown[]): AccessReviewReplayer {
  const conn = new FakeConn((sql) => {
    if (sql.includes("FROM meta.access_review_items i")) {
      return { rows: itemRows as Record<string, unknown>[], rowCount: itemRows.length };
    }
    if (sql.includes("FROM meta.access_review_decisions d")) {
      return { rows: decisionRows as Record<string, unknown>[], rowCount: decisionRows.length };
    }
    if (sql.includes("FROM meta.access_review_campaigns")) {
      return { rows: campaignRows as Record<string, unknown>[], rowCount: campaignRows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  return new AccessReviewReplayer({
    campaignStore: new PostgresAccessReviewCampaignStore(conn),
    itemStore: new PostgresAccessReviewItemStore(conn),
    decisionStore: new PostgresAccessReviewDecisionStore(conn),
  });
}

const campaignDbRow = {
  campaign_id: "arc_00000001",
  tenant_id: UUIDS.tenant,
  label: "Q",
  description: "d",
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
  created_at: "2025-12-01T00:00:00.000Z",
  created_by: UUIDS.creator,
  started_at: "2026-01-01T00:00:00.000Z",
  completed_at: null,
  archived_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  template_id: null,
  total_items: 1,
  decided_items: 0,
  auto_revoked_items: 0,
  exception_items: 0,
};

const itemDbRow = {
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
  status: "pending",
  current_reviewer_user_id: null,
  current_reviewer_kind: null,
  reviewer_assigned_at: null,
  reminder_count: 0,
  last_reminder_at: null,
  escalation_level: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  opened_for_review_at: null,
  decided_at: null,
  decision_id: null,
  auto_revoked_at: null,
  auto_revoke_reason: null,
  due_at: "2026-01-10T00:00:00.000Z",
  notes: null,
};

describe("AccessReviewReplayer", () => {
  it("returns no issues for a clean campaign graph", async () => {
    const replayer = stores([campaignDbRow], [itemDbRow], []);
    const issues = await replayer.verifyCampaign(UUIDS.tenant, "arc_00000001");
    expect(issues).toHaveLength(0);
  });

  it("returns empty when the campaign is absent", async () => {
    const replayer = stores([], [], []);
    expect(await replayer.verifyCampaign(UUIDS.tenant, "arc_00000001")).toHaveLength(0);
  });

  it("summarize counts campaigns, items, decisions", async () => {
    const replayer = stores([campaignDbRow], [itemDbRow], []);
    const summary = await replayer.summarize(UUIDS.tenant, "arc_00000001");
    expect(summary).toEqual({ campaigns: 1, items: 1, decisions: 0, issues: 0 });
  });
});
