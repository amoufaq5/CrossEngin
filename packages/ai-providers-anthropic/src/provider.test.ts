import type { CompletionChunk, CompletionRequest } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import { AnthropicError } from "./errors.js";
import { AnthropicProvider, type FetchLike, summarizeResponse } from "./provider.js";

const API_KEY = "sk-ant-test-key";
const TENANT = "00000000-0000-4000-8000-000000000001";
const SESSION = "sess_abc";

const STREAM_SAMPLE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":15,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","usage":{"output_tokens":8}}

event: message_stop
data: {"type":"message_stop"}

`;

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

function buildFetch(
  opts: {
    status?: number;
    responseBody?: string;
    asStream?: boolean;
    capture?: CapturedCall[];
    throwOnce?: Error;
  } = {},
): FetchLike {
  const status = opts.status ?? 200;
  const responseBody = opts.responseBody ?? STREAM_SAMPLE;
  let didThrow = false;
  return async (url, init) => {
    if (opts.capture !== undefined) {
      opts.capture.push({ url, method: init.method, headers: init.headers, body: init.body });
    }
    if (opts.throwOnce !== undefined && !didThrow) {
      didThrow = true;
      throw opts.throwOnce;
    }
    if (opts.asStream === true) {
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => responseBody,
        body: streamFrom(responseBody),
      };
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => responseBody,
      body: null,
    };
  };
}

function fixtureRequest(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    task: "executor",
    messages: [{ role: "user", content: "Hello" }],
    tenantId: TENANT,
    sessionId: SESSION,
    ...overrides,
  };
}

describe("AnthropicProvider — constructor", () => {
  it("rejects empty apiKey", () => {
    expect(
      () =>
        new AnthropicProvider({
          apiKey: "",
          defaultModel: "claude-sonnet-4-6",
        }),
    ).toThrow(/apiKey/);
  });

  it("rejects unsupported defaultModel", () => {
    expect(
      () =>
        new AnthropicProvider({
          apiKey: API_KEY,
          defaultModel: "gpt-4" as never,
        }),
    ).toThrow(/unsupported/);
  });

  it("exposes capabilities", () => {
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-sonnet-4-6",
    });
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.toolUse).toBe(true);
    expect(provider.capabilities.embedding).toBe(false);
  });

  it("threads pricing from defaultModel", () => {
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-opus-4-7",
    });
    expect(provider.pricing.inputPerMillionTokens).toBe(15);
    expect(provider.pricing.outputPerMillionTokens).toBe(75);
  });
});

describe("AnthropicProvider.complete (streaming)", () => {
  it("calls /v1/messages with stream + correct headers", async () => {
    const captured: CapturedCall[] = [];
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-sonnet-4-6",
      fetch: buildFetch({ asStream: true, capture: captured }),
    });
    const chunks: CompletionChunk[] = [];
    for await (const chunk of provider.complete(fixtureRequest())) {
      chunks.push(chunk);
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.headers["x-api-key"]).toBe(API_KEY);
    expect(captured[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured[0]?.headers["accept"]).toBe("text/event-stream");
    const body = JSON.parse(captured[0]!.body as string) as Record<string, unknown>;
    expect(body["stream"]).toBe(true);
    expect(body["model"]).toBe("claude-sonnet-4-6");
  });

  it("yields text chunks + usage_final", async () => {
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-sonnet-4-6",
      fetch: buildFetch({ asStream: true }),
    });
    const chunks: CompletionChunk[] = [];
    for await (const chunk of provider.complete(fixtureRequest())) {
      chunks.push(chunk);
    }
    const texts = chunks.filter((c) => c.kind === "text");
    expect(texts.map((c) => (c.kind === "text" ? c.text : ""))).toEqual(["Hello", " there"]);
    const final = chunks.find((c) => c.kind === "usage_final");
    expect(final?.kind).toBe("usage_final");
    if (final?.kind === "usage_final") {
      expect(final.usage.inputTokens).toBe(15);
      expect(final.usage.outputTokens).toBe(8);
    }
  });

  it("throws AnthropicError on non-2xx response", async () => {
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-sonnet-4-6",
      fetch: buildFetch({
        status: 401,
        responseBody: JSON.stringify({
          error: { type: "authentication_error", message: "bad key" },
        }),
      }),
    });
    await expect(async () => {
      for await (const _ of provider.complete(fixtureRequest())) {
        void _;
      }
    }).rejects.toThrow(AnthropicError);
  });

  it("throws network_error AnthropicError when fetch throws", async () => {
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-sonnet-4-6",
      fetch: buildFetch({ throwOnce: new Error("ECONNRESET") }),
    });
    await expect(async () => {
      for await (const _ of provider.complete(fixtureRequest())) {
        void _;
      }
    }).rejects.toMatchObject({ kind: "network_error" });
  });

  it("rejects unsupported model in request override", async () => {
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-sonnet-4-6",
      fetch: buildFetch({ asStream: true }),
    });
    await expect(async () => {
      for await (const _ of provider.complete(fixtureRequest({ model: "gpt-4o" }))) {
        void _;
      }
    }).rejects.toMatchObject({ kind: "invalid_request_error" });
  });
});

describe("AnthropicProvider.completeNonStreaming", () => {
  const NON_STREAM_RESPONSE = JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "Hello there" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 15, output_tokens: 8 },
  });

  it("parses the JSON response into AnthropicResponse", async () => {
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-sonnet-4-6",
      fetch: buildFetch({ responseBody: NON_STREAM_RESPONSE }),
    });
    const response = await provider.completeNonStreaming(fixtureRequest());
    expect(response.content).toHaveLength(1);
    expect(response.usage.input_tokens).toBe(15);
  });

  it("throws AnthropicError on bad JSON", async () => {
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-sonnet-4-6",
      fetch: buildFetch({ responseBody: "not-json" }),
    });
    await expect(provider.completeNonStreaming(fixtureRequest())).rejects.toMatchObject({
      kind: "api_error",
    });
  });
});

describe("AnthropicProvider.embed", () => {
  it("throws invalid_request_error (Anthropic has no embeddings API)", async () => {
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-sonnet-4-6",
    });
    await expect(provider.embed({ texts: ["hello"], tenantId: TENANT })).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
  });
});

describe("AnthropicProvider — anthropic-beta header", () => {
  it("forwards beta features when supplied", async () => {
    const captured: CapturedCall[] = [];
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-sonnet-4-6",
      fetch: buildFetch({ asStream: true, capture: captured }),
      anthropicBeta: ["prompt-caching-2024-07-31", "tool-streaming-2024-04-04"],
    });
    for await (const _ of provider.complete(fixtureRequest())) {
      void _;
    }
    expect(captured[0]?.headers["anthropic-beta"]).toBe(
      "prompt-caching-2024-07-31,tool-streaming-2024-04-04",
    );
  });
});

describe("summarizeResponse helper", () => {
  it("packs text + tool calls + stop reason + normalized usage", () => {
    const summary = summarizeResponse(
      {
        id: "msg_2",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      "claude-sonnet-4-6",
    );
    expect(summary.text).toBe("ok");
    expect(summary.toolCalls).toEqual([]);
    expect(summary.stopReason).toBe("end_turn");
    expect(summary.usage.cost).toBeGreaterThan(0);
  });
});

describe("AnthropicProvider Files API (M2.X.5.aa.z.1)", () => {
  function fileResponseBody(): string {
    return JSON.stringify({
      id: "file_abc123",
      type: "file",
      filename: "spec.pdf",
      mime_type: "application/pdf",
      size_bytes: 1024,
      created_at: "2026-01-01T00:00:00Z",
    });
  }

  function buildProvider(opts: Parameters<typeof buildFetch>[0]): AnthropicProvider {
    return new AnthropicProvider({
      apiKey: "sk-ant-test",
      defaultModel: "claude-sonnet-4-6",
      fetch: buildFetch(opts),
    });
  }

  it("uploadFile POSTs multipart/form-data to /v1/files with the beta header", async () => {
    const captured: CapturedCall[] = [];
    const provider = buildProvider({
      capture: captured,
      responseBody: fileResponseBody(),
    });
    const file = await provider.uploadFile({
      bytes: new TextEncoder().encode("PDF_BYTES"),
      filename: "spec.pdf",
      contentType: "application/pdf",
    });
    expect(file.id).toBe("file_abc123");
    expect(file.type).toBe("file");
    expect(captured[0]!.url).toBe("https://api.anthropic.com/v1/files");
    expect(captured[0]!.method).toBe("POST");
    expect(captured[0]!.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(captured[0]!.headers["anthropic-beta"]).toContain("files-api-2025-04-14");
  });

  it("retrieveFile GETs /v1/files/{id} with the beta header", async () => {
    const captured: CapturedCall[] = [];
    const provider = buildProvider({
      capture: captured,
      responseBody: fileResponseBody(),
    });
    const file = await provider.retrieveFile("file_abc123");
    expect(file.id).toBe("file_abc123");
    expect(captured[0]!.url).toBe("https://api.anthropic.com/v1/files/file_abc123");
    expect(captured[0]!.method).toBe("GET");
    expect(captured[0]!.headers["anthropic-beta"]).toContain("files-api-2025-04-14");
  });

  it("retrieveFile rejects empty fileId", async () => {
    const provider = buildProvider({});
    await expect(provider.retrieveFile("")).rejects.toThrow(/fileId is required/);
  });

  it("deleteFile DELETEs /v1/files/{id} and returns the deletion envelope", async () => {
    const captured: CapturedCall[] = [];
    const provider = buildProvider({
      capture: captured,
      responseBody: JSON.stringify({
        id: "file_abc123",
        type: "file_deleted",
      }),
    });
    const result = await provider.deleteFile("file_abc123");
    expect(result.type).toBe("file_deleted");
    expect(captured[0]!.method).toBe("DELETE");
  });

  it("deleteFile surfaces HTTP errors as AnthropicError", async () => {
    const provider = buildProvider({
      status: 404,
      responseBody: JSON.stringify({
        error: { type: "not_found_error", message: "file not found" },
      }),
    });
    await expect(provider.deleteFile("file_bogus")).rejects.toMatchObject({
      kind: "not_found_error",
    });
  });

  it("listFiles GETs /v1/files without query when called with no options (M2.X.5.aa.z.2)", async () => {
    const captured: CapturedCall[] = [];
    const provider = buildProvider({
      capture: captured,
      responseBody: JSON.stringify({
        data: [
          {
            id: "file_a",
            type: "file",
            filename: "a.pdf",
            mime_type: "application/pdf",
            size_bytes: 100,
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            id: "file_b",
            type: "file",
            filename: "b.pdf",
            mime_type: "application/pdf",
            size_bytes: 200,
            created_at: "2026-01-02T00:00:00Z",
          },
        ],
        has_more: false,
        first_id: "file_a",
        last_id: "file_b",
      }),
    });
    const result = await provider.listFiles();
    expect(result.data).toHaveLength(2);
    expect(result.has_more).toBe(false);
    expect(captured[0]!.url).toBe("https://api.anthropic.com/v1/files");
    expect(captured[0]!.method).toBe("GET");
    expect(captured[0]!.headers["anthropic-beta"]).toContain("files-api-2025-04-14");
  });

  it("listFiles passes limit / before_id / after_id / order as query params", async () => {
    const captured: CapturedCall[] = [];
    const provider = buildProvider({
      capture: captured,
      responseBody: JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }),
    });
    await provider.listFiles({
      limit: 25,
      beforeId: "file_x",
      afterId: "file_y",
      order: "desc",
    });
    const url = new URL(captured[0]!.url);
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("before_id")).toBe("file_x");
    expect(url.searchParams.get("after_id")).toBe("file_y");
    expect(url.searchParams.get("order")).toBe("desc");
  });

  it("listFiles rejects limit < 1 or > 1000 (Anthropic's documented max)", async () => {
    const provider = buildProvider({});
    await expect(provider.listFiles({ limit: 0 })).rejects.toThrow(/limit must be/);
    await expect(provider.listFiles({ limit: 1001 })).rejects.toThrow(/limit must be/);
  });

  it("merges files-api beta with existing anthropicBeta headers (deduplicates)", async () => {
    const captured: CapturedCall[] = [];
    const provider = new AnthropicProvider({
      apiKey: "sk-ant-test",
      defaultModel: "claude-sonnet-4-6",
      anthropicBeta: ["files-api-2025-04-14", "other-beta-feature"],
      fetch: buildFetch({ capture: captured, responseBody: fileResponseBody() }),
    });
    await provider.retrieveFile("file_abc");
    const beta = captured[0]!.headers["anthropic-beta"]!;
    // Should contain files-api-2025-04-14 only once
    const matches = beta.match(/files-api-2025-04-14/g);
    expect(matches).toHaveLength(1);
    expect(beta).toContain("other-beta-feature");
  });
});
