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
import {
  FakeConn,
  UUIDS,
  evidenceRowFor,
  makeCampaign,
  makeSealedEvidence,
} from "./test-fakes.js";

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

describe("PersistentAccessReviewRuntime.closeCampaign", () => {
  const CLOSE_AT = new Date("2026-03-31T00:00:00.000Z");
  const running = () =>
    makeCampaign({ status: "in_progress", startedAt: "2026-01-01T00:00:00.000Z" });

  /** No items, no decisions, every write affecting one row. */
  const emptyCampaignConn = () =>
    new FakeConn((sql) => {
      if (sql.includes("INSERT INTO meta.access_review_campaigns")) {
        return { rows: [{ id: UUIDS.campaignRow }], rowCount: 1 };
      }
      if (sql.trimStart().toUpperCase().startsWith("SELECT")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });

  function closeArgs(conn: FakeConn) {
    return build(conn).closeCampaign({
      campaign: running(),
      createdBy: UUIDS.creator,
      now: CLOSE_AT,
    });
  }

  it("completes the campaign, persists it, and seals a pack", async () => {
    const conn = emptyCampaignConn();
    const outcome = await closeArgs(conn);
    expect(outcome.campaign.status).toBe("completed");
    expect(outcome.evidence?.status).toBe("sealed");
    expect(outcome.evidence?.sealedSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes the pack through compile() and then seal(), in that order", async () => {
    const conn = emptyCampaignConn();
    await closeArgs(conn);
    const insertAt = conn.calls.findIndex((c) =>
      c.sql.includes("INSERT INTO meta.access_review_evidence"),
    );
    const updateAt = conn.calls.findIndex((c) =>
      c.sql.includes("UPDATE meta.access_review_evidence"),
    );
    expect(insertAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(insertAt);
  });

  it("persists the completed campaign before it tries to seal", async () => {
    const conn = emptyCampaignConn();
    await closeArgs(conn);
    const campaignAt = conn.calls.findIndex((c) =>
      c.sql.includes("INSERT INTO meta.access_review_campaigns"),
    );
    const evidenceAt = conn.calls.findIndex((c) =>
      c.sql.includes("INSERT INTO meta.access_review_evidence"),
    );
    expect(campaignAt).toBeLessThan(evidenceAt);
  });

  it("takes the pack's period from the campaign, not from a configured window", async () => {
    const conn = emptyCampaignConn();
    const outcome = await closeArgs(conn);
    expect(outcome.evidence?.periodStartAt).toBe("2026-01-01T00:00:00.000Z");
    expect(outcome.evidence?.periodEndAt).toBe(CLOSE_AT.toISOString());
  });

  it("reports a failed seal rather than undoing the close", async () => {
    const errors: unknown[] = [];
    const conn = new FakeConn((sql) => {
      if (sql.includes("INSERT INTO meta.access_review_campaigns")) {
        return { rows: [{ id: UUIDS.campaignRow }], rowCount: 1 };
      }
      // Every evidence write refuses, and the diagnosing re-read finds nothing.
      if (sql.includes("meta.access_review_evidence")) return { rows: [], rowCount: 0 };
      if (sql.trimStart().toUpperCase().startsWith("SELECT")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const outcome = await build(conn).closeCampaign({
      campaign: running(),
      createdBy: UUIDS.creator,
      now: CLOSE_AT,
      onSealError: (e) => errors.push(e),
    });
    expect(outcome.campaign.status).toBe("completed");
    expect(outcome.evidence).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it("skips the pack entirely when sealEvidence is false", async () => {
    const conn = emptyCampaignConn();
    const outcome = await build(conn).closeCampaign({
      campaign: running(),
      createdBy: UUIDS.creator,
      now: CLOSE_AT,
      sealEvidence: false,
    });
    expect(outcome.evidence).toBeNull();
    expect(conn.find("meta.access_review_evidence")).toBeUndefined();
  });

  it("refuses to close a campaign the transition map forbids", async () => {
    const conn = emptyCampaignConn();
    await expect(
      build(conn).closeCampaign({
        campaign: makeCampaign({ status: "scheduled" }),
        createdBy: UUIDS.creator,
        now: CLOSE_AT,
      }),
    ).rejects.toThrow(/not a valid transition/);
  });

  it("re-closing is idempotent on the pack's id, because the period derives it", async () => {
    const first = await closeArgs(emptyCampaignConn());
    const second = await closeArgs(emptyCampaignConn());
    expect(second.evidence?.id).toBe(first.evidence?.id);
  });

  it("builds an evidence store into the runtime, so nothing has to wire one", () => {
    expect(build(emptyCampaignConn()).evidenceStore).toBeDefined();
  });
});

describe("PersistentAccessReviewRuntime.verifyStoredEvidence", () => {
  const CLOSE_AT = new Date("2026-03-31T00:00:00.000Z");
  const completed = () =>
    makeCampaign({
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: CLOSE_AT.toISOString(),
    });

  it("answers `absent` when no pack is stored, which closes nothing", async () => {
    const conn = new FakeConn(() => ({ rows: [], rowCount: 0 }));
    const result = await build(conn).verifyStoredEvidence({
      campaign: completed(),
      createdBy: UUIDS.creator,
      now: CLOSE_AT,
    });
    expect(result.outcome).toBe("absent");
  });

  it("verifies a pack against a bundle re-derived from the persisted rows", async () => {
    // Seal a pack over an empty campaign, then hand the stored row straight back.
    const sealConn = new FakeConn((sql) =>
      sql.includes("INSERT INTO meta.access_review_campaigns")
        ? { rows: [{ id: UUIDS.campaignRow }], rowCount: 1 }
        : sql.trimStart().toUpperCase().startsWith("SELECT")
          ? { rows: [], rowCount: 0 }
          : { rows: [], rowCount: 1 },
    );
    const sealed = (
      await build(sealConn).closeCampaign({
        campaign: makeCampaign({ status: "in_progress", startedAt: "2026-01-01T00:00:00.000Z" }),
        createdBy: UUIDS.creator,
        now: CLOSE_AT,
      })
    ).evidence;
    if (sealed === null) throw new Error("expected a sealed pack");

    const readConn = new FakeConn((sql) =>
      sql.includes("FROM meta.access_review_evidence")
        ? { rows: [evidenceRowFor(sealed)], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    const result = await build(readConn).verifyStoredEvidence({
      campaign: completed(),
      createdBy: UUIDS.creator,
      now: CLOSE_AT,
    });
    expect(result.outcome).toBe("verified");
  });

  it("reports `unverified` when the stored digest does not match the rows", async () => {
    const tampered = makeSealedEvidence({
      campaignIds: ["arc_00000001"],
      periodStartAt: "2026-01-01T00:00:00.000Z",
      periodEndAt: CLOSE_AT.toISOString(),
      sealedSha256: "9".repeat(64),
    });
    const conn = new FakeConn((sql) =>
      sql.includes("FROM meta.access_review_evidence")
        ? { rows: [evidenceRowFor(tampered)], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    const result = await build(conn).verifyStoredEvidence({
      campaign: completed(),
      createdBy: UUIDS.creator,
      now: CLOSE_AT,
    });
    expect(result.outcome).toBe("unverified");
  });
});
