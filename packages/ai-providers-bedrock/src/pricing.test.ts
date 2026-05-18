import { describe, expect, it } from "vitest";

import {
  BEDROCK_CHAT_MODELS,
  BEDROCK_CHAT_PRICING,
  BEDROCK_DEFAULT_EMBEDDING_MODEL,
  BEDROCK_EMBEDDING_MODELS,
  BEDROCK_EMBEDDING_PRICING,
  buildBedrockEmbeddingUsage,
  buildBedrockUsage,
  computeBedrockChatCost,
  computeBedrockEmbeddingCost,
  isBedrockChatModel,
  isBedrockEmbeddingModel,
  isBedrockModel,
} from "./pricing.js";

describe("BEDROCK_CHAT_MODELS", () => {
  it("lists 8 chat models", () => {
    expect(BEDROCK_CHAT_MODELS).toHaveLength(8);
  });

  it("includes Claude on Bedrock + Llama + Mistral + Titan", () => {
    expect(BEDROCK_CHAT_MODELS).toContain(
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
    expect(BEDROCK_CHAT_MODELS).toContain("meta.llama3-1-405b-instruct-v1:0");
    expect(BEDROCK_CHAT_MODELS).toContain("mistral.mistral-large-2407-v1:0");
    expect(BEDROCK_CHAT_MODELS).toContain("amazon.titan-text-premier-v1:0");
  });
});

describe("BEDROCK_CHAT_PRICING", () => {
  it("has an entry for every chat model", () => {
    for (const model of BEDROCK_CHAT_MODELS) {
      expect(BEDROCK_CHAT_PRICING[model]).toBeDefined();
    }
  });

  it("Claude Opus 4 on Bedrock costs $15 / $75 per million", () => {
    const p = BEDROCK_CHAT_PRICING["anthropic.claude-opus-4-20250514-v1:0"];
    expect(p.inputUsdPerMillion).toBe(15);
    expect(p.outputUsdPerMillion).toBe(75);
  });

  it("Claude Haiku is the cheapest Claude on Bedrock", () => {
    const haiku = BEDROCK_CHAT_PRICING["anthropic.claude-3-5-haiku-20241022-v1:0"];
    const sonnet = BEDROCK_CHAT_PRICING["anthropic.claude-3-5-sonnet-20241022-v2:0"];
    expect(haiku.inputUsdPerMillion).toBeLessThan(sonnet.inputUsdPerMillion);
  });

  it("Anthropic-on-Bedrock models have 90%-off cached input pricing", () => {
    const sonnet = BEDROCK_CHAT_PRICING["anthropic.claude-3-5-sonnet-20241022-v2:0"];
    expect(sonnet.cachedInputUsdPerMillion).toBeDefined();
    expect(sonnet.cachedInputUsdPerMillion!).toBeCloseTo(sonnet.inputUsdPerMillion * 0.1, 3);
  });

  it("Meta + Mistral + Titan have no separate cached input pricing", () => {
    expect(BEDROCK_CHAT_PRICING["meta.llama3-1-405b-instruct-v1:0"].cachedInputUsdPerMillion).toBeUndefined();
    expect(BEDROCK_CHAT_PRICING["mistral.mistral-large-2407-v1:0"].cachedInputUsdPerMillion).toBeUndefined();
    expect(BEDROCK_CHAT_PRICING["amazon.titan-text-premier-v1:0"].cachedInputUsdPerMillion).toBeUndefined();
  });
});

describe("computeBedrockChatCost", () => {
  it("computes input + output cost without cache", () => {
    const cost = computeBedrockChatCost("anthropic.claude-3-5-sonnet-20241022-v2:0", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBe(18); // $3 + $15
  });

  it("subtracts cached input from uncached input bucket", () => {
    const cost = computeBedrockChatCost("anthropic.claude-3-5-sonnet-20241022-v2:0", {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 0,
    });
    // 500k uncached @ $3 + 500k cached @ $0.30 = $1.50 + $0.15 = $1.65
    expect(cost).toBe(1.65);
  });

  it("rounds to 6 decimal places", () => {
    const cost = computeBedrockChatCost("amazon.titan-text-premier-v1:0", {
      inputTokens: 1,
      outputTokens: 1,
    });
    // 0.5/M + 1.5/M = 2/M = 0.000002 USD
    expect(cost).toBe(0.000002);
  });

  it("zero tokens → zero cost", () => {
    const cost = computeBedrockChatCost("anthropic.claude-3-5-haiku-20241022-v1:0", {
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(cost).toBe(0);
  });
});

describe("buildBedrockUsage", () => {
  it("includes cachedInputTokens only when > 0", () => {
    const withCache = buildBedrockUsage("anthropic.claude-3-5-sonnet-20241022-v2:0", {
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 20,
    });
    expect(withCache.cachedInputTokens).toBe(20);
    const withoutCache = buildBedrockUsage("anthropic.claude-3-5-sonnet-20241022-v2:0", {
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(withoutCache.cachedInputTokens).toBeUndefined();
    const withZero = buildBedrockUsage("anthropic.claude-3-5-sonnet-20241022-v2:0", {
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
    });
    expect(withZero.cachedInputTokens).toBeUndefined();
  });
});

describe("isBedrockChatModel", () => {
  it("accepts known models", () => {
    expect(isBedrockChatModel("anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe(true);
  });

  it("rejects unknown strings", () => {
    expect(isBedrockChatModel("gpt-4o")).toBe(false);
    expect(isBedrockChatModel("claude-sonnet-4-6")).toBe(false);
    expect(isBedrockChatModel("")).toBe(false);
  });

  it("returns false for embedding model strings", () => {
    expect(isBedrockChatModel("amazon.titan-embed-text-v2:0")).toBe(false);
  });
});

describe("BEDROCK_EMBEDDING_MODELS + pricing", () => {
  it("lists 4 embedding models (2 Titan + 2 Cohere)", () => {
    expect(BEDROCK_EMBEDDING_MODELS).toHaveLength(4);
    expect(BEDROCK_EMBEDDING_MODELS).toContain("amazon.titan-embed-text-v2:0");
    expect(BEDROCK_EMBEDDING_MODELS).toContain("amazon.titan-embed-text-v1");
    expect(BEDROCK_EMBEDDING_MODELS).toContain("cohere.embed-english-v3");
    expect(BEDROCK_EMBEDDING_MODELS).toContain("cohere.embed-multilingual-v3");
  });

  it("default embedding model is titan-embed-text-v2 (cheapest at $0.02/M)", () => {
    expect(BEDROCK_DEFAULT_EMBEDDING_MODEL).toBe("amazon.titan-embed-text-v2:0");
  });

  it("titan v2 is 5x cheaper than titan v1 (matching AWS published rates)", () => {
    expect(BEDROCK_EMBEDDING_PRICING["amazon.titan-embed-text-v2:0"].inputUsdPerMillion).toBe(0.02);
    expect(BEDROCK_EMBEDDING_PRICING["amazon.titan-embed-text-v1"].inputUsdPerMillion).toBe(0.1);
  });

  it("cohere models match the documented $0.10/M rate", () => {
    expect(BEDROCK_EMBEDDING_PRICING["cohere.embed-english-v3"].inputUsdPerMillion).toBe(0.1);
    expect(BEDROCK_EMBEDDING_PRICING["cohere.embed-multilingual-v3"].inputUsdPerMillion).toBe(0.1);
  });
});

describe("computeBedrockEmbeddingCost", () => {
  it("computes cost rounded to 6 decimals", () => {
    expect(computeBedrockEmbeddingCost("amazon.titan-embed-text-v2:0", 1_000_000)).toBe(0.02);
    expect(computeBedrockEmbeddingCost("amazon.titan-embed-text-v2:0", 500_000)).toBe(0.01);
    expect(computeBedrockEmbeddingCost("amazon.titan-embed-text-v2:0", 1)).toBe(0);
    expect(computeBedrockEmbeddingCost("cohere.embed-english-v3", 1_000)).toBe(0.0001);
  });

  it("zero tokens → zero cost", () => {
    expect(computeBedrockEmbeddingCost("amazon.titan-embed-text-v2:0", 0)).toBe(0);
  });
});

describe("buildBedrockEmbeddingUsage", () => {
  it("Usage has outputTokens: 0 and computed cost", () => {
    const usage = buildBedrockEmbeddingUsage("amazon.titan-embed-text-v2:0", 5);
    expect(usage.inputTokens).toBe(5);
    expect(usage.outputTokens).toBe(0);
    expect(usage.cachedInputTokens).toBeUndefined();
    expect(usage.cost).toBeGreaterThanOrEqual(0);
  });
});

describe("isBedrockEmbeddingModel + isBedrockModel", () => {
  it("isBedrockEmbeddingModel accepts embedding models", () => {
    expect(isBedrockEmbeddingModel("amazon.titan-embed-text-v2:0")).toBe(true);
    expect(isBedrockEmbeddingModel("cohere.embed-english-v3")).toBe(true);
  });

  it("isBedrockEmbeddingModel rejects chat models + unknowns", () => {
    expect(isBedrockEmbeddingModel("anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe(false);
    expect(isBedrockEmbeddingModel("text-embedding-3-small")).toBe(false);
  });

  it("isBedrockModel accepts both chat + embedding models", () => {
    expect(isBedrockModel("anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe(true);
    expect(isBedrockModel("amazon.titan-embed-text-v2:0")).toBe(true);
    expect(isBedrockModel("gpt-4o")).toBe(false);
  });
});
