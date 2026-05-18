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

describe("runGatewayRoutes register-pack (M4.8)", () => {
  it("exits 2 when slug is missing", async () => {
    const { io, errChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(parseRoutesArgs("register-pack"), ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/missing slug/);
  });

  it("exits 2 when slug is unknown (UnknownPackError)", async () => {
    const { io, errChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("register-pack", "bogus/pack"),
      ctx,
    );
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/unknown pack/);
  });

  it("--dry-run prints generated routes WITHOUT calling upsert", async () => {
    const { io, outChunks } = makeIo();
    const { registry, capture } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("register-pack", "operate-erp/core", "--dry-run"),
      ctx,
    );
    expect(code).toBe(0);
    expect(outChunks.join("")).toMatch(/dry-run: 24 route\(s\)/);
    // 4 entities x 5 CRUD + 4 invoice transitions = 24
    const inserts = capture.filter((c) => c.sql.includes("INSERT"));
    expect(inserts).toHaveLength(0);
  });

  it("happy path: upserts every generated route + reports the count", async () => {
    const { io, outChunks } = makeIo();
    const { registry, capture } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("register-pack", "operate-erp/payments"),
      ctx,
    );
    expect(code).toBe(0);
    const inserts = capture.filter((c) => c.sql.includes("INSERT"));
    // core pack: 4 entities * 5 CRUD + 4 invoice transitions = 24
    // payments adds: 1 entity * 5 CRUD + 5 payment transitions = 10
    // total resolved = 34
    expect(inserts).toHaveLength(34);
    expect(outChunks.join("")).toMatch(/registered 34 route\(s\)/);
  });

  it("--format=json emits {pack, count, dryRun, routes}", async () => {
    const { io, outChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs(
        "register-pack",
        "operate-erp/core",
        "--dry-run",
        "--format",
        "json",
      ),
      ctx,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(outChunks.join("")) as {
      pack: string;
      count: number;
      dryRun: boolean;
      routes: unknown[];
    };
    expect(parsed.pack).toBe("operate-erp/core");
    expect(parsed.count).toBe(24);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.routes).toHaveLength(24);
  });

  it("--api-version override threads into pathSegments + apiVersion fields", async () => {
    const { io, outChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    await runGatewayRoutes(
      parseRoutesArgs(
        "register-pack",
        "operate-erp/core",
        "--api-version",
        "v2",
        "--dry-run",
        "--format",
        "json",
      ),
      ctx,
    );
    const parsed = JSON.parse(outChunks.join("")) as {
      routes: Array<{ apiVersion: string; pathSegments: Array<{ value?: string }> }>;
    };
    expect(parsed.routes.every((r) => r.apiVersion === "v2")).toBe(true);
    expect(parsed.routes.every((r) => r.pathSegments[0]?.value === "v2")).toBe(true);
  });

  it("--created-by is threaded into the upsert (param index 14)", async () => {
    const { io } = makeIo();
    const { registry, capture } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    await runGatewayRoutes(
      parseRoutesArgs(
        "register-pack",
        "operate-erp/core",
        "--created-by",
        "11111111-2222-3333-4444-555555555555",
      ),
      ctx,
    );
    const insert = capture.find((c) => c.sql.includes("INSERT"));
    expect(insert?.params?.[14]).toBe("11111111-2222-3333-4444-555555555555");
  });
});

describe("runGatewayRoutes unregister-pack (M4.8.x)", () => {
  it("exits 2 when slug is missing", async () => {
    const { io, errChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(parseRoutesArgs("unregister-pack"), ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/missing slug/);
  });

  it("exits 2 when slug is unknown", async () => {
    const { io, errChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("unregister-pack", "bogus/pack"),
      ctx,
    );
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/unknown pack/);
  });

  it("--dry-run prints the list of route ids WITHOUT calling DELETE", async () => {
    const { io, outChunks } = makeIo();
    const { registry, capture } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("unregister-pack", "operate-erp/core", "--dry-run"),
      ctx,
    );
    expect(code).toBe(0);
    expect(outChunks.join("")).toMatch(/dry-run: 24 route id\(s\) would be deleted/);
    const deletes = capture.filter((c) => c.sql.includes("DELETE"));
    expect(deletes).toHaveLength(0);
  });

  it("happy path: issues DELETE for every generated route id + reports deleted count", async () => {
    const { io, outChunks } = makeIo();
    // Pre-populate stored rows so deletes return rowCount: 1
    const seededRoutes: RouteDefinition[] = [];
    // The fake registry's INSERT path doesn't reflect the real generation, but we'll
    // pre-populate stored to have matching IDs.
    const { registry, capture } = fakeRegistry(seededRoutes);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    // First, register-pack to seed the rows
    await runGatewayRoutes(
      parseRoutesArgs("register-pack", "operate-erp/core"),
      ctx,
    );
    // Now unregister
    const code = await runGatewayRoutes(
      parseRoutesArgs("unregister-pack", "operate-erp/core"),
      ctx,
    );
    expect(code).toBe(0);
    const deletes = capture.filter((c) => c.sql.includes("DELETE"));
    expect(deletes).toHaveLength(24);
    expect(outChunks.join("")).toMatch(/unregistered 24 of 24/);
  });

  it("reports the not-found count when some routes don't exist", async () => {
    const { io, outChunks } = makeIo();
    const { registry, capture } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    // Skip the register-pack — DELETEs on empty stored set return rowCount: 0
    const code = await runGatewayRoutes(
      parseRoutesArgs("unregister-pack", "operate-erp/core"),
      ctx,
    );
    expect(code).toBe(0);
    expect(outChunks.join("")).toMatch(/unregistered 0 of 24/);
    expect(outChunks.join("")).toMatch(/24 route id\(s\) not found — already removed/);
    const deletes = capture.filter((c) => c.sql.includes("DELETE"));
    expect(deletes).toHaveLength(24);
  });

  it("--format=json emits {pack, attempted, deleted, notFound, notFoundIds}", async () => {
    const { io, outChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("unregister-pack", "operate-erp/core", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(outChunks.join("")) as {
      pack: string;
      attempted: number;
      deleted: number;
      notFound: number;
      notFoundIds: string[];
    };
    expect(parsed.pack).toBe("operate-erp/core");
    expect(parsed.attempted).toBe(24);
    expect(parsed.deleted).toBe(0);
    expect(parsed.notFound).toBe(24);
    expect(parsed.notFoundIds).toHaveLength(24);
    expect(parsed.notFoundIds[0]).toMatch(/^rt_[a-f0-9]{16}$/);
  });

  it("--dry-run --format=json emits a different shape: {pack, count, dryRun, routes}", async () => {
    const { io, outChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs(
        "unregister-pack",
        "operate-erp/core",
        "--dry-run",
        "--format",
        "json",
      ),
      ctx,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(outChunks.join("")) as {
      pack: string;
      count: number;
      dryRun: boolean;
      routes: Array<{ id: string; method: string; operationId: string }>;
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.count).toBe(24);
    expect(parsed.routes[0]?.id).toMatch(/^rt_/);
    expect(parsed.routes[0]?.method).toBeDefined();
    expect(parsed.routes[0]?.operationId).toBeDefined();
  });

  it("--api-version override generates the same hash as register-pack with --api-version", async () => {
    const { io } = makeIo();
    const { registry, capture } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    // register with v2
    await runGatewayRoutes(
      parseRoutesArgs(
        "register-pack",
        "operate-erp/core",
        "--api-version",
        "v2",
      ),
      ctx,
    );
    const registeredIds = capture
      .filter((c) => c.sql.includes("INSERT"))
      .map((c) => c.params?.[0] as string);
    // unregister with v2
    await runGatewayRoutes(
      parseRoutesArgs(
        "unregister-pack",
        "operate-erp/core",
        "--api-version",
        "v2",
      ),
      ctx,
    );
    const deletedIds = capture
      .filter((c) => c.sql.includes("DELETE"))
      .map((c) => c.params?.[0] as string);
    // Same set: registered IDs match deleted IDs exactly (apiVersion is part of
    // the operationId-stable route content, so route_id is reused unless slug
    // changes; but since both invocations use the same slug + manifest, IDs match)
    expect(new Set(deletedIds)).toEqual(new Set(registeredIds));
  });
});

describe("runGatewayRoutes sync-pack (M4.8.y)", () => {
  it("exits 2 when slug is missing", async () => {
    const { io, errChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(parseRoutesArgs("sync-pack"), ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/missing slug/);
  });

  it("exits 2 when slug is unknown", async () => {
    const { io, errChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("sync-pack", "bogus/pack"),
      ctx,
    );
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/unknown pack/);
  });

  it("happy path on empty store: all 24 core routes classified as added", async () => {
    const { io, outChunks } = makeIo();
    const { registry, capture } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("sync-pack", "operate-erp/core"),
      ctx,
    );
    expect(code).toBe(0);
    const inserts = capture.filter((c) => c.sql.includes("INSERT"));
    expect(inserts).toHaveLength(24);
    expect(outChunks.join("")).toMatch(/synced 24 route\(s\)/);
    expect(outChunks.join("")).toMatch(/24 added/);
    expect(outChunks.join("")).toMatch(/0 refreshed/);
  });

  it("after register-pack, sync-pack reclassifies all routes as refreshed (persistent)", async () => {
    const { io, outChunks } = makeIo();
    const { registry, capture } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    await runGatewayRoutes(
      parseRoutesArgs("register-pack", "operate-erp/core"),
      ctx,
    );
    const beforeSync = capture.length;
    const code = await runGatewayRoutes(
      parseRoutesArgs("sync-pack", "operate-erp/core"),
      ctx,
    );
    expect(code).toBe(0);
    const newCalls = capture.slice(beforeSync);
    const newInserts = newCalls.filter((c) => c.sql.includes("INSERT"));
    expect(newInserts).toHaveLength(24);
    const out = outChunks.join("");
    expect(out).toMatch(/synced 24 route\(s\)/);
    expect(out).toMatch(/0 added/);
    expect(out).toMatch(/24 refreshed/);
  });

  it("reports external routes (stored but not generated) without deleting them", async () => {
    const { io, outChunks } = makeIo();
    const externalRoute = fixtureRoute({
      id: "rt_externalabc12345",
      operationId: "other.foo",
    });
    const { registry, capture } = fakeRegistry([externalRoute]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("sync-pack", "operate-erp/core"),
      ctx,
    );
    expect(code).toBe(0);
    const deletes = capture.filter((c) => c.sql.includes("DELETE"));
    expect(deletes).toHaveLength(0);
    const out = outChunks.join("");
    expect(out).toMatch(/1 external — left alone/);
    expect(out).toMatch(/rt_externalabc12345/);
  });

  it("--dry-run computes the diff WITHOUT calling upsert", async () => {
    const { io, outChunks } = makeIo();
    const { registry, capture } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("sync-pack", "operate-erp/core", "--dry-run"),
      ctx,
    );
    expect(code).toBe(0);
    const inserts = capture.filter((c) => c.sql.includes("INSERT"));
    expect(inserts).toHaveLength(0);
    const out = outChunks.join("");
    expect(out).toMatch(/dry-run: pack 'operate-erp\/core' would sync 24 route\(s\)/);
    expect(out).toMatch(/24 added/);
  });

  it("--format=json emits {pack, dryRun, total, added, persistent, external, externalIds}", async () => {
    const { io, outChunks } = makeIo();
    const externalRoute = fixtureRoute({ id: "rt_externalabc12345" });
    const { registry } = fakeRegistry([externalRoute]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("sync-pack", "operate-erp/core", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(outChunks.join("")) as {
      pack: string;
      dryRun: boolean;
      total: number;
      added: number;
      persistent: number;
      external: number;
      externalIds: string[];
    };
    expect(parsed.pack).toBe("operate-erp/core");
    expect(parsed.dryRun).toBe(false);
    expect(parsed.total).toBe(24);
    expect(parsed.added).toBe(24);
    expect(parsed.persistent).toBe(0);
    expect(parsed.external).toBe(1);
    expect(parsed.externalIds).toEqual(["rt_externalabc12345"]);
  });

  it("--dry-run --format=json includes externalIds for inspection", async () => {
    const { io, outChunks } = makeIo();
    const externalRoute = fixtureRoute({ id: "rt_externalabc12345" });
    const { registry } = fakeRegistry([externalRoute]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs(
        "sync-pack",
        "operate-erp/core",
        "--dry-run",
        "--format",
        "json",
      ),
      ctx,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(outChunks.join("")) as {
      dryRun: boolean;
      externalIds: string[];
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.externalIds).toEqual(["rt_externalabc12345"]);
  });

  it("--api-version override propagates into all upserts", async () => {
    const { io } = makeIo();
    const { registry, capture } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    await runGatewayRoutes(
      parseRoutesArgs("sync-pack", "operate-erp/core", "--api-version", "v2"),
      ctx,
    );
    const inserts = capture.filter((c) => c.sql.includes("INSERT"));
    expect(inserts).toHaveLength(24);
    for (const insert of inserts) {
      expect(insert.params?.[4]).toBe("v2");
    }
  });

  it("--created-by is threaded into the upsert (param index 14)", async () => {
    const { io } = makeIo();
    const { registry, capture } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    await runGatewayRoutes(
      parseRoutesArgs(
        "sync-pack",
        "operate-erp/core",
        "--created-by",
        "11111111-2222-3333-4444-555555555555",
      ),
      ctx,
    );
    const insert = capture.find((c) => c.sql.includes("INSERT"));
    expect(insert?.params?.[14]).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("payments pack on empty store: all 34 routes added (cross-pack composition)", async () => {
    const { io, outChunks } = makeIo();
    const { registry } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("sync-pack", "operate-erp/payments"),
      ctx,
    );
    expect(code).toBe(0);
    expect(outChunks.join("")).toMatch(/synced 34 route\(s\)/);
    expect(outChunks.join("")).toMatch(/34 added/);
  });

  it("sync-pack is idempotent: second invocation reports refreshed=24, added=0", async () => {
    const { io } = makeIo();
    const { registry, capture } = fakeRegistry([]);
    const ctx: GatewayRoutesContext = { io, env: {}, registryOverride: registry };
    await runGatewayRoutes(parseRoutesArgs("sync-pack", "operate-erp/core"), ctx);
    const beforeSecond = capture.length;
    const { io: io2, outChunks: outChunks2 } = makeIo();
    const ctx2: GatewayRoutesContext = { io: io2, env: {}, registryOverride: registry };
    const code = await runGatewayRoutes(
      parseRoutesArgs("sync-pack", "operate-erp/core"),
      ctx2,
    );
    expect(code).toBe(0);
    const newCalls = capture.slice(beforeSecond);
    const newInserts = newCalls.filter((c) => c.sql.includes("INSERT"));
    expect(newInserts).toHaveLength(24);
    const out = outChunks2.join("");
    expect(out).toMatch(/0 added/);
    expect(out).toMatch(/24 refreshed/);
  });
});
