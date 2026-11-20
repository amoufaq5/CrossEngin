import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { TenantPseudonymSchema, type CompletionChunk, type CompletionRequest } from "@crossengin/ai-providers";
import { AnthropicProvider, type FetchLike as AnthropicFetch } from "@crossengin/ai-providers-anthropic";
import { LocalLlmProvider, type FetchLike as LocalFetch } from "@crossengin/ai-providers-local";
import { OpenAiProvider, type FetchLike as OpenAiFetch } from "@crossengin/ai-providers-openai";
import { AI_TENANT_PSEUDONYM_PREFIX } from "@crossengin/crypto";
import { stripComments } from "@crossengin/testing/strategy";
import { describe, expect, it } from "vitest";

import { buildDesignDesigner, buildDesignProviderFromEnv, type DesignCompletionProvider } from "./ai-design.js";
import {
  AI_TENANT_PSEUDONYM_SECRET_VAR,
  formatAiTenantPseudonym,
  resolveAiTenantPseudonymSource,
  tenantPseudonymForOf,
} from "./ai-tenant-pseudonym.js";

const SECRET = "ai-pseudonym-test-secret-0123456789abcdefXYZ";
const TENANT_A = "0196f2a8-7c3b-7d4e-9a1b-2c3d4e5f6a7b";
const TENANT_B = "0196f2a8-7c3b-7d4e-9a1b-2c3d4e5f6a7c";

function keyed(): (tenantId: string) => string {
  const source = resolveAiTenantPseudonymSource({ [AI_TENANT_PSEUDONYM_SECRET_VAR]: SECRET });
  const fn = tenantPseudonymForOf(source);
  if (fn === null) throw new Error("expected a keyed source");
  return fn;
}

describe("resolveAiTenantPseudonymSource", () => {
  it("is keyed by CURSOR_ENCRYPTION_SECRET", () => {
    expect(AI_TENANT_PSEUDONYM_SECRET_VAR).toBe("CURSOR_ENCRYPTION_SECRET");
    expect(resolveAiTenantPseudonymSource({ CURSOR_ENCRYPTION_SECRET: SECRET }).kind).toBe("keyed");
  });

  it.each([
    ["unset", {}],
    ["empty", { CURSOR_ENCRYPTION_SECRET: "" }],
    ["blank", { CURSOR_ENCRYPTION_SECRET: "   " }],
  ])("is absent when the secret is %s, and maps to no function", (_l, env) => {
    const source = resolveAiTenantPseudonymSource(env);
    expect(source.kind).toBe("absent");
    expect(tenantPseudonymForOf(source)).toBeNull();
  });

  it("refuses a weak secret at resolution rather than at the first design", () => {
    expect(() => resolveAiTenantPseudonymSource({ CURSOR_ENCRYPTION_SECRET: "too-short" })).toThrow(
      /refused/,
    );
  });

  it("derives a value the provider wire contract accepts (the cross-package agreement)", () => {
    const p = keyed()(TENANT_A);
    expect(TenantPseudonymSchema.safeParse(p).success).toBe(true);
    expect(p.startsWith(AI_TENANT_PSEUDONYM_PREFIX)).toBe(true);
  });

  it("is stable per tenant, distinct across tenants, and contains no tenant id", () => {
    const f = keyed();
    expect(f(TENANT_A)).toBe(keyed()(TENANT_A));
    expect(f(TENANT_A)).not.toBe(f(TENANT_B));
    expect(f(TENANT_A)).not.toContain(TENANT_A);
    expect(f(TENANT_A)).not.toContain(TENANT_A.replaceAll("-", ""));
  });
});

describe("formatAiTenantPseudonym", () => {
  const VENDOR = { providerLabel: "anthropic/claude-sonnet-4-6", endpoint: "vendor" } as const;

  it.each([
    ["vendor", VENDOR],
    ["self-hosted", { providerLabel: "local/qwen2.5:14b", endpoint: "self_hosted" } as const],
  ])("says keyed at info on a %s provider, naming the variable and never the secret or a pseudonym", (_l, provider) => {
    const out = formatAiTenantPseudonym(
      resolveAiTenantPseudonymSource({ CURSOR_ENCRYPTION_SECRET: SECRET }),
      provider,
    );
    expect(out.level).toBe("info");
    expect(out.line).toContain("keyed");
    expect(out.line).toContain("CURSOR_ENCRYPTION_SECRET");
    expect(out.line).not.toContain(SECRET);
    expect(out.line).not.toMatch(/ctp_[0-9a-f]{32}/);
  });

  it("warns when absent on a vendor, naming the key-wide consequence", () => {
    const out = formatAiTenantPseudonym({ kind: "absent" }, VENDOR);
    expect(out.level).toBe("warn");
    expect(out.line).toContain("absent");
    expect(out.line).toContain("CURSOR_ENCRYPTION_SECRET is not set");
    expect(out.line).toContain("throttles or revokes");
    expect(out.line).toContain("raw tenant id is never sent");
  });

  it("is info when absent on a self-hosted model, and claims no vendor consequence", () => {
    const out = formatAiTenantPseudonym(
      { kind: "absent" },
      { providerLabel: "local/qwen2.5:14b", endpoint: "self_hosted" },
    );
    expect(out.level).toBe("info");
    expect(out.line).toContain("None is needed");
    expect(out.line).not.toMatch(/throttle|revoke the deployment|abuse to one tenant/);
    expect(out.line).toContain("raw tenant id is never sent");
  });

  it("warns conditionally when absent on an OpenAI custom base URL, which may be either", () => {
    const out = formatAiTenantPseudonym(
      { kind: "absent" },
      { providerLabel: "openai/qwen2.5:14b", endpoint: "unknown" },
    );
    expect(out.level).toBe("warn");
    expect(out.line).toContain("If this custom base URL is a vendor or a proxy to one");
    expect(out.line).toContain("raw tenant id is never sent");
  });
});

describe("buildDesignProviderFromEnv's endpoint, which the boot line's consequence is keyed on", () => {
  it.each([
    ["the local arm", { LOCAL_LLM_BASE_URL: "http://ollama:11434/v1" }, "self_hosted"],
    ["the Anthropic arm", { ANTHROPIC_API_KEY: "sk-ant-test" }, "vendor"],
    ["api.openai.com", { OPENAI_API_KEY: "sk-test" }, "vendor"],
    ["an OpenAI custom base URL", { OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "http://vllm:8000/v1" }, "unknown"],
  ])("answers %s as %s", (_l, env, endpoint) => {
    expect(buildDesignProviderFromEnv(env)?.endpoint).toBe(endpoint);
  });
});

function capturing(): { provider: DesignCompletionProvider; requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    provider: {
      complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
        requests.push(req);
        return (async function* (): AsyncGenerator<CompletionChunk> {
          yield { kind: "text", text: "not json" };
        })();
      },
    },
  };
}

describe("buildDesignDesigner stamps the pseudonym on every attempt", () => {
  it("carries one tenant's pseudonym on each request for that tenant", async () => {
    const { provider, requests } = capturing();
    const f = keyed();
    const designer = buildDesignDesigner({ provider, parentPack: null, tenantPseudonymFor: f });
    await designer({ tenantId: TENANT_A, description: "a shop" });
    await designer({ tenantId: TENANT_B, description: "a shop" });
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const forA = requests.filter((r) => r.tenantId === TENANT_A).map((r) => r.tenantPseudonym);
    const forB = requests.filter((r) => r.tenantId === TENANT_B).map((r) => r.tenantPseudonym);
    expect(new Set(forA)).toEqual(new Set([f(TENANT_A)]));
    expect(new Set(forB)).toEqual(new Set([f(TENANT_B)]));
  });

  it("carries none when the deployment configured no source", async () => {
    const { provider, requests } = capturing();
    const designer = buildDesignDesigner({ provider, parentPack: null, tenantPseudonymFor: null });
    await designer({ tenantId: TENANT_A, description: "a shop" });
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(r).not.toHaveProperty("tenantPseudonym");
  });
});

// The wire, end to end: the real designer, the real derivation and each real provider, with only
// `fetch` replaced. A refusal response is enough — the request body is captured before it.
type AnyFetch = AnthropicFetch & OpenAiFetch & LocalFetch;
function refusingFetch(bodies: string[]): AnyFetch {
  return (async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    return { ok: false, status: 400, text: async () => "{}", body: null };
  }) as unknown as AnyFetch;
}

describe.each([
  ["anthropic", (fetch: AnyFetch) => new AnthropicProvider({ apiKey: "k", defaultModel: "claude-sonnet-4-6", fetch }), (b: Record<string, unknown>) => (b["metadata"] as { user_id?: unknown } | undefined)?.user_id],
  ["openai", (fetch: AnyFetch) => new OpenAiProvider({ apiKey: "k", defaultModel: "gpt-4o", fetch }), (b: Record<string, unknown>) => b["user"]],
  ["local", (fetch: AnyFetch) => new LocalLlmProvider({ fetch }), (b: Record<string, unknown>) => b["user"]],
] as const)("the %s wire", (_name, make, field) => {
  it("carries the derived pseudonym and never the tenant id", async () => {
    const bodies: string[] = [];
    const f = keyed();
    const designer = buildDesignDesigner({
      provider: make(refusingFetch(bodies)),
      parentPack: null,
      tenantPseudonymFor: f,
    });
    await designer({ tenantId: TENANT_A, description: "a shop" });
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      expect(field(JSON.parse(b) as Record<string, unknown>)).toBe(f(TENANT_A));
      expect(b).not.toContain(TENANT_A);
    }
  });

  it("carries no tenant identifier at all when unconfigured", async () => {
    const bodies: string[] = [];
    const designer = buildDesignDesigner({
      provider: make(refusingFetch(bodies)),
      parentPack: null,
      tenantPseudonymFor: null,
    });
    await designer({ tenantId: TENANT_A, description: "a shop" });
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      expect(field(JSON.parse(b) as Record<string, unknown>)).toBeUndefined();
      expect(b).not.toContain(TENANT_A);
    }
  });
});

describe("serve() wires the source into the designer and reports it (text fence)", () => {
  // Text, because the wiring is inside serve(), which needs a live Postgres to reach.
  const src = stripComments(readFileSync(resolve(import.meta.dirname, "./node.ts"), "utf8"));
  const start = src.indexOf("buildDesignDesigner({");
  const call = src.slice(start, src.indexOf("parentPack:", start));

  it("passes the resolved source, not null and not a literal", () => {
    expect(start).toBeGreaterThan(0);
    expect(call).toContain("tenantPseudonymFor: tenantPseudonymForOf(aiTenantPseudonym)");
    expect(src.indexOf("resolveAiTenantPseudonymSource(process.env)")).toBeGreaterThan(0);
    expect(src.indexOf("resolveAiTenantPseudonymSource(process.env)")).toBeLessThan(start);
  });

  it("says the source at boot", () => {
    expect(src).toContain("formatAiTenantPseudonym(aiTenantPseudonym, providerBuild)");
  });
});
