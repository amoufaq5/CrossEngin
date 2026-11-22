import { describe, expect, it } from "vitest";

import { AI_PRICING_PROVENANCES, buildDesignProviderFromEnv } from "./ai-design.js";
import {
  AI_ALLOW_UNPRICED_MODEL_FLAG,
  AI_MODEL_PRICE_FLAG,
  AI_PRICING_STALE_AFTER_DAYS,
  AiModelPriceInvalid,
  decideAiDesignPricing,
  parseDeclaredModelPrice,
  type AiDesignPricingInput,
} from "./ai-design-pricing.js";

const NOW = new Date("2026-11-18T12:00:00Z");

function input(over: Partial<AiDesignPricingInput>): AiDesignPricingInput {
  return {
    providerLabel: "openai/some-model",
    pricing: "catalogue",
    pricingAsOf: "2026-11-01",
    maxUsdPerMonth: 50,
    maxRequestDollars: 2,
    allowUnpricedModel: false,
    declaredPrice: null,
    now: NOW,
    ...over,
  };
}

describe("parseDeclaredModelPrice", () => {
  it("reads input and output, and an optional cached-input rate", () => {
    expect(parseDeclaredModelPrice("3:15")).toEqual({ inputUsdPerMillion: 3, outputUsdPerMillion: 15 });
    expect(parseDeclaredModelPrice("0.25:1.5:0.025")).toEqual({
      inputUsdPerMillion: 0.25,
      outputUsdPerMillion: 1.5,
      cachedInputUsdPerMillion: 0.025,
    });
    expect(parseDeclaredModelPrice("0:0")).toEqual({ inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  });

  it("refuses a wrong field count, a negative, a non-number and an exponent", () => {
    for (const bad of ["3", "3:15:1:1", "-3:15", "3:abc", "1e3:15", "3:", "Infinity:1"]) {
      expect(() => parseDeclaredModelPrice(bad), bad).toThrow(AiModelPriceInvalid);
    }
  });
});

describe("decideAiDesignPricing", () => {
  it("answers every provenance", () => {
    for (const pricing of AI_PRICING_PROVENANCES) {
      const d = decideAiDesignPricing(input({ pricing }));
      expect(d.info.length + d.warnings.length + (d.refusal === null ? 0 : 1)).toBeGreaterThan(0);
    }
  });

  it("refuses an unpriced model under a ceiling, naming both remedies", () => {
    const d = decideAiDesignPricing(input({ pricing: "unpriced", pricingAsOf: null }));
    expect(d.refusal).toContain(AI_MODEL_PRICE_FLAG);
    expect(d.refusal).toContain(AI_ALLOW_UNPRICED_MODEL_FLAG);
    expect(d.refusal).toContain("$50/tenant/month and $2/request ceilings");
    // A compose deployment cannot pass the flag without editing the shipped command, so the refusal
    // has to name the variable it can set.
    expect(d.refusal).toContain("OPERATE_AI_MODEL_PRICE");
  });

  it("serves an unpriced model under the hatch and warns that the ceiling bounds nothing", () => {
    const d = decideAiDesignPricing(input({ pricing: "unpriced", pricingAsOf: null, allowUnpricedModel: true }));
    expect(d.refusal).toBeNull();
    expect(d.warnings[0]).toMatch(/admit every request/);
    expect(d.warnings[0]).toContain(AI_ALLOW_UNPRICED_MODEL_FLAG);
  });

  it("serves a self-hosted model and says its ceilings bound nothing rather than refusing", () => {
    const d = decideAiDesignPricing(input({ pricing: "self_hosted_free", pricingAsOf: null, maxRequestDollars: null }));
    expect(d.refusal).toBeNull();
    expect(d.warnings[0]).toMatch(/bound nothing/);
    expect(d.warnings[0]).toContain("the $50/tenant/month ceiling");
  });

  it("reports the catalogue's check date and warns only once it is older than the stale horizon", () => {
    const fresh = decideAiDesignPricing(input({ pricingAsOf: "2026-11-03" }));
    expect(fresh.info[0]).toContain("checked 2026-11-03");
    expect(fresh.warnings).toEqual([]);
    const edge = new Date(Date.parse("2026-01-01T00:00:00Z") + AI_PRICING_STALE_AFTER_DAYS * 86_400_000);
    expect(decideAiDesignPricing(input({ pricingAsOf: "2026-01-01", now: edge })).warnings).toEqual([]);
    const stale = decideAiDesignPricing(input({ pricingAsOf: "2026-08-01" }));
    expect(stale.warnings[0]).toMatch(/109 days ago/);
    expect(stale.warnings[0]).toContain(AI_MODEL_PRICE_FLAG);
  });

  it("treats a declared price as enforced", () => {
    const d = decideAiDesignPricing(
      input({ pricing: "declared", pricingAsOf: null, declaredPrice: { inputUsdPerMillion: 0, outputUsdPerMillion: 0.5 } }),
    );
    expect(d.refusal).toBeNull();
    expect(d.warnings).toEqual([]);
    expect(d.info[0]).toContain(AI_MODEL_PRICE_FLAG);
  });

  it("says a declared $0 price bounds nothing rather than calling it enforced", () => {
    const d = decideAiDesignPricing(
      input({ pricing: "declared", pricingAsOf: null, declaredPrice: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } }),
    );
    expect(d.refusal).toBeNull();
    expect(d.info).toEqual([]);
    expect(d.warnings[0]).toMatch(/declared free/);
    expect(d.warnings[0]).toMatch(/bound nothing/);
  });
});

describe("buildDesignProviderFromEnv — pricing provenance", () => {
  const key = ["sk", "test", "fixture"].join("-");

  it("prices a catalogued cloud model from the catalogue with its check date", () => {
    const a = buildDesignProviderFromEnv({ ANTHROPIC_API_KEY: key });
    expect(a?.pricing).toBe("catalogue");
    expect(a?.pricingAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const o = buildDesignProviderFromEnv({ OPENAI_API_KEY: key });
    expect(o?.pricing).toBe("catalogue");
  });

  it("calls a custom endpoint's off-catalogue model unpriced, and a declared price declared", () => {
    const env = { OPENAI_API_KEY: key, OPENAI_BASE_URL: "http://proxy.invalid/v1" };
    const bare = buildDesignProviderFromEnv(env, { model: "vendor/some-model" });
    expect(bare?.pricing).toBe("unpriced");
    expect(bare?.pricingAsOf).toBeNull();
    const priced = buildDesignProviderFromEnv(env, {
      model: "vendor/some-model",
      declaredPrice: { inputUsdPerMillion: 2, outputUsdPerMillion: 8 },
    });
    expect(priced?.pricing).toBe("declared");
    expect(priced?.provider.pricing?.inputPerMillionTokens).toBe(2);
    expect(priced?.provider.pricing?.outputPerMillionTokens).toBe(8);
    expect(bare?.provider.pricing?.outputPerMillionTokens).toBe(0);
  });

  it("calls an undeclared local model self-hosted-free and a declared one declared", () => {
    expect(buildDesignProviderFromEnv({ LOCAL_LLM_BASE_URL: "http://127.0.0.1:11434" })?.pricing).toBe("self_hosted_free");
    expect(
      buildDesignProviderFromEnv(
        { LOCAL_LLM_BASE_URL: "http://127.0.0.1:11434" },
        { declaredPrice: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 } },
      )?.pricing,
    ).toBe("declared");
  });
});
