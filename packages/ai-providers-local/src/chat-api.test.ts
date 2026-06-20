import { describe, expect, it } from "vitest";

import type { CompletionRequest } from "@crossengin/ai-providers";

import {
  buildLocalRequest,
  extractText,
  extractToolCalls,
  normalizeUsage,
  type LocalResponse,
} from "./chat-api.js";

function baseReq(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    task: "executor",
    messages: [{ role: "user", content: "hello" }],
    tenantId: "t1",
    sessionId: "s1",
    ...overrides,
  };
}

describe("buildLocalRequest", () => {
  it("uses the default model and max_tokens (not max_completion_tokens)", () => {
    const built = buildLocalRequest(baseReq(), { defaultModel: "llama3.1" });
    expect(built.model).toBe("llama3.1");
    expect(built.max_tokens).toBeGreaterThan(0);
    expect("max_completion_tokens" in built).toBe(false);
  });

  it("accepts an arbitrary requested model name", () => {
    const built = buildLocalRequest(baseReq({ model: "qwen2.5:14b" }), { defaultModel: "llama3.1" });
    expect(built.model).toBe("qwen2.5:14b");
  });

  it("maps system/user/assistant/tool messages", () => {
    const built = buildLocalRequest(
      baseReq({
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "", toolUses: [{ id: "c1", name: "lookup", input: { q: 1 } }] },
          { role: "tool", content: "result", toolCallId: "c1" },
        ],
      }),
      { defaultModel: "m" },
    );
    expect(built.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(built.messages[2].tool_calls?.[0]).toEqual({
      id: "c1",
      type: "function",
      function: { name: "lookup", arguments: JSON.stringify({ q: 1 }) },
    });
    expect(built.messages[3]).toEqual({ role: "tool", content: "result", tool_call_id: "c1" });
  });

  it("sets stream options and json mode when requested", () => {
    const built = buildLocalRequest(baseReq({ jsonMode: true }), {
      defaultModel: "m",
      stream: true,
    });
    expect(built.stream).toBe(true);
    expect(built.stream_options).toEqual({ include_usage: true });
    expect(built.response_format).toEqual({ type: "json_object" });
  });

  it("emits tools when provided", () => {
    const built = buildLocalRequest(
      baseReq({ tools: [{ name: "calc", description: "math", inputSchema: { type: "object" } }] }),
      { defaultModel: "m" },
    );
    expect(built.tools?.[0]).toEqual({
      type: "function",
      function: { name: "calc", description: "math", parameters: { type: "object" } },
    });
  });
});

describe("normalizeUsage", () => {
  it("returns zero cost with token counts", () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cost: 0,
    });
  });

  it("handles missing usage (servers that omit it)", () => {
    expect(normalizeUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cost: 0 });
  });
});

describe("extractText / extractToolCalls", () => {
  const response: LocalResponse = {
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "thinking",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "calc", arguments: '{"x":2}' } },
            { id: "c2", type: "function", function: { name: "noop", arguments: "" } },
          ],
        },
      },
    ],
  };

  it("pulls assistant text", () => {
    expect(extractText(response)).toBe("thinking");
    expect(extractText({ choices: [] })).toBe("");
  });

  it("parses tool call arguments, falling back to raw on bad JSON", () => {
    const calls = extractToolCalls(response);
    expect(calls[0]).toEqual({ id: "c1", name: "calc", input: { x: 2 } });
    expect(calls[1]).toEqual({ id: "c2", name: "noop", input: {} });
  });
});
