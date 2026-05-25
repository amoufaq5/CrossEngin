import { describe, expect, it } from "vitest";
import {
  AUTO_REVOKE_POLICIES,
  AccessReviewCampaignSchema,
  CAMPAIGN_FREQUENCIES,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TRANSITIONS,
  COMPLIANCE_FRAMEWORKS,
  REVIEWER_ASSIGNMENT_POLICIES,
  ReviewerAssignmentSchema,
  canTransitionCampaign,
  computeCampaignProgress,
  computeNextScheduledStart,
  isPastDeadline,
  isPastGracePeriod,
  type AccessReviewCampaign,
} from "./campaigns.js";

const baseCampaign: AccessReviewCampaign = {
  id: "arc_q22026adm",
  tenantId: "11111111-1111-1111-1111-111111111111",
  label: "Q2 2026 Admin Access Review",
  description: "Quarterly review of all admin role grants",
  frequency: "quarterly",
  framework: "soc2_type2",
  status: "scheduled",
  scope: {
    kind: "all_users_with_role",
    roleSlug: "admin",
    includeInherited: true,
  },
  reviewerAssignment: {
    policy: "principal_manager",
    fallbackReviewerUserId: "22222222-2222-2222-2222-222222222222",
    reviewerPoolUserIds: [],
    specificReviewerUserId: null,
    roleBasedReviewerRoleSlug: null,
    escalationChainUserIds: [
      "33333333-3333-3333-3333-333333333333",
      "44444444-4444-4444-4444-444444444444",
    ],
    escalationTimeoutHours: 72,
  },
  autoRevokePolicy: "escalate_to_manager",
  relatedIncidentId: null,
  scheduledStartAt: "2026-04-01T00:00:00.000Z",
  deadlineAt: "2026-04-30T23:59:59.000Z",
  gracePeriodHours: 24,
  remediationDeadlineAt: "2026-05-15T00:00:00.000Z",
  createdAt: "2026-03-15T10:00:00.000Z",
  createdBy: "55555555-5555-5555-5555-555555555555",
  startedAt: null,
  completedAt: null,
  archivedAt: null,
  cancelledAt: null,
  cancelledReason: null,
  templateId: null,
  totalItems: 50,
  decidedItems: 0,
  autoRevokedItems: 0,
  exceptionItems: 0,
};

describe("constants", () => {
  it("has 8 campaign frequencies", () => {
    expect(CAMPAIGN_FREQUENCIES).toHaveLength(8);
  });
  it("has 7 campaign statuses", () => {
    expect(CAMPAIGN_STATUSES).toHaveLength(7);
  });
  it("has 5 reviewer assignment policies", () => {
    expect(REVIEWER_ASSIGNMENT_POLICIES).toHaveLength(5);
  });
  it("has 4 auto-revoke policies", () => {
    expect(AUTO_REVOKE_POLICIES).toHaveLength(4);
  });
  it("has 7 compliance frameworks", () => {
    expect(COMPLIANCE_FRAMEWORKS).toHaveLength(7);
  });
});

describe("canTransitionCampaign", () => {
  it("allows draft → scheduled", () => {
    expect(canTransitionCampaign("draft", "scheduled")).toBe(true);
  });
  it("blocks draft → completed", () => {
    expect(canTransitionCampaign("draft", "completed")).toBe(false);
  });
  it("blocks completed → in_progress (no rollback)", () => {
    expect(canTransitionCampaign("completed", "in_progress")).toBe(false);
  });
  it("archived is terminal", () => {
    expect(CAMPAIGN_TRANSITIONS.archived).toEqual([]);
  });
});

describe("ReviewerAssignmentSchema", () => {
  it("accepts principal_manager policy", () => {
    expect(() => ReviewerAssignmentSchema.parse(baseCampaign.reviewerAssignment)).not.toThrow();
  });

  it("rejects specific_user without specificReviewerUserId", () => {
    expect(() =>
      ReviewerAssignmentSchema.parse({
        ...baseCampaign.reviewerAssignment,
        policy: "specific_user",
      }),
    ).toThrow(/specific_user policy requires specificReviewerUserId/);
  });

  it("rejects role_based without roleBasedReviewerRoleSlug", () => {
    expect(() =>
      ReviewerAssignmentSchema.parse({
        ...baseCampaign.reviewerAssignment,
        policy: "role_based",
      }),
    ).toThrow(/role_based policy requires roleBasedReviewerRoleSlug/);
  });

  it("rejects round_robin_pool with empty pool", () => {
    expect(() =>
      ReviewerAssignmentSchema.parse({
        ...baseCampaign.reviewerAssignment,
        policy: "round_robin_pool",
      }),
    ).toThrow(/non-empty reviewerPoolUserIds/);
  });

  it("rejects duplicate reviewer ids across pool + escalation chain", () => {
    expect(() =>
      ReviewerAssignmentSchema.parse({
        ...baseCampaign.reviewerAssignment,
        reviewerPoolUserIds: ["33333333-3333-3333-3333-333333333333"],
        escalationChainUserIds: ["33333333-3333-3333-3333-333333333333"],
      }),
    ).toThrow(/reviewer ids must be unique/);
  });
});

describe("AccessReviewCampaignSchema", () => {
  it("accepts a valid scheduled campaign", () => {
    expect(() => AccessReviewCampaignSchema.parse(baseCampaign)).not.toThrow();
  });

  it("rejects deadlineAt <= scheduledStartAt", () => {
    expect(() =>
      AccessReviewCampaignSchema.parse({
        ...baseCampaign,
        deadlineAt: baseCampaign.scheduledStartAt,
      }),
    ).toThrow(/deadlineAt must be after scheduledStartAt/);
  });

  it("rejects post_incident campaign without relatedIncidentId", () => {
    expect(() =>
      AccessReviewCampaignSchema.parse({
        ...baseCampaign,
        frequency: "post_incident",
      }),
    ).toThrow(/post_incident frequency requires relatedIncidentId/);
  });

  it("rejects completed status without completedAt", () => {
    expect(() =>
      AccessReviewCampaignSchema.parse({
        ...baseCampaign,
        status: "completed",
        startedAt: "2026-04-01T00:00:00.000Z",
        decidedItems: 50,
      }),
    ).toThrow(/completed campaign requires completedAt/);
  });

  it("rejects cancelled without cancelledReason", () => {
    expect(() =>
      AccessReviewCampaignSchema.parse({
        ...baseCampaign,
        status: "cancelled",
      }),
    ).toThrow(/cancelled campaign requires cancelledReason/);
  });

  it("rejects counts exceeding totalItems", () => {
    expect(() =>
      AccessReviewCampaignSchema.parse({
        ...baseCampaign,
        totalItems: 10,
        decidedItems: 8,
        autoRevokedItems: 3,
        exceptionItems: 1,
      }),
    ).toThrow(/cannot exceed totalItems/);
  });

  it("rejects completed campaign with unresolved items", () => {
    expect(() =>
      AccessReviewCampaignSchema.parse({
        ...baseCampaign,
        status: "completed",
        startedAt: "2026-04-01T00:00:00.000Z",
        completedAt: "2026-04-30T23:59:59.000Z",
        totalItems: 50,
        decidedItems: 30,
        autoRevokedItems: 5,
        exceptionItems: 5,
      }),
    ).toThrow(/all items decided/);
  });
});

describe("computeCampaignProgress", () => {
  it("returns 0 when nothing resolved", () => {
    expect(computeCampaignProgress(baseCampaign)).toBe(0);
  });

  it("returns 1 when totalItems is 0 (vacuous)", () => {
    expect(computeCampaignProgress({ ...baseCampaign, totalItems: 0 })).toBe(1);
  });

  it("returns ratio of resolved/total", () => {
    expect(
      computeCampaignProgress({
        ...baseCampaign,
        decidedItems: 30,
        autoRevokedItems: 5,
        exceptionItems: 5,
      }),
    ).toBe(40 / 50);
  });
});

describe("isPastDeadline", () => {
  it("returns false before deadline", () => {
    expect(isPastDeadline(baseCampaign, new Date("2026-04-15T00:00:00Z"))).toBe(false);
  });
  it("returns true after deadline", () => {
    expect(isPastDeadline(baseCampaign, new Date("2026-05-01T00:00:00Z"))).toBe(true);
  });
});

describe("isPastGracePeriod", () => {
  it("returns false within grace period", () => {
    expect(isPastGracePeriod(baseCampaign, new Date("2026-05-01T12:00:00Z"))).toBe(false);
  });
  it("returns true after grace period (24h)", () => {
    expect(isPastGracePeriod(baseCampaign, new Date("2026-05-02T00:00:00Z"))).toBe(true);
  });
});

describe("computeNextScheduledStart", () => {
  it("returns null for one_time", () => {
    expect(computeNextScheduledStart({ ...baseCampaign, frequency: "one_time" })).toBeNull();
  });
  it("returns null for post_incident", () => {
    expect(
      computeNextScheduledStart({
        ...baseCampaign,
        frequency: "post_incident",
        relatedIncidentId: "INC-2026-0001",
      }),
    ).toBeNull();
  });
  it("returns next start ~91 days later for quarterly", () => {
    const next = computeNextScheduledStart(baseCampaign);
    expect(next).not.toBeNull();
    if (next) {
      const delta = Date.parse(next) - Date.parse(baseCampaign.scheduledStartAt);
      const days = delta / 86_400_000;
      expect(days).toBe(91);
    }
  });
  it("returns next start ~365 days later for annual", () => {
    const next = computeNextScheduledStart({
      ...baseCampaign,
      frequency: "annual",
    });
    if (next) {
      const days = (Date.parse(next) - Date.parse(baseCampaign.scheduledStartAt)) / 86_400_000;
      expect(days).toBe(365);
    }
  });
});
