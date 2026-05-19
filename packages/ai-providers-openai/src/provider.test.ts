import type { CompletionChunk, CompletionRequest } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import { OpenAIError } from "./errors.js";
import { OpenAIProvider, type FetchLike, summarizeChatResponse } from "./provider.js";

const API_KEY = "sk-test-key";
const TENANT = "00000000-0000-4000-8000-000000000001";

const STREAM_SAMPLE = [
  `data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}`,
  `data: {"choices":[{"delta":{"content":" there"},"finish_reason":null}]}`,
  `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
  `data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}`,
  `data: [DONE]`,
  ``,
].join("\n\n");

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

function buildFetch(opts: {
  status?: number;
  responseBody?: string;
  asStream?: boolean;
  capture?: CapturedCall[];
  throwOnce?: Error;
} = {}): FetchLike {
  const status = opts.status ?? 200;
  const responseBody = opts.responseBody ?? STREAM_SAMPLE;
  let didThrow = false;
  return async (url, init) => {
    if (opts.capture !== undefined) {
      opts.capture.push({
        url,
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
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

function fixtureRequest(
  overrides: Partial<CompletionRequest> = {},
): CompletionRequest {
  return {
    task: "executor",
    messages: [{ role: "user", content: "Hello" }],
    tenantId: TENANT,
    sessionId: "sess-1",
    ...overrides,
  };
}

describe("OpenAIProvider — constructor", () => {
  it("rejects empty apiKey", () => {
    expect(() => new OpenAIProvider({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("rejects unsupported defaultChatModel", () => {
    expect(
      () =>
        new OpenAIProvider({
          apiKey: API_KEY,
          defaultChatModel: "gpt-bogus" as never,
        }),
    ).toThrow(/unsupported/);
  });

  it("exposes capabilities including embedding + jsonMode", () => {
    const provider = new OpenAIProvider({ apiKey: API_KEY });
    expect(provider.capabilities.embedding).toBe(true);
    expect(provider.capabilities.jsonMode).toBe(true);
    expect(provider.capabilities.toolUse).toBe(true);
  });

  it("threads pricing from defaultChatModel", () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      defaultChatModel: "gpt-4o",
    });
    expect(provider.pricing.inputPerMillionTokens).toBe(2.5);
    expect(provider.pricing.outputPerMillionTokens).toBe(10);
  });

  it("uses gpt-4o-mini as default", () => {
    const provider = new OpenAIProvider({ apiKey: API_KEY });
    expect(provider.pricing.inputPerMillionTokens).toBe(0.15);
  });
});

describe("OpenAIProvider.complete — streaming", () => {
  it("calls /v1/chat/completions with stream=true + correct headers", async () => {
    const captured: CapturedCall[] = [];
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({ asStream: true, capture: captured }),
    });
    for await (const _ of provider.complete(fixtureRequest())) void _;
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(captured[0]?.headers["accept"]).toBe("text/event-stream");
    const body = JSON.parse(captured[0]!.body) as Record<string, unknown>;
    expect(body["stream"]).toBe(true);
    expect((body["stream_options"] as { include_usage: boolean }).include_usage).toBe(true);
  });

  it("yields text chunks + usage_final", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({ asStream: true }),
    });
    const chunks: CompletionChunk[] = [];
    for await (const c of provider.complete(fixtureRequest())) chunks.push(c);
    const texts = chunks.filter((c) => c.kind === "text");
    expect(texts.map((c) => (c.kind === "text" ? c.text : ""))).toEqual([
      "Hello",
      " there",
    ]);
    const final = chunks.find((c) => c.kind === "usage_final");
    expect(final?.kind).toBe("usage_final");
    if (final?.kind === "usage_final") {
      expect(final.usage.inputTokens).toBe(8);
      expect(final.usage.outputTokens).toBe(2);
    }
  });

  it("forwards organization + project headers", async () => {
    const captured: CapturedCall[] = [];
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      organization: "org_x",
      project: "proj_y",
      fetch: buildFetch({ asStream: true, capture: captured }),
    });
    for await (const _ of provider.complete(fixtureRequest())) void _;
    expect(captured[0]?.headers["openai-organization"]).toBe("org_x");
    expect(captured[0]?.headers["openai-project"]).toBe("proj_y");
  });

  it("throws OpenAIError on non-2xx response", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({
        status: 401,
        responseBody: JSON.stringify({
          error: { type: "authentication_error", message: "bad key" },
        }),
      }),
    });
    await expect(async () => {
      for await (const _ of provider.complete(fixtureRequest())) void _;
    }).rejects.toThrow(OpenAIError);
  });

  it("throws network_error when fetch throws", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({ throwOnce: new Error("ECONNRESET") }),
    });
    await expect(async () => {
      for await (const _ of provider.complete(fixtureRequest())) void _;
    }).rejects.toMatchObject({ kind: "network_error" });
  });

  it("rejects unsupported model in request override", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({ asStream: true }),
    });
    await expect(async () => {
      for await (const _ of provider.complete(
        fixtureRequest({ model: "claude-sonnet-4-6" }),
      )) {
        void _;
      }
    }).rejects.toMatchObject({ kind: "invalid_request_error" });
  });

  it("rejects an embedding model in chat complete()", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({ asStream: true }),
    });
    await expect(async () => {
      for await (const _ of provider.complete(
        fixtureRequest({ model: "text-embedding-3-small" }),
      )) {
        void _;
      }
    }).rejects.toMatchObject({ kind: "invalid_request_error" });
  });
});

describe("OpenAIProvider.completeNonStreaming", () => {
  const NON_STREAM_RESPONSE = JSON.stringify({
    id: "chat_1",
    model: "gpt-4o-mini",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello there" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
  });

  it("parses the JSON response", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({ responseBody: NON_STREAM_RESPONSE }),
    });
    const response = await provider.completeNonStreaming(fixtureRequest());
    expect(response.choices[0]?.message.content).toBe("Hello there");
  });

  it("throws OpenAIError on bad JSON", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({ responseBody: "not-json" }),
    });
    await expect(provider.completeNonStreaming(fixtureRequest())).rejects.toMatchObject({
      kind: "api_error",
    });
  });
});

describe("OpenAIProvider.embed", () => {
  const EMBED_RESPONSE = JSON.stringify({
    object: "list",
    model: "text-embedding-3-small",
    data: [
      { object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 },
    ],
    usage: { prompt_tokens: 5, total_tokens: 5 },
  });

  it("calls /v1/embeddings and normalizes the response", async () => {
    const captured: CapturedCall[] = [];
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({ responseBody: EMBED_RESPONSE, capture: captured }),
    });
    const result = await provider.embed({
      texts: ["hello"],
      tenantId: TENANT,
    });
    expect(captured[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(result.vectors).toEqual([[0.1, 0.2, 0.3]]);
    expect(result.dim).toBe(3);
    expect(result.usage.inputTokens).toBe(5);
    expect(result.usage.cost).toBeGreaterThanOrEqual(0);
  });

  it("rejects a chat model in embed()", async () => {
    const provider = new OpenAIProvider({ apiKey: API_KEY });
    await expect(
      provider.embed({
        texts: ["x"],
        tenantId: TENANT,
        model: "gpt-4o",
      }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
  });

  it("throws OpenAIError on non-2xx", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({
        status: 401,
        responseBody: JSON.stringify({
          error: { type: "authentication_error", message: "bad key" },
        }),
      }),
    });
    await expect(
      provider.embed({ texts: ["x"], tenantId: TENANT }),
    ).rejects.toMatchObject({ kind: "authentication_error" });
  });
});

describe("summarizeChatResponse helper", () => {
  it("packs text + tool calls + finish_reason + normalized usage", () => {
    const summary = summarizeChatResponse(
      {
        id: "chat_2",
        model: "gpt-4o-mini",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      "gpt-4o-mini",
    );
    expect(summary.text).toBe("ok");
    expect(summary.toolCalls).toEqual([]);
    expect(summary.finishReason).toBe("stop");
    expect(summary.usage.cost).toBeGreaterThan(0);
  });
});

const RESPONSES_STREAM_SAMPLE = [
  `event: response.created\ndata: {"response":{"id":"resp_1"}}`,
  `event: response.output_text.delta\ndata: {"delta":"Hello"}`,
  `event: response.output_text.delta\ndata: {"delta":" world"}`,
  `event: response.completed\ndata: {"response":{"id":"resp_1","usage":{"input_tokens":9,"output_tokens":3,"total_tokens":12}}}`,
  ``,
].join("\n\n");

describe("OpenAIProvider — Responses API path", () => {
  it("complete() routes to /v1/responses when defaultApiPath = 'responses'", async () => {
    const captured: CapturedCall[] = [];
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      defaultApiPath: "responses",
      fetch: buildFetch({ asStream: true, capture: captured, responseBody: RESPONSES_STREAM_SAMPLE }),
    });
    for await (const _ of provider.complete(fixtureRequest())) void _;
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://api.openai.com/v1/responses");
  });

  it("completeViaResponses() yields text + usage_final from a streamed response", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({ asStream: true, responseBody: RESPONSES_STREAM_SAMPLE }),
    });
    const chunks: CompletionChunk[] = [];
    for await (const c of provider.completeViaResponses(fixtureRequest())) {
      chunks.push(c);
    }
    const texts = chunks.filter((c) => c.kind === "text");
    expect(texts.map((c) => (c.kind === "text" ? c.text : ""))).toEqual([
      "Hello",
      " world",
    ]);
    const final = chunks.find((c) => c.kind === "usage_final");
    if (final?.kind === "usage_final") {
      expect(final.usage.inputTokens).toBe(9);
      expect(final.usage.outputTokens).toBe(3);
    }
  });

  it("threads reasoningEffort into the request body", async () => {
    const captured: CapturedCall[] = [];
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      reasoningEffort: "high",
      fetch: buildFetch({ asStream: true, capture: captured, responseBody: RESPONSES_STREAM_SAMPLE }),
    });
    for await (const _ of provider.completeViaResponses(fixtureRequest())) void _;
    const body = JSON.parse(captured[0]!.body) as { reasoning?: { effort: string } };
    expect(body.reasoning?.effort).toBe("high");
  });

  it("complete() defaults to chat path when defaultApiPath unset", async () => {
    const captured: CapturedCall[] = [];
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({ asStream: true, capture: captured }),
    });
    for await (const _ of provider.complete(fixtureRequest())) void _;
    expect(captured[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("respondNonStreaming() parses a Responses API response", async () => {
    const NON_STREAM_RESPONSE = JSON.stringify({
      id: "resp_1",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          role: "assistant",
          content: [{ type: "output_text", text: "Hi!" }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
    });
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({ responseBody: NON_STREAM_RESPONSE }),
    });
    const response = await provider.respondNonStreaming(fixtureRequest());
    expect(response.status).toBe("completed");
    expect(response.output[0]).toMatchObject({ role: "assistant" });
  });

  it("respondNonStreaming() throws OpenAIError on bad JSON", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({ responseBody: "not-json" }),
    });
    await expect(provider.respondNonStreaming(fixtureRequest())).rejects.toMatchObject({
      kind: "api_error",
    });
  });

  it("propagates network errors as OpenAIError with network_error kind", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({ throwOnce: new Error("ECONNRESET") }),
    });
    await expect(async () => {
      for await (const _ of provider.completeViaResponses(fixtureRequest())) void _;
    }).rejects.toMatchObject({ kind: "network_error" });
  });
});

describe("summarizeResponsesResponse helper", () => {
  it("packs text + tool calls + reasoning + status + usage", async () => {
    const { summarizeResponsesResponse } = await import("./provider.js");
    const summary = summarizeResponsesResponse(
      {
        id: "resp_2",
        object: "response",
        model: "gpt-4o",
        status: "completed",
        output: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "thinking" }],
          },
          { role: "assistant", content: [{ type: "output_text", text: "ok" }] },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
      "gpt-4o-mini",
    );
    expect(summary.text).toBe("ok");
    expect(summary.reasoningSummary).toBe("thinking");
    expect(summary.status).toBe("completed");
    expect(summary.usage.inputTokens).toBe(10);
  });
});

describe("OpenAIProvider Files API (M2.X.5.aa.z)", () => {
  function fileResponse(): string {
    return JSON.stringify({
      id: "file-abc123",
      object: "file",
      bytes: 1024,
      created_at: 1700000000,
      filename: "spec.pdf",
      purpose: "user_data",
    });
  }

  it("uploadFile POSTs multipart/form-data to /v1/files and returns OpenAIFile", async () => {
    const captured: CapturedCall[] = [];
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({ capture: captured, responseBody: fileResponse() }),
    });
    const file = await provider.uploadFile({
      bytes: new TextEncoder().encode("PDF_BYTES"),
      filename: "spec.pdf",
      purpose: "user_data",
      contentType: "application/pdf",
    });
    expect(file.id).toBe("file-abc123");
    expect(file.purpose).toBe("user_data");
    expect(captured[0]!.url).toBe("https://api.openai.com/v1/files");
    expect(captured[0]!.method).toBe("POST");
    expect(captured[0]!.headers["content-type"]).toMatch(
      /^multipart\/form-data; boundary=/,
    );
  });

  it("uploadFile rejects invalid purpose at the provider boundary", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({}),
    });
    await expect(
      provider.uploadFile({
        bytes: new TextEncoder().encode("X"),
        filename: "x.pdf",
        purpose: "training" as never,
      }),
    ).rejects.toThrow(/invalid purpose/);
  });

  it("retrieveFile GETs /v1/files/{file_id}", async () => {
    const captured: CapturedCall[] = [];
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({ capture: captured, responseBody: fileResponse() }),
    });
    const file = await provider.retrieveFile("file-abc123");
    expect(file.id).toBe("file-abc123");
    expect(captured[0]!.url).toBe("https://api.openai.com/v1/files/file-abc123");
    expect(captured[0]!.method).toBe("GET");
  });

  it("retrieveFile rejects empty fileId", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({}),
    });
    await expect(provider.retrieveFile("")).rejects.toThrow(/fileId is required/);
  });

  it("deleteFile DELETEs /v1/files/{file_id} + returns deleted: true", async () => {
    const captured: CapturedCall[] = [];
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({
        capture: captured,
        responseBody: JSON.stringify({
          id: "file-abc123",
          object: "file",
          deleted: true,
        }),
      }),
    });
    const result = await provider.deleteFile("file-abc123");
    expect(result.deleted).toBe(true);
    expect(captured[0]!.url).toBe("https://api.openai.com/v1/files/file-abc123");
    expect(captured[0]!.method).toBe("DELETE");
  });

  it("deleteFile surfaces HTTP errors as OpenAIError", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({
        status: 404,
        responseBody: JSON.stringify({
          error: { type: "not_found_error", message: "file not found" },
        }),
      }),
    });
    await expect(provider.deleteFile("file-bogus")).rejects.toMatchObject({
      kind: "not_found_error",
    });
  });
});

describe("OpenAIProvider.moderate (M2.X.8)", () => {
  function moderationResponse(opts: { flagged: boolean; model?: string }): string {
    const cats = Object.fromEntries(
      [
        "sexual",
        "hate",
        "harassment",
        "self-harm",
        "sexual/minors",
        "hate/threatening",
        "violence/graphic",
        "self-harm/intent",
        "self-harm/instructions",
        "harassment/threatening",
        "violence",
      ].map((k) => [k, false]),
    );
    if (opts.flagged) cats["violence"] = true;
    const scores = Object.fromEntries(Object.keys(cats).map((k) => [k, 0.01]));
    if (opts.flagged) scores["violence"] = 0.92;
    return JSON.stringify({
      id: "modr_1",
      model: opts.model ?? "omni-moderation-latest",
      results: [
        {
          flagged: opts.flagged,
          categories: cats,
          category_scores: scores,
        },
      ],
    });
  }

  it("calls /v1/moderations with the default omni-moderation model + reports unflagged input", async () => {
    const captured: CapturedCall[] = [];
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({
        capture: captured,
        responseBody: moderationResponse({ flagged: false }),
      }),
    });
    const result = await provider.moderate({ input: "is this OK?" });
    expect(captured[0]!.url).toBe("https://api.openai.com/v1/moderations");
    expect(captured[0]!.method).toBe("POST");
    const body = JSON.parse(captured[0]!.body) as {
      model: string;
      input: string;
    };
    expect(body.model).toBe("omni-moderation-latest");
    expect(body.input).toBe("is this OK?");
    expect(result.anyFlagged).toBe(false);
    expect(result.flaggedCategoriesPerResult[0]).toEqual([]);
  });

  it("reports flagged input + the flagged category list", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({
        responseBody: moderationResponse({ flagged: true }),
      }),
    });
    const result = await provider.moderate({ input: "violent content" });
    expect(result.anyFlagged).toBe(true);
    expect(result.flaggedCategoriesPerResult[0]).toEqual(["violence"]);
  });

  it("accepts an explicit model override", async () => {
    const captured: CapturedCall[] = [];
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({
        capture: captured,
        responseBody: moderationResponse({
          flagged: false,
          model: "text-moderation-latest",
        }),
      }),
    });
    await provider.moderate({
      input: "x",
      model: "text-moderation-latest",
    });
    const body = JSON.parse(captured[0]!.body) as { model: string };
    expect(body.model).toBe("text-moderation-latest");
  });

  it("accepts an array of inputs", async () => {
    const captured: CapturedCall[] = [];
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({
        capture: captured,
        responseBody: moderationResponse({ flagged: false }),
      }),
    });
    await provider.moderate({ input: ["one", "two", "three"] });
    const body = JSON.parse(captured[0]!.body) as { input: string[] };
    expect(body.input).toEqual(["one", "two", "three"]);
  });

  it("uses defaultModerationModel from constructor when none is passed per-call", async () => {
    const captured: CapturedCall[] = [];
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      defaultModerationModel: "text-moderation-stable",
      fetch: buildFetch({
        capture: captured,
        responseBody: moderationResponse({
          flagged: false,
          model: "text-moderation-stable",
        }),
      }),
    });
    await provider.moderate({ input: "x" });
    const body = JSON.parse(captured[0]!.body) as { model: string };
    expect(body.model).toBe("text-moderation-stable");
  });

  it("throws on empty string input (caught at request-build time)", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({}),
    });
    await expect(provider.moderate({ input: "" })).rejects.toThrow(/empty/);
  });

  it("constructor rejects unknown defaultModerationModel", () => {
    expect(
      () =>
        new OpenAIProvider({
          apiKey: API_KEY,
          defaultModerationModel: "gpt-4o" as never,
        }),
    ).toThrow(/unsupported defaultModerationModel/);
  });

  it("rejects unknown model passed to moderate() call", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({}),
    });
    await expect(
      provider.moderate({ input: "x", model: "gpt-4o" as never }),
    ).rejects.toThrow(/not a known OpenAI moderation model/);
  });

  it("surfaces HTTP errors via fromHttpResponse → OpenAIError", async () => {
    const provider = new OpenAIProvider({
      apiKey: API_KEY,
      fetch: buildFetch({
        status: 429,
        responseBody: JSON.stringify({
          error: { type: "rate_limit_exceeded", message: "slow down" },
        }),
      }),
    });
    await expect(provider.moderate({ input: "x" })).rejects.toMatchObject({
      kind: "rate_limit_error",
    });
  });
});
