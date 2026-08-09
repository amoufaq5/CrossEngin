import { describe, expect, it } from "vitest";

import { CampaignUuidResolver, ItemUuidResolver } from "./id-mapping.js";
import { FakeConn, UUIDS } from "./test-fakes.js";

describe("CampaignUuidResolver", () => {
  it("returns a registered uuid without querying", async () => {
    const conn = new FakeConn(() => ({ rows: [], rowCount: 0 }));
    const r = new CampaignUuidResolver();
    r.register("arc_00000001", UUIDS.campaignRow);
    const uuid = await r.resolve(conn, "arc_00000001");
    expect(uuid).toBe(UUIDS.campaignRow);
    expect(conn.calls).toHaveLength(0);
  });

  it("queries by campaign_id when not cached and caches the result", async () => {
    const conn = new FakeConn((sql) => {
      expect(sql).toContain("FROM meta.access_review_campaigns");
      expect(sql).toContain("WHERE campaign_id = $1");
      return { rows: [{ id: UUIDS.campaignRow }], rowCount: 1 };
    });
    const r = new CampaignUuidResolver();
    const uuid = await r.resolve(conn, "arc_00000001");
    expect(uuid).toBe(UUIDS.campaignRow);
    expect(conn.calls[0]?.params).toEqual(["arc_00000001"]);
    await r.resolve(conn, "arc_00000001");
    expect(conn.calls).toHaveLength(1);
  });

  it("resolve returns null when the row is absent", async () => {
    const conn = new FakeConn(() => ({ rows: [], rowCount: 0 }));
    const r = new CampaignUuidResolver();
    expect(await r.resolve(conn, "arc_missing0")).toBeNull();
  });

  it("requireResolve throws when the row is absent", async () => {
    const conn = new FakeConn(() => ({ rows: [], rowCount: 0 }));
    const r = new CampaignUuidResolver();
    await expect(r.requireResolve(conn, "arc_missing0")).rejects.toThrow(
      /access review campaign not found/,
    );
  });

  it("invalidate forces a re-query", async () => {
    const conn = new FakeConn(() => ({ rows: [{ id: UUIDS.campaignRow }], rowCount: 1 }));
    const r = new CampaignUuidResolver();
    await r.resolve(conn, "arc_00000001");
    r.invalidate("arc_00000001");
    await r.resolve(conn, "arc_00000001");
    expect(conn.calls).toHaveLength(2);
  });

  it("tracks cache size and peek", () => {
    const r = new CampaignUuidResolver();
    expect(r.size()).toBe(0);
    r.register("arc_00000001", UUIDS.campaignRow);
    expect(r.size()).toBe(1);
    expect(r.peek("arc_00000001")).toBe(UUIDS.campaignRow);
    expect(r.peek("arc_none0000")).toBeUndefined();
  });
});

describe("ItemUuidResolver", () => {
  it("queries the items table by item_id", async () => {
    const conn = new FakeConn((sql) => {
      expect(sql).toContain("FROM meta.access_review_items");
      expect(sql).toContain("WHERE item_id = $1");
      return { rows: [{ id: UUIDS.itemRow }], rowCount: 1 };
    });
    const r = new ItemUuidResolver();
    expect(await r.requireResolve(conn, "ari_00000001")).toBe(UUIDS.itemRow);
  });

  it("requireResolve throws a distinct message for items", async () => {
    const conn = new FakeConn(() => ({ rows: [], rowCount: 0 }));
    const r = new ItemUuidResolver();
    await expect(r.requireResolve(conn, "ari_missing0")).rejects.toThrow(
      /access review item not found/,
    );
  });
});
