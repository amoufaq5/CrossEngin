import { describe, expect, it } from "vitest";
import { aggregateChunks } from "./helpers.js";
import { MockLlmProvider } from "./mock.js";
import type { CompletionChunk, CompletionRequest, EmbeddingRequest } from "./types.js";

const baseCompletionReq: CompletionRequest = {
  task: "planner",
  messages: [{ role: "user", content: "hi" }],
  tenantId: "t",
  sessionId: "s",
};

const baseEmbeddingReq: EmbeddingRequest = {
  texts: ["hello", "world"],
  tenantId: "t",
};

describe("MockLlmProvider — defaults", () => {
  it("constructs with sensible defaults", () => {
    const p = new MockLlmProvider();
    expect(p.id).toBe("mock");
    expect(p.models).toEqual(["mock-model"]);
    expect(p.capabilities.chat).toBe(true);
    expect(p.residency).toContain("eu");
    expect(p.pricing.inputPerMillionTokens).toBe(0);
  });

  it("accepts overrides", () => {
    const p = new MockLlmProvider({
      id: "test-provider",
      models: ["a", "b"],
      capabilities: { embedding: false },
      residency: ["us"],
      pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 5 },
    });
    expect(p.id).toBe("test-provider");
    expect(p.models).toEqual(["a", "b"]);
    expect(p.capabilities.embedding).toBe(false);
    expect(p.capabilities.chat).toBe(true);
    expect(p.residency).toEqual(["us"]);
  });
});

describe("MockLlmProvider — complete()", () => {
  it("yields a text chunk + usage_final by default", async () => {
    const p = new MockLlmProvider();
    const result = await aggregateChunks(p.complete(baseCompletionReq));
    expect(result.text).toBe("mock response");
    expect(result.usage.inputTokens).toBe(100);
  });

  it("uses completeBehavior override when provided", async () => {
    async function* customStream(): AsyncIterable<CompletionChunk> {
      yield { kind: "text", text: "custom" };
      yield {
        kind: "usage_final",
        usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      };
    }
    const p = new MockLlmProvider({ completeBehavior: () => customStream() });
    const result = await aggregateChunks(p.complete(baseCompletionReq));
    expect(result.text).toBe("custom");
  });

  it("throws errorOnComplete when configured", () => {
    const p = new MockLlmProvider({
      errorOnComplete: new Error("provider down"),
    });
    expect(() => p.complete(baseCompletionReq)).toThrow("provider down");
  });
});

describe("MockLlmProvider — embed()", () => {
  it("returns zero vectors of dim 16 by default", async () => {
    const p = new MockLlmProvider();
    const result = await p.embed(baseEmbeddingReq);
    expect(result.dim).toBe(16);
    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toHaveLength(16);
    expect(result.vectors[0]).toEqual(new Array(16).fill(0));
  });

  it("uses embedBehavior override when provided", async () => {
    const p = new MockLlmProvider({
      async embedBehavior(req) {
        return {
          vectors: req.texts.map(() => [1, 2, 3]),
          dim: 3,
          model: "custom",
          usage: { inputTokens: 1, outputTokens: 0, cost: 0 },
        };
      },
    });
    const result = await p.embed(baseEmbeddingReq);
    expect(result.dim).toBe(3);
    expect(result.vectors[0]).toEqual([1, 2, 3]);
  });

  it("rejects with errorOnEmbed when configured", async () => {
    const p = new MockLlmProvider({
      errorOnEmbed: new Error("embedding service down"),
    });
    await expect(p.embed(baseEmbeddingReq)).rejects.toThrow("embedding service down");
  });
});
