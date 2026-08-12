import { describe, expect, it } from "vitest";

import { PostgresPackVersionStore } from "./version-store.js";
import { fakePackVersion, fakeVersionPg } from "./test-fakes.js";

describe("PostgresPackVersionStore.upsert", () => {
  it("INSERTs with an (pack_id, version) UPSERT + a bound JSONB signature", async () => {
    const { conn, calls } = fakeVersionPg();
    await new PostgresPackVersionStore(conn).upsert(fakePackVersion());
    const insert = calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(insert.sql).toContain("meta.pack_versions");
    expect(insert.sql).toContain("ON CONFLICT (pack_id, version) DO UPDATE");
    expect(insert.sql).toContain("$8::jsonb");
    expect(insert.params[0]).toBe("com.acme.loyalty");
    expect(insert.params[1]).toBe("1.0.0");
    expect(insert.params[2]).toBe("draft");
    expect(typeof insert.params[7]).toBe("string"); // signature serialized
  });

  it("re-upserting the same (pack_id, version) advances the row (one row, new status)", async () => {
    const { conn } = fakeVersionPg();
    const store = new PostgresPackVersionStore(conn);
    await store.upsert(fakePackVersion({ status: "draft" }));
    await store.upsert(fakePackVersion({ status: "in_review", securityReviewStatus: "in_progress" }));
    const got = await store.getByPackVersion("com.acme.loyalty", "1.0.0");
    expect(got?.status).toBe("in_review");
    expect(got?.securityReviewStatus).toBe("in_progress");
  });
});

describe("PostgresPackVersionStore reads", () => {
  it("round-trips a published version back through the schema", async () => {
    const { conn } = fakeVersionPg();
    const store = new PostgresPackVersionStore(conn);
    const published = fakePackVersion({
      channel: "stable",
      status: "published",
      securityReviewStatus: "passed",
      securityReviewedAt: "2026-06-10T00:00:00.000Z",
      securityReviewer: "00000000-0000-4000-8000-0000000000bb",
      publishedAt: "2026-06-11T00:00:00.000Z",
      publishedBy: "00000000-0000-4000-8000-0000000000cc",
    });
    await store.upsert(published);
    const got = await store.getByPackVersion("com.acme.loyalty", "1.0.0");
    expect(got?.status).toBe("published");
    expect(got?.securityReviewStatus).toBe("passed");
    expect(got?.publishedBy).toBe("00000000-0000-4000-8000-0000000000cc");
  });

  it("getByPackVersion returns null when absent, listByPack filters by status", async () => {
    const { conn } = fakeVersionPg();
    const store = new PostgresPackVersionStore(conn);
    expect(await store.getByPackVersion("com.acme.loyalty", "9.9.9")).toBeNull();
    await store.upsert(fakePackVersion({ version: "1.0.0", status: "draft" }));
    await store.upsert(fakePackVersion({ version: "1.1.0", status: "published", channel: "beta", publishedAt: "2026-06-11T00:00:00.000Z", publishedBy: "00000000-0000-4000-8000-0000000000cc" }));
    const drafts = await store.listByPack("com.acme.loyalty", "draft");
    expect(drafts.map((r) => r.version)).toEqual(["1.0.0"]);
    const all = await store.listByPack("com.acme.loyalty");
    expect(all).toHaveLength(2);
  });
});
