import type { Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import {
  DecimalWireError,
  decimalFieldIndexFromManifest,
  withDecimalWireType,
  type DecimalFieldIndex,
} from "./decimal-store.js";
import { InMemoryEntityStore, type EntityRecord, type EntityStore, type ListQuery } from "./store.js";

const MANIFEST = {
  meta: { name: "dec", version: "1.0.0" },
  entities: [
    {
      name: "Invoice",
      traits: ["auditable"],
      fields: [
        { name: "code", type: { kind: "text" } },
        { name: "total", type: { kind: "decimal", precision: 16, scale: 2 } },
        { name: "rate", type: { kind: "decimal", precision: 20, scale: 10 } },
        { name: "qty", type: { kind: "integer" } },
      ],
    },
    {
      name: "Note",
      fields: [{ name: "body", type: { kind: "long_text" } }],
    },
  ],
} as unknown as Manifest;

const INDEX: DecimalFieldIndex = decimalFieldIndexFromManifest(MANIFEST);
const QUERY: ListQuery = { limit: 10, cursor: null, sort: [], filters: [] };

describe("decimalFieldIndexFromManifest", () => {
  it("indexes only the decimal fields, with their declarations", () => {
    expect([...INDEX.keys()]).toEqual(["Invoice"]);
    expect([...INDEX.get("Invoice")!.entries()]).toEqual([
      ["total", { precision: 16, scale: 2 }],
      ["rate", { precision: 20, scale: 10 }],
    ]);
  });

  it("omits an entity with no decimal field", () => {
    expect(INDEX.has("Note")).toBe(false);
  });

  it("is empty for a manifest with no entities", () => {
    expect(decimalFieldIndexFromManifest({ meta: { name: "x", version: "1.0.0" } } as unknown as Manifest).size).toBe(0);
  });
});

describe("withDecimalWireType", () => {
  const wrapped = (): EntityStore => withDecimalWireType(new InMemoryEntityStore(), INDEX);

  it("returns the store untouched when nothing is declared decimal", () => {
    const inner = new InMemoryEntityStore();
    expect(withDecimalWireType(inner, new Map())).toBe(inner);
  });

  it("canonicalises a number on write and reads it back as the wire string", async () => {
    const store = wrapped();
    const created = await store.create("t1", "Invoice", { id: "a", total: 10.25, rate: 1.5 });
    expect(created["total"]).toBe("10.25");
    expect(created["rate"]).toBe("1.5000000000");
    const read = await store.get("t1", "Invoice", "a");
    expect(read?.["total"]).toBe("10.25");
  });

  it("pads to the declared scale so create and get cannot disagree", async () => {
    const store = wrapped();
    await store.create("t1", "Invoice", { id: "a", total: 10 });
    expect((await store.get("t1", "Invoice", "a"))?.["total"]).toBe("10.00");
  });

  it("keeps a value no double holds", async () => {
    const store = wrapped();
    await store.create("t1", "Invoice", { id: "a", rate: "1234567890.1234567891" });
    expect((await store.get("t1", "Invoice", "a"))?.["rate"]).toBe("1234567890.1234567891");
  });

  it("leaves non-decimal fields alone", async () => {
    const store = wrapped();
    const created = await store.create("t1", "Invoice", { id: "a", code: "INV-1", qty: 3 });
    expect(created["code"]).toBe("INV-1");
    expect(created["qty"]).toBe(3);
  });

  it("leaves an unindexed entity alone", async () => {
    const store = wrapped();
    const created = await store.create("t1", "Note", { id: "n", body: "10.25" });
    expect(created["body"]).toBe("10.25");
  });

  it("passes null and absent through untouched", async () => {
    const store = wrapped();
    const created = await store.create("t1", "Invoice", { id: "a", total: null });
    expect(created["total"]).toBeNull();
    expect("rate" in created).toBe(false);
  });

  it("converts on update, in both the patch and the returned record", async () => {
    const store = wrapped();
    await store.create("t1", "Invoice", { id: "a", total: 1 });
    const updated = await store.update("t1", "Invoice", "a", { total: "2.5" });
    expect(updated?.["total"]).toBe("2.50");
    expect((await store.get("t1", "Invoice", "a"))?.["total"]).toBe("2.50");
  });

  it("converts every record of a list and a page", async () => {
    const store = wrapped();
    await store.create("t1", "Invoice", { id: "a", total: 1 });
    await store.create("t1", "Invoice", { id: "b", total: 2 });
    expect((await store.list("t1", "Invoice")).map((r) => r["total"])).toEqual(["1.00", "2.00"]);
    const page = await store.listPage("t1", "Invoice", QUERY);
    expect(page.records.map((r) => r["total"])).toEqual(["1.00", "2.00"]);
  });

  it("refuses a value that is not a decimal rather than storing a guess", async () => {
    const store = wrapped();
    await expect(store.create("t1", "Invoice", { id: "a", total: "about ten" })).rejects.toThrow(
      DecimalWireError,
    );
    await expect(store.create("t1", "Invoice", { id: "a", total: "about ten" })).rejects.toThrow(
      /Invoice\.total: not_a_decimal \(inbound\)/,
    );
  });

  it("names the direction, so a 500 says whether a caller or the database produced it", async () => {
    const inner = new InMemoryEntityStore();
    // Reaches the store behind the decorator, as a row written before the wire type existed.
    await inner.create("t1", "Invoice", { id: "legacy", total: "n/a" });
    const store = withDecimalWireType(inner, INDEX);
    await expect(store.get("t1", "Invoice", "legacy")).rejects.toThrow(
      /Invoice\.total: not_a_decimal \(stored\)/,
    );
    const err = await store.get("t1", "Invoice", "legacy").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecimalWireError);
    expect((err as DecimalWireError).direction).toBe("stored");
    expect((err as DecimalWireError).reason).toBe("not_a_decimal");
  });

  it("refuses an integer part the column cannot hold", async () => {
    const store = wrapped();
    await expect(
      store.create("t1", "Invoice", { id: "a", total: "99999999999999999" }),
    ).rejects.toThrow(/precision_overflow/);
  });

  it("wraps the transaction-bound store, so a write effect's own writes convert too", async () => {
    const store = withDecimalWireType(new InMemoryEntityStore(), INDEX);
    expect(typeof (store as { withTransaction?: unknown }).withTransaction).toBe("function");
    const seen = await (store as { withTransaction: (t: string, fn: (tx: EntityStore) => Promise<EntityRecord>) => Promise<EntityRecord> }).withTransaction(
      "t1",
      async (tx) => tx.create("t1", "Invoice", { id: "a", total: 7 }),
    );
    expect(seen["total"]).toBe("7.00");
    expect((await store.get("t1", "Invoice", "a"))?.["total"]).toBe("7.00");
  });

  it("keeps methods the decorator knows nothing about", async () => {
    class Extra extends InMemoryEntityStore {
      async countLinks(): Promise<number> {
        return 4;
      }
    }
    const store = withDecimalWireType(new Extra(), INDEX);
    expect(await store.countLinks()).toBe(4);
    expect((await store.create("t1", "Invoice", { id: "a", total: 1 }))["total"]).toBe("1.00");
  });

  it("does not claim a transaction the inner store cannot run", () => {
    const plain: EntityStore = {
      list: async () => [],
      listPage: async () => ({ records: [], nextCursor: null }),
      get: async () => null,
      create: async (_t, _e, r) => r,
      update: async () => null,
      remove: async () => false,
    };
    expect((withDecimalWireType(plain, INDEX) as { withTransaction?: unknown }).withTransaction).toBeUndefined();
  });
});

describe("ordering under the wire type", () => {
  it("sorts a decimal by value, not by the string's spelling", async () => {
    const store = withDecimalWireType(new InMemoryEntityStore(), INDEX);
    for (const [id, total] of [["a", 9.5], ["b", 10.25], ["c", 2]] as const) {
      await store.create("t1", "Invoice", { id, total });
    }
    const page = await store.listPage("t1", "Invoice", {
      ...QUERY,
      sort: [{ field: "total", direction: "asc" }],
    });
    expect(page.records.map((r) => r["id"])).toEqual(["c", "a", "b"]);
  });

  it("pages past page 1 on a decimal sort without skipping or repeating a row", async () => {
    const store = withDecimalWireType(new InMemoryEntityStore(), INDEX);
    const totals = ["2.00", "9.50", "10.25", "100.00", "1000.00"];
    for (let i = 0; i < totals.length; i += 1) {
      await store.create("t1", "Invoice", { id: `r${i.toString()}`, total: totals[i]! });
    }
    const seen: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page = await store.listPage("t1", "Invoice", {
        limit: 2,
        cursor,
        sort: [{ field: "total", direction: "asc" }],
        filters: [],
      });
      seen.push(...page.records.map((r) => r["total"]));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(totals);
  });

  it("matches an eq filter spelled with fewer digits than the canonical form", async () => {
    const store = withDecimalWireType(new InMemoryEntityStore(), INDEX);
    await store.create("t1", "Invoice", { id: "a", rate: 1.5 });
    const page = await store.listPage("t1", "Invoice", {
      ...QUERY,
      filters: [{ field: "rate", op: "eq", value: "1.5" }],
    });
    expect(page.records.map((r) => r["id"])).toEqual(["a"]);
  });
});
