import type { PgConnection } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { ColumnMappedEntityStore } from "./column-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

const WIDGET: Entity = {
  name: "Widget",
  fields: [
    { name: "sku", type: { kind: "text" }, required: true },
    { name: "price", type: { kind: "decimal", precision: 12, scale: 2 } },
    { name: "status", type: { kind: "enum", values: ["active", "archived"] } },
    { name: "owner", type: { kind: "reference", target: "Account" } },
  ],
};

const MANIFEST = { entities: [WIDGET] } as unknown as Manifest;

interface Captured {
  conn: PgConnection;
  calls: { sql: string; params: readonly unknown[] }[];
  setRows: (rows: Record<string, unknown>[]) => void;
}

function capturePg(initialRows: Record<string, unknown>[] = []): Captured {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  let rows = initialRows;
  const query = (async (sql: string, params?: readonly unknown[]) => {
    if (sql.includes("set_config")) return { rows: [], rowCount: 0 };
    calls.push({ sql, params: params ?? [] });
    if (sql.includes("SELECT") || sql.includes("RETURNING")) return { rows, rowCount: rows.length };
    if (sql.trimStart().startsWith("DELETE")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }) as PgConnection["query"];
  const conn: PgConnection = {
    query,
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, calls, setRows: (r) => (rows = r) };
}

function store(cap: Captured): ColumnMappedEntityStore {
  return new ColumnMappedEntityStore(cap.conn, MANIFEST, { schema: "tenant_app" });
}

describe("ColumnMappedEntityStore — ensureSchema", () => {
  it("issues idempotent CREATE TABLE + RLS DDL for each entity", async () => {
    const cap = capturePg();
    await store(cap).ensureSchema();
    const all = cap.calls.map((c) => c.sql).join("\n");
    expect(all).toContain('CREATE TABLE IF NOT EXISTS "tenant_app"."widget"');
    expect(all).toContain("ENABLE ROW LEVEL SECURITY");
  });
});

describe("ColumnMappedEntityStore — CRUD maps fields to typed columns", () => {
  it("create writes only provided fields as columns and returns the stored record", async () => {
    const cap = capturePg();
    const created = await store(cap).create(TENANT, "Widget", { id: "w1", sku: "S1", price: 9.5, owner: "acct-1" });
    const insert = cap.calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(insert.sql).toContain('"tenant_app"."widget"');
    expect(insert.sql).toContain('"owner_id"'); // reference field → _id column
    expect(insert.params).toEqual([TENANT, "w1", "S1", 9.5, "acct-1"]);
    expect(created).toEqual({ id: "w1", sku: "S1", price: 9.5, owner: "acct-1" });
  });

  it("get maps columns back to fields (owner_id → owner), nulls omitted", async () => {
    const cap = capturePg([{ id: "w1", sku: "S1", price: 9.5, status: null, owner_id: "acct-1" }]);
    const record = await store(cap).get(TENANT, "Widget", "w1");
    expect(record).toEqual({ id: "w1", sku: "S1", price: 9.5, owner: "acct-1" });
    const select = cap.calls.find((c) => c.sql.includes("SELECT"))!;
    expect(select.params).toEqual([TENANT, "w1"]);
  });

  it("update SETs only patched columns + updated_at and returns the merged row", async () => {
    const cap = capturePg([{ id: "w1", sku: "S1", price: 12, owner_id: null }]);
    const updated = await store(cap).update(TENANT, "Widget", "w1", { price: 12 });
    const upd = cap.calls.find((c) => c.sql.includes("UPDATE"))!;
    expect(upd.sql).toContain('"price" = $3');
    expect(upd.sql).toContain('"updated_at" = now()');
    expect(upd.sql).toContain("RETURNING");
    expect(updated).toMatchObject({ id: "w1", price: 12 });
  });

  it("remove reports whether a row was deleted", async () => {
    const cap = capturePg();
    expect(await store(cap).remove(TENANT, "Widget", "w1")).toBe(true);
    expect(cap.calls.find((c) => c.sql.includes("DELETE"))!.params).toEqual([TENANT, "w1"]);
  });
});

describe("ColumnMappedEntityStore.listPage — typed sort + safe filter", () => {
  it("orders by the native column (typed), filters by text-cast equality, pages with +1", async () => {
    const cap = capturePg([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const page = await store(cap).listPage(TENANT, "Widget", {
      limit: 2,
      cursor: null,
      sort: [{ field: "price", direction: "desc" }],
      filters: [{ field: "status", value: "active" }],
    });
    const sel = cap.calls.find((c) => c.sql.includes("SELECT"))!;
    expect(sel.sql).toContain('ORDER BY "price" DESC, "id" ASC');
    expect(sel.sql).toContain('"status"::text = $2');
    expect(sel.sql).toContain("LIMIT $3 OFFSET $4");
    expect(sel.params).toEqual([TENANT, "active", 3, 0]);
    expect(page.records.map((r) => r["id"])).toEqual(["a", "b"]);
    expect(page.nextCursor).not.toBeNull();
  });

  it("ignores a filter/sort field not in the entity's column plan", async () => {
    const cap = capturePg([]);
    await store(cap).listPage(TENANT, "Widget", {
      limit: 5,
      cursor: null,
      sort: [{ field: "nope", direction: "asc" }],
      filters: [{ field: "ghost", value: "x" }],
    });
    const sel = cap.calls.find((c) => c.sql.includes("SELECT"))!;
    expect(sel.sql).toContain('ORDER BY "id" ASC');
    expect(sel.params).toEqual([TENANT, 6, 0]);
  });
});

describe("ColumnMappedEntityStore — unknown entity", () => {
  it("throws for an entity with no column plan", async () => {
    const cap = capturePg();
    await expect(store(cap).get(TENANT, "Ghost", "x")).rejects.toThrow(/no column plan/);
  });
});
