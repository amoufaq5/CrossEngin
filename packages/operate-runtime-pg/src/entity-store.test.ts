import type { PgConnection } from "@crossengin/kernel-pg";
import type { EntityRecord } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import { PostgresEntityStore } from "./entity-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";

interface BackingRow {
  tenant_id: string;
  entity: string;
  record_id: string;
  document: EntityRecord;
  seq: number;
}

/**
 * A fake `PgConnection` backed by an in-memory array that interprets the exact
 * SQL the store emits. It also enforces the RLS contract: a data query only
 * sees rows for the tenant set via `set_config` (the transaction context), so a
 * test that forgets to scope leaks nothing.
 */
function fakePg(): { conn: PgConnection; calls: string[] } {
  const backing: BackingRow[] = [];
  const calls: string[] = [];
  let seq = 0;
  let tenantCtx: string | null = null;

  const run = async (sql: string, params?: readonly unknown[]) => {
    calls.push(sql);
    const p = params ?? [];
    if (sql.includes("set_config")) {
      tenantCtx = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    const visible = backing.filter((r) => tenantCtx !== null && r.tenant_id === tenantCtx);
    if (sql.includes("count(*)")) {
      const n = visible.filter((r) => r.tenant_id === p[0] && r.entity === p[1]).length;
      return { rows: [{ n: String(n) }], rowCount: 1 };
    }
    if (sql.includes("SELECT document")) {
      let matched = visible.filter((r) => r.tenant_id === p[0] && r.entity === p[1]);
      if (p[2] !== undefined) matched = matched.filter((r) => r.record_id === p[2]);
      matched.sort((a, b) => a.seq - b.seq || a.record_id.localeCompare(b.record_id));
      return { rows: matched.map((r) => ({ document: r.document })), rowCount: matched.length };
    }
    if (sql.includes("INSERT INTO")) {
      backing.push({
        tenant_id: String(p[0]),
        entity: String(p[1]),
        record_id: String(p[2]),
        document: JSON.parse(String(p[3])) as EntityRecord,
        seq: seq++,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE")) {
      const row = backing.find((r) => r.tenant_id === p[0] && r.entity === p[1] && r.record_id === p[2]);
      if (row !== undefined) row.document = JSON.parse(String(p[3])) as EntityRecord;
      return { rows: [], rowCount: row === undefined ? 0 : 1 };
    }
    if (sql.includes("DELETE")) {
      const idx = backing.findIndex((r) => r.tenant_id === p[0] && r.entity === p[1] && r.record_id === p[2]);
      if (idx >= 0) {
        backing.splice(idx, 1);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };

  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      const before = tenantCtx;
      try {
        return await fn(conn);
      } finally {
        tenantCtx = before; // is_local => true: context resets at tx end
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, calls };
}

const PRODUCT: EntityRecord = { id: "prod-1", sku: "SKU-1", name: "Milk", unit_price: 2 };

describe("PostgresEntityStore — CRUD round-trips", () => {
  it("create then get returns the stored document", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    const created = await store.create(TENANT, "Product", PRODUCT);
    expect(created).toMatchObject({ id: "prod-1", sku: "SKU-1" });
    expect(await store.get(TENANT, "Product", "prod-1")).toEqual(PRODUCT);
  });

  it("mints an id when the record has none", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    const created = await store.create(TENANT, "Product", { sku: "S2" });
    expect(typeof created["id"]).toBe("string");
    expect(created["id"]).toMatch(/^rec_/);
    expect(await store.get(TENANT, "Product", created["id"] as string)).toMatchObject({ sku: "S2" });
  });

  it("get returns null for a missing record", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    expect(await store.get(TENANT, "Product", "nope")).toBeNull();
  });

  it("list returns all records for the (tenant, entity), ordered", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    await store.create(TENANT, "Product", { id: "a", sku: "A" });
    await store.create(TENANT, "Product", { id: "b", sku: "B" });
    const rows = await store.list(TENANT, "Product");
    expect(rows.map((r) => r["id"])).toEqual(["a", "b"]);
  });

  it("update merges the patch and pins the id", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    await store.create(TENANT, "Product", PRODUCT);
    const updated = await store.update(TENANT, "Product", "prod-1", { name: "Bread", id: "evil" });
    expect(updated).toMatchObject({ id: "prod-1", name: "Bread", sku: "SKU-1" });
    expect(await store.get(TENANT, "Product", "prod-1")).toMatchObject({ name: "Bread" });
  });

  it("update returns null for a missing record", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    expect(await store.update(TENANT, "Product", "nope", { name: "x" })).toBeNull();
  });

  it("remove deletes and reports whether a row was removed", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    await store.create(TENANT, "Product", PRODUCT);
    expect(await store.remove(TENANT, "Product", "prod-1")).toBe(true);
    expect(await store.remove(TENANT, "Product", "prod-1")).toBe(false);
    expect(await store.get(TENANT, "Product", "prod-1")).toBeNull();
  });

  it("count reports the number of records for a (tenant, entity)", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    await store.create(TENANT, "Product", { id: "a" });
    await store.create(TENANT, "Product", { id: "b" });
    expect(await store.count(TENANT, "Product")).toBe(2);
  });
});

describe("PostgresEntityStore — tenant isolation (RLS context)", () => {
  it("a record created in one tenant is invisible to another", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    await store.create(TENANT, "Product", PRODUCT);
    expect(await store.get(OTHER_TENANT, "Product", "prod-1")).toBeNull();
    expect(await store.list(OTHER_TENANT, "Product")).toEqual([]);
  });

  it("sets the tenant RLS context before every data query", async () => {
    const { conn, calls } = fakePg();
    const store = new PostgresEntityStore(conn);
    await store.get(TENANT, "Product", "prod-1");
    expect(calls[0]).toContain("set_config");
    expect(calls[1]).toContain("SELECT document");
  });
});

describe("PostgresEntityStore — configuration", () => {
  it("targets meta.operate_entity_records by default", async () => {
    const { conn, calls } = fakePg();
    const store = new PostgresEntityStore(conn);
    await store.list(TENANT, "Product");
    expect(calls.some((c) => c.includes("meta.operate_entity_records"))).toBe(true);
  });

  it("honors a custom schema", async () => {
    const { conn, calls } = fakePg();
    const store = new PostgresEntityStore(conn, { schema: "tenant_app" });
    await store.list(TENANT, "Product");
    expect(calls.some((c) => c.includes("tenant_app.operate_entity_records"))).toBe(true);
  });

  it("rejects an invalid schema name", () => {
    const { conn } = fakePg();
    expect(() => new PostgresEntityStore(conn, { schema: "meta; DROP" })).toThrow(/invalid schema/);
  });

  it("rejects a malformed tenant id (RLS guard)", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    await expect(store.get("not-a-uuid!!", "Product", "x")).rejects.toThrow(/invalid tenantId/);
  });
});
