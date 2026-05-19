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

import {
  buildOpenAIChatRequest,
  extractTextFromResponse,
  extractToolCallsFromResponse,
  normalizeChatUsage,
  type OpenAIChatResponse,
} from "./chat-api.js";
import {
  buildEmbeddingsRequest,
  normalizeEmbeddingResponse,
  type OpenAIEmbeddingsResponse,
} from "./embeddings.js";
import { OpenAIError, fromHttpResponse, fromNetworkError } from "./errors.js";
import {
  buildMultipartUpload,
  isOpenAIFilesPurpose,
  type OpenAIFile,
  type OpenAIFileDeleteResponse,
  type OpenAIFileListResponse,
  type OpenAIFilesPurpose,
} from "./files-api.js";
import {
  OPENAI_DEFAULT_MODERATION_MODEL,
  buildModerationRequest,
  isOpenAIModerationModel,
  normalizeModerationResponse,
  type NormalizedModerationOutcome,
  type OpenAIModerationModel,
  type OpenAIModerationResponse,
} from "./moderations-api.js";
import {
  OPENAI_CHAT_PRICING,
  OPENAI_DEFAULT_CHAT_MODEL,
  OPENAI_DEFAULT_EMBEDDING_MODEL,
  isOpenAIChatModel,
  isOpenAIEmbeddingModel,
  isOpenAIModel,
  type OpenAIChatModel,
  type OpenAIEmbeddingModel,
} from "./pricing.js";
import {
  buildOpenAIResponsesRequest,
  extractReasoningSummary,
  extractTextFromResponsesResponse,
  extractToolCallsFromResponsesResponse,
  normalizeResponsesUsage,
  type OpenAIResponsesResponse,
  type ReasoningEffort,
} from "./responses-api.js";
import { readResponsesSseStream } from "./responses-streaming.js";
import { readSseStream } from "./streaming.js";

export const OPENAI_API_BASE_URL = "https://api.openai.com";

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string | Uint8Array;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  body: ReadableStream<Uint8Array> | null;
}>;

export type OpenAIApiPath = "chat" | "responses";

export interface OpenAIProviderOptions {
  readonly apiKey: string;
  readonly defaultChatModel?: OpenAIChatModel;
  readonly defaultEmbeddingModel?: OpenAIEmbeddingModel;
  readonly defaultModerationModel?: OpenAIModerationModel;
  readonly defaultMaxTokens?: number;
  readonly baseUrl?: string;
  readonly organization?: string;
  readonly project?: string;
  readonly residency?: readonly Region[];
  readonly fetch?: FetchLike;
  readonly defaultApiPath?: OpenAIApiPath;
  readonly reasoningEffort?: ReasoningEffort;
}

const PROVIDER_ID = "openai";

export class OpenAIProvider implements LlmProvider {
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
    vision: true,
  };
  readonly residency: readonly Region[];
  readonly pricing: ProviderPricing;

  private readonly apiKey: string;
  private readonly defaultChatModel: OpenAIChatModel;
  private readonly defaultEmbeddingModel: OpenAIEmbeddingModel;
  private readonly defaultModerationModel: OpenAIModerationModel;
  private readonly defaultMaxTokens: number | undefined;
  private readonly baseUrl: string;
  private readonly organization: string | undefined;
  private readonly project: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly defaultApiPath: OpenAIApiPath;
  private readonly reasoningEffort: ReasoningEffort | undefined;

  constructor(opts: OpenAIProviderOptions) {
    if (opts.apiKey.length === 0) {
      throw new Error("OpenAIProvider: apiKey is required");
    }
    const chatModel = opts.defaultChatModel ?? OPENAI_DEFAULT_CHAT_MODEL;
    if (!isOpenAIChatModel(chatModel)) {
      throw new Error(`OpenAIProvider: unsupported defaultChatModel ${chatModel}`);
    }
    const embedModel = opts.defaultEmbeddingModel ?? OPENAI_DEFAULT_EMBEDDING_MODEL;
    if (!isOpenAIEmbeddingModel(embedModel)) {
      throw new Error(`OpenAIProvider: unsupported defaultEmbeddingModel ${embedModel}`);
    }
    const moderationModel =
      opts.defaultModerationModel ?? OPENAI_DEFAULT_MODERATION_MODEL;
    if (!isOpenAIModerationModel(moderationModel)) {
      throw new Error(
        `OpenAIProvider: unsupported defaultModerationModel ${moderationModel}`,
      );
    }
    this.apiKey = opts.apiKey;
    this.defaultChatModel = chatModel;
    this.defaultEmbeddingModel = embedModel;
    this.defaultModerationModel = moderationModel;
    this.defaultMaxTokens = opts.defaultMaxTokens;
    this.baseUrl = opts.baseUrl ?? OPENAI_API_BASE_URL;
    this.organization = opts.organization;
    this.project = opts.project;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.defaultApiPath = opts.defaultApiPath ?? "chat";
    this.reasoningEffort = opts.reasoningEffort;
    this.models = [
      ...Object.keys(OPENAI_CHAT_PRICING),
      "text-embedding-3-small",
      "text-embedding-3-large",
    ];
    this.residency = opts.residency ?? ["us", "eu"];
    const p = OPENAI_CHAT_PRICING[this.defaultChatModel];
    this.pricing = {
      inputPerMillionTokens: p.inputUsdPerMillion,
      outputPerMillionTokens: p.outputUsdPerMillion,
      cachedInputPerMillionTokens: p.cachedInputUsdPerMillion,
    };
  }

  async *complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (this.defaultApiPath === "responses") {
      yield* this.completeViaResponses(req);
      return;
    }
    yield* this.completeViaChat(req);
  }

  async *completeViaChat(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    const model = this.resolveChatModel(req.model);
    const built = buildOpenAIChatRequest(req, {
      defaultModel: this.defaultChatModel,
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
      throw new OpenAIError({
        kind: "api_error",
        message: "OpenAI streaming response had no body",
        status: response.status,
      });
    }
    yield* readSseStream(response.body, model);
  }

  async *completeViaResponses(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    const model = this.resolveChatModel(req.model);
    const built = buildOpenAIResponsesRequest(req, {
      defaultModel: this.defaultChatModel,
      defaultMaxTokens: this.defaultMaxTokens,
      stream: true,
      reasoningEffort: this.reasoningEffort,
    });
    let response;
    try {
      response = await this.fetchImpl(this.url("/v1/responses"), {
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
      throw new OpenAIError({
        kind: "api_error",
        message: "OpenAI streaming response had no body",
        status: response.status,
      });
    }
    yield* readResponsesSseStream(response.body, model);
  }

  async respondNonStreaming(req: CompletionRequest): Promise<OpenAIResponsesResponse> {
    const built = buildOpenAIResponsesRequest(req, {
      defaultModel: this.defaultChatModel,
      defaultMaxTokens: this.defaultMaxTokens,
      stream: false,
      reasoningEffort: this.reasoningEffort,
    });
    let response;
    try {
      response = await this.fetchImpl(this.url("/v1/responses"), {
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
      return JSON.parse(text) as OpenAIResponsesResponse;
    } catch (err) {
      throw new OpenAIError({
        kind: "api_error",
        message: `failed to parse OpenAI responses response: ${err instanceof Error ? err.message : String(err)}`,
        status: response.status,
      });
    }
  }

  async completeNonStreaming(req: CompletionRequest): Promise<OpenAIChatResponse> {
    const built = buildOpenAIChatRequest(req, {
      defaultModel: this.defaultChatModel,
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
      return JSON.parse(text) as OpenAIChatResponse;
    } catch (err) {
      throw new OpenAIError({
        kind: "api_error",
        message: `failed to parse OpenAI response: ${err instanceof Error ? err.message : String(err)}`,
        status: response.status,
      });
    }
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = this.resolveEmbeddingModel(req.model);
    const built = buildEmbeddingsRequest({ texts: req.texts, model });
    let response;
    try {
      response = await this.fetchImpl(this.url("/v1/embeddings"), {
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
    let raw: OpenAIEmbeddingsResponse;
    try {
      raw = JSON.parse(text) as OpenAIEmbeddingsResponse;
    } catch (err) {
      throw new OpenAIError({
        kind: "api_error",
        message: `failed to parse OpenAI embeddings response: ${err instanceof Error ? err.message : String(err)}`,
        status: response.status,
      });
    }
    return normalizeEmbeddingResponse(model, raw);
  }

  async moderate(input: {
    readonly input: string | readonly string[];
    readonly model?: OpenAIModerationModel;
  }): Promise<NormalizedModerationOutcome> {
    const model = this.resolveModerationModel(input.model);
    const built = buildModerationRequest({
      input: input.input,
      model,
      defaultModel: this.defaultModerationModel,
    });
    let response;
    try {
      response = await this.fetchImpl(this.url("/v1/moderations"), {
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
    let raw: OpenAIModerationResponse;
    try {
      raw = JSON.parse(text) as OpenAIModerationResponse;
    } catch (err) {
      throw new OpenAIError({
        kind: "api_error",
        message: `failed to parse OpenAI moderation response: ${err instanceof Error ? err.message : String(err)}`,
        status: response.status,
      });
    }
    return normalizeModerationResponse(raw);
  }

  private resolveModerationModel(
    requested: OpenAIModerationModel | undefined,
  ): OpenAIModerationModel {
    if (requested === undefined) return this.defaultModerationModel;
    if (!isOpenAIModerationModel(requested)) {
      throw new OpenAIError({
        kind: "invalid_request_error",
        message: `model '${requested}' is not a known OpenAI moderation model`,
      });
    }
    return requested;
  }

  async uploadFile(input: {
    readonly bytes: Uint8Array;
    readonly filename: string;
    readonly purpose: OpenAIFilesPurpose;
    readonly contentType?: string;
  }): Promise<OpenAIFile> {
    if (!isOpenAIFilesPurpose(input.purpose)) {
      throw new OpenAIError({
        kind: "invalid_request_error",
        message: `uploadFile: invalid purpose '${input.purpose}'`,
      });
    }
    const multipart = buildMultipartUpload({
      bytes: input.bytes,
      filename: input.filename,
      purpose: input.purpose,
      ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
    });
    let response;
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": multipart.contentType,
      };
      if (this.organization !== undefined) headers["openai-organization"] = this.organization;
      if (this.project !== undefined) headers["openai-project"] = this.project;
      response = await this.fetchImpl(this.url("/v1/files"), {
        method: "POST",
        headers,
        body: multipart.body,
      });
    } catch (err) {
      throw fromNetworkError(err);
    }
    if (!response.ok) {
      throw fromHttpResponse({ status: response.status, body: await response.text() });
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as OpenAIFile;
    } catch (err) {
      throw new OpenAIError({
        kind: "api_error",
        message: `failed to parse OpenAI file upload response: ${err instanceof Error ? err.message : String(err)}`,
        status: response.status,
      });
    }
  }

  async retrieveFile(fileId: string): Promise<OpenAIFile> {
    if (fileId.length === 0) {
      throw new OpenAIError({
        kind: "invalid_request_error",
        message: "retrieveFile: fileId is required",
      });
    }
    let response;
    try {
      response = await this.fetchImpl(
        this.url(`/v1/files/${encodeURIComponent(fileId)}`),
        {
          method: "GET",
          headers: this.headers({ stream: false }),
          body: "",
        },
      );
    } catch (err) {
      throw fromNetworkError(err);
    }
    if (!response.ok) {
      throw fromHttpResponse({ status: response.status, body: await response.text() });
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as OpenAIFile;
    } catch (err) {
      throw new OpenAIError({
        kind: "api_error",
        message: `failed to parse OpenAI file retrieve response: ${err instanceof Error ? err.message : String(err)}`,
        status: response.status,
      });
    }
  }

  async deleteFile(fileId: string): Promise<OpenAIFileDeleteResponse> {
    if (fileId.length === 0) {
      throw new OpenAIError({
        kind: "invalid_request_error",
        message: "deleteFile: fileId is required",
      });
    }
    let response;
    try {
      response = await this.fetchImpl(
        this.url(`/v1/files/${encodeURIComponent(fileId)}`),
        {
          method: "DELETE",
          headers: this.headers({ stream: false }),
          body: "",
        },
      );
    } catch (err) {
      throw fromNetworkError(err);
    }
    if (!response.ok) {
      throw fromHttpResponse({ status: response.status, body: await response.text() });
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as OpenAIFileDeleteResponse;
    } catch (err) {
      throw new OpenAIError({
        kind: "api_error",
        message: `failed to parse OpenAI file delete response: ${err instanceof Error ? err.message : String(err)}`,
        status: response.status,
      });
    }
  }

  async listFiles(options: {
    readonly purpose?: OpenAIFilesPurpose;
    readonly limit?: number;
    readonly order?: "asc" | "desc";
    readonly after?: string;
  } = {}): Promise<OpenAIFileListResponse> {
    if (options.purpose !== undefined && !isOpenAIFilesPurpose(options.purpose)) {
      throw new OpenAIError({
        kind: "invalid_request_error",
        message: `listFiles: invalid purpose '${options.purpose}'`,
      });
    }
    if (
      options.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10_000)
    ) {
      throw new OpenAIError({
        kind: "invalid_request_error",
        message: "listFiles: limit must be an integer in [1, 10000]",
      });
    }
    const params = new URLSearchParams();
    if (options.purpose !== undefined) params.set("purpose", options.purpose);
    if (options.limit !== undefined) params.set("limit", options.limit.toString());
    if (options.order !== undefined) params.set("order", options.order);
    if (options.after !== undefined) params.set("after", options.after);
    const query = params.toString();
    const path = query.length > 0 ? `/v1/files?${query}` : "/v1/files";
    let response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method: "GET",
        headers: this.headers({ stream: false }),
        body: "",
      });
    } catch (err) {
      throw fromNetworkError(err);
    }
    if (!response.ok) {
      throw fromHttpResponse({ status: response.status, body: await response.text() });
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as OpenAIFileListResponse;
    } catch (err) {
      throw new OpenAIError({
        kind: "api_error",
        message: `failed to parse OpenAI file list response: ${err instanceof Error ? err.message : String(err)}`,
        status: response.status,
      });
    }
  }

  private resolveChatModel(requested: string | undefined): OpenAIChatModel {
    if (requested === undefined) return this.defaultChatModel;
    if (!isOpenAIModel(requested)) {
      throw new OpenAIError({
        kind: "invalid_request_error",
        message: `OpenAI provider does not support model: ${requested}`,
      });
    }
    if (!isOpenAIChatModel(requested)) {
      throw new OpenAIError({
        kind: "invalid_request_error",
        message: `model ${requested} is not a chat model — use embed() instead`,
      });
    }
    return requested;
  }

  private resolveEmbeddingModel(requested: string | undefined): OpenAIEmbeddingModel {
    if (requested === undefined) return this.defaultEmbeddingModel;
    if (!isOpenAIModel(requested)) {
      throw new OpenAIError({
        kind: "invalid_request_error",
        message: `OpenAI provider does not support model: ${requested}`,
      });
    }
    if (!isOpenAIEmbeddingModel(requested)) {
      throw new OpenAIError({
        kind: "invalid_request_error",
        message: `model ${requested} is not an embedding model — use complete() instead`,
      });
    }
    return requested;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private headers(opts: { stream: boolean }): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };
    if (this.organization !== undefined) {
      headers["openai-organization"] = this.organization;
    }
    if (this.project !== undefined) {
      headers["openai-project"] = this.project;
    }
    headers["accept"] = opts.stream ? "text/event-stream" : "application/json";
    return headers;
  }
}

export function summarizeChatResponse(response: OpenAIChatResponse, model: OpenAIChatModel) {
  return {
    text: extractTextFromResponse(response),
    toolCalls: extractToolCallsFromResponse(response),
    finishReason: response.choices[0]?.finish_reason ?? null,
    usage: normalizeChatUsage(model, response.usage),
  };
}

export function summarizeResponsesResponse(
  response: OpenAIResponsesResponse,
  model: OpenAIChatModel,
) {
  return {
    text: extractTextFromResponsesResponse(response),
    toolCalls: extractToolCallsFromResponsesResponse(response),
    reasoningSummary: extractReasoningSummary(response),
    status: response.status,
    usage: normalizeResponsesUsage(model, response.usage),
  };
}
