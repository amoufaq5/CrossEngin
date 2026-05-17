import type {
  CompletionChunk,
  CompletionRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderCapabilities,
  ProviderPricing,
  Region,
} from "./types.js";

export interface LlmProvider {
  readonly id: string;
  readonly models: readonly string[];
  readonly capabilities: ProviderCapabilities;
  readonly residency: readonly Region[];
  readonly pricing: ProviderPricing;

  complete(req: CompletionRequest): AsyncIterable<CompletionChunk>;
  embed(req: EmbeddingRequest): Promise<EmbeddingResponse>;
}
