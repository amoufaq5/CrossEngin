import type { CompletionRequest } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import {
  REASONING_EFFORTS,
  buildOpenAIResponsesRequest,
  extractReasoningSummary,
  extractTextFromResponsesResponse,
  extractToolCallsFromResponsesResponse,
  normalizeResponsesUsage,
  type OpenAIResponsesResponse,
} from "./responses-api.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function req(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    task: "executor",
    tenantId: TENANT,
    sessionId: "sess",
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

describe("REASONING_EFFORTS", () => {
  it("exports the three documented levels", () => {
    expect(REASONING_EFFORTS).toEqual(["low", "medium", "high"]);
  });
});

describe("buildOpenAIResponsesRequest — message translation", () => {
  it("collapses system messages into the instructions field", () => {
    const built = buildOpenAIResponsesRequest(
      req({
        messages: [
          { role: "system", content: "you are helpful" },
          { role: "user", content: "hi" },
        ],
      }),
      { defaultModel: "gpt-4o-mini" },
    );
    expect(built.instructions).toBe("you are helpful");
    expect(built.input).toHaveLength(1);
    expect(built.input[0]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    });
  });

  it("joins multiple system messages with blank lines", () => {
    const built = buildOpenAIResponsesRequest(
      req({
        messages: [
          { role: "system", content: "first instruction" },
          { role: "system", content: "second instruction" },
          { role: "user", content: "go" },
        ],
      }),
      { defaultModel: "gpt-4o-mini" },
    );
    expect(built.instructions).toBe("first instruction\n\nsecond instruction");
  });

  it("emits function_call items for assistant.toolUses", () => {
    const built = buildOpenAIResponsesRequest(
      req({
        messages: [
          { role: "user", content: "search please" },
          {
            role: "assistant",
            content: "looking up",
            toolUses: [{ id: "call_1", name: "search", input: { q: "x" } }],
          },
          { role: "tool", content: "{\"hits\":1}", toolCallId: "call_1" },
        ],
      }),
      { defaultModel: "gpt-4o-mini" },
    );
    // user message + assistant text + function_call + function_call_output
    expect(built.input).toHaveLength(4);
    expect(built.input[2]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "search",
      arguments: JSON.stringify({ q: "x" }),
    });
    expect(built.input[3]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "{\"hits\":1}",
    });
  });

  it("omits assistant text item when content is empty but toolUses present", () => {
    const built = buildOpenAIResponsesRequest(
      req({
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
    // user, function_call, function_call_output (no empty assistant text item)
    expect(built.input).toHaveLength(3);
    expect(built.input[1]?.type).toBe("function_call");
  });

  it("translates tools to the Responses function declaration shape", () => {
    const built = buildOpenAIResponsesRequest(
      req({
        tools: [
          {
            name: "search",
            description: "Find things",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
      }),
      { defaultModel: "gpt-4o-mini" },
    );
    expect(built.tools).toHaveLength(1);
    expect(built.tools?.[0]?.type).toBe("function");
    expect(built.tools?.[0]?.name).toBe("search");
    expect(built.tools?.[0]?.parameters).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
  });

  it("threads reasoning effort when supplied", () => {
    const built = buildOpenAIResponsesRequest(req(), {
      defaultModel: "gpt-4o-mini",
      reasoningEffort: "high",
    });
    expect(built.reasoning).toEqual({ effort: "high" });
  });

  it("threads previousResponseId + store flag", () => {
    const built = buildOpenAIResponsesRequest(req(), {
      defaultModel: "gpt-4o-mini",
      previousResponseId: "resp_abc",
      store: true,
    });
    expect(built.previous_response_id).toBe("resp_abc");
    expect(built.store).toBe(true);
  });

  it("max_output_tokens defaults to RESPONSES_DEFAULT_MAX_OUTPUT_TOKENS when not specified", () => {
    const built = buildOpenAIResponsesRequest(req(), {
      defaultModel: "gpt-4o-mini",
    });
    expect(built.max_output_tokens).toBe(4_096);
  });

  it("max_output_tokens honors req.maxTokens", () => {
    const built = buildOpenAIResponsesRequest(req({ maxTokens: 1024 }), {
      defaultModel: "gpt-4o-mini",
    });
    expect(built.max_output_tokens).toBe(1024);
  });

  it("stream: true emits stream:true on the request", () => {
    const built = buildOpenAIResponsesRequest(req(), {
      defaultModel: "gpt-4o-mini",
      stream: true,
    });
    expect(built.stream).toBe(true);
  });
});

describe("normalizeResponsesUsage", () => {
  it("computes input + output tokens + cost", () => {
    const usage = normalizeResponsesUsage("gpt-4o-mini", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      total_tokens: 2_000_000,
    });
    expect(usage.inputTokens).toBe(1_000_000);
    expect(usage.outputTokens).toBe(1_000_000);
    expect(usage.cost).toBeCloseTo(0.75, 6);
  });

  it("threads cachedInputTokens when input_tokens_details.cached_tokens set", () => {
    const usage = normalizeResponsesUsage("gpt-4o-mini", {
      input_tokens: 1_000_000,
      output_tokens: 0,
      total_tokens: 1_000_000,
      input_tokens_details: { cached_tokens: 500_000 },
    });
    expect(usage.cachedInputTokens).toBe(500_000);
  });
});

describe("extractTextFromResponsesResponse", () => {
  it("concatenates output_text content blocks from assistant messages", () => {
    const response: OpenAIResponsesResponse = {
      id: "resp_1",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          role: "assistant",
          content: [
            { type: "output_text", text: "Hello " },
            { type: "output_text", text: "world" },
          ],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    };
    expect(extractTextFromResponsesResponse(response)).toBe("Hello world");
  });

  it("ignores reasoning + function_call items", () => {
    const response: OpenAIResponsesResponse = {
      id: "resp_1",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thinking..." }],
        },
        {
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "x",
          arguments: "{}",
        },
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    };
    expect(extractTextFromResponsesResponse(response)).toBe("ok");
  });
});

describe("extractToolCallsFromResponsesResponse", () => {
  it("returns function_call items with parsed JSON arguments", () => {
    const response: OpenAIResponsesResponse = {
      id: "resp_1",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "search",
          arguments: JSON.stringify({ q: "hello" }),
        },
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    };
    const calls = extractToolCallsFromResponsesResponse(response);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe("call_1");
    expect(calls[0]?.name).toBe("search");
    expect(calls[0]?.input).toEqual({ q: "hello" });
  });

  it("returns empty array when no tool calls", () => {
    const response: OpenAIResponsesResponse = {
      id: "resp_1",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          role: "assistant",
          content: [{ type: "output_text", text: "no tools" }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    };
    expect(extractToolCallsFromResponsesResponse(response)).toEqual([]);
  });
});

describe("extractReasoningSummary", () => {
  it("concatenates summary_text from reasoning items", () => {
    const response: OpenAIResponsesResponse = {
      id: "resp_1",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "reasoning",
          summary: [
            { type: "summary_text", text: "Step 1: parse" },
            { type: "summary_text", text: "Step 2: lookup" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    };
    expect(extractReasoningSummary(response)).toBe("Step 1: parse\n\nStep 2: lookup");
  });

  it("returns empty string when no reasoning items", () => {
    const response: OpenAIResponsesResponse = {
      id: "resp_1",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [
        { role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    };
    expect(extractReasoningSummary(response)).toBe("");
  });
});
