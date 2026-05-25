import { describe, expect, it } from "vitest";
import {
  FacetSelectionSchema,
  SearchHitSchema,
  SearchQuerySchema,
  SearchResultSchema,
  selectEngine,
} from "./query.js";

describe("FacetSelectionSchema", () => {
  it("accepts eq with a single value", () => {
    expect(() =>
      FacetSelectionSchema.parse({ field: "status", operator: "eq", values: ["active"] }),
    ).not.toThrow();
  });

  it("rejects eq with multiple values", () => {
    expect(() =>
      FacetSelectionSchema.parse({
        field: "status",
        operator: "eq",
        values: ["active", "pending"],
      }),
    ).toThrow(/exactly one value/);
  });

  it("between needs exactly two values", () => {
    expect(() =>
      FacetSelectionSchema.parse({
        field: "qty",
        operator: "between",
        values: [1, 5, 10],
      }),
    ).toThrow(/exactly two values/);
  });
});

describe("SearchQuerySchema — entity", () => {
  it("parses a typeahead-style entity search", () => {
    const q = SearchQuerySchema.parse({
      kind: "entity",
      entity: "Prescription",
      text: "amoxicillin",
      filters: [{ field: "status", operator: "eq", values: ["active"] }],
      facets: ["status"],
    });
    if (q.kind === "entity") {
      expect(q.entity).toBe("Prescription");
      expect(q.pageSize).toBe(20);
      expect(q.highlight).toBe(true);
    }
  });

  it("rejects entity-name with lowercase first letter", () => {
    expect(() => SearchQuerySchema.parse({ kind: "entity", entity: "prescription" })).toThrow();
  });
});

describe("SearchQuerySchema — global / semantic / typeahead", () => {
  it("parses a global search restricted to two entity types", () => {
    const q = SearchQuerySchema.parse({
      kind: "global",
      text: "vendor 42",
      entityScope: ["Vendor", "Contract"],
    });
    if (q.kind === "global") {
      expect(q.entityScope).toEqual(["Vendor", "Contract"]);
    }
  });

  it("parses a semantic search with a vector + minScore", () => {
    const q = SearchQuerySchema.parse({
      kind: "semantic",
      embedding: new Array(1024).fill(0).map((_, i) => i / 1024),
      similarity: "cosine",
      minScore: 0.7,
    });
    if (q.kind === "semantic") {
      expect(q.embedding).toHaveLength(1024);
    }
  });

  it("parses a typeahead with maxResultsPerEntity", () => {
    const q = SearchQuerySchema.parse({
      kind: "typeahead",
      text: "amox",
      entityScope: ["Drug", "Prescription"],
      maxResultsPerEntity: 3,
    });
    if (q.kind === "typeahead") {
      expect(q.maxResultsPerEntity).toBe(3);
    }
  });

  it("rejects an unknown kind", () => {
    expect(() => SearchQuerySchema.parse({ kind: "explore", text: "x" })).toThrow();
  });
});

describe("selectEngine", () => {
  it("entity → postgres_fts", () => {
    expect(selectEngine(SearchQuerySchema.parse({ kind: "entity", entity: "X" }))).toBe(
      "postgres_fts",
    );
  });

  it("global → typesense", () => {
    expect(selectEngine(SearchQuerySchema.parse({ kind: "global", text: "x" }))).toBe("typesense");
  });

  it("typeahead → typesense", () => {
    expect(selectEngine(SearchQuerySchema.parse({ kind: "typeahead", text: "x" }))).toBe(
      "typesense",
    );
  });

  it("semantic → pgvector", () => {
    expect(selectEngine(SearchQuerySchema.parse({ kind: "semantic", text: "x" }))).toBe("pgvector");
  });
});

describe("SearchHitSchema / SearchResultSchema", () => {
  const baseHit = SearchHitSchema.parse({
    id: "h1",
    entityType: "Prescription",
    title: "Amoxicillin 500mg",
    score: 0.92,
  });

  it("parses a hit with defaults for highlights + redactedFields + data", () => {
    expect(baseHit.highlights).toEqual({});
    expect(baseHit.redactedFields).toEqual([]);
  });

  it("parses a result envelope", () => {
    const r = SearchResultSchema.parse({
      query: { kind: "entity", entity: "Prescription", text: "amox" },
      hits: [baseHit],
      totalHits: 1,
      engine: "postgres_fts",
      latencyMs: 42,
    });
    expect(r.cacheHit).toBe(false);
  });

  it("allows totalHits=null for cursor-paginated queries", () => {
    expect(() =>
      SearchResultSchema.parse({
        query: { kind: "global", text: "x" },
        hits: [],
        totalHits: null,
        engine: "typesense",
        latencyMs: 12,
      }),
    ).not.toThrow();
  });
});
