import type { PgConnection } from "@crossengin/kernel-pg";
import type { CompatibilityEntry } from "@crossengin/sdk-clients";
import { describe, expect, it, vi } from "vitest";

import { PostgresSdkCompatibilityStore, compatibilityEntryKey } from "./compatibility-store.js";

interface Captured {
  conn: PgConnection;
  calls: { sql: string; params: readonly unknown[] }[];
  rows: Record<string, unknown>[];
}

function capture(): Captured {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const cap: Captured = { calls, rows: [], conn: undefined as unknown as PgConnection };
  const query = (async (sql: string, params?: readonly unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    return { rows: cap.rows, rowCount: cap.rows.length };
  }) as PgConnection["query"];
  cap.conn = {
    query,
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return cap;
}

const ENTRY: CompatibilityEntry = {
  language: "typescript",
  clientVersion: "1.0.0",
  apiVersion: "v1",
  level: "fully_compatible",
  warningCount: 0,
  determinedAt: "2026-06-11T00:00:00.000Z",
} as unknown as CompatibilityEntry;

describe("compatibilityEntryKey", () => {
  it("joins language:clientVersion:apiVersion", () => {
    expect(compatibilityEntryKey(ENTRY)).toBe("typescript:1.0.0:v1");
  });
});

describe("PostgresSdkCompatibilityStore.record", () => {
  it("upserts keyed on entry_key with the entry stored as JSONB", async () => {
    const cap = capture();
    await new PostgresSdkCompatibilityStore(cap.conn).record(ENTRY);
    const { sql, params } = cap.calls[0]!;
    expect(sql).toContain("INSERT INTO meta.sdk_compatibility_entries");
    expect(sql).toContain("ON CONFLICT (entry_key) DO UPDATE SET");
    expect(sql).toContain("$9::jsonb");
    expect(params[0]).toBe("typescript:1.0.0:v1");
    expect(params.slice(1, 6)).toEqual(["typescript", "1.0.0", "v1", "fully_compatible", 0]);
    expect(JSON.parse(params[8] as string).level).toBe("fully_compatible");
  });

  it("reads reconstruct the entry from the JSONB record", async () => {
    const cap = capture();
    cap.rows = [{ record: ENTRY }];
    const out = await new PostgresSdkCompatibilityStore(cap.conn).listForApiVersion("v1");
    expect(cap.calls[0]!.sql).toContain("WHERE api_version = $1");
    expect(out).toHaveLength(1);
    expect(out[0]!.clientVersion).toBe("1.0.0");
  });

  it("listForClient filters by language + client_version", async () => {
    const cap = capture();
    cap.rows = [{ record: JSON.stringify(ENTRY) }]; // also handles a JSON string column
    const out = await new PostgresSdkCompatibilityStore(cap.conn).listForClient("typescript", "1.0.0");
    expect(cap.calls[0]!.sql).toContain("WHERE language = $1 AND client_version = $2");
    expect(out[0]!.level).toBe("fully_compatible");
  });
});
