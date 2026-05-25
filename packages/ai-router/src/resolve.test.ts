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
} from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import {
  ProviderResolutionError,
  parseProviderRef,
  residencyAllowsProvider,
  resolveProviders,
} from "./resolve.js";

function fakeProvider(opts: {
  id: string;
  models?: string[];
  residency?: Region[];
}): LlmProvider {
  return {
    id: opts.id,
    models: opts.models ?? ["default-model"],
    capabilities: {
      chat: true,
      streaming: true,
      toolUse: true,
      jsonMode: false,
      embedding: false,
      maxContextTokens: 100_000,
      supportsThinking: false,
      vision: false,
    } satisfies ProviderCapabilities,
    pricing: {
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
    } satisfies ProviderPricing,
    residency: opts.residency ?? ["us", "eu"],
    async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
      // no-op
    },
    async embed(_req: EmbeddingRequest): Promise<EmbeddingResponse> {
      throw new Error("not implemented");
    },
  };
}

const TENANT = "00000000-0000-4000-8000-000000000001";
const POLICIES: TaskPolicyMap = {
  executor: {
    primary: "anthropic/claude-sonnet-4-6",
    fallback: ["openai/gpt-4o", "anthropic"],
  },
  embedding: { primary: "openai", fallback: [] },
};

describe("parseProviderRef", () => {
  it("splits provider/model", () => {
    expect(parseProviderRef("anthropic/claude-sonnet-4-6")).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
  });

  it("returns null modelId when no slash", () => {
    expect(parseProviderRef("anthropic")).toEqual({
      providerId: "anthropic",
      modelId: null,
    });
  });
});

describe("residencyAllowsProvider", () => {
  it("allows everything for 'unrestricted'", () => {
    expect(
      residencyAllowsProvider("unrestricted", fakeProvider({ id: "x", residency: ["us"] })),
    ).toBe(true);
  });

  it("blocks when required region missing from provider", () => {
    expect(
      residencyAllowsProvider("eu-only", fakeProvider({ id: "x", residency: ["us"] })),
    ).toBe(false);
  });

  it("allows when required region is in provider's list", () => {
    expect(
      residencyAllowsProvider("eu-only", fakeProvider({ id: "x", residency: ["us", "eu"] })),
    ).toBe(true);
  });
});

describe("resolveProviders", () => {
  it("returns the primary then fallbacks in order", () => {
    const providers = new Map<string, LlmProvider>([
      ["anthropic", fakeProvider({ id: "anthropic" })],
      ["openai", fakeProvider({ id: "openai" })],
    ]);
    const result = resolveProviders({
      task: "executor",
      tenantId: TENANT,
      residency: "unrestricted",
      providers,
      taskPolicies: POLICIES,
    });
    expect(result.map((c) => `${c.providerId}/${c.modelId}`)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-4o",
      "anthropic/default-model",
    ]);
  });

  it("skips unknown providers in the chain", () => {
    const providers = new Map<string, LlmProvider>([
      ["openai", fakeProvider({ id: "openai" })],
    ]);
    const result = resolveProviders({
      task: "executor",
      tenantId: TENANT,
      residency: "unrestricted",
      providers,
      taskPolicies: POLICIES,
    });
    expect(result.map((c) => c.providerId)).toEqual(["openai"]);
  });

  it("filters by residency", () => {
    const providers = new Map<string, LlmProvider>([
      ["anthropic", fakeProvider({ id: "anthropic", residency: ["us"] })],
      ["openai", fakeProvider({ id: "openai", residency: ["eu"] })],
    ]);
    const result = resolveProviders({
      task: "executor",
      tenantId: TENANT,
      residency: "eu-only",
      providers,
      taskPolicies: POLICIES,
    });
    expect(result.map((c) => c.providerId)).toEqual(["openai"]);
  });

  it("throws when no provider matches", () => {
    const providers = new Map<string, LlmProvider>();
    expect(() =>
      resolveProviders({
        task: "executor",
        tenantId: TENANT,
        residency: "unrestricted",
        providers,
        taskPolicies: POLICIES,
      }),
    ).toThrow(ProviderResolutionError);
  });

  it("throws when task has no policy", () => {
    const providers = new Map<string, LlmProvider>([
      ["anthropic", fakeProvider({ id: "anthropic" })],
    ]);
    expect(() =>
      resolveProviders({
        task: "rerank",
        tenantId: TENANT,
        residency: "unrestricted",
        providers,
        taskPolicies: POLICIES,
      }),
    ).toThrow(/no task policy/);
  });

  it("uses override policy when supplied", () => {
    const providers = new Map<string, LlmProvider>([
      ["anthropic", fakeProvider({ id: "anthropic" })],
      ["openai", fakeProvider({ id: "openai" })],
    ]);
    const result = resolveProviders({
      task: "executor",
      tenantId: TENANT,
      residency: "unrestricted",
      providers,
      taskPolicies: POLICIES,
      overrides: { executor: { primary: "openai/gpt-4-mini", fallback: [] } },
    });
    expect(result.map((c) => `${c.providerId}/${c.modelId}`)).toEqual([
      "openai/gpt-4-mini",
    ]);
  });
});
