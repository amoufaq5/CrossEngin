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
  it("serves a GET through the Node glue", async () => {
    const listener = createNodeRequestListener(httpServer());
    const res = mockRes();
    await listener(mockReq({ method: "GET", url: "/v1/products", headers: { "x-api-key": "key-manager" } }), res);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(new TextDecoder().decode(res.body ?? new Uint8Array())) as { data: unknown[] };
    expect(Array.isArray(parsed.data)).toBe(true);
  });

  it("collects a POST body and creates a record", async () => {
    const listener = createNodeRequestListener(httpServer());
    const res = mockRes();
    const body = new TextEncoder().encode(JSON.stringify({ sku: "S1", name: "A", status: "active", category: "g" }));
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
    } finally {
      await running.close();
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
