import { describe, expect, it } from "vitest";

import { asModuleWorker, buildEdgeFetchHandler, fetchToRaw } from "./edge.js";
import { RequestBodyTooLargeError } from "./request-body-limit.js";
import { loadBuiltinPack } from "./manifest-source.js";
import { parseApiKeySpec } from "./principals.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const manifest = await loadBuiltinPack("erp-retail");

function handler() {
  return buildEdgeFetchHandler({
    manifest,
    apiKeys: [
      parseApiKeySpec(`key-cashier:cashier:${TENANT}`),
      parseApiKeySpec(`key-manager:store_manager:${TENANT}`),
    ],
    now: () => new Date("2026-06-03T12:00:00.000Z"),
  }).fetch;
}

const PRODUCT = { sku: "SKU-1", name: "Milk", unit_price: 2, unit_cost: 1.1, status: "active", category: "grocery" };

function getReq(path: string, key: string): Request {
  return new Request(`https://api.example.com${path}`, { method: "GET", headers: { "x-api-key": key } });
}

function postReq(path: string, key: string, body: unknown): Request {
  return new Request(`https://api.example.com${path}`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("fetchToRaw", () => {
  it("maps method, url, headers, and the client IP from cf-connecting-ip", async () => {
    const request = new Request("https://api.example.com/v1/products?limit=5", {
      method: "GET",
      headers: { "x-api-key": "k", "cf-connecting-ip": "203.0.113.9" },
    });
    const { raw, body } = await fetchToRaw(request);
    expect(raw.method).toBe("GET");
    expect(raw.url).toContain("/v1/products?limit=5");
    expect(raw.headers["x-api-key"]).toBe("k");
    expect(raw.remoteAddress).toBe("203.0.113.9");
    expect(body).toBeNull();
  });

  it("reads a POST body into bytes", async () => {
    const { body } = await fetchToRaw(postReq("/v1/products", "k", { a: 1 }));
    expect(body).not.toBeNull();
    expect(JSON.parse(new TextDecoder().decode(body!))).toEqual({ a: 1 });
  });

  it("applies a per-route override, parsing the path out of an absolute URL", async () => {
    // ADR-0331, and the step the Node path does not need: `request.url` here is absolute, so a
    // prefix like `/v1/products` would never match it directly.
    const body = new Uint8Array(4096).fill(0x61);
    const request = new Request("https://api.example.com/v1/products", {
      method: "POST",
      headers: { "x-api-key": "k", "content-type": "application/json" },
      body,
    });
    const out = await fetchToRaw(request, 2048, [{ prefix: "/v1/products", bytes: 1024 * 1024 }]);
    expect(out.body?.byteLength).toBe(4096);
  });

  it("does not let an override loosen a route it did not name", async () => {
    const request = new Request("https://api.example.com/v1/orders", {
      method: "POST",
      headers: { "x-api-key": "k", "content-type": "application/json" },
      body: new Uint8Array(4096),
    });
    await expect(
      fetchToRaw(request, 2048, [{ prefix: "/v1/products", bytes: 1024 * 1024 }]),
    ).rejects.toThrow(/too large|exceeds|limit/i);
  });

  it("cannot have its limit widened by a query string", async () => {
    // The path comes from a URL parse, so a query cannot smuggle another route's prefix in.
    const request = new Request("https://api.example.com/v1/orders?x=/v1/products", {
      method: "POST",
      headers: { "x-api-key": "k", "content-type": "application/json" },
      body: new Uint8Array(4096),
    });
    await expect(
      fetchToRaw(request, 2048, [{ prefix: "/v1/products", bytes: 1024 * 1024 }]),
    ).rejects.toThrow(/too large|exceeds|limit/i);
  });

  it("refuses a body over the cap instead of buffering it", async () => {
    // This path called `request.arrayBuffer()` with no limit, so the 10 MiB control existed only on
    // the Node listener — and the edge is the surface actually exposed to the internet.
    const body = new Uint8Array(4096).fill(0x61);
    const request = new Request("https://api.example.com/v1/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    await expect(fetchToRaw(request, 1024)).rejects.toThrow(RequestBodyTooLargeError);
  });

  it("answers an oversized request with a 413 problem document, not a 500", async () => {
    const h = buildEdgeFetchHandler({
      manifest,
      apiKeys: [parseApiKeySpec(`k:store_manager:${TENANT}`)],
      maxRequestBodyBytes: 1024,
    });
    const res = await h.fetch(
      new Request("https://api.example.com/v1/products", {
        method: "POST",
        headers: { "x-api-key": "k", "content-type": "application/json" },
        body: new Uint8Array(4096).fill(0x61),
      }),
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const problem = (await res.json()) as { type: string; status: number };
    expect(problem.type).toBe("https://crossengin.io/problems/payload-too-large");
    expect(problem.status).toBe(413);
  });
});

describe("createFetchHandler — serving over the Fetch API", () => {
  it("creates then lists a product (manager)", async () => {
    const fetch = handler();
    const created = await fetch(postReq("/v1/products", "key-manager", PRODUCT));
    expect(created.status).toBe(201);

    const list = await fetch(getReq("/v1/products", "key-manager"));
    expect(list.status).toBe(200);
    const parsed = (await list.json()) as { data: Array<Record<string, unknown>> };
    // `unit_cost` is `decimal(12, 2)`: it leaves the gateway as its canonical wire string.
    expect(parsed.data[0]).toMatchObject({ sku: "SKU-1", unit_cost: "1.10" });
  });

  it("redacts unit_cost for a cashier (classification at the edge)", async () => {
    const fetch = handler();
    await fetch(postReq("/v1/products", "key-manager", PRODUCT));
    const list = await fetch(getReq("/v1/products", "key-cashier"));
    const parsed = (await list.json()) as { data: Array<Record<string, unknown>> };
    expect(parsed.data[0]).not.toHaveProperty("unit_cost");
    expect(parsed.data[0]).toMatchObject({ sku: "SKU-1" });
  });

  it("401s an unknown API key (fail-closed)", async () => {
    const res = await handler()(getReq("/v1/products", "key-nobody"));
    expect(res.status).toBe(401);
  });

  it("paginates with ?limit and an opaque cursor", async () => {
    const fetch = handler();
    for (const p of [{ sku: "A", name: "Apple" }, { sku: "B", name: "Banana" }, { sku: "C", name: "Cherry" }]) {
      await fetch(postReq("/v1/products", "key-manager", { ...p, unit_price: 1, unit_cost: 0.5, status: "active", category: "grocery" }));
    }
    const first = await fetch(getReq("/v1/products?limit=2", "key-manager"));
    const body = (await first.json()) as { data: unknown[]; page: { nextCursor: string | null } };
    expect(body.data).toHaveLength(2);
    expect(body.page.nextCursor).not.toBeNull();
  });
});

describe("asModuleWorker", () => {
  it("exposes a { fetch } default-export shape", async () => {
    const worker = asModuleWorker(handler());
    const res = await worker.fetch(getReq("/v1/products", "key-manager"));
    expect(res.status).toBe(200);
  });
});
