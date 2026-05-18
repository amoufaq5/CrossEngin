import type { EmbeddingResponse, Usage } from "@crossengin/ai-providers";

import { BedrockError } from "./errors.js";
import {
  buildBedrockEmbeddingUsage,
  type BedrockEmbeddingModel,
} from "./pricing.js";

export type BedrockEmbeddingFamily = "titan" | "cohere";

export function bedrockEmbeddingFamily(
  model: BedrockEmbeddingModel,
): BedrockEmbeddingFamily {
  if (model.startsWith("amazon.titan-embed-text")) return "titan";
  if (model.startsWith("cohere.embed-")) return "cohere";
  throw new BedrockError({
    kind: "invalid_request_error",
    message: `unknown bedrock embedding model family for '${model}'`,
  });
}

export const TITAN_V2_DEFAULT_DIMENSIONS = 1024;
export const TITAN_V2_VALID_DIMENSIONS: readonly number[] = [256, 512, 1024];

export interface TitanEmbedRequest {
  readonly inputText: string;
  readonly dimensions?: number;
  readonly normalize?: boolean;
}

export interface TitanEmbedResponse {
  readonly embedding: readonly number[];
  readonly inputTextTokenCount: number;
}

export function buildTitanEmbedRequest(input: {
  readonly model: BedrockEmbeddingModel;
  readonly text: string;
  readonly dimensions?: number;
}): TitanEmbedRequest {
  if (input.model === "amazon.titan-embed-text-v2:0") {
    const dim = input.dimensions ?? TITAN_V2_DEFAULT_DIMENSIONS;
    if (!TITAN_V2_VALID_DIMENSIONS.includes(dim)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `titan-embed-text-v2 dimensions must be one of ${TITAN_V2_VALID_DIMENSIONS.join("/")}, got ${dim.toString()}`,
      });
    }
    return { inputText: input.text, dimensions: dim, normalize: true };
  }
  return { inputText: input.text };
}

export type CohereEmbedInputType =
  | "search_document"
  | "search_query"
  | "classification"
  | "clustering";

export interface CohereEmbedRequest {
  readonly texts: readonly string[];
  readonly input_type: CohereEmbedInputType;
  readonly truncate?: "NONE" | "START" | "END";
}

export interface CohereEmbedResponse {
  readonly id: string;
  readonly embeddings: ReadonlyArray<readonly number[]>;
  readonly texts: readonly string[];
  readonly response_type?: string;
  readonly meta?: {
    readonly billed_units?: { readonly input_tokens?: number };
  };
}

export const COHERE_MAX_BATCH_SIZE = 96;
export const COHERE_DEFAULT_INPUT_TYPE: CohereEmbedInputType = "search_document";

export function buildCohereEmbedRequest(input: {
  readonly texts: readonly string[];
  readonly inputType?: CohereEmbedInputType;
}): CohereEmbedRequest {
  if (input.texts.length === 0) {
    throw new BedrockError({
      kind: "invalid_request_error",
      message: "cohere embeddings require at least one text",
    });
  }
  if (input.texts.length > COHERE_MAX_BATCH_SIZE) {
    throw new BedrockError({
      kind: "invalid_request_error",
      message: `cohere embeddings accept at most ${COHERE_MAX_BATCH_SIZE.toString()} texts per call, got ${input.texts.length.toString()}`,
    });
  }
  return {
    texts: [...input.texts],
    input_type: input.inputType ?? COHERE_DEFAULT_INPUT_TYPE,
  };
}

export function parseTitanEmbedResponse(raw: unknown): TitanEmbedResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new BedrockError({
      kind: "api_error",
      message: "titan embedding response is not an object",
    });
  }
  const obj = raw as { embedding?: unknown; inputTextTokenCount?: unknown };
  if (!Array.isArray(obj.embedding)) {
    throw new BedrockError({
      kind: "api_error",
      message: "titan embedding response missing 'embedding' array",
    });
  }
  const tokens = typeof obj.inputTextTokenCount === "number" ? obj.inputTextTokenCount : 0;
  return {
    embedding: obj.embedding as readonly number[],
    inputTextTokenCount: tokens,
  };
}

export function parseCohereEmbedResponse(raw: unknown): CohereEmbedResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new BedrockError({
      kind: "api_error",
      message: "cohere embedding response is not an object",
    });
  }
  const obj = raw as {
    id?: unknown;
    embeddings?: unknown;
    texts?: unknown;
    response_type?: unknown;
    meta?: unknown;
  };
  if (!Array.isArray(obj.embeddings)) {
    throw new BedrockError({
      kind: "api_error",
      message: "cohere embedding response missing 'embeddings' array",
    });
  }
  return {
    id: typeof obj.id === "string" ? obj.id : "",
    embeddings: obj.embeddings as ReadonlyArray<readonly number[]>,
    texts: Array.isArray(obj.texts) ? (obj.texts as readonly string[]) : [],
    response_type: typeof obj.response_type === "string" ? obj.response_type : undefined,
    meta: obj.meta as CohereEmbedResponse["meta"],
  };
}

export interface EmbeddingAggregation {
  readonly vectors: ReadonlyArray<readonly number[]>;
  readonly dim: number;
  readonly inputTokens: number;
}

export function buildEmbeddingResponse(input: {
  readonly model: BedrockEmbeddingModel;
  readonly aggregation: EmbeddingAggregation;
}): EmbeddingResponse {
  const usage: Usage = buildBedrockEmbeddingUsage(
    input.model,
    input.aggregation.inputTokens,
  );
  return {
    vectors: input.aggregation.vectors.map((v) => [...v]),
    dim: input.aggregation.dim,
    model: input.model,
    usage,
  };
}

export function approximateTokenCount(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
