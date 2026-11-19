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
    expect(provider.pricing.inputPerMillionTokens).toBe(5);
    expect(provider.pricing.outputPerMillionTokens).toBe(25);
  });

  it("reports a declared price, and charges it on the default model only", async () => {
    const declared = {
      inputUsdPerMillion: 1_000_000,
      cachedInputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      cacheWriteUsdPerMillion: 0,
    };
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-sonnet-4-6",
      pricingOverride: declared,
      fetch: buildFetch({ asStream: true }),
    });
    expect(provider.pricing.inputPerMillionTokens).toBe(1_000_000);
    const finalCost = async (req: CompletionRequest): Promise<number> => {
      let cost = -1;
      for await (const chunk of provider.complete(req)) {
        if (chunk.kind === "usage_final") cost = chunk.usage.cost;
      }
      return cost;
    };
    // 15 input tokens at the declared $1/token.
    expect(await finalCost(fixtureRequest())).toBeCloseTo(15, 6);
    // Another model is charged its catalogue price, not the price declared for the default.
    expect(await finalCost(fixtureRequest({ model: "claude-haiku-4-5" }))).toBeLessThan(0.001);
  });

  it("refuses an inactivity timeout that is not a positive number", () => {
    expect(
      () =>
        new AnthropicProvider({ apiKey: API_KEY, defaultModel: "claude-sonnet-4-6", inactivityTimeoutMs: 0 }),
    ).toThrow(/inactivity timeout/);
  });
});

describe("AnthropicProvider — inactivity timeout", () => {
  it("aborts a call whose response headers never arrive, and passes the signal to fetch", async () => {
    let seen: AbortSignal | undefined;
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-sonnet-4-6",
      inactivityTimeoutMs: 30,
      fetch: async (_url, init) => {
        seen = init.signal;
        return new Promise(() => undefined);
      },
    });
    const err = await (async () => {
      try {
        for await (const _ of provider.complete(fixtureRequest())) void _;
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AnthropicError);
    expect((err as AnthropicError).kind).toBe("timeout_error");
    expect(seen?.aborted).toBe(true);
  });

  it("aborts the non-streaming call the same way, and passes it the signal", async () => {
    let seen: AbortSignal | undefined;
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-sonnet-4-6",
      inactivityTimeoutMs: 30,
      fetch: async (_url, init) => {
        seen = init.signal;
        return new Promise(() => undefined);
      },
    });
    const err = await provider.completeNonStreaming(fixtureRequest()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AnthropicError);
    expect((err as AnthropicError).kind).toBe("timeout_error");
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(true);
  });

  it("aborts a stream that goes silent after its first event and releases the body", async () => {
    let cancelled = false;
    const enc = new TextEncoder();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl): Promise<void> | void {
        if (!sent) {
          sent = true;
          ctrl.enqueue(enc.encode(STREAM_SAMPLE.split("\n\n").slice(0, 3).join("\n\n") + "\n\n"));
          return;
        }
        return new Promise<void>(() => undefined);
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-sonnet-4-6",
      inactivityTimeoutMs: 30,
      fetch: async () => ({ ok: true, status: 200, text: async () => "", body }),
    });
    const texts: string[] = [];
    const err = await (async () => {
      try {
        for await (const chunk of provider.complete(fixtureRequest())) {
          if (chunk.kind === "text") texts.push(chunk.text);
        }
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(texts).toEqual(["Hello"]);
    expect((err as AnthropicError).kind).toBe("timeout_error");
    expect(cancelled).toBe(true);
  });

  it("cancels the body when the consumer stops iterating early", async () => {
    let cancelled = false;
    const enc = new TextEncoder();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl): Promise<void> | void {
        if (!sent) {
          sent = true;
          ctrl.enqueue(enc.encode(STREAM_SAMPLE.split("\n\n").slice(0, 3).join("\n\n") + "\n\n"));
          return;
        }
        return new Promise<void>(() => undefined);
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-sonnet-4-6",
      inactivityTimeoutMs: 60_000,
      fetch: async () => ({ ok: true, status: 200, text: async () => "", body }),
    });
    for await (const chunk of provider.complete(fixtureRequest())) {
      if (chunk.kind === "text") break;
    }
    expect(cancelled).toBe(true);
  });

  it("does not fire on a slow stream that never pauses for the full timeout", async () => {
    const enc = new TextEncoder();
    const events = STREAM_SAMPLE.split("\n\n").filter((e) => e.trim().length > 0);
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl): Promise<void> {
        if (i >= events.length) {
          ctrl.close();
          return;
        }
        await new Promise((r) => setTimeout(r, 15));
        ctrl.enqueue(enc.encode(`${events[i] ?? ""}\n\n`));
        i += 1;
      },
    });
    const provider = new AnthropicProvider({
      apiKey: API_KEY,
      defaultModel: "claude-sonnet-4-6",
      inactivityTimeoutMs: 60,
      fetch: async () => ({ ok: true, status: 200, text: async () => "", body }),
    });
    const chunks: CompletionChunk[] = [];
    for await (const chunk of provider.complete(fixtureRequest())) chunks.push(chunk);
    // 7 events x 15ms is longer than the 60ms timeout in total, and it completes.
    expect(chunks.some((c) => c.kind === "usage_final")).toBe(true);
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
    const body = JSON.parse(captured[0]!.body) as Record<string, unknown>;
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
        responseBody: JSON.stringify({ error: { type: "authentication_error", message: "bad key" } }),
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
    await expect(
      provider.embed({ texts: ["hello"], tenantId: TENANT }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
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
