import type { CompletionRequest } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import {
  buildOpenAIChatRequest,
  extractTextFromResponse,
  extractToolCallsFromResponse,
  normalizeChatUsage,
  type OpenAIChatResponse,
} from "./chat-api.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function fixtureCompletionRequest(
  overrides: Partial<CompletionRequest> = {},
): CompletionRequest {
  return {
    task: "executor",
    tenantId: TENANT,
    sessionId: "sess-1",
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

describe("buildOpenAIChatRequest", () => {
  it("passes through model + max_tokens", () => {
    const built = buildOpenAIChatRequest(
      fixtureCompletionRequest({ model: "gpt-4o", maxTokens: 1024 }),
      { defaultModel: "gpt-4o-mini" },
    );
    expect(built.model).toBe("gpt-4o");
    expect(built.max_tokens).toBe(1024);
  });

  it("uses defaultModel when req.model is undefined", () => {
    const built = buildOpenAIChatRequest(fixtureCompletionRequest(), {
      defaultModel: "gpt-4o-mini",
    });
    expect(built.model).toBe("gpt-4o-mini");
  });

  it("translates system + user + assistant messages without toolUses to plain content", () => {
    const built = buildOpenAIChatRequest(
      fixtureCompletionRequest({
        messages: [
          { role: "system", content: "you are a helpful assistant" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      }),
      { defaultModel: "gpt-4o-mini" },
    );
    expect(built.messages).toHaveLength(3);
    expect(built.messages[0]).toEqual({ role: "system", content: "you are a helpful assistant" });
    expect(built.messages[2]).toEqual({ role: "assistant", content: "hello" });
  });

  it("translates assistant.toolUses into tool_calls", () => {
    const built = buildOpenAIChatRequest(
      fixtureCompletionRequest({
        messages: [
          { role: "user", content: "look it up" },
          {
            role: "assistant",
            content: "I'll search.",
            toolUses: [{ id: "call_1", name: "search", input: { q: "openai" } }],
          },
          { role: "tool", content: "{\"hits\":1}", toolCallId: "call_1" },
        ],
      }),
      { defaultModel: "gpt-4o-mini" },
    );
    const asst = built.messages[1]!;
    expect(asst.role).toBe("assistant");
    expect(asst.content).toBe("I'll search.");
    expect(asst.tool_calls).toHaveLength(1);
    expect(asst.tool_calls?.[0]?.id).toBe("call_1");
    expect(asst.tool_calls?.[0]?.function.name).toBe("search");
    expect(asst.tool_calls?.[0]?.function.arguments).toBe(JSON.stringify({ q: "openai" }));
  });

  it("sets assistant.content to null when toolUses present + content empty", () => {
    const built = buildOpenAIChatRequest(
      fixtureCompletionRequest({
        messages: [
          { role: "user", content: "do it" },
          {
            role: "assistant",
            content: "",
            toolUses: [{ id: "call_1", name: "x", input: {} }],
          },
          { role: "tool", content: "{}", toolCallId: "call_1" },
        ],
      }),
      { defaultModel: "gpt-4o-mini" },
    );
    expect(built.messages[1]?.content).toBeNull();
  });

  it("translates tool messages with tool_call_id", () => {
    const built = buildOpenAIChatRequest(
      fixtureCompletionRequest({
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            toolUses: [{ id: "call_1", name: "x", input: {} }],
          },
          { role: "tool", content: "result", toolCallId: "call_1", name: "x" },
        ],
      }),
      { defaultModel: "gpt-4o-mini" },
    );
    const toolMsg = built.messages[built.messages.length - 1]!;
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("call_1");
    expect(toolMsg.content).toBe("result");
    expect(toolMsg.name).toBe("x");
  });

  it("translates tools into the OpenAI function format", () => {
    const built = buildOpenAIChatRequest(
      fixtureCompletionRequest({
        tools: [
          {
            name: "search",
            description: "Search the web",
            inputSchema: {
              type: "object",
              properties: { q: { type: "string" } },
              required: ["q"],
            },
          },
        ],
      }),
      { defaultModel: "gpt-4o-mini" },
    );
    expect(built.tools).toHaveLength(1);
    expect(built.tools?.[0]?.type).toBe("function");
    expect(built.tools?.[0]?.function.name).toBe("search");
    expect(built.tools?.[0]?.function.parameters).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    });
  });

  it("sets stream: true + stream_options.include_usage when streaming", () => {
    const built = buildOpenAIChatRequest(fixtureCompletionRequest(), {
      defaultModel: "gpt-4o-mini",
      stream: true,
    });
    expect(built.stream).toBe(true);
    expect(built.stream_options).toEqual({ include_usage: true });
  });

  it("omits stream + stream_options when not streaming", () => {
    const built = buildOpenAIChatRequest(fixtureCompletionRequest(), {
      defaultModel: "gpt-4o-mini",
    });
    expect(built.stream).toBeUndefined();
    expect(built.stream_options).toBeUndefined();
  });
});

describe("normalizeChatUsage", () => {
  it("computes input + output tokens + cost", () => {
    const usage = normalizeChatUsage("gpt-4o-mini", {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      total_tokens: 2_000_000,
    });
    expect(usage.inputTokens).toBe(1_000_000);
    expect(usage.outputTokens).toBe(1_000_000);
    expect(usage.cost).toBeCloseTo(0.75, 6);
  });

  it("threads cachedInputTokens when prompt_tokens_details.cached_tokens is set", () => {
    const usage = normalizeChatUsage("gpt-4o-mini", {
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
      total_tokens: 1_000_000,
      prompt_tokens_details: { cached_tokens: 800_000 },
    });
    expect(usage.cachedInputTokens).toBe(800_000);
  });
});

describe("extractTextFromResponse", () => {
  it("returns the assistant message content", () => {
    const response: OpenAIChatResponse = {
      id: "chat_1",
      model: "gpt-4o",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello!" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
    expect(extractTextFromResponse(response)).toBe("Hello!");
  });

  it("returns empty string when content is null", () => {
    const response: OpenAIChatResponse = {
      id: "chat_1",
      model: "gpt-4o",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
    expect(extractTextFromResponse(response)).toBe("");
  });
});

describe("extractToolCallsFromResponse", () => {
  it("returns parsed tool_calls with JSON-decoded input", () => {
    const response: OpenAIChatResponse = {
      id: "chat_1",
      model: "gpt-4o",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "search",
                  arguments: JSON.stringify({ q: "hi" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
    const calls = extractToolCallsFromResponse(response);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe("call_1");
    expect(calls[0]?.name).toBe("search");
    expect(calls[0]?.input).toEqual({ q: "hi" });
  });

  it("returns empty array when no tool_calls", () => {
    const response: OpenAIChatResponse = {
      id: "chat_1",
      model: "gpt-4o",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "no tools" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
    expect(extractToolCallsFromResponse(response)).toEqual([]);
  });
});
