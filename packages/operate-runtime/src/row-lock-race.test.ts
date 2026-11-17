import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import { compileOperateServer, type CompiledOperateServer } from "./compile.js";
import { routeFromSpec } from "./operations.js";
import { InMemoryEntityStore, type EntityRecord, type ListPage, type ListQuery } from "./store.js";
import type { WriteEffect } from "./write-effects.js";

/**
 * The races ADR-0422 left open: a delete decided on a state a transition then leaves, and a line
 * written onto a draft parent that a concurrent `post` makes final. Each test holds one request at
 * the point where the defect needs the other to land, so the outcome depends only on whether the
 * two are serialised.
 */

const TENANT = "00000000-0000-4000-8000-000000000001";
const ACCOUNT = "00000000-0000-4000-8000-0000000000ac";

const registry: ManifestRegistry = {
  async getManifest(id: string): Promise<Manifest | null> {
    return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
  },
};
const retail = await resolveManifest(buildErpRetailPack(), { registry });
const core = buildErpCorePack();

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

function serverOver(manifest: Manifest, store: InMemoryEntityStore, effects: readonly WriteEffect[] = []): CompiledOperateServer {
  return compileOperateServer(manifest, {
    store,
    clock: { now: () => new Date("2026-06-15T12:00:00.000Z") },
    principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
    ...(effects.length > 0 ? { additionalWriteEffects: effects } : {}),
  });
}

async function invoke(
  server: CompiledOperateServer,
  role: string,
  opId: string,
  opts: { params?: Record<string, string>; body?: Record<string, unknown> } = {},
): Promise<HandlerOutput> {
  const spec = server.routeSpecs.find((s) => s.operationId === opId);
  if (spec === undefined) throw new Error(`no route for ${opId}`);
  const request = buildIncomingRequest({
    id: "req_rowlock00001",
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
  return server.handlers.resolve(opId)!({
    request,
    route: routeFromSpec(spec),
    principal: principal(role),
    params: opts.params ?? {},
    parsedBody: opts.body ?? null,
  });
}

function statusAndError(out: HandlerOutput): [number, string | null] {
  if (out.kind !== "json") return [out.status, null];
  const body = out.body as { error?: unknown };
  return [out.status, typeof body.error === "string" ? body.error : null];
}

/** Signals once an armed call is reached, then holds it for a few ticks before letting it finish. */
class Hold {
  private resolveReached!: () => void;
  readonly reached = new Promise<void>((resolve) => {
    this.resolveReached = resolve;
  });
  private fired = false;

  async at(): Promise<void> {
    if (this.fired) return;
    this.fired = true;
    this.resolveReached();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

class HeldStore extends InMemoryEntityStore {
  afterLinesRead: Hold | null = null;
  beforeLineCreate: Hold | null = null;
  beforeRemove: Hold | null = null;

  override async listPage(tenantId: string, entity: string, query: ListQuery): Promise<ListPage> {
    const page = await super.listPage(tenantId, entity, query);
    if (entity === "JournalLine" && this.afterLinesRead !== null) await this.afterLinesRead.at();
    return page;
  }

  override async create(tenantId: string, entity: string, record: EntityRecord): Promise<EntityRecord> {
    if (entity === "JournalLine" && this.beforeLineCreate !== null) await this.beforeLineCreate.at();
    return super.create(tenantId, entity, record);
  }

  override async removeIf(
    tenantId: string,
    entity: string,
    id: string,
    expected: Readonly<Record<string, unknown>>,
  ): ReturnType<InMemoryEntityStore["removeIf"]> {
    if (this.beforeRemove !== null) await this.beforeRemove.at();
    return super.removeIf(tenantId, entity, id, expected);
  }

  override async remove(tenantId: string, entity: string, id: string): Promise<boolean> {
    if (this.beforeRemove !== null) await this.beforeRemove.at();
    return super.remove(tenantId, entity, id);
  }
}

async function balancedDraft(server: CompiledOperateServer): Promise<string> {
  const je = await invoke(server, "erp_admin", "journalEntry.create", {
    body: { entry_number: "M-1", entry_date: "2026-06-15", source: "manual" },
  });
  expect(je.status).toBe(201);
  const id = String((je as { body: EntityRecord }).body["id"]);
  for (const [debit, credit] of [["10.00", "0.00"], ["0.00", "10.00"]]) {
    expect((await invoke(server, "erp_admin", "journalLine.create", { body: line(id, debit!, credit!) })).status).toBe(201);
  }
  return id;
}

function line(entryId: string, debit: string, credit: string): Record<string, unknown> {
  return {
    journal_entry_id: entryId,
    ledger_account_id: ACCOUNT,
    currency: "USD",
    debit,
    credit,
    functional_debit: debit,
    functional_credit: credit,
  };
}

async function sums(store: InMemoryEntityStore, entryId: string): Promise<[number, number, number]> {
  const lines = (await store.list(TENANT, "JournalLine")).filter((l) => l["journal_entry_id"] === entryId);
  const dr = lines.reduce((s, l) => s + Number(l["debit"] ?? 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l["credit"] ?? 0), 0);
  return [lines.length, dr, cr];
}

describe("a line written while its parent is posted", () => {
  it("waits for a post already reading the lines, then is refused on the posted parent", async () => {
    // Measured before as a draft entry posted Dr 1009 / Cr 10: the line committed after the balance
    // read and before the post's write. Now the post holds the entry exclusively while it reads, so
    // the line's share lock on the parent waits for the post to commit and then reads `posted`.
    const store = new HeldStore();
    const server = serverOver(core, store);
    const id = await balancedDraft(server);
    const hold = new Hold();
    store.afterLinesRead = hold;
    const post = invoke(server, "erp_admin", "journalEntry.post", { params: { id } });
    await hold.reached;
    const added = invoke(server, "erp_admin", "journalLine.create", { body: line(id, "999.00", "0.00") });
    const [p, a] = await Promise.all([post, added]);
    expect(p.status).toBe(200);
    expect(statusAndError(a)[0]).toBe(422);
    expect((await store.get(TENANT, "JournalEntry", id))?.["state"]).toBe("posted");
    expect(await sums(store, id)).toEqual([2, 10, 10]);
  });

  it("makes a post that arrives while a line is being written read that line", async () => {
    // The other order: the line holds the entry `share` and has not committed. The post's exclusive
    // lock waits for it, then its balance read sees the line and refuses the entry it unbalanced.
    const store = new HeldStore();
    const server = serverOver(core, store);
    const id = await balancedDraft(server);
    const hold = new Hold();
    store.beforeLineCreate = hold;
    const added = invoke(server, "erp_admin", "journalLine.create", { body: line(id, "999.00", "0.00") });
    await hold.reached;
    const post = invoke(server, "erp_admin", "journalEntry.post", { params: { id } });
    const [a, p] = await Promise.all([added, post]);
    expect(a.status).toBe(201);
    expect(statusAndError(p)).toEqual([422, "unbalanced_journal_entry"]);
    expect((await store.get(TENANT, "JournalEntry", id))?.["state"]).toBe("draft");
    expect(await sums(store, id)).toEqual([3, 1009, 10]);
  });
});

describe("a delete racing a transition", () => {
  async function cartOrder(server: CompiledOperateServer): Promise<string> {
    const created = await invoke(server, "retail_admin", "salesOrder.create", {
      body: { store_id: "st1", order_number: "SO-DEL", state: "cart", channel: "in_store", currency: "USD", total: 0 },
    });
    expect(created.status).toBe(201);
    return String((created as { body: EntityRecord }).body["id"]);
  }

  it("loses to a transition that moved the record after the delete read it", async () => {
    // Measured before as 204 and 200: the placement's effect ran and the order it ran for was gone.
    const store = new HeldStore();
    const fired: string[] = [];
    const server = serverOver(retail, store, [
      async (input) => {
        if (input.operation === "transition" && input.transitionTo === "placed") fired.push(String(input.id));
      },
    ]);
    const id = await cartOrder(server);
    const hold = new Hold();
    store.beforeRemove = hold;
    const del = invoke(server, "retail_admin", "salesOrder.delete", { params: { id } });
    await hold.reached;
    const place = await invoke(server, "retail_admin", "salesOrder.place", { params: { id } });
    const deleted = await del;
    expect(place.status).toBe(200);
    expect(statusAndError(deleted)).toEqual([409, "state_changed"]);
    expect(fired).toEqual([id]);
    expect((await store.get(TENANT, "SalesOrder", id))?.["state"]).toBe("placed");
  });

  it("still deletes a record nobody moved", async () => {
    const store = new HeldStore();
    const server = serverOver(retail, store);
    const id = await cartOrder(server);
    expect((await invoke(server, "retail_admin", "salesOrder.delete", { params: { id } })).status).toBe(204);
    expect(await store.get(TENANT, "SalesOrder", id)).toBeNull();
  });
});

describe("two transitions on one record", () => {
  it("are serialised by the record lock, so the second reads the first's state", async () => {
    // Without the lock both read `cart` and the compare-and-set refuses the loser as
    // `transition_conflict`; with it the loser does not read until the winner commits, so it is
    // refused from the state it can see.
    class SlowRead extends InMemoryEntityStore {
      override async get(tenantId: string, entity: string, id: string): Promise<EntityRecord | null> {
        const read = await super.get(tenantId, entity, id);
        if (entity === "SalesOrder") await new Promise((resolve) => setTimeout(resolve, 10));
        return read;
      }
    }
    const store = new SlowRead();
    const server = serverOver(retail, store);
    const created = await invoke(server, "retail_admin", "salesOrder.create", {
      body: { store_id: "st1", order_number: "SO-TT", state: "cart", channel: "in_store", currency: "USD", total: 0 },
    });
    const id = String((created as { body: EntityRecord }).body["id"]);
    const outs = await Promise.all([
      invoke(server, "retail_admin", "salesOrder.place", { params: { id } }),
      invoke(server, "retail_admin", "salesOrder.place", { params: { id } }),
    ]);
    expect(outs.map(statusAndError).sort()).toEqual([
      [200, null],
      [409, "invalid_transition"],
    ]);
  });
});

describe("InMemoryEntityStore row locks", () => {
  const key = { t: TENANT, e: "Doc" };

  it("holds an exclusive lock until its transaction ends, and lets shares coexist", async () => {
    const store = new InMemoryEntityStore();
    const r = await store.create(key.t, key.e, { n: 1 });
    const id = String(r["id"]);
    const order: string[] = [];
    let releaseA!: () => void;
    const aHolding = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aLocked!: () => void;
    const aHasLock = new Promise<void>((resolve) => {
      aLocked = resolve;
    });
    const a = store.withTransaction(TENANT, async (tx) => {
      await tx.getLocked(key.t, key.e, id, "exclusive");
      order.push("a-locked");
      aLocked();
      await aHolding;
      order.push("a-done");
    });
    await aHasLock;
    const b = store.withTransaction(TENANT, async (tx) => {
      await tx.getLocked(key.t, key.e, id, "share");
      order.push("b-locked");
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["a-locked"]);
    releaseA();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-locked", "a-done", "b-locked"]);

    const shares: string[] = [];
    let releaseC!: () => void;
    const cHolding = new Promise<void>((resolve) => {
      releaseC = resolve;
    });
    const c = store.withTransaction(TENANT, async (tx) => {
      await tx.getLocked(key.t, key.e, id, "share");
      shares.push("c");
      await cHolding;
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    await store.withTransaction(TENANT, async (tx) => {
      await tx.getLocked(key.t, key.e, id, "share");
      shares.push("d");
    });
    expect(shares).toEqual(["c", "d"]);
    releaseC();
    await c;
  });

  it("releases the locks of a transaction that throws", async () => {
    const store = new InMemoryEntityStore();
    const id = String((await store.create(key.t, key.e, { n: 1 }))["id"]);
    await expect(
      store.withTransaction(TENANT, async (tx) => {
        await tx.getLocked(key.t, key.e, id, "exclusive");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const read = await store.withTransaction(TENANT, (tx) => tx.getLocked(key.t, key.e, id, "exclusive"));
    expect(read?.["n"]).toBe(1);
  });

  it("takes no lock outside a transaction, and lets a holder strengthen its own share", async () => {
    const store = new InMemoryEntityStore();
    const id = String((await store.create(key.t, key.e, { n: 1 }))["id"]);
    expect((await store.getLocked(key.t, key.e, id, "exclusive"))?.["n"]).toBe(1);
    expect((await store.getLocked(key.t, key.e, id, "exclusive"))?.["n"]).toBe(1);
    const both = await store.withTransaction(TENANT, async (tx) => {
      await tx.getLocked(key.t, key.e, id, "share");
      return tx.getLocked(key.t, key.e, id, "exclusive");
    });
    expect(both?.["n"]).toBe(1);
  });
});

describe("InMemoryEntityStore.removeIf", () => {
  it("removes only while every expected field still holds what it was read as", async () => {
    const store = new InMemoryEntityStore();
    const id = String((await store.create(TENANT, "Doc", { state: "draft" }))["id"]);
    expect(await store.removeIf(TENANT, "Doc", id, { state: "sent" })).toEqual({ kind: "precondition_failed" });
    expect(await store.get(TENANT, "Doc", id)).not.toBeNull();
    expect(await store.removeIf(TENANT, "Doc", id, { state: "draft" })).toEqual({ kind: "removed" });
    expect(await store.get(TENANT, "Doc", id)).toBeNull();
    expect(await store.removeIf(TENANT, "Doc", id, {})).toEqual({ kind: "not_found" });
  });
});
