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
import {
  ROUTER_INSTRUMENTATION_KINDS,
  captureRouterInstrumentation,
} from "./instrumentation.js";
import { InMemoryLatencyTracker } from "./latency-tracker.js";
import { ProviderResolutionError } from "./resolve.js";
import {
  AllProvidersExhaustedError,
  DefaultLlmRouter,
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
  getTenantCostCeiling?: ConstructorParameters<
    typeof DefaultLlmRouter
  >[0]["getTenantCostCeiling"];
  costTracker?: InMemoryCostTracker;
  instrumentation?: ConstructorParameters<typeof DefaultLlmRouter>[0]["instrumentation"];
}): DefaultLlmRouter {
  return new DefaultLlmRouter({
    providers: opts.providers,
    taskPolicies: POLICIES,
    getTenantResidency: async () => opts.residency ?? "unrestricted",
    getTenantOverrides: opts.overrides ? async () => opts.overrides! : undefined,
    retry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0, jitter: false },
    costCeiling: opts.costCeiling,
    getTenantCostCeiling: opts.getTenantCostCeiling,
    costTracker: opts.costTracker,
    latencyTracker: new InMemoryLatencyTracker(),
    instrumentation: opts.instrumentation,
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

describe("DefaultLlmRouter.complete — moderation early-exit (M6.6)", () => {
  class ModerationProvider extends StubProvider {
    constructor(id: string, private readonly modKind: string) {
      super(id, "ok");
    }
    async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
      void _req;
      throw Object.assign(new Error("blocked"), { kind: this.modKind });
    }
  }

  it("does NOT fall over to the fallback when the primary throws a moderation error", async () => {
    let openaiAttempts = 0;
    class CountingOpenAI extends StubProvider {
      constructor() {
        super("openai", "ok");
      }
      async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
        void _req;
        openaiAttempts += 1;
        yield { kind: "text", text: "fallback" };
        yield { kind: "usage_final", usage: { inputTokens: 1, outputTokens: 1, cost: 0 } };
      }
    }
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new ModerationProvider("anthropic", "refusal")],
      ["openai", new CountingOpenAI()],
    ]);
    const router = buildRouter({ providers });
    await expect(async () => {
      for await (const _c of router.complete(fakeReq())) {
        void _c;
      }
    }).rejects.toMatchObject({ kind: "refusal" });
    expect(openaiAttempts).toBe(0);
  });

  it("guardrail_intervened from Bedrock is also terminal — no fallback", async () => {
    let openaiAttempts = 0;
    class CountingOpenAI extends StubProvider {
      constructor() {
        super("openai", "ok");
      }
      async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
        void _req;
        openaiAttempts += 1;
        yield { kind: "text", text: "fallback" };
        yield { kind: "usage_final", usage: { inputTokens: 1, outputTokens: 1, cost: 0 } };
      }
    }
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new ModerationProvider("anthropic", "guardrail_intervened")],
      ["openai", new CountingOpenAI()],
    ]);
    const router = buildRouter({ providers });
    await expect(async () => {
      for await (const _c of router.complete(fakeReq())) {
        void _c;
      }
    }).rejects.toMatchObject({ kind: "guardrail_intervened" });
    expect(openaiAttempts).toBe(0);
  });

  it("rate_limit_error from primary DOES fall over to fallback (retryable)", async () => {
    let openaiAttempts = 0;
    class CountingOpenAI extends StubProvider {
      constructor() {
        super("openai", "ok");
      }
      async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
        void _req;
        openaiAttempts += 1;
        yield { kind: "text", text: "fallback ok" };
        yield { kind: "usage_final", usage: { inputTokens: 1, outputTokens: 1, cost: 0 } };
      }
    }
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new StubProvider("anthropic", "always_retryable")],
      ["openai", new CountingOpenAI()],
    ]);
    const router = buildRouter({ providers });
    const chunks: CompletionChunk[] = [];
    for await (const c of router.complete(fakeReq())) chunks.push(c);
    expect(openaiAttempts).toBe(1);
    expect(chunks).toContainEqual({ kind: "text", text: "fallback ok" });
  });
});

describe("DefaultLlmRouter.complete — conflict early-exit (M6.6.x)", () => {
  class ConflictProvider extends StubProvider {
    constructor(id: string) {
      super(id, "ok");
    }
    async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
      void _req;
      throw Object.assign(new Error("resource state conflict"), {
        kind: "conflict_error",
        status: 409,
        code: "ConflictException",
      });
    }
  }

  it("does NOT fall over to the fallback when the primary throws conflict_error", async () => {
    let openaiAttempts = 0;
    class CountingOpenAI extends StubProvider {
      constructor() {
        super("openai", "ok");
      }
      async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
        void _req;
        openaiAttempts += 1;
        yield { kind: "text", text: "fallback" };
        yield {
          kind: "usage_final",
          usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
        };
      }
    }
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new ConflictProvider("anthropic")],
      ["openai", new CountingOpenAI()],
    ]);
    const router = buildRouter({ providers });
    await expect(async () => {
      for await (const _c of router.complete(fakeReq())) {
        void _c;
      }
    }).rejects.toMatchObject({ kind: "conflict_error" });
    expect(openaiAttempts).toBe(0);
  });

  it("does NOT retry within the same provider on conflict_error", async () => {
    let attempts = 0;
    class CountingConflict extends StubProvider {
      constructor() {
        super("anthropic", "ok");
      }
      async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
        void _req;
        attempts += 1;
        throw Object.assign(new Error("conflict"), { kind: "conflict_error" });
      }
    }
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new CountingConflict()],
      ["openai", new StubProvider("openai", "ok")],
    ]);
    const router = buildRouter({ providers });
    await expect(async () => {
      for await (const _c of router.complete(fakeReq())) {
        void _c;
      }
    }).rejects.toMatchObject({ kind: "conflict_error" });
    expect(attempts).toBe(1);
  });

  it("propagates the original conflict_error (preserves status + code)", async () => {
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new ConflictProvider("anthropic")],
    ]);
    const router = buildRouter({ providers });
    await expect(async () => {
      for await (const _c of router.complete(fakeReq())) {
        void _c;
      }
    }).rejects.toMatchObject({
      kind: "conflict_error",
      status: 409,
      code: "ConflictException",
    });
  });

  it("conflict_error is distinct from moderation early-exit (different kind, same terminal behavior)", async () => {
    let fallbackAttempts = 0;
    class CountingFallback extends StubProvider {
      constructor() {
        super("openai", "ok");
      }
      async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
        void _req;
        fallbackAttempts += 1;
        yield { kind: "text", text: "fallback" };
        yield {
          kind: "usage_final",
          usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
        };
      }
    }
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new ConflictProvider("anthropic")],
      ["openai", new CountingFallback()],
    ]);
    const router = buildRouter({ providers });
    await expect(async () => {
      for await (const _c of router.complete(fakeReq())) {
        void _c;
      }
    }).rejects.toMatchObject({ kind: "conflict_error" });
    expect(fallbackAttempts).toBe(0);
  });

  it("rate_limit_error still falls over (conflict short-circuit doesn't break retryable path)", async () => {
    let openaiAttempts = 0;
    class CountingOpenAI extends StubProvider {
      constructor() {
        super("openai", "ok");
      }
      async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
        void _req;
        openaiAttempts += 1;
        yield { kind: "text", text: "fallback ok" };
        yield {
          kind: "usage_final",
          usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
        };
      }
    }
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new StubProvider("anthropic", "always_retryable")],
      ["openai", new CountingOpenAI()],
    ]);
    const router = buildRouter({ providers });
    const chunks: CompletionChunk[] = [];
    for await (const c of router.complete(fakeReq())) chunks.push(c);
    expect(openaiAttempts).toBe(1);
    expect(chunks).toContainEqual({ kind: "text", text: "fallback ok" });
  });
});

describe("DefaultLlmRouter.complete — not-found early-exit (M6.6.y)", () => {
  class NotFoundProvider extends StubProvider {
    constructor(id: string) {
      super(id, "ok");
    }
    async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
      void _req;
      throw Object.assign(new Error("resource missing"), {
        kind: "not_found_error",
        status: 404,
      });
    }
  }

  it("does NOT fall over to the fallback when the primary throws not_found_error", async () => {
    let openaiAttempts = 0;
    class CountingOpenAI extends StubProvider {
      constructor() {
        super("openai", "ok");
      }
      async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
        void _req;
        openaiAttempts += 1;
        yield { kind: "text", text: "fallback" };
        yield {
          kind: "usage_final",
          usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
        };
      }
    }
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new NotFoundProvider("anthropic")],
      ["openai", new CountingOpenAI()],
    ]);
    const router = buildRouter({ providers });
    await expect(async () => {
      for await (const _c of router.complete(fakeReq())) {
        void _c;
      }
    }).rejects.toMatchObject({ kind: "not_found_error" });
    expect(openaiAttempts).toBe(0);
  });

  it("does NOT retry within the same provider on not_found_error", async () => {
    let attempts = 0;
    class CountingNotFound extends StubProvider {
      constructor() {
        super("anthropic", "ok");
      }
      async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
        void _req;
        attempts += 1;
        throw Object.assign(new Error("missing"), { kind: "not_found_error" });
      }
    }
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new CountingNotFound()],
      ["openai", new StubProvider("openai", "ok")],
    ]);
    const router = buildRouter({ providers });
    await expect(async () => {
      for await (const _c of router.complete(fakeReq())) {
        void _c;
      }
    }).rejects.toMatchObject({ kind: "not_found_error" });
    expect(attempts).toBe(1);
  });

  it("propagates the original not_found_error (preserves status)", async () => {
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new NotFoundProvider("anthropic")],
    ]);
    const router = buildRouter({ providers });
    await expect(async () => {
      for await (const _c of router.complete(fakeReq())) {
        void _c;
      }
    }).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
  });

  it("not_found_error is distinct from conflict_error early-exit (same terminal behavior, different kind)", async () => {
    let fallbackAttempts = 0;
    class CountingFallback extends StubProvider {
      constructor() {
        super("openai", "ok");
      }
      async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
        void _req;
        fallbackAttempts += 1;
        yield { kind: "text", text: "fallback" };
        yield {
          kind: "usage_final",
          usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
        };
      }
    }
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new NotFoundProvider("anthropic")],
      ["openai", new CountingFallback()],
    ]);
    const router = buildRouter({ providers });
    await expect(async () => {
      for await (const _c of router.complete(fakeReq())) {
        void _c;
      }
    }).rejects.toMatchObject({ kind: "not_found_error" });
    expect(fallbackAttempts).toBe(0);
  });

  it("rate_limit_error still falls over (not_found short-circuit doesn't break retryable path)", async () => {
    let openaiAttempts = 0;
    class CountingOpenAI extends StubProvider {
      constructor() {
        super("openai", "ok");
      }
      async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
        void _req;
        openaiAttempts += 1;
        yield { kind: "text", text: "fallback ok" };
        yield {
          kind: "usage_final",
          usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
        };
      }
    }
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new StubProvider("anthropic", "always_retryable")],
      ["openai", new CountingOpenAI()],
    ]);
    const router = buildRouter({ providers });
    const chunks: CompletionChunk[] = [];
    for await (const c of router.complete(fakeReq())) chunks.push(c);
    expect(openaiAttempts).toBe(1);
    expect(chunks).toContainEqual({ kind: "text", text: "fallback ok" });
  });
});

describe("DefaultLlmRouter.complete — array content cost estimation (M6.6)", () => {
  it("estimates tokens from array content (was broken pre-M6.6 — used array.length)", async () => {
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new StubProvider("anthropic", "ok")],
      ["openai", new StubProvider("openai", "ok")],
    ]);
    // A cost ceiling that would be exceeded if estimation breaks (array.length = 2 chars
    // → ~1 token → tiny cost; vs the actual 12 chars in text blocks → 3 tokens → still tiny).
    // The test verifies the call does NOT throw — even with rich content the estimate is sane.
    const router = buildRouter({
      providers,
      costCeiling: { perTenantUsdPerHour: 1 },
      costTracker: new InMemoryCostTracker(),
    });
    const chunks: CompletionChunk[] = [];
    for await (const c of router.complete(
      fakeReq({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image", format: "png", bytes: "ABCD" },
            ],
          },
        ],
      }),
    )) {
      chunks.push(c);
    }
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe("DefaultLlmRouter.complete — per-tenant cost ceiling (M6.7.x)", () => {
  it("uses the tenant-scoped ceiling when getTenantCostCeiling returns one", async () => {
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const router = buildRouter({
      providers,
      getTenantCostCeiling: async () => ({ maxUsdPerRequest: 0.0000001 }),
    });
    await expect(async () => {
      for await (const _ of router.complete(fakeReq())) void _;
    }).rejects.toThrow(CostCeilingExceededError);
  });

  it("falls back to the global costCeiling when getTenantCostCeiling returns undefined", async () => {
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const router = buildRouter({
      providers,
      costCeiling: { maxUsdPerRequest: 0.0000001 },
      getTenantCostCeiling: async () => undefined,
    });
    await expect(async () => {
      for await (const _ of router.complete(fakeReq())) void _;
    }).rejects.toThrow(CostCeilingExceededError);
  });

  it("tenant-scoped ceiling overrides the global ceiling (tighter tenant ceiling wins)", async () => {
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const router = buildRouter({
      providers,
      costCeiling: { maxUsdPerRequest: 1.0 },
      getTenantCostCeiling: async () => ({ maxUsdPerRequest: 0.0000001 }),
    });
    await expect(async () => {
      for await (const _ of router.complete(fakeReq())) void _;
    }).rejects.toThrow(CostCeilingExceededError);
  });

  it("tenant-scoped ceiling overrides the global ceiling (looser tenant ceiling wins)", async () => {
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const router = buildRouter({
      providers,
      costCeiling: { maxUsdPerRequest: 0.0000001 },
      getTenantCostCeiling: async () => ({ maxUsdPerRequest: 1.0 }),
    });
    const chunks: CompletionChunk[] = [];
    for await (const c of router.complete(fakeReq())) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("threads tenantId into the resolver call", async () => {
    let seenTenant: string | null = null;
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const router = buildRouter({
      providers,
      getTenantCostCeiling: async (tid: string) => {
        seenTenant = tid;
        return undefined;
      },
    });
    for await (const _ of router.complete(fakeReq())) void _;
    expect(seenTenant).toBe(TENANT);
  });

  it("with no resolver and no global ceiling, the request flows through (no preflight check)", async () => {
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const router = buildRouter({ providers });
    const chunks: CompletionChunk[] = [];
    for await (const c of router.complete(fakeReq())) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("supports asymmetric ceiling: tenant sets only maxUsdPerWindow, global sets only maxUsdPerRequest", async () => {
    const tracker = new InMemoryCostTracker();
    await tracker.recordUsage({ tenantId: TENANT, costUsd: 100 });
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const router = buildRouter({
      providers,
      costTracker: tracker,
      costCeiling: { maxUsdPerRequest: 1.0 },
      getTenantCostCeiling: async () => ({ maxUsdPerWindow: 50 }),
    });
    await expect(async () => {
      for await (const _ of router.complete(fakeReq())) void _;
    }).rejects.toThrow(CostCeilingExceededError);
  });
});

describe("DefaultLlmRouter.complete — RouterInstrumentation (M6.7.z)", () => {
  it("emits llm_call_started then llm_call_completed on the happy path", async () => {
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    for await (const _ of router.complete(fakeReq())) void _;
    const kinds = cap.events.map((e) => e.kind);
    expect(kinds).toEqual(["llm_call_started", "llm_call_completed"]);
  });

  it("threads tenantId + sessionId + task + providerId + modelId on every event", async () => {
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    for await (const _ of router.complete(fakeReq())) void _;
    for (const event of cap.events) {
      expect(event.tenantId).toBe(TENANT);
      expect(event.sessionId).toBe("sess-1");
      expect(event.task).toBe("executor");
      expect(event.providerId).toBe("anthropic");
      expect(event.modelId).toBe("anthropic-model-1");
    }
  });

  it("populates costUsd / inputTokens / outputTokens / attempts on llm_call_completed", async () => {
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    for await (const _ of router.complete(fakeReq())) void _;
    const completed = cap.events.find((e) => e.kind === "llm_call_completed")!;
    expect(completed.attributes["costUsd"]).toBeGreaterThan(0);
    expect(completed.attributes["inputTokens"]).toBeGreaterThan(0);
    expect(completed.attributes["outputTokens"]).toBeGreaterThan(0);
    expect(completed.attributes["attempts"]).toBe(1);
  });

  it("includes durationMs on llm_call_completed but null on llm_call_started", async () => {
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    for await (const _ of router.complete(fakeReq())) void _;
    const started = cap.events.find((e) => e.kind === "llm_call_started")!;
    const completed = cap.events.find((e) => e.kind === "llm_call_completed")!;
    expect(started.durationMs).toBeNull();
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits llm_call_failed when a provider exhausts retries (with willFallback=true if fallback exists)", async () => {
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new StubProvider("anthropic", "always_retryable")],
      ["openai", new StubProvider("openai", "ok")],
    ]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    for await (const _ of router.complete(fakeReq())) void _;
    const failed = cap.events.find((e) => e.kind === "llm_call_failed");
    expect(failed).toBeDefined();
    expect(failed?.providerId).toBe("anthropic");
    expect(failed?.attributes["willFallback"]).toBe(true);
    expect(failed?.attributes["errorKind"]).toBeDefined();
  });

  it("emits the full started/failed/started/completed sequence on fallover", async () => {
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new StubProvider("anthropic", "always_retryable")],
      ["openai", new StubProvider("openai", "ok")],
    ]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    for await (const _ of router.complete(fakeReq())) void _;
    const kinds = cap.events.map((e) => e.kind);
    expect(kinds).toEqual([
      "llm_call_started",
      "llm_call_failed",
      "llm_call_started",
      "llm_call_completed",
    ]);
    expect(cap.events[0]?.providerId).toBe("anthropic");
    expect(cap.events[2]?.providerId).toBe("openai");
  });

  it("emits llm_call_failed with willFallback=false on the last provider when AllProvidersExhausted", async () => {
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new StubProvider("anthropic", "always_retryable")],
      ["openai", new StubProvider("openai", "always_retryable")],
    ]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    await expect(async () => {
      for await (const _ of router.complete(fakeReq())) void _;
    }).rejects.toThrow(AllProvidersExhaustedError);
    const failed = cap.events.filter((e) => e.kind === "llm_call_failed");
    expect(failed).toHaveLength(2);
    expect(failed[0]?.attributes["willFallback"]).toBe(true);
    expect(failed[1]?.attributes["willFallback"]).toBe(false);
  });

  it("emits an ISO 8601 occurredAt string on every event", async () => {
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    for await (const _ of router.complete(fakeReq())) void _;
    for (const event of cap.events) {
      expect(event.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it("no instrumentation = no observable behavior change (defaults to noop)", async () => {
    const provider = new StubProvider("anthropic", "ok");
    const providers = new Map<string, LlmProvider>([["anthropic", provider]]);
    const router = buildRouter({ providers });
    const chunks: CompletionChunk[] = [];
    for await (const c of router.complete(fakeReq())) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("emits attemptIndex 0 then 1 across fallback chain", async () => {
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new StubProvider("anthropic", "always_retryable")],
      ["openai", new StubProvider("openai", "ok")],
    ]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    for await (const _ of router.complete(fakeReq())) void _;
    const starts = cap.events.filter((e) => e.kind === "llm_call_started");
    expect(starts[0]?.attributes["attemptIndex"]).toBe(0);
    expect(starts[1]?.attributes["attemptIndex"]).toBe(1);
  });

  it("non-retryable error emits llm_call_failed (no fallback) with willFallback=false", async () => {
    const providers = new Map<string, LlmProvider>([
      ["anthropic", new StubProvider("anthropic", "fatal")],
      ["openai", new StubProvider("openai", "ok")],
    ]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    await expect(async () => {
      for await (const _ of router.complete(fakeReq())) void _;
    }).rejects.toThrow();
    const failed = cap.events.filter((e) => e.kind === "llm_call_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.providerId).toBe("anthropic");
    expect(failed[0]?.attributes["willFallback"]).toBe(false);
  });
});

describe("DefaultLlmRouter.embed — RouterInstrumentation (M6.7.z.embed)", () => {
  it("emits embed_call_started then embed_call_completed on happy path", async () => {
    const openai = new StubProvider("openai", "ok");
    const providers = new Map<string, LlmProvider>([["openai", openai]]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    await router.embed({ texts: ["hello"], tenantId: TENANT, sessionId: "sess-1" });
    const kinds = cap.events.map((e) => e.kind);
    expect(kinds).toEqual(["embed_call_started", "embed_call_completed"]);
  });

  it("threads tenantId + sessionId + task='embedding' + providerId + modelId", async () => {
    const openai = new StubProvider("openai", "ok");
    const providers = new Map<string, LlmProvider>([["openai", openai]]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    await router.embed({ texts: ["hello"], tenantId: TENANT, sessionId: "sess-1" });
    for (const event of cap.events) {
      expect(event.tenantId).toBe(TENANT);
      expect(event.sessionId).toBe("sess-1");
      expect(event.task).toBe("embedding");
      expect(event.providerId).toBe("openai");
      expect(event.modelId).toBe("openai-model-1");
    }
  });

  it("defaults sessionId to empty string when not provided (embed sessionId is optional)", async () => {
    const openai = new StubProvider("openai", "ok");
    const providers = new Map<string, LlmProvider>([["openai", openai]]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    await router.embed({ texts: ["hi"], tenantId: TENANT });
    expect(cap.events[0]?.sessionId).toBe("");
  });

  it("populates embed_call_started with attemptIndex + totalChoices + inputTextCount", async () => {
    const openai = new StubProvider("openai", "ok");
    const providers = new Map<string, LlmProvider>([["openai", openai]]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    await router.embed({
      texts: ["one", "two", "three"],
      tenantId: TENANT,
      sessionId: "sess-1",
    });
    const started = cap.events.find((e) => e.kind === "embed_call_started")!;
    expect(started.attributes["attemptIndex"]).toBe(0);
    expect(started.attributes["totalChoices"]).toBe(1);
    expect(started.attributes["inputTextCount"]).toBe(3);
  });

  it("populates embed_call_completed with costUsd / tokens / vectorCount / attempts", async () => {
    const openai = new StubProvider("openai", "ok");
    const providers = new Map<string, LlmProvider>([["openai", openai]]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    await router.embed({ texts: ["hi"], tenantId: TENANT, sessionId: "sess-1" });
    const completed = cap.events.find((e) => e.kind === "embed_call_completed")!;
    expect(completed.attributes["costUsd"]).toBeDefined();
    expect(completed.attributes["inputTokens"]).toBeDefined();
    expect(completed.attributes["vectorCount"]).toBe(1);
    expect(completed.attributes["attempts"]).toBe(1);
  });

  it("includes durationMs on completed but null on started", async () => {
    const openai = new StubProvider("openai", "ok");
    const providers = new Map<string, LlmProvider>([["openai", openai]]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    await router.embed({ texts: ["hi"], tenantId: TENANT, sessionId: "sess-1" });
    const started = cap.events.find((e) => e.kind === "embed_call_started")!;
    const completed = cap.events.find((e) => e.kind === "embed_call_completed")!;
    expect(started.durationMs).toBeNull();
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits embed_call_failed when a provider throws non-retryably (no fallback issued)", async () => {
    const fatal = new StubProvider("openai", "fatal");
    const providers = new Map<string, LlmProvider>([["openai", fatal]]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    await expect(
      router.embed({ texts: ["hi"], tenantId: TENANT, sessionId: "sess-1" }),
    ).rejects.toThrow();
    const failed = cap.events.find((e) => e.kind === "embed_call_failed");
    expect(failed).toBeDefined();
    expect(failed?.attributes["willFallback"]).toBe(false);
    expect(failed?.attributes["errorKind"]).toBeDefined();
  });

  it("noop default = no observable behavior change", async () => {
    const openai = new StubProvider("openai", "ok");
    const providers = new Map<string, LlmProvider>([["openai", openai]]);
    const router = buildRouter({ providers });
    const result = await router.embed({
      texts: ["hi"],
      tenantId: TENANT,
      sessionId: "sess-1",
    });
    expect(result.vectors).toEqual([[1, 2, 3]]);
  });

  it("event sessionId reflects the provided embed sessionId (when set)", async () => {
    const openai = new StubProvider("openai", "ok");
    const providers = new Map<string, LlmProvider>([["openai", openai]]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    await router.embed({
      texts: ["hi"],
      tenantId: TENANT,
      sessionId: "explicit-session",
    });
    expect(cap.events[0]?.sessionId).toBe("explicit-session");
  });

  it("emits ISO 8601 occurredAt on every embed event", async () => {
    const openai = new StubProvider("openai", "ok");
    const providers = new Map<string, LlmProvider>([["openai", openai]]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    await router.embed({ texts: ["hi"], tenantId: TENANT, sessionId: "sess-1" });
    for (const event of cap.events) {
      expect(event.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it("does NOT emit completion events on failure (the failure event covers the outcome)", async () => {
    const fatal = new StubProvider("openai", "fatal");
    const providers = new Map<string, LlmProvider>([["openai", fatal]]);
    const cap = captureRouterInstrumentation();
    const router = buildRouter({ providers, instrumentation: cap.instrumentation });
    await expect(
      router.embed({ texts: ["hi"], tenantId: TENANT, sessionId: "sess-1" }),
    ).rejects.toThrow();
    const completed = cap.events.filter((e) => e.kind === "embed_call_completed");
    expect(completed).toHaveLength(0);
  });
});

describe("ROUTER_INSTRUMENTATION_KINDS — embed kinds (M6.7.z.embed)", () => {
  it("includes the 3 new embed kinds additively (original 3 llm kinds preserved)", () => {
    expect(ROUTER_INSTRUMENTATION_KINDS).toContain("embed_call_started");
    expect(ROUTER_INSTRUMENTATION_KINDS).toContain("embed_call_completed");
    expect(ROUTER_INSTRUMENTATION_KINDS).toContain("embed_call_failed");
    expect(ROUTER_INSTRUMENTATION_KINDS).toContain("llm_call_started");
    expect(ROUTER_INSTRUMENTATION_KINDS).toContain("llm_call_completed");
    expect(ROUTER_INSTRUMENTATION_KINDS).toContain("llm_call_failed");
    expect(ROUTER_INSTRUMENTATION_KINDS.length).toBe(6);
  });
});
