import type {
  CompletionChunk,
  CompletionRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  LlmProvider,
  ProviderCapabilities,
  ProviderPricing,
  Region,
  Usage,
} from "@crossengin/ai-providers";

import {
  buildOpenAiRequest,
  extractText,
  extractToolCalls,
  normalizeUsage,
  type OpenAiResponse,
} from "./chat-api.js";
import { OpenAiError, fromHttpResponse, fromNetworkError } from "./errors.js";
import {
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_PRICING,
  computeUsageCost,
  isOpenAiChatModel,
  isOpenAiEmbeddingModel,
  type OpenAiChatModel,
  type OpenAiEmbeddingModel,
} from "./pricing.js";
import { chunksFromSse, readSseStream } from "./streaming.js";

export const OPENAI_API_BASE_URL = "https://api.openai.com";
export const DEFAULT_EMBEDDING_MODEL: OpenAiEmbeddingModel = "text-embedding-3-small";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; body: ReadableStream<Uint8Array> | null }>;

export interface OpenAiProviderOptions {
  readonly apiKey: string;
  readonly defaultModel: OpenAiChatModel;
  readonly defaultEmbeddingModel?: OpenAiEmbeddingModel;
  readonly defaultMaxTokens?: number;
  readonly baseUrl?: string;
  readonly organization?: string;
  readonly project?: string;
  readonly residency?: readonly Region[];
  readonly fetch?: FetchLike;
}

interface OpenAiEmbeddingApiResponse {
  readonly data: readonly { readonly embedding: readonly number[]; readonly index: number }[];
  readonly model: string;
  readonly usage: { readonly prompt_tokens: number; readonly total_tokens: number };
}

const PROVIDER_ID = "openai";

export class OpenAiProvider implements LlmProvider {
  readonly id = PROVIDER_ID;
  readonly models: readonly string[];
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    toolUse: true,
    jsonMode: true,
    embedding: true,
    maxContextTokens: 128_000,
    supportsThinking: false,
  };
  readonly residency: readonly Region[];
  readonly pricing: ProviderPricing;

  private readonly apiKey: string;
  private readonly defaultModel: OpenAiChatModel;
  private readonly defaultEmbeddingModel: OpenAiEmbeddingModel;
  private readonly defaultMaxTokens: number | undefined;
  private readonly baseUrl: string;
  private readonly organization: string | undefined;
  private readonly project: string | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OpenAiProviderOptions) {
    if (opts.apiKey.length === 0) {
      throw new Error("OpenAiProvider: apiKey is required");
    }
    if (!isOpenAiChatModel(opts.defaultModel)) {
      throw new Error(`OpenAiProvider: unsupported defaultModel ${opts.defaultModel}`);
    }
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel;
    this.defaultEmbeddingModel = opts.defaultEmbeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    this.defaultMaxTokens = opts.defaultMaxTokens;
    this.baseUrl = opts.baseUrl ?? OPENAI_API_BASE_URL;
    this.organization = opts.organization;
    this.project = opts.project;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.models = Object.keys(OPENAI_PRICING);
    this.residency = opts.residency ?? ["us", "eu"];
    const defaultPricing = OPENAI_PRICING[this.defaultModel];
    this.pricing = {
      inputPerMillionTokens: defaultPricing.inputUsdPerMillion,
      outputPerMillionTokens: defaultPricing.outputUsdPerMillion,
      cachedInputPerMillionTokens: defaultPricing.cachedInputUsdPerMillion,
    };
  }

  async *complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    const model = this.resolveModel(req.model);
    const built = buildOpenAiRequest(req, {
      defaultModel: this.defaultModel,
      defaultMaxTokens: this.defaultMaxTokens,
      stream: true,
    });
    let response;
    try {
      response = await this.fetchImpl(this.url("/v1/chat/completions"), {
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
      throw new OpenAiError({
        kind: "server_error",
        message: "OpenAI streaming response had no body",
        status: response.status,
      });
    }
    yield* readSseStream(response.body, model);
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = this.resolveEmbeddingModel(req.model);
    let response;
    try {
      response = await this.fetchImpl(this.url("/v1/embeddings"), {
        method: "POST",
        headers: this.headers({ stream: false }),
        body: JSON.stringify({ model, input: req.texts }),
      });
    } catch (err) {
      throw fromNetworkError(err);
    }
    if (!response.ok) {
      throw fromHttpResponse({ status: response.status, body: await response.text() });
    }
    const text = await response.text();
    let parsed: OpenAiEmbeddingApiResponse;
    try {
      parsed = JSON.parse(text) as OpenAiEmbeddingApiResponse;
    } catch (err) {
      throw new OpenAiError({
        kind: "server_error",
        message: `failed to parse OpenAI embedding response: ${err instanceof Error ? err.message : String(err)}`,
        status: response.status,
      });
    }
    const ordered = [...parsed.data].sort((a, b) => a.index - b.index);
    const vectors = ordered.map((d) => [...d.embedding]);
    const dim = vectors[0]?.length ?? OPENAI_EMBEDDING_DIMENSIONS[model];
    const usage: Usage = {
      inputTokens: parsed.usage.prompt_tokens,
      outputTokens: 0,
      cost: computeUsageCost(model, {
        inputTokens: parsed.usage.prompt_tokens,
        outputTokens: 0,
      }),
    };
    return { vectors, dim, model, usage };
  }

  async completeNonStreaming(req: CompletionRequest): Promise<OpenAiResponse> {
    const built = buildOpenAiRequest(req, {
      defaultModel: this.defaultModel,
      defaultMaxTokens: this.defaultMaxTokens,
      stream: false,
    });
    let response;
    try {
      response = await this.fetchImpl(this.url("/v1/chat/completions"), {
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
      return JSON.parse(text) as OpenAiResponse;
    } catch (err) {
      throw new OpenAiError({
        kind: "server_error",
        message: `failed to parse OpenAI response: ${err instanceof Error ? err.message : String(err)}`,
        status: response.status,
      });
    }
  }

  chunksFromTextStream(sse: string, model?: OpenAiChatModel): readonly CompletionChunk[] {
    return [...chunksFromSse(sse, model ?? this.defaultModel)];
  }

  private resolveModel(requested: string | undefined): OpenAiChatModel {
    if (requested === undefined) return this.defaultModel;
    if (!isOpenAiChatModel(requested)) {
      throw new OpenAiError({
        kind: "invalid_request_error",
        message: `OpenAI provider does not support chat model: ${requested}`,
      });
    }
    return requested;
  }

  private resolveEmbeddingModel(requested: string | undefined): OpenAiEmbeddingModel {
    if (requested === undefined) return this.defaultEmbeddingModel;
    if (!isOpenAiEmbeddingModel(requested)) {
      throw new OpenAiError({
        kind: "invalid_request_error",
        message: `OpenAI provider does not support embedding model: ${requested}`,
      });
    }
    return requested;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private headers(_opts: { stream: boolean }): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };
    if (this.organization !== undefined) headers["openai-organization"] = this.organization;
    if (this.project !== undefined) headers["openai-project"] = this.project;
    return headers;
  }
}

export function summarizeResponse(response: OpenAiResponse, model: OpenAiChatModel) {
  return {
    text: extractText(response),
    toolCalls: extractToolCalls(response),
    finishReason: response.choices[0]?.finish_reason ?? null,
    usage: normalizeUsage(model, response.usage),
  };
}
