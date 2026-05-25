import { describe, expect, it } from "vitest";
import { canonicalManifestJson, canonicalizeForHash, manifestHash } from "./hash.js";
import type { Manifest } from "./types.js";

const v = "1.0.0";
const baseMeta = { name: "T", slug: "t", version: v } as const;

describe("canonicalizeForHash", () => {
  it("returns primitives unchanged", () => {
    expect(canonicalizeForHash(1)).toBe(1);
    expect(canonicalizeForHash("x")).toBe("x");
    expect(canonicalizeForHash(true)).toBe(true);
    expect(canonicalizeForHash(null)).toBe(null);
  });

  it("sorts object keys alphabetically", () => {
    const result = canonicalizeForHash({ b: 2, a: 1, c: 3 });
    expect(Object.keys(result as object)).toEqual(["a", "b", "c"]);
  });

  it("sorts arrays of named objects by name", () => {
    const result = canonicalizeForHash([
      { name: "z", value: 1 },
      { name: "a", value: 2 },
      { name: "m", value: 3 },
    ]);
    expect((result as { name: string }[]).map((x) => x.name)).toEqual(["a", "m", "z"]);
  });

  it("preserves order in arrays of unnamed objects", () => {
    const result = canonicalizeForHash([
      { kind: "x", value: 1 },
      { kind: "y", value: 2 },
    ]);
    expect((result as { kind: string }[]).map((x) => x.kind)).toEqual(["x", "y"]);
  });

  it("preserves order in arrays of mixed named and unnamed objects", () => {
    const result = canonicalizeForHash([{ name: "z" }, { kind: "y" }, { name: "a" }]);
    expect(result).toEqual([{ name: "z" }, { kind: "y" }, { name: "a" }]);
  });

  it("preserves order in arrays of primitives", () => {
    expect(canonicalizeForHash([3, 1, 2])).toEqual([3, 1, 2]);
    expect(canonicalizeForHash(["c", "a", "b"])).toEqual(["c", "a", "b"]);
  });

  it("recurses into nested objects", () => {
    const result = canonicalizeForHash({
      outer: { z: 1, a: 2 },
    }) as { outer: object };
    expect(Object.keys(result.outer)).toEqual(["a", "z"]);
  });

  it("recurses into nested arrays of named objects", () => {
    const result = canonicalizeForHash({
      entities: [
        {
          name: "z",
          fields: [
            { name: "z1", type: { kind: "text" } },
            { name: "a1", type: { kind: "text" } },
          ],
        },
        { name: "a", fields: [] },
      ],
    }) as { entities: { name: string; fields: { name: string }[] }[] };
    expect(result.entities.map((e) => e.name)).toEqual(["a", "z"]);
    expect(result.entities[1]?.fields.map((f) => f.name)).toEqual(["a1", "z1"]);
  });
});

describe("manifestHash", () => {
  it("returns a 64-character hex string", () => {
    const m: Manifest = { manifestVersion: "1.0", meta: baseMeta };
    expect(manifestHash(m)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic across calls", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [{ name: "X", fields: [{ name: "a", type: { kind: "text" } }] }],
    };
    const h1 = manifestHash(m);
    const h2 = manifestHash(m);
    expect(h1).toBe(h2);
  });

  it("differs for different content", () => {
    const m1: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [{ name: "X", fields: [{ name: "a", type: { kind: "text" } }] }],
    };
    const m2: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [{ name: "Y", fields: [{ name: "a", type: { kind: "text" } }] }],
    };
    expect(manifestHash(m1)).not.toBe(manifestHash(m2));
  });

  it("is insensitive to top-level key insertion order", () => {
    const m1: Manifest = { manifestVersion: "1.0", meta: baseMeta };
    const m2: Manifest = { meta: baseMeta, manifestVersion: "1.0" };
    expect(manifestHash(m1)).toBe(manifestHash(m2));
  });

  it("is insensitive to entity-array order (sorted by name)", () => {
    const eA = { name: "A", fields: [{ name: "x", type: { kind: "text" as const } }] };
    const eB = { name: "B", fields: [{ name: "y", type: { kind: "text" as const } }] };
    const m1: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [eA, eB],
    };
    const m2: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [eB, eA],
    };
    expect(manifestHash(m1)).toBe(manifestHash(m2));
  });

  it("is insensitive to field-array order within an entity", () => {
    const m1: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        {
          name: "X",
          fields: [
            { name: "a", type: { kind: "text" } },
            { name: "b", type: { kind: "integer" } },
          ],
        },
      ],
    };
    const m2: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        {
          name: "X",
          fields: [
            { name: "b", type: { kind: "integer" } },
            { name: "a", type: { kind: "text" } },
          ],
        },
      ],
    };
    expect(manifestHash(m1)).toBe(manifestHash(m2));
  });

  it("is insensitive to role-record key insertion order", () => {
    const m1: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      roles: { pharmacist: { name: "pharmacist" }, staff: { name: "staff" } },
    };
    const m2: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      roles: { staff: { name: "staff" }, pharmacist: { name: "pharmacist" } },
    };
    expect(manifestHash(m1)).toBe(manifestHash(m2));
  });

  it("ignores meta.manifestResolution when hashing", () => {
    const m1: Manifest = { manifestVersion: "1.0", meta: baseMeta };
    const m2: Manifest = {
      manifestVersion: "1.0",
      meta: {
        ...baseMeta,
        manifestResolution: {
          parents: [{ slug: "p", version: "1.0.0", hash: "x".repeat(64), parentId: "p" }],
        },
      },
    };
    expect(manifestHash(m1)).toBe(manifestHash(m2));
  });

  it("includes meta fields other than manifestResolution in the hash", () => {
    const m1: Manifest = { manifestVersion: "1.0", meta: baseMeta };
    const m2: Manifest = {
      manifestVersion: "1.0",
      meta: { ...baseMeta, description: "extra" },
    };
    expect(manifestHash(m1)).not.toBe(manifestHash(m2));
  });
});

describe("canonicalManifestJson", () => {
  it("strips manifestResolution from the canonical JSON", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: {
        ...baseMeta,
        manifestResolution: {
          parents: [{ slug: "p", version: "1.0.0", hash: "h".repeat(64), parentId: "p" }],
        },
      },
    };
    const json = canonicalManifestJson(m);
    expect(json).not.toContain("manifestResolution");
  });
});
