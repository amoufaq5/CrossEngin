import { describe, expect, it } from "vitest";

import { BedrockError } from "./errors.js";
import {
  mapEventToChunks,
  newConverseStreamState,
  parseEventStreamMessage,
  readConverseEventStream,
  type ConverseStreamState,
} from "./event-stream.js";
import { BedrockGuardrailViolationError } from "./guardrails.js";

const PRELUDE_LENGTH = 12;
const MESSAGE_CRC_LENGTH = 4;
const HEADER_VALUE_TYPE_STRING = 7;

function encodeHeader(name: string, value: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const valueBytes = new TextEncoder().encode(value);
  const buf = new Uint8Array(1 + nameBytes.byteLength + 1 + 2 + valueBytes.byteLength);
  const view = new DataView(buf.buffer);
  let i = 0;
  buf[i++] = nameBytes.byteLength;
  buf.set(nameBytes, i);
  i += nameBytes.byteLength;
  buf[i++] = HEADER_VALUE_TYPE_STRING;
  view.setUint16(i, valueBytes.byteLength, false);
  i += 2;
  buf.set(valueBytes, i);
  return buf;
}

function encodeFrame(headers: Readonly<Record<string, string>>, payload: Uint8Array): Uint8Array {
  const headerChunks: Uint8Array[] = [];
  let headersLen = 0;
  for (const [name, value] of Object.entries(headers)) {
    const h = encodeHeader(name, value);
    headerChunks.push(h);
    headersLen += h.byteLength;
  }
  const totalLen = PRELUDE_LENGTH + headersLen + payload.byteLength + MESSAGE_CRC_LENGTH;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);
  view.setUint32(0, totalLen, false);
  view.setUint32(4, headersLen, false);
  // Prelude CRC at bytes [8..12) — leave as zero (parser doesn't validate).
  let offset = PRELUDE_LENGTH;
  for (const h of headerChunks) {
    out.set(h, offset);
    offset += h.byteLength;
  }
  out.set(payload, offset);
  // Message CRC at end — leave as zero.
  return out;
}

function encodeEvent(eventType: string, payload: unknown): Uint8Array {
  const headers: Record<string, string> = {
    ":event-type": eventType,
    ":content-type": "application/json",
    ":message-type": "event",
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  return encodeFrame(headers, payloadBytes);
}

describe("parseEventStreamMessage", () => {
  it("returns null when buffer is too short for the prelude", () => {
    expect(parseEventStreamMessage(new Uint8Array(0))).toBeNull();
    expect(parseEventStreamMessage(new Uint8Array(8))).toBeNull();
  });

  it("returns null when buffer is shorter than the declared total length", () => {
    const frame = encodeEvent("messageStart", { role: "assistant" });
    const partial = frame.subarray(0, frame.byteLength - 1);
    expect(parseEventStreamMessage(partial)).toBeNull();
  });

  it("decodes a single frame with headers + JSON payload", () => {
    const frame = encodeEvent("messageStart", { role: "assistant" });
    const parsed = parseEventStreamMessage(frame);
    expect(parsed).not.toBeNull();
    expect(parsed!.consumed).toBe(frame.byteLength);
    expect(parsed!.message.headers[":event-type"]).toBe("messageStart");
    expect(parsed!.message.headers[":content-type"]).toBe("application/json");
    const payloadText = new TextDecoder().decode(parsed!.message.payload);
    expect(JSON.parse(payloadText)).toEqual({ role: "assistant" });
  });

  it("throws BedrockError on truncated headers section", () => {
    const headers = encodeHeader(":event-type", "messageStart");
    const totalLen = PRELUDE_LENGTH + headers.byteLength + MESSAGE_CRC_LENGTH;
    const buf = new Uint8Array(totalLen);
    const view = new DataView(buf.buffer);
    view.setUint32(0, totalLen, false);
    view.setUint32(4, headers.byteLength + 5, false); // declared > actual
    buf.set(headers, PRELUDE_LENGTH);
    expect(() => parseEventStreamMessage(buf)).toThrow(BedrockError);
  });
});

describe("mapEventToChunks", () => {
  const MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  function stateWithToolBlocks(
    blocks: ReadonlyArray<readonly [number, string]> = [],
  ): ConverseStreamState {
    const s = newConverseStreamState();
    for (const [i, id] of blocks) s.toolBlocks.set(i, id);
    return s;
  }

  function dispatch(
    eventType: string,
    payload: unknown,
    state: ConverseStreamState = newConverseStreamState(),
  ) {
    const frame = encodeEvent(eventType, payload);
    const parsed = parseEventStreamMessage(frame)!;
    return Array.from(mapEventToChunks(parsed.message, state, { model: MODEL }));
  }

  it("messageStart emits no chunks", () => {
    expect(dispatch("messageStart", { role: "assistant" })).toEqual([]);
  });

  it("contentBlockStart with toolUse emits tool_call_start + records the block id", () => {
    const state = newConverseStreamState();
    const chunks = dispatch(
      "contentBlockStart",
      {
        contentBlockIndex: 0,
        start: { toolUse: { toolUseId: "tu_1", name: "search" } },
      },
      state,
    );
    expect(chunks).toEqual([{ kind: "tool_call_start", id: "tu_1", name: "search" }]);
    expect(state.toolBlocks.get(0)).toBe("tu_1");
  });

  it("contentBlockStart with text emits no chunks", () => {
    expect(
      dispatch("contentBlockStart", {
        contentBlockIndex: 0,
        start: { text: "" },
      }),
    ).toEqual([]);
  });

  it("contentBlockDelta with text emits a text chunk", () => {
    expect(
      dispatch("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { text: "Hello " },
      }),
    ).toEqual([{ kind: "text", text: "Hello " }]);
  });

  it("contentBlockDelta with empty text emits nothing", () => {
    expect(
      dispatch("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { text: "" },
      }),
    ).toEqual([]);
  });

  it("contentBlockDelta with toolUse.input emits tool_call_arg_delta", () => {
    expect(
      dispatch(
        "contentBlockDelta",
        {
          contentBlockIndex: 0,
          delta: { toolUse: { input: '{"q":"' } },
        },
        stateWithToolBlocks([[0, "tu_42"]]),
      ),
    ).toEqual([{ kind: "tool_call_arg_delta", id: "tu_42", delta: '{"q":"' }]);
  });

  it("contentBlockDelta with toolUse.input on unknown index throws BedrockError", () => {
    expect(() =>
      dispatch("contentBlockDelta", {
        contentBlockIndex: 7,
        delta: { toolUse: { input: "fragment" } },
      }),
    ).toThrow(BedrockError);
  });

  it("contentBlockStop on a tool block emits tool_call_end + clears the block id", () => {
    const state = stateWithToolBlocks([[0, "tu_1"]]);
    expect(dispatch("contentBlockStop", { contentBlockIndex: 0 }, state)).toEqual([
      { kind: "tool_call_end", id: "tu_1" },
    ]);
    expect(state.toolBlocks.has(0)).toBe(false);
  });

  it("contentBlockStop on a text block emits nothing", () => {
    expect(dispatch("contentBlockStop", { contentBlockIndex: 0 })).toEqual([]);
  });

  it("messageStop emits no chunks", () => {
    expect(dispatch("messageStop", { stopReason: "end_turn" })).toEqual([]);
  });

  it("metadata emits usage_final with computed cost", () => {
    const chunks = dispatch("metadata", {
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      metrics: { latencyMs: 1234 },
    });
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0]!;
    if (chunk.kind !== "usage_final") throw new Error("expected usage_final");
    expect(chunk.usage.inputTokens).toBe(1_000_000);
    expect(chunk.usage.outputTokens).toBe(1_000_000);
    expect(chunk.usage.cost).toBe(18); // sonnet: $3+$15 per M
  });

  it("metadata with cacheReadInputTokens carries cachedInputTokens through", () => {
    const chunks = dispatch("metadata", {
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 800,
      },
    });
    const chunk = chunks[0]!;
    if (chunk.kind !== "usage_final") throw new Error("expected usage_final");
    expect(chunk.usage.cachedInputTokens).toBe(800);
  });

  it("exception event-type throws BedrockError with model_stream_error kind", () => {
    const frame = encodeFrame(
      {
        ":event-type": "modelStreamErrorException",
        ":message-type": "exception",
        ":content-type": "application/json",
      },
      new TextEncoder().encode('{"message":"upstream died"}'),
    );
    const parsed = parseEventStreamMessage(frame)!;
    expect(() =>
      Array.from(mapEventToChunks(parsed.message, newConverseStreamState(), { model: MODEL })),
    ).toThrow(BedrockError);
  });

  it("unknown event-type is silently ignored", () => {
    expect(dispatch("futureEventType", { someField: true })).toEqual([]);
  });
});

describe("readConverseEventStream — integration", () => {
  const MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  function streamFromBuffer(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async function collect(body: ReadableStream<Uint8Array>): Promise<ReturnType<typeof Array.from>> {
    const out: unknown[] = [];
    for await (const chunk of readConverseEventStream(body, { model: MODEL })) {
      out.push(chunk);
    }
    return out;
  }

  it("processes a multi-frame text + tool sequence end-to-end", async () => {
    const frames = [
      encodeEvent("messageStart", { role: "assistant" }),
      encodeEvent("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { text: "Hello " },
      }),
      encodeEvent("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { text: "world" },
      }),
      encodeEvent("contentBlockStop", { contentBlockIndex: 0 }),
      encodeEvent("contentBlockStart", {
        contentBlockIndex: 1,
        start: { toolUse: { toolUseId: "tu_a", name: "search" } },
      }),
      encodeEvent("contentBlockDelta", {
        contentBlockIndex: 1,
        delta: { toolUse: { input: '{"q":"foo"}' } },
      }),
      encodeEvent("contentBlockStop", { contentBlockIndex: 1 }),
      encodeEvent("messageStop", { stopReason: "tool_use" }),
      encodeEvent("metadata", {
        usage: { inputTokens: 12, outputTokens: 8 },
      }),
    ];
    const combined = new Uint8Array(frames.reduce((n, f) => n + f.byteLength, 0));
    let off = 0;
    for (const f of frames) {
      combined.set(f, off);
      off += f.byteLength;
    }
    const chunks = await collect(streamFromBuffer(combined));
    expect(chunks).toEqual([
      { kind: "text", text: "Hello " },
      { kind: "text", text: "world" },
      { kind: "tool_call_start", id: "tu_a", name: "search" },
      { kind: "tool_call_arg_delta", id: "tu_a", delta: '{"q":"foo"}' },
      { kind: "tool_call_end", id: "tu_a" },
      expect.objectContaining({ kind: "usage_final" }),
    ]);
  });

  it("handles frame split across multiple reads", async () => {
    const frame = encodeEvent("contentBlockDelta", {
      contentBlockIndex: 0,
      delta: { text: "hi" },
    });
    const mid = Math.floor(frame.byteLength / 2);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame.subarray(0, mid));
        controller.enqueue(frame.subarray(mid));
        controller.close();
      },
    });
    const chunks = await collect(body);
    expect(chunks).toEqual([{ kind: "text", text: "hi" }]);
  });

  it("throws when unparsed bytes remain at end of stream", async () => {
    const frame = encodeEvent("messageStart", { role: "assistant" });
    const truncated = frame.subarray(0, frame.byteLength - 2);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(truncated);
        controller.close();
      },
    });
    await expect(collect(body)).rejects.toThrow(BedrockError);
  });

  function concatFrames(frames: readonly Uint8Array[]): Uint8Array {
    const total = frames.reduce((n, f) => n + f.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const f of frames) {
      out.set(f, off);
      off += f.byteLength;
    }
    return out;
  }

  it("guardrail intervention: throws BedrockGuardrailViolationError AFTER usage_final", async () => {
    const frames = [
      encodeEvent("messageStart", { role: "assistant" }),
      encodeEvent("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { text: "before block" },
      }),
      encodeEvent("contentBlockStop", { contentBlockIndex: 0 }),
      encodeEvent("messageStop", { stopReason: "guardrail_intervened" }),
      encodeEvent("metadata", {
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    ];
    const body = streamFromBuffer(concatFrames(frames));
    const chunks: unknown[] = [];
    let caught: unknown;
    try {
      for await (const chunk of readConverseEventStream(body, { model: MODEL })) {
        chunks.push(chunk);
      }
    } catch (err) {
      caught = err;
    }
    expect(chunks).toEqual([
      { kind: "text", text: "before block" },
      expect.objectContaining({ kind: "usage_final" }),
    ]);
    expect(caught).toBeInstanceOf(BedrockGuardrailViolationError);
    const e = caught as BedrockGuardrailViolationError;
    expect(e.stopReason).toBe("guardrail_intervened");
    expect(e.kind).toBe("guardrail_intervened");
    expect(e.isRetryable()).toBe(false);
  });

  it("guardrail intervention: content_filtered stopReason maps to same error class", async () => {
    const frames = [
      encodeEvent("messageStart", { role: "assistant" }),
      encodeEvent("messageStop", { stopReason: "content_filtered" }),
      encodeEvent("metadata", {
        usage: { inputTokens: 4, outputTokens: 0 },
      }),
    ];
    const body = streamFromBuffer(concatFrames(frames));
    let caught: unknown;
    try {
      for await (const _chunk of readConverseEventStream(body, { model: MODEL })) {
        // drain
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BedrockGuardrailViolationError);
    expect((caught as BedrockGuardrailViolationError).stopReason).toBe("content_filtered");
  });

  it("guardrail trace from metadata flows into the thrown error", async () => {
    const trace = {
      inputAssessment: {
        guardrailId123: {
          contentPolicy: { filters: [{ type: "HATE", action: "BLOCKED" }] },
        },
      },
    };
    const frames = [
      encodeEvent("messageStart", { role: "assistant" }),
      encodeEvent("messageStop", { stopReason: "guardrail_intervened" }),
      encodeEvent("metadata", {
        usage: { inputTokens: 10, outputTokens: 0 },
        trace: { guardrail: trace },
      }),
    ];
    const body = streamFromBuffer(concatFrames(frames));
    let caught: unknown;
    try {
      for await (const _chunk of readConverseEventStream(body, { model: MODEL })) {
        // drain
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BedrockGuardrailViolationError);
    expect((caught as BedrockGuardrailViolationError).trace).toEqual(trace);
  });

  it("non-intervention stopReason does NOT throw", async () => {
    const frames = [
      encodeEvent("messageStart", { role: "assistant" }),
      encodeEvent("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { text: "ok" },
      }),
      encodeEvent("contentBlockStop", { contentBlockIndex: 0 }),
      encodeEvent("messageStop", { stopReason: "end_turn" }),
      encodeEvent("metadata", {
        usage: { inputTokens: 8, outputTokens: 1 },
      }),
    ];
    const body = streamFromBuffer(concatFrames(frames));
    const chunks: unknown[] = [];
    for await (const chunk of readConverseEventStream(body, { model: MODEL })) {
      chunks.push(chunk);
    }
    expect(chunks).toContainEqual({ kind: "text", text: "ok" });
  });
});
