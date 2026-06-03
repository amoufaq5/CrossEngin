import { describe, expect, it } from "vitest";

import { asModuleWorker, buildEdgeFetchHandler, fetchToRaw } from "./edge.js";
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
});

describe("createFetchHandler — serving over the Fetch API", () => {
  it("creates then lists a product (manager)", async () => {
    const fetch = handler();
    const created = await fetch(postReq("/v1/products", "key-manager", PRODUCT));
    expect(created.status).toBe(201);

    const list = await fetch(getReq("/v1/products", "key-manager"));
    expect(list.status).toBe(200);
    const parsed = (await list.json()) as { data: Array<Record<string, unknown>> };
    expect(parsed.data[0]).toMatchObject({ sku: "SKU-1", unit_cost: 1.1 });
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
      await fetch(postReq("/v1/products", "key-manager", { ...p, unit_price: 1, status: "active", category: "g" }));
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
