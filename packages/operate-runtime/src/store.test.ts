import { describe, expect, it } from "vitest";

import {
  InMemoryEntityStore,
  applyListQuery,
  decodeKeyset,
  encodeKeyset,
  keysetOf,
  matchesFilter,
  projectRecord,
  type EntityRecord,
  type ListPage,
  type ListQuery,
  type ListSort,
} from "./store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function query(overrides: Partial<ListQuery> = {}): ListQuery {
  return { limit: 2, cursor: null, sort: [], filters: [], ...overrides };
}

describe("keyset cursor encoding", () => {
  it("round-trips a keyset position", () => {
    expect(decodeKeyset(encodeKeyset({ k: ["Apple"], id: "b" }))).toEqual({ k: ["Apple"], id: "b" });
  });
  it("reads a malformed or null cursor as null", () => {
    expect(decodeKeyset(null)).toBeNull();
    expect(decodeKeyset("!!!not-base64!!!")).toBeNull();
  });
});

describe("projectRecord", () => {
  const r = { id: "x", sku: "S1", name: "Milk", unit_cost: 1.1 };
  it("keeps id + requested fields, omits the rest", () => {
    expect(projectRecord(r, ["sku", "name"])).toEqual({ id: "x", sku: "S1", name: "Milk" });
  });
  it("always keeps id even if not requested, and ignores unknown fields", () => {
    expect(projectRecord(r, ["sku", "ghost"])).toEqual({ id: "x", sku: "S1" });
  });
});

describe("matchesFilter — typed operators", () => {
  const r = { id: "x", price: 10, status: "active" };
  it("eq / ne", () => {
    expect(matchesFilter(r, { field: "status", op: "eq", value: "active" })).toBe(true);
    expect(matchesFilter(r, { field: "status", op: "ne", value: "active" })).toBe(false);
  });
  it("numeric gt / gte / lt / lte (coerced)", () => {
    expect(matchesFilter(r, { field: "price", op: "gt", value: "5" })).toBe(true);
    expect(matchesFilter(r, { field: "price", op: "gte", value: "10" })).toBe(true);
    expect(matchesFilter(r, { field: "price", op: "lt", value: "10" })).toBe(false);
    expect(matchesFilter(r, { field: "price", op: "lte", value: "10" })).toBe(true);
  });
  it("in membership", () => {
    expect(matchesFilter(r, { field: "status", op: "in", value: ["active", "draft"] })).toBe(true);
    expect(matchesFilter(r, { field: "status", op: "in", value: ["draft"] })).toBe(false);
  });
  it("contains (case-insensitive substring)", () => {
    const c = { id: "y", name: "Acme Corporation" };
    expect(matchesFilter(c, { field: "name", op: "contains", value: "corp" })).toBe(true);
    expect(matchesFilter(c, { field: "name", op: "contains", value: "ACME" })).toBe(true);
    expect(matchesFilter(c, { field: "name", op: "contains", value: "xyz" })).toBe(false);
    expect(matchesFilter(c, { field: "missing", op: "contains", value: "a" })).toBe(false);
  });
  it("defaults to eq when op is omitted", () => {
    expect(matchesFilter(r, { field: "status", value: "active" })).toBe(true);
  });
});

describe("applyListQuery", () => {
  const rows = [
    { id: "a", name: "Cherry", status: "active", price: 30 },
    { id: "b", name: "Apple", status: "active", price: 10 },
    { id: "c", name: "Banana", status: "archived", price: 20 },
  ];

  it("sorts ascending and descending", () => {
    const asc = applyListQuery(rows, query({ limit: 10, sort: [{ field: "name", direction: "asc" }] }));
    expect(asc.records.map((r) => r["name"])).toEqual(["Apple", "Banana", "Cherry"]);
    const desc = applyListQuery(rows, query({ limit: 10, sort: [{ field: "name", direction: "desc" }] }));
    expect(desc.records.map((r) => r["name"])).toEqual(["Cherry", "Banana", "Apple"]);
  });

  it("filters by equality and by a typed operator", () => {
    const eq = applyListQuery(rows, query({ limit: 10, filters: [{ field: "status", value: "active" }] }));
    expect(eq.records).toHaveLength(2);
    const gt = applyListQuery(rows, query({ limit: 10, filters: [{ field: "price", op: "gt", value: "15" }] }));
    expect(gt.records.map((r) => r["id"]).sort()).toEqual(["a", "c"]);
  });

  it("free-text search matches ANY searchable field (case-insensitive)", () => {
    const searchRows = [
      { id: "a", name: "Almond Milk", notes: "dairy free" },
      { id: "b", name: "Whole Milk", notes: "keep cold" },
      { id: "c", name: "Orange Juice", notes: "contains milk solids" },
      { id: "d", name: "Water", notes: "still" },
    ];
    const hits = applyListQuery(
      searchRows,
      query({ limit: 10, search: { term: "MILK", fields: ["name", "notes"] } }),
    );
    // matches a (name), b (name), c (notes) — not d.
    expect(hits.records.map((r) => r["id"]).sort()).toEqual(["a", "b", "c"]);
  });

  it("search ANDs with typed filters", () => {
    const searchRows = [
      { id: "a", name: "Milk", status: "active" },
      { id: "b", name: "Milk", status: "archived" },
    ];
    const hits = applyListQuery(
      searchRows,
      query({ limit: 10, filters: [{ field: "status", value: "active" }], search: { term: "milk", fields: ["name"] } }),
    );
    expect(hits.records.map((r) => r["id"])).toEqual(["a"]);
  });

  it("keyset-paginates with a stable cursor (sorted by name)", () => {
    const sort = [{ field: "name" as const, direction: "asc" as const }];
    const first = applyListQuery(rows, query({ limit: 2, sort }));
    expect(first.records.map((r) => r["name"])).toEqual(["Apple", "Banana"]);
    expect(first.nextCursor).not.toBeNull();

    const second = applyListQuery(rows, query({ limit: 2, cursor: first.nextCursor, sort }));
    expect(second.records.map((r) => r["name"])).toEqual(["Cherry"]);
    expect(second.nextCursor).toBeNull();
  });

  it("keyset is stable when an earlier row is inserted between pages", () => {
    const sort = [{ field: "id" as const, direction: "asc" as const }];
    const first = applyListQuery(rows, query({ limit: 1, sort }));
    expect(first.records[0]!["id"]).toBe("a");
    // a new row "0" sorts before the cursor ("a"); keyset (unlike offset) skips
    // it and doesn't repeat "b" on the next page
    const withInserted = [...rows, { id: "0", name: "Z", status: "active", price: 1 }];
    const second = applyListQuery(withInserted, query({ limit: 1, cursor: first.nextCursor, sort }));
    expect(second.records[0]!["id"]).toBe("b");
  });
});

describe("InMemoryEntityStore.listPage", () => {
  it("returns a paginated page scoped to the (tenant, entity)", async () => {
    const store = new InMemoryEntityStore();
    for (const id of ["a", "b", "c"]) await store.create(TENANT, "Product", { id, n: id });
    const page = await store.listPage(TENANT, "Product", query({ limit: 2, sort: [{ field: "id", direction: "asc" }] }));
    expect(page.records.map((r) => r["id"])).toEqual(["a", "b"]);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe("ordering puts a missing value last in both directions", () => {
  // Three implementations of one `EntityStore` must not disagree about row order: both SQL stores
  // write `NULLS LAST` in both directions (ADR-0333), because Postgres's default moves the tail
  // with the direction while a cursor component cannot say which end it is at. The in-memory store
  // rendered a missing value as `""`, which sorts *first* ascending.
  const rows: EntityRecord[] = [
    { id: "a", at: "2026-01-31T10:00:00.000Z" },
    { id: "b" },
    { id: "c", at: "2026-01-30T10:00:00.000Z" },
    { id: "d", at: null },
  ];
  const q = (direction: "asc" | "desc"): ListQuery => ({
    limit: 10,
    cursor: null,
    sort: [{ field: "at", direction }],
    filters: [],
  });

  it("puts both an absent key and an explicit null at the tail ascending", () => {
    expect(applyListQuery(rows, q("asc")).records.map((r) => r["id"])).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  it("keeps them at the tail descending, rather than following the direction", () => {
    expect(applyListQuery(rows, q("desc")).records.map((r) => r["id"])).toEqual([
      "a",
      "c",
      "b",
      "d",
    ]);
  });

  it("still sorts an empty string as the value it is, first ascending", () => {
    const withEmpty: EntityRecord[] = [{ id: "a", at: "x" }, { id: "b", at: "" }, { id: "c" }];
    expect(applyListQuery(withEmpty, q("asc")).records.map((r) => r["id"])).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("breaks a tie among the tail by id, so the order is total", () => {
    const tail: EntityRecord[] = [{ id: "z" }, { id: "y" }, { id: "x", at: null }];
    expect(applyListQuery(tail, q("asc")).records.map((r) => r["id"])).toEqual(["x", "y", "z"]);
  });
});

describe("keysetOf holds a null, which is what makes the tail seekable", () => {
  it("renders a missing value as null and an empty string as itself", () => {
    const sort: ListSort[] = [{ field: "at", direction: "asc" }];
    expect(keysetOf({ id: "a" }, sort)).toEqual({ k: [null], id: "a" });
    expect(keysetOf({ id: "a", at: null }, sort)).toEqual({ k: [null], id: "a" });
    expect(keysetOf({ id: "a", at: "" }, sort)).toEqual({ k: [""], id: "a" });
  });

  it("round-trips through the cursor token", () => {
    const cursor = { k: ["x", null], id: "a" };
    expect(decodeKeyset(encodeKeyset(cursor))).toEqual(cursor);
  });

  it("still decodes a cursor issued before the widening, so none is invalidated", () => {
    // `string[]` is a valid `(string | null)[]`, which is why the format could be widened rather
    // than versioned — `list-sql.ts` recorded the opposite, that this "invalidates every cursor
    // in flight".
    const legacy = Buffer.from(JSON.stringify({ k: ["x", ""], id: "a" })).toString("base64url");
    expect(decodeKeyset(legacy)).toEqual({ k: ["x", ""], id: "a" });
  });

  it("refuses a component that is neither a string nor null", () => {
    const bad = Buffer.from(JSON.stringify({ k: [1], id: "a" })).toString("base64url");
    expect(decodeKeyset(bad)).toBeNull();
  });
});

describe("the keyset seek agrees with NULLS LAST", () => {
  const rows: EntityRecord[] = [
    { id: "c", at: "2026-01-30T10:00:00.000Z" },
    { id: "a", at: "2026-01-31T10:00:00.000Z" },
    { id: "b" },
    { id: "d", at: null },
  ];

  const walk = (direction: "asc" | "desc"): string[] => {
    const out: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: ListPage = applyListQuery(rows, {
        limit: 1,
        cursor,
        sort: [{ field: "at", direction }],
        filters: [],
      });
      for (const r of page.records) out.push(String(r["id"]));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return out;
  };

  it("walks every row exactly once, one page at a time, ascending", () => {
    expect(walk("asc")).toEqual(["c", "a", "b", "d"]);
  });

  it("walks every row exactly once descending", () => {
    expect(walk("desc")).toEqual(["a", "c", "b", "d"]);
  });

  it("returns nothing after a cursor already in the tail", () => {
    const page = applyListQuery(rows, {
      limit: 10,
      cursor: encodeKeyset({ k: [null], id: "d" }),
      sort: [{ field: "at", direction: "asc" }],
      filters: [],
    });
    expect(page.records).toEqual([]);
  });

  it("passes a tail row for a cursor that names a value", () => {
    const page = applyListQuery(rows, {
      limit: 10,
      cursor: encodeKeyset({ k: ["2026-01-31T10:00:00.000Z"], id: "a" }),
      sort: [{ field: "at", direction: "asc" }],
      filters: [],
    });
    expect(page.records.map((r) => r["id"])).toEqual(["b", "d"]);
  });

  it("holds the tail for a descending cursor too, which the direction flip would have moved", () => {
    const page = applyListQuery(rows, {
      limit: 10,
      cursor: encodeKeyset({ k: ["2026-01-30T10:00:00.000Z"], id: "c" }),
      sort: [{ field: "at", direction: "desc" }],
      filters: [],
    });
    expect(page.records.map((r) => r["id"])).toEqual(["b", "d"]);
  });
});

describe("two spellings of one instant compare as one instant", () => {
  it("orders by instant rather than by bytes, as the SQL cast does", () => {
    // Text order put 11:00Z before 19:00+09:00 (= 10:00Z). A legacy JSONB row keeps its spelling.
    const rows: EntityRecord[] = [
      { id: "later", at: "2026-01-31T11:00:00.000Z" },
      { id: "earlier", at: "2026-01-31T19:00:00+09:00" },
    ];
    expect("2026-01-31T11:00:00.000Z" < "2026-01-31T19:00:00+09:00").toBe(true);
    const page = applyListQuery(rows, {
      limit: 10,
      cursor: null,
      sort: [{ field: "at", direction: "asc" }],
      filters: [],
    });
    expect(page.records.map((r) => r["id"])).toEqual(["earlier", "later"]);
  });

  it("leaves a text field that is not an instant on localeCompare", () => {
    const rows: EntityRecord[] = [{ id: "a", name: "beta" }, { id: "b", name: "alpha" }];
    const page = applyListQuery(rows, {
      limit: 10,
      cursor: null,
      sort: [{ field: "name", direction: "asc" }],
      filters: [],
    });
    expect(page.records.map((r) => r["id"])).toEqual(["b", "a"]);
  });
});

describe("an ordered filter excludes a missing value, as SQL does", () => {
  const rows: EntityRecord[] = [{ id: "a", n: "5" }, { id: "b" }, { id: "c", n: null }];

  it("matches no row with a missing value on lt, which `\"\"` used to", () => {
    // `document ->> 'f' < $1` is NULL for an absent key, and NULL is not true. Rendering it `""`
    // made `lt` match every row with no value, so the in-memory store returned rows both
    // Postgres stores filtered out.
    expect(matchesFilter({ id: "b" }, { field: "n", op: "lt", value: "9" })).toBe(false);
    expect(matchesFilter({ id: "c", n: null }, { field: "n", op: "lt", value: "9" })).toBe(false);
  });

  it("excludes them from gt, gte and lte too", () => {
    for (const op of ["gt", "gte", "lte"] as const) {
      expect(matchesFilter({ id: "b" }, { field: "n", op, value: "9" })).toBe(false);
    }
  });

  it("still matches the rows that have a value", () => {
    const page = applyListQuery(rows, {
      limit: 10,
      cursor: null,
      sort: [],
      filters: [{ field: "n", op: "lt", value: "9" }],
    });
    expect(page.records.map((r) => r["id"])).toEqual(["a"]);
  });
});
