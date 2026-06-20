import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { PostgresSequenceAllocator } from "./sequence-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function fakePg(): PgConnection {
  const counters = new Map<string, number>();
  let tenantCtx: string | null = null;

  const run = async (sql: string, params?: readonly unknown[]) => {
    const p = params ?? [];
    if (sql.includes("set_config")) {
      tenantCtx = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO meta.operate_sequences")) {
      const key = `${String(p[0])} ${String(p[1])} ${String(p[2])}`;
      const start = Number(p[3]);
      const current = counters.get(key);
      const next = current === undefined ? start : current + 1;
      counters.set(key, next);
      // RLS: only the tenant in context may write/read its rows.
      expect(tenantCtx).toBe(String(p[0]));
      return { rows: [{ current_value: String(next) }], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };

  const conn: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) => run(sql, params)) as PgConnection["query"],
    transaction: async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn),
    withAdvisoryLock: async <T,>(_k: bigint, fn: () => Promise<T>) => fn(),
    close: async () => undefined,
  };
  return conn;
}

describe("PostgresSequenceAllocator", () => {
  it("increments atomically per (tenant, name, period)", async () => {
    const a = new PostgresSequenceAllocator(fakePg());
    const i = { tenantId: TENANT, sequenceName: "erp.invoice", periodKey: "2026" };
    expect(await a.allocate(i)).toBe(1);
    expect(await a.allocate(i)).toBe(2);
    expect(await a.allocate({ ...i, periodKey: "2027" })).toBe(1);
  });

  it("honors a custom start", async () => {
    const a = new PostgresSequenceAllocator(fakePg());
    expect(await a.allocate({ tenantId: TENANT, sequenceName: "erp.po", periodKey: "all", start: 1000 })).toBe(1000);
  });

  it("rejects an invalid sequence name or period key", async () => {
    const a = new PostgresSequenceAllocator(fakePg());
    await expect(a.allocate({ tenantId: TENANT, sequenceName: "bad name;DROP", periodKey: "all" })).rejects.toThrow();
    await expect(a.allocate({ tenantId: TENANT, sequenceName: "ok", periodKey: "../etc" })).rejects.toThrow();
  });

  it("rejects an invalid schema identifier", () => {
    expect(() => new PostgresSequenceAllocator(fakePg(), "meta; DROP")).toThrow();
  });
});
