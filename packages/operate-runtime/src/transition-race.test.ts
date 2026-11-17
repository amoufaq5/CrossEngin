import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import { compileOperateServer, type CompiledOperateServer } from "./compile.js";
import { routeFromSpec } from "./operations.js";
import { InMemoryEntityStore, type EntityRecord } from "./store.js";
import type { WriteEffect } from "./write-effects.js";

/**
 * Two requests for one write, interleaved at the one point where a race can happen: both have read
 * the record and neither has written it. Without a compare-and-set in the store both pass every
 * check made from that read and both write — which for a transition meant both ran its effects, the
 * GL posting among them.
 */

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

function principal(role: string): ResolvedPrincipal {
  return {
    principalId: "00000000-0000-4000-8000-0000000000aa",
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [role],
    abacAttributes: {},
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-03T12:00:00.000Z",
  };
}

/**
 * Holds every armed `get` of `entity` until `parties` of them have arrived, then releases them
 * together — so each request has read the record before any of them writes it. The store is the
 * one a transaction is handed (`InMemoryEntityStore.withTransaction` passes `this`), so the barrier
 * sits exactly between a handler's read and its write.
 */
class BarrierStore extends InMemoryEntityStore {
  private armed: { entity: string; parties: number; arrived: number; release: () => void; gate: Promise<void> } | null =
    null;

  arm(entity: string, parties: number): void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.armed = { entity, parties, arrived: 0, release, gate };
  }

  override async get(tenantId: string, entity: string, id: string): Promise<EntityRecord | null> {
    const read = await super.get(tenantId, entity, id);
    const a = this.armed;
    if (a !== null && entity === a.entity) {
      a.arrived += 1;
      if (a.arrived >= a.parties) {
        this.armed = null;
        a.release();
      }
      await a.gate;
    }
    return read;
  }
}

function serverOver(store: InMemoryEntityStore, effects: readonly WriteEffect[]): CompiledOperateServer {
  return compileOperateServer(resolved, { store, principalRoles, writeEffects: effects });
}

async function invoke(
  server: CompiledOperateServer,
  opId: string,
  opts: { params?: Record<string, string>; body?: Record<string, unknown> },
): Promise<HandlerOutput> {
  const spec = server.routeSpecs.find((s) => s.operationId === opId);
  if (spec === undefined) throw new Error(`no route for ${opId}`);
  const handler = server.handlers.resolve(opId)!;
  const request = buildIncomingRequest({
    id: "req_race00000001",
    receivedAt: "2026-06-03T12:00:00.000Z",
    method: spec.method,
    path: "/v1/x",
    headers: {},
    host: "api.example.com",
    scheme: "https",
    bodyBytes: null,
    clientIp: "203.0.113.1",
    edgeTrust: "untrusted",
  });
  return handler({
    request,
    route: routeFromSpec(spec),
    principal: principal("store_manager"),
    params: opts.params ?? {},
    parsedBody: opts.body ?? null,
  });
}

function bodyOf(out: HandlerOutput): Record<string, unknown> {
  if (out.kind !== "json") throw new Error("expected json output");
  return out.body as Record<string, unknown>;
}

async function cartOrder(server: CompiledOperateServer): Promise<string> {
  const created = await invoke(server, "salesOrder.create", {
    body: { store_id: "st1", order_number: "SO-RACE", state: "cart", channel: "in_store", currency: "USD", total: 0 },
  });
  expect(created.status).toBe(201);
  return bodyOf(created)["id"] as string;
}

describe("concurrent transitions", () => {
  it("lets exactly one of two racing transitions fire, and runs its effects exactly once", async () => {
    const store = new BarrierStore();
    const fired: string[] = [];
    const server = serverOver(store, [
      async (input) => {
        if (input.operation === "transition" && input.transitionTo === "placed") fired.push(String(input.id));
      },
    ]);
    const id = await cartOrder(server);

    store.arm("SalesOrder", 2);
    const [a, b] = await Promise.all([
      invoke(server, "salesOrder.place", { params: { id } }),
      invoke(server, "salesOrder.place", { params: { id } }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(bodyOf(loser)["error"]).toBe("transition_conflict");
    // The point of the whole change: the effect — in a deployment, the GL posting — ran once.
    expect(fired).toEqual([id]);
    expect((await store.get(TENANT, "SalesOrder", id))?.["state"]).toBe("placed");
  });

  it("does not refuse a transition nobody raced", async () => {
    const store = new BarrierStore();
    const server = serverOver(store, []);
    const id = await cartOrder(server);
    const out = await invoke(server, "salesOrder.place", { params: { id } });
    expect(out.status).toBe(200);
    expect(bodyOf(out)["state"]).toBe("placed");
  });

  it("answers 404 when the record is gone by the time the write lands, and runs no effect", async () => {
    // It used to answer `updated ?? record` — a 200 carrying the record as read, with the effects
    // run against a row that no longer existed.
    const store = new BarrierStore();
    const fired: string[] = [];
    const server = serverOver(store, [
      async (input) => {
        if (input.operation === "transition") fired.push(String(input.id));
      },
    ]);
    const id = await cartOrder(server);
    const original = store.get.bind(store);
    let removed = false;
    store.get = async (t, e, i) => {
      const read = await original(t, e, i);
      if (!removed && e === "SalesOrder") {
        removed = true;
        await store.remove(t, e, i);
      }
      return read;
    };
    const out = await invoke(server, "salesOrder.place", { params: { id } });
    expect(out.status).toBe(404);
    expect(fired).toEqual([]);
  });
});

describe("concurrent optimistic updates", () => {
  it("refuses the second of two updates carrying the same expectedUpdatedAt", async () => {
    const store = new BarrierStore();
    const server = serverOver(store, [async () => undefined]);
    const id = await cartOrder(server);
    const token = (await store.get(TENANT, "SalesOrder", id))?.["updated_at"] as string;
    // A frozen clock would leave `updated_at` unchanged by the winner, so the loser could never see
    // a difference: move the stored token aside first so the winner's write visibly changes it.
    await store.update(TENANT, "SalesOrder", id, { updated_at: "2026-01-01T00:00:00.000Z" });

    store.arm("SalesOrder", 2);
    const [a, b] = await Promise.all([
      invoke(server, "salesOrder.update", { params: { id }, body: { channel: "online", expectedUpdatedAt: "2026-01-01T00:00:00.000Z" } }),
      invoke(server, "salesOrder.update", { params: { id }, body: { channel: "phone", expectedUpdatedAt: "2026-01-01T00:00:00.000Z" } }),
    ]);

    expect(token).toBeTypeOf("string");
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(bodyOf(loser)["error"]).toBe("conflict");
    expect(bodyOf(loser)["currentUpdatedAt"]).toBeTypeOf("string");
    const winner = a.status === 200 ? "online" : "phone";
    expect((await store.get(TENANT, "SalesOrder", id))?.["channel"]).toBe(winner);
  });

  it("leaves an update with no token unconditional, as it was", async () => {
    const store = new BarrierStore();
    const server = serverOver(store, [async () => undefined]);
    const id = await cartOrder(server);
    store.arm("SalesOrder", 2);
    const [a, b] = await Promise.all([
      invoke(server, "salesOrder.update", { params: { id }, body: { channel: "online" } }),
      invoke(server, "salesOrder.update", { params: { id }, body: { channel: "phone" } }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });
});

/**
 * Holds every write whose patch names `field` until a tick has passed, so a concurrent writer that
 * read at the same moment commits first — the ordering in which the edit's read is the stale one.
 */
class LateEditStore extends BarrierStore {
  constructor(private readonly field: string) {
    super();
  }

  override async update(t: string, e: string, id: string, patch: EntityRecord): Promise<EntityRecord | null> {
    if (this.field in patch) await new Promise((r) => setTimeout(r, 5));
    return super.update(t, e, id, patch);
  }

  override async updateIf(
    t: string,
    e: string,
    id: string,
    patch: EntityRecord,
    expected: Readonly<Record<string, unknown>>,
  ): ReturnType<InMemoryEntityStore["updateIf"]> {
    if (this.field in patch) await new Promise((r) => setTimeout(r, 5));
    return super.updateIf(t, e, id, patch, expected);
  }
}

describe("an update racing a transition", () => {
  it("does not let an edit decided on an unlocked read land on the order a transition locked", async () => {
    // Both read `cart`; `place` writes first. Without a state precondition the edit's guard had
    // passed on `cart` and its write then landed on a `placed` order, a locked state — measured as
    // [200, 200] with the placed order's channel rewritten.
    const store = new LateEditStore("channel");
    const server = serverOver(store, [async () => undefined]);
    const id = await cartOrder(server);
    store.arm("SalesOrder", 2);
    const [edit, place] = await Promise.all([
      invoke(server, "salesOrder.update", { params: { id }, body: { channel: "online" } }),
      invoke(server, "salesOrder.place", { params: { id } }),
    ]);
    const final = await store.get(TENANT, "SalesOrder", id);
    expect(final?.["state"]).toBe("placed");
    expect(place.status).toBe(200);
    expect(edit.status).toBe(409);
    expect(bodyOf(edit)["error"]).toBe("state_changed");
    expect(final?.["channel"]).toBe("in_store");
  });

  it("still answers a tokened edit that lost to a transition with the optimistic-concurrency conflict", async () => {
    const store = new LateEditStore("channel");
    const server = serverOver(store, [async () => undefined]);
    const id = await cartOrder(server);
    await store.update(TENANT, "SalesOrder", id, { updated_at: "2026-01-01T00:00:00.000Z" });
    store.arm("SalesOrder", 2);
    const [edit] = await Promise.all([
      invoke(server, "salesOrder.update", {
        params: { id },
        body: { channel: "online", expectedUpdatedAt: "2026-01-01T00:00:00.000Z" },
      }),
      invoke(server, "salesOrder.place", { params: { id } }),
    ]);
    expect(edit.status).toBe(409);
    expect(bodyOf(edit)["error"]).toBe("conflict");
  });
});

describe("InMemoryEntityStore.updateIf", () => {
  it("writes only while every expected field still holds what it was read as", async () => {
    const store = new InMemoryEntityStore();
    const r = await store.create(TENANT, "Doc", { state: "draft", n: 1 });
    const id = String(r["id"]);
    expect(await store.updateIf(TENANT, "Doc", id, { state: "sent" }, { state: "draft" })).toMatchObject({
      kind: "updated",
      record: { state: "sent", n: 1 },
    });
    expect(await store.updateIf(TENANT, "Doc", id, { state: "void" }, { state: "draft" })).toEqual({
      kind: "precondition_failed",
    });
    expect((await store.get(TENANT, "Doc", id))?.["state"]).toBe("sent");
    expect(await store.updateIf(TENANT, "Doc", "missing", { state: "x" }, {})).toEqual({ kind: "not_found" });
  });

  it("reads an absent field and a null as the same value, and nothing else as either", async () => {
    const store = new InMemoryEntityStore();
    const r = await store.create(TENANT, "Doc", { n: 1 });
    const id = String(r["id"]);
    expect((await store.updateIf(TENANT, "Doc", id, { n: 2 }, { state: null })).kind).toBe("updated");
    expect((await store.updateIf(TENANT, "Doc", id, { n: 3 }, { state: undefined })).kind).toBe("updated");
    expect((await store.updateIf(TENANT, "Doc", id, { n: 4 }, { state: "" })).kind).toBe("precondition_failed");
    expect((await store.updateIf(TENANT, "Doc", id, { n: 5 }, { n: "3" })).kind).toBe("precondition_failed");
  });
});
