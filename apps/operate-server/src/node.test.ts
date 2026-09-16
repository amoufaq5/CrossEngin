import { request as httpRequest } from "node:http";
import { InMemoryEntityStore } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import { parseServeArgs } from "./cli.js";
import { loadBuiltinPack } from "./manifest-source.js";
import { parseApiKeySpec } from "./principals.js";
import { buildOperateHttpServer } from "./server.js";
import { createNodeRequestListener, serve, type NodeReqLike, type NodeResLike } from "./node.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const manifest = await loadBuiltinPack("erp-retail");

function httpServer() {
  return buildOperateHttpServer({
    manifest,
    store: new InMemoryEntityStore(),
    apiKeys: [parseApiKeySpec(`key-manager:store_manager:${TENANT}`)],
    now: () => new Date("2026-06-03T12:00:00.000Z"),
  }).httpServer;
}

function mockReq(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | null;
}): NodeReqLike {
  const chunks = opts.body ? [opts.body] : [];
  return {
    method: opts.method,
    url: opts.url,
    headers: opts.headers ?? {},
    socket: { remoteAddress: "203.0.113.1" },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function mockRes(): NodeResLike & { status: number; headers: Record<string, string>; body: Uint8Array | null } {
  return {
    status: 0,
    headers: {},
    body: null,
    writeHead(status: number, headers?: Record<string, string>) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(chunk?: Uint8Array) {
      this.body = chunk ?? null;
    },
  };
}

describe("createNodeRequestListener", () => {
  it("throttles a socket peer before reading a body or verifying a credential", async () => {
    const scopes: string[] = [];
    const listener = createNodeRequestListener(
      { dispatch: async () => { throw new Error("must not dispatch"); } },
      {
        preAuthLimiter: {
          async checkScope(scope) {
            scopes.push(scope);
            return { allowed: false, retryAfterSeconds: 17 };
          },
        },
      },
    );
    const req: NodeReqLike = {
      ...mockReq({ method: "POST", url: "/v1/products", headers: { "x-forwarded-for": "198.51.100.99" } }),
      async *[Symbol.asyncIterator]() { throw new Error("body must not be read"); },
    };
    const res = mockRes();
    await listener(req, res);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("17");
    expect(scopes).toEqual(["203.0.113.1"]);
  });

  it("serves unauthenticated liveness and readiness probes without gateway dispatch", async () => {
    let dispatches = 0;
    let readinessChecks = 0;
    const listener = createNodeRequestListener(
      {
        dispatch: async () => {
          dispatches += 1;
          throw new Error("must not dispatch");
        },
      },
      {
        readiness: async () => {
          readinessChecks += 1;
          return true;
        },
      },
    );

    const live = mockRes();
    await listener(mockReq({ method: "GET", url: "/healthz" }), live);
    expect(live.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(live.body ?? new Uint8Array()))).toEqual({ status: "ok" });

    const ready = mockRes();
    await listener(mockReq({ method: "HEAD", url: "/readyz?from=orchestrator" }), ready);
    expect(ready.status).toBe(200);
    expect(ready.body).toBeNull();
    expect(readinessChecks).toBe(1);
    expect(dispatches).toBe(0);
  });

  it("returns a non-sensitive 503 when the readiness dependency fails", async () => {
    const errors: unknown[] = [];
    const listener = createNodeRequestListener(httpServer(), {
      readiness: async () => {
        throw new Error("postgres password=secret");
      },
      onError: error => errors.push(error),
    });
    const res = mockRes();

    await listener(mockReq({ method: "GET", url: "/readyz" }), res);

    expect(res.status).toBe(503);
    const text = new TextDecoder().decode(res.body ?? new Uint8Array());
    expect(text).toContain("unavailable");
    expect(text).not.toContain("password");
    expect(errors).toHaveLength(1);
  });

  it("does not expose internal dispatch errors in a 500 response", async () => {
    const errors: unknown[] = [];
    const listener = createNodeRequestListener(
      {
        dispatch: async () => {
          throw new Error("relation private_payroll does not exist");
        },
      },
      { onError: error => errors.push(error) },
    );
    const res = mockRes();

    await listener(mockReq({ method: "GET", url: "/v1/private" }), res);

    expect(res.status).toBe(500);
    const text = new TextDecoder().decode(res.body ?? new Uint8Array());
    expect(text).toContain("Request processing failed");
    expect(text).not.toContain("private_payroll");
    expect(errors).toHaveLength(1);
  });

  it("serves a GET through the Node glue", async () => {
    const listener = createNodeRequestListener(httpServer());
    const res = mockRes();
    await listener(mockReq({ method: "GET", url: "/v1/products", headers: { "x-api-key": "key-manager" } }), res);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(new TextDecoder().decode(res.body ?? new Uint8Array())) as { data: unknown[] };
    expect(Array.isArray(parsed.data)).toBe(true);
  });

  it("rejects a body over MAX_REQUEST_BODY_BYTES with 413 before dispatch", async () => {
    const listener = createNodeRequestListener(httpServer());
    const res = mockRes();
    const megabyte = new Uint8Array(1024 * 1024);
    const req: NodeReqLike = {
      method: "POST",
      url: "/v1/products",
      headers: { "x-api-key": "key-manager", "content-type": "application/json" },
      socket: { remoteAddress: "203.0.113.1" },
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 11; i++) yield megabyte;
      },
    };
    await listener(req, res);
    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toBe("application/problem+json");
    const parsed = JSON.parse(new TextDecoder().decode(res.body ?? new Uint8Array())) as { status: number };
    expect(parsed.status).toBe(413);
  });

  it("collects a POST body and creates a record", async () => {
    const listener = createNodeRequestListener(httpServer());
    const res = mockRes();
    const body = new TextEncoder().encode(JSON.stringify({ sku: "S1", name: "A", unit_price: 2, unit_cost: 1, status: "active", category: "grocery" }));
    await listener(
      mockReq({
        method: "POST",
        url: "/v1/products",
        headers: { "x-api-key": "key-manager", "content-type": "application/json" },
        body,
      }),
      res,
    );
    expect(res.status).toBe(201);
  });
});

describe("serve — real loopback boot", () => {
  it("boots a listening server and answers a request", async () => {
    const running = await serve(
      parseServeArgs(["--pack", "erp-retail", "--port", "0", "--api-key", `key-manager:store_manager:${TENANT}`]),
    );
    try {
      const status = await get(running.port, "/v1/products", "key-manager");
      expect(status).toBe(200);
      expect(await get(running.port, "/readyz", "")).toBe(200);
    } finally {
      await Promise.all([running.close(), running.close()]);
    }
  });
});

// Local helper for the loopback test -----------------------------------------

function get(port: number, path: string, apiKey: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { "x-api-key": apiKey } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
