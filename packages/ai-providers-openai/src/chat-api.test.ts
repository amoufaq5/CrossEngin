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

describe("buildOpenAIChatRequest — image attachments (M2.X)", () => {
  it("emits content as a [{type:text}, {type:image_url}] array for a user message with one image", () => {
    const req = buildOpenAIChatRequest(
      {
        task: "planner",
        messages: [
          {
            role: "user",
            content: "what is this?",
            attachments: [
              { kind: "image", format: "png", bytes: "iVBORw0KGgo..." },
            ],
          },
        ],
        tenantId: "t",
        sessionId: "s",
      },
      { defaultModel: "gpt-4o-mini" },
    );
    expect(req.messages).toHaveLength(1);
    const userMsg = req.messages[0]!;
    expect(userMsg.role).toBe("user");
    const content = userMsg.content as ReadonlyArray<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "what is this?" });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgo..." },
    });
  });

  it("preserves string content when no attachments are supplied", () => {
    const req = buildOpenAIChatRequest(
      {
        task: "planner",
        messages: [{ role: "user", content: "hello" }],
        tenantId: "t",
        sessionId: "s",
      },
      { defaultModel: "gpt-4o-mini" },
    );
    expect(req.messages[0]!.content).toBe("hello");
  });

  it("emits image-only content array (no text part) when content is empty", () => {
    const req = buildOpenAIChatRequest(
      {
        task: "planner",
        messages: [
          {
            role: "user",
            content: "",
            attachments: [{ kind: "image", format: "jpeg", bytes: "/9j/4AAQ" }],
          },
        ],
        tenantId: "t",
        sessionId: "s",
      },
      { defaultModel: "gpt-4o-mini" },
    );
    const content = req.messages[0]!.content as ReadonlyArray<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" },
    });
  });

  it("translates each format into the correct data URL media-type", () => {
    for (const format of ["png", "jpeg", "gif", "webp"] as const) {
      const req = buildOpenAIChatRequest(
        {
          task: "planner",
          messages: [
            {
              role: "user",
              content: "x",
              attachments: [{ kind: "image", format, bytes: "abc" }],
            },
          ],
          tenantId: "t",
          sessionId: "s",
        },
        { defaultModel: "gpt-4o-mini" },
      );
      const content = req.messages[0]!.content as ReadonlyArray<{ image_url?: { url: string } }>;
      expect(content[1]!.image_url!.url).toBe(`data:image/${format};base64,abc`);
    }
  });
});

describe("extractTextFromResponse — content-part arrays (M2.X)", () => {
  it("joins text parts and ignores image_url parts in a content-part response", () => {
    const out = extractTextFromResponse({
      id: "msg",
      model: "gpt-4o",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "I see " },
              { type: "text", text: "a cat" },
            ],
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });
    expect(out).toBe("I see a cat");
  });
});

describe("buildOpenAIChatRequest — kernel content blocks (M2.X.5)", () => {
  it("translates assistant message with kernel content blocks to OpenAI content parts", () => {
    const built = buildOpenAIChatRequest(
      {
        task: "planner",
        messages: [
          { role: "user", content: "describe" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Here it is:" },
              { type: "image", format: "png", bytes: "ABCD" },
            ],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "gpt-4o" },
    );
    const asst = built.messages[1]!;
    expect(asst.role).toBe("assistant");
    expect(Array.isArray(asst.content)).toBe(true);
    const parts = asst.content as ReadonlyArray<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "Here it is:" });
    expect(parts[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,ABCD" },
    });
  });

  it("string content for assistant continues to map to plain string (backwards compat)", () => {
    const built = buildOpenAIChatRequest(
      {
        task: "planner",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello back" },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "gpt-4o" },
    );
    expect(built.messages[1]!.content).toBe("hello back");
  });

  it("user message with content blocks emits OpenAI image_url part", () => {
    const built = buildOpenAIChatRequest(
      {
        task: "planner",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what's this?" },
              { type: "image", format: "jpeg", bytes: "XYZ" },
            ],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "gpt-4o" },
    );
    const parts = built.messages[0]!.content as ReadonlyArray<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatchObject({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,XYZ" },
    });
  });

  it("assistant tool_use block hoists to OpenAI tool_calls (M2.X.5.x)", () => {
    const built = buildOpenAIChatRequest(
      {
        task: "planner",
        messages: [
          { role: "user", content: "search the docs" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Searching..." },
              {
                type: "tool_use",
                id: "tu_1",
                name: "search",
                input: { q: "docs" },
              },
            ],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "gpt-4o" },
    );
    const asst = built.messages[1]!;
    expect(asst.role).toBe("assistant");
    expect(asst.content).toBe("Searching...");
    expect(asst.tool_calls).toHaveLength(1);
    expect(asst.tool_calls?.[0]).toEqual({
      id: "tu_1",
      type: "function",
      function: { name: "search", arguments: '{"q":"docs"}' },
    });
  });

  it("user tool_result block SPLITS into a separate tool-role message (M2.X.5.x)", () => {
    const built = buildOpenAIChatRequest(
      {
        task: "planner",
        messages: [
          { role: "user", content: "search the docs" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tu_1", name: "search", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "tu_1",
                content: "found 3 results",
              },
              { type: "text", text: "what's the third?" },
            ],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "gpt-4o" },
    );
    // user msg with tool_result + text → emits 2 OpenAI messages:
    //   1. tool-role msg with tool_call_id
    //   2. user-role msg with remaining text
    expect(built.messages).toHaveLength(4);
    expect(built.messages[2]).toEqual({
      role: "tool",
      content: "found 3 results",
      tool_call_id: "tu_1",
    });
    expect(built.messages[3]!.role).toBe("user");
    const userParts = built.messages[3]!.content as ReadonlyArray<{ type: string; text?: string }>;
    expect(userParts).toEqual([{ type: "text", text: "what's the third?" }]);
  });

  it("tool_use inline content blocks merge with toolUses field for tool_calls (M2.X.5.x)", () => {
    const built = buildOpenAIChatRequest(
      {
        task: "planner",
        messages: [
          { role: "user", content: "do both" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tu_a", name: "search", input: { q: "x" } },
            ],
            toolUses: [{ id: "tu_b", name: "fetch", input: { url: "y" } }],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "gpt-4o" },
    );
    const asst = built.messages[1]!;
    expect(asst.tool_calls).toHaveLength(2);
    const ids = asst.tool_calls!.map((tc) => tc.id);
    expect(ids).toContain("tu_a");
    expect(ids).toContain("tu_b");
  });
});
