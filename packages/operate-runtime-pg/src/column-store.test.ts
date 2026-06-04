import type { PgConnection } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import { encodeKeyset } from "@crossengin/operate-runtime";
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
    { name: "mrn", type: { kind: "text" }, classification: "phi" },
  ],
};

const KEY_REF = "current_setting('app.column_encryption_key')";

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

  it("creates referenced tables first, then adds composite foreign keys", async () => {
    const account: Entity = { name: "Account", fields: [{ name: "name", type: { kind: "text" } }] };
    const order: Entity = { name: "Order", fields: [{ name: "account", type: { kind: "reference", target: "Account" } }] };
    const cap = capturePg();
    const s = new ColumnMappedEntityStore(cap.conn, { entities: [order, account] } as unknown as Manifest, { schema: "tenant_app" });
    await s.ensureSchema();
    const sqls = cap.calls.map((c) => c.sql);
    const createAccount = sqls.findIndex((q) => q.includes('CREATE TABLE IF NOT EXISTS "tenant_app"."account"'));
    const createOrder = sqls.findIndex((q) => q.includes('CREATE TABLE IF NOT EXISTS "tenant_app"."order"'));
    const addFk = sqls.findIndex((q) => q.includes('ADD CONSTRAINT "fk_order_account_id"'));
    expect(createAccount).toBeGreaterThanOrEqual(0);
    // referenced table (account) created before the referencing table (order)
    expect(createAccount).toBeLessThan(createOrder);
    // FK added only after both tables exist
    expect(addFk).toBeGreaterThan(createOrder);
    expect(sqls[addFk]).toContain('REFERENCES "tenant_app"."account" ("tenant_id", "id")');
  });

  it("drives the FK ON DELETE behavior from the manifest's relation onDelete", async () => {
    const account: Entity = { name: "Account", fields: [{ name: "name", type: { kind: "text" } }] };
    const order: Entity = { name: "Order", fields: [{ name: "account", type: { kind: "reference", target: "Account" } }] };
    const manifest = {
      entities: [order, account],
      relations: [{ kind: "many_to_one", from: "Order", field: "account", to: "Account", onDelete: "cascade" }],
    } as unknown as Manifest;
    const cap = capturePg();
    await new ColumnMappedEntityStore(cap.conn, manifest, { schema: "tenant_app" }).ensureSchema();
    const fk = cap.calls.map((c) => c.sql).find((q) => q.includes('ADD CONSTRAINT "fk_order_account_id"'))!;
    expect(fk).toContain("ON DELETE CASCADE");
  });

  it("provisions a many_to_many join table after the entity tables exist", async () => {
    const course: Entity = { name: "Course", fields: [{ name: "title", type: { kind: "text" } }] };
    const student: Entity = { name: "Student", fields: [{ name: "name", type: { kind: "text" } }] };
    const manifest = {
      entities: [course, student],
      relations: [{ kind: "many_to_many", left: "Course", right: "Student" }],
    } as unknown as Manifest;
    const cap = capturePg();
    await new ColumnMappedEntityStore(cap.conn, manifest, { schema: "tenant_app" }).ensureSchema();
    const sqls = cap.calls.map((c) => c.sql);
    const createCourse = sqls.findIndex((q) => q.includes('CREATE TABLE IF NOT EXISTS "tenant_app"."course"'));
    const createJoin = sqls.findIndex((q) => q.includes('CREATE TABLE IF NOT EXISTS "tenant_app"."course_student"'));
    const joinFk = sqls.find((q) => q.includes('ADD CONSTRAINT "fk_course_student_course_id"'));
    expect(createJoin).toBeGreaterThan(createCourse); // entity tables first
    expect(joinFk).toContain('REFERENCES "tenant_app"."course" ("tenant_id", "id") ON DELETE CASCADE');
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

  it("coerces a NUMERIC column (returned as a string by pg) back to a number on read", async () => {
    // node-postgres returns NUMERIC as a string; a `decimal` field is a number
    const cap = capturePg([{ id: "w1", sku: "S1", price: "9.50", status: null, owner_id: null }]);
    const record = await store(cap).get(TENANT, "Widget", "w1");
    expect(record?.["price"]).toBe(9.5);
    expect(typeof record?.["price"]).toBe("number");
  });

  it("coerces DATE / TIMESTAMPTZ columns (returned as Date by pg) back to strings", async () => {
    const dated: Entity = {
      name: "Dated",
      fields: [
        { name: "dob", type: { kind: "date" } },
        { name: "seen_at", type: { kind: "datetime" } },
      ],
    };
    const cap = capturePg([{ id: "d1", dob: new Date(1990, 0, 1), seen_at: new Date("2026-06-04T12:00:00.000Z") }]);
    const s = new ColumnMappedEntityStore(cap.conn, { entities: [dated] } as unknown as Manifest, { schema: "tenant_app" });
    const record = await s.get(TENANT, "Dated", "d1");
    expect(record?.["dob"]).toBe("1990-01-01"); // DATE → YYYY-MM-DD
    expect(record?.["seen_at"]).toBe("2026-06-04T12:00:00.000Z"); // TIMESTAMPTZ → ISO
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
    expect(sel.sql).toContain('"status" = $2::TEXT'); // value cast to the column type
    expect(sel.sql).toContain("LIMIT $3");
    expect(sel.sql).not.toContain("OFFSET");
    expect(sel.params).toEqual([TENANT, "active", 3]);
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
    expect(sel.params).toEqual([TENANT, 6]);
  });

  it("pushes a typed comparison operator with a value cast to the column type", async () => {
    const cap = capturePg([]);
    await store(cap).listPage(TENANT, "Widget", {
      limit: 5,
      cursor: null,
      sort: [],
      filters: [{ field: "price", op: "gte", value: "15" }],
    });
    const sel = cap.calls.find((c) => c.sql.includes("SELECT"))!;
    expect(sel.sql).toContain('"price" >= $2::NUMERIC(12, 2)');
    expect(sel.params).toEqual([TENANT, "15", 6]);
  });

  it("pushes an in filter as text-cast = ANY($n::text[])", async () => {
    const cap = capturePg([]);
    await store(cap).listPage(TENANT, "Widget", {
      limit: 5,
      cursor: null,
      sort: [],
      filters: [{ field: "status", op: "in", value: ["active", "archived"] }],
    });
    const sel = cap.calls.find((c) => c.sql.includes("SELECT"))!;
    expect(sel.sql).toContain('"status"::text = ANY($2::text[])');
    expect(sel.params).toEqual([TENANT, ["active", "archived"], 6]);
  });

  it("builds a keyset seek predicate from the cursor (sort desc + id tiebreaker)", async () => {
    const cap = capturePg([]);
    const cursor = encodeKeyset({ k: ["20"], id: "b" });
    await store(cap).listPage(TENANT, "Widget", {
      limit: 5,
      cursor,
      sort: [{ field: "price", direction: "desc" }],
      filters: [],
    });
    const sel = cap.calls.find((c) => c.sql.includes("SELECT"))!;
    // (price < $2) OR (price = $3 AND id > $4)
    expect(sel.sql).toContain('"price" < $2::NUMERIC(12, 2)');
    expect(sel.sql).toContain('"id" > $4');
    expect(sel.params).toEqual([TENANT, "20", "20", "b", 6]);
  });

  it("pushes ?fields into the SELECT: only id + requested + sort columns", async () => {
    const cap = capturePg([]);
    await store(cap).listPage(TENANT, "Widget", {
      limit: 5,
      cursor: null,
      sort: [{ field: "price", direction: "asc" }],
      filters: [],
      fields: ["sku"],
    });
    const sel = cap.calls.find((c) => c.sql.includes("SELECT"))!;
    expect(sel.sql).toContain('"sku"'); // requested
    expect(sel.sql).toContain('"price"'); // sort column (needed for the cursor)
    expect(sel.sql).toContain('"id"'); // always
    expect(sel.sql).not.toContain('"status"'); // not selected
    expect(sel.sql).not.toContain('"owner_id"'); // not selected
  });

  it("selects all columns when there is no ?fields projection", async () => {
    const cap = capturePg([]);
    await store(cap).listPage(TENANT, "Widget", { limit: 5, cursor: null, sort: [], filters: [] });
    const sel = cap.calls.find((c) => c.sql.includes("SELECT"))!;
    expect(sel.sql).toContain('"status"');
    expect(sel.sql).toContain('"owner_id"');
  });
});

describe("ColumnMappedEntityStore — at-rest encryption of phi columns", () => {
  it("ensureSchema provisions pgcrypto when a phi column exists", async () => {
    const cap = capturePg();
    await store(cap).ensureSchema();
    expect(cap.calls.some((c) => /CREATE EXTENSION IF NOT EXISTS pgcrypto/i.test(c.sql))).toBe(true);
  });

  it("create encrypts a phi value with pgp_sym_encrypt(...::text, keyRef), binding plaintext as text", async () => {
    const cap = capturePg();
    await store(cap).create(TENANT, "Widget", { id: "w1", sku: "S1", mrn: 12345 });
    const insert = cap.calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(insert.sql).toContain(`pgp_sym_encrypt($4::text, ${KEY_REF})`);
    // tenant, id, sku, then the mrn plaintext coerced to text
    expect(insert.params).toEqual([TENANT, "w1", "S1", "12345"]);
  });

  it("get decrypts a phi column via pgp_sym_decrypt(...) AS the column", async () => {
    const cap = capturePg([{ id: "w1", sku: "S1", mrn: "999-99-9999" }]);
    const record = await store(cap).get(TENANT, "Widget", "w1");
    const select = cap.calls.find((c) => c.sql.includes("SELECT"))!;
    expect(select.sql).toContain(`pgp_sym_decrypt("mrn", ${KEY_REF}) AS "mrn"`);
    expect(record).toMatchObject({ mrn: "999-99-9999" });
  });

  it("update re-encrypts a patched phi column", async () => {
    const cap = capturePg([{ id: "w1", mrn: "x" }]);
    await store(cap).update(TENANT, "Widget", "w1", { mrn: "new" });
    const upd = cap.calls.find((c) => c.sql.includes("UPDATE"))!;
    expect(upd.sql).toContain(`"mrn" = pgp_sym_encrypt($3::text, ${KEY_REF})`);
    expect(upd.params).toEqual([TENANT, "w1", "new"]);
  });

  it("excludes encrypted columns from filter + sort (can't order ciphertext)", async () => {
    const cap = capturePg([]);
    await store(cap).listPage(TENANT, "Widget", {
      limit: 5,
      cursor: null,
      sort: [{ field: "mrn", direction: "asc" }],
      filters: [{ field: "mrn", value: "x" }],
    });
    const sel = cap.calls.find((c) => c.sql.includes("SELECT"))!;
    expect(sel.sql).not.toContain('"mrn" DESC');
    expect(sel.sql).toContain('ORDER BY "id" ASC');
    expect(sel.params).toEqual([TENANT, 6]); // no filter bound for mrn
  });

  it("honors a custom encryptionKeyRef", async () => {
    const cap = capturePg();
    const s = new ColumnMappedEntityStore(cap.conn, MANIFEST, { schema: "tenant_app", encryptionKeyRef: "$$kref$$" });
    await s.create(TENANT, "Widget", { id: "w1", mrn: "z" });
    const insert = cap.calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(insert.sql).toContain("pgp_sym_encrypt($3::text, $$kref$$)");
  });
});

describe("ColumnMappedEntityStore — many_to_many association links", () => {
  const M2M = {
    entities: [
      { name: "Course", fields: [{ name: "title", type: { kind: "text" } }] },
      { name: "Student", fields: [{ name: "name", type: { kind: "text" } }] },
    ],
    relations: [{ kind: "many_to_many", left: "Course", right: "Student" }],
  } as unknown as Manifest;

  function m2mStore(cap: Captured): ColumnMappedEntityStore {
    return new ColumnMappedEntityStore(cap.conn, M2M, { schema: "tenant_app" });
  }

  it("link inserts idempotently into the join table", async () => {
    const cap = capturePg();
    await m2mStore(cap).link(TENANT, "Course", "Student", "c1", "s1");
    const ins = cap.calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(ins.sql).toContain('"tenant_app"."course_student"');
    expect(ins.sql).toContain('"course_id"');
    expect(ins.sql).toContain('"student_id"');
    expect(ins.sql).toContain("ON CONFLICT DO NOTHING");
    expect(ins.params).toEqual([TENANT, "c1", "s1"]);
  });

  it("unlink deletes and reports whether a link existed", async () => {
    const cap = capturePg();
    expect(await m2mStore(cap).unlink(TENANT, "Course", "Student", "c1", "s1")).toBe(true);
    const del = cap.calls.find((c) => c.sql.includes("DELETE"))!;
    expect(del.params).toEqual([TENANT, "c1", "s1"]);
  });

  it("isLinked reflects whether a row exists", async () => {
    expect(await m2mStore(capturePg([{ "?column?": 1 }])).isLinked(TENANT, "Course", "Student", "c1", "s1")).toBe(true);
    expect(await m2mStore(capturePg([])).isLinked(TENANT, "Course", "Student", "c1", "s1")).toBe(false);
  });

  it("listLinks maps rows to {leftId, rightId} and narrows by one side", async () => {
    const cap = capturePg([
      { left_id: "c1", right_id: "s1" },
      { left_id: "c1", right_id: "s2" },
    ]);
    const links = await m2mStore(cap).listLinks(TENANT, "Course", "Student", { leftId: "c1" });
    expect(links).toEqual([
      { leftId: "c1", rightId: "s1" },
      { leftId: "c1", rightId: "s2" },
    ]);
    const sel = cap.calls.find((c) => c.sql.includes("SELECT"))!;
    expect(sel.sql).toContain('AS left_id');
    expect(sel.sql).toContain('"course_id" = $2');
    expect(sel.params).toEqual([TENANT, "c1"]);
  });

  it("throws for a relation with no join table", async () => {
    await expect(m2mStore(capturePg()).link(TENANT, "Course", "Teacher", "c1", "t1")).rejects.toThrow(/no many_to_many join table/);
  });
});

describe("ColumnMappedEntityStore — unknown entity", () => {
  it("throws for an entity with no column plan", async () => {
    const cap = capturePg();
    await expect(store(cap).get(TENANT, "Ghost", "x")).rejects.toThrow(/no column plan/);
  });
});
