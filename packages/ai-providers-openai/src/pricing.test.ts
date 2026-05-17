import { describe, expect, it } from "vitest";

import {
  OPENAI_CHAT_MODELS,
  OPENAI_CHAT_PRICING,
  OPENAI_DEFAULT_CHAT_MODEL,
  OPENAI_DEFAULT_EMBEDDING_MODEL,
  OPENAI_EMBEDDING_MODELS,
  computeChatUsageCost,
  computeEmbeddingCost,
  isOpenAIChatModel,
  isOpenAIEmbeddingModel,
  isOpenAIModel,
} from "./pricing.js";

describe("OPENAI_CHAT_MODELS", () => {
  it("includes the current 4.x + o1 models", () => {
    expect(OPENAI_CHAT_MODELS).toContain("gpt-4o");
    expect(OPENAI_CHAT_MODELS).toContain("gpt-4o-mini");
    expect(OPENAI_CHAT_MODELS).toContain("o1");
    expect(OPENAI_CHAT_MODELS).toContain("o1-mini");
  });

  it("has pricing for every model", () => {
    for (const m of OPENAI_CHAT_MODELS) {
      expect(OPENAI_CHAT_PRICING[m].inputUsdPerMillion).toBeGreaterThan(0);
      expect(OPENAI_CHAT_PRICING[m].outputUsdPerMillion).toBeGreaterThan(0);
    }
  });
});

describe("OPENAI_EMBEDDING_MODELS", () => {
  it("includes the v3 small + large models", () => {
    expect(OPENAI_EMBEDDING_MODELS).toContain("text-embedding-3-small");
    expect(OPENAI_EMBEDDING_MODELS).toContain("text-embedding-3-large");
  });
});

describe("defaults", () => {
  it("default chat model is gpt-4o-mini (cheapest)", () => {
    expect(OPENAI_DEFAULT_CHAT_MODEL).toBe("gpt-4o-mini");
  });

  it("default embedding model is text-embedding-3-small (cheapest)", () => {
    expect(OPENAI_DEFAULT_EMBEDDING_MODEL).toBe("text-embedding-3-small");
  });
});

describe("computeChatUsageCost", () => {
  it("computes input + output cost for gpt-4o-mini", () => {
    const cost = computeChatUsageCost("gpt-4o-mini", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // 0.15 + 0.60 = 0.75
    expect(cost).toBeCloseTo(0.75, 6);
  });

  it("applies the cached input discount", () => {
    const without = computeChatUsageCost("gpt-4o-mini", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const withCache = computeChatUsageCost("gpt-4o-mini", {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(withCache).toBeLessThan(without);
    expect(withCache).toBeCloseTo(0.075, 6);
  });

  it("rounds to 6 decimal places", () => {
    const cost = computeChatUsageCost("gpt-4o", {
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(cost.toString()).toMatch(/^[0-9]+(\.[0-9]{1,6})?$/);
  });
});

describe("computeEmbeddingCost", () => {
  it("computes embedding cost for text-embedding-3-small", () => {
    const cost = computeEmbeddingCost("text-embedding-3-small", 1_000_000);
    expect(cost).toBeCloseTo(0.02, 6);
  });

  it("computes embedding cost for text-embedding-3-large", () => {
    const cost = computeEmbeddingCost("text-embedding-3-large", 1_000_000);
    expect(cost).toBeCloseTo(0.13, 6);
  });
});

describe("type guards", () => {
  it("isOpenAIChatModel matches chat models only", () => {
    expect(isOpenAIChatModel("gpt-4o")).toBe(true);
    expect(isOpenAIChatModel("text-embedding-3-small")).toBe(false);
    expect(isOpenAIChatModel("claude-sonnet-4-6")).toBe(false);
  });

  it("isOpenAIEmbeddingModel matches embedding models only", () => {
    expect(isOpenAIEmbeddingModel("text-embedding-3-small")).toBe(true);
    expect(isOpenAIEmbeddingModel("gpt-4o")).toBe(false);
  });

  it("isOpenAIModel matches either", () => {
    expect(isOpenAIModel("gpt-4o")).toBe(true);
    expect(isOpenAIModel("text-embedding-3-small")).toBe(true);
    expect(isOpenAIModel("foo")).toBe(false);
  });
});
