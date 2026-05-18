import type { CompletionRequest } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import { BedrockError } from "./errors.js";
import { BedrockProvider, type FetchLike } from "./provider.js";

const FIXED_DATE = new Date("2026-05-18T12:00:00.000Z");

function baseReq(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    task: "planner",
    messages: [{ role: "user", content: "hello" }],
    tenantId: "ten-1",
    sessionId: "ses-1",
    ...overrides,
  };
}

interface FetchCapture {
  url: string | null;
  init: {
    method: string;
    headers: Record<string, string>;
    body: Uint8Array;
  } | null;
}

function buildFetch(opts: {
  ok?: boolean;
  status?: number;
  body?: ReadableStream<Uint8Array> | null;
  text?: string;
  arrayBuffer?: ArrayBuffer;
  throwError?: unknown;
  capture?: FetchCapture;
}): FetchLike {
  return async (url, init) => {
    if (opts.capture !== undefined) {
      opts.capture.url = url;
      opts.capture.init = init;
    }
    if (opts.throwError !== undefined) throw opts.throwError;
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      text: async () => opts.text ?? "",
      arrayBuffer: async () => opts.arrayBuffer ?? new ArrayBuffer(0),
      body: opts.body ?? null,
    };
  };
}

function build(opts: { fetch: FetchLike }): BedrockProvider {
  return new BedrockProvider({
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    fetch: opts.fetch,
    clock: () => FIXED_DATE,
  });
}

describe("BedrockProvider — constructor", () => {
  it("requires accessKeyId", () => {
    expect(
      () =>
        new BedrockProvider({
          accessKeyId: "",
          secretAccessKey: "x",
          fetch: buildFetch({}),
        }),
    ).toThrow(/accessKeyId/);
  });

  it("requires secretAccessKey", () => {
    expect(
      () =>
        new BedrockProvider({
          accessKeyId: "x",
          secretAccessKey: "",
          fetch: buildFetch({}),
        }),
    ).toThrow(/secretAccessKey/);
  });

  it("rejects unknown defaultModel", () => {
    expect(
      () =>
        new BedrockProvider({
          accessKeyId: "x",
          secretAccessKey: "y",
          defaultModel: "gpt-4o" as never,
          fetch: buildFetch({}),
        }),
    ).toThrow(/unsupported/);
  });

  it("exposes id, models, capabilities, pricing", () => {
    const provider = build({ fetch: buildFetch({}) });
    expect(provider.id).toBe("bedrock");
    expect(provider.models.length).toBe(8);
    expect(provider.capabilities.chat).toBe(true);
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.embedding).toBe(false);
    expect(provider.capabilities.maxContextTokens).toBe(200_000);
    expect(provider.pricing.inputPerMillionTokens).toBeGreaterThan(0);
    expect(provider.pricing.outputPerMillionTokens).toBeGreaterThan(0);
  });

  it("derives residency from region prefix", () => {
    const us = new BedrockProvider({
      accessKeyId: "x",
      secretAccessKey: "y",
      region: "us-west-2",
      fetch: buildFetch({}),
    });
    expect(us.residency).toEqual(["us"]);
    const eu = new BedrockProvider({
      accessKeyId: "x",
      secretAccessKey: "y",
      region: "eu-west-3",
      fetch: buildFetch({}),
    });
    expect(eu.residency).toEqual(["eu"]);
    const ap = new BedrockProvider({
      accessKeyId: "x",
      secretAccessKey: "y",
      region: "ap-south-1",
      fetch: buildFetch({}),
    });
    expect(ap.residency).toEqual(["ap"]);
  });
});

describe("BedrockProvider — embed", () => {
  it("rejects with BedrockError (Titan embeddings not implemented in M2.9)", async () => {
    const provider = build({ fetch: buildFetch({}) });
    await expect(
      provider.embed({
        tenantId: "t",
        sessionId: "s",
        texts: ["one"],
      }),
    ).rejects.toThrow(BedrockError);
  });
});

describe("BedrockProvider — request signing + headers", () => {
  async function consumeStream(provider: BedrockProvider, req: CompletionRequest): Promise<void> {
    for await (const _ of provider.complete(req)) {
      // drain
    }
  }

  it("POSTs to /model/{modelId}/converse-stream with sig v4 headers", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({
        capture,
        body: emptyStream(),
      }),
    });
    await consumeStream(provider, baseReq()).catch(() => undefined);
    expect(capture.url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse-stream",
    );
    expect(capture.init?.method).toBe("POST");
    const headers = capture.init!.headers;
    expect(headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    expect(headers["x-amz-date"]).toBe("20260518T120000Z");
    expect(headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["host"]).toBe("bedrock-runtime.us-east-1.amazonaws.com");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["accept"]).toBe("application/vnd.amazon.eventstream");
  });

  it("body is a JSON-encoded converse request", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, body: emptyStream() }),
    });
    await consumeStream(provider, baseReq({ maxTokens: 99 })).catch(() => undefined);
    const text = new TextDecoder().decode(capture.init!.body);
    const parsed = JSON.parse(text) as {
      messages: Array<{ role: string; content: Array<{ text?: string }> }>;
      inferenceConfig: { maxTokens: number };
    };
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.role).toBe("user");
    expect(parsed.messages[0]?.content[0]?.text).toBe("hello");
    expect(parsed.inferenceConfig.maxTokens).toBe(99);
  });

  it("includes x-amz-security-token header when sessionToken is configured", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = new BedrockProvider({
      accessKeyId: "x",
      secretAccessKey: "y",
      sessionToken: "session-abc",
      region: "us-east-1",
      fetch: buildFetch({ capture, body: emptyStream() }),
      clock: () => FIXED_DATE,
    });
    await consumeStream(provider, baseReq()).catch(() => undefined);
    expect(capture.init!.headers["x-amz-security-token"]).toBe("session-abc");
  });
});

describe("BedrockProvider — error handling", () => {
  async function consumeStream(provider: BedrockProvider, req: CompletionRequest): Promise<void> {
    for await (const _ of provider.complete(req)) {
      // drain
    }
  }

  it("wraps network failures as BedrockError(kind: network_error)", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(consumeStream(provider, baseReq())).rejects.toMatchObject({
      kind: "network_error",
    });
  });

  it("wraps AbortError as BedrockError(kind: timeout_error)", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const provider = build({ fetch: buildFetch({ throwError: abortErr }) });
    await expect(consumeStream(provider, baseReq())).rejects.toMatchObject({
      kind: "timeout_error",
    });
  });

  it("maps HTTP 429 + ThrottlingException → rate_limit_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 429,
        text: JSON.stringify({
          __type: "ThrottlingException",
          message: "throttled",
        }),
      }),
    });
    await expect(consumeStream(provider, baseReq())).rejects.toMatchObject({
      kind: "rate_limit_error",
      status: 429,
    });
  });

  it("maps HTTP 400 + ValidationException → invalid_request_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 400,
        text: JSON.stringify({
          __type: "ValidationException",
          message: "no messages",
        }),
      }),
    });
    await expect(consumeStream(provider, baseReq())).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
  });

  it("rejects unknown model names with invalid_request_error", async () => {
    const provider = build({ fetch: buildFetch({}) });
    await expect(
      consumeStream(provider, baseReq({ model: "gpt-4o" })),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
  });

  it("throws BedrockError when response body is null", async () => {
    const provider = build({ fetch: buildFetch({ body: null }) });
    await expect(consumeStream(provider, baseReq())).rejects.toMatchObject({
      kind: "api_error",
    });
  });
});

describe("BedrockProvider — completeNonStreaming", () => {
  it("POSTs to /model/{modelId}/converse with accept: application/json", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({
        capture,
        text: JSON.stringify({
          output: { message: { role: "assistant", content: [{ text: "hi" }] } },
          stopReason: "end_turn",
          usage: { inputTokens: 5, outputTokens: 2 },
        }),
      }),
    });
    const response = await provider.completeNonStreaming(baseReq());
    expect(capture.url).toContain("/converse");
    expect(capture.url).not.toContain("/converse-stream");
    expect(capture.init?.headers["accept"]).toBe("application/json");
    expect(response.output.message.content[0]).toEqual({ text: "hi" });
  });

  it("throws BedrockError on non-JSON body", async () => {
    const provider = build({ fetch: buildFetch({ text: "<html>oops</html>" }) });
    await expect(provider.completeNonStreaming(baseReq())).rejects.toMatchObject({
      kind: "api_error",
    });
  });
});

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}
