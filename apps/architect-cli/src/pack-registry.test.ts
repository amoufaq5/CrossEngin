import { describe, expect, it } from "vitest";

import {
  PACK_REGISTRY,
  UnknownPackError,
  listAvailablePacks,
  resolvePack,
} from "./pack-registry.js";

describe("PACK_REGISTRY", () => {
  it("includes operate-erp/core", () => {
    expect(PACK_REGISTRY).toHaveProperty("operate-erp/core");
  });

  it("every entry's build() returns a valid Manifest shape", () => {
    for (const entry of Object.values(PACK_REGISTRY)) {
      const m = entry.build();
      expect(m.manifestVersion).toBe("1.0");
      expect(m.meta.slug).toBe(entry.slug);
    }
  });
});

describe("resolvePack", () => {
  it("returns the entry for a known slug", () => {
    const entry = resolvePack("operate-erp/core");
    expect(entry.slug).toBe("operate-erp/core");
    expect(entry.description.length).toBeGreaterThan(0);
  });

  it("throws UnknownPackError for unknown slugs", () => {
    expect(() => resolvePack("bogus/pack")).toThrow(UnknownPackError);
  });

  it("error includes the available pack list", () => {
    try {
      resolvePack("bogus/pack");
    } catch (err) {
      if (err instanceof UnknownPackError) {
        expect(err.available).toContain("operate-erp/core");
        expect(err.slug).toBe("bogus/pack");
      } else {
        throw err;
      }
    }
  });
});

describe("listAvailablePacks", () => {
  it("returns slugs in alphabetical order", () => {
    const packs = listAvailablePacks();
    const sorted = [...packs].sort();
    expect(packs).toEqual(sorted);
  });
});
