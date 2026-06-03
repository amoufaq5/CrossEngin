export interface OpenAiModelPricing {
  readonly inputUsdPerMillion: number;
  readonly cachedInputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

export const OPENAI_CHAT_MODELS = [
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4o",
  "gpt-4o-mini",
  "o4-mini",
] as const;
export type OpenAiChatModel = (typeof OPENAI_CHAT_MODELS)[number];

export const OPENAI_EMBEDDING_MODELS = [
  "text-embedding-3-small",
  "text-embedding-3-large",
] as const;
export type OpenAiEmbeddingModel = (typeof OPENAI_EMBEDDING_MODELS)[number];

export type OpenAiModel = OpenAiChatModel | OpenAiEmbeddingModel;

export const OPENAI_PRICING: Readonly<Record<OpenAiModel, OpenAiModelPricing>> = {
  "gpt-4.1": { inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 8 },
  "gpt-4.1-mini": { inputUsdPerMillion: 0.4, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 1.6 },
  "gpt-4o": { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 1.25, outputUsdPerMillion: 10 },
  "gpt-4o-mini": { inputUsdPerMillion: 0.15, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 0.6 },
  "o4-mini": { inputUsdPerMillion: 1.1, cachedInputUsdPerMillion: 0.275, outputUsdPerMillion: 4.4 },
  "text-embedding-3-small": { inputUsdPerMillion: 0.02, cachedInputUsdPerMillion: 0.02, outputUsdPerMillion: 0 },
  "text-embedding-3-large": { inputUsdPerMillion: 0.13, cachedInputUsdPerMillion: 0.13, outputUsdPerMillion: 0 },
};

export const OPENAI_EMBEDDING_DIMENSIONS: Readonly<Record<OpenAiEmbeddingModel, number>> = {
  "text-embedding-3-small": 1_536,
  "text-embedding-3-large": 3_072,
};

export function isOpenAiChatModel(value: unknown): value is OpenAiChatModel {
  return typeof value === "string" && (OPENAI_CHAT_MODELS as readonly string[]).includes(value);
}

export function isOpenAiEmbeddingModel(value: unknown): value is OpenAiEmbeddingModel {
  return typeof value === "string" && (OPENAI_EMBEDDING_MODELS as readonly string[]).includes(value);
}

export interface UsageCostInput {
  readonly inputTokens: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens: number;
}

export function computeUsageCost(model: OpenAiModel, usage: UsageCostInput): number {
  const pricing = OPENAI_PRICING[model];
  const cached = usage.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  const inputDollars = (uncachedInput * pricing.inputUsdPerMillion) / 1_000_000;
  const cachedDollars = (cached * pricing.cachedInputUsdPerMillion) / 1_000_000;
  const outputDollars = (usage.outputTokens * pricing.outputUsdPerMillion) / 1_000_000;
  const total = inputDollars + cachedDollars + outputDollars;
  return Math.round(total * 1_000_000) / 1_000_000;
}
