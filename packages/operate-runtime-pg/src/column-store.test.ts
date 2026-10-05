import type { PgConnection } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import { encodeKeyset } from "@crossengin/operate-runtime";
import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import {
  ColumnMappedEntityStore,
  UndecidedWireTypeError,
  decimalSpecFromSqlType,
} from "./column-store.js";

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
    // `price` is `decimal(12, 2)`: bound and echoed as its canonical wire string.
    expect(insert.params).toEqual([TENANT, "w1", "S1", "9.50", "acct-1"]);
    expect(created).toEqual({ id: "w1", sku: "S1", price: "9.50", owner: "acct-1" });
  });

  it("get maps columns back to fields (owner_id → owner), nulls omitted", async () => {
    const cap = capturePg([{ id: "w1", sku: "S1", price: "9.50", status: null, owner_id: "acct-1" }]);
    const record = await store(cap).get(TENANT, "Widget", "w1");
    expect(record).toEqual({ id: "w1", sku: "S1", price: "9.50", owner: "acct-1" });
    const select = cap.calls.find((c) => c.sql.includes("SELECT"))!;
    expect(select.params).toEqual([TENANT, "w1"]);
  });

  it("update SETs only patched columns + updated_at and returns the merged row", async () => {
    const cap = capturePg([{ id: "w1", sku: "S1", price: "12.00", owner_id: null }]);
    const updated = await store(cap).update(TENANT, "Widget", "w1", { price: 12 });
    const upd = cap.calls.find((c) => c.sql.includes("UPDATE"))!;
    expect(upd.sql).toContain('"price" = $3');
    expect(upd.sql).toContain('"updated_at" = now()');
    expect(upd.sql).toContain("RETURNING");
    expect(updated).toMatchObject({ id: "w1", price: "12.00" });
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
    // `NULLS LAST` on a numeric column in *both* directions: Postgres's default would put them
    // first descending, and a keyset cursor component cannot say which end of the order it is at.
    expect(sel.sql).toContain('ORDER BY "price" DESC NULLS LAST, "id" ASC');
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

  it("countLinks counts join rows, narrowing by one side", async () => {
    const cap = capturePg([{ n: "2" }]);
    const n = await m2mStore(cap).countLinks(TENANT, "Course", "Student", { leftId: "c1" });
    expect(n).toBe(2);
    const sel = cap.calls.find((c) => c.sql.includes("count(*)"))!;
    expect(sel.sql).toContain('"tenant_app"."course_student"');
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

describe("ColumnMappedEntityStore — withTransaction", () => {
  it("runs ops on the shared transaction store and returns the result", async () => {
    const cap = capturePg();
    const created = await store(cap).withTransaction(TENANT, async (tx) => {
      return tx.create(TENANT, "Widget", { sku: "TXN-1" });
    });
    expect(created.sku).toBe("TXN-1");
    expect(cap.calls.some((c) => c.sql.includes('INSERT INTO "tenant_app"."widget"'))).toBe(true);
  });

  it("propagates a throw from the unit of work (so the tx rolls back)", async () => {
    const cap = capturePg();
    await expect(
      store(cap).withTransaction(TENANT, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("rejects cross-tenant access inside the transaction", async () => {
    const cap = capturePg();
    await expect(
      store(cap).withTransaction(TENANT, async (tx) => tx.get("99999999-0000-4000-8000-000000000002", "Widget", "x")),
    ).rejects.toThrow(/cross-tenant/);
  });
});

describe("ColumnMappedEntityStore — an auditable entity's trait columns", () => {
  const AUDITED = {
    name: "Visit",
    traits: ["auditable"],
    fields: [{ name: "reason", type: { kind: "text" } }],
  };
  const AUDITED_MANIFEST = { entities: [AUDITED] } as unknown as Manifest;
  const auditedStore = (cap: Captured): ColumnMappedEntityStore =>
    new ColumnMappedEntityStore(cap.conn, AUDITED_MANIFEST, { schema: "tenant_app" });

  it("selects the trait columns, so a record carries created_at and created_by", async () => {
    const cap = capturePg([
      { id: "v1", reason: "checkup", created_at: "2026-08-26T00:00:00Z", created_by: "u1" },
    ]);
    const record = await auditedStore(cap).get(TENANT, "Visit", "v1");
    expect(record).toEqual({
      id: "v1",
      reason: "checkup",
      created_at: "2026-08-26T00:00:00Z",
      created_by: "u1",
    });
  });

  // The whole reason this class of defect survived: every offline fake here hands back a string,
  // and node-postgres hands back a `Date`. Measured live against Postgres 16.
  it("renders a Date trait timestamp as the ISO text an EntityRecord holds", async () => {
    const cap = capturePg([
      { id: "v1", reason: "checkup", created_at: new Date("2026-08-26T01:02:03.456Z"), created_by: "u1" },
    ]);
    const record = await auditedStore(cap).get(TENANT, "Visit", "v1");
    expect(typeof record?.["created_at"]).toBe("string");
    expect(record?.["created_at"]).toBe("2026-08-26T01:02:03.456Z");
  });

  it("builds a keyset cursor Postgres can bind back, not a Date's toString form", async () => {
    const cap = capturePg([
      { id: "v1", reason: "a", created_at: new Date("2026-08-26T01:02:03.456Z"), created_by: "u1" },
      { id: "v2", reason: "b", created_at: new Date("2026-08-27T01:02:03.456Z"), created_by: "u1" },
    ]);
    const page = await auditedStore(cap).listPage(TENANT, "Visit", {
      limit: 1,
      cursor: null,
      sort: [{ field: "created_at", direction: "asc" }],
      filters: [],
    });
    expect(page.nextCursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(page.nextCursor ?? "", "base64url").toString("utf8"),
    ) as { k: readonly string[] };
    // `Fri Aug 26 2026 … (Coordinated Universal Time)` is what this was, and
    // `$n::TIMESTAMPTZ` refuses it — verified live, `invalid input syntax`.
    expect(decoded.k[0]).toBe("2026-08-26T01:02:03.456Z");
    expect(decoded.k[0]).not.toContain("Coordinated Universal Time");
  });

  it("still stamps updated_at when the patch does not name it", async () => {
    const cap = capturePg([{ id: "v1", reason: "x" }]);
    await auditedStore(cap).update(TENANT, "Visit", "v1", { reason: "x" });
    const upd = cap.calls.find((c) => c.sql.includes("UPDATE"))!;
    expect(upd.sql).toContain('"updated_at" = now()');
  });

  it("assigns updated_at once when the patch names it, not twice", async () => {
    const cap = capturePg([{ id: "v1", reason: "x" }]);
    await auditedStore(cap).update(TENANT, "Visit", "v1", { updated_at: "2026-08-26T00:00:00Z" });
    const upd = cap.calls.find((c) => c.sql.includes("UPDATE"))!;
    expect(upd.sql.match(/"updated_at" =/g)).toHaveLength(1);
    expect(upd.sql).not.toContain('"updated_at" = now()');
  });

  it("migrates an existing table additively on ensureSchema", async () => {
    const cap = capturePg();
    await auditedStore(cap).ensureSchema();
    const adds = cap.calls.filter((c) => c.sql.includes("ADD COLUMN IF NOT EXISTS"));
    expect(adds.map((a) => a.sql.match(/IF NOT EXISTS "(\w+)"/)?.[1])).toEqual([
      "reason",
      "created_at",
      "updated_at",
      "created_by",
      "updated_by",
    ]);
  });
});

describe("ColumnMappedEntityStore — a DATE column", () => {
  const SHIFT = {
    name: "Shift",
    fields: [
      { name: "on_day", type: { kind: "date" } },
      { name: "spare_days", type: { kind: "array", element: { kind: "date" } } },
    ],
  };
  const SHIFT_MANIFEST = { entities: [SHIFT] } as unknown as Manifest;
  const shiftStore = (cap: Captured): ColumnMappedEntityStore =>
    new ColumnMappedEntityStore(cap.conn, SHIFT_MANIFEST, { schema: "tenant_app" });

  // node-postgres parses a DATE into *local* midnight, so `toISOString().slice(0, 10)` names the
  // previous day east of UTC. `isoCalendarDate` reads the local parts, which are right everywhere.
  it("renders a Date as the calendar day it is, independent of the process timezone", async () => {
    const cap = capturePg([{ id: "s1", on_day: new Date(2026, 1, 2, 0, 0, 0) }]);
    const record = await shiftStore(cap).get(TENANT, "Shift", "s1");
    expect(record?.["on_day"]).toBe("2026-02-02");
  });

  it("renders each element of a DATE[] column", async () => {
    const cap = capturePg([
      { id: "s1", spare_days: [new Date(2026, 1, 2, 0, 0, 0), new Date(2026, 1, 3, 0, 0, 0)] },
    ]);
    const record = await shiftStore(cap).get(TENANT, "Shift", "s1");
    expect(record?.["spare_days"]).toEqual(["2026-02-02", "2026-02-03"]);
  });

  it("leaves text already in YYYY-MM-DD exactly as the write put it", async () => {
    const cap = capturePg([{ id: "s1", on_day: "2026-02-02" }]);
    const record = await shiftStore(cap).get(TENANT, "Shift", "s1");
    expect(record?.["on_day"]).toBe("2026-02-02");
  });

  it("leaves a non-temporal, non-numeric column untouched", async () => {
    const cap = capturePg([{ id: "s1", on_day: null }]);
    const record = await shiftStore(cap).get(TENANT, "Shift", "s1");
    expect(record).toEqual({ id: "s1" });
  });
});

describe("ColumnMappedEntityStore — decimal wire type", () => {
  it("recovers a column's declaration from the NUMERIC type the kernel emitted", () => {
    expect(decimalSpecFromSqlType("NUMERIC(12, 2)")).toEqual({ precision: 12, scale: 2 });
    expect(decimalSpecFromSqlType("NUMERIC(20, 10)")).toEqual({ precision: 20, scale: 10 });
    expect(decimalSpecFromSqlType("NUMERIC(12, 2)[]")).toEqual({ precision: 12, scale: 2 });
    for (const other of ["TEXT", "INTEGER", "TIMESTAMPTZ", "NUMERIC", "VARCHAR(320)"]) {
      expect(decimalSpecFromSqlType(other)).toBeNull();
    }
  });

  it("serves the string node-postgres returns, at the declared scale", async () => {
    const cap = capturePg([{ id: "w1", price: "10.25" }]);
    expect((await store(cap).get(TENANT, "Widget", "w1"))?.["price"]).toBe("10.25");
  });

  it("pads a value Postgres rendered at a shorter scale", async () => {
    // Reachable through an encrypted decimal column, which decrypts to whatever text was stored
    // rather than to Postgres's own numeric rendering.
    const cap = capturePg([{ id: "w1", price: "10.2" }]);
    expect((await store(cap).get(TENANT, "Widget", "w1"))?.["price"]).toBe("10.20");
  });

  it("keeps a value no double holds", async () => {
    const cap = capturePg([{ id: "w1", price: "9007199254740993.01" }]);
    expect((await store(cap).get(TENANT, "Widget", "w1"))?.["price"]).toBe("9007199254740993.01");
  });

  it("echoes a create at the wire type, so create and get cannot disagree", async () => {
    const cap = capturePg();
    const created = await store(cap).create(TENANT, "Widget", { id: "w1", sku: "S", price: 10.25 });
    expect(created["price"]).toBe("10.25");
    // The bound parameter is the canonical string; Postgres parses it under the column's type.
    const insert = cap.calls.find((c) => c.sql.startsWith("INSERT"))!;
    expect(insert.params).toContain("10.25");
  });

  it("leaves a value it cannot read as a decimal exactly as it found it", async () => {
    const cap = capturePg([{ id: "w1", price: "not-a-number" }]);
    expect((await store(cap).get(TENANT, "Widget", "w1"))?.["price"]).toBe("not-a-number");
  });

  it("puts the canonical form in the keyset cursor, cast on the next page's seek", async () => {
    const cap = capturePg([
      { id: "w1", price: "9.50" },
      { id: "w2", price: "10.25" },
    ]);
    const page = await store(cap).listPage(TENANT, "Widget", {
      limit: 1,
      cursor: null,
      sort: [{ field: "price", direction: "asc" }],
      filters: [],
    });
    expect(page.records.map((r) => r["price"])).toEqual(["9.50"]);
    expect(page.nextCursor).not.toBeNull();
    const cap2 = capturePg([{ id: "w2", price: "10.25" }]);
    await store(cap2).listPage(TENANT, "Widget", {
      limit: 1,
      cursor: page.nextCursor,
      sort: [{ field: "price", direction: "asc" }],
      filters: [],
    });
    const sel = cap2.calls.find((c) => c.sql.includes("SELECT"))!;
    expect(sel.sql).toContain('"price" > $2::NUMERIC(12, 2)');
    expect(sel.params).toContain("9.50");
  });
});

describe("ColumnMappedEntityStore — a column type with no decided wire type", () => {
  const SHIFT: Entity = {
    name: "Span",
    fields: [{ name: "elapsed", type: { kind: "duration" } }],
  };
  const spanStore = (cap: Captured): ColumnMappedEntityStore =>
    new ColumnMappedEntityStore(cap.conn, { entities: [SHIFT] } as unknown as Manifest, {
      schema: "tenant_app",
    });

  it("refuses to serve an INTERVAL column rather than handing out [object Object]", async () => {
    const cap = capturePg([{ id: "s1", elapsed: { days: 3, hours: 4 } }]);
    await expect(spanStore(cap).get(TENANT, "Span", "s1")).rejects.toThrow(UndecidedWireTypeError);
    await expect(spanStore(cap).get(TENANT, "Span", "s1")).rejects.toThrow(
      /elapsed: no wire type is defined for a INTERVAL column/,
    );
  });

  it("refuses on the write echo too, so nothing is stored under a type it cannot read back", async () => {
    const cap = capturePg();
    await expect(spanStore(cap).create(TENANT, "Span", { id: "s1", elapsed: "3 days" })).rejects.toThrow(
      UndecidedWireTypeError,
    );
  });

  it("still emits DDL for the column — the refusal is about serving, not about declaring", async () => {
    const cap = capturePg();
    await spanStore(cap).ensureSchema();
    expect(cap.calls.map((c) => c.sql).join("\n")).toContain('"elapsed" INTERVAL');
  });
});
