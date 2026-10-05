import type { Manifest } from "@crossengin/kernel/manifest";
import { PrimitiveFieldTypeSchema } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import {
  FIELD_LIST_VALUE_TYPES,
  listValueTypeFor,
  listValueTypesForManifest,
  withListValueTypes,
  type ListValueTypeIndex,
} from "./list-value-types.js";
import {
  InMemoryEntityStore,
  LIST_VALUE_TYPES,
  type EntityStore,
  type ListPage,
  type ListQuery,
  type ListValueType,
} from "./store.js";

const MANIFEST = {
  meta: { name: "lvt", version: "1.0.0" },
  entities: [
    {
      name: "Invoice",
      traits: ["auditable"],
      fields: [
        { name: "code", type: { kind: "text" } },
        { name: "total", type: { kind: "decimal", precision: 16, scale: 2 } },
        { name: "qty", type: { kind: "integer" } },
        { name: "due_on", type: { kind: "date" } },
        { name: "posted", type: { kind: "boolean" } },
        { name: "tags", type: { kind: "array", element: { kind: "decimal", precision: 8, scale: 2 } } },
      ],
    },
    { name: "Note", fields: [{ name: "body", type: { kind: "long_text" } }] },
  ],
} as unknown as Manifest;

const INDEX: ListValueTypeIndex = listValueTypesForManifest(MANIFEST);
const QUERY: ListQuery = { limit: 10, cursor: null, sort: [], filters: [] };

describe("LIST_VALUE_TYPES", () => {
  it("is exactly the two comparisons a text-holding store needs", () => {
    expect(LIST_VALUE_TYPES).toEqual(["text", "numeric"]);
  });
});

describe("FIELD_LIST_VALUE_TYPES", () => {
  it("is total over every field kind the schema accepts", () => {
    // A twenty-fourth field kind must be a compile error in the map, not a silent text default.
    // The schema is the authority on how many there are, so count against it rather than a list
    // maintained beside it — ADR-0332's `FEATURE_FLAG_COLUMN_NAMES` lesson.
    // Several members are `.refine()`d, sometimes twice, so unwrap `ZodEffects` to the object.
    const unwrap = (schema: unknown): Record<string, unknown> => {
      const node = schema as { shape?: Record<string, unknown>; _def?: { schema?: unknown } };
      if (node.shape !== undefined) return node.shape;
      return node._def?.schema !== undefined ? unwrap(node._def.schema) : {};
    };
    const declared = PrimitiveFieldTypeSchema.options.flatMap((option) => {
      const kind = (unwrap(option)["kind"] as { _def?: { value?: unknown } } | undefined)?._def?.value;
      return typeof kind === "string" ? [kind] : [];
    });
    expect(declared.length).toBe(23);
    expect([...declared].sort()).toEqual(Object.keys(FIELD_LIST_VALUE_TYPES).sort());
  });

  it("gives `numeric` to exactly the kinds whose Postgres type is numeric", () => {
    const numeric = Object.entries(FIELD_LIST_VALUE_TYPES)
      .filter(([, t]) => t === "numeric")
      .map(([k]) => k);
    expect(numeric.sort()).toEqual(["decimal", "integer"]);
  });

  it("keeps boolean, date and time on text, which is measured rather than assumed", () => {
    // `'false' < 'true'` is the boolean order; a zero-padded `YYYY-MM-DD` and `HH:MM:SS` sort
    // chronologically byte-wise. A cast would buy nothing and cost a guard.
    expect(FIELD_LIST_VALUE_TYPES.boolean).toBe("text");
    expect(FIELD_LIST_VALUE_TYPES.date).toBe("text");
    expect(FIELD_LIST_VALUE_TYPES.time).toBe("text");
  });

  it("keeps datetime on text, with the hole that leaves recorded here", () => {
    // ISO-8601 instants sort correctly only while every writer spells them the same way. Every
    // server-side writer uses `toISOString()` and does; `validateBody` has no rule for a
    // `datetime` field, so a client can store `2026-01-31T19:00:00+09:00` — one instant with a
    // spelling that sorts hours away from `2026-01-31T10:00:00.000Z`. Closing that is a decision
    // about a `datetime` wire form, not about ordering.
    expect(FIELD_LIST_VALUE_TYPES.datetime).toBe("text");
  });

  it("keeps duration on text, because its wire type is undecided on purpose", () => {
    expect(FIELD_LIST_VALUE_TYPES.duration).toBe("text");
  });
});

describe("listValueTypeFor", () => {
  it("answers from the field's own declaration", () => {
    expect(listValueTypeFor({ kind: "decimal", precision: 16, scale: 2 })).toBe("numeric");
    expect(listValueTypeFor({ kind: "integer" })).toBe("numeric");
    expect(listValueTypeFor({ kind: "text" })).toBe("text");
  });

  it("calls an array field text even when its element is numeric", () => {
    // A keyset cursor component for an array is already not a value Postgres can compare back,
    // so a numeric claim would change the NULL placement of an ordering that is wrong anyway.
    expect(listValueTypeFor({ kind: "array", element: { kind: "decimal", precision: 8, scale: 2 } })).toBe("text");
    expect(listValueTypeFor({ kind: "array", element: { kind: "integer" } })).toBe("text");
  });
});

describe("listValueTypesForManifest", () => {
  it("indexes only the non-text fields, so an absent entry means text", () => {
    expect([...INDEX.keys()]).toEqual(["Invoice"]);
    expect([...INDEX.get("Invoice")!.entries()]).toEqual([
      ["total", "numeric"],
      ["qty", "numeric"],
    ]);
  });

  it("omits an entity with no numeric field", () => {
    expect(INDEX.has("Note")).toBe(false);
  });

  it("is empty for a manifest with no entities", () => {
    expect(
      listValueTypesForManifest({ meta: { name: "x", version: "1.0.0" } } as unknown as Manifest).size,
    ).toBe(0);
  });

  it("reaches trait-supplied fields through `resolvedFields`", () => {
    // `auditable` supplies `created_at`/`updated_at` (datetime → text), so the entity is indexed
    // for its own numerics only — but the index is built from the same function the column plan
    // and `validateManifest` use, so it cannot name a field the store lacks.
    const keys = [...INDEX.get("Invoice")!.keys()];
    expect(keys).not.toContain("created_at");
    expect(keys).not.toContain("due_on");
    expect(keys).not.toContain("tags");
  });
});

/** Records every query that reaches the underlying store. */
function recordingStore(): { store: EntityStore; seen: ListQuery[] } {
  const seen: ListQuery[] = [];
  const inner = new InMemoryEntityStore();
  const store: EntityStore = {
    list: (t, e) => inner.list(t, e),
    listPage: (t, e, q): Promise<ListPage> => {
      seen.push(q);
      return inner.listPage(t, e, q);
    },
    get: (t, e, i) => inner.get(t, e, i),
    create: (t, e, r) => inner.create(t, e, r),
    update: (t, e, i, p) => inner.update(t, e, i, p),
    remove: (t, e, i) => inner.remove(t, e, i),
  };
  return { store, seen };
}

describe("withListValueTypes", () => {
  it("attaches the entity's comparison types to a list query", async () => {
    const { store, seen } = recordingStore();
    await withListValueTypes(store, INDEX).listPage("t1", "Invoice", QUERY);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.valueTypes?.get("total")).toBe("numeric");
    expect(seen[0]!.valueTypes?.get("code")).toBeUndefined();
  });

  it("leaves a query for an unindexed entity exactly as it was", async () => {
    const { store, seen } = recordingStore();
    await withListValueTypes(store, INDEX).listPage("t1", "Note", QUERY);
    expect(seen[0]).toBe(QUERY);
  });

  it("does not overwrite types a caller already supplied", async () => {
    const { store, seen } = recordingStore();
    const mine = new Map<string, ListValueType>([["total", "text"]]);
    await withListValueTypes(store, INDEX).listPage("t1", "Invoice", { ...QUERY, valueTypes: mine });
    expect(seen[0]!.valueTypes).toBe(mine);
  });

  it("returns the store untouched when no manifest field is numeric", () => {
    const { store } = recordingStore();
    expect(withListValueTypes(store, new Map())).toBe(store);
  });

  it("keeps the other operations and the interfaces a store also implements", async () => {
    // `Object.create` rather than a fresh literal: the association routes reach for
    // `AssociationReader`/`Writer` off the same object.
    const inner = new InMemoryEntityStore();
    const extra = Object.assign(inner, { countLinks: () => Promise.resolve(7) });
    const wrapped = withListValueTypes(extra, INDEX);
    const created = await wrapped.create("t1", "Invoice", { id: "i1", total: "9.00" });
    expect(created["id"]).toBe("i1");
    expect(await wrapped.get("t1", "Invoice", "i1")).toMatchObject({ total: "9.00" });
    expect(await (wrapped as unknown as { countLinks: () => Promise<number> }).countLinks()).toBe(7);
  });

  it("wraps the transaction-bound store too, so a write effect's lookup is typed as well", async () => {
    // The GL postings, the aging report and the period-lock guard all build a `ListQuery` by hand
    // through the store they are handed — inside a transaction, that is the tx store.
    const seen: ListQuery[] = [];
    const inner = new InMemoryEntityStore();
    const tx: EntityStore = {
      list: (t, e) => inner.list(t, e),
      listPage: (t, e, q) => {
        seen.push(q);
        return inner.listPage(t, e, q);
      },
      get: (t, e, i) => inner.get(t, e, i),
      create: (t, e, r) => inner.create(t, e, r),
      update: (t, e, i, p) => inner.update(t, e, i, p),
      remove: (t, e, i) => inner.remove(t, e, i),
    };
    const transactional = Object.assign(Object.create(tx) as EntityStore, {
      withTransaction: <T>(_tenantId: string, fn: (s: EntityStore) => Promise<T>) => fn(tx),
    });
    const wrapped = withListValueTypes(transactional, INDEX);
    await (wrapped as unknown as {
      withTransaction: (t: string, fn: (s: EntityStore) => Promise<void>) => Promise<void>;
    }).withTransaction("t1", async (s) => {
      await s.listPage("t1", "Invoice", QUERY);
    });
    expect(seen[0]!.valueTypes?.get("qty")).toBe("numeric");
  });

  it("leaves a store with no withTransaction without one", () => {
    const { store } = recordingStore();
    const wrapped = withListValueTypes(store, INDEX) as Partial<{ withTransaction: unknown }>;
    expect(wrapped.withTransaction).toBeUndefined();
  });
});
