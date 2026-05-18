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
  buildBedrockConverseRequest,
  extractTextFromConverseResponse,
  extractToolCallsFromConverseResponse,
  normalizeConverseUsage,
  type BedrockConverseResponse,
} from "./converse-api.js";
import {
  bedrockEmbeddingFamily,
  buildCohereEmbedRequest,
  buildEmbeddingResponse,
  buildTitanEmbedRequest,
  parseCohereEmbedResponse,
  parseTitanEmbedResponse,
  type CohereEmbedInputType,
  type EmbeddingAggregation,
} from "./embeddings.js";
import {
  BedrockError,
  fromHttpResponse,
  fromNetworkError,
} from "./errors.js";
import { readConverseEventStream } from "./event-stream.js";
import {
  BEDROCK_CHAT_MODELS,
  BEDROCK_CHAT_PRICING,
  BEDROCK_DEFAULT_EMBEDDING_MODEL,
  BEDROCK_EMBEDDING_MODELS,
  isBedrockChatModel,
  isBedrockEmbeddingModel,
  type BedrockChatModel,
  type BedrockEmbeddingModel,
} from "./pricing.js";
import { signRequest, type AwsCredentials } from "./signing.js";

export const BEDROCK_DEFAULT_REGION = "us-east-1";
export const BEDROCK_DEFAULT_MODEL: BedrockChatModel =
  "anthropic.claude-3-5-sonnet-20241022-v2:0";

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
  readonly baseUrl?: string;
  readonly residency?: readonly Region[];
  readonly fetch?: FetchLike;
  readonly clock?: () => Date;
}

const PROVIDER_ID = "bedrock";
const SERVICE = "bedrock";

export class BedrockProvider implements LlmProvider {
  readonly id = PROVIDER_ID;
  readonly models: readonly string[] = [
    ...BEDROCK_CHAT_MODELS,
    ...BEDROCK_EMBEDDING_MODELS,
  ];
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    toolUse: true,
    jsonMode: false,
    embedding: true,
    maxContextTokens: 200_000,
    supportsThinking: false,
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
  private readonly baseUrl: string;
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
      throw new Error(
        `BedrockProvider: unsupported defaultEmbeddingModel ${embedModel}`,
      );
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
    this.baseUrl = opts.baseUrl ?? `https://bedrock-runtime.${this.region}.amazonaws.com`;
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
    const model = this.resolveModel(req.model);
    const built = buildBedrockConverseRequest(req, {
      defaultMaxTokens: this.defaultMaxTokens,
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
    const model = this.resolveModel(req.model);
    const built = buildBedrockConverseRequest(req, {
      defaultMaxTokens: this.defaultMaxTokens,
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
    const vectors: number[][] = [];
    let totalTokens = 0;
    let dim = 0;
    for (const text of texts) {
      const body = buildTitanEmbedRequest({
        model,
        text,
        ...(this.defaultEmbeddingDimensions !== undefined
          ? { dimensions: this.defaultEmbeddingDimensions }
          : {}),
      });
      const raw = await this.invokeModelJson(model, body);
      const parsed = parseTitanEmbedResponse(raw);
      vectors.push([...parsed.embedding]);
      totalTokens += parsed.inputTextTokenCount;
      if (dim === 0) dim = parsed.embedding.length;
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
      typeof reported === "number" && reported > 0
        ? reported
        : approximateCohereTokens(texts);
    return { vectors, dim, inputTokens };
  }

  private async invokeModelJson(
    model: BedrockEmbeddingModel,
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
    if (!isBedrockEmbeddingModel(requested)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `model '${requested}' is not a known Bedrock embedding model`,
      });
    }
    return requested;
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
}

function deriveDefaultResidency(region: string): readonly Region[] {
  if (region.startsWith("eu-")) return ["eu"];
  if (region.startsWith("ap-") || region.startsWith("me-")) return ["ap"];
  if (region.startsWith("sa-")) return ["sa"];
  return ["us"];
}

function approximateCohereTokens(texts: readonly string[]): number {
  let total = 0;
  for (const t of texts) {
    if (t.length === 0) continue;
    total += Math.max(1, Math.ceil(t.length / 4));
  }
  return total;
}
