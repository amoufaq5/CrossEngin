import type {
  CompletionChunk,
  CompletionRequest,
  LlmMessage,
  Usage,
} from "@crossengin/ai-providers";
import {
  AnthropicProvider,
  isAnthropicModel,
  type AnthropicModel,
} from "@crossengin/ai-providers-anthropic";
import {
  OpenAiProvider,
  isOpenAiChatModel,
  type OpenAiChatModel,
} from "@crossengin/ai-providers-openai";
import {
  ManifestSchema,
  manifestHash,
  tryValidateManifest,
  type Manifest,
} from "@crossengin/kernel/manifest";

export interface DesignCompletionProvider {
  complete(req: CompletionRequest): AsyncIterable<CompletionChunk>;
}

export interface DesignUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface DesignResult {
  ok: boolean;
  manifest: Record<string, unknown> | null;
  manifestHash: string | null;
  issues: readonly string[];
  attempts: number;
  providerLabel: string | null;
  usage: DesignUsage | null;
}

export type DesignPhase = "generating" | "validating" | "retrying";

export interface DesignProgress {
  readonly phase: DesignPhase;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly outputChars: number;
  readonly issues: readonly string[];
}

export type DesignProgressListener = (progress: DesignProgress) => void;

export type ManifestDesigner = (input: {
  description: string;
  name?: string;
  onProgress?: DesignProgressListener;
}) => Promise<DesignResult>;

export const MAX_DESIGN_DESCRIPTION_CHARS = 4000;
export const MAX_DESIGN_ATTEMPTS = 3;
export const MAX_DESIGN_RESPONSE_CHARS = 262144;
export const DESIGN_PROGRESS_CHARS_STEP = 400;

const DEFAULT_DESIGN_MAX_TOKENS = 8192;
const MAX_FEEDBACK_ISSUES = 10;
const MAX_ASSISTANT_ECHO_CHARS = 4000;
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

export const DESIGN_EXAMPLE_MANIFEST: Record<string, unknown> = {
  manifestVersion: "1.0",
  meta: {
    name: "Field Service",
    slug: "generated/field-service",
    version: "0.1.0",
    description: "Work-order tracking for a field service business.",
  },
  entities: [
    {
      name: "Customer",
      fields: [
        { name: "display_name", type: { kind: "text", maxLength: 200 }, required: true },
        { name: "contact_email", type: { kind: "email" }, classification: "pii" },
      ],
      traits: ["auditable"],
    },
    {
      name: "WorkOrder",
      fields: [
        { name: "title", type: { kind: "text", maxLength: 200 }, required: true },
        { name: "status", type: { kind: "enum", values: ["open", "in_progress", "closed"] } },
        { name: "customer", type: { kind: "reference", target: "Customer" }, required: true },
        {
          name: "quoted_price",
          type: { kind: "decimal", precision: 12, scale: 2 },
          classification: "commercial_sensitive",
        },
      ],
      traits: ["auditable"],
    },
  ],
  relations: [
    { kind: "many_to_one", from: "WorkOrder", field: "customer", to: "Customer", onDelete: "restrict" },
  ],
  roles: {
    app_admin: {
      name: "app_admin",
      label: { en: "Administrator" },
      description: "Full access to every entity.",
    },
    app_user: {
      name: "app_user",
      label: { en: "Staff User" },
      description: "Day-to-day operational access.",
    },
  },
  permissions: {
    Customer: {
      list: { roles: ["app_admin", "app_user"] },
      read: { roles: ["app_admin", "app_user"] },
      create: { roles: ["app_admin", "app_user"] },
      update: { roles: ["app_admin"] },
      delete: { roles: ["app_admin"] },
    },
    WorkOrder: {
      list: { roles: ["app_admin", "app_user"] },
      read: { roles: ["app_admin", "app_user"] },
      create: { roles: ["app_admin", "app_user"] },
      update: { roles: ["app_admin", "app_user"] },
      delete: { roles: ["app_admin"] },
    },
  },
};

export const DESIGN_SYSTEM_PROMPT: string = [
  "You are the CrossEngin AI Architect. You turn a natural-language business description into exactly one CrossEngin Manifest.",
  "Respond with ONLY a single JSON object — no prose, no markdown, no code fences.",
  "",
  "Manifest spec:",
  '- manifestVersion: the literal string "1.0".',
  '- meta: { name, slug (kebab-case path like "generated/field-service"), version (semver like "0.1.0"), description? }.',
  '- entities: array of { name (PascalCase), fields (at least 1), traits? }. Give every entity the "auditable" trait.',
  "- Each field: { name (snake_case), type, required?, classification? }.",
  "- Field type kinds: text {maxLength?}, long_text, integer {min?, max?}, decimal {precision, scale}, boolean, date, datetime, uuid, enum {values: [...]}, reference {target: EntityName}, json, email, phone, url, currency_amount.",
  '- Classify sensitive fields: "pii" (emails, names, addresses), "phi" (health data), "commercial_sensitive" (costs, margins, prices), "regulated". Any "phi"/"regulated" field REQUIRES its entity to carry the "auditable" trait.',
  '- relations: array of { kind: "many_to_one", from: EntityName, field: field_name, to: EntityName, onDelete: "restrict"|"cascade"|"set_null" } — one per reference field. Many-to-many associations use { kind: "many_to_many", left, right }.',
  "- roles: record keyed by role name (snake_case); each value { name (MUST equal its record key), label: { en: string }, description }.",
  "- permissions: record keyed by entity name; each value { list, read, create, update, delete }, each of those { roles: [...] }. Grant only roles declared in roles, for entities declared in entities.",
  "- Every reference target, relation endpoint, permission entity, and granted role must resolve to something declared in the same manifest.",
  "",
  "Example of a complete valid manifest:",
  JSON.stringify(DESIGN_EXAMPLE_MANIFEST, null, 2),
].join("\n");

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/```[A-Za-z0-9_-]*/g, "");
  const start = stripped.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(stripped.slice(start, i + 1));
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function normalizeGeneratedManifest(
  manifest: Record<string, unknown>,
  opts?: { name?: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...manifest };
  if (out["manifestVersion"] === undefined) out["manifestVersion"] = "1.0";
  const rawMeta = out["meta"];
  const meta: Record<string, unknown> =
    typeof rawMeta === "object" && rawMeta !== null && !Array.isArray(rawMeta)
      ? { ...(rawMeta as Record<string, unknown>) }
      : {};
  const existingName = meta["name"];
  const name =
    typeof existingName === "string" && existingName.length > 0
      ? existingName
      : (opts?.name ?? "Generated Application");
  meta["name"] = name;
  const slug = meta["slug"];
  if (typeof slug !== "string" || !SLUG_REGEX.test(slug)) {
    meta["slug"] = slugify(name);
  }
  const version = meta["version"];
  if (typeof version !== "string" || !SEMVER_REGEX.test(version)) {
    meta["version"] = "0.1.0";
  }
  out["meta"] = meta;
  return out;
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? `generated/${s}` : "generated/app";
}

function addUsage(current: DesignUsage | null, usage: Usage): DesignUsage {
  return {
    inputTokens: (current?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + usage.outputTokens,
    cost: (current?.cost ?? 0) + usage.cost,
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function correctiveMessage(issues: readonly string[]): string {
  return [
    "That manifest is not valid. Fix these issues and respond again with ONLY the corrected JSON object — no prose, no code fences:",
    ...issues.map((issue) => `- ${issue}`),
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Grafts the deployment's operator roles (the roles allowed to design/activate) into a
 * generated manifest: without this, activating a system whose AI-invented roles don't
 * include the operator's own role would sever the operator from the very API they created.
 * Each ensured role is added to `roles` and appended to every role-bearing permission grant.
 */
export function ensureRolesInManifest(
  manifest: Record<string, unknown>,
  ensureRoles: readonly string[],
): Record<string, unknown> {
  if (ensureRoles.length === 0) return manifest;
  const out: Record<string, unknown> = { ...manifest };
  const roles: Record<string, unknown> = isRecord(out["roles"]) ? { ...(out["roles"] as Record<string, unknown>) } : {};
  for (const role of ensureRoles) {
    if (!isRecord(roles[role])) {
      roles[role] = { name: role, label: { en: role }, description: "Deployment operator role (auto-granted)." };
    }
  }
  out["roles"] = roles;
  const permissions: Record<string, unknown> = isRecord(out["permissions"])
    ? { ...(out["permissions"] as Record<string, unknown>) }
    : {};
  const entityNames: string[] = Array.isArray(out["entities"])
    ? (out["entities"] as unknown[])
        .map((e) => (isRecord(e) && typeof e["name"] === "string" ? e["name"] : null))
        .filter((n): n is string => n !== null)
    : Object.keys(isRecord(out["entities"]) ? (out["entities"] as Record<string, unknown>) : {});
  for (const entityName of entityNames) {
    const entityPerms: Record<string, unknown> = isRecord(permissions[entityName])
      ? { ...(permissions[entityName] as Record<string, unknown>) }
      : Object.fromEntries(["list", "read", "create", "update", "delete"].map((op) => [op, { roles: [] }]));
    const graftGrant = (grant: unknown): unknown => {
      if (!isRecord(grant) || !Array.isArray(grant["roles"])) return grant;
      const merged = [...(grant["roles"] as unknown[])];
      for (const role of ensureRoles) {
        if (!merged.includes(role)) merged.push(role);
      }
      return { ...grant, roles: merged };
    };
    for (const [op, grant] of Object.entries(entityPerms)) {
      // `transitions` is a record of named grants (lifecycle endpoints); `fields` is
      // deliberately untouched so grafted roles never gain field-level reads and
      // classification redaction stays fail-closed for them.
      if (op === "transitions" && isRecord(grant)) {
        entityPerms[op] = Object.fromEntries(
          Object.entries(grant).map(([name, t]) => [name, graftGrant(t)]),
        );
        continue;
      }
      entityPerms[op] = graftGrant(grant);
    }
    permissions[entityName] = entityPerms;
  }
  out["permissions"] = permissions;
  return out;
}

export async function designManifest(opts: {
  provider: DesignCompletionProvider;
  description: string;
  name?: string;
  model?: string;
  maxTokens?: number;
  maxAttempts?: number;
  providerLabel?: string | null;
  ensureRoles?: readonly string[];
  onProgress?: DesignProgressListener;
}): Promise<DesignResult> {
  const providerLabel = opts.providerLabel ?? null;
  const maxAttempts = opts.maxAttempts ?? MAX_DESIGN_ATTEMPTS;
  const maxTokens = opts.maxTokens ?? DEFAULT_DESIGN_MAX_TOKENS;
  const onProgress = opts.onProgress;

  const emit = (progress: DesignProgress): void => {
    if (onProgress === undefined) return;
    try {
      onProgress(progress);
    } catch {
      // Progress is observational: a caller's listener must never abort a design run.
    }
  };

  if (opts.description.length > MAX_DESIGN_DESCRIPTION_CHARS) {
    return {
      ok: false,
      manifest: null,
      manifestHash: null,
      issues: [
        `description is ${opts.description.length} chars; the limit is ${MAX_DESIGN_DESCRIPTION_CHARS}`,
      ],
      attempts: 0,
      providerLabel,
      usage: null,
    };
  }

  const userPrompt = [
    "Design a CrossEngin manifest for this business:",
    "",
    opts.description,
    ...(opts.name !== undefined ? ["", `Application name: ${opts.name}`] : []),
  ].join("\n");
  const messages: LlmMessage[] = [
    { role: "system", content: DESIGN_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];
  const sessionId = `design-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  let attempts = 0;
  let issues: readonly string[] = [];
  let usage: DesignUsage | null = null;

  while (attempts < maxAttempts) {
    attempts += 1;
    const attemptNumber = attempts;
    const emitRetrying = (reason: readonly string[], outputChars: number): void => {
      if (attemptNumber >= maxAttempts) return;
      emit({
        phase: "retrying",
        attempt: attemptNumber,
        maxAttempts,
        outputChars,
        issues: reason,
      });
    };
    emit({
      phase: "generating",
      attempt: attemptNumber,
      maxAttempts,
      outputChars: 0,
      issues: [],
    });
    const request: CompletionRequest = {
      task: "planner",
      messages: [...messages],
      maxTokens,
      jsonMode: true,
      tenantId: "operate-design",
      sessionId,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    };

    let text = "";
    let oversized = false;
    let lastEmittedChars = 0;
    try {
      for await (const chunk of opts.provider.complete(request)) {
        if (chunk.kind === "text") {
          text += chunk.text;
          if (text.length > MAX_DESIGN_RESPONSE_CHARS) {
            oversized = true;
            break;
          }
          if (text.length - lastEmittedChars >= DESIGN_PROGRESS_CHARS_STEP) {
            lastEmittedChars = text.length;
            emit({
              phase: "generating",
              attempt: attemptNumber,
              maxAttempts,
              outputChars: text.length,
              issues: [],
            });
          }
        } else if (chunk.kind === "usage_final") {
          usage = addUsage(usage, chunk.usage);
        }
      }
    } catch (err) {
      issues = [`provider error: ${err instanceof Error ? err.message : String(err)}`];
      emitRetrying(issues, text.length);
      continue;
    }

    if (oversized) {
      issues = [`model response exceeded ${MAX_DESIGN_RESPONSE_CHARS} chars`];
      emitRetrying(issues, text.length);
      messages.push({
        role: "user",
        content:
          "Your previous response was too long. Respond with ONLY one compact JSON manifest object.",
      });
      continue;
    }

    const extracted = extractJsonObject(text);
    if (extracted === null) {
      issues = ["model output did not contain a parseable JSON object"];
      emitRetrying(issues, text.length);
      messages.push({ role: "assistant", content: truncate(text, MAX_ASSISTANT_ECHO_CHARS) });
      messages.push({
        role: "user",
        content:
          "Your previous reply did not contain a single parseable JSON object. Respond with ONLY one JSON object — no prose, no code fences.",
      });
      continue;
    }

    emit({
      phase: "validating",
      attempt: attemptNumber,
      maxAttempts,
      outputChars: text.length,
      issues: [],
    });

    const normalized = ensureRolesInManifest(
      normalizeGeneratedManifest(extracted, opts.name !== undefined ? { name: opts.name } : {}),
      opts.ensureRoles ?? [],
    );
    const parsed = ManifestSchema.safeParse(normalized);
    if (!parsed.success) {
      issues = parsed.error.issues
        .slice(0, MAX_FEEDBACK_ISSUES)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      emitRetrying(issues, text.length);
      messages.push({ role: "assistant", content: truncate(text, MAX_ASSISTANT_ECHO_CHARS) });
      messages.push({ role: "user", content: correctiveMessage(issues) });
      continue;
    }

    const manifest: Manifest = parsed.data;
    try {
      const result = tryValidateManifest(manifest);
      if (result.ok) {
        return {
          ok: true,
          manifest: manifest as unknown as Record<string, unknown>,
          manifestHash: manifestHash(manifest),
          issues: [],
          attempts,
          providerLabel,
          usage,
        };
      }
      issues = result.errors.slice(0, MAX_FEEDBACK_ISSUES).map((e) => e.message);
    } catch (err) {
      // validateManifest throws non-ManifestValidationError kinds (e.g. cycle errors) past tryValidateManifest
      issues = [err instanceof Error ? err.message : String(err)];
    }
    emitRetrying(issues, text.length);
    messages.push({ role: "assistant", content: truncate(text, MAX_ASSISTANT_ECHO_CHARS) });
    messages.push({ role: "user", content: correctiveMessage(issues) });
  }

  return {
    ok: false,
    manifest: null,
    manifestHash: null,
    issues,
    attempts,
    providerLabel,
    usage,
  };
}

export function buildDesignDesigner(opts: {
  provider: DesignCompletionProvider;
  model?: string;
  maxTokens?: number;
  providerLabel?: string | null;
  ensureRoles?: readonly string[];
  onProgress?: DesignProgressListener;
}): ManifestDesigner {
  return async (input: {
    description: string;
    name?: string;
    onProgress?: DesignProgressListener;
  }): Promise<DesignResult> => {
    // A per-call listener replaces the builder-level one rather than composing with it,
    // so one invocation's progress never leaks into another caller's stream.
    const listener = input.onProgress ?? opts.onProgress;
    return designManifest({
      provider: opts.provider,
      description: input.description,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.providerLabel !== undefined ? { providerLabel: opts.providerLabel } : {}),
      ...(opts.ensureRoles !== undefined ? { ensureRoles: opts.ensureRoles } : {}),
      ...(listener !== undefined ? { onProgress: listener } : {}),
    });
  };
}

export function buildDesignProviderFromEnv(
  env: NodeJS.ProcessEnv,
  opts?: { model?: string },
): { provider: DesignCompletionProvider; providerLabel: string; model: string } | null {
  const anthropicKey = env["ANTHROPIC_API_KEY"];
  if (anthropicKey !== undefined && anthropicKey.length > 0) {
    const model: AnthropicModel =
      opts?.model !== undefined && isAnthropicModel(opts.model) ? opts.model : "claude-sonnet-4-6";
    const provider = new AnthropicProvider({ apiKey: anthropicKey, defaultModel: model });
    return { provider, providerLabel: `anthropic/${model}`, model };
  }
  const openaiKey = env["OPENAI_API_KEY"];
  if (openaiKey !== undefined && openaiKey.length > 0) {
    const model: OpenAiChatModel =
      opts?.model !== undefined && isOpenAiChatModel(opts.model) ? opts.model : "gpt-4o";
    const baseUrl = env["OPENAI_BASE_URL"];
    const provider = new OpenAiProvider({
      apiKey: openaiKey,
      defaultModel: model,
      ...(baseUrl !== undefined && baseUrl.length > 0 ? { baseUrl } : {}),
    });
    return { provider, providerLabel: `openai/${model}`, model };
  }
  return null;
}
