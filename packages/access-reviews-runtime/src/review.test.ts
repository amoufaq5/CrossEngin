import { AccessReviewItemSchema, assignReviewer, type AccessReviewCampaign, type AccessReviewItem } from "@crossengin/access-reviews";
import { describe, expect, it } from "vitest";

import { generateReviewItem, type CampaignItemContext, type LiveGrant } from "./item-generation.js";
import { allItemsResolved, itemsToEscalate, nextCampaignStart, overdueItems, summarizeItems } from "./review.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL = "00000000-0000-4000-8000-0000000000a1";
const REVIEWER = "00000000-0000-4000-8000-0000000000c1";

let counter = 0;
function ctx(dueAt: string): CampaignItemContext {
  return { campaignId: "arc_camp0001", tenantId: TENANT, dueAt, now: "2026-06-13T00:00:00.000Z", newItemId: () => `ari_${(++counter).toString().padStart(8, "0")}` };
}
function grant(): LiveGrant {
  return { principalId: PRINCIPAL, principalType: "user", principalLabel: "alice", grantKind: "permission", grantId: "p1", grantLabel: "products.read", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: null, lastUsedAt: "2026-06-01T00:00:00.000Z", mfaStatus: "totp" };
}
function pending(dueAt: string): AccessReviewItem {
  return generateReviewItem(grant(), ctx(dueAt));
}
function decided(item: AccessReviewItem): AccessReviewItem {
  return AccessReviewItemSchema.parse({ ...item, status: "decided", decidedAt: "2026-06-20T00:00:00.000Z", decisionId: "dec-1" });
}

describe("summarizeItems", () => {
  it("counts resolved / pending / overdue and computes progress", () => {
    const now = new Date("2026-06-25T00:00:00.000Z");
    const items = [
      decided(pending("2026-07-01T00:00:00.000Z")), // resolved
      pending("2026-06-20T00:00:00.000Z"), // pending + overdue (due before now)
      pending("2026-07-10T00:00:00.000Z"), // pending, not overdue
    ];
    const s = summarizeItems(items, now);
    expect(s).toMatchObject({ total: 3, resolved: 1, pending: 2, overdue: 1 });
    expect(s.progress).toBeCloseTo(1 / 3);
  });

  it("is 100% progress for an empty campaign", () => {
    expect(summarizeItems([], new Date()).progress).toBe(1);
  });
});

describe("overdueItems / itemsToEscalate / allItemsResolved", () => {
  it("flags only past-due unresolved items as overdue", () => {
    const now = new Date("2026-06-25T00:00:00.000Z");
    const overdue = pending("2026-06-20T00:00:00.000Z");
    const future = pending("2026-07-10T00:00:00.000Z");
    const resolvedPastDue = decided(pending("2026-06-20T00:00:00.000Z"));
    expect(overdueItems([overdue, future, resolvedPastDue], now).map((i) => i.id)).toEqual([overdue.id]);
  });

  it("escalates an in-review item whose reviewer has sat past the timeout", () => {
    const assigned = assignReviewer(pending("2026-07-01T00:00:00.000Z"), REVIEWER, "human_user", new Date("2026-06-13T00:00:00.000Z"));
    // 48h later, with a 24h escalation timeout → escalate
    const now = new Date("2026-06-15T00:00:00.000Z");
    expect(itemsToEscalate([assigned], now, 24).map((i) => i.id)).toEqual([assigned.id]);
    // within the timeout → not yet
    expect(itemsToEscalate([assigned], new Date("2026-06-13T12:00:00.000Z"), 24)).toEqual([]);
  });

  it("allItemsResolved is true only when every item is resolved", () => {
    expect(allItemsResolved([decided(pending("2026-07-01T00:00:00.000Z"))])).toBe(true);
    expect(allItemsResolved([pending("2026-07-01T00:00:00.000Z")])).toBe(false);
  });
});

describe("nextCampaignStart", () => {
  it("advances a recurring campaign and is null for one-time", () => {
    const quarterly = { frequency: "quarterly", scheduledStartAt: "2026-01-01T00:00:00.000Z" } as unknown as AccessReviewCampaign;
    expect(nextCampaignStart(quarterly)).not.toBeNull();
    const oneTime = { frequency: "one_time", scheduledStartAt: "2026-01-01T00:00:00.000Z" } as unknown as AccessReviewCampaign;
    expect(nextCampaignStart(oneTime)).toBeNull();
  });
});
