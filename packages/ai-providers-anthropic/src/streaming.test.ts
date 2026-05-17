import { describe, expect, it } from "vitest";

import { chunksFromSse, parseSseEvents } from "./streaming.js";

const SAMPLE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","usage":{"output_tokens":12}}

event: message_stop
data: {"type":"message_stop"}
`;

describe("parseSseEvents", () => {
  it("splits the stream into typed events with data payload", () => {
    const events = parseSseEvents(SAMPLE);
    const types = events.map((e) => e.event);
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  it("handles \\r\\n line endings", () => {
    const events = parseSseEvents(SAMPLE.replace(/\n/g, "\r\n"));
    expect(events.length).toBe(7);
  });

  it("ignores empty blocks + comment lines", () => {
    const events = parseSseEvents(
      `event: ping\ndata: \n\n\n\n: keepalive\n\nevent: hi\ndata: {"x":1}\n\n`,
    );
    expect(events.map((e) => e.event)).toEqual(["ping", "hi"]);
  });
});

describe("chunksFromSse — text streaming", () => {
  it("emits text chunks for text_delta events", () => {
    const chunks = [...chunksFromSse(SAMPLE, "claude-sonnet-4-6")];
    const texts = chunks.filter((c) => c.kind === "text").map((c) => (c.kind === "text" ? c.text : ""));
    expect(texts).toEqual(["Hello", " world"]);
  });

  it("emits a single usage_final at the end", () => {
    const chunks = [...chunksFromSse(SAMPLE, "claude-sonnet-4-6")];
    const final = chunks.filter((c) => c.kind === "usage_final");
    expect(final).toHaveLength(1);
    if (final[0]?.kind === "usage_final") {
      expect(final[0].usage.inputTokens).toBe(10);
      expect(final[0].usage.outputTokens).toBe(12);
      expect(final[0].usage.cost).toBeGreaterThan(0);
    }
  });
});

describe("chunksFromSse — tool use streaming", () => {
  const TOOL_SAMPLE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":20}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"search","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"hello\\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","usage":{"output_tokens":50}}

`;

  it("emits tool_call_start / arg deltas / tool_call_end", () => {
    const chunks = [...chunksFromSse(TOOL_SAMPLE, "claude-sonnet-4-6")];
    expect(chunks.some((c) => c.kind === "tool_call_start" && c.id === "toolu_1" && c.name === "search")).toBe(true);
    const deltas = chunks.filter((c) => c.kind === "tool_call_arg_delta");
    expect(deltas).toHaveLength(2);
    expect(chunks.some((c) => c.kind === "tool_call_end" && c.id === "toolu_1")).toBe(true);
  });
});

describe("chunksFromSse — cache token accounting", () => {
  it("includes cache_read + cache_creation in usage_final", () => {
    const sample = `event: message_start
data: {"type":"message_start","message":{"id":"msg_x","usage":{"input_tokens":50,"output_tokens":0,"cache_read_input_tokens":40,"cache_creation_input_tokens":10}}}

event: message_delta
data: {"type":"message_delta","usage":{"output_tokens":20}}

`;
    const chunks = [...chunksFromSse(sample, "claude-sonnet-4-6")];
    const final = chunks.find((c) => c.kind === "usage_final");
    if (final?.kind === "usage_final") {
      expect(final.usage.cachedInputTokens).toBe(40);
      expect(final.usage.outputTokens).toBe(20);
    } else {
      throw new Error("expected usage_final");
    }
  });
});

describe("chunksFromSse — malformed input", () => {
  it("skips events whose data is not valid JSON", () => {
    const chunks = [...chunksFromSse(`event: x\ndata: not-json\n\n`, "claude-sonnet-4-6")];
    expect(chunks.filter((c) => c.kind !== "usage_final")).toEqual([]);
  });

  it("skips events whose data is a JSON array", () => {
    const chunks = [...chunksFromSse(`event: x\ndata: [1,2,3]\n\n`, "claude-sonnet-4-6")];
    expect(chunks.filter((c) => c.kind !== "usage_final")).toEqual([]);
  });
});
