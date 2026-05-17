import { describe, expect, it } from "vitest";

import {
  buildEmbeddingsRequest,
  normalizeEmbeddingResponse,
  normalizeEmbeddingUsage,
  type OpenAIEmbeddingsResponse,
} from "./embeddings.js";

describe("buildEmbeddingsRequest", () => {
  it("emits the OpenAI embeddings request shape", () => {
    const req = buildEmbeddingsRequest({
      texts: ["hello", "world"],
      model: "text-embedding-3-small",
    });
    expect(req.model).toBe("text-embedding-3-small");
    expect(req.input).toEqual(["hello", "world"]);
    expect(req.encoding_format).toBe("float");
  });
});

describe("normalizeEmbeddingResponse", () => {
  it("sorts vectors by index, reports dim, packs Usage", () => {
    const raw: OpenAIEmbeddingsResponse = {
      object: "list",
      model: "text-embedding-3-small",
      data: [
        { object: "embedding", embedding: [0.4, 0.5, 0.6], index: 1 },
        { object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 },
      ],
      usage: { prompt_tokens: 7, total_tokens: 7 },
    };
    const norm = normalizeEmbeddingResponse("text-embedding-3-small", raw);
    expect(norm.vectors).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    expect(norm.dim).toBe(3);
    expect(norm.model).toBe("text-embedding-3-small");
    expect(norm.usage.inputTokens).toBe(7);
    expect(norm.usage.outputTokens).toBe(0);
    expect(norm.usage.cost).toBeGreaterThanOrEqual(0);
  });

  it("computes a non-zero cost for larger batches", () => {
    const raw: OpenAIEmbeddingsResponse = {
      object: "list",
      model: "text-embedding-3-small",
      data: [
        { object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 },
      ],
      usage: { prompt_tokens: 1_000_000, total_tokens: 1_000_000 },
    };
    const norm = normalizeEmbeddingResponse("text-embedding-3-small", raw);
    expect(norm.usage.cost).toBeCloseTo(0.02, 6);
  });
});

describe("normalizeEmbeddingUsage", () => {
  it("rounds cost to 6 decimals", () => {
    const usage = normalizeEmbeddingUsage("text-embedding-3-small", {
      prompt_tokens: 1,
      total_tokens: 1,
    });
    expect(usage.cost.toString()).toMatch(/^[0-9]+(\.[0-9]{1,6})?$/);
  });
});
