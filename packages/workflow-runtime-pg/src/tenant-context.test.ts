import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { SET_TENANT_CONTEXT_SQL, withTenantContext } from "./tenant-context.js";

const TENANT = "11111111-1111-7111-8111-111111111111";

function mockConn(): {
  conn: PgConnection;
  calls: Array<{ sql: string; params: readonly unknown[] | undefined }>;
  transactions: number;
} {
  const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  let transactions = 0;
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      transactions += 1;
      return fn(conn);
    }) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return {
    conn,
    calls,
    get transactions() {
      return transactions;
    },
  };
}

describe("SET_TENANT_CONTEXT_SQL", () => {
  it("binds the tenant id rather than interpolating it", () => {
    expect(SET_TENANT_CONTEXT_SQL).toContain("$1");
    expect(SET_TENANT_CONTEXT_SQL).toContain("set_config");
    expect(SET_TENANT_CONTEXT_SQL).toContain("app.current_tenant_id");
  });

  it("is transaction-local, so a pooled connection cannot carry one tenant into another's statement", () => {
    // `is_local => true`. Without it the setting outlives the transaction on a pooled connection
    // and the next checkout serves a different tenant under this one's context — which is worse
    // than the defect this module closes, because it is a cross-tenant *write* rather than a
    // refusal.
    expect(SET_TENANT_CONTEXT_SQL).toContain("true");
  });

  it("is the same statement every sibling package issues, so a reader can compare them", () => {
    // Fifteen packages declare this string. The convergence is deferred (see the module's doc and
    // this increment's ADR), so the least this can do is not drift: it is byte-for-byte the form
    // `kernel-pg`'s own callers use.
    expect(SET_TENANT_CONTEXT_SQL).toBe("SELECT set_config('app.current_tenant_id', $1, true)");
  });
});

describe("withTenantContext", () => {
  it("sets the context before running fn, and hands fn the transaction", async () => {
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

  it("issues exactly one context statement however many statements the body runs", async () => {
    // The producers loop, one INSERT per planned run. The context belongs to the transaction, not
    // to the statement, so a ten-row batch pays for one `set_config` and not ten.
    const { conn, calls } = mockConn();
    await withTenantContext(conn, TENANT, async (tx) => {
      for (let i = 0; i < 5; i += 1) await tx.query(`INSERT ${String(i)}`, []);
      return null;
    });
    expect(calls.filter((c) => c.sql === SET_TENANT_CONTEXT_SQL)).toHaveLength(1);
    expect(calls).toHaveLength(6);
  });

  it("opens exactly one transaction", async () => {
    const m = mockConn();
    await withTenantContext(m.conn, TENANT, async () => null);
    expect(m.transactions).toBe(1);
  });

  it("refuses a malformed tenant id before opening a transaction or issuing anything", async () => {
    // Before, not after: a value that cannot be a tenant must not reach `set_config`, where an
    // empty or unparseable setting makes the RLS predicate `tenant_id = NULL` again — the very
    // state this module exists to prevent, arrived at through the module itself.
    const m = mockConn();
    await expect(withTenantContext(m.conn, "'; DROP TABLE x; --", async () => "x")).rejects.toThrow(
      /invalid tenantId/,
    );
    expect(m.calls).toHaveLength(0);
    expect(m.transactions).toBe(0);
  });

  it("refuses an empty tenant id", async () => {
    const m = mockConn();
    await expect(withTenantContext(m.conn, "", async () => "x")).rejects.toThrow(/invalid tenantId/);
    expect(m.calls).toHaveLength(0);
  });

  it("propagates a throw from fn, so the caller's transaction rolls back", async () => {
    // Load-bearing for the producers: the batch is one transaction precisely so a failure part-way
    // rolls back rather than leaving a committed prefix, and that only holds if the throw escapes.
    const { conn, calls } = mockConn();
    await expect(
      withTenantContext(conn, TENANT, async (tx) => {
        await tx.query("INSERT 1", []);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(calls.map((c) => c.sql)).toEqual([SET_TENANT_CONTEXT_SQL, "INSERT 1"]);
  });

  it("never puts the tenant id in any SQL text it issues", async () => {
    const { conn, calls } = mockConn();
    await withTenantContext(conn, TENANT, async (tx) => {
      await tx.query("SELECT 1", []);
      return null;
    });
    expect(calls.map((c) => c.sql).join("\n")).not.toContain(TENANT);
  });
});
