import type { PgConnection } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import { encodeKeyset } from "@crossengin/operate-runtime";
import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { UndecidedColumnTypeError } from "./column-plan.js";
import {
  COLUMN_ENCRYPTION_KEY_SETTING,
  ColumnEncryptionUnavailable,
  ColumnMappedEntityStore,
  DEFAULT_ENCRYPTION_KEY_REF,
  decimalSpecFromSqlType,
} from "./column-store.js";
import { SET_EXTRA_SETTING_SQL } from "./tenant-context.js";

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
  /**
   * The `set_config` statements, kept apart from `calls` so the existing
   * assertions (which index into the store's own statements) are unaffected, and
   * recorded at all because the column key now rides on one of them and "the key
   * never appears in SQL text" is only checkable against what was issued.
   */
  settings: { sql: string; params: readonly unknown[] }[];
  setRows: (rows: Record<string, unknown>[]) => void;
}

function capturePg(initialRows: Record<string, unknown>[] = []): Captured {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const settings: { sql: string; params: readonly unknown[] }[] = [];
  let rows = initialRows;
  const query = (async (sql: string, params?: readonly unknown[]) => {
    if (sql.includes("set_config")) {
      settings.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 };
    }
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
  return { conn, calls, settings, setRows: (r) => (rows = r) };
}

/** The key the tests serve PHI under. Never asserted to appear in any SQL text. */
const KEY = "tenant-key-🔐";

/**
 * `MANIFEST` declares `Widget.mrn` as `phi`, so the store now refuses to be built
 * without a way to reach a key (see `ColumnEncryptionUnavailable`). Every test
 * therefore states which key it serves under — which is the point of the change:
 * before, this construction succeeded and the first PHI write was a 500.
 */
function store(cap: Captured): ColumnMappedEntityStore {
  return new ColumnMappedEntityStore(cap.conn, MANIFEST, {
    schema: "tenant_app",
    encryptionKey: () => KEY,
  });
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
    expect(upd.sql).toContain('"updated_at" = date_trunc(\'milliseconds\', now())');
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
      {
        id: "v1",
        reason: "a",
        created_at: new Date("2026-08-26T01:02:03.456Z"),
        created_by: "u1",
        // The full-precision cursor alias `listPageOn` adds for an instant sort key. A `Date` has
        // lost the microseconds by the time it reaches JS, so the cursor is rendered from the
        // column's own `to_char` instead — see `FULL_PRECISION_INSTANT_FORMAT`.
        __ck0: "2026-08-26T01:02:03.456000Z",
      },
      {
        id: "v2",
        reason: "b",
        created_at: new Date("2026-08-27T01:02:03.456Z"),
        created_by: "u1",
        __ck0: "2026-08-27T01:02:03.456000Z",
      },
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
    expect(decoded.k[0]).toBe("2026-08-26T01:02:03.456000Z");
    expect(decoded.k[0]).not.toContain("Coordinated Universal Time");
  });

  it("still stamps updated_at when the patch does not name it", async () => {
    const cap = capturePg([{ id: "v1", reason: "x" }]);
    await auditedStore(cap).update(TENANT, "Visit", "v1", { reason: "x" });
    const upd = cap.calls.find((c) => c.sql.includes("UPDATE"))!;
    expect(upd.sql).toContain('"updated_at" = date_trunc(\'milliseconds\', now())');
  });

  it("assigns updated_at once when the patch names it, not twice", async () => {
    const cap = capturePg([{ id: "v1", reason: "x" }]);
    await auditedStore(cap).update(TENANT, "Visit", "v1", { updated_at: "2026-08-26T00:00:00Z" });
    const upd = cap.calls.find((c) => c.sql.includes("UPDATE"))!;
    expect(upd.sql.match(/"updated_at" =/g)).toHaveLength(1);
    expect(upd.sql).not.toContain('"updated_at" = date_trunc');
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

  // The refusal moved from the first *read* to the *plan*. A manifest declaring a `duration` used
  // to provision a table, serve every other field, and fail on the first page of the one entity
  // that had it; now it cannot be planned at all. See `UNDECIDED_SQL_TYPES` for the measurements
  // behind refusing rather than choosing a wire form.
  it("refuses at plan time, naming the entity and the field", () => {
    const cap = capturePg();
    expect(() => spanStore(cap)).toThrow(UndecidedColumnTypeError);
    expect(() => spanStore(cap)).toThrow(
      /Span\.elapsed: cannot plan a INTERVAL column — a 'duration' field has no decided wire type/,
    );
  });

  it("carries the entity, field, sqlType and reason on the error", () => {
    const cap = capturePg();
    let caught: unknown = null;
    try {
      spanStore(cap);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UndecidedColumnTypeError);
    const err = caught as UndecidedColumnTypeError;
    // The entity as well as the field: the plan is per entity, and `elapsed` may be declared on
    // several, so an operator reading a boot failure needs to know which one to edit.
    expect(err.entity).toBe("Span");
    expect(err.field).toBe("elapsed");
    expect(err.sqlType).toBe("INTERVAL");
  });

  it("refuses an array of them too, since the element type is the undecided one", () => {
    const cap = capturePg();
    const arrayOfSpans = {
      entities: [{ name: "Span", fields: [{ name: "elapsed", type: { kind: "array", element: { kind: "duration" } } }] }],
    } as unknown as Manifest;
    expect(() => new ColumnMappedEntityStore(cap.conn, arrayOfSpans, { schema: "tenant_app" })).toThrow(
      UndecidedColumnTypeError,
    );
  });

  it("emits no DDL for it, because there is no plan to emit DDL from", async () => {
    const cap = capturePg();
    expect(() => spanStore(cap)).toThrow(UndecidedColumnTypeError);
    // The earlier decision was "the refusal is about serving, not about declaring", which left a
    // provisioned table nothing could read. Declaring a column whose values can never be served is
    // not a smaller failure than refusing the manifest; it is the same failure, later.
    expect(cap.calls).toHaveLength(0);
  });
});

describe("ColumnMappedEntityStore — the at-rest column key", () => {
  const PLAIN: Entity = {
    name: "Plain",
    fields: [{ name: "sku", type: { kind: "text" } }],
  };
  const PLAIN_MANIFEST = { entities: [PLAIN] } as unknown as Manifest;

  it("sets app.column_encryption_key inside the same transaction as the tenant context", async () => {
    const cap = capturePg();
    await store(cap).create(TENANT, "Widget", { id: "w1", mrn: "MRN-1" });
    expect(cap.settings).toHaveLength(2);
    expect(cap.settings[0]?.params).toEqual([TENANT]);
    expect(cap.settings[1]?.params).toEqual([COLUMN_ENCRYPTION_KEY_SETTING, KEY]);
  });

  it("binds the key as a parameter — it never appears in any SQL text", async () => {
    const cap = capturePg();
    await store(cap).create(TENANT, "Widget", { id: "w1", mrn: "MRN-1" });
    // The whole reason both the name and the value are bound: a key interpolated into the
    // statement lands in `log_statement = 'all'`, in `pg_stat_statements`, and in any error that
    // echoes the SQL. The recorded statements are every statement this store issued.
    const everySql = [...cap.settings, ...cap.calls].map((c) => c.sql).join("\n");
    expect(everySql).not.toContain(KEY);
    expect(cap.settings[1]?.sql).toBe(SET_EXTRA_SETTING_SQL);
    expect(cap.settings[1]?.sql).not.toContain(COLUMN_ENCRYPTION_KEY_SETTING);
  });

  it("sets the key for a read as well as a write — a decrypt needs it too", async () => {
    const cap = capturePg([{ id: "w1", mrn: "MRN-1" }]);
    await store(cap).get(TENANT, "Widget", "w1");
    expect(cap.settings.map((s) => s.params[0])).toEqual([TENANT, COLUMN_ENCRYPTION_KEY_SETTING]);
  });

  it("resolves the key per tenant, so two tenants bind two keys", async () => {
    const cap = capturePg();
    const seen: string[] = [];
    const s = new ColumnMappedEntityStore(cap.conn, MANIFEST, {
      schema: "tenant_app",
      encryptionKey: (tenantId) => {
        seen.push(tenantId);
        return `key-for-${tenantId}`;
      },
    });
    const other = "99999999-0000-4000-8000-000000000002";
    await s.create(TENANT, "Widget", { id: "w1", mrn: "a" });
    await s.create(other, "Widget", { id: "w2", mrn: "b" });
    expect(seen).toEqual([TENANT, other]);
    expect(cap.settings.filter((x) => x.params[0] === COLUMN_ENCRYPTION_KEY_SETTING).map((x) => x.params[1]))
      .toEqual([`key-for-${TENANT}`, `key-for-${other}`]);
  });

  it("awaits an async resolver before issuing any statement", async () => {
    const cap = capturePg();
    const s = new ColumnMappedEntityStore(cap.conn, MANIFEST, {
      schema: "tenant_app",
      encryptionKey: async () => Promise.resolve("async-key"),
    });
    await s.create(TENANT, "Widget", { id: "w1", mrn: "a" });
    expect(cap.settings[1]?.params).toEqual([COLUMN_ENCRYPTION_KEY_SETTING, "async-key"]);
  });

  it("issues no extra statement when no column is encrypted", async () => {
    const cap = capturePg();
    const s = new ColumnMappedEntityStore(cap.conn, PLAIN_MANIFEST, {
      schema: "tenant_app",
      encryptionKey: () => KEY,
    });
    await s.create(TENANT, "Plain", { id: "p1", sku: "S" });
    // A deployment with no PHI pays nothing for the seam — one `set_config`, the tenant's, exactly
    // as before this existed. The key source is supplied here *and* ignored, which is the claim.
    expect(cap.settings).toHaveLength(1);
    expect(cap.settings[0]?.params).toEqual([TENANT]);
  });

  it("does not call the key resolver at all for an unencrypted manifest", async () => {
    const cap = capturePg();
    let calls = 0;
    const s = new ColumnMappedEntityStore(cap.conn, PLAIN_MANIFEST, {
      schema: "tenant_app",
      encryptionKey: () => {
        calls += 1;
        return KEY;
      },
    });
    await s.listPage(TENANT, "Plain", { limit: 5, cursor: null, sort: [], filters: [] });
    expect(calls).toBe(0);
  });

  it("carries the key through every op, including a transaction and an association write", async () => {
    const cap = capturePg();
    const s = store(cap);
    await s.withTransaction(TENANT, async (tx) => tx.get(TENANT, "Widget", "w1"));
    expect(cap.settings[1]?.params).toEqual([COLUMN_ENCRYPTION_KEY_SETTING, KEY]);
    for (const op of [
      () => s.list(TENANT, "Widget"),
      () => s.remove(TENANT, "Widget", "w1"),
      () => s.update(TENANT, "Widget", "w1", { mrn: "x" }),
    ]) {
      cap.settings.length = 0;
      await op();
      expect(cap.settings.map((x) => x.params[0])).toEqual([TENANT, COLUMN_ENCRYPTION_KEY_SETTING]);
    }
  });

  it("refuses at construction when a phi column has no reachable key", () => {
    const cap = capturePg();
    expect(() => new ColumnMappedEntityStore(cap.conn, MANIFEST, { schema: "tenant_app" })).toThrow(
      ColumnEncryptionUnavailable,
    );
    // Entity *and* field: the manifest may declare `mrn` on several entities, and an operator
    // reading a boot failure needs to know which one to supply a key for or reclassify.
    expect(() => new ColumnMappedEntityStore(cap.conn, MANIFEST, { schema: "tenant_app" })).toThrow(
      /Widget\.mrn \(phi\)/,
    );
  });

  it("names the remedy, and emits no DDL, because there is nothing it could serve", () => {
    const cap = capturePg();
    let caught: unknown = null;
    try {
      new ColumnMappedEntityStore(cap.conn, MANIFEST, { schema: "tenant_app" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ColumnEncryptionUnavailable);
    const err = caught as ColumnEncryptionUnavailable;
    expect(err.name).toBe("ColumnEncryptionUnavailable");
    expect(err.columns).toEqual(["Widget.mrn (phi)"]);
    expect(err.message).toContain("encryptionKey");
    expect(err.message).toContain("encryptionKeyRef");
    expect(cap.calls).toHaveLength(0);
    expect(cap.settings).toHaveLength(0);
  });

  it("does not refuse a manifest with no encrypted column", () => {
    const cap = capturePg();
    expect(
      () => new ColumnMappedEntityStore(cap.conn, PLAIN_MANIFEST, { schema: "tenant_app" }),
    ).not.toThrow();
  });

  it("exempts an explicit non-default encryptionKeyRef, which is somebody else's arrangement", () => {
    const cap = capturePg();
    // A caller naming its own reference is reaching the key by a route this store cannot see — a
    // session GUC a pooler sets, a wrapper function, a literal. The exemption is exactly that
    // narrow and must not widen: it is keyed on the ref differing from the default, not on one
    // having been passed.
    const s = new ColumnMappedEntityStore(cap.conn, MANIFEST, {
      schema: "tenant_app",
      encryptionKeyRef: "$$kref$$",
    });
    expect(s).toBeInstanceOf(ColumnMappedEntityStore);
  });

  it("still refuses when the ref passed is the default spelled out", () => {
    const cap = capturePg();
    // `DEFAULT_ENCRYPTION_KEY_REF` names the GUC whose only setter is this store's own `scoped`,
    // so passing it back is not an arrangement — it is the same unreachable key.
    expect(
      () =>
        new ColumnMappedEntityStore(cap.conn, MANIFEST, {
          schema: "tenant_app",
          encryptionKeyRef: DEFAULT_ENCRYPTION_KEY_REF,
        }),
    ).toThrow(ColumnEncryptionUnavailable);
  });

  it("sets no key GUC under a custom ref, since the custom route owns it", async () => {
    const cap = capturePg();
    const s = new ColumnMappedEntityStore(cap.conn, MANIFEST, {
      schema: "tenant_app",
      encryptionKeyRef: "$$kref$$",
    });
    await s.create(TENANT, "Widget", { id: "w1", mrn: "a" });
    expect(cap.settings).toHaveLength(1);
  });

  it("refuses a resolver that answers an empty key, naming the tenant", async () => {
    const cap = capturePg();
    const s = new ColumnMappedEntityStore(cap.conn, MANIFEST, {
      schema: "tenant_app",
      encryptionKey: () => "",
    });
    // Measured on PG 16: `pgp_sym_encrypt(x, '')` raises `Illegal argument to function`, so an
    // empty key would surface as an opaque failure from inside pgcrypto on the write path.
    await expect(s.create(TENANT, "Widget", { id: "w1", mrn: "a" })).rejects.toThrow(
      ColumnEncryptionUnavailable,
    );
    await expect(s.create(TENANT, "Widget", { id: "w1", mrn: "a" })).rejects.toThrow(TENANT);
  });

  it("the default key ref is the RAISING form of current_setting, not the quiet one", () => {
    // Fact, measured on PG 16, and the reason this assertion exists rather than a comment:
    //   current_setting('app.foo')        → RAISES `unrecognized configuration parameter`
    //   current_setting('app.foo', true)  → NULL when unset, and '' once set-and-reset
    //   pgp_sym_encrypt(x, NULL)          → NULL, *silently*
    // So the repo's house GUC idiom — the `, true` second argument used for
    // `app.current_tenant_id` — would turn a missing key into a row of NULL where the ciphertext
    // should be: PHI accepted, 201 returned, nothing stored. The raising form is mandatory here
    // and is deliberately the opposite of the convention one file over.
    expect(DEFAULT_ENCRYPTION_KEY_REF).toBe(`current_setting('${COLUMN_ENCRYPTION_KEY_SETTING}')`);
    expect(DEFAULT_ENCRYPTION_KEY_REF).not.toContain("true");
  });

  it("the setting the ref reads is the setting scoped() writes", async () => {
    const cap = capturePg();
    await store(cap).create(TENANT, "Widget", { id: "w1", mrn: "a" });
    // One name, two consumers — the SQL reference and the setter. Two spellings is ADR-0332's
    // `FEATURE_FLAG_COLUMN_NAMES` defect, where a store could not round-trip a single row against
    // any real database while every offline test passed.
    expect(DEFAULT_ENCRYPTION_KEY_REF).toContain(String(cap.settings[1]?.params[0]));
  });
});
