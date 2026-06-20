import type { ProviderPricing, Usage } from "@crossengin/ai-providers";

/**
 * Locally hosted open-source models (Ollama / vLLM / LM Studio / llama.cpp /
 * LocalAI) run on the operator's own hardware, so per-token billing is zero.
 * The cost tracker still receives a Usage with `cost: 0`, which keeps the
 * router's accounting consistent across cloud and local providers.
 */
export const LOCAL_ZERO_PRICING: ProviderPricing = {
  inputPerMillionTokens: 0,
  outputPerMillionTokens: 0,
  cachedInputPerMillionTokens: 0,
};

export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
}

/** Local inference is free; the monetary cost is always zero. */
export function computeLocalCost(_tokens: TokenCounts): number {
  return 0;
}

/** Builds a zero-cost Usage from raw token counts, dropping absent fields. */
export function localUsage(tokens: TokenCounts): Usage {
  const cached = tokens.cachedInputTokens ?? 0;
  return {
    inputTokens: Math.max(0, tokens.inputTokens),
    outputTokens: Math.max(0, tokens.outputTokens),
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
    cost: 0,
  };
}
