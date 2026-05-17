import type { CompletionRequest } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import {
  buildAnthropicRequest,
  extractText,
  extractToolCalls,
  normalizeUsage,
  type AnthropicResponse,
} from "./messages-api.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const SESSION = "sess_abc";

function fixtureCompletionRequest(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    task: "architect_chat",
    messages: [{ role: "user", content: "Hello" }],
    tenantId: TENANT,
    sessionId: SESSION,
    ...overrides,
  };
}

describe("buildAnthropicRequest", () => {
  it("uses defaultModel when request.model is not set", () => {
    const built = buildAnthropicRequest(fixtureCompletionRequest(), {
      defaultModel: "claude-sonnet-4-6",
    });
    expect(built.model).toBe("claude-sonnet-4-6");
    expect(built.max_tokens).toBe(4096);
    expect(built.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("uses request.model when set", () => {
    const built = buildAnthropicRequest(
      fixtureCompletionRequest({ model: "claude-opus-4-7" }),
      { defaultModel: "claude-sonnet-4-6" },
    );
    expect(built.model).toBe("claude-opus-4-7");
  });

  it("threads maxTokens + temperature", () => {
    const built = buildAnthropicRequest(
      fixtureCompletionRequest({ maxTokens: 500, temperature: 0.7 }),
      { defaultModel: "claude-sonnet-4-6" },
    );
    expect(built.max_tokens).toBe(500);
    expect(built.temperature).toBe(0.7);
  });

  it("separates system messages from the conversation into a system block", () => {
    const built = buildAnthropicRequest(
      fixtureCompletionRequest({
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hi" },
        ],
      }),
      { defaultModel: "claude-sonnet-4-6" },
    );
    expect(built.system).toEqual([{ type: "text", text: "You are helpful." }]);
    expect(built.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("attaches cache_control: ephemeral to system blocks when cacheControl.systemPrompt is set", () => {
    const built = buildAnthropicRequest(
      fixtureCompletionRequest({
        messages: [
          { role: "system", content: "Long prompt..." },
          { role: "user", content: "Hi" },
        ],
        cacheControl: { systemPrompt: "v1" },
      }),
      { defaultModel: "claude-sonnet-4-6" },
    );
    const sys = built.system as ReadonlyArray<{ cache_control?: { type: string } }>;
    expect(sys[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("converts tool role messages into tool_result blocks under a user message", () => {
    const built = buildAnthropicRequest(
      fixtureCompletionRequest({
        messages: [
          { role: "user", content: "search please" },
          { role: "assistant", content: "calling tool" },
          { role: "tool", content: "result-body", toolCallId: "tu_1" },
        ],
      }),
      { defaultModel: "claude-sonnet-4-6" },
    );
    const last = built.messages[built.messages.length - 1]!;
    expect(last.role).toBe("user");
    const content = last.content as ReadonlyArray<{ type: string; tool_use_id?: string }>;
    expect(content[0]?.type).toBe("tool_result");
    expect(content[0]?.tool_use_id).toBe("tu_1");
  });

  it("encodes assistant toolUses as tool_use content blocks alongside text", () => {
    const built = buildAnthropicRequest(
      fixtureCompletionRequest({
        messages: [
          { role: "user", content: "please search" },
          {
            role: "assistant",
            content: "I'll search now.",
            toolUses: [
              { id: "tu_1", name: "search", input: { q: "anthropic" } },
            ],
          },
          { role: "tool", content: "{\"hits\":1}", toolCallId: "tu_1" },
        ],
      }),
      { defaultModel: "claude-sonnet-4-6" },
    );
    const assistantMsg = built.messages[1]!;
    expect(assistantMsg.role).toBe("assistant");
    const blocks = assistantMsg.content as ReadonlyArray<{
      type: string;
      id?: string;
      name?: string;
      input?: unknown;
      text?: string;
    }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[0]?.text).toBe("I'll search now.");
    expect(blocks[1]?.type).toBe("tool_use");
    expect(blocks[1]?.id).toBe("tu_1");
    expect(blocks[1]?.name).toBe("search");
    expect(blocks[1]?.input).toEqual({ q: "anthropic" });
  });

  it("omits the text block when assistant content is empty but toolUses are present", () => {
    const built = buildAnthropicRequest(
      fixtureCompletionRequest({
        messages: [
          { role: "user", content: "do it" },
          {
            role: "assistant",
            content: "",
            toolUses: [{ id: "tu_a", name: "do_thing", input: {} }],
          },
          { role: "tool", content: "{}", toolCallId: "tu_a" },
        ],
      }),
      { defaultModel: "claude-sonnet-4-6" },
    );
    const assistantMsg = built.messages[1]!;
    const blocks = assistantMsg.content as ReadonlyArray<{ type: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("tool_use");
  });

  it("falls back to plain string content when toolUses is empty/absent", () => {
    const built = buildAnthropicRequest(
      fixtureCompletionRequest({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "Hello!" },
        ],
      }),
      { defaultModel: "claude-sonnet-4-6" },
    );
    expect(built.messages[1]?.content).toBe("Hello!");
  });

  it("threads tools through", () => {
    const built = buildAnthropicRequest(
      fixtureCompletionRequest({
        tools: [
          { name: "search", description: "Search the web", inputSchema: { type: "object" } },
        ],
      }),
      { defaultModel: "claude-sonnet-4-6" },
    );
    expect(built.tools).toEqual([
      { name: "search", description: "Search the web", input_schema: { type: "object" } },
    ]);
  });

  it("opts.stream=true sets stream: true on the request", () => {
    const built = buildAnthropicRequest(fixtureCompletionRequest(), {
      defaultModel: "claude-sonnet-4-6",
      stream: true,
    });
    expect(built.stream).toBe(true);
  });

  it("omits empty system + tools arrays", () => {
    const built = buildAnthropicRequest(fixtureCompletionRequest(), {
      defaultModel: "claude-sonnet-4-6",
    });
    expect(built.system).toBeUndefined();
    expect(built.tools).toBeUndefined();
  });
});

describe("normalizeUsage", () => {
  it("computes input + output tokens + cost", () => {
    const usage = normalizeUsage("claude-sonnet-4-6", {
      input_tokens: 1000,
      output_tokens: 500,
    });
    expect(usage.inputTokens).toBe(1000);
    expect(usage.outputTokens).toBe(500);
    expect(usage.cost).toBeGreaterThan(0);
  });

  it("threads cachedInputTokens when cache_read_input_tokens is set", () => {
    const usage = normalizeUsage("claude-sonnet-4-6", {
      input_tokens: 1000,
      cache_read_input_tokens: 800,
      output_tokens: 0,
    });
    expect(usage.cachedInputTokens).toBe(800);
  });

  it("includes cache write cost in total", () => {
    const without = normalizeUsage("claude-sonnet-4-6", {
      input_tokens: 1000,
      output_tokens: 0,
    });
    const withWrite = normalizeUsage("claude-sonnet-4-6", {
      input_tokens: 1000,
      cache_creation_input_tokens: 500,
      output_tokens: 0,
    });
    expect(withWrite.cost).toBeGreaterThan(without.cost);
  });
});

describe("extractText", () => {
  it("concatenates text content blocks", () => {
    const response: AnthropicResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    expect(extractText(response)).toBe("Hello world");
  });

  it("ignores tool_use blocks", () => {
    const response: AnthropicResponse = {
      id: "msg_2",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "Calling: " },
        { type: "tool_use", id: "tu_1", name: "search", input: {} },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    expect(extractText(response)).toBe("Calling: ");
  });
});

describe("extractToolCalls", () => {
  it("returns tool_use blocks", () => {
    const response: AnthropicResponse = {
      id: "msg_2",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "tu_1", name: "search", input: { q: "hello" } },
        { type: "tool_use", id: "tu_2", name: "fetch", input: { url: "x" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    const calls = extractToolCalls(response);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ id: "tu_1", name: "search", input: { q: "hello" } });
  });

  it("returns empty array when no tools were used", () => {
    const response: AnthropicResponse = {
      id: "msg_3",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "no tools here" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    expect(extractToolCalls(response)).toEqual([]);
  });
});
