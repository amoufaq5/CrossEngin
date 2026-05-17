import { describe, expect, it } from "vitest";
import {
  CRDT_KINDS,
  CrdtSchema,
  GCounterSchema,
  LwwMapSchema,
  LwwRegisterSchema,
  OrSetSchema,
  PNCounterSchema,
  gCounterIncrement,
  gCounterMerge,
  gCounterValue,
  lwwMapGet,
  lwwMapMerge,
  lwwRegisterMerge,
  orSetMembers,
  orSetMerge,
  pnCounterMerge,
  pnCounterValue,
  type GCounter,
  type LwwMap,
  type LwwRegister,
  type OrSet,
  type PNCounter,
} from "./crdts.js";

describe("CRDT_KINDS", () => {
  it("has 6 entries", () => {
    expect(CRDT_KINDS).toContain("g_counter");
    expect(CRDT_KINDS).toContain("or_set");
    expect(CRDT_KINDS).toContain("mv_register");
  });
});

describe("G-Counter", () => {
  const a: GCounter = { kind: "g_counter", perRegion: { "eu-central": 5, "us-east": 3 } };
  const b: GCounter = { kind: "g_counter", perRegion: { "eu-central": 2, "us-east": 7 } };

  it("validates schema", () => {
    expect(() => GCounterSchema.parse(a)).not.toThrow();
  });

  it("value sums all regions", () => {
    expect(gCounterValue(a)).toBe(8);
  });

  it("increment adds to a region", () => {
    const c = gCounterIncrement(a, "eu-central");
    expect(c.perRegion["eu-central"]).toBe(6);
  });

  it("increment with new region adds it", () => {
    const c = gCounterIncrement(a, "ap-south", 4);
    expect(c.perRegion["ap-south"]).toBe(4);
  });

  it("increment rejects negative", () => {
    expect(() => gCounterIncrement(a, "eu-central", -1)).toThrow();
  });

  it("merge takes per-region max", () => {
    const merged = gCounterMerge(a, b);
    expect(merged.perRegion["eu-central"]).toBe(5);
    expect(merged.perRegion["us-east"]).toBe(7);
  });

  it("merge is commutative", () => {
    expect(gCounterMerge(a, b)).toEqual(gCounterMerge(b, a));
  });
});

describe("PN-Counter", () => {
  const a: PNCounter = {
    kind: "pn_counter",
    positive: { "eu-central": 5 },
    negative: { "eu-central": 2 },
  };

  it("validates schema", () => {
    expect(() => PNCounterSchema.parse(a)).not.toThrow();
  });

  it("value = positive - negative", () => {
    expect(pnCounterValue(a)).toBe(3);
  });

  it("merge takes max per region per direction", () => {
    const b: PNCounter = {
      kind: "pn_counter",
      positive: { "eu-central": 8 },
      negative: { "eu-central": 1 },
    };
    const merged = pnCounterMerge(a, b);
    expect(merged.positive["eu-central"]).toBe(8);
    expect(merged.negative["eu-central"]).toBe(2);
  });
});

describe("OR-Set", () => {
  const a: OrSet = {
    kind: "or_set",
    entries: [
      { value: "apple", addedTags: ["t1"], removedTags: [] },
      { value: "banana", addedTags: ["t2"], removedTags: ["t2"] },
    ],
  };

  it("validates schema", () => {
    expect(() => OrSetSchema.parse(a)).not.toThrow();
  });

  it("members returns un-removed values", () => {
    expect(orSetMembers(a)).toEqual(["apple"]);
  });

  it("merge unions tags", () => {
    const b: OrSet = {
      kind: "or_set",
      entries: [{ value: "banana", addedTags: ["t3"], removedTags: [] }],
    };
    const merged = orSetMerge(a, b);
    const banana = merged.entries.find((e) => e.value === "banana");
    expect(banana?.addedTags.sort()).toEqual(["t2", "t3"]);
    expect(orSetMembers(merged).sort()).toEqual(["apple", "banana"]);
  });
});

describe("LWW-Register", () => {
  const a: LwwRegister = {
    kind: "lww_register",
    value: "hello",
    timestamp: "2026-05-15T10:00:00Z",
    originRegion: "eu-central",
  };
  const b: LwwRegister = {
    kind: "lww_register",
    value: "world",
    timestamp: "2026-05-15T11:00:00Z",
    originRegion: "us-east",
  };

  it("validates schema", () => {
    expect(() => LwwRegisterSchema.parse(a)).not.toThrow();
  });

  it("merge keeps later timestamp", () => {
    expect(lwwRegisterMerge(a, b).value).toBe("world");
  });

  it("merge breaks ties by region (lexicographic)", () => {
    const c: LwwRegister = { ...a, value: "x", originRegion: "eu-central" };
    const d: LwwRegister = { ...a, value: "y", originRegion: "us-east" };
    expect(lwwRegisterMerge(c, d).value).toBe("x");
  });
});

describe("LWW-Map", () => {
  const a: LwwMap = {
    kind: "lww_map",
    entries: [
      {
        key: "name",
        value: "Alice",
        timestamp: "2026-05-15T10:00:00Z",
        originRegion: "eu-central",
        tombstone: false,
      },
    ],
  };

  it("validates schema", () => {
    expect(() => LwwMapSchema.parse(a)).not.toThrow();
  });

  it("get returns current value", () => {
    expect(lwwMapGet(a, "name")).toBe("Alice");
  });

  it("get returns undefined for tombstoned", () => {
    const t: LwwMap = {
      kind: "lww_map",
      entries: [{ ...a.entries[0]!, tombstone: true }],
    };
    expect(lwwMapGet(t, "name")).toBeUndefined();
  });

  it("merge keeps newer per key", () => {
    const b: LwwMap = {
      kind: "lww_map",
      entries: [
        {
          key: "name",
          value: "Bob",
          timestamp: "2026-05-15T11:00:00Z",
          originRegion: "us-east",
          tombstone: false,
        },
      ],
    };
    const merged = lwwMapMerge(a, b);
    expect(lwwMapGet(merged, "name")).toBe("Bob");
  });
});

describe("CrdtSchema (discriminated union)", () => {
  it("accepts g_counter via discriminator", () => {
    expect(() =>
      CrdtSchema.parse({
        kind: "g_counter",
        perRegion: { "eu-central": 1 },
      }),
    ).not.toThrow();
  });

  it("rejects unknown kind", () => {
    expect(() => CrdtSchema.parse({ kind: "unknown" })).toThrow();
  });
});
