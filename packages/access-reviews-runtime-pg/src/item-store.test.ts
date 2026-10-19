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
    // Both sides of the join, which is what a non-owner is shown.
    expect(select?.sql).toContain("i.tenant_id = $2");
    expect(select?.sql).toContain("c.tenant_id = $2");
    expect(select?.params).toEqual(["arc_00000001", UUIDS.tenant]);
  });

  it("listByCampaignWithUnreadable issues the identical statement", async () => {
    // The sibling exists to change what is done with a refused row, not what is asked of the
    // database — so a scope predicate added to one and not the other is the defect this pins.
    const plain = new FakeConn();
    await new PostgresAccessReviewItemStore(plain).listByCampaign(UUIDS.tenant, "arc_00000001");
    const paired = new FakeConn();
    await new PostgresAccessReviewItemStore(paired).listByCampaignWithUnreadable(
      UUIDS.tenant,
      "arc_00000001",
    );
    expect(paired.calls.map((c) => c.sql)).toEqual(plain.calls.map((c) => c.sql));
    expect(paired.calls.map((c) => c.params)).toEqual(plain.calls.map((c) => c.params));
  });
});

describe("PostgresAccessReviewItemStore reports a row it cannot represent", () => {
  const itemRow = {
    item_id: "ari_00000001",
    tenant_id: UUIDS.tenant,
    campaign_natural_id: "arc_00000001",
    principal_id: UUIDS.principal,
    principal_type: "user",
    principal_label: "alice@example.com",
    grant_kind: "role",
    grant_id: "grant-role-admin",
    grant_label: "admin role",
    grant_attributes: {},
    granted_at: "2024-01-01T00:00:00.000Z",
    granted_by: UUIDS.creator,
    last_used_at: null,
    risk_level: "high",
    status: "pending",
    current_reviewer_user_id: null,
    current_reviewer_kind: null,
    reviewer_assigned_at: null,
    reminder_count: 0,
    last_reminder_at: null,
    escalation_level: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    opened_for_review_at: null,
    decided_at: null,
    decision_id: null,
    auto_revoked_at: null,
    auto_revoke_reason: null,
    due_at: "2026-01-10T00:00:00.000Z",
    notes: null,
  };

  function connWith(rows: readonly unknown[]): FakeConn {
    return new FakeConn((sql) =>
      sql.includes("FROM meta.access_review_items i")
        ? { rows: rows as Record<string, unknown>[], rowCount: rows.length }
        : { rows: [], rowCount: 0 },
    );
  }

  it("keeps the other rows and names the refused one by item_id", async () => {
    const broken = { ...itemRow, item_id: "ari_0000bad1", due_at: null };
    const read = await new PostgresAccessReviewItemStore(
      connWith([broken, itemRow]),
    ).listByCampaignWithUnreadable(UUIDS.tenant, "arc_00000001");
    expect(read.records.map((i) => i.id)).toEqual(["ari_00000001"]);
    expect(read.unreadable).toEqual([
      { identity: "ari_0000bad1", detail: "row is missing required timestamp: due_at" },
    ]);
  });

  it("discloses no value from the refused row beyond its business key", async () => {
    const broken = {
      ...itemRow,
      item_id: "ari_0000bad2",
      principal_label: "alice@example.com",
      due_at: null,
    };
    const read = await new PostgresAccessReviewItemStore(
      connWith([broken]),
    ).listByCampaignWithUnreadable(UUIDS.tenant, "arc_00000001");
    const rendered = JSON.stringify(read.unreadable);
    expect(rendered).toContain("ari_0000bad2");
    expect(rendered).not.toContain("alice@example.com");
    expect(rendered).not.toContain(UUIDS.principal);
  });

  it("admits it cannot name the row when item_id is itself what is wrong", async () => {
    const read = await new PostgresAccessReviewItemStore(
      connWith([{ ...itemRow, item_id: null, due_at: null }]),
    ).listByCampaignWithUnreadable(UUIDS.tenant, "arc_00000001");
    expect(read.unreadable[0]?.identity).toBeNull();
  });
});
