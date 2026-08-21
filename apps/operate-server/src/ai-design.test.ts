import { describe, expect, it } from "vitest";

import type { CompletionChunk, CompletionRequest } from "@crossengin/ai-providers";
import { AnthropicProvider } from "@crossengin/ai-providers-anthropic";
import { OpenAiProvider } from "@crossengin/ai-providers-openai";
import { ManifestSchema, tryValidateManifest } from "@crossengin/kernel/manifest";

import {
  DESIGN_EXAMPLE_MANIFEST,
  DESIGN_SYSTEM_PROMPT,
  MAX_DESIGN_ATTEMPTS,
  MAX_DESIGN_DESCRIPTION_CHARS,
  MAX_DESIGN_RESPONSE_CHARS,
  buildDesignDesigner,
  buildDesignProviderFromEnv,
  designManifest,
  ensureRolesInManifest,
  extractJsonObject,
  normalizeGeneratedManifest,
  type DesignCompletionProvider,
} from "./ai-design.js";

type Turn = readonly CompletionChunk[] | Error;

function scriptedProvider(turns: readonly Turn[]): {
  provider: DesignCompletionProvider;
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  let index = 0;
  const provider: DesignCompletionProvider = {
    complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
      requests.push(req);
      const turn = turns[Math.min(index, turns.length - 1)] ?? [];
      index += 1;
      return (async function* (): AsyncGenerator<CompletionChunk> {
        if (turn instanceof Error) throw turn;
        for (const chunk of turn) yield chunk;
      })();
    },
  };
  return { provider, requests };
}

function textTurn(text: string, usage?: { input: number; output: number; cost: number }): Turn {
  const chunks: CompletionChunk[] = [{ kind: "text", text }];
  if (usage !== undefined) {
    chunks.push({
      kind: "usage_final",
      usage: { inputTokens: usage.input, outputTokens: usage.output, cost: usage.cost },
    });
  }
  return chunks;
}

const VALID_JSON = JSON.stringify(DESIGN_EXAMPLE_MANIFEST);

function brokenManifestJson(): string {
  const clone = JSON.parse(VALID_JSON) as Record<string, unknown>;
  const entities = clone["entities"] as {
    name: string;
    fields: { name: string; type: { kind: string; target?: string } }[];
  }[];
  const workOrder = entities.find((e) => e.name === "WorkOrder");
  const customerField = workOrder?.fields.find((f) => f.name === "customer");
  if (customerField?.type.target !== undefined) customerField.type.target = "Missing";
  return JSON.stringify(clone);
}

describe("DESIGN_EXAMPLE_MANIFEST fixture", () => {
  it("parses under ManifestSchema and passes kernel cross-validation", () => {
    const parsed = ManifestSchema.parse(DESIGN_EXAMPLE_MANIFEST);
    expect(tryValidateManifest(parsed)).toEqual({ ok: true });
  });

  it("is embedded verbatim in DESIGN_SYSTEM_PROMPT", () => {
    expect(DESIGN_SYSTEM_PROMPT).toContain(JSON.stringify(DESIGN_EXAMPLE_MANIFEST, null, 2));
    expect(DESIGN_SYSTEM_PROMPT).toContain("ONLY a single JSON object");
  });
});

describe("extractJsonObject", () => {
  it("parses a bare JSON object", () => {
    expect(extractJsonObject('{"a": 1}')).toEqual({ a: 1 });
  });

  it("strips markdown code fences", () => {
    expect(extractJsonObject('```json\n{"a": {"b": 2}}\n```')).toEqual({ a: { b: 2 } });
  });

  it("skips leading prose before the object", () => {
    expect(extractJsonObject('Here is the manifest:\n{"x": true} done')).toEqual({ x: true });
  });

  it("balances nested braces and braces inside strings", () => {
    const text = '{"a": "closing } inside", "b": {"c": {"d": 1}}}';
    expect(extractJsonObject(text)).toEqual({ a: "closing } inside", b: { c: { d: 1 } } });
  });

  it("returns null for garbage, arrays, and no object at all", () => {
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("[1, 2, 3]")).toBeNull();
    expect(extractJsonObject("{oops: not json}")).toBeNull();
  });

  it("returns null for an unbalanced object", () => {
    expect(extractJsonObject('{"a": {"b": 1}')).toBeNull();
  });
});

describe("normalizeGeneratedManifest", () => {
  it("injects manifestVersion + meta defaults, using the requested name", () => {
    const out = normalizeGeneratedManifest({}, { name: "Bike Shop" });
    expect(out["manifestVersion"]).toBe("1.0");
    const meta = out["meta"] as Record<string, unknown>;
    expect(meta["name"]).toBe("Bike Shop");
    expect(meta["slug"]).toBe("generated/bike-shop");
    expect(meta["version"]).toBe("0.1.0");
  });

  it("preserves an existing valid meta and does not override name from opts", () => {
    const out = normalizeGeneratedManifest(
      { manifestVersion: "1.0", meta: { name: "Kept", slug: "generated/kept", version: "2.3.4" } },
      { name: "Ignored" },
    );
    expect(out["meta"]).toEqual({ name: "Kept", slug: "generated/kept", version: "2.3.4" });
  });

  it("replaces an invalid slug with one derived from the name", () => {
    const out = normalizeGeneratedManifest({ meta: { name: "My Shop", slug: "My Shop!" } });
    expect((out["meta"] as Record<string, unknown>)["slug"]).toBe("generated/my-shop");
  });

  it("replaces a non-semver version and leaves other manifest keys untouched", () => {
    const out = normalizeGeneratedManifest({
      meta: { name: "X", slug: "generated/x", version: "v1" },
      entities: [{ name: "Thing" }],
    });
    expect((out["meta"] as Record<string, unknown>)["version"]).toBe("0.1.0");
    expect(out["entities"]).toEqual([{ name: "Thing" }]);
  });
});

describe("designManifest — happy path", () => {
  it("accepts a valid fenced manifest on the first attempt", async () => {
    const { provider, requests } = scriptedProvider([
      textTurn("```json\n" + VALID_JSON + "\n```"),
    ]);
    const result = await designManifest({ provider, description: "a field service business" });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.issues).toEqual([]);
    expect(result.manifest?.["manifestVersion"]).toBe("1.0");
    expect(requests).toHaveLength(1);
  });

  it("sends the DESIGN system prompt, planner task, jsonMode, and default maxTokens", async () => {
    const { provider, requests } = scriptedProvider([textTurn(VALID_JSON)]);
    await designManifest({ provider, description: "desc" });
    const req = requests[0];
    expect(req?.task).toBe("planner");
    expect(req?.jsonMode).toBe(true);
    expect(req?.maxTokens).toBe(8192);
    expect(req?.messages[0]).toEqual({ role: "system", content: DESIGN_SYSTEM_PROMPT });
    expect(req?.messages[1]?.content).toContain("desc");
  });

  it("threads model and name into the request", async () => {
    const { provider, requests } = scriptedProvider([textTurn(VALID_JSON)]);
    await designManifest({ provider, description: "desc", name: "Acme", model: "claude-opus-4-7" });
    expect(requests[0]?.model).toBe("claude-opus-4-7");
    expect(requests[0]?.messages[1]?.content).toContain("Application name: Acme");
  });

  it("captures usage from usage_final and reports the providerLabel", async () => {
    const { provider } = scriptedProvider([
      textTurn(VALID_JSON, { input: 100, output: 50, cost: 0.01 }),
    ]);
    const result = await designManifest({
      provider,
      description: "desc",
      providerLabel: "anthropic/claude-sonnet-4-6",
    });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, cost: 0.01 });
    expect(result.providerLabel).toBe("anthropic/claude-sonnet-4-6");
  });

  it("injects meta defaults so a metadata-free manifest still validates", async () => {
    const bare = JSON.parse(VALID_JSON) as Record<string, unknown>;
    delete bare["meta"];
    delete bare["manifestVersion"];
    const { provider } = scriptedProvider([textTurn(JSON.stringify(bare))]);
    const result = await designManifest({ provider, description: "desc", name: "Bare App" });
    expect(result.ok).toBe(true);
    const meta = result.manifest?.["meta"] as Record<string, unknown>;
    expect(meta["name"]).toBe("Bare App");
    expect(meta["slug"]).toBe("generated/bare-app");
  });
});

describe("designManifest — retry loop", () => {
  it("retries after a kernel-invalid manifest with a corrective message", async () => {
    const { provider, requests } = scriptedProvider([
      textTurn(brokenManifestJson()),
      textTurn(VALID_JSON),
    ]);
    const result = await designManifest({ provider, description: "desc" });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(requests).toHaveLength(2);
    const second = requests[1];
    const corrective = second?.messages.filter((m) => m.role === "user").at(-1);
    expect(corrective?.content).toContain("Missing");
    expect(corrective?.content).toContain("ONLY the corrected JSON object");
    const echo = second?.messages.filter((m) => m.role === "assistant").at(-1);
    expect(echo?.content).toContain('"Missing"');
  });

  it("retries after schema-invalid JSON, feeding zod issues back", async () => {
    const schemaInvalid = JSON.stringify({
      manifestVersion: "1.0",
      meta: { name: "X", slug: "generated/x", version: "0.1.0" },
      entities: [{ name: "lowercase", fields: [] }],
    });
    const { provider, requests } = scriptedProvider([
      textTurn(schemaInvalid),
      textTurn(VALID_JSON),
    ]);
    const result = await designManifest({ provider, description: "desc" });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    const corrective = requests[1]?.messages.filter((m) => m.role === "user").at(-1);
    expect(corrective?.content).toContain("entities");
  });

  it("retries after non-JSON output", async () => {
    const { provider, requests } = scriptedProvider([
      textTurn("I cannot answer in JSON, sorry."),
      textTurn(VALID_JSON),
    ]);
    const result = await designManifest({ provider, description: "desc" });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    const corrective = requests[1]?.messages.filter((m) => m.role === "user").at(-1);
    expect(corrective?.content).toContain("JSON object");
  });

  it("retries after a provider throw without appending messages", async () => {
    const { provider, requests } = scriptedProvider([
      new Error("boom"),
      textTurn(VALID_JSON),
    ]);
    const result = await designManifest({ provider, description: "desc" });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(requests[1]?.messages).toHaveLength(2);
  });

  it("gives up after maxAttempts when every response is invalid", async () => {
    const { provider, requests } = scriptedProvider([textTurn(brokenManifestJson())]);
    const result = await designManifest({ provider, description: "desc" });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(MAX_DESIGN_ATTEMPTS);
    expect(requests).toHaveLength(MAX_DESIGN_ATTEMPTS);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]).toContain("Missing");
    expect(result.manifest).toBeNull();
    expect(result.manifestHash).toBeNull();
  });

  it("honors a maxAttempts override", async () => {
    const { provider, requests } = scriptedProvider([textTurn("not json")]);
    const result = await designManifest({ provider, description: "desc", maxAttempts: 2 });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(requests).toHaveLength(2);
  });

  it("accumulates usage across attempts", async () => {
    const { provider } = scriptedProvider([
      textTurn(brokenManifestJson(), { input: 100, output: 40, cost: 0.02 }),
      textTurn(VALID_JSON, { input: 200, output: 60, cost: 0.03 }),
    ]);
    const result = await designManifest({ provider, description: "desc" });
    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 100, cost: 0.05 });
  });
});

describe("designManifest — size limits", () => {
  it("rejects an oversized description without calling the provider", async () => {
    const { provider, requests } = scriptedProvider([textTurn(VALID_JSON)]);
    const result = await designManifest({
      provider,
      description: "x".repeat(MAX_DESIGN_DESCRIPTION_CHARS + 1),
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(0);
    expect(result.issues[0]).toContain("description");
    expect(requests).toHaveLength(0);
  });

  it("fails an attempt whose response exceeds the response cap", async () => {
    const { provider } = scriptedProvider([
      textTurn("{".repeat(MAX_DESIGN_RESPONSE_CHARS + 1)),
    ]);
    const result = await designManifest({ provider, description: "desc", maxAttempts: 1 });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.issues[0]).toContain(`${MAX_DESIGN_RESPONSE_CHARS}`);
  });
});

describe("buildDesignDesigner", () => {
  it("builds a designer that closes over provider config", async () => {
    const { provider, requests } = scriptedProvider([textTurn(VALID_JSON)]);
    const designer = buildDesignDesigner({
      provider,
      model: "claude-opus-4-7",
      maxTokens: 4096,
      providerLabel: "anthropic/claude-opus-4-7",
    });
    const result = await designer({ description: "desc", name: "Closed Over" });
    expect(result.ok).toBe(true);
    expect(result.providerLabel).toBe("anthropic/claude-opus-4-7");
    expect(requests[0]?.model).toBe("claude-opus-4-7");
    expect(requests[0]?.maxTokens).toBe(4096);
    expect(requests[0]?.messages[1]?.content).toContain("Closed Over");
  });
});

describe("buildDesignProviderFromEnv", () => {
  it("returns null when no API keys are set", () => {
    expect(buildDesignProviderFromEnv({})).toBeNull();
  });

  it("prefers Anthropic when both keys are set", () => {
    const built = buildDesignProviderFromEnv({
      ANTHROPIC_API_KEY: "sk-ant-x",
      OPENAI_API_KEY: "sk-x",
    });
    expect(built?.provider).toBeInstanceOf(AnthropicProvider);
    expect(built?.providerLabel).toBe("anthropic/claude-sonnet-4-6");
    expect(built?.model).toBe("claude-sonnet-4-6");
  });

  it("honors a supported Anthropic model override", () => {
    const built = buildDesignProviderFromEnv(
      { ANTHROPIC_API_KEY: "sk-ant-x" },
      { model: "claude-opus-4-7" },
    );
    expect(built?.providerLabel).toBe("anthropic/claude-opus-4-7");
  });

  it("falls back to OpenAI with the gpt-4o default", () => {
    const built = buildDesignProviderFromEnv({ OPENAI_API_KEY: "sk-x" });
    expect(built?.provider).toBeInstanceOf(OpenAiProvider);
    expect(built?.providerLabel).toBe("openai/gpt-4o");
    expect((built?.provider as OpenAiProvider).endpoint).toBe("https://api.openai.com");
  });

  it("honors OPENAI_BASE_URL and an OpenAI model override", () => {
    const built = buildDesignProviderFromEnv(
      { OPENAI_API_KEY: "sk-x", OPENAI_BASE_URL: "https://gateway.example.com" },
      { model: "gpt-4o-mini" },
    );
    expect(built?.providerLabel).toBe("openai/gpt-4o-mini");
    expect((built?.provider as OpenAiProvider).endpoint).toBe("https://gateway.example.com");
  });

  it("ignores an unsupported model override and keeps the vendor default", () => {
    const built = buildDesignProviderFromEnv(
      { ANTHROPIC_API_KEY: "sk-ant-x" },
      { model: "gpt-4o" },
    );
    expect(built?.providerLabel).toBe("anthropic/claude-sonnet-4-6");
  });
});

describe("ensureRolesInManifest", () => {
  it("grafts an operator role into roles + every permission grant, still kernel-valid", () => {
    const grafted = ensureRolesInManifest(
      DESIGN_EXAMPLE_MANIFEST as Record<string, unknown>,
      ["erp_admin"],
    );
    const parsed = ManifestSchema.parse(grafted);
    expect(tryValidateManifest(parsed)).toEqual({ ok: true });
    const roles = grafted["roles"] as Record<string, unknown>;
    expect(Object.keys(roles)).toContain("erp_admin");
    const perms = grafted["permissions"] as Record<string, Record<string, { roles: string[] }>>;
    for (const entity of Object.keys(perms)) {
      for (const op of Object.keys(perms[entity] ?? {})) {
        expect(perms[entity]?.[op]?.roles).toContain("erp_admin");
      }
    }
  });

  it("is a no-op for an empty role list and never duplicates an existing role", () => {
    const same = ensureRolesInManifest(DESIGN_EXAMPLE_MANIFEST as Record<string, unknown>, []);
    expect(same).toBe(DESIGN_EXAMPLE_MANIFEST);
    const grafted = ensureRolesInManifest(
      DESIGN_EXAMPLE_MANIFEST as Record<string, unknown>,
      ["app_admin"],
    );
    const perms = grafted["permissions"] as Record<string, Record<string, { roles: string[] }>>;
    const listRoles = perms["Customer"]?.["list"]?.roles ?? [];
    expect(listRoles.filter((r) => r === "app_admin")).toHaveLength(1);
  });

  it("designManifest threads ensureRoles through to the validated result", async () => {
    const { provider } = scriptedProvider([
      [
        { kind: "text", text: JSON.stringify(DESIGN_EXAMPLE_MANIFEST) },
        { kind: "usage_final", usage: { inputTokens: 10, outputTokens: 20, cost: 0.001 } },
      ] as unknown as readonly CompletionChunk[],
    ]);
    const result = await designManifest({
      provider,
      description: "field service business",
      ensureRoles: ["erp_admin"],
    });
    expect(result.ok).toBe(true);
    const perms = (result.manifest ?? {})["permissions"] as Record<string, Record<string, { roles: string[] }>>;
    expect(perms["WorkOrder"]?.["update"]?.roles).toContain("erp_admin");
  });
});

describe("ensureRolesInManifest — transition + field grants", () => {
  it("grafts into transition grants but never into field-level grants", () => {
    const manifest = {
      ...(DESIGN_EXAMPLE_MANIFEST as Record<string, unknown>),
      permissions: {
        Customer: {
          list: { roles: ["app_admin"] },
          read: { roles: ["app_admin"] },
          create: { roles: ["app_admin"] },
          update: { roles: ["app_admin"] },
          delete: { roles: ["app_admin"] },
          transitions: { archive: { roles: ["app_admin"] } },
          fields: { contact_email: { read: { roles: ["app_admin"] } } },
        },
        WorkOrder: (DESIGN_EXAMPLE_MANIFEST as { permissions: Record<string, unknown> }).permissions["WorkOrder"],
      },
    };
    const grafted = ensureRolesInManifest(manifest, ["erp_admin"]);
    const perms = grafted["permissions"] as Record<string, Record<string, unknown>>;
    const customer = perms["Customer"] ?? {};
    expect((customer["transitions"] as Record<string, { roles: string[] }>)["archive"]?.roles).toContain("erp_admin");
    const fields = customer["fields"] as Record<string, { read: { roles: string[] } }>;
    expect(fields["contact_email"]?.read.roles).toEqual(["app_admin"]);
    expect((customer["list"] as { roles: string[] }).roles).toContain("erp_admin");
  });
});
