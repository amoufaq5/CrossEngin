import { describe, expect, it } from "vitest";
import {
  aggregateChunks,
  computeCost,
  makeTelemetryRecord,
  providerSatisfiesResidency,
} from "./helpers.js";
import { MockLlmProvider } from "./mock.js";
import type { CompletionChunk } from "./types.js";

async function* stream(...chunks: CompletionChunk[]): AsyncIterable<CompletionChunk> {
  for (const c of chunks) yield c;
}

describe("aggregateChunks", () => {
  it("returns just usage for an empty stream", async () => {
    const result = await aggregateChunks(
      stream({
        kind: "usage_final",
        usage: { inputTokens: 10, outputTokens: 0, cost: 0.001 },
      }),
    );
    expect(result.text).toBeUndefined();
    expect(result.toolCalls).toBeUndefined();
    expect(result.usage.inputTokens).toBe(10);
  });

  it("concatenates text chunks", async () => {
    const result = await aggregateChunks(
      stream(
        { kind: "text", text: "Hello, " },
        { kind: "text", text: "world." },
        { kind: "usage_final", usage: { inputTokens: 5, outputTokens: 5, cost: 0 } },
      ),
    );
    expect(result.text).toBe("Hello, world.");
  });

  it("assembles a tool call from start + arg deltas + end", async () => {
    const result = await aggregateChunks(
      stream(
        { kind: "tool_call_start", id: "c1", name: "askUser" },
        { kind: "tool_call_arg_delta", id: "c1", delta: '{"que' },
        { kind: "tool_call_arg_delta", id: "c1", delta: 'stion":"Which industry?"}' },
        { kind: "tool_call_end", id: "c1" },
        { kind: "usage_final", usage: { inputTokens: 5, outputTokens: 5, cost: 0 } },
      ),
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.name).toBe("askUser");
    expect(result.toolCalls?.[0]?.arguments).toEqual({ question: "Which industry?" });
  });

  it("handles a mix of text and tool calls", async () => {
    const result = await aggregateChunks(
      stream(
        { kind: "text", text: "Calling tool..." },
        { kind: "tool_call_start", id: "c1", name: "foo" },
        { kind: "tool_call_arg_delta", id: "c1", delta: "{}" },
        { kind: "tool_call_end", id: "c1" },
        { kind: "usage_final", usage: { inputTokens: 1, outputTokens: 1, cost: 0 } },
      ),
    );
    expect(result.text).toBe("Calling tool...");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("assembles two parallel tool calls", async () => {
    const result = await aggregateChunks(
      stream(
        { kind: "tool_call_start", id: "a", name: "foo" },
        { kind: "tool_call_start", id: "b", name: "bar" },
        { kind: "tool_call_arg_delta", id: "a", delta: "{}" },
        { kind: "tool_call_arg_delta", id: "b", delta: "{}" },
        { kind: "tool_call_end", id: "a" },
        { kind: "tool_call_end", id: "b" },
        { kind: "usage_final", usage: { inputTokens: 1, outputTokens: 1, cost: 0 } },
      ),
    );
    expect(result.toolCalls?.map((c) => c.name)).toEqual(["foo", "bar"]);
  });
});

describe("computeCost", () => {
  it("computes input + output cost without caching", () => {
    const cost = computeCost(
      { inputPerMillionTokens: 1, outputPerMillionTokens: 5 },
      1_000_000,
      100_000,
    );
    expect(cost).toBeCloseTo(1 + 0.5);
  });

  it("subtracts cached input from regular input and applies cached pricing", () => {
    const cost = computeCost(
      {
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 5,
        cachedInputPerMillionTokens: 0.1,
      },
      1_000_000,
      0,
      800_000,
    );
    // regular = 200_000 @ $1/M  = 0.20
    // cached  = 800_000 @ $0.10/M = 0.08
    expect(cost).toBeCloseTo(0.28);
  });

  it("ignores cached input when pricing does not declare cachedInputPerMillionTokens", () => {
    const cost = computeCost(
      { inputPerMillionTokens: 1, outputPerMillionTokens: 5 },
      1_000_000,
      0,
      800_000,
    );
    expect(cost).toBeCloseTo(1);
  });

  it("returns 0 for zero tokens", () => {
    expect(
      computeCost({ inputPerMillionTokens: 1, outputPerMillionTokens: 5 }, 0, 0),
    ).toBe(0);
  });
});

describe("providerSatisfiesResidency", () => {
  const euProvider = new MockLlmProvider({ id: "eu-only", residency: ["eu"] });
  const usProvider = new MockLlmProvider({ id: "us-only", residency: ["us"] });
  const globalProvider = new MockLlmProvider({ id: "global", residency: ["eu", "us", "me"] });

  it("unrestricted accepts any provider", () => {
    expect(providerSatisfiesResidency(euProvider, "unrestricted")).toBe(true);
    expect(providerSatisfiesResidency(usProvider, "unrestricted")).toBe(true);
  });

  it("eu-only only accepts EU providers", () => {
    expect(providerSatisfiesResidency(euProvider, "eu-only")).toBe(true);
    expect(providerSatisfiesResidency(usProvider, "eu-only")).toBe(false);
    expect(providerSatisfiesResidency(globalProvider, "eu-only")).toBe(true);
  });

  it("us-only only accepts US providers", () => {
    expect(providerSatisfiesResidency(usProvider, "us-only")).toBe(true);
    expect(providerSatisfiesResidency(euProvider, "us-only")).toBe(false);
  });

  it("me-only only accepts ME providers", () => {
    expect(providerSatisfiesResidency(globalProvider, "me-only")).toBe(true);
    expect(providerSatisfiesResidency(euProvider, "me-only")).toBe(false);
  });
});

describe("makeTelemetryRecord", () => {
  it("constructs a complete record with all fields populated", () => {
    const record = makeTelemetryRecord(
      { tenantId: "t1", sessionId: "s1", task: "planner" },
      {
        providerId: "fireworks",
        modelId: "qwen3-72b",
        usage: { inputTokens: 4521, outputTokens: 312, cachedInputTokens: 3800, cost: 0.0028 },
        ok: true,
        latencyMs: 1832,
      },
      new Date("2026-05-12T14:33:18Z"),
    );
    expect(record).toEqual({
      tenantId: "t1",
      sessionId: "s1",
      taskKind: "planner",
      providerId: "fireworks",
      modelId: "qwen3-72b",
      inputTokens: 4521,
      outputTokens: 312,
      cachedInputTokens: 3800,
      costUsd: 0.0028,
      latencyMs: 1832,
      ok: true,
      occurredAt: "2026-05-12T14:33:18.000Z",
    });
  });

  it("omits sessionId and cachedInputTokens when not provided", () => {
    const record = makeTelemetryRecord(
      { tenantId: "t1", task: "planner" },
      {
        providerId: "fireworks",
        modelId: "qwen3-72b",
        usage: { inputTokens: 100, outputTokens: 50, cost: 0 },
        ok: true,
        latencyMs: 200,
      },
      new Date("2026-05-12T00:00:00Z"),
    );
    expect(record.sessionId).toBeUndefined();
    expect(record.cachedInputTokens).toBeUndefined();
  });

  it("records error message on failure", () => {
    const record = makeTelemetryRecord(
      { tenantId: "t1", task: "planner" },
      {
        providerId: "fireworks",
        modelId: "qwen3-72b",
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        ok: false,
        latencyMs: 5000,
        errorMessage: "timeout",
      },
    );
    expect(record.ok).toBe(false);
    expect(record.errorMessage).toBe("timeout");
  });
});
