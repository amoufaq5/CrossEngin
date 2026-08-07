import type { PgConnection } from "@crossengin/kernel-pg";
import { buildProfileFromTemplate } from "@crossengin/residency";
import { describe, expect, it } from "vitest";

import { PostgresTenantResidencyDirectory } from "./directory.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const AT = { establishedAt: "2026-01-01T00:00:00.000Z" };

/** A fake PgConnection over an in-memory tenant→row map honoring the RLS context. */
function fakePg(): { conn: PgConnection; calls: string[] } {
  const rows = new Map<string, { tenant_id: string; profile: unknown }>();
  const calls: string[] = [];
  let ctx: string | null = null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    calls.push(sql);
    const p = params ?? [];
    if (sql.includes("set_config")) {
      ctx = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO")) {
      rows.set(String(p[0]), { tenant_id: String(p[0]), profile: JSON.parse(String(p[1])) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT profile")) {
      const row = rows.get(String(p[0]));
      // RLS: only visible when the tenant context matches the row's tenant.
      const visible = row !== undefined && ctx === row.tenant_id;
      return { rows: visible ? [{ profile: row.profile }] : [], rowCount: visible ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      const before = ctx;
      try {
        return await fn(conn);
      } finally {
        ctx = before;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, calls };
}

describe("PostgresTenantResidencyDirectory", () => {
  it("upsert then resolve round-trips a profile", async () => {
    const dir = new PostgresTenantResidencyDirectory(fakePg().conn);
    await dir.upsert(TENANT, buildProfileFromTemplate("eu-only", AT), "admin");
    const resolved = await dir.resolve(TENANT);
    expect(resolved?.primaryRegion).toBe("eu-central");
    expect(resolved?.allowedRegions).toContain("eu-west");
  });

  it("upsert replaces an existing profile", async () => {
    const { conn } = fakePg();
    const dir = new PostgresTenantResidencyDirectory(conn);
    await dir.upsert(TENANT, buildProfileFromTemplate("eu-only", AT));
    await dir.upsert(TENANT, buildProfileFromTemplate("us-only", AT));
    expect((await dir.resolve(TENANT))?.primaryRegion).toBe("us-east");
  });

  it("resolve returns null for an unregistered tenant", async () => {
    const dir = new PostgresTenantResidencyDirectory(fakePg().conn);
    expect(await dir.resolve(TENANT)).toBeNull();
  });

  it("a profile for one tenant is invisible to another (RLS context)", async () => {
    const { conn } = fakePg();
    const dir = new PostgresTenantResidencyDirectory(conn);
    await dir.upsert(TENANT, buildProfileFromTemplate("eu-only", AT));
    expect(await dir.resolve(OTHER)).toBeNull();
  });

  it("validates schema name + tenant id", async () => {
    expect(() => new PostgresTenantResidencyDirectory(fakePg().conn, { schema: "meta; DROP" })).toThrow(/invalid schema/);
    const dir = new PostgresTenantResidencyDirectory(fakePg().conn);
    await expect(dir.resolve("not-a-uuid!!")).rejects.toThrow(/invalid tenantId/);
  });

  it("targets meta.tenant_residency_profiles by default, honors a custom schema", async () => {
    const { conn, calls } = fakePg();
    await new PostgresTenantResidencyDirectory(conn).resolve(TENANT);
    expect(calls.some((s) => s.includes("meta.tenant_residency_profiles"))).toBe(true);

    const custom = fakePg();
    await new PostgresTenantResidencyDirectory(custom.conn, { schema: "app_x" }).resolve(TENANT);
    expect(custom.calls.some((s) => s.includes("app_x.tenant_residency_profiles"))).toBe(true);
  });
});
