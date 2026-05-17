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
  body: string;
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
