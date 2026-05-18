import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RouteDefinition } from "@crossengin/api-gateway";
import { PostgresRouteRegistry } from "@crossengin/api-gateway-pg";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { parseArgs } from "./cli.js";
import type { IoStreams } from "./format.js";
import {
  formatPath,
  formatRoutesTable,
  runGatewayRoutes,
  type GatewayRoutesContext,
} from "./gateway-routes.js";

function makeIo(): {
  io: IoStreams;
  outChunks: string[];
  errChunks: string[];
} {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      stdout: { write: (chunk: string) => outChunks.push(chunk) },
      stderr: { write: (chunk: string) => errChunks.push(chunk) },
    },
    outChunks,
    errChunks,
  };
}

function parseRoutesArgs(...args: string[]) {
  const parsed = parseArgs(["node", "crossengin", "gateway", "routes", ...args]);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.command;
}

function fixtureRoute(overrides: Partial<RouteDefinition> = {}): RouteDefinition {
  return {
    id: "rt_route0001",
    operationId: "tenants.create",
    method: "POST",
    pathSegments: [
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "tenants" },
    ],
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: ["tenants:write"],
    rateLimitPolicyId: null,
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
    ...overrides,
  };
}

function fakeRegistry(rows: RouteDefinition[]): {
  registry: PostgresRouteRegistry;
  capture: Array<{ sql: string; params: readonly unknown[] | undefined }>;
} {
  const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  let stored: RouteDefinition[] = [...rows];
  const conn: PgConnection = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      capture.push({ sql, params });
      if (sql.includes("SELECT")) {
        return {
          rows: stored.map(routeAsRow) as unknown as readonly Record<string, unknown>[],
          rowCount: stored.length,
        };
      }
      if (sql.includes("DELETE")) {
        const routeId = params?.[0];
        const before = stored.length;
        stored = stored.filter((r) => r.id !== routeId);
        return { rows: [], rowCount: before - stored.length };
      }
      if (sql.includes("INSERT")) {
        const routeId = params?.[0];
        const existing = stored.findIndex((r) => r.id === routeId);
        if (existing >= 0) stored[existing] = fixtureRoute({ id: routeId as string });
        else stored.push(fixtureRoute({ id: routeId as string }));
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return { registry: new PostgresRouteRegistry({ conn }), capture };
}

function routeAsRow(r: RouteDefinition): Record<string, unknown> {
  return {
    route_id: r.id,
    operation_id: r.operationId,
    method: r.method,
    path_segments: r.pathSegments,
    api_version: r.apiVersion,
    is_deprecated: r.isDeprecated,
    deprecated_since: r.deprecatedSince,
    sunset_at: r.sunsetAt,
    successor_operation_id: r.successorOperationId,
    required_scopes: r.requiredScopes,
    rate_limit_policy_id: r.rateLimitPolicyId,
    idempotency_required: r.idempotencyRequired,
    request_schema_sha256: r.requestSchemaSha256,
    response_schema_sha256: r.responseSchemaSha256,
  };
}

async function withTempFile<T>(
  contents: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "routes-"));
  const path = join(dir, "route.json");
  await writeFile(path, contents, "utf8");
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("runGatewayRoutes — dispatch", () => {
  it("exits 2 when no action is provided", async () => {
    const { io, errChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(parseRoutesArgs(), ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/missing action/);
  });

  it("exits 2 on unknown action", async () => {
    const { io, errChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(parseRoutesArgs("explode"), ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/unknown action 'explode'/);
  });

  it("exits 1 when PG env is missing and no override is supplied", async () => {
    const { io, errChunks } = makeIo();
    const ctx: GatewayRoutesContext = { io, env: {} };
    const code = await runGatewayRoutes(parseRoutesArgs("list"), ctx);
    expect(code).toBe(1);
    expect(errChunks.join("")).toMatch(/PG/);
  });
});

describe("runGatewayRoutes list", () => {
  it("renders an empty message when there are no routes", async () => {
    const { io, outChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(parseRoutesArgs("list"), ctx);
    expect(code).toBe(0);
    expect(outChunks.join("")).toMatch(/no routes registered/);
  });

  it("renders a table with one row per registered route", async () => {
    const { io, outChunks } = makeIo();
    const { registry } = fakeRegistry([
      fixtureRoute({ id: "rt_route0001", method: "GET" }),
      fixtureRoute({ id: "rt_route0002", method: "POST" }),
    ]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(parseRoutesArgs("list"), ctx);
    expect(code).toBe(0);
    const out = outChunks.join("");
    expect(out).toContain("route_id");
    expect(out).toContain("rt_route0001");
    expect(out).toContain("rt_route0002");
    expect(out).toContain("/v1/tenants");
  });

  it("emits NDJSON when --format=json", async () => {
    const { io, outChunks } = makeIo();
    const { registry } = fakeRegistry([fixtureRoute()]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("list", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(outChunks.join("")) as {
      count: number;
      routes: RouteDefinition[];
    };
    expect(parsed.count).toBe(1);
    expect(parsed.routes[0]?.id).toBe("rt_route0001");
  });
});

describe("runGatewayRoutes register", () => {
  it("upserts a valid route from a JSON file", async () => {
    const { io, outChunks } = makeIo();
    const { registry, capture } = fakeRegistry([]);
    const route = fixtureRoute({ id: "rt_route0099", operationId: "tenants.update" });
    await withTempFile(JSON.stringify(route), async (path) => {
      const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
      const code = await runGatewayRoutes(
        parseRoutesArgs("register", path),
        ctx,
      );
      expect(code).toBe(0);
      expect(outChunks.join("")).toContain("rt_route0099");
      const insert = capture.find((c) => c.sql.includes("INSERT"));
      expect(insert).toBeDefined();
      expect(insert?.params?.[0]).toBe("rt_route0099");
    });
  });

  it("exits 2 when path is missing", async () => {
    const { io, errChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(parseRoutesArgs("register"), ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/missing path/);
  });

  it("exits 1 when the file does not exist", async () => {
    const { io, errChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("register", "/nope/missing.json"),
      ctx,
    );
    expect(code).toBe(1);
    expect(errChunks.join("")).toMatch(/failed to read/);
  });

  it("exits 1 when the file is invalid JSON", async () => {
    const { io, errChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    await withTempFile("not json", async (path) => {
      const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
      const code = await runGatewayRoutes(
        parseRoutesArgs("register", path),
        ctx,
      );
      expect(code).toBe(1);
      expect(errChunks.join("")).toMatch(/not valid JSON/);
    });
  });

  it("exits 1 when the JSON fails RouteDefinitionSchema validation", async () => {
    const { io, errChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    await withTempFile(JSON.stringify({ id: "bad" }), async (path) => {
      const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
      const code = await runGatewayRoutes(
        parseRoutesArgs("register", path),
        ctx,
      );
      expect(code).toBe(1);
      expect(errChunks.join("")).toMatch(/RouteDefinitionSchema/);
    });
  });

  it("threads --created-by into the upsert call", async () => {
    const { io } = makeIo();
    const { registry, capture } = fakeRegistry([]);
    const route = fixtureRoute({ id: "rt_route0011" });
    await withTempFile(JSON.stringify(route), async (path) => {
      const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
      await runGatewayRoutes(
        parseRoutesArgs(
          "register",
          path,
          "--created-by",
          "11111111-2222-3333-4444-555555555555",
        ),
        ctx,
      );
      const insert = capture.find((c) => c.sql.includes("INSERT"));
      expect(insert?.params?.[14]).toBe("11111111-2222-3333-4444-555555555555");
    });
  });
});

describe("runGatewayRoutes unregister", () => {
  it("returns 0 when a route is removed", async () => {
    const { io, outChunks } = makeIo();
    const { registry, capture } = fakeRegistry([fixtureRoute({ id: "rt_route0042" })]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("unregister", "rt_route0042"),
      ctx,
    );
    expect(code).toBe(0);
    expect(outChunks.join("")).toMatch(/unregistered route rt_route0042/);
    const del = capture.find((c) => c.sql.includes("DELETE"));
    expect(del?.params?.[0]).toBe("rt_route0042");
  });

  it("returns 1 when no route matches the id", async () => {
    const { io, errChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("unregister", "rt_nomatch1"),
      ctx,
    );
    expect(code).toBe(1);
    expect(errChunks.join("")).toMatch(/no route with id 'rt_nomatch1'/);
  });

  it("exits 2 when route id is missing", async () => {
    const { io, errChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(parseRoutesArgs("unregister"), ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/missing route id/);
  });

  it("emits a JSON envelope when --format=json", async () => {
    const { io, outChunks } = makeIo();
    const { registry } = fakeRegistry([fixtureRoute({ id: "rt_route0042" })]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("unregister", "rt_route0042", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(outChunks.join("")) as { ok: boolean; routeId: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.routeId).toBe("rt_route0042");
  });
});

describe("formatRoutesTable + formatPath", () => {
  it("renders parameter segments with a leading colon", () => {
    const route = fixtureRoute({
      pathSegments: [
        { kind: "literal", value: "v1" },
        { kind: "literal", value: "tenants" },
        { kind: "parameter", name: "id", pattern: null },
      ],
    });
    expect(formatPath(route)).toBe("/v1/tenants/:id");
  });

  it("renders wildcard segments as *", () => {
    const route = fixtureRoute({
      pathSegments: [
        { kind: "literal", value: "v1" },
        { kind: "wildcard" },
      ],
    });
    expect(formatPath(route)).toBe("/v1/*");
  });

  it("table emits one row per route + a header + a separator", () => {
    const out = formatRoutesTable([
      fixtureRoute({ id: "rt_route0001", method: "GET" }),
    ]);
    const lines = out.trim().split("\n");
    expect(lines.length).toBe(3); // header + sep + 1 row
    expect(lines[0]).toContain("route_id");
    expect(lines[2]).toContain("rt_route0001");
  });
});
