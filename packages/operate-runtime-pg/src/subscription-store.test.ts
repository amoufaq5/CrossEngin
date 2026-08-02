import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { PostgresSubscriptionStore } from "./subscription-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

interface Captured {
  sql: string;
  params: readonly unknown[];
}

function fakePg(): { conn: PgConnection; inserts: Captured[]; tenantCtx: () => string | null } {
  const inserts: Captured[] = [];
  let tenantCtx: string | null = null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    const p = params ?? [];
    if (sql.includes("set_config")) {
      tenantCtx = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO meta.billing_subscriptions")) {
      inserts.push({ sql, params: p });
      expect(tenantCtx).toBe(String(p[0])); // insert runs under the tenant's RLS context
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
  return { conn, inserts, tenantCtx: () => tenantCtx };
}

describe("PostgresSubscriptionStore", () => {
  it("inserts a snapshot binding tenant id + serializing features to JSON", async () => {
    const { conn, inserts } = fakePg();
    await new PostgresSubscriptionStore(conn).insert({
      tenantId: TENANT,
      planId: "price_pro",
      status: "active",
      currentPeriodEnd: "2027-01-01T00:00:00.000Z",
      trialEnd: null,
      maxRecordsPerEntity: 500,
      features: ["sso", "exports"],
    });
    expect(inserts).toHaveLength(1);
    const { params } = inserts[0]!;
    expect(params[0]).toBe(TENANT);
    expect(params[1]).toBe("price_pro");
    expect(params[2]).toBe("active");
    expect(params[3]).toBe("2027-01-01T00:00:00.000Z");
    expect(params[5]).toBe(500);
    expect(params[6]).toBe(JSON.stringify(["sso", "exports"]));
    // The raw tenant id is bound, never interpolated into the SQL text.
    expect(inserts[0]!.sql).not.toContain(TENANT);
  });

  it("passes null for absent optionals", async () => {
    const { conn, inserts } = fakePg();
    await new PostgresSubscriptionStore(conn).insert({
      tenantId: TENANT,
      planId: null,
      status: "canceled",
      currentPeriodEnd: null,
      trialEnd: null,
      maxRecordsPerEntity: null,
      features: null,
    });
    const { params } = inserts[0]!;
    expect(params[6]).toBeNull();
    expect(params[5]).toBeNull();
  });

  it("rejects an invalid schema identifier", () => {
    const { conn } = fakePg();
    expect(() => new PostgresSubscriptionStore(conn, { schema: "meta; DROP" })).toThrow(/invalid schema/);
  });
});
