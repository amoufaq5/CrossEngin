import { describe, expect, it } from "vitest";
import {
  OPENAI_CHAT_MODELS,
  OPENAI_EMBEDDING_MODELS,
  OPENAI_PRICING,
  computeUsageCost,
  isOpenAiChatModel,
  isOpenAiEmbeddingModel,
} from "./pricing.js";

describe("OPENAI_PRICING", () => {
  it("prices every chat + embedding model", () => {
    for (const m of [...OPENAI_CHAT_MODELS, ...OPENAI_EMBEDDING_MODELS]) {
      expect(OPENAI_PRICING[m]).toBeDefined();
    }
  });
  it("prices output cheaper-or-equal than input for chat, free for embeddings", () => {
    expect(OPENAI_PRICING["gpt-4o"].outputUsdPerMillion).toBeGreaterThan(
      OPENAI_PRICING["gpt-4o"].inputUsdPerMillion,
    );
    expect(OPENAI_PRICING["text-embedding-3-small"].outputUsdPerMillion).toBe(0);
  });
});

describe("model guards", () => {
  it("distinguishes chat from embedding models", () => {
    expect(isOpenAiChatModel("gpt-4o")).toBe(true);
    expect(isOpenAiChatModel("text-embedding-3-small")).toBe(false);
    expect(isOpenAiEmbeddingModel("text-embedding-3-large")).toBe(true);
    expect(isOpenAiEmbeddingModel("gpt-4o")).toBe(false);
    expect(isOpenAiChatModel("claude-opus-4-7")).toBe(false);
  });
});

describe("computeUsageCost", () => {
  it("charges uncached input + output", () => {
    // gpt-4o: $2.5/M in, $10/M out
    const cost = computeUsageCost("gpt-4o", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(12.5, 6);
  });

  it("discounts cached prompt tokens (which are part of prompt_tokens)", () => {
    // 1M prompt of which 500k cached: 500k @ $2.5/M + 500k @ $1.25/M = 1.25 + 0.625
    const cost = computeUsageCost("gpt-4o", {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(1.875, 6);
  });

  it("is zero output for embeddings", () => {
    const cost = computeUsageCost("text-embedding-3-small", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(0.02, 6);
  });

  it("rounds to six decimals", () => {
    const cost = computeUsageCost("gpt-4o-mini", { inputTokens: 1, outputTokens: 1 });
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost.toString().split(".")[1]?.length ?? 0).toBeLessThanOrEqual(6);
  });
});
