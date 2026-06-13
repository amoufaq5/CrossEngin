import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { PackSignature, PackVersionRecord } from "@crossengin/marketplace";
import { describe, expect, it } from "vitest";

import { PostgresPackVersionStore, rowToPackVersion } from "./pack-version-store.js";

const SIG: PackSignature = { algorithm: "ed25519", publicKeyFingerprint: "a".repeat(64), signature: "QUJDRA==", signedAt: "2026-06-13T00:00:00.000Z" };

function publishedRecord(over: Partial<PackVersionRecord> = {}): PackVersionRecord {
  return {
    packId: "acme.crm.sales",
    version: "1.2.0",
    status: "published",
    channel: "beta",
    bundleSha256: "b".repeat(64),
    bundleSizeBytes: 4096,
    manifestSha256: "c".repeat(64),
    signature: SIG,
    changelog: "initial",
    publishedAt: "2026-06-13T01:00:00.000Z",
    publishedBy: "00000000-0000-4000-8000-0000000000aa",
    deprecatedAt: null,
    withdrawnAt: null,
    securityReviewStatus: "exempt",
    securityReviewedAt: null,
    securityReviewer: null,
    ...over,
  } as PackVersionRecord;
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pack_id: "acme.crm.sales",
    version: "1.2.0",
    status: "published",
    channel: "beta",
    bundle_sha256: "b".repeat(64),
    bundle_size_bytes: "4096",
    manifest_sha256: "c".repeat(64),
    signature: JSON.stringify(SIG),
    changelog: "initial",
    published_at: new Date("2026-06-13T01:00:00.000Z"),
    published_by: "00000000-0000-4000-8000-0000000000aa",
    deprecated_at: null,
    deprecated_reason: null,
    withdrawn_at: null,
    withdrawn_reason: null,
    superseded_by: null,
    security_review_status: "exempt",
    security_reviewed_at: null,
    security_reviewer: null,
    ...over,
  };
}

function fakeConn(rows: Record<string, unknown>[] = []): { conn: PgConnection; calls: Array<{ sql: string; params: readonly unknown[] }> } {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const conn = {
    async query<T>(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult<T>> {
      calls.push({ sql, params });
      return { rows: rows as readonly T[], rowCount: rows.length };
    },
    async transaction() { throw new Error("unused"); },
    async withAdvisoryLock() { throw new Error("unused"); },
    async close() {},
  } as unknown as PgConnection;
  return { conn, calls };
}

describe("rowToPackVersion", () => {
  it("reconstructs a record (BIGINT string + JSON signature + Date timestamps)", () => {
    const rec = rowToPackVersion(row());
    expect(rec).toMatchObject({ packId: "acme.crm.sales", version: "1.2.0", status: "published", bundleSizeBytes: 4096 });
    expect(rec.signature.algorithm).toBe("ed25519");
    expect(rec.publishedAt).toBe("2026-06-13T01:00:00.000Z");
  });

  it("maps null optional columns to omitted (not null) on a published row", () => {
    const rec = rowToPackVersion(row()); // published, with deprecated_reason / withdrawn_reason / superseded_by all NULL
    expect(rec.deprecatedReason).toBeUndefined();
    expect(rec.withdrawnReason).toBeUndefined();
    expect(rec.supersededBy).toBeUndefined();
  });

  it("maps a deprecated row's reason + successor through", () => {
    const rec = rowToPackVersion(
      row({ status: "deprecated", deprecated_at: new Date("2026-06-13T02:00:00.000Z"), deprecated_reason: "superseded", superseded_by: "2.0.0" }),
    );
    expect(rec).toMatchObject({ status: "deprecated", deprecatedReason: "superseded", supersededBy: "2.0.0" });
  });
});

describe("PostgresPackVersionStore", () => {
  it("record upserts on (pack_id, version) with a jsonb signature", async () => {
    const { conn, calls } = fakeConn();
    await new PostgresPackVersionStore(conn).record(publishedRecord());
    expect(calls[0]!.sql).toContain("INSERT INTO meta.pack_versions");
    expect(calls[0]!.sql).toContain("ON CONFLICT (pack_id, version) DO UPDATE");
    expect(calls[0]!.sql).toContain("$8::jsonb");
    expect(calls[0]!.params[0]).toBe("acme.crm.sales");
  });

  it("get returns null for a missing version, the record otherwise", async () => {
    expect(await new PostgresPackVersionStore(fakeConn().conn).get("p", "9.9.9")).toBeNull();
    const found = await new PostgresPackVersionStore(fakeConn([row()]).conn).get("acme.crm.sales", "1.2.0");
    expect(found?.version).toBe("1.2.0");
  });

  it("latestPublished picks the highest-semver published version", async () => {
    const rows = [row({ version: "1.2.0" }), row({ version: "2.0.0" }), row({ version: "1.5.0", status: "draft" })];
    const latest = await new PostgresPackVersionStore(fakeConn(rows).conn).latestPublished("acme.crm.sales");
    expect(latest?.version).toBe("2.0.0"); // 1.5.0 is draft (excluded), 2.0.0 > 1.2.0
  });
});
