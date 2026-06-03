import { describe, expect, it } from "vitest";

import {
  InMemoryEntityStore,
  applyListQuery,
  decodeKeyset,
  encodeKeyset,
  matchesFilter,
  projectRecord,
  type ListQuery,
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
