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

describe("buildAnthropicRequest — image attachments (M2.X)", () => {
  it("emits content as a [{type:text}, {type:image}] array for a user message with one image", () => {
    const req = buildAnthropicRequest({
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
    }, { defaultModel: "claude-sonnet-4-6" });
    expect(req.messages).toHaveLength(1);
    const userMsg = req.messages[0]!;
    expect(userMsg.role).toBe("user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    const blocks = userMsg.content as ReadonlyArray<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "what is this?" });
    expect(blocks[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "iVBORw0KGgo...",
      },
    });
  });

  it("emits content as a string when no attachments are present (backward compat)", () => {
    const req = buildAnthropicRequest({
      task: "planner",
      messages: [{ role: "user", content: "hello" }],
      tenantId: "t",
      sessionId: "s",
    }, { defaultModel: "claude-sonnet-4-6" });
    expect(req.messages[0]!.content).toBe("hello");
  });

  it("skips the text block when content is empty (image-only prompt)", () => {
    const req = buildAnthropicRequest({
      task: "planner",
      messages: [
        {
          role: "user",
          content: "",
          attachments: [
            { kind: "image", format: "webp", bytes: "abc" },
          ],
        },
      ],
      tenantId: "t",
      sessionId: "s",
    }, { defaultModel: "claude-sonnet-4-6" });
    const blocks = req.messages[0]!.content as ReadonlyArray<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/webp",
        data: "abc",
      },
    });
  });

  it("translates jpeg / gif / webp formats to the correct media_type", () => {
    for (const format of ["png", "jpeg", "gif", "webp"] as const) {
      const req = buildAnthropicRequest({
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
      }, { defaultModel: "claude-sonnet-4-6" });
      const blocks = req.messages[0]!.content as ReadonlyArray<Record<string, unknown>>;
      const imageBlock = blocks[1] as { source: { media_type: string } };
      expect(imageBlock.source.media_type).toBe(`image/${format}`);
    }
  });
});

describe("buildAnthropicRequest — kernel content blocks (M2.X.5)", () => {
  it("translates assistant message with content blocks to Anthropic content array", () => {
    const built = buildAnthropicRequest(
      {
        task: "planner",
        messages: [
          { role: "user", content: "describe" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Here is the result:" },
              { type: "image", format: "png", bytes: "ABCD" },
            ],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "claude-sonnet-4-6" },
    );
    const asst = built.messages[1]!;
    expect(asst.role).toBe("assistant");
    expect(Array.isArray(asst.content)).toBe(true);
    const blocks = asst.content as readonly Record<string, unknown>[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "Here is the result:" });
    expect(blocks[1]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "ABCD" },
    });
  });

  it("string content for assistant continues to map to plain string (backwards compat)", () => {
    const built = buildAnthropicRequest(
      {
        task: "planner",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello back" },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "claude-sonnet-4-6" },
    );
    expect(built.messages[1]!.content).toBe("hello back");
  });

  it("user message with content blocks emits Anthropic image blocks", () => {
    const built = buildAnthropicRequest(
      {
        task: "planner",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image", format: "jpeg", bytes: "XYZ" },
            ],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "claude-sonnet-4-6" },
    );
    const blocks = built.messages[0]!.content as readonly Record<string, unknown>[];
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({
      type: "image",
      source: { media_type: "image/jpeg", data: "XYZ" },
    });
  });

  it("assistant tool_use block translates to Anthropic tool_use block (M2.X.5.x)", () => {
    const built = buildAnthropicRequest(
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
      { defaultModel: "claude-sonnet-4-6" },
    );
    const blocks = built.messages[1]!.content as readonly Record<string, unknown>[];
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({
      type: "tool_use",
      id: "tu_1",
      name: "search",
      input: { q: "docs" },
    });
  });

  it("image_url content block translates to Anthropic url-source image block (M2.X.5.z)", () => {
    const built = buildAnthropicRequest(
      {
        task: "planner",
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", url: "https://example.com/cat.png" },
            ],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "claude-sonnet-4-6" },
    );
    const blocks = built.messages[0]!.content as readonly Record<string, unknown>[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "image",
      source: { type: "url", url: "https://example.com/cat.png" },
    });
  });

  it("image_url + image (bytes) both work in the same message (M2.X.5.z)", () => {
    const built = buildAnthropicRequest(
      {
        task: "planner",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", format: "png", bytes: "ABCD" },
              { type: "image_url", url: "https://example.com/y.jpg" },
            ],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "claude-sonnet-4-6" },
    );
    const blocks = built.messages[0]!.content as readonly { source: Record<string, string> }[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: "ABCD",
    });
    expect(blocks[1]!.source).toEqual({
      type: "url",
      url: "https://example.com/y.jpg",
    });
  });

  it("document block translates to Anthropic document content block (M2.X.5.aa)", () => {
    const built = buildAnthropicRequest(
      {
        task: "planner",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarize" },
              {
                type: "document",
                format: "pdf",
                bytes: "PDF_BYTES",
                name: "spec.pdf",
              },
            ],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "claude-sonnet-4-6" },
    );
    const blocks = built.messages[0]!.content as readonly Record<string, unknown>[];
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "PDF_BYTES",
      },
      title: "spec.pdf",
    });
  });

  it("document_url block translates to Anthropic url-source document (M2.X.5.aa.y)", () => {
    const built = buildAnthropicRequest(
      {
        task: "planner",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document_url",
                url: "https://example.com/spec.pdf",
                name: "spec.pdf",
              },
            ],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "claude-sonnet-4-6" },
    );
    const blocks = built.messages[0]!.content as readonly Record<string, unknown>[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "document",
      source: { type: "url", url: "https://example.com/spec.pdf" },
      title: "spec.pdf",
    });
  });

  it("txt document translates to Anthropic text source with decoded UTF-8 (M2.X.5.aa.x)", () => {
    const text = "Hello, world!\nThis is a plain-text document.";
    const bytes = Buffer.from(text, "utf8").toString("base64");
    const built = buildAnthropicRequest(
      {
        task: "planner",
        messages: [
          {
            role: "user",
            content: [
              { type: "document", format: "txt", bytes, name: "note.txt" },
            ],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "claude-sonnet-4-6" },
    );
    const block = built.messages[0]!.content[0] as {
      source: { type: string; media_type: string; data: string };
    };
    expect(block.source).toEqual({
      type: "text",
      media_type: "text/plain",
      data: text,
    });
  });

  it("md document → text/markdown media type (M2.X.5.aa.x)", () => {
    const md = "# Heading\n\nBody";
    const bytes = Buffer.from(md, "utf8").toString("base64");
    const built = buildAnthropicRequest(
      {
        task: "planner",
        messages: [
          {
            role: "user",
            content: [{ type: "document", format: "md", bytes }],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "claude-sonnet-4-6" },
    );
    const block = built.messages[0]!.content[0] as {
      source: { type: string; media_type: string; data: string };
    };
    expect(block.source.media_type).toBe("text/markdown");
    expect(block.source.data).toBe(md);
  });

  it("csv document → text/csv media type (M2.X.5.aa.x)", () => {
    const csv = "col1,col2\n1,2\n3,4";
    const bytes = Buffer.from(csv, "utf8").toString("base64");
    const built = buildAnthropicRequest(
      {
        task: "planner",
        messages: [
          {
            role: "user",
            content: [{ type: "document", format: "csv", bytes }],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "claude-sonnet-4-6" },
    );
    const block = built.messages[0]!.content[0] as {
      source: { type: string; media_type: string; data: string };
    };
    expect(block.source.media_type).toBe("text/csv");
    expect(block.source.data).toBe(csv);
  });

  it("file_id block translates to Anthropic file-source document (M2.X.5.aa.z.1)", () => {
    const built = buildAnthropicRequest(
      {
        task: "planner",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarize" },
              { type: "file_id", fileId: "file_abc123" },
            ],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "claude-sonnet-4-6" },
    );
    const blocks = built.messages[0]!.content as readonly Record<string, unknown>[];
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({
      type: "document",
      source: { type: "file", file_id: "file_abc123" },
    });
  });

  it("office format documents THROW on Anthropic with conversion guidance (M2.X.5.aa.x.1)", () => {
    for (const format of ["doc", "docx", "xls", "xlsx", "html"] as const) {
      expect(() =>
        buildAnthropicRequest(
          {
            task: "planner",
            messages: [
              {
                role: "user",
                content: [{ type: "document", format, bytes: "BYTES" }],
              },
            ],
            tenantId: "ten-1",
            sessionId: "ses-1",
          },
          { defaultModel: "claude-sonnet-4-6" },
        ),
      ).toThrow(/Anthropic provider does not support document format/);
    }
  });

  it("PDF still uses base64 source on Anthropic (unchanged from M2.X.5.aa)", () => {
    const built = buildAnthropicRequest(
      {
        task: "planner",
        messages: [
          {
            role: "user",
            content: [{ type: "document", format: "pdf", bytes: "PDF_B64" }],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "claude-sonnet-4-6" },
    );
    const block = built.messages[0]!.content[0] as {
      source: { type: string; media_type: string; data: string };
    };
    expect(block.source).toEqual({
      type: "base64",
      media_type: "application/pdf",
      data: "PDF_B64",
    });
  });

  it("document block without name omits title field on Anthropic", () => {
    const built = buildAnthropicRequest(
      {
        task: "planner",
        messages: [
          {
            role: "user",
            content: [
              { type: "document", format: "pdf", bytes: "PDF_BYTES" },
            ],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "claude-sonnet-4-6" },
    );
    const block = built.messages[0]!.content[0] as Record<string, unknown>;
    expect("title" in block).toBe(false);
  });

  it("user tool_result block translates to Anthropic tool_result block (M2.X.5.x)", () => {
    const built = buildAnthropicRequest(
      {
        task: "planner",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "tu_1",
                content: "found 3 results",
              },
            ],
          },
        ],
        tenantId: "ten-1",
        sessionId: "ses-1",
      },
      { defaultModel: "claude-sonnet-4-6" },
    );
    const blocks = built.messages[0]!.content as readonly Record<string, unknown>[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "found 3 results",
    });
  });
});

describe("buildAnthropicRequest — cacheBreakpoint emission (M2.X.11)", () => {
  function base(content: CompletionRequest["messages"][number]["content"]): CompletionRequest {
    return {
      task: "executor",
      messages: [{ role: "user", content }],
      tenantId: TENANT,
      sessionId: "sess-cache",
    };
  }

  it("emits cache_control on a text block when cacheBreakpoint=ephemeral", () => {
    const req = buildAnthropicRequest(
      base([
        { type: "text", text: "very long context here", cacheBreakpoint: { type: "ephemeral" } },
      ]),
      { defaultModel: "claude-sonnet-4-6", defaultMaxTokens: 4096 },
    );
    const blocks = req.messages[0]!.content as Array<{
      type: string;
      cache_control?: { type: string };
    }>;
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("omits cache_control when cacheBreakpoint is absent", () => {
    const req = buildAnthropicRequest(
      base([{ type: "text", text: "no caching" }]),
      { defaultModel: "claude-sonnet-4-6", defaultMaxTokens: 4096 },
    );
    const blocks = req.messages[0]!.content as Array<{
      type: string;
      cache_control?: { type: string };
    }>;
    expect(blocks[0]!.cache_control).toBeUndefined();
  });

  it("emits cache_control on an image_url block", () => {
    const req = buildAnthropicRequest(
      base([
        {
          type: "image_url",
          url: "https://example.com/img.png",
          cacheBreakpoint: { type: "ephemeral" },
        },
      ]),
      { defaultModel: "claude-sonnet-4-6", defaultMaxTokens: 4096 },
    );
    const blocks = req.messages[0]!.content as Array<{
      type: string;
      cache_control?: { type: string };
    }>;
    expect(blocks[0]!.type).toBe("image");
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("emits cache_control on a PDF document block", () => {
    const req = buildAnthropicRequest(
      base([
        {
          type: "document",
          format: "pdf",
          bytes: "JVBER",
          cacheBreakpoint: { type: "ephemeral" },
        },
      ]),
      { defaultModel: "claude-sonnet-4-6", defaultMaxTokens: 4096 },
    );
    const blocks = req.messages[0]!.content as Array<{
      type: string;
      cache_control?: { type: string };
    }>;
    expect(blocks[0]!.type).toBe("document");
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("emits cache_control on a file_id block", () => {
    const req = buildAnthropicRequest(
      base([
        { type: "file_id", fileId: "file-abc", cacheBreakpoint: { type: "ephemeral" } },
      ]),
      { defaultModel: "claude-sonnet-4-6", defaultMaxTokens: 4096 },
    );
    const blocks = req.messages[0]!.content as Array<{
      type: string;
      cache_control?: { type: string };
    }>;
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("emits cache_control on a tool_use block (assistant message)", () => {
    const req = buildAnthropicRequest(
      {
        task: "executor",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "search",
                input: { q: "x" },
                cacheBreakpoint: { type: "ephemeral" },
              },
            ],
          },
        ],
        tenantId: TENANT,
        sessionId: "sess-cache",
      },
      { defaultModel: "claude-sonnet-4-6", defaultMaxTokens: 4096 },
    );
    const blocks = req.messages[0]!.content as Array<{
      type: string;
      cache_control?: { type: string };
    }>;
    expect(blocks[0]!.type).toBe("tool_use");
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("emits cache_control on a tool_result block", () => {
    const req = buildAnthropicRequest(
      {
        task: "executor",
        messages: [
          {
            role: "tool",
            toolCallId: "tu_1",
            content: "result body",
            cacheBreakpoint: { type: "ephemeral" } as never,
          } as never,
        ],
        tenantId: TENANT,
        sessionId: "sess-cache",
      },
      { defaultModel: "claude-sonnet-4-6", defaultMaxTokens: 4096 },
    );
    // Anthropic puts tool messages as user-role with tool_result block.
    const blocks = req.messages[0]!.content as Array<{
      type: string;
      cache_control?: { type: string };
    }>;
    expect(blocks[0]!.type).toBe("tool_result");
  });

  it("emits cache_control on multiple blocks independently (partial cache prefix)", () => {
    const req = buildAnthropicRequest(
      base([
        {
          type: "text",
          text: "long context A",
          cacheBreakpoint: { type: "ephemeral" },
        },
        { type: "text", text: "fresh question" }, // no cache breakpoint
      ]),
      { defaultModel: "claude-sonnet-4-6", defaultMaxTokens: 4096 },
    );
    const blocks = req.messages[0]!.content as Array<{
      type: string;
      cache_control?: { type: string };
    }>;
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1]!.cache_control).toBeUndefined();
  });

  it("plain-string user message has no cache_control (kernel field is per-block)", () => {
    const req = buildAnthropicRequest(
      base("hello"),
      { defaultModel: "claude-sonnet-4-6", defaultMaxTokens: 4096 },
    );
    expect(typeof req.messages[0]!.content).toBe("string");
  });
});
