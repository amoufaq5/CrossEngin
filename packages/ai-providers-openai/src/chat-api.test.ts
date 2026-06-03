import type { CompletionRequest } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";
import {
  buildOpenAiRequest,
  extractText,
  extractToolCalls,
  normalizeUsage,
  type OpenAiResponse,
} from "./chat-api.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function req(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    task: "executor",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ],
    tenantId: TENANT,
    sessionId: "sess_1",
    ...overrides,
  };
}

describe("buildOpenAiRequest", () => {
  it("keeps system messages as system role (no flattening)", () => {
    const built = buildOpenAiRequest(req(), { defaultModel: "gpt-4o" });
    expect(built.model).toBe("gpt-4o");
    expect(built.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(built.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("honours an explicit model + maxTokens + temperature", () => {
    const built = buildOpenAiRequest(req({ model: "gpt-4.1-mini", maxTokens: 256, temperature: 0.2 }), {
      defaultModel: "gpt-4o",
    });
    expect(built.model).toBe("gpt-4.1-mini");
    expect(built.max_completion_tokens).toBe(256);
    expect(built.temperature).toBe(0.2);
  });

  it("sets response_format on jsonMode", () => {
    const built = buildOpenAiRequest(req({ jsonMode: true }), { defaultModel: "gpt-4o" });
    expect(built.response_format).toEqual({ type: "json_object" });
  });

  it("requests usage in the stream when streaming", () => {
    const built = buildOpenAiRequest(req(), { defaultModel: "gpt-4o", stream: true });
    expect(built.stream).toBe(true);
    expect(built.stream_options).toEqual({ include_usage: true });
  });

  it("encodes tools as function tools", () => {
    const built = buildOpenAiRequest(
      req({ tools: [{ name: "lookup", description: "look up", inputSchema: { type: "object" } }] }),
      { defaultModel: "gpt-4o" },
    );
    expect(built.tools?.[0]).toEqual({
      type: "function",
      function: { name: "lookup", description: "look up", parameters: { type: "object" } },
    });
  });

  it("re-encodes assistant tool_uses as tool_calls with stringified arguments", () => {
    const built = buildOpenAiRequest(
      req({
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "",
            toolUses: [{ id: "call_1", name: "lookup", input: { q: "x" } }],
          },
          { role: "tool", content: "result", toolCallId: "call_1" },
        ],
      }),
      { defaultModel: "gpt-4o" },
    );
    const assistant = built.messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.content).toBeNull();
    expect(assistant?.tool_calls?.[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "lookup", arguments: JSON.stringify({ q: "x" }) },
    });
    const tool = built.messages[2];
    expect(tool).toEqual({ role: "tool", content: "result", tool_call_id: "call_1" });
  });
});

describe("normalizeUsage", () => {
  it("treats prompt_tokens as total and splits out cached", () => {
    const usage = normalizeUsage("gpt-4o", {
      prompt_tokens: 1_000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 400 },
    });
    expect(usage.inputTokens).toBe(1_000);
    expect(usage.outputTokens).toBe(200);
    expect(usage.cachedInputTokens).toBe(400);
    expect(usage.cost).toBeGreaterThan(0);
  });

  it("omits cachedInputTokens when zero", () => {
    const usage = normalizeUsage("gpt-4o-mini", { prompt_tokens: 100, completion_tokens: 10 });
    expect(usage.cachedInputTokens).toBeUndefined();
  });
});

describe("extractText / extractToolCalls", () => {
  const response: OpenAiResponse = {
    id: "chatcmpl_1",
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "partial",
          tool_calls: [
            { id: "call_9", type: "function", function: { name: "lookup", arguments: '{"q":"y"}' } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  };

  it("pulls text", () => {
    expect(extractText(response)).toBe("partial");
  });

  it("parses tool-call arguments back to objects", () => {
    const calls = extractToolCalls(response);
    expect(calls[0]).toEqual({ id: "call_9", name: "lookup", input: { q: "y" } });
  });

  it("falls back to raw string on unparseable arguments", () => {
    const calls = extractToolCalls({
      ...response,
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{bad" } }],
          },
        },
      ],
    });
    expect(calls[0]?.input).toBe("{bad");
  });
});
