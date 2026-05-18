import type { RouteDefinition } from "@crossengin/api-gateway";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresRouteRegistry } from "./route-registry.js";

const USER = "00000000-0000-4000-8000-000000000099";

function routeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    route_id: "rt_route0001",
    operation_id: "tenants.create",
    method: "POST",
    path_segments: [
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "tenants" },
    ],
    api_version: "v1",
    is_deprecated: false,
    deprecated_since: null,
    sunset_at: null,
    successor_operation_id: null,
    required_scopes: ["tenants:write"],
    rate_limit_policy_id: null,
    idempotency_required: false,
    request_schema_sha256: null,
    response_schema_sha256: null,
    ...overrides,
  };
}

function mockConnection(
  rows: Record<string, unknown>[],
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      if (capture !== undefined) capture.push({ sql, params });
      if (sql.includes("SELECT")) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 1 };
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

describe("PostgresRouteRegistry — empty cache", () => {
  it("returns null on lookup before ensureLoaded is called", () => {
    const conn = mockConnection([]);
    const registry = new PostgresRouteRegistry({ conn });
    expect(registry.lookup({ method: "POST", path: "/v1/tenants", apiVersion: "v1" })).toBeNull();
  });

  it("listVersionsFor returns empty before load", () => {
    const conn = mockConnection([]);
    const registry = new PostgresRouteRegistry({ conn });
    expect(registry.listVersionsFor("POST", "/v1/tenants")).toEqual([]);
  });
});

describe("PostgresRouteRegistry — after loading", () => {
  it("matches a literal route", async () => {
    const conn = mockConnection([routeRow()]);
    const registry = new PostgresRouteRegistry({ conn });
    await registry.ensureLoaded();
    const result = registry.lookup({ method: "POST", path: "/v1/tenants", apiVersion: "v1" });
    expect(result?.route.operationId).toBe("tenants.create");
    expect(result?.params).toEqual({});
  });

  it("matches a parameterized route + captures params", async () => {
    const conn = mockConnection([
      routeRow({
        route_id: "rt_route0002",
        operation_id: "tenants.get",
        method: "GET",
        path_segments: [
          { kind: "literal", value: "v1" },
          { kind: "literal", value: "tenants" },
          { kind: "parameter", name: "tenantId", pattern: null },
        ],
      }),
    ]);
    const registry = new PostgresRouteRegistry({ conn });
    await registry.ensureLoaded();
    const result = registry.lookup({ method: "GET", path: "/v1/tenants/acme", apiVersion: "v1" });
    expect(result?.params).toEqual({ tenantId: "acme" });
  });

  it("rejects mismatched api version", async () => {
    const conn = mockConnection([routeRow()]);
    const registry = new PostgresRouteRegistry({ conn });
    await registry.ensureLoaded();
    expect(registry.lookup({ method: "POST", path: "/v1/tenants", apiVersion: "v2" })).toBeNull();
  });

  it("listVersionsFor returns matching versions", async () => {
    const conn = mockConnection([
      routeRow({ api_version: "v1" }),
      routeRow({
        route_id: "rt_route0003",
        api_version: "v2",
        path_segments: [
          { kind: "literal", value: "v2" },
          { kind: "literal", value: "tenants" },
        ],
      }),
    ]);
    const registry = new PostgresRouteRegistry({ conn });
    await registry.ensureLoaded();
    expect(registry.listVersionsFor("POST", "/v1/tenants")).toEqual(["v1"]);
    expect(registry.listVersionsFor("POST", "/v2/tenants")).toEqual(["v2"]);
  });

  it("parses path_segments delivered as JSON-text", async () => {
    const conn = mockConnection([
      routeRow({ path_segments: JSON.stringify([{ kind: "literal", value: "v1" }, { kind: "literal", value: "tenants" }]) }),
    ]);
    const registry = new PostgresRouteRegistry({ conn });
    await registry.ensureLoaded();
    const result = registry.lookup({ method: "POST", path: "/v1/tenants", apiVersion: "v1" });
    expect(result?.route.operationId).toBe("tenants.create");
  });
});

describe("PostgresRouteRegistry — caching", () => {
  it("does not requery within the cache TTL", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection([routeRow()], capture);
    let nowMs = 1_000;
    const registry = new PostgresRouteRegistry({ conn, cacheTtlMs: 5_000, now: () => nowMs });
    await registry.ensureLoaded();
    await registry.ensureLoaded();
    await registry.ensureLoaded();
    expect(capture.filter((c) => c.sql.includes("SELECT"))).toHaveLength(1);
  });

  it("requeries after cache TTL expires", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection([routeRow()], capture);
    let nowMs = 1_000;
    const registry = new PostgresRouteRegistry({ conn, cacheTtlMs: 1_000, now: () => nowMs });
    await registry.ensureLoaded();
    nowMs = 5_000;
    await registry.ensureLoaded();
    expect(capture.filter((c) => c.sql.includes("SELECT"))).toHaveLength(2);
  });

  it("refresh() forces a reload", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection([routeRow()], capture);
    const registry = new PostgresRouteRegistry({ conn });
    await registry.ensureLoaded();
    await registry.refresh();
    expect(capture.filter((c) => c.sql.includes("SELECT"))).toHaveLength(2);
  });
});

describe("PostgresRouteRegistry — upsert", () => {
  it("issues an INSERT ... ON CONFLICT DO UPDATE and invalidates the cache", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection([routeRow()], capture);
    const registry = new PostgresRouteRegistry({ conn });
    await registry.ensureLoaded();
    const route: RouteDefinition = {
      id: "rt_route0099",
      operationId: "tenants.update",
      method: "PATCH",
      pathSegments: [
        { kind: "literal", value: "v1" },
        { kind: "literal", value: "tenants" },
        { kind: "parameter", name: "id", pattern: null },
      ],
      apiVersion: "v1",
      isDeprecated: false,
      deprecatedSince: null,
      sunsetAt: null,
      successorOperationId: null,
      requiredScopes: ["tenants:write"],
      rateLimitPolicyId: null,
      idempotencyRequired: true,
      requestSchemaSha256: null,
      responseSchemaSha256: null,
    };
    await registry.upsert(route, USER);
    const insert = capture.find((c) => c.sql.includes("INSERT"));
    expect(insert?.sql).toContain("ON CONFLICT (route_id) DO UPDATE");
    expect(insert?.params?.[0]).toBe("rt_route0099");
  });
});

describe("PostgresRouteRegistry — listAll", () => {
  it("returns RouteDefinitions for every stored row, ordered by api_version + method + route_id", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(
      [
        routeRow({ route_id: "rt_route0001", method: "GET" }),
        routeRow({ route_id: "rt_route0002", method: "POST" }),
      ],
      capture,
    );
    const registry = new PostgresRouteRegistry({ conn });
    const all = await registry.listAll();
    expect(all).toHaveLength(2);
    expect(all[0]!.id).toBe("rt_route0001");
    expect(all[0]!.method).toBe("GET");
    expect(all[1]!.id).toBe("rt_route0002");
    const select = capture.find((c) => c.sql.includes("SELECT"));
    expect(select?.sql).toContain("ORDER BY api_version, method, route_id");
  });

  it("returns an empty array when no rows match", async () => {
    const conn = mockConnection([]);
    const registry = new PostgresRouteRegistry({ conn });
    const all = await registry.listAll();
    expect(all).toEqual([]);
  });
});

describe("PostgresRouteRegistry — deleteByRouteId", () => {
  it("issues DELETE WHERE route_id and returns true when a row was removed", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn: PgConnection = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
        capture.push({ sql, params });
        if (sql.includes("DELETE")) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }) as PgConnection["query"],
      transaction: vi.fn() as PgConnection["transaction"],
      withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
      close: vi.fn() as PgConnection["close"],
    };
    const registry = new PostgresRouteRegistry({ conn });
    const removed = await registry.deleteByRouteId("rt_route0042");
    expect(removed).toBe(true);
    const del = capture.find((c) => c.sql.includes("DELETE"));
    expect(del?.sql).toContain("WHERE route_id = $1");
    expect(del?.params?.[0]).toBe("rt_route0042");
  });

  it("returns false when no row matched the route id", async () => {
    const conn: PgConnection = {
      query: vi.fn(async (): Promise<PgQueryResult> => ({ rows: [], rowCount: 0 })) as PgConnection["query"],
      transaction: vi.fn() as PgConnection["transaction"],
      withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
      close: vi.fn() as PgConnection["close"],
    };
    const registry = new PostgresRouteRegistry({ conn });
    expect(await registry.deleteByRouteId("rt_unknown1")).toBe(false);
  });

  it("invalidates the cache so subsequent lookups reload from the DB", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    let selectCount = 0;
    const conn: PgConnection = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
        capture.push({ sql, params });
        if (sql.includes("SELECT")) {
          selectCount += 1;
          return { rows: [routeRow()], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }) as PgConnection["query"],
      transaction: vi.fn() as PgConnection["transaction"],
      withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
      close: vi.fn() as PgConnection["close"],
    };
    const registry = new PostgresRouteRegistry({ conn });
    await registry.ensureLoaded();
    expect(selectCount).toBe(1);
    await registry.deleteByRouteId("rt_route0001");
    await registry.ensureLoaded();
    expect(selectCount).toBe(2);
  });
});
