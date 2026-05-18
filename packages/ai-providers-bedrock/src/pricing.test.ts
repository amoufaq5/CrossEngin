import { describe, expect, it } from "vitest";

import {
  BEDROCK_CHAT_MODELS,
  BEDROCK_CHAT_PRICING,
  buildBedrockUsage,
  computeBedrockChatCost,
  isBedrockChatModel,
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
});
