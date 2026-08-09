import { describe, expect, it } from "vitest";
import {
  AccessReviewDecisionSchema,
  type AccessReviewItem,
} from "@crossengin/access-reviews";
import { CountingIdGenerator } from "./clock.js";
import { generateItems } from "./item-generation.js";
import {
  REVOKING_AUTO_POLICIES,
  UNATTESTED_ITEM_STATUSES,
  isAutoRevocable,
  planAutoRevocations,
} from "./enforcement.js";
import { UUID, makeCampaign, makeGrant, makePrincipal } from "./fixtures.js";

const BEFORE_DEADLINE = new Date("2026-01-10T00:00:00.000Z");
const AFTER_DEADLINE = new Date("2026-01-16T00:00:00.000Z");
const AFTER_GRACE = new Date("2026-01-16T06:00:00.000Z");

const pendingItems = (): readonly AccessReviewItem[] =>
  generateItems(
    makeCampaign(),
    [makeGrant({ grantId: "g1" }), makeGrant({ grantId: "g2" })],
    [makePrincipal()],
    { ids: new CountingIdGenerator(), now: BEFORE_DEADLINE, assignReviewers: false },
  );

const revokeOpts = (now: Date, requireGracePeriod?: boolean) => ({
  ids: new CountingIdGenerator(500),
  now,
  systemActorUserId: UUID.system,
  requireGracePeriod,
});

describe("constants", () => {
  it("only auto_revoke_on_deadline and default_revoke revoke", () => {
    expect(REVOKING_AUTO_POLICIES.has("auto_revoke_on_deadline")).toBe(true);
    expect(REVOKING_AUTO_POLICIES.has("default_revoke")).toBe(true);
    expect(REVOKING_AUTO_POLICIES.has("default_keep")).toBe(false);
    expect(REVOKING_AUTO_POLICIES.has("escalate_to_manager")).toBe(false);
  });

  it("treats open item statuses as un-attested", () => {
    expect(UNATTESTED_ITEM_STATUSES.has("pending")).toBe(true);
    expect(UNATTESTED_ITEM_STATUSES.has("in_review")).toBe(true);
    expect(UNATTESTED_ITEM_STATUSES.has("escalated")).toBe(true);
    expect(UNATTESTED_ITEM_STATUSES.has("exception_pending")).toBe(true);
    expect(UNATTESTED_ITEM_STATUSES.has("decided")).toBe(false);
    expect(UNATTESTED_ITEM_STATUSES.has("auto_revoked")).toBe(false);
  });
});

describe("isAutoRevocable", () => {
  const campaign = makeCampaign();
  const item = pendingItems()[0] as AccessReviewItem;

  it("is revocable for an overdue un-attested item", () => {
    expect(isAutoRevocable(item, campaign, AFTER_DEADLINE, false)).toBe(true);
  });

  it("is not revocable before the deadline", () => {
    expect(isAutoRevocable(item, campaign, BEFORE_DEADLINE, false)).toBe(false);
  });

  it("is not revocable for a withdrawn item", () => {
    const withdrawn = { ...item, status: "withdrawn" } as AccessReviewItem;
    expect(isAutoRevocable(withdrawn, campaign, AFTER_DEADLINE, false)).toBe(false);
  });

  it("under grace-period gating waits for the grace window", () => {
    expect(isAutoRevocable(item, campaign, AFTER_DEADLINE, true)).toBe(false);
    expect(isAutoRevocable(item, campaign, AFTER_GRACE, true)).toBe(true);
  });
});

describe("planAutoRevocations", () => {
  it("produces a revoke decision per overdue item under auto_revoke_on_deadline", () => {
    const campaign = makeCampaign({ autoRevokePolicy: "auto_revoke_on_deadline" });
    const decisions = planAutoRevocations(pendingItems(), campaign, revokeOpts(AFTER_DEADLINE));
    expect(decisions).toHaveLength(2);
    for (const d of decisions) {
      expect(d.kind).toBe("revoke");
      expect(d.reason).toBe("no_response_auto_default");
      expect(d.decidedByUserId).toBe(UUID.system);
      expect(d.attestation.kind).toBe("click_through_acknowledgement");
      expect(d.attestation.attestedByUserId).toBe(UUID.system);
      expect(d.id).toMatch(/^ard_[a-z0-9]{8,32}$/);
      expect(() => AccessReviewDecisionSchema.parse(d)).not.toThrow();
    }
    expect(decisions.map((d) => d.itemId)).toEqual(pendingItems().map((i) => i.id));
  });

  it("also revokes under default_revoke", () => {
    const campaign = makeCampaign({ autoRevokePolicy: "default_revoke" });
    expect(
      planAutoRevocations(pendingItems(), campaign, revokeOpts(AFTER_DEADLINE)),
    ).toHaveLength(2);
  });

  it("produces nothing under default_keep", () => {
    const campaign = makeCampaign({ autoRevokePolicy: "default_keep" });
    expect(
      planAutoRevocations(pendingItems(), campaign, revokeOpts(AFTER_DEADLINE)),
    ).toEqual([]);
  });

  it("produces nothing under escalate_to_manager", () => {
    const campaign = makeCampaign({ autoRevokePolicy: "escalate_to_manager" });
    expect(
      planAutoRevocations(pendingItems(), campaign, revokeOpts(AFTER_DEADLINE)),
    ).toEqual([]);
  });

  it("produces nothing before the deadline", () => {
    const campaign = makeCampaign({ autoRevokePolicy: "auto_revoke_on_deadline" });
    expect(
      planAutoRevocations(pendingItems(), campaign, revokeOpts(BEFORE_DEADLINE)),
    ).toEqual([]);
  });

  it("respects grace-period gating", () => {
    const campaign = makeCampaign({ autoRevokePolicy: "auto_revoke_on_deadline" });
    expect(
      planAutoRevocations(pendingItems(), campaign, revokeOpts(AFTER_DEADLINE, true)),
    ).toEqual([]);
    expect(
      planAutoRevocations(pendingItems(), campaign, revokeOpts(AFTER_GRACE, true)),
    ).toHaveLength(2);
  });

  it("skips items that are no longer un-attested", () => {
    const campaign = makeCampaign({ autoRevokePolicy: "auto_revoke_on_deadline" });
    const items = pendingItems().map((it, idx) =>
      idx === 0 ? ({ ...it, status: "withdrawn" } as AccessReviewItem) : it,
    );
    const decisions = planAutoRevocations(items, campaign, revokeOpts(AFTER_DEADLINE));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.itemId).toBe(items[1]?.id);
  });
});
