import { describe, expect, it, vi } from "vitest";

import type { PgConnection, PgQueryResult } from "./connection.js";
import {
  META_MIGRATIONS_TABLE,
  ensureMigrationLog,
  isStatementApplied,
  listAppliedHashes,
  migrationLogDdl,
  recordStatement,
} from "./migration-log.js";
import { hashStatement } from "./statement-hash.js";

function mockConnection(
  queryFn: (
    sql: string,
    params?: readonly unknown[],
  ) => Promise<PgQueryResult<Record<string, unknown>>>,
): PgConnection {
  return {
    query: vi.fn(queryFn) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

describe("migrationLogDdl", () => {
  it("creates a schema, table, and two indexes", () => {
    const ddl = migrationLogDdl("meta");
    expect(ddl).toHaveLength(4);
    expect(ddl[0]).toContain('CREATE SCHEMA IF NOT EXISTS "meta"');
    expect(ddl[1]).toContain("CREATE TABLE IF NOT EXISTS");
    expect(ddl[1]).toContain(META_MIGRATIONS_TABLE);
    expect(ddl[2]).toContain("executed_at");
    expect(ddl[3]).toContain("succeeded");
  });

  it("constrains statement_hash to lowercase hex sha256", () => {
    const ddl = migrationLogDdl("meta");
    expect(ddl[1]).toContain("CHECK (statement_hash ~ '^[0-9a-f]{64}$')");
  });

  it("rejects unsafe schema identifiers", () => {
    expect(() => migrationLogDdl('meta"; DROP TABLE foo; --')).toThrow(/unsafe identifier/);
  });
});

describe("ensureMigrationLog", () => {
  it("issues each DDL statement once", async () => {
    const queries: string[] = [];
    const conn = mockConnection(async (sql) => {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    });
    await ensureMigrationLog(conn, "meta");
    expect(queries).toHaveLength(4);
    expect(queries[1]).toContain("CREATE TABLE IF NOT EXISTS");
  });
});

describe("isStatementApplied", () => {
  it("returns true when a succeeded row exists", async () => {
    const conn = mockConnection(async () => ({
      rows: [{ succeeded: true }],
      rowCount: 1,
    }));
    const h = hashStatement("CREATE TABLE x();");
    await expect(isStatementApplied(conn, "meta", h)).resolves.toBe(true);
  });

  it("returns false when the row exists but did not succeed", async () => {
    const conn = mockConnection(async () => ({
      rows: [{ succeeded: false }],
      rowCount: 1,
    }));
    const h = hashStatement("CREATE TABLE x();");
    await expect(isStatementApplied(conn, "meta", h)).resolves.toBe(false);
  });

  it("returns false when no row exists", async () => {
    const conn = mockConnection(async () => ({ rows: [], rowCount: 0 }));
    const h = hashStatement("CREATE TABLE x();");
    await expect(isStatementApplied(conn, "meta", h)).resolves.toBe(false);
  });

  it("rejects an invalid hash", async () => {
    const conn = mockConnection(async () => ({ rows: [], rowCount: 0 }));
    await expect(isStatementApplied(conn, "meta", "not-a-hash")).rejects.toThrow(
      /not a valid statement hash/,
    );
  });
});

describe("recordStatement", () => {
  it("inserts with the hash, excerpt, duration, and status", async () => {
    const captured: Array<{ sql: string; params: readonly unknown[] }> = [];
    const conn = mockConnection(async (sql, params) => {
      captured.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 1 };
    });
    const entry = await recordStatement(conn, "meta", "CREATE TABLE x();", 7, true, null);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toContain("INSERT INTO");
    expect(captured[0]?.params[0]).toBe(hashStatement("CREATE TABLE x();"));
    expect(captured[0]?.params[2]).toBe(7);
    expect(captured[0]?.params[3]).toBe(true);
    expect(captured[0]?.params[4]).toBeNull();
    expect(entry.succeeded).toBe(true);
    expect(entry.durationMs).toBe(7);
  });

  it("captures the error message when failed", async () => {
    const captured: Array<{ sql: string; params: readonly unknown[] }> = [];
    const conn = mockConnection(async (sql, params) => {
      captured.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 1 };
    });
    const entry = await recordStatement(conn, "meta", "BAD SQL", 12, false, "syntax error");
    expect(captured[0]?.params[3]).toBe(false);
    expect(captured[0]?.params[4]).toBe("syntax error");
    expect(entry.errorMessage).toBe("syntax error");
    expect(entry.succeeded).toBe(false);
  });

  it("upserts on conflict so retries replace the prior record", async () => {
    const captured: string[] = [];
    const conn = mockConnection(async (sql) => {
      captured.push(sql);
      return { rows: [], rowCount: 1 };
    });
    await recordStatement(conn, "meta", "CREATE TABLE x();", 1, true);
    expect(captured[0]).toContain("ON CONFLICT (statement_hash) DO UPDATE");
  });
});

describe("listAppliedHashes", () => {
  it("returns hashes only for succeeded rows", async () => {
    const conn = mockConnection(async () => ({
      rows: [{ statement_hash: "a".repeat(64) }, { statement_hash: "b".repeat(64) }],
      rowCount: 2,
    }));
    const hashes = await listAppliedHashes(conn, "meta");
    expect(hashes).toEqual(["a".repeat(64), "b".repeat(64)]);
  });
});
