import type { PgConnection } from "@crossengin/kernel-pg";
import type { ClientRelease } from "@crossengin/sdk-clients";
import { describe, expect, it, vi } from "vitest";

import { PostgresClientReleaseStore, rowToClientRelease } from "./release-store.js";

interface Captured {
  readonly conn: PgConnection;
  readonly calls: { sql: string; params: readonly unknown[] }[];
  rows: Record<string, unknown>[];
}

function capture(): Captured {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const cap: Captured = { calls, rows: [], conn: undefined as unknown as PgConnection };
  const query = (async (sql: string, params?: readonly unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    return { rows: cap.rows, rowCount: cap.rows.length };
  }) as PgConnection["query"];
  (cap as { conn: PgConnection }).conn = {
    query,
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return cap;
}

const RELEASE: ClientRelease = {
  id: "rel-typescript-1.0.0",
  language: "typescript",
  version: "1.0.0",
  apiVersion: "v1",
  channel: "stable",
  status: "published",
  artifactSha256: "a".repeat(64),
  artifactSizeBytes: 4096,
  registryPackageUri: "https://registry.npmjs.org/@acme/operate-client",
  generationRunId: "gen-typescript-abc123",
  publishedAt: "2026-06-11T00:00:00.000Z",
  publishedBy: "00000000-0000-4000-8000-000000000000",
  deprecatedAt: null,
  yankedAt: null,
  securityAdvisories: [],
  changelogUrl: "https://docs.acme.dev/changelog",
  downloadCount: 0,
  breakingChanges: false,
} as unknown as ClientRelease;

describe("PostgresClientReleaseStore.record", () => {
  it("upserts keyed on release_id with the full column map", async () => {
    const cap = capture();
    await new PostgresClientReleaseStore(cap.conn).record(RELEASE);
    const { sql, params } = cap.calls[0]!;
    expect(sql).toContain("INSERT INTO meta.sdk_client_releases");
    expect(sql).toContain("ON CONFLICT (release_id) DO UPDATE SET");
    expect(sql).toContain("$18::jsonb"); // security_advisories
    expect(params.slice(0, 6)).toEqual(["rel-typescript-1.0.0", "typescript", "1.0.0", "v1", "stable", "published"]);
    expect(params[11]).toBe("00000000-0000-4000-8000-000000000000"); // published_by
    expect(JSON.parse(params[17] as string)).toEqual([]); // security_advisories
  });

  it("rejects an invalid schema name", () => {
    const cap = capture();
    expect(() => new PostgresClientReleaseStore(cap.conn, { schema: "bad; DROP" })).toThrow(/invalid schema/);
  });

  it("get returns null when absent, a parsed release when present", async () => {
    const cap = capture();
    const store = new PostgresClientReleaseStore(cap.conn);
    expect(await store.get("missing")).toBeNull();
    cap.rows = [row()];
    const r = await store.get("rel-typescript-1.0.0");
    expect(r?.id).toBe("rel-typescript-1.0.0");
    expect(r?.artifactSizeBytes).toBe(4096);
    expect(r?.channel).toBe("stable");
  });

  it("list filters by language/channel/status + clamps the limit", async () => {
    const cap = capture();
    cap.rows = [row()];
    await new PostgresClientReleaseStore(cap.conn).list({ language: "typescript", channel: "stable", status: "published", limit: 99999 });
    const { sql, params } = cap.calls[0]!;
    expect(sql).toContain("WHERE language = $1 AND channel = $2 AND status = $3");
    expect(sql).toContain("ORDER BY language ASC, version DESC");
    expect(params).toEqual(["typescript", "stable", "published", 1000]); // clamped
  });
});

describe("rowToClientRelease", () => {
  it("coerces BIGINT strings + Date timestamps and omits absent optionals", () => {
    const r = rowToClientRelease({ ...row(), artifact_size_bytes: "8192", download_count: "5", published_at: new Date("2026-06-11T00:00:00.000Z") });
    expect(r.artifactSizeBytes).toBe(8192);
    expect(r.downloadCount).toBe(5);
    expect(r.publishedAt).toBe("2026-06-11T00:00:00.000Z");
    expect("deprecatedReason" in r).toBe(false);
  });
});

function row(): Record<string, unknown> {
  return {
    release_id: "rel-typescript-1.0.0",
    language: "typescript",
    version: "1.0.0",
    api_version: "v1",
    channel: "stable",
    status: "published",
    artifact_sha256: "a".repeat(64),
    artifact_size_bytes: 4096,
    registry_package_uri: "https://registry.npmjs.org/@acme/operate-client",
    generation_run_id: "gen-typescript-abc123",
    published_at: "2026-06-11T00:00:00.000Z",
    published_by: "00000000-0000-4000-8000-000000000000",
    deprecated_at: null,
    deprecated_reason: null,
    deprecated_replaced_by: null,
    yanked_at: null,
    yanked_reason: null,
    security_advisories: [],
    changelog_url: "https://docs.acme.dev/changelog",
    download_count: 0,
    breaking_changes: false,
    min_language_runtime_version: null,
  };
}
