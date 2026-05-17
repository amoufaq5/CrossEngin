import { describe, expect, it } from "vitest";
import {
  FTS_DICTIONARIES,
  FTS_WEIGHTS,
  globallyIndexedEntities,
  indexedEntities,
  indexedFieldPaths,
  IndexedFieldSchema,
  SearchEntityIndexSchema,
  SearchFilesConfigSchema,
  SearchManifestSchema,
} from "./manifest.js";

describe("IndexedFieldSchema", () => {
  it("defaults weight to B and kind to text", () => {
    const f = IndexedFieldSchema.parse({ field: "name" });
    expect(f.weight).toBe("B");
    expect(f.kind).toBe("text");
  });

  it("rejects an unknown weight", () => {
    expect(() => IndexedFieldSchema.parse({ field: "name", weight: "Z" })).toThrow();
  });

  it("FTS_WEIGHTS includes A through D", () => {
    expect(FTS_WEIGHTS).toEqual(["A", "B", "C", "D"]);
  });
});

describe("SearchEntityIndexSchema", () => {
  it("parses the ADR-0016 prescription example", () => {
    const idx = SearchEntityIndexSchema.parse({
      indexedFields: [
        { field: "patient.name", weight: "A", kind: "text" },
        { field: "drug.name", weight: "A", kind: "text" },
        { field: "drug.brandName", weight: "B", kind: "text" },
        { field: "id", weight: "C", kind: "exact" },
      ],
      globalIndex: true,
      displayInGlobalResults: {
        title: "$drug.name",
        subtitle: "$patient.name • $status",
        url: "/prescriptions/$id",
      },
      facets: ["status", "drug.category", "writtenAt"],
    });
    expect(idx.indexedFields).toHaveLength(4);
    expect(idx.facets).toHaveLength(3);
  });

  it("rejects globalIndex without displayInGlobalResults", () => {
    expect(() =>
      SearchEntityIndexSchema.parse({
        indexedFields: [{ field: "name" }],
        globalIndex: true,
      }),
    ).toThrow(/requires displayInGlobalResults/);
  });

  it("rejects duplicate indexed field paths", () => {
    expect(() =>
      SearchEntityIndexSchema.parse({
        indexedFields: [{ field: "name" }, { field: "name" }],
      }),
    ).toThrow(/duplicate indexed field/);
  });

  it("requires at least one indexed field", () => {
    expect(() => SearchEntityIndexSchema.parse({ indexedFields: [] })).toThrow();
  });
});

describe("SearchFilesConfigSchema", () => {
  it("parses with defaults all false", () => {
    const f = SearchFilesConfigSchema.parse({});
    expect(f.globalIndex).toBe(false);
    expect(f.ocr).toBe(false);
    expect(f.embedding).toBe(false);
    expect(f.embeddingScope).toBe("tenant");
  });

  it("accepts the ADR example with global+ocr+embedding=true", () => {
    const f = SearchFilesConfigSchema.parse({
      globalIndex: true,
      ocr: true,
      embedding: true,
    });
    expect(f.embedding).toBe(true);
  });
});

describe("SearchManifestSchema", () => {
  it("parses a manifest with one indexed entity", () => {
    const m = SearchManifestSchema.parse({
      entities: {
        Prescription: {
          indexedFields: [{ field: "drug.name", weight: "A" }],
        },
      },
    });
    expect(Object.keys(m.entities)).toEqual(["Prescription"]);
    expect(m.defaultDictionary).toBe("simple");
  });

  it("accepts every supported FTS dictionary", () => {
    for (const dict of FTS_DICTIONARIES) {
      expect(() =>
        SearchManifestSchema.parse({ defaultDictionary: dict }),
      ).not.toThrow();
    }
  });

  it("rejects an entity-name key with lowercase first letter", () => {
    expect(() =>
      SearchManifestSchema.parse({
        entities: {
          prescription: {
            indexedFields: [{ field: "drug.name" }],
          },
        },
      }),
    ).toThrow();
  });
});

describe("indexedEntities / indexedFieldPaths / globallyIndexedEntities", () => {
  const manifest = SearchManifestSchema.parse({
    entities: {
      Prescription: {
        indexedFields: [{ field: "drug.name" }, { field: "patient.name" }],
        globalIndex: true,
        displayInGlobalResults: { title: "$drug.name", url: "/p/$id" },
      },
      AuditEvent: {
        indexedFields: [{ field: "action" }],
        globalIndex: false,
      },
    },
  });

  it("indexedEntities returns all keys", () => {
    expect(indexedEntities(manifest).sort()).toEqual(["AuditEvent", "Prescription"]);
  });

  it("indexedFieldPaths returns paths for one entity", () => {
    expect(indexedFieldPaths(manifest, "Prescription")).toEqual([
      "drug.name",
      "patient.name",
    ]);
  });

  it("globallyIndexedEntities filters to globalIndex=true", () => {
    expect(globallyIndexedEntities(manifest)).toEqual(["Prescription"]);
  });
});
