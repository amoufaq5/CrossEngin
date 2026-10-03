import type { ProviderPricing } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import {
  ESTIMATED_CHARS_PER_TOKEN,
  StreamCostMeter,
  admitRequestCost,
  estimateRequestCost,
  estimateTokensFromChars,
  estimateTokensFromText,
  reconcileRequestCost,
} from "./request-cost.js";

const PAID: ProviderPricing = { inputPerMillionTokens: 3, outputPerMillionTokens: 15 };
const PAID_CACHED: ProviderPricing = {
  inputPerMillionTokens: 3,
  outputPerMillionTokens: 15,
  cachedInputPerMillionTokens: 0.3,
};
const FREE: ProviderPricing = { inputPerMillionTokens: 0, outputPerMillionTokens: 0 };

describe("token estimation", () => {
  it("rounds up and treats non-positive input as zero", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(-10)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(7)).toBe(2);
  });

  it("over-counts rather than under-counts, so a ceiling never admits on a low guess", () => {
    expect(ESTIMATED_CHARS_PER_TOKEN).toBeLessThan(4);
    expect(estimateTokensFromChars(1000)).toBeGreaterThan(1000 / 4);
  });

  it("sums the parts of a prompt", () => {
    expect(estimateTokensFromText(["abcdefg", "hijklmn"])).toBe(estimateTokensFromChars(14));
  });
});

describe("estimateRequestCost", () => {
  it("prices input chars plus the declared maxTokens as the worst case", () => {
    const e = estimateRequestCost({ pricing: PAID, promptChars: 3500, maxOutputTokens: 1000 });
    expect(e.kind).toBe("bounded");
    if (e.kind !== "bounded") return;
    expect(e.inputTokens).toBe(1000);
    expect(e.outputTokens).toBe(1000);
    expect(e.dollars).toBeCloseTo((1000 * 3) / 1e6 + (1000 * 15) / 1e6, 10);
  });

  it("discounts cached input tokens at the cached rate", () => {
    const plain = estimateRequestCost({ pricing: PAID_CACHED, promptChars: 3500, maxOutputTokens: 0 });
    const cached = estimateRequestCost({
      pricing: PAID_CACHED,
      promptChars: 3500,
      maxOutputTokens: 0,
      cachedInputTokens: 900,
    });
    if (plain.kind !== "bounded" || cached.kind !== "bounded") throw new Error("bounded");
    expect(cached.dollars).toBeLessThan(plain.dollars);
  });

  it("never counts more cached tokens than there are input tokens", () => {
    const e = estimateRequestCost({
      pricing: PAID_CACHED,
      promptChars: 350,
      maxOutputTokens: 0,
      cachedInputTokens: 10_000,
    });
    if (e.kind !== "bounded") throw new Error("bounded");
    expect(e.dollars).toBeCloseTo((100 * 0.3) / 1e6, 12);
  });

  it("is unbounded when output is billed and no maxTokens was declared", () => {
    const e = estimateRequestCost({ pricing: PAID, promptChars: 100 });
    expect(e.kind).toBe("unbounded");
    if (e.kind !== "unbounded") return;
    expect(e.reason).toMatch(/no maxTokens/);
  });

  it("is bounded with no maxTokens when output is free (self-hosted)", () => {
    const e = estimateRequestCost({ pricing: FREE, promptChars: 100_000 });
    expect(e.kind).toBe("bounded");
    if (e.kind !== "bounded") return;
    expect(e.dollars).toBe(0);
  });

  it("applies an inflation factor above 1 and ignores one at or below 1", () => {
    const base = estimateRequestCost({ pricing: PAID, promptChars: 3500, maxOutputTokens: 1000 });
    const inflated = estimateRequestCost({
      pricing: PAID,
      promptChars: 3500,
      maxOutputTokens: 1000,
      inflation: 2,
    });
    const deflated = estimateRequestCost({
      pricing: PAID,
      promptChars: 3500,
      maxOutputTokens: 1000,
      inflation: 0.1,
    });
    if (base.kind !== "bounded" || inflated.kind !== "bounded" || deflated.kind !== "bounded") {
      throw new Error("bounded");
    }
    expect(inflated.dollars).toBeCloseTo(base.dollars * 2, 12);
    expect(deflated.dollars).toBeCloseTo(base.dollars, 12);
    expect(deflated.inflation).toBe(1);
  });
});

describe("admitRequestCost", () => {
  it("admits a request under the ceiling and reports how much of it was used", () => {
    const a = admitRequestCost(
      { maxDollars: 1 },
      { pricing: PAID, promptChars: 3500, maxOutputTokens: 1000 },
    );
    expect(a.outcome).toBe("admit");
    if (a.outcome !== "admit") return;
    expect(a.percentOfCeiling).toBeCloseTo(1.8, 6);
  });

  it("refuses a request whose estimate exceeds the ceiling", () => {
    const a = admitRequestCost(
      { maxDollars: 0.01 },
      { pricing: PAID, promptChars: 3500, maxOutputTokens: 200_000 },
    );
    expect(a.outcome).toBe("refuse");
    if (a.outcome !== "refuse") return;
    expect(a.reason).toMatch(/per-request ceiling/);
  });

  it("refuses an unbounded request rather than estimating it optimistically", () => {
    const a = admitRequestCost({ maxDollars: 1000 }, { pricing: PAID, promptChars: 10 });
    expect(a.outcome).toBe("refuse");
  });

  it("admits a free-priced provider with no maxTokens", () => {
    const a = admitRequestCost({ maxDollars: 0.0001 }, { pricing: FREE, promptChars: 1_000_000 });
    expect(a.outcome).toBe("admit");
  });
});

describe("reconcileRequestCost", () => {
  it("reports within_estimate when the estimate held", () => {
    const v = reconcileRequestCost({
      ceiling: { maxDollars: 1 },
      estimatedDollars: 0.5,
      actualDollars: 0.2,
    });
    expect(v.kind).toBe("within_estimate");
    expect(v.actualDollars).toBe(0.2);
  });

  it("reports over_estimate with the ratio when the ceiling still held", () => {
    const v = reconcileRequestCost({
      ceiling: { maxDollars: 1 },
      estimatedDollars: 0.2,
      actualDollars: 0.5,
    });
    expect(v.kind).toBe("over_estimate");
    if (v.kind !== "over_estimate") return;
    expect(v.ratio).toBeCloseTo(2.5, 10);
  });

  it("reports over_ceiling when the real cost broke the cap that admitted it", () => {
    const v = reconcileRequestCost({
      ceiling: { maxDollars: 1 },
      estimatedDollars: 0.9,
      actualDollars: 1.4,
    });
    expect(v.kind).toBe("over_ceiling");
  });

  it("omits the ratio when the estimate was zero (a pricing bug, not estimator drift)", () => {
    const v = reconcileRequestCost({
      ceiling: { maxDollars: 1 },
      estimatedDollars: 0,
      actualDollars: 0.3,
    });
    expect(v.kind).toBe("over_estimate");
    if (v.kind !== "over_estimate") return;
    expect(v.ratio).toBeUndefined();
  });
});

describe("StreamCostMeter", () => {
  it("lets a stream run while the accrued cost stays under the ceiling", () => {
    const m = new StreamCostMeter({ pricing: PAID, ceiling: { maxDollars: 1 }, inputTokens: 1000 });
    expect(m.accrueChars(1000)).toBe("continue");
    expect(m.accrueChars(1000)).toBe("continue");
    expect(m.outputTokens).toBe(estimateTokensFromChars(2000));
  });

  it("aborts the moment accrued output crosses the ceiling", () => {
    const m = new StreamCostMeter({
      pricing: PAID,
      ceiling: { maxDollars: 0.001 },
      inputTokens: 100,
    });
    let verdict = m.accrueChars(1000);
    let guard = 0;
    while (verdict === "continue" && guard < 100) {
      verdict = m.accrueChars(1000);
      guard += 1;
    }
    expect(verdict).toBe("abort");
    expect(m.dollars).toBeGreaterThan(0.001);
  });

  it("counts the committed input cost, so a huge prompt aborts on the first chunk", () => {
    const m = new StreamCostMeter({
      pricing: PAID,
      ceiling: { maxDollars: 0.001 },
      inputTokens: 1_000_000,
    });
    expect(m.accrueChars(1)).toBe("abort");
  });

  it("never aborts a free-priced provider", () => {
    const m = new StreamCostMeter({ pricing: FREE, ceiling: { maxDollars: 0 }, inputTokens: 10_000 });
    expect(m.accrueChars(5_000_000)).toBe("continue");
  });

  it("ignores a non-positive chunk length", () => {
    const m = new StreamCostMeter({ pricing: PAID, ceiling: { maxDollars: 1 }, inputTokens: 0 });
    expect(m.accrueChars(0)).toBe("continue");
    expect(m.outputTokens).toBe(0);
  });
});
