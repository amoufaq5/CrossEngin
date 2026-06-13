import { describe, expect, it } from "vitest";

import { generateReviewItem, generateReviewItems, type CampaignItemContext, type LiveGrant } from "./item-generation.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL = "00000000-0000-4000-8000-0000000000a1";
const GRANTOR = "00000000-0000-4000-8000-0000000000b1";

function ctx(over: Partial<CampaignItemContext> = {}): CampaignItemContext {
  let n = 0;
  return {
    campaignId: "arc_camp0001",
    tenantId: TENANT,
    dueAt: "2026-07-01T00:00:00.000Z",
    now: "2026-06-13T00:00:00.000Z",
    newItemId: () => `ari_${(++n).toString().padStart(8, "0")}`,
    ...over,
  };
}

function grant(over: Partial<LiveGrant> = {}): LiveGrant {
  return {
    principalId: PRINCIPAL,
    principalType: "user",
    principalLabel: "alice@acme.test",
    grantKind: "permission",
    grantId: "perm-1",
    grantLabel: "products.read",
    grantedAt: "2026-01-01T00:00:00.000Z",
    grantedBy: GRANTOR,
    lastUsedAt: "2026-06-01T00:00:00.000Z",
    mfaStatus: "totp",
    ...over,
  };
}

describe("generateReviewItem", () => {
  it("builds a pending, undecided item from a live grant", () => {
    const item = generateReviewItem(grant(), ctx());
    expect(item).toMatchObject({
      campaignId: "arc_camp0001",
      tenantId: TENANT,
      principalId: PRINCIPAL,
      grantId: "perm-1",
      status: "pending",
      currentReviewer: null,
      decisionId: null,
      dueAt: "2026-07-01T00:00:00.000Z",
    });
    expect(item.id).toMatch(/^ari_/);
  });

  it("scores a high-risk grant (external partner + role + no MFA + never used) as critical", () => {
    const item = generateReviewItem(
      grant({ principalType: "external_partner", grantKind: "role", mfaStatus: "none", lastUsedAt: null }),
      ctx(),
    );
    expect(item.riskLevel).toBe("critical");
  });

  it("scores a low-risk grant (user + permission + MFA + recently used) as low", () => {
    expect(generateReviewItem(grant(), ctx()).riskLevel).toBe("low");
  });

  it("generates one item per grant", () => {
    const items = generateReviewItems([grant({ grantId: "g1" }), grant({ grantId: "g2" })], ctx());
    expect(items.map((i) => i.grantId)).toEqual(["g1", "g2"]);
    expect(new Set(items.map((i) => i.id)).size).toBe(2); // unique ids
  });
});
