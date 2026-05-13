import { describe, expect, it } from "vitest";
import {
  CompletionChunkSchema,
  CompletionRequestSchema,
  CostTelemetryRecordSchema,
  EmbeddingRequestSchema,
  EmbeddingResponseSchema,
  NormalizedCompletionSchema,
  ProviderCapabilitiesSchema,
  ProviderPricingSchema,
  RegionSchema,
  TaskKindSchema,
  TaskPolicySchema,
  TenantResidencySchema,
} from "./types.js";

describe("RegionSchema", () => {
  it.each(["eu", "us", "me", "ap", "sa"])("accepts %s", (r) => {
    expect(RegionSchema.parse(r)).toBe(r);
  });

  it("rejects unknown region", () => {
    expect(() => RegionSchema.parse("antarctica")).toThrow();
  });
});

describe("TaskKindSchema", () => {
  it.each([
    "planner",
    "executor",
    "summarizer",
    "diff-narrator",
    "embedding",
    "rerank",
    "classifier",
  ])("accepts %s", (k) => {
    expect(TaskKindSchema.parse(k)).toBe(k);
  });

  it("rejects unknown task", () => {
    expect(() => TaskKindSchema.parse("brainstormer")).toThrow();
  });
});

describe("TenantResidencySchema", () => {
  it.each(["unrestricted", "eu-only", "us-only", "me-only"])("accepts %s", (r) => {
    expect(TenantResidencySchema.parse(r)).toBe(r);
  });
});

describe("ProviderCapabilitiesSchema", () => {
  it("parses a complete capabilities object", () => {
    const c = {
      chat: true,
      toolUse: true,
      streaming: true,
      jsonMode: true,
      embedding: false,
      maxContextTokens: 200_000,
      supportsThinking: false,
    };
    expect(ProviderCapabilitiesSchema.parse(c)).toEqual(c);
  });

  it("rejects non-positive maxContextTokens", () => {
    expect(() =>
      ProviderCapabilitiesSchema.parse({
        chat: true,
        toolUse: true,
        streaming: true,
        jsonMode: true,
        embedding: true,
        maxContextTokens: 0,
        supportsThinking: false,
      }),
    ).toThrow();
  });
});

describe("ProviderPricingSchema", () => {
  it("parses with cached pricing", () => {
    const p = {
      inputPerMillionTokens: 0.2,
      outputPerMillionTokens: 0.6,
      cachedInputPerMillionTokens: 0.05,
    };
    expect(ProviderPricingSchema.parse(p)).toEqual(p);
  });

  it("parses without cached pricing", () => {
    const p = { inputPerMillionTokens: 0.2, outputPerMillionTokens: 0.6 };
    expect(ProviderPricingSchema.parse(p)).toEqual(p);
  });

  it("rejects negative pricing", () => {
    expect(() =>
      ProviderPricingSchema.parse({
        inputPerMillionTokens: -0.1,
        outputPerMillionTokens: 0.6,
      }),
    ).toThrow();
  });
});

describe("TaskPolicySchema", () => {
  it("parses primary + fallback chain", () => {
    const p = { primary: "fireworks:qwen3-72b", fallback: ["together:qwen3-72b"] };
    expect(TaskPolicySchema.parse(p)).toEqual(p);
  });

  it("parses primary + empty fallback", () => {
    const p = { primary: "self-hosted-bge:bge-m3", fallback: [] };
    expect(TaskPolicySchema.parse(p)).toEqual(p);
  });
});

describe("CompletionRequestSchema", () => {
  it("parses a minimal request", () => {
    const req = {
      task: "planner" as const,
      messages: [{ role: "user" as const, content: "hi" }],
      tenantId: "t",
      sessionId: "s",
    };
    expect(CompletionRequestSchema.parse(req)).toEqual(req);
  });

  it("parses a request with tools, cacheControl, and temperature", () => {
    const req = {
      task: "executor" as const,
      messages: [{ role: "system" as const, content: "..." }, { role: "user" as const, content: "..." }],
      tools: [{ name: "x", description: "y", inputSchema: {} }],
      cacheControl: { systemPrompt: "stable" },
      temperature: 0.2,
      jsonMode: true,
      tenantId: "t",
      sessionId: "s",
    };
    expect(CompletionRequestSchema.parse(req)).toEqual(req);
  });

  it("rejects an empty messages array", () => {
    expect(() =>
      CompletionRequestSchema.parse({
        task: "planner",
        messages: [],
        tenantId: "t",
        sessionId: "s",
      }),
    ).toThrow();
  });

  it("rejects temperature out of range", () => {
    expect(() =>
      CompletionRequestSchema.parse({
        task: "planner",
        messages: [{ role: "user", content: "x" }],
        temperature: 3,
        tenantId: "t",
        sessionId: "s",
      }),
    ).toThrow();
  });
});

describe("CompletionChunkSchema", () => {
  it("parses each chunk variant", () => {
    expect(() => CompletionChunkSchema.parse({ kind: "text", text: "hi" })).not.toThrow();
    expect(() =>
      CompletionChunkSchema.parse({ kind: "tool_call_start", id: "a", name: "foo" }),
    ).not.toThrow();
    expect(() =>
      CompletionChunkSchema.parse({ kind: "tool_call_arg_delta", id: "a", delta: '{"x"' }),
    ).not.toThrow();
    expect(() =>
      CompletionChunkSchema.parse({ kind: "tool_call_end", id: "a" }),
    ).not.toThrow();
    expect(() =>
      CompletionChunkSchema.parse({
        kind: "usage_final",
        usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      }),
    ).not.toThrow();
  });

  it("rejects unknown chunk kind", () => {
    expect(() =>
      CompletionChunkSchema.parse({ kind: "magic", text: "x" }),
    ).toThrow();
  });
});

describe("NormalizedCompletionSchema", () => {
  it("parses text-only completion", () => {
    expect(() =>
      NormalizedCompletionSchema.parse({
        text: "hello",
        usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      }),
    ).not.toThrow();
  });

  it("parses tool-call-only completion", () => {
    expect(() =>
      NormalizedCompletionSchema.parse({
        toolCalls: [{ id: "x", name: "foo", arguments: { y: 1 } }],
        usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      }),
    ).not.toThrow();
  });
});

describe("EmbeddingRequestSchema / EmbeddingResponseSchema", () => {
  it("parses a minimal embedding request", () => {
    expect(() =>
      EmbeddingRequestSchema.parse({ texts: ["hello"], tenantId: "t" }),
    ).not.toThrow();
  });

  it("rejects empty texts array", () => {
    expect(() => EmbeddingRequestSchema.parse({ texts: [], tenantId: "t" })).toThrow();
  });

  it("parses an embedding response", () => {
    expect(() =>
      EmbeddingResponseSchema.parse({
        vectors: [[0.1, 0.2]],
        dim: 2,
        model: "m",
        usage: { inputTokens: 5, outputTokens: 0, cost: 0 },
      }),
    ).not.toThrow();
  });
});

describe("CostTelemetryRecordSchema", () => {
  it("parses a complete record", () => {
    expect(() =>
      CostTelemetryRecordSchema.parse({
        tenantId: "t",
        sessionId: "s",
        taskKind: "planner",
        providerId: "fireworks",
        modelId: "qwen3-72b",
        inputTokens: 4521,
        outputTokens: 312,
        cachedInputTokens: 3800,
        costUsd: 0.0028,
        latencyMs: 1832,
        ok: true,
        occurredAt: "2026-05-12T00:00:00Z",
      }),
    ).not.toThrow();
  });

  it("parses a failure record", () => {
    expect(() =>
      CostTelemetryRecordSchema.parse({
        tenantId: "t",
        taskKind: "planner",
        providerId: "fireworks",
        modelId: "qwen3-72b",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 5000,
        ok: false,
        errorMessage: "timeout",
        occurredAt: "2026-05-12T00:00:00Z",
      }),
    ).not.toThrow();
  });
});
