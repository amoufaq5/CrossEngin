import type { CompletionChunk } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import { chunksFromSse, parseSseEvents } from "./streaming.js";

const TEXT_STREAM = [
  `data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}`,
  `data: {"choices":[{"delta":{"content":" there"},"finish_reason":null}]}`,
  `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
  `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}`,
  `data: [DONE]`,
  ``,
].join("\n\n");

const TOOL_STREAM = [
  `data: {"choices":[{"delta":{"role":"assistant","content":null}}]}`,
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":""}}]}}]}`,
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":"}}]}}]}`,
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"openai\\"}"}}]}}]}`,
  `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
  `data: {"usage":{"prompt_tokens":15,"completion_tokens":7,"total_tokens":22}}`,
  `data: [DONE]`,
  ``,
].join("\n\n");

describe("parseSseEvents", () => {
  it("splits on \\n\\n and extracts data lines", () => {
    const events = parseSseEvents(`data: hello\n\ndata: world\n\n`);
    expect(events).toHaveLength(2);
    expect(events[0]?.data).toBe("hello");
    expect(events[1]?.data).toBe("world");
  });

  it("ignores blocks without data:", () => {
    const events = parseSseEvents(`event: foo\nid: 1\n\ndata: x\n\n`);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("x");
  });

  it("handles \\r\\n line endings", () => {
    const events = parseSseEvents(`data: a\r\n\r\ndata: b\r\n\r\n`);
    expect(events).toHaveLength(2);
  });
});

describe("chunksFromSse — text stream", () => {
  it("yields one text chunk per delta.content", () => {
    const chunks = [...chunksFromSse(TEXT_STREAM, "gpt-4o-mini")];
    const texts = chunks.filter((c) => c.kind === "text");
    expect(texts.map((c) => (c.kind === "text" ? c.text : ""))).toEqual([
      "Hello",
      " there",
    ]);
  });

  it("emits a usage_final at the end with cost computed", () => {
    const chunks = [...chunksFromSse(TEXT_STREAM, "gpt-4o-mini")];
    const usage = chunks.find((c) => c.kind === "usage_final");
    expect(usage?.kind).toBe("usage_final");
    if (usage?.kind === "usage_final") {
      expect(usage.usage.inputTokens).toBe(10);
      expect(usage.usage.outputTokens).toBe(2);
      expect(usage.usage.cost).toBeGreaterThan(0);
    }
  });

  it("skips [DONE] markers without trying to parse them as JSON", () => {
    const chunks = [...chunksFromSse(TEXT_STREAM, "gpt-4o-mini")];
    // No error thrown; chunks present.
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe("chunksFromSse — tool-call stream", () => {
  it("yields tool_call_start once with id + name", () => {
    const chunks = [...chunksFromSse(TOOL_STREAM, "gpt-4o-mini")];
    const starts = chunks.filter((c) => c.kind === "tool_call_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.kind).toBe("tool_call_start");
    if (starts[0]?.kind === "tool_call_start") {
      expect(starts[0].id).toBe("call_1");
      expect(starts[0].name).toBe("search");
    }
  });

  it("yields tool_call_arg_delta for each argument fragment", () => {
    const chunks = [...chunksFromSse(TOOL_STREAM, "gpt-4o-mini")];
    const deltas = chunks.filter((c) => c.kind === "tool_call_arg_delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    const joined = deltas
      .map((c) => (c.kind === "tool_call_arg_delta" ? c.delta : ""))
      .join("");
    expect(JSON.parse(joined)).toEqual({ q: "openai" });
  });

  it("yields tool_call_end on finish_reason: tool_calls", () => {
    const chunks = [...chunksFromSse(TOOL_STREAM, "gpt-4o-mini")];
    const ends = chunks.filter((c) => c.kind === "tool_call_end");
    expect(ends).toHaveLength(1);
  });

  it("usage_final is at the very end", () => {
    const chunks = [...chunksFromSse(TOOL_STREAM, "gpt-4o-mini")];
    expect(chunks[chunks.length - 1]?.kind).toBe("usage_final");
  });
});

describe("chunksFromSse — empty + degenerate streams", () => {
  it("emits a synthetic usage_final when no usage chunk arrives", () => {
    const chunks = [...chunksFromSse(`data: [DONE]\n\n`, "gpt-4o-mini")];
    const usage = chunks.find((c) => c.kind === "usage_final");
    expect(usage?.kind).toBe("usage_final");
  });

  it("ignores malformed JSON data chunks without throwing", () => {
    const raw = `data: not-json\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n`;
    const chunks: CompletionChunk[] = [...chunksFromSse(raw, "gpt-4o-mini")];
    const texts = chunks.filter((c) => c.kind === "text");
    expect(texts).toHaveLength(1);
  });
});
