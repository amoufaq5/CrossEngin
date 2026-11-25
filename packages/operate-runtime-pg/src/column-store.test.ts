import { PGP_SYM_ENCRYPT_OPTIONS, type PgConnection } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import {
  encodeKeyset,
  ListRowUnreadable,
  ListSurfaceUnserveable,
  RecordIdConflict,
  ReferencedRecordInUse,
  ReferenceNotFound,
  UniqueViolation,
} from "@crossengin/operate-runtime";
import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { UndecidedColumnTypeError } from "./column-plan.js";
import {
  COLUMN_ENCRYPTION_KEY_SETTING,
  ColumnEncryptionUnavailable,
  ColumnMappedEntityStore,
  DEFAULT_ENCRYPTION_KEY_REF,
  decimalSpecFromSqlType,
  ENCRYPTED_COLUMN_TYPE_SQL,
  EncryptedColumnNotCiphertext,
  BootDdlStopped,
  UNIQUE_INDEX_REFUSAL_CAUSES,
  describeBootDdlStatement,
  entityPrimaryKeyConstraintName,
  isPrimaryKeyViolation,
  uniqueIndexRefusalCause,
} from "./column-store.js";
import {
  searchFunctionCall,
  SEARCH_FUNCTION_PRESENT_ROW,
  SEARCH_FUNCTION_PROBE_MATCH,
} from "./search-function.js";
import {
  COLUMN_SCHEMA_AUTHORITY_PROBE_MATCH,
  COLUMN_SCHEMA_OWNER_AUTHORITY_ROW,
} from "./column-schema-provisioning.js";
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

function capturePg(
  initialRows: Record<string, unknown>[] = [],
  /**
   * Fails exactly the statements this answers an error for, and **only** those: a `null` falls
   * through to the arms below untouched. One hook rather than a second fake, because a copy of
   * these arms is a fake answering a statement it could not really serve, which is the thing this
   * file's own convention forbids.
   */
  fail?: (sql: string) => Error | null,
): Captured {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const settings: { sql: string; params: readonly unknown[] }[] = [];
  let rows = initialRows;
  const query = (async (sql: string, params?: readonly unknown[]) => {
    if (sql.includes("set_config")) {
      settings.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 };
    }
    // The authority probe `ensureSchema` opens with, answered as an owner session and kept out of
    // `calls` for `settings`' reason: these tests are about the DDL an owner applies.
    if (sql.includes(COLUMN_SCHEMA_AUTHORITY_PROBE_MATCH)) {
      return { rows: [COLUMN_SCHEMA_OWNER_AUTHORITY_ROW], rowCount: 1 };
    }
    calls.push({ sql, params: params ?? [] });
    // Recorded *before* it throws, because the statement was issued: "the next index was still
    // attempted" is only checkable against what actually reached the connection.
    const failure = fail?.(sql) ?? null;
    if (failure !== null) throw failure;
    // The search-function probe, answered **before** the generic `SELECT` arm and matched on
    // `to_regprocedure`, which no other statement in this store names.
    //
    // It needs its own arm rather than falling through: the generic arm hands back `initialRows`,
    // which defaults to `[]`, and `[]` is exactly how a real database reports *the function does not
    // exist* — `to_regprocedure` answers NULL rather than raising. So every `ensureSchema` test would
    // be exercising the `absent` refusal instead of the schema DDL it is about, which is a fake
    // answering a statement it cannot really serve (ADR-0363: the fake and the code agreeing with
    // each other and with nothing else). A deployment reaches `matches` on its second boot and
    // `created` on its first; `matches` is the state these tests mean.
    if (sql.includes(SEARCH_FUNCTION_PROBE_MATCH)) {
      return { rows: [SEARCH_FUNCTION_PRESENT_ROW], rowCount: 1 };
    }
    if (sql.includes("SELECT") || sql.includes("RETURNING")) return { rows, rowCount: rows.length };
    if (sql.trimStart().startsWith("DELETE")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }) as PgConnection["query"];
  const conn: PgConnection = {
    query,
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
      fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
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
    const order: Entity = {
      name: "Order",
      fields: [{ name: "account", type: { kind: "reference", target: "Account" } }],
    };
    const cap = capturePg();
    const s = new ColumnMappedEntityStore(
      cap.conn,
      { entities: [order, account] } as unknown as Manifest,
      { schema: "tenant_app" },
    );
    await s.ensureSchema();
    const sqls = cap.calls.map((c) => c.sql);
    const createAccount = sqls.findIndex((q) =>
      q.includes('CREATE TABLE IF NOT EXISTS "tenant_app"."account"'),
    );
    const createOrder = sqls.findIndex((q) =>
      q.includes('CREATE TABLE IF NOT EXISTS "tenant_app"."order"'),
    );
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
    const order: Entity = {
      name: "Order",
      fields: [{ name: "account", type: { kind: "reference", target: "Account" } }],
    };
    const manifest = {
      entities: [order, account],
      relations: [
        {
          kind: "many_to_one",
          from: "Order",
          field: "account",
          to: "Account",
          onDelete: "cascade",
        },
      ],
    } as unknown as Manifest;
    const cap = capturePg();
    await new ColumnMappedEntityStore(cap.conn, manifest, { schema: "tenant_app" }).ensureSchema();
    const fk = cap.calls
      .map((c) => c.sql)
      .find((q) => q.includes('ADD CONSTRAINT "fk_order_account_id"'))!;
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
    const createCourse = sqls.findIndex((q) =>
      q.includes('CREATE TABLE IF NOT EXISTS "tenant_app"."course"'),
    );
    const createJoin = sqls.findIndex((q) =>
      q.includes('CREATE TABLE IF NOT EXISTS "tenant_app"."course_student"'),
    );
    const joinFk = sqls.find((q) => q.includes('ADD CONSTRAINT "fk_course_student_course_id"'));
    expect(createJoin).toBeGreaterThan(createCourse); // entity tables first
    expect(joinFk).toContain(
      'REFERENCES "tenant_app"."course" ("tenant_id", "id") ON DELETE CASCADE',
    );
  });
});

describe("ColumnMappedEntityStore — CRUD maps fields to typed columns", () => {
  it("create writes only provided fields as columns and returns the stored record", async () => {
    const cap = capturePg();
    const created = await store(cap).create(TENANT, "Widget", {
      id: "w1",
      sku: "S1",
      price: 9.5,
      owner: "acct-1",
    });
    const insert = cap.calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(insert.sql).toContain('"tenant_app"."widget"');
    expect(insert.sql).toContain('"owner_id"'); // reference field → _id column
    // `price` is `decimal(12, 2)`: bound and echoed as its canonical wire string.
    expect(insert.params).toEqual([TENANT, "w1", "S1", "9.50", "acct-1"]);
    expect(created).toEqual({ id: "w1", sku: "S1", price: "9.50", owner: "acct-1" });
  });

  it("get maps columns back to fields (owner_id → owner), nulls omitted", async () => {
    const cap = capturePg([
      { id: "w1", sku: "S1", price: "9.50", status: null, owner_id: "acct-1" },
    ]);
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
    expect(upd.sql).toContain("\"updated_at\" = date_trunc('milliseconds', now())");
    expect(upd.sql).toContain("RETURNING");
    expect(updated).toMatchObject({ id: "w1", price: "12.00" });
  });

  it("updateIf puts the precondition in the UPDATE's own WHERE, after the SET parameters", async () => {
    const cap = capturePg([{ id: "w1", sku: "S1", status: "archived" }]);
    const out = await store(cap).updateIf(
      TENANT,
      "Widget",
      "w1",
      { status: "archived" },
      { status: "active", owner: null },
    );
    const upd = cap.calls.find((c) => c.sql.includes("UPDATE"))!;
    expect(upd.sql).toContain('"status" = $3');
    expect(upd.sql).toMatch(
      /WHERE "tenant_id" = \$1 AND "id" = \$2 AND "status" IS NOT DISTINCT FROM \$4::TEXT AND "owner_id" IS NULL/,
    );
    expect(upd.params).toEqual([TENANT, "w1", "archived", "active"]);
    expect(out).toEqual({ kind: "updated", record: { id: "w1", sku: "S1", status: "archived" } });
  });

  it("updateIf tells a changed row from a missing one when the UPDATE matched nothing", async () => {
    for (const [present, kind] of [
      [true, "precondition_failed"],
      [false, "not_found"],
    ] as const) {
      const cap = capturePg();
      const inner = cap.conn.query;
      const conn: PgConnection = {
        ...cap.conn,
        query: (async (sql: string, params?: readonly unknown[]) => {
          if (sql.includes("UPDATE")) {
            await inner(sql, params);
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("SELECT 1")) {
            await inner(sql, params);
            return { rows: present ? [{ "?column?": 1 }] : [], rowCount: present ? 1 : 0 };
          }
          return inner(sql, params);
        }) as PgConnection["query"],
      };
      conn.transaction = (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
        fn(conn)) as PgConnection["transaction"];
      const s = new ColumnMappedEntityStore(conn, MANIFEST, {
        schema: "tenant_app",
        encryptionKey: () => KEY,
      });
      expect(
        await s.updateIf(TENANT, "Widget", "w1", { status: "archived" }, { status: "active" }),
      ).toEqual({ kind });
      const probe = cap.calls.find((c) => c.sql.includes("SELECT 1"))!;
      expect(probe.params).toEqual([TENANT, "w1"]);
    }
  });

  it("updateIf refuses a precondition it cannot express rather than dropping it", async () => {
    const cap = capturePg([{ id: "w1" }]);
    await expect(
      store(cap).updateIf(TENANT, "Widget", "w1", { sku: "x" }, { mrn: "a" }),
    ).rejects.toThrow(/encrypted at rest/);
    await expect(
      store(cap).updateIf(TENANT, "Widget", "w1", { sku: "x" }, { nope: "a" }),
    ).rejects.toThrow(/has no column/);
    expect(cap.calls.filter((c) => c.sql.includes("UPDATE"))).toEqual([]);
  });

  it("getLocked reads the row with the lock it names, so a transition and a line writer serialise", async () => {
    for (const [lock, clause] of [
      ["share", "FOR SHARE"],
      ["exclusive", "FOR NO KEY UPDATE"],
    ] as const) {
      const cap = capturePg([{ id: "w1", sku: "S1" }]);
      expect(await store(cap).getLocked(TENANT, "Widget", "w1", lock)).toMatchObject({ id: "w1" });
      const sel = cap.calls.find((c) => c.sql.includes("SELECT") && c.sql.includes('"widget"'))!;
      expect(sel.sql).toMatch(new RegExp(`LIMIT 1 ${clause}$`));
      expect(sel.params).toEqual([TENANT, "w1"]);
    }
    // `get` itself takes no lock.
    const cap = capturePg([{ id: "w1" }]);
    await store(cap).get(TENANT, "Widget", "w1");
    expect(cap.calls.some((c) => /FOR (SHARE|NO KEY UPDATE|UPDATE)/.test(c.sql))).toBe(false);
  });

  it("removeIf puts the precondition in the DELETE's own WHERE and tells a changed row from a missing one", async () => {
    const cap = capturePg();
    expect(await store(cap).removeIf(TENANT, "Widget", "w1", { status: "active" })).toEqual({
      kind: "removed",
    });
    const del = cap.calls.find((c) => c.sql.includes("DELETE"))!;
    expect(del.sql).toMatch(
      /WHERE "tenant_id" = \$1 AND "id" = \$2 AND "status" IS NOT DISTINCT FROM \$3::TEXT/,
    );
    expect(del.params).toEqual([TENANT, "w1", "active"]);
    for (const [present, kind] of [
      [true, "precondition_failed"],
      [false, "not_found"],
    ] as const) {
      const cap2 = capturePg();
      const inner = cap2.conn.query;
      const conn: PgConnection = {
        ...cap2.conn,
        query: (async (sql: string, params?: readonly unknown[]) => {
          if (sql.includes("DELETE")) {
            await inner(sql, params);
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("SELECT 1")) {
            await inner(sql, params);
            return { rows: present ? [{ "?column?": 1 }] : [], rowCount: present ? 1 : 0 };
          }
          return inner(sql, params);
        }) as PgConnection["query"],
      };
      conn.transaction = (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
        fn(conn)) as PgConnection["transaction"];
      const s = new ColumnMappedEntityStore(conn, MANIFEST, {
        schema: "tenant_app",
        encryptionKey: () => KEY,
      });
      expect(await s.removeIf(TENANT, "Widget", "w1", { status: "active" })).toEqual({ kind });
    }
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

  // This test used to be titled "ignores a filter/sort field not in the entity's column plan" and
  // asserted that the statement came back as `ORDER BY "id" ASC` with the filter gone. It was
  // pinning the defect: a dropped filter leaves `tenant_id = $1` as the whole predicate, so the
  // page carried every row the caller asked to exclude, under a 200.
  it("refuses a filter/sort field not in the entity's column plan rather than dropping it", async () => {
    const cap = capturePg([]);
    await expect(
      store(cap).listPage(TENANT, "Widget", {
        limit: 5,
        cursor: null,
        sort: [{ field: "nope", direction: "asc" }],
        filters: [{ field: "ghost", value: "x" }],
      }),
    ).rejects.toThrow(ListSurfaceUnserveable);
    // And nothing was issued: the refusal lands before the statement, so no query runs with a
    // predicate the caller did not ask for.
    expect(cap.calls.some((c) => c.sql.includes("SELECT"))).toBe(false);
  });

  it("names every unserveable surface and its reason on the refusal", async () => {
    const cap = capturePg([]);
    const err = await store(cap)
      .listPage(TENANT, "Widget", {
        limit: 5,
        cursor: null,
        sort: [{ field: "nope", direction: "asc" }],
        filters: [{ field: "ghost", value: "x" }],
      })
      .then(
        () => null,
        (e: unknown) => e as ListSurfaceUnserveable,
      );
    expect(err).toBeInstanceOf(ListSurfaceUnserveable);
    expect(err!.entity).toBe("Widget");
    // The filter only: `UNSERVEABLE_SURFACE_REFUSES` says a dropped sort changes the order and
    // not which rows come back, so it degrades and the boot survey names it.
    expect(err!.surfaces).toEqual([{ surface: "filter", field: "ghost", reason: "not_a_column" }]);
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

describe("ColumnMappedEntityStore — an encrypted column whose table predates the classification", () => {
  // Answers the type probe and nothing else, so every other statement takes the arms it always took.
  const withColumnType = (type: string | null): Captured => {
    const cap = capturePg();
    const inner = cap.conn.query;
    const query = (async (sql: string, params?: readonly unknown[]) => {
      if (sql === ENCRYPTED_COLUMN_TYPE_SQL) {
        cap.calls.push({ sql, params: params ?? [] });
        const rows =
          type === null
            ? []
            : [
                { table_name: "widget", column_name: "sku", column_type: "text" },
                { table_name: "widget", column_name: "mrn", column_type: type },
              ];
        return { rows, rowCount: rows.length };
      }
      return inner(sql, params);
    }) as PgConnection["query"];
    cap.conn.query = query;
    return cap;
  };

  it("refuses at boot, naming the column and its type, when a phi column is still text", async () => {
    const cap = withColumnType("text");
    const err = await store(cap)
      .ensureSchema()
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(EncryptedColumnNotCiphertext);
    expect((err as EncryptedColumnNotCiphertext).columns).toEqual(["tenant_app.widget.mrn (text)"]);
    // Refused before any DDL: an additive pass would not have changed the type anyway.
    expect(cap.calls.some((c) => /ADD COLUMN|CREATE TABLE/.test(c.sql))).toBe(false);
    // The remedy does not send an operator to the one-key conversion as if it were general.
    expect((err as Error).message).toContain("no shipped command does");
  });

  it("asks about the planned encrypted tables only, in the store's own schema", async () => {
    const cap = withColumnType("bytea");
    await store(cap).ensureSchema();
    const probe = cap.calls.find((c) => c.sql === ENCRYPTED_COLUMN_TYPE_SQL)!;
    expect(probe.params).toEqual(["tenant_app", ["widget"]]);
  });

  it("boots when the column is already ciphertext, or does not exist yet", async () => {
    await expect(store(withColumnType("bytea")).ensureSchema()).resolves.toMatchObject({
      mode: "applied",
    });
    await expect(store(withColumnType(null)).ensureSchema()).resolves.toMatchObject({
      mode: "applied",
    });
  });

  it("issues no probe when the manifest encrypts nothing", async () => {
    const cap = withColumnType("text");
    const plain = {
      entities: [{ ...WIDGET, fields: WIDGET.fields.filter((f) => f.name !== "mrn") }],
    };
    await new ColumnMappedEntityStore(cap.conn, plain as unknown as Manifest, {
      schema: "tenant_app",
    }).ensureSchema();
    expect(cap.calls.some((c) => c.sql === ENCRYPTED_COLUMN_TYPE_SQL)).toBe(false);
  });

  it("refuses on the verifying arm too, which checks presence and not type", async () => {
    const cap = withColumnType("text");
    const inner = cap.conn.query;
    cap.conn.query = (async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes(COLUMN_SCHEMA_AUTHORITY_PROBE_MATCH)) {
        const row = { ...COLUMN_SCHEMA_OWNER_AUTHORITY_ROW, role: "serving", may_apply: false };
        return { rows: [row], rowCount: 1 };
      }
      return inner(sql, params);
    }) as PgConnection["query"];
    await expect(store(cap).ensureSchema()).rejects.toBeInstanceOf(EncryptedColumnNotCiphertext);
  });
});

describe("ColumnMappedEntityStore — at-rest encryption of phi columns", () => {
  it("ensureSchema provisions pgcrypto when a phi column exists", async () => {
    const cap = capturePg();
    await store(cap).ensureSchema();
    expect(cap.calls.some((c) => /CREATE EXTENSION IF NOT EXISTS pgcrypto/i.test(c.sql))).toBe(
      true,
    );
  });

  it("create encrypts a phi value with pgp_sym_encrypt(...::text, keyRef), binding plaintext as text", async () => {
    const cap = capturePg();
    await store(cap).create(TENANT, "Widget", { id: "w1", sku: "S1", mrn: 12345 });
    const insert = cap.calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(insert.sql).toContain(
      `pgp_sym_encrypt($4::text, ${KEY_REF}, '${PGP_SYM_ENCRYPT_OPTIONS}')`,
    );
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
    expect(upd.sql).toContain(
      `"mrn" = pgp_sym_encrypt($3::text, ${KEY_REF}, '${PGP_SYM_ENCRYPT_OPTIONS}')`,
    );
    expect(upd.params).toEqual([TENANT, "w1", "new"]);
  });

  // The sharpest of the four tests this increment rewrote, and the one whose old title read as a
  // feature: "excludes encrypted columns from filter + sort (can't order ciphertext)". The premise
  // is true — `pgp_sym_encrypt` is non-deterministic, so there is nothing to compare in SQL — and
  // the conclusion was wrong. Excluding a *filter* does not narrow the answer, it widens it: on the
  // real `erp-healthcare` pack `mrn` is a filterable column of the Patient list view, so
  // `GET /v1/patients?mrn=MRN-1` came back as the first page of EVERY patient under a 200, which a
  // caller and the UI alike read as a search result.
  it("refuses a filter on an encrypted column rather than excluding it", async () => {
    const cap = capturePg([]);
    const err = await store(cap)
      .listPage(TENANT, "Widget", {
        limit: 5,
        cursor: null,
        sort: [{ field: "mrn", direction: "asc" }],
        filters: [{ field: "mrn", value: "x" }],
      })
      .then(
        () => null,
        (e: unknown) => e as ListSurfaceUnserveable,
      );
    expect(err).toBeInstanceOf(ListSurfaceUnserveable);
    expect(err!.surfaces).toEqual([
      { surface: "filter", field: "mrn", reason: "encrypted_at_rest" },
    ]);
    expect(cap.calls.some((c) => c.sql.includes("SELECT"))).toBe(false);
  });

  it("serves a sort on an encrypted column, degraded rather than refused", async () => {
    // The other half of the rule. The rows are right and the order is the id tiebreaker's; what
    // this does NOT fix is the value riding out in the cursor, which is ADR-0357's survey.
    const cap = capturePg([]);
    await store(cap).listPage(TENANT, "Widget", {
      limit: 5,
      cursor: null,
      sort: [{ field: "mrn", direction: "asc" }],
      filters: [],
    });
    const sel = cap.calls.find((c) => c.sql.includes("SELECT"))!;
    expect(sel.sql).toContain('ORDER BY "id" ASC');
    expect(sel.sql).not.toContain('"mrn" ASC');
  });

  it("serves a search over an encrypted column partially, and says on the page which field it left out", async () => {
    const cap = capturePg([]);
    const page = await store(cap).listPage(TENANT, "Widget", {
      limit: 5,
      cursor: null,
      sort: [{ field: "id", direction: "asc" }],
      filters: [],
      search: { term: "MRN-1", fields: ["sku", "mrn"] },
    });
    const sel = cap.calls.find((c) => c.sql.includes("SELECT"))!;
    expect(sel.sql).toContain('"sku"::text');
    // The fold is the column store's own declaration since ADR-0474 (`foldText` is required on the
    // adapter), and it must be the wrapper the trigram index is built over or `?q=` never reads one.
    expect(sel.sql).toContain(searchFunctionCall('"sku"::text'));
    expect(page.searchNarrowedBy).toEqual(["mrn"]);
    const unnarrowed = await store(capturePg([])).listPage(TENANT, "Widget", {
      limit: 5,
      cursor: null,
      sort: [{ field: "id", direction: "asc" }],
      filters: [],
      search: { term: "S1", fields: ["sku"] },
    });
    expect(unnarrowed).not.toHaveProperty("searchNarrowedBy");
  });

  it("serves a query that names no encrypted column, so the refusal is not a blanket one", async () => {
    // The negative control. The entity HAS an encrypted column and the query does not address it,
    // so the page is served exactly as before — which is what keeps the refusal about the surface
    // the caller named rather than about the entity.
    const cap = capturePg([]);
    await store(cap).listPage(TENANT, "Widget", {
      limit: 5,
      cursor: null,
      sort: [{ field: "id", direction: "asc" }],
      filters: [],
    });
    expect(cap.calls.some((c) => c.sql.includes("SELECT"))).toBe(true);
  });

  it("honors a custom encryptionKeyRef", async () => {
    const cap = capturePg();
    const s = new ColumnMappedEntityStore(cap.conn, MANIFEST, {
      schema: "tenant_app",
      encryptionKeyRef: "$$kref$$",
    });
    await s.create(TENANT, "Widget", { id: "w1", mrn: "z" });
    const insert = cap.calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(insert.sql).toContain(
      `pgp_sym_encrypt($3::text, $$kref$$, '${PGP_SYM_ENCRYPT_OPTIONS}')`,
    );
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
    expect(
      await m2mStore(capturePg([{ "?column?": 1 }])).isLinked(
        TENANT,
        "Course",
        "Student",
        "c1",
        "s1",
      ),
    ).toBe(true);
    expect(await m2mStore(capturePg([])).isLinked(TENANT, "Course", "Student", "c1", "s1")).toBe(
      false,
    );
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
    expect(sel.sql).toContain("AS left_id");
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
    await expect(
      m2mStore(capturePg()).link(TENANT, "Course", "Teacher", "c1", "t1"),
    ).rejects.toThrow(/no many_to_many join table/);
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
      store(cap).withTransaction(TENANT, async (tx) =>
        tx.get("99999999-0000-4000-8000-000000000002", "Widget", "x"),
      ),
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

  // A row whose `updated_at` holds microseconds (a pre-ADR-0334 `now()` default) is served truncated,
  // so a precondition built from that read must compare truncated or it can never hold — measured
  // live as `precondition_failed` on every retry. A text column is compared as itself.
  it("compares an instant precondition at the precision the store serves it", async () => {
    const cap = capturePg([{ id: "v1", reason: "x" }]);
    await auditedStore(cap).updateIf(
      TENANT,
      "Visit",
      "v1",
      { reason: "y" },
      { updated_at: "2026-01-01T00:00:00.123Z", reason: "x" },
    );
    const upd = cap.calls.find((c) => c.sql.includes("UPDATE"))!;
    expect(upd.sql).toMatch(
      /date_trunc\('milliseconds', "updated_at"\) IS NOT DISTINCT FROM \$\d+::TIMESTAMPTZ/,
    );
    expect(upd.sql).toMatch(/AND "reason" IS NOT DISTINCT FROM \$\d+::TEXT/);
    expect(upd.sql).not.toMatch(/date_trunc\('milliseconds', "reason"\)/);
  });

  // The whole reason this class of defect survived: every offline fake here hands back a string,
  // and node-postgres hands back a `Date`. Measured live against Postgres 16.
  it("renders a Date trait timestamp as the ISO text an EntityRecord holds", async () => {
    const cap = capturePg([
      {
        id: "v1",
        reason: "checkup",
        created_at: new Date("2026-08-26T01:02:03.456Z"),
        created_by: "u1",
      },
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
    expect(upd.sql).toContain("\"updated_at\" = date_trunc('milliseconds', now())");
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

describe("ColumnMappedEntityStore — a JSONB column", () => {
  // `json`, `file` and `currency_amount` all plan as JSONB. Before, the store bound the raw JS value,
  // and node-postgres serialises by JS type: a string went as bare text and an array as a Postgres
  // array literal, so `"a"`, `""` and `["a", 1]` each raised 22P02 (measured on PG 16, and through
  // `POST /v1/expenses` as a 500 on `Expense.receipt`). These pin the bind, which is the half a fake
  // can see; the round trip itself is the live check.
  const DOC = {
    name: "Doc",
    fields: [
      { name: "label", type: { kind: "text" } },
      { name: "payload", type: { kind: "json" } },
      { name: "attachment", type: { kind: "file" } },
      { name: "fee", type: { kind: "currency_amount" } },
      { name: "parts", type: { kind: "array", element: { kind: "json" } } },
      { name: "secret_blob", type: { kind: "json" }, classification: "phi" },
    ],
  };
  const DOC_MANIFEST = { entities: [DOC] } as unknown as Manifest;
  const docStore = (cap: Captured): ColumnMappedEntityStore =>
    new ColumnMappedEntityStore(cap.conn, DOC_MANIFEST, {
      schema: "tenant_app",
      encryptionKey: () => KEY,
    });

  const SHAPES: readonly [string, unknown][] = [
    ["a string", "t_abc/receipts/f1.pdf"],
    ["an empty string", ""],
    ["a string that is itself JSON text", '{"a":1}'],
    ["a number", 42],
    ["a boolean", false],
    ["an array", ["a", 1]],
    ["an object", { key: "k", n: [1] }],
    ["an array of objects", [{ a: "x" }]],
  ];

  for (const field of ["payload", "attachment", "fee"] as const) {
    for (const [label, value] of SHAPES) {
      it(`create binds ${label} into ${field} as JSON text with a ::jsonb cast, and echoes it unchanged`, async () => {
        const cap = capturePg();
        const created = await docStore(cap).create(TENANT, "Doc", { id: "d1", [field]: value });
        const insert = cap.calls.find((c) => c.sql.includes("INSERT INTO"))!;
        expect(insert.sql).toContain("VALUES ($1, $2, $3::jsonb)");
        expect(insert.params).toEqual([TENANT, "d1", JSON.stringify(value)]);
        // The bound text parses back to the value the caller sent — a string stays a string, which
        // is the case the raw bind turned into an object (`'{"a":1}'`) or a 22P02 (everything else).
        expect(JSON.parse(insert.params[2] as string)).toEqual(value);
        expect(created).toEqual({ id: "d1", [field]: value });
      });

      it(`update binds ${label} into ${field} as JSON text with a ::jsonb cast`, async () => {
        const cap = capturePg([{ id: "d1", [field]: value }]);
        const updated = await docStore(cap).update(TENANT, "Doc", "d1", { [field]: value });
        const upd = cap.calls.find((c) => c.sql.includes("UPDATE"))!;
        expect(upd.sql).toContain(`"${field}" = $3::jsonb`);
        expect(upd.params).toEqual([TENANT, "d1", JSON.stringify(value)]);
        expect(updated).toEqual({ id: "d1", [field]: value });
      });
    }
  }

  it("binds a JS null into a JSONB column as SQL NULL, not as JSON null", async () => {
    const cap = capturePg();
    await docStore(cap).create(TENANT, "Doc", { id: "d1", payload: null });
    const insert = cap.calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(insert.sql).toContain("VALUES ($1, $2, $3)");
    expect(insert.sql).not.toContain("::jsonb");
    expect(insert.params).toEqual([TENANT, "d1", null]);
  });

  it("binds a JSONB[] column one JSON text per element, so a string element survives", async () => {
    const cap = capturePg();
    const parts = ["a", { b: 2 }, 3, null];
    await docStore(cap).create(TENANT, "Doc", { id: "d1", parts });
    const insert = cap.calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(insert.sql).toContain("$3::jsonb[]");
    expect(insert.params).toEqual([TENANT, "d1", ['"a"', '{"b":2}', "3", "null"]]);
  });

  it("leaves a non-JSONB column in the same write bound raw — the control", async () => {
    const cap = capturePg();
    await docStore(cap).create(TENANT, "Doc", { id: "d1", label: "plain", payload: "plain" });
    const insert = cap.calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(insert.sql).toContain("VALUES ($1, $2, $3, $4::jsonb)");
    expect(insert.params).toEqual([TENANT, "d1", "plain", '"plain"']);
  });

  it("leaves an encrypted json column on the pgcrypto path: BYTEA, not JSONB, encrypting JSON text", async () => {
    const cap = capturePg();
    await docStore(cap).create(TENANT, "Doc", { id: "d1", secret_blob: "s" });
    const insert = cap.calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(insert.sql).toContain(
      `pgp_sym_encrypt($3::text, ${KEY_REF}, '${PGP_SYM_ENCRYPT_OPTIONS}')`,
    );
    expect(insert.sql).not.toContain("::jsonb");
    // JSON text, not `String()`: a string encrypts as `"s"` so it decrypts back to a string, and an
    // object as `{"a":1}` rather than `[object Object]` (ADR-0414 Q1).
    expect(insert.params).toEqual([TENANT, "d1", '"s"']);
  });

  it.each([
    ["a string", "s"],
    ["an empty string", ""],
    ["JSON-shaped text", '{"a":1}'],
    ["a number", 7],
    ["a boolean", true],
    ["an array", ["x", 1]],
    ["an object", { a: 1, b: [null] }],
  ] as const)(
    "round-trips %s through an encrypted json column with its type",
    async (_label, value) => {
      const cap = capturePg();
      await docStore(cap).create(TENANT, "Doc", { id: "d1", secret_blob: value });
      const bound = cap.calls.find((c) => c.sql.includes("INSERT INTO"))!.params[2] as string;
      // What the decrypt hands back is the text that was encrypted.
      const read = capturePg([{ id: "d1", secret_blob: bound }]);
      expect((await docStore(read).get(TENANT, "Doc", "d1"))?.["secret_blob"]).toEqual(value);
    },
  );

  it("does not echo a null on create, since the row holds NULL and a get reads it as absent", async () => {
    const cap = capturePg();
    const created = await docStore(cap).create(TENANT, "Doc", {
      id: "d1",
      label: null,
      payload: null,
    });
    const insert = cap.calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(insert.params).toEqual([TENANT, "d1", null, null]);
    expect(created).toEqual({ id: "d1" });
  });

  it("binds an encrypted field with no value as SQL NULL, never as the encrypted text 'null'", async () => {
    const cap = capturePg();
    const created = await docStore(cap).create(TENANT, "Doc", { id: "d1", secret_blob: null });
    const insert = cap.calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(insert.params).toEqual([TENANT, "d1", null]);
    expect(created).toEqual({ id: "d1" });
  });

  it("reads a decrypted JSON null as absent, as every other column reads NULL", async () => {
    const read = capturePg([{ id: "d1", secret_blob: "null" }]);
    expect(await docStore(read).get(TENANT, "Doc", "d1")).toEqual({ id: "d1" });
  });

  it("reads an encrypted json value an earlier binary stored with String() as the text it is", async () => {
    const read = capturePg([{ id: "d1", secret_blob: "[object Object]" }]);
    expect((await docStore(read).get(TENANT, "Doc", "d1"))?.["secret_blob"]).toBe(
      "[object Object]",
    );
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
      entities: [
        {
          name: "Span",
          fields: [{ name: "elapsed", type: { kind: "array", element: { kind: "duration" } } }],
        },
      ],
    } as unknown as Manifest;
    expect(
      () => new ColumnMappedEntityStore(cap.conn, arrayOfSpans, { schema: "tenant_app" }),
    ).toThrow(UndecidedColumnTypeError);
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
    expect(
      cap.settings
        .filter((x) => x.params[0] === COLUMN_ENCRYPTION_KEY_SETTING)
        .map((x) => x.params[1]),
    ).toEqual([`key-for-${TENANT}`, `key-for-${other}`]);
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

/**
 * A node-postgres error as the driver really delivers one: the SQLSTATE in `code` and the index
 * name in `constraint`, which is all a `23505` carries that a caller could act on.
 */
function pgError(code: string, constraint: string): Error & { code: string; constraint: string } {
  return Object.assign(new Error(`pg error ${code}`), { code, constraint });
}

/**
 * Where each `CREATE UNIQUE INDEX` landed in the call log.
 *
 * Positions rather than a `some()` over the names, because "both appear somewhere" is satisfied by
 * the index issued *before* a failure and so says nothing about whether the loop went on past it.
 */
function uniqueIndexPositions(cap: Captured): readonly number[] {
  return cap.calls.flatMap((c, i) => (c.sql.includes("CREATE UNIQUE INDEX") ? [i] : []));
}

describe("ColumnMappedEntityStore — a declared unique field", () => {
  /** Two unique columns, so a refusal on the first is distinguishable from a refusal on both. */
  const CATALOG: Entity = {
    name: "Catalog",
    fields: [
      { name: "sku", type: { kind: "text" }, required: true, unique: true },
      { name: "ean", type: { kind: "text" }, unique: true },
      { name: "label", type: { kind: "text" } },
    ],
  };
  const CATALOG_MANIFEST = { entities: [CATALOG] } as unknown as Manifest;
  const catalogStore = (cap: Captured): ColumnMappedEntityStore =>
    new ColumnMappedEntityStore(cap.conn, CATALOG_MANIFEST, { schema: "tenant_app" });

  /**
   * Three unique columns, so a refusal can be put on the **middle** one — which is what makes the
   * continue-past-a-failure assertions below claims about this loop rather than about the emitter's
   * column order. Two is not enough: with the refusal on an end, whether a surviving index proves
   * the loop continued or merely that it had already run is decided by the direction
   * `enforceableUniqueColumns` happens to filter in, so reversing that order would make a loop
   * stopping at the first failure invisible. The middle of three has a sibling on each side under
   * either direction. A local fixture rather than a third unique column on `CATALOG`, which five
   * tests below share, so no existing test changes meaning.
   */
  const SHELF: Entity = {
    name: "Shelf",
    fields: [
      { name: "sku", type: { kind: "text" }, required: true, unique: true },
      { name: "ean", type: { kind: "text" }, unique: true },
      { name: "upc", type: { kind: "text" }, unique: true },
      { name: "label", type: { kind: "text" } },
    ],
  };
  const SHELF_MANIFEST = { entities: [SHELF] } as unknown as Manifest;

  it("issues the unique indexes last, after every CREATE TABLE and ALTER TABLE", async () => {
    // The ordering is the design, not tidiness. These are the only statements this emitter issues
    // whose outcome depends on existing **data** — a unique index over a populated table holding
    // duplicates raises `23505` and no `IF NOT EXISTS` helps, because the condition is in the rows
    // — so everything that must succeed has already succeeded by the time one can fail.
    const cap = capturePg();
    await catalogStore(cap).ensureSchema();
    const sqls = cap.calls.map((c) => c.sql);
    const firstUnique = sqls.findIndex((q) => q.includes("CREATE UNIQUE INDEX"));
    const lastStructural = sqls.reduce(
      (acc, q, i) => (q.includes("CREATE TABLE") || q.includes("ALTER TABLE") ? i : acc),
      -1,
    );
    expect(firstUnique).toBeGreaterThanOrEqual(0);
    expect(lastStructural).toBeGreaterThanOrEqual(0);
    expect(firstUnique).toBeGreaterThan(lastStructural);
  });

  it("reports a refused unique index, completes the boot, and still attempts the next one", async () => {
    const refused: { entity: string; sql: string; detail: string }[] = [];
    const cap = capturePg([], (sql) =>
      sql.includes("shelf_ean_uniq") ? new Error("could not create unique index") : null,
    );
    await new ColumnMappedEntityStore(cap.conn, SHELF_MANIFEST, {
      schema: "tenant_app",
      onUniqueIndexRefused: (entity, sql, detail) => refused.push({ entity, sql, detail }),
    }).ensureSchema();
    expect(refused).toHaveLength(1);
    expect(refused[0]!.entity).toBe("Shelf");
    expect(refused[0]!.sql).toContain('"shelf_ean_uniq"');
    expect(refused[0]!.detail).toBe("could not create unique index");
    // The assertions that pin ADR-0295's continue-past-a-failure rule rather than merely "it did
    // not throw": all three were attempted, and one of them *after* the refused one. A loop that
    // stopped at the first failure would withhold every later guarantee over one table's duplicate
    // rows. Counted and positioned rather than asked for by name, so neither half can be satisfied
    // by the index issued *before* the failure.
    const positions = uniqueIndexPositions(cap);
    const refusedAt = cap.calls.findIndex((c) => c.sql.includes('"shelf_ean_uniq"'));
    expect(positions).toHaveLength(3);
    expect(positions.filter((i) => i > refusedAt)).toHaveLength(1);
  });

  it("swallows the refusal with no reporter supplied, which is why node.ts always supplies one", async () => {
    let failed = 0;
    const cap = capturePg([], (sql) => {
      if (!sql.includes("shelf_ean_uniq")) return null;
      failed += 1;
      return new Error("duplicate rows");
    });
    await expect(
      new ColumnMappedEntityStore(cap.conn, SHELF_MANIFEST, {
        schema: "tenant_app",
      }).ensureSchema(),
    ).resolves.toEqual({ mode: "applied", role: null, schema: "tenant_app", uniqueIndexes: [] });
    // Counted rather than assumed: "it resolved" is the claim only if a statement really failed,
    // and a hook whose predicate had stopped matching would make this pass having failed nothing.
    expect(failed).toBe(1);
    // And the swallow is the *reporter's* absence, not the loop's: with nobody to tell, the two
    // indexes either side of the refused one are still attempted.
    const positions = uniqueIndexPositions(cap);
    const refusedAt = cap.calls.findIndex((c) => c.sql.includes('"shelf_ean_uniq"'));
    expect(positions).toHaveLength(3);
    expect(positions.filter((i) => i > refusedAt)).toHaveLength(1);
  });

  it("translates a 23505 on INSERT into a UniqueViolation naming the field", async () => {
    const cap = capturePg([], (sql) =>
      sql.startsWith("INSERT") ? pgError("23505", "catalog_sku_uniq") : null,
    );
    const err = await catalogStore(cap)
      .create(TENANT, "Catalog", { id: "c1", sku: "S1" })
      .then(
        () => null,
        (e: unknown) => e as UniqueViolation,
      );
    expect(err).toBeInstanceOf(UniqueViolation);
    expect(err!.entity).toBe("Catalog");
    expect(err!.field).toBe("sku");
  });

  it("translates a 23505 on UPDATE into a UniqueViolation naming the field", async () => {
    // The likelier of the two in practice: a create usually supplies a fresh business key, while
    // an update is where somebody re-types one that is already taken.
    const cap = capturePg([], (sql) =>
      sql.trimStart().startsWith("UPDATE") ? pgError("23505", "catalog_ean_uniq") : null,
    );
    const err = await catalogStore(cap)
      .update(TENANT, "Catalog", "c1", { ean: "E1" })
      .then(
        () => null,
        (e: unknown) => e as UniqueViolation,
      );
    expect(err).toBeInstanceOf(UniqueViolation);
    expect(err!.field).toBe("ean");
  });

  it("re-throws a 23505 from a constraint this store never emitted, untouched", async () => {
    // The most important of these. Claiming a field for a constraint that cannot be attributed
    // would be a guess in an error message, and an unattributable duplicate is exactly as opaque
    // as it was before this existed — which is honest rather than improved. This used to use
    // `catalog_pkey`, under the claim that nothing in this emitter produces it — false: the emitter's
    // unnamed `PRIMARY KEY ("tenant_id", "id")` is named exactly that by Postgres, and since ADR-0474
    // a 23505 on it is `RecordIdConflict` (see "a caller id the tenant already holds"). A constraint
    // this store really never emitted is one a hand or another tool added.
    const original = pgError("23505", "catalog_sku_legacy_key");
    const cap = capturePg([], (sql) => (sql.startsWith("INSERT") ? original : null));
    const err = await catalogStore(cap)
      .create(TENANT, "Catalog", { id: "c1", sku: "S1" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).not.toBeInstanceOf(UniqueViolation);
    expect(err).toBe(original);
  });

  it("re-throws a non-23505 untouched, even when it names an index this store did emit", async () => {
    // The constraint here *is* attributable, so only the SQLSTATE check can be what declines the
    // translation: the keying is on `23505` and not on "something went wrong during a write".
    const original = pgError("42501", "catalog_sku_uniq");
    const cap = capturePg([], (sql) => (sql.startsWith("INSERT") ? original : null));
    const err = await catalogStore(cap)
      .create(TENANT, "Catalog", { id: "c1", sku: "S1" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBe(original);
    // The `23505` half beside it, because a bare re-throw is also what an *unattributable*
    // constraint produces — so one name under two SQLSTATEs with opposite outcomes is the only
    // shape that shows which of the two checks declined. The sibling above asserts the field;
    // this asserts that attributability was not what decided it here.
    const dup = pgError("23505", "catalog_sku_uniq");
    const capDup = capturePg([], (sql) => (sql.startsWith("INSERT") ? dup : null));
    await expect(
      catalogStore(capDup).create(TENANT, "Catalog", { id: "c1", sku: "S1" }),
    ).rejects.toBeInstanceOf(UniqueViolation);
  });

  it("names an encrypted unique field as withheld, and emits no index for it", async () => {
    // A local fixture rather than an edit to `WIDGET`, so no existing test changes meaning.
    const CHART: Entity = {
      name: "Chart",
      fields: [
        { name: "mrn", type: { kind: "text" }, classification: "phi", unique: true },
        { name: "code", type: { kind: "text" }, unique: true },
      ],
    };
    const cap = capturePg();
    const s = new ColumnMappedEntityStore(cap.conn, { entities: [CHART] } as unknown as Manifest, {
      schema: "tenant_app",
      encryptionKey: () => KEY,
    });
    expect(s.uniqueWithheld()).toEqual([
      { entity: "Chart", field: "mrn", reason: "encrypted_at_rest" },
    ]);
    // Both directions, because reporting "withheld" beside an index that exists is the worse of
    // the two errors: an operator reading `\d` would see a constraint `pgp_sym_encrypt`'s
    // non-determinism makes inert — two rows with one plaintext encrypt to different bytes.
    await s.ensureSchema();
    const indexes = cap.calls.map((c) => c.sql).filter((q) => q.includes("CREATE UNIQUE INDEX"));
    expect(indexes).toHaveLength(1);
    expect(indexes[0]).toContain('"chart_code_uniq"');
  });

  it("carries a scoped unique through ensureSchema as (tenant_id, scope, column)", async () => {
    const SEAT: Entity = {
      name: "Seat",
      fields: [
        { name: "dept", type: { kind: "text" } },
        { name: "seat_no", type: { kind: "text" }, unique: { scope: ["dept"] } },
      ],
    };
    const cap = capturePg();
    await new ColumnMappedEntityStore(cap.conn, { entities: [SEAT] } as unknown as Manifest, {
      schema: "tenant_app",
    }).ensureSchema();
    const indexes = cap.calls.map((c) => c.sql).filter((q) => q.includes("CREATE UNIQUE INDEX"));
    // Counted before it is read, or `find` would silently assert about whichever index came first
    // if a second unique field were ever added to this fixture.
    expect(indexes).toHaveLength(1);
    const index = indexes[0]!;
    // Tenant first, then the declared scope, then the column — a multi-column index serves a
    // prefix of its own columns, so leading with `tenant_id` makes it useful to the tenant-filtered
    // reads every op here issues. The emitter has its own unit tests; what this adds is that the
    // *store* carries the scope through, which is the measured 0-of-47 form no pack declares.
    expect(index).toContain('("tenant_id", "dept", "seat_no")');
  });

  it("issues no CREATE UNIQUE INDEX for an index the catalog already holds valid", async () => {
    // `IF NOT EXISTS` decides after taking a SHARE lock on the table, so issuing it for an index
    // that is there blocks every boot behind an open write for nothing.
    const SEAT: Entity = {
      name: "Seat",
      fields: [{ name: "seat_no", type: { kind: "text" }, unique: true }],
    };
    const present = capturePg([{ valid: true }]);
    await new ColumnMappedEntityStore(present.conn, { entities: [SEAT] } as unknown as Manifest, {
      schema: "tenant_app",
    }).ensureSchema();
    const probe = present.calls.find((c) => c.sql.includes("FROM pg_index x"));
    expect(probe?.params).toEqual(['"tenant_app"."seat_seat_no_uniq"']);
    expect(present.calls.some((c) => c.sql.includes("CREATE UNIQUE INDEX"))).toBe(false);
    // An invalid one is still asked for, as before: `IF NOT EXISTS` was the behaviour there.
    const invalid = capturePg([{ valid: false }]);
    await new ColumnMappedEntityStore(invalid.conn, { entities: [SEAT] } as unknown as Manifest, {
      schema: "tenant_app",
    }).ensureSchema();
    expect(invalid.calls.filter((c) => c.sql.includes("CREATE UNIQUE INDEX"))).toHaveLength(1);
  });
});

describe("ColumnMappedEntityStore — a foreign-key violation names the reference", () => {
  // The document store refuses the same two requests by lookup, so one request answers the same on
  // both stores. Before this a `23503` reached the handler as the opaque 500 on this store while the
  // document store stored the dangling id and answered 201.
  const REFS = {
    entities: [
      { name: "Account", fields: [{ name: "name", type: { kind: "text" } }] },
      {
        name: "Contact",
        fields: [{ name: "account", type: { kind: "reference", target: "Account" } }],
      },
    ],
  } as unknown as Manifest;
  const refStore = (cap: Captured): ColumnMappedEntityStore =>
    new ColumnMappedEntityStore(cap.conn, REFS, { schema: "tenant_app" });

  it("turns a 23503 on this entity's own key into a ReferenceNotFound on write", async () => {
    const cap = capturePg([], (sql) =>
      sql.startsWith("INSERT") ? pgError("23503", "fk_contact_account_id") : null,
    );
    const err = await refStore(cap)
      .create(TENANT, "Contact", { id: "c1", account: "nope" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ReferenceNotFound);
    expect(err).toMatchObject({ entity: "Contact", field: "account", target: "Account" });
  });

  it("turns a 23503 on a delete into ReferencedRecordInUse naming the referencing field", async () => {
    const cap = capturePg([], (sql) =>
      sql.startsWith("DELETE") ? pgError("23503", "fk_contact_account_id") : null,
    );
    const err = await refStore(cap)
      .remove(TENANT, "Account", "a1")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ReferencedRecordInUse);
    expect(err).toMatchObject({ entity: "Account", referencedBy: "Contact", field: "account" });
  });

  it("re-throws a 23503 from a key this store did not emit, untouched", async () => {
    const original = pgError("23503", "some_other_fk");
    const cap = capturePg([], (sql) =>
      sql.startsWith("INSERT") || sql.startsWith("DELETE") ? original : null,
    );
    for (const op of [
      () => refStore(cap).create(TENANT, "Contact", { id: "c1", account: "a1" }),
      () => refStore(cap).remove(TENANT, "Account", "a1"),
    ]) {
      const err = await op().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBe(original);
    }
  });

  it("does not claim another entity's key as this write's dangling reference", async () => {
    // A 23503 on an INSERT into Account naming Contact's key is not a reference Account wrote.
    const original = pgError("23503", "fk_contact_account_id");
    const cap = capturePg([], (sql) => (sql.startsWith("INSERT") ? original : null));
    const err = await refStore(cap)
      .create(TENANT, "Account", { id: "a1", name: "x" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBe(original);
  });
});

describe("ColumnMappedEntityStore — an encrypted scalar keeps its type (ADR-0414 Q1)", () => {
  const VAULT: Entity = {
    name: "Vault",
    fields: [
      { name: "count", type: { kind: "integer" }, classification: "phi" },
      { name: "flag", type: { kind: "boolean" }, classification: "phi" },
      { name: "code", type: { kind: "text" }, classification: "phi" },
      { name: "tags", type: { kind: "array", element: { kind: "text" } }, classification: "phi" },
    ],
  };
  const vault = (cap: Captured): ColumnMappedEntityStore =>
    new ColumnMappedEntityStore(cap.conn, { entities: [VAULT] } as unknown as Manifest, {
      schema: "tenant_app",
      encryptionKey: () => KEY,
    });

  it.each([
    ["count", 7, "7"],
    ["count", -3, "-3"],
    ["flag", true, "true"],
    ["flag", false, "false"],
    ["code", "007", "007"],
    ["tags", ["a", "b,c"], '["a","b,c"]'],
  ] as const)("encrypts %s = %j as %s and reads it back unchanged", async (field, value, text) => {
    const cap = capturePg();
    await vault(cap).create(TENANT, "Vault", { id: "v1", [field]: value });
    expect(cap.calls.find((c) => c.sql.includes("INSERT INTO"))!.params[2]).toBe(text);
    const read = capturePg([{ id: "v1", [field]: text }]);
    expect((await vault(read).get(TENANT, "Vault", "v1"))?.[field]).toEqual(value);
  });

  it("leaves text that is not an integer's or a boolean's spelling as the text it is", async () => {
    const read = capturePg([{ id: "v1", count: "seven", flag: "yes" }]);
    expect(await vault(read).get(TENANT, "Vault", "v1")).toEqual({
      id: "v1",
      count: "seven",
      flag: "yes",
    });
  });
});

// ---------------------------------------------------------------------------
// ADR-0474: the store's write and read diagnostics.
// ---------------------------------------------------------------------------

describe("ColumnMappedEntityStore — a caller id the tenant already holds", () => {
  const pkey = (constraint: string) =>
    Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
      code: "23505",
      constraint,
    });

  it("raises RecordIdConflict for a 23505 on the table's own primary key", async () => {
    expect(entityPrimaryKeyConstraintName("widget")).toBe("widget_pkey");
    const cap = capturePg([], (sql) => (sql.startsWith("INSERT") ? pkey("widget_pkey") : null));
    const err = await store(cap)
      .create(TENANT, "Widget", { id: "w-1", sku: "A" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecordIdConflict);
    expect((err as RecordIdConflict).entity).toBe("Widget");
    expect((err as RecordIdConflict).id).toBe("w-1");
  });

  it("leaves a 23505 on any other constraint to the unique-violation path", async () => {
    const cap = capturePg([], (sql) => (sql.startsWith("INSERT") ? pkey("something_else_key") : null));
    const err = await store(cap)
      .create(TENANT, "Widget", { id: "w-1", sku: "A" })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RecordIdConflict);
    expect(err).not.toBeInstanceOf(UniqueViolation);
  });

  it("predicts Postgres's truncation of a long table's primary-key name", () => {
    const long = "a".repeat(70);
    const name = entityPrimaryKeyConstraintName(long);
    expect(name).toHaveLength(63);
    expect(name.endsWith("_pkey")).toBe(true);
    expect(isPrimaryKeyViolation({ code: "23505", constraint: name }, long)).toBe(true);
    expect(isPrimaryKeyViolation({ code: "23503", constraint: name }, long)).toBe(false);
  });
});

describe("ColumnMappedEntityStore — a page holding a row the store cannot represent", () => {
  const EVENT: Entity = {
    name: "Event",
    fields: [
      { name: "title", type: { kind: "text" } },
      { name: "at", type: { kind: "datetime" } },
    ],
  };
  const eventStore = (cap: Captured) =>
    new ColumnMappedEntityStore(cap.conn, { entities: [EVENT] } as unknown as Manifest, {
      schema: "tenant_app",
    });
  const query = { limit: 10, cursor: null, sort: [], filters: [] };

  it("refuses the whole page naming every unreadable row, and keeps the readable ones out of a short answer", async () => {
    // Measured, the mapper is total over every value node-postgres hands back today — an invalid
    // `Date` reads as the string "Invalid Date", which the wire-type decorator refuses above this
    // store — so the refusal is exercised by a row whose column read itself throws, the shape a
    // mapper's own guard would produce. What is under test is that one bad row refuses the page,
    // names every bad row and drops none.
    const raising = (id: string) => ({
      id,
      title: "far",
      get at(): unknown {
        throw new RangeError("Invalid time value");
      },
    });
    const cap = capturePg([
      { id: "ev-ok", title: "fine", at: new Date("2026-01-01T00:00:00.000Z") },
      raising("ev-bad"),
      raising("ev-bad-2"),
    ]);
    const err = await eventStore(cap).listPage(TENANT, "Event", query).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ListRowUnreadable);
    const refused = err as ListRowUnreadable;
    expect(refused.entity).toBe("Event");
    expect(refused.rows.map((r) => r.identity)).toEqual(["ev-bad", "ev-bad-2"]);
    expect(refused.rows[0]!.detail).toMatch(/Invalid time value/);
  });

  it("serves a page whose rows all read, which is the control", async () => {
    const cap = capturePg([{ id: "ev-ok", title: "fine", at: new Date("2026-01-01T00:00:00.000Z") }]);
    const page = await eventStore(cap).listPage(TENANT, "Event", query);
    expect(page.records.map((r) => r["id"])).toEqual(["ev-ok"]);
    expect(page.records[0]!["at"]).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("ColumnMappedEntityStore — a boot DDL statement stopped by a lock", () => {
  const lock = () =>
    Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });

  it("names the table and the act instead of Postgres's bare 'lock timeout'", async () => {
    const cap = capturePg([], (sql) =>
      sql.includes('CREATE TABLE IF NOT EXISTS "tenant_app"."widget"') ? lock() : null,
    );
    const s = new ColumnMappedEntityStore(cap.conn, MANIFEST, {
      schema: "tenant_app",
      encryptionKey: () => KEY,
      ddl: { lockRetries: 0, sleep: async () => undefined },
    });
    const err = await s.ensureSchema().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BootDdlStopped);
    const stopped = err as BootDdlStopped;
    expect(stopped.stop).toBe("lock_timeout");
    expect(stopped.tables).toEqual(["tenant_app.widget"]);
    expect(stopped.action).toBe("CREATE TABLE");
    expect(stopped.message).toContain("tenant_app.widget");
    expect(stopped.message).toContain("pg_locks");
    // The lookup is pasteable: it names the table, not a placeholder.
    expect(stopped.message).toContain("l.relation IN ('tenant_app.widget'::regclass)");
    expect(stopped.message).not.toContain("<table>");
    expect((stopped.cause as { code?: string }).code).toBe("55P03");
  });

  it("tells a statement-timeout stop to run the act by hand, not to raise a bound no flag reaches", async () => {
    // `applyBootStatement` sets its `statement_timeout` with `SET LOCAL`, which overrides the
    // session's `--pg-statement-timeout-ms` and which no flag reaches; the first draft said "raise it
    // for this boot", a remedy that could not be followed (found in review).
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const cap = capturePg([], (sql) =>
      sql.includes('CREATE TABLE IF NOT EXISTS "tenant_app"."widget"') ? timeout : null,
    );
    const err = await new ColumnMappedEntityStore(cap.conn, MANIFEST, {
      schema: "tenant_app",
      encryptionKey: () => KEY,
      ddl: { lockRetries: 0, sleep: async () => undefined },
    })
      .ensureSchema()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BootDdlStopped);
    const stopped = err as BootDdlStopped;
    expect(stopped.stop).toBe("statement_timeout");
    expect(stopped.message).toContain("run that CREATE TABLE on tenant_app.widget by hand");
    expect(stopped.message).not.toMatch(/raise it/);
    expect(stopped.message).not.toMatch(/--pg-statement-timeout-ms/);
  });

  it("leaves every other DDL failure as it was", async () => {
    const denied = Object.assign(new Error("permission denied for schema tenant_app"), { code: "42501" });
    const cap = capturePg([], (sql) => (sql.includes("CREATE TABLE") ? denied : null));
    const s = new ColumnMappedEntityStore(cap.conn, MANIFEST, {
      schema: "tenant_app",
      encryptionKey: () => KEY,
      ddl: { lockRetries: 0, sleep: async () => undefined },
    });
    await expect(s.ensureSchema()).rejects.toBe(denied);
  });

  it("names both tables of a foreign key, which locks both", () => {
    const sql =
      `DO $ce_fk$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = '"s"."order"'::regclass) THEN ` +
      `ALTER TABLE "s"."order" ADD CONSTRAINT "fk_order_account_id" FOREIGN KEY ("tenant_id", "account_id") ` +
      `REFERENCES "s"."account" ("tenant_id", "id") ON DELETE RESTRICT; END IF; END $ce_fk$;`;
    expect(describeBootDdlStatement(sql, "s", new Set(["order", "account"]))).toEqual({
      tables: ["s.order", "s.account"],
      action: "ADD FOREIGN KEY",
    });
    // An index name that merely starts with a table's name is not a table this store plans.
    expect(
      describeBootDdlStatement(`SELECT to_regclass('"s"."order_title_utrgm"')`, "s", new Set(["order"])).tables,
    ).toEqual([]);
  });
});

describe("ColumnMappedEntityStore — why a unique index was refused", () => {
  const SHELF: Entity = {
    name: "Shelf",
    fields: [{ name: "ean", type: { kind: "text" }, unique: true }],
  };

  it("tells the reporter the field and the cause, and calls only a 23505 duplicates", async () => {
    for (const [err, cause] of [
      [Object.assign(new Error("could not create unique index"), { code: "23505" }), "duplicates"],
      [Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }), "timed_out"],
      [Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }), "timed_out"],
      [new Error("out of disk"), "other"],
    ] as const) {
      const seen: unknown[] = [];
      const cap = capturePg([], (sql) => (sql.includes("shelf_ean_uniq") ? err : null));
      await new ColumnMappedEntityStore(cap.conn, { entities: [SHELF] } as unknown as Manifest, {
        schema: "tenant_app",
        ddl: { lockRetries: 0, sleep: async () => undefined },
        onUniqueIndexRefused: (_e, _s, _d, facts) => seen.push(facts),
      }).ensureSchema();
      expect(seen).toEqual([{ field: "ean", cause }]);
    }
    expect(UNIQUE_INDEX_REFUSAL_CAUSES).toEqual(["duplicates", "timed_out", "other"]);
    expect(uniqueIndexRefusalCause("not an error")).toBe("other");
  });
});
