import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { SET_TENANT_CONTEXT_SQL, withTenantContext } from "./tenant-context.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function mockConn(): {
  conn: PgConnection;
  calls: Array<{ sql: string; params: readonly unknown[] | undefined }>;
} {
  const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
      fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return { conn, calls };
}

describe("withTenantContext", () => {
  it("sets app.current_tenant_id before running fn", async () => {
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

  it("binds the tenant id as $1, never interpolated", () => {
    expect(SET_TENANT_CONTEXT_SQL).toContain("$1");
    expect(SET_TENANT_CONTEXT_SQL).toContain("set_config");
    expect(SET_TENANT_CONTEXT_SQL).toContain("true");
    expect(SET_TENANT_CONTEXT_SQL).not.toContain(TENANT);
  });

  it("rejects a malformed tenant id before opening a transaction", async () => {
    const { conn, calls } = mockConn();
    await expect(
      withTenantContext(conn, "'; DROP TABLE x; --", async () => "x"),
    ).rejects.toThrow(/invalid tenantId/);
    expect(calls).toHaveLength(0);
  });

  it("propagates the fn return value", async () => {
    const { conn } = mockConn();
    const value = await withTenantContext(conn, TENANT, async () => 42);
    expect(value).toBe(42);
  });

  it("accepts a UUID tenant id", async () => {
    const { conn, calls } = mockConn();
    await withTenantContext(conn, TENANT, async () => undefined);
    expect(calls[0]?.params).toEqual([TENANT]);
  });
});
