import { PostgresIdempotencyStore } from "@crossengin/api-gateway-pg";
import {
  GatewayRuntime,
  InMemoryIdempotencyStore,
  InMemoryPrincipalResolver,
  InMemoryRateLimitChecker,
  InMemoryRouteRegistry,
  type HandleResult,
} from "@crossengin/api-gateway-runtime";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { parseArgs } from "./cli.js";
import type { IoStreams } from "./format.js";
import { buildDefaultGatewayHandlers } from "./gateway-handlers.js";
import type { FetchLike } from "./gateway-jwks.js";
import { runGateway, type GatewayContext } from "./gateway.js";
import type {
  RequestLogEntry,
  RunningGatewayServer,
  StartGatewayServerOptions,
} from "./gateway-server.js";

function makeIo(): { io: IoStreams; outChunks: string[]; errChunks: string[] } {
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

function buildRealRuntime(): GatewayRuntime {
  const { handlers, routes } = buildDefaultGatewayHandlers({
    mode: "in_memory",
    startedAt: new Date(),
  });
  const routeRegistry = new InMemoryRouteRegistry();
  for (const r of routes) routeRegistry.register(r);
  return new GatewayRuntime({
    routes: routeRegistry,
    handlers,
    principalResolver: new InMemoryPrincipalResolver(),
    idempotencyStore: new InMemoryIdempotencyStore(),
    rateLimitChecker: new InMemoryRateLimitChecker({ limit: 100 }),
  });
}

interface FakeServerHandle {
  readonly options: StartGatewayServerOptions;
  readonly server: RunningGatewayServer;
}

function fakeServerFactory(): {
  factory: typeof import("./gateway-server.js").startGatewayServer;
  capture: { value: FakeServerHandle | null };
  closeCalls: { count: number };
} {
  const capture: { value: FakeServerHandle | null } = { value: null };
  const closeCalls = { count: 0 };
  const factory: typeof import("./gateway-server.js").startGatewayServer = async (options) => {
    const server: RunningGatewayServer = {
      host: options.host ?? "127.0.0.1",
      port: options.port === 0 ? 12345 : options.port,
      close: async () => {
        closeCalls.count += 1;
      },
    };
    capture.value = { options, server };
    return server;
  };
  return { factory, capture, closeCalls };
}

function parseGatewayArgs(...args: string[]) {
  const parsed = parseArgs(["node", "crossengin", "gateway", ...args]);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.command;
}

describe("runGateway action dispatch", () => {
  it("exits 2 with help when no action is supplied", async () => {
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = { io, env: {} };
    const command = parseGatewayArgs();
    const code = await runGateway(command, ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/missing action/);
  });

  it("exits 2 with a friendly message for unknown actions", async () => {
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = { io, env: {} };
    const command = parseGatewayArgs("explode");
    const code = await runGateway(command, ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/unknown action 'explode'/);
  });

  it("dispatches the 'routes' action to the routes subcommand handler", async () => {
    const { io, errChunks } = makeIo();
    // No registry override + no PG env → routes handler exits 1 with PG-missing error
    const ctx: GatewayContext = { io, env: {} };
    const command = parseGatewayArgs("routes", "list");
    const code = await runGateway(command, ctx);
    expect(code).toBe(1);
    expect(errChunks.join("")).toMatch(/PG/);
  });
});

describe("runGateway start (in-memory + runtime override)", () => {
  it("rejects an invalid --port flag", async () => {
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      runtimeOverride: buildRealRuntime(),
    };
    const command = parseGatewayArgs("start", "--in-memory", "--port", "not-a-number");
    const code = await runGateway(command, ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/invalid --port/);
  });

  it("rejects a port outside 1..65535", async () => {
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      runtimeOverride: buildRealRuntime(),
    };
    const command = parseGatewayArgs("start", "--in-memory", "--port", "70000");
    const code = await runGateway(command, ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/invalid --port/);
  });

  it("boots in-memory and stops cleanly via the shutdown signal", async () => {
    const { io, outChunks } = makeIo();
    const { factory, capture, closeCalls } = fakeServerFactory();
    let resolveShutdown: () => void = () => undefined;
    const shutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const ctx: GatewayContext = {
      io,
      env: {},
      runtimeOverride: buildRealRuntime(),
      serverFactory: factory,
      waitForShutdown: () => shutdown,
    };
    const command = parseGatewayArgs("start", "--in-memory", "--port", "0");
    const runPromise = runGateway(command, ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(capture.value).not.toBeNull();
    expect(capture.value?.options.port).toBe(0);
    resolveShutdown();
    const code = await runPromise;
    expect(code).toBe(0);
    expect(closeCalls.count).toBe(1);
    const stdout = outChunks.join("");
    expect(stdout).toMatch(/gateway listening on http:\/\/127\.0\.0\.1:/);
    expect(stdout).toMatch(/gateway stopped/);
  });

  it("logs structured request events when --format=json is set", async () => {
    const { io, outChunks } = makeIo();
    let captured: StartGatewayServerOptions | null = null;
    const factory: typeof import("./gateway-server.js").startGatewayServer = async (options) => {
      captured = options;
      return {
        host: "127.0.0.1",
        port: 8080,
        close: async () => undefined,
      };
    };
    const ctx: GatewayContext = {
      io,
      env: {},
      runtimeOverride: buildRealRuntime(),
      serverFactory: factory,
      waitForShutdown: () => Promise.resolve(),
    };
    const command = parseGatewayArgs("start", "--in-memory", "--port", "0", "--format", "json");
    const code = await runGateway(command, ctx);
    expect(code).toBe(0);
    expect(captured).not.toBeNull();
    captured!.onRequest!({
      method: "GET",
      path: "/__ping",
      status: 200,
      durationMs: 5,
      requestId: "req_abcdef0123",
      tenantId: null,
      operationId: "platform.ping",
    } satisfies RequestLogEntry);
    const stdout = outChunks.join("");
    const blocks = stdout
      .split(/(?<=^})\n/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const parsedBlocks = blocks.map((b) => JSON.parse(b) as Record<string, unknown>);
    const startedEntry = parsedBlocks.find((b) => b["kind"] === "started");
    expect(startedEntry).toBeDefined();
    const requestEntry = parsedBlocks.find((b) => b["kind"] === "request");
    expect(requestEntry).toBeDefined();
    expect(requestEntry?.["method"]).toBe("GET");
    expect(requestEntry?.["status"]).toBe(200);
    expect(requestEntry?.["path"]).toBe("/__ping");
  });

  it("renders human-readable request logs by default", async () => {
    const { io, outChunks } = makeIo();
    let captured: StartGatewayServerOptions | null = null;
    const factory: typeof import("./gateway-server.js").startGatewayServer = async (options) => {
      captured = options;
      return {
        host: "127.0.0.1",
        port: 8080,
        close: async () => undefined,
      };
    };
    const ctx: GatewayContext = {
      io,
      env: {},
      runtimeOverride: buildRealRuntime(),
      serverFactory: factory,
      waitForShutdown: () => Promise.resolve(),
    };
    const command = parseGatewayArgs("start", "--in-memory", "--port", "0");
    await runGateway(command, ctx);
    captured!.onRequest!({
      method: "GET",
      path: "/__health",
      status: 200,
      durationMs: 3,
      requestId: "req_abcdef0123",
      tenantId: "ten-1",
      operationId: "platform.health",
    });
    const stdout = outChunks.join("");
    expect(stdout).toContain("GET /__health -> 200 (3ms) tenant=ten-1 op=platform.health");
  });

  it("forwards the executionSink and beforeHandle as undefined for runtime overrides", async () => {
    const { io } = makeIo();
    const { factory, capture } = fakeServerFactory();
    const ctx: GatewayContext = {
      io,
      env: {},
      runtimeOverride: buildRealRuntime(),
      serverFactory: factory,
      waitForShutdown: () => Promise.resolve(),
    };
    const command = parseGatewayArgs("start", "--port", "0");
    await runGateway(command, ctx);
    expect(capture.value?.options.executionSink).toBeUndefined();
    expect(capture.value?.options.beforeHandle).toBeUndefined();
  });

  it("returns 1 when the runtime is not overridden and PG env is missing (postgres mode)", async () => {
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
    };
    const command = parseGatewayArgs("start", "--port", "0");
    const code = await runGateway(command, ctx);
    expect(code).toBe(1);
    expect(errChunks.join("")).toMatch(/PG/);
  });

  it("rejects --jwt-issuer without --jwks-file or --jwks-url", async () => {
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      runtimeOverride: buildRealRuntime(),
      waitForShutdown: () => Promise.resolve(),
    };
    const command = parseGatewayArgs(
      "start",
      "--in-memory",
      "--port",
      "0",
      "--jwt-issuer",
      "https://issuer.example",
    );
    const code = await runGateway(command, ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/--jwks-file/);
  });

  it("rejects --jwks-file and --jwks-url together", async () => {
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      runtimeOverride: buildRealRuntime(),
      waitForShutdown: () => Promise.resolve(),
    };
    const command = parseGatewayArgs(
      "start",
      "--in-memory",
      "--port",
      "0",
      "--jwks-file",
      "/tmp/x.json",
      "--jwks-url",
      "https://example.com/jwks",
      "--jwt-issuer",
      "i",
      "--jwt-audience",
      "a",
    );
    const code = await runGateway(command, ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/mutually exclusive/);
  });

  it("--jwks-url + valid response → started event includes jwksSource", async () => {
    const { io, outChunks } = makeIo();
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ keys: [{ kid: "k1", publicKeyBase64: "AAAA" }] }),
    });
    const factory: typeof import("./gateway-server.js").startGatewayServer = async () => ({
      host: "127.0.0.1",
      port: 12345,
      close: async () => undefined,
    });
    const ctx: GatewayContext = {
      io,
      env: {},
      runtimeOverride: buildRealRuntime(),
      serverFactory: factory,
      waitForShutdown: () => Promise.resolve(),
      jwksFetch: fetchImpl,
      registerReloadHandler: () => () => undefined,
    };
    const command = parseGatewayArgs(
      "start",
      "--in-memory",
      "--port",
      "0",
      "--format",
      "json",
      "--jwks-url",
      "https://example.com/jwks",
      "--jwt-issuer",
      "https://issuer.example",
      "--jwt-audience",
      "https://aud.example",
    );
    const code = await runGateway(command, ctx);
    expect(code).toBe(0);
    const out = outChunks.join("");
    const blocks = out
      .split(/(?<=^})\n/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const parsed = blocks.map((b) => JSON.parse(b) as Record<string, unknown>);
    const started = parsed.find((b) => b["kind"] === "started");
    expect(started).toBeDefined();
    expect(started?.["jwksSource"]).toBe("https://example.com/jwks");
  });

  it("--jwks-url + 404 exits 2 with a JwksLoadError message", async () => {
    const { io, errChunks } = makeIo();
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 404,
      text: async () => "not found",
    });
    const ctx: GatewayContext = {
      io,
      env: {},
      runtimeOverride: buildRealRuntime(),
      waitForShutdown: () => Promise.resolve(),
      jwksFetch: fetchImpl,
    };
    const command = parseGatewayArgs(
      "start",
      "--in-memory",
      "--port",
      "0",
      "--jwks-url",
      "https://example.com/jwks",
      "--jwt-issuer",
      "i",
      "--jwt-audience",
      "a",
    );
    const code = await runGateway(command, ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/status 404/);
  });

  it("registerReloadHandler is invoked when --jwks-url is set, triggering refresh", async () => {
    const { io, outChunks } = makeIo();
    let fetches = 0;
    const fetchImpl: FetchLike = async () => {
      fetches += 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ keys: [{ kid: "k" + fetches.toString(), publicKeyBase64: "AAAA" }] }),
      };
    };
    let captured: (() => void) | null = null;
    const ctx: GatewayContext = {
      io,
      env: {},
      runtimeOverride: buildRealRuntime(),
      serverFactory: async () => ({
        host: "127.0.0.1",
        port: 12345,
        close: async () => undefined,
      }),
      waitForShutdown: () => Promise.resolve(),
      jwksFetch: fetchImpl,
      registerReloadHandler: (handler) => {
        captured = handler;
        return () => undefined;
      },
    };
    const command = parseGatewayArgs(
      "start",
      "--in-memory",
      "--port",
      "0",
      "--format",
      "json",
      "--jwks-url",
      "https://example.com/jwks",
      "--jwt-issuer",
      "i",
      "--jwt-audience",
      "a",
    );
    await runGateway(command, ctx);
    expect(captured).not.toBeNull();
    expect(fetches).toBe(1); // initial load
    captured!();
    await new Promise((res) => setTimeout(res, 5));
    expect(fetches).toBe(2);
    const out = outChunks.join("");
    expect(out).toMatch(/"kind":\s*"jwks_refresh"/);
  });

  it("--jwks-refresh-seconds in --jwks-file mode is rejected (exit 2)", async () => {
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      runtimeOverride: buildRealRuntime(),
      waitForShutdown: () => Promise.resolve(),
    };
    const command = parseGatewayArgs(
      "start",
      "--in-memory",
      "--port",
      "0",
      "--jwks-file",
      "/tmp/whatever.json",
      "--jwt-issuer",
      "i",
      "--jwt-audience",
      "a",
      "--jwks-refresh-seconds",
      "30",
    );
    const code = await runGateway(command, ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/only supported with --jwks-url/);
  });

  it("passes a probe through the runtime override so the wiring is exercised", async () => {
    const { io } = makeIo();
    const { factory, capture } = fakeServerFactory();
    const runtime = buildRealRuntime();
    const probe: HandleResult = await runtime.handleRequest({
      id: "req_probe0001234",
      receivedAt: "2026-05-18T12:00:00.000Z",
      method: "GET",
      path: "/__ping",
      query: {},
      headers: { host: "localhost" },
      host: "localhost",
      scheme: "http",
      bodyBytes: 0,
      bodySha256: null,
      clientIp: "127.0.0.1",
      forwardedFor: [],
      forwardedProto: null,
      forwardedHost: null,
      userAgent: null,
      tlsVersion: null,
      tlsCipher: null,
      clientCertSha256: null,
      correlationId: null,
      traceparent: null,
      tenantHint: null,
      edgeRegion: null,
    });
    expect(probe.response.status).toBe(200);
    const ctx: GatewayContext = {
      io,
      env: {},
      runtimeOverride: runtime,
      serverFactory: factory,
      waitForShutdown: () => Promise.resolve(),
    };
    const command = parseGatewayArgs("start", "--in-memory", "--port", "0");
    const code = await runGateway(command, ctx);
    expect(code).toBe(0);
    expect(capture.value?.options.runtime).toBe(runtime);
  });
});

function fakePgConnection(
  handler: (sql: string, params: readonly unknown[] | undefined) => PgQueryResult,
): {
  conn: PgConnection;
  captured: Array<{ sql: string; params: readonly unknown[] | undefined }>;
} {
  const captured: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  const conn: PgConnection = {
    query: async <T>(sql: string, params?: readonly unknown[]) => {
      captured.push({ sql, params });
      return handler(sql, params) as PgQueryResult<T>;
    },
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn),
    withAdvisoryLock: async <T>(_lockKey: bigint, fn: () => Promise<T>) => fn(),
    close: async () => undefined,
  };
  return { conn, captured };
}

describe("runGateway prune-idempotency (M4.12)", () => {
  const fixedNow = new Date("2026-05-26T12:00:00.000Z");

  it("default mode calls deleteExpired + prints deletion count in human format", async () => {
    const { conn, captured } = fakePgConnection(() => ({ rows: [], rowCount: 17 }));
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      idempotencyStoreOverride: new PostgresIdempotencyStore(conn),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(parseGatewayArgs("prune-idempotency"), ctx);
    expect(code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toContain("DELETE FROM");
    expect(captured[0]?.sql).toContain("expires_at < $1");
    expect(captured[0]?.params?.[0]).toBe(fixedNow.toISOString());
    expect(outChunks.join("")).toContain("deleted 17 expired idempotency record");
    expect(outChunks.join("")).toContain(fixedNow.toISOString());
  });

  it("--dry-run mode calls previewDeleteExpired + does NOT delete", async () => {
    const { conn, captured } = fakePgConnection(() => ({
      rows: [{ count: "42" }],
      rowCount: 1,
    }));
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      idempotencyStoreOverride: new PostgresIdempotencyStore(conn),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(parseGatewayArgs("prune-idempotency", "--dry-run"), ctx);
    expect(code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toContain("SELECT COUNT(*)");
    expect(captured[0]?.sql).not.toContain("DELETE");
    expect(outChunks.join("")).toContain(
      "42 expired idempotency record(s) would be deleted (dry-run",
    );
  });

  it("JSON envelope on deletion includes action + dryRun:false + asOf + deletedCount", async () => {
    const { conn } = fakePgConnection(() => ({ rows: [], rowCount: 5 }));
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      idempotencyStoreOverride: new PostgresIdempotencyStore(conn),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(parseGatewayArgs("prune-idempotency", "--format", "json"), ctx);
    expect(code).toBe(0);
    const env = JSON.parse(outChunks.join("")) as Record<string, unknown>;
    expect(env).toMatchObject({
      action: "gateway.prune-idempotency",
      dryRun: false,
      asOf: fixedNow.toISOString(),
      deletedCount: 5,
    });
  });

  it("JSON envelope on dry-run uses wouldDeleteCount + dryRun:true", async () => {
    const { conn } = fakePgConnection(() => ({ rows: [{ count: "0" }], rowCount: 1 }));
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      idempotencyStoreOverride: new PostgresIdempotencyStore(conn),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(
      parseGatewayArgs("prune-idempotency", "--dry-run", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(outChunks.join("")) as Record<string, unknown>;
    expect(env).toMatchObject({
      action: "gateway.prune-idempotency",
      dryRun: true,
      asOf: fixedNow.toISOString(),
      wouldDeleteCount: 0,
    });
    expect(env).not.toHaveProperty("deletedCount");
  });

  it("propagates adapter errors as exit 1 with a clear message", async () => {
    const conn: PgConnection = {
      query: async () => {
        throw new Error("PG connection refused");
      },
      transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn),
      withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>) => fn(),
      close: async () => undefined,
    };
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      idempotencyStoreOverride: new PostgresIdempotencyStore(conn),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(parseGatewayArgs("prune-idempotency"), ctx);
    expect(code).toBe(1);
    expect(errChunks.join("")).toContain("PG connection refused");
  });

  it("exits 1 with PG-missing error when no override + no PG env", async () => {
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = { io, env: {} };
    const code = await runGateway(parseGatewayArgs("prune-idempotency"), ctx);
    expect(code).toBe(1);
    expect(errChunks.join("")).toMatch(/PG env/);
  });
});

describe("runGateway prune-idempotency scope flags (M4.13)", () => {
  const fixedNow = new Date("2026-05-26T12:00:00.000Z");

  it("threads --operation-id through to deleteExpired + echoes the scope in human output", async () => {
    const { conn, captured } = fakePgConnection(() => ({ rows: [], rowCount: 3 }));
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      idempotencyStoreOverride: new PostgresIdempotencyStore(conn),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(
      parseGatewayArgs("prune-idempotency", "--operation-id", "tenants.create"),
      ctx,
    );
    expect(code).toBe(0);
    expect(captured[0]?.sql).toContain("AND operation_id = $2");
    expect(captured[0]?.params?.[1]).toBe("tenants.create");
    const stdout = outChunks.join("");
    expect(stdout).toContain("deleted 3 expired idempotency record(s)");
    expect(stdout).toContain("operationId=tenants.create");
  });

  it("threads --method through to deleteExpired", async () => {
    const { conn, captured } = fakePgConnection(() => ({ rows: [], rowCount: 7 }));
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      idempotencyStoreOverride: new PostgresIdempotencyStore(conn),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(parseGatewayArgs("prune-idempotency", "--method", "POST"), ctx);
    expect(code).toBe(0);
    expect(captured[0]?.sql).toContain("AND method = $2");
    expect(captured[0]?.params?.[1]).toBe("POST");
    expect(outChunks.join("")).toContain("method=POST");
  });

  it("rejects --method with an invalid HTTP verb (exit 2, no PG call)", async () => {
    const { conn, captured } = fakePgConnection(() => ({ rows: [], rowCount: 0 }));
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      idempotencyStoreOverride: new PostgresIdempotencyStore(conn),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(parseGatewayArgs("prune-idempotency", "--method", "GET"), ctx);
    expect(code).toBe(2);
    expect(captured).toHaveLength(0);
    expect(errChunks.join("")).toMatch(/--method must be one of POST, PUT, PATCH, DELETE/);
  });

  it("threads --limit as a positive integer + uses the LIMIT subquery SQL shape", async () => {
    const { conn, captured } = fakePgConnection(() => ({ rows: [], rowCount: 100 }));
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      idempotencyStoreOverride: new PostgresIdempotencyStore(conn),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(parseGatewayArgs("prune-idempotency", "--limit", "100"), ctx);
    expect(code).toBe(0);
    expect(captured[0]?.sql).toContain("LIMIT $2");
    expect(captured[0]?.params?.[1]).toBe(100);
    expect(outChunks.join("")).toContain("limit=100");
  });

  it("rejects --limit when not a positive integer (exit 2, no PG call)", async () => {
    const { conn, captured } = fakePgConnection(() => ({ rows: [], rowCount: 0 }));
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      idempotencyStoreOverride: new PostgresIdempotencyStore(conn),
      clockOverride: () => fixedNow,
    };
    const codeZero = await runGateway(parseGatewayArgs("prune-idempotency", "--limit", "0"), ctx);
    expect(codeZero).toBe(2);
    const codeNaN = await runGateway(
      parseGatewayArgs("prune-idempotency", "--limit", "not-a-number"),
      ctx,
    );
    expect(codeNaN).toBe(2);
    const codeFloat = await runGateway(
      parseGatewayArgs("prune-idempotency", "--limit", "1.5"),
      ctx,
    );
    expect(codeFloat).toBe(2);
    expect(captured).toHaveLength(0);
    expect(errChunks.join("")).toMatch(/--limit must be a positive integer/);
  });

  it("combines all three scope flags through deleteExpired with bind order now, op, method, limit", async () => {
    const { conn, captured } = fakePgConnection(() => ({ rows: [], rowCount: 50 }));
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      idempotencyStoreOverride: new PostgresIdempotencyStore(conn),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(
      parseGatewayArgs(
        "prune-idempotency",
        "--operation-id",
        "orders.create",
        "--method",
        "POST",
        "--limit",
        "50",
      ),
      ctx,
    );
    expect(code).toBe(0);
    expect(captured[0]?.params).toEqual([fixedNow.toISOString(), "orders.create", "POST", 50]);
    const stdout = outChunks.join("");
    expect(stdout).toContain("operationId=orders.create");
    expect(stdout).toContain("method=POST");
    expect(stdout).toContain("limit=50");
  });

  it("JSON envelope echoes operationId / method / limit (null when not set)", async () => {
    const { conn } = fakePgConnection(() => ({ rows: [], rowCount: 5 }));
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      idempotencyStoreOverride: new PostgresIdempotencyStore(conn),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(
      parseGatewayArgs("prune-idempotency", "--operation-id", "tenants.create", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(outChunks.join("")) as Record<string, unknown>;
    expect(env).toMatchObject({
      action: "gateway.prune-idempotency",
      dryRun: false,
      deletedCount: 5,
      operationId: "tenants.create",
      method: null,
      limit: null,
    });
  });

  it("dry-run JSON envelope echoes scope and uses wouldDeleteCount", async () => {
    const { conn } = fakePgConnection(() => ({ rows: [{ count: "12" }], rowCount: 1 }));
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      idempotencyStoreOverride: new PostgresIdempotencyStore(conn),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(
      parseGatewayArgs(
        "prune-idempotency",
        "--dry-run",
        "--method",
        "PATCH",
        "--limit",
        "12",
        "--format",
        "json",
      ),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(outChunks.join("")) as Record<string, unknown>;
    expect(env).toMatchObject({
      action: "gateway.prune-idempotency",
      dryRun: true,
      wouldDeleteCount: 12,
      operationId: null,
      method: "PATCH",
      limit: 12,
    });
  });
});
