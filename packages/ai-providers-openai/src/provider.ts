import {
  ProviderInactivityTimeout,
  resolveInactivityTimeoutMs,
  startInactivityWatchdog,
  tenantPseudonymForWire,
  type InactivityWatchdog,
} from "@crossengin/ai-providers";
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
  openAiPricingFor,
  type OpenAiChatModel,
  type OpenAiEmbeddingModel,
  type OpenAiModel,
  type OpenAiModelPricing,
} from "./pricing.js";
import { chunksFromSse, readSseStream } from "./streaming.js";

export const OPENAI_API_BASE_URL = "https://api.openai.com";
export const DEFAULT_EMBEDDING_MODEL: OpenAiEmbeddingModel = "text-embedding-3-small";

/** A chat model id: one of OpenAI's own, or any id an OpenAI-compatible
 * endpoint serves. The union keeps literal-type ergonomics for the former. */
export type OpenAiChatModelId = OpenAiChatModel | (string & {});
export type OpenAiEmbeddingModelId = OpenAiEmbeddingModel | (string & {});

const UNKNOWN_MODEL_PRICING: OpenAiModelPricing = {
  inputUsdPerMillion: 0,
  cachedInputUsdPerMillion: 0,
  outputUsdPerMillion: 0,
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").toLowerCase();
}

/** INVARIANT: OpenAI's model catalogue describes `api.openai.com`. Point the
 * client anywhere else — a different engine (Ollama serving `qwen2.5:14b`) or a
 * proxy in front of OpenAI (OpenRouter serving `anthropic/claude-3.5-sonnet`) —
 * and that catalogue is no longer authoritative, so it must not gate model ids. */
function isCustomBaseUrl(baseUrl: string): boolean {
  return normalizeBaseUrl(baseUrl) !== normalizeBaseUrl(OPENAI_API_BASE_URL);
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; body: ReadableStream<Uint8Array> | null }>;

export interface OpenAiProviderOptions {
  readonly apiKey: string;
  readonly defaultModel: OpenAiChatModelId;
  readonly defaultEmbeddingModel?: OpenAiEmbeddingModelId;
  readonly defaultMaxTokens?: number;
  readonly baseUrl?: string;
  readonly organization?: string;
  readonly project?: string;
  readonly residency?: readonly Region[];
  readonly fetch?: FetchLike;
  /** Abort a call the endpoint sends nothing for this long (`startInactivityWatchdog`). */
  readonly inactivityTimeoutMs?: number;
  /**
   * The price of the default chat model, in place of the catalogue's. The only way an
   * OpenAI-compatible endpoint's model is charged anything at all: the catalogue describes
   * `api.openai.com`, so without a declaration such a model costs 0.
   */
  readonly pricingOverride?: OpenAiModelPricing;
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
  private readonly defaultModel: string;
  private readonly defaultEmbeddingModel: string;
  private readonly defaultMaxTokens: number | undefined;
  private readonly baseUrl: string;
  private readonly customBaseUrl: boolean;
  private readonly organization: string | undefined;
  private readonly project: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly inactivityTimeoutMs: number;
  private readonly pricingOverride: OpenAiModelPricing | undefined;

  constructor(opts: OpenAiProviderOptions) {
    if (opts.apiKey.length === 0) {
      throw new Error("OpenAiProvider: apiKey is required");
    }
    this.baseUrl = opts.baseUrl ?? OPENAI_API_BASE_URL;
    this.customBaseUrl = isCustomBaseUrl(this.baseUrl);
    if (
      opts.defaultModel.length === 0 ||
      (!this.customBaseUrl && !isOpenAiChatModel(opts.defaultModel))
    ) {
      throw new Error(`OpenAiProvider: unsupported defaultModel ${opts.defaultModel}`);
    }
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel;
    this.defaultEmbeddingModel = opts.defaultEmbeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    this.defaultMaxTokens = opts.defaultMaxTokens;
    this.organization = opts.organization;
    this.project = opts.project;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.inactivityTimeoutMs = resolveInactivityTimeoutMs(opts.inactivityTimeoutMs);
    this.pricingOverride = opts.pricingOverride;
    const catalogue = Object.keys(OPENAI_PRICING);
    this.models = catalogue.includes(this.defaultModel)
      ? catalogue
      : [this.defaultModel, ...catalogue];
    this.residency = opts.residency ?? ["us", "eu"];
    const defaultPricing =
      opts.pricingOverride ?? openAiPricingFor(this.defaultModel) ?? UNKNOWN_MODEL_PRICING;
    this.pricing = {
      inputPerMillionTokens: defaultPricing.inputUsdPerMillion,
      outputPerMillionTokens: defaultPricing.outputUsdPerMillion,
      cachedInputPerMillionTokens: defaultPricing.cachedInputUsdPerMillion,
    };
  }

  /** The effective API host (no path). Defaults to the public OpenAI API; an
   * OpenAI-compatible endpoint (Azure OpenAI, a gateway, or a self-hosted OSS
   * server) can be substituted via `baseUrl`. The `/v1/...` path is appended. */
  get endpoint(): string {
    return this.baseUrl;
  }

  async *complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    const model = this.resolveModel(req.model);
    const built = buildOpenAiRequest(req, {
      defaultModel: this.defaultModel,
      defaultMaxTokens: this.defaultMaxTokens,
      stream: true,
    });
    const watchdog = startInactivityWatchdog(this.inactivityTimeoutMs);
    try {
      const response = await this.send(watchdog, "/v1/chat/completions", built, true);
      if (response.body === null) {
        throw new OpenAiError({
          kind: "server_error",
          message: "OpenAI streaming response had no body",
          status: response.status,
        });
      }
      // The stream reader only carries the model id into `computeUsageCost`, which
      // is total over arbitrary ids, so a non-catalogue id is safe here.
      yield* readSseStream(watchdog.watch(response.body), model as OpenAiModel, this.pricingFor(model));
    } catch (err) {
      throw asTimeout(err);
    } finally {
      watchdog.dispose();
    }
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = this.resolveEmbeddingModel(req.model);
    // The embedding body carries the pseudonym under the same rule as the chat one (ADR-0456).
    const pseudonym = tenantPseudonymForWire(req);
    const { response, text } = await this.sendForText("/v1/embeddings", {
      model,
      input: req.texts,
      ...(pseudonym !== undefined ? { user: pseudonym } : {}),
    });
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
    const dim =
      vectors[0]?.length ??
      (isOpenAiEmbeddingModel(model) ? OPENAI_EMBEDDING_DIMENSIONS[model] : 0);
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
    const { response, text } = await this.sendForText("/v1/chat/completions", built);
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

  chunksFromTextStream(sse: string, model?: OpenAiChatModelId): readonly CompletionChunk[] {
    return [...chunksFromSse(sse, (model ?? this.defaultModel) as OpenAiModel)];
  }

  private resolveModel(requested: string | undefined): string {
    if (requested === undefined) return this.defaultModel;
    if (requested.length === 0 || (!this.customBaseUrl && !isOpenAiChatModel(requested))) {
      throw new OpenAiError({
        kind: "invalid_request_error",
        message: `OpenAI provider does not support chat model: ${requested}`,
      });
    }
    return requested;
  }

  private resolveEmbeddingModel(requested: string | undefined): string {
    if (requested === undefined) return this.defaultEmbeddingModel;
    if (requested.length === 0 || (!this.customBaseUrl && !isOpenAiEmbeddingModel(requested))) {
      throw new OpenAiError({
        kind: "invalid_request_error",
        message: `OpenAI provider does not support embedding model: ${requested}`,
      });
    }
    return requested;
  }

  /** The declared price applies to the model it was declared for — the default — and no other. */
  private pricingFor(model: string): OpenAiModelPricing | undefined {
    return model === this.defaultModel ? this.pricingOverride : undefined;
  }

  /** POST under `watchdog`; a non-2xx is thrown as an `OpenAiError`. */
  private async send(
    watchdog: InactivityWatchdog,
    path: string,
    body: unknown,
    stream: boolean,
  ): ReturnType<FetchLike> {
    let response;
    try {
      response = await watchdog.guard(
        this.fetchImpl(this.url(path), {
          method: "POST",
          headers: this.headers({ stream }),
          body: JSON.stringify(body),
          signal: watchdog.signal,
        }),
      );
    } catch (err) {
      if (err instanceof ProviderInactivityTimeout) throw err;
      throw fromNetworkError(err);
    }
    if (!response.ok) {
      throw fromHttpResponse({ status: response.status, body: await watchdog.guard(response.text()) });
    }
    return response;
  }

  private async sendForText(
    path: string,
    body: unknown,
  ): Promise<{ response: Awaited<ReturnType<FetchLike>>; text: string }> {
    const watchdog = startInactivityWatchdog(this.inactivityTimeoutMs);
    try {
      const response = await this.send(watchdog, path, body, false);
      return { response, text: await watchdog.guard(response.text()) };
    } catch (err) {
      throw asTimeout(err);
    } finally {
      watchdog.dispose();
    }
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

function asTimeout(err: unknown): unknown {
  return err instanceof ProviderInactivityTimeout
    ? new OpenAiError({ kind: "timeout_error", message: err.message })
    : err;
}

export function summarizeResponse(response: OpenAiResponse, model: OpenAiChatModel) {
  return {
    text: extractText(response),
    toolCalls: extractToolCalls(response),
    finishReason: response.choices[0]?.finish_reason ?? null,
    usage: normalizeUsage(model, response.usage),
  };
}
