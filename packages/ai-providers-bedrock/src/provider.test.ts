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

  it("validates guardrailConfig at construction time (M2.9.8)", () => {
    expect(
      () =>
        new BedrockProvider({
          accessKeyId: "x",
          secretAccessKey: "y",
          guardrailConfig: {
            guardrailIdentifier: "BAD-ID",
            guardrailVersion: "DRAFT",
          },
          fetch: buildFetch({}),
        }),
    ).toThrow(/invalid guardrailIdentifier/);
  });

  it("accepts a valid guardrailConfig at construction time", () => {
    const p = new BedrockProvider({
      accessKeyId: "x",
      secretAccessKey: "y",
      guardrailConfig: {
        guardrailIdentifier: "gr12345",
        guardrailVersion: "1",
        trace: "enabled",
      },
      fetch: buildFetch({}),
    });
    expect(p.id).toBe("bedrock");
  });
});

describe("BedrockProvider — guardrailConfig threading (M2.9.8)", () => {
  it("non-streaming: passes guardrailConfig into the request body", async () => {
    const captures: FetchCapture[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      captures.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            output: { message: { role: "assistant", content: [{ text: "ok" }] } },
            stopReason: "end_turn",
            usage: { inputTokens: 5, outputTokens: 2 },
          }),
        arrayBuffer: async () => new ArrayBuffer(0),
        body: null,
      };
    };
    const provider = new BedrockProvider({
      accessKeyId: "x",
      secretAccessKey: "y",
      region: "us-east-1",
      guardrailConfig: {
        guardrailIdentifier: "gr12345",
        guardrailVersion: "DRAFT",
      },
      fetch: fetchImpl,
      clock: () => FIXED_DATE,
    });
    await provider.completeNonStreaming({
      task: "planner",
      messages: [{ role: "user", content: "hi" }],
      tenantId: "ten-1",
      sessionId: "ses-1",
    });
    const body = JSON.parse(
      new TextDecoder().decode(captures[0]!.init!.body),
    ) as { guardrailConfig?: { guardrailIdentifier: string } };
    expect(body.guardrailConfig).toEqual({
      guardrailIdentifier: "gr12345",
      guardrailVersion: "DRAFT",
    });
  });

  it("no guardrailConfig in constructor → request body has no guardrailConfig field", async () => {
    const captures: FetchCapture[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      captures.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            output: { message: { role: "assistant", content: [{ text: "ok" }] } },
            stopReason: "end_turn",
            usage: { inputTokens: 5, outputTokens: 2 },
          }),
        arrayBuffer: async () => new ArrayBuffer(0),
        body: null,
      };
    };
    const provider = build({ fetch: fetchImpl });
    await provider.completeNonStreaming({
      task: "planner",
      messages: [{ role: "user", content: "hi" }],
      tenantId: "ten-1",
      sessionId: "ses-1",
    });
    const body = JSON.parse(
      new TextDecoder().decode(captures[0]!.init!.body),
    ) as Record<string, unknown>;
    expect("guardrailConfig" in body).toBe(false);
  });
});

describe("BedrockProvider — completeNonStreamingWithGuardrail per-request override (M2.9.8.x)", () => {
  function plainOkFetch(): { fetch: FetchLike; captures: FetchCapture[] } {
    const captures: FetchCapture[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      captures.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            output: { message: { role: "assistant", content: [{ text: "ok" }] } },
            stopReason: "end_turn",
            usage: { inputTokens: 5, outputTokens: 2 },
          }),
        arrayBuffer: async () => new ArrayBuffer(0),
        body: null,
      };
    };
    return { fetch: fetchImpl, captures };
  }

  function baseReq() {
    return {
      task: "planner" as const,
      messages: [{ role: "user" as const, content: "hi" }],
      tenantId: "ten-1",
      sessionId: "ses-1",
    };
  }

  it("BedrockGuardrailConfig override takes precedence over provider default", async () => {
    const { fetch, captures } = plainOkFetch();
    const provider = new BedrockProvider({
      accessKeyId: "x",
      secretAccessKey: "y",
      guardrailConfig: {
        guardrailIdentifier: "default01",
        guardrailVersion: "DRAFT",
      },
      fetch,
      clock: () => FIXED_DATE,
    });
    await provider.completeNonStreamingWithGuardrail(baseReq(), {
      guardrailIdentifier: "override01",
      guardrailVersion: "2",
    });
    const body = JSON.parse(
      new TextDecoder().decode(captures[0]!.init!.body),
    ) as { guardrailConfig?: { guardrailIdentifier: string; guardrailVersion: string } };
    expect(body.guardrailConfig).toEqual({
      guardrailIdentifier: "override01",
      guardrailVersion: "2",
    });
  });

  it("null override disables the provider's default guardrail for this request", async () => {
    const { fetch, captures } = plainOkFetch();
    const provider = new BedrockProvider({
      accessKeyId: "x",
      secretAccessKey: "y",
      guardrailConfig: {
        guardrailIdentifier: "default01",
        guardrailVersion: "DRAFT",
      },
      fetch,
      clock: () => FIXED_DATE,
    });
    await provider.completeNonStreamingWithGuardrail(baseReq(), null);
    const body = JSON.parse(
      new TextDecoder().decode(captures[0]!.init!.body),
    ) as Record<string, unknown>;
    expect("guardrailConfig" in body).toBe(false);
  });

  it("undefined override falls back to provider default", async () => {
    const { fetch, captures } = plainOkFetch();
    const provider = new BedrockProvider({
      accessKeyId: "x",
      secretAccessKey: "y",
      guardrailConfig: {
        guardrailIdentifier: "default01",
        guardrailVersion: "DRAFT",
      },
      fetch,
      clock: () => FIXED_DATE,
    });
    await provider.completeNonStreamingWithGuardrail(baseReq(), undefined);
    const body = JSON.parse(
      new TextDecoder().decode(captures[0]!.init!.body),
    ) as { guardrailConfig?: { guardrailIdentifier: string } };
    expect(body.guardrailConfig?.guardrailIdentifier).toBe("default01");
  });

  it("no-arg override falls back to provider default (omitted arg = undefined)", async () => {
    const { fetch, captures } = plainOkFetch();
    const provider = new BedrockProvider({
      accessKeyId: "x",
      secretAccessKey: "y",
      guardrailConfig: {
        guardrailIdentifier: "default01",
        guardrailVersion: "DRAFT",
      },
      fetch,
      clock: () => FIXED_DATE,
    });
    await provider.completeNonStreamingWithGuardrail(baseReq());
    const body = JSON.parse(
      new TextDecoder().decode(captures[0]!.init!.body),
    ) as { guardrailConfig?: { guardrailIdentifier: string } };
    expect(body.guardrailConfig?.guardrailIdentifier).toBe("default01");
  });

  it("override validates at call time — bad identifier throws BEFORE the request", async () => {
    const { fetch, captures } = plainOkFetch();
    const provider = new BedrockProvider({
      accessKeyId: "x",
      secretAccessKey: "y",
      fetch,
      clock: () => FIXED_DATE,
    });
    await expect(
      provider.completeNonStreamingWithGuardrail(baseReq(), {
        guardrailIdentifier: "BAD-ID",
        guardrailVersion: "DRAFT",
      }),
    ).rejects.toThrow(/invalid guardrailIdentifier/);
    expect(captures).toHaveLength(0);
  });

  it("works when provider has NO default + override provides the config", async () => {
    const { fetch, captures } = plainOkFetch();
    const provider = new BedrockProvider({
      accessKeyId: "x",
      secretAccessKey: "y",
      fetch,
      clock: () => FIXED_DATE,
    });
    await provider.completeNonStreamingWithGuardrail(baseReq(), {
      guardrailIdentifier: "perreq01",
      guardrailVersion: "DRAFT",
    });
    const body = JSON.parse(
      new TextDecoder().decode(captures[0]!.init!.body),
    ) as { guardrailConfig?: { guardrailIdentifier: string } };
    expect(body.guardrailConfig?.guardrailIdentifier).toBe("perreq01");
  });

  it("complete() (kernel API) is unaffected — still uses provider default", async () => {
    const { fetch, captures } = plainOkFetch();
    const provider = new BedrockProvider({
      accessKeyId: "x",
      secretAccessKey: "y",
      guardrailConfig: {
        guardrailIdentifier: "default01",
        guardrailVersion: "DRAFT",
      },
      fetch,
      clock: () => FIXED_DATE,
    });
    await provider.completeNonStreaming(baseReq());
    const body = JSON.parse(
      new TextDecoder().decode(captures[0]!.init!.body),
    ) as { guardrailConfig?: { guardrailIdentifier: string } };
    expect(body.guardrailConfig?.guardrailIdentifier).toBe("default01");
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

describe("BedrockProvider — listBatches (M2.X.5.aa.z.3)", () => {
  function buildListBody(opts: {
    summaries?: ReadonlyArray<Record<string, unknown>>;
    nextToken?: string;
  }): string {
    const body: Record<string, unknown> = {
      invocationJobSummaries: opts.summaries ?? [],
    };
    if (opts.nextToken !== undefined) body["nextToken"] = opts.nextToken;
    return JSON.stringify(body);
  }

  function sampleJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      jobArn:
        "arn:aws:bedrock:us-east-1:123456789012:model-invocation-job/abcd1234",
      jobName: "tenant-x-batch",
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      roleArn: "arn:aws:iam::123456789012:role/BatchRole",
      status: "Completed",
      submitTime: "2026-05-19T00:00:00Z",
      inputDataConfig: { s3InputDataConfig: { s3Uri: "s3://b/in/" } },
      outputDataConfig: { s3OutputDataConfig: { s3Uri: "s3://b/out/" } },
      ...overrides,
    };
  }

  it("GETs the control-plane host with sig v4 auth headers", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: buildListBody({ summaries: [] }) }),
    });
    await provider.listBatches();
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).not.toContain("bedrock-runtime.");
    expect(capture.url).toContain("/model-invocation-jobs/");
    expect(capture.init?.method).toBe("GET");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(capture.init?.headers["x-amz-date"]).toBeTruthy();
  });

  it("zero-arg call emits no query string", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: buildListBody({ summaries: [] }) }),
    });
    await provider.listBatches();
    expect(capture.url).not.toContain("?");
  });

  it("threads query parameters into the URL", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: buildListBody({ summaries: [] }) }),
    });
    await provider.listBatches({
      statusEquals: "InProgress",
      maxResults: 50,
      nameContains: "tenant-x",
      sortBy: "CreationTime",
      sortOrder: "Descending",
    });
    expect(capture.url).toContain("statusEquals=InProgress");
    expect(capture.url).toContain("maxResults=50");
    expect(capture.url).toContain("nameContains=tenant-x");
    expect(capture.url).toContain("sortBy=CreationTime");
    expect(capture.url).toContain("sortOrder=Descending");
  });

  it("parses a response with one job + nextToken", async () => {
    const provider = build({
      fetch: buildFetch({
        text: buildListBody({
          summaries: [sampleJob()],
          nextToken: "page-2",
        }),
      }),
    });
    const out = await provider.listBatches();
    expect(out.invocationJobSummaries.length).toBe(1);
    expect(out.invocationJobSummaries[0]!.jobName).toBe("tenant-x-batch");
    expect(out.nextToken).toBe("page-2");
  });

  it("validates options BEFORE fetch — never burns a request on bad limit", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.listBatches({ maxResults: 9999 }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("propagates http errors via fromHttpResponse classification", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(provider.listBatches()).rejects.toMatchObject({
      kind: "permission_error",
      status: 403,
    });
  });

  it("throws api_error on non-JSON body", async () => {
    const provider = build({
      fetch: buildFetch({ text: "<html>500</html>" }),
    });
    await expect(provider.listBatches()).rejects.toMatchObject({
      kind: "api_error",
    });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(provider.listBatches()).rejects.toMatchObject({
      kind: "network_error",
    });
  });

  it("supports a custom controlPlaneBaseUrl override", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = new BedrockProvider({
      accessKeyId: "x",
      secretAccessKey: "y",
      region: "us-east-1",
      controlPlaneBaseUrl: "https://test.example.com",
      fetch: buildFetch({ capture, text: buildListBody({ summaries: [] }) }),
      clock: () => FIXED_DATE,
    });
    await provider.listBatches();
    expect(capture.url).toMatch(/^https:\/\/test\.example\.com\//);
  });
});

describe("BedrockProvider — getBatch (M2.X.5.aa.z.4)", () => {
  function buildDetailBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      jobArn:
        "arn:aws:bedrock:us-east-1:123456789012:model-invocation-job/abcd1234efgh",
      jobName: "tenant-x-detail",
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      roleArn: "arn:aws:iam::123456789012:role/Batch",
      status: "InProgress",
      submitTime: "2026-05-19T00:00:00Z",
      inputDataConfig: { s3InputDataConfig: { s3Uri: "s3://b/in/" } },
      outputDataConfig: { s3OutputDataConfig: { s3Uri: "s3://b/out/" } },
      ...overrides,
    });
  }

  it("GETs control-plane /model-invocation-jobs/{id} with the encoded identifier", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: buildDetailBody() }),
    });
    await provider.getBatch("abcd1234efgh");
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).toContain("/model-invocation-jobs/abcd1234efgh");
    expect(capture.init?.method).toBe("GET");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("URI-encodes ARN colons in the path", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: buildDetailBody() }),
    });
    const arn =
      "arn:aws:bedrock:us-east-1:123456789012:model-invocation-job/abcd1234efgh";
    await provider.getBatch(arn);
    expect(capture.url).toContain("/model-invocation-jobs/");
    expect(capture.url).toContain("%3A");
    expect(capture.url).not.toContain(`/model-invocation-jobs/${arn}`);
  });

  it("validates identifier BEFORE fetch — invalid identifier never burns a request", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(provider.getBatch("not-a-job")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    await expect(provider.getBatch("")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    expect(called).toBe(0);
  });

  it("parses the response and returns a typed detail", async () => {
    const provider = build({
      fetch: buildFetch({
        text: buildDetailBody({
          status: "Completed",
          endTime: "2026-05-19T02:00:00Z",
          message: "Done",
        }),
      }),
    });
    const detail = await provider.getBatch("abcd1234efgh");
    expect(detail.status).toBe("Completed");
    expect(detail.endTime).toBe("2026-05-19T02:00:00Z");
    expect(detail.message).toBe("Done");
  });

  it("propagates 404 as not_found_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "job does not exist",
        }),
      }),
    });
    await expect(provider.getBatch("abcd1234efgh")).rejects.toMatchObject({
      kind: "not_found_error",
      status: 404,
    });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(provider.getBatch("abcd1234efgh")).rejects.toMatchObject({
      kind: "permission_error",
      status: 403,
    });
  });

  it("throws api_error on non-JSON body", async () => {
    const provider = build({
      fetch: buildFetch({ text: "<html>500</html>" }),
    });
    await expect(provider.getBatch("abcd1234efgh")).rejects.toMatchObject({
      kind: "api_error",
    });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(provider.getBatch("abcd1234efgh")).rejects.toMatchObject({
      kind: "network_error",
    });
  });
});

describe("BedrockProvider — createModelCustomizationJob (M2.X.5.aa.z.20)", () => {
  function minimalCreate() {
    return {
      jobName: "tenant-x-haiku-finetune-001",
      customModelName: "tenant-x-haiku-v1",
      roleArn: "arn:aws:iam::123456789012:role/BedrockFineTuneRole",
      baseModelIdentifier:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0:200k",
      trainingDataConfig: { s3Uri: "s3://tenant-x-data/train/" },
      outputDataConfig: { s3Uri: "s3://tenant-x-data/output/" },
      hyperParameters: { epochCount: "10", learningRate: "0.0001" },
    };
  }

  it("POSTs to control-plane /model-customization-jobs with JSON body", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({
        capture,
        text: JSON.stringify({
          jobArn:
            "arn:aws:bedrock:us-east-1:123:model-customization-job/abc",
        }),
      }),
    });
    const out = await provider.createModelCustomizationJob(minimalCreate());
    expect(capture.url).toBe(
      "https://bedrock.us-east-1.amazonaws.com/model-customization-jobs",
    );
    expect(capture.init?.method).toBe("POST");
    expect(capture.init?.headers["content-type"]).toBe("application/json");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
    const sentBody = JSON.parse(
      new TextDecoder().decode(capture.init?.body),
    ) as Record<string, unknown>;
    expect(sentBody["jobName"]).toBe("tenant-x-haiku-finetune-001");
    expect(sentBody["customModelName"]).toBe("tenant-x-haiku-v1");
    expect(sentBody["baseModelIdentifier"]).toMatch(/claude-3-haiku/);
    expect(sentBody["hyperParameters"]).toEqual({
      epochCount: "10",
      learningRate: "0.0001",
    });
    expect(out.jobArn).toMatch(/abc$/);
  });

  it("validates input BEFORE fetch — bad jobName never burns a request", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.createModelCustomizationJob({
        ...minimalCreate(),
        jobName: "bad name",
      }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("validates input BEFORE fetch — bad hyperParameter type", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.createModelCustomizationJob({
        ...minimalCreate(),
        hyperParameters: { learningRate: 0.0001 } as never,
      }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("threads optional fields into the body (clientRequestToken + tags + KMS + VPC)", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({
        capture,
        text: JSON.stringify({
          jobArn:
            "arn:aws:bedrock:us-east-1:123:model-customization-job/abc",
        }),
      }),
    });
    await provider.createModelCustomizationJob({
      ...minimalCreate(),
      clientRequestToken: "req-uuid-abc",
      customizationType: "FINE_TUNING",
      customModelKmsKeyId: "arn:aws:kms:us-east-1:123:key/k1",
      jobTags: [{ key: "purpose", value: "claims" }],
      vpcConfig: { subnetIds: ["s-1"], securityGroupIds: ["sg-1"] },
    });
    const sent = JSON.parse(
      new TextDecoder().decode(capture.init?.body),
    ) as Record<string, unknown>;
    expect(sent["clientRequestToken"]).toBe("req-uuid-abc");
    expect(sent["customizationType"]).toBe("FINE_TUNING");
    expect(sent["customModelKmsKeyId"]).toMatch(/^arn:aws:kms:/);
    expect(sent["jobTags"]).toEqual([{ key: "purpose", value: "claims" }]);
  });

  it("threads distillationConfig.teacherModelConfig in the body", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({
        capture,
        text: JSON.stringify({
          jobArn:
            "arn:aws:bedrock:us-east-1:123:model-customization-job/dst",
        }),
      }),
    });
    await provider.createModelCustomizationJob({
      ...minimalCreate(),
      customizationType: "DISTILLATION",
      customizationConfig: {
        distillationConfig: {
          teacherModelConfig: {
            teacherModelIdentifier:
              "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
            maxResponseLengthForInference: 4096,
          },
        },
      },
    });
    const sent = JSON.parse(
      new TextDecoder().decode(capture.init?.body),
    ) as { customizationConfig: { distillationConfig: { teacherModelConfig: { teacherModelIdentifier: string; maxResponseLengthForInference: number } } } };
    expect(
      sent.customizationConfig.distillationConfig.teacherModelConfig
        .maxResponseLengthForInference,
    ).toBe(4096);
  });

  it("propagates 409 ConflictException as conflict_error (idempotency reuse with different body)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 409,
        text: JSON.stringify({
          __type: "ConflictException",
          message: "jobName already exists",
        }),
      }),
    });
    await expect(
      provider.createModelCustomizationJob(minimalCreate()),
    ).rejects.toMatchObject({
      kind: "conflict_error",
      status: 409,
    });
  });

  it("propagates 400 ValidationException as invalid_request_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 400,
        text: JSON.stringify({
          __type: "ValidationException",
          message: "role missing s3:GetObject",
        }),
      }),
    });
    await expect(
      provider.createModelCustomizationJob(minimalCreate()),
    ).rejects.toMatchObject({ kind: "invalid_request_error", status: 400 });
  });

  it("throws api_error when response has no jobArn", async () => {
    const provider = build({
      fetch: buildFetch({ text: JSON.stringify({ ok: true }) }),
    });
    await expect(
      provider.createModelCustomizationJob(minimalCreate()),
    ).rejects.toMatchObject({ kind: "api_error" });
  });

  it("throws api_error on non-JSON body", async () => {
    const provider = build({
      fetch: buildFetch({ text: "<html>oops</html>" }),
    });
    await expect(
      provider.createModelCustomizationJob(minimalCreate()),
    ).rejects.toMatchObject({ kind: "api_error" });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(
      provider.createModelCustomizationJob(minimalCreate()),
    ).rejects.toMatchObject({ kind: "network_error" });
  });
});

describe("BedrockProvider — stopModelCustomizationJob (M2.X.5.aa.z.19)", () => {
  it("POSTs control-plane /model-customization-jobs/{id}/stop with empty body", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "" }) });
    await provider.stopModelCustomizationJob("abc123");
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).toContain("/model-customization-jobs/abc123/stop");
    expect(capture.init?.method).toBe("POST");
    expect(capture.init?.body.byteLength).toBe(0);
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(capture.init?.headers["content-type"]).toBe("application/json");
  });

  it("URI-encodes ARN colons in the path", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "" }) });
    const arn =
      "arn:aws:bedrock:us-east-1:123:model-customization-job/abc";
    await provider.stopModelCustomizationJob(arn);
    expect(capture.url).toContain("%3A");
    expect(capture.url).toContain("/stop");
  });

  it("does not run against the runtime host", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "" }) });
    await provider.stopModelCustomizationJob("abc123");
    expect(capture.url).not.toContain("bedrock-runtime.");
  });

  it("validates identifier BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(provider.stopModelCustomizationJob("")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    expect(called).toBe(0);
  });

  it("resolves void on success", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 200, text: "" }),
    });
    const result = await provider.stopModelCustomizationJob("abc123");
    expect(result).toBeUndefined();
  });

  it("tolerates an empty JSON object body", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 200, text: "{}" }),
    });
    await expect(
      provider.stopModelCustomizationJob("abc123"),
    ).resolves.toBeUndefined();
  });

  it("propagates 404 as not_found_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no such job",
        }),
      }),
    });
    await expect(
      provider.stopModelCustomizationJob("abc123"),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
  });

  it("classifies 409 ConflictException as conflict_error (terminal-state job)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 409,
        text: JSON.stringify({
          __type: "ConflictException",
          message: "job is already in terminal state",
        }),
      }),
    });
    await expect(
      provider.stopModelCustomizationJob("abc123"),
    ).rejects.toMatchObject({
      kind: "conflict_error",
      status: 409,
      code: "ConflictException",
    });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(
      provider.stopModelCustomizationJob("abc123"),
    ).rejects.toMatchObject({ kind: "permission_error", status: 403 });
  });

  it("propagates 429 as rate_limit_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 429,
        text: JSON.stringify({
          __type: "ThrottlingException",
          message: "slow down",
        }),
      }),
    });
    await expect(
      provider.stopModelCustomizationJob("abc123"),
    ).rejects.toMatchObject({ kind: "rate_limit_error", status: 429 });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(
      provider.stopModelCustomizationJob("abc123"),
    ).rejects.toMatchObject({ kind: "network_error" });
  });
});

describe("BedrockProvider — getModelCustomizationJob (M2.X.5.aa.z.18)", () => {
  function detailBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      jobArn:
        "arn:aws:bedrock:us-east-1:123456789012:model-customization-job/abc",
      jobName: "tenant-x-haiku-finetune",
      outputModelName: "tenant-x-haiku-v1",
      roleArn: "arn:aws:iam::123456789012:role/BedrockFineTuneRole",
      status: "Completed",
      creationTime: "2026-04-15T12:00:00Z",
      baseModelArn:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0:200k",
      trainingDataConfig: { s3Uri: "s3://tenant-x-data/train/" },
      outputDataConfig: { s3Uri: "s3://tenant-x-data/output/" },
      ...overrides,
    });
  }

  it("GETs control-plane /model-customization-jobs/{id} endpoint", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: detailBody() }),
    });
    await provider.getModelCustomizationJob("abc");
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).toContain("/model-customization-jobs/abc");
    expect(capture.url).not.toContain("?");
    expect(capture.init?.method).toBe("GET");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("URI-encodes ARN colons in the path", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: detailBody() }),
    });
    const arn =
      "arn:aws:bedrock:us-east-1:123:model-customization-job/abc";
    await provider.getModelCustomizationJob(arn);
    expect(capture.url).toContain("%3A");
  });

  it("validates identifier BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(provider.getModelCustomizationJob("")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    expect(called).toBe(0);
  });

  it("parses a completed fine-tune with hyperParameters + metrics + KMS", async () => {
    const provider = build({
      fetch: buildFetch({
        text: detailBody({
          outputModelArn:
            "arn:aws:bedrock:us-east-1:123:custom-model/anthropic.claude-3-haiku-20240307-v1:0:200k/xyz",
          customizationType: "FINE_TUNING",
          outputModelKmsKeyArn: "arn:aws:kms:us-east-1:123:key/k1",
          hyperParameters: { epochCount: "10", learningRate: "0.0001" },
          validationDataConfig: {
            validators: [{ s3Uri: "s3://tenant-x-data/val/" }],
          },
          trainingMetrics: { trainingLoss: 0.42 },
          validationMetrics: [{ validationLoss: 0.51 }],
        }),
      }),
    });
    const detail = await provider.getModelCustomizationJob("abc");
    expect(detail.status).toBe("Completed");
    expect(detail.outputModelArn).toMatch(/custom-model/);
    expect(detail.customizationType).toBe("FINE_TUNING");
    expect(detail.outputModelKmsKeyArn).toMatch(/^arn:aws:kms:/);
    expect(detail.hyperParameters?.["epochCount"]).toBe("10");
    expect(detail.trainingMetrics?.trainingLoss).toBe(0.42);
    expect(detail.validationMetrics?.[0]!.validationLoss).toBe(0.51);
  });

  it("parses a distillation job with teacherModelConfig", async () => {
    const provider = build({
      fetch: buildFetch({
        text: detailBody({
          customizationType: "DISTILLATION",
          customizationConfig: {
            distillationConfig: {
              teacherModelConfig: {
                teacherModelIdentifier:
                  "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
                maxResponseLengthForInference: 4096,
              },
            },
          },
        }),
      }),
    });
    const detail = await provider.getModelCustomizationJob("abc");
    expect(detail.customizationType).toBe("DISTILLATION");
    expect(
      detail.customizationConfig?.distillationConfig?.teacherModelConfig
        .maxResponseLengthForInference,
    ).toBe(4096);
  });

  it("parses a Failed job with failureMessage", async () => {
    const provider = build({
      fetch: buildFetch({
        text: detailBody({
          status: "Failed",
          failureMessage: "training data validation failed",
        }),
      }),
    });
    const detail = await provider.getModelCustomizationJob("abc");
    expect(detail.status).toBe("Failed");
    expect(detail.failureMessage).toMatch(/training data/);
  });

  it("propagates 404 as not_found_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no such job",
        }),
      }),
    });
    await expect(
      provider.getModelCustomizationJob("abc"),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(
      provider.getModelCustomizationJob("abc"),
    ).rejects.toMatchObject({ kind: "permission_error", status: 403 });
  });

  it("throws api_error on non-JSON body", async () => {
    const provider = build({ fetch: buildFetch({ text: "<html>oops</html>" }) });
    await expect(
      provider.getModelCustomizationJob("abc"),
    ).rejects.toMatchObject({ kind: "api_error" });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(
      provider.getModelCustomizationJob("abc"),
    ).rejects.toMatchObject({ kind: "network_error" });
  });
});

describe("BedrockProvider — listModelCustomizationJobs (M2.X.5.aa.z.17)", () => {
  function listBody(opts: {
    items?: ReadonlyArray<Record<string, unknown>>;
    nextToken?: string;
  }): string {
    const body: Record<string, unknown> = {
      modelCustomizationJobSummaries: opts.items ?? [],
    };
    if (opts.nextToken !== undefined) body["nextToken"] = opts.nextToken;
    return JSON.stringify(body);
  }

  function sampleJob(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      jobArn:
        "arn:aws:bedrock:us-east-1:123456789012:model-customization-job/abc",
      jobName: "tenant-x-haiku-finetune",
      baseModelArn:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0:200k",
      status: "Completed",
      creationTime: "2026-04-15T12:00:00Z",
      lastModifiedTime: "2026-04-15T13:00:00Z",
      endTime: "2026-04-15T13:00:00Z",
      customModelArn:
        "arn:aws:bedrock:us-east-1:123:custom-model/anthropic.claude-3-haiku-20240307-v1:0:200k/xyz",
      customModelName: "tenant-x-haiku-finetune",
      customizationType: "FINE_TUNING",
      ...overrides,
    };
  }

  it("GETs the control-plane /model-customization-jobs endpoint with sig v4 headers", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listModelCustomizationJobs();
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).not.toContain("bedrock-runtime.");
    expect(capture.url).toContain("/model-customization-jobs");
    expect(capture.init?.method).toBe("GET");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("zero-arg call emits no query string", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listModelCustomizationJobs();
    expect(capture.url).not.toContain("?");
  });

  it("threads query parameters into the URL", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listModelCustomizationJobs({
      nameContains: "tenant-x",
      statusEquals: "Stopped",
      maxResults: 50,
      sortBy: "CreationTime",
      sortOrder: "Descending",
    });
    expect(capture.url).toContain("nameContains=tenant-x");
    expect(capture.url).toContain("statusEquals=Stopped");
    expect(capture.url).toContain("maxResults=50");
    expect(capture.url).toContain("sortBy=CreationTime");
    expect(capture.url).toContain("sortOrder=Descending");
  });

  it("parses a response with one completed job + nextToken", async () => {
    const provider = build({
      fetch: buildFetch({
        text: listBody({ items: [sampleJob()], nextToken: "page-2" }),
      }),
    });
    const out = await provider.listModelCustomizationJobs();
    expect(out.modelCustomizationJobSummaries.length).toBe(1);
    expect(out.modelCustomizationJobSummaries[0]!.status).toBe("Completed");
    expect(out.modelCustomizationJobSummaries[0]!.customModelName).toBe(
      "tenant-x-haiku-finetune",
    );
    expect(out.modelCustomizationJobSummaries[0]!.customizationType).toBe(
      "FINE_TUNING",
    );
    expect(out.nextToken).toBe("page-2");
  });

  it("validates options BEFORE fetch — bad statusEquals never burns a request", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.listModelCustomizationJobs({
        statusEquals: "RUNNING" as never,
      }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(
      provider.listModelCustomizationJobs(),
    ).rejects.toMatchObject({ kind: "permission_error", status: 403 });
  });

  it("throws api_error on non-JSON body", async () => {
    const provider = build({ fetch: buildFetch({ text: "<html>oops</html>" }) });
    await expect(
      provider.listModelCustomizationJobs(),
    ).rejects.toMatchObject({ kind: "api_error" });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(
      provider.listModelCustomizationJobs(),
    ).rejects.toMatchObject({ kind: "network_error" });
  });
});

describe("BedrockProvider — getModelImportJob (M2.X.5.aa.z.16)", () => {
  function detailBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      jobArn:
        "arn:aws:bedrock:us-east-1:123456789012:model-import-job/abc123def456",
      jobName: "import-tenant-x-2026-04-15",
      roleArn: "arn:aws:iam::123456789012:role/BedrockImportRole",
      status: "Completed",
      creationTime: "2026-04-15T12:00:00Z",
      modelDataSource: {
        s3DataSource: { s3Uri: "s3://tenant-x-artifacts/llama3/" },
      },
      importedModelName: "tenant-x-llama3-finetune",
      importedModelArn:
        "arn:aws:bedrock:us-east-1:123:imported-model/xyz789",
      endTime: "2026-04-15T13:00:00Z",
      ...overrides,
    });
  }

  it("GETs the control-plane /model-import-jobs/{id} endpoint", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: detailBody() }),
    });
    await provider.getModelImportJob("abc123def456");
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).toContain("/model-import-jobs/abc123def456");
    expect(capture.url).not.toContain("?");
    expect(capture.init?.method).toBe("GET");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("URI-encodes ARN colons in the path", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: detailBody() }),
    });
    const arn =
      "arn:aws:bedrock:us-east-1:123:model-import-job/abc123def456";
    await provider.getModelImportJob(arn);
    expect(capture.url).toContain("%3A");
  });

  it("validates identifier BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(provider.getModelImportJob("")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    expect(called).toBe(0);
  });

  it("parses a completed-job detail with imported-model fields + KMS + VPC", async () => {
    const provider = build({
      fetch: buildFetch({
        text: detailBody({
          importedModelKmsKeyArn: "arn:aws:kms:us-east-1:123:key/k1",
          vpcConfig: {
            subnetIds: ["subnet-aaa"],
            securityGroupIds: ["sg-111", "sg-222"],
          },
        }),
      }),
    });
    const detail = await provider.getModelImportJob("abc123def456");
    expect(detail.status).toBe("Completed");
    expect(detail.importedModelArn).toMatch(/imported-model/);
    expect(detail.modelDataSource.s3DataSource.s3Uri).toBe(
      "s3://tenant-x-artifacts/llama3/",
    );
    expect(detail.importedModelKmsKeyArn).toMatch(/^arn:aws:kms:/);
    expect(detail.vpcConfig?.subnetIds).toEqual(["subnet-aaa"]);
    expect(detail.vpcConfig?.securityGroupIds.length).toBe(2);
  });

  it("parses a Failed-job detail with failureMessage", async () => {
    const provider = build({
      fetch: buildFetch({
        text: detailBody({
          status: "Failed",
          failureMessage: "role missing s3:GetObject permission",
        }),
      }),
    });
    const detail = await provider.getModelImportJob("abc123def456");
    expect(detail.status).toBe("Failed");
    expect(detail.failureMessage).toMatch(/s3:GetObject/);
  });

  it("propagates 404 as not_found_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no such job",
        }),
      }),
    });
    await expect(
      provider.getModelImportJob("abc123def456"),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(
      provider.getModelImportJob("abc123def456"),
    ).rejects.toMatchObject({ kind: "permission_error", status: 403 });
  });

  it("throws api_error on non-JSON body", async () => {
    const provider = build({ fetch: buildFetch({ text: "<html>oops</html>" }) });
    await expect(
      provider.getModelImportJob("abc123def456"),
    ).rejects.toMatchObject({ kind: "api_error" });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(
      provider.getModelImportJob("abc123def456"),
    ).rejects.toMatchObject({ kind: "network_error" });
  });
});

describe("BedrockProvider — listModelImportJobs (M2.X.5.aa.z.15)", () => {
  function listBody(opts: {
    items?: ReadonlyArray<Record<string, unknown>>;
    nextToken?: string;
  }): string {
    const body: Record<string, unknown> = {
      modelImportJobSummaries: opts.items ?? [],
    };
    if (opts.nextToken !== undefined) body["nextToken"] = opts.nextToken;
    return JSON.stringify(body);
  }

  function sampleJob(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      jobArn:
        "arn:aws:bedrock:us-east-1:123456789012:model-import-job/abc123def456",
      jobName: "import-tenant-x-2026-04-15",
      status: "Completed",
      creationTime: "2026-04-15T12:00:00Z",
      lastModifiedTime: "2026-04-15T13:00:00Z",
      endTime: "2026-04-15T13:00:00Z",
      importedModelArn:
        "arn:aws:bedrock:us-east-1:123456789012:imported-model/abc",
      importedModelName: "tenant-x-llama3-finetune",
      ...overrides,
    };
  }

  it("GETs the control-plane /model-import-jobs endpoint with sig v4 headers", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listModelImportJobs();
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).not.toContain("bedrock-runtime.");
    expect(capture.url).toContain("/model-import-jobs");
    expect(capture.init?.method).toBe("GET");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("zero-arg call emits no query string", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listModelImportJobs();
    expect(capture.url).not.toContain("?");
  });

  it("threads query parameters into the URL", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listModelImportJobs({
      nameContains: "tenant-x",
      statusEquals: "Failed",
      maxResults: 50,
      sortBy: "CreationTime",
      sortOrder: "Descending",
    });
    expect(capture.url).toContain("nameContains=tenant-x");
    expect(capture.url).toContain("statusEquals=Failed");
    expect(capture.url).toContain("maxResults=50");
    expect(capture.url).toContain("sortBy=CreationTime");
    expect(capture.url).toContain("sortOrder=Descending");
  });

  it("parses a response with one completed job + nextToken", async () => {
    const provider = build({
      fetch: buildFetch({
        text: listBody({ items: [sampleJob()], nextToken: "page-2" }),
      }),
    });
    const out = await provider.listModelImportJobs();
    expect(out.modelImportJobSummaries.length).toBe(1);
    expect(out.modelImportJobSummaries[0]!.status).toBe("Completed");
    expect(out.modelImportJobSummaries[0]!.importedModelName).toBe(
      "tenant-x-llama3-finetune",
    );
    expect(out.nextToken).toBe("page-2");
  });

  it("validates options BEFORE fetch — bad statusEquals never burns a request", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.listModelImportJobs({ statusEquals: "RUNNING" as never }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(provider.listModelImportJobs()).rejects.toMatchObject({
      kind: "permission_error",
      status: 403,
    });
  });

  it("throws api_error on non-JSON body", async () => {
    const provider = build({ fetch: buildFetch({ text: "<html>oops</html>" }) });
    await expect(provider.listModelImportJobs()).rejects.toMatchObject({
      kind: "api_error",
    });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(provider.listModelImportJobs()).rejects.toMatchObject({
      kind: "network_error",
    });
  });
});

describe("BedrockProvider — getCustomModel (M2.X.5.aa.z.14)", () => {
  function detailBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      modelArn:
        "arn:aws:bedrock:us-east-1:123456789012:custom-model/anthropic.claude-3-haiku-20240307-v1:0:200k/abc",
      modelName: "tenant-x-claude-finetune",
      jobArn:
        "arn:aws:bedrock:us-east-1:123456789012:model-customization-job/xyz",
      baseModelArn:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0:200k",
      creationTime: "2026-04-15T12:00:00Z",
      trainingDataConfig: { s3Uri: "s3://tenant-x-data/train/" },
      outputDataConfig: { s3Uri: "s3://tenant-x-data/output/" },
      ...overrides,
    });
  }

  it("GETs the control-plane /custom-models/{id} endpoint", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: detailBody() }),
    });
    await provider.getCustomModel("abc");
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).toContain("/custom-models/abc");
    expect(capture.url).not.toContain("?");
    expect(capture.init?.method).toBe("GET");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("URI-encodes ARN colons in the path", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: detailBody() }),
    });
    const arn =
      "arn:aws:bedrock:us-east-1:123:custom-model/anthropic.claude-3-haiku-20240307-v1:0:200k/abc";
    await provider.getCustomModel(arn);
    expect(capture.url).toContain("%3A");
  });

  it("validates identifier BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(provider.getCustomModel("")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    expect(called).toBe(0);
  });

  it("parses a fine-tune detail with hyperParameters + metrics", async () => {
    const provider = build({
      fetch: buildFetch({
        text: detailBody({
          jobName: "ft-001",
          customizationType: "FINE_TUNING",
          hyperParameters: { epochCount: "10", learningRate: "0.0001" },
          validationDataConfig: {
            validators: [{ s3Uri: "s3://tenant-x-data/val/" }],
          },
          trainingMetrics: { trainingLoss: 0.42 },
          validationMetrics: [{ validationLoss: 0.51 }],
        }),
      }),
    });
    const detail = await provider.getCustomModel("abc");
    expect(detail.jobName).toBe("ft-001");
    expect(detail.customizationType).toBe("FINE_TUNING");
    expect(detail.hyperParameters?.["epochCount"]).toBe("10");
    expect(detail.validationDataConfig?.validators[0]!.s3Uri).toBe(
      "s3://tenant-x-data/val/",
    );
    expect(detail.trainingMetrics?.trainingLoss).toBe(0.42);
    expect(detail.validationMetrics?.[0]!.validationLoss).toBe(0.51);
  });

  it("parses a distillation detail with teacherModelConfig", async () => {
    const provider = build({
      fetch: buildFetch({
        text: detailBody({
          customizationType: "DISTILLATION",
          customizationConfig: {
            distillationConfig: {
              teacherModelConfig: {
                teacherModelIdentifier:
                  "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
                maxResponseLengthForInference: 4096,
              },
            },
          },
        }),
      }),
    });
    const detail = await provider.getCustomModel("abc");
    expect(
      detail.customizationConfig?.distillationConfig?.teacherModelConfig
        .teacherModelIdentifier,
    ).toMatch(/claude-3-5-sonnet/);
    expect(
      detail.customizationConfig?.distillationConfig?.teacherModelConfig
        .maxResponseLengthForInference,
    ).toBe(4096);
  });

  it("propagates 404 as not_found_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no such custom model",
        }),
      }),
    });
    await expect(
      provider.getCustomModel("not-a-real-model"),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(provider.getCustomModel("abc")).rejects.toMatchObject({
      kind: "permission_error",
      status: 403,
    });
  });

  it("throws api_error on non-JSON body", async () => {
    const provider = build({ fetch: buildFetch({ text: "<html>oops</html>" }) });
    await expect(provider.getCustomModel("abc")).rejects.toMatchObject({
      kind: "api_error",
    });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(provider.getCustomModel("abc")).rejects.toMatchObject({
      kind: "network_error",
    });
  });
});

describe("BedrockProvider — listCustomModels (M2.X.5.aa.z.13)", () => {
  function listBody(opts: {
    items?: ReadonlyArray<Record<string, unknown>>;
    nextToken?: string;
  }): string {
    const body: Record<string, unknown> = { modelSummaries: opts.items ?? [] };
    if (opts.nextToken !== undefined) body["nextToken"] = opts.nextToken;
    return JSON.stringify(body);
  }

  function sampleCustom(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      modelArn:
        "arn:aws:bedrock:us-east-1:123456789012:custom-model/anthropic.claude-3-haiku-20240307-v1:0:200k/abc",
      modelName: "tenant-x-claude-finetune",
      creationTime: "2026-04-15T12:00:00Z",
      baseModelArn:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0:200k",
      baseModelName: "Claude 3 Haiku",
      customizationType: "FINE_TUNING",
      ownerAccountId: "123456789012",
      modelStatus: "Active",
      ...overrides,
    };
  }

  it("GETs the control-plane /custom-models endpoint with sig v4 headers", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listCustomModels();
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).not.toContain("bedrock-runtime.");
    expect(capture.url).toContain("/custom-models");
    expect(capture.init?.method).toBe("GET");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("zero-arg call emits no query string", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listCustomModels();
    expect(capture.url).not.toContain("?");
  });

  it("threads query parameters into the URL", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listCustomModels({
      nameContains: "tenant-x",
      isOwned: true,
      modelStatus: "Active",
      maxResults: 50,
      sortBy: "CreationTime",
      sortOrder: "Descending",
    });
    expect(capture.url).toContain("nameContains=tenant-x");
    expect(capture.url).toContain("isOwned=true");
    expect(capture.url).toContain("modelStatus=Active");
    expect(capture.url).toContain("maxResults=50");
    expect(capture.url).toContain("sortBy=CreationTime");
    expect(capture.url).toContain("sortOrder=Descending");
  });

  it("parses a response with one custom model + nextToken", async () => {
    const provider = build({
      fetch: buildFetch({
        text: listBody({ items: [sampleCustom()], nextToken: "page-2" }),
      }),
    });
    const out = await provider.listCustomModels();
    expect(out.modelSummaries.length).toBe(1);
    expect(out.modelSummaries[0]!.modelName).toBe("tenant-x-claude-finetune");
    expect(out.modelSummaries[0]!.customizationType).toBe("FINE_TUNING");
    expect(out.modelSummaries[0]!.modelStatus).toBe("Active");
    expect(out.nextToken).toBe("page-2");
  });

  it("validates options BEFORE fetch — bad modelStatus never burns a request", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.listCustomModels({ modelStatus: "Inactive" as never }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(provider.listCustomModels()).rejects.toMatchObject({
      kind: "permission_error",
      status: 403,
    });
  });

  it("throws api_error on non-JSON body", async () => {
    const provider = build({ fetch: buildFetch({ text: "<html>oops</html>" }) });
    await expect(provider.listCustomModels()).rejects.toMatchObject({
      kind: "api_error",
    });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(provider.listCustomModels()).rejects.toMatchObject({
      kind: "network_error",
    });
  });
});

describe("BedrockProvider — getImportedModel (M2.X.5.aa.z.12)", () => {
  function detailBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      modelArn:
        "arn:aws:bedrock:us-east-1:123456789012:imported-model/abc123def456",
      modelName: "tenant-x-llama3-finetune",
      creationTime: "2026-04-15T12:00:00Z",
      instructSupported: true,
      modelArchitecture: "LLAMA3",
      jobName: "import-tenant-x-2026-04-15",
      jobArn:
        "arn:aws:bedrock:us-east-1:123456789012:model-import-job/xyz789",
      modelDataSource: {
        s3DataSource: { s3Uri: "s3://tenant-x-artifacts/llama3/" },
      },
      ...overrides,
    });
  }

  it("GETs the control-plane /imported-models/{id} endpoint", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: detailBody() }),
    });
    await provider.getImportedModel("abc123def456");
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).toContain("/imported-models/abc123def456");
    expect(capture.url).not.toContain("?");
    expect(capture.init?.method).toBe("GET");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("URI-encodes ARN colons in the path", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: detailBody() }),
    });
    const arn =
      "arn:aws:bedrock:us-east-1:123456789012:imported-model/abc123def456";
    await provider.getImportedModel(arn);
    expect(capture.url).toContain("%3A");
  });

  it("validates identifier BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(provider.getImportedModel("")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    expect(called).toBe(0);
  });

  it("parses a complete detail response", async () => {
    const provider = build({
      fetch: buildFetch({
        text: detailBody({
          modelKmsKeyArn: "arn:aws:kms:us-east-1:123:key/xyz",
        }),
      }),
    });
    const detail = await provider.getImportedModel("abc123def456");
    expect(detail.modelName).toBe("tenant-x-llama3-finetune");
    expect(detail.instructSupported).toBe(true);
    expect(detail.modelArchitecture).toBe("LLAMA3");
    expect(detail.jobName).toBe("import-tenant-x-2026-04-15");
    expect(detail.modelDataSource.s3DataSource.s3Uri).toBe(
      "s3://tenant-x-artifacts/llama3/",
    );
    expect(detail.modelKmsKeyArn).toMatch(/^arn:aws:kms:/);
  });

  it("propagates 404 as not_found_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no such model",
        }),
      }),
    });
    await expect(
      provider.getImportedModel("not-a-real-model"),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(
      provider.getImportedModel("abc123def456"),
    ).rejects.toMatchObject({ kind: "permission_error", status: 403 });
  });

  it("throws api_error on non-JSON body", async () => {
    const provider = build({ fetch: buildFetch({ text: "<html>oops</html>" }) });
    await expect(
      provider.getImportedModel("abc123def456"),
    ).rejects.toMatchObject({ kind: "api_error" });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(
      provider.getImportedModel("abc123def456"),
    ).rejects.toMatchObject({ kind: "network_error" });
  });
});

describe("BedrockProvider — listImportedModels (M2.X.5.aa.z.11)", () => {
  function listBody(opts: {
    items?: ReadonlyArray<Record<string, unknown>>;
    nextToken?: string;
  }): string {
    const body: Record<string, unknown> = { modelSummaries: opts.items ?? [] };
    if (opts.nextToken !== undefined) body["nextToken"] = opts.nextToken;
    return JSON.stringify(body);
  }

  function sampleImportedModel(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      modelArn:
        "arn:aws:bedrock:us-east-1:123456789012:imported-model/abc123def456",
      modelName: "tenant-x-llama3-finetune",
      creationTime: "2026-04-15T12:00:00Z",
      instructSupported: true,
      modelArchitecture: "LLAMA3",
      ...overrides,
    };
  }

  it("GETs the control-plane /imported-models endpoint with sig v4 headers", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listImportedModels();
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).not.toContain("bedrock-runtime.");
    expect(capture.url).toContain("/imported-models");
    expect(capture.init?.method).toBe("GET");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("zero-arg call emits no query string", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listImportedModels();
    expect(capture.url).not.toContain("?");
  });

  it("threads query parameters into the URL", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listImportedModels({
      nameContains: "tenant-x",
      maxResults: 50,
      sortBy: "CreationTime",
      sortOrder: "Descending",
    });
    expect(capture.url).toContain("nameContains=tenant-x");
    expect(capture.url).toContain("maxResults=50");
    expect(capture.url).toContain("sortBy=CreationTime");
    expect(capture.url).toContain("sortOrder=Descending");
  });

  it("parses a response with one model + nextToken", async () => {
    const provider = build({
      fetch: buildFetch({
        text: listBody({ items: [sampleImportedModel()], nextToken: "page-2" }),
      }),
    });
    const out = await provider.listImportedModels();
    expect(out.modelSummaries.length).toBe(1);
    expect(out.modelSummaries[0]!.modelName).toBe("tenant-x-llama3-finetune");
    expect(out.modelSummaries[0]!.instructSupported).toBe(true);
    expect(out.modelSummaries[0]!.modelArchitecture).toBe("LLAMA3");
    expect(out.nextToken).toBe("page-2");
  });

  it("validates options BEFORE fetch — bad nameContains never burns a request", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.listImportedModels({ nameContains: "" }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(provider.listImportedModels()).rejects.toMatchObject({
      kind: "permission_error",
      status: 403,
    });
  });

  it("throws api_error on non-JSON body", async () => {
    const provider = build({ fetch: buildFetch({ text: "<html>oops</html>" }) });
    await expect(provider.listImportedModels()).rejects.toMatchObject({
      kind: "api_error",
    });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(provider.listImportedModels()).rejects.toMatchObject({
      kind: "network_error",
    });
  });
});

describe("BedrockProvider — getInferenceProfile (M2.X.5.aa.z.10)", () => {
  function detailBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      inferenceProfileId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      inferenceProfileName: "Claude 3.5 Sonnet (US)",
      inferenceProfileArn:
        "arn:aws:bedrock:us-east-1::inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      models: [
        {
          modelArn:
            "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
        },
      ],
      status: "ACTIVE",
      type: "SYSTEM_DEFINED",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
      ...overrides,
    });
  }

  it("GETs the control-plane /inference-profiles/{id} endpoint", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: detailBody() }),
    });
    await provider.getInferenceProfile("us.anthropic.claude-3-5-sonnet-20241022-v2:0");
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).toContain("/inference-profiles/");
    expect(capture.url).not.toContain("?");
    expect(capture.init?.method).toBe("GET");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("URI-encodes ARN colons in the path", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: detailBody() }),
    });
    const arn =
      "arn:aws:bedrock:us-east-1::inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0";
    await provider.getInferenceProfile(arn);
    expect(capture.url).toContain("%3A");
  });

  it("validates identifier BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(provider.getInferenceProfile("")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    expect(called).toBe(0);
  });

  it("parses a complete detail response", async () => {
    const provider = build({
      fetch: buildFetch({
        text: detailBody({
          description: "Cross-region failover",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
            },
            {
              modelArn:
                "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
            },
          ],
        }),
      }),
    });
    const detail = await provider.getInferenceProfile(
      "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
    expect(detail.status).toBe("ACTIVE");
    expect(detail.type).toBe("SYSTEM_DEFINED");
    expect(detail.models.length).toBe(2);
    expect(detail.description).toBe("Cross-region failover");
  });

  it("propagates 404 as not_found_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no such profile",
        }),
      }),
    });
    await expect(
      provider.getInferenceProfile("not.a.real.profile"),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(
      provider.getInferenceProfile("us.anthropic.claude-3-5-sonnet-20241022-v2:0"),
    ).rejects.toMatchObject({ kind: "permission_error", status: 403 });
  });

  it("throws api_error on non-JSON body", async () => {
    const provider = build({ fetch: buildFetch({ text: "<html>oops</html>" }) });
    await expect(
      provider.getInferenceProfile("us.anthropic.claude-3-5-sonnet-20241022-v2:0"),
    ).rejects.toMatchObject({ kind: "api_error" });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(
      provider.getInferenceProfile("us.anthropic.claude-3-5-sonnet-20241022-v2:0"),
    ).rejects.toMatchObject({ kind: "network_error" });
  });
});

describe("BedrockProvider — listInferenceProfiles (M2.X.5.aa.z.9)", () => {
  function listBody(opts: {
    items?: ReadonlyArray<Record<string, unknown>>;
    nextToken?: string;
  }): string {
    const body: Record<string, unknown> = {
      inferenceProfileSummaries: opts.items ?? [],
    };
    if (opts.nextToken !== undefined) body["nextToken"] = opts.nextToken;
    return JSON.stringify(body);
  }

  function sampleProfile(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      inferenceProfileId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      inferenceProfileName: "Claude 3.5 Sonnet (US)",
      inferenceProfileArn:
        "arn:aws:bedrock:us-east-1::inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      models: [
        {
          modelArn:
            "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
        },
      ],
      status: "ACTIVE",
      type: "SYSTEM_DEFINED",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
      ...overrides,
    };
  }

  it("GETs the control-plane /inference-profiles endpoint with sig v4 headers", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listInferenceProfiles();
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).not.toContain("bedrock-runtime.");
    expect(capture.url).toContain("/inference-profiles");
    expect(capture.init?.method).toBe("GET");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("zero-arg call emits no query string", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listInferenceProfiles();
    expect(capture.url).not.toContain("?");
  });

  it("threads query parameters into the URL", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listInferenceProfiles({
      typeEquals: "APPLICATION",
      maxResults: 50,
    });
    expect(capture.url).toContain("typeEquals=APPLICATION");
    expect(capture.url).toContain("maxResults=50");
  });

  it("parses a response with one profile + nextToken", async () => {
    const provider = build({
      fetch: buildFetch({
        text: listBody({ items: [sampleProfile()], nextToken: "page-2" }),
      }),
    });
    const out = await provider.listInferenceProfiles();
    expect(out.inferenceProfileSummaries.length).toBe(1);
    expect(out.inferenceProfileSummaries[0]!.type).toBe("SYSTEM_DEFINED");
    expect(out.inferenceProfileSummaries[0]!.models[0]!.modelArn).toMatch(
      /claude-3-5-sonnet/,
    );
    expect(out.nextToken).toBe("page-2");
  });

  it("validates options BEFORE fetch — bad typeEquals never burns a request", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.listInferenceProfiles({ typeEquals: "CUSTOM" as never }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(provider.listInferenceProfiles()).rejects.toMatchObject({
      kind: "permission_error",
      status: 403,
    });
  });

  it("throws api_error on non-JSON body", async () => {
    const provider = build({
      fetch: buildFetch({ text: "<html>oops</html>" }),
    });
    await expect(provider.listInferenceProfiles()).rejects.toMatchObject({
      kind: "api_error",
    });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(provider.listInferenceProfiles()).rejects.toMatchObject({
      kind: "network_error",
    });
  });
});

describe("BedrockProvider — getGuardrail (M2.X.5.aa.z.8)", () => {
  function detailBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      guardrailId: "gr12345",
      guardrailArn: "arn:aws:bedrock:us-east-1:123:guardrail/gr12345",
      name: "tenant-x-policy",
      version: "DRAFT",
      status: "READY",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
      blockedInputMessaging: "blocked",
      blockedOutputsMessaging: "blocked",
      ...overrides,
    });
  }

  it("GETs control-plane /guardrails/{id} without query when no version", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: detailBody() }),
    });
    await provider.getGuardrail("gr12345");
    expect(capture.url).toBe(
      "https://bedrock.us-east-1.amazonaws.com/guardrails/gr12345",
    );
    expect(capture.init?.method).toBe("GET");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("threads guardrailVersion as a query parameter", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: detailBody({ version: "3" }) }),
    });
    await provider.getGuardrail("gr12345", "3");
    expect(capture.url).toContain("/guardrails/gr12345?");
    expect(capture.url).toContain("guardrailVersion=3");
  });

  it("URI-encodes the identifier path component", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: detailBody() }),
    });
    const arn = "arn:aws:bedrock:us-east-1:123:guardrail/gr12345";
    await provider.getGuardrail(arn);
    expect(capture.url).toContain("%3A");
  });

  it("validates inputs BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(provider.getGuardrail("")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    await expect(provider.getGuardrail("gr12345", "")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    expect(called).toBe(0);
  });

  it("parses a complete detail response with all policy types", async () => {
    const provider = build({
      fetch: buildFetch({
        text: detailBody({
          description: "PII redaction policy",
          kmsKeyArn: "arn:aws:kms:us-east-1:123:key/xyz",
          contentPolicy: {
            filters: [
              { type: "HATE", inputStrength: "HIGH", outputStrength: "MEDIUM" },
            ],
          },
          sensitiveInformationPolicy: {
            piiEntities: [{ type: "EMAIL", action: "ANONYMIZE" }],
          },
          contextualGroundingPolicy: {
            filters: [{ type: "GROUNDING", threshold: 0.7 }],
          },
        }),
      }),
    });
    const detail = await provider.getGuardrail("gr12345");
    expect(detail.description).toBe("PII redaction policy");
    expect(detail.kmsKeyArn).toMatch(/^arn:aws:kms:/);
    expect(detail.contentPolicy?.filters[0]!.type).toBe("HATE");
    expect(detail.sensitiveInformationPolicy?.piiEntities?.[0]!.action).toBe(
      "ANONYMIZE",
    );
    expect(detail.contextualGroundingPolicy?.filters[0]!.threshold).toBe(0.7);
  });

  it("propagates 404 as not_found_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no such guardrail",
        }),
      }),
    });
    await expect(provider.getGuardrail("gr00000")).rejects.toMatchObject({
      kind: "not_found_error",
      status: 404,
    });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(provider.getGuardrail("gr12345")).rejects.toMatchObject({
      kind: "permission_error",
      status: 403,
    });
  });

  it("throws api_error on non-JSON body", async () => {
    const provider = build({
      fetch: buildFetch({ text: "<html>oops</html>" }),
    });
    await expect(provider.getGuardrail("gr12345")).rejects.toMatchObject({
      kind: "api_error",
    });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(provider.getGuardrail("gr12345")).rejects.toMatchObject({
      kind: "network_error",
    });
  });
});

describe("BedrockProvider — listGuardrails (M2.X.5.aa.z.7)", () => {
  function listBody(opts: {
    items?: ReadonlyArray<Record<string, unknown>>;
    nextToken?: string;
  }): string {
    const body: Record<string, unknown> = { guardrails: opts.items ?? [] };
    if (opts.nextToken !== undefined) body["nextToken"] = opts.nextToken;
    return JSON.stringify(body);
  }

  function sampleGuardrail(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: "gr12345",
      arn: "arn:aws:bedrock:us-east-1:123456789012:guardrail/gr12345",
      status: "READY",
      name: "tenant-x-policy",
      version: "1",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
      ...overrides,
    };
  }

  it("GETs the control-plane /guardrails endpoint with sig v4 headers", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listGuardrails();
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).not.toContain("bedrock-runtime.");
    expect(capture.url).toContain("/guardrails");
    expect(capture.init?.method).toBe("GET");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("zero-arg call emits no query string", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listGuardrails();
    expect(capture.url).not.toContain("?");
  });

  it("threads query parameters into the URL", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: listBody({ items: [] }) }),
    });
    await provider.listGuardrails({
      guardrailIdentifier: "gr12345",
      maxResults: 50,
    });
    expect(capture.url).toContain("guardrailIdentifier=gr12345");
    expect(capture.url).toContain("maxResults=50");
  });

  it("parses a response with one guardrail + nextToken", async () => {
    const provider = build({
      fetch: buildFetch({
        text: listBody({ items: [sampleGuardrail()], nextToken: "page-2" }),
      }),
    });
    const out = await provider.listGuardrails();
    expect(out.guardrails.length).toBe(1);
    expect(out.guardrails[0]!.name).toBe("tenant-x-policy");
    expect(out.guardrails[0]!.status).toBe("READY");
    expect(out.nextToken).toBe("page-2");
  });

  it("validates options BEFORE fetch — bad maxResults never burns a request", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.listGuardrails({ maxResults: 9999 }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(provider.listGuardrails()).rejects.toMatchObject({
      kind: "permission_error",
      status: 403,
    });
  });

  it("throws api_error on non-JSON body", async () => {
    const provider = build({
      fetch: buildFetch({ text: "<html>oops</html>" }),
    });
    await expect(provider.listGuardrails()).rejects.toMatchObject({
      kind: "api_error",
    });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(provider.listGuardrails()).rejects.toMatchObject({
      kind: "network_error",
    });
  });
});

describe("BedrockProvider — createBatch (M2.X.5.aa.z.6)", () => {
  function minimalCreate() {
    return {
      jobName: "tenant-x-batch-0001",
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      roleArn: "arn:aws:iam::123456789012:role/BedrockBatchRole",
      inputDataConfig: { s3InputDataConfig: { s3Uri: "s3://bucket/in/" } },
      outputDataConfig: { s3OutputDataConfig: { s3Uri: "s3://bucket/out/" } },
    };
  }

  it("POSTs control-plane /model-invocation-jobs with the JSON body", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({
        capture,
        text: JSON.stringify({
          jobArn:
            "arn:aws:bedrock:us-east-1:123456789012:model-invocation-job/aaaa1111bbbb",
        }),
      }),
    });
    const out = await provider.createBatch(minimalCreate());
    expect(capture.url).toBe(
      "https://bedrock.us-east-1.amazonaws.com/model-invocation-jobs",
    );
    expect(capture.init?.method).toBe("POST");
    expect(capture.init?.headers["content-type"]).toBe("application/json");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
    const sentBody = JSON.parse(
      new TextDecoder().decode(capture.init?.body),
    ) as Record<string, unknown>;
    expect(sentBody["jobName"]).toBe("tenant-x-batch-0001");
    expect(sentBody["modelId"]).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
    expect(out.jobArn).toMatch(/aaaa1111bbbb$/);
  });

  it("validates input BEFORE fetch — bad jobName never burns a request", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.createBatch({ ...minimalCreate(), jobName: "bad name" }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("validates input BEFORE fetch — bad roleArn never burns a request", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.createBatch({ ...minimalCreate(), roleArn: "not-an-arn" }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("threads optional fields into the body", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({
        capture,
        text: JSON.stringify({
          jobArn:
            "arn:aws:bedrock:us-east-1:123456789012:model-invocation-job/abcd1234efgh",
        }),
      }),
    });
    await provider.createBatch({
      ...minimalCreate(),
      clientRequestToken: "req-001-abc",
      tags: [{ key: "tenant", value: "x" }],
      timeoutDurationInHours: 48,
      vpcConfig: { subnetIds: ["s-1"], securityGroupIds: ["sg-1"] },
    });
    const sentBody = JSON.parse(
      new TextDecoder().decode(capture.init?.body),
    ) as Record<string, unknown>;
    expect(sentBody["clientRequestToken"]).toBe("req-001-abc");
    expect(sentBody["tags"]).toEqual([{ key: "tenant", value: "x" }]);
    expect(sentBody["timeoutDurationInHours"]).toBe(48);
  });

  it("propagates 409 ConflictException as conflict_error (M2.X.12 — idempotency token reuse)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 409,
        text: JSON.stringify({
          __type: "ConflictException",
          message: "jobName already exists",
        }),
      }),
    });
    await expect(provider.createBatch(minimalCreate())).rejects.toMatchObject({
      kind: "conflict_error",
      status: 409,
      code: "ConflictException",
    });
  });

  it("propagates 400 ValidationException as invalid_request_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 400,
        text: JSON.stringify({
          __type: "ValidationException",
          message: "role does not have s3:GetObject permission",
        }),
      }),
    });
    await expect(provider.createBatch(minimalCreate())).rejects.toMatchObject({
      kind: "invalid_request_error",
      status: 400,
    });
  });

  it("throws api_error when response has no jobArn", async () => {
    const provider = build({
      fetch: buildFetch({ text: JSON.stringify({ ok: true }) }),
    });
    await expect(provider.createBatch(minimalCreate())).rejects.toMatchObject({
      kind: "api_error",
    });
  });

  it("throws api_error on non-JSON body", async () => {
    const provider = build({
      fetch: buildFetch({ text: "<html>oops</html>" }),
    });
    await expect(provider.createBatch(minimalCreate())).rejects.toMatchObject({
      kind: "api_error",
    });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(provider.createBatch(minimalCreate())).rejects.toMatchObject({
      kind: "network_error",
    });
  });
});

describe("BedrockProvider — stopBatch (M2.X.5.aa.z.5)", () => {
  it("POSTs control-plane /model-invocation-jobs/{id}/stop with empty body", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: "" }),
    });
    await provider.stopBatch("abcd1234efgh");
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).toContain("/model-invocation-jobs/abcd1234efgh/stop");
    expect(capture.init?.method).toBe("POST");
    expect(capture.init?.body.byteLength).toBe(0);
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(capture.init?.headers["content-type"]).toBe("application/json");
  });

  it("URI-encodes ARN colons in the path", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: "" }),
    });
    const arn =
      "arn:aws:bedrock:us-east-1:123456789012:model-invocation-job/abcd1234efgh";
    await provider.stopBatch(arn);
    expect(capture.url).toContain("%3A");
    expect(capture.url).toContain("/stop");
  });

  it("does not run against the runtime host", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: "" }),
    });
    await provider.stopBatch("abcd1234efgh");
    expect(capture.url).not.toContain("bedrock-runtime.");
  });

  it("validates identifier BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(provider.stopBatch("INVALID")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    await expect(provider.stopBatch("")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    expect(called).toBe(0);
  });

  it("resolves void on success", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 200, text: "" }),
    });
    const result = await provider.stopBatch("abcd1234efgh");
    expect(result).toBeUndefined();
  });

  it("tolerates an empty JSON object body", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 200, text: "{}" }),
    });
    await expect(provider.stopBatch("abcd1234efgh")).resolves.toBeUndefined();
  });

  it("propagates 404 as not_found_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "job does not exist",
        }),
      }),
    });
    await expect(provider.stopBatch("abcd1234efgh")).rejects.toMatchObject({
      kind: "not_found_error",
      status: 404,
    });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(provider.stopBatch("abcd1234efgh")).rejects.toMatchObject({
      kind: "permission_error",
      status: 403,
    });
  });

  it("classifies 409 ConflictException as conflict_error (M2.X.12 — terminal-state stops)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 409,
        text: JSON.stringify({
          __type: "ConflictException",
          message: "job is already in terminal state",
        }),
      }),
    });
    await expect(provider.stopBatch("abcd1234efgh")).rejects.toMatchObject({
      kind: "conflict_error",
      status: 409,
      code: "ConflictException",
    });
  });

  it("propagates 429 as rate_limit_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 429,
        text: JSON.stringify({ __type: "ThrottlingException", message: "slow down" }),
      }),
    });
    await expect(provider.stopBatch("abcd1234efgh")).rejects.toMatchObject({
      kind: "rate_limit_error",
      status: 429,
    });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(provider.stopBatch("abcd1234efgh")).rejects.toMatchObject({
      kind: "network_error",
    });
  });
});

describe("BedrockProvider — deleteCustomModel (M2.X.5.aa.z.21)", () => {
  it("DELETEs control-plane /custom-models/{id} with empty body", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "" }) });
    await provider.deleteCustomModel("my-cm-id");
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).toContain("/custom-models/my-cm-id");
    expect(capture.init?.method).toBe("DELETE");
    expect(capture.init?.body.byteLength).toBe(0);
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("URI-encodes ARN colons in the path", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "" }) });
    const arn = "arn:aws:bedrock:us-east-1:123:custom-model/abc";
    await provider.deleteCustomModel(arn);
    expect(capture.url).toContain("%3A");
  });

  it("does not run against the runtime host", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "" }) });
    await provider.deleteCustomModel("abc");
    expect(capture.url).not.toContain("bedrock-runtime.");
  });

  it("validates identifier BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(provider.deleteCustomModel("")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    expect(called).toBe(0);
  });

  it("resolves void on success", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 200, text: "" }),
    });
    const result = await provider.deleteCustomModel("abc");
    expect(result).toBeUndefined();
  });

  it("tolerates a 204 No Content response (typical DELETE outcome)", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 204, text: "" }),
    });
    await expect(provider.deleteCustomModel("abc")).resolves.toBeUndefined();
  });

  it("propagates 404 as not_found_error (caller decides idempotency)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no such model",
        }),
      }),
    });
    await expect(provider.deleteCustomModel("abc")).rejects.toMatchObject({
      kind: "not_found_error",
      status: 404,
    });
  });

  it("classifies 409 ConflictException as conflict_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 409,
        text: JSON.stringify({
          __type: "ConflictException",
          message: "model is referenced by a provisioned throughput",
        }),
      }),
    });
    await expect(provider.deleteCustomModel("abc")).rejects.toMatchObject({
      kind: "conflict_error",
      status: 409,
      code: "ConflictException",
    });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(provider.deleteCustomModel("abc")).rejects.toMatchObject({
      kind: "permission_error",
      status: 403,
    });
  });

  it("propagates 429 as rate_limit_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 429,
        text: JSON.stringify({ __type: "ThrottlingException", message: "slow down" }),
      }),
    });
    await expect(provider.deleteCustomModel("abc")).rejects.toMatchObject({
      kind: "rate_limit_error",
      status: 429,
    });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(provider.deleteCustomModel("abc")).rejects.toMatchObject({
      kind: "network_error",
    });
  });
});

describe("BedrockProvider — deleteImportedModel (M2.X.5.aa.z.21)", () => {
  it("DELETEs control-plane /imported-models/{id}", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "" }) });
    await provider.deleteImportedModel("im-abc");
    expect(capture.url).toContain("/imported-models/im-abc");
    expect(capture.init?.method).toBe("DELETE");
  });

  it("URI-encodes ARN colons in the path", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "" }) });
    const arn = "arn:aws:bedrock:us-east-1:123:imported-model/abc";
    await provider.deleteImportedModel(arn);
    expect(capture.url).toContain("%3A");
  });

  it("validates identifier BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(provider.deleteImportedModel("")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    expect(called).toBe(0);
  });

  it("resolves void on success (204)", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 204, text: "" }),
    });
    await expect(provider.deleteImportedModel("im-abc")).resolves.toBeUndefined();
  });

  it("propagates 404 as not_found_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no such imported model",
        }),
      }),
    });
    await expect(provider.deleteImportedModel("im-abc")).rejects.toMatchObject({
      kind: "not_found_error",
      status: 404,
    });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(provider.deleteImportedModel("im-abc")).rejects.toMatchObject({
      kind: "permission_error",
      status: 403,
    });
  });

  it("propagates 429 as rate_limit_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 429,
        text: JSON.stringify({ __type: "ThrottlingException", message: "slow down" }),
      }),
    });
    await expect(provider.deleteImportedModel("im-abc")).rejects.toMatchObject({
      kind: "rate_limit_error",
      status: 429,
    });
  });
});

describe("BedrockProvider — deleteGuardrail (M2.X.5.aa.z.21)", () => {
  it("DELETEs control-plane /guardrails/{id} with no query when version omitted", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "" }) });
    await provider.deleteGuardrail("gr-abc");
    expect(capture.url).toContain("/guardrails/gr-abc");
    expect(capture.url).not.toContain("?");
    expect(capture.init?.method).toBe("DELETE");
  });

  it("appends ?guardrailVersion when provided", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "" }) });
    await provider.deleteGuardrail("gr-abc", "DRAFT");
    expect(capture.url).toContain("/guardrails/gr-abc");
    expect(capture.url).toContain("guardrailVersion=DRAFT");
  });

  it("URI-encodes ARN colons in the path", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "" }) });
    const arn = "arn:aws:bedrock:us-east-1:123:guardrail/abc";
    await provider.deleteGuardrail(arn);
    expect(capture.url).toContain("%3A");
  });

  it("validates identifier BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(provider.deleteGuardrail("")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    expect(called).toBe(0);
  });

  it("validates guardrailVersion BEFORE fetch when provided empty", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(provider.deleteGuardrail("gr-abc", "")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    expect(called).toBe(0);
  });

  it("resolves void on success", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 202, text: "" }),
    });
    await expect(provider.deleteGuardrail("gr-abc")).resolves.toBeUndefined();
  });

  it("propagates 404 as not_found_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no such guardrail",
        }),
      }),
    });
    await expect(provider.deleteGuardrail("gr-abc")).rejects.toMatchObject({
      kind: "not_found_error",
      status: 404,
    });
  });

  it("classifies 409 ConflictException as conflict_error (in-use guardrail)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 409,
        text: JSON.stringify({
          __type: "ConflictException",
          message: "guardrail is in use by an application",
        }),
      }),
    });
    await expect(provider.deleteGuardrail("gr-abc")).rejects.toMatchObject({
      kind: "conflict_error",
      status: 409,
      code: "ConflictException",
    });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(provider.deleteGuardrail("gr-abc")).rejects.toMatchObject({
      kind: "permission_error",
      status: 403,
    });
  });

  it("propagates 429 as rate_limit_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 429,
        text: JSON.stringify({ __type: "ThrottlingException", message: "slow down" }),
      }),
    });
    await expect(provider.deleteGuardrail("gr-abc")).rejects.toMatchObject({
      kind: "rate_limit_error",
      status: 429,
    });
  });
});

describe("BedrockProvider — deleteInferenceProfile (M2.X.5.aa.z.22)", () => {
  interface MethodCall {
    method: string;
    url: string;
  }

  function applicationProfileJson(
    id: string = "ip-application-1",
    extras: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      inferenceProfileId: id,
      inferenceProfileName: "test",
      inferenceProfileArn: `arn:aws:bedrock:us-east-1:123:application-inference-profile/${id}`,
      models: [
        { modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet" },
      ],
      status: "ACTIVE",
      type: "APPLICATION",
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-19T12:00:00.000Z",
      ...extras,
    });
  }

  function systemProfileJson(
    id: string = "ip-system-1",
  ): string {
    return JSON.stringify({
      inferenceProfileId: id,
      inferenceProfileName: "anthropic.claude-3-sonnet",
      inferenceProfileArn: `arn:aws:bedrock:us-east-1::inference-profile/${id}`,
      models: [
        { modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet" },
      ],
      status: "ACTIVE",
      type: "SYSTEM_DEFINED",
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-19T12:00:00.000Z",
    });
  }

  function sequencedFetch(opts: {
    calls: MethodCall[];
    onGet: () => { ok: boolean; status: number; text: string };
    onDelete?: () => { ok: boolean; status: number; text: string };
  }): FetchLike {
    return async (url, init) => {
      opts.calls.push({ method: init.method, url });
      const resp =
        init.method === "DELETE"
          ? (opts.onDelete ?? (() => ({ ok: true, status: 204, text: "" })))()
          : opts.onGet();
      return {
        ok: resp.ok,
        status: resp.status,
        text: async () => resp.text,
        arrayBuffer: async () => new ArrayBuffer(0),
        body: null,
      };
    };
  }

  it("pre-flights GET, then DELETEs when type === APPLICATION", async () => {
    const calls: MethodCall[] = [];
    const provider = build({
      fetch: sequencedFetch({
        calls,
        onGet: () => ({ ok: true, status: 200, text: applicationProfileJson("ip-application-1") }),
      }),
    });
    await provider.deleteInferenceProfile("ip-application-1");
    expect(calls.length).toBe(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/inference-profiles/ip-application-1");
    expect(calls[1]?.method).toBe("DELETE");
    expect(calls[1]?.url).toContain("/inference-profiles/ip-application-1");
  });

  it("refuses to delete SYSTEM_DEFINED profiles and NEVER issues DELETE", async () => {
    const calls: MethodCall[] = [];
    const provider = build({
      fetch: sequencedFetch({
        calls,
        onGet: () => ({ ok: true, status: 200, text: systemProfileJson("ip-system-1") }),
      }),
    });
    await expect(
      provider.deleteInferenceProfile("ip-system-1"),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe("GET");
  });

  it("system-profile guard error message names the profile and type", async () => {
    const provider = build({
      fetch: sequencedFetch({
        calls: [],
        onGet: () => ({ ok: true, status: 200, text: systemProfileJson("ip-system-1") }),
      }),
    });
    await expect(
      provider.deleteInferenceProfile("ip-system-1"),
    ).rejects.toThrow(/SYSTEM_DEFINED/);
    await expect(
      provider.deleteInferenceProfile("ip-system-1"),
    ).rejects.toThrow(/ip-system-1/);
  });

  it("URI-encodes ARN colons on both GET and DELETE", async () => {
    const calls: MethodCall[] = [];
    const arn = "arn:aws:bedrock:us-east-1:123:application-inference-profile/abc";
    const provider = build({
      fetch: sequencedFetch({
        calls,
        onGet: () => ({ ok: true, status: 200, text: applicationProfileJson(arn) }),
      }),
    });
    await provider.deleteInferenceProfile(arn);
    expect(calls[0]?.url).toContain("%3A");
    expect(calls[1]?.url).toContain("%3A");
  });

  it("does not run against the runtime host", async () => {
    const calls: MethodCall[] = [];
    const provider = build({
      fetch: sequencedFetch({
        calls,
        onGet: () => ({ ok: true, status: 200, text: applicationProfileJson() }),
      }),
    });
    await provider.deleteInferenceProfile("ip-application-1");
    for (const call of calls) {
      expect(call.url).not.toContain("bedrock-runtime.");
    }
  });

  it("validates identifier BEFORE pre-flight GET", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(provider.deleteInferenceProfile("")).rejects.toMatchObject({
      kind: "invalid_request_error",
    });
    expect(called).toBe(0);
  });

  it("propagates 404 from the pre-flight GET (profile doesn't exist)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no such profile",
        }),
      }),
    });
    await expect(
      provider.deleteInferenceProfile("ip-missing"),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
  });

  it("propagates 403 from the pre-flight GET (no GetInferenceProfile permission)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(
      provider.deleteInferenceProfile("ip-application-1"),
    ).rejects.toMatchObject({ kind: "permission_error", status: 403 });
  });

  it("propagates 404 from the DELETE (race: profile deleted between GET and DELETE)", async () => {
    const calls: MethodCall[] = [];
    const provider = build({
      fetch: sequencedFetch({
        calls,
        onGet: () => ({ ok: true, status: 200, text: applicationProfileJson("ip-application-1") }),
        onDelete: () => ({
          ok: false,
          status: 404,
          text: JSON.stringify({
            __type: "ResourceNotFoundException",
            message: "deleted already",
          }),
        }),
      }),
    });
    await expect(
      provider.deleteInferenceProfile("ip-application-1"),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
    expect(calls.length).toBe(2);
  });

  it("propagates 403 from the DELETE (have GET but not DeleteInferenceProfile permission)", async () => {
    const provider = build({
      fetch: sequencedFetch({
        calls: [],
        onGet: () => ({ ok: true, status: 200, text: applicationProfileJson("ip-application-1") }),
        onDelete: () => ({
          ok: false,
          status: 403,
          text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
        }),
      }),
    });
    await expect(
      provider.deleteInferenceProfile("ip-application-1"),
    ).rejects.toMatchObject({ kind: "permission_error", status: 403 });
  });

  it("propagates 429 from the DELETE", async () => {
    const provider = build({
      fetch: sequencedFetch({
        calls: [],
        onGet: () => ({ ok: true, status: 200, text: applicationProfileJson("ip-application-1") }),
        onDelete: () => ({
          ok: false,
          status: 429,
          text: JSON.stringify({
            __type: "ThrottlingException",
            message: "slow down",
          }),
        }),
      }),
    });
    await expect(
      provider.deleteInferenceProfile("ip-application-1"),
    ).rejects.toMatchObject({ kind: "rate_limit_error", status: 429 });
  });

  it("classifies 409 ConflictException on DELETE as conflict_error (profile in use)", async () => {
    const provider = build({
      fetch: sequencedFetch({
        calls: [],
        onGet: () => ({ ok: true, status: 200, text: applicationProfileJson("ip-application-1") }),
        onDelete: () => ({
          ok: false,
          status: 409,
          text: JSON.stringify({
            __type: "ConflictException",
            message: "profile is in use by an active deployment",
          }),
        }),
      }),
    });
    await expect(
      provider.deleteInferenceProfile("ip-application-1"),
    ).rejects.toMatchObject({
      kind: "conflict_error",
      status: 409,
      code: "ConflictException",
    });
  });

  it("resolves void on 204 from the DELETE", async () => {
    const provider = build({
      fetch: sequencedFetch({
        calls: [],
        onGet: () => ({ ok: true, status: 200, text: applicationProfileJson("ip-application-1") }),
        onDelete: () => ({ ok: true, status: 204, text: "" }),
      }),
    });
    const result = await provider.deleteInferenceProfile("ip-application-1");
    expect(result).toBeUndefined();
  });
});

describe("BedrockProvider — createInferenceProfile (M2.X.5.aa.z.23)", () => {
  function validInput() {
    return {
      inferenceProfileName: "my-app-profile",
      modelSource: {
        copyFrom:
          "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
      },
    };
  }

  function buildSuccessFetch(capture?: FetchCapture): FetchLike {
    return buildFetch({
      capture,
      ok: true,
      status: 201,
      text: JSON.stringify({
        inferenceProfileArn:
          "arn:aws:bedrock:us-east-1:123:application-inference-profile/abc",
        status: "ACTIVE",
      }),
    });
  }

  it("POSTs control-plane /inference-profiles with the JSON body", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildSuccessFetch(capture) });
    await provider.createInferenceProfile(validInput());
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).toContain("/inference-profiles");
    expect(capture.init?.method).toBe("POST");
    expect(capture.init?.headers["content-type"]).toBe("application/json");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("includes inferenceProfileName + modelSource in the body bytes", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildSuccessFetch(capture) });
    await provider.createInferenceProfile(validInput());
    const bodyStr = new TextDecoder().decode(capture.init!.body);
    const body = JSON.parse(bodyStr) as Record<string, unknown>;
    expect(body["inferenceProfileName"]).toBe("my-app-profile");
    expect(body["modelSource"]).toEqual(validInput().modelSource);
  });

  it("returns the parsed inferenceProfileArn + status on success", async () => {
    const provider = build({ fetch: buildSuccessFetch() });
    const result = await provider.createInferenceProfile(validInput());
    expect(result.inferenceProfileArn).toContain(
      "application-inference-profile/abc",
    );
    expect(result.status).toBe("ACTIVE");
  });

  it("does not run against the runtime host", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildSuccessFetch(capture) });
    await provider.createInferenceProfile(validInput());
    expect(capture.url).not.toContain("bedrock-runtime.");
  });

  it("validates inferenceProfileName BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.createInferenceProfile({
        ...validInput(),
        inferenceProfileName: "",
      }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("validates modelSource.copyFrom BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.createInferenceProfile({
        ...validInput(),
        modelSource: { copyFrom: "" },
      }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("propagates 409 ConflictException as conflict_error (name already exists)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 409,
        text: JSON.stringify({
          __type: "ConflictException",
          message: "profile with this name already exists",
        }),
      }),
    });
    await expect(
      provider.createInferenceProfile(validInput()),
    ).rejects.toMatchObject({
      kind: "conflict_error",
      status: 409,
      code: "ConflictException",
    });
  });

  it("propagates 404 as not_found_error (copyFrom ARN doesn't exist)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no such source",
        }),
      }),
    });
    await expect(
      provider.createInferenceProfile(validInput()),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(
      provider.createInferenceProfile(validInput()),
    ).rejects.toMatchObject({ kind: "permission_error", status: 403 });
  });

  it("propagates 429 as rate_limit_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 429,
        text: JSON.stringify({
          __type: "ThrottlingException",
          message: "slow down",
        }),
      }),
    });
    await expect(
      provider.createInferenceProfile(validInput()),
    ).rejects.toMatchObject({ kind: "rate_limit_error", status: 429 });
  });

  it("threads description + clientRequestToken + tags into the body when provided", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildSuccessFetch(capture) });
    await provider.createInferenceProfile({
      ...validInput(),
      description: "for tenant A",
      clientRequestToken: "req-abc-123",
      tags: [{ key: "env", value: "prod" }],
    });
    const bodyStr = new TextDecoder().decode(capture.init!.body);
    const body = JSON.parse(bodyStr) as Record<string, unknown>;
    expect(body["description"]).toBe("for tenant A");
    expect(body["clientRequestToken"]).toBe("req-abc-123");
    expect(body["tags"]).toEqual([{ key: "env", value: "prod" }]);
  });

  it("propagates parse failures as api_error", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 201, text: "not json" }),
    });
    await expect(
      provider.createInferenceProfile(validInput()),
    ).rejects.toMatchObject({ kind: "api_error" });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(
      provider.createInferenceProfile(validInput()),
    ).rejects.toMatchObject({ kind: "network_error" });
  });
});

describe("BedrockProvider — tagResource (M2.X.5.aa.z.24)", () => {
  const VALID_ARN =
    "arn:aws:bedrock:us-east-1:123456789012:custom-model/abc123def456";

  it("POSTs to /tags with resourceARN in the query string", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "{}" }) });
    await provider.tagResource({
      resourceArn: VALID_ARN,
      tags: [{ key: "env", value: "prod" }],
    });
    expect(capture.url).toContain("/tags");
    expect(capture.url).toContain("resourceARN=");
    expect(capture.init?.method).toBe("POST");
  });

  it("includes the tags array in the body bytes", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "{}" }) });
    await provider.tagResource({
      resourceArn: VALID_ARN,
      tags: [{ key: "env", value: "prod" }],
    });
    const bodyStr = new TextDecoder().decode(capture.init!.body);
    const body = JSON.parse(bodyStr) as Record<string, unknown>;
    expect(body["tags"]).toEqual([{ key: "env", value: "prod" }]);
  });

  it("URI-encodes ARN colons in the query string", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "{}" }) });
    await provider.tagResource({
      resourceArn: VALID_ARN,
      tags: [{ key: "k", value: "v" }],
    });
    expect(capture.url).toContain("%3A");
  });

  it("does not run against the runtime host", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "{}" }) });
    await provider.tagResource({
      resourceArn: VALID_ARN,
      tags: [{ key: "k", value: "v" }],
    });
    expect(capture.url).not.toContain("bedrock-runtime.");
  });

  it("validates resourceArn BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.tagResource({ resourceArn: "", tags: [{ key: "k", value: "v" }] }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("resolves void on success", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 200, text: "{}" }),
    });
    const result = await provider.tagResource({
      resourceArn: VALID_ARN,
      tags: [{ key: "k", value: "v" }],
    });
    expect(result).toBeUndefined();
  });

  it("propagates 404 as not_found_error (resource ARN doesn't exist)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no such resource",
        }),
      }),
    });
    await expect(
      provider.tagResource({
        resourceArn: VALID_ARN,
        tags: [{ key: "k", value: "v" }],
      }),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(
      provider.tagResource({
        resourceArn: VALID_ARN,
        tags: [{ key: "k", value: "v" }],
      }),
    ).rejects.toMatchObject({ kind: "permission_error", status: 403 });
  });

  it("propagates 429 as rate_limit_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 429,
        text: JSON.stringify({
          __type: "ThrottlingException",
          message: "slow down",
        }),
      }),
    });
    await expect(
      provider.tagResource({
        resourceArn: VALID_ARN,
        tags: [{ key: "k", value: "v" }],
      }),
    ).rejects.toMatchObject({ kind: "rate_limit_error", status: 429 });
  });
});

describe("BedrockProvider — untagResource (M2.X.5.aa.z.24)", () => {
  const VALID_ARN = "arn:aws:bedrock:us-east-1:123:custom-model/abc";

  it("POSTs to /untag with resourceARN in the query string", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "{}" }) });
    await provider.untagResource({ resourceArn: VALID_ARN, tagKeys: ["env"] });
    expect(capture.url).toContain("/untag");
    expect(capture.url).toContain("resourceARN=");
    expect(capture.init?.method).toBe("POST");
  });

  it("includes the tagKeys array in the body bytes", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildFetch({ capture, text: "{}" }) });
    await provider.untagResource({
      resourceArn: VALID_ARN,
      tagKeys: ["env", "team"],
    });
    const body = JSON.parse(new TextDecoder().decode(capture.init!.body)) as Record<
      string,
      unknown
    >;
    expect(body["tagKeys"]).toEqual(["env", "team"]);
  });

  it("validates resourceArn BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.untagResource({ resourceArn: "", tagKeys: ["k"] }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("resolves void on success", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 200, text: "{}" }),
    });
    const result = await provider.untagResource({
      resourceArn: VALID_ARN,
      tagKeys: ["env"],
    });
    expect(result).toBeUndefined();
  });

  it("propagates 404 as not_found_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no",
        }),
      }),
    });
    await expect(
      provider.untagResource({ resourceArn: VALID_ARN, tagKeys: ["k"] }),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
  });
});

describe("BedrockProvider — listTagsForResource (M2.X.5.aa.z.24)", () => {
  const VALID_ARN = "arn:aws:bedrock:us-east-1:123:guardrail/abc";

  it("POSTs to /listTagsForResource with resourceARN in the BODY (not the query)", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, text: JSON.stringify({ tags: [] }) }),
    });
    await provider.listTagsForResource({ resourceArn: VALID_ARN });
    expect(capture.url).toContain("/listTagsForResource");
    expect(capture.url).not.toContain("resourceARN=");
    const body = JSON.parse(new TextDecoder().decode(capture.init!.body)) as Record<
      string,
      unknown
    >;
    expect(body["resourceARN"]).toBe(VALID_ARN);
  });

  it("returns the parsed tags array on success", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: true,
        status: 200,
        text: JSON.stringify({
          tags: [
            { key: "env", value: "prod" },
            { key: "team", value: "platform" },
          ],
        }),
      }),
    });
    const result = await provider.listTagsForResource({ resourceArn: VALID_ARN });
    expect(result.tags).toEqual([
      { key: "env", value: "prod" },
      { key: "team", value: "platform" },
    ]);
  });

  it("returns empty tags when the resource has none", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: true,
        status: 200,
        text: JSON.stringify({ tags: [] }),
      }),
    });
    const result = await provider.listTagsForResource({ resourceArn: VALID_ARN });
    expect(result.tags).toEqual([]);
  });

  it("validates resourceArn BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.listTagsForResource({ resourceArn: "" }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("propagates 404 as not_found_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no",
        }),
      }),
    });
    await expect(
      provider.listTagsForResource({ resourceArn: VALID_ARN }),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
  });

  it("propagates parse failures as api_error", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 200, text: "garbage" }),
    });
    await expect(
      provider.listTagsForResource({ resourceArn: VALID_ARN }),
    ).rejects.toMatchObject({ kind: "api_error" });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(
      provider.listTagsForResource({ resourceArn: VALID_ARN }),
    ).rejects.toMatchObject({ kind: "network_error" });
  });
});

describe("BedrockProvider — updateInferenceProfile (M2.X.5.aa.z.25)", () => {
  interface MethodCall {
    method: string;
    url: string;
    body: Uint8Array;
  }

  function applicationProfileJson(id = "ip-application-1"): string {
    return JSON.stringify({
      inferenceProfileId: id,
      inferenceProfileName: "test",
      inferenceProfileArn: `arn:aws:bedrock:us-east-1:123:application-inference-profile/${id}`,
      models: [
        { modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet" },
      ],
      status: "ACTIVE",
      type: "APPLICATION",
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-19T12:00:00.000Z",
    });
  }

  function systemProfileJson(id = "ip-system-1"): string {
    return JSON.stringify({
      inferenceProfileId: id,
      inferenceProfileName: "anthropic.claude-3-sonnet",
      inferenceProfileArn: `arn:aws:bedrock:us-east-1::inference-profile/${id}`,
      models: [
        { modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet" },
      ],
      status: "ACTIVE",
      type: "SYSTEM_DEFINED",
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-19T12:00:00.000Z",
    });
  }

  function sequencedFetch(opts: {
    calls: MethodCall[];
    onGet: () => { ok: boolean; status: number; text: string };
    onPatch?: () => { ok: boolean; status: number; text: string };
  }): FetchLike {
    return async (url, init) => {
      opts.calls.push({ method: init.method, url, body: init.body });
      const resp =
        init.method === "PATCH"
          ? (opts.onPatch ?? (() => ({ ok: true, status: 200, text: "" })))()
          : opts.onGet();
      return {
        ok: resp.ok,
        status: resp.status,
        text: async () => resp.text,
        arrayBuffer: async () => new ArrayBuffer(0),
        body: null,
      };
    };
  }

  it("pre-flights GET, then PATCHes when type === APPLICATION", async () => {
    const calls: MethodCall[] = [];
    const provider = build({
      fetch: sequencedFetch({
        calls,
        onGet: () => ({ ok: true, status: 200, text: applicationProfileJson() }),
      }),
    });
    await provider.updateInferenceProfile("ip-application-1", {
      description: "new desc",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/inference-profiles/ip-application-1");
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.url).toContain("/inference-profiles/ip-application-1");
  });

  it("threads the description into the PATCH body", async () => {
    const calls: MethodCall[] = [];
    const provider = build({
      fetch: sequencedFetch({
        calls,
        onGet: () => ({ ok: true, status: 200, text: applicationProfileJson() }),
      }),
    });
    await provider.updateInferenceProfile("ip-application-1", {
      description: "new desc",
    });
    const patchCall = calls.find((c) => c.method === "PATCH");
    const bodyStr = new TextDecoder().decode(patchCall!.body);
    const body = JSON.parse(bodyStr) as Record<string, unknown>;
    expect(body["description"]).toBe("new desc");
  });

  it("refuses to update SYSTEM_DEFINED profiles and NEVER issues PATCH", async () => {
    const calls: MethodCall[] = [];
    const provider = build({
      fetch: sequencedFetch({
        calls,
        onGet: () => ({ ok: true, status: 200, text: systemProfileJson() }),
      }),
    });
    await expect(
      provider.updateInferenceProfile("ip-system-1", { description: "new desc" }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
  });

  it("system-profile guard error message names the profile and type", async () => {
    const provider = build({
      fetch: sequencedFetch({
        calls: [],
        onGet: () => ({ ok: true, status: 200, text: systemProfileJson("ip-system-1") }),
      }),
    });
    await expect(
      provider.updateInferenceProfile("ip-system-1", { description: "x" }),
    ).rejects.toThrow(/SYSTEM_DEFINED/);
    await expect(
      provider.updateInferenceProfile("ip-system-1", { description: "x" }),
    ).rejects.toThrow(/ip-system-1/);
  });

  it("validates description BEFORE pre-flight GET (saves a round-trip)", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.updateInferenceProfile("ip-application-1", { description: "" }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("validates empty input BEFORE pre-flight (must include at least one mutable field)", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.updateInferenceProfile("ip-application-1", {}),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("validates identifier BEFORE input checks", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.updateInferenceProfile("", { description: "valid" }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("URI-encodes ARN colons on both GET and PATCH", async () => {
    const calls: MethodCall[] = [];
    const arn = "arn:aws:bedrock:us-east-1:123:application-inference-profile/abc";
    const provider = build({
      fetch: sequencedFetch({
        calls,
        onGet: () => ({ ok: true, status: 200, text: applicationProfileJson(arn) }),
      }),
    });
    await provider.updateInferenceProfile(arn, { description: "x" });
    expect(calls[0]?.url).toContain("%3A");
    expect(calls[1]?.url).toContain("%3A");
  });

  it("does not run against the runtime host", async () => {
    const calls: MethodCall[] = [];
    const provider = build({
      fetch: sequencedFetch({
        calls,
        onGet: () => ({ ok: true, status: 200, text: applicationProfileJson() }),
      }),
    });
    await provider.updateInferenceProfile("ip-application-1", {
      description: "new",
    });
    for (const call of calls) {
      expect(call.url).not.toContain("bedrock-runtime.");
    }
  });

  it("propagates 404 from the pre-flight GET (profile doesn't exist)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no such profile",
        }),
      }),
    });
    await expect(
      provider.updateInferenceProfile("ip-missing", { description: "x" }),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
  });

  it("propagates 404 from the PATCH (race: profile deleted between GET and PATCH)", async () => {
    const calls: MethodCall[] = [];
    const provider = build({
      fetch: sequencedFetch({
        calls,
        onGet: () => ({ ok: true, status: 200, text: applicationProfileJson() }),
        onPatch: () => ({
          ok: false,
          status: 404,
          text: JSON.stringify({
            __type: "ResourceNotFoundException",
            message: "deleted already",
          }),
        }),
      }),
    });
    await expect(
      provider.updateInferenceProfile("ip-application-1", { description: "x" }),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
    expect(calls).toHaveLength(2);
  });

  it("propagates 403 from the PATCH (have GET but not UpdateInferenceProfile permission)", async () => {
    const provider = build({
      fetch: sequencedFetch({
        calls: [],
        onGet: () => ({ ok: true, status: 200, text: applicationProfileJson() }),
        onPatch: () => ({
          ok: false,
          status: 403,
          text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
        }),
      }),
    });
    await expect(
      provider.updateInferenceProfile("ip-application-1", { description: "x" }),
    ).rejects.toMatchObject({ kind: "permission_error", status: 403 });
  });

  it("propagates 429 from the PATCH", async () => {
    const provider = build({
      fetch: sequencedFetch({
        calls: [],
        onGet: () => ({ ok: true, status: 200, text: applicationProfileJson() }),
        onPatch: () => ({
          ok: false,
          status: 429,
          text: JSON.stringify({
            __type: "ThrottlingException",
            message: "slow down",
          }),
        }),
      }),
    });
    await expect(
      provider.updateInferenceProfile("ip-application-1", { description: "x" }),
    ).rejects.toMatchObject({ kind: "rate_limit_error", status: 429 });
  });

  it("resolves void on 200 from the PATCH", async () => {
    const provider = build({
      fetch: sequencedFetch({
        calls: [],
        onGet: () => ({ ok: true, status: 200, text: applicationProfileJson() }),
        onPatch: () => ({ ok: true, status: 200, text: "" }),
      }),
    });
    const result = await provider.updateInferenceProfile("ip-application-1", {
      description: "new",
    });
    expect(result).toBeUndefined();
  });

  it("PATCH request has content-type application/json header", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const calls: MethodCall[] = [];
    const provider = build({
      fetch: async (url, init) => {
        calls.push({ method: init.method, url, body: init.body });
        if (init.method === "PATCH") {
          capture.url = url;
          capture.init = init;
        }
        const body =
          init.method === "PATCH"
            ? { ok: true, status: 200, text: "" }
            : { ok: true, status: 200, text: applicationProfileJson() };
        return {
          ok: body.ok,
          status: body.status,
          text: async () => body.text,
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await provider.updateInferenceProfile("ip-application-1", {
      description: "x",
    });
    expect(capture.init?.headers["content-type"]).toBe("application/json");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });
});

describe("BedrockProvider — getProvisionedModelThroughput (M2.X.5.aa.z.26)", () => {
  function detailJson(
    overrides: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      provisionedModelName: "tenant-a-pt",
      provisionedModelArn: "arn:aws:bedrock:us-east-1:123:provisioned-model/abc",
      modelArn: "arn:aws:bedrock:us-east-1::foundation-model/x",
      desiredModelArn: "arn:aws:bedrock:us-east-1::foundation-model/x",
      foundationModelArn: "arn:aws:bedrock:us-east-1::foundation-model/x",
      modelUnits: 1,
      desiredModelUnits: 1,
      status: "InService",
      creationTime: "2026-05-19T12:00:00.000Z",
      lastModifiedTime: "2026-05-19T12:00:00.000Z",
      ...overrides,
    });
  }

  it("GETs the control-plane /provisioned-model-throughputs/{id}", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, ok: true, status: 200, text: detailJson() }),
    });
    await provider.getProvisionedModelThroughput("abc");
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).toContain("/provisioned-model-throughputs/abc");
    expect(capture.init?.method).toBe("GET");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("URI-encodes ARN colons", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, ok: true, status: 200, text: detailJson() }),
    });
    await provider.getProvisionedModelThroughput(
      "arn:aws:bedrock:us-east-1:123:provisioned-model/abc",
    );
    expect(capture.url).toContain("%3A");
  });

  it("does not run against the runtime host", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, ok: true, status: 200, text: detailJson() }),
    });
    await provider.getProvisionedModelThroughput("abc");
    expect(capture.url).not.toContain("bedrock-runtime.");
  });

  it("validates identifier BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.getProvisionedModelThroughput(""),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("returns the parsed detail on success", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 200, text: detailJson() }),
    });
    const detail = await provider.getProvisionedModelThroughput("abc");
    expect(detail.provisionedModelName).toBe("tenant-a-pt");
    expect(detail.status).toBe("InService");
    expect(detail.modelUnits).toBe(1);
  });

  it("threads commitmentDuration when present on a committed PT", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: true,
        status: 200,
        text: detailJson({
          commitmentDuration: "OneMonth",
          commitmentExpirationTime: "2026-06-19T12:00:00.000Z",
        }),
      }),
    });
    const detail = await provider.getProvisionedModelThroughput("abc");
    expect(detail.commitmentDuration).toBe("OneMonth");
    expect(detail.commitmentExpirationTime).toBe("2026-06-19T12:00:00.000Z");
  });

  it("threads failureMessage when status is Failed", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: true,
        status: 200,
        text: detailJson({
          status: "Failed",
          failureMessage: "insufficient capacity",
        }),
      }),
    });
    const detail = await provider.getProvisionedModelThroughput("abc");
    expect(detail.status).toBe("Failed");
    expect(detail.failureMessage).toBe("insufficient capacity");
  });

  it("propagates 404 as not_found_error (PT doesn't exist)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no",
        }),
      }),
    });
    await expect(
      provider.getProvisionedModelThroughput("abc"),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({
          __type: "AccessDeniedException",
          message: "no",
        }),
      }),
    });
    await expect(
      provider.getProvisionedModelThroughput("abc"),
    ).rejects.toMatchObject({ kind: "permission_error", status: 403 });
  });

  it("propagates parse failures as api_error", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 200, text: "garbage" }),
    });
    await expect(
      provider.getProvisionedModelThroughput("abc"),
    ).rejects.toMatchObject({ kind: "api_error" });
  });
});

describe("BedrockProvider — listProvisionedModelThroughputs (M2.X.5.aa.z.26)", () => {
  function listJson(
    overrides: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      provisionedModelSummaries: [
        {
          provisionedModelName: "pt-1",
          provisionedModelArn: "arn:aws:bedrock:us-east-1:123:provisioned-model/1",
          modelArn: "arn:aws:bedrock:us-east-1::foundation-model/x",
          desiredModelArn: "arn:aws:bedrock:us-east-1::foundation-model/x",
          foundationModelArn: "arn:aws:bedrock:us-east-1::foundation-model/x",
          modelUnits: 2,
          desiredModelUnits: 2,
          status: "InService",
          creationTime: "2026-05-19T12:00:00.000Z",
          lastModifiedTime: "2026-05-19T12:00:00.000Z",
        },
      ],
      ...overrides,
    });
  }

  it("GETs the control-plane /provisioned-model-throughputs", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, ok: true, status: 200, text: listJson() }),
    });
    await provider.listProvisionedModelThroughputs();
    expect(capture.url).toContain("/provisioned-model-throughputs");
    expect(capture.init?.method).toBe("GET");
  });

  it("threads statusEquals filter through to the query", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, ok: true, status: 200, text: listJson() }),
    });
    await provider.listProvisionedModelThroughputs({ statusEquals: "InService" });
    expect(capture.url).toContain("statusEquals=InService");
  });

  it("threads modelArnEquals filter through (URI-encoded)", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, ok: true, status: 200, text: listJson() }),
    });
    await provider.listProvisionedModelThroughputs({
      modelArnEquals:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet",
    });
    expect(capture.url).toContain("modelArnEquals=arn%3Aaws%3Abedrock");
  });

  it("threads maxResults + sortBy + sortOrder + nextToken", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, ok: true, status: 200, text: listJson() }),
    });
    await provider.listProvisionedModelThroughputs({
      maxResults: 50,
      sortBy: "CreationTime",
      sortOrder: "Descending",
      nextToken: "page2",
    });
    expect(capture.url).toContain("maxResults=50");
    expect(capture.url).toContain("sortBy=CreationTime");
    expect(capture.url).toContain("sortOrder=Descending");
    expect(capture.url).toContain("nextToken=page2");
  });

  it("returns the parsed list response", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 200, text: listJson() }),
    });
    const result = await provider.listProvisionedModelThroughputs();
    expect(result.provisionedModelSummaries).toHaveLength(1);
    expect(result.provisionedModelSummaries[0]?.provisionedModelName).toBe(
      "pt-1",
    );
  });

  it("threads nextToken back when present", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: true,
        status: 200,
        text: listJson({ nextToken: "page2" }),
      }),
    });
    const result = await provider.listProvisionedModelThroughputs();
    expect(result.nextToken).toBe("page2");
  });

  it("validates BEFORE fetch (bad maxResults)", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.listProvisionedModelThroughputs({ maxResults: 0 }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({
          __type: "AccessDeniedException",
          message: "no",
        }),
      }),
    });
    await expect(
      provider.listProvisionedModelThroughputs(),
    ).rejects.toMatchObject({ kind: "permission_error", status: 403 });
  });

  it("propagates 429 as rate_limit_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 429,
        text: JSON.stringify({
          __type: "ThrottlingException",
          message: "slow down",
        }),
      }),
    });
    await expect(
      provider.listProvisionedModelThroughputs(),
    ).rejects.toMatchObject({ kind: "rate_limit_error", status: 429 });
  });

  it("propagates parse failures as api_error", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 200, text: "garbage" }),
    });
    await expect(
      provider.listProvisionedModelThroughputs(),
    ).rejects.toMatchObject({ kind: "api_error" });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(
      provider.listProvisionedModelThroughputs(),
    ).rejects.toMatchObject({ kind: "network_error" });
  });
});

describe("BedrockProvider — createProvisionedModelThroughput (M2.X.5.aa.z.27)", () => {
  function validInput() {
    return {
      clientRequestToken: "req-abc-123",
      modelUnits: 1,
      provisionedModelName: "tenant-a-pt",
      modelId:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
    };
  }

  function buildSuccessFetch(capture?: FetchCapture): FetchLike {
    return buildFetch({
      capture,
      ok: true,
      status: 200,
      text: JSON.stringify({
        provisionedModelArn:
          "arn:aws:bedrock:us-east-1:123:provisioned-model/abc",
      }),
    });
  }

  it("POSTs control-plane /provisioned-model-throughput with the JSON body", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildSuccessFetch(capture) });
    await provider.createProvisionedModelThroughput(validInput());
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).toContain("/provisioned-model-throughput");
    expect(capture.init?.method).toBe("POST");
    expect(capture.init?.headers["content-type"]).toBe("application/json");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("includes clientRequestToken + modelUnits + name + modelId in the body bytes", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildSuccessFetch(capture) });
    await provider.createProvisionedModelThroughput(validInput());
    const bodyStr = new TextDecoder().decode(capture.init!.body);
    const body = JSON.parse(bodyStr) as Record<string, unknown>;
    expect(body["clientRequestToken"]).toBe("req-abc-123");
    expect(body["modelUnits"]).toBe(1);
    expect(body["provisionedModelName"]).toBe("tenant-a-pt");
    expect(body["modelId"]).toContain("claude-3-sonnet");
  });

  it("returns the parsed provisionedModelArn on success", async () => {
    const provider = build({ fetch: buildSuccessFetch() });
    const result = await provider.createProvisionedModelThroughput(validInput());
    expect(result.provisionedModelArn).toContain("provisioned-model/abc");
  });

  it("does not run against the runtime host", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildSuccessFetch(capture) });
    await provider.createProvisionedModelThroughput(validInput());
    expect(capture.url).not.toContain("bedrock-runtime.");
  });

  it("validates clientRequestToken BEFORE fetch (mandatory for cost-safety)", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.createProvisionedModelThroughput({
        ...validInput(),
        clientRequestToken: "",
      }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("validates modelUnits BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.createProvisionedModelThroughput({
        ...validInput(),
        modelUnits: 0,
      }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("threads commitmentDuration into the body when provided", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildSuccessFetch(capture) });
    await provider.createProvisionedModelThroughput({
      ...validInput(),
      commitmentDuration: "SixMonths",
    });
    const body = JSON.parse(new TextDecoder().decode(capture.init!.body)) as Record<
      string,
      unknown
    >;
    expect(body["commitmentDuration"]).toBe("SixMonths");
  });

  it("threads tags into the body when provided", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({ fetch: buildSuccessFetch(capture) });
    await provider.createProvisionedModelThroughput({
      ...validInput(),
      tags: [
        { key: "tenant", value: "a" },
        { key: "env", value: "prod" },
      ],
    });
    const body = JSON.parse(new TextDecoder().decode(capture.init!.body)) as Record<
      string,
      unknown
    >;
    expect(body["tags"]).toEqual([
      { key: "tenant", value: "a" },
      { key: "env", value: "prod" },
    ]);
  });

  it("propagates 409 ConflictException as conflict_error (name already exists)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 409,
        text: JSON.stringify({
          __type: "ConflictException",
          message: "PT with this name already exists",
        }),
      }),
    });
    await expect(
      provider.createProvisionedModelThroughput(validInput()),
    ).rejects.toMatchObject({
      kind: "conflict_error",
      status: 409,
      code: "ConflictException",
    });
  });

  it("propagates 404 as not_found_error (modelId doesn't exist)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no such model",
        }),
      }),
    });
    await expect(
      provider.createProvisionedModelThroughput(validInput()),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(
      provider.createProvisionedModelThroughput(validInput()),
    ).rejects.toMatchObject({ kind: "permission_error", status: 403 });
  });

  it("propagates 429 as rate_limit_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 429,
        text: JSON.stringify({
          __type: "ThrottlingException",
          message: "slow down",
        }),
      }),
    });
    await expect(
      provider.createProvisionedModelThroughput(validInput()),
    ).rejects.toMatchObject({ kind: "rate_limit_error", status: 429 });
  });

  it("propagates 402 ServiceQuotaExceeded as quota-style error (over PT capacity)", async () => {
    // AWS surfaces capacity issues as 402 ServiceQuotaExceededException
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 402,
        text: JSON.stringify({
          __type: "ServiceQuotaExceededException",
          message: "PT quota exceeded",
        }),
      }),
    });
    await expect(
      provider.createProvisionedModelThroughput(validInput()),
    ).rejects.toBeDefined();
  });

  it("propagates parse failures as api_error", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 200, text: "not json" }),
    });
    await expect(
      provider.createProvisionedModelThroughput(validInput()),
    ).rejects.toMatchObject({ kind: "api_error" });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(
      provider.createProvisionedModelThroughput(validInput()),
    ).rejects.toMatchObject({ kind: "network_error" });
  });

  it("idempotent retry with same token: substrate makes the API call (AWS handles dedup server-side)", async () => {
    // Substrate doesn't dedupe locally — AWS guarantees idempotency via clientRequestToken.
    // Repeated calls with the same token go through to AWS each time; AWS returns the same ARN.
    let calls = 0;
    const provider = build({
      fetch: async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              provisionedModelArn:
                "arn:aws:bedrock:us-east-1:123:provisioned-model/same-arn",
            }),
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    const r1 = await provider.createProvisionedModelThroughput(validInput());
    const r2 = await provider.createProvisionedModelThroughput(validInput());
    expect(r1.provisionedModelArn).toBe(r2.provisionedModelArn);
    expect(calls).toBe(2);
  });
});

describe("BedrockProvider — updateProvisionedModelThroughput (M2.X.5.aa.z.28)", () => {
  function validInput() {
    return {
      desiredProvisionedModelName: "tenant-a-pt-renamed",
    };
  }

  it("PATCHes control-plane /provisioned-model-throughput/{id}", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, ok: true, status: 200, text: "" }),
    });
    await provider.updateProvisionedModelThroughput("pt-abc", validInput());
    expect(capture.url).toContain("bedrock.us-east-1.amazonaws.com");
    expect(capture.url).toContain("/provisioned-model-throughput/pt-abc");
    expect(capture.init?.method).toBe("PATCH");
    expect(capture.init?.headers["content-type"]).toBe("application/json");
    expect(capture.init?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("URI-encodes ARN colons in the path", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, ok: true, status: 200, text: "" }),
    });
    await provider.updateProvisionedModelThroughput(
      "arn:aws:bedrock:us-east-1:123:provisioned-model/abc",
      validInput(),
    );
    expect(capture.url).toContain("%3A");
  });

  it("includes desiredProvisionedModelName in the PATCH body", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, ok: true, status: 200, text: "" }),
    });
    await provider.updateProvisionedModelThroughput("pt-abc", {
      desiredProvisionedModelName: "tenant-a-pt-renamed",
    });
    const body = JSON.parse(new TextDecoder().decode(capture.init!.body)) as Record<
      string,
      unknown
    >;
    expect(body["desiredProvisionedModelName"]).toBe("tenant-a-pt-renamed");
  });

  it("includes desiredModelId for model migration", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, ok: true, status: 200, text: "" }),
    });
    await provider.updateProvisionedModelThroughput("pt-abc", {
      desiredModelId:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0",
    });
    const body = JSON.parse(new TextDecoder().decode(capture.init!.body)) as Record<
      string,
      unknown
    >;
    expect(body["desiredModelId"]).toContain("claude-3-haiku");
  });

  it("does not run against the runtime host", async () => {
    const capture: FetchCapture = { url: null, init: null };
    const provider = build({
      fetch: buildFetch({ capture, ok: true, status: 200, text: "" }),
    });
    await provider.updateProvisionedModelThroughput("pt-abc", validInput());
    expect(capture.url).not.toContain("bedrock-runtime.");
  });

  it("validates identifier BEFORE body builder", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.updateProvisionedModelThroughput("", validInput()),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("validates input (empty body) BEFORE fetch", async () => {
    let called = 0;
    const provider = build({
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      provider.updateProvisionedModelThroughput("pt-abc", {}),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("resolves void on 200 success", async () => {
    const provider = build({
      fetch: buildFetch({ ok: true, status: 200, text: "" }),
    });
    const result = await provider.updateProvisionedModelThroughput(
      "pt-abc",
      validInput(),
    );
    expect(result).toBeUndefined();
  });

  it("propagates 404 as not_found_error (PT doesn't exist)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 404,
        text: JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no",
        }),
      }),
    });
    await expect(
      provider.updateProvisionedModelThroughput("pt-abc", validInput()),
    ).rejects.toMatchObject({ kind: "not_found_error", status: 404 });
  });

  it("propagates 409 ConflictException as conflict_error (e.g., new name already exists)", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 409,
        text: JSON.stringify({
          __type: "ConflictException",
          message: "name already exists",
        }),
      }),
    });
    await expect(
      provider.updateProvisionedModelThroughput("pt-abc", validInput()),
    ).rejects.toMatchObject({
      kind: "conflict_error",
      status: 409,
      code: "ConflictException",
    });
  });

  it("propagates 403 as permission_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 403,
        text: JSON.stringify({ __type: "AccessDeniedException", message: "no" }),
      }),
    });
    await expect(
      provider.updateProvisionedModelThroughput("pt-abc", validInput()),
    ).rejects.toMatchObject({ kind: "permission_error", status: 403 });
  });

  it("propagates 429 as rate_limit_error", async () => {
    const provider = build({
      fetch: buildFetch({
        ok: false,
        status: 429,
        text: JSON.stringify({
          __type: "ThrottlingException",
          message: "slow down",
        }),
      }),
    });
    await expect(
      provider.updateProvisionedModelThroughput("pt-abc", validInput()),
    ).rejects.toMatchObject({ kind: "rate_limit_error", status: 429 });
  });

  it("propagates network errors", async () => {
    const provider = build({
      fetch: buildFetch({ throwError: new Error("ECONNRESET") }),
    });
    await expect(
      provider.updateProvisionedModelThroughput("pt-abc", validInput()),
    ).rejects.toMatchObject({ kind: "network_error" });
  });
});

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}
