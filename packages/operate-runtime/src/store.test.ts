import { describe, expect, it } from "vitest";

import {
  InMemoryEntityStore,
  applyListQuery,
  decodeCursor,
  encodeCursor,
  type ListQuery,
} from "./store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function query(overrides: Partial<ListQuery> = {}): ListQuery {
  return { limit: 2, cursor: null, sort: [], filters: [], ...overrides };
}

describe("cursor encoding", () => {
  it("round-trips a non-negative offset", () => {
    expect(decodeCursor(encodeCursor(40))).toBe(40);
  });
  it("reads a malformed or null cursor as 0", () => {
    expect(decodeCursor(null)).toBe(0);
    expect(decodeCursor("!!!not-base64!!!")).toBe(0);
  });
});

describe("applyListQuery", () => {
  const rows = [
    { id: "a", name: "Cherry", status: "active" },
    { id: "b", name: "Apple", status: "active" },
    { id: "c", name: "Banana", status: "archived" },
  ];

  it("sorts ascending and descending", () => {
    const asc = applyListQuery(rows, query({ limit: 10, sort: [{ field: "name", direction: "asc" }] }));
    expect(asc.records.map((r) => r["name"])).toEqual(["Apple", "Banana", "Cherry"]);
    const desc = applyListQuery(rows, query({ limit: 10, sort: [{ field: "name", direction: "desc" }] }));
    expect(desc.records.map((r) => r["name"])).toEqual(["Cherry", "Banana", "Apple"]);
  });

  it("filters by equality", () => {
    const page = applyListQuery(rows, query({ limit: 10, filters: [{ field: "status", value: "active" }] }));
    expect(page.records).toHaveLength(2);
    expect(page.records.every((r) => r["status"] === "active")).toBe(true);
  });

  it("paginates with an opaque next cursor", () => {
    const first = applyListQuery(rows, query({ limit: 2, sort: [{ field: "id", direction: "asc" }] }));
    expect(first.records.map((r) => r["id"])).toEqual(["a", "b"]);
    expect(first.nextCursor).not.toBeNull();

    const second = applyListQuery(rows, query({ limit: 2, cursor: first.nextCursor, sort: [{ field: "id", direction: "asc" }] }));
    expect(second.records.map((r) => r["id"])).toEqual(["c"]);
    expect(second.nextCursor).toBeNull();
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
