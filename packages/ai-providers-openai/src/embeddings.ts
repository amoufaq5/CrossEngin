import type { EmbeddingResponse, Usage } from "@crossengin/ai-providers";

import { computeEmbeddingCost, type OpenAIEmbeddingModel } from "./pricing.js";

export interface OpenAIEmbeddingsRequest {
  readonly model: string;
  readonly input: readonly string[];
  readonly encoding_format: "float";
}

export interface OpenAIEmbeddingsUsage {
  readonly prompt_tokens: number;
  readonly total_tokens: number;
}

export interface OpenAIEmbeddingsResponse {
  readonly object: "list";
  readonly model: string;
  readonly data: ReadonlyArray<{
    readonly object: "embedding";
    readonly embedding: readonly number[];
    readonly index: number;
  }>;
  readonly usage: OpenAIEmbeddingsUsage;
}

export function buildEmbeddingsRequest(input: {
  readonly texts: readonly string[];
  readonly model: OpenAIEmbeddingModel;
}): OpenAIEmbeddingsRequest {
  return {
    model: input.model,
    input: [...input.texts],
    encoding_format: "float",
  };
}

export function normalizeEmbeddingResponse(
  model: OpenAIEmbeddingModel,
  raw: OpenAIEmbeddingsResponse,
): EmbeddingResponse {
  const sorted = [...raw.data].sort((a, b) => a.index - b.index);
  const vectors = sorted.map((d) => [...d.embedding]);
  const dim = vectors[0]?.length ?? 0;
  const usage = normalizeEmbeddingUsage(model, raw.usage);
  return {
    vectors,
    dim,
    model: raw.model,
    usage,
  };
}

export function normalizeEmbeddingUsage(
  model: OpenAIEmbeddingModel,
  usage: OpenAIEmbeddingsUsage,
): Usage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: 0,
    cost: computeEmbeddingCost(model, usage.prompt_tokens),
  };
}
