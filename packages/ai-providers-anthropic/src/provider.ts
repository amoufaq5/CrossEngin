import type {
  CompletionChunk,
  CompletionRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  LlmProvider,
  ProviderCapabilities,
  ProviderPricing,
  Region,
} from "@crossengin/ai-providers";

import { AnthropicError, fromHttpResponse, fromNetworkError } from "./errors.js";
import {
  buildAnthropicRequest,
  type AnthropicResponse,
  extractText,
  extractToolCalls,
  normalizeUsage,
} from "./messages-api.js";
import { ANTHROPIC_PRICING, isAnthropicModel, type AnthropicModel } from "./pricing.js";
import { chunksFromSse, readSseStream } from "./streaming.js";

export const ANTHROPIC_API_VERSION = "2023-06-01";
export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; body: ReadableStream<Uint8Array> | null }>;

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly defaultModel: AnthropicModel;
  readonly defaultMaxTokens?: number;
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  readonly residency?: readonly Region[];
  readonly fetch?: FetchLike;
  readonly anthropicBeta?: readonly string[];
}

const PROVIDER_ID = "anthropic";

export class AnthropicProvider implements LlmProvider {
  readonly id = PROVIDER_ID;
  readonly models: readonly string[];
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    toolUse: true,
    jsonMode: false,
    embedding: false,
    maxContextTokens: 200_000,
    supportsThinking: true,
    vision: true,
  };
  readonly residency: readonly Region[];
  readonly pricing: ProviderPricing;

  private readonly apiKey: string;
  private readonly defaultModel: AnthropicModel;
  private readonly defaultMaxTokens: number | undefined;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: FetchLike;
  private readonly anthropicBeta: readonly string[];

  constructor(opts: AnthropicProviderOptions) {
    if (opts.apiKey.length === 0) {
      throw new Error("AnthropicProvider: apiKey is required");
    }
    if (!isAnthropicModel(opts.defaultModel)) {
      throw new Error(`AnthropicProvider: unsupported defaultModel ${opts.defaultModel}`);
    }
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel;
    this.defaultMaxTokens = opts.defaultMaxTokens;
    this.baseUrl = opts.baseUrl ?? ANTHROPIC_API_BASE_URL;
    this.apiVersion = opts.apiVersion ?? ANTHROPIC_API_VERSION;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.anthropicBeta = opts.anthropicBeta ?? [];
    this.models = Object.keys(ANTHROPIC_PRICING);
    this.residency = opts.residency ?? ["us", "eu"];
    const defaultPricing = ANTHROPIC_PRICING[this.defaultModel];
    this.pricing = {
      inputPerMillionTokens: defaultPricing.inputUsdPerMillion,
      outputPerMillionTokens: defaultPricing.outputUsdPerMillion,
      cachedInputPerMillionTokens: defaultPricing.cachedInputUsdPerMillion,
    };
  }

  async *complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    const model = this.resolveModel(req.model);
    const built = buildAnthropicRequest(req, {
      defaultModel: this.defaultModel,
      defaultMaxTokens: this.defaultMaxTokens,
      stream: true,
    });
    let response;
    try {
      response = await this.fetchImpl(this.url("/v1/messages"), {
        method: "POST",
        headers: this.headers({ stream: true }),
        body: JSON.stringify(built),
      });
    } catch (err) {
      throw fromNetworkError(err);
    }
    if (!response.ok) {
      throw fromHttpResponse({ status: response.status, body: await response.text() });
    }
    if (response.body === null) {
      throw new AnthropicError({
        kind: "api_error",
        message: "Anthropic streaming response had no body",
        status: response.status,
      });
    }
    yield* readSseStream(response.body, model);
  }

  async embed(_req: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new AnthropicError({
      kind: "invalid_request_error",
      message: "Anthropic does not offer embeddings; use a different provider for embed()",
    });
  }

  async completeNonStreaming(req: CompletionRequest): Promise<AnthropicResponse> {
    const built = buildAnthropicRequest(req, {
      defaultModel: this.defaultModel,
      defaultMaxTokens: this.defaultMaxTokens,
      stream: false,
    });
    let response;
    try {
      response = await this.fetchImpl(this.url("/v1/messages"), {
        method: "POST",
        headers: this.headers({ stream: false }),
        body: JSON.stringify(built),
      });
    } catch (err) {
      throw fromNetworkError(err);
    }
    if (!response.ok) {
      throw fromHttpResponse({ status: response.status, body: await response.text() });
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as AnthropicResponse;
    } catch (err) {
      throw new AnthropicError({
        kind: "api_error",
        message: `failed to parse Anthropic response: ${err instanceof Error ? err.message : String(err)}`,
        status: response.status,
      });
    }
  }

  async chunksFromTextStream(sse: string, model?: AnthropicModel): Promise<readonly CompletionChunk[]> {
    return [...chunksFromSse(sse, model ?? this.defaultModel)];
  }

  private resolveModel(requested: string | undefined): AnthropicModel {
    if (requested === undefined) return this.defaultModel;
    if (!isAnthropicModel(requested)) {
      throw new AnthropicError({
        kind: "invalid_request_error",
        message: `Anthropic provider does not support model: ${requested}`,
      });
    }
    return requested;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private headers(opts: { stream: boolean }): Record<string, string> {
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      "anthropic-version": this.apiVersion,
      "content-type": "application/json",
    };
    if (this.anthropicBeta.length > 0) {
      headers["anthropic-beta"] = this.anthropicBeta.join(",");
    }
    if (opts.stream) {
      headers["accept"] = "text/event-stream";
    } else {
      headers["accept"] = "application/json";
    }
    return headers;
  }
}

export function extractCompletion(response: AnthropicResponse): {
  readonly text: string | undefined;
  readonly toolCalls: ReadonlyArray<{ id: string; name: string; input: unknown }>;
  readonly stopReason: AnthropicResponse["stop_reason"];
} {
  const text = extractText(response);
  const toolCalls = extractToolCalls(response);
  return {
    text: text.length > 0 ? text : undefined,
    toolCalls,
    stopReason: response.stop_reason,
  };
}

export function summarizeResponse(response: AnthropicResponse, model: AnthropicModel) {
  return {
    text: extractText(response),
    toolCalls: extractToolCalls(response),
    stopReason: response.stop_reason,
    usage: normalizeUsage(model, response.usage),
  };
}
