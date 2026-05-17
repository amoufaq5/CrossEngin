import { describe, expect, it } from "vitest";
import {
  AccessReviewItemSchema,
  REVIEW_ITEM_STATUSES,
  REVIEW_ITEM_TRANSITIONS,
  REVIEWER_KINDS,
  RISK_LEVELS,
  ReviewerAssignmentStateSchema,
  assignReviewer,
  canTransitionItem,
  computeRiskLevel,
  isItemOverdue,
  shouldEscalate,
  type AccessReviewItem,
} from "./items.js";

const baseItem: AccessReviewItem = {
  id: "ari_abc12345",
  campaignId: "arc_q22026adm",
  tenantId: "11111111-1111-1111-1111-111111111111",
  principalId: "22222222-2222-2222-2222-222222222222",
  principalType: "user",
  principalLabel: "alice@acme.com",
  grantKind: "role",
  grantId: "role:admin",
  grantLabel: "Admin role",
  grantAttributes: {},
  grantedAt: "2025-04-01T00:00:00.000Z",
  grantedBy: "33333333-3333-3333-3333-333333333333",
  lastUsedAt: "2026-05-01T00:00:00.000Z",
  riskLevel: "medium",
  status: "pending",
  currentReviewer: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  openedForReviewAt: null,
  decidedAt: null,
  decisionId: null,
  autoRevokedAt: null,
  autoRevokeReason: null,
  dueAt: "2026-04-30T23:59:59.000Z",
};

describe("constants", () => {
  it("has 8 review item statuses", () => {
    expect(REVIEW_ITEM_STATUSES).toHaveLength(8);
  });
  it("has 3 reviewer kinds", () => {
    expect(REVIEWER_KINDS).toHaveLength(3);
  });
  it("has 4 risk levels", () => {
    expect(RISK_LEVELS).toHaveLength(4);
  });
});

describe("canTransitionItem", () => {
  it("allows pending → in_review", () => {
    expect(canTransitionItem("pending", "in_review")).toBe(true);
  });
  it("blocks pending → decided (must go through in_review)", () => {
    expect(canTransitionItem("pending", "decided")).toBe(false);
  });
  it("decided is terminal", () => {
    expect(REVIEW_ITEM_TRANSITIONS.decided).toEqual([]);
  });
  it("auto_revoked is terminal", () => {
    expect(REVIEW_ITEM_TRANSITIONS.auto_revoked).toEqual([]);
  });
});

describe("ReviewerAssignmentStateSchema", () => {
  it("accepts a valid state", () => {
    expect(() =>
      ReviewerAssignmentStateSchema.parse({
        reviewerUserId: "44444444-4444-4444-4444-444444444444",
        reviewerKind: "human_user",
        assignedAt: "2026-04-05T10:00:00.000Z",
        reminderCount: 2,
        lastReminderAt: "2026-04-15T10:00:00.000Z",
        escalationLevel: 0,
      }),
    ).not.toThrow();
  });
});

describe("AccessReviewItemSchema", () => {
  it("accepts a valid pending item", () => {
    expect(() => AccessReviewItemSchema.parse(baseItem)).not.toThrow();
  });

  it("rejects four-eyes violation (reviewer === principal)", () => {
    expect(() =>
      AccessReviewItemSchema.parse({
        ...baseItem,
        status: "in_review",
        currentReviewer: {
          reviewerUserId: baseItem.principalId,
          reviewerKind: "human_user",
          assignedAt: "2026-04-05T10:00:00.000Z",
          reminderCount: 0,
          lastReminderAt: null,
          escalationLevel: 0,
        },
      }),
    ).toThrow(/four-eyes/);
  });

  it("rejects in_review without currentReviewer", () => {
    expect(() =>
      AccessReviewItemSchema.parse({
        ...baseItem,
        status: "in_review",
      }),
    ).toThrow(/requires currentReviewer/);
  });

  it("rejects decided without decisionId", () => {
    expect(() =>
      AccessReviewItemSchema.parse({
        ...baseItem,
        status: "decided",
        decidedAt: "2026-04-15T10:00:00.000Z",
      }),
    ).toThrow(/requires decisionId/);
  });

  it("rejects auto_revoked without autoRevokedAt", () => {
    expect(() =>
      AccessReviewItemSchema.parse({
        ...baseItem,
        status: "auto_revoked",
        autoRevokeReason: "no_response",
      }),
    ).toThrow(/requires autoRevokedAt/);
  });

  it("rejects auto_revoked without autoRevokeReason", () => {
    expect(() =>
      AccessReviewItemSchema.parse({
        ...baseItem,
        status: "auto_revoked",
        autoRevokedAt: "2026-05-02T00:00:00.000Z",
      }),
    ).toThrow(/requires autoRevokeReason/);
  });

  it("rejects openedForReviewAt before createdAt", () => {
    expect(() =>
      AccessReviewItemSchema.parse({
        ...baseItem,
        openedForReviewAt: "2026-03-01T00:00:00.000Z",
      }),
    ).toThrow(/cannot precede createdAt/);
  });
});

describe("computeRiskLevel", () => {
  it("flags service_account + no-MFA + role grant as critical", () => {
    const r = computeRiskLevel({
      grantKind: "role",
      principalType: "service_account",
      lastUsedAt: null,
      mfaStatus: "none",
      grantAgeDays: 800,
    });
    expect(r).toBe("critical");
  });

  it("flags external_partner + api_key as critical", () => {
    const r = computeRiskLevel({
      grantKind: "api_key_scope",
      principalType: "external_partner",
      lastUsedAt: "2026-05-01T00:00:00.000Z",
      mfaStatus: "none",
      grantAgeDays: 100,
    });
    expect(r).toBe("critical");
  });

  it("returns low for recent user with strong MFA + recent grant", () => {
    const r = computeRiskLevel({
      grantKind: "permission",
      principalType: "user",
      lastUsedAt: "2026-05-01T00:00:00.000Z",
      mfaStatus: "webauthn",
      grantAgeDays: 30,
    });
    expect(r).toBe("low");
  });
});

describe("isItemOverdue", () => {
  it("returns true past dueAt for pending item", () => {
    expect(
      isItemOverdue(baseItem, new Date("2026-05-01T00:00:00Z")),
    ).toBe(true);
  });
  it("returns false before dueAt", () => {
    expect(
      isItemOverdue(baseItem, new Date("2026-04-15T00:00:00Z")),
    ).toBe(false);
  });
  it("returns false for already-decided item even past due", () => {
    expect(
      isItemOverdue(
        {
          ...baseItem,
          status: "decided",
          decidedAt: "2026-04-20T00:00:00.000Z",
          decisionId: "ard_xyz",
        },
        new Date("2026-05-01T00:00:00Z"),
      ),
    ).toBe(false);
  });
});

describe("shouldEscalate", () => {
  const itemInReview: AccessReviewItem = {
    ...baseItem,
    status: "in_review",
    currentReviewer: {
      reviewerUserId: "44444444-4444-4444-4444-444444444444",
      reviewerKind: "human_user",
      assignedAt: "2026-04-05T10:00:00.000Z",
      reminderCount: 1,
      lastReminderAt: null,
      escalationLevel: 0,
    },
    openedForReviewAt: "2026-04-05T10:00:00.000Z",
  };

  it("returns true when timeout elapsed", () => {
    expect(
      shouldEscalate(itemInReview, new Date("2026-04-09T10:00:00Z"), 72),
    ).toBe(true);
  });

  it("returns false when within timeout", () => {
    expect(
      shouldEscalate(itemInReview, new Date("2026-04-06T10:00:00Z"), 72),
    ).toBe(false);
  });

  it("returns false for non-in_review items", () => {
    expect(
      shouldEscalate(baseItem, new Date("2026-05-01T00:00:00Z"), 72),
    ).toBe(false);
  });
});

describe("assignReviewer", () => {
  it("transitions pending → in_review with reviewer set", () => {
    const r = assignReviewer(
      baseItem,
      "44444444-4444-4444-4444-444444444444",
      "human_user",
      new Date("2026-04-05T10:00:00Z"),
    );
    expect(r.status).toBe("in_review");
    expect(r.currentReviewer?.reviewerUserId).toBe(
      "44444444-4444-4444-4444-444444444444",
    );
  });

  it("throws on four-eyes violation", () => {
    expect(() =>
      assignReviewer(
        baseItem,
        baseItem.principalId,
        "human_user",
        new Date("2026-04-05T10:00:00Z"),
      ),
    ).toThrow(/four-eyes/);
  });

  it("throws on invalid transition (already decided)", () => {
    expect(() =>
      assignReviewer(
        {
          ...baseItem,
          status: "decided",
          decidedAt: "2026-04-15T10:00:00.000Z",
          decisionId: "ard_xyz",
        },
        "44444444-4444-4444-4444-444444444444",
        "human_user",
        new Date("2026-04-20T10:00:00Z"),
      ),
    ).toThrow(/cannot transition/);
  });
});
