import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
import {
  ManifestSchema,
  resolveManifest,
  tryValidateManifest,
  type Manifest,
} from "@crossengin/kernel/manifest";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import { stripComments } from "@crossengin/testing/strategy";

import {
  DESIGN_EXAMPLE_MANIFEST,
  parentLineageIssues,
  DESIGN_FAILURE_FAULT,
  DESIGN_FAILURE_KINDS,
  DESIGN_FAULTS,
  DESIGN_PROGRESS_CHARS_STEP,
  MAX_DESIGN_ATTEMPTS,
  MAX_DESIGN_DESCRIPTION_CHARS,
  MAX_DESIGN_RESPONSE_CHARS,
  buildDesignDesigner,
  buildDesignProviderFromEnv,
  buildDesignSystemPrompt,
  designManifest,
  ensureRolesInManifest,
  extractJsonObject,
  normalizeGeneratedManifest,
  type DesignCompletionProvider,
  type DesignProgress,
  type DesignSpend,
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

const DESIGN_TENANT = "00000000-0000-4000-8000-0000000000d1";
const VALID_JSON = JSON.stringify(DESIGN_EXAMPLE_MANIFEST);

/**
 * The example with its one reference aimed at an entity that does not exist — the fixture seven
 * tests use to reach the cross-validation arm.
 *
 * It **throws** rather than returning the manifest unchanged when it cannot find the field to
 * break, and that is the whole point of the guard: the previous version looked for `WorkOrder`
 * behind an `if (target !== undefined)`, so renaming the example's entity turned it into a silent
 * no-op and seven tests went on passing while asserting the opposite of their own titles. A
 * fixture that cannot produce the condition it is named for must fail, not pass.
 */
function brokenManifestJson(): string {
  const clone = JSON.parse(VALID_JSON) as Record<string, unknown>;
  const entities = clone["entities"] as {
    name: string;
    fields: { name: string; type: { kind: string; target?: string } }[];
  }[];
  const visit = entities.find((e) => e.name === "ServiceVisit");
  const customerField = visit?.fields.find((f) => f.name === "customer");
  if (customerField?.type.target === undefined) {
    throw new Error(
      "brokenManifestJson: no ServiceVisit.customer reference field to break — " +
        "DESIGN_EXAMPLE_MANIFEST changed shape and this fixture no longer breaks anything",
    );
  }
  customerField.type.target = "Missing";
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

/** The example as a child of the given pack: the shape the with-parent prompt asks for. */
function exampleExtending(slug: string): Manifest {
  return ManifestSchema.parse({
    ...DESIGN_EXAMPLE_MANIFEST,
    meta: { ...(DESIGN_EXAMPLE_MANIFEST["meta"] as Record<string, unknown>), extends: [slug] },
  });
}

describe("DESIGN_EXAMPLE_MANIFEST fixture", () => {
  it("parses under ManifestSchema and passes kernel cross-validation", () => {
    const parsed = ManifestSchema.parse(DESIGN_EXAMPLE_MANIFEST);
    expect(tryValidateManifest(parsed)).toEqual({ ok: true });
  });

  it("is embedded verbatim in the prompt, with and without a parent", () => {
    const json = JSON.stringify(DESIGN_EXAMPLE_MANIFEST, null, 2);
    expect(buildDesignSystemPrompt({ parentPack: null })).toContain(json);
    expect(
      buildDesignSystemPrompt({ parentPack: { slug: "operate-erp/core", entityNames: ["Invoice"] } }),
    ).toContain(json);
    expect(buildDesignSystemPrompt({ parentPack: null })).toContain("ONLY a single JSON object");
  });

  it("declares a lifecycle whose transitions are all granted", () => {
    const parsed = ManifestSchema.parse(DESIGN_EXAMPLE_MANIFEST);
    const workflow = parsed.workflows?.["service_visit_lifecycle"];
    expect(workflow?.kind).toBe("entityLifecycle");
    if (workflow?.kind !== "entityLifecycle") throw new Error("expected an entityLifecycle");
    expect(workflow.entity).toBe("ServiceVisit");
    expect(workflow.stateField).toBe("status");
    const granted = Object.keys(parsed.permissions?.["ServiceVisit"]?.transitions ?? {}).sort();
    expect(granted).toEqual(workflow.transitions.map((t) => t.name).sort());
  });

  // The state column's enum values are the states the store writes into it. Nothing in the kernel
  // compares the two, so a worked example that got it wrong would teach the model a value set no
  // transition can satisfy.
  it("gives the state field an enum covering exactly the declared states", () => {
    const parsed = ManifestSchema.parse(DESIGN_EXAMPLE_MANIFEST);
    const workflow = parsed.workflows?.["service_visit_lifecycle"];
    if (workflow?.kind !== "entityLifecycle") throw new Error("expected an entityLifecycle");
    const entity = parsed.entities?.find((e) => e.name === workflow.entity);
    const field = entity?.fields.find((f) => f.name === workflow.stateField);
    expect(field?.type.kind).toBe("enum");
    const values = field?.type.kind === "enum" ? [...field.type.values].sort() : [];
    expect(values).toEqual(workflow.states.map((s) => s.name).sort());
  });

  // Every entity name in the example is outside the seven shipped packs, so the example never
  // contradicts the "do not reuse a parent entity name" list the with-parent prompt prints.
  it("declares no entity name that erp-core already declares", () => {
    const core = buildErpCorePack();
    const parentNames = new Set((core.entities ?? []).map((e) => e.name));
    const parsed = ManifestSchema.parse(DESIGN_EXAMPLE_MANIFEST);
    const collisions = (parsed.entities ?? [])
      .map((e) => e.name)
      .filter((name) => parentNames.has(name));
    expect(collisions).toEqual([]);
  });

  // The end-to-end proof that what the with-parent prompt asks for is a thing the platform
  // accepts: the example plus `extends` validates on its own (which is all `designManifest`
  // checks), resolves against the real pack, and the merged result validates too.
  it("validates as a child of the real erp-core pack, before and after resolution", async () => {
    const core = buildErpCorePack();
    const child = exampleExtending(core.meta.slug);
    expect(tryValidateManifest(child)).toEqual({ ok: true });

    const resolved = await resolveManifest(child, {
      registry: {
        getManifest: async (id): Promise<Manifest | null> =>
          id === core.meta.slug ? core : null,
      },
    });
    expect(tryValidateManifest(resolved)).toEqual({ ok: true });
    expect(resolved.meta.extends).toBeUndefined();
    expect(resolved.meta.manifestResolution?.parents.map((p) => p.slug)).toEqual([core.meta.slug]);
    // The child's two entities and its workflow are added to the parent's, not substituted for them.
    expect((resolved.entities ?? []).length).toBe((core.entities ?? []).length + 2);
    expect(Object.keys(resolved.workflows ?? {}).length).toBe(
      Object.keys(core.workflows ?? {}).length + 1,
    );
    expect((resolved.entities ?? []).map((e) => e.name)).toContain("Invoice");
  });

  // Why the with-parent prompt prints the parent's entity names at all: this is the one rule in it
  // that `designManifest`'s retry loop cannot enforce. A colliding child passes every check the
  // design loop makes and throws two layers later, at resolution, after a reviewer approved it.
  it("shows an entity-name collision is invisible to the design loop and fatal at resolution", async () => {
    const core = buildErpCorePack();
    const colliding = ManifestSchema.parse({
      manifestVersion: "1.0",
      meta: {
        name: "Collides",
        slug: "generated/collides",
        version: "0.1.0",
        extends: [core.meta.slug],
      },
      entities: [
        {
          name: "Invoice",
          fields: [{ name: "memo", type: { kind: "text", maxLength: 20 } }],
          traits: ["auditable"],
        },
      ],
      roles: { app_admin: { name: "app_admin", label: { en: "A" }, description: "d" } },
      permissions: { Invoice: { list: { roles: ["app_admin"] } } },
    });
    expect(tryValidateManifest(colliding)).toEqual({ ok: true });

    await expect(
      resolveManifest(colliding, {
        registry: {
          getManifest: async (id): Promise<Manifest | null> =>
            id === core.meta.slug ? core : null,
        },
      }),
    ).rejects.toThrow(/already exists in an inherited manifest/);
  });
});

describe("buildDesignSystemPrompt", () => {
  const CORE_SLUG = "operate-erp/core";
  const parentPack = { slug: CORE_SLUG, entityNames: ["Invoice", "Payment", "WorkOrder"] };

  it("names no parent and no extends instruction when parentPack is null", () => {
    const prompt = buildDesignSystemPrompt({ parentPack: null });
    expect(prompt).not.toContain("extends");
    expect(prompt).not.toContain("overrides");
    expect(prompt).not.toContain(CORE_SLUG);
    expect(prompt).toContain("Example of a complete valid manifest:");
  });

  it("names the parent slug and demands meta.extends when one is given", () => {
    const prompt = buildDesignSystemPrompt({ parentPack });
    expect(prompt).toContain(`This deployment already serves the pack "${CORE_SLUG}"`);
    expect(prompt).toContain(`meta MUST carry extends: ["${CORE_SLUG}"]`);
    expect(prompt).toContain("declare ONLY what the described business ADDS");
  });

  // Read as text so a reworded prompt that drops a rule fails here rather than in production.
  it("states the overrides rule with its consequence, and lists the taken names", () => {
    const prompt = buildDesignSystemPrompt({ parentPack });
    expect(prompt).toContain('"overrides": true');
    expect(prompt).toContain("DISCARDS the parent's version");
    expect(prompt).toContain("Do NOT reuse one of the parent's 3 entity names");
    expect(prompt).toContain("Invoice, Payment, WorkOrder");
  });

  it("states that the child is validated before it is merged", () => {
    const prompt = buildDesignSystemPrompt({ parentPack });
    expect(prompt).toContain("validated on its own BEFORE it is merged");
    expect(prompt).toContain("A field pointing at a parent entity is refused.");
  });

  it("tells the model the example is standalone while its own reply must not be", () => {
    expect(buildDesignSystemPrompt({ parentPack })).toContain(
      "It is standalone — yours must also carry meta.extends",
    );
  });

  it("reports an empty parent entity list as the claim it is", () => {
    const prompt = buildDesignSystemPrompt({ parentPack: { slug: CORE_SLUG, entityNames: [] } });
    expect(prompt).toContain(`meta MUST carry extends: ["${CORE_SLUG}"]`);
    expect(prompt).toContain("Do NOT reuse one of the parent's 0 entity names");
  });

  it("states the workflow shape in both forms", () => {
    for (const prompt of [
      buildDesignSystemPrompt({ parentPack: null }),
      buildDesignSystemPrompt({ parentPack }),
    ]) {
      expect(prompt).toContain('kind: "entityLifecycle"');
      expect(prompt).toContain("stateField MUST name one of that entity's own declared fields");
      expect(prompt).toContain("Declare an enum field on the entity whose values are exactly the state names");
      expect(prompt).toContain("Every from and every to MUST be the name of a declared state");
      // The whole shape, not the prefix: `toContain("permissions.<Entity>.transitions")` alone is
      // satisfied by `…transitionsMUT`, which a mutation check caught.
      expect(prompt).toContain(
        "permissions.<Entity>.transitions = { <transition_name>: { roles: [...] } }",
      );
      expect(prompt).toContain("every state must be reachable from initialState");
      expect(prompt).toContain('no transition may lead out of a "terminal" state');
    }
  });

  it("stays inside the size budget for the model's context", () => {
    const withParent = buildDesignSystemPrompt({
      parentPack: { slug: CORE_SLUG, entityNames: Array.from({ length: 51 }, (_, i) => `Entity${i}`) },
    });
    // 9668 was twice the 4,834-character spec ADR-0368 measured. P2.2's field-grant syntax and its
    // worked instance in the example cost 1,223 more (8,749 → 9,972 with a 51-name parent), about
    // 350 input tokens per attempt at the estimator's 3.5 chars/token — the price of a design whose
    // classified fields someone can read.
    expect(buildDesignSystemPrompt({ parentPack: null }).length).toBeLessThan(10_500);
    expect(withParent.length).toBeLessThan(10_500);
    expect(withParent.length).toBeGreaterThan(buildDesignSystemPrompt({ parentPack: null }).length);
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

  // The two keys the prompt newly asks the model for. Both rewriters copy by spread, so neither
  // drops a top-level key nor a meta key — but the prompt change is inert if either ever does,
  // and `ManifestSchema` strips unknown keys, so these are the fences for that whole path.
  it("keeps a workflows key the model supplied", () => {
    const workflows = DESIGN_EXAMPLE_MANIFEST["workflows"];
    const out = normalizeGeneratedManifest({ ...DESIGN_EXAMPLE_MANIFEST }, { name: "X" });
    expect(out["workflows"]).toEqual(workflows);
  });

  it("keeps meta.extends while still repairing the rest of meta", () => {
    const out = normalizeGeneratedManifest({
      meta: { name: "Clinic", slug: "NOT A SLUG", version: "v9", extends: ["operate-erp/core"] },
    });
    expect(out["meta"]).toEqual({
      name: "Clinic",
      slug: "generated/clinic",
      version: "0.1.0",
      extends: ["operate-erp/core"],
    });
  });
});

describe("the model's reply survives the rewriters and the schema", () => {
  // End to end over the two rewriters plus `ManifestSchema`, because that is the whole path
  // between what the model says and what `tryValidateManifest` sees.
  const reply: Record<string, unknown> = {
    ...DESIGN_EXAMPLE_MANIFEST,
    meta: {
      ...(DESIGN_EXAMPLE_MANIFEST["meta"] as Record<string, unknown>),
      extends: ["operate-erp/core"],
    },
  };

  it("carries workflows and meta.extends through to the parsed manifest", () => {
    const rewritten = ensureRolesInManifest(normalizeGeneratedManifest(reply, { name: "X" }), [
      "erp_admin",
    ]);
    const parsed = ManifestSchema.parse(rewritten);
    expect(parsed.meta.extends).toEqual(["operate-erp/core"]);
    expect(Object.keys(parsed.workflows ?? {})).toEqual(["service_visit_lifecycle"]);
    expect(tryValidateManifest(parsed)).toEqual({ ok: true });
  });

  it("grafts the operator role into the transition grants too", () => {
    const rewritten = ensureRolesInManifest(normalizeGeneratedManifest(reply, { name: "X" }), [
      "erp_admin",
    ]);
    const parsed = ManifestSchema.parse(rewritten);
    expect(parsed.permissions?.["ServiceVisit"]?.transitions).toEqual({
      start: { roles: ["app_admin", "app_user", "erp_admin"] },
      close: { roles: ["app_admin", "erp_admin"] },
    });
  });
});

describe("designManifest — happy path", () => {
  it("accepts a valid fenced manifest on the first attempt", async () => {
    const { provider, requests } = scriptedProvider([
      textTurn("```json\n" + VALID_JSON + "\n```"),
    ]);
    const result = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "a field service business" });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.issues).toEqual([]);
    expect(result.manifest?.["manifestVersion"]).toBe("1.0");
    expect(requests).toHaveLength(1);
  });

  it("sends the DESIGN system prompt, planner task, jsonMode, and default maxTokens", async () => {
    const { provider, requests } = scriptedProvider([textTurn(VALID_JSON)]);
    await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc" });
    const req = requests[0];
    expect(req?.task).toBe("planner");
    expect(req?.jsonMode).toBe(true);
    expect(req?.maxTokens).toBe(8192);
    expect(req?.messages[0]).toEqual({
      role: "system",
      content: buildDesignSystemPrompt({ parentPack: null }),
    });
    expect(req?.messages[1]?.content).toContain("desc");
  });

  it("threads model and name into the request", async () => {
    const { provider, requests } = scriptedProvider([textTurn(VALID_JSON)]);
    await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", name: "Acme", model: "claude-opus-4-7" });
    expect(requests[0]?.model).toBe("claude-opus-4-7");
    expect(requests[0]?.messages[1]?.content).toContain("Application name: Acme");
  });

  it("captures usage from usage_final and reports the providerLabel", async () => {
    const { provider } = scriptedProvider([
      textTurn(VALID_JSON, { input: 100, output: 50, cost: 0.01 }),
    ]);
    const result = await designManifest({ tenantId: DESIGN_TENANT,
      provider,
      parentPack: null,
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
    const result = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", name: "Bare App" });
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
    const result = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc" });
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
    const result = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc" });
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
    const result = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc" });
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
    const result = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc" });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(requests[1]?.messages).toHaveLength(2);
  });

  it("gives up after maxAttempts when every response is invalid", async () => {
    const { provider, requests } = scriptedProvider([textTurn(brokenManifestJson())]);
    const result = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc" });
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
    const result = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", maxAttempts: 2 });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(requests).toHaveLength(2);
  });

  it("accumulates usage across attempts", async () => {
    const { provider } = scriptedProvider([
      textTurn(brokenManifestJson(), { input: 100, output: 40, cost: 0.02 }),
      textTurn(VALID_JSON, { input: 200, output: 60, cost: 0.03 }),
    ]);
    const result = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc" });
    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 100, cost: 0.05 });
  });
});

describe("designManifest — size limits", () => {
  it("rejects an oversized description without calling the provider", async () => {
    const { provider, requests } = scriptedProvider([textTurn(VALID_JSON)]);
    const result = await designManifest({ tenantId: DESIGN_TENANT,
      provider,
      parentPack: null,
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
    const result = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", maxAttempts: 1 });
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
      parentPack: null,
      tenantPseudonymFor: null,
      model: "claude-opus-4-7",
      maxTokens: 4096,
      providerLabel: "anthropic/claude-opus-4-7",
    });
    const result = await designer({ tenantId: DESIGN_TENANT, description: "desc", name: "Closed Over" });
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
    // `transitions` is a record of named grants rather than a grant, so it is walked one level
    // deeper; the loop used to assume every op was a grant, which held only while the example
    // declared no lifecycle. A vacuous pass is impossible here: both arms assert.
    const perms = grafted["permissions"] as Record<string, Record<string, unknown>>;
    let asserted = 0;
    for (const entity of Object.keys(perms)) {
      for (const [op, grant] of Object.entries(perms[entity] ?? {})) {
        if (op === "transitions") {
          const named = grant as Record<string, { roles: string[] }>;
          expect(Object.keys(named).length).toBeGreaterThan(0);
          for (const name of Object.keys(named)) {
            expect(named[name]?.roles).toContain("erp_admin");
            asserted += 1;
          }
          continue;
        }
        if (op === "fields") {
          // A grafted role gains no field-level read and no right to change a value: only the
          // `create` arm moves, because the entity `create` graft would otherwise leave a required
          // field uncreatable by that role (ADR-0348: supplying a value discloses nothing).
          const designed = (DESIGN_EXAMPLE_MANIFEST["permissions"] as Record<string, Record<string, unknown>>)[
            entity
          ]?.["fields"] as Record<string, Record<string, unknown>>;
          const out = grant as Record<string, Record<string, { roles: string[] }>>;
          expect(Object.keys(out)).toEqual(Object.keys(designed));
          for (const [field, perm] of Object.entries(out)) {
            expect(perm["read"]).toEqual(designed[field]?.["read"]);
            expect(perm["update"]).toEqual(designed[field]?.["update"]);
            expect(perm["create"]?.roles).toContain("erp_admin");
            asserted += 1;
          }
          continue;
        }
        expect((grant as { roles: string[] }).roles).toContain("erp_admin");
        asserted += 1;
      }
    }
    // 12 entity and transition grants, plus the example's 2 field grants' create arms.
    expect(asserted).toBe(14);
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
    const result = await designManifest({ tenantId: DESIGN_TENANT,
      provider,
      parentPack: null,
      description: "field service business",
      ensureRoles: ["erp_admin"],
    });
    expect(result.ok).toBe(true);
    const perms = (result.manifest ?? {})["permissions"] as Record<string, Record<string, { roles: string[] }>>;
    expect(perms["ServiceVisit"]?.["update"]?.roles).toContain("erp_admin");
  });
});

describe("ensureRolesInManifest — transition + field grants", () => {
  it("grafts into transition grants and never into a field's read grant", () => {
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
        ServiceVisit: (DESIGN_EXAMPLE_MANIFEST as { permissions: Record<string, unknown> }).permissions["ServiceVisit"],
      },
    };
    const grafted = ensureRolesInManifest(manifest, ["erp_admin"]);
    const perms = grafted["permissions"] as Record<string, Record<string, unknown>>;
    const customer = perms["Customer"] ?? {};
    expect((customer["transitions"] as Record<string, { roles: string[] }>)["archive"]?.roles).toContain("erp_admin");
    const fields = customer["fields"] as Record<string, { read: { roles: string[] } }>;
    expect(fields["contact_email"]?.read.roles).toEqual(["app_admin"]);
    expect(fields["contact_email"]).not.toHaveProperty("create");
    expect((customer["list"] as { roles: string[] }).roles).toContain("erp_admin");
  });

  type FieldPerms = Record<string, Record<string, { roles: string[]; abac?: string }>>;

  function customerWithFields(fields: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const base = JSON.parse(JSON.stringify(DESIGN_EXAMPLE_MANIFEST)) as {
      roles: Record<string, unknown>;
      permissions: Record<string, Record<string, unknown>>;
      entities: Array<{ name: string; fields: Array<Record<string, unknown>> }>;
    };
    const customer = base.permissions["Customer"] ?? {};
    base.permissions["Customer"] = { ...customer, ...extra, fields };
    return base;
  }

  function graftedCustomerFields(manifest: Record<string, unknown>): FieldPerms {
    const grafted = ensureRolesInManifest(manifest, ["erp_admin"]);
    const perms = grafted["permissions"] as Record<string, Record<string, unknown>>;
    return (perms["Customer"]?.["fields"] ?? {}) as FieldPerms;
  }

  it("adds the deployment role to a field's create arm only, leaving read and update as designed", () => {
    const fields = graftedCustomerFields(
      customerWithFields({
        contact_email: {
          read: { roles: ["app_admin", "app_user"] },
          update: { roles: ["app_admin"] },
          create: { roles: ["app_admin", "app_user"] },
        },
      }),
    );
    const email = fields["contact_email"];
    expect(email?.["create"]?.roles).toEqual(["app_admin", "app_user", "erp_admin"]);
    expect(email?.["read"]?.roles).toEqual(["app_admin", "app_user"]);
    expect(email?.["update"]?.roles).toEqual(["app_admin"]);
  });

  it("keeps a spec-compliant required classified field valid once the deployment role is grafted", () => {
    const manifest = customerWithFields({
      contact_email: {
        read: { roles: ["app_admin", "app_user"] },
        update: { roles: ["app_admin"] },
        create: { roles: ["app_admin", "app_user"] },
      },
    });
    const customer = manifest.entities.find((e) => e.name === "Customer");
    const email = customer?.fields.find((f) => f["name"] === "contact_email");
    if (email === undefined) throw new Error("fixture: Customer.contact_email missing");
    email["required"] = true;
    expect(tryValidateManifest(ManifestSchema.parse(manifest))).toEqual({ ok: true });
    const grafted = ensureRolesInManifest(manifest, ["erp_admin"]);
    expect(tryValidateManifest(ManifestSchema.parse(grafted))).toEqual({ ok: true });
  });

  it("materialises the create arm from update keeping only roles the entity create grant names", () => {
    const manifest = customerWithFields(
      {
        contact_email: {
          read: { roles: ["app_admin", "app_user", "editor"] },
          update: { roles: ["app_admin", "editor"] },
        },
      },
      {
        read: { roles: ["app_admin", "app_user", "editor"] },
        update: { roles: ["app_admin", "editor"] },
      },
    );
    manifest.roles["editor"] = { name: "editor", label: { en: "Editor" }, description: "edits" };
    expect(tryValidateManifest(ManifestSchema.parse(manifest))).toEqual({ ok: true });
    const fields = graftedCustomerFields(manifest);
    expect(fields["contact_email"]?.["create"]?.roles).toEqual(["app_admin", "erp_admin"]);
    expect(fields["contact_email"]?.["update"]?.roles).toEqual(["app_admin", "editor"]);
    const grafted = ensureRolesInManifest(manifest, ["erp_admin"]);
    expect(tryValidateManifest(ManifestSchema.parse(grafted))).toEqual({ ok: true });
  });

  it("leaves a grant carrying an ABAC obligation alone", () => {
    const fields = graftedCustomerFields(
      customerWithFields({
        contact_email: {
          read: { roles: ["app_admin"] },
          create: { roles: ["app_admin"], abac: "own_rows" },
        },
      }),
    );
    expect(fields["contact_email"]?.["create"]).toEqual({ roles: ["app_admin"], abac: "own_rows" });
  });
});

describe("designManifest — progress", () => {
  it("reports generating then validating on a first-try success, with no retrying", async () => {
    const { provider } = scriptedProvider([textTurn(VALID_JSON)]);
    const { events, listener } = collector();
    const result = await designManifest({ tenantId: DESIGN_TENANT,
      provider,
      parentPack: null,
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
    const result = await designManifest({ tenantId: DESIGN_TENANT,
      provider,
      parentPack: null,
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
    await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", maxAttempts: 2, onProgress: listener });
    expect(events.every((e) => e.maxAttempts === 2)).toBe(true);
    expect(events[0]?.attempt).toBe(1);
    expect(new Set(events.map((e) => e.attempt))).toEqual(new Set([1, 2]));
    expect(events.every((e) => e.attempt >= 1)).toBe(true);
  });

  it("never emits retrying after the final attempt fails", async () => {
    const { provider } = scriptedProvider([textTurn(brokenManifestJson())]);
    const { events, listener } = collector();
    const result = await designManifest({ tenantId: DESIGN_TENANT,
      provider,
      parentPack: null,
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
    await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", maxAttempts: 1, onProgress: listener });
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
    await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", onProgress: listener });
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
    const result = await designManifest({ tenantId: DESIGN_TENANT,
      provider,
      parentPack: null,
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
    const result = await designManifest({ tenantId: DESIGN_TENANT,
      provider,
      parentPack: null,
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
    const designer = buildDesignDesigner({ provider, parentPack: null, tenantPseudonymFor: null });
    const { events, listener } = collector();
    const result = await designer({ tenantId: DESIGN_TENANT, description: "desc", onProgress: listener });
    expect(result.ok).toBe(true);
    expect(phaseSequence(events)).toEqual(["generating", "validating"]);
  });

  it("buildDesignDesigner uses the builder listener, and a per-call listener wins", async () => {
    const { provider } = scriptedProvider([textTurn(VALID_JSON)]);
    const builderSink = collector();
    const designer = buildDesignDesigner({ provider, parentPack: null, tenantPseudonymFor: null, onProgress: builderSink.listener });
    await designer({ tenantId: DESIGN_TENANT, description: "desc" });
    expect(builderSink.events.length).toBeGreaterThan(0);

    const before = builderSink.events.length;
    const perCall = collector();
    await designer({ tenantId: DESIGN_TENANT, description: "desc", onProgress: perCall.listener });
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
    const result = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "a field service business" });
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
    return designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", maxAttempts: 1 });
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
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", maxAttempts: 1 });
    expect(r.ok).toBe(true);
    expect(r.failure).toBeNull();
    expect(r.recovery).toBe("surrounding_prose");
  });

  it("recovers a fenced manifest and still reports the fence", async () => {
    const { provider } = mockProvider([textTurn(`\`\`\`json\n${VALID_JSON}\n\`\`\``)]);
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", maxAttempts: 1 });
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
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", maxAttempts: 1 });
    expect(r.failure).toBe("empty_response");
    expect(r.diagnosis[0]?.shape).toBe("empty");
  });

  it("classifies a provider throw as a provider fault, not a model one", async () => {
    const { provider } = mockProvider([new Error("connect ECONNREFUSED")]);
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", maxAttempts: 1 });
    expect(r.failure).toBe("provider_error");
    expect(r.fault).toBe("provider");
    expect(r.diagnosis[0]?.shape).toBeNull();
  });

  it("classifies an over-long description as the caller's fault before any call", async () => {
    const { provider, requests } = mockProvider([textTurn(VALID_JSON)]);
    const r = await designManifest({ tenantId: DESIGN_TENANT,
      provider,
      parentPack: null,
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
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc" });
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
    await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc" });
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
    const out = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc" });
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
    const out = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc" });
    expect(out.ok).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it("tells a truncating model to produce a smaller manifest", async () => {
    const { provider, requests } = mockProvider([
      textTurn(VALID_JSON.slice(0, 200)),
      textTurn(VALID_JSON),
    ]);
    await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc" });
    const corrective = requests[1]?.messages.filter((m) => m.role === "user").at(-1);
    expect(corrective?.content).toContain("smaller manifest");
  });

  it("surfaces the classification on the retrying progress event", async () => {
    const seen: DesignProgress[] = [];
    const { provider } = mockProvider([textTurn("[1, 2, 3]"), textTurn(VALID_JSON)]);
    await designManifest({ tenantId: DESIGN_TENANT,
      provider,
      parentPack: null,
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
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc" });
    expect(r.ok).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("admits a request whose estimate fits under the ceiling", async () => {
    const { provider, requests } = pricedProvider([textTurn(VALID_JSON)], PAID);
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", maxRequestDollars: 1 });
    expect(r.ok).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("refuses to send a request estimated over the ceiling, and does not retry it", async () => {
    const { provider, requests } = pricedProvider([textTurn(VALID_JSON)], PAID);
    const r = await designManifest({ tenantId: DESIGN_TENANT,
      provider,
      parentPack: null,
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
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", maxRequestDollars: 10 });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("request_cost_ceiling");
    expect(r.issues[0]).toContain("no pricing");
    expect(requests).toHaveLength(0);
  });

  it("a free-priced self-hosted provider is never refused by the ceiling", async () => {
    const free: ProviderPricing = { inputPerMillionTokens: 0, outputPerMillionTokens: 0 };
    const { provider } = pricedProvider([textTurn(VALID_JSON)], free);
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", maxRequestDollars: 0 });
    expect(r.ok).toBe(true);
  });

  // A model that writes past its own maxTokens: the pre-flight estimate fits, so the
  // in-flight meter is the only thing that can stop it.
  const RUNAWAY = `{"entities": [${'"x",'.repeat(60_000)}`;

  it("abandons a stream mid-flight once accrued output breaks the ceiling", async () => {
    const { provider } = pricedProvider([chunkedTurn(RUNAWAY, 500), textTurn(VALID_JSON)], PAID);
    const r = await designManifest({ tenantId: DESIGN_TENANT,
      provider,
      parentPack: null,
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
    const r = await designManifest({ tenantId: DESIGN_TENANT,
      provider,
      parentPack: null,
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
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", maxRequestDollars: 0.5 });
    expect(r.ok).toBe(true);
    expect(r.usage?.cost).toBe(5);
    expect(requests).toHaveLength(1);
  });

  it("stops retrying after an actual cost over the ceiling", async () => {
    const { provider, requests } = pricedProvider(
      [textTurn("not json", { input: 10, output: 10, cost: 5 })],
      PAID,
    );
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", maxRequestDollars: 0.5 });
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
    const r = await designManifest({ tenantId: DESIGN_TENANT,
      provider,
      parentPack: null,
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
    const r = await designManifest({ tenantId: DESIGN_TENANT,
      provider,
      parentPack: null,
      description: "desc",
      maxTokens: 1000,
      maxRequestDollars: 1,
    });
    expect(r.ok).toBe(true);
    expect(requests).toHaveLength(2);
  });
});

describe("designManifest — the tenant and the monthly reservation (M-16, M-17)", () => {
  const PAID: ProviderPricing = { inputPerMillionTokens: 3, outputPerMillionTokens: 15 };

  function paid(turns: readonly Turn[]): { provider: DesignCompletionProvider; requests: CompletionRequest[] } {
    const scripted = scriptedProvider(turns);
    return { provider: { complete: scripted.provider.complete, pricing: PAID }, requests: scripted.requests };
  }

  interface Ledger {
    readonly reserved: number[];
    readonly settled: Array<{ reserved: number; actual: number }>;
    readonly spend: DesignSpend;
  }

  function ledger(answer: "reserve" | "refuse" | "throw" = "reserve"): Ledger {
    const reserved: number[] = [];
    const settled: Array<{ reserved: number; actual: number }> = [];
    const spend: DesignSpend = async (dollars) => {
      reserved.push(dollars);
      if (answer === "throw") throw new Error("ledger down");
      if (answer === "refuse") return null;
      return {
        dollars,
        settle: async (actual) => {
          settled.push({ reserved: dollars, actual });
        },
      };
    };
    return { reserved, settled, spend };
  }

  it("names the tenant on every provider request, not a constant", async () => {
    const { provider, requests } = paid([textTurn("[1]"), textTurn(VALID_JSON)]);
    await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc" });
    expect(requests.length).toBeGreaterThan(0);
    for (const req of requests) expect(req.tenantId).toBe(DESIGN_TENANT);
  });

  it("reserves the estimate before the call and settles to the provider's reported cost", async () => {
    const { provider, requests } = paid([textTurn(VALID_JSON, { input: 100, output: 50, cost: 0.0042 })]);
    const l = ledger();
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", spend: l.spend });
    expect(r.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(l.reserved).toHaveLength(1);
    // 8192 output tokens at $15/M bound the estimate from below at $0.12.
    expect(l.reserved[0]).toBeGreaterThan(0.12);
    expect(l.settled).toEqual([{ reserved: l.reserved[0], actual: 0.0042 }]);
  });

  it("sends nothing when the month refuses the reservation, and does not retry", async () => {
    const { provider, requests } = paid([textTurn(VALID_JSON)]);
    const l = ledger("refuse");
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", spend: l.spend });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("monthly_budget_exhausted");
    expect(r.fault).toBe("request");
    expect(r.attempts).toBe(1);
    expect(requests).toHaveLength(0);
    expect(r.issues[0]).toMatch(/cannot absorb/);
  });

  it("refuses rather than spends when the ledger cannot be written", async () => {
    const { provider, requests } = paid([textTurn(VALID_JSON)]);
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", spend: ledger("throw").spend });
    expect(r.failure).toBe("monthly_budget_exhausted");
    expect(r.issues[0]).toMatch(/could not be charged.*no request was sent/);
    expect(requests).toHaveLength(0);
  });

  it("charges an attempt that failed before any output only its input, and one that produced output its reservation", async () => {
    const silent = paid([new Error("ECONNREFUSED")]);
    const l1 = ledger();
    await designManifest({ tenantId: DESIGN_TENANT, provider: silent.provider, parentPack: null, description: "desc", spend: l1.spend, maxAttempts: 1 });
    expect(l1.settled).toHaveLength(1);
    expect(l1.settled[0]!.actual).toBeGreaterThan(0);
    expect(l1.settled[0]!.actual).toBeLessThan(l1.settled[0]!.reserved / 10);

    const partial: Turn = [{ kind: "text", text: '{"meta":' }];
    const broke = scriptedProvider([partial]);
    const brokeProvider: DesignCompletionProvider = {
      pricing: PAID,
      complete: (req) =>
        (async function* (): AsyncGenerator<CompletionChunk> {
          for await (const c of broke.provider.complete(req)) yield c;
          throw new Error("stream reset");
        })(),
    };
    const l2 = ledger();
    await designManifest({ tenantId: DESIGN_TENANT, provider: brokeProvider, parentPack: null, description: "desc", spend: l2.spend, maxAttempts: 1 });
    expect(l2.settled).toEqual([{ reserved: l2.reserved[0], actual: l2.reserved[0] }]);
  });

  it("refuses a run under a monthly ledger when the provider publishes no price", async () => {
    const { provider, requests } = scriptedProvider([textTurn(VALID_JSON)]);
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc", spend: ledger().spend });
    expect(r.failure).toBe("monthly_budget_exhausted");
    expect(requests).toHaveLength(0);
  });
});

describe("buildDesignDesigner — the per-request ceiling and the budget are wired (M-16)", () => {
  const PAID: ProviderPricing = { inputPerMillionTokens: 3, outputPerMillionTokens: 15 };

  it("refuses a request over --ai-max-request-dollars before calling the provider", async () => {
    const scripted = scriptedProvider([textTurn(VALID_JSON)]);
    const designer = buildDesignDesigner({
      provider: { complete: scripted.provider.complete, pricing: PAID },
      parentPack: null,
      tenantPseudonymFor: null,
      maxRequestDollars: 0.01,
    });
    const r = await designer({ tenantId: DESIGN_TENANT, description: "desc" });
    expect(r.failure).toBe("request_cost_ceiling");
    expect(scripted.requests).toHaveLength(0);
  });

  it("charges the tenant it was called for and seeds and feeds that tenant's estimator correction", async () => {
    const scripted = scriptedProvider([textTurn(VALID_JSON, { input: 10, output: 10, cost: 0.001 })]);
    const reservedFor: string[] = [];
    const inflationAsked: string[] = [];
    const observed: Array<{ tenantId: string; ratio: number }> = [];
    const designer = buildDesignDesigner({
      provider: { complete: scripted.provider.complete, pricing: PAID },
      parentPack: null,
      tenantPseudonymFor: null,
      maxRequestDollars: 10,
      budget: {
        reserve: async (tenantId, dollars) => {
          reservedFor.push(tenantId);
          return { dollars, settle: async () => undefined };
        },
        inflationFor: async (tenantId) => {
          inflationAsked.push(tenantId);
          return 4;
        },
        observeInflation: async (tenantId, ratio) => {
          observed.push({ tenantId, ratio });
        },
      },
    });
    const r = await designer({ tenantId: DESIGN_TENANT, description: "desc" });
    expect(r.ok).toBe(true);
    expect(reservedFor).toEqual([DESIGN_TENANT]);
    expect(inflationAsked).toEqual([DESIGN_TENANT]);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.tenantId).toBe(DESIGN_TENANT);
    // The seeded correction raised the estimate, so the realised ratio is below 1/4.
    expect(observed[0]!.ratio).toBeLessThan(0.25);
  });
});

describe("serve() hands the designer the ceilings it is configured with (M-16)", () => {
  // Text, because `serve()` needs a live Postgres to reach and the defect was a wiring one: the
  // designer was built with neither option, and a conditional spread passes the type check whether
  // or not the field is there, so only reading the call site can say it is.
  const src = stripComments(readFileSync(resolve(import.meta.dirname, "./node.ts"), "utf8"));
  const start = src.indexOf("buildDesignDesigner({");
  const call = src.slice(start, src.indexOf("parentPack:", start));

  it("passes --ai-max-request-dollars and the monthly budget to buildDesignDesigner", () => {
    expect(start).toBeGreaterThan(0);
    expect(call).toContain("maxRequestDollars: options.aiMaxRequestDollars");
    expect(call).toContain("{ budget }");
  });

  it("builds the budget before the designer, and no route or job records spend after the fact", () => {
    expect(src.indexOf("const budget =")).toBeGreaterThan(0);
    expect(src.indexOf("const budget =")).toBeLessThan(start);
    expect(src).not.toMatch(/startDesignJob\(\s*\{[^}]*budget/);
    expect(src).not.toContain("maxUsdPerRequest");
  });

  it("passes the provider timeout and a declared price to the provider build, and gates residency", () => {
    // Both now resolve flag-then-environment (ai-model-source.ts), so the build reads the resolved
    // values; reading the flag fields directly would drop OPERATE_AI_PROVIDER_TIMEOUT_MS and
    // OPERATE_AI_MODEL_PRICE, and the second would make the boot refuse a priced model.
    expect(src).toContain("inactivityTimeoutMs: aiTimeoutSetting.value");
    expect(src).toContain("declaredPrice: aiModelPrice");
    expect(src).not.toContain("declaredPrice: options.aiModelPrice");
    expect(src).toContain("maxTokens: aiMaxOutputSetting.value");
    expect(src).toContain("{ providerAdmission }");
    expect(src).toContain("if (pricingDecision.refusal !== null) throw");
  });
});

describe("the design spec teaches the field-grant syntax its classification rule needs (P2.2)", () => {
  // The spec told the model to classify sensitive fields and never said how to grant one, so every
  // AI design classified fields and granted none — and an ungranted classified field falls to the
  // classification default, which no role reads unless the deployment declares one privileged.
  type Grants = Record<string, Record<string, { fields?: Record<string, Record<string, unknown>> }>>;

  function classifiedWithoutGrant(manifest: Record<string, unknown>): string[] {
    const permissions = (manifest["permissions"] ?? {}) as Grants[string];
    const missing: string[] = [];
    for (const entity of (manifest["entities"] ?? []) as Array<{
      name: string;
      fields: Array<{ name: string; classification?: string }>;
    }>) {
      for (const field of entity.fields) {
        if (field.classification === undefined) continue;
        const grant = permissions[entity.name]?.fields?.[field.name];
        if (grant?.["read"] === undefined) missing.push(`${entity.name}.${field.name}`);
      }
    }
    return missing;
  }

  function mockReplying(texts: readonly string[]): {
    provider: DesignCompletionProvider;
    requests: CompletionRequest[];
  } {
    const requests: CompletionRequest[] = [];
    let index = 0;
    const provider = new MockLlmProvider({
      completeBehavior: (req: CompletionRequest): AsyncIterable<CompletionChunk> => {
        requests.push(req);
        const text = texts[Math.min(index, texts.length - 1)] ?? "";
        index += 1;
        return (async function* (): AsyncGenerator<CompletionChunk> {
          yield { kind: "text", text };
        })();
      },
    });
    return { provider, requests };
  }

  it("states the shape and the coherence rules, with and without a parent", () => {
    for (const prompt of [
      buildDesignSystemPrompt({ parentPack: null }),
      buildDesignSystemPrompt({ parentPack: { slug: "operate-erp/core", entityNames: ["Invoice"] } }),
    ]) {
      expect(prompt).toContain(
        "permissions.<Entity>.fields = { <field_name>: { read: { roles: [...] }, update: { roles: [...] }, create?: { roles: [...] } } }",
      );
      expect(prompt).toContain("Give EVERY classified field a field grant");
      expect(prompt).toContain("every update role must also be a read role");
      expect(prompt).toContain("on a required field, create (or update) must name every role");
    }
  });

  it("shows a grant for every field the worked example classifies", () => {
    const parsed = ManifestSchema.parse(DESIGN_EXAMPLE_MANIFEST);
    expect((parsed.entities ?? []).flatMap((e) => e.fields.filter((f) => f.classification !== undefined))).toHaveLength(2);
    expect(classifiedWithoutGrant(DESIGN_EXAMPLE_MANIFEST)).toEqual([]);
    // The create arm is shown once, so the model sees the set-once form as well as the plain one.
    expect(parsed.permissions?.["ServiceVisit"]?.fields?.["quoted_price"]?.create?.roles).toEqual([
      "app_admin",
      "app_user",
    ]);
  });

  it("carries the grants through the design loop when the model follows the example", async () => {
    const { provider, requests } = mockReplying([VALID_JSON]);
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "a field service business" });
    expect(r.ok).toBe(true);
    expect(requests[0]?.messages[0]?.content).toContain("permissions.<Entity>.fields");
    expect(classifiedWithoutGrant(r.manifest ?? {})).toEqual([]);
    const parsed = ManifestSchema.parse(r.manifest);
    expect(tryValidateManifest(parsed)).toEqual({ ok: true });
  });

  it("feeds an incoherent field grant back to the model rather than accepting it", async () => {
    const blind = JSON.parse(VALID_JSON) as Grants & Record<string, unknown>;
    const customer = (blind["permissions"] as Grants[string])["Customer"]!;
    customer.fields = { contact_email: { read: { roles: ["app_admin"] }, update: { roles: ["app_admin", "app_user"] } } };
    // app_user may not update Customer at all, and may not read the field it would overwrite.
    const { provider, requests } = mockReplying([JSON.stringify(blind), VALID_JSON]);
    const r = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: null, description: "desc" });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    const feedback = requests[1]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(feedback).toContain("permissions.Customer.fields.contact_email");
  });
});

describe("a design on a deployment that serves a pack must extend that pack", () => {
  const CORE = { slug: "operate-erp/core", entityNames: ["Invoice", "Account"] } as const;
  const standalone = ManifestSchema.parse(DESIGN_EXAMPLE_MANIFEST);

  it("refuses a design that forgot meta.extends, naming the parent and the consequence", () => {
    // Measured live before this check: a mock returning the example verbatim was stored, reviewed,
    // approved and activated, and the tenant's /v1/invoices then answered 404 — the design had
    // replaced the ERP, because validation ran on the design alone and found it valid standalone.
    const issues = parentLineageIssues(standalone, CORE);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('["operate-erp/core"]');
    expect(issues[0]).toContain("replaces the whole ERP");
  });

  it("refuses a wrong or extra parent, and a reused parent entity without overrides", () => {
    expect(parentLineageIssues(exampleExtending("operate-erp/retail"), CORE)).toHaveLength(1);
    const reused = ManifestSchema.parse({
      ...exampleExtending(CORE.slug),
      entities: [...(exampleExtending(CORE.slug).entities ?? []), { name: "Invoice", fields: [{ name: "note", type: { kind: "text" } }] }],
    });
    const issues = parentLineageIssues(reused, CORE);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("entity Invoice");
    const overridden = ManifestSchema.parse({
      ...reused,
      entities: (reused.entities ?? []).map((e) => (e.name === "Invoice" ? { ...e, overrides: true } : e)),
    });
    expect(parentLineageIssues(overridden, CORE)).toEqual([]);
  });

  it("accepts the exact parent, and asks nothing of a deployment that serves no pack", () => {
    expect(parentLineageIssues(exampleExtending(CORE.slug), CORE)).toEqual([]);
    expect(parentLineageIssues(standalone, null)).toEqual([]);
  });

  it("retries the attempt with the issue as feedback, then succeeds once the model complies", async () => {
    const { provider, requests } = scriptedProvider([
      textTurn(JSON.stringify(DESIGN_EXAMPLE_MANIFEST)),
      textTurn(JSON.stringify(exampleExtending(CORE.slug))),
    ]);
    const result = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: CORE, description: "desc" });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.diagnosis[0]?.failure).toBe("cross_validation_failed");
    const feedback = requests[1]?.messages.at(-1)?.content ?? "";
    expect(feedback).toContain("meta.extends must be exactly");
  });

  it("fails the design rather than storing a replacement when the model never complies", async () => {
    const { provider } = scriptedProvider([textTurn(JSON.stringify(DESIGN_EXAMPLE_MANIFEST))]);
    const result = await designManifest({ tenantId: DESIGN_TENANT, provider, parentPack: CORE, description: "desc" });
    expect(result.ok).toBe(false);
    expect(result.manifest).toBeNull();
    expect(result.attempts).toBe(MAX_DESIGN_ATTEMPTS);
  });
});
