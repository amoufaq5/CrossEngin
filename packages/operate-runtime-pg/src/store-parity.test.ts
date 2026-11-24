import type { PgConnection } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import {
  FIELD_LIST_VALUE_TYPES,
  InMemoryEntityStore,
  LIST_VALUE_TYPES,
  encodeKeyset,
  taxRemittanceGlPostingEffect,
  taxRemittanceReversalEffect,
  taxRemittanceStampClearEffect,
  taxRemittanceWiring,
  type EntityRecord,
  listValueTypesForManifest,
  type ListQuery,
  type ListValueType,
} from "@crossengin/operate-runtime";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import type { Entity, PrimitiveFieldType } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { columnPlansForManifest } from "./column-plan.js";
import { ColumnMappedEntityStore } from "./column-store.js";
import { PostgresEntityStore } from "./entity-store.js";
import { VALUE_TYPE_COMPARABLE } from "./list-sql.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

/**
 * Every field kind a manifest can declare, minus `duration`, `geo_point` and `geo_polygon` — which
 * have no wire form and are refused at plan time (see `UNDECIDED_SQL_TYPES`), so there is no parity
 * to assert about them.
 *
 * Built from `FIELD_LIST_VALUE_TYPES`'s own keys rather than from a list written here, so a
 * twenty-fourth field kind lands in this test the moment the kernel declares one.
 */
const KINDS = (Object.keys(FIELD_LIST_VALUE_TYPES) as PrimitiveFieldType["kind"][]).filter(
  (k) => k !== "duration" && k !== "geo_point" && k !== "geo_polygon",
);

function fieldTypeFor(kind: PrimitiveFieldType["kind"]): PrimitiveFieldType {
  switch (kind) {
    case "decimal":
      return { kind, precision: 12, scale: 2 };
    case "enum":
      return { kind, values: ["a", "b"] };
    case "reference":
      return { kind, target: "Other" };
    default:
      return { kind } as PrimitiveFieldType;
  }
}

const ENTITY: Entity = {
  name: "Probe",
  fields: KINDS.map((kind) => ({ name: `f_${kind}`, type: fieldTypeFor(kind) })),
};
const OTHER: Entity = { name: "Other", fields: [{ name: "name", type: { kind: "text" } }] };
const MANIFEST = { entities: [ENTITY, OTHER] } as unknown as Manifest;

interface Captured {
  readonly conn: PgConnection;
  readonly calls: { sql: string; params: readonly unknown[] }[];
}

function capturePg(rows: Record<string, unknown>[] = []): Captured {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const query = (async (sql: string, params?: readonly unknown[]) => {
    if (sql.includes("set_config")) return { rows: [], rowCount: 0 };
    calls.push({ sql, params: params ?? [] });
    return { rows, rowCount: rows.length };
  }) as PgConnection["query"];
  const conn: PgConnection = {
    query,
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, calls };
}

const VALUE_TYPES = listValueTypesForManifest(MANIFEST).get("Probe");

function queryFor(field: string, direction: "asc" | "desc", cursor: string | null): ListQuery {
  return {
    limit: 10,
    cursor,
    sort: [{ field, direction }],
    filters: [],
    // The JSONB store needs the manifest's declaration (its columns are all TEXT); the column store
    // reads its own column types and ignores this. Supplying it to both is what `compileOperateServer`
    // does, so the two stores are compared under the wiring they actually run under.
    valueTypes: VALUE_TYPES,
  };
}

async function listSqlFor(
  store: PostgresEntityStore | ColumnMappedEntityStore,
  cap: Captured,
  query: ListQuery,
): Promise<string> {
  cap.calls.length = 0;
  await store.listPage(TENANT, "Probe", query);
  const select = cap.calls.find((c) => c.sql.includes("ORDER BY"));
  expect(select).toBeDefined();
  return select!.sql;
}

/** The SELECT whose ORDER BY this assertion is about. */
function cap0(cap: Captured): { sql: string; params: readonly unknown[] } {
  const call = cap.calls.find((c) => c.sql.includes("ORDER BY"));
  expect(call).toBeDefined();
  return call!;
}

function orderByOf(sql: string): string {
  return /ORDER BY ([\s\S]*?)\n?\s*LIMIT/.exec(sql)?.[1]?.trim() ?? "";
}

/**
 * The defect this file exists for is **two implementations of one `EntityStore` disagreeing**, and
 * ADR-0331 established that the disagreement surfaces as a production pagination failure rather
 * than as a test failure: the keyset cursor is built from the ordering, so a disagreement does not
 * merely reorder a page, it skips and repeats rows at every page boundary. ADR-0333 found the same
 * shape again in a decimal that sorted lexicographically and a walk that did not terminate.
 *
 * So the two stores are driven through *one* `ListQuery` and their emitted SQL compared on the
 * three things that decide a page sequence: which comparison type each key has, where NULLs sit,
 * and what the seek does with a cursor component.
 *
 * What this cannot cover, stated plainly: a fake `PgConnection` answers every statement and
 * executes none, so it cannot compare *row* sequences — that is the boundary ADR-0333 named, and
 * the page-sequence comparison is a live check (`B-live.mjs` in this increment's evidence, which
 * walks both stores over one seeded corpus at limit 3 and at limit 100 and asserts the sequences
 * match). It also covers only the field kinds a manifest can declare, which is why `KINDS` is
 * derived from `FIELD_LIST_VALUE_TYPES` rather than listed here.
 */
describe("the two Postgres stores agree about ordering", () => {
  it("assigns every field kind the same comparison type in both stores", async () => {
    const jsonbCap = capturePg();
    const colCap = capturePg();
    const jsonb = new PostgresEntityStore(jsonbCap.conn);
    const cols = new ColumnMappedEntityStore(colCap.conn, MANIFEST, { schema: "tenant_app" });
    for (const kind of KINDS) {
      const field = `f_${kind}`;
      const declared: ListValueType = VALUE_TYPES?.get(field) ?? "text";
      const jsonbSql = await listSqlFor(jsonb, jsonbCap, queryFor(field, "asc", null));
      const colSql = await listSqlFor(cols, colCap, queryFor(field, "asc", null));
      // The JSONB store casts iff the manifest declares a non-text comparison; the column store's
      // column already carries the type. So the *observable* agreement is: whenever one compares
      // numerically or as an instant, so does the other.
      const jsonbCasts = /::numeric|::timestamptz/.test(orderByOf(jsonbSql));
      expect(jsonbCasts).toBe(declared !== "text");
      // And the column store's own type must agree with the manifest's declaration, which is the
      // half that was wrong for `decimal` before ADR-0332 and for `datetime` before this. The
      // column store's ORDER BY is the bare column either way — its *type* shows in what it binds
      // a cursor as, so that is where the two are compared.
      expect(orderByOf(colSql)).toContain("NULLS LAST");
      const probe = declared === "timestamptz" ? "2026-01-31T11:00:00.000Z" : "9.00";
      const withCursor = queryFor(field, "asc", encodeKeyset({ k: [probe], id: "r01" }));
      const colSeek = await listSqlFor(cols, colCap, withCursor);
      const jsonbSeek = await listSqlFor(jsonb, jsonbCap, withCursor);
      // Both bind the component, or neither does: a component one store compares and the other
      // reads as the NULL tail is precisely the page-boundary skip this file exists for.
      expect(colSeek.includes("IS NULL") && !colSeek.includes("= $"))
        .toBe(jsonbSeek.includes("IS NULL") && !jsonbSeek.includes("= $"));
    }
  });

  it("puts NULLS LAST in both stores, in both directions, for every field kind", async () => {
    const jsonbCap = capturePg();
    const colCap = capturePg();
    const jsonb = new PostgresEntityStore(jsonbCap.conn);
    const cols = new ColumnMappedEntityStore(colCap.conn, MANIFEST, { schema: "tenant_app" });
    for (const kind of KINDS) {
      for (const direction of ["asc", "desc"] as const) {
        const q = queryFor(`f_${kind}`, direction, null);
        // One placement, both directions, both stores. Postgres's default moves the tail with the
        // direction, so inheriting it would make a cursor component mean one thing ascending and
        // another descending — and the store that inherited it would disagree with the store that
        // did not.
        expect(orderByOf(await listSqlFor(jsonb, jsonbCap, q))).toContain(
          `${direction === "desc" ? "DESC" : "ASC"} NULLS LAST`,
        );
        expect(orderByOf(await listSqlFor(cols, colCap, q))).toContain(
          `${direction === "desc" ? "DESC" : "ASC"} NULLS LAST`,
        );
      }
    }
  });

  it("reads a null cursor component as the NULL tail in both stores, for every field kind", async () => {
    const jsonbCap = capturePg();
    const colCap = capturePg();
    const jsonb = new PostgresEntityStore(jsonbCap.conn);
    const cols = new ColumnMappedEntityStore(colCap.conn, MANIFEST, { schema: "tenant_app" });
    const cursor = encodeKeyset({ k: [null], id: "r01" });
    for (const kind of KINDS) {
      const q = queryFor(`f_${kind}`, "asc", cursor);
      for (const [store, cap] of [
        [jsonb, jsonbCap],
        [cols, colCap],
      ] as const) {
        const sql = await listSqlFor(store, cap, q);
        // `null` means the previous page ended in the tail, so nothing sorts after it on this key
        // and the only remaining disjunct is the id tiebreaker over `IS NULL`.
        expect(sql).toContain("IS NULL");
        const bound = cap.calls.find((c) => c.sql.includes("ORDER BY"))!.params;
        // Exactly the tenant (+ entity, for the JSONB store) and the tiebreaker id and limit are
        // bound: a null component binds no parameter in either store.
        expect(bound).toContain("r01");
      }
    }
  });

  it("drops a cursor component neither store can bind, rather than one store raising on it", async () => {
    const jsonbCap = capturePg();
    const colCap = capturePg();
    const jsonb = new PostgresEntityStore(jsonbCap.conn);
    const cols = new ColumnMappedEntityStore(colCap.conn, MANIFEST, { schema: "tenant_app" });
    // A forged cursor: `decodeKeyset` reads base64 JSON a client holds, so this is reachable from
    // the outside. Before, the column store bound it with the column's own cast — `'DROP'::DATE`,
    // `''::TIMESTAMPTZ` — and answered 500 where it should answer a page.
    for (const forged of ["DROP", "", "n/a"]) {
      const cursor = encodeKeyset({ k: [forged], id: "r01" });
      // The column store is where this is a 500: its `castSuffix` is the column's own SQL type, so
      // binding the component means `'DROP'::DATE`. The JSONB store compares a `date`/`time` field
      // as text with no cast at all, so binding `'DROP'` there is an ordinary text comparison that
      // matches nothing — which is why the claim is about the typed store and not about both.
      for (const field of ["f_datetime", "f_date", "f_time", "f_decimal", "f_integer"]) {
        const sql = await listSqlFor(cols, colCap, queryFor(field, "asc", cursor));
        const bound = cap0(colCap).params;
        expect(bound).not.toContain(forged);
        expect(sql).toContain("IS NULL");
      }
      // And on the JSONB store, the same component is read as the NULL tail for exactly the fields
      // whose comparison is typed — the two agree about `f_datetime`, `f_decimal` and `f_integer`.
      for (const field of ["f_datetime", "f_decimal", "f_integer"]) {
        await listSqlFor(jsonb, jsonbCap, queryFor(field, "asc", cursor));
        expect(cap0(jsonbCap).params).not.toContain(forged);
      }
    }
  });

  it("covers every comparison type the contract declares", () => {
    // `VALUE_TYPE_COMPARABLE` is a total map over `ListValueType`, so a fourth member is already a
    // compile error. This asserts the runtime half: that each member has a usable predicate, so a
    // member added with a placeholder cannot pass the type check and then admit everything.
    for (const type of LIST_VALUE_TYPES) {
      expect(typeof VALUE_TYPE_COMPARABLE[type]).toBe("function");
    }
    expect(VALUE_TYPE_COMPARABLE.text("")).toBe(true);
    expect(VALUE_TYPE_COMPARABLE.numeric("")).toBe(false);
    expect(VALUE_TYPE_COMPARABLE.timestamptz("")).toBe(false);
  });

  it("names the field kinds whose comparison type the two stores answer independently", () => {
    // The parity claim in one place, as data. `datetime` is the member this increment moved: the
    // manifest declares `timestamptz` and the column store reads `TIMESTAMPTZ` off its own column,
    // and before this increment the second answered `text` — so the JSONB store ordered a legacy
    // offset spelling five positions away from where the column store ordered it (measured live).
    expect(FIELD_LIST_VALUE_TYPES.datetime).toBe("timestamptz");
    expect(FIELD_LIST_VALUE_TYPES.decimal).toBe("numeric");
    expect(FIELD_LIST_VALUE_TYPES.integer).toBe("numeric");
    // `date` and `time` stay text in **both**: their canonical spellings are fixed-width and
    // zero-padded, so byte order is chronological, and `date_in`/`time_in` are STABLE — a cast
    // would be unindexable and `DateStyle`-dependent for no ordering gain.
    expect(FIELD_LIST_VALUE_TYPES.date).toBe("text");
    expect(FIELD_LIST_VALUE_TYPES.time).toBe("text");
  });
});

/**
 * The write half, which nothing compared: the ordering tests above drive only `listPage`, so a field
 * the two stores *stored* differently was invisible here. And the three JSONB-typed kinds were
 * stored differently — the JSONB store binds the whole document as JSON text, while the column store
 * bound a JSONB column's value raw, which node-postgres sends as bare text for a string and as a
 * Postgres array literal for an array, so both raised 22P02 (measured live, and through
 * `POST /v1/expenses` as a 500 on `Expense.receipt`).
 *
 * Compared on the bound parameters, which is what a fake can see: each store's bound text parsed
 * back must be the value the caller sent. The JSONB fields are read off the column plan rather than
 * listed, so a fourth JSONB-typed kind lands here when the kernel maps one.
 */
describe("the two Postgres stores agree about what a JSONB-typed field stores", () => {
  const JSONB_FIELDS = (columnPlansForManifest(MANIFEST, { schema: "tenant_app" }).get("Probe")?.columns ?? [])
    .filter((c) => c.sqlType === "JSONB")
    .map((c) => c.field);

  const SHAPES: readonly unknown[] = [
    "t_abc/receipts/f1.pdf",
    "",
    '{"a":1}',
    42,
    true,
    ["a", 1],
    { key: "k", n: [1] },
    [{ a: "x" }],
  ];

  it("finds the three JSONB-typed kinds, so the comparison below is not over nothing", () => {
    expect([...JSONB_FIELDS].sort()).toEqual(["f_currency_amount", "f_file", "f_json"]);
  });

  it("binds every JSON value shape so it parses back to what the caller sent, in both stores", async () => {
    for (const field of JSONB_FIELDS) {
      for (const value of SHAPES) {
        const jsonbCap = capturePg();
        const colCap = capturePg();
        const record = { id: "r01", [field]: value };
        await new PostgresEntityStore(jsonbCap.conn).create(TENANT, "Probe", record);
        await new ColumnMappedEntityStore(colCap.conn, MANIFEST, { schema: "tenant_app" }).create(
          TENANT,
          "Probe",
          record,
        );
        const docInsert = jsonbCap.calls.find((c) => c.sql.includes("INSERT INTO"))!;
        const colInsert = colCap.calls.find((c) => c.sql.includes("INSERT INTO"))!;
        const document = JSON.parse(docInsert.params[3] as string) as Record<string, unknown>;
        // One placeholder for the one field, after the tenant and the id.
        expect(colInsert.sql).toContain("$3::jsonb");
        const columnValue: unknown = JSON.parse(colInsert.params[2] as string);
        expect(columnValue).toEqual(value);
        expect(document[field]).toEqual(value);
      }
    }
  });
});

/**
 * A key a write effect sends that the entity does not declare is kept by the document store and
 * dropped by the column store, so a remittance posted on `--store pg` and on `--store pg-columns`
 * would read back differently — an entry with a currency on one and none on the other, or a return
 * whose stamp survives on one. So every key the remittance effects write is asserted to be a planned
 * column of the entity it is written to, which is what makes the two stores hold the same entry,
 * lines and stamps (ADR-0467).
 */
describe("the two Postgres stores hold the same tax remittance", () => {
  const CORE = buildErpCorePack();
  const PLANS = columnPlansForManifest(CORE, { schema: "public" });
  const WIRING = taxRemittanceWiring(CORE)!;
  const T = "11111111-1111-1111-1111-111111111111";

  class Recording extends InMemoryEntityStore {
    readonly written: { entity: string; keys: readonly string[] }[] = [];
    armed = false;
    override create(tenantId: string, entity: string, data: EntityRecord): Promise<EntityRecord> {
      if (this.armed) this.written.push({ entity, keys: Object.keys(data) });
      return super.create(tenantId, entity, data);
    }
    override update(tenantId: string, entity: string, id: string, patch: EntityRecord): Promise<EntityRecord | null> {
      if (this.armed) this.written.push({ entity, keys: Object.keys(patch) });
      return super.update(tenantId, entity, id, patch);
    }
  }

  it("writes only keys the column store plans as columns, for the posting, its reversal and the stamp clear", async () => {
    const store = new Recording();
    const ids: Record<string, string> = {};
    for (const code of ["2200", "1400", "1000"]) {
      ids[code] = String((await store.create(T, "LedgerAccount", { account_code: code }))["id"]);
    }
    const seed = await store.create(T, "JournalEntry", { entry_number: "SEED", state: "posted" });
    for (const [code, d, c] of [["2200", 0, 1000], ["1400", 300, 0]] as const) {
      await store.create(T, "JournalLine", {
        journal_entry_id: String(seed["id"]),
        ledger_account_id: ids[code],
        currency: "USD",
        debit: d,
        credit: c,
        functional_debit: d,
        functional_credit: c,
      });
    }
    const filed = await store.create(T, "TaxReturn", {
      return_number: "TR-1",
      state: "filed",
      return_type: "vat",
      jurisdiction_id: "jur-1",
      period_start: "2026-01-01",
      period_end: "2026-03-31",
      output_tax: 1000,
      input_tax: 300,
      net_payable: 700,
      currency: "USD",
      updated_by: "00000000-0000-4000-8000-0000000000aa",
    });
    const id = String(filed["id"]);
    const settings = {
      get: () =>
        Promise.resolve({
          defaults: { currency: "USD" },
          finance: {
            taxPayableAccountCode: "2200",
            taxInputAccountCode: "1400",
            cashAccountCode: "1000",
            taxRemittancePosting: "on_mark_paid" as const,
          },
        }),
    };
    store.armed = true;
    await taxRemittanceGlPostingEffect({ wiring: WIRING, settingsStore: settings })({
      operation: "transition",
      entity: "TaxReturn",
      tenantId: T,
      id,
      before: filed,
      after: { ...filed, state: "paid" },
      store,
    });
    // The effect stamps the return; the handler, not run here, is what moves its state.
    const paid = { ...(await store.get(T, "TaxReturn", id))!, state: "paid" };
    const reverse = {
      operation: "transition" as const,
      entity: "TaxReturn",
      tenantId: T,
      id,
      before: paid,
      after: { ...paid, state: "filed" },
      store,
    };
    await taxRemittanceReversalEffect({ wiring: WIRING })(reverse);
    await taxRemittanceStampClearEffect({ wiring: WIRING })(reverse);

    // The posting, its three lines and the stamp; the reversal entry, its three lines and the
    // original entry's state; the cleared stamp.
    expect(store.written.map((w) => w.entity)).toEqual([
      "JournalEntry",
      "JournalLine",
      "JournalLine",
      "JournalLine",
      "TaxReturn",
      "JournalEntry",
      "JournalLine",
      "JournalLine",
      "JournalLine",
      "JournalEntry",
      "TaxReturn",
    ]);
    for (const w of store.written) {
      const planned = new Set((PLANS.get(w.entity)?.columns ?? []).map((c) => c.field));
      for (const key of w.keys) {
        if (key === "id") continue;
        expect(planned.has(key), `${w.entity}.${key} is a column`).toBe(true);
      }
    }
  });
});
