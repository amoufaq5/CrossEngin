import { describe, expect, it } from "vitest";

import type {
  CompletionChunk,
  CompletionRequest,
  ProviderPricing,
} from "@crossengin/ai-providers";
import { MockLlmProvider } from "@crossengin/ai-providers";
import { AnthropicProvider } from "@crossengin/ai-providers-anthropic";
import { DEFAULT_LOCAL_MODEL, LocalLlmProvider } from "@crossengin/ai-providers-local";
import { OpenAiProvider } from "@crossengin/ai-providers-openai";
import { ManifestSchema, tryValidateManifest } from "@crossengin/kernel/manifest";

import {
  DESIGN_EXAMPLE_MANIFEST,
  DESIGN_FAILURE_FAULT,
  DESIGN_FAILURE_KINDS,
  DESIGN_FAULTS,
  DESIGN_PROGRESS_CHARS_STEP,
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
  type DesignProgress,
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

function chunkedTurn(text: string, chunkSize: number): Turn {
  const chunks: CompletionChunk[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push({ kind: "text", text: text.slice(i, i + chunkSize) });
  }
  return chunks;
}

function collector(): { events: DesignProgress[]; listener: (p: DesignProgress) => void } {
  const events: DesignProgress[] = [];
  return { events, listener: (p: DesignProgress): void => void events.push(p) };
}

function phaseSequence(events: readonly DesignProgress[]): string[] {
  return events.map((e) => e.phase).filter((phase, i, all) => phase !== all[i - 1]);
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

  it("passes a self-hosted model id through verbatim against a custom base URL", () => {
    // The whole point of OPENAI_BASE_URL: Ollama serves `qwen2.5:14b-instruct`, never `gpt-4o`.
    const built = buildDesignProviderFromEnv(
      { OPENAI_API_KEY: "local", OPENAI_BASE_URL: "http://ollama:11434" },
      { model: "qwen2.5:14b-instruct" },
    );
    expect(built?.model).toBe("qwen2.5:14b-instruct");
    expect(built?.providerLabel).toBe("openai/qwen2.5:14b-instruct");
    expect((built?.provider as OpenAiProvider).endpoint).toBe("http://ollama:11434");
  });

  it("still rewrites an unlisted model to the default against OpenAI itself", () => {
    const built = buildDesignProviderFromEnv(
      { OPENAI_API_KEY: "sk-x" },
      { model: "qwen2.5:14b-instruct" },
    );
    expect(built?.model).toBe("gpt-4o");
  });

  it("keeps the OpenAI default when a custom base URL names no model", () => {
    const built = buildDesignProviderFromEnv({
      OPENAI_API_KEY: "local",
      OPENAI_BASE_URL: "http://ollama:11434",
    });
    expect(built?.model).toBe("gpt-4o");
  });

  it("treats an empty OPENAI_BASE_URL as no base URL at all", () => {
    const built = buildDesignProviderFromEnv(
      { OPENAI_API_KEY: "sk-x", OPENAI_BASE_URL: "" },
      { model: "qwen2.5:14b-instruct" },
    );
    expect(built?.model).toBe("gpt-4o");
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

describe("designManifest — progress", () => {
  it("reports generating then validating on a first-try success, with no retrying", async () => {
    const { provider } = scriptedProvider([textTurn(VALID_JSON)]);
    const { events, listener } = collector();
    const result = await designManifest({
      provider,
      description: "desc",
      onProgress: listener,
    });
    expect(result.ok).toBe(true);
    expect(phaseSequence(events)).toEqual(["generating", "validating"]);
    expect(events[0]).toEqual({
      phase: "generating",
      attempt: 1,
      maxAttempts: MAX_DESIGN_ATTEMPTS,
      outputChars: 0,
      issues: [],
    });
    expect(events.at(-1)?.phase).toBe("validating");
    expect(events.at(-1)?.outputChars).toBe(VALID_JSON.length);
  });

  it("reports a retrying phase carrying the issues, then a second generating pass", async () => {
    const { provider } = scriptedProvider([textTurn(brokenManifestJson()), textTurn(VALID_JSON)]);
    const { events, listener } = collector();
    const result = await designManifest({
      provider,
      description: "desc",
      onProgress: listener,
    });
    expect(result.ok).toBe(true);
    expect(phaseSequence(events)).toEqual([
      "generating",
      "validating",
      "retrying",
      "generating",
      "validating",
    ]);
    const retrying = events.filter((e) => e.phase === "retrying");
    expect(retrying).toHaveLength(1);
    expect(retrying[0]?.attempt).toBe(1);
    expect(retrying[0]?.issues.length).toBeGreaterThan(0);
    expect(retrying[0]?.issues.join(" ")).toContain("Missing");
  });

  it("numbers attempts from 1 and carries maxAttempts on every event", async () => {
    const { provider } = scriptedProvider([textTurn("not json"), textTurn(VALID_JSON)]);
    const { events, listener } = collector();
    await designManifest({ provider, description: "desc", maxAttempts: 2, onProgress: listener });
    expect(events.every((e) => e.maxAttempts === 2)).toBe(true);
    expect(events[0]?.attempt).toBe(1);
    expect(new Set(events.map((e) => e.attempt))).toEqual(new Set([1, 2]));
    expect(events.every((e) => e.attempt >= 1)).toBe(true);
  });

  it("never emits retrying after the final attempt fails", async () => {
    const { provider } = scriptedProvider([textTurn(brokenManifestJson())]);
    const { events, listener } = collector();
    const result = await designManifest({
      provider,
      description: "desc",
      maxAttempts: 2,
      onProgress: listener,
    });
    expect(result.ok).toBe(false);
    const retrying = events.filter((e) => e.phase === "retrying");
    expect(retrying).toHaveLength(1);
    expect(retrying[0]?.attempt).toBe(1);
    expect(events.at(-1)?.phase).toBe("validating");
    expect(events.at(-1)?.attempt).toBe(2);
  });

  it("throttles streaming updates to one per DESIGN_PROGRESS_CHARS_STEP of growth", async () => {
    const chunkSize = 40;
    const total = 4000;
    const { provider } = scriptedProvider([chunkedTurn("x".repeat(total), chunkSize)]);
    const { events, listener } = collector();
    await designManifest({ provider, description: "desc", maxAttempts: 1, onProgress: listener });
    const generating = events.filter((e) => e.phase === "generating");
    const expected = total / DESIGN_PROGRESS_CHARS_STEP + 1;
    expect(generating.length).toBeLessThanOrEqual(expected);
    expect(generating.length).toBeLessThan(total / chunkSize);
    expect(generating.map((e) => e.outputChars)).toEqual([
      0, 400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3600, 4000,
    ]);
  });

  it("resets outputChars at the start of each attempt", async () => {
    const { provider } = scriptedProvider([textTurn("y".repeat(1200)), textTurn(VALID_JSON)]);
    const { events, listener } = collector();
    await designManifest({ provider, description: "desc", onProgress: listener });
    const firstOfAttemptTwo = events.find((e) => e.attempt === 2);
    expect(firstOfAttemptTwo?.phase).toBe("generating");
    expect(firstOfAttemptTwo?.outputChars).toBe(0);
    const attemptOneMax = Math.max(
      ...events.filter((e) => e.attempt === 1).map((e) => e.outputChars),
    );
    expect(attemptOneMax).toBe(1200);
    const validatingTwo = events.find((e) => e.attempt === 2 && e.phase === "validating");
    expect(validatingTwo?.outputChars).toBe(VALID_JSON.length);
  });

  it("survives a listener that throws on every event", async () => {
    const { provider } = scriptedProvider([textTurn(brokenManifestJson()), textTurn(VALID_JSON)]);
    let calls = 0;
    const result = await designManifest({
      provider,
      description: "desc",
      onProgress: (): void => {
        calls += 1;
        throw new Error("listener exploded");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(calls).toBeGreaterThan(1);
  });

  it("emits retrying with the provider error message when an attempt throws", async () => {
    const { provider } = scriptedProvider([new Error("boom"), textTurn(VALID_JSON)]);
    const { events, listener } = collector();
    const result = await designManifest({
      provider,
      description: "desc",
      onProgress: listener,
    });
    expect(result.ok).toBe(true);
    const retrying = events.filter((e) => e.phase === "retrying");
    expect(retrying).toHaveLength(1);
    expect(retrying[0]?.issues[0]).toContain("provider error: boom");
    expect(retrying[0]?.outputChars).toBe(0);
  });

  it("buildDesignDesigner accepts a per-call listener", async () => {
    const { provider } = scriptedProvider([textTurn(VALID_JSON)]);
    const designer = buildDesignDesigner({ provider });
    const { events, listener } = collector();
    const result = await designer({ description: "desc", onProgress: listener });
    expect(result.ok).toBe(true);
    expect(phaseSequence(events)).toEqual(["generating", "validating"]);
  });

  it("buildDesignDesigner uses the builder listener, and a per-call listener wins", async () => {
    const { provider } = scriptedProvider([textTurn(VALID_JSON)]);
    const builderSink = collector();
    const designer = buildDesignDesigner({ provider, onProgress: builderSink.listener });
    await designer({ description: "desc" });
    expect(builderSink.events.length).toBeGreaterThan(0);

    const before = builderSink.events.length;
    const perCall = collector();
    await designer({ description: "desc", onProgress: perCall.listener });
    expect(perCall.events.length).toBeGreaterThan(0);
    expect(builderSink.events).toHaveLength(before);
  });
});

describe("buildDesignProviderFromEnv — self-hosted model", () => {
  const LOCAL_SSE = [
    'data: {"choices":[{"delta":{"content":"{}"}}]}',
    "",
    'data: {"usage":{"prompt_tokens":1200,"completion_tokens":4800}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  it("builds a LocalLlmProvider from LOCAL_LLM_BASE_URL with the package default model", () => {
    const built = buildDesignProviderFromEnv({ LOCAL_LLM_BASE_URL: "http://ollama:11434/v1" });
    expect(built?.provider).toBeInstanceOf(LocalLlmProvider);
    expect(built?.model).toBe(DEFAULT_LOCAL_MODEL);
    expect(built?.providerLabel).toBe(`local/${DEFAULT_LOCAL_MODEL}`);
  });

  it("accepts OLLAMA_BASE_URL as the same signal", () => {
    const built = buildDesignProviderFromEnv({ OLLAMA_BASE_URL: "http://ollama:11434/v1" });
    expect(built?.provider).toBeInstanceOf(LocalLlmProvider);
  });

  it("prefers LOCAL_LLM_BASE_URL over OLLAMA_BASE_URL", () => {
    const built = buildDesignProviderFromEnv({
      LOCAL_LLM_BASE_URL: "http://vllm:8000/v1",
      OLLAMA_BASE_URL: "http://ollama:11434/v1",
    });
    expect(built?.provider).toBeInstanceOf(LocalLlmProvider);
  });

  it("passes a self-hosted model id through verbatim — there is no catalogue to gate against", () => {
    const built = buildDesignProviderFromEnv(
      { LOCAL_LLM_BASE_URL: "http://ollama:11434/v1" },
      { model: "qwen2.5:14b-instruct" },
    );
    expect(built?.model).toBe("qwen2.5:14b-instruct");
    expect(built?.providerLabel).toBe("local/qwen2.5:14b-instruct");
  });

  it("wins over both cloud keys, so an opted-out operator's prose never leaves the box", () => {
    const built = buildDesignProviderFromEnv({
      LOCAL_LLM_BASE_URL: "http://ollama:11434/v1",
      ANTHROPIC_API_KEY: "sk-ant-x",
      OPENAI_API_KEY: "sk-x",
    });
    expect(built?.provider).toBeInstanceOf(LocalLlmProvider);
  });

  it("builds with an optional LOCAL_LLM_API_KEY bearer token", () => {
    const built = buildDesignProviderFromEnv({
      LOCAL_LLM_BASE_URL: "http://lmstudio:1234/v1",
      LOCAL_LLM_API_KEY: "lm-token",
    });
    expect(built?.provider).toBeInstanceOf(LocalLlmProvider);
    expect(built?.providerLabel).toBe(`local/${DEFAULT_LOCAL_MODEL}`);
  });

  it("treats an empty LOCAL_LLM_BASE_URL as unset and falls through to the cloud", () => {
    const built = buildDesignProviderFromEnv({ LOCAL_LLM_BASE_URL: "", ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(built?.provider).toBeInstanceOf(AnthropicProvider);
  });

  it("treats an empty OLLAMA_BASE_URL as unset too", () => {
    const built = buildDesignProviderFromEnv({ OLLAMA_BASE_URL: "", OPENAI_API_KEY: "sk-x" });
    expect(built?.provider).toBeInstanceOf(OpenAiProvider);
  });

  it("fails closed on a malformed local base URL rather than silently using a cloud vendor", () => {
    const built = buildDesignProviderFromEnv({
      LOCAL_LLM_BASE_URL: "ollama:11434",
      ANTHROPIC_API_KEY: "sk-ant-x",
      OPENAI_API_KEY: "sk-x",
    });
    expect(built).toBeNull();
  });

  it("fails closed on a non-http local base URL", () => {
    expect(
      buildDesignProviderFromEnv({ LOCAL_LLM_BASE_URL: "file:///models/qwen", OPENAI_API_KEY: "sk-x" }),
    ).toBeNull();
  });

  it("fails closed on a malformed OLLAMA_BASE_URL as well", () => {
    expect(buildDesignProviderFromEnv({ OLLAMA_BASE_URL: "not a url", ANTHROPIC_API_KEY: "sk-ant-x" })).toBeNull();
  });

  it("prices self-hosted inference at zero, so a cost ceiling never trips on it", () => {
    const built = buildDesignProviderFromEnv({ LOCAL_LLM_BASE_URL: "http://ollama:11434/v1" });
    const provider = built?.provider as LocalLlmProvider;
    expect(provider.pricing).toEqual({
      inputPerMillionTokens: 0,
      outputPerMillionTokens: 0,
      cachedInputPerMillionTokens: 0,
    });
    const final = provider.chunksFromTextStream(LOCAL_SSE).find((c) => c.kind === "usage_final");
    expect(final).toEqual({
      kind: "usage_final",
      usage: { inputTokens: 1200, outputTokens: 4800, cost: 0 },
    });
  });

  it("accumulates a zero cost across design attempts while still counting tokens", async () => {
    const { provider } = scriptedProvider([
      textTurn("not json", { input: 100, output: 200, cost: 0 }),
      textTurn(VALID_JSON, { input: 150, output: 900, cost: 0 }),
    ]);
    const result = await designManifest({ provider, description: "a field service business" });
    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 250, outputTokens: 1100, cost: 0 });
  });

  it("falls back to the default model when --ai-model is an empty string", () => {
    const built = buildDesignProviderFromEnv({ LOCAL_LLM_BASE_URL: "http://ollama:11434/v1" }, { model: "" });
    expect(built?.model).toBe(DEFAULT_LOCAL_MODEL);
  });

  it("still returns null when neither a local endpoint nor an API key is configured", () => {
    expect(buildDesignProviderFromEnv({ LOCAL_LLM_API_KEY: "lm-token" })).toBeNull();
  });
});

describe("designManifest — diagnosable failure classification (ADR-0280)", () => {
  function mockProvider(
    turns: readonly Turn[],
    pricing?: ProviderPricing,
  ): { provider: DesignCompletionProvider; requests: CompletionRequest[] } {
    const requests: CompletionRequest[] = [];
    let index = 0;
    const provider = new MockLlmProvider({
      ...(pricing !== undefined ? { pricing } : {}),
      completeBehavior: (req: CompletionRequest): AsyncIterable<CompletionChunk> => {
        requests.push(req);
        const turn = turns[Math.min(index, turns.length - 1)] ?? [];
        index += 1;
        return (async function* (): AsyncGenerator<CompletionChunk> {
          if (turn instanceof Error) throw turn;
          for (const chunk of turn) yield chunk;
        })();
      },
    });
    return { provider, requests };
  }

  async function failWith(text: string): Promise<Awaited<ReturnType<typeof designManifest>>> {
    const { provider } = mockProvider([textTurn(text)]);
    return designManifest({ provider, description: "desc", maxAttempts: 1 });
  }

  it("every failure kind maps to exactly one fault", () => {
    for (const kind of DESIGN_FAILURE_KINDS) {
      expect(DESIGN_FAULTS).toContain(DESIGN_FAILURE_FAULT[kind]);
    }
    expect(new Set(DESIGN_FAILURE_KINDS).size).toBe(DESIGN_FAILURE_KINDS.length);
  });

  it("classifies prose with no JSON as not_json, faulting the model", async () => {
    const r = await failWith("I'd be glad to help — could you tell me more about your business?");
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("not_json");
    expect(r.fault).toBe("model_output");
    expect(r.diagnosis[0]?.shape).toBe("no_json");
  });

  it("classifies leading prose then JSON as a prose-wrapped recovery, not a failure", async () => {
    const { provider } = mockProvider([textTurn(`Certainly! Here it is:\n\n${VALID_JSON}\n\nEnjoy.`)]);
    const r = await designManifest({ provider, description: "desc", maxAttempts: 1 });
    expect(r.ok).toBe(true);
    expect(r.failure).toBeNull();
    expect(r.recovery).toBe("surrounding_prose");
  });

  it("recovers a fenced manifest and still reports the fence", async () => {
    const { provider } = mockProvider([textTurn(`\`\`\`json\n${VALID_JSON}\n\`\`\``)]);
    const r = await designManifest({ provider, description: "desc", maxAttempts: 1 });
    expect(r.ok).toBe(true);
    expect(r.recovery).toBe("code_fence");
    expect(r.diagnosis).toHaveLength(1);
    expect(r.diagnosis[0]?.wrapper).toBe("code_fence");
  });

  it("classifies JSON cut off mid-object as truncated_json, distinct from malformed", async () => {
    const r = await failWith(VALID_JSON.slice(0, VALID_JSON.length - 30));
    expect(r.failure).toBe("truncated_json");
    expect(r.fault).toBe("model_output");
    expect(r.manifest).toBeNull();
  });

  it("classifies balanced-but-unparseable JSON as malformed_json and never repairs it", async () => {
    const r = await failWith('{"manifestVersion": "1.0", "entities": [],}');
    expect(r.failure).toBe("malformed_json");
    expect(r.manifest).toBeNull();
  });

  it("classifies a JSON array as array_not_object, not its first element", async () => {
    const r = await failWith(`[${VALID_JSON}]`);
    expect(r.failure).toBe("array_not_object");
    expect(r.manifest).toBeNull();
  });

  it("classifies valid JSON that is not a manifest as not_a_manifest", async () => {
    const r = await failWith('{"reply": "Your business needs a CRM.", "confidence": 0.4}');
    expect(r.failure).toBe("not_a_manifest");
    expect(r.fault).toBe("model_output");
  });

  it("separates a manifest the schema rejects from one the model could not form", async () => {
    const r = await failWith(
      JSON.stringify({
        manifestVersion: "1.0",
        meta: { name: "X", slug: "generated/x", version: "0.1.0" },
        entities: [{ name: "lowercase", fields: [] }],
      }),
    );
    expect(r.failure).toBe("schema_invalid");
    expect(r.fault).toBe("manifest_content");
  });

  it("separates a cross-validation failure from a schema failure", async () => {
    const r = await failWith(brokenManifestJson());
    expect(r.failure).toBe("cross_validation_failed");
    expect(r.fault).toBe("manifest_content");
  });

  it("classifies an empty reply as empty_response", async () => {
    const { provider } = mockProvider([[]]);
    const r = await designManifest({ provider, description: "desc", maxAttempts: 1 });
    expect(r.failure).toBe("empty_response");
    expect(r.diagnosis[0]?.shape).toBe("empty");
  });

  it("classifies a provider throw as a provider fault, not a model one", async () => {
    const { provider } = mockProvider([new Error("connect ECONNREFUSED")]);
    const r = await designManifest({ provider, description: "desc", maxAttempts: 1 });
    expect(r.failure).toBe("provider_error");
    expect(r.fault).toBe("provider");
    expect(r.diagnosis[0]?.shape).toBeNull();
  });

  it("classifies an over-long description as the caller's fault before any call", async () => {
    const { provider, requests } = mockProvider([textTurn(VALID_JSON)]);
    const r = await designManifest({
      provider,
      description: "x".repeat(MAX_DESIGN_DESCRIPTION_CHARS + 1),
    });
    expect(r.failure).toBe("description_too_long");
    expect(r.fault).toBe("request");
    expect(requests).toHaveLength(0);
  });

  it("records one diagnosis per attempt, in order, ending with the success", async () => {
    const { provider } = mockProvider([
      textTurn("no json at all"),
      textTurn(`\`\`\`json\n${VALID_JSON}\n\`\`\``),
    ]);
    const r = await designManifest({ provider, description: "desc" });
    expect(r.ok).toBe(true);
    expect(r.diagnosis.map((d) => d.failure)).toEqual(["not_json", null]);
    expect(r.diagnosis.map((d) => d.attempt)).toEqual([1, 2]);
    expect(r.diagnosis[1]?.wrapper).toBe("code_fence");
  });

  it("tells a fenced model to drop the fence specifically", async () => {
    // The payload inside the fence is *malformed*, not a well-formed object answering another
    // question. That distinction became load-bearing in ADR-0330: `object_not_manifest` — a JSON
    // object with none of the manifest's keys — is now `wrong_question` and is not retried at all,
    // so a fenced `{"reply":"no"}` would never reach a corrective. Broken syntax inside a fence
    // still is a delivery problem, which is what this test is about.
    const { provider, requests } = mockProvider([
      textTurn('```json\n{"entities": [,]}\n```'),
      textTurn(VALID_JSON),
    ]);
    await designManifest({ provider, description: "desc" });
    const corrective = requests[1]?.messages.filter((m) => m.role === "user").at(-1);
    expect(corrective?.content).toContain("code fence");
  });

  it("does not ask again when the model answered a different question", async () => {
    // ADR-0330. The loop used to retry **every** non-manifest shape, which is the blind retry
    // ADR-0311 warned about: a well-formed object or array that is not a manifest is the model
    // answering something else, and asking again buys the same wrong answer for another paid call.
    const { provider, requests } = mockProvider([
      textTurn('{"reply": "no"}'),
      textTurn(VALID_JSON),
    ]);
    const out = await designManifest({ provider, description: "desc" });
    expect(out.ok).toBe(false);
    // One call, not two: the second turn was never asked for.
    expect(requests).toHaveLength(1);
  });

  it("still asks again when the failure was only in the delivery", async () => {
    // The other side of the same line, so the change is a narrowing and not a blanket stop.
    const { provider, requests } = mockProvider([
      textTurn("not json at all"),
      textTurn(VALID_JSON),
    ]);
    const out = await designManifest({ provider, description: "desc" });
    expect(out.ok).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it("tells a truncating model to produce a smaller manifest", async () => {
    const { provider, requests } = mockProvider([
      textTurn(VALID_JSON.slice(0, 200)),
      textTurn(VALID_JSON),
    ]);
    await designManifest({ provider, description: "desc" });
    const corrective = requests[1]?.messages.filter((m) => m.role === "user").at(-1);
    expect(corrective?.content).toContain("smaller manifest");
  });

  it("surfaces the classification on the retrying progress event", async () => {
    const seen: DesignProgress[] = [];
    const { provider } = mockProvider([textTurn("[1, 2, 3]"), textTurn(VALID_JSON)]);
    await designManifest({
      provider,
      description: "desc",
      onProgress: (p) => void seen.push(p),
    });
    const retry = seen.find((p) => p.phase === "retrying");
    expect(retry?.failure).toBe("array_not_object");
    expect(retry?.shape).toBe("array_not_object");
  });
});

describe("designManifest — per-request cost ceiling (ADR-0267)", () => {
  const PAID: ProviderPricing = { inputPerMillionTokens: 3, outputPerMillionTokens: 15 };

  function pricedProvider(
    turns: readonly Turn[],
    pricing: ProviderPricing | undefined,
  ): { provider: DesignCompletionProvider; requests: CompletionRequest[] } {
    const requests: CompletionRequest[] = [];
    let index = 0;
    const base = new MockLlmProvider({
      ...(pricing !== undefined ? { pricing } : {}),
      completeBehavior: (req: CompletionRequest): AsyncIterable<CompletionChunk> => {
        requests.push(req);
        const turn = turns[Math.min(index, turns.length - 1)] ?? [];
        index += 1;
        return (async function* (): AsyncGenerator<CompletionChunk> {
          if (turn instanceof Error) throw turn;
          for (const chunk of turn) yield chunk;
        })();
      },
    });
    const provider: DesignCompletionProvider =
      pricing === undefined
        ? { complete: (req: CompletionRequest) => base.complete(req) }
        : base;
    return { provider, requests };
  }

  it("leaves a run unpriced when no ceiling is configured", async () => {
    const { provider, requests } = pricedProvider([textTurn(VALID_JSON)], PAID);
    const r = await designManifest({ provider, description: "desc" });
    expect(r.ok).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("admits a request whose estimate fits under the ceiling", async () => {
    const { provider, requests } = pricedProvider([textTurn(VALID_JSON)], PAID);
    const r = await designManifest({ provider, description: "desc", maxRequestDollars: 1 });
    expect(r.ok).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("refuses to send a request estimated over the ceiling, and does not retry it", async () => {
    const { provider, requests } = pricedProvider([textTurn(VALID_JSON)], PAID);
    const r = await designManifest({
      provider,
      description: "desc",
      maxRequestDollars: 0.000001,
    });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("request_cost_ceiling");
    expect(r.fault).toBe("request");
    expect(requests).toHaveLength(0);
    expect(r.attempts).toBe(1);
  });

  it("refuses a configured ceiling it cannot compute (provider publishes no pricing)", async () => {
    const { provider, requests } = pricedProvider([textTurn(VALID_JSON)], undefined);
    const r = await designManifest({ provider, description: "desc", maxRequestDollars: 10 });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("request_cost_ceiling");
    expect(r.issues[0]).toContain("no pricing");
    expect(requests).toHaveLength(0);
  });

  it("a free-priced self-hosted provider is never refused by the ceiling", async () => {
    const free: ProviderPricing = { inputPerMillionTokens: 0, outputPerMillionTokens: 0 };
    const { provider } = pricedProvider([textTurn(VALID_JSON)], free);
    const r = await designManifest({ provider, description: "desc", maxRequestDollars: 0 });
    expect(r.ok).toBe(true);
  });

  // A model that writes past its own maxTokens: the pre-flight estimate fits, so the
  // in-flight meter is the only thing that can stop it.
  const RUNAWAY = `{"entities": [${'"x",'.repeat(60_000)}`;

  it("abandons a stream mid-flight once accrued output breaks the ceiling", async () => {
    const { provider } = pricedProvider([chunkedTurn(RUNAWAY, 500), textTurn(VALID_JSON)], PAID);
    const r = await designManifest({
      provider,
      description: "desc",
      maxTokens: 500,
      maxRequestDollars: 0.05,
      maxAttempts: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("response_cost_ceiling");
    expect(r.fault).toBe("request");
    // The abandoned output is still charged — those tokens were generated.
    expect(r.usage?.cost ?? 0).toBeGreaterThan(0.05);
  });

  it("an abandoned stream is retried with a compactness instruction", async () => {
    const { provider, requests } = pricedProvider(
      [chunkedTurn(RUNAWAY, 500), textTurn(VALID_JSON)],
      PAID,
    );
    const r = await designManifest({
      provider,
      description: "desc",
      maxTokens: 500,
      maxRequestDollars: 0.05,
    });
    expect(r.ok).toBe(true);
    const corrective = requests[1]?.messages.filter((m) => m.role === "user").at(-1);
    expect(corrective?.content).toContain("too expensive");
  });

  it("stops the run when the actual cost broke the ceiling, but keeps a valid manifest", async () => {
    const { provider, requests } = pricedProvider(
      [textTurn(VALID_JSON, { input: 10, output: 10, cost: 5 })],
      PAID,
    );
    const r = await designManifest({ provider, description: "desc", maxRequestDollars: 0.5 });
    expect(r.ok).toBe(true);
    expect(r.usage?.cost).toBe(5);
    expect(requests).toHaveLength(1);
  });

  it("stops retrying after an actual cost over the ceiling", async () => {
    const { provider, requests } = pricedProvider(
      [textTurn("not json", { input: 10, output: 10, cost: 5 })],
      PAID,
    );
    const r = await designManifest({ provider, description: "desc", maxRequestDollars: 0.5 });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("not_json");
    expect(r.attempts).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it("an over-estimate inflates the next attempt's estimate, refusing it when it no longer fits", async () => {
    // The first turn settles just inside the ceiling at ~2.4x its estimate. The echoed
    // reply then grows the prompt, so attempt 2 priced at 2.4x no longer fits — the run
    // stops instead of spending another ceiling's worth on the same mis-modelled prompt.
    const { provider, requests } = pricedProvider(
      [
        textTurn("I will not answer in JSON. ".repeat(170), {
          input: 10,
          output: 10,
          cost: 0.047,
        }),
        textTurn(VALID_JSON, { input: 10, output: 10, cost: 0 }),
      ],
      PAID,
    );
    const r = await designManifest({
      provider,
      description: "desc",
      maxTokens: 1000,
      maxRequestDollars: 0.05,
    });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("request_cost_ceiling");
    expect(requests).toHaveLength(1);
    expect(r.attempts).toBe(2);
  });

  it("an over-estimate that still fits lets the next attempt through", async () => {
    const { provider, requests } = pricedProvider(
      [
        textTurn("not json", { input: 10, output: 10, cost: 0.03 }),
        textTurn(VALID_JSON, { input: 10, output: 10, cost: 0.03 }),
      ],
      PAID,
    );
    const r = await designManifest({
      provider,
      description: "desc",
      maxTokens: 1000,
      maxRequestDollars: 1,
    });
    expect(r.ok).toBe(true);
    expect(requests).toHaveLength(2);
  });
});
