import { hkdfSync } from "node:crypto";

import {
  MalformedTenantPseudonym,
  type CompletionChunk,
  type CompletionRequest,
} from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import { buildOpenAiRequest, type OpenAiEndUserBody } from "./chat-api.js";
import {
  OPENAI_API_BASE_URL,
  OpenAiProvider,
  isCustomOpenAiBaseUrl,
  openAiEndUserField,
  type FetchLike,
} from "./provider.js";

// Mirrors `deriveAiTenantPseudonym` (ADR-0456) without depending on @crossengin/crypto; the
// agreement between the two spellings is asserted in apps/operate-server, which depends on both.
// These tests cover carriage and refusal only: a provider copies the field, so stability and
// distinctness are properties of the derivation (packages/crypto) and are tested there and end to
// end in apps/operate-server — asserting them here would only re-test this helper.
const SECRET = "test-deployment-secret-0123456789abcdef";
function pseudonymFor(tenantId: string): string {
  return `ctp_${Buffer.from(hkdfSync("sha256", SECRET, tenantId, "crossengin.ai-tenant-pseudonym.v1", 16)).toString("hex")}`;
}

const TENANT_A = "0196f2a8-7c3b-7d4e-9a1b-2c3d4e5f6a7b";

function request(tenantId: string, withPseudonym: boolean): CompletionRequest {
  return {
    task: "planner",
    messages: [{ role: "user", content: "hi" }],
    tenantId,
    sessionId: "sess_1",
    ...(withPseudonym ? { tenantPseudonym: pseudonymFor(tenantId) } : {}),
  };
}

const STREAM =
  'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
  "data: [DONE]\n\n";
const EMBEDDINGS = JSON.stringify({
  data: [{ index: 0, embedding: [0.1, 0.2] }],
  model: "text-embedding-3-small",
  usage: { prompt_tokens: 1, total_tokens: 1 },
});

function capturing(bodies: string[], baseUrl?: string): OpenAiProvider {
  const fetch: FetchLike = async (url, init) => {
    bodies.push(init.body);
    const payload = url.endsWith("/embeddings") ? EMBEDDINGS : STREAM;
    const bytes = new TextEncoder().encode(payload);
    return {
      ok: true,
      status: 200,
      text: async () => payload,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    };
  };
  return new OpenAiProvider({
    apiKey: "sk-test",
    defaultModel: "gpt-4o",
    fetch,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });
}

const CUSTOM = "http://vllm:8000";

async function drain(stream: AsyncIterable<CompletionChunk>): Promise<void> {
  for await (const _ of stream) void _;
}

function userOf(body: string): unknown {
  return (JSON.parse(body) as { user?: unknown }).user;
}
function safetyIdOf(body: string): unknown {
  return (JSON.parse(body) as { safety_identifier?: unknown }).safety_identifier;
}

describe("openAiEndUserField: one predicate decides which field carries the pseudonym (ADR-0461)", () => {
  it.each([
    ["the default base URL", OPENAI_API_BASE_URL],
    ["the default with a trailing slash and other case", "HTTPS://API.OPENAI.COM/"],
  ])("answers safety_identifier for chat on %s", (_l, base) => {
    expect(openAiEndUserField(base, "chat")).toBe("safety_identifier");
  });

  it.each([
    ["a self-hosted server", "http://vllm:8000"],
    ["a gateway", "https://openrouter.ai/api"],
    ["an Ollama box", "http://ollama:11434"],
  ])("answers user for chat on %s, the field OpenAI-compatible servers know", (_l, base) => {
    expect(openAiEndUserField(base, "chat")).toBe("user");
  });

  it.each([OPENAI_API_BASE_URL, "http://vllm:8000"])(
    "answers user for embeddings on %s, where safety_identifier is not documented",
    (base) => {
      expect(openAiEndUserField(base, "embeddings")).toBe("user");
    },
  );

  it("is what the provider reports and what its builder is handed", () => {
    expect(capturing([]).endUserField).toBe("safety_identifier");
    expect(capturing([], CUSTOM).endUserField).toBe("user");
  });

  it("puts the value under exactly one of the two keys", () => {
    for (const field of ["safety_identifier", "user"] as const) {
      const built = buildOpenAiRequest(request(TENANT_A, true), { defaultModel: "m", endUserField: field });
      const other = field === "user" ? "safety_identifier" : "user";
      expect(built[field]).toBe(pseudonymFor(TENANT_A));
      expect(built).not.toHaveProperty(other);
    }
  });
});

describe("api.openai.com: chat carries safety_identifier, never user (ADR-0461)", () => {
  it("is present on a chat request, and is the pseudonym rather than the tenant id", async () => {
    const bodies: string[] = [];
    await drain(capturing(bodies).complete(request(TENANT_A, true)));
    expect(safetyIdOf(bodies[0]!)).toBe(pseudonymFor(TENANT_A));
    expect(safetyIdOf(bodies[0]!)).toMatch(/^ctp_[0-9a-f]{32}$/);
    expect(JSON.parse(bodies[0]!)).not.toHaveProperty("user");
    expect(bodies[0]).not.toContain(TENANT_A);
    expect(bodies[0]).not.toContain(TENANT_A.replaceAll("-", ""));
  });

  it("uses the same field on the non-streaming path", async () => {
    const bodies: string[] = [];
    const p = new OpenAiProvider({
      apiKey: "sk-test",
      defaultModel: "gpt-4o",
      fetch: async (_url, init) => {
        bodies.push(init.body);
        return { ok: true, status: 200, text: async () => "{\"choices\":[]}", body: null };
      },
    });
    await p.completeNonStreaming(request(TENANT_A, true));
    expect(safetyIdOf(bodies[0]!)).toBe(pseudonymFor(TENANT_A));
    expect(JSON.parse(bodies[0]!)).not.toHaveProperty("user");
  });
});

describe("a custom base URL: chat carries user, never safety_identifier (ADR-0461)", () => {
  it("is the pseudonym under user", async () => {
    const bodies: string[] = [];
    await drain(capturing(bodies, CUSTOM).complete(request(TENANT_A, true)));
    expect(userOf(bodies[0]!)).toBe(pseudonymFor(TENANT_A));
    expect(JSON.parse(bodies[0]!)).not.toHaveProperty("safety_identifier");
    expect(bodies[0]).not.toContain(TENANT_A);
  });
});

describe("the tenant pseudonym's carriage and refusal (ADR-0456)", () => {
  it("is present on an embedding request too, under user on api.openai.com", async () => {
    const bodies: string[] = [];
    await capturing(bodies).embed({ texts: ["a"], tenantId: TENANT_A, tenantPseudonym: pseudonymFor(TENANT_A) });
    expect(userOf(bodies[0]!)).toBe(pseudonymFor(TENANT_A));
    expect(bodies[0]).not.toContain(TENANT_A);
  });

  it("refuses the request's own tenant id with its hyphens removed, which the pattern admits", async () => {
    const bodies: string[] = [];
    const p = capturing(bodies);
    const smuggled = `ctp_${TENANT_A.replaceAll("-", "")}`;
    await expect(
      drain(p.complete({ ...request(TENANT_A, false), tenantPseudonym: smuggled })),
    ).rejects.toBeInstanceOf(MalformedTenantPseudonym);
    await expect(
      p.embed({ texts: ["a"], tenantId: TENANT_A, tenantPseudonym: smuggled }),
    ).rejects.toBeInstanceOf(MalformedTenantPseudonym);
    expect(bodies).toHaveLength(0);
  });

  it("sends no user field, and no tenant id, when no pseudonym is configured", async () => {
    const bodies: string[] = [];
    const p = capturing(bodies);
    await drain(p.complete(request(TENANT_A, false)));
    await p.embed({ texts: ["a"], tenantId: TENANT_A });
    for (const b of bodies) {
      expect(JSON.parse(b)).not.toHaveProperty("user");
      expect(JSON.parse(b)).not.toHaveProperty("safety_identifier");
      expect(b).not.toContain(TENANT_A);
    }
  });

  it("refuses to build a request whose pseudonym is the raw tenant id", () => {
    expect(() =>
      buildOpenAiRequest(
        { ...request(TENANT_A, false), tenantPseudonym: TENANT_A },
        { defaultModel: "m", endUserField: "safety_identifier" },
      ),
    ).toThrow(MalformedTenantPseudonym);
  });

  it("refuses at the provider before any byte is sent", async () => {
    const bodies: string[] = [];
    const p = capturing(bodies);
    await expect(
      drain(p.complete({ ...request(TENANT_A, false), tenantPseudonym: TENANT_A })),
    ).rejects.toBeInstanceOf(MalformedTenantPseudonym);
    await expect(
      p.embed({ texts: ["a"], tenantId: TENANT_A, tenantPseudonym: TENANT_A }),
    ).rejects.toBeInstanceOf(MalformedTenantPseudonym);
    expect(bodies).toHaveLength(0);
  });
});

describe("OpenAiEndUserBody: at most one key, by type (ADR-0461)", () => {
  it("refuses a body carrying both keys at compile time", () => {
    // @ts-expect-error — a body with both keys is not an OpenAiEndUserBody.
    const both: OpenAiEndUserBody = { user: "ctp_a", safety_identifier: "ctp_a" };
    expect(Object.keys(both)).toHaveLength(2);
    const one: OpenAiEndUserBody = { safety_identifier: "ctp_a" };
    const none: OpenAiEndUserBody = {};
    expect([one, none]).toHaveLength(2);
  });
});

describe("isCustomOpenAiBaseUrl: OpenAI's own hosts against everything else (ADR-0461)", () => {
  it.each([
    "https://api.openai.com",
    "https://api.openai.com/",
    "HTTPS://API.OPENAI.COM/",
    "https://api.openai.com:443",
    "https://eu.api.openai.com",
  ])("%s is OpenAI's own API, so chat sends safety_identifier", (base) => {
    expect(isCustomOpenAiBaseUrl(base)).toBe(false);
    expect(openAiEndUserField(base, "chat")).toBe("safety_identifier");
  });

  it.each([
    "http://api.openai.com",
    "https://api.openai.com:8443",
    "https://api.openai.com/v2-proxy",
    "https://api.openai.com.evil.example",
    "https://notapi.openai.com",
    "https://user:pw@api.openai.com",
    "http://vllm:8000",
    "not a url",
  ])("%s is custom, so chat sends user", (base) => {
    expect(isCustomOpenAiBaseUrl(base)).toBe(true);
    expect(openAiEndUserField(base, "chat")).toBe("user");
  });

  it("is what the provider reports as its endpoint class", () => {
    expect(capturing([]).isCustomEndpoint).toBe(false);
    expect(capturing([], "https://eu.api.openai.com").isCustomEndpoint).toBe(false);
    expect(capturing([], CUSTOM).isCustomEndpoint).toBe(true);
  });
});
