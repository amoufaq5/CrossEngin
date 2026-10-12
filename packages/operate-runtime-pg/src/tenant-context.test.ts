import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { SET_EXTRA_SETTING_SQL, SET_TENANT_CONTEXT_SQL, withTenantContext } from "./tenant-context.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function mockConn(): { conn: PgConnection; calls: Array<{ sql: string; params: readonly unknown[] | undefined }> } {
  const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return { conn, calls };
}

describe("withTenantContext", () => {
  it("sets app.current_tenant_id (transaction-local) before running fn", async () => {
    const { conn, calls } = mockConn();
    const result = await withTenantContext(conn, TENANT, async (tx) => {
      await tx.query("SELECT 1", []);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(calls[0]?.params).toEqual([TENANT]);
    expect(calls[1]?.sql).toBe("SELECT 1");
  });

  it("binds the tenant id as a parameter, never interpolated", () => {
    expect(SET_TENANT_CONTEXT_SQL).toContain("$1");
    expect(SET_TENANT_CONTEXT_SQL).toContain("set_config");
    expect(SET_TENANT_CONTEXT_SQL).toContain("true");
  });

  it("rejects a malformed tenant id before opening a transaction", async () => {
    const { conn, calls } = mockConn();
    await expect(withTenantContext(conn, "'; DROP TABLE x; --", async () => "x")).rejects.toThrow(
      /invalid tenantId/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("withTenantContext — extra transaction-local settings", () => {
  const KEY = "a-column-key-value";

  it("issues nothing extra when settings is omitted", async () => {
    const { conn, calls } = mockConn();
    await withTenantContext(conn, TENANT, async (tx) => {
      await tx.query("SELECT 1", []);
      return null;
    });
    // The statement sequence this function has always issued, pinned: one `set_config` and then
    // the body. A deployment with no encrypted column must pay nothing for the seam.
    expect(calls.map((c) => c.sql)).toEqual([SET_TENANT_CONTEXT_SQL, "SELECT 1"]);
  });

  it("issues nothing extra for an empty settings map", async () => {
    const { conn, calls } = mockConn();
    await withTenantContext(conn, TENANT, async () => null, new Map());
    expect(calls.map((c) => c.sql)).toEqual([SET_TENANT_CONTEXT_SQL]);
  });

  it("applies each extra setting after the tenant context and before the body", async () => {
    const { conn, calls } = mockConn();
    await withTenantContext(
      conn,
      TENANT,
      async (tx) => {
        await tx.query("SELECT 1", []);
        return null;
      },
      new Map([["app.column_encryption_key", KEY]]),
    );
    expect(calls.map((c) => c.sql)).toEqual([
      SET_TENANT_CONTEXT_SQL,
      SET_EXTRA_SETTING_SQL,
      "SELECT 1",
    ]);
  });

  it("binds BOTH the setting name and its value, never interpolating either", async () => {
    const { conn, calls } = mockConn();
    await withTenantContext(conn, TENANT, async () => null, new Map([["app.column_encryption_key", KEY]]));
    expect(calls[1]?.params).toEqual(["app.column_encryption_key", KEY]);
    // Load-bearing rather than stylistic: the one caller carries a pgcrypto key, and an
    // interpolated value lands in `log_statement = 'all'`, `pg_stat_statements` and any error that
    // echoes the statement. Bound, the SQL text is this constant for every key in every deployment.
    expect(calls[1]?.sql).toBe(SET_EXTRA_SETTING_SQL);
    expect(calls.map((c) => c.sql).join("\n")).not.toContain(KEY);
    expect(calls.map((c) => c.sql).join("\n")).not.toContain("app.column_encryption_key");
  });

  it("is transaction-local, like the tenant context it rides with", async () => {
    // `is_local = true`, so the setting is discarded with the transaction and a pooled connection
    // never carries one tenant's key into another tenant's statement.
    expect(SET_EXTRA_SETTING_SQL).toContain("true");
    expect(SET_EXTRA_SETTING_SQL).toContain("set_config");
  });

  it("applies several settings in map order", async () => {
    const { conn, calls } = mockConn();
    await withTenantContext(
      conn,
      TENANT,
      async () => null,
      new Map([
        ["app.one", "1"],
        ["app.two", "2"],
      ]),
    );
    expect(calls.slice(1).map((c) => c.params)).toEqual([
      ["app.one", "1"],
      ["app.two", "2"],
    ]);
  });

  it("rejects a malformed tenant id before applying any setting", async () => {
    const { conn, calls } = mockConn();
    await expect(
      withTenantContext(conn, "not a tenant", async () => null, new Map([["app.column_encryption_key", KEY]])),
    ).rejects.toThrow(/invalid tenantId/);
    expect(calls).toHaveLength(0);
  });
});
