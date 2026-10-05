import { request as httpRequest } from "node:http";
import { InMemoryEntityStore } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import { parseServeArgs } from "./cli.js";
import { loadBuiltinPack } from "./manifest-source.js";
import { parseApiKeySpec } from "./principals.js";
import { buildOperateHttpServer } from "./server.js";
import { auditEmitterAvailable, createNodeRequestListener, serve, type NodeReqLike, type NodeResLike } from "./node.js";

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

  it("applies a per-route override, bounding the read before dispatch", async () => {
    // ADR-0331. The default is deliberately tiny here, which is the posture the feature exists to
    // enable: one platform-wide number has to be the largest legitimate body in the deployment,
    // and that figure then applies to every cheap endpoint.
    const listener = createNodeRequestListener(httpServer(), 2048, [
      { prefix: "/v1/products", bytes: 1024 * 1024 },
    ]);
    const res = mockRes();
    const body = new TextEncoder().encode(
      JSON.stringify({ sku: "S1", name: "A".repeat(4000), unit_price: 2, unit_cost: 1, status: "active", category: "grocery" }),
    );
    await listener(
      mockReq({
        method: "POST",
        url: "/v1/products",
        headers: { "x-api-key": "key-manager", "content-type": "application/json" },
        body,
      }),
      res,
    );
    // Over the 2 KiB default, under the route's 1 MiB — so it is read, not refused.
    expect(body.byteLength).toBeGreaterThan(2048);
    expect(res.status).not.toBe(413);
  });

  it("still refuses a route the override does not cover", async () => {
    // The other half: an override must not loosen anything it did not name.
    const listener = createNodeRequestListener(httpServer(), 2048, [
      { prefix: "/v1/products", bytes: 1024 * 1024 },
    ]);
    const res = mockRes();
    const chunk = new Uint8Array(4096);
    await listener(
      mockReq({
        method: "POST",
        url: "/v1/orders",
        headers: { "x-api-key": "key-manager", "content-type": "application/json" },
        body: chunk,
      }),
      res,
    );
    expect(res.status).toBe(413);
  });

  it("cannot have its limit widened by a query string", async () => {
    // The matcher cuts the query before matching, so appending one cannot select another route's
    // allowance — nor make a non-matching path match.
    const listener = createNodeRequestListener(httpServer(), 2048, [
      { prefix: "/v1/products", bytes: 1024 * 1024 },
    ]);
    const res = mockRes();
    await listener(
      mockReq({
        method: "POST",
        url: "/v1/orders?x=/v1/products",
        headers: { "x-api-key": "key-manager", "content-type": "application/json" },
        body: new Uint8Array(4096),
      }),
      res,
    );
    expect(res.status).toBe(413);
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
    } finally {
      await running.close();
    }
  });
});

describe("auditEmitterAvailable", () => {
  /**
   * The flags whose features write an audit row. Kept as a list only to assert that **none of them
   * matters any more** (ADR-0327).
   *
   * `needsAuditEmitter` used to enumerate these and answer false for anything missing, and the
   * enumeration was wrong three times. The third time got through a per-flag test exactly like the
   * one below: `--deletion-escalation-config` was in the test's list and **absent from the
   * predicate**, and the test still passed because the parser turns `--deletion-request-routes` on
   * alongside it. A hand-maintained list cannot catch a flag missing from both copies of itself.
   */
  const AUDIT_WRITING_ARGS: ReadonlyArray<readonly string[]> = [
    ["--ai-design"],
    ["--per-tenant-manifests"],
    ["--design-review"],
    ["--audit-read-routes"],
    ["--tenant-erasure-routes"],
    ["--tenant-deletion-routes"],
    ["--deletion-request-routes"],
    ["--deletion-runner-ms", "60000"],
    ["--deletion-escalation-config", "/tmp/deletion-escalation.json"],
    ["--integrity-proof-config", "/tmp/proof.json"],
  ];

  const base = ["--pack", "erp-retail", "--port", "0", "--store", "pg"];

  it("is true for a Postgres server with no audit-writing feature at all", () => {
    // The whole change: an emitter exists because there is a database to write to, not because
    // somebody remembered to add a flag to a list.
    expect(auditEmitterAvailable(parseServeArgs(base))).toBe(true);
  });

  it("is true for each audit-writing flag, by construction rather than by enumeration", () => {
    for (const args of AUDIT_WRITING_ARGS) {
      expect(auditEmitterAvailable(parseServeArgs([...base, ...args])), args.join(" ")).toBe(true);
    }
  });

  it("is false without a Postgres store, which is the only condition that was ever real", () => {
    const memory = ["--pack", "erp-retail", "--port", "0"];
    expect(auditEmitterAvailable(parseServeArgs(memory))).toBe(false);
    // And the CLI refuses the combination outright rather than leaving it to this predicate — a
    // stronger guarantee than the gate ever gave, and the reason the gate had nothing left to do.
    expect(() => parseServeArgs([...memory, "--audit-read-routes"])).toThrow(/require a Postgres/);
  });

  it("does not depend on any flag, so a feature added tomorrow cannot omit itself", () => {
    // Every flag combination answers the same thing: the store decides. This is the assertion the
    // old per-flag loop could not make, and the reason the list above is now evidence rather than
    // a gate.
    const all = AUDIT_WRITING_ARGS.flatMap((a) => [...a]);
    expect(auditEmitterAvailable(parseServeArgs([...base, ...all]))).toBe(
      auditEmitterAvailable(parseServeArgs(base)),
    );
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
