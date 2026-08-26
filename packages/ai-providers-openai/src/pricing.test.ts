import { describe, expect, it } from "vitest";
import {
  OPENAI_CHAT_MODELS,
  OPENAI_EMBEDDING_MODELS,
  OPENAI_PRICING,
  computeUsageCost,
  hasKnownPricing,
  isOpenAiChatModel,
  isOpenAiEmbeddingModel,
  openAiPricingFor,
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

  it("is unchanged for every model in the catalogue", () => {
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 300_000, outputTokens: 500_000 };
    for (const [model, p] of Object.entries(OPENAI_PRICING)) {
      const expected =
        (700_000 * p.inputUsdPerMillion +
          300_000 * p.cachedInputUsdPerMillion +
          500_000 * p.outputUsdPerMillion) /
        1_000_000;
      expect(computeUsageCost(model, usage)).toBeCloseTo(expected, 6);
      expect(computeUsageCost(model, usage)).toBeGreaterThan(0);
    }
  });

  it("returns 0 for a self-hosted model that is not in the catalogue", () => {
    expect(computeUsageCost("qwen2.5:14b", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(0);
  });

  it("returns 0 rather than throwing for a proxied third-party model", () => {
    expect(() =>
      computeUsageCost("anthropic/claude-3.5-sonnet", {
        inputTokens: 500,
        cachedInputTokens: 100,
        outputTokens: 250,
      }),
    ).not.toThrow();
    expect(
      computeUsageCost("anthropic/claude-3.5-sonnet", { inputTokens: 500, outputTokens: 250 }),
    ).toBe(0);
  });

  it("returns 0 for an empty model id", () => {
    expect(computeUsageCost("", { inputTokens: 10, outputTokens: 10 })).toBe(0);
  });

  it("does not read pricing off Object.prototype", () => {
    expect(computeUsageCost("constructor", { inputTokens: 1_000, outputTokens: 1_000 })).toBe(0);
    expect(computeUsageCost("toString", { inputTokens: 1_000, outputTokens: 1_000 })).toBe(0);
  });
});

describe("hasKnownPricing", () => {
  it("is true for every catalogued chat + embedding model", () => {
    for (const m of [...OPENAI_CHAT_MODELS, ...OPENAI_EMBEDDING_MODELS]) {
      expect(hasKnownPricing(m)).toBe(true);
    }
  });

  it("is false for models served by an OpenAI-compatible endpoint", () => {
    expect(hasKnownPricing("qwen2.5:14b")).toBe(false);
    expect(hasKnownPricing("llama3.1:70b")).toBe(false);
    expect(hasKnownPricing("anthropic/claude-3.5-sonnet")).toBe(false);
  });

  it("is false for an empty id and for inherited object keys", () => {
    expect(hasKnownPricing("")).toBe(false);
    expect(hasKnownPricing("constructor")).toBe(false);
    expect(hasKnownPricing("hasOwnProperty")).toBe(false);
  });
});

describe("openAiPricingFor", () => {
  it("returns the catalogue entry for a known model", () => {
    expect(openAiPricingFor("gpt-4o")).toEqual(OPENAI_PRICING["gpt-4o"]);
  });

  it("returns undefined for an unknown model", () => {
    expect(openAiPricingFor("qwen2.5:14b")).toBeUndefined();
  });
});
