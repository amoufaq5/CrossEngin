import type { Usage } from "@crossengin/ai-providers";

export const BEDROCK_CHAT_MODELS = [
  "anthropic.claude-3-5-haiku-20241022-v1:0",
  "anthropic.claude-3-5-sonnet-20241022-v2:0",
  "anthropic.claude-3-7-sonnet-20250219-v1:0",
  "anthropic.claude-opus-4-20250514-v1:0",
  "meta.llama3-1-70b-instruct-v1:0",
  "meta.llama3-1-405b-instruct-v1:0",
  "mistral.mistral-large-2407-v1:0",
  "amazon.titan-text-premier-v1:0",
] as const;

export type BedrockChatModel = (typeof BEDROCK_CHAT_MODELS)[number];

export interface BedrockChatPricing {
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly cachedInputUsdPerMillion?: number;
}

export const BEDROCK_CHAT_PRICING: Readonly<Record<BedrockChatModel, BedrockChatPricing>> = {
  "anthropic.claude-3-5-haiku-20241022-v1:0": {
    inputUsdPerMillion: 0.8,
    outputUsdPerMillion: 4.0,
    cachedInputUsdPerMillion: 0.08,
  },
  "anthropic.claude-3-5-sonnet-20241022-v2:0": {
    inputUsdPerMillion: 3.0,
    outputUsdPerMillion: 15.0,
    cachedInputUsdPerMillion: 0.3,
  },
  "anthropic.claude-3-7-sonnet-20250219-v1:0": {
    inputUsdPerMillion: 3.0,
    outputUsdPerMillion: 15.0,
    cachedInputUsdPerMillion: 0.3,
  },
  "anthropic.claude-opus-4-20250514-v1:0": {
    inputUsdPerMillion: 15.0,
    outputUsdPerMillion: 75.0,
    cachedInputUsdPerMillion: 1.5,
  },
  "meta.llama3-1-70b-instruct-v1:0": {
    inputUsdPerMillion: 0.72,
    outputUsdPerMillion: 0.72,
  },
  "meta.llama3-1-405b-instruct-v1:0": {
    inputUsdPerMillion: 5.32,
    outputUsdPerMillion: 16.0,
  },
  "mistral.mistral-large-2407-v1:0": {
    inputUsdPerMillion: 2.0,
    outputUsdPerMillion: 6.0,
  },
  "amazon.titan-text-premier-v1:0": {
    inputUsdPerMillion: 0.5,
    outputUsdPerMillion: 1.5,
  },
};

export interface BedrockTokenBreakdown {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
}

export function computeBedrockChatCost(
  model: BedrockChatModel,
  tokens: BedrockTokenBreakdown,
): number {
  const pricing = BEDROCK_CHAT_PRICING[model];
  const cached = tokens.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, tokens.inputTokens - cached);
  const cachedRate = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
  const inputCost = (uncachedInput * pricing.inputUsdPerMillion) / 1_000_000;
  const cachedCost = (cached * cachedRate) / 1_000_000;
  const outputCost = (tokens.outputTokens * pricing.outputUsdPerMillion) / 1_000_000;
  return Number((inputCost + cachedCost + outputCost).toFixed(6));
}

export function buildBedrockUsage(
  model: BedrockChatModel,
  tokens: BedrockTokenBreakdown,
): Usage {
  return {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    ...(tokens.cachedInputTokens !== undefined && tokens.cachedInputTokens > 0
      ? { cachedInputTokens: tokens.cachedInputTokens }
      : {}),
    cost: computeBedrockChatCost(model, tokens),
  };
}

export function isBedrockChatModel(value: string): value is BedrockChatModel {
  return (BEDROCK_CHAT_MODELS as readonly string[]).includes(value);
}
