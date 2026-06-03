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
import { describe, expect, it } from "vitest";

import { CostCeilingExceededError, InMemoryCostTracker } from "./cost-tracker.js";
import { InMemoryLatencyTracker } from "./latency-tracker.js";
import { ProviderResolutionError } from "./resolve.js";
import {
  AllProvidersExhaustedError,
  DefaultLlmRouter,
  type RouterResolution,
} from "./router.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

const POLICIES: TaskPolicyMap = {
  executor: { primary: "anthropic", fallback: ["openai"] },
  embedding: { primary: "openai", fallback: [] },
};

class StubProvider implements LlmProvider {
  readonly id: string;
  readonly models: readonly string[];
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    toolUse: true,
    jsonMode: false,
    embedding: false,
    maxContextTokens: 100_000,
    supportsThinking: false,
  };
  readonly pricing: ProviderPricing = {
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 2,
  };
  readonly residency: readonly Region[] = ["us", "eu"];

  private readonly behavior: "ok" | "retryable_then_ok" | "always_retryable" | "fatal";
  private attempts = 0;

  constructor(id: string, behavior: StubProvider["behavior"]) {
    this.id = id;
    this.models = [`${id}-model-1`];
    this.behavior = behavior;
  }

  async *complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    void req;
    this.attempts += 1;
    if (this.behavior === "always_retryable") {
      throw new RetryableError(`${this.id} failing`);
    }
    if (this.behavior === "retryable_then_ok" && this.attempts < 3) {
      throw new RetryableError(`${this.id} transient`);
    }
    if (this.behavior === "fatal") {
      throw new FatalError(`${this.id} fatal`);
    }
    yield { kind: "text", text: `from ${this.id}` };
    yield {
      kind: "usage_final",
      usage: { inputTokens: 5, outputTokens: 3, cost: 0.0001 },
    };
  }

  async embed(_req: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (this.behavior === "fatal") throw new FatalError("no embed");
    return { vectors: [[1, 2, 3]], usage: { inputTokens: 1, outputTokens: 0, cost: 0 } };
  }
}

class RetryableError extends Error {
  readonly kind = "rate_limit_error" as const;
  isRetryable(): boolean {
    return true;
  }
}

class FatalError extends Error {
  readonly kind = "invalid_request_error" as const;
  isRetryable(): boolean {
    return false;
  }
}

function fakeReq(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    task: "executor",
    tenantId: TENANT,
    sessionId: "sess-1",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

function buildRouter(opts: {
  providers: ReadonlyMap<string, LlmProvider>;
  residency?: TenantResidency;
  overrides?: Partial<TaskPolicyMap>;
  costCeiling?: ConstructorParameters<typeof DefaultLlmRouter>[0]["costCeiling"];
  costTracker?: InMemoryCostTracker;
}): DefaultLlmRouter {
  return new DefaultLlmRouter({
    providers: opts.providers,
    taskPolicies: POLICIES,
    getTenantResidency: async () => opts.residency ?? "unrestricted",
    getTenantOverrides: opts.overrides ? async () => opts.overrides! : undefined,
    retry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0, jitter: false },
    costCeiling: opts.costCeiling,
    costTracker: opts.costTracker,
    latencyTracker: new InMemoryLatencyTracker(),
    clock: () => 0,
  });
}

describe("DefaultLlmRouter.resolveProvider", () => {
  it("returns the primary provider + its model", async () => {
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new StubProvider("anthropic", "ok")],
      ["openai", new StubProvider("openai", "ok")],
    ]);
    const router = buildRouter({ providers });
    const resolved = await router.resolveProvider("executor", TENANT);
    expect(resolved.providerId).toBe("anthropic");
    expect(resolved.modelId).toBe("anthropic-model-1");
  });

  it("skips a missing primary and uses the fallback", async () => {
    const providers = new Map<string, LlmProvider>([
      ["openai", new StubProvider("openai", "ok")],
    ]);
    const router = buildRouter({ providers });
    const resolved = await router.resolveProvider("executor", TENANT);
    expect(resolved.providerId).toBe("openai");
  });

  it("throws ProviderResolutionError when no provider matches", async () => {
    const providers = new Map<string, LlmProvider>();
    const router = buildRouter({ providers });
    await expect(router.resolveProvider("executor", TENANT)).rejects.toThrow(
      ProviderResolutionError,
    );
  });
});

describe("DefaultLlmRouter.complete (single provider, happy path)", () => {
  it("streams chunks and records cost", async () => {
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const tracker = new InMemoryCostTracker();
    const router = buildRouter({ providers, costTracker: tracker });
    const chunks: CompletionChunk[] = [];
    for await (const c of router.complete(fakeReq())) chunks.push(c);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ kind: "text", text: "from anthropic" });
    const w = await tracker.getWindow(TENANT);
    expect(w?.costUsd).toBe(0.0001);
  });
});

describe("DefaultLlmRouter.complete — retry within a provider", () => {
  it("retries a transient error and succeeds", async () => {
    const provider = new StubProvider("anthropic", "retryable_then_ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const router = buildRouter({ providers });
    const chunks: CompletionChunk[] = [];
    for await (const c of router.complete(fakeReq())) chunks.push(c);
    expect(chunks[0]).toEqual({ kind: "text", text: "from anthropic" });
  });
});

describe("DefaultLlmRouter.complete — fallback to next provider", () => {
  it("uses the fallback when primary fully fails", async () => {
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new StubProvider("anthropic", "always_retryable")],
      ["openai", new StubProvider("openai", "ok")],
    ]);
    const router = buildRouter({ providers });
    const chunks: CompletionChunk[] = [];
    for await (const c of router.complete(fakeReq())) chunks.push(c);
    expect((chunks[0] as { text: string }).text).toBe("from openai");
  });

  it("throws AllProvidersExhausted when every fallback fails", async () => {
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new StubProvider("anthropic", "always_retryable")],
      ["openai", new StubProvider("openai", "always_retryable")],
    ]);
    const router = buildRouter({ providers });
    await expect(async () => {
      for await (const _ of router.complete(fakeReq())) void _;
    }).rejects.toThrow(AllProvidersExhaustedError);
  });
});

describe("DefaultLlmRouter.complete — non-retryable errors", () => {
  it("propagates non-retryable errors without trying the fallback", async () => {
    const fatal = new StubProvider("anthropic", "fatal");
    const ok = new StubProvider("openai", "ok");
    const providers = new Map<string, LlmProvider>([
      ["anthropic", fatal],
      ["openai", ok],
    ]);
    const router = buildRouter({ providers });
    await expect(async () => {
      for await (const _ of router.complete(fakeReq())) void _;
    }).rejects.toThrow("fatal");
  });
});

describe("DefaultLlmRouter.complete — cost ceiling", () => {
  it("blocks the request when estimated cost > maxUsdPerRequest", async () => {
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const router = buildRouter({
      providers,
      costCeiling: { maxUsdPerRequest: 0.0000001 },
    });
    await expect(async () => {
      for await (const _ of router.complete(fakeReq())) void _;
    }).rejects.toThrow(CostCeilingExceededError);
  });

  it("blocks the request when window total > maxUsdPerWindow", async () => {
    const tracker = new InMemoryCostTracker();
    await tracker.recordUsage({ tenantId: TENANT, costUsd: 100 });
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const router = buildRouter({
      providers,
      costTracker: tracker,
      costCeiling: { maxUsdPerWindow: 50 },
    });
    await expect(async () => {
      for await (const _ of router.complete(fakeReq())) void _;
    }).rejects.toThrow(CostCeilingExceededError);
  });
});

describe("DefaultLlmRouter.completeAggregate", () => {
  it("packs text + usage into a NormalizedCompletion", async () => {
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const router = buildRouter({ providers });
    const result = await router.completeAggregate(fakeReq());
    expect(result.text).toBe("from anthropic");
    expect(result.usage.inputTokens).toBe(5);
    expect(result.usage.cost).toBe(0.0001);
  });
});

describe("DefaultLlmRouter.embed", () => {
  it("calls the embedding-task primary provider", async () => {
    const openai = new StubProvider("openai", "ok");
    const providers = new Map<string, LlmProvider>([["openai", openai]]);
    const router = buildRouter({ providers });
    const result = await router.embed({
      texts: ["hello"],
      tenantId: TENANT,
    });
    expect(result.vectors).toEqual([[1, 2, 3]]);
  });
});

describe("DefaultLlmRouter onResolved observer", () => {
  function routerWithObserver(
    providers: ReadonlyMap<string, LlmProvider>,
    sink: RouterResolution[],
  ): DefaultLlmRouter {
    return new DefaultLlmRouter({
      providers,
      taskPolicies: POLICIES,
      getTenantResidency: async () => "unrestricted",
      retry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0, jitter: false },
      clock: () => 0,
      onResolved: (r) => sink.push(r),
    });
  }

  it("reports the primary provider at fallbackDepth 0", async () => {
    const sink: RouterResolution[] = [];
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new StubProvider("anthropic", "ok")],
      ["openai", new StubProvider("openai", "ok")],
    ]);
    for await (const _ of routerWithObserver(providers, sink).complete(fakeReq())) void _;
    expect(sink).toHaveLength(1);
    expect(sink[0]).toMatchObject({ providerId: "anthropic", fallbackDepth: 0, task: "executor" });
  });

  it("reports the fallback provider at fallbackDepth 1 when the primary fails", async () => {
    const sink: RouterResolution[] = [];
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new StubProvider("anthropic", "always_retryable")],
      ["openai", new StubProvider("openai", "ok")],
    ]);
    for await (const _ of routerWithObserver(providers, sink).complete(fakeReq())) void _;
    expect(sink).toHaveLength(1);
    expect(sink[0]).toMatchObject({ providerId: "openai", fallbackDepth: 1 });
  });

  it("does not fire when every provider is exhausted", async () => {
    const sink: RouterResolution[] = [];
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new StubProvider("anthropic", "always_retryable")],
      ["openai", new StubProvider("openai", "always_retryable")],
    ]);
    await expect(async () => {
      for await (const _ of routerWithObserver(providers, sink).complete(fakeReq())) void _;
    }).rejects.toBeInstanceOf(AllProvidersExhaustedError);
    expect(sink).toEqual([]);
  });
});
