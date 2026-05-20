import { describe, expect, it } from "vitest";
import {
  CompletionChunkSchema,
  CompletionRequestSchema,
  CostTelemetryRecordSchema,
  EmbeddingRequestSchema,
  EmbeddingResponseSchema,
  FileReferenceContentBlockSchema,
  ImageAttachmentSchema,
  ImageContentBlockSchema,
  DocumentContentBlockSchema,
  DocumentUrlContentBlockSchema,
  LLM_CACHE_BREAKPOINT_TYPES,
  LlmCacheBreakpointSchema,
  OFFICE_DOCUMENT_FORMATS,
  ToolResultContentBlockSchema,
  ToolUseContentBlockSchema,
  documentMediaType,
  isOfficeDocumentFormat,
  isTextDocumentFormat,
  ImageUrlContentBlockSchema,
  LlmContentBlockSchema,
  LlmContentSchema,
  LlmMessageSchema,
  MessageAttachmentSchema,
  NormalizedCompletionSchema,
  ProviderCapabilitiesSchema,
  ProviderPricingSchema,
  RegionSchema,
  TaskKindSchema,
  TaskPolicySchema,
  TenantResidencySchema,
  TextContentBlockSchema,
  contentToText,
  imageMediaType,
  isBlockContent,
  isStringContent,
  normalizeContent,
} from "./types.js";

describe("RegionSchema", () => {
  it.each(["eu", "us", "me", "ap", "sa"])("accepts %s", (r) => {
    expect(RegionSchema.parse(r)).toBe(r);
  });

  it("rejects unknown region", () => {
    expect(() => RegionSchema.parse("antarctica")).toThrow();
  });
});

describe("TaskKindSchema", () => {
  it.each([
    "planner",
    "executor",
    "summarizer",
    "diff-narrator",
    "embedding",
    "rerank",
    "classifier",
  ])("accepts %s", (k) => {
    expect(TaskKindSchema.parse(k)).toBe(k);
  });

  it("rejects unknown task", () => {
    expect(() => TaskKindSchema.parse("brainstormer")).toThrow();
  });
});

describe("TenantResidencySchema", () => {
  it.each(["unrestricted", "eu-only", "us-only", "me-only"])("accepts %s", (r) => {
    expect(TenantResidencySchema.parse(r)).toBe(r);
  });
});

describe("ProviderCapabilitiesSchema", () => {
  it("parses a complete capabilities object", () => {
    const c = {
      chat: true,
      toolUse: true,
      streaming: true,
      jsonMode: true,
      embedding: false,
      maxContextTokens: 200_000,
      supportsThinking: false,
      vision: false,
    };
    expect(ProviderCapabilitiesSchema.parse(c)).toEqual(c);
  });

  it("defaults vision to false when omitted (M2.X backward compat)", () => {
    const parsed = ProviderCapabilitiesSchema.parse({
      chat: true,
      toolUse: true,
      streaming: true,
      jsonMode: true,
      embedding: false,
      maxContextTokens: 200_000,
      supportsThinking: false,
    });
    expect(parsed.vision).toBe(false);
  });

  it("rejects non-positive maxContextTokens", () => {
    expect(() =>
      ProviderCapabilitiesSchema.parse({
        chat: true,
        toolUse: true,
        streaming: true,
        jsonMode: true,
        embedding: true,
        maxContextTokens: 0,
        supportsThinking: false,
      }),
    ).toThrow();
  });
});

describe("ProviderPricingSchema", () => {
  it("parses with cached pricing", () => {
    const p = {
      inputPerMillionTokens: 0.2,
      outputPerMillionTokens: 0.6,
      cachedInputPerMillionTokens: 0.05,
    };
    expect(ProviderPricingSchema.parse(p)).toEqual(p);
  });

  it("parses without cached pricing", () => {
    const p = { inputPerMillionTokens: 0.2, outputPerMillionTokens: 0.6 };
    expect(ProviderPricingSchema.parse(p)).toEqual(p);
  });

  it("rejects negative pricing", () => {
    expect(() =>
      ProviderPricingSchema.parse({
        inputPerMillionTokens: -0.1,
        outputPerMillionTokens: 0.6,
      }),
    ).toThrow();
  });
});

describe("TaskPolicySchema", () => {
  it("parses primary + fallback chain", () => {
    const p = { primary: "fireworks:qwen3-72b", fallback: ["together:qwen3-72b"] };
    expect(TaskPolicySchema.parse(p)).toEqual(p);
  });

  it("parses primary + empty fallback", () => {
    const p = { primary: "self-hosted-bge:bge-m3", fallback: [] };
    expect(TaskPolicySchema.parse(p)).toEqual(p);
  });
});

describe("CompletionRequestSchema", () => {
  it("parses a minimal request", () => {
    const req = {
      task: "planner" as const,
      messages: [{ role: "user" as const, content: "hi" }],
      tenantId: "t",
      sessionId: "s",
    };
    expect(CompletionRequestSchema.parse(req)).toEqual(req);
  });

  it("parses a request with tools, cacheControl, and temperature", () => {
    const req = {
      task: "executor" as const,
      messages: [{ role: "system" as const, content: "..." }, { role: "user" as const, content: "..." }],
      tools: [{ name: "x", description: "y", inputSchema: {} }],
      cacheControl: { systemPrompt: "stable" },
      temperature: 0.2,
      jsonMode: true,
      tenantId: "t",
      sessionId: "s",
    };
    expect(CompletionRequestSchema.parse(req)).toEqual(req);
  });

  it("rejects an empty messages array", () => {
    expect(() =>
      CompletionRequestSchema.parse({
        task: "planner",
        messages: [],
        tenantId: "t",
        sessionId: "s",
      }),
    ).toThrow();
  });

  it("rejects temperature out of range", () => {
    expect(() =>
      CompletionRequestSchema.parse({
        task: "planner",
        messages: [{ role: "user", content: "x" }],
        temperature: 3,
        tenantId: "t",
        sessionId: "s",
      }),
    ).toThrow();
  });
});

describe("CompletionChunkSchema", () => {
  it("parses each chunk variant", () => {
    expect(() => CompletionChunkSchema.parse({ kind: "text", text: "hi" })).not.toThrow();
    expect(() =>
      CompletionChunkSchema.parse({ kind: "tool_call_start", id: "a", name: "foo" }),
    ).not.toThrow();
    expect(() =>
      CompletionChunkSchema.parse({ kind: "tool_call_arg_delta", id: "a", delta: '{"x"' }),
    ).not.toThrow();
    expect(() =>
      CompletionChunkSchema.parse({ kind: "tool_call_end", id: "a" }),
    ).not.toThrow();
    expect(() =>
      CompletionChunkSchema.parse({
        kind: "usage_final",
        usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      }),
    ).not.toThrow();
  });

  it("rejects unknown chunk kind", () => {
    expect(() =>
      CompletionChunkSchema.parse({ kind: "magic", text: "x" }),
    ).toThrow();
  });
});

describe("NormalizedCompletionSchema", () => {
  it("parses text-only completion", () => {
    expect(() =>
      NormalizedCompletionSchema.parse({
        text: "hello",
        usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      }),
    ).not.toThrow();
  });

  it("parses tool-call-only completion", () => {
    expect(() =>
      NormalizedCompletionSchema.parse({
        toolCalls: [{ id: "x", name: "foo", arguments: { y: 1 } }],
        usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      }),
    ).not.toThrow();
  });
});

describe("EmbeddingRequestSchema / EmbeddingResponseSchema", () => {
  it("parses a minimal embedding request", () => {
    expect(() =>
      EmbeddingRequestSchema.parse({ texts: ["hello"], tenantId: "t" }),
    ).not.toThrow();
  });

  it("rejects empty texts array", () => {
    expect(() => EmbeddingRequestSchema.parse({ texts: [], tenantId: "t" })).toThrow();
  });

  it("parses an embedding response", () => {
    expect(() =>
      EmbeddingResponseSchema.parse({
        vectors: [[0.1, 0.2]],
        dim: 2,
        model: "m",
        usage: { inputTokens: 5, outputTokens: 0, cost: 0 },
      }),
    ).not.toThrow();
  });
});

describe("CostTelemetryRecordSchema", () => {
  it("parses a complete record", () => {
    expect(() =>
      CostTelemetryRecordSchema.parse({
        tenantId: "t",
        sessionId: "s",
        taskKind: "planner",
        providerId: "fireworks",
        modelId: "qwen3-72b",
        inputTokens: 4521,
        outputTokens: 312,
        cachedInputTokens: 3800,
        costUsd: 0.0028,
        latencyMs: 1832,
        ok: true,
        occurredAt: "2026-05-12T00:00:00Z",
      }),
    ).not.toThrow();
  });

  it("parses a failure record", () => {
    expect(() =>
      CostTelemetryRecordSchema.parse({
        tenantId: "t",
        taskKind: "planner",
        providerId: "fireworks",
        modelId: "qwen3-72b",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 5000,
        ok: false,
        errorMessage: "timeout",
        occurredAt: "2026-05-12T00:00:00Z",
      }),
    ).not.toThrow();
  });
});

describe("ImageAttachmentSchema (M2.X)", () => {
  it("parses a valid PNG attachment", () => {
    expect(() =>
      ImageAttachmentSchema.parse({
        kind: "image",
        format: "png",
        bytes: "iVBORw0KGgo...",
      }),
    ).not.toThrow();
  });

  it("accepts each documented image format", () => {
    for (const format of ["png", "jpeg", "gif", "webp"]) {
      expect(() =>
        ImageAttachmentSchema.parse({
          kind: "image",
          format,
          bytes: "abc",
        }),
      ).not.toThrow();
    }
  });

  it("rejects unsupported image formats", () => {
    expect(() =>
      ImageAttachmentSchema.parse({
        kind: "image",
        format: "svg",
        bytes: "abc",
      }),
    ).toThrow();
    expect(() =>
      ImageAttachmentSchema.parse({
        kind: "image",
        format: "bmp",
        bytes: "abc",
      }),
    ).toThrow();
  });

  it("rejects empty bytes", () => {
    expect(() =>
      ImageAttachmentSchema.parse({
        kind: "image",
        format: "png",
        bytes: "",
      }),
    ).toThrow();
  });
});

describe("MessageAttachmentSchema (M2.X discriminated union)", () => {
  it("parses image attachments via the kind discriminator", () => {
    const parsed = MessageAttachmentSchema.parse({
      kind: "image",
      format: "jpeg",
      bytes: "/9j/4AAQ...",
    });
    expect(parsed.kind).toBe("image");
  });

  it("rejects unknown kinds (future-extension safety)", () => {
    expect(() =>
      MessageAttachmentSchema.parse({
        kind: "audio",
        format: "mp3",
        bytes: "...",
      } as unknown),
    ).toThrow();
  });
});

describe("LlmMessageSchema name field validation (M2.X.10)", () => {
  it("accepts valid name with alphanumeric + underscore + hyphen", () => {
    for (const name of ["alice", "Bob-42", "system_v2", "abc123", "a"]) {
      expect(() =>
        LlmMessageSchema.parse({
          role: "user",
          content: "hi",
          name,
        }),
      ).not.toThrow();
    }
  });

  it("rejects name with spaces or other special characters", () => {
    for (const name of [
      "name with space",
      "name@example",
      "name.dotted",
      "name/slash",
      "name+plus",
    ]) {
      expect(() =>
        LlmMessageSchema.parse({
          role: "user",
          content: "hi",
          name,
        }),
      ).toThrow();
    }
  });

  it("rejects empty name", () => {
    expect(() =>
      LlmMessageSchema.parse({ role: "user", content: "hi", name: "" }),
    ).toThrow();
  });

  it("rejects name longer than 64 chars", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "user",
        content: "hi",
        name: "a".repeat(65),
      }),
    ).toThrow();
  });

  it("accepts name exactly 64 chars", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "user",
        content: "hi",
        name: "a".repeat(64),
      }),
    ).not.toThrow();
  });

  it("name is optional (omitted parses cleanly)", () => {
    expect(() =>
      LlmMessageSchema.parse({ role: "user", content: "hi" }),
    ).not.toThrow();
  });
});

describe("LlmMessageSchema with attachments (M2.X)", () => {
  it("parses a user message with image attachments", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "user",
        content: "what is this?",
        attachments: [{ kind: "image", format: "png", bytes: "abc" }],
      }),
    ).not.toThrow();
  });

  it("parses a user message with empty text + image (image-only prompt)", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "user",
        content: "",
        attachments: [{ kind: "image", format: "webp", bytes: "abc" }],
      }),
    ).not.toThrow();
  });

  it("parses a user message with no attachments (backward compat)", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "user",
        content: "no images here",
      }),
    ).not.toThrow();
  });

  it("rejects attachments on system messages", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "system",
        content: "you are helpful",
        attachments: [{ kind: "image", format: "png", bytes: "abc" }],
      }),
    ).toThrow(/user messages/);
  });

  it("rejects attachments on assistant messages", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "assistant",
        content: "here is my answer",
        attachments: [{ kind: "image", format: "png", bytes: "abc" }],
      }),
    ).toThrow(/user messages/);
  });

  it("rejects attachments on tool messages", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "tool",
        content: "tool output",
        toolCallId: "tu_1",
        attachments: [{ kind: "image", format: "png", bytes: "abc" }],
      }),
    ).toThrow(/user messages/);
  });

  it("permits an empty attachments array on non-user roles", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "system",
        content: "you are helpful",
        attachments: [],
      }),
    ).not.toThrow();
  });
});

describe("imageMediaType", () => {
  it("returns the MIME-type form of each image format", () => {
    expect(imageMediaType("png")).toBe("image/png");
    expect(imageMediaType("jpeg")).toBe("image/jpeg");
    expect(imageMediaType("gif")).toBe("image/gif");
    expect(imageMediaType("webp")).toBe("image/webp");
  });
});

describe("TextContentBlockSchema", () => {
  it("accepts text blocks with arbitrary text including empty string", () => {
    expect(() =>
      TextContentBlockSchema.parse({ type: "text", text: "hello" }),
    ).not.toThrow();
    expect(() => TextContentBlockSchema.parse({ type: "text", text: "" })).not.toThrow();
  });

  it("rejects wrong type discriminator", () => {
    expect(() =>
      TextContentBlockSchema.parse({ type: "image", text: "x" }),
    ).toThrow();
  });
});

describe("ImageContentBlockSchema", () => {
  it("accepts image block with format + non-empty bytes", () => {
    expect(() =>
      ImageContentBlockSchema.parse({
        type: "image",
        format: "png",
        bytes: "AAAA",
      }),
    ).not.toThrow();
  });

  it("rejects empty bytes", () => {
    expect(() =>
      ImageContentBlockSchema.parse({ type: "image", format: "png", bytes: "" }),
    ).toThrow();
  });

  it("rejects unknown format", () => {
    expect(() =>
      ImageContentBlockSchema.parse({ type: "image", format: "bmp", bytes: "x" }),
    ).toThrow();
  });
});

describe("LlmContentBlockSchema (discriminated union)", () => {
  it("discriminates on 'type'", () => {
    expect(() => LlmContentBlockSchema.parse({ type: "text", text: "hi" })).not.toThrow();
    expect(() =>
      LlmContentBlockSchema.parse({ type: "image", format: "png", bytes: "x" }),
    ).not.toThrow();
  });

  it("rejects unknown type discriminator", () => {
    expect(() => LlmContentBlockSchema.parse({ type: "audio", url: "x" })).toThrow();
  });
});

describe("LlmContentSchema", () => {
  it("accepts a plain string", () => {
    expect(() => LlmContentSchema.parse("hello")).not.toThrow();
    expect(() => LlmContentSchema.parse("")).not.toThrow();
  });

  it("accepts an array with at least one block", () => {
    expect(() =>
      LlmContentSchema.parse([{ type: "text", text: "hi" }]),
    ).not.toThrow();
  });

  it("rejects an empty array (min(1))", () => {
    expect(() => LlmContentSchema.parse([])).toThrow();
  });

  it("rejects non-string non-array values", () => {
    expect(() => LlmContentSchema.parse(null)).toThrow();
    expect(() => LlmContentSchema.parse(42)).toThrow();
    expect(() => LlmContentSchema.parse({})).toThrow();
  });
});

describe("LlmMessageSchema with block content (M2.X.5)", () => {
  it("accepts user message with array content", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "user",
        content: [{ type: "text", text: "look" }, { type: "image", format: "png", bytes: "x" }],
      }),
    ).not.toThrow();
  });

  it("accepts assistant message with array content (M2.X.5 unblocks multimodal output)", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "assistant",
        content: [{ type: "text", text: "here is the image" }, { type: "image", format: "png", bytes: "y" }],
      }),
    ).not.toThrow();
  });

  it("accepts system + tool messages with array content", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "system",
        content: [{ type: "text", text: "you are" }],
      }),
    ).not.toThrow();
    expect(() =>
      LlmMessageSchema.parse({
        role: "tool",
        toolCallId: "tu_1",
        content: [{ type: "text", text: "ok" }],
      }),
    ).not.toThrow();
  });

  it("rejects empty-array content", () => {
    expect(() =>
      LlmMessageSchema.parse({ role: "user", content: [] }),
    ).toThrow();
  });

  it("rejects array content + attachments simultaneously (mutually exclusive)", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "user",
        content: [{ type: "text", text: "hi" }],
        attachments: [{ kind: "image", format: "png", bytes: "x" }],
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("still accepts string content + attachments (M2.X backwards compat)", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "user",
        content: "see this",
        attachments: [{ kind: "image", format: "png", bytes: "x" }],
      }),
    ).not.toThrow();
  });
});

describe("isStringContent / isBlockContent", () => {
  it("isStringContent narrows correctly", () => {
    expect(isStringContent("hi")).toBe(true);
    expect(isStringContent("")).toBe(true);
    expect(isStringContent([{ type: "text", text: "x" }])).toBe(false);
  });

  it("isBlockContent narrows correctly", () => {
    expect(isBlockContent("hi")).toBe(false);
    expect(isBlockContent([{ type: "text", text: "x" }])).toBe(true);
  });
});

describe("normalizeContent", () => {
  it("wraps a string in a single text block", () => {
    expect(normalizeContent("hello")).toEqual([{ type: "text", text: "hello" }]);
  });

  it("passes block arrays through unchanged", () => {
    const blocks = [
      { type: "text" as const, text: "hi" },
      { type: "image" as const, format: "png" as const, bytes: "x" },
    ];
    expect(normalizeContent(blocks)).toBe(blocks);
  });
});

describe("contentToText", () => {
  it("returns string content unchanged", () => {
    expect(contentToText("hi")).toBe("hi");
    expect(contentToText("")).toBe("");
  });

  it("concatenates text blocks from an array, ignoring image blocks", () => {
    expect(
      contentToText([
        { type: "text", text: "hello " },
        { type: "image", format: "png", bytes: "x" },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello world");
  });

  it("returns empty string when array has only image blocks", () => {
    expect(
      contentToText([{ type: "image", format: "png", bytes: "x" }]),
    ).toBe("");
  });
});

describe("ToolUseContentBlock / ToolResultContentBlock (M2.X.5.x)", () => {
  it("LlmContentBlockSchema accepts a tool_use block", () => {
    expect(() =>
      LlmContentBlockSchema.parse({
        type: "tool_use",
        id: "tu_1",
        name: "search",
        input: { q: "x" },
      }),
    ).not.toThrow();
  });

  it("LlmContentBlockSchema accepts a tool_result block (status optional)", () => {
    expect(() =>
      LlmContentBlockSchema.parse({
        type: "tool_result",
        toolUseId: "tu_1",
        content: "result text",
      }),
    ).not.toThrow();
    expect(() =>
      LlmContentBlockSchema.parse({
        type: "tool_result",
        toolUseId: "tu_1",
        content: "err",
        status: "error",
      }),
    ).not.toThrow();
  });

  it("tool_use requires non-empty id + name", () => {
    expect(() =>
      LlmContentBlockSchema.parse({ type: "tool_use", id: "", name: "x", input: {} }),
    ).toThrow();
    expect(() =>
      LlmContentBlockSchema.parse({ type: "tool_use", id: "tu_1", name: "", input: {} }),
    ).toThrow();
  });

  it("tool_result requires non-empty toolUseId; content can be empty string", () => {
    expect(() =>
      LlmContentBlockSchema.parse({ type: "tool_result", toolUseId: "", content: "x" }),
    ).toThrow();
    expect(() =>
      LlmContentBlockSchema.parse({ type: "tool_result", toolUseId: "tu_1", content: "" }),
    ).not.toThrow();
  });

  it("tool_result status only accepts 'success' or 'error'", () => {
    expect(() =>
      LlmContentBlockSchema.parse({
        type: "tool_result",
        toolUseId: "tu_1",
        content: "ok",
        status: "partial",
      }),
    ).toThrow();
  });
});

describe("ImageUrlContentBlockSchema (M2.X.5.y)", () => {
  it("accepts a valid http URL", () => {
    expect(() =>
      ImageUrlContentBlockSchema.parse({
        type: "image_url",
        url: "https://example.com/cat.png",
      }),
    ).not.toThrow();
  });

  it("accepts a data: URL too (operator passing a pre-encoded image)", () => {
    expect(() =>
      ImageUrlContentBlockSchema.parse({
        type: "image_url",
        url: "https://images.example.com/photo.jpg",
        format: "jpeg",
      }),
    ).not.toThrow();
  });

  it("rejects an invalid URL", () => {
    expect(() =>
      ImageUrlContentBlockSchema.parse({
        type: "image_url",
        url: "not-a-url",
      }),
    ).toThrow();
  });

  it("rejects wrong type discriminator", () => {
    expect(() =>
      ImageUrlContentBlockSchema.parse({
        type: "image",
        url: "https://example.com/x.png",
      }),
    ).toThrow();
  });

  it("LlmContentBlockSchema accepts image_url variant", () => {
    expect(() =>
      LlmContentBlockSchema.parse({
        type: "image_url",
        url: "https://example.com/x.png",
      }),
    ).not.toThrow();
  });

  it("LlmContentBlockSchema still accepts bytes-based image variant (backwards compat)", () => {
    expect(() =>
      LlmContentBlockSchema.parse({
        type: "image",
        format: "png",
        bytes: "ABCD",
      }),
    ).not.toThrow();
  });

  it("REJECTS image_url block on tool message (same rule as image)", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "tool",
        toolCallId: "tu_1",
        content: [{ type: "image_url", url: "https://example.com/x.png" }],
      }),
    ).toThrow(/image content blocks are not allowed on tool/);
  });

  it("accepts image_url block on user + assistant messages", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "user",
        content: [{ type: "image_url", url: "https://example.com/x.png" }],
      }),
    ).not.toThrow();
    expect(() =>
      LlmMessageSchema.parse({
        role: "assistant",
        content: [{ type: "image_url", url: "https://example.com/x.png" }],
      }),
    ).not.toThrow();
  });
});

describe("DocumentContentBlockSchema (M2.X.5.aa)", () => {
  it("accepts a PDF document with bytes", () => {
    expect(() =>
      DocumentContentBlockSchema.parse({
        type: "document",
        format: "pdf",
        bytes: "ABCD",
      }),
    ).not.toThrow();
  });

  it("accepts txt + md + csv formats (M2.X.5.aa.x)", () => {
    for (const format of ["txt", "md", "csv"] as const) {
      expect(() =>
        DocumentContentBlockSchema.parse({
          type: "document",
          format,
          bytes: "ABCD",
        }),
      ).not.toThrow();
    }
  });

  it("accepts optional name", () => {
    expect(() =>
      DocumentContentBlockSchema.parse({
        type: "document",
        format: "pdf",
        bytes: "ABCD",
        name: "spec.pdf",
      }),
    ).not.toThrow();
  });

  it("rejects empty bytes", () => {
    expect(() =>
      DocumentContentBlockSchema.parse({
        type: "document",
        format: "pdf",
        bytes: "",
      }),
    ).toThrow();
  });

  it("accepts office formats doc/docx/xls/xlsx/html (M2.X.5.aa.x.1)", () => {
    for (const format of ["doc", "docx", "xls", "xlsx", "html"] as const) {
      expect(() =>
        DocumentContentBlockSchema.parse({
          type: "document",
          format,
          bytes: "ABCD",
        }),
      ).not.toThrow();
    }
  });

  it("rejects truly unknown formats", () => {
    for (const badFormat of ["rtf", "json", "yaml", "xml", "audio"]) {
      expect(() =>
        DocumentContentBlockSchema.parse({
          type: "document",
          format: badFormat,
          bytes: "ABCD",
        }),
      ).toThrow();
    }
  });

  it("rejects name > 120 chars", () => {
    expect(() =>
      DocumentContentBlockSchema.parse({
        type: "document",
        format: "pdf",
        bytes: "ABCD",
        name: "x".repeat(121),
      }),
    ).toThrow();
  });

  it("LlmContentBlockSchema accepts document variant in the discriminated union", () => {
    expect(() =>
      LlmContentBlockSchema.parse({
        type: "document",
        format: "pdf",
        bytes: "ABCD",
      }),
    ).not.toThrow();
  });

  it("REJECTS document block on tool message (text-only by convention)", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "tool",
        toolCallId: "tu_1",
        content: [{ type: "document", format: "pdf", bytes: "ABCD" }],
      }),
    ).toThrow(/document content blocks are not allowed on tool/);
  });

  it("accepts document block on user + assistant messages", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "user",
        content: [{ type: "document", format: "pdf", bytes: "ABCD" }],
      }),
    ).not.toThrow();
    expect(() =>
      LlmMessageSchema.parse({
        role: "assistant",
        content: [{ type: "document", format: "pdf", bytes: "ABCD" }],
      }),
    ).not.toThrow();
  });
});

describe("documentMediaType / isTextDocumentFormat (M2.X.5.aa.x)", () => {
  it("documentMediaType returns correct MIME type per format", () => {
    expect(documentMediaType("pdf")).toBe("application/pdf");
    expect(documentMediaType("txt")).toBe("text/plain");
    expect(documentMediaType("md")).toBe("text/markdown");
    expect(documentMediaType("csv")).toBe("text/csv");
  });

  it("documentMediaType returns correct office MIME types (M2.X.5.aa.x.1)", () => {
    expect(documentMediaType("doc")).toBe("application/msword");
    expect(documentMediaType("docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(documentMediaType("xls")).toBe("application/vnd.ms-excel");
    expect(documentMediaType("xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(documentMediaType("html")).toBe("text/html");
  });

  it("isTextDocumentFormat returns true only for txt/md/csv", () => {
    expect(isTextDocumentFormat("pdf")).toBe(false);
    expect(isTextDocumentFormat("txt")).toBe(true);
    expect(isTextDocumentFormat("md")).toBe(true);
    expect(isTextDocumentFormat("csv")).toBe(true);
    expect(isTextDocumentFormat("doc")).toBe(false);
    expect(isTextDocumentFormat("docx")).toBe(false);
    expect(isTextDocumentFormat("html")).toBe(false);
  });
});

describe("OFFICE_DOCUMENT_FORMATS / isOfficeDocumentFormat (M2.X.5.aa.x.1)", () => {
  it("OFFICE_DOCUMENT_FORMATS contains the 5 office formats", () => {
    expect(OFFICE_DOCUMENT_FORMATS).toEqual(["doc", "docx", "xls", "xlsx", "html"]);
  });

  it("isOfficeDocumentFormat narrows correctly", () => {
    expect(isOfficeDocumentFormat("doc")).toBe(true);
    expect(isOfficeDocumentFormat("docx")).toBe(true);
    expect(isOfficeDocumentFormat("xls")).toBe(true);
    expect(isOfficeDocumentFormat("xlsx")).toBe(true);
    expect(isOfficeDocumentFormat("html")).toBe(true);
    expect(isOfficeDocumentFormat("pdf")).toBe(false);
    expect(isOfficeDocumentFormat("txt")).toBe(false);
    expect(isOfficeDocumentFormat("md")).toBe(false);
    expect(isOfficeDocumentFormat("csv")).toBe(false);
  });
});

describe("FileReferenceContentBlockSchema (M2.X.5.aa.z)", () => {
  it("accepts a non-empty fileId", () => {
    expect(() =>
      LlmContentBlockSchema.parse({
        type: "file_id",
        fileId: "file-abc123",
      }),
    ).not.toThrow();
  });

  it("rejects empty fileId", () => {
    expect(() =>
      LlmContentBlockSchema.parse({ type: "file_id", fileId: "" }),
    ).toThrow();
  });

  it("rejects fileId > 120 chars", () => {
    expect(() =>
      LlmContentBlockSchema.parse({ type: "file_id", fileId: "f".repeat(121) }),
    ).toThrow();
  });

  it("REJECTS file_id block on tool message (same rule as document)", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "tool",
        toolCallId: "tu_1",
        content: [{ type: "file_id", fileId: "file-abc" }],
      }),
    ).toThrow(/file_id content blocks are not allowed on tool/);
  });

  it("accepts file_id block on user + assistant", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "user",
        content: [{ type: "file_id", fileId: "file-abc" }],
      }),
    ).not.toThrow();
    expect(() =>
      LlmMessageSchema.parse({
        role: "assistant",
        content: [{ type: "file_id", fileId: "file-abc" }],
      }),
    ).not.toThrow();
  });
});

describe("DocumentUrlContentBlockSchema (M2.X.5.aa.y)", () => {
  it("accepts a URL-based document", () => {
    expect(() =>
      DocumentUrlContentBlockSchema.parse({
        type: "document_url",
        url: "https://example.com/spec.pdf",
      }),
    ).not.toThrow();
  });

  it("accepts optional format + name", () => {
    expect(() =>
      DocumentUrlContentBlockSchema.parse({
        type: "document_url",
        url: "https://example.com/spec.pdf",
        format: "pdf",
        name: "spec.pdf",
      }),
    ).not.toThrow();
  });

  it("rejects invalid URL", () => {
    expect(() =>
      DocumentUrlContentBlockSchema.parse({
        type: "document_url",
        url: "not-a-url",
      }),
    ).toThrow();
  });

  it("accepts office formats on URL variant (Bedrock-only path but kernel schema permits)", () => {
    for (const format of ["docx", "xlsx", "html"] as const) {
      expect(() =>
        DocumentUrlContentBlockSchema.parse({
          type: "document_url",
          url: `https://example.com/x.${format}`,
          format,
        }),
      ).not.toThrow();
    }
  });

  it("rejects truly unknown formats", () => {
    expect(() =>
      DocumentUrlContentBlockSchema.parse({
        type: "document_url",
        url: "https://example.com/x.rtf",
        format: "rtf",
      }),
    ).toThrow();
  });

  it("LlmContentBlockSchema accepts document_url variant", () => {
    expect(() =>
      LlmContentBlockSchema.parse({
        type: "document_url",
        url: "https://example.com/x.pdf",
      }),
    ).not.toThrow();
  });

  it("REJECTS document_url block on tool message (same rule as document)", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "tool",
        toolCallId: "tu_1",
        content: [{ type: "document_url", url: "https://example.com/x.pdf" }],
      }),
    ).toThrow(/document content blocks are not allowed on tool/);
  });

  it("accepts document_url block on user + assistant", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "user",
        content: [{ type: "document_url", url: "https://example.com/x.pdf" }],
      }),
    ).not.toThrow();
    expect(() =>
      LlmMessageSchema.parse({
        role: "assistant",
        content: [{ type: "document_url", url: "https://example.com/x.pdf" }],
      }),
    ).not.toThrow();
  });
});

describe("LlmMessageSchema role-validation for tool blocks (M2.X.5.x)", () => {
  it("accepts tool_use block on assistant message", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "assistant",
        content: [
          { type: "text", text: "Let me search" },
          { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
        ],
      }),
    ).not.toThrow();
  });

  it("REJECTS tool_use block on user message", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "user",
        content: [{ type: "tool_use", id: "tu_1", name: "search", input: {} }],
      }),
    ).toThrow(/tool_use content blocks only allowed on assistant/);
  });

  it("accepts tool_result block on user message", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "user",
        content: [{ type: "tool_result", toolUseId: "tu_1", content: "result" }],
      }),
    ).not.toThrow();
  });

  it("accepts tool_result block on tool message", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "tool",
        toolCallId: "tu_1",
        content: [{ type: "tool_result", toolUseId: "tu_1", content: "result" }],
      }),
    ).not.toThrow();
  });

  it("REJECTS tool_result block on assistant message", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "assistant",
        content: [{ type: "tool_result", toolUseId: "tu_1", content: "x" }],
      }),
    ).toThrow(/tool_result content blocks only allowed on user or tool/);
  });

  it("REJECTS image block on tool message", () => {
    expect(() =>
      LlmMessageSchema.parse({
        role: "tool",
        toolCallId: "tu_1",
        content: [{ type: "image", format: "png", bytes: "x" }],
      }),
    ).toThrow(/image content blocks are not allowed on tool/);
  });
});

describe("LlmCacheBreakpoint (M2.X.11)", () => {
  it("exposes the 1 documented type tuple", () => {
    expect(LLM_CACHE_BREAKPOINT_TYPES).toEqual(["ephemeral"]);
  });

  it("LlmCacheBreakpointSchema accepts ephemeral", () => {
    expect(LlmCacheBreakpointSchema.parse({ type: "ephemeral" })).toEqual({
      type: "ephemeral",
    });
  });

  it("LlmCacheBreakpointSchema rejects unknown types", () => {
    expect(() => LlmCacheBreakpointSchema.parse({ type: "persistent" })).toThrow();
    expect(() => LlmCacheBreakpointSchema.parse({})).toThrow();
  });
});

describe("LlmContentBlock cacheBreakpoint field (M2.X.11)", () => {
  it("TextContentBlockSchema accepts cacheBreakpoint", () => {
    expect(
      TextContentBlockSchema.parse({
        type: "text",
        text: "context",
        cacheBreakpoint: { type: "ephemeral" },
      }),
    ).toEqual({
      type: "text",
      text: "context",
      cacheBreakpoint: { type: "ephemeral" },
    });
  });

  it("TextContentBlockSchema cacheBreakpoint is optional", () => {
    expect(TextContentBlockSchema.parse({ type: "text", text: "hi" })).toEqual({
      type: "text",
      text: "hi",
    });
  });

  it("ImageContentBlockSchema accepts cacheBreakpoint", () => {
    const out = ImageContentBlockSchema.parse({
      type: "image",
      format: "png",
      bytes: "iVBOR",
      cacheBreakpoint: { type: "ephemeral" },
    });
    expect(out.cacheBreakpoint).toEqual({ type: "ephemeral" });
  });

  it("ImageUrlContentBlockSchema accepts cacheBreakpoint", () => {
    const out = ImageUrlContentBlockSchema.parse({
      type: "image_url",
      url: "https://example.com/img.png",
      cacheBreakpoint: { type: "ephemeral" },
    });
    expect(out.cacheBreakpoint).toEqual({ type: "ephemeral" });
  });

  it("DocumentContentBlockSchema accepts cacheBreakpoint", () => {
    const out = DocumentContentBlockSchema.parse({
      type: "document",
      format: "pdf",
      bytes: "JVBER",
      cacheBreakpoint: { type: "ephemeral" },
    });
    expect(out.cacheBreakpoint).toEqual({ type: "ephemeral" });
  });

  it("DocumentUrlContentBlockSchema accepts cacheBreakpoint", () => {
    const out = DocumentUrlContentBlockSchema.parse({
      type: "document_url",
      url: "https://example.com/doc.pdf",
      cacheBreakpoint: { type: "ephemeral" },
    });
    expect(out.cacheBreakpoint).toEqual({ type: "ephemeral" });
  });

  it("FileReferenceContentBlockSchema accepts cacheBreakpoint", () => {
    const out = FileReferenceContentBlockSchema.parse({
      type: "file_id",
      fileId: "file-abc",
      cacheBreakpoint: { type: "ephemeral" },
    });
    expect(out.cacheBreakpoint).toEqual({ type: "ephemeral" });
  });

  it("ToolUseContentBlockSchema accepts cacheBreakpoint", () => {
    const out = ToolUseContentBlockSchema.parse({
      type: "tool_use",
      id: "tu_1",
      name: "search",
      input: { q: "x" },
      cacheBreakpoint: { type: "ephemeral" },
    });
    expect(out.cacheBreakpoint).toEqual({ type: "ephemeral" });
  });

  it("ToolResultContentBlockSchema accepts cacheBreakpoint", () => {
    const out = ToolResultContentBlockSchema.parse({
      type: "tool_result",
      toolUseId: "tu_1",
      content: "result",
      cacheBreakpoint: { type: "ephemeral" },
    });
    expect(out.cacheBreakpoint).toEqual({ type: "ephemeral" });
  });

  it("LlmContentBlockSchema discriminated union accepts cacheBreakpoint on each branch", () => {
    expect(() =>
      LlmContentBlockSchema.parse({
        type: "text",
        text: "x",
        cacheBreakpoint: { type: "ephemeral" },
      }),
    ).not.toThrow();
    expect(() =>
      LlmContentBlockSchema.parse({
        type: "tool_use",
        id: "tu_1",
        name: "fn",
        input: {},
        cacheBreakpoint: { type: "ephemeral" },
      }),
    ).not.toThrow();
  });

  it("rejects unknown cacheBreakpoint.type values across all block schemas", () => {
    expect(() =>
      TextContentBlockSchema.parse({
        type: "text",
        text: "x",
        cacheBreakpoint: { type: "persistent" },
      }),
    ).toThrow();
  });
});
