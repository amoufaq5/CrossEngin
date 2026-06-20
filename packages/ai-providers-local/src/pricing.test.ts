import { describe, expect, it } from "vitest";

import { LOCAL_ZERO_PRICING, computeLocalCost, localUsage } from "./pricing.js";

describe("local pricing", () => {
  it("advertises zero per-token pricing", () => {
    expect(LOCAL_ZERO_PRICING.inputPerMillionTokens).toBe(0);
    expect(LOCAL_ZERO_PRICING.outputPerMillionTokens).toBe(0);
    expect(LOCAL_ZERO_PRICING.cachedInputPerMillionTokens).toBe(0);
  });

  it("always computes zero cost", () => {
    expect(computeLocalCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(0);
  });

  it("builds a zero-cost Usage from token counts", () => {
    const usage = localUsage({ inputTokens: 12, outputTokens: 34 });
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 34, cost: 0 });
  });

  it("includes cached tokens only when positive", () => {
    expect(localUsage({ inputTokens: 5, outputTokens: 5, cachedInputTokens: 3 })).toEqual({
      inputTokens: 5,
      outputTokens: 5,
      cachedInputTokens: 3,
      cost: 0,
    });
    expect(localUsage({ inputTokens: 5, outputTokens: 5, cachedInputTokens: 0 })).toEqual({
      inputTokens: 5,
      outputTokens: 5,
      cost: 0,
    });
  });

  it("clamps negative counts to zero", () => {
    expect(localUsage({ inputTokens: -1, outputTokens: -2 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    });
  });
});
