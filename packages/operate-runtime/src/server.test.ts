import type { IncomingRequest, ResolvedPrincipal } from "@crossengin/api-gateway";
import {
  InMemoryPrincipalResolver,
  buildIncomingRequest,
  type OpaqueTokenLookup,
} from "@crossengin/api-gateway-runtime";
import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import { buildOperateGateway } from "./compile.js";
import { InMemoryEntityStore } from "./store.js";

// This milestone proves the manifest -> routes -> gateway -> handler -> store ->
// classification-redaction chain end-to-end through the real gateway pipeline,
// for both the READ path (with per-caller redaction) and — since the P1.5
// gateway fixes landed — the WRITE path (POST/PATCH bodies decoded into
// `parsedBody` by `parse_request`, and handler-returned 4xx/5xx mapped to a
// `deny`/`error` stage outcome instead of tripping the "pass cannot be 4xx"
// PipelineExecution invariant).

const TENANT = "00000000-0000-4000-8000-000000000001";

const registry: ManifestRegistry = {
  async getManifest(id: string): Promise<Manifest | null> {
    return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
  },
};
const resolved = await resolveManifest(buildErpRetailPack(), { registry });

const KEYS: Record<string, string> = { "key-cashier": "cashier", "key-manager": "store_manager" };

function makeServer() {
  const store = new InMemoryEntityStore();
  const principalResolver = new InMemoryPrincipalResolver();
  for (const role of Object.values(KEYS)) {
    principalResolver.register(role, {
      principalId: "00000000-0000-4000-8000-0000000000aa",
      tenantId: TENANT,
      principalKind: "user",
      authScheme: "api_key_header",
      grantedScopes: [role],
      mfaProofAgeSeconds: null,
      resolvedAt: "2026-06-03T12:00:00.000Z",
    });
  }
  const opaqueTokenLookup: OpaqueTokenLookup = {
    async lookup(_req: IncomingRequest, token: string) {
      const role = KEYS[token];
      return role === undefined ? null : { principalRef: role, scopes: [role], tenantId: TENANT };
    },
  };
  const server = buildOperateGateway(resolved, {
    store,
    principalRoles: (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
    principalResolver,
    opaqueTokenLookup,
    clock: { now: () => new Date("2026-06-03T12:00:00.000Z") },
  });
  return { server, store };
}

function getReq(target: string, token: string): IncomingRequest {
  const url = new URL(target, "http://placeholder.invalid");
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) query[k] = v;
  return buildIncomingRequest({
    id: `req_${Math.random().toString(36).slice(2, 14)}`,
    receivedAt: "2026-06-03T12:00:00.000Z",
    method: "GET",
    path: url.pathname,
    query,
    headers: { "x-api-key": token },
    host: "api.example.com",
    scheme: "https",
    bodyBytes: null,
    clientIp: "203.0.113.1",
  });
}

function writeReq(
  method: "POST" | "PATCH",
  path: string,
  token: string,
  body: Record<string, unknown>,
): IncomingRequest {
  return buildIncomingRequest({
    id: `req_${Math.random().toString(36).slice(2, 14)}`,
    receivedAt: "2026-06-03T12:00:00.000Z",
    method,
    path,
    headers: { "x-api-key": token, "content-type": "application/json" },
    host: "api.example.com",
    scheme: "https",
    bodyBytes: new TextEncoder().encode(JSON.stringify(body)),
    clientIp: "203.0.113.1",
  });
}

function bodyOf(bytes: Uint8Array | null): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())) as Record<string, unknown>;
}

const PRODUCT = {
  id: "prod-1",
  sku: "SKU-1",
  name: "Milk",
  unit_price: 2,
  unit_cost: 1.1,
  status: "active",
  category: "grocery",
};

describe("operate-server — manifest served end-to-end through the gateway", () => {
  it("serves a list with classification redaction (cashier: no unit_cost; manager: full)", async () => {
    const { server, store } = makeServer();
    await store.create(TENANT, "Product", PRODUCT);

    const asCashier = await server.runtime.handleRequest(getReq("/v1/products", "key-cashier"));
    expect(asCashier.response.status).toBe(200);
    expect(asCashier.execution.routeOperationId).toBe("product.list");
    const cashierRows = bodyOf(asCashier.response.bodyBytes)["data"] as Array<Record<string, unknown>>;
    expect(cashierRows[0]).not.toHaveProperty("unit_cost");
    expect(cashierRows[0]).toMatchObject({ sku: "SKU-1", unit_price: 2 });

    const asManager = await server.runtime.handleRequest(getReq("/v1/products", "key-manager"));
    const managerRows = bodyOf(asManager.response.bodyBytes)["data"] as Array<Record<string, unknown>>;
    expect(managerRows[0]).toHaveProperty("unit_cost", 1.1);
  });

  it("serves a single record read via the manifest-derived route, redacted per caller", async () => {
    const { server, store } = makeServer();
    await store.create(TENANT, "Product", PRODUCT);

    const read = await server.runtime.handleRequest(getReq("/v1/products/prod-1", "key-cashier"));
    expect(read.response.status).toBe(200);
    expect(read.execution.routeOperationId).toBe("product.read");
    const record = bodyOf(read.response.bodyBytes);
    expect(record["sku"]).toBe("SKU-1");
    expect(record).not.toHaveProperty("unit_cost");
  });

  it("records a queryable PipelineExecution per served request", async () => {
    const { server, store } = makeServer();
    await store.create(TENANT, "Product", PRODUCT);
    const { execution } = await server.runtime.handleRequest(getReq("/v1/products", "key-manager"));
    expect(execution.finalOutcome).toBe("pass");
    expect(execution.tenantId).toBe(TENANT);
    expect(execution.stages.some((s) => s.stage === "transform_response")).toBe(true);
  });
});

describe("operate-server — list pagination + filter from the ListView (P1.8)", () => {
  async function seedThree(store: InMemoryEntityStore): Promise<void> {
    await store.create(TENANT, "Product", { id: "p-c", sku: "C", name: "Cherry", unit_price: 3, status: "active", category: "g" });
    await store.create(TENANT, "Product", { id: "p-a", sku: "A", name: "Apple", unit_price: 1, status: "active", category: "g" });
    await store.create(TENANT, "Product", { id: "p-b", sku: "B", name: "Banana", unit_price: 2, status: "archived", category: "g" });
  }

  it("paginates with ?limit and follows the opaque cursor (sorted by the view's default)", async () => {
    const { server, store } = makeServer();
    await seedThree(store);

    const first = await server.runtime.handleRequest(getReq("/v1/products?limit=2", "key-manager"));
    const firstBody = bodyOf(first.response.bodyBytes);
    const firstRows = firstBody["data"] as Array<Record<string, unknown>>;
    expect(firstRows.map((r) => r["name"])).toEqual(["Apple", "Banana"]); // default sort name asc
    const page = firstBody["page"] as { nextCursor: string | null; limit: number };
    expect(page.limit).toBe(2);
    expect(page.nextCursor).not.toBeNull();

    const second = await server.runtime.handleRequest(
      getReq(`/v1/products?limit=2&cursor=${encodeURIComponent(page.nextCursor!)}`, "key-manager"),
    );
    const secondRows = bodyOf(second.response.bodyBytes)["data"] as Array<Record<string, unknown>>;
    expect(secondRows.map((r) => r["name"])).toEqual(["Cherry"]);
    expect((bodyOf(second.response.bodyBytes)["page"] as { nextCursor: string | null }).nextCursor).toBeNull();
  });

  it("filters by an equality param on a filterable column", async () => {
    const { server, store } = makeServer();
    await seedThree(store);
    const res = await server.runtime.handleRequest(getReq("/v1/products?status=active", "key-manager"));
    const rows = bodyOf(res.response.bodyBytes)["data"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r["status"] === "active")).toBe(true);
  });
});

describe("operate-server — write path through the gateway (P1.5)", () => {
  it("creates a product through the pipeline: the POST body lands in the store", async () => {
    const { server, store } = makeServer();
    const created = await server.runtime.handleRequest(
      writeReq("POST", "/v1/products", "key-manager", {
        sku: "SKU-9",
        name: "Bread",
        unit_price: 3,
        unit_cost: 1.5,
        status: "active",
        category: "grocery",
      }),
    );
    expect(created.response.status).toBe(201);
    expect(created.execution.routeOperationId).toBe("product.create");
    const body = bodyOf(created.response.bodyBytes);
    const id = body["id"] as string;
    expect(typeof id).toBe("string");

    const persisted = await store.get(TENANT, "Product", id);
    expect(persisted).toMatchObject({ sku: "SKU-9", name: "Bread" });
  });

  it("denies a cashier creating a product (RBAC 403 → dispatch deny, not a tripped invariant)", async () => {
    const { server } = makeServer();
    const denied = await server.runtime.handleRequest(
      writeReq("POST", "/v1/products", "key-cashier", { sku: "X", name: "Y" }),
    );
    expect(denied.response.status).toBe(403);
    const dispatch = denied.execution.stages.find((s) => s.stage === "dispatch_handler");
    expect(dispatch?.outcome).toBe("deny");
    expect(denied.execution.finalOutcome).toBe("deny");
  });

  it("advances a sales order cart -> placed and 409s an invalid re-fire, both through the gateway", async () => {
    const { server } = makeServer();
    const created = await server.runtime.handleRequest(
      writeReq("POST", "/v1/sales-orders", "key-manager", {
        store_id: "st1",
        order_number: "SO-1",
        state: "cart",
        channel: "in_store",
        currency: "USD",
        total: 0,
      }),
    );
    expect(created.response.status).toBe(201);
    const id = bodyOf(created.response.bodyBytes)["id"] as string;

    const placed = await server.runtime.handleRequest(
      writeReq("POST", `/v1/sales-orders/${id}/place`, "key-manager", {}),
    );
    expect(placed.response.status).toBe(200);
    expect(placed.execution.routeOperationId).toBe("salesOrder.place");
    expect(bodyOf(placed.response.bodyBytes)["state"]).toBe("placed");

    const again = await server.runtime.handleRequest(
      writeReq("POST", `/v1/sales-orders/${id}/place`, "key-manager", {}),
    );
    expect(again.response.status).toBe(409);
    const dispatch = again.execution.stages.find((s) => s.stage === "dispatch_handler");
    expect(dispatch?.outcome).toBe("deny");
  });
});
