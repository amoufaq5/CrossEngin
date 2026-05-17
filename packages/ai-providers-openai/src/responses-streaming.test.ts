import { describe, expect, it } from "vitest";

import {
  chunksFromResponsesSse,
  parseResponsesSseEvents,
} from "./responses-streaming.js";

const TEXT_STREAM = [
  `event: response.created\ndata: {"response":{"id":"resp_1"}}`,
  `event: response.output_text.delta\ndata: {"delta":"Hello"}`,
  `event: response.output_text.delta\ndata: {"delta":" there"}`,
  `event: response.completed\ndata: {"response":{"id":"resp_1","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}`,
  `event: done\ndata: [DONE]`,
  ``,
].join("\n\n");

const TOOL_STREAM = [
  `event: response.created\ndata: {"response":{"id":"resp_1"}}`,
  `event: response.output_item.added\ndata: {"item":{"type":"function_call","id":"item_1","call_id":"call_1","name":"search","arguments":""}}`,
  `event: response.function_call_arguments.delta\ndata: {"item_id":"item_1","delta":"{\\"q\\":"}`,
  `event: response.function_call_arguments.delta\ndata: {"item_id":"item_1","delta":"\\"x\\"}"}`,
  `event: response.function_call_arguments.done\ndata: {"item_id":"item_1"}`,
  `event: response.completed\ndata: {"response":{"id":"resp_1","usage":{"input_tokens":12,"output_tokens":6,"total_tokens":18}}}`,
  ``,
].join("\n\n");

describe("parseResponsesSseEvents", () => {
  it("captures event name + data per block", () => {
    const events = parseResponsesSseEvents(
      `event: a\ndata: hello\n\nevent: b\ndata: world\n\n`,
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ event: "a", data: "hello" });
    expect(events[1]).toEqual({ event: "b", data: "world" });
  });

  it("defaults event to 'message' when none specified", () => {
    const events = parseResponsesSseEvents(`data: foo\n\n`);
    expect(events[0]?.event).toBe("message");
  });

  it("handles \\r\\n endings", () => {
    const events = parseResponsesSseEvents(`event: x\r\ndata: y\r\n\r\n`);
    expect(events[0]?.event).toBe("x");
    expect(events[0]?.data).toBe("y");
  });
});

describe("chunksFromResponsesSse — text-only stream", () => {
  it("yields text deltas in order", () => {
    const chunks = [...chunksFromResponsesSse(TEXT_STREAM, "gpt-4o")];
    const texts = chunks.filter((c) => c.kind === "text");
    expect(texts.map((c) => (c.kind === "text" ? c.text : ""))).toEqual([
      "Hello",
      " there",
    ]);
  });

  it("emits usage_final with real token counts at the end", () => {
    const chunks = [...chunksFromResponsesSse(TEXT_STREAM, "gpt-4o")];
    const usage = chunks.find((c) => c.kind === "usage_final");
    expect(usage?.kind).toBe("usage_final");
    if (usage?.kind === "usage_final") {
      expect(usage.usage.inputTokens).toBe(10);
      expect(usage.usage.outputTokens).toBe(2);
      expect(usage.usage.cost).toBeGreaterThan(0);
    }
  });

  it("skips [DONE] markers without throwing", () => {
    const chunks = [...chunksFromResponsesSse(TEXT_STREAM, "gpt-4o")];
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe("chunksFromResponsesSse — tool-call stream", () => {
  it("yields tool_call_start once with id + name", () => {
    const chunks = [...chunksFromResponsesSse(TOOL_STREAM, "gpt-4o")];
    const starts = chunks.filter((c) => c.kind === "tool_call_start");
    expect(starts).toHaveLength(1);
    if (starts[0]?.kind === "tool_call_start") {
      expect(starts[0].id).toBe("call_1");
      expect(starts[0].name).toBe("search");
    }
  });

  it("yields tool_call_arg_delta for each argument fragment", () => {
    const chunks = [...chunksFromResponsesSse(TOOL_STREAM, "gpt-4o")];
    const deltas = chunks.filter((c) => c.kind === "tool_call_arg_delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    const joined = deltas
      .map((c) => (c.kind === "tool_call_arg_delta" ? c.delta : ""))
      .join("");
    expect(JSON.parse(joined)).toEqual({ q: "x" });
  });

  it("yields tool_call_end on response.function_call_arguments.done", () => {
    const chunks = [...chunksFromResponsesSse(TOOL_STREAM, "gpt-4o")];
    const ends = chunks.filter((c) => c.kind === "tool_call_end");
    expect(ends).toHaveLength(1);
  });

  it("emits usage_final from response.completed", () => {
    const chunks = [...chunksFromResponsesSse(TOOL_STREAM, "gpt-4o")];
    const usage = chunks.find((c) => c.kind === "usage_final");
    expect(usage?.kind).toBe("usage_final");
    if (usage?.kind === "usage_final") {
      expect(usage.usage.inputTokens).toBe(12);
      expect(usage.usage.outputTokens).toBe(6);
    }
  });
});

describe("chunksFromResponsesSse — degenerate streams", () => {
  it("emits a synthetic usage_final when no completed event arrives", () => {
    const chunks = [...chunksFromResponsesSse(`event: x\ndata: {}\n\n`, "gpt-4o")];
    const usage = chunks.find((c) => c.kind === "usage_final");
    expect(usage?.kind).toBe("usage_final");
    if (usage?.kind === "usage_final") {
      expect(usage.usage.inputTokens).toBe(0);
    }
  });

  it("ignores malformed JSON without throwing", () => {
    const raw = [
      `event: response.output_text.delta\ndata: not-json`,
      `event: response.output_text.delta\ndata: {"delta":"ok"}`,
      `event: done\ndata: [DONE]`,
      ``,
    ].join("\n\n");
    const chunks = [...chunksFromResponsesSse(raw, "gpt-4o")];
    const texts = chunks.filter((c) => c.kind === "text");
    expect(texts).toHaveLength(1);
    if (texts[0]?.kind === "text") expect(texts[0].text).toBe("ok");
  });

  it("emits a synthetic tool_call_end for unclosed tool calls", () => {
    const raw = [
      `event: response.output_item.added\ndata: {"item":{"type":"function_call","id":"i","call_id":"c","name":"x"}}`,
      `event: response.function_call_arguments.delta\ndata: {"item_id":"i","delta":"{}"}`,
      `event: done\ndata: [DONE]`,
      ``,
    ].join("\n\n");
    const chunks = [...chunksFromResponsesSse(raw, "gpt-4o")];
    const ends = chunks.filter((c) => c.kind === "tool_call_end");
    expect(ends).toHaveLength(1);
  });
});
