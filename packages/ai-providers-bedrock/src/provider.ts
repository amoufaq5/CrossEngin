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
  buildBatchListQuery,
  buildCreateBatchBody,
  isBedrockBatchJobIdentifier,
  parseBatchJobDetail,
  parseBatchListResponse,
  parseCreateBatchResponse,
  type BedrockBatchJobDetail,
  type BedrockBatchJobListResponse,
  type BedrockCreateBatchInput,
  type BedrockCreateBatchResponse,
  type BedrockListBatchesOptions,
} from "./batch-api.js";
import {
  buildBedrockConverseRequest,
  extractTextFromConverseResponse,
  extractToolCallsFromConverseResponse,
  normalizeConverseUsage,
  type BedrockConverseResponse,
} from "./converse-api.js";
import {
  buildCustomModelListQuery,
  parseCustomModelDetail,
  parseCustomModelListResponse,
  type BedrockCustomModelDetail,
  type BedrockCustomModelListResponse,
  type BedrockListCustomModelsOptions,
} from "./custom-models-api.js";
import {
  bedrockEmbeddingFamily,
  buildCohereEmbedRequest,
  buildEmbeddingResponse,
  buildTitanEmbedRequest,
  buildTitanMultimodalRequest,
  parseCohereEmbedResponse,
  parseTitanEmbedResponse,
  parseTitanMultimodalResponse,
  type CohereEmbedInputType,
  type EmbeddingAggregation,
  type MultimodalEmbeddingResult,
} from "./embeddings.js";
import { BedrockError, fromHttpResponse, fromNetworkError } from "./errors.js";
import { readConverseEventStream } from "./event-stream.js";
import { buildBedrockGuardrailConfig, type BedrockGuardrailConfig } from "./guardrails.js";
import {
  buildGuardrailListQuery,
  parseGuardrailDetail,
  parseGuardrailListResponse,
  type BedrockGuardrailDetail,
  type BedrockGuardrailListResponse,
  type BedrockListGuardrailsOptions,
} from "./guardrails-api.js";
import {
  buildImportedModelListQuery,
  parseImportedModelDetail,
  parseImportedModelListResponse,
  type BedrockImportedModelDetail,
  type BedrockImportedModelListResponse,
  type BedrockListImportedModelsOptions,
} from "./imported-models-api.js";
import {
  buildCreateInferenceProfileBody,
  buildInferenceProfileListQuery,
  buildUpdateInferenceProfileBody,
  parseCreateInferenceProfileResponse,
  parseInferenceProfileDetail,
  parseInferenceProfileListResponse,
  type BedrockCreateInferenceProfileInput,
  type BedrockCreateInferenceProfileResponse,
  type BedrockInferenceProfileDetail,
  type BedrockInferenceProfileListResponse,
  type BedrockListInferenceProfilesOptions,
  type BedrockUpdateInferenceProfileInput,
} from "./inference-profiles-api.js";
import {
  buildCreateModelCustomizationJobBody,
  buildModelCustomizationJobListQuery,
  parseCreateModelCustomizationJobResponse,
  parseModelCustomizationJobDetail,
  parseModelCustomizationJobListResponse,
  type BedrockCreateModelCustomizationJobInput,
  type BedrockCreateModelCustomizationJobResponse,
  type BedrockModelCustomizationJobDetail,
  type BedrockModelCustomizationJobListResponse,
  type BedrockListModelCustomizationJobsOptions,
} from "./model-customization-jobs-api.js";
import {
  buildModelImportJobListQuery,
  parseModelImportJobDetail,
  parseModelImportJobListResponse,
  type BedrockModelImportJobDetail,
  type BedrockModelImportJobListResponse,
  type BedrockListModelImportJobsOptions,
} from "./model-import-jobs-api.js";
import {
  BEDROCK_CHAT_MODELS,
  BEDROCK_CHAT_PRICING,
  BEDROCK_DEFAULT_EMBEDDING_MODEL,
  BEDROCK_EMBEDDING_MODELS,
  BEDROCK_MULTIMODAL_EMBEDDING_MODELS,
  buildBedrockMultimodalEmbeddingUsage,
  isBedrockChatModel,
  isBedrockEmbeddingModel,
  isBedrockMultimodalEmbeddingModel,
  type BedrockChatModel,
  type BedrockEmbeddingModel,
  type BedrockMultimodalEmbeddingModel,
} from "./pricing.js";
import {
  buildFoundationModelListQuery,
  parseFoundationModelDetail,
  parseFoundationModelListResponse,
  type BedrockFoundationModelDetail,
  type BedrockFoundationModelListResponse,
  type BedrockListFoundationModelsOptions,
} from "./foundation-models-api.js";
import {
  buildCreateProvisionedModelThroughputBody,
  buildProvisionedThroughputListQuery,
  buildUpdateProvisionedModelThroughputBody,
  parseCreateProvisionedModelThroughputResponse,
  parseProvisionedModelDetail,
  parseProvisionedModelListResponse,
  type BedrockCreateProvisionedModelThroughputInput,
  type BedrockCreateProvisionedModelThroughputResponse,
  type BedrockListProvisionedModelThroughputsOptions,
  type BedrockProvisionedModelDetail,
  type BedrockProvisionedModelListResponse,
  type BedrockUpdateProvisionedModelThroughputInput,
} from "./provisioned-throughput-api.js";
import { signRequest, type AwsCredentials } from "./signing.js";
import {
  buildListTagsForResourceBody,
  buildTagResourceBody,
  buildTagResourceQuery,
  buildUntagResourceBody,
  buildUntagResourceQuery,
  parseListTagsForResourceResponse,
  type BedrockListTagsForResourceInput,
  type BedrockListTagsForResourceResponse,
  type BedrockTagResourceInput,
  type BedrockUntagResourceInput,
} from "./tagging-api.js";

export const BEDROCK_DEFAULT_REGION = "us-east-1";
export const BEDROCK_DEFAULT_MODEL: BedrockChatModel = "anthropic.claude-3-5-sonnet-20241022-v2:0";

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: Uint8Array;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  body: ReadableStream<Uint8Array> | null;
}>;

export interface BedrockProviderOptions {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly region?: string;
  readonly defaultModel?: BedrockChatModel;
  readonly defaultEmbeddingModel?: BedrockEmbeddingModel;
  readonly defaultMaxTokens?: number;
  readonly defaultEmbeddingDimensions?: number;
  readonly defaultCohereInputType?: CohereEmbedInputType;
  readonly titanConcurrency?: number;
  readonly guardrailConfig?: BedrockGuardrailConfig;
  readonly baseUrl?: string;
  readonly controlPlaneBaseUrl?: string;
  readonly residency?: readonly Region[];
  readonly fetch?: FetchLike;
  readonly clock?: () => Date;
}

export const DEFAULT_TITAN_CONCURRENCY = 4;
export const MAX_TITAN_CONCURRENCY = 100;

const PROVIDER_ID = "bedrock";
const SERVICE = "bedrock";

export class BedrockProvider implements LlmProvider {
  readonly id = PROVIDER_ID;
  readonly models: readonly string[] = [
    ...BEDROCK_CHAT_MODELS,
    ...BEDROCK_EMBEDDING_MODELS,
    ...BEDROCK_MULTIMODAL_EMBEDDING_MODELS,
  ];
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    toolUse: true,
    jsonMode: false,
    embedding: true,
    maxContextTokens: 200_000,
    supportsThinking: false,
    vision: true,
  };
  readonly residency: readonly Region[];
  readonly pricing: ProviderPricing;

  private readonly credentials: AwsCredentials;
  private readonly region: string;
  private readonly defaultModel: BedrockChatModel;
  private readonly defaultEmbeddingModel: BedrockEmbeddingModel;
  private readonly defaultMaxTokens: number | undefined;
  private readonly defaultEmbeddingDimensions: number | undefined;
  private readonly defaultCohereInputType: CohereEmbedInputType | undefined;
  private readonly titanConcurrency: number;
  private readonly guardrailConfig: BedrockGuardrailConfig | undefined;
  private readonly baseUrl: string;
  private readonly controlPlaneBaseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly clock: () => Date;

  constructor(opts: BedrockProviderOptions) {
    if (opts.accessKeyId.length === 0) {
      throw new Error("BedrockProvider: accessKeyId is required");
    }
    if (opts.secretAccessKey.length === 0) {
      throw new Error("BedrockProvider: secretAccessKey is required");
    }
    const model = opts.defaultModel ?? BEDROCK_DEFAULT_MODEL;
    if (!isBedrockChatModel(model)) {
      throw new Error(`BedrockProvider: unsupported defaultModel ${model}`);
    }
    const embedModel = opts.defaultEmbeddingModel ?? BEDROCK_DEFAULT_EMBEDDING_MODEL;
    if (!isBedrockEmbeddingModel(embedModel)) {
      throw new Error(`BedrockProvider: unsupported defaultEmbeddingModel ${embedModel}`);
    }
    this.credentials = {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      ...(opts.sessionToken !== undefined ? { sessionToken: opts.sessionToken } : {}),
    };
    this.region = opts.region ?? BEDROCK_DEFAULT_REGION;
    this.defaultModel = model;
    this.defaultEmbeddingModel = embedModel;
    this.defaultMaxTokens = opts.defaultMaxTokens;
    this.defaultEmbeddingDimensions = opts.defaultEmbeddingDimensions;
    this.defaultCohereInputType = opts.defaultCohereInputType;
    const concurrency = opts.titanConcurrency ?? DEFAULT_TITAN_CONCURRENCY;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_TITAN_CONCURRENCY) {
      throw new Error(
        `BedrockProvider: titanConcurrency must be an integer in [1, ${MAX_TITAN_CONCURRENCY.toString()}], got ${concurrency.toString()}`,
      );
    }
    this.titanConcurrency = concurrency;
    this.guardrailConfig =
      opts.guardrailConfig !== undefined
        ? buildBedrockGuardrailConfig(opts.guardrailConfig)
        : undefined;
    this.baseUrl = opts.baseUrl ?? `https://bedrock-runtime.${this.region}.amazonaws.com`;
    this.controlPlaneBaseUrl =
      opts.controlPlaneBaseUrl ?? `https://bedrock.${this.region}.amazonaws.com`;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.clock = opts.clock ?? (() => new Date());
    this.residency = opts.residency ?? deriveDefaultResidency(this.region);
    const p = BEDROCK_CHAT_PRICING[this.defaultModel];
    this.pricing = {
      inputPerMillionTokens: p.inputUsdPerMillion,
      outputPerMillionTokens: p.outputUsdPerMillion,
      ...(p.cachedInputUsdPerMillion !== undefined
        ? { cachedInputPerMillionTokens: p.cachedInputUsdPerMillion }
        : {}),
    };
  }

  async *complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    yield* this.completeInternal(req, this.guardrailConfig);
  }

  async *completeWithGuardrail(
    req: CompletionRequest,
    guardrailOverride?: BedrockGuardrailConfig | null,
  ): AsyncIterable<CompletionChunk> {
    yield* this.completeInternal(req, this.resolveGuardrailOverride(guardrailOverride));
  }

  private async *completeInternal(
    req: CompletionRequest,
    effectiveGuardrail: BedrockGuardrailConfig | undefined,
  ): AsyncIterable<CompletionChunk> {
    const model = this.resolveModel(req.model);
    const built = buildBedrockConverseRequest(req, {
      defaultMaxTokens: this.defaultMaxTokens,
      ...(effectiveGuardrail !== undefined ? { guardrailConfig: effectiveGuardrail } : {}),
    });
    const body = new TextEncoder().encode(JSON.stringify(built));
    const url = `${this.baseUrl}/model/${encodeURIComponent(model)}/converse-stream`;
    const response = await this.signedFetch({
      url,
      path: `/model/${encodeURIComponent(model)}/converse-stream`,
      body,
      accept: "application/vnd.amazon.eventstream",
    });
    if (response.body === null) {
      throw new BedrockError({
        kind: "api_error",
        message: "bedrock converse-stream returned empty body",
      });
    }
    yield* readConverseEventStream(response.body, { model });
  }

  async completeNonStreaming(req: CompletionRequest): Promise<BedrockConverseResponse> {
    return this.completeNonStreamingInternal(req, this.guardrailConfig);
  }

  async completeNonStreamingWithGuardrail(
    req: CompletionRequest,
    guardrailOverride?: BedrockGuardrailConfig | null,
  ): Promise<BedrockConverseResponse> {
    return this.completeNonStreamingInternal(req, this.resolveGuardrailOverride(guardrailOverride));
  }

  private async completeNonStreamingInternal(
    req: CompletionRequest,
    effectiveGuardrail: BedrockGuardrailConfig | undefined,
  ): Promise<BedrockConverseResponse> {
    const model = this.resolveModel(req.model);
    const built = buildBedrockConverseRequest(req, {
      defaultMaxTokens: this.defaultMaxTokens,
      ...(effectiveGuardrail !== undefined ? { guardrailConfig: effectiveGuardrail } : {}),
    });
    const body = new TextEncoder().encode(JSON.stringify(built));
    const url = `${this.baseUrl}/model/${encodeURIComponent(model)}/converse`;
    const response = await this.signedFetch({
      url,
      path: `/model/${encodeURIComponent(model)}/converse`,
      body,
      accept: "application/json",
    });
    const text = await response.text();
    try {
      return JSON.parse(text) as BedrockConverseResponse;
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `failed to parse bedrock converse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
  }

  private resolveGuardrailOverride(
    override: BedrockGuardrailConfig | null | undefined,
  ): BedrockGuardrailConfig | undefined {
    if (override === null) return undefined;
    if (override !== undefined) return buildBedrockGuardrailConfig(override);
    return this.guardrailConfig;
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = this.resolveEmbeddingModel(req.model);
    if (req.texts.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "embed: at least one text is required",
      });
    }
    const family = bedrockEmbeddingFamily(model);
    let aggregation: EmbeddingAggregation;
    if (family === "titan") {
      aggregation = await this.embedViaTitan(model, req.texts);
    } else {
      aggregation = await this.embedViaCohere(model, req.texts);
    }
    return buildEmbeddingResponse({ model, aggregation });
  }

  private async embedViaTitan(
    model: BedrockEmbeddingModel,
    texts: readonly string[],
  ): Promise<EmbeddingAggregation> {
    const callOne = async (
      text: string,
    ): Promise<{
      embedding: readonly number[];
      tokens: number;
    }> => {
      const body = buildTitanEmbedRequest({
        model,
        text,
        ...(this.defaultEmbeddingDimensions !== undefined
          ? { dimensions: this.defaultEmbeddingDimensions }
          : {}),
      });
      const raw = await this.invokeModelJson(model, body);
      const parsed = parseTitanEmbedResponse(raw);
      return { embedding: parsed.embedding, tokens: parsed.inputTextTokenCount };
    };
    const results = new Array<{
      embedding: readonly number[];
      tokens: number;
    }>(texts.length);
    for (let start = 0; start < texts.length; start += this.titanConcurrency) {
      const end = Math.min(start + this.titanConcurrency, texts.length);
      const chunk = await Promise.all(texts.slice(start, end).map((t) => callOne(t)));
      for (let i = 0; i < chunk.length; i++) {
        results[start + i] = chunk[i]!;
      }
    }
    let totalTokens = 0;
    let dim = 0;
    const vectors: number[][] = [];
    for (const r of results) {
      vectors.push([...r.embedding]);
      totalTokens += r.tokens;
      if (dim === 0) dim = r.embedding.length;
    }
    return { vectors, dim, inputTokens: totalTokens };
  }

  private async embedViaCohere(
    model: BedrockEmbeddingModel,
    texts: readonly string[],
  ): Promise<EmbeddingAggregation> {
    const body = buildCohereEmbedRequest({
      texts,
      ...(this.defaultCohereInputType !== undefined
        ? { inputType: this.defaultCohereInputType }
        : {}),
    });
    const raw = await this.invokeModelJson(model, body);
    const parsed = parseCohereEmbedResponse(raw);
    const vectors = parsed.embeddings.map((v) => [...v]);
    const dim = vectors[0]?.length ?? 0;
    const reported = parsed.meta?.billed_units?.input_tokens;
    const inputTokens =
      typeof reported === "number" && reported > 0 ? reported : approximateCohereTokens(texts);
    return { vectors, dim, inputTokens };
  }

  private async invokeModelJson(
    model: BedrockEmbeddingModel | BedrockMultimodalEmbeddingModel,
    requestBody: unknown,
  ): Promise<unknown> {
    const body = new TextEncoder().encode(JSON.stringify(requestBody));
    const path = `/model/${encodeURIComponent(model)}/invoke`;
    const response = await this.signedFetch({
      url: `${this.baseUrl}${path}`,
      path,
      body,
      accept: "application/json",
    });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `failed to parse bedrock invoke response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
  }

  extractText(response: BedrockConverseResponse): string {
    return extractTextFromConverseResponse(response);
  }

  extractToolCalls(
    response: BedrockConverseResponse,
  ): ReadonlyArray<{ id: string; name: string; input: unknown }> {
    return extractToolCallsFromConverseResponse(response);
  }

  normalizeUsage(model: BedrockChatModel, response: BedrockConverseResponse) {
    return normalizeConverseUsage(model, response.usage);
  }

  private resolveModel(requested: string | undefined): BedrockChatModel {
    if (requested === undefined) return this.defaultModel;
    if (!isBedrockChatModel(requested)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `model '${requested}' is not a known Bedrock chat model`,
      });
    }
    return requested;
  }

  private resolveEmbeddingModel(requested: string | undefined): BedrockEmbeddingModel {
    if (requested === undefined) return this.defaultEmbeddingModel;
    if (isBedrockMultimodalEmbeddingModel(requested)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `model '${requested}' is a multimodal embedding model — call embedMultimodal() instead`,
      });
    }
    if (!isBedrockEmbeddingModel(requested)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `model '${requested}' is not a known Bedrock embedding model`,
      });
    }
    return requested;
  }

  async embedMultimodal(input: {
    readonly model?: BedrockMultimodalEmbeddingModel;
    readonly text?: string;
    readonly imageBase64?: string;
    readonly dimensions?: number;
  }): Promise<MultimodalEmbeddingResult> {
    const model = input.model ?? "amazon.titan-embed-image-v1";
    if (!isBedrockMultimodalEmbeddingModel(model)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `embedMultimodal: model '${model}' is not a known Bedrock multimodal embedding model`,
      });
    }
    const body = buildTitanMultimodalRequest({
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.imageBase64 !== undefined ? { imageBase64: input.imageBase64 } : {}),
      ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {}),
    });
    const raw = await this.invokeModelJson(model, body);
    const parsed = parseTitanMultimodalResponse(raw);
    if (parsed.message !== null && parsed.message.length > 0) {
      throw new BedrockError({
        kind: "model_stream_error",
        message: `titan multimodal embed returned message: ${parsed.message.slice(0, 480)}`,
      });
    }
    const imageCount =
      typeof input.imageBase64 === "string" && input.imageBase64.length > 0 ? 1 : 0;
    const usage = buildBedrockMultimodalEmbeddingUsage(model, {
      textInputTokens: parsed.inputTextTokenCount,
      imageCount,
    });
    return {
      vector: [...parsed.embedding],
      dim: parsed.embedding.length,
      model,
      usage: {
        inputTextTokens: parsed.inputTextTokenCount,
        imageCount,
        cost: usage.cost,
      },
    };
  }

  private async signedFetch(input: {
    readonly url: string;
    readonly path: string;
    readonly body: Uint8Array;
    readonly accept: string;
  }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    body: ReadableStream<Uint8Array> | null;
  }> {
    const host = new URL(this.baseUrl).host;
    const signed = signRequest({
      method: "POST",
      host,
      path: input.path,
      headers: {
        "content-type": "application/json",
        accept: input.accept,
      },
      body: input.body,
      region: this.region,
      service: SERVICE,
      credentials: this.credentials,
      now: this.clock(),
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: input.accept,
      host,
      "x-amz-date": signed.amzDate,
      "x-amz-content-sha256": signed.contentSha256,
      authorization: signed.authorization,
    };
    if (this.credentials.sessionToken !== undefined) {
      headers["x-amz-security-token"] = this.credentials.sessionToken;
    }
    let response;
    try {
      response = await this.fetchImpl(input.url, {
        method: "POST",
        headers,
        body: input.body,
      });
    } catch (err) {
      throw fromNetworkError(err);
    }
    if (!response.ok) {
      throw fromHttpResponse({ status: response.status, body: await response.text() });
    }
    return response;
  }

  async getBatch(jobIdentifier: string): Promise<BedrockBatchJobDetail> {
    if (!isBedrockBatchJobIdentifier(jobIdentifier)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `getBatch: invalid jobIdentifier '${jobIdentifier}'`,
      });
    }
    const path = `/model-invocation-jobs/${encodeURIComponent(jobIdentifier)}`;
    const text = await this.signedControlPlaneGet({ path, query: {} });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `getBatch: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseBatchJobDetail(raw);
  }

  async createModelCustomizationJob(
    input: BedrockCreateModelCustomizationJobInput,
  ): Promise<BedrockCreateModelCustomizationJobResponse> {
    const bodyStr = buildCreateModelCustomizationJobBody(input);
    const body = new TextEncoder().encode(bodyStr);
    const text = await this.signedControlPlanePost({
      path: "/model-customization-jobs",
      body,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `createModelCustomizationJob: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseCreateModelCustomizationJobResponse(raw);
  }

  async stopModelCustomizationJob(jobIdentifier: string): Promise<void> {
    if (jobIdentifier.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "stopModelCustomizationJob: jobIdentifier must be a non-empty string",
      });
    }
    const path = `/model-customization-jobs/${encodeURIComponent(jobIdentifier)}/stop`;
    await this.signedControlPlanePost({ path });
  }

  async getModelCustomizationJob(
    jobIdentifier: string,
  ): Promise<BedrockModelCustomizationJobDetail> {
    if (jobIdentifier.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "getModelCustomizationJob: jobIdentifier must be a non-empty string",
      });
    }
    const path = `/model-customization-jobs/${encodeURIComponent(jobIdentifier)}`;
    const text = await this.signedControlPlaneGet({ path, query: {} });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `getModelCustomizationJob: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseModelCustomizationJobDetail(raw);
  }

  async listModelCustomizationJobs(
    options: BedrockListModelCustomizationJobsOptions = {},
  ): Promise<BedrockModelCustomizationJobListResponse> {
    const query = buildModelCustomizationJobListQuery(options);
    const text = await this.signedControlPlaneGet({
      path: "/model-customization-jobs",
      query,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `listModelCustomizationJobs: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseModelCustomizationJobListResponse(raw);
  }

  async getModelImportJob(jobIdentifier: string): Promise<BedrockModelImportJobDetail> {
    if (jobIdentifier.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "getModelImportJob: jobIdentifier must be a non-empty string",
      });
    }
    const path = `/model-import-jobs/${encodeURIComponent(jobIdentifier)}`;
    const text = await this.signedControlPlaneGet({ path, query: {} });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `getModelImportJob: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseModelImportJobDetail(raw);
  }

  async listModelImportJobs(
    options: BedrockListModelImportJobsOptions = {},
  ): Promise<BedrockModelImportJobListResponse> {
    const query = buildModelImportJobListQuery(options);
    const text = await this.signedControlPlaneGet({
      path: "/model-import-jobs",
      query,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `listModelImportJobs: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseModelImportJobListResponse(raw);
  }

  async getCustomModel(modelIdentifier: string): Promise<BedrockCustomModelDetail> {
    if (modelIdentifier.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "getCustomModel: modelIdentifier must be a non-empty string",
      });
    }
    const path = `/custom-models/${encodeURIComponent(modelIdentifier)}`;
    const text = await this.signedControlPlaneGet({ path, query: {} });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `getCustomModel: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseCustomModelDetail(raw);
  }

  async deleteCustomModel(modelIdentifier: string): Promise<void> {
    if (modelIdentifier.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "deleteCustomModel: modelIdentifier must be a non-empty string",
      });
    }
    const path = `/custom-models/${encodeURIComponent(modelIdentifier)}`;
    await this.signedControlPlaneDelete({ path });
  }

  async listCustomModels(
    options: BedrockListCustomModelsOptions = {},
  ): Promise<BedrockCustomModelListResponse> {
    const query = buildCustomModelListQuery(options);
    const text = await this.signedControlPlaneGet({
      path: "/custom-models",
      query,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `listCustomModels: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseCustomModelListResponse(raw);
  }

  async getImportedModel(modelIdentifier: string): Promise<BedrockImportedModelDetail> {
    if (modelIdentifier.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "getImportedModel: modelIdentifier must be a non-empty string",
      });
    }
    const path = `/imported-models/${encodeURIComponent(modelIdentifier)}`;
    const text = await this.signedControlPlaneGet({ path, query: {} });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `getImportedModel: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseImportedModelDetail(raw);
  }

  async deleteImportedModel(modelIdentifier: string): Promise<void> {
    if (modelIdentifier.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "deleteImportedModel: modelIdentifier must be a non-empty string",
      });
    }
    const path = `/imported-models/${encodeURIComponent(modelIdentifier)}`;
    await this.signedControlPlaneDelete({ path });
  }

  async listImportedModels(
    options: BedrockListImportedModelsOptions = {},
  ): Promise<BedrockImportedModelListResponse> {
    const query = buildImportedModelListQuery(options);
    const text = await this.signedControlPlaneGet({
      path: "/imported-models",
      query,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `listImportedModels: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseImportedModelListResponse(raw);
  }

  async getInferenceProfile(profileIdentifier: string): Promise<BedrockInferenceProfileDetail> {
    if (profileIdentifier.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "getInferenceProfile: profileIdentifier must be a non-empty string",
      });
    }
    const path = `/inference-profiles/${encodeURIComponent(profileIdentifier)}`;
    const text = await this.signedControlPlaneGet({ path, query: {} });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `getInferenceProfile: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseInferenceProfileDetail(raw);
  }

  async deleteInferenceProfile(profileIdentifier: string): Promise<void> {
    if (profileIdentifier.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "deleteInferenceProfile: profileIdentifier must be a non-empty string",
      });
    }
    const detail = await this.getInferenceProfile(profileIdentifier);
    if (detail.type !== "APPLICATION") {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `deleteInferenceProfile: cannot delete ${detail.type} profile '${profileIdentifier}'. Only APPLICATION-type profiles are operator-owned and deletable.`,
      });
    }
    const path = `/inference-profiles/${encodeURIComponent(profileIdentifier)}`;
    await this.signedControlPlaneDelete({ path });
  }

  async updateInferenceProfile(
    profileIdentifier: string,
    input: BedrockUpdateInferenceProfileInput,
  ): Promise<void> {
    if (profileIdentifier.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "updateInferenceProfile: profileIdentifier must be a non-empty string",
      });
    }
    const bodyStr = buildUpdateInferenceProfileBody(input);
    const detail = await this.getInferenceProfile(profileIdentifier);
    if (detail.type !== "APPLICATION") {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `updateInferenceProfile: cannot update ${detail.type} profile '${profileIdentifier}'. Only APPLICATION-type profiles are operator-owned and mutable.`,
      });
    }
    const body = new TextEncoder().encode(bodyStr);
    const path = `/inference-profiles/${encodeURIComponent(profileIdentifier)}`;
    await this.signedControlPlanePatch({ path, body });
  }

  async createInferenceProfile(
    input: BedrockCreateInferenceProfileInput,
  ): Promise<BedrockCreateInferenceProfileResponse> {
    const bodyStr = buildCreateInferenceProfileBody(input);
    const body = new TextEncoder().encode(bodyStr);
    const text = await this.signedControlPlanePost({
      path: "/inference-profiles",
      body,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `createInferenceProfile: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseCreateInferenceProfileResponse(raw);
  }

  async listInferenceProfiles(
    options: BedrockListInferenceProfilesOptions = {},
  ): Promise<BedrockInferenceProfileListResponse> {
    const query = buildInferenceProfileListQuery(options);
    const text = await this.signedControlPlaneGet({
      path: "/inference-profiles",
      query,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `listInferenceProfiles: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseInferenceProfileListResponse(raw);
  }

  async getProvisionedModelThroughput(
    provisionedModelId: string,
  ): Promise<BedrockProvisionedModelDetail> {
    if (provisionedModelId.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "getProvisionedModelThroughput: provisionedModelId must be a non-empty string",
      });
    }
    const path = `/provisioned-model-throughputs/${encodeURIComponent(provisionedModelId)}`;
    const text = await this.signedControlPlaneGet({ path, query: {} });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `getProvisionedModelThroughput: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseProvisionedModelDetail(raw);
  }

  async deleteProvisionedModelThroughput(provisionedModelId: string): Promise<void> {
    if (provisionedModelId.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "deleteProvisionedModelThroughput: provisionedModelId must be a non-empty string",
      });
    }
    const path = `/provisioned-model-throughput/${encodeURIComponent(provisionedModelId)}`;
    await this.signedControlPlaneDelete({ path });
  }

  async updateProvisionedModelThroughput(
    provisionedModelId: string,
    input: BedrockUpdateProvisionedModelThroughputInput,
  ): Promise<void> {
    if (provisionedModelId.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "updateProvisionedModelThroughput: provisionedModelId must be a non-empty string",
      });
    }
    const bodyStr = buildUpdateProvisionedModelThroughputBody(input);
    const body = new TextEncoder().encode(bodyStr);
    const path = `/provisioned-model-throughput/${encodeURIComponent(provisionedModelId)}`;
    await this.signedControlPlanePatch({ path, body });
  }

  async createProvisionedModelThroughput(
    input: BedrockCreateProvisionedModelThroughputInput,
  ): Promise<BedrockCreateProvisionedModelThroughputResponse> {
    const bodyStr = buildCreateProvisionedModelThroughputBody(input);
    const body = new TextEncoder().encode(bodyStr);
    const text = await this.signedControlPlanePost({
      path: "/provisioned-model-throughput",
      body,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `createProvisionedModelThroughput: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseCreateProvisionedModelThroughputResponse(raw);
  }

  async listProvisionedModelThroughputs(
    options: BedrockListProvisionedModelThroughputsOptions = {},
  ): Promise<BedrockProvisionedModelListResponse> {
    const query = buildProvisionedThroughputListQuery(options);
    const text = await this.signedControlPlaneGet({
      path: "/provisioned-model-throughputs",
      query,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `listProvisionedModelThroughputs: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseProvisionedModelListResponse(raw);
  }

  async getFoundationModel(modelIdentifier: string): Promise<BedrockFoundationModelDetail> {
    if (modelIdentifier.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "getFoundationModel: modelIdentifier must be a non-empty string",
      });
    }
    const path = `/foundation-models/${encodeURIComponent(modelIdentifier)}`;
    const text = await this.signedControlPlaneGet({ path, query: {} });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `getFoundationModel: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseFoundationModelDetail(raw);
  }

  async listFoundationModels(
    options: BedrockListFoundationModelsOptions = {},
  ): Promise<BedrockFoundationModelListResponse> {
    const query = buildFoundationModelListQuery(options);
    const text = await this.signedControlPlaneGet({
      path: "/foundation-models",
      query,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `listFoundationModels: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseFoundationModelListResponse(raw);
  }

  async getGuardrail(
    guardrailIdentifier: string,
    guardrailVersion?: string,
  ): Promise<BedrockGuardrailDetail> {
    if (guardrailIdentifier.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "getGuardrail: guardrailIdentifier must be a non-empty string",
      });
    }
    if (guardrailVersion !== undefined && guardrailVersion.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "getGuardrail: guardrailVersion must be a non-empty string when provided",
      });
    }
    const path = `/guardrails/${encodeURIComponent(guardrailIdentifier)}`;
    const query: Record<string, string> =
      guardrailVersion !== undefined ? { guardrailVersion } : {};
    const text = await this.signedControlPlaneGet({ path, query });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `getGuardrail: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseGuardrailDetail(raw);
  }

  async deleteGuardrail(guardrailIdentifier: string, guardrailVersion?: string): Promise<void> {
    if (guardrailIdentifier.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "deleteGuardrail: guardrailIdentifier must be a non-empty string",
      });
    }
    if (guardrailVersion !== undefined && guardrailVersion.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "deleteGuardrail: guardrailVersion must be a non-empty string when provided",
      });
    }
    const path = `/guardrails/${encodeURIComponent(guardrailIdentifier)}`;
    const query: Record<string, string> =
      guardrailVersion !== undefined ? { guardrailVersion } : {};
    await this.signedControlPlaneDelete({ path, query });
  }

  async listGuardrails(
    options: BedrockListGuardrailsOptions = {},
  ): Promise<BedrockGuardrailListResponse> {
    const query = buildGuardrailListQuery(options);
    const text = await this.signedControlPlaneGet({
      path: "/guardrails",
      query,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `listGuardrails: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseGuardrailListResponse(raw);
  }

  async createBatch(input: BedrockCreateBatchInput): Promise<BedrockCreateBatchResponse> {
    const bodyStr = buildCreateBatchBody(input);
    const body = new TextEncoder().encode(bodyStr);
    const text = await this.signedControlPlanePost({
      path: "/model-invocation-jobs",
      body,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `createBatch: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseCreateBatchResponse(raw);
  }

  async stopBatch(jobIdentifier: string): Promise<void> {
    if (!isBedrockBatchJobIdentifier(jobIdentifier)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `stopBatch: invalid jobIdentifier '${jobIdentifier}'`,
      });
    }
    const path = `/model-invocation-jobs/${encodeURIComponent(jobIdentifier)}/stop`;
    await this.signedControlPlanePost({ path });
  }

  async listBatches(options: BedrockListBatchesOptions = {}): Promise<BedrockBatchJobListResponse> {
    const query = buildBatchListQuery(options);
    const text = await this.signedControlPlaneGet({
      path: "/model-invocation-jobs/",
      query,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `listBatches: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseBatchListResponse(raw);
  }

  async tagResource(input: BedrockTagResourceInput): Promise<void> {
    const bodyStr = buildTagResourceBody(input);
    const body = new TextEncoder().encode(bodyStr);
    const query = buildTagResourceQuery(input);
    await this.signedControlPlanePost({ path: "/tags", body, query });
  }

  async untagResource(input: BedrockUntagResourceInput): Promise<void> {
    const bodyStr = buildUntagResourceBody(input);
    const body = new TextEncoder().encode(bodyStr);
    const query = buildUntagResourceQuery(input);
    await this.signedControlPlanePost({ path: "/untag", body, query });
  }

  async listTagsForResource(
    input: BedrockListTagsForResourceInput,
  ): Promise<BedrockListTagsForResourceResponse> {
    const bodyStr = buildListTagsForResourceBody(input);
    const body = new TextEncoder().encode(bodyStr);
    const text = await this.signedControlPlanePost({
      path: "/listTagsForResource",
      body,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new BedrockError({
        kind: "api_error",
        message: `listTagsForResource: failed to parse response: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
    return parseListTagsForResourceResponse(raw);
  }

  private async signedControlPlaneGet(input: {
    readonly path: string;
    readonly query: Record<string, string>;
  }): Promise<string> {
    const host = new URL(this.controlPlaneBaseUrl).host;
    const body = new Uint8Array(0);
    const signed = signRequest({
      method: "GET",
      host,
      path: input.path,
      query: input.query,
      headers: {
        accept: "application/json",
      },
      body,
      region: this.region,
      service: SERVICE,
      credentials: this.credentials,
      now: this.clock(),
    });
    const headers: Record<string, string> = {
      accept: "application/json",
      host,
      "x-amz-date": signed.amzDate,
      "x-amz-content-sha256": signed.contentSha256,
      authorization: signed.authorization,
    };
    if (this.credentials.sessionToken !== undefined) {
      headers["x-amz-security-token"] = this.credentials.sessionToken;
    }
    const qs = encodeQueryString(input.query);
    const url = `${this.controlPlaneBaseUrl}${input.path}${qs.length > 0 ? `?${qs}` : ""}`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        body,
      });
    } catch (err) {
      throw fromNetworkError(err);
    }
    if (!response.ok) {
      throw fromHttpResponse({ status: response.status, body: await response.text() });
    }
    return response.text();
  }

  private async signedControlPlanePost(input: {
    readonly path: string;
    readonly body?: Uint8Array;
    readonly query?: Record<string, string>;
  }): Promise<string> {
    const host = new URL(this.controlPlaneBaseUrl).host;
    const body = input.body ?? new Uint8Array(0);
    const query = input.query ?? {};
    const signed = signRequest({
      method: "POST",
      host,
      path: input.path,
      query,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body,
      region: this.region,
      service: SERVICE,
      credentials: this.credentials,
      now: this.clock(),
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      host,
      "x-amz-date": signed.amzDate,
      "x-amz-content-sha256": signed.contentSha256,
      authorization: signed.authorization,
    };
    if (this.credentials.sessionToken !== undefined) {
      headers["x-amz-security-token"] = this.credentials.sessionToken;
    }
    const qs = encodeQueryString(query);
    const url = `${this.controlPlaneBaseUrl}${input.path}${qs.length > 0 ? `?${qs}` : ""}`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
      });
    } catch (err) {
      throw fromNetworkError(err);
    }
    if (!response.ok) {
      throw fromHttpResponse({ status: response.status, body: await response.text() });
    }
    return response.text();
  }

  private async signedControlPlaneDelete(input: {
    readonly path: string;
    readonly query?: Record<string, string>;
  }): Promise<void> {
    const host = new URL(this.controlPlaneBaseUrl).host;
    const body = new Uint8Array(0);
    const query = input.query ?? {};
    const signed = signRequest({
      method: "DELETE",
      host,
      path: input.path,
      query,
      headers: {
        accept: "application/json",
      },
      body,
      region: this.region,
      service: SERVICE,
      credentials: this.credentials,
      now: this.clock(),
    });
    const headers: Record<string, string> = {
      accept: "application/json",
      host,
      "x-amz-date": signed.amzDate,
      "x-amz-content-sha256": signed.contentSha256,
      authorization: signed.authorization,
    };
    if (this.credentials.sessionToken !== undefined) {
      headers["x-amz-security-token"] = this.credentials.sessionToken;
    }
    const qs = encodeQueryString(query);
    const url = `${this.controlPlaneBaseUrl}${input.path}${qs.length > 0 ? `?${qs}` : ""}`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "DELETE",
        headers,
        body,
      });
    } catch (err) {
      throw fromNetworkError(err);
    }
    if (!response.ok) {
      throw fromHttpResponse({ status: response.status, body: await response.text() });
    }
  }

  private async signedControlPlanePatch(input: {
    readonly path: string;
    readonly body: Uint8Array;
  }): Promise<void> {
    const host = new URL(this.controlPlaneBaseUrl).host;
    const signed = signRequest({
      method: "PATCH",
      host,
      path: input.path,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: input.body,
      region: this.region,
      service: SERVICE,
      credentials: this.credentials,
      now: this.clock(),
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      host,
      "x-amz-date": signed.amzDate,
      "x-amz-content-sha256": signed.contentSha256,
      authorization: signed.authorization,
    };
    if (this.credentials.sessionToken !== undefined) {
      headers["x-amz-security-token"] = this.credentials.sessionToken;
    }
    const url = `${this.controlPlaneBaseUrl}${input.path}`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "PATCH",
        headers,
        body: input.body,
      });
    } catch (err) {
      throw fromNetworkError(err);
    }
    if (!response.ok) {
      throw fromHttpResponse({ status: response.status, body: await response.text() });
    }
  }
}

function deriveDefaultResidency(region: string): readonly Region[] {
  if (region.startsWith("eu-")) return ["eu"];
  if (region.startsWith("ap-") || region.startsWith("me-")) return ["ap"];
  if (region.startsWith("sa-")) return ["sa"];
  return ["us"];
}

function encodeQueryString(query: Record<string, string>): string {
  const keys = Object.keys(query).sort();
  return keys.map((k) => `${awsUriEncode(k)}=${awsUriEncode(query[k] ?? "")}`).join("&");
}

function awsUriEncode(value: string): string {
  const out: string[] = [];
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    const isUnreserved =
      (cp >= 0x30 && cp <= 0x39) ||
      (cp >= 0x41 && cp <= 0x5a) ||
      (cp >= 0x61 && cp <= 0x7a) ||
      ch === "-" ||
      ch === "_" ||
      ch === "." ||
      ch === "~";
    if (isUnreserved) {
      out.push(ch);
    } else {
      const bytes = new TextEncoder().encode(ch);
      for (const b of bytes) {
        out.push("%" + b.toString(16).toUpperCase().padStart(2, "0"));
      }
    }
  }
  return out.join("");
}

function approximateCohereTokens(texts: readonly string[]): number {
  let total = 0;
  for (const t of texts) {
    if (t.length === 0) continue;
    total += Math.max(1, Math.ceil(t.length / 4));
  }
  return total;
}
