import type { CompletionChunk, CompletionRequest, EmbeddingRequest } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";
import { OpenAiError } from "./errors.js";
import { OpenAiProvider, type FetchLike } from "./provider.js";

const API_KEY = "sk-openai-test";
const TENANT = "00000000-0000-4000-8000-000000000001";

const TEXT_STREAM = `data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}

data: [DONE]

`;

const NON_STREAM_RESPONSE = JSON.stringify({
  id: "chatcmpl_1",
  model: "gpt-4o",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Hi" } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
});

const EMBED_RESPONSE = JSON.stringify({
  data: [
    { embedding: [0.3, 0.4], index: 1 },
    { embedding: [0.1, 0.2], index: 0 },
  ],
  model: "text-embedding-3-small",
  usage: { prompt_tokens: 100_000, total_tokens: 100_000 },
});

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function buildFetch(opts: {
  status?: number;
  body?: string;
  asStream?: boolean;
  capture?: Captured[];
  throwErr?: Error;
} = {}): FetchLike {
  const status = opts.status ?? 200;
  return async (url, init) => {
    opts.capture?.push({ url, headers: init.headers, body: init.body });
    if (opts.throwErr !== undefined) throw opts.throwErr;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => opts.body ?? "",
      body: opts.asStream === true ? streamFrom(opts.body ?? TEXT_STREAM) : null,
    };
  };
}

function provider(fetch: FetchLike): OpenAiProvider {
  return new OpenAiProvider({ apiKey: API_KEY, defaultModel: "gpt-4o", fetch });
}

function req(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    task: "executor",
    messages: [{ role: "user", content: "hi" }],
    tenantId: TENANT,
    sessionId: "sess_1",
    ...overrides,
  };
}

describe("OpenAiProvider construction", () => {
  it("advertises chat + embedding capabilities and lists models", () => {
    const p = provider(buildFetch());
    expect(p.id).toBe("openai");
    expect(p.capabilities.embedding).toBe(true);
    expect(p.capabilities.jsonMode).toBe(true);
    expect(p.models).toContain("gpt-4o");
    expect(p.models).toContain("text-embedding-3-small");
  });

  it("rejects an unknown default model", () => {
    expect(() => new OpenAiProvider({ apiKey: API_KEY, defaultModel: "nope" as never })).toThrow();
  });

  it("requires an api key", () => {
    expect(() => new OpenAiProvider({ apiKey: "", defaultModel: "gpt-4o" })).toThrow();
  });
});

describe("OpenAiProvider.complete", () => {
  it("streams text + usage and sends a Bearer auth header", async () => {
    const capture: Captured[] = [];
    const p = provider(buildFetch({ asStream: true, capture }));
    const chunks: CompletionChunk[] = [];
    for await (const chunk of p.complete(req())) chunks.push(chunk);
    expect(chunks.filter((c) => c.kind === "text")).toHaveLength(1);
    expect(chunks.at(-1)?.kind).toBe("usage_final");
    expect(capture[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(capture[0]?.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(capture[0]?.body ?? "{}").stream).toBe(true);
  });

  it("throws a classified OpenAiError on non-2xx", async () => {
    const p = provider(buildFetch({ status: 429, body: JSON.stringify({ error: { message: "slow" } }) }));
    await expect(async () => {
      for await (const _ of p.complete(req())) void _;
    }).rejects.toMatchObject({ kind: "rate_limit_error", status: 429 });
  });

  it("wraps network failures", async () => {
    const p = provider(buildFetch({ throwErr: new Error("ECONNRESET") }));
    await expect(async () => {
      for await (const _ of p.complete(req())) void _;
    }).rejects.toBeInstanceOf(OpenAiError);
  });

  it("rejects an unsupported chat model", async () => {
    const p = provider(buildFetch({ asStream: true }));
    await expect(async () => {
      for await (const _ of p.complete(req({ model: "text-embedding-3-small" }))) void _;
    }).rejects.toMatchObject({ kind: "invalid_request_error" });
  });
});

describe("OpenAiProvider.embed", () => {
  it("returns vectors ordered by index with usage cost", async () => {
    const capture: Captured[] = [];
    const p = provider(buildFetch({ body: EMBED_RESPONSE, capture }));
    const res = await p.embed({ texts: ["a", "b"], tenantId: TENANT } satisfies EmbeddingRequest);
    expect(capture[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(res.vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(res.dim).toBe(2);
    expect(res.model).toBe("text-embedding-3-small");
    expect(res.usage.inputTokens).toBe(100_000);
    expect(res.usage.cost).toBeGreaterThan(0);
  });

  it("rejects a non-embedding model", async () => {
    const p = provider(buildFetch({ body: EMBED_RESPONSE }));
    await expect(p.embed({ texts: ["a"], tenantId: TENANT, model: "gpt-4o" })).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
  });
});

describe("OpenAiProvider.completeNonStreaming", () => {
  it("parses a chat completion response", async () => {
    const p = provider(buildFetch({ body: NON_STREAM_RESPONSE }));
    const res = await p.completeNonStreaming(req());
    expect(res.choices[0]?.message.content).toBe("Hi");
    expect(res.usage.prompt_tokens).toBe(10);
  });
});
