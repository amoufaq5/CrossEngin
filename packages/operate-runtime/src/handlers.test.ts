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
    const created = bodyOf(await invoke("product.create", { role: "retail_admin", body: { sku: "S1", name: "A", unit_price: 1, unit_cost: 1 } }));
    const id = created["id"] as string;

    expect((await invoke("product.read", { role: "retail_admin", params: { id } })).status).toBe(200);

    const list = bodyOf(await invoke("product.list", { role: "retail_admin" }));
    expect((list["data"] as unknown[]).length).toBe(1);

    const updated = bodyOf(await invoke("product.update", { role: "retail_admin", params: { id }, body: { name: "B" } }));
    expect(updated["name"]).toBe("B");

    expect((await invoke("product.delete", { role: "retail_admin", params: { id } })).status).toBe(204);
    expect((await invoke("product.read", { role: "retail_admin", params: { id } })).status).toBe(404);
  });

  it("stamps created_at + updated_at on create and bumps updated_at on update", async () => {
    const created = bodyOf(await invoke("product.create", { role: "retail_admin", body: { sku: "TS", name: "A", unit_price: 1, unit_cost: 1 } }));
    expect(typeof created["created_at"]).toBe("string");
    expect(created["updated_at"]).toBe(created["created_at"]);
    const id = created["id"] as string;
    const updated = bodyOf(await invoke("product.update", { role: "retail_admin", params: { id }, body: { name: "B" } }));
    expect(updated["created_at"]).toBe(created["created_at"]);
    expect(typeof updated["updated_at"]).toBe("string");
  });

  it("404s reading a missing record", async () => {
    expect((await invoke("product.read", { role: "retail_admin", params: { id: "nope" } })).status).toBe(404);
  });

  it("optimistic concurrency: a matching expectedUpdatedAt updates; a stale one 409s", async () => {
    const created = bodyOf(await invoke("product.create", { role: "retail_admin", body: { sku: "OC", name: "A", unit_price: 1, unit_cost: 1 } }));
    const id = created["id"] as string;
    const version = created["updated_at"] as string;

    // Stale token → 409 conflict, record untouched.
    const stale = await invoke("product.update", {
      role: "retail_admin",
      params: { id },
      body: { name: "B", expectedUpdatedAt: "1999-01-01T00:00:00.000Z" },
    });
    expect(stale.status).toBe(409);
    expect(bodyOf(stale)["error"]).toBe("conflict");
    expect((bodyOf(await invoke("product.read", { role: "retail_admin", params: { id } })))["name"]).toBe("A");

    // Matching token → update succeeds, and the token field is never stored.
    const ok = await invoke("product.update", {
      role: "retail_admin",
      params: { id },
      body: { name: "B", expectedUpdatedAt: version },
    });
    expect(ok.status).toBe(200);
    expect(bodyOf(ok)["name"]).toBe("B");
    expect(bodyOf(ok)).not.toHaveProperty("expectedUpdatedAt");
  });

  it("update without expectedUpdatedAt is unconditional (backward compatible)", async () => {
    const created = bodyOf(await invoke("product.create", { role: "retail_admin", body: { sku: "UN", name: "A", unit_price: 1, unit_cost: 1 } }));
    const id = created["id"] as string;
    const out = await invoke("product.update", { role: "retail_admin", params: { id }, body: { name: "B" } });
    expect(out.status).toBe(200);
    expect(bodyOf(out)["name"]).toBe("B");
  });

  it("a conditional update on a missing record 404s", async () => {
    const out = await invoke("product.update", {
      role: "retail_admin",
      params: { id: "nope" },
      body: { name: "B", expectedUpdatedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(out.status).toBe(404);
  });

  it("422s a create missing a required field (unit_price/unit_cost)", async () => {
    const out = await invoke("product.create", { role: "retail_admin", body: { sku: "V1", name: "A" } });
    expect(out.status).toBe(422);
    const fields = bodyOf(out)["fields"] as Array<{ field: string; code: string }>;
    expect(fields.map((f) => f.field).sort()).toEqual(["unit_cost", "unit_price"]);
  });

  it("422s a create with an invalid enum value", async () => {
    const out = await invoke("product.create", {
      role: "retail_admin",
      body: { sku: "V2", name: "A", unit_price: 1, unit_cost: 1, status: "bogus" },
    });
    expect(out.status).toBe(422);
    expect((bodyOf(out)["fields"] as Array<{ code: string }>)[0]?.code).toBe("enum");
  });

  it("422s an update that empties a required field", async () => {
    const created = bodyOf(await invoke("product.create", { role: "retail_admin", body: { sku: "V3", name: "A", unit_price: 1, unit_cost: 1 } }));
    const id = created["id"] as string;
    const out = await invoke("product.update", { role: "retail_admin", params: { id }, body: { name: "" } });
    expect(out.status).toBe(422);
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

describe("operate handlers — transactional effects", () => {
  it("rolls back the primary write when a post-write effect fails (transactional store)", async () => {
    const store = new InMemoryEntityStore();
    const failing = compileOperateServer(resolved, {
      store,
      principalRoles,
      writeEffects: [
        async () => {
          throw new Error("effect boom");
        },
      ],
    });
    const spec = failing.routeSpecs.find((s) => s.operationId === "product.create")!;
    const out = await failing.handlers.resolve("product.create")!({
      request: buildIncomingRequest({
        id: "req_tx0000000001",
        receivedAt: "2026-06-03T12:00:00.000Z",
        method: spec.method,
        path: "/v1/x",
        headers: {},
        host: "api.example.com",
        scheme: "https",
        bodyBytes: null,
        clientIp: "203.0.113.1",
      }),
      route: routeFromSpec(spec),
      principal: principal("retail_admin"),
      params: {},
      parsedBody: { sku: "ROLL", name: "RolledBack", unit_price: 1, unit_cost: 1 },
    });
    expect(out.status).toBe(500);
    // The create was rolled back: nothing persisted for Product.
    expect((await store.list(TENANT, "Product")).length).toBe(0);
  });
});
