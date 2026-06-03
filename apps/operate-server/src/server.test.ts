import { InMemoryEntityStore } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import type { RawHttpRequest } from "./http.js";
import { loadBuiltinPack } from "./manifest-source.js";
import { parseApiKeySpec } from "./principals.js";
import { OperateHttpServer, buildOperateHttpServer } from "./server.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const manifest = await loadBuiltinPack("erp-retail");

const API_KEYS = [
  parseApiKeySpec(`key-cashier:cashier:${TENANT}`),
  parseApiKeySpec(`key-manager:store_manager:${TENANT}`),
];

function makeServer(): OperateHttpServer {
  const { httpServer } = buildOperateHttpServer({
    manifest,
    store: new InMemoryEntityStore(),
    apiKeys: API_KEYS,
    now: () => new Date("2026-06-03T12:00:00.000Z"),
  });
  return httpServer;
}

function req(method: string, url: string, key: string): RawHttpRequest {
  return { method, url, headers: { "x-api-key": key, host: "api.example.com" }, remoteAddress: "203.0.113.1" };
}

function jsonBody(method: string, url: string, key: string, body: unknown): { raw: RawHttpRequest; bytes: Uint8Array } {
  return {
    raw: {
      method,
      url,
      headers: { "x-api-key": key, host: "api.example.com", "content-type": "application/json" },
      remoteAddress: "203.0.113.1",
    },
    bytes: new TextEncoder().encode(JSON.stringify(body)),
  };
}

function parse(body: Uint8Array | null): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(body ?? new Uint8Array())) as Record<string, unknown>;
}

const PRODUCT = {
  sku: "SKU-1",
  name: "Milk",
  unit_price: 2,
  unit_cost: 1.1,
  status: "active",
  category: "grocery",
};

describe("OperateHttpServer — serving a pack over raw HTTP", () => {
  it("rejects an unknown HTTP method with 405", async () => {
    const server = makeServer();
    const res = await server.dispatch(req("BREW", "/v1/products", "key-manager"), null);
    expect(res.status).toBe(405);
    expect(res.headers["content-type"]).toContain("problem+json");
  });

  it("401s a request with no/unknown API key", async () => {
    const server = makeServer();
    const res = await server.dispatch(req("GET", "/v1/products", "key-nobody"), null);
    expect(res.status).toBe(401);
  });

  it("creates a product (manager) then lists it back", async () => {
    const server = makeServer();
    const { raw, bytes } = jsonBody("POST", "/v1/products", "key-manager", PRODUCT);
    const created = await server.dispatch(raw, bytes);
    expect(created.status).toBe(201);
    expect(typeof parse(created.body)["id"]).toBe("string");

    const list = await server.dispatch(req("GET", "/v1/products", "key-manager"), null);
    expect(list.status).toBe(200);
    const rows = parse(list.body)["data"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sku: "SKU-1", unit_cost: 1.1 });
  });

  it("redacts unit_cost for a cashier but not a manager (same route)", async () => {
    const server = makeServer();
    const { raw, bytes } = jsonBody("POST", "/v1/products", "key-manager", PRODUCT);
    await server.dispatch(raw, bytes);

    const cashier = await server.dispatch(req("GET", "/v1/products", "key-cashier"), null);
    const cashierRows = parse(cashier.body)["data"] as Array<Record<string, unknown>>;
    expect(cashierRows[0]).not.toHaveProperty("unit_cost");
    expect(cashierRows[0]).toMatchObject({ sku: "SKU-1" });

    const manager = await server.dispatch(req("GET", "/v1/products", "key-manager"), null);
    const managerRows = parse(manager.body)["data"] as Array<Record<string, unknown>>;
    expect(managerRows[0]).toHaveProperty("unit_cost", 1.1);
  });

  it("denies a cashier creating a product with 403", async () => {
    const server = makeServer();
    const { raw, bytes } = jsonBody("POST", "/v1/products", "key-cashier", PRODUCT);
    const res = await server.dispatch(raw, bytes);
    expect(res.status).toBe(403);
  });

  it("decodes a query string into the gateway request (does not 404 on ?cursor=)", async () => {
    const server = makeServer();
    const res = await server.dispatch(req("GET", "/v1/products?limit=10&cursor=abc", "key-manager"), null);
    expect(res.status).toBe(200);
  });

  it("paginates over HTTP: ?limit drives the page + an opaque nextCursor (P1.8)", async () => {
    const server = makeServer();
    for (const p of [
      { sku: "A", name: "Apple" },
      { sku: "B", name: "Banana" },
      { sku: "C", name: "Cherry" },
    ]) {
      const { raw, bytes } = jsonBody("POST", "/v1/products", "key-manager", {
        ...p,
        unit_price: 1,
        status: "active",
        category: "g",
      });
      await server.dispatch(raw, bytes);
    }

    const first = await server.dispatch(req("GET", "/v1/products?limit=2", "key-manager"), null);
    const firstBody = parse(first.body);
    expect((firstBody["data"] as unknown[]).length).toBe(2);
    const page = firstBody["page"] as { nextCursor: string | null; limit: number };
    expect(page.limit).toBe(2);
    expect(page.nextCursor).not.toBeNull();

    const second = await server.dispatch(
      req("GET", `/v1/products?limit=2&cursor=${encodeURIComponent(page.nextCursor!)}`, "key-manager"),
      null,
    );
    const secondBody = parse(second.body);
    expect((secondBody["data"] as unknown[]).length).toBe(1);
    expect((secondBody["page"] as { nextCursor: string | null }).nextCursor).toBeNull();
  });
});
