import type { LlmProvider } from "./provider.js";
import type {
  CompletionChunk,
  CompletionRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderCapabilities,
  ProviderPricing,
  Region,
} from "./types.js";

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  chat: true,
  toolUse: true,
  streaming: true,
  jsonMode: true,
  embedding: true,
  maxContextTokens: 128_000,
  supportsThinking: false,
};

const DEFAULT_PRICING: ProviderPricing = {
  inputPerMillionTokens: 0,
  outputPerMillionTokens: 0,
};

export interface MockLlmProviderConfig {
  readonly id?: string;
  readonly models?: readonly string[];
  readonly capabilities?: Partial<ProviderCapabilities>;
  readonly residency?: readonly Region[];
  readonly pricing?: ProviderPricing;
  readonly completeBehavior?: (
    req: CompletionRequest,
  ) => AsyncIterable<CompletionChunk>;
  readonly embedBehavior?: (req: EmbeddingRequest) => Promise<EmbeddingResponse>;
  readonly errorOnComplete?: Error;
  readonly errorOnEmbed?: Error;
}

export class MockLlmProvider implements LlmProvider {
  readonly id: string;
  readonly models: readonly string[];
  readonly capabilities: ProviderCapabilities;
  readonly residency: readonly Region[];
  readonly pricing: ProviderPricing;

  private readonly completeBehavior?: (
    req: CompletionRequest,
  ) => AsyncIterable<CompletionChunk>;
  private readonly embedBehavior?: (req: EmbeddingRequest) => Promise<EmbeddingResponse>;
  private readonly errorOnComplete?: Error;
  private readonly errorOnEmbed?: Error;

  constructor(config: MockLlmProviderConfig = {}) {
    this.id = config.id ?? "mock";
    this.models = config.models ?? ["mock-model"];
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...config.capabilities };
    this.residency = config.residency ?? ["eu", "us", "me"];
    this.pricing = config.pricing ?? DEFAULT_PRICING;
    this.completeBehavior = config.completeBehavior;
    this.embedBehavior = config.embedBehavior;
    this.errorOnComplete = config.errorOnComplete;
    this.errorOnEmbed = config.errorOnEmbed;
  }

  complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (this.errorOnComplete !== undefined) {
      throw this.errorOnComplete;
    }
    if (this.completeBehavior !== undefined) {
      return this.completeBehavior(req);
    }
    return defaultCompleteStream();
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (this.errorOnEmbed !== undefined) {
      throw this.errorOnEmbed;
    }
    if (this.embedBehavior !== undefined) {
      return this.embedBehavior(req);
    }
    const dim = 16;
    const vectors = req.texts.map(() => new Array<number>(dim).fill(0));
    return {
      vectors,
      dim,
      model: req.model ?? "mock-embedding",
      usage: {
        inputTokens: req.texts.length * 10,
        outputTokens: 0,
        cost: 0,
      },
    };
  }
}

async function* defaultCompleteStream(): AsyncIterable<CompletionChunk> {
  yield { kind: "text", text: "mock response" };
  yield {
    kind: "usage_final",
    usage: { inputTokens: 100, outputTokens: 2, cost: 0 },
  };
}
