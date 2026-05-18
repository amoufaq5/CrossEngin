import type { CompletionRequest } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import {
  buildBedrockConverseRequest,
  extractTextFromConverseResponse,
  extractToolCallsFromConverseResponse,
  normalizeConverseUsage,
  type BedrockConverseResponse,
} from "./converse-api.js";

function baseReq(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    task: "planner",
    messages: [{ role: "user", content: "hello" }],
    tenantId: "ten-1",
    sessionId: "ses-1",
    ...overrides,
  };
}

describe("buildBedrockConverseRequest", () => {
  it("translates user + assistant text messages into Bedrock content blocks", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          { role: "user", content: "ping" },
          { role: "assistant", content: "pong" },
        ],
      }),
      { defaultMaxTokens: 1000 },
    );
    expect(built.messages).toHaveLength(2);
    expect(built.messages[0]).toEqual({
      role: "user",
      content: [{ text: "ping" }],
    });
    expect(built.messages[1]).toEqual({
      role: "assistant",
      content: [{ text: "pong" }],
    });
  });

  it("lifts system messages into a top-level system array", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          { role: "system", content: "you are helpful" },
          { role: "user", content: "hi" },
        ],
      }),
      {},
    );
    expect(built.system).toEqual([{ text: "you are helpful" }]);
    expect(built.messages).toHaveLength(1);
    expect(built.messages[0]?.role).toBe("user");
  });

  it("omits empty system blocks", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          { role: "system", content: "" },
          { role: "user", content: "hi" },
        ],
      }),
      {},
    );
    expect(built.system).toBeUndefined();
  });

  it("translates LlmMessage.toolUses into assistant.content.toolUse blocks", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          { role: "user", content: "search for foo" },
          {
            role: "assistant",
            content: "let me check",
            toolUses: [{ id: "tu_1", name: "search", input: { q: "foo" } }],
          },
        ],
      }),
      {},
    );
    const assistantBlock = built.messages[1]!;
    expect(assistantBlock.role).toBe("assistant");
    expect(assistantBlock.content).toHaveLength(2);
    expect(assistantBlock.content[0]).toEqual({ text: "let me check" });
    expect(assistantBlock.content[1]).toEqual({
      toolUse: { toolUseId: "tu_1", name: "search", input: { q: "foo" } },
    });
  });

  it("translates tool-role messages into user content with toolResult", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          { role: "user", content: "?" },
          {
            role: "assistant",
            content: "",
            toolUses: [{ id: "tu_1", name: "search", input: {} }],
          },
          {
            role: "tool",
            toolCallId: "tu_1",
            content: '{"results":["a"]}',
          },
        ],
      }),
      {},
    );
    const toolMsg = built.messages[2]!;
    expect(toolMsg.role).toBe("user");
    expect(toolMsg.content[0]).toEqual({
      toolResult: {
        toolUseId: "tu_1",
        content: [{ text: '{"results":["a"]}' }],
        status: "success",
      },
    });
  });

  it("passes inferenceConfig with maxTokens + temperature", () => {
    const built = buildBedrockConverseRequest(
      baseReq({ maxTokens: 256, temperature: 0.25 }),
      { defaultMaxTokens: 1024 },
    );
    expect(built.inferenceConfig?.maxTokens).toBe(256);
    expect(built.inferenceConfig?.temperature).toBe(0.25);
  });

  it("uses defaultMaxTokens when the request omits maxTokens", () => {
    const built = buildBedrockConverseRequest(baseReq(), {
      defaultMaxTokens: 555,
    });
    expect(built.inferenceConfig?.maxTokens).toBe(555);
  });

  it("translates tools into the {toolConfig: {tools: [{toolSpec: ...}]}} shape", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        tools: [
          {
            name: "search",
            description: "look stuff up",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
      }),
      {},
    );
    expect(built.toolConfig?.tools).toHaveLength(1);
    expect(built.toolConfig?.tools[0]?.toolSpec.name).toBe("search");
    expect(built.toolConfig?.tools[0]?.toolSpec.description).toBe("look stuff up");
    expect(built.toolConfig?.tools[0]?.toolSpec.inputSchema.json).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
  });

  it("omits toolConfig when no tools are provided", () => {
    const built = buildBedrockConverseRequest(baseReq(), {});
    expect(built.toolConfig).toBeUndefined();
  });
});

describe("normalizeConverseUsage", () => {
  it("includes cached input only when > 0", () => {
    const u = normalizeConverseUsage(
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
      { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 20 },
    );
    expect(u.inputTokens).toBe(100);
    expect(u.outputTokens).toBe(50);
    expect(u.cachedInputTokens).toBe(20);
    expect(u.cost).toBeGreaterThan(0);
  });

  it("omits cachedInputTokens when zero", () => {
    const u = normalizeConverseUsage(
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
      { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0 },
    );
    expect(u.cachedInputTokens).toBeUndefined();
  });
});

describe("extractTextFromConverseResponse", () => {
  function withContent(content: BedrockConverseResponse["output"]["message"]["content"]): BedrockConverseResponse {
    return {
      output: { message: { role: "assistant", content } },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }

  it("joins all text blocks", () => {
    const text = extractTextFromConverseResponse(
      withContent([{ text: "hello " }, { text: "world" }]),
    );
    expect(text).toBe("hello world");
  });

  it("skips toolUse blocks", () => {
    const text = extractTextFromConverseResponse(
      withContent([
        { text: "before" },
        { toolUse: { toolUseId: "x", name: "y", input: {} } },
        { text: "after" },
      ]),
    );
    expect(text).toBe("beforeafter");
  });
});

describe("extractToolCallsFromConverseResponse", () => {
  it("returns id + name + input for each toolUse block", () => {
    const calls = extractToolCallsFromConverseResponse({
      output: {
        message: {
          role: "assistant",
          content: [
            { text: "let me check" },
            { toolUse: { toolUseId: "tu_1", name: "search", input: { q: "x" } } },
            { toolUse: { toolUseId: "tu_2", name: "lookup", input: { k: "y" } } },
          ],
        },
      },
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(calls).toEqual([
      { id: "tu_1", name: "search", input: { q: "x" } },
      { id: "tu_2", name: "lookup", input: { k: "y" } },
    ]);
  });

  it("returns empty array when no toolUse blocks", () => {
    const calls = extractToolCallsFromConverseResponse({
      output: { message: { role: "assistant", content: [{ text: "no tools" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(calls).toEqual([]);
  });
});
