import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { resolveTenantIdentifier } from "./tenant-resolver.js";

interface CapturedQuery {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

function fakeConn(rows: ReadonlyArray<{ id: string }>): {
  conn: PgConnection;
  queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];
  const conn: PgConnection = {
    query: async <T>(sql: string, params?: readonly unknown[]) => {
      queries.push({ sql, params });
      return { rows: rows as unknown as T[], rowCount: rows.length } as PgQueryResult<T>;
    },
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>) => fn(),
    close: async () => undefined,
  };
  return { conn, queries };
}

describe("resolveTenantIdentifier (M4.14.o)", () => {
  const UUID = "11111111-2222-3333-4444-555555555555";

  it("UUID-shaped value short-circuits without any PG query", async () => {
    const { conn, queries } = fakeConn([]);
    const result = await resolveTenantIdentifier(conn, UUID);
    expect(result).toEqual({ ok: true, tenantId: UUID });
    expect(queries).toHaveLength(0);
  });

  it("UUID-shaped value case-insensitive (uppercase hex accepted)", async () => {
    const { conn, queries } = fakeConn([]);
    const upper = UUID.toUpperCase();
    const result = await resolveTenantIdentifier(conn, upper);
    expect(result).toEqual({ ok: true, tenantId: upper });
    expect(queries).toHaveLength(0);
  });

  it("slug-shaped value triggers SELECT id FROM meta.tenants WHERE slug = $1", async () => {
    const { conn, queries } = fakeConn([{ id: UUID }]);
    const result = await resolveTenantIdentifier(conn, "acme-prod");
    expect(result).toEqual({ ok: true, tenantId: UUID });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain("SELECT id FROM meta.tenants WHERE slug = $1");
    expect(queries[0]!.params).toEqual(["acme-prod"]);
  });

  it("unknown slug returns ok:false with explanatory error", async () => {
    const { conn } = fakeConn([]);
    const result = await resolveTenantIdentifier(conn, "no-such-tenant");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no tenant with slug 'no-such-tenant'");
    }
  });

  it("preserves slugs with unusual but valid characters (dots, underscores)", async () => {
    const { conn, queries } = fakeConn([{ id: UUID }]);
    const result = await resolveTenantIdentifier(conn, "acme.prod_v2");
    expect(result).toEqual({ ok: true, tenantId: UUID });
    expect(queries[0]!.params).toEqual(["acme.prod_v2"]);
  });

  it("malformed UUID (missing hyphens, wrong length) falls through to slug lookup", async () => {
    // Operators with typos still get a clean error path — first the slug
    // lookup runs against the garbage value (returns no rows because the
    // typo is unlikely to be a real slug), then the typed "no tenant" error
    // surfaces.
    const { conn, queries } = fakeConn([]);
    const result = await resolveTenantIdentifier(conn, "11111111222233334444555555555555");
    expect(result.ok).toBe(false);
    expect(queries).toHaveLength(1);
    if (!result.ok) {
      expect(result.error).toContain("no tenant with slug");
    }
  });
});
