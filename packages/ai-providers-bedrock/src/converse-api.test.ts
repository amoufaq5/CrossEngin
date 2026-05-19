import type { CompletionRequest } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import {
  buildBedrockConverseRequest,
  buildBedrockImageBlock,
  extractTextFromConverseResponse,
  extractToolCallsFromConverseResponse,
  isBedrockImageFormat,
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

describe("buildBedrockConverseRequest — cacheControl threading (M2.9.6)", () => {
  it("omits all cachePoint blocks when cacheControl is undefined", () => {
    const built = buildBedrockConverseRequest(baseReq(), {});
    for (const block of built.system ?? []) {
      expect("cachePoint" in block).toBe(false);
    }
    for (const msg of built.messages) {
      for (const block of msg.content) {
        expect("cachePoint" in block).toBe(false);
      }
    }
  });

  it("appends a cachePoint to the system array when systemPrompt is set", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          { role: "system", content: "you are helpful" },
          { role: "user", content: "hi" },
        ],
        cacheControl: { systemPrompt: "sp1" },
      }),
      {},
    );
    expect(built.system).toHaveLength(2);
    expect(built.system?.[0]).toEqual({ text: "you are helpful" });
    expect(built.system?.[1]).toEqual({ cachePoint: { type: "default" } });
  });

  it("appends a cachePoint to the system array when toolSchemas is set", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          { role: "system", content: "you are helpful" },
          { role: "user", content: "hi" },
        ],
        cacheControl: { toolSchemas: "ts1" },
      }),
      {},
    );
    const sys = built.system ?? [];
    expect(sys.some((b) => "cachePoint" in b)).toBe(true);
  });

  it("does NOT append a system cachePoint when system blocks are empty", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [{ role: "user", content: "hi" }],
        cacheControl: { systemPrompt: "sp1" },
      }),
      {},
    );
    expect(built.system).toBeUndefined();
  });

  it("appends a cachePoint to the last message when retrievedContext is set", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          { role: "user", content: "ping" },
          { role: "assistant", content: "pong" },
          { role: "user", content: "the new context here" },
        ],
        cacheControl: { retrievedContext: "rc1" },
      }),
      {},
    );
    const last = built.messages[built.messages.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content[last.content.length - 1]).toEqual({
      cachePoint: { type: "default" },
    });
    // earlier messages have no cachePoint
    for (let i = 0; i < built.messages.length - 1; i++) {
      const msg = built.messages[i]!;
      for (const block of msg.content) {
        expect("cachePoint" in block).toBe(false);
      }
    }
  });

  it("appends a cachePoint to the penultimate message when conversationHistory is set", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          { role: "user", content: "ping" },
          { role: "assistant", content: "pong" },
          { role: "user", content: "the new question" },
        ],
        cacheControl: { conversationHistory: "ch1" },
      }),
      {},
    );
    const penultimate = built.messages[built.messages.length - 2]!;
    expect(penultimate.role).toBe("assistant");
    expect(penultimate.content[penultimate.content.length - 1]).toEqual({
      cachePoint: { type: "default" },
    });
    const last = built.messages[built.messages.length - 1]!;
    expect(last.content.every((b) => !("cachePoint" in b))).toBe(true);
  });

  it("conversationHistory is a no-op when messages.length < 2", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [{ role: "user", content: "single message" }],
        cacheControl: { conversationHistory: "ch1" },
      }),
      {},
    );
    for (const msg of built.messages) {
      for (const block of msg.content) {
        expect("cachePoint" in block).toBe(false);
      }
    }
  });

  it("combines system + history + retrievedContext cache markers in one request", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          { role: "system", content: "instructions" },
          { role: "user", content: "ping" },
          { role: "assistant", content: "pong" },
          { role: "user", content: "now" },
        ],
        cacheControl: {
          systemPrompt: "sp1",
          conversationHistory: "ch1",
          retrievedContext: "rc1",
        },
      }),
      {},
    );
    // system: [text, cachePoint]
    expect(built.system).toHaveLength(2);
    expect("cachePoint" in built.system![1]!).toBe(true);
    // penultimate (assistant): ends in cachePoint
    expect(
      "cachePoint" in
        built.messages[built.messages.length - 2]!.content[
          built.messages[built.messages.length - 2]!.content.length - 1
        ]!,
    ).toBe(true);
    // last (user): ends in cachePoint
    expect(
      "cachePoint" in
        built.messages[built.messages.length - 1]!.content[
          built.messages[built.messages.length - 1]!.content.length - 1
        ]!,
    ).toBe(true);
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

  it("skips cachePoint blocks (M2.9.6 forward-compat)", () => {
    const text = extractTextFromConverseResponse(
      withContent([
        { text: "hello" },
        { cachePoint: { type: "default" } },
        { text: "world" },
      ]),
    );
    expect(text).toBe("helloworld");
  });

  it("skips image blocks (M2.9.7 forward-compat)", () => {
    const text = extractTextFromConverseResponse(
      withContent([
        { text: "before" },
        { image: { format: "png", source: { bytes: "..." } } },
        { text: "after" },
      ]),
    );
    expect(text).toBe("beforeafter");
  });
});

describe("buildBedrockImageBlock (M2.9.7)", () => {
  it("emits a {image: {format, source: {bytes}}} block for valid input", () => {
    const block = buildBedrockImageBlock({
      format: "png",
      imageBase64: "iVBORw0KGgo...",
    });
    expect(block).toEqual({
      image: {
        format: "png",
        source: { bytes: "iVBORw0KGgo..." },
      },
    });
  });

  it("accepts each documented format (png/jpeg/gif/webp)", () => {
    for (const format of ["png", "jpeg", "gif", "webp"] as const) {
      const block = buildBedrockImageBlock({ format, imageBase64: "abc" });
      expect(block.image.format).toBe(format);
    }
  });

  it("rejects empty imageBase64", () => {
    expect(() =>
      buildBedrockImageBlock({ format: "png", imageBase64: "" }),
    ).toThrow(/non-empty/);
  });
});

describe("isBedrockImageFormat", () => {
  it("accepts the documented formats", () => {
    expect(isBedrockImageFormat("png")).toBe(true);
    expect(isBedrockImageFormat("jpeg")).toBe(true);
    expect(isBedrockImageFormat("gif")).toBe(true);
    expect(isBedrockImageFormat("webp")).toBe(true);
  });

  it("rejects unsupported formats", () => {
    expect(isBedrockImageFormat("svg")).toBe(false);
    expect(isBedrockImageFormat("bmp")).toBe(false);
    expect(isBedrockImageFormat("")).toBe(false);
    expect(isBedrockImageFormat("JPEG")).toBe(false); // case sensitive
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

describe("buildBedrockConverseRequest — user image attachments (M2.X)", () => {
  it("appends BedrockImageContentBlock entries to the user message content array", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          {
            role: "user",
            content: "what is this?",
            attachments: [
              { kind: "image", format: "png", bytes: "iVBORw0KGgo..." },
            ],
          },
        ],
      }),
      {},
    );
    const user = built.messages[0]!;
    expect(user.role).toBe("user");
    expect(user.content).toHaveLength(2);
    expect(user.content[0]).toEqual({ text: "what is this?" });
    expect(user.content[1]).toEqual({
      image: {
        format: "png",
        source: { bytes: "iVBORw0KGgo..." },
      },
    });
  });

  it("falls back to a single {text} block when no attachments are present", () => {
    const built = buildBedrockConverseRequest(
      baseReq({ messages: [{ role: "user", content: "no images" }] }),
      {},
    );
    expect(built.messages[0]!.content).toEqual([{ text: "no images" }]);
  });

  it("emits image-only content when content is empty + attachments present", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          {
            role: "user",
            content: "",
            attachments: [{ kind: "image", format: "webp", bytes: "abc" }],
          },
        ],
      }),
      {},
    );
    expect(built.messages[0]!.content).toHaveLength(1);
    expect(built.messages[0]!.content[0]).toEqual({
      image: {
        format: "webp",
        source: { bytes: "abc" },
      },
    });
  });

  it("forwards multiple image attachments in input order", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          {
            role: "user",
            content: "compare these",
            attachments: [
              { kind: "image", format: "png", bytes: "first" },
              { kind: "image", format: "jpeg", bytes: "second" },
            ],
          },
        ],
      }),
      {},
    );
    expect(built.messages[0]!.content).toHaveLength(3);
    const second = built.messages[0]!.content[1] as { image: { format: string } };
    const third = built.messages[0]!.content[2] as { image: { format: string } };
    expect(second.image.format).toBe("png");
    expect(third.image.format).toBe("jpeg");
  });

  it("falls back to [{text}] when content is empty AND attachments is empty (edge case)", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [{ role: "user", content: "" }],
      }),
      {},
    );
    expect(built.messages[0]!.content).toEqual([{ text: "" }]);
  });

  it("threads guardrailConfig from BuildConverseRequestOptions into the request body (M2.9.8)", () => {
    const built = buildBedrockConverseRequest(baseReq(), {
      guardrailConfig: {
        guardrailIdentifier: "gr12345",
        guardrailVersion: "DRAFT",
        trace: "enabled",
      },
    });
    expect(built.guardrailConfig).toEqual({
      guardrailIdentifier: "gr12345",
      guardrailVersion: "DRAFT",
      trace: "enabled",
    });
  });

  it("omits guardrailConfig from the body when not provided", () => {
    const built = buildBedrockConverseRequest(baseReq(), {});
    expect("guardrailConfig" in built).toBe(false);
  });

  it("translates assistant message with kernel content blocks (M2.X.5)", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          { role: "user", content: "describe" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Here is a generated image:" },
              { type: "image", format: "png", bytes: "ABCD" },
            ],
          },
        ],
      }),
      {},
    );
    const assistantMsg = built.messages[1]!;
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toHaveLength(2);
    expect(assistantMsg.content[0]).toEqual({ text: "Here is a generated image:" });
    const imgBlock = assistantMsg.content[1] as { image: { format: string; source: { bytes: string } } };
    expect(imgBlock.image.format).toBe("png");
    expect(imgBlock.image.source.bytes).toBe("ABCD");
  });

  it("string content for assistant continues to work (backwards compat with M2.X)", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello back" },
        ],
      }),
      {},
    );
    expect(built.messages[1]!.content).toEqual([{ text: "hello back" }]);
  });

  it("user message with kernel content blocks (M2.X.5)", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image", format: "jpeg", bytes: "XYZ" },
            ],
          },
        ],
      }),
      {},
    );
    expect(built.messages[0]!.content).toHaveLength(2);
  });

  it("assistant tool_use block translates to Bedrock toolUse (M2.X.5.x)", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
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
      }),
      {},
    );
    const blocks = built.messages[1]!.content;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ text: "Searching..." });
    expect(blocks[1]).toEqual({
      toolUse: { toolUseId: "tu_1", name: "search", input: { q: "docs" } },
    });
  });

  it("throws on image_url content block (Bedrock requires base64 bytes) (M2.X.5.y)", () => {
    expect(() =>
      buildBedrockConverseRequest(
        baseReq({
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", url: "https://example.com/cat.png" },
              ],
            },
          ],
        }),
        {},
      ),
    ).toThrow(/Bedrock provider does not support image_url/);
  });

  it("document block translates to Bedrock document content block (M2.X.5.aa)", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
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
      }),
      {},
    );
    const blocks = built.messages[0]!.content;
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({
      document: {
        format: "pdf",
        name: "spec.pdf",
        source: { bytes: "PDF_BYTES" },
      },
    });
  });

  it("document_url block throws on Bedrock (no native URL support) (M2.X.5.aa.y)", () => {
    expect(() =>
      buildBedrockConverseRequest(
        baseReq({
          messages: [
            {
              role: "user",
              content: [
                { type: "document_url", url: "https://example.com/spec.pdf" },
              ],
            },
          ],
        }),
        {},
      ),
    ).toThrow(/Bedrock provider does not support document_url/);
  });

  it("document block format flows through to Bedrock natively for txt/md/csv (M2.X.5.aa.x)", () => {
    for (const format of ["txt", "md", "csv"] as const) {
      const built = buildBedrockConverseRequest(
        baseReq({
          messages: [
            {
              role: "user",
              content: [
                { type: "document", format, bytes: "BYTES", name: `doc.${format}` },
              ],
            },
          ],
        }),
        {},
      );
      const block = built.messages[0]!.content[0] as {
        document: { format: string; name: string; source: { bytes: string } };
      };
      expect(block.document.format).toBe(format);
      expect(block.document.name).toBe(`doc.${format}`);
      expect(block.document.source.bytes).toBe("BYTES");
    }
  });

  it("document block office formats flow through to Bedrock natively (M2.X.5.aa.x.1)", () => {
    for (const format of ["doc", "docx", "xls", "xlsx", "html"] as const) {
      const built = buildBedrockConverseRequest(
        baseReq({
          messages: [
            {
              role: "user",
              content: [
                { type: "document", format, bytes: "BYTES", name: `report.${format}` },
              ],
            },
          ],
        }),
        {},
      );
      const block = built.messages[0]!.content[0] as {
        document: { format: string; name: string; source: { bytes: string } };
      };
      expect(block.document.format).toBe(format);
      expect(block.document.name).toBe(`report.${format}`);
    }
  });

  it("document block without name defaults to 'document' on Bedrock", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          {
            role: "user",
            content: [
              { type: "document", format: "pdf", bytes: "PDF_BYTES" },
            ],
          },
        ],
      }),
      {},
    );
    const block = built.messages[0]!.content[0] as {
      document: { name: string };
    };
    expect(block.document.name).toBe("document");
  });

  it("user tool_result block translates to Bedrock toolResult (M2.X.5.x)", () => {
    const built = buildBedrockConverseRequest(
      baseReq({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "tu_1",
                content: "found 3 results",
                status: "success",
              },
            ],
          },
        ],
      }),
      {},
    );
    const blocks = built.messages[0]!.content;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      toolResult: {
        toolUseId: "tu_1",
        content: [{ text: "found 3 results" }],
        status: "success",
      },
    });
  });
});
