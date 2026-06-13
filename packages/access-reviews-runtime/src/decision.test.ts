import { AccessReviewDecisionSchema, assignReviewer, type AccessReviewDecision, type AccessReviewItem } from "@crossengin/access-reviews";
import { describe, expect, it } from "vitest";

import { recordItemDecision, DecisionItemMismatchError, IllegalItemDecisionError, StrongAttestationRequiredError } from "./decision.js";
import { generateReviewItem, type CampaignItemContext, type LiveGrant } from "./item-generation.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL = "00000000-0000-4000-8000-0000000000a1";
const REVIEWER = "00000000-0000-4000-8000-0000000000c1";

let n = 0;
const CTX: CampaignItemContext = {
  campaignId: "arc_camp0001",
  tenantId: TENANT,
  dueAt: "2026-07-01T00:00:00.000Z",
  now: "2026-06-13T00:00:00.000Z",
  newItemId: () => `ari_${(++n).toString().padStart(8, "0")}`,
};
const GRANT: LiveGrant = {
  principalId: PRINCIPAL,
  principalType: "user",
  principalLabel: "alice",
  grantKind: "permission",
  grantId: "p1",
  grantLabel: "products.read",
  grantedAt: "2026-01-01T00:00:00.000Z",
  grantedBy: null,
  lastUsedAt: "2026-06-01T00:00:00.000Z",
  mfaStatus: "totp",
};

/** A pending item moved into review by REVIEWER. */
function inReviewItem(): AccessReviewItem {
  return assignReviewer(generateReviewItem(GRANT, CTX), REVIEWER, "human_user", new Date("2026-06-14T00:00:00.000Z"));
}

const WEAK_ATTESTATION = {
  kind: "click_through_acknowledgement",
  attestedAt: "2026-06-15T00:00:00.000Z",
  attestedByUserId: REVIEWER,
  signatureSha256: null,
  signingKeyFingerprint: null,
  coAttestingUserId: null,
  coAttestedAt: null,
  ipAddress: "203.0.113.1",
  userAgent: "test-agent",
};
const STRONG_ATTESTATION = {
  ...WEAK_ATTESTATION,
  kind: "e_signature_digital",
  signatureSha256: "a".repeat(64),
  signingKeyFingerprint: "b".repeat(64),
};

function decision(item: AccessReviewItem, over: Partial<AccessReviewDecision> & { attestation?: unknown } = {}): AccessReviewDecision {
  return AccessReviewDecisionSchema.parse({
    id: `ard_${(++n).toString().padStart(8, "0")}`,
    itemId: item.id,
    campaignId: item.campaignId,
    tenantId: item.tenantId,
    decidedByUserId: REVIEWER,
    decidedAt: "2026-06-15T00:00:00.000Z",
    kind: "keep",
    reason: "role_appropriate",
    timeBoundExtendUntil: null,
    modifiedGrantAttributes: null,
    attestation: WEAK_ATTESTATION,
    supersedesDecisionId: null,
    relatedExceptionId: null,
    appliedAt: null,
    applicationFailedAt: null,
    applicationFailureReason: null,
    ...over,
  });
}

describe("recordItemDecision", () => {
  it("applies a keep decision → the item is decided + linked", () => {
    const item = inReviewItem();
    const result = recordItemDecision(item, decision(item));
    expect(result).toMatchObject({ status: "decided", decisionId: expect.stringMatching(/^ard_/) as unknown });
    expect(result.decidedAt).toBe("2026-06-15T00:00:00.000Z");
  });

  it("blocks a strong-attestation-required decision (time_bound_extend) with a weak attestation", () => {
    const item = inReviewItem();
    const weak = decision(item, { kind: "time_bound_extend", reason: "business_justification_attested", timeBoundExtendUntil: "2026-12-01T00:00:00.000Z", attestation: WEAK_ATTESTATION });
    expect(() => recordItemDecision(item, weak)).toThrow(StrongAttestationRequiredError);
  });

  it("allows the same decision once the attestation is strong", () => {
    const item = inReviewItem();
    const strong = decision(item, { kind: "time_bound_extend", reason: "business_justification_attested", timeBoundExtendUntil: "2026-12-01T00:00:00.000Z", attestation: STRONG_ATTESTATION });
    expect(recordItemDecision(item, strong).status).toBe("decided");
  });

  it("parks a defer_to_next_campaign decision (status deferred)", () => {
    // a pending item can defer directly
    const pending = generateReviewItem(GRANT, CTX);
    const defer = decision(pending, { kind: "defer_to_next_campaign", reason: "principal_no_longer_in_scope" });
    expect(recordItemDecision(pending, defer).status).toBe("deferred_to_next_campaign");
  });

  it("rejects deciding a still-pending item (must enter review first)", () => {
    const pending = generateReviewItem(GRANT, CTX);
    expect(() => recordItemDecision(pending, decision(pending))).toThrow(IllegalItemDecisionError);
  });

  it("rejects a decision that doesn't belong to the item", () => {
    const item = inReviewItem();
    const other = decision(item, { itemId: "ari_99999999" });
    expect(() => recordItemDecision(item, other)).toThrow(DecisionItemMismatchError);
  });
});
