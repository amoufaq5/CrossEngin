import { request as nodeRequest } from "node:http";
import { Readable } from "node:stream";

import {
  GatewayRuntime,
  InMemoryIdempotencyStore,
  InMemoryPrincipalResolver,
  InMemoryRateLimitChecker,
  InMemoryRouteRegistry,
} from "@crossengin/api-gateway-runtime";
import { describe, expect, it } from "vitest";

import { buildDefaultGatewayHandlers } from "./gateway-handlers.js";
import {
  buildIncomingFromNode,
  generateRequestId,
  readBody,
  startGatewayServer,
} from "./gateway-server.js";

function makeFakeNodeReq(opts: {
  method?: string;
  url?: string;
  headers?: NodeJS.Dict<string | string[]>;
  remoteAddress?: string;
  encrypted?: boolean;
}): import("node:http").IncomingMessage {
  const base: Record<string, unknown> = {
    url: opts.url ?? "/",
    headers: opts.headers ?? {},
    socket: {
      remoteAddress: opts.remoteAddress ?? "203.0.113.7",
      ...(opts.encrypted !== undefined ? { encrypted: opts.encrypted } : {}),
    },
  };
  if ("method" in opts) {
    base["method"] = opts.method;
  } else {
    base["method"] = "GET";
  }
  return base as unknown as import("node:http").IncomingMessage;
}

describe("generateRequestId", () => {
  it("produces a req_<24-hex> shape that satisfies the gateway regex", () => {
    const id = generateRequestId();
    expect(id).toMatch(/^req_[a-f0-9]{24}$/);
  });

  it("generates unique ids across calls", () => {
    const a = generateRequestId();
    const b = generateRequestId();
    expect(a).not.toBe(b);
  });
});

describe("buildIncomingFromNode", () => {
  it("translates a basic GET into a valid IncomingRequest", () => {
    const req = makeFakeNodeReq({
      method: "GET",
      url: "/__ping?trace=1",
      headers: { host: "example.com", "user-agent": "vitest" },
    });
    const incoming = buildIncomingFromNode({
      req,
      bodyBytes: null,
      requestId: "req_abc12345",
      receivedAtIso: "2026-05-18T12:00:00.000Z",
    });
    expect(incoming).not.toBeNull();
    expect(incoming?.method).toBe("GET");
    expect(incoming?.path).toBe("/__ping");
    expect(incoming?.host).toBe("example.com");
    expect(incoming?.scheme).toBe("http");
    expect(incoming?.query).toEqual({ trace: "1" });
    expect(incoming?.userAgent).toBe("vitest");
    expect(incoming?.bodyBytes).toBe(0);
    expect(incoming?.bodySha256).toBeNull();
  });

  it("returns null when method is missing", () => {
    const req = makeFakeNodeReq({ method: undefined as unknown as string });
    expect(
      buildIncomingFromNode({
        req,
        bodyBytes: null,
        requestId: "req_abc12345",
        receivedAtIso: "2026-05-18T12:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("returns null for unsupported methods", () => {
    const req = makeFakeNodeReq({ method: "BREW" });
    expect(
      buildIncomingFromNode({
        req,
        bodyBytes: null,
        requestId: "req_abc12345",
        receivedAtIso: "2026-05-18T12:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("marks scheme=https when the socket is encrypted", () => {
    const req = makeFakeNodeReq({
      method: "GET",
      url: "/__ping",
      headers: { host: "example.com" },
      encrypted: true,
    });
    const incoming = buildIncomingFromNode({
      req,
      bodyBytes: null,
      requestId: "req_abc12345",
      receivedAtIso: "2026-05-18T12:00:00.000Z",
    });
    expect(incoming?.scheme).toBe("https");
  });

  it("treats repeated query params as arrays", () => {
    const req = makeFakeNodeReq({
      method: "GET",
      url: "/__ping?tag=a&tag=b",
      headers: { host: "example.com" },
    });
    const incoming = buildIncomingFromNode({
      req,
      bodyBytes: null,
      requestId: "req_abc12345",
      receivedAtIso: "2026-05-18T12:00:00.000Z",
    });
    expect(incoming?.query).toEqual({ tag: ["a", "b"] });
  });

  it("drops headers whose names do not match the gateway header regex", () => {
    const req = makeFakeNodeReq({
      method: "GET",
      url: "/__ping",
      headers: { host: "example.com", ":illegal:": "x" },
    });
    const incoming = buildIncomingFromNode({
      req,
      bodyBytes: null,
      requestId: "req_abc12345",
      receivedAtIso: "2026-05-18T12:00:00.000Z",
    });
    expect(incoming?.headers["host"]).toBe("example.com");
    expect(incoming?.headers[":illegal:"]).toBeUndefined();
  });
});

describe("readBody", () => {
  it("returns null when there is no data", async () => {
    const req = Readable.from([]) as unknown as import("node:http").IncomingMessage;
    const bytes = await readBody(req, 1024);
    expect(bytes).toBeNull();
  });

  it("returns the concatenated bytes for non-empty bodies", async () => {
    const req = Readable.from([
      Buffer.from("hello "),
      Buffer.from("world"),
    ]) as unknown as import("node:http").IncomingMessage;
    const bytes = await readBody(req, 1024);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe("hello world");
  });

  it("rejects when the body exceeds maxBytes", async () => {
    const req = Readable.from([Buffer.alloc(10)]) as unknown as import("node:http").IncomingMessage;
    await expect(readBody(req, 5)).rejects.toThrow(/exceeds 5 bytes/);
  });
});

describe("startGatewayServer integration", () => {
  function buildRuntime() {
    const startedAt = new Date();
    const { handlers, routes } = buildDefaultGatewayHandlers({
      mode: "in_memory",
      startedAt,
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

  function curl(host: string, port: number, path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = nodeRequest({ host, port, path, method: "GET" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("serves GET /__ping with 200 + ok body", async () => {
    const runtime = buildRuntime();
    const server = await startGatewayServer({ runtime, port: 0 });
    try {
      const reply = await curl(server.host, server.port, "/__ping");
      expect(reply.status).toBe(200);
      const body = JSON.parse(reply.body) as { status: string; at: string };
      expect(body.status).toBe("ok");
      expect(body.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await server.close();
    }
  });

  it("returns 404 for an unknown route", async () => {
    const runtime = buildRuntime();
    const server = await startGatewayServer({ runtime, port: 0 });
    try {
      const reply = await curl(server.host, server.port, "/nope");
      expect(reply.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("invokes onRequest with method + path + status for every request", async () => {
    const runtime = buildRuntime();
    const entries: Array<{ status: number; path: string; method: string }> = [];
    const server = await startGatewayServer({
      runtime,
      port: 0,
      onRequest: (e) => entries.push({ status: e.status, path: e.path, method: e.method }),
    });
    try {
      await curl(server.host, server.port, "/__ping");
      await curl(server.host, server.port, "/__health");
    } finally {
      await server.close();
    }
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ status: 200, path: "/__ping", method: "GET" });
    expect(entries[1]).toEqual({ status: 200, path: "/__health", method: "GET" });
  });

  it("forwards executions to the executionSink when one is supplied", async () => {
    const runtime = buildRuntime();
    const recorded: string[] = [];
    const server = await startGatewayServer({
      runtime,
      port: 0,
      executionSink: {
        record: async (e) => {
          recorded.push(e.requestId);
        },
      },
    });
    try {
      await curl(server.host, server.port, "/__ping");
    } finally {
      await server.close();
    }
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatch(/^req_/);
  });

  it("calls beforeHandle before each request", async () => {
    const runtime = buildRuntime();
    let calls = 0;
    const server = await startGatewayServer({
      runtime,
      port: 0,
      beforeHandle: async () => {
        calls += 1;
      },
    });
    try {
      await curl(server.host, server.port, "/__ping");
      await curl(server.host, server.port, "/__health");
    } finally {
      await server.close();
    }
    expect(calls).toBe(2);
  });
});
