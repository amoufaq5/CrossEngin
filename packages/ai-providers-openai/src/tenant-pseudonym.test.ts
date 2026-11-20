import { hkdfSync } from "node:crypto";

import {
  MalformedTenantPseudonym,
  type CompletionChunk,
  type CompletionRequest,
} from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import { buildOpenAiRequest } from "./chat-api.js";
import { OpenAiProvider, type FetchLike } from "./provider.js";

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

function capturing(bodies: string[]): OpenAiProvider {
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
  return new OpenAiProvider({ apiKey: "sk-test", defaultModel: "gpt-4o", fetch });
}

async function drain(stream: AsyncIterable<CompletionChunk>): Promise<void> {
  for await (const _ of stream) void _;
}

function userOf(body: string): unknown {
  return (JSON.parse(body) as { user?: unknown }).user;
}

describe("the OpenAI-compatible user field carries the tenant pseudonym (ADR-0456)", () => {
  it("is present on a chat request, and is the pseudonym rather than the tenant id", async () => {
    const bodies: string[] = [];
    await drain(capturing(bodies).complete(request(TENANT_A, true)));
    expect(userOf(bodies[0]!)).toBe(pseudonymFor(TENANT_A));
    expect(userOf(bodies[0]!)).toMatch(/^ctp_[0-9a-f]{32}$/);
    expect(bodies[0]).not.toContain(TENANT_A);
    expect(bodies[0]).not.toContain(TENANT_A.replaceAll("-", ""));
  });

  it("is present on an embedding request too", async () => {
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
      expect(b).not.toContain(TENANT_A);
    }
  });

  it("refuses to build a request whose pseudonym is the raw tenant id", () => {
    expect(() =>
      buildOpenAiRequest({ ...request(TENANT_A, false), tenantPseudonym: TENANT_A }, { defaultModel: "m" }),
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
