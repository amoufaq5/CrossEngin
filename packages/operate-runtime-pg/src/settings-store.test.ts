import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { PostgresSettingsStore } from "./settings-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function fakePg(): PgConnection {
  const rowsByTenant = new Map<string, string>();
  let tenantCtx: string | null = null;

  const run = async (sql: string, params?: readonly unknown[]) => {
    const p = params ?? [];
    if (sql.includes("set_config")) {
      tenantCtx = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT settings")) {
      expect(tenantCtx).toBe(String(p[0]));
      const raw = rowsByTenant.get(String(p[0]));
      return raw === undefined ? { rows: [], rowCount: 0 } : { rows: [{ settings: raw }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO meta.operate_tenant_settings")) {
      expect(tenantCtx).toBe(String(p[0]));
      rowsByTenant.set(String(p[0]), String(p[1]));
      return { rows: [], rowCount: 1 };
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

describe("PostgresSettingsStore", () => {
  it("returns empty settings for an untouched tenant", async () => {
    const store = new PostgresSettingsStore(fakePg());
    expect(await store.get(TENANT)).toEqual({});
  });

  it("round-trips a put through JSONB", async () => {
    const store = new PostgresSettingsStore(fakePg());
    await store.put(TENANT, { company: { name: "Acme" }, numbering: { "erp.invoice": { start: 100 } } });
    const got = await store.get(TENANT);
    expect(got.company?.name).toBe("Acme");
    expect(got.numbering?.["erp.invoice"]?.start).toBe(100);
  });

  it("rejects an invalid settings document on put", async () => {
    const store = new PostgresSettingsStore(fakePg());
    await expect(store.put(TENANT, { defaults: { currency: "USDX" } } as never)).rejects.toThrow();
  });
});

describe("PostgresSettingsStore.putWithin", () => {
  it("writes on the caller's transaction and sets no context of its own", async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const tx = {
      query: (async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        if (sql.includes("INSERT INTO meta.operate_tenant_settings")) return { rows: [], rowCount: 1 };
        throw new Error(`unexpected SQL: ${sql}`);
      }) as PgConnection["query"],
      transaction: async () => {
        throw new Error("putWithin must not open a transaction");
      },
      withAdvisoryLock: async () => {
        throw new Error("unexpected advisory lock");
      },
      close: async () => undefined,
    } as PgConnection;
    const store = new PostgresSettingsStore(fakePg());
    const out = await store.putWithin(tx, TENANT, { company: { name: "Acme" } }, "u1");
    expect(out.company?.name).toBe("Acme");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual([TENANT, JSON.stringify({ company: { name: "Acme" } }), "u1"]);
    expect(calls.some((c) => c.sql.includes("set_config"))).toBe(false);
  });

  it("refuses an invalid document before issuing SQL", async () => {
    // `currency` is `length(3)`, so "usd" would be VALID; a four-letter code is what the schema
    // refuses. The recording tx proves the refusal came from the parse and not from a fake's guard.
    const store = new PostgresSettingsStore(fakePg());
    const sqls: string[] = [];
    const tx = {
      query: (async (sql: string) => {
        sqls.push(sql);
        return { rows: [], rowCount: 1 };
      }) as PgConnection["query"],
      transaction: async () => {
        throw new Error("putWithin must not open a transaction");
      },
      withAdvisoryLock: async () => {
        throw new Error("unexpected advisory lock");
      },
      close: async () => undefined,
    } as PgConnection;
    await expect(
      store.putWithin(tx, TENANT, { defaults: { currency: "USDX" } } as never),
    ).rejects.toThrow();
    expect(sqls).toEqual([]);
  });

  it("put refuses an invalid document before opening a transaction", async () => {
    let opened = false;
    const conn = {
      ...fakePg(),
      transaction: async () => {
        opened = true;
        throw new Error("an invalid document must not open a transaction");
      },
    } as PgConnection;
    const store = new PostgresSettingsStore(conn);
    await expect(store.put(TENANT, { defaults: { currency: "USDX" } } as never)).rejects.toThrow();
    expect(opened).toBe(false);
  });
});
