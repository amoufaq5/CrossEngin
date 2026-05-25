import { describe, expect, it } from "vitest";
import {
  chunkText,
  DEFAULT_CHUNKING,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODELS,
  EmbeddingChunkSchema,
  VectorIndexConfigSchema,
} from "./embeddings.js";

const now = "2026-05-13T10:00:00.000Z";

describe("EMBEDDING_DIMENSIONS", () => {
  it("declares a dimension for each model", () => {
    for (const model of EMBEDDING_MODELS) {
      expect(EMBEDDING_DIMENSIONS[model]).toBeGreaterThan(0);
    }
  });

  it("bge-m3 is 1024", () => {
    expect(EMBEDDING_DIMENSIONS["bge-m3"]).toBe(1024);
  });
});

describe("VectorIndexConfigSchema", () => {
  it("parses an ivfflat config with lists", () => {
    const c = VectorIndexConfigSchema.parse({ kind: "ivfflat", ivfflatLists: 100 });
    expect(c.distance).toBe("cosine");
  });

  it("rejects ivfflat without lists", () => {
    expect(() => VectorIndexConfigSchema.parse({ kind: "ivfflat" })).toThrow(
      /requires ivfflatLists/,
    );
  });

  it("parses an hnsw config", () => {
    expect(() =>
      VectorIndexConfigSchema.parse({
        kind: "hnsw",
        hnswM: 16,
        hnswEfConstruction: 64,
      }),
    ).not.toThrow();
  });

  it("rejects hnsw missing M or efConstruction", () => {
    expect(() => VectorIndexConfigSchema.parse({ kind: "hnsw", hnswM: 16 })).toThrow();
  });
});

describe("EmbeddingChunkSchema", () => {
  const baseEmbedding = new Array(1024).fill(0).map((_, i) => i / 1024);

  it("parses a bge-m3 chunk", () => {
    expect(() =>
      EmbeddingChunkSchema.parse({
        tenantId: "t_1",
        sourceKind: "file",
        sourceId: "f_1",
        chunkIdx: 0,
        chunkText: "Some OCR text.",
        embedding: baseEmbedding,
        model: "bge-m3",
        dimensions: 1024,
        createdAt: now,
      }),
    ).not.toThrow();
  });

  it("rejects mismatched dimensions vs. model", () => {
    expect(() =>
      EmbeddingChunkSchema.parse({
        tenantId: "t_1",
        sourceKind: "file",
        sourceId: "f_1",
        chunkIdx: 0,
        chunkText: "x",
        embedding: baseEmbedding,
        model: "bge-base-en",
        dimensions: 1024,
        createdAt: now,
      }),
    ).toThrow(/expects 768/);
  });

  it("rejects mismatched embedding length", () => {
    expect(() =>
      EmbeddingChunkSchema.parse({
        tenantId: "t_1",
        sourceKind: "file",
        sourceId: "f_1",
        chunkIdx: 0,
        chunkText: "x",
        embedding: new Array(900).fill(0),
        model: "bge-m3",
        dimensions: 1024,
        createdAt: now,
      }),
    ).toThrow(/does not match dimensions/);
  });
});

describe("chunkText", () => {
  it("returns an empty array for empty text", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("returns one chunk for short text", () => {
    const chunks = chunkText("hello world");
    expect(chunks).toHaveLength(1);
  });

  it("splits long text with overlap", () => {
    const text = "x".repeat(10_000);
    const chunks = chunkText(text, {
      maxChunkTokens: 100,
      overlapTokens: 20,
      approxCharsPerToken: 4,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(400);
    }
  });

  it("rejects overlap >= chunk size", () => {
    expect(() => chunkText("x".repeat(100), { maxChunkTokens: 10, overlapTokens: 10 })).toThrow();
  });

  it("DEFAULT_CHUNKING matches ADR-0014 defaults (1024 / 128)", () => {
    expect(DEFAULT_CHUNKING.maxChunkTokens).toBe(1024);
    expect(DEFAULT_CHUNKING.overlapTokens).toBe(128);
  });
});
