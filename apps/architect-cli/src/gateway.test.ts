import { PostgresIdempotencyStore } from "@crossengin/api-gateway-pg";
import {
  GatewayRuntime,
  InMemoryIdempotencyStore,
  InMemoryPrincipalResolver,
  InMemoryRateLimitChecker,
  InMemoryRouteRegistry,
  type HandleResult,
} from "@crossengin/api-gateway-runtime";
import type { PgConnection, PgQueryResult, PostgresTraceRetention } from "@crossengin/kernel-pg";
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

describe("runGateway housekeeping (M4.14)", () => {
  const fixedNow = new Date("2026-05-29T12:00:00.000Z");

  // The housekeeping action calls 3 sources per table:
  // - retention.listPolicies() once for retention-governed tables
  // - retention.previewPrune() once for would-prune count on retention tables
  // - idempotencyStore.previewDeleteExpired() for the idempotency table
  // - direct SELECT COUNT(*) / MIN(time_col) on each of the 3 tables
  // A dispatching mock connection wraps all the SELECTs.
  function fakeStatsConnection(
    perTable: Record<string, { total: string; oldest: string | null }>,
  ): PgConnection {
    return {
      query: async <T>(sql: string, _params?: readonly unknown[]) => {
        for (const [name, stats] of Object.entries(perTable)) {
          if (sql.includes(`FROM meta.${name}`)) {
            return { rows: [stats], rowCount: 1 } as unknown as PgQueryResult<T>;
          }
        }
        return { rows: [], rowCount: 0 } as unknown as PgQueryResult<T>;
      },
      transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => fn({} as PgConnection),
      withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>) => fn(),
      close: async () => undefined,
    };
  }

  function fakeRetention(): PostgresTraceRetention {
    return {
      listPolicies: async () => [
        {
          tableName: "gateway_pipeline_executions",
          retentionDays: 30,
          enabled: true,
          lastPrunedAt: "2026-05-28T00:00:00.000Z",
        },
        {
          tableName: "rate_limit_decisions",
          retentionDays: 7,
          enabled: true,
          lastPrunedAt: null,
        },
      ],
      previewPrune: async () => [
        {
          tableName: "gateway_pipeline_executions",
          status: "previewed",
          retentionDays: 30,
          wouldDeleteCount: 1042,
          cutoffMs: 0,
        },
        {
          tableName: "rate_limit_decisions",
          status: "previewed",
          retentionDays: 7,
          wouldDeleteCount: 9876,
          cutoffMs: 0,
        },
      ],
    } as unknown as PostgresTraceRetention;
  }

  function fakeIdempotencyStore(wouldDelete: number): PostgresIdempotencyStore {
    return {
      previewDeleteExpired: async () => wouldDelete,
    } as unknown as PostgresIdempotencyStore;
  }

  it("default mode renders the three-table dashboard in human format", async () => {
    const conn = fakeStatsConnection({
      gateway_pipeline_executions: {
        total: "50000",
        oldest: "2026-04-01T00:00:00.000Z",
      },
      gateway_idempotency_records: {
        total: "1200",
        oldest: "2026-05-25T00:00:00.000Z",
      },
      rate_limit_decisions: {
        total: "987654",
        oldest: "2026-03-15T00:00:00.000Z",
      },
    });
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotencyStore(300),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(parseGatewayArgs("housekeeping"), ctx);
    expect(code).toBe(0);
    const stdout = outChunks.join("");
    expect(stdout).toContain(`gateway housekeeping (as of ${fixedNow.toISOString()})`);
    expect(stdout).toContain("gateway_pipeline_executions");
    expect(stdout).toContain("gateway_idempotency_records");
    expect(stdout).toContain("rate_limit_decisions");
    // Total counts are locale-formatted with commas.
    expect(stdout).toContain("50,000");
    expect(stdout).toContain("987,654");
    // wouldPrune counts surface for each table.
    expect(stdout).toContain("1,042");
    expect(stdout).toContain("9,876");
    expect(stdout).toContain("300");
    // Retention-governed tables show retention days + lastPrunedAt.
    expect(stdout).toContain("30 day(s)");
    expect(stdout).toContain("7 day(s)");
    expect(stdout).toContain("2026-05-28T00:00:00.000Z");
    expect(stdout).toContain("never");
    // The idempotency-records section uses expires_at semantic — no retention
    // policy line.
    expect(stdout).toContain("semantic:       expires_at");
    expect(stdout).toContain("semantic:       retention_days");
  });

  it("JSON envelope includes asOf + tables[] with all three tables", async () => {
    const conn = fakeStatsConnection({
      gateway_pipeline_executions: { total: "100", oldest: null },
      gateway_idempotency_records: { total: "0", oldest: null },
      rate_limit_decisions: { total: "5", oldest: "2026-05-01T00:00:00.000Z" },
    });
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotencyStore(0),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(parseGatewayArgs("housekeeping", "--format", "json"), ctx);
    expect(code).toBe(0);
    const env = JSON.parse(outChunks.join("")) as {
      action: string;
      asOf: string;
      tables: Array<{
        tableName: string;
        pruneSemantic: string;
        totalRowCount: number;
        oldestAt: string | null;
        wouldPruneCount: number;
        retentionDays: number | null;
        lastPrunedAt: string | null;
      }>;
    };
    expect(env.action).toBe("gateway.housekeeping");
    expect(env.asOf).toBe(fixedNow.toISOString());
    expect(env.tables).toHaveLength(3);
    const byName = new Map(env.tables.map((t) => [t.tableName, t]));
    const pipe = byName.get("gateway_pipeline_executions")!;
    expect(pipe.pruneSemantic).toBe("retention_days");
    expect(pipe.totalRowCount).toBe(100);
    expect(pipe.retentionDays).toBe(30);
    expect(pipe.lastPrunedAt).toBe("2026-05-28T00:00:00.000Z");
    expect(pipe.wouldPruneCount).toBe(1042);
    const idem = byName.get("gateway_idempotency_records")!;
    expect(idem.pruneSemantic).toBe("expires_at");
    expect(idem.totalRowCount).toBe(0);
    expect(idem.oldestAt).toBeNull();
    expect(idem.retentionDays).toBeNull();
    expect(idem.lastPrunedAt).toBeNull();
    expect(idem.wouldPruneCount).toBe(0);
    const rl = byName.get("rate_limit_decisions")!;
    expect(rl.pruneSemantic).toBe("retention_days");
    expect(rl.retentionDays).toBe(7);
    expect(rl.lastPrunedAt).toBeNull();
  });

  it("renders '(empty)' for tables with zero rows + null oldest, and '(no platform policy configured)' for missing retention", async () => {
    const conn = fakeStatsConnection({
      gateway_pipeline_executions: { total: "0", oldest: null },
      gateway_idempotency_records: { total: "0", oldest: null },
      rate_limit_decisions: { total: "0", oldest: null },
    });
    const noPoliciesRetention = {
      listPolicies: async () => [],
      previewPrune: async () => [],
    } as unknown as PostgresTraceRetention;
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: noPoliciesRetention,
      idempotencyStoreOverride: fakeIdempotencyStore(0),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(parseGatewayArgs("housekeeping"), ctx);
    expect(code).toBe(0);
    const stdout = outChunks.join("");
    expect(stdout).toContain("(empty)");
    expect(stdout).toContain("(no platform policy configured)");
  });

  it("propagates adapter errors as exit 1 with a clear message", async () => {
    const throwingConn: PgConnection = {
      query: async () => {
        throw new Error('relation "meta.gateway_pipeline_executions" does not exist');
      },
      transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(throwingConn),
      withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>) => fn(),
      close: async () => undefined,
    };
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: throwingConn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotencyStore(0),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(parseGatewayArgs("housekeeping"), ctx);
    expect(code).toBe(1);
    expect(errChunks.join("")).toContain("does not exist");
  });

  it("exits 1 with PG-missing error when no PG env and no override", async () => {
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = { io, env: {} };
    const code = await runGateway(parseGatewayArgs("housekeeping"), ctx);
    expect(code).toBe(1);
    expect(errChunks.join("")).toMatch(/PG env/);
  });

  it("dispatcher includes housekeeping in the unknown-action error message", async () => {
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = { io, env: {} };
    const code = await runGateway(parseGatewayArgs("nuke"), ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/housekeeping/);
  });
});

describe("runGateway housekeeping --watch (M4.14.w)", () => {
  const fixedNow = new Date("2026-05-29T12:00:00.000Z");

  // Test-only setTimeout that fires synchronously so watch loops drain
  // instantly. Production uses real setTimeout.
  const immediateSetTimeout = (cb: () => void, _ms: number) => {
    cb();
    return 1 as unknown;
  };

  function fixtures() {
    const conn = fakePgConnection(() => ({
      rows: [{ total: "0", oldest: null }],
      rowCount: 1,
    }));
    const retention = {
      listPolicies: async () => [],
      previewPrune: async () => [],
    } as unknown as PostgresTraceRetention;
    const idempotencyStore = {
      previewDeleteExpired: async () => 0,
    } as unknown as PostgresIdempotencyStore;
    return { conn: conn.conn, retention, idempotencyStore };
  }

  it("loops N times when --watch + watchOverride.maxIterations is set", async () => {
    const { io, outChunks } = makeIo();
    const { conn, retention, idempotencyStore } = fixtures();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 3, setTimeoutFn: immediateSetTimeout },
    };
    const code = await runGateway(parseGatewayArgs("housekeeping", "--watch"), ctx);
    expect(code).toBe(0);
    const stdout = outChunks.join("");
    const headerMatches = stdout.match(/gateway housekeeping \(as of /g);
    expect(headerMatches).not.toBeNull();
    expect(headerMatches!.length).toBe(3);
    expect(stdout).toContain("\x1b[2J\x1b[H");
  });

  it("--watch with --format json streams NDJSON-of-envelopes", async () => {
    const { io, outChunks } = makeIo();
    const { conn, retention, idempotencyStore } = fixtures();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 2, setTimeoutFn: immediateSetTimeout },
    };
    const code = await runGateway(
      parseGatewayArgs("housekeeping", "--watch", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = outChunks.join("").trim().split("\n");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const env = JSON.parse(line) as { action: string };
      expect(env.action).toBe("gateway.housekeeping");
    }
    expect(outChunks.join("")).not.toContain("\x1b[2J");
  });

  it("--watch-interval threads custom interval", async () => {
    const { io, outChunks } = makeIo();
    const { conn, retention, idempotencyStore } = fixtures();
    const delays: number[] = [];
    const fakeSetTimeout = (cb: () => void, ms: number) => {
      delays.push(ms);
      cb();
      return 1 as unknown;
    };
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 3, setTimeoutFn: fakeSetTimeout },
    };
    const code = await runGateway(
      parseGatewayArgs("housekeeping", "--watch", "--watch-interval", "15"),
      ctx,
    );
    expect(code).toBe(0);
    expect(outChunks.join("").match(/gateway housekeeping \(as of /g)!.length).toBe(3);
    expect(delays).toEqual([15000, 15000]);
  });

  it("--watch-interval requires --watch (exit 2)", async () => {
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = { io, env: {} };
    const code = await runGateway(parseGatewayArgs("housekeeping", "--watch-interval", "10"), ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toContain("--watch-interval requires --watch");
  });

  it("--watch-interval rejects invalid values (exit 2)", async () => {
    for (const bad of ["0", "3601", "abc", "1.5"]) {
      const { io, errChunks } = makeIo();
      const ctx: GatewayContext = { io, env: {} };
      const code = await runGateway(
        parseGatewayArgs("housekeeping", "--watch", "--watch-interval", bad),
        ctx,
      );
      expect(code).toBe(2);
      expect(errChunks.join("")).toContain("invalid --watch-interval");
    }
  });

  it("--watch rejects --format csv/tsv/ndjson/yaml", async () => {
    for (const fmt of ["csv", "tsv", "ndjson", "yaml"]) {
      const { io, errChunks } = makeIo();
      const ctx: GatewayContext = { io, env: {} };
      const code = await runGateway(
        parseGatewayArgs("housekeeping", "--watch", "--format", fmt),
        ctx,
      );
      expect(code).toBe(2);
      expect(errChunks.join("")).toContain("--watch requires --format human or json");
    }
  });

  it("--watch with abortSignal cancels the loop", async () => {
    const { io, outChunks } = makeIo();
    const { conn, retention, idempotencyStore } = fixtures();
    const controller = new AbortController();
    let tickCount = 0;
    const fakeSetTimeout = (cb: () => void, _ms: number) => {
      tickCount++;
      if (tickCount === 1) controller.abort();
      cb();
      return 1 as unknown;
    };
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
      watchOverride: {
        maxIterations: 5,
        abortSignal: controller.signal,
        setTimeoutFn: fakeSetTimeout,
      },
    };
    const code = await runGateway(parseGatewayArgs("housekeeping", "--watch"), ctx);
    expect(code).toBe(0);
    expect(outChunks.join("").match(/gateway housekeeping \(as of /g)!.length).toBe(1);
  });

  it("--watch propagates gather errors as exit 1", async () => {
    const { io, errChunks } = makeIo();
    const { conn, idempotencyStore } = fixtures();
    const throwingRetention = {
      listPolicies: async () => {
        throw new Error('relation "meta.retention_policies" does not exist');
      },
      previewPrune: async () => [],
    } as unknown as PostgresTraceRetention;
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: throwingRetention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 5, setTimeoutFn: immediateSetTimeout },
    };
    const code = await runGateway(parseGatewayArgs("housekeeping", "--watch"), ctx);
    expect(code).toBe(1);
    expect(errChunks.join("")).toContain("does not exist");
  });
});

describe("runGateway housekeeping --threshold-alert (M4.14.t)", () => {
  const fixedNow = new Date("2026-05-29T12:00:00.000Z");

  function trippingFixtures() {
    const conn = fakePgConnection(() => ({
      rows: [{ total: "5000000", oldest: "2026-04-01T00:00:00.000Z" }],
      rowCount: 1,
    }));
    const retention = {
      listPolicies: async () => [
        {
          tableName: "gateway_pipeline_executions",
          retentionDays: 30,
          enabled: true,
          // 5d ago.
          lastPrunedAt: new Date(fixedNow.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
      previewPrune: async () => [
        {
          tableName: "gateway_pipeline_executions",
          status: "previewed" as const,
          wouldDeleteCount: 2_000_000,
          retentionDays: 30,
          cutoffMs: 0,
        },
      ],
    } as unknown as PostgresTraceRetention;
    const idempotencyStore = {
      previewDeleteExpired: async () => 0,
    } as unknown as PostgresIdempotencyStore;
    return { conn: conn.conn, retention, idempotencyStore };
  }

  it("exits 0 when no alert trips", async () => {
    const { io, outChunks } = makeIo();
    const { conn, retention, idempotencyStore } = trippingFixtures();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(
      parseGatewayArgs("housekeeping", "--threshold-alert", "wouldPruneCount:>10000000"),
      ctx,
    );
    expect(code).toBe(0);
    expect(outChunks.join("")).not.toContain("THRESHOLD ALERTS");
  });

  it("exits 3 + prints THRESHOLD ALERTS section on a tripping numeric alert", async () => {
    const { io, outChunks } = makeIo();
    const { conn, retention, idempotencyStore } = trippingFixtures();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(
      parseGatewayArgs("housekeeping", "--threshold-alert", "wouldPruneCount:>1000000"),
      ctx,
    );
    expect(code).toBe(3);
    expect(outChunks.join("")).toContain("THRESHOLD ALERTS");
    expect(outChunks.join("")).toContain("gateway_pipeline_executions wouldPruneCount=2,000,000");
  });

  it("exits 3 on duration alert (lastPrunedAt:>24h with 5-day-old policy)", async () => {
    const { io, outChunks } = makeIo();
    const { conn, retention, idempotencyStore } = trippingFixtures();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(
      parseGatewayArgs("housekeeping", "--threshold-alert", "lastPrunedAt:>24h"),
      ctx,
    );
    expect(code).toBe(3);
    expect(outChunks.join("")).toContain("THRESHOLD ALERTS");
    expect(outChunks.join("")).toContain("age 5.0d");
  });

  it("exits 2 on invalid alert syntax (no PG call needed)", async () => {
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = { io, env: {} };
    const code = await runGateway(
      parseGatewayArgs("housekeeping", "--threshold-alert", "badSyntax"),
      ctx,
    );
    expect(code).toBe(2);
    expect(errChunks.join("")).toContain("invalid threshold alert");
  });

  it("exits 2 on unknown field (with helpful suggestion list)", async () => {
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = { io, env: {} };
    const code = await runGateway(
      parseGatewayArgs("housekeeping", "--threshold-alert", "ghostField:>1"),
      ctx,
    );
    expect(code).toBe(2);
    expect(errChunks.join("")).toContain("unknown field");
    expect(errChunks.join("")).toContain("totalRowCount");
  });

  it("JSON envelope embeds tripped alert details on hit", async () => {
    const { io, outChunks } = makeIo();
    const { conn, retention, idempotencyStore } = trippingFixtures();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(
      parseGatewayArgs(
        "housekeeping",
        "--format",
        "json",
        "--threshold-alert",
        "wouldPruneCount:>1000000",
      ),
      ctx,
    );
    expect(code).toBe(3);
    const env = JSON.parse(outChunks.join("")) as {
      alerts: Array<{ tableName: string; actual: number }>;
    };
    expect(env.alerts.length).toBeGreaterThanOrEqual(1);
    const wpcHit = env.alerts.find((a) => a.tableName === "gateway_pipeline_executions");
    expect(wpcHit?.actual).toBe(2_000_000);
  });

  it("composes with --watch — first tripped tick exits 3", async () => {
    const { io, outChunks } = makeIo();
    const { conn, retention, idempotencyStore } = trippingFixtures();
    let tickCount = 0;
    const immediateSetTimeout = (cb: () => void, _ms: number) => {
      tickCount++;
      cb();
      return 1 as unknown;
    };
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
      watchOverride: {
        maxIterations: 5,
        setTimeoutFn: immediateSetTimeout,
      },
    };
    const code = await runGateway(
      parseGatewayArgs("housekeeping", "--watch", "--threshold-alert", "wouldPruneCount:>1000000"),
      ctx,
    );
    expect(code).toBe(3);
    expect(tickCount).toBe(0); // exited before any setTimeout was scheduled
    expect(outChunks.join("")).toContain("THRESHOLD ALERTS");
  });
});

describe("runGateway housekeeping --watch-keep-going (M4.14.s)", () => {
  const fixedNow = new Date("2026-05-29T12:00:00.000Z");

  const immediateSetTimeout = (cb: () => void, _ms: number) => {
    cb();
    return 1 as unknown;
  };

  function cleanFixtures() {
    const conn = fakePgConnection(() => ({
      rows: [{ total: "0", oldest: null }],
      rowCount: 1,
    }));
    const retention = {
      listPolicies: async () => [],
      previewPrune: async () => [],
    } as unknown as PostgresTraceRetention;
    const idempotencyStore = {
      previewDeleteExpired: async () => 0,
    } as unknown as PostgresIdempotencyStore;
    return { conn: conn.conn, retention, idempotencyStore };
  }

  it("--watch-keep-going requires --watch (exit 2 otherwise)", async () => {
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = { io, env: {} };
    const code = await runGateway(parseGatewayArgs("housekeeping", "--watch-keep-going"), ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toContain("--watch-keep-going requires --watch");
  });

  it("exits 0 when N ticks complete cleanly", async () => {
    const { io, outChunks } = makeIo();
    const { conn, retention, idempotencyStore } = cleanFixtures();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 3, setTimeoutFn: immediateSetTimeout },
    };
    const code = await runGateway(
      parseGatewayArgs("housekeeping", "--watch", "--watch-keep-going"),
      ctx,
    );
    expect(code).toBe(0);
    expect(outChunks.join("").match(/gateway housekeeping \(as of /g)!.length).toBe(3);
  });

  it("catches gather errors + renders them + continues (exit 0 if no trip)", async () => {
    const { io, outChunks } = makeIo();
    const { conn, idempotencyStore } = cleanFixtures();
    let callCount = 0;
    const flakyRetention = {
      listPolicies: async () => {
        callCount++;
        if (callCount === 2) throw new Error("PG connection lost");
        return [];
      },
      previewPrune: async () => [],
    } as unknown as PostgresTraceRetention;
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: flakyRetention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 3, setTimeoutFn: immediateSetTimeout },
    };
    const code = await runGateway(
      parseGatewayArgs("housekeeping", "--watch", "--watch-keep-going"),
      ctx,
    );
    expect(code).toBe(0);
    expect(outChunks.join("")).toContain("error this tick: PG connection lost");
  });

  it("WITHOUT --watch-keep-going, errors still propagate exit 1", async () => {
    const { io, errChunks } = makeIo();
    const { conn, idempotencyStore } = cleanFixtures();
    const throwingRetention = {
      listPolicies: async () => {
        throw new Error("boom");
      },
      previewPrune: async () => [],
    } as unknown as PostgresTraceRetention;
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: throwingRetention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 5, setTimeoutFn: immediateSetTimeout },
    };
    const code = await runGateway(parseGatewayArgs("housekeeping", "--watch"), ctx);
    expect(code).toBe(1);
    expect(errChunks.join("")).toContain("boom");
  });

  it("threshold alert under keep-going loops through all ticks + exits 3 (sticky)", async () => {
    const { io, outChunks } = makeIo();
    const trippyConn = fakePgConnection(() => ({
      rows: [{ total: "5000000", oldest: null }],
      rowCount: 1,
    }));
    const retention = {
      listPolicies: async () => [],
      previewPrune: async () => [
        {
          tableName: "gateway_pipeline_executions",
          status: "previewed" as const,
          wouldDeleteCount: 2_000_000,
          retentionDays: 30,
          cutoffMs: 0,
        },
      ],
    } as unknown as PostgresTraceRetention;
    const idempotencyStore = {
      previewDeleteExpired: async () => 0,
    } as unknown as PostgresIdempotencyStore;
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: trippyConn.conn,
      retentionOverride: retention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 3, setTimeoutFn: immediateSetTimeout },
    };
    const code = await runGateway(
      parseGatewayArgs(
        "housekeeping",
        "--watch",
        "--watch-keep-going",
        "--threshold-alert",
        "wouldPruneCount:>1000000",
      ),
      ctx,
    );
    expect(code).toBe(3);
    // All 3 ticks should render the alert.
    const sections = outChunks.join("").match(/THRESHOLD ALERTS/g);
    expect(sections!.length).toBe(3);
  });

  it("under keep-going + json, error tick emits compact NDJSON error envelope", async () => {
    const { io, outChunks } = makeIo();
    const { conn, idempotencyStore } = cleanFixtures();
    let callCount = 0;
    const flakyRetention = {
      listPolicies: async () => {
        callCount++;
        if (callCount === 1) throw new Error("transient PG glitch");
        return [];
      },
      previewPrune: async () => [],
    } as unknown as PostgresTraceRetention;
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: flakyRetention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 2, setTimeoutFn: immediateSetTimeout },
    };
    const code = await runGateway(
      parseGatewayArgs("housekeeping", "--watch", "--watch-keep-going", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = outChunks.join("").trim().split("\n");
    expect(lines.length).toBe(2);
    const env1 = JSON.parse(lines[0]!) as { error?: { message: string } };
    expect(env1.error?.message).toBe("transient PG glitch");
  });
});

describe("runGateway housekeeping --watch SIGINT bridge (M4.14.r)", () => {
  const fixedNow = new Date("2026-05-29T12:00:00.000Z");

  function fixtures() {
    const conn = fakePgConnection(() => ({
      rows: [{ total: "0", oldest: null }],
      rowCount: 1,
    }));
    const retention = {
      listPolicies: async () => [],
      previewPrune: async () => [],
    } as unknown as PostgresTraceRetention;
    const idempotencyStore = {
      previewDeleteExpired: async () => 0,
    } as unknown as PostgresIdempotencyStore;
    return { conn: conn.conn, retention, idempotencyStore };
  }

  // M4.14.r captured SIGINT only; M4.14.p extends the bridge to register
  // BOTH SIGINT and SIGTERM under a shared AbortController. The capture
  // tracks each signal's handler separately so tests can assert both are
  // registered + verify per-signal abort semantics.
  function captureSignalRegistrar() {
    const captured: { handlers: Map<string, () => void> } = { handlers: new Map() };
    const removeCalls: { count: number; signals: string[] } = { count: 0, signals: [] };
    const registrar = (signal: string, handler: () => void): (() => void) => {
      captured.handlers.set(signal, handler);
      return () => {
        removeCalls.count++;
        removeCalls.signals.push(signal);
      };
    };
    return { registrar, captured, removeCalls };
  }

  it("installs the shutdown bridge under --watch + cleans up on natural exit (both signals)", async () => {
    const { io } = makeIo();
    const { conn, retention, idempotencyStore } = fixtures();
    const { registrar, captured, removeCalls } = captureSignalRegistrar();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
      watchOverride: {
        maxIterations: 1,
        setTimeoutFn: (cb: () => void) => {
          cb();
          return 1 as unknown;
        },
        signalRegistrar: registrar,
      },
    };
    const code = await runGateway(parseGatewayArgs("housekeeping", "--watch"), ctx);
    expect(code).toBe(0);
    // M4.14.p — both SIGINT and SIGTERM handlers registered + both removed.
    expect(captured.handlers.has("SIGINT")).toBe(true);
    expect(captured.handlers.has("SIGTERM")).toBe(true);
    expect(removeCalls.count).toBe(2);
    expect(removeCalls.signals.sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("firing the captured SIGINT handler aborts the loop cleanly (exit 0)", async () => {
    const { io, outChunks } = makeIo();
    const { conn, retention, idempotencyStore } = fixtures();
    const { registrar, captured } = captureSignalRegistrar();
    let tickCount = 0;
    const setTimeoutFiringSigint = (cb: () => void, _ms: number) => {
      tickCount++;
      const sigintHandler = captured.handlers.get("SIGINT");
      if (tickCount === 1 && sigintHandler !== undefined) sigintHandler();
      cb();
      return 1 as unknown;
    };
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
      watchOverride: {
        maxIterations: 10,
        setTimeoutFn: setTimeoutFiringSigint,
        signalRegistrar: registrar,
      },
    };
    const code = await runGateway(parseGatewayArgs("housekeeping", "--watch"), ctx);
    expect(code).toBe(0);
    expect(outChunks.join("").match(/gateway housekeeping \(as of /g)!.length).toBe(1);
  });

  it("does NOT install the bridge when abortSignal override is supplied (neither signal registered)", async () => {
    const { io } = makeIo();
    const { conn, retention, idempotencyStore } = fixtures();
    const { registrar, captured, removeCalls } = captureSignalRegistrar();
    const controller = new AbortController();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
      watchOverride: {
        maxIterations: 1,
        setTimeoutFn: (cb: () => void) => {
          cb();
          return 1 as unknown;
        },
        abortSignal: controller.signal,
        signalRegistrar: registrar,
      },
    };
    const code = await runGateway(parseGatewayArgs("housekeeping", "--watch"), ctx);
    expect(code).toBe(0);
    expect(captured.handlers.size).toBe(0);
    expect(removeCalls.count).toBe(0);
  });

  // M4.14.p — Kubernetes / systemd / container-manager graceful shutdown
  // typically sends SIGTERM (not SIGINT). The bridge handles both
  // uniformly: SIGTERM-triggered abort exits cleanly with the same
  // semantic as SIGINT (PG closed via finally, sticky-trip exit codes
  // preserved). This block exercises the SIGTERM path in isolation.

  it("M4.14.p — firing the captured SIGTERM handler aborts the loop cleanly (Kubernetes shutdown)", async () => {
    const { io, outChunks } = makeIo();
    const { conn, retention, idempotencyStore } = fixtures();
    const { registrar, captured } = captureSignalRegistrar();
    let tickCount = 0;
    const setTimeoutFiringSigterm = (cb: () => void, _ms: number) => {
      tickCount++;
      const sigtermHandler = captured.handlers.get("SIGTERM");
      if (tickCount === 1 && sigtermHandler !== undefined) sigtermHandler();
      cb();
      return 1 as unknown;
    };
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
      idempotencyStoreOverride: idempotencyStore,
      clockOverride: () => fixedNow,
      watchOverride: {
        maxIterations: 10,
        setTimeoutFn: setTimeoutFiringSigterm,
        signalRegistrar: registrar,
      },
    };
    const code = await runGateway(parseGatewayArgs("housekeeping", "--watch"), ctx);
    expect(code).toBe(0);
    // Exactly one tick rendered before the SIGTERM handler aborted.
    expect(outChunks.join("").match(/gateway housekeeping \(as of /g)!.length).toBe(1);
  });
});

describe("runGateway housekeeping --tenant (M4.14.v)", () => {
  const fixedNow = new Date("2026-05-29T12:00:00.000Z");
  const TENANT_A = "11111111-2222-3333-4444-555555555555";
  const TENANT_B = "66666666-7777-8888-9999-aaaaaaaaaaaa";

  function fakeStatsConnection(): PgConnection {
    return {
      query: async <T>(sql: string, _params?: readonly unknown[]) => {
        if (sql.includes("FROM meta.gateway_pipeline_executions")) {
          return {
            rows: [{ total: "50000", oldest: "2026-04-01T00:00:00.000Z" }],
            rowCount: 1,
          } as unknown as PgQueryResult<T>;
        }
        if (sql.includes("FROM meta.gateway_idempotency_records")) {
          return {
            rows: [{ total: "1200", oldest: "2026-05-25T00:00:00.000Z" }],
            rowCount: 1,
          } as unknown as PgQueryResult<T>;
        }
        if (sql.includes("FROM meta.rate_limit_decisions")) {
          return {
            rows: [{ total: "987654", oldest: "2026-03-15T00:00:00.000Z" }],
            rowCount: 1,
          } as unknown as PgQueryResult<T>;
        }
        return { rows: [], rowCount: 0 } as unknown as PgQueryResult<T>;
      },
      transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => fn({} as PgConnection),
      withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>) => fn(),
      close: async () => undefined,
    };
  }

  function fakeRetention(): PostgresTraceRetention {
    return {
      listPolicies: async () => [
        {
          tableName: "gateway_pipeline_executions",
          retentionDays: 30,
          enabled: true,
          lastPrunedAt: "2026-05-28T00:00:00.000Z",
        },
        {
          tableName: "rate_limit_decisions",
          retentionDays: 7,
          enabled: true,
          lastPrunedAt: null,
        },
      ],
      listTenantPolicies: async () => [
        // TENANT_A has a custom 365-day retention override on
        // gateway_pipeline_executions (legal-hold scenario), no override on
        // rate_limit_decisions (inherits 7-day platform default).
        {
          tenantId: TENANT_A,
          tableName: "gateway_pipeline_executions",
          retentionDays: 365,
          enabled: true,
          optOut: false,
          optOutReason: null,
          optOutUntil: null,
          lastPrunedAt: null,
        },
        // TENANT_B has an active opt-out on rate_limit_decisions for an
        // ongoing investigation; no override on gateway_pipeline_executions.
        {
          tenantId: TENANT_B,
          tableName: "rate_limit_decisions",
          retentionDays: 7,
          enabled: false,
          optOut: true,
          optOutReason: "investigation:case#42",
          optOutUntil: "2099-01-01T00:00:00.000Z",
          lastPrunedAt: null,
        },
      ],
      previewPrune: async () => [
        {
          tableName: "gateway_pipeline_executions",
          status: "previewed",
          retentionDays: 30,
          wouldDeleteCount: 1042,
          cutoffMs: 0,
        },
        {
          tableName: "rate_limit_decisions",
          status: "previewed",
          retentionDays: 7,
          wouldDeleteCount: 9876,
          cutoffMs: 0,
        },
      ],
    } as unknown as PostgresTraceRetention;
  }

  function fakeIdempotencyStore(wouldDelete: number): PostgresIdempotencyStore {
    return {
      previewDeleteExpired: async () => wouldDelete,
    } as unknown as PostgresIdempotencyStore;
  }

  it("invalid --tenant value exits 2 BEFORE PG resolution", async () => {
    const conn = fakeStatsConnection();
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotencyStore(0),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(parseGatewayArgs("housekeeping", "--tenant", "not-a-uuid"), ctx);
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/must be a UUID/);
  });

  it("valid --tenant surfaces per-table tenantPolicy in human output (with override + without)", async () => {
    const conn = fakeStatsConnection();
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotencyStore(300),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(parseGatewayArgs("housekeeping", "--tenant", TENANT_A), ctx);
    expect(code).toBe(0);
    const stdout = outChunks.join("");
    expect(stdout).toContain(`filtered to tenant ${TENANT_A}`);
    // gateway_pipeline_executions: TENANT_A has 365-day override.
    expect(stdout).toContain("365 day(s) (enabled)");
    // rate_limit_decisions: no override for TENANT_A → inherits platform.
    expect(stdout).toContain("(no override — inherits platform default)");
    // gateway_idempotency_records: expires_at-managed → not applicable.
    expect(stdout).toContain("(not applicable — expires_at-managed)");
  });

  it("filter discriminates between tenants — TENANT_A and TENANT_B see different tenantPolicy fields", async () => {
    const conn = fakeStatsConnection();
    const { io: ioA, outChunks: outA } = makeIo();
    const ctxA: GatewayContext = {
      io: ioA,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotencyStore(0),
      clockOverride: () => fixedNow,
      // M4.14.v doesn't compose with --watch in this fixture, so no
      // watchOverride needed; single-shot covers the filter discrimination.
    };
    const codeA = await runGateway(
      parseGatewayArgs("housekeeping", "--tenant", TENANT_A, "--format", "json"),
      ctxA,
    );
    expect(codeA).toBe(0);
    const envA = JSON.parse(outA.join("")) as {
      tenantId: string;
      tables: Array<{ tableName: string; tenantPolicy: { retentionDays: number } | null }>;
    };
    expect(envA.tenantId).toBe(TENANT_A);
    const pipeA = envA.tables.find((t) => t.tableName === "gateway_pipeline_executions")!;
    expect(pipeA.tenantPolicy).not.toBeNull();
    expect(pipeA.tenantPolicy!.retentionDays).toBe(365);
    const rlA = envA.tables.find((t) => t.tableName === "rate_limit_decisions")!;
    expect(rlA.tenantPolicy).toBeNull();

    const { io: ioB, outChunks: outB } = makeIo();
    const ctxB: GatewayContext = {
      io: ioB,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotencyStore(0),
      clockOverride: () => fixedNow,
    };
    const codeB = await runGateway(
      parseGatewayArgs("housekeeping", "--tenant", TENANT_B, "--format", "json"),
      ctxB,
    );
    expect(codeB).toBe(0);
    const envB = JSON.parse(outB.join("")) as {
      tenantId: string;
      tables: Array<{
        tableName: string;
        tenantPolicy: { retentionDays: number; optOut: boolean; optOutReason: string } | null;
      }>;
    };
    expect(envB.tenantId).toBe(TENANT_B);
    const pipeB = envB.tables.find((t) => t.tableName === "gateway_pipeline_executions")!;
    expect(pipeB.tenantPolicy).toBeNull();
    const rlB = envB.tables.find((t) => t.tableName === "rate_limit_decisions")!;
    expect(rlB.tenantPolicy).not.toBeNull();
    expect(rlB.tenantPolicy!.optOut).toBe(true);
    expect(rlB.tenantPolicy!.optOutReason).toBe("investigation:case#42");
  });

  it("JSON envelope includes tenantFilter + tenantPolicy on every table (with null for non-overridden)", async () => {
    const conn = fakeStatsConnection();
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotencyStore(0),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(
      parseGatewayArgs("housekeeping", "--tenant", TENANT_A, "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(outChunks.join("")) as {
      action: string;
      tenantId: string;
      tables: Array<{ tableName: string; tenantPolicy: unknown }>;
    };
    expect(env.action).toBe("gateway.housekeeping");
    expect(env.tenantId).toBe(TENANT_A);
    // tenantPolicy is set on ALL three tables under --tenant (null on
    // expires_at table reflects "(not applicable)" semantic + null on
    // retention tables reflects "no override on this table").
    for (const t of env.tables) {
      expect("tenantPolicy" in t).toBe(true);
    }
    expect(
      env.tables.find((t) => t.tableName === "gateway_idempotency_records")!.tenantPolicy,
    ).toBeNull();
  });

  it("omitting --tenant preserves backward-compat envelope shape verbatim (no tenantId, no tenantPolicy)", async () => {
    const conn = fakeStatsConnection();
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotencyStore(0),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(parseGatewayArgs("housekeeping", "--format", "json"), ctx);
    expect(code).toBe(0);
    const env = JSON.parse(outChunks.join("")) as {
      tenantId?: string;
      tables: Array<{ tableName: string; tenantPolicy?: unknown }>;
    };
    expect(env.tenantId).toBeUndefined();
    for (const t of env.tables) {
      expect("tenantPolicy" in t).toBe(false);
    }
  });

  it("composes with --threshold-alert — drill-down preserves CI-gate semantic (exit 3 on trip)", async () => {
    const conn = fakeStatsConnection();
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotencyStore(0),
      clockOverride: () => fixedNow,
    };
    // totalRowCount on rate_limit_decisions = 987,654 — alert trips at >1M
    // is FALSE (the table is below the threshold). Use > 500k so it trips.
    const code = await runGateway(
      parseGatewayArgs(
        "housekeeping",
        "--tenant",
        TENANT_A,
        "--threshold-alert",
        "totalRowCount:>500000",
      ),
      ctx,
    );
    expect(code).toBe(3);
    const stdout = outChunks.join("");
    expect(stdout).toContain("THRESHOLD ALERTS");
    expect(stdout).toContain(`filtered to tenant ${TENANT_A}`);
  });
});

describe("runGateway housekeeping --all-tenants (M4.14.q)", () => {
  const fixedNow = new Date("2026-05-29T12:00:00.000Z");
  const TENANT_A = "00000000-0000-4000-8000-00000000000a";
  const TENANT_B = "00000000-0000-4000-8000-00000000000b";

  function fakeStatsConnection(): PgConnection {
    return {
      query: async <T>(sql: string, _params?: readonly unknown[]) => {
        if (sql.includes("FROM meta.gateway_pipeline_executions")) {
          return {
            rows: [{ total: "50000", oldest: "2026-04-01T00:00:00.000Z" }],
            rowCount: 1,
          } as unknown as PgQueryResult<T>;
        }
        if (sql.includes("FROM meta.gateway_idempotency_records")) {
          return {
            rows: [{ total: "1200", oldest: "2026-05-25T00:00:00.000Z" }],
            rowCount: 1,
          } as unknown as PgQueryResult<T>;
        }
        if (sql.includes("FROM meta.rate_limit_decisions")) {
          return {
            rows: [{ total: "987654", oldest: "2026-03-15T00:00:00.000Z" }],
            rowCount: 1,
          } as unknown as PgQueryResult<T>;
        }
        return { rows: [], rowCount: 0 } as unknown as PgQueryResult<T>;
      },
      transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => fn({} as PgConnection),
      withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>) => fn(),
      close: async () => undefined,
    };
  }

  function fakeRetention(): PostgresTraceRetention {
    return {
      listPolicies: async () => [
        {
          tableName: "gateway_pipeline_executions",
          retentionDays: 30,
          enabled: true,
          lastPrunedAt: "2026-05-28T00:00:00.000Z",
        },
        { tableName: "rate_limit_decisions", retentionDays: 7, enabled: true, lastPrunedAt: null },
      ],
      // Unsorted input verifies sort-by-tenantId for stable output.
      listTenantPolicies: async () => [
        {
          tenantId: TENANT_B,
          tableName: "gateway_pipeline_executions",
          retentionDays: 60,
          enabled: true,
          optOut: false,
          optOutReason: null,
          optOutUntil: null,
          lastPrunedAt: null,
        },
        {
          tenantId: TENANT_A,
          tableName: "gateway_pipeline_executions",
          retentionDays: 365,
          enabled: true,
          optOut: false,
          optOutReason: null,
          optOutUntil: null,
          lastPrunedAt: null,
        },
        {
          tenantId: TENANT_A,
          tableName: "rate_limit_decisions",
          retentionDays: 7,
          enabled: false,
          optOut: true,
          optOutReason: "investigation:case#42",
          optOutUntil: "2099-01-01T00:00:00.000Z",
          lastPrunedAt: null,
        },
      ],
      previewPrune: async () => [
        {
          tableName: "gateway_pipeline_executions",
          status: "previewed",
          retentionDays: 30,
          wouldDeleteCount: 1042,
          cutoffMs: 0,
        },
        {
          tableName: "rate_limit_decisions",
          status: "previewed",
          retentionDays: 7,
          wouldDeleteCount: 9876,
          cutoffMs: 0,
        },
      ],
    } as unknown as PostgresTraceRetention;
  }

  function fakeIdempotencyStore(wouldDelete: number): PostgresIdempotencyStore {
    return {
      previewDeleteExpired: async () => wouldDelete,
    } as unknown as PostgresIdempotencyStore;
  }

  it("exits 2 when --tenant and --all-tenants are both set (mutual exclusivity)", async () => {
    const conn = fakeStatsConnection();
    const { io, errChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotencyStore(0),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(
      parseGatewayArgs("housekeeping", "--tenant", TENANT_A, "--all-tenants"),
      ctx,
    );
    expect(code).toBe(2);
    expect(errChunks.join("")).toMatch(/mutually exclusive/);
  });

  it("renders per-table matrix block sorted by tenantId in human output", async () => {
    const conn = fakeStatsConnection();
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotencyStore(0),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(parseGatewayArgs("housekeeping", "--all-tenants"), ctx);
    expect(code).toBe(0);
    const stdout = outChunks.join("");
    expect(stdout).toContain("matrix mode — all tenants");
    // gateway_pipeline_executions has 2 overrides, sorted A → B.
    expect(stdout).toMatch(
      new RegExp(
        `gateway_pipeline_executions[\\s\\S]*?matrix \\(2\\):[\\s\\S]*?${TENANT_A}[\\s\\S]*?${TENANT_B}`,
      ),
    );
    // rate_limit_decisions has 1 override (TENANT_A opt-out).
    expect(stdout).toMatch(
      /rate_limit_decisions[\s\S]*?matrix \(1\):[\s\S]*?opt-out=yes \(until 2099-01-01T00:00:00\.000Z/,
    );
    // Idempotency table marks "(not applicable)" — per-tenant overrides
    // don't exist on the TTL surface.
    expect(stdout).toMatch(
      /gateway_idempotency_records[\s\S]*?matrix:\s+\(not applicable — expires_at-managed\)/,
    );
  });

  it("JSON envelope includes allTenants:true + every table has tenantOverrides[] (empty array on idempotency)", async () => {
    const conn = fakeStatsConnection();
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotencyStore(0),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(
      parseGatewayArgs("housekeeping", "--all-tenants", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(outChunks.join("")) as {
      action: string;
      allTenants: boolean;
      tenantId?: string;
      tables: Array<{ tableName: string; tenantOverrides: Array<{ tenantId: string }> }>;
    };
    expect(env.action).toBe("gateway.housekeeping");
    expect(env.allTenants).toBe(true);
    expect(env.tenantId).toBeUndefined();
    const pipe = env.tables.find((t) => t.tableName === "gateway_pipeline_executions")!;
    expect(pipe.tenantOverrides).toHaveLength(2);
    expect(pipe.tenantOverrides[0]!.tenantId).toBe(TENANT_A);
    expect(pipe.tenantOverrides[1]!.tenantId).toBe(TENANT_B);
    // Idempotency table — empty array reflects "(not applicable)".
    const idem = env.tables.find((t) => t.tableName === "gateway_idempotency_records")!;
    expect(idem.tenantOverrides).toEqual([]);
  });

  it("omitting --all-tenants preserves backward-compat envelope shape (no tenantOverrides field)", async () => {
    const conn = fakeStatsConnection();
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotencyStore(0),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(parseGatewayArgs("housekeeping", "--format", "json"), ctx);
    expect(code).toBe(0);
    const env = JSON.parse(outChunks.join("")) as {
      allTenants?: boolean;
      tables: Array<{ tableName: string; tenantOverrides?: unknown }>;
    };
    expect(env.allTenants).toBeUndefined();
    for (const t of env.tables) {
      expect("tenantOverrides" in t).toBe(false);
    }
  });

  it("composes with --threshold-alert — drill-down preserves CI-gate semantic (exit 3 on trip)", async () => {
    const conn = fakeStatsConnection();
    const { io, outChunks } = makeIo();
    const ctx: GatewayContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotencyStore(0),
      clockOverride: () => fixedNow,
    };
    const code = await runGateway(
      parseGatewayArgs(
        "housekeeping",
        "--all-tenants",
        "--threshold-alert",
        "totalRowCount:>500000",
      ),
      ctx,
    );
    expect(code).toBe(3);
    const stdout = outChunks.join("");
    expect(stdout).toContain("THRESHOLD ALERTS");
    expect(stdout).toContain("matrix mode — all tenants");
  });
});
