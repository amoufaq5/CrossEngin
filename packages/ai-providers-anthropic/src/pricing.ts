export interface AnthropicModelPricing {
  readonly inputUsdPerMillion: number;
  readonly cachedInputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly cacheWriteUsdPerMillion: number;
}

/**
 * The date the list prices below were last checked against Anthropic's published table. A list
 * price is not a contract price and goes stale; a deployment whose figure differs declares its own
 * (`AnthropicProviderOptions.pricingOverride`). The Opus rows were 3x too high until this date —
 * they carried the previous generation's $15/$75.
 */
export const ANTHROPIC_PRICING_AS_OF = "2026-11-03";

export const ANTHROPIC_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;
export type AnthropicModel = (typeof ANTHROPIC_MODELS)[number];

export const ANTHROPIC_PRICING: Readonly<Record<AnthropicModel, AnthropicModelPricing>> = {
  "claude-opus-4-7": {
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
    cacheWriteUsdPerMillion: 6.25,
  },
  "claude-opus-4-6": {
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
    cacheWriteUsdPerMillion: 6.25,
  },
  "claude-sonnet-4-6": {
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
    cacheWriteUsdPerMillion: 3.75,
  },
  "claude-sonnet-4-5": {
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
    cacheWriteUsdPerMillion: 3.75,
  },
  "claude-haiku-4-5": {
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    outputUsdPerMillion: 5,
    cacheWriteUsdPerMillion: 1.25,
  },
};

export function isAnthropicModel(value: unknown): value is AnthropicModel {
  return typeof value === "string" && (ANTHROPIC_MODELS as readonly string[]).includes(value);
}

export interface UsageCostInput {
  readonly inputTokens: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens: number;
}

export function computeUsageCost(
  model: AnthropicModel,
  usage: UsageCostInput,
  pricingOverride?: AnthropicModelPricing,
): number {
  const pricing = pricingOverride ?? ANTHROPIC_PRICING[model];
  const inputDollars =
    ((usage.inputTokens - (usage.cachedInputTokens ?? 0)) * pricing.inputUsdPerMillion) /
    1_000_000;
  const cachedDollars =
    ((usage.cachedInputTokens ?? 0) * pricing.cachedInputUsdPerMillion) / 1_000_000;
  const cacheWriteDollars =
    ((usage.cacheWriteTokens ?? 0) * pricing.cacheWriteUsdPerMillion) / 1_000_000;
  const outputDollars = (usage.outputTokens * pricing.outputUsdPerMillion) / 1_000_000;
  const total = inputDollars + cachedDollars + cacheWriteDollars + outputDollars;
  return Math.round(total * 1_000_000) / 1_000_000;
}
