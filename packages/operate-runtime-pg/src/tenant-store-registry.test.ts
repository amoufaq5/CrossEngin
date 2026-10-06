import type { PgConnection } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import {
  isAssociationCounter,
  isAssociationReader,
  isAssociationWriter,
  isTransactional,
  type EntityRecord,
  type EntityStore,
  type ListPage,
  type ListQuery,
} from "@crossengin/operate-runtime";
import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import {
  COLUMN_ENCRYPTION_KEY_SETTING,
  ColumnEncryptionUnavailable,
  ColumnMappedEntityStore,
  encryptedEntityNames,
} from "./column-store.js";
import { tenantSchemaName } from "./tenant-schema.js";
import type { TenantSchemaApplication } from "./tenant-schema-apply.js";
import {
  PlaintextFallbackRefused,
  TenantColumnStoreRegistry,
  TenantColumnStoreRouter,
} from "./tenant-store-registry.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const OTHER = "11111111-2222-4333-8444-555555555555";

const WIDGET: Entity = {
  name: "Widget",
  fields: [{ name: "sku", type: { kind: "text" }, required: true }],
};

const V1 = { entities: [WIDGET] } as unknown as Manifest;
const V2 = {
  entities: [{ ...WIDGET, fields: [...WIDGET.fields, { name: "note", type: { kind: "text" } }] }],
} as unknown as Manifest;

interface Captured {
  readonly conn: PgConnection;
  readonly sqls: string[];
  /** Every statement with its bound parameters, so a bound key is observable. */
  readonly calls: { sql: string; params: readonly unknown[] }[];
  /** Rows the introspection query answers with, settable per test. */
  setLive: (rows: readonly Record<string, unknown>[]) => void;
}

function capturePg(): Captured {
  const sqls: string[] = [];
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  let live: readonly Record<string, unknown>[] = [];
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      sqls.push(sql);
      calls.push({ sql, params: params ?? [] });
      if (sql.includes("pg_catalog.format_type")) return { rows: live, rowCount: live.length };
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, sqls, calls, setLive: (rows) => (live = rows) };
}

function driftedWidget(): readonly Record<string, unknown>[] {
  return [
    { table_name: "widget", column_name: "tenant_id", formatted_type: "uuid", not_null: true },
    { table_name: "widget", column_name: "id", formatted_type: "text", not_null: true },
    // declared TEXT, live integer → a blocking type change
    { table_name: "widget", column_name: "sku", formatted_type: "integer", not_null: true },
  ];
}

describe("TenantColumnStoreRegistry", () => {
  it("names the tenant's schema from the tenant id", () => {
    const registry = new TenantColumnStoreRegistry(capturePg().conn);
    expect(registry.schemaFor(TENANT)).toBe(tenantSchemaName(TENANT));
  });

  it("applies on the first ensure and returns a store bound to that schema", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn);
    const application = await registry.ensure(TENANT, V1);
    expect(application.applied).toBe(true);
    expect(cap.sqls.join("\n")).toContain(`CREATE TABLE IF NOT EXISTS "${tenantSchemaName(TENANT)}"."widget"`);
    expect(registry.storeFor(TENANT)).toBeInstanceOf(ColumnMappedEntityStore);
  });

  it("memoises on the manifest hash: a second ensure sends no SQL", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn);
    await registry.ensure(TENANT, V1);
    const sent = cap.sqls.length;
    const again = await registry.ensure(TENANT, V1);
    expect(cap.sqls.length).toBe(sent);
    expect(again.applied).toBe(true);
  });

  it("re-applies when the manifest changes, so a second activation gains its fields", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn);
    await registry.ensure(TENANT, V1);
    const before = cap.sqls.length;
    await registry.ensure(TENANT, V2);
    const added = cap.sqls.slice(before).join("\n");
    expect(added).toContain('ADD COLUMN IF NOT EXISTS "note" TEXT;');
  });

  it("rebuilds the store for the new manifest, so the new field is served", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn);
    await registry.ensure(TENANT, V1);
    const first = registry.storeFor(TENANT);
    await registry.ensure(TENANT, V2);
    expect(registry.storeFor(TENANT)).not.toBe(first);
  });

  it("keeps each tenant in its own schema", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn);
    await registry.ensure(TENANT, V1);
    await registry.ensure(OTHER, V1);
    expect(cap.sqls.join("\n")).toContain(`"${tenantSchemaName(TENANT)}"."widget"`);
    expect(cap.sqls.join("\n")).toContain(`"${tenantSchemaName(OTHER)}"."widget"`);
    expect(registry.schemaFor(TENANT)).not.toBe(registry.schemaFor(OTHER));
  });

  it("reports a refusal and exposes no store for it", async () => {
    const cap = capturePg();
    cap.setLive(driftedWidget());
    const seen: TenantSchemaApplication[] = [];
    const registry = new TenantColumnStoreRegistry(cap.conn, { onApplication: (a) => seen.push(a) });
    const application = await registry.ensure(TENANT, V1);
    expect(application.applied).toBe(false);
    expect(registry.storeFor(TENANT)).toBeNull();
    expect(seen.map((a) => a.applied)).toEqual([false]);
  });

  it("memoises a refusal so every request does not re-introspect", async () => {
    const cap = capturePg();
    cap.setLive(driftedWidget());
    const registry = new TenantColumnStoreRegistry(cap.conn, { now: () => 1_000 });
    await registry.ensure(TENANT, V1);
    const sent = cap.sqls.length;
    await registry.ensure(TENANT, V1);
    expect(cap.sqls.length).toBe(sent);
  });

  it("retries a refusal once it expires, so a hand-reconciled schema is picked up without a restart", async () => {
    const cap = capturePg();
    cap.setLive(driftedWidget());
    let now = 1_000;
    const registry = new TenantColumnStoreRegistry(cap.conn, {
      refusalRetryMs: 500,
      now: () => now,
    });
    expect((await registry.ensure(TENANT, V1)).applied).toBe(false);
    now = 2_000;
    cap.setLive([]); // operator ran the reported ALTER; the column now matches
    expect((await registry.ensure(TENANT, V1)).applied).toBe(true);
    expect(registry.storeFor(TENANT)).not.toBeNull();
  });

  it("does not expose a store for a tenant whose refusal has expired", async () => {
    const cap = capturePg();
    cap.setLive(driftedWidget());
    let now = 1_000;
    const registry = new TenantColumnStoreRegistry(cap.conn, { refusalRetryMs: 500, now: () => now });
    await registry.ensure(TENANT, V1);
    now = 2_000;
    expect(registry.storeFor(TENANT)).toBeNull();
  });

  it("exposes no store for a tenant that was never ensured", () => {
    const registry = new TenantColumnStoreRegistry(capturePg().conn);
    expect(registry.storeFor(TENANT)).toBeNull();
    expect(registry.applicationFor(TENANT)).toBeNull();
  });

  it("collapses concurrent first ensures for one tenant into one application", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn);
    const [a, b] = await Promise.all([registry.ensure(TENANT, V1), registry.ensure(TENANT, V1)]);
    expect(a).toBe(b);
    expect(cap.sqls.filter((s) => s.startsWith("CREATE SCHEMA"))).toHaveLength(1);
  });

  it("forget() makes the next ensure re-apply", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn);
    await registry.ensure(TENANT, V1);
    const sent = cap.sqls.length;
    registry.forget(TENANT);
    expect(registry.storeFor(TENANT)).toBeNull();
    await registry.ensure(TENANT, V1);
    expect(cap.sqls.length).toBeGreaterThan(sent);
  });

  it("clear() drops every tenant", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn);
    await registry.ensure(TENANT, V1);
    await registry.ensure(OTHER, V1);
    registry.clear();
    expect(registry.storeFor(TENANT)).toBeNull();
    expect(registry.storeFor(OTHER)).toBeNull();
  });

  it("passes the encryption key reference through to each tenant's store", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn, {
      encryptionKeyRef: "current_setting('app.k')",
    });
    await registry.ensure(TENANT, V1);
    const store = registry.storeFor(TENANT);
    expect(store).not.toBeNull();
    await store?.get(TENANT, "Widget", "w1");
    expect(cap.sqls.join("\n")).toContain("SELECT");
  });

  it("uses a resolveSchema override, so a tenant does not own two schema names", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn, {
      resolveSchema: async (tenantId) => `t_slug_${tenantId.slice(0, 4)}`,
    });
    const application = await registry.ensure(TENANT, V1);
    expect(application.schema).toBe("t_slug_3f2a");
    expect(cap.sqls.join("\n")).toContain('CREATE TABLE IF NOT EXISTS "t_slug_3f2a"."widget"');
    // schemaFor() still reports the id-derived default it replaced.
    expect(registry.schemaFor(TENANT)).toBe(tenantSchemaName(TENANT));
    expect(registry.applicationFor(TENANT)?.schema).toBe("t_slug_3f2a");
  });

  it("refuses a non-uuid tenant id", async () => {
    const registry = new TenantColumnStoreRegistry(capturePg().conn);
    await expect(registry.ensure("acme", V1)).rejects.toThrow(/canonical UUID/);
    expect(() => registry.schemaFor("acme")).toThrow(/canonical UUID/);
  });
});

/** Records which store a call landed on, so the router's routing is observable. */
class RecordingStore implements EntityStore {
  readonly calls: string[] = [];
  constructor(private readonly label: string) {}
  async list(): Promise<readonly EntityRecord[]> {
    this.calls.push(`${this.label}:list`);
    return [];
  }
  async listPage(_t: string, _e: string, _q: ListQuery): Promise<ListPage> {
    this.calls.push(`${this.label}:listPage`);
    return { records: [], nextCursor: null };
  }
  async get(): Promise<EntityRecord | null> {
    this.calls.push(`${this.label}:get`);
    return null;
  }
  async create(_t: string, _e: string, record: EntityRecord): Promise<EntityRecord> {
    this.calls.push(`${this.label}:create`);
    return record;
  }
  async update(): Promise<EntityRecord | null> {
    this.calls.push(`${this.label}:update`);
    return null;
  }
  async remove(): Promise<boolean> {
    this.calls.push(`${this.label}:remove`);
    return false;
  }
}

describe("TenantColumnStoreRouter", () => {
  async function routed(): Promise<{
    router: TenantColumnStoreRouter;
    registry: TenantColumnStoreRegistry;
    fallback: RecordingStore;
    cap: Captured;
  }> {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn);
    const fallback = new RecordingStore("fallback");
    await registry.ensure(TENANT, V1);
    return { router: new TenantColumnStoreRouter({ registry, fallback }), registry, fallback, cap };
  }

  it("sends an ensured tenant to their own schema", async () => {
    const { router, cap } = await routed();
    cap.sqls.length = 0;
    await router.get(TENANT, "Widget", "w1");
    expect(cap.sqls.join("\n")).toContain(`FROM "${tenantSchemaName(TENANT)}"."widget"`);
  });

  it("sends a tenant with no ensured manifest to the fallback", async () => {
    const { router, fallback } = await routed();
    await router.get(OTHER, "Widget", "w1");
    expect(fallback.calls).toEqual(["fallback:get"]);
  });

  it("reports which tenants are served from their own tables", async () => {
    const { router } = await routed();
    expect(router.isTenantScoped(TENANT)).toBe(true);
    expect(router.isTenantScoped(OTHER)).toBe(false);
  });

  it("follows a re-activation immediately: routing is per call, not per gateway", async () => {
    const { router, registry, cap } = await routed();
    await registry.ensure(TENANT, V2);
    cap.sqls.length = 0;
    await router.get(TENANT, "Widget", "w1");
    // V2's `note` column is selected only if the router picked up the new store.
    expect(cap.sqls.join("\n")).toContain('"note"');
  });

  it("falls back after forget(), rather than failing the request", async () => {
    const { router, registry, fallback } = await routed();
    registry.forget(TENANT);
    await router.list(TENANT, "Widget");
    expect(fallback.calls).toEqual(["fallback:list"]);
  });

  it("routes every EntityStore method", async () => {
    const { router, fallback } = await routed();
    await router.list(OTHER, "Widget");
    await router.listPage(OTHER, "Widget", { limit: 10, cursor: null, sort: [], filters: [] });
    await router.get(OTHER, "Widget", "w");
    await router.create(OTHER, "Widget", { id: "w" });
    await router.update(OTHER, "Widget", "w", {});
    await router.remove(OTHER, "Widget", "w");
    expect(fallback.calls).toEqual([
      "fallback:list",
      "fallback:listPage",
      "fallback:get",
      "fallback:create",
      "fallback:update",
      "fallback:remove",
    ]);
  });

  it("satisfies every capability check a handler makes, so no route silently narrows", async () => {
    const { router } = await routed();
    expect(isTransactional(router)).toBe(true);
    expect(isAssociationReader(router)).toBe(true);
    expect(isAssociationWriter(router)).toBe(true);
    expect(isAssociationCounter(router)).toBe(true);
  });

  it("runs an atomic unit on the tenant's own store", async () => {
    const { router, cap } = await routed();
    cap.sqls.length = 0;
    await router.withTransaction(TENANT, async (tx) => {
      await tx.get(TENANT, "Widget", "w1");
    });
    expect(cap.sqls.join("\n")).toContain(`FROM "${tenantSchemaName(TENANT)}"."widget"`);
  });

  it("still runs the unit when the fallback offers no transaction", async () => {
    const { router, fallback } = await routed();
    const seen: string[] = [];
    await router.withTransaction(OTHER, async (tx) => {
      await tx.get(OTHER, "Widget", "w");
      seen.push("ran");
    });
    expect(seen).toEqual(["ran"]);
    expect(fallback.calls).toEqual(["fallback:get"]);
  });

  it("refuses an association call the serving store cannot answer, instead of answering wrongly", async () => {
    const { router } = await routed();
    await expect(router.listLinks(OTHER, "Widget", "Gadget")).rejects.toThrow(/association reads/);
    await expect(router.countLinks(OTHER, "Widget", "Gadget")).rejects.toThrow(/association counts/);
    await expect(router.link(OTHER, "Widget", "Gadget", "a", "b")).rejects.toThrow(/association writes/);
    await expect(router.unlink(OTHER, "Widget", "Gadget", "a", "b")).rejects.toThrow(/association writes/);
    await expect(router.isLinked(OTHER, "Widget", "Gadget", "a", "b")).rejects.toThrow(/association checks/);
  });

  it("refuses an unensured tenant outright when there is no fallback", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn);
    const router = new TenantColumnStoreRouter({ registry });
    await expect(router.get(TENANT, "Widget", "w")).rejects.toThrow(/no fallback store is configured/);
  });
});

/** A manifest declaring one `phi` field, so its entity needs a key and ciphertext. */
const PHI_WIDGET: Entity = {
  name: "Widget",
  fields: [
    { name: "sku", type: { kind: "text" }, required: true },
    { name: "mrn", type: { kind: "text" }, classification: "phi" },
  ],
};
const PHI_V1 = { entities: [PHI_WIDGET] } as unknown as Manifest;

describe("TenantColumnStoreRegistry — the per-tenant column key", () => {
  it("passes the resolver through, so the tenant's store binds that tenant's key", async () => {
    const cap = capturePg();
    const seen: string[] = [];
    const registry = new TenantColumnStoreRegistry(cap.conn, {
      encryptionKey: (tenantId) => {
        seen.push(tenantId);
        return `key-${tenantId}`;
      },
    });
    await registry.ensure(TENANT, PHI_V1);
    const store = registry.storeFor(TENANT);
    expect(store).toBeInstanceOf(ColumnMappedEntityStore);
    await store?.get(TENANT, "Widget", "w1");
    // The resolver is called with the tenant the store serves, and its answer is bound — never in
    // the SQL text, which is what keeps a key out of `log_statement` and `pg_stat_statements`.
    expect(seen).toEqual([TENANT]);
    const keySet = cap.calls.find((c) => c.params[0] === COLUMN_ENCRYPTION_KEY_SETTING);
    expect(keySet?.params).toEqual([COLUMN_ENCRYPTION_KEY_SETTING, `key-${TENANT}`]);
    expect(cap.sqls.join("\n")).not.toContain(`key-${TENANT}`);
  });

  it("resolves per tenant, so two tenants' stores carry two keys", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn, {
      encryptionKey: (tenantId) => `key-${tenantId}`,
    });
    await registry.ensure(TENANT, PHI_V1);
    await registry.ensure(OTHER, PHI_V1);
    await registry.storeFor(TENANT)?.get(TENANT, "Widget", "w1");
    await registry.storeFor(OTHER)?.get(OTHER, "Widget", "w1");
    expect(
      cap.calls.filter((c) => c.params[0] === COLUMN_ENCRYPTION_KEY_SETTING).map((c) => c.params[1]),
    ).toEqual([`key-${TENANT}`, `key-${OTHER}`]);
  });

  it("refuses a PHI manifest with no key and no custom ref, rather than applying a schema it cannot serve", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn);
    await expect(registry.ensure(TENANT, PHI_V1)).rejects.toThrow(ColumnEncryptionUnavailable);
  });

  it("keeps encryptionKeyRef working on its own, unchanged", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn, { encryptionKeyRef: "$$kref$$" });
    await registry.ensure(TENANT, PHI_V1);
    await registry.storeFor(TENANT)?.get(TENANT, "Widget", "w1");
    expect(cap.sqls.join("\n")).toContain("$$kref$$");
    // The custom route owns the key, so this registry sets no key GUC — only the tenant context.
    expect(cap.calls.filter((c) => c.params[0] === COLUMN_ENCRYPTION_KEY_SETTING)).toHaveLength(0);
  });

  it("does not disturb a manifest with no encrypted column", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn, { encryptionKey: () => "k" });
    await registry.ensure(TENANT, V1);
    await registry.storeFor(TENANT)?.get(TENANT, "Widget", "w1");
    expect(cap.calls.filter((c) => c.params[0] === COLUMN_ENCRYPTION_KEY_SETTING)).toHaveLength(0);
  });

  it("re-reads the resolver on the next application, which is what forget() is for", async () => {
    const cap = capturePg();
    let generation = 1;
    const registry = new TenantColumnStoreRegistry(cap.conn, {
      encryptionKey: () => `gen-${generation.toString()}`,
    });
    await registry.ensure(TENANT, PHI_V1);
    generation = 2;
    // An applied entry's `validUntil` is Infinity, so `ensure` is a map hit and builds no new
    // store — but `encryptionKey` is a *function* the store calls per op, so the new answer is
    // picked up anyway. What `forget` buys is a store built around a *different resolver*.
    await registry.ensure(TENANT, PHI_V1);
    await registry.storeFor(TENANT)?.get(TENANT, "Widget", "w1");
    expect(cap.calls.find((c) => c.params[0] === COLUMN_ENCRYPTION_KEY_SETTING)?.params[1]).toBe("gen-2");
  });
});

describe("encryptedEntityNames", () => {
  it("names the entities carrying an at-rest-encrypted column", () => {
    expect([...encryptedEntityNames(PHI_V1)]).toEqual(["Widget"]);
  });

  it("is empty for a manifest with no classified field", () => {
    expect(encryptedEntityNames(V1).size).toBe(0);
  });

  it("leaves a non-encrypted classification out", () => {
    const manifest = {
      entities: [
        {
          name: "Product",
          fields: [{ name: "unit_cost", type: { kind: "decimal", precision: 12, scale: 2 }, classification: "commercial_sensitive" }],
        },
      ],
    } as unknown as Manifest;
    // `requiresEncryptionAtRest` is the one rule; this asserts the helper reads it rather than
    // treating every classification as ciphertext, which would refuse the retail pack outright.
    expect(encryptedEntityNames(manifest).size).toBe(0);
  });
});

describe("TenantColumnStoreRouter — the plaintext fallback and PHI", () => {
  async function phiRouted(opts: { readonly declare: boolean }): Promise<{
    router: TenantColumnStoreRouter;
    registry: TenantColumnStoreRegistry;
    fallback: RecordingStore;
  }> {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn, { encryptionKey: () => "k" });
    const fallback = new RecordingStore("fallback");
    await registry.ensure(TENANT, PHI_V1);
    const router = new TenantColumnStoreRouter({
      registry,
      fallback,
      ...(opts.declare ? { encryptedEntities: encryptedEntityNames(PHI_V1) } : {}),
    });
    return { router, registry, fallback };
  }

  it("is a no-op when encryptedEntities is absent: every existing deployment unchanged", async () => {
    const { router, fallback } = await phiRouted({ declare: false });
    await router.get(OTHER, "Widget", "w1");
    await router.create(OTHER, "Widget", { id: "w1", mrn: "MRN-1" });
    expect(fallback.calls).toEqual(["fallback:get", "fallback:create"]);
  });

  it("refuses a write of an encrypted entity to the plaintext fallback", async () => {
    const { router, fallback } = await phiRouted({ declare: true });
    // Verified live: the JSONB fallback accepts this write, answers 201, and
    // `document->>'mrn'` reads the plaintext back. A silent downgrade from ciphertext to
    // plaintext is the compliance failure itself, so the router denies — CLAUDE.md's "fail closed".
    await expect(router.create(OTHER, "Widget", { id: "w1", mrn: "MRN-1" })).rejects.toThrow(
      PlaintextFallbackRefused,
    );
    expect(fallback.calls).toEqual([]);
  });

  it("refuses a READ too, because the fallback cannot hold what was written encrypted", async () => {
    const { router, fallback } = await phiRouted({ declare: true });
    // Not a degraded answer but a wrong one: the row lives in the tenant's own schema, so the
    // fallback answers absent for data that exists. ADR-0336's `IdempotencyStore.get` rule — not
    // knowing must not be reported as knowing.
    await expect(router.get(OTHER, "Widget", "w1")).rejects.toThrow(PlaintextFallbackRefused);
    await expect(router.list(OTHER, "Widget")).rejects.toThrow(PlaintextFallbackRefused);
    await expect(
      router.listPage(OTHER, "Widget", { limit: 10, cursor: null, sort: [], filters: [] }),
    ).rejects.toThrow(PlaintextFallbackRefused);
    expect(fallback.calls).toEqual([]);
  });

  it("refuses update and remove as well, so all six methods are covered", async () => {
    const { router } = await phiRouted({ declare: true });
    await expect(router.update(OTHER, "Widget", "w1", { mrn: "x" })).rejects.toThrow(
      PlaintextFallbackRefused,
    );
    await expect(router.remove(OTHER, "Widget", "w1")).rejects.toThrow(PlaintextFallbackRefused);
  });

  it("names the tenant and the entity, and carries no field value", async () => {
    const { router } = await phiRouted({ declare: true });
    let caught: unknown = null;
    try {
      await router.create(OTHER, "Widget", { id: "w1", mrn: "MRN-SECRET" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PlaintextFallbackRefused);
    const err = caught as PlaintextFallbackRefused;
    expect(err.name).toBe("PlaintextFallbackRefused");
    expect(err.tenantId).toBe(OTHER);
    expect(err.entity).toBe("Widget");
    expect(err.message).toContain(OTHER);
    expect(err.message).toContain("Widget");
    // ADR-0310's rule: a refusal about PHI must not quote the PHI. The record travelled past this
    // code and nothing of it is in the message.
    expect(err.message).not.toContain("MRN-SECRET");
  });

  it("still routes an UNencrypted entity to the fallback", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn, { encryptionKey: () => "k" });
    const fallback = new RecordingStore("fallback");
    const mixed = {
      entities: [PHI_WIDGET, { name: "Gadget", fields: [{ name: "label", type: { kind: "text" } }] }],
    } as unknown as Manifest;
    await registry.ensure(TENANT, mixed);
    const router = new TenantColumnStoreRouter({
      registry,
      fallback,
      encryptedEntities: encryptedEntityNames(mixed),
    });
    // The fallback is correct for an unplanned *ordinary* entity — ADR-0314's trade — and the
    // refusal must not widen into it.
    await router.get(OTHER, "Gadget", "g1");
    expect(fallback.calls).toEqual(["fallback:get"]);
  });

  it("routes an encrypted entity normally once the tenant's schema is applied", async () => {
    const cap = capturePg();
    const registry = new TenantColumnStoreRegistry(cap.conn, { encryptionKey: () => "k" });
    const fallback = new RecordingStore("fallback");
    await registry.ensure(TENANT, PHI_V1);
    const router = new TenantColumnStoreRouter({
      registry,
      fallback,
      encryptedEntities: encryptedEntityNames(PHI_V1),
    });
    cap.sqls.length = 0;
    await router.get(TENANT, "Widget", "w1");
    expect(cap.sqls.join("\n")).toContain(`FROM "${tenantSchemaName(TENANT)}"."widget"`);
    expect(fallback.calls).toEqual([]);
  });

  it("refuses inside withTransaction, where the callback holds the underlying store", async () => {
    const { router, fallback } = await phiRouted({ declare: true });
    // The callback is handed the *underlying* store, so its ops do not pass back through the
    // router — a guard only on the router's own six methods would be bypassed by every handler
    // running its guard → write → effect unit in a transaction, i.e. the ordinary write path.
    await expect(
      router.withTransaction(OTHER, async (tx) => tx.create(OTHER, "Widget", { id: "w1", mrn: "x" })),
    ).rejects.toThrow(PlaintextFallbackRefused);
    expect(fallback.calls).toEqual([]);
  });

  it("leaves an unencrypted entity usable inside withTransaction on the fallback", async () => {
    const { router, fallback } = await phiRouted({ declare: true });
    await router.withTransaction(OTHER, async (tx) => tx.get(OTHER, "Gadget", "g1"));
    expect(fallback.calls).toEqual(["fallback:get"]);
  });
});
