import { describe, expect, it } from "vitest";

import { PostgresAccessReviewDecisionStore } from "./decision-store.js";
import { CampaignUuidResolver, ItemUuidResolver } from "./id-mapping.js";
import { SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";
import { FakeConn, UUIDS, makeDecision } from "./test-fakes.js";

function resolvedStore(): {
  conn: FakeConn;
  store: PostgresAccessReviewDecisionStore;
} {
  const conn = new FakeConn();
  const campaignResolver = new CampaignUuidResolver();
  campaignResolver.register("arc_00000001", UUIDS.campaignRow);
  const itemResolver = new ItemUuidResolver();
  itemResolver.register("ari_00000001", UUIDS.itemRow);
  const store = new PostgresAccessReviewDecisionStore(conn, campaignResolver, itemResolver);
  return { conn, store };
}

describe("PostgresAccessReviewDecisionStore.record", () => {
  it("sets tenant context then INSERT ... ON CONFLICT (decision_id) DO NOTHING", async () => {
    const { conn, store } = resolvedStore();
    await store.record(makeDecision());
    expect(conn.calls[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    const insert = conn.find("INSERT INTO meta.access_review_decisions");
    expect(insert?.sql).toContain("ON CONFLICT (decision_id) DO NOTHING");
  });

  it("binds resolved item + campaign uuids as FK columns", async () => {
    const { conn, store } = resolvedStore();
    await store.record(makeDecision());
    const params = conn.find("INSERT INTO meta.access_review_decisions")?.params ?? [];
    expect(params[0]).toBe("ard_00000001");
    expect(params[1]).toBe(UUIDS.itemRow);
    expect(params[2]).toBe(UUIDS.campaignRow);
    expect(params[3]).toBe(UUIDS.tenant);
  });

  it("flattens the nested attestation into columns", async () => {
    const { conn, store } = resolvedStore();
    await store.record(makeDecision());
    const params = conn.find("INSERT INTO meta.access_review_decisions")?.params ?? [];
    expect(params[11]).toBe("click_through_acknowledgement"); // attestation_kind
    expect(params[12]).toBeNull(); // signature sha256
    expect(params[16]).toBe("127.0.0.1"); // ip_address
    expect(params[17]).toBe("crossengin-access-reviews-runtime"); // user_agent
  });

  it("casts ip_address to inet in SQL", async () => {
    const { conn, store } = resolvedStore();
    await store.record(makeDecision());
    expect(conn.find("INSERT INTO meta.access_review_decisions")?.sql).toContain("::inet");
  });

  it("serializes modified_grant_attributes when present, null otherwise", async () => {
    const { conn, store } = resolvedStore();
    await store.record(
      makeDecision({
        id: "ard_00000002",
        kind: "modify_grant",
        reason: "role_changed_modified",
        modifiedGrantAttributes: { tier: "gold" },
      }),
    );
    const params = conn.find("INSERT INTO meta.access_review_decisions")?.params ?? [];
    expect(params[10]).toBe(JSON.stringify({ tier: "gold" }));
  });

  it("throws when the item FK cannot be resolved", async () => {
    const conn = new FakeConn(() => ({ rows: [], rowCount: 0 }));
    const store = new PostgresAccessReviewDecisionStore(conn);
    await expect(store.record(makeDecision())).rejects.toThrow(
      /access review item not found/,
    );
  });

  it("listByItem filters by natural item id via join", async () => {
    const { conn, store } = resolvedStore();
    await store.listByItem(UUIDS.tenant, "ari_00000001");
    const select = conn.find("FROM meta.access_review_decisions d");
    expect(select?.sql).toContain("WHERE i.item_id = $1");
    expect(select?.params).toEqual(["ari_00000001"]);
  });

  it("listByCampaign filters by natural campaign id via join", async () => {
    const { conn, store } = resolvedStore();
    await store.listByCampaign(UUIDS.tenant, "arc_00000001");
    const select = conn.find("FROM meta.access_review_decisions d");
    expect(select?.sql).toContain("WHERE c.campaign_id = $1");
    expect(select?.params).toEqual(["arc_00000001"]);
  });
});
