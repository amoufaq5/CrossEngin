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

import { buildLocalRequest, type LocalResponse } from "./chat-api.js";
import { LocalProviderError, fromHttpResponse, fromNetworkError } from "./errors.js";
import { LOCAL_ZERO_PRICING } from "./pricing.js";
import { chunksFromSse, readSseStream } from "./streaming.js";

/** Ollama's OpenAI-compatible endpoint. Includes the `/v1` version segment. */
export const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_LOCAL_MODEL = "llama3.1";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  body: ReadableStream<Uint8Array> | null;
}>;

export interface LocalLlmProviderOptions {
  /** Default chat model name, e.g. "llama3.1", "qwen2.5", "mistral". */
  readonly defaultModel?: string;
  /** Base URL of the OpenAI-compatible server (default Ollama on :11434/v1). */
  readonly baseUrl?: string;
  /** Optional bearer token (some servers, e.g. LM Studio behind a proxy, want one). */
  readonly apiKey?: string;
  /** Provider id used by the router (default "local"). */
  readonly id?: string;
  /** Models advertised on `.models` (defaults to just the default model). */
  readonly models?: readonly string[];
  readonly defaultEmbeddingModel?: string;
  readonly defaultMaxTokens?: number;
  readonly maxContextTokens?: number;
  /**
   * Residency regions this provider satisfies. Local inference never leaves the
   * operator's hardware, so by default it satisfies every region.
   */
  readonly residency?: readonly Region[];
  readonly capabilities?: Partial<ProviderCapabilities>;
  readonly fetch?: FetchLike;
}

interface LocalEmbeddingApiResponse {
  readonly data: readonly { readonly embedding: readonly number[]; readonly index: number }[];
  readonly model?: string;
  readonly usage?: { readonly prompt_tokens?: number; readonly total_tokens?: number };
}

const ALL_REGIONS: readonly Region[] = ["eu", "us", "me", "ap", "sa"];

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  chat: true,
  streaming: true,
  toolUse: true,
  jsonMode: true,
  embedding: true,
  maxContextTokens: 8_192,
  supportsThinking: false,
};

/**
 * An `LlmProvider` backed by any local OpenAI-compatible inference server —
 * Ollama, vLLM, LM Studio, llama.cpp's server, LocalAI, text-generation-webui.
 * Arbitrary model names are accepted (no fixed allow-list), cost is always
 * zero, and data never leaves the host. Drops straight into the ai-router
 * fallback chain alongside the cloud providers.
 */
export class LocalLlmProvider implements LlmProvider {
  readonly id: string;
  readonly models: readonly string[];
  readonly capabilities: ProviderCapabilities;
  readonly residency: readonly Region[];
  readonly pricing: ProviderPricing = LOCAL_ZERO_PRICING;

  private readonly defaultModel: string;
  private readonly defaultEmbeddingModel: string;
  private readonly defaultMaxTokens: number | undefined;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(opts: LocalLlmProviderOptions = {}) {
    this.defaultModel = opts.defaultModel ?? DEFAULT_LOCAL_MODEL;
    this.defaultEmbeddingModel = opts.defaultEmbeddingModel ?? this.defaultModel;
    this.defaultMaxTokens = opts.defaultMaxTokens;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_LOCAL_BASE_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.id = opts.id ?? "local";
    this.models = opts.models ?? [this.defaultModel];
    this.residency = opts.residency ?? ALL_REGIONS;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...opts.capabilities };
    if (opts.maxContextTokens !== undefined) {
      this.capabilities = { ...this.capabilities, maxContextTokens: opts.maxContextTokens };
    }
  }

  async *complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    const built = buildLocalRequest(req, {
      defaultModel: this.defaultModel,
      defaultMaxTokens: this.defaultMaxTokens,
      stream: true,
    });
    let response;
    try {
      response = await this.fetchImpl(this.url("/chat/completions"), {
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
      throw new LocalProviderError({
        kind: "server_error",
        message: "local streaming response had no body",
        status: response.status,
      });
    }
    yield* readSseStream(response.body);
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = req.model ?? this.defaultEmbeddingModel;
    let response;
    try {
      response = await this.fetchImpl(this.url("/embeddings"), {
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
    let parsed: LocalEmbeddingApiResponse;
    try {
      parsed = JSON.parse(text) as LocalEmbeddingApiResponse;
    } catch (err) {
      throw new LocalProviderError({
        kind: "server_error",
        message: `failed to parse local embedding response: ${err instanceof Error ? err.message : String(err)}`,
        status: response.status,
      });
    }
    const ordered = [...parsed.data].sort((a, b) => a.index - b.index);
    const vectors = ordered.map((d) => [...d.embedding]);
    const dim = vectors[0]?.length ?? 0;
    if (dim === 0) {
      throw new LocalProviderError({
        kind: "server_error",
        message: "local embedding response contained no vectors",
        status: response.status,
      });
    }
    const usage: Usage = {
      inputTokens: parsed.usage?.prompt_tokens ?? 0,
      outputTokens: 0,
      cost: 0,
    };
    return { vectors, dim, model, usage };
  }

  async completeNonStreaming(req: CompletionRequest): Promise<LocalResponse> {
    const built = buildLocalRequest(req, {
      defaultModel: this.defaultModel,
      defaultMaxTokens: this.defaultMaxTokens,
      stream: false,
    });
    let response;
    try {
      response = await this.fetchImpl(this.url("/chat/completions"), {
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
      return JSON.parse(text) as LocalResponse;
    } catch (err) {
      throw new LocalProviderError({
        kind: "server_error",
        message: `failed to parse local response: ${err instanceof Error ? err.message : String(err)}`,
        status: response.status,
      });
    }
  }

  chunksFromTextStream(sse: string): readonly CompletionChunk[] {
    return [...chunksFromSse(sse)];
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private headers(_opts: { stream: boolean }): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey !== undefined && this.apiKey.length > 0) {
      headers["authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
}
