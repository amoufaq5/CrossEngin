import { describe, expect, it } from "vitest";

import type { CompletionChunk } from "@crossengin/ai-providers";

import { chunksFromSse, parseSseDataPayloads, readSseStream } from "./streaming.js";

function sse(...objs: unknown[]): string {
  return objs.map((o) => `data: ${typeof o === "string" ? o : JSON.stringify(o)}\n\n`).join("");
}

describe("parseSseDataPayloads", () => {
  it("splits data blocks and ignores blanks", () => {
    const payloads = parseSseDataPayloads("data: a\n\ndata: b\n\n\n\n");
    expect(payloads).toEqual(["a", "b"]);
  });
});

describe("chunksFromSse", () => {
  it("emits text chunks then a zero-cost usage_final", () => {
    const raw = sse(
      { choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      "[DONE]",
    );
    const chunks = [...chunksFromSse(raw)];
    expect(chunks.filter((c) => c.kind === "text").map((c) => (c as { text: string }).text)).toEqual([
      "Hel",
      "lo",
    ]);
    const final = chunks.at(-1) as Extract<CompletionChunk, { kind: "usage_final" }>;
    expect(final.kind).toBe("usage_final");
    expect(final.usage).toEqual({ inputTokens: 3, outputTokens: 2, cost: 0 });
  });

  it("assembles tool calls and synthesizes an id when the server omits it", () => {
    const raw = sse(
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { name: "calc", arguments: '{"x":' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: "2}" } }] },
            finish_reason: "tool_calls",
          },
        ],
      },
      "[DONE]",
    );
    const chunks = [...chunksFromSse(raw)];
    const start = chunks.find((c) => c.kind === "tool_call_start") as Extract<
      CompletionChunk,
      { kind: "tool_call_start" }
    >;
    expect(start.name).toBe("calc");
    expect(start.id).toMatch(/^local-tool-/);
    const args = chunks
      .filter((c) => c.kind === "tool_call_arg_delta")
      .map((c) => (c as { delta: string }).delta)
      .join("");
    expect(args).toBe('{"x":2}');
    expect(chunks.some((c) => c.kind === "tool_call_end")).toBe(true);
  });

  it("ignores malformed JSON payloads", () => {
    const chunks = [...chunksFromSse("data: not json\n\ndata: [DONE]\n\n")];
    expect(chunks).toHaveLength(1);
    expect(chunks[0].kind).toBe("usage_final");
  });
});

describe("readSseStream", () => {
  it("parses a real ReadableStream across chunk boundaries", async () => {
    const raw = sse(
      { choices: [{ index: 0, delta: { content: "A" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "B" }, finish_reason: "stop" }] },
      "[DONE]",
    );
    const encoder = new TextEncoder();
    const mid = Math.floor(raw.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(raw.slice(0, mid)));
        controller.enqueue(encoder.encode(raw.slice(mid)));
        controller.close();
      },
    });
    const collected: CompletionChunk[] = [];
    for await (const chunk of readSseStream(stream)) collected.push(chunk);
    expect(collected.filter((c) => c.kind === "text").map((c) => (c as { text: string }).text)).toEqual([
      "A",
      "B",
    ]);
    expect(collected.at(-1)?.kind).toBe("usage_final");
  });
});
