import type { CompletionChunk } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";
import { chunksFromSse, parseSseDataPayloads, readSseStream } from "./streaming.js";

const TEXT_STREAM = `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":4}}}

data: [DONE]

`;

const TOOL_STREAM = `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":""}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":"}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":8}}

data: [DONE]

`;

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("parseSseDataPayloads", () => {
  it("extracts data payloads, ignoring blank blocks", () => {
    const payloads = parseSseDataPayloads(TEXT_STREAM);
    expect(payloads[payloads.length - 1]).toBe("[DONE]");
    expect(payloads.length).toBe(6);
  });
});

describe("chunksFromSse — text", () => {
  it("yields text chunks then a usage_final", () => {
    const chunks = [...chunksFromSse(TEXT_STREAM, "gpt-4o")];
    const texts = chunks.filter((c): c is Extract<CompletionChunk, { kind: "text" }> => c.kind === "text");
    expect(texts.map((t) => t.text).join("")).toBe("Hello there");
    const final = chunks.at(-1);
    expect(final?.kind).toBe("usage_final");
    if (final?.kind === "usage_final") {
      expect(final.usage.inputTokens).toBe(12);
      expect(final.usage.outputTokens).toBe(3);
      expect(final.usage.cachedInputTokens).toBe(4);
      expect(final.usage.cost).toBeGreaterThan(0);
    }
  });
});

describe("chunksFromSse — tool calls", () => {
  it("assembles start / arg deltas / end and reconstructs JSON", () => {
    const chunks = [...chunksFromSse(TOOL_STREAM, "gpt-4o")];
    const start = chunks.find((c) => c.kind === "tool_call_start");
    expect(start).toEqual({ kind: "tool_call_start", id: "call_1", name: "lookup" });
    const args = chunks
      .filter((c): c is Extract<CompletionChunk, { kind: "tool_call_arg_delta" }> => c.kind === "tool_call_arg_delta")
      .map((c) => c.delta)
      .join("");
    expect(JSON.parse(args)).toEqual({ q: "x" });
    expect(chunks.some((c) => c.kind === "tool_call_end")).toBe(true);
    expect(chunks.at(-1)?.kind).toBe("usage_final");
  });
});

describe("readSseStream", () => {
  it("streams chunks across read boundaries with a final usage", async () => {
    const chunks: CompletionChunk[] = [];
    for await (const chunk of readSseStream(streamFrom(TEXT_STREAM), "gpt-4o-mini")) {
      chunks.push(chunk);
    }
    expect(chunks.filter((c) => c.kind === "text")).toHaveLength(2);
    expect(chunks.at(-1)?.kind).toBe("usage_final");
  });

  it("survives a mid-event chunk split", async () => {
    const bytes = new TextEncoder().encode(TEXT_STREAM);
    const mid = Math.floor(bytes.length / 2);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
        controller.close();
      },
    });
    const chunks: CompletionChunk[] = [];
    for await (const chunk of readSseStream(body, "gpt-4o")) chunks.push(chunk);
    const texts = chunks.filter((c): c is Extract<CompletionChunk, { kind: "text" }> => c.kind === "text");
    expect(texts.map((t) => t.text).join("")).toBe("Hello there");
  });
});
