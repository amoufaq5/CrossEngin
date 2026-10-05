import type { Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import {
  DatetimeWireError,
  TEMPORAL_WIRE_DIRECTIONS,
  temporalFieldIndexFromManifest,
  withDatetimeWireType,
  type TemporalFieldIndex,
} from "./datetime-store.js";
import {
  InMemoryEntityStore,
  type EntityRecord,
  type EntityStore,
  type ListQuery,
} from "./store.js";

const MANIFEST = {
  meta: { name: "dt", version: "1.0.0" },
  traits: [
    {
      name: "auditable",
      fields: [
        { name: "created_at", type: { kind: "datetime" } },
        { name: "updated_at", type: { kind: "datetime" } },
      ],
    },
  ],
  entities: [
    {
      name: "Encounter",
      traits: ["auditable"],
      fields: [
        { name: "code", type: { kind: "text" } },
        { name: "scheduled_at", type: { kind: "datetime" } },
        { name: "due_date", type: { kind: "date" } },
        { name: "opens_at", type: { kind: "time" } },
      ],
    },
    { name: "Note", fields: [{ name: "body", type: { kind: "long_text" } }] },
  ],
} as unknown as Manifest;

const INDEX: TemporalFieldIndex = temporalFieldIndexFromManifest(MANIFEST);
const QUERY: ListQuery = { limit: 10, cursor: null, sort: [], filters: [] };

describe("temporalFieldIndexFromManifest", () => {
  it("indexes every temporal field with its kind", () => {
    expect([...INDEX.keys()]).toEqual(["Encounter"]);
    const kinds = INDEX.get("Encounter")!;
    expect(kinds.get("scheduled_at")).toBe("datetime");
    expect(kinds.get("due_date")).toBe("date");
    expect(kinds.get("opens_at")).toBe("time");
  });

  it("includes trait-supplied timestamps, which are six in seven of the real ones", () => {
    // The shipped packs declare 23 `datetime` fields by hand and resolve to 159, because
    // `auditable` contributes created_at/updated_at everywhere. A declared-fields index would
    // have covered one field in seven.
    const kinds = INDEX.get("Encounter")!;
    expect(kinds.get("created_at")).toBe("datetime");
    expect(kinds.get("updated_at")).toBe("datetime");
    expect(kinds.size).toBe(5);
  });

  it("omits an entity with no temporal field", () => {
    expect(INDEX.has("Note")).toBe(false);
  });

  it("is empty for a manifest with no entities", () => {
    const empty = temporalFieldIndexFromManifest({
      meta: { name: "x", version: "1.0.0" },
    } as unknown as Manifest);
    expect(empty.size).toBe(0);
  });

  it("names both wire directions", () => {
    expect(TEMPORAL_WIRE_DIRECTIONS).toEqual(["inbound", "stored"]);
  });
});

describe("withDatetimeWireType", () => {
  const wrapped = (): EntityStore => withDatetimeWireType(new InMemoryEntityStore(), INDEX);

  it("returns the store untouched when nothing is declared temporal", () => {
    const inner = new InMemoryEntityStore();
    expect(withDatetimeWireType(inner, new Map())).toBe(inner);
  });

  it("canonicalises an offset spelling on write, so what is stored is one instant one way", async () => {
    const store = wrapped();
    const created = await store.create("t1", "Encounter", {
      id: "a",
      scheduled_at: "2026-01-31T19:00:00+09:00",
    });
    expect(created["scheduled_at"]).toBe("2026-01-31T10:00:00.000Z");
    const read = await store.get("t1", "Encounter", "a");
    expect(read?.["scheduled_at"]).toBe("2026-01-31T10:00:00.000Z");
  });

  it("canonicalises a stored legacy spelling on read", async () => {
    const inner = new InMemoryEntityStore();
    await inner.create("t1", "Encounter", { id: "a", scheduled_at: "2026-01-31T10:00:00Z" });
    const store = withDatetimeWireType(inner, INDEX);
    expect((await store.get("t1", "Encounter", "a"))?.["scheduled_at"]).toBe(
      "2026-01-31T10:00:00.000Z",
    );
  });

  it("makes every spelling of one instant read back identically", async () => {
    const store = wrapped();
    const spellings = [
      "2026-01-31T05:00:00-05:00",
      "2026-01-31T10:00:00.000Z",
      "2026-01-31T10:00:00Z",
      "2026-01-31T19:00:00+09:00",
    ];
    for (const [i, s] of spellings.entries()) {
      await store.create("t1", "Encounter", { id: `r${String(i)}`, scheduled_at: s });
    }
    const page = await store.listPage("t1", "Encounter", QUERY);
    expect(new Set(page.records.map((r) => r["scheduled_at"]))).toEqual(
      new Set(["2026-01-31T10:00:00.000Z"]),
    );
  });

  it("converts a Date, which is what node-postgres hands back for a TIMESTAMPTZ", async () => {
    const store = wrapped();
    const created = await store.create("t1", "Encounter", {
      id: "a",
      scheduled_at: new Date(Date.UTC(2026, 0, 31, 10, 0, 0, 7)),
    });
    expect(created["scheduled_at"]).toBe("2026-01-31T10:00:00.007Z");
  });

  it("canonicalises a date and a time by their own rules", async () => {
    const store = wrapped();
    const created = await store.create("t1", "Encounter", {
      id: "a",
      due_date: "2026-01-31",
      opens_at: "9:05",
    });
    expect(created["due_date"]).toBe("2026-01-31");
    expect(created["opens_at"]).toBe("09:05:00");
  });

  it("truncates a sub-millisecond instant at the boundary rather than refusing", async () => {
    // The store boundary may be handed a computed value; refusing would turn a correct
    // computation into a 500. A *client* literal is a 422 upstream.
    const store = wrapped();
    const created = await store.create("t1", "Encounter", {
      id: "a",
      scheduled_at: "2026-01-31T10:00:00.999999Z",
    });
    expect(created["scheduled_at"]).toBe("2026-01-31T10:00:00.999Z");
  });

  it("throws with direction `inbound` for a write it must not store", async () => {
    const store = wrapped();
    await expect(
      store.create("t1", "Encounter", { id: "a", scheduled_at: "yesterday" }),
    ).rejects.toThrow(DatetimeWireError);
    try {
      await store.create("t1", "Encounter", { id: "b", scheduled_at: "yesterday" });
    } catch (e) {
      const err = e as DatetimeWireError;
      expect(err.entity).toBe("Encounter");
      expect(err.field).toBe("scheduled_at");
      expect(err.kind).toBe("datetime");
      expect(err.reason).toBe("not_an_instant");
      expect(err.direction).toBe("inbound");
      expect(err.message).toBe("Encounter.scheduled_at: not_an_instant (datetime, inbound)");
    }
  });

  it("throws with direction `stored` for a row the database already holds wrong", async () => {
    const inner = new InMemoryEntityStore();
    await inner.create("t1", "Encounter", { id: "a", due_date: "01/31/2026" });
    const store = withDatetimeWireType(inner, INDEX);
    try {
      await store.get("t1", "Encounter", "a");
      expect.unreachable();
    } catch (e) {
      const err = e as DatetimeWireError;
      expect(err.reason).toBe("not_a_calendar_date");
      expect(err.direction).toBe("stored");
      expect(err.kind).toBe("date");
    }
  });

  it("leaves null and absent values alone", async () => {
    const store = wrapped();
    const created = await store.create("t1", "Encounter", { id: "a", scheduled_at: null });
    expect(created["scheduled_at"]).toBeNull();
    expect("due_date" in created).toBe(false);
  });

  it("converts on update, in both directions", async () => {
    const store = wrapped();
    await store.create("t1", "Encounter", { id: "a", scheduled_at: "2026-01-31T10:00:00Z" });
    const updated = await store.update("t1", "Encounter", "a", {
      scheduled_at: "2026-02-01T05:00:00-05:00",
    });
    expect(updated?.["scheduled_at"]).toBe("2026-02-01T10:00:00.000Z");
  });

  it("converts the records a list and a page carry", async () => {
    const store = wrapped();
    await store.create("t1", "Encounter", { id: "a", scheduled_at: "2026-01-31T10:00:00Z" });
    const all = await store.list("t1", "Encounter");
    expect(all[0]?.["scheduled_at"]).toBe("2026-01-31T10:00:00.000Z");
    const page = await store.listPage("t1", "Encounter", QUERY);
    expect(page.records[0]?.["scheduled_at"]).toBe("2026-01-31T10:00:00.000Z");
  });

  it("leaves a non-temporal field and an unindexed entity untouched", async () => {
    const store = wrapped();
    const created = await store.create("t1", "Encounter", { id: "a", code: "2026-1-5" });
    expect(created["code"]).toBe("2026-1-5");
    const note = await store.create("t1", "Note", { id: "n", body: "nope" });
    expect(note["body"]).toBe("nope");
  });

  it("keeps the prototype's other methods reachable", () => {
    class Extra extends InMemoryEntityStore {
      ensureSchema(): string {
        return "ensured";
      }
    }
    const store = withDatetimeWireType(new Extra(), INDEX);
    expect(store.ensureSchema()).toBe("ensured");
  });

  it("re-wraps the transaction-bound store, so an effect's write is converted too", async () => {
    const store = withDatetimeWireType(new InMemoryEntityStore(), INDEX);
    const record = await store.withTransaction("t1", async (tx: EntityStore) =>
      tx.create("t1", "Encounter", { id: "a", scheduled_at: "2026-01-31T19:00:00+09:00" }),
    );
    expect((record as EntityRecord)["scheduled_at"]).toBe("2026-01-31T10:00:00.000Z");
  });

  it("rolls a transaction back when a conversion refuses mid-unit", async () => {
    const store = withDatetimeWireType(new InMemoryEntityStore(), INDEX);
    await expect(
      store.withTransaction("t1", async (tx: EntityStore) => {
        await tx.create("t1", "Encounter", { id: "a", scheduled_at: "2026-01-31T10:00:00Z" });
        await tx.create("t1", "Encounter", { id: "b", scheduled_at: "nope" });
      }),
    ).rejects.toThrow(DatetimeWireError);
    expect(await store.get("t1", "Encounter", "a")).toBeNull();
  });

  it("does not wrap withTransaction on a store that has none", () => {
    const plain: EntityStore = {
      list: async () => [],
      listPage: async () => ({ records: [], nextCursor: null }),
      get: async () => null,
      create: async (_t, _e, r) => r,
      update: async () => null,
      remove: async () => false,
    };
    const store = withDatetimeWireType(plain, INDEX);
    expect((store as Partial<{ withTransaction: unknown }>).withTransaction).toBeUndefined();
  });

  it("is idempotent, so a double wrap cannot change a value", async () => {
    const once = withDatetimeWireType(new InMemoryEntityStore(), INDEX);
    const twice = withDatetimeWireType(once, INDEX);
    const created = await twice.create("t1", "Encounter", {
      id: "a",
      scheduled_at: "2026-01-31T19:00:00+09:00",
    });
    expect(created["scheduled_at"]).toBe("2026-01-31T10:00:00.000Z");
  });
});
