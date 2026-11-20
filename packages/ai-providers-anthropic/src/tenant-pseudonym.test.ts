import { hkdfSync } from "node:crypto";

import {
  MalformedTenantPseudonym,
  type CompletionChunk,
  type CompletionRequest,
} from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import { buildAnthropicRequest } from "./messages-api.js";
import { AnthropicProvider, type FetchLike } from "./provider.js";

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

const STREAM = [
  "event: message_start",
  'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");

function capturingProvider(bodies: string[]): AnthropicProvider {
  const fetch: FetchLike = async (_url, init) => {
    bodies.push(init.body);
    const bytes = new TextEncoder().encode(STREAM);
    return {
      ok: true,
      status: 200,
      text: async () => STREAM,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    };
  };
  return new AnthropicProvider({ apiKey: "sk-ant-test", defaultModel: "claude-sonnet-4-6", fetch });
}

async function drain(stream: AsyncIterable<CompletionChunk>): Promise<void> {
  for await (const _ of stream) void _;
}

describe("Anthropic metadata.user_id carries the tenant pseudonym (ADR-0456)", () => {
  it("is present on the wire, and is the pseudonym rather than the tenant id", async () => {
    const bodies: string[] = [];
    await drain(capturingProvider(bodies).complete(request(TENANT_A, true)));
    const body = JSON.parse(bodies[0]!) as { metadata?: { user_id?: string } };
    expect(body.metadata?.user_id).toBe(pseudonymFor(TENANT_A));
    expect(body.metadata?.user_id).toMatch(/^ctp_[0-9a-f]{32}$/);
    expect(bodies[0]).not.toContain(TENANT_A);
    expect(bodies[0]).not.toContain(TENANT_A.replaceAll("-", ""));
  });

  it("refuses the request's own tenant id with its hyphens removed, which the pattern admits", async () => {
    const bodies: string[] = [];
    const smuggled = `ctp_${TENANT_A.replaceAll("-", "")}`;
    await expect(
      drain(capturingProvider(bodies).complete({ ...request(TENANT_A, false), tenantPseudonym: smuggled })),
    ).rejects.toBeInstanceOf(MalformedTenantPseudonym);
    expect(bodies).toHaveLength(0);
  });

  it("sends no metadata at all, and no tenant id, when no pseudonym is configured", async () => {
    const bodies: string[] = [];
    await drain(capturingProvider(bodies).complete(request(TENANT_A, false)));
    expect(JSON.parse(bodies[0]!)).not.toHaveProperty("metadata");
    expect(bodies[0]).not.toContain(TENANT_A);
  });

  it("refuses to build a request whose pseudonym is the raw tenant id", () => {
    expect(() =>
      buildAnthropicRequest(
        { ...request(TENANT_A, false), tenantPseudonym: TENANT_A },
        { defaultModel: "claude-sonnet-4-6" },
      ),
    ).toThrow(MalformedTenantPseudonym);
  });

  it("refuses at the provider before any byte is sent", async () => {
    const bodies: string[] = [];
    await expect(
      drain(capturingProvider(bodies).complete({ ...request(TENANT_A, false), tenantPseudonym: TENANT_A })),
    ).rejects.toBeInstanceOf(MalformedTenantPseudonym);
    expect(bodies).toHaveLength(0);
  });
});
