import type {
  LiveGrant,
} from "@crossengin/access-reviews-runtime";
import type { PrincipalUnderReview } from "@crossengin/access-reviews";
import { CountingIdGenerator, FixedClock } from "@crossengin/access-reviews-runtime";
import { describe, expect, it } from "vitest";

import {
  buildPersistentAccessReviewRuntime,
  PersistentAccessReviewRuntime,
} from "./persisting-runtime.js";
import { FakeConn, UUIDS, makeCampaign } from "./test-fakes.js";

const NOW = new Date("2026-02-01T00:00:00.000Z");

function build(conn: FakeConn): PersistentAccessReviewRuntime {
  return buildPersistentAccessReviewRuntime(conn, {
    systemActorUserId: UUIDS.system,
    clock: new FixedClock(NOW),
    ids: new CountingIdGenerator(),
  });
}

const grant = (): LiveGrant => ({
  principalId: UUIDS.principal,
  kind: "role",
  grantId: "grant-role-admin",
  resourceLabel: "admin role",
  attributes: {},
  grantedAt: "2024-01-01T00:00:00.000Z",
  grantedBy: UUIDS.creator,
  lastUsedAt: null,
});

const principal = (): PrincipalUnderReview => ({
  principalId: UUIDS.principal,
  principalType: "user",
  displayLabel: "alice@example.com",
  tenantId: UUIDS.tenant,
  isExternal: false,
  managerUserId: UUIDS.reviewer,
  mfaStatus: "none",
  lastLoginAt: null,
});

describe("PersistentAccessReviewRuntime.startCampaign", () => {
  it("transitions to in_progress and writes a campaign row", async () => {
    const conn = new FakeConn();
    const runtime = build(conn);
    const started = await runtime.startCampaign(makeCampaign());
    expect(started.status).toBe("in_progress");
    expect(conn.find("INSERT INTO meta.access_review_campaigns")).toBeDefined();
  });
});

describe("PersistentAccessReviewRuntime.generateItems", () => {
  it("upserts the campaign then one item row per generated item", async () => {
    const conn = new FakeConn();
    const runtime = build(conn);
    const campaign = await runtime.startCampaign(makeCampaign());
    conn.calls.length = 0;
    const items = await runtime.generateItems(campaign, [grant()], [principal()]);
    expect(items.length).toBeGreaterThan(0);
    const itemInserts = conn.calls.filter((c) =>
      c.sql.includes("INSERT INTO meta.access_review_items"),
    );
    expect(itemInserts).toHaveLength(items.length);
    expect(conn.find("INSERT INTO meta.access_review_campaigns")).toBeDefined();
  });

  it("registers each generated item uuid for later FK resolution", async () => {
    const conn = new FakeConn();
    const runtime = build(conn);
    const campaign = await runtime.startCampaign(makeCampaign());
    const items = await runtime.generateItems(campaign, [grant()], [principal()]);
    for (const item of items) {
      expect(runtime.itemResolver.peek(item.id)).toBe(UUIDS.itemRow);
    }
  });
});

describe("PersistentAccessReviewRuntime.planAutoRevocations", () => {
  it("records a decision row for each auto-revocation", async () => {
    const conn = new FakeConn();
    const runtime = build(conn);
    const campaign = await runtime.startCampaign(makeCampaign());
    const items = await runtime.generateItems(campaign, [grant()], [principal()]);
    conn.calls.length = 0;
    const decisions = await runtime.planAutoRevocations(items, campaign, NOW);
    expect(decisions.length).toBeGreaterThan(0);
    const decisionInserts = conn.calls.filter((c) =>
      c.sql.includes("INSERT INTO meta.access_review_decisions"),
    );
    expect(decisionInserts).toHaveLength(decisions.length);
    expect(decisions[0]?.kind).toBe("revoke");
    expect(decisions[0]?.reason).toBe("no_response_auto_default");
  });

  it("writes nothing when the policy is non-revoking", async () => {
    const conn = new FakeConn();
    const runtime = build(conn);
    const campaign = await runtime.startCampaign(
      makeCampaign({ autoRevokePolicy: "default_keep" }),
    );
    const items = await runtime.generateItems(campaign, [grant()], [principal()]);
    conn.calls.length = 0;
    const decisions = await runtime.planAutoRevocations(items, campaign, NOW);
    expect(decisions).toHaveLength(0);
    expect(conn.find("INSERT INTO meta.access_review_decisions")).toBeUndefined();
  });
});

describe("buildPersistentAccessReviewRuntime", () => {
  it("shares one resolver pair across the stores", () => {
    const conn = new FakeConn();
    const runtime = build(conn);
    expect(runtime.campaignStore).toBeDefined();
    expect(runtime.itemStore).toBeDefined();
    expect(runtime.decisionStore).toBeDefined();
    expect(runtime.campaignResolver).toBeDefined();
    expect(runtime.itemResolver).toBeDefined();
  });

  it("persistCampaign writes a campaign without a lifecycle transition", async () => {
    const conn = new FakeConn();
    const runtime = build(conn);
    const c = await runtime.persistCampaign(makeCampaign({ status: "draft" }));
    expect(c.status).toBe("draft");
    expect(conn.find("INSERT INTO meta.access_review_campaigns")).toBeDefined();
  });
});
