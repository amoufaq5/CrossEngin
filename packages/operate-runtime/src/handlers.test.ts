import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { beforeEach, describe, expect, it } from "vitest";

import { compileOperateServer, type CompiledOperateServer } from "./compile.js";
import { routeFromSpec } from "./operations.js";
import { InMemoryEntityStore } from "./store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

const registry: ManifestRegistry = {
  async getManifest(id: string): Promise<Manifest | null> {
    return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
  },
};
const resolved = await resolveManifest(buildErpRetailPack(), { registry });

const principalRoles = (p: ResolvedPrincipal | null) => ({
  primaryRole: p?.grantedScopes[0] ?? "anonymous",
});

function principal(role: string | null): ResolvedPrincipal | null {
  if (role === null) return null;
  return {
    principalId: "00000000-0000-4000-8000-0000000000aa",
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [role],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-03T12:00:00.000Z",
  };
}

let server: CompiledOperateServer;
beforeEach(() => {
  server = compileOperateServer(resolved, { store: new InMemoryEntityStore(), principalRoles });
});

async function invoke(
  opId: string,
  opts: { role: string | null; params?: Record<string, string>; body?: Record<string, unknown> },
): Promise<HandlerOutput> {
  const spec = server.routeSpecs.find((s) => s.operationId === opId);
  if (spec === undefined) throw new Error(`no route for ${opId}`);
  const handler = server.handlers.resolve(opId)!;
  const request = buildIncomingRequest({
    id: "req_op000000001",
    receivedAt: "2026-06-03T12:00:00.000Z",
    method: spec.method,
    path: "/v1/x",
    headers: {},
    host: "api.example.com",
    scheme: "https",
    bodyBytes: null,
    clientIp: "203.0.113.1",
  });
  return handler({
    request,
    route: routeFromSpec(spec),
    principal: principal(opts.role),
    params: opts.params ?? {},
    parsedBody: opts.body ?? null,
  });
}

function bodyOf(out: HandlerOutput): Record<string, unknown> {
  if (out.kind !== "json") throw new Error("expected json output");
  return out.body as Record<string, unknown>;
}

describe("operate handlers — RBAC", () => {
  it("rejects an anonymous request with 401", async () => {
    expect((await invoke("product.list", { role: null })).status).toBe(401);
  });

  it("403s a cashier creating a product (create is managers-only)", async () => {
    const out = await invoke("product.create", { role: "cashier", body: { sku: "X" } });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["error"]).toBe("forbidden");
  });

  it("lets a store manager create a product", async () => {
    const out = await invoke("product.create", {
      role: "store_manager",
      body: { sku: "SKU-1", name: "Milk", unit_price: 2, unit_cost: 1, status: "active", category: "grocery" },
    });
    expect(out.status).toBe(201);
    expect(typeof bodyOf(out)["id"]).toBe("string");
  });
});

describe("operate handlers — CRUD", () => {
  it("creates, reads, lists, updates, deletes a product", async () => {
    const created = bodyOf(await invoke("product.create", { role: "retail_admin", body: { sku: "S1", name: "A" } }));
    const id = created["id"] as string;

    expect((await invoke("product.read", { role: "retail_admin", params: { id } })).status).toBe(200);

    const list = bodyOf(await invoke("product.list", { role: "retail_admin" }));
    expect((list["data"] as unknown[]).length).toBe(1);

    const updated = bodyOf(await invoke("product.update", { role: "retail_admin", params: { id }, body: { name: "B" } }));
    expect(updated["name"]).toBe("B");

    expect((await invoke("product.delete", { role: "retail_admin", params: { id } })).status).toBe(204);
    expect((await invoke("product.read", { role: "retail_admin", params: { id } })).status).toBe(404);
  });

  it("404s reading a missing record", async () => {
    expect((await invoke("product.read", { role: "retail_admin", params: { id: "nope" } })).status).toBe(404);
  });
});

describe("operate handlers — lifecycle transitions", () => {
  it("advances a sales order cart -> placed and rejects an invalid transition", async () => {
    const order = bodyOf(
      await invoke("salesOrder.create", {
        role: "store_manager",
        body: { store_id: "st1", order_number: "SO-1", state: "cart", channel: "in_store", currency: "USD", total: 0 },
      }),
    );
    const id = order["id"] as string;

    const placed = bodyOf(await invoke("salesOrder.place", { role: "store_manager", params: { id } }));
    expect(placed["state"]).toBe("placed");

    // place again: now in 'placed', not in the transition's fromStates ('cart')
    const again = await invoke("salesOrder.place", { role: "store_manager", params: { id } });
    expect(again.status).toBe(409);
  });
});
