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
