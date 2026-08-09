import { describe, expect, it } from "vitest";
import { AccessReviewItemSchema } from "@crossengin/access-reviews";
import { CountingIdGenerator } from "./clock.js";
import {
  LiveGrantSchema,
  generateItems,
  resolveReviewerUserId,
  reviewerKindForPolicy,
} from "./item-generation.js";
import {
  UUID,
  defaultReviewerAssignment,
  makeCampaign,
  makeGrant,
  makePrincipal,
} from "./fixtures.js";

const NOW = new Date("2026-01-02T00:00:00.000Z");

const opts = (assignReviewers?: boolean) => ({
  ids: new CountingIdGenerator(),
  now: NOW,
  assignReviewers,
});

describe("LiveGrantSchema", () => {
  it("accepts a grant carrying a principalId", () => {
    expect(() => LiveGrantSchema.parse(makeGrant())).not.toThrow();
  });

  it("rejects a grant without a valid principalId", () => {
    expect(() =>
      LiveGrantSchema.parse({ ...makeGrant(), principalId: "not-a-uuid" }),
    ).toThrow();
  });
});

describe("reviewerKindForPolicy", () => {
  it("maps ai_suggested_human_confirmed to the pending-human kind", () => {
    expect(
      reviewerKindForPolicy(
        defaultReviewerAssignment({ policy: "ai_suggested_human_confirmed" }),
      ),
    ).toBe("ai_suggested_pending_human");
  });

  it("maps other policies to human_user", () => {
    expect(reviewerKindForPolicy(defaultReviewerAssignment())).toBe("human_user");
  });
});

describe("resolveReviewerUserId", () => {
  it("uses the principal manager for principal_manager", () => {
    const r = resolveReviewerUserId(defaultReviewerAssignment(), makePrincipal(), 0);
    expect(r).toBe(UUID.manager);
  });

  it("falls back when the manager is null", () => {
    const r = resolveReviewerUserId(
      defaultReviewerAssignment({ fallbackReviewerUserId: UUID.reviewer }),
      makePrincipal({ managerUserId: null }),
      0,
    );
    expect(r).toBe(UUID.reviewer);
  });

  it("uses the specific reviewer for specific_user", () => {
    const r = resolveReviewerUserId(
      defaultReviewerAssignment({
        policy: "specific_user",
        specificReviewerUserId: UUID.reviewer,
      }),
      makePrincipal(),
      0,
    );
    expect(r).toBe(UUID.reviewer);
  });

  it("round-robins across the pool", () => {
    const assignment = defaultReviewerAssignment({
      policy: "round_robin_pool",
      reviewerPoolUserIds: [UUID.poolOne, UUID.poolTwo],
      fallbackReviewerUserId: null,
    });
    expect(resolveReviewerUserId(assignment, makePrincipal(), 0)).toBe(UUID.poolOne);
    expect(resolveReviewerUserId(assignment, makePrincipal(), 1)).toBe(UUID.poolTwo);
    expect(resolveReviewerUserId(assignment, makePrincipal(), 2)).toBe(UUID.poolOne);
  });

  it("returns the fallback for role_based (concrete user resolved elsewhere)", () => {
    const r = resolveReviewerUserId(
      defaultReviewerAssignment({
        policy: "role_based",
        roleBasedReviewerRoleSlug: "auditor",
        fallbackReviewerUserId: UUID.reviewer,
      }),
      makePrincipal(),
      0,
    );
    expect(r).toBe(UUID.reviewer);
  });
});

describe("generateItems", () => {
  it("creates one pending item per grant of each in-scope principal", () => {
    const campaign = makeCampaign();
    const grants = [
      makeGrant({ grantId: "g1" }),
      makeGrant({ grantId: "g2", kind: "permission" }),
    ];
    const items = generateItems(campaign, grants, [makePrincipal()], opts(false));
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.status === "pending")).toBe(true);
    expect(items.every((i) => i.currentReviewer === null)).toBe(true);
    expect(items.map((i) => i.grantId)).toEqual(["g1", "g2"]);
    expect(items.every((i) => i.campaignId === campaign.id)).toBe(true);
    expect(items.every((i) => i.tenantId === campaign.tenantId)).toBe(true);
    expect(items.every((i) => i.dueAt === campaign.deadlineAt)).toBe(true);
  });

  it("excludes principals not matching the campaign scope", () => {
    const campaign = makeCampaign();
    const inScope = makePrincipal();
    const outOfScope = makePrincipal({
      principalId: UUID.principalB,
      principalType: "service_account",
      displayLabel: "svc-bot",
    });
    const grants = [
      makeGrant({ principalId: UUID.principalA, grantId: "g1" }),
      makeGrant({ principalId: UUID.principalB, grantId: "g2" }),
    ];
    const items = generateItems(campaign, grants, [inScope, outOfScope], opts(false));
    expect(items).toHaveLength(1);
    expect(items[0]?.principalId).toBe(UUID.principalA);
  });

  it("computes a higher risk level for an unused external api-key grant", () => {
    const campaign = makeCampaign({
      scope: { kind: "external_users_only", externalDomainsExcluded: [] },
    });
    const principal = makePrincipal({
      principalId: UUID.principalB,
      principalType: "external_partner",
      isExternal: true,
      mfaStatus: "none",
      displayLabel: "partner@vendor.example",
    });
    const grant = makeGrant({
      principalId: UUID.principalB,
      kind: "api_key_scope",
      lastUsedAt: null,
    });
    const items = generateItems(campaign, [grant], [principal], opts(false));
    expect(items[0]?.riskLevel).toBe("critical");
  });

  it("assigns a reviewer (in_review) when assignReviewers is true", () => {
    const campaign = makeCampaign();
    const items = generateItems(campaign, [makeGrant()], [makePrincipal()], opts(true));
    expect(items[0]?.status).toBe("in_review");
    expect(items[0]?.currentReviewer?.reviewerUserId).toBe(UUID.manager);
    expect(items[0]?.currentReviewer?.reviewerKind).toBe("human_user");
    expect(items[0]?.openedForReviewAt).toBe(NOW.toISOString());
  });

  it("leaves the item pending when the resolved reviewer would be the principal (four-eyes)", () => {
    const campaign = makeCampaign({
      reviewerAssignment: defaultReviewerAssignment({
        policy: "specific_user",
        specificReviewerUserId: UUID.principalA,
      }),
    });
    const items = generateItems(campaign, [makeGrant()], [makePrincipal()], opts(true));
    expect(items[0]?.status).toBe("pending");
    expect(items[0]?.currentReviewer).toBeNull();
  });

  it("defaults assignReviewers to true", () => {
    const campaign = makeCampaign();
    const items = generateItems(campaign, [makeGrant()], [makePrincipal()], {
      ids: new CountingIdGenerator(),
      now: NOW,
    });
    expect(items[0]?.status).toBe("in_review");
  });

  it("round-robins reviewers across an in-scope principal's grants", () => {
    const campaign = makeCampaign({
      reviewerAssignment: defaultReviewerAssignment({
        policy: "round_robin_pool",
        reviewerPoolUserIds: [UUID.poolOne, UUID.poolTwo],
        fallbackReviewerUserId: null,
      }),
    });
    const grants = [makeGrant({ grantId: "g1" }), makeGrant({ grantId: "g2" })];
    const items = generateItems(campaign, grants, [makePrincipal()], opts(true));
    expect(items[0]?.currentReviewer?.reviewerUserId).toBe(UUID.poolOne);
    expect(items[1]?.currentReviewer?.reviewerUserId).toBe(UUID.poolTwo);
  });

  it("emits schema-valid items with well-formed ids", () => {
    const items = generateItems(makeCampaign(), [makeGrant()], [makePrincipal()], opts(false));
    for (const item of items) {
      expect(() => AccessReviewItemSchema.parse(item)).not.toThrow();
      expect(item.id).toMatch(/^ari_[a-z0-9]{8,32}$/);
    }
  });

  it("returns an empty list when there are no grants", () => {
    const items = generateItems(makeCampaign(), [], [makePrincipal()], opts(false));
    expect(items).toEqual([]);
  });
});
