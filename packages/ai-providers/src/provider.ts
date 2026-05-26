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

  // Per-model rate for cost estimation; undefined for models unknown to this
  // provider (callers fall back to the provider-level `pricing`). Optional.
  pricingFor?(modelId: string): ProviderPricing | undefined;
}
