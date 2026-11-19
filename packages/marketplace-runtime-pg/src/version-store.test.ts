import type { PackVersionRecord } from "@crossengin/marketplace";
import type { PgConnection, UnreadableRow } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { PackSubmissionError } from "@crossengin/marketplace-runtime";

import { PostgresPackVersionStore } from "./version-store.js";
import { fakePackVersion, fakeVersionPg } from "./test-fakes.js";

describe("PostgresPackVersionStore.insertDraft", () => {
  it("INSERTs with a bound JSONB signature and refuses rather than updates on conflict", async () => {
    const { conn, calls } = fakeVersionPg();
    await new PostgresPackVersionStore(conn).insertDraft(fakePackVersion());
    const insert = calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(insert.sql).toContain("meta.pack_versions");
    expect(insert.sql).toContain("ON CONFLICT (pack_id, version) DO NOTHING");
    expect(insert.sql).not.toContain("DO UPDATE");
    expect(insert.sql).toContain("$8::jsonb");
    expect(insert.params[0]).toBe("com.acme.loyalty");
    expect(insert.params[1]).toBe("1.0.0");
    expect(insert.params[2]).toBe("draft");
    expect(typeof insert.params[7]).toBe("string");
  });

  it("refuses to re-submit an existing version, so a published version's bytes cannot be replaced", async () => {
    const { conn } = fakeVersionPg();
    const store = new PostgresPackVersionStore(conn);
    await store.insertDraft(fakePackVersion({ bundleSha256: "a".repeat(64) }));
    const err = await store.insertDraft(fakePackVersion({ bundleSha256: "b".repeat(64) })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PackSubmissionError);
    expect((err as PackSubmissionError).reason).toBe("version_exists");
    const got = await store.getByPackVersion("com.acme.loyalty", "1.0.0");
    expect(got?.bundleSha256).toBe("a".repeat(64));
  });
});

describe("PostgresPackVersionStore.advance", () => {
  it("moves the lifecycle and names no content column", async () => {
    const { conn, calls } = fakeVersionPg();
    const store = new PostgresPackVersionStore(conn);
    const draft = fakePackVersion({ status: "draft" });
    await store.insertDraft(draft);
    await store.advance(draft, fakePackVersion({ status: "in_review", securityReviewStatus: "in_progress" }));
    const update = calls.find((c) => c.sql.startsWith("UPDATE"))!;
    for (const column of ["channel", "bundle_sha256", "bundle_size_bytes", "manifest_sha256", "signature", "changelog"]) {
      expect(update.sql).not.toMatch(new RegExp(`\\b${column}\\s*=`));
    }
    expect(update.sql).toContain("status = $14 AND security_review_status = $15");
    const got = await store.getByPackVersion("com.acme.loyalty", "1.0.0");
    expect(got?.status).toBe("in_review");
    expect(got?.securityReviewStatus).toBe("in_progress");
  });

  it("refuses when the row has moved since it was read, so a stale read cannot overwrite a newer state", async () => {
    const { conn } = fakeVersionPg();
    const store = new PostgresPackVersionStore(conn);
    const draft = fakePackVersion({ status: "draft" });
    await store.insertDraft(draft);
    await store.advance(draft, fakePackVersion({ status: "in_review", securityReviewStatus: "in_progress" }));
    const err = await store
      .advance(draft, fakePackVersion({ status: "withdrawn", withdrawnAt: "2026-06-12T00:00:00.000Z", withdrawnReason: "x" }))
      .catch((e: unknown) => e);
    expect((err as PackSubmissionError).reason).toBe("version_changed");
    expect((await store.getByPackVersion("com.acme.loyalty", "1.0.0"))?.status).toBe("in_review");
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
    await store.insertDraft(published);
    const got = await store.getByPackVersion("com.acme.loyalty", "1.0.0");
    expect(got?.status).toBe("published");
    expect(got?.securityReviewStatus).toBe("passed");
    expect(got?.publishedBy).toBe("00000000-0000-4000-8000-0000000000cc");
  });

  it("getByPackVersion returns null when absent, listByPack filters by status", async () => {
    const { conn } = fakeVersionPg();
    const store = new PostgresPackVersionStore(conn);
    expect(await store.getByPackVersion("com.acme.loyalty", "9.9.9")).toBeNull();
    await store.insertDraft(fakePackVersion({ version: "1.0.0", status: "draft" }));
    await store.insertDraft(fakePackVersion({ version: "1.1.0", status: "published", channel: "beta", publishedAt: "2026-06-11T00:00:00.000Z", publishedBy: "00000000-0000-4000-8000-0000000000cc" }));
    const refused: UnreadableRow[] = [];
    const report = (row: UnreadableRow): void => {
      refused.push(row);
    };
    const drafts = await store.listByPack("com.acme.loyalty", report, "draft");
    expect(drafts.map((r) => r.version)).toEqual(["1.0.0"]);
    const all = await store.listByPack("com.acme.loyalty", report);
    expect(all).toHaveLength(2);
    expect(refused).toEqual([]);
  });
});

describe("a version row the contract refuses", () => {
  /** A fake whose SELECT answers a fixed row list, so a drifted row is expressible. */
  function answeringPg(rows: readonly Record<string, unknown>[]): PgConnection {
    const client: PgConnection = {
      query: (async (sql: string) =>
        sql.includes("SELECT") ? { rows, rowCount: rows.length } : { rows: [], rowCount: 0 }) as PgConnection["query"],
      transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
        fn(client)) as PgConnection["transaction"],
      withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
        fn()) as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    return client;
  }

  function rowFrom(rec: PackVersionRecord): Record<string, unknown> {
    return {
      pack_id: rec.packId,
      version: rec.version,
      status: rec.status,
      channel: rec.channel,
      bundle_sha256: rec.bundleSha256,
      bundle_size_bytes: rec.bundleSizeBytes,
      manifest_sha256: rec.manifestSha256,
      signature: rec.signature,
      changelog: rec.changelog,
      published_at: rec.publishedAt,
      published_by: rec.publishedBy,
      deprecated_at: rec.deprecatedAt,
      deprecated_reason: rec.deprecatedReason ?? null,
      withdrawn_at: rec.withdrawnAt,
      withdrawn_reason: rec.withdrawnReason ?? null,
      superseded_by: rec.supersededBy ?? null,
      security_review_status: rec.securityReviewStatus,
      security_reviewed_at: rec.securityReviewedAt,
      security_reviewer: rec.securityReviewer,
    };
  }

  it("is reported by the business key rather than taking the page with it", async () => {
    const good = rowFrom(fakePackVersion({ version: "1.0.0" }));
    // `meta.pack_versions.version` is TEXT with no CHECK while the contract requires SEMVER, which
    // is register P2.12b's class and makes this the realistic refusal on this table.
    const bad = { ...rowFrom(fakePackVersion({ version: "1.1.0" })), version: "not-a-semver" };
    const refused: UnreadableRow[] = [];
    const store = new PostgresPackVersionStore(answeringPg([good, bad]));
    const got = await store.listByPack("com.acme.loyalty", (row) => {
      refused.push(row);
    });
    expect(got.map((r) => r.version)).toEqual(["1.0.0"]);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.identity).toBe("com.acme.loyalty@not-a-semver");
    expect(refused[0]?.detail).toBe("version: invalid_string");
  });

  it("withholds a malformed signature column's text, where JSON.parse would have quoted it", async () => {
    // `unreadableDetail` passes a non-`ZodError` message through verbatim on the premise that such
    // a message is a mapper's own guard written in this repo. A `SyntaxError` from `JSON.parse` is
    // V8's, and **when the first token is the unexpected one it quotes the input** — measured on
    // this runtime, `JSON.parse("SECRETKEY")` says `Unexpected token 'S', "SECRETKEY" is not valid
    // JSON`. (A truncation mid-object instead yields a positional message and discloses nothing, so
    // the disclosure is real and conditional on where the text first fails.) The fixture is chosen
    // to be the disclosing shape, so the `not.toContain` below is load-bearing.
    const bad = { ...rowFrom(fakePackVersion()), signature: "SECRETKEY" };
    const refused: UnreadableRow[] = [];
    const store = new PostgresPackVersionStore(answeringPg([bad]));
    const got = await store.listByPack("com.acme.loyalty", (row) => {
      refused.push(row);
    });
    expect(got).toEqual([]);
    expect(refused[0]?.detail).toBe("signature: column is not valid JSON");
    expect(refused[0]?.detail).not.toContain("SECRETKEY");
  });
});
