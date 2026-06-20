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
