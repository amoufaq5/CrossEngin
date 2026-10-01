import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { beforeEach, describe, expect, it } from "vitest";

import { compileOperateServer, type CompiledOperateServer } from "./compile.js";
import { routeFromSpec } from "./operations.js";
import { InMemoryEntityStore, type EntityRecord, type EntityStore } from "./store.js";

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
let store: InMemoryEntityStore;
beforeEach(() => {
  store = new InMemoryEntityStore();
  server = compileOperateServer(resolved, { store, principalRoles });
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

  it("409s a conditional update whose record publishes a Date version, not a string", async () => {
    // What the column store does: node-postgres returns TIMESTAMPTZ as a JS Date,
    // so the old `typeof === "string"` test made `current` null and the guard
    // skipped. Measured live against real Postgres: a deliberately stale
    // precondition was answered 200 and the write landed (ADR-0285).
    const created = bodyOf(await invoke("product.create", { role: "retail_admin", body: { sku: "DT", name: "A", unit_price: 1, unit_cost: 1 } }));
    const id = created["id"] as string;
    const version = created["updated_at"] as string;
    // the store now holds a Date where the document store would hold a string
    await store.update(TENANT, "Product", id, { updated_at: new Date(version) });

    const stale = await invoke("product.update", {
      role: "retail_admin",
      params: { id },
      body: { name: "B", expectedUpdatedAt: "1999-01-01T00:00:00.000Z" },
    });
    expect(stale.status).toBe(409);
    expect((bodyOf(await invoke("product.read", { role: "retail_admin", params: { id } })))["name"]).toBe("A");

    // and the matching one still applies, because both sides normalise identically
    const ok = await invoke("product.update", {
      role: "retail_admin",
      params: { id },
      body: { name: "B", expectedUpdatedAt: version },
    });
    expect(ok.status).toBe(200);
  });

  it("400s a non-string expectedUpdatedAt instead of stripping it and writing", async () => {
    const created = bodyOf(await invoke("product.create", { role: "retail_admin", body: { sku: "NS", name: "A", unit_price: 1, unit_cost: 1 } }));
    const id = created["id"] as string;
    for (const bad of [0, null, true, { at: 1 }, ["x"], "", "   ", "not-a-date"]) {
      const out = await invoke("product.update", {
        role: "retail_admin",
        params: { id },
        body: { name: "FORGED", expectedUpdatedAt: bad },
      });
      expect(out.status).toBe(400);
      expect(bodyOf(out)["error"]).toBe("invalid_precondition");
    }
    // nothing was written by any of them
    expect((bodyOf(await invoke("product.read", { role: "retail_admin", params: { id } })))["name"]).toBe("A");
  });

  it("409s when the record publishes no version at all, rather than writing unconditionally", async () => {
    const created = bodyOf(await invoke("product.create", { role: "retail_admin", body: { sku: "NV", name: "A", unit_price: 1, unit_cost: 1 } }));
    const id = created["id"] as string;
    await store.remove(TENANT, "Product", id);
    await store.create(TENANT, "Product", { id, sku: "NV", name: "A", unit_price: 1, unit_cost: 1 });

    const out = await invoke("product.update", {
      role: "retail_admin",
      params: { id },
      body: { name: "B", expectedUpdatedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(out.status).toBe(409);
    expect(bodyOf(out)["detail"]).toContain("publishes no version");
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

/**
 * A store that lets a rival commit land in the window between the handler's read
 * and its write — the interleaving `applyTransition` could not see. `get`
 * returns the pre-rival view (which is what a real concurrent caller holds) and
 * commits the rival behind it, exactly once.
 *
 * Built in two flavours from one body so the pair measures one difference: with
 * `updateIf` the handler refuses; without it, the handler writes over the rival.
 */
function interleavingStore(
  inner: InMemoryEntityStore,
  rival: EntityRecord,
  opts: { readonly conditional: boolean },
): EntityStore {
  let fired = false;
  const base: EntityStore = {
    list: (t, e) => inner.list(t, e),
    listPage: (t, e, q) => inner.listPage(t, e, q),
    async get(t, e, id) {
      const record = await inner.get(t, e, id);
      if (record === null) return null;
      if (!fired) {
        fired = true;
        await inner.update(t, e, id, rival);
      }
      return record;
    },
    create: (t, e, r) => inner.create(t, e, r),
    update: (t, e, id, p) => inner.update(t, e, id, p),
    remove: (t, e, id) => inner.remove(t, e, id),
  };
  if (!opts.conditional) return base;
  return {
    ...base,
    updateIf: (t, e, id, p, expect) => inner.updateIf(t, e, id, p, expect),
  };
}

describe("operate handlers — the transition write is compare-and-set", () => {
  async function placeAgainstRival(conditional: boolean): Promise<{
    out: HandlerOutput;
    finalState: unknown;
  }> {
    const inner = new InMemoryEntityStore();
    const seeded = await inner.create(TENANT, "SalesOrder", {
      store_id: "st1", order_number: "SO-RACE", state: "cart", channel: "in_store",
      currency: "USD", total: 0,
    });
    const id = String(seeded["id"]);
    // The rival is another caller's `place`, committed while this one is still
    // holding its `cart` read.
    const store = interleavingStore(inner, { state: "placed" }, { conditional });
    const raced = compileOperateServer(resolved, { store, principalRoles });
    const spec = raced.routeSpecs.find((s) => s.operationId === "salesOrder.place")!;
    const out = await raced.handlers.resolve("salesOrder.place")!({
      request: buildIncomingRequest({
        id: "req_cas0000001",
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
      principal: principal("store_manager"),
      params: { id },
      parsedBody: null,
    });
    const after = await inner.get(TENANT, "SalesOrder", id);
    return { out, finalState: after?.["state"] };
  }

  it("refuses 409 concurrent_modification when the state moved under the read", async () => {
    const { out, finalState } = await placeAgainstRival(true);
    expect(out.status).toBe(409);
    const body = bodyOf(out);
    expect(body["error"]).toBe("concurrent_modification");
    // The refusal names the field, what was read, and what is actually there.
    expect(body["field"]).toBe("state");
    expect(body["expected"]).toBe("cart");
    expect(String(body["detail"])).toContain("'placed'");
    expect(finalState).toBe("placed");
  });

  it("is the SAME interleaving a non-conditional store lets through — the race, measured", async () => {
    // The control. One store difference, two answers: this is the window every
    // read-then-write guard on this contract has been carrying.
    const { out, finalState } = await placeAgainstRival(false);
    expect(out.status).toBe(200);
    expect(finalState).toBe("placed");
  });

  it("leaves an ordinary uncontended transition at 200", async () => {
    // The fence must cost nothing when nothing raced: the conditional path is
    // taken for every transition on a capable store, so this is the common case.
    const store = new InMemoryEntityStore();
    const plain = compileOperateServer(resolved, { store, principalRoles });
    const spec = plain.routeSpecs.find((s) => s.operationId === "salesOrder.place")!;
    const seeded = await store.create(TENANT, "SalesOrder", {
      store_id: "st1", order_number: "SO-OK", state: "cart", channel: "in_store",
      currency: "USD", total: 0,
    });
    const out = await plain.handlers.resolve("salesOrder.place")!({
      request: buildIncomingRequest({
        id: "req_cas0000002",
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
      principal: principal("store_manager"),
      params: { id: String(seeded["id"]) },
      parsedBody: null,
    });
    expect(out.status).toBe(200);
    expect(bodyOf(out)["state"]).toBe("placed");
  });
});

describe("operate handlers — concurrency: optimistic makes the precondition mandatory", () => {
  const strictManifest: Manifest = {
    ...resolved,
    entities: (resolved.entities ?? []).map((e) =>
      e.name === "Product" ? { ...e, concurrency: "optimistic" as const } : e,
    ),
  };
  let strictStore: InMemoryEntityStore;
  let strict: CompiledOperateServer;
  beforeEach(() => {
    strictStore = new InMemoryEntityStore();
    strict = compileOperateServer(strictManifest, { store: strictStore, principalRoles });
  });

  async function call(
    opId: string,
    opts: { params?: Record<string, string>; body?: Record<string, unknown> },
  ): Promise<HandlerOutput> {
    const spec = strict.routeSpecs.find((s) => s.operationId === opId)!;
    const handler = strict.handlers.resolve(opId)!;
    return handler({
      request: buildIncomingRequest({
        id: "req_op000000001",
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
      params: opts.params ?? {},
      parsedBody: opts.body ?? null,
    });
  }

  async function makeProduct(sku: string): Promise<Record<string, unknown>> {
    return bodyOf(await call("product.create", { body: { sku, name: "A", unit_price: 1, unit_cost: 1 } }));
  }

  it("428s an unconditional PATCH, naming the field it wants", async () => {
    const id = (await makeProduct("RQ1"))["id"] as string;
    const out = await call("product.update", { params: { id }, body: { name: "B" } });
    expect(out.status).toBe(428);
    expect(bodyOf(out)["error"]).toBe("precondition_required");
    expect(bodyOf(out)["field"]).toBe("expectedUpdatedAt");
  });

  it("428, not 409 — every neighbouring refusal means 'no role may do this', which is false here", async () => {
    const id = (await makeProduct("RQ2"))["id"] as string;
    const refused = await call("product.update", { params: { id }, body: { name: "B" } });
    expect(refused.status).toBe(428);
    // the same role, the same body, plus a version → allowed
    const version = bodyOf(await call("product.read", { params: { id } }))["updated_at"] as string;
    const allowed = await call("product.update", { params: { id }, body: { name: "B", expectedUpdatedAt: version } });
    expect(allowed.status).toBe(200);
  });

  it("writes nothing when it refuses", async () => {
    const id = (await makeProduct("RQ3"))["id"] as string;
    await call("product.update", { params: { id }, body: { name: "OVERWRITTEN" } });
    expect(bodyOf(await call("product.read", { params: { id } }))["name"]).toBe("A");
  });

  it("still 400s a malformed precondition rather than treating it as absent", async () => {
    const id = (await makeProduct("RQ4"))["id"] as string;
    const out = await call("product.update", { params: { id }, body: { name: "B", expectedUpdatedAt: 0 } });
    expect(out.status).toBe(400);
    expect(bodyOf(out)["error"]).toBe("invalid_precondition");
  });

  it("still 409s a stale precondition", async () => {
    const id = (await makeProduct("RQ5"))["id"] as string;
    const out = await call("product.update", {
      params: { id },
      body: { name: "B", expectedUpdatedAt: "1999-01-01T00:00:00.000Z" },
    });
    expect(out.status).toBe(409);
  });

  it("leaves create, delete and transitions unconditional", async () => {
    const id = (await makeProduct("RQ6"))["id"] as string;
    expect((await call("product.delete", { params: { id } })).status).toBe(204);
  });

  it("does not require a version on an entity that did not declare the mode", async () => {
    // Store is a different entity in the same manifest: the fence is per-entity.
    const created = bodyOf(
      await call("store.create", { body: { account_id: "acct-1", code: "S1", name: "Main" } }),
    );
    expect(created["id"]).toBeTypeOf("string");
    const out = await call("store.update", { params: { id: created["id"] as string }, body: { name: "Other" } });
    expect(out.status).toBe(200);
  });
});
