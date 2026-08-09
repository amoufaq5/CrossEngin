import { describe, expect, it } from "vitest";

import { CampaignUuidResolver, ItemUuidResolver } from "./id-mapping.js";
import { PostgresAccessReviewItemStore } from "./item-store.js";
import { SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";
import { FakeConn, UUIDS, makeItem } from "./test-fakes.js";

function storeWithResolvedCampaign(): {
  conn: FakeConn;
  store: PostgresAccessReviewItemStore;
  itemResolver: ItemUuidResolver;
} {
  const conn = new FakeConn();
  const campaignResolver = new CampaignUuidResolver();
  campaignResolver.register("arc_00000001", UUIDS.campaignRow);
  const itemResolver = new ItemUuidResolver();
  const store = new PostgresAccessReviewItemStore(conn, campaignResolver, itemResolver);
  return { conn, store, itemResolver };
}

describe("PostgresAccessReviewItemStore.upsert", () => {
  it("sets tenant context then INSERT ... ON CONFLICT (item_id)", async () => {
    const { conn, store } = storeWithResolvedCampaign();
    await store.upsert(makeItem());
    expect(conn.calls[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(conn.calls[0]?.params).toEqual([UUIDS.tenant]);
    const insert = conn.find("INSERT INTO meta.access_review_items");
    expect(insert?.sql).toContain("ON CONFLICT (item_id) DO UPDATE");
  });

  it("resolves the campaign uuid and binds it as the FK column (param 2)", async () => {
    const { conn, store } = storeWithResolvedCampaign();
    await store.upsert(makeItem());
    const params = conn.find("INSERT INTO meta.access_review_items")?.params ?? [];
    expect(params[0]).toBe("ari_00000001");
    expect(params[1]).toBe(UUIDS.campaignRow);
    expect(params[2]).toBe(UUIDS.tenant);
  });

  it("flattens a null currentReviewer to null cols + zero counters", async () => {
    const { conn, store } = storeWithResolvedCampaign();
    await store.upsert(makeItem({ status: "pending", currentReviewer: null }));
    const params = conn.find("INSERT INTO meta.access_review_items")?.params ?? [];
    expect(params[15]).toBeNull(); // current_reviewer_user_id
    expect(params[16]).toBeNull(); // current_reviewer_kind
    expect(params[17]).toBeNull(); // reviewer_assigned_at
    expect(params[18]).toBe(0); // reminder_count
    expect(params[20]).toBe(0); // escalation_level
  });

  it("flattens a present currentReviewer into the reviewer columns", async () => {
    const { conn, store } = storeWithResolvedCampaign();
    const item = makeItem({
      status: "in_review",
      openedForReviewAt: "2026-01-02T00:00:00.000Z",
      currentReviewer: {
        reviewerUserId: UUIDS.reviewer,
        reviewerKind: "human_user",
        assignedAt: "2026-01-02T00:00:00.000Z",
        reminderCount: 3,
        lastReminderAt: "2026-01-03T00:00:00.000Z",
        escalationLevel: 1,
      },
    });
    await store.upsert(item);
    const params = conn.find("INSERT INTO meta.access_review_items")?.params ?? [];
    expect(params[15]).toBe(UUIDS.reviewer);
    expect(params[16]).toBe("human_user");
    expect(params[18]).toBe(3);
    expect(params[20]).toBe(1);
  });

  it("serializes grant_attributes as JSON", async () => {
    const { conn, store } = storeWithResolvedCampaign();
    await store.upsert(makeItem({ grantAttributes: { scope: "billing" } }));
    const params = conn.find("INSERT INTO meta.access_review_items")?.params ?? [];
    expect(params[9]).toBe(JSON.stringify({ scope: "billing" }));
  });

  it("registers the item uuid in the resolver", async () => {
    const { store, itemResolver } = storeWithResolvedCampaign();
    const uuid = await store.upsert(makeItem());
    expect(uuid).toBe(UUIDS.itemRow);
    expect(itemResolver.peek("ari_00000001")).toBe(UUIDS.itemRow);
  });

  it("throws when the campaign FK cannot be resolved", async () => {
    const conn = new FakeConn(() => ({ rows: [], rowCount: 0 }));
    const store = new PostgresAccessReviewItemStore(conn);
    await expect(store.upsert(makeItem())).rejects.toThrow(
      /access review campaign not found/,
    );
  });

  it("listByCampaign joins to filter by natural campaign id", async () => {
    const { conn, store } = storeWithResolvedCampaign();
    await store.listByCampaign(UUIDS.tenant, "arc_00000001");
    const select = conn.find("FROM meta.access_review_items i");
    expect(select?.sql).toContain("JOIN meta.access_review_campaigns c");
    expect(select?.sql).toContain("WHERE c.campaign_id = $1");
    expect(select?.params).toEqual(["arc_00000001"]);
  });
});
