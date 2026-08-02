import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { PostgresEntitlementResolver } from "./entitlement-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

interface Captured {
  sql: string;
  params: readonly unknown[];
}

function fakePg(row: Record<string, unknown> | null): { conn: PgConnection; selects: Captured[] } {
  const selects: Captured[] = [];
  let tenantCtx: string | null = null;

  const run = async (sql: string, params?: readonly unknown[]) => {
    const p = params ?? [];
    if (sql.includes("set_config")) {
      tenantCtx = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM meta.billing_subscriptions") || sql.includes("billing_subscriptions")) {
      selects.push({ sql, params: p });
      expect(tenantCtx).toBe(String(p[0]));
      return row === null ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };

  const conn: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) => run(sql, params)) as PgConnection["query"],
    transaction: async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn),
    withAdvisoryLock: async <T,>(_k: bigint, fn: () => Promise<T>) => fn(),
    close: async () => undefined,
  };
  return { conn, selects };
}

describe("PostgresEntitlementResolver", () => {
  it("maps a row to an Entitlement (status/plan/limit/features)", async () => {
    const { conn } = fakePg({
      plan_id: "pro",
      status: "active",
      max_records_per_entity: 500,
      features: ["exports", "sso"],
    });
    const resolver = new PostgresEntitlementResolver(conn);
    const ent = await resolver.resolve(TENANT);
    expect(ent).toEqual({
      status: "active",
      planId: "pro",
      maxRecordsPerEntity: 500,
      features: ["exports", "sso"],
    });
  });

  it("returns null when no subscription row exists", async () => {
    const { conn } = fakePg(null);
    const resolver = new PostgresEntitlementResolver(conn);
    expect(await resolver.resolve(TENANT)).toBeNull();
  });

  it("omits optional fields when the row lacks them", async () => {
    const { conn } = fakePg({
      plan_id: null,
      status: "past_due",
      max_records_per_entity: null,
      features: null,
    });
    const resolver = new PostgresEntitlementResolver(conn);
    const ent = await resolver.resolve(TENANT);
    expect(ent).toEqual({ status: "past_due" });
  });

  it("coerces an unknown status to incomplete (fail-closed)", async () => {
    const { conn } = fakePg({
      plan_id: "pro",
      status: "gibberish",
      max_records_per_entity: null,
      features: null,
    });
    const resolver = new PostgresEntitlementResolver(conn);
    const ent = await resolver.resolve(TENANT);
    expect(ent?.status).toBe("incomplete");
  });

  it("parses features / limit delivered as text (JSONB-as-string, numeric text)", async () => {
    const { conn } = fakePg({
      plan_id: "starter",
      status: "trialing",
      max_records_per_entity: "50",
      features: JSON.stringify(["basic"]),
    });
    const resolver = new PostgresEntitlementResolver(conn);
    const ent = await resolver.resolve(TENANT);
    expect(ent).toEqual({
      status: "trialing",
      planId: "starter",
      maxRecordsPerEntity: 50,
      features: ["basic"],
    });
  });

  it("binds tenantId as a parameter and never interpolates it into the SQL", async () => {
    const { conn, selects } = fakePg({
      plan_id: "pro",
      status: "active",
      max_records_per_entity: null,
      features: null,
    });
    const resolver = new PostgresEntitlementResolver(conn);
    await resolver.resolve(TENANT);
    expect(selects).toHaveLength(1);
    expect(selects[0]?.params).toEqual([TENANT]);
    expect(selects[0]?.sql).toContain("$1");
    expect(selects[0]?.sql).not.toContain(TENANT);
    expect(selects[0]?.sql).toContain("ORDER BY updated_at DESC");
    expect(selects[0]?.sql).toContain("LIMIT 1");
  });

  it("uses a custom schema when provided", async () => {
    const { conn, selects } = fakePg({
      plan_id: "pro",
      status: "active",
      max_records_per_entity: null,
      features: null,
    });
    const resolver = new PostgresEntitlementResolver(conn, { schema: "billing" });
    await resolver.resolve(TENANT);
    expect(selects[0]?.sql).toContain("billing.billing_subscriptions");
  });

  it("rejects an invalid schema identifier", () => {
    const { conn } = fakePg(null);
    expect(() => new PostgresEntitlementResolver(conn, { schema: "meta; DROP TABLE x" })).toThrow(
      /invalid schema/,
    );
  });
});
