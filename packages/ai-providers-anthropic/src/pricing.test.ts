import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_MODELS,
  ANTHROPIC_PRICING,
  computeUsageCost,
  isAnthropicModel,
} from "./pricing.js";

describe("ANTHROPIC_MODELS", () => {
  it("includes the Claude 4.x lineup", () => {
    expect(ANTHROPIC_MODELS).toContain("claude-opus-4-7");
    expect(ANTHROPIC_MODELS).toContain("claude-sonnet-4-6");
    expect(ANTHROPIC_MODELS).toContain("claude-haiku-4-5");
  });

  it("has matching pricing entry for every model", () => {
    for (const model of ANTHROPIC_MODELS) {
      expect(ANTHROPIC_PRICING[model]).toBeDefined();
    }
  });
});

describe("isAnthropicModel", () => {
  it("accepts known values", () => {
    expect(isAnthropicModel("claude-opus-4-7")).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isAnthropicModel("gpt-4")).toBe(false);
    expect(isAnthropicModel(undefined)).toBe(false);
  });
});

describe("computeUsageCost", () => {
  it("returns 0 for zero tokens", () => {
    expect(
      computeUsageCost("claude-sonnet-4-6", {
        inputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0);
  });

  it("charges full input rate when nothing is cached", () => {
    const cost = computeUsageCost("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(3, 5);
  });

  it("charges cached input rate for the cached portion", () => {
    const cost = computeUsageCost("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(1.5 + 0.15, 5);
  });

  it("charges cache-write rate for newly-written cache tokens", () => {
    const cost = computeUsageCost("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      cacheWriteTokens: 200_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(3 + 0.75, 5);
  });

  it("charges output rate for output tokens", () => {
    const cost = computeUsageCost("claude-sonnet-4-6", {
      inputTokens: 0,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(15, 5);
  });

  it("opus is 5x sonnet input rate", () => {
    const opus = computeUsageCost("claude-opus-4-7", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const sonnet = computeUsageCost("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(opus / sonnet).toBeCloseTo(5, 1);
  });

  it("rounds to 6 decimal places", () => {
    const cost = computeUsageCost("claude-haiku-4-5", {
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(cost.toString()).not.toMatch(/\d{7,}/);
  });
});
