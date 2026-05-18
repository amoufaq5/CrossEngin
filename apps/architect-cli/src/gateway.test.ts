import {
  GatewayRuntime,
  InMemoryIdempotencyStore,
  InMemoryPrincipalResolver,
  InMemoryRateLimitChecker,
  InMemoryRouteRegistry,
  type HandleResult,
} from "@crossengin/api-gateway-runtime";
import { describe, expect, it } from "vitest";

import { parseArgs } from "./cli.js";
import type { IoStreams } from "./format.js";
import { buildDefaultGatewayHandlers } from "./gateway-handlers.js";
import {
  runGateway,
  type GatewayContext,
} from "./gateway.js";
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
  const factory: typeof import("./gateway-server.js").startGatewayServer = async (
    options,
  ) => {
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
    const command = parseGatewayArgs(
      "start",
      "--in-memory",
      "--port",
      "0",
      "--format",
      "json",
    );
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
