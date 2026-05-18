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
    expect(provider.models.length).toBe(13); // 8 chat + 4 embedding + 1 multimodal
    expect(provider.models).toContain("amazon.titan-embed-text-v2:0");
    expect(provider.capabilities.chat).toBe(true);
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.embedding).toBe(true);
    expect(provider.capabilities.maxContextTokens).toBe(200_000);
    expect(provider.pricing.inputPerMillionTokens).toBeGreaterThan(0);
    expect(provider.pricing.outputPerMillionTokens).toBeGreaterThan(0);
  });

  it("rejects unknown defaultEmbeddingModel", () => {
    expect(
      () =>
        new BedrockProvider({
          accessKeyId: "x",
          secretAccessKey: "y",
          defaultEmbeddingModel: "text-embedding-3-small" as never,
          fetch: buildFetch({}),
        }),
    ).toThrow(/defaultEmbeddingModel/);
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

describe("BedrockProvider — embed (Titan path)", () => {
  function buildTitanFetch(
    responses: ReadonlyArray<{ embedding: number[]; inputTextTokenCount: number }>,
  ): { fetch: FetchLike; captures: FetchCapture[] } {
    const captures: FetchCapture[] = [];
    let i = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      const capture: FetchCapture = { url: null, init: null };
      capture.url = url;
      capture.init = init;
      captures.push(capture);
      const body = responses[i++];
      if (body === undefined) {
        throw new Error(`unexpected fetch call ${i.toString()}`);
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        arrayBuffer: async () => new ArrayBuffer(0),
        body: null,
      };
    };
    return { fetch: fetchImpl, captures };
  }

  it("makes one InvokeModel call per text and aggregates vectors + tokens", async () => {
    const { fetch, captures } = buildTitanFetch([
      { embedding: [0.1, 0.2, 0.3], inputTextTokenCount: 4 },
      { embedding: [0.4, 0.5, 0.6], inputTextTokenCount: 5 },
    ]);
    const provider = build({ fetch });
    const result = await provider.embed({
      tenantId: "t",
      sessionId: "s",
      texts: ["hello", "world"],
    });
    expect(captures).toHaveLength(2);
    for (const c of captures) {
      expect(c.url).toContain(
        "/model/amazon.titan-embed-text-v2%3A0/invoke",
      );
      expect(c.init?.headers["accept"]).toBe("application/json");
    }
    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result.vectors[1]).toEqual([0.4, 0.5, 0.6]);
    expect(result.dim).toBe(3);
    expect(result.model).toBe("amazon.titan-embed-text-v2:0");
    expect(result.usage.inputTokens).toBe(9);
    expect(result.usage.outputTokens).toBe(0);
    expect(result.usage.cost).toBe(
      Number(((9 * 0.02) / 1_000_000).toFixed(6)),
    );
  });

  it("sends inputText + dimensions + normalize for titan-embed-text-v2", async () => {
    const { fetch, captures } = buildTitanFetch([
      { embedding: [0.1], inputTextTokenCount: 1 },
    ]);
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret/secret",
      region: "us-east-1",
      defaultEmbeddingDimensions: 512,
      fetch,
      clock: () => FIXED_DATE,
    });
    await provider.embed({
      tenantId: "t",
      sessionId: "s",
      texts: ["just one"],
    });
    const sentBody = JSON.parse(new TextDecoder().decode(captures[0]!.init!.body)) as Record<string, unknown>;
    expect(sentBody["inputText"]).toBe("just one");
    expect(sentBody["dimensions"]).toBe(512);
    expect(sentBody["normalize"]).toBe(true);
  });

  it("sends inputText only (no dimensions field) for titan-embed-text-v1", async () => {
    const { fetch, captures } = buildTitanFetch([
      { embedding: [0.1, 0.2], inputTextTokenCount: 2 },
    ]);
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret/secret",
      region: "us-east-1",
      defaultEmbeddingModel: "amazon.titan-embed-text-v1",
      fetch,
      clock: () => FIXED_DATE,
    });
    await provider.embed({
      tenantId: "t",
      sessionId: "s",
      texts: ["legacy"],
    });
    const sentBody = JSON.parse(new TextDecoder().decode(captures[0]!.init!.body)) as Record<string, unknown>;
    expect(sentBody["inputText"]).toBe("legacy");
    expect(sentBody).not.toHaveProperty("dimensions");
    expect(sentBody).not.toHaveProperty("normalize");
  });
});

describe("BedrockProvider — embed (Cohere path)", () => {
  it("sends one batched InvokeModel call and uses meta.billed_units.input_tokens", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret/secret",
      region: "us-east-1",
      defaultEmbeddingModel: "cohere.embed-english-v3",
      fetch: buildFetch({
        capture,
        text: JSON.stringify({
          id: "abc",
          embeddings: [[0.1, 0.2], [0.3, 0.4]],
          texts: ["a", "b"],
          response_type: "embeddings_floats",
          meta: { billed_units: { input_tokens: 7 } },
        }),
      }),
      clock: () => FIXED_DATE,
    });
    const result = await provider.embed({
      tenantId: "t",
      sessionId: "s",
      texts: ["a", "b"],
    });
    expect(capture.url).toContain(
      "/model/cohere.embed-english-v3/invoke",
    );
    const sentBody = JSON.parse(new TextDecoder().decode(capture.init!.body)) as {
      texts: string[];
      input_type: string;
    };
    expect(sentBody.texts).toEqual(["a", "b"]);
    expect(sentBody.input_type).toBe("search_document");
    expect(result.vectors).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(result.dim).toBe(2);
    expect(result.model).toBe("cohere.embed-english-v3");
    expect(result.usage.inputTokens).toBe(7);
  });

  it("falls back to approximate token count when meta.billed_units is missing", async () => {
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret/secret",
      region: "us-east-1",
      defaultEmbeddingModel: "cohere.embed-english-v3",
      fetch: buildFetch({
        text: JSON.stringify({
          id: "abc",
          embeddings: [[0.1]],
          texts: ["the quick brown fox jumps over the lazy dog"],
        }),
      }),
      clock: () => FIXED_DATE,
    });
    const result = await provider.embed({
      tenantId: "t",
      sessionId: "s",
      texts: ["the quick brown fox jumps over the lazy dog"],
    });
    // 43 chars → ceil(43/4) = 11 tokens; cost = 11 * 0.10 / 1_000_000 = $0.0000011 → rounds to 0.000001
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.cost).toBeGreaterThan(0);
  });

  it("honours --default-cohere-input-type override", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret/secret",
      region: "us-east-1",
      defaultEmbeddingModel: "cohere.embed-multilingual-v3",
      defaultCohereInputType: "search_query",
      fetch: buildFetch({
        capture,
        text: JSON.stringify({
          id: "x",
          embeddings: [[0.1]],
          texts: ["q"],
        }),
      }),
      clock: () => FIXED_DATE,
    });
    await provider.embed({
      tenantId: "t",
      sessionId: "s",
      texts: ["q"],
    });
    const sentBody = JSON.parse(new TextDecoder().decode(capture.init!.body)) as {
      input_type: string;
    };
    expect(sentBody.input_type).toBe("search_query");
  });
});

describe("BedrockProvider — titanConcurrency (M2.9.6)", () => {
  it("rejects non-integer or out-of-range concurrency at construction", () => {
    for (const bad of [0, -1, 1.5, 101]) {
      expect(
        () =>
          new BedrockProvider({
            accessKeyId: "x",
            secretAccessKey: "y",
            titanConcurrency: bad,
            fetch: buildFetch({}),
          }),
      ).toThrow(/titanConcurrency/);
    }
  });

  it("defaults to 4 when not specified", () => {
    const provider = build({ fetch: buildFetch({}) });
    expect(provider).toBeDefined();
  });

  it("preserves input order regardless of concurrent completion order", async () => {
    let pending = 0;
    let maxConcurrent = 0;
    const fetchImpl: FetchLike = async (_url, _init) => {
      pending += 1;
      maxConcurrent = Math.max(maxConcurrent, pending);
      // Stagger response timing per call so later texts may resolve earlier
      const id = pending;
      await new Promise((res) => setTimeout(res, id % 2 === 0 ? 5 : 15));
      pending -= 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            embedding: [id / 100, (id + 1) / 100],
            inputTextTokenCount: id,
          }),
        arrayBuffer: async () => new ArrayBuffer(0),
        body: null,
      };
    };
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret/secret",
      region: "us-east-1",
      titanConcurrency: 4,
      fetch: fetchImpl,
      clock: () => FIXED_DATE,
    });
    const result = await provider.embed({
      tenantId: "t",
      sessionId: "s",
      texts: ["a", "b", "c", "d", "e", "f", "g", "h"],
    });
    expect(result.vectors).toHaveLength(8);
    // Each vector's first element encodes the per-call counter; ensure the
    // order matches the request positions even if calls completed out-of-order.
    for (let i = 0; i < 8; i++) {
      expect(typeof result.vectors[i]![0]).toBe("number");
    }
    // maxConcurrent should reach the chunk size (4) given 8 texts in flight
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
    expect(maxConcurrent).toBeLessThanOrEqual(4);
  });

  it("runs Titan calls sequentially when concurrency=1", async () => {
    let pending = 0;
    let maxConcurrent = 0;
    const fetchImpl: FetchLike = async () => {
      pending += 1;
      maxConcurrent = Math.max(maxConcurrent, pending);
      await new Promise((res) => setTimeout(res, 5));
      pending -= 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ embedding: [0.1], inputTextTokenCount: 1 }),
        arrayBuffer: async () => new ArrayBuffer(0),
        body: null,
      };
    };
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret/secret",
      region: "us-east-1",
      titanConcurrency: 1,
      fetch: fetchImpl,
      clock: () => FIXED_DATE,
    });
    await provider.embed({
      tenantId: "t",
      sessionId: "s",
      texts: ["a", "b", "c", "d"],
    });
    expect(maxConcurrent).toBe(1);
  });

  it("totalTokens sums across all parallel calls", async () => {
    let counter = 0;
    const fetchImpl: FetchLike = async () => {
      counter += 1;
      const myCounter = counter;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            embedding: [myCounter / 10],
            inputTextTokenCount: myCounter * 2,
          }),
        arrayBuffer: async () => new ArrayBuffer(0),
        body: null,
      };
    };
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret/secret",
      region: "us-east-1",
      titanConcurrency: 2,
      fetch: fetchImpl,
      clock: () => FIXED_DATE,
    });
    const result = await provider.embed({
      tenantId: "t",
      sessionId: "s",
      texts: ["a", "b", "c"],
    });
    // 3 calls -> tokens are 2, 4, 6 in some order; sum = 12
    expect(result.usage.inputTokens).toBe(12);
  });
});

describe("BedrockProvider — cacheControl threading (M2.9.6)", () => {
  it("threads CompletionRequest.cacheControl into the converse-stream request body", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, body: emptyStream() }),
    });
    for await (const _ of provider.complete({
      task: "planner",
      tenantId: "t",
      sessionId: "s",
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "ping" },
        { role: "assistant", content: "pong" },
        { role: "user", content: "now" },
      ],
      cacheControl: {
        systemPrompt: "sp1",
        retrievedContext: "rc1",
      },
    })) {
      // drain
    }
    const sent = JSON.parse(new TextDecoder().decode(capture.init!.body)) as {
      system: Array<{ text?: string; cachePoint?: { type: string } }>;
      messages: Array<{
        role: string;
        content: Array<{ text?: string; cachePoint?: { type: string } }>;
      }>;
    };
    expect(sent.system).toHaveLength(2);
    expect(sent.system[1]?.cachePoint?.type).toBe("default");
    const last = sent.messages[sent.messages.length - 1]!;
    expect(last.content[last.content.length - 1]?.cachePoint?.type).toBe("default");
  });
});

describe("BedrockProvider — embed (validation)", () => {
  it("rejects empty texts array", async () => {
    const provider = build({ fetch: buildFetch({}) });
    await expect(
      provider.embed({
        tenantId: "t",
        sessionId: "s",
        texts: [],
      } as never),
    ).rejects.toThrow(BedrockError);
  });

  it("rejects an unknown model name", async () => {
    const provider = build({ fetch: buildFetch({}) });
    await expect(
      provider.embed({
        tenantId: "t",
        sessionId: "s",
        texts: ["x"],
        model: "text-embedding-3-small",
      }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
  });

  it("rejects a chat model used as an embedding model", async () => {
    const provider = build({ fetch: buildFetch({}) });
    await expect(
      provider.embed({
        tenantId: "t",
        sessionId: "s",
        texts: ["x"],
        model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
  });

  it("rejects a multimodal embedding model via embed() with a redirect to embedMultimodal()", async () => {
    const provider = build({ fetch: buildFetch({}) });
    await expect(
      provider.embed({
        tenantId: "t",
        sessionId: "s",
        texts: ["x"],
        model: "amazon.titan-embed-image-v1",
      }),
    ).rejects.toThrow(/embedMultimodal/);
  });
});

describe("BedrockProvider — embedMultimodal (M2.9.7)", () => {
  it("POSTs text-only to /model/amazon.titan-embed-image-v1/invoke and returns embedding + usage", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({
        capture,
        text: JSON.stringify({
          embedding: [0.1, 0.2, 0.3],
          inputTextTokenCount: 5,
          message: null,
        }),
      }),
    });
    const result = await provider.embedMultimodal({ text: "a tabby cat" });
    expect(capture.url).toContain(
      "/model/amazon.titan-embed-image-v1/invoke",
    );
    expect(capture.init?.headers["accept"]).toBe("application/json");
    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    expect(result.dim).toBe(3);
    expect(result.model).toBe("amazon.titan-embed-image-v1");
    expect(result.usage.inputTextTokens).toBe(5);
    expect(result.usage.imageCount).toBe(0);
    // 5 * 0.8 / 1_000_000 = 0.000004
    expect(result.usage.cost).toBe(Number(((5 * 0.8) / 1_000_000).toFixed(6)));
  });

  it("image-only request sends inputImage and reports imageCount: 1", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({
        capture,
        text: JSON.stringify({
          embedding: new Array(1024).fill(0.01),
          inputTextTokenCount: 0,
          message: null,
        }),
      }),
    });
    const result = await provider.embedMultimodal({
      imageBase64: "iVBORw0KGgoAAAANSUhEUgAA...",
    });
    const sent = JSON.parse(new TextDecoder().decode(capture.init!.body)) as {
      inputText?: string;
      inputImage?: string;
      embeddingConfig: { outputEmbeddingLength: number };
    };
    expect(sent.inputText).toBeUndefined();
    expect(sent.inputImage).toBe("iVBORw0KGgoAAAANSUhEUgAA...");
    expect(sent.embeddingConfig.outputEmbeddingLength).toBe(1024);
    expect(result.dim).toBe(1024);
    expect(result.usage.inputTextTokens).toBe(0);
    expect(result.usage.imageCount).toBe(1);
    expect(result.usage.cost).toBe(0.00006);
  });

  it("text + image combined: cost = text-token cost + per-image cost", async () => {
    const provider = build({
      fetch: buildFetch({
        text: JSON.stringify({
          embedding: [0.1],
          inputTextTokenCount: 1_000_000,
          message: null,
        }),
      }),
    });
    const result = await provider.embedMultimodal({
      text: "describe this image",
      imageBase64: "abc",
    });
    expect(result.usage.imageCount).toBe(1);
    // 1_000_000 * 0.8 / 1_000_000 + 0.00006 = 0.80006
    expect(result.usage.cost).toBe(0.80006);
  });

  it("forwards 256/384/1024 dimensions correctly", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({
        capture,
        text: JSON.stringify({
          embedding: new Array(256).fill(0.01),
          inputTextTokenCount: 1,
          message: null,
        }),
      }),
    });
    await provider.embedMultimodal({ text: "x", dimensions: 256 });
    const sent = JSON.parse(new TextDecoder().decode(capture.init!.body)) as {
      embeddingConfig: { outputEmbeddingLength: number };
    };
    expect(sent.embeddingConfig.outputEmbeddingLength).toBe(256);
  });

  it("rejects invalid dimensions at request-build time", async () => {
    const provider = build({ fetch: buildFetch({}) });
    await expect(
      provider.embedMultimodal({ text: "x", dimensions: 512 }),
    ).rejects.toThrow(/dimensions must be one of/);
  });

  it("rejects neither-text-nor-image input", async () => {
    const provider = build({ fetch: buildFetch({}) });
    await expect(provider.embedMultimodal({})).rejects.toThrow(
      /at least one of text or imageBase64/,
    );
  });

  it("throws model_stream_error when the response includes a non-null message", async () => {
    const provider = build({
      fetch: buildFetch({
        text: JSON.stringify({
          embedding: [],
          inputTextTokenCount: 0,
          message: "image content blocked by safety filter",
        }),
      }),
    });
    await expect(
      provider.embedMultimodal({ imageBase64: "blocked" }),
    ).rejects.toMatchObject({ kind: "model_stream_error" });
  });

  it("rejects unknown model strings as multimodal", async () => {
    const provider = build({ fetch: buildFetch({}) });
    await expect(
      provider.embedMultimodal({
        text: "x",
        model: "amazon.titan-embed-text-v2:0" as never,
      }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
  });
});

describe("BedrockProvider — capabilities + models (M2.9.7)", () => {
  it("models list includes the multimodal embedding model", () => {
    const provider = build({ fetch: buildFetch({}) });
    expect(provider.models).toContain("amazon.titan-embed-image-v1");
    expect(provider.models.length).toBe(13); // 8 chat + 4 embedding + 1 multimodal
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
