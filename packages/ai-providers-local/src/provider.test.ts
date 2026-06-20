import { describe, expect, it } from "vitest";

import type { CompletionChunk, CompletionRequest, EmbeddingRequest } from "@crossengin/ai-providers";

import { LocalProviderError } from "./errors.js";
import {
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_LOCAL_MODEL,
  LocalLlmProvider,
  type FetchLike,
} from "./provider.js";

interface Captured {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function streamResponse(raw: string): ReturnType<FetchLike> {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(raw));
      controller.close();
    },
  });
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(raw), body });
}

function jsonResponse(obj: unknown, status = 200): ReturnType<FetchLike> {
  const text = JSON.stringify(obj);
  return Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(text), body: null });
}

function req(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    task: "executor",
    messages: [{ role: "user", content: "hi" }],
    tenantId: "t1",
    sessionId: "s1",
    ...overrides,
  };
}

function sse(...objs: unknown[]): string {
  return objs.map((o) => `data: ${typeof o === "string" ? o : JSON.stringify(o)}\n\n`).join("");
}

describe("LocalLlmProvider defaults", () => {
  it("defaults to the Ollama endpoint and zero pricing", () => {
    const p = new LocalLlmProvider();
    expect(p.id).toBe("local");
    expect(p.models).toEqual([DEFAULT_LOCAL_MODEL]);
    expect(p.pricing.inputPerMillionTokens).toBe(0);
    expect(p.capabilities.embedding).toBe(true);
    // Local inference satisfies every residency region.
    expect(p.residency).toContain("eu");
    expect(p.residency).toContain("us");
  });
});

describe("complete()", () => {
  it("streams chunks and posts to <baseUrl>/chat/completions", async () => {
    const captured: Captured[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      captured.push({ url, body: init.body, headers: init.headers });
      return streamResponse(
        sse(
          { choices: [{ index: 0, delta: { content: "hi there" }, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } },
          "[DONE]",
        ),
      );
    };
    const p = new LocalLlmProvider({ defaultModel: "llama3.1", fetch: fetchImpl });
    const chunks: CompletionChunk[] = [];
    for await (const c of p.complete(req())) chunks.push(c);

    expect(captured[0].url).toBe(`${DEFAULT_LOCAL_BASE_URL}/chat/completions`);
    expect(JSON.parse(captured[0].body).stream).toBe(true);
    const text = chunks
      .filter((c) => c.kind === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    expect(text).toBe("hi there");
    const final = chunks.at(-1) as Extract<CompletionChunk, { kind: "usage_final" }>;
    expect(final.usage.cost).toBe(0);
  });

  it("does not double the version segment in the URL", async () => {
    const captured: Captured[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      captured.push({ url, body: init.body, headers: init.headers });
      return streamResponse(sse("[DONE]"));
    };
    const p = new LocalLlmProvider({ baseUrl: "http://localhost:8000/v1/", fetch: fetchImpl });
    for await (const _ of p.complete(req())) void _;
    expect(captured[0].url).toBe("http://localhost:8000/v1/chat/completions");
  });

  it("sends a bearer token only when an apiKey is configured", async () => {
    const captured: Captured[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      captured.push({ url, body: init.body, headers: init.headers });
      return streamResponse(sse("[DONE]"));
    };
    const withKey = new LocalLlmProvider({ apiKey: "secret", fetch: fetchImpl });
    for await (const _ of withKey.complete(req())) void _;
    expect(captured[0].headers["authorization"]).toBe("Bearer secret");

    captured.length = 0;
    const noKey = new LocalLlmProvider({ fetch: fetchImpl });
    for await (const _ of noKey.complete(req())) void _;
    expect(captured[0].headers["authorization"]).toBeUndefined();
  });

  it("throws a classified error on a non-ok response", async () => {
    const fetchImpl: FetchLike = () =>
      jsonResponse({ error: 'model "x" not found, pulling' }, 404);
    const p = new LocalLlmProvider({ fetch: fetchImpl });
    await expect(async () => {
      for await (const _ of p.complete(req())) void _;
    }).rejects.toMatchObject({ kind: "model_not_loaded" });
  });

  it("wraps network failures", async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"));
    const p = new LocalLlmProvider({ fetch: fetchImpl });
    await expect(async () => {
      for await (const _ of p.complete(req())) void _;
    }).rejects.toBeInstanceOf(LocalProviderError);
  });
});

describe("embed()", () => {
  it("returns ordered vectors with zero cost", async () => {
    const fetchImpl: FetchLike = () =>
      jsonResponse({
        data: [
          { index: 1, embedding: [0.3, 0.4] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
        model: "nomic-embed-text",
        usage: { prompt_tokens: 6 },
      });
    const p = new LocalLlmProvider({ defaultEmbeddingModel: "nomic-embed-text", fetch: fetchImpl });
    const embReq: EmbeddingRequest = { texts: ["a", "b"], tenantId: "t1" };
    const res = await p.embed(embReq);
    expect(res.vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(res.dim).toBe(2);
    expect(res.usage.cost).toBe(0);
  });

  it("throws when no vectors come back", async () => {
    const fetchImpl: FetchLike = () => jsonResponse({ data: [] });
    const p = new LocalLlmProvider({ fetch: fetchImpl });
    await expect(p.embed({ texts: ["a"], tenantId: "t1" })).rejects.toBeInstanceOf(
      LocalProviderError,
    );
  });
});

describe("completeNonStreaming()", () => {
  it("returns the parsed response", async () => {
    const fetchImpl: FetchLike = () =>
      jsonResponse({
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    const p = new LocalLlmProvider({ fetch: fetchImpl });
    const res = await p.completeNonStreaming(req());
    expect(res.choices[0].message.content).toBe("ok");
  });
});
