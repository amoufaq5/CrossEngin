import { describe, expect, it } from "vitest";

import {
  CONDITIONAL_UPDATE_OUTCOMES,
  InMemoryEntityStore,
  applyListQuery,
  decodeKeyset,
  encodeKeyset,
  expectUnchanged,
  isConditional,
  isTransactional,
  matchesFilter,
  matchesPreconditions,
  projectRecord,
  type EntityStore,
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

describe("matchesPreconditions", () => {
  it("holds vacuously with no expectations", () => {
    expect(matchesPreconditions({ id: "a" }, [])).toBe(true);
  });

  it("compares as text, so 2 and \"2\" are the same expectation", () => {
    expect(matchesPreconditions({ n: 2 }, [{ field: "n", value: 2 }])).toBe(true);
    expect(matchesPreconditions({ n: 2 }, [{ field: "n", value: "2" }])).toBe(true);
    expect(matchesPreconditions({ n: "2" }, [{ field: "n", value: 2 }])).toBe(true);
  });

  it("rejects a different value", () => {
    expect(matchesPreconditions({ n: 2 }, [{ field: "n", value: 3 }])).toBe(false);
    expect(matchesPreconditions({ s: "in_review" }, [{ field: "s", value: "pended" }])).toBe(false);
  });

  it("treats an absent field and a stored null as the same state", () => {
    expect(matchesPreconditions({}, [{ field: "n", value: null }])).toBe(true);
    expect(matchesPreconditions({ n: null }, [{ field: "n", value: null }])).toBe(true);
  });

  it("refuses to satisfy a value expectation from an absent field", () => {
    // The counter guard case: "expected 1" must NOT be satisfied by "never set".
    expect(matchesPreconditions({}, [{ field: "n", value: 1 }])).toBe(false);
    expect(matchesPreconditions({ n: null }, [{ field: "n", value: 1 }])).toBe(false);
  });

  it("requires EVERY expectation to hold", () => {
    const record = { state: "rejected", rejected_by: "user-a" };
    expect(matchesPreconditions(record, [
      { field: "state", value: "rejected" },
      { field: "rejected_by", value: "user-a" },
    ])).toBe(true);
    expect(matchesPreconditions(record, [
      { field: "state", value: "rejected" },
      { field: "rejected_by", value: "user-b" },
    ])).toBe(false);
  });

  it("compares booleans by their text form", () => {
    expect(matchesPreconditions({ f: true }, [{ field: "f", value: true }])).toBe(true);
    expect(matchesPreconditions({ f: true }, [{ field: "f", value: false }])).toBe(false);
    expect(matchesPreconditions({ f: "true" }, [{ field: "f", value: true }])).toBe(true);
  });
});

describe("expectUnchanged", () => {
  it("turns a read scalar into its own expectation", () => {
    expect(expectUnchanged("state", "in_review")).toEqual({ field: "state", value: "in_review" });
    expect(expectUnchanged("n", 2)).toEqual({ field: "n", value: 2 });
    expect(expectUnchanged("f", false)).toEqual({ field: "f", value: false });
  });

  it("turns an unread field into the absent expectation", () => {
    expect(expectUnchanged("n", undefined)).toEqual({ field: "n", value: null });
    expect(expectUnchanged("n", null)).toEqual({ field: "n", value: null });
  });

  it("REFUSES a non-comparable value instead of weakening to absent", () => {
    // Fail closed. Returning `{value: null}` here would mean "expected absent"
    // for a field that is plainly present — a fence the caller believes it has
    // and does not.
    expect(() => expectUnchanged("d", new Date())).toThrow(/not comparable/);
    expect(() => expectUnchanged("o", { a: 1 })).toThrow(/not comparable/);
    expect(() => expectUnchanged("a", [1, 2])).toThrow(/not comparable/);
  });

  it("round-trips through matchesPreconditions for every scalar kind", () => {
    for (const value of ["x", 0, 7, true, false]) {
      expect(matchesPreconditions({ k: value }, [expectUnchanged("k", value)])).toBe(true);
    }
    expect(matchesPreconditions({}, [expectUnchanged("k", undefined)])).toBe(true);
  });
});

describe("isConditional", () => {
  it("recognizes the in-memory store", () => {
    expect(isConditional(new InMemoryEntityStore())).toBe(true);
  });

  it("does NOT claim the capability for a plain store", () => {
    // The narrowing is a capability check, so a store without `updateIf` keeps
    // its unfenced path rather than throwing at the call site.
    const plain: EntityStore = {
      list: async () => [],
      listPage: async () => ({ records: [], nextCursor: null }),
      get: async () => null,
      create: async (_t, _e, r) => r,
      update: async () => null,
      remove: async () => false,
    };
    expect(isConditional(plain)).toBe(false);
    expect(isTransactional(plain)).toBe(false);
  });

  it("names exactly three outcomes", () => {
    // Enumerated, not counted: a caller has to be able to tell "someone else got
    // there first" from "it was never there", so neither may quietly leave.
    expect([...CONDITIONAL_UPDATE_OUTCOMES]).toEqual([
      "applied",
      "precondition_failed",
      "not_found",
    ]);
  });
});

describe("InMemoryEntityStore.updateIf", () => {
  it("applies the patch when every precondition holds", async () => {
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "Claim", { id: "c1", state: "in_review", n: 1 });
    const res = await store.updateIf(TENANT, "Claim", "c1", { state: "pended", n: 2 }, [
      { field: "state", value: "in_review" },
      { field: "n", value: 1 },
    ]);
    expect(res.outcome).toBe("applied");
    expect(res.record).toMatchObject({ id: "c1", state: "pended", n: 2 });
    expect(await store.get(TENANT, "Claim", "c1")).toMatchObject({ state: "pended", n: 2 });
  });

  it("writes NOTHING when a precondition fails, and reports what it lost to", async () => {
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "Claim", { id: "c1", state: "pended", n: 5 });
    const res = await store.updateIf(TENANT, "Claim", "c1", { state: "paid" }, [
      { field: "state", value: "in_review" },
    ]);
    expect(res.outcome).toBe("precondition_failed");
    expect(res.record).toMatchObject({ state: "pended", n: 5 });
    expect(await store.get(TENANT, "Claim", "c1")).toMatchObject({ state: "pended", n: 5 });
  });

  it("separates not_found from precondition_failed", async () => {
    const store = new InMemoryEntityStore();
    const res = await store.updateIf(TENANT, "Claim", "nope", { state: "paid" }, [
      { field: "state", value: "in_review" },
    ]);
    expect(res.outcome).toBe("not_found");
    expect(res.record).toBeNull();
  });

  it("behaves exactly like update when given no preconditions", async () => {
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "Claim", { id: "c1", state: "in_review" });
    const res = await store.updateIf(TENANT, "Claim", "c1", { state: "pended" }, []);
    expect(res.outcome).toBe("applied");
    expect(await store.get(TENANT, "Claim", "c1")).toMatchObject({ state: "pended" });
  });

  it("pins the id against a patch that tries to move it", async () => {
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "Claim", { id: "c1", state: "in_review" });
    const res = await store.updateIf(TENANT, "Claim", "c1", { id: "evil", state: "pended" }, [
      { field: "state", value: "in_review" },
    ]);
    expect(res.record).toMatchObject({ id: "c1", state: "pended" });
  });

  it("admits exactly ONE of two budget increments read at the same count", async () => {
    // The whole point, expressed against the store contract. Two callers read
    // `n = 1` and both decide to write 2; with compare-and-set the second is
    // refused rather than confirming a budget spend that never happened.
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "Claim", { id: "c1", n: 1 });
    const read = await store.get(TENANT, "Claim", "c1");
    const expectation = [expectUnchanged("n", read?.["n"])];
    const a = await store.updateIf(TENANT, "Claim", "c1", { n: 2 }, expectation);
    const b = await store.updateIf(TENANT, "Claim", "c1", { n: 2 }, expectation);
    expect([a.outcome, b.outcome]).toEqual(["applied", "precondition_failed"]);
    expect(await store.get(TENANT, "Claim", "c1")).toMatchObject({ n: 2 });
  });

  it("scopes by tenant like every other op", async () => {
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "Claim", { id: "c1", state: "in_review" });
    const res = await store.updateIf(
      "00000000-0000-4000-8000-000000000002", "Claim", "c1", { state: "pended" },
      [{ field: "state", value: "in_review" }],
    );
    expect(res.outcome).toBe("not_found");
  });

  it("rolls back under withTransaction when the unit throws", async () => {
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "Claim", { id: "c1", state: "in_review" });
    await expect(
      store.withTransaction(TENANT, async () => {
        await store.updateIf(TENANT, "Claim", "c1", { state: "pended" }, [
          { field: "state", value: "in_review" },
        ]);
        throw new Error("effect failed");
      }),
    ).rejects.toThrow("effect failed");
    expect(await store.get(TENANT, "Claim", "c1")).toMatchObject({ state: "in_review" });
  });
});
