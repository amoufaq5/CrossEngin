import type {
  CompletionChunk,
  CompletionRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  LlmProvider,
  ProviderCapabilities,
  ProviderPricing,
  Region,
  TaskPolicyMap,
  TenantResidency,
} from "@crossengin/ai-providers";
import { AnthropicProvider, isAnthropicModel } from "@crossengin/ai-providers-anthropic";
import {
  BedrockProvider,
  BEDROCK_DEFAULT_MODEL,
  isBedrockChatModel,
  isBedrockEmbeddingModel,
  type BedrockChatModel,
} from "@crossengin/ai-providers-bedrock";
import { OpenAIProvider, isOpenAIModel } from "@crossengin/ai-providers-openai";
import {
  DefaultLlmRouter,
  InMemoryCostTracker,
  InMemoryLatencyTracker,
  type CostCeiling,
} from "@crossengin/ai-router";

export const DEFAULT_TASK_POLICIES: TaskPolicyMap = {
  planner: {
    primary: "anthropic/claude-opus-4-7",
    fallback: [
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-4o",
      "bedrock/anthropic.claude-opus-4-20250514-v1:0",
    ],
  },
  executor: {
    primary: "anthropic/claude-sonnet-4-6",
    fallback: ["openai/gpt-4o-mini", "bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0"],
  },
  summarizer: {
    primary: "openai/gpt-4o-mini",
    fallback: ["anthropic/claude-haiku-4-5", "bedrock/anthropic.claude-3-5-haiku-20241022-v1:0"],
  },
  "diff-narrator": {
    primary: "anthropic/claude-haiku-4-5",
    fallback: ["openai/gpt-4o-mini", "bedrock/anthropic.claude-3-5-haiku-20241022-v1:0"],
  },
  embedding: {
    primary: "openai/text-embedding-3-small",
    fallback: ["bedrock/amazon.titan-embed-text-v2:0"],
  },
  rerank: {
    primary: "anthropic/claude-haiku-4-5",
    fallback: ["openai/gpt-4o-mini", "bedrock/anthropic.claude-3-5-haiku-20241022-v1:0"],
  },
  classifier: {
    primary: "openai/gpt-4o-mini",
    fallback: ["anthropic/claude-haiku-4-5", "bedrock/anthropic.claude-3-5-haiku-20241022-v1:0"],
  },
};

export interface BuildProviderInput {
  readonly env: NodeJS.ProcessEnv;
  readonly forceModel?: string;
  readonly costCeiling?: CostCeiling;
}

export interface BuildProviderOutput {
  readonly provider: LlmProvider;
  readonly providerKind: "single" | "router";
  readonly availableProviders: readonly string[];
}

export class NoProvidersConfiguredError extends Error {
  readonly kind = "no_providers_configured" as const;

  constructor() {
    super(
      "chat: no provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, and/or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY before running 'crossengin chat'.",
    );
    this.name = "NoProvidersConfiguredError";
  }
}

export function buildChatCompleter(input: BuildProviderInput): BuildProviderOutput {
  const providers = new Map<string, LlmProvider>();
  const anthropicKey = input.env["ANTHROPIC_API_KEY"];
  if (anthropicKey !== undefined && anthropicKey.length > 0) {
    providers.set(
      "anthropic",
      new AnthropicProvider({
        apiKey: anthropicKey,
        defaultModel: resolveAnthropicDefault(input.forceModel),
      }),
    );
  }
  const openaiKey = input.env["OPENAI_API_KEY"];
  if (openaiKey !== undefined && openaiKey.length > 0) {
    providers.set(
      "openai",
      new OpenAIProvider({
        apiKey: openaiKey,
        defaultChatModel: resolveOpenAIChatDefault(input.forceModel),
      }),
    );
  }
  const awsAccessKey = input.env["AWS_ACCESS_KEY_ID"];
  const awsSecretKey = input.env["AWS_SECRET_ACCESS_KEY"];
  if (
    awsAccessKey !== undefined &&
    awsAccessKey.length > 0 &&
    awsSecretKey !== undefined &&
    awsSecretKey.length > 0
  ) {
    const sessionToken = input.env["AWS_SESSION_TOKEN"];
    const region = input.env["AWS_REGION"] ?? input.env["AWS_DEFAULT_REGION"];
    providers.set(
      "bedrock",
      new BedrockProvider({
        accessKeyId: awsAccessKey,
        secretAccessKey: awsSecretKey,
        ...(sessionToken !== undefined && sessionToken.length > 0 ? { sessionToken } : {}),
        ...(region !== undefined && region.length > 0 ? { region } : {}),
        defaultModel: resolveBedrockDefault(input.forceModel),
      }),
    );
  }
  if (providers.size === 0) throw new NoProvidersConfiguredError();
  if (providers.size === 1) {
    const [providerId, provider] = [...providers.entries()][0]!;
    return {
      provider,
      providerKind: "single",
      availableProviders: [providerId],
    };
  }
  const router = new DefaultLlmRouter({
    providers,
    taskPolicies: filterPoliciesByAvailable(DEFAULT_TASK_POLICIES, providers),
    getTenantResidency: async () => "unrestricted" as TenantResidency,
    costCeiling: input.costCeiling,
    costTracker: new InMemoryCostTracker(),
    latencyTracker: new InMemoryLatencyTracker(),
  });
  return {
    provider: new RouterAsProvider(router, providers),
    providerKind: "router",
    availableProviders: [...providers.keys()],
  };
}

function resolveAnthropicDefault(
  forceModel: string | undefined,
):
  | "claude-sonnet-4-6"
  | "claude-opus-4-7"
  | "claude-opus-4-6"
  | "claude-sonnet-4-5"
  | "claude-haiku-4-5" {
  if (forceModel !== undefined && isAnthropicModel(forceModel)) {
    return forceModel;
  }
  return "claude-sonnet-4-6";
}

function resolveOpenAIChatDefault(
  forceModel: string | undefined,
): "gpt-4o" | "gpt-4o-mini" | "gpt-4-turbo" | "o1" | "o1-mini" {
  if (forceModel !== undefined && isOpenAIModel(forceModel)) {
    if (
      forceModel === "gpt-4o" ||
      forceModel === "gpt-4o-mini" ||
      forceModel === "gpt-4-turbo" ||
      forceModel === "o1" ||
      forceModel === "o1-mini"
    ) {
      return forceModel;
    }
  }
  return "gpt-4o-mini";
}

function resolveBedrockDefault(forceModel: string | undefined): BedrockChatModel {
  if (forceModel !== undefined && isBedrockChatModel(forceModel)) {
    return forceModel;
  }
  return BEDROCK_DEFAULT_MODEL;
}

export function isBedrockModelRef(value: string): boolean {
  return isBedrockChatModel(value) || isBedrockEmbeddingModel(value);
}

function filterPoliciesByAvailable(
  policies: TaskPolicyMap,
  providers: ReadonlyMap<string, LlmProvider>,
): TaskPolicyMap {
  const result: TaskPolicyMap = {};
  for (const [task, policy] of Object.entries(policies)) {
    const entries = [policy.primary, ...policy.fallback].filter((ref) => {
      const providerId = ref.split("/")[0];
      return providerId !== undefined && providers.has(providerId);
    });
    if (entries.length === 0) continue;
    result[task] = {
      primary: entries[0]!,
      fallback: entries.slice(1),
    };
  }
  return result;
}

class RouterAsProvider implements LlmProvider {
  readonly id = "router";
  readonly models: readonly string[];
  readonly capabilities: ProviderCapabilities;
  readonly residency: readonly Region[];
  readonly pricing: ProviderPricing;

  constructor(
    private readonly router: DefaultLlmRouter,
    providers: ReadonlyMap<string, LlmProvider>,
  ) {
    const all = [...providers.values()];
    this.models = all.flatMap((p) => [...p.models]);
    this.capabilities = unionCapabilities(all);
    this.residency = unionResidency(all);
    this.pricing = all[0]?.pricing ?? {
      inputPerMillionTokens: 0,
      outputPerMillionTokens: 0,
    };
  }

  async *complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    yield* this.router.complete(req);
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    return this.router.embed(req);
  }
}

function unionCapabilities(providers: readonly LlmProvider[]): ProviderCapabilities {
  if (providers.length === 0) {
    return {
      chat: false,
      streaming: false,
      toolUse: false,
      jsonMode: false,
      embedding: false,
      maxContextTokens: 0,
      supportsThinking: false,
      vision: false,
    };
  }
  return {
    chat: providers.some((p) => p.capabilities.chat),
    streaming: providers.some((p) => p.capabilities.streaming),
    toolUse: providers.some((p) => p.capabilities.toolUse),
    jsonMode: providers.some((p) => p.capabilities.jsonMode),
    embedding: providers.some((p) => p.capabilities.embedding),
    maxContextTokens: Math.max(...providers.map((p) => p.capabilities.maxContextTokens)),
    supportsThinking: providers.some((p) => p.capabilities.supportsThinking),
    vision: providers.some((p) => p.capabilities.vision),
  };
}

function unionResidency(providers: readonly LlmProvider[]): readonly Region[] {
  const set = new Set<Region>();
  for (const p of providers) {
    for (const r of p.residency) set.add(r);
  }
  return [...set];
}
