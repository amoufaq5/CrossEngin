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

  it("propagates 409 ConflictException via .code field (idempotency token reuse)", async () => {
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

  it("surfaces 409 ConflictException with the code field for terminal-state stops", async () => {
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

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}
