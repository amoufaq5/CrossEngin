export const OPENAI_CHAT_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "o1",
  "o1-mini",
] as const;
export type OpenAIChatModel = (typeof OPENAI_CHAT_MODELS)[number];

export const OPENAI_EMBEDDING_MODELS = [
  "text-embedding-3-small",
  "text-embedding-3-large",
] as const;
export type OpenAIEmbeddingModel = (typeof OPENAI_EMBEDDING_MODELS)[number];

export type OpenAIModel = OpenAIChatModel | OpenAIEmbeddingModel;

export interface ChatPricing {
  readonly inputUsdPerMillion: number;
  readonly cachedInputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

export interface EmbeddingPricing {
  readonly inputUsdPerMillion: number;
}

export const OPENAI_CHAT_PRICING: Readonly<Record<OpenAIChatModel, ChatPricing>> = {
  "gpt-4o": {
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 1.25,
    outputUsdPerMillion: 10,
  },
  "gpt-4o-mini": {
    inputUsdPerMillion: 0.15,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 0.6,
  },
  "gpt-4-turbo": {
    inputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 10,
    outputUsdPerMillion: 30,
  },
  o1: {
    inputUsdPerMillion: 15,
    cachedInputUsdPerMillion: 7.5,
    outputUsdPerMillion: 60,
  },
  "o1-mini": {
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 1.5,
    outputUsdPerMillion: 12,
  },
};

export const OPENAI_EMBEDDING_PRICING: Readonly<Record<OpenAIEmbeddingModel, EmbeddingPricing>> = {
  "text-embedding-3-small": { inputUsdPerMillion: 0.02 },
  "text-embedding-3-large": { inputUsdPerMillion: 0.13 },
};

export interface ChatUsageBreakdown {
  readonly inputTokens: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens: number;
}

export function computeChatUsageCost(
  model: OpenAIChatModel,
  usage: ChatUsageBreakdown,
): number {
  const p = OPENAI_CHAT_PRICING[model];
  const cached = usage.cachedInputTokens ?? 0;
  const freshInput = Math.max(0, usage.inputTokens - cached);
  const inputCost = (freshInput * p.inputUsdPerMillion) / 1_000_000;
  const cachedCost = (cached * p.cachedInputUsdPerMillion) / 1_000_000;
  const outputCost = (usage.outputTokens * p.outputUsdPerMillion) / 1_000_000;
  return roundUsd(inputCost + cachedCost + outputCost);
}

export function computeEmbeddingCost(
  model: OpenAIEmbeddingModel,
  inputTokens: number,
): number {
  const p = OPENAI_EMBEDDING_PRICING[model];
  return roundUsd((inputTokens * p.inputUsdPerMillion) / 1_000_000);
}

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

export function isOpenAIChatModel(value: string): value is OpenAIChatModel {
  return (OPENAI_CHAT_MODELS as readonly string[]).includes(value);
}

export function isOpenAIEmbeddingModel(value: string): value is OpenAIEmbeddingModel {
  return (OPENAI_EMBEDDING_MODELS as readonly string[]).includes(value);
}

export function isOpenAIModel(value: string): value is OpenAIModel {
  return isOpenAIChatModel(value) || isOpenAIEmbeddingModel(value);
}

export const OPENAI_DEFAULT_CHAT_MODEL: OpenAIChatModel = "gpt-4o-mini";
export const OPENAI_DEFAULT_EMBEDDING_MODEL: OpenAIEmbeddingModel = "text-embedding-3-small";
