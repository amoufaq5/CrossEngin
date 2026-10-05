import {
  StreamCostMeter,
  admitRequestCost,
  DESIGN_SHAPE_RETRIABILITY,
  classifyDesignOutput,
  reconcileRequestCost,
  type DesignOutputShape,
  type DesignOutputWrapper,
  type PerRequestCostCeiling,
} from "@crossengin/ai-architect-runtime";
import type {
  CompletionChunk,
  CompletionRequest,
  LlmMessage,
  ProviderPricing,
  Usage,
} from "@crossengin/ai-providers";
import {
  AnthropicProvider,
  isAnthropicModel,
  type AnthropicModel,
} from "@crossengin/ai-providers-anthropic";
import {
  DEFAULT_LOCAL_MODEL,
  LocalLlmProvider,
} from "@crossengin/ai-providers-local";
import { OpenAiProvider, isOpenAiChatModel } from "@crossengin/ai-providers-openai";
import {
  ManifestSchema,
  manifestHash,
  tryValidateManifest,
  type Manifest,
} from "@crossengin/kernel/manifest";

export interface DesignCompletionProvider {
  complete(req: CompletionRequest): AsyncIterable<CompletionChunk>;
  /** Present on every real provider; needed to price a request before it is sent. */
  readonly pricing?: ProviderPricing;
}

export interface DesignUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/**
 * Why a design run ended without a manifest. The point of naming these separately is
 * that they are not one operator action: a `model_output` fault means the model could
 * not produce the asked-for *form* at all (swap the model), a `manifest_content` fault
 * means it produced a manifest the platform rejected (fix the description or the
 * prompt), `provider` is a transport failure, and `request` is the operator's own limits.
 */
export const DESIGN_FAILURE_KINDS = [
  "description_too_long",
  "request_cost_ceiling",
  "response_cost_ceiling",
  "response_too_long",
  "provider_error",
  "empty_response",
  "not_json",
  "truncated_json",
  "malformed_json",
  "array_not_object",
  "scalar_not_object",
  "not_a_manifest",
  "schema_invalid",
  "cross_validation_failed",
] as const;
export type DesignFailureKind = (typeof DESIGN_FAILURE_KINDS)[number];

export const DESIGN_FAULTS = ["request", "provider", "model_output", "manifest_content"] as const;
export type DesignFault = (typeof DESIGN_FAULTS)[number];

export const DESIGN_FAILURE_FAULT: Readonly<Record<DesignFailureKind, DesignFault>> = {
  description_too_long: "request",
  request_cost_ceiling: "request",
  response_cost_ceiling: "request",
  provider_error: "provider",
  response_too_long: "model_output",
  empty_response: "model_output",
  not_json: "model_output",
  truncated_json: "model_output",
  malformed_json: "model_output",
  array_not_object: "model_output",
  scalar_not_object: "model_output",
  not_a_manifest: "model_output",
  schema_invalid: "manifest_content",
  cross_validation_failed: "manifest_content",
};

const SHAPE_FAILURE: Readonly<Record<DesignOutputShape, DesignFailureKind | null>> = {
  empty: "empty_response",
  no_json: "not_json",
  truncated_json: "truncated_json",
  malformed_json: "malformed_json",
  array_not_object: "array_not_object",
  scalar_not_object: "scalar_not_object",
  object_not_manifest: "not_a_manifest",
  manifest_shaped_object: null,
};

/** The failure a classified output shape implies, or `null` when the output was readable. */
export function designFailureForShape(shape: DesignOutputShape): DesignFailureKind | null {
  return SHAPE_FAILURE[shape];
}

export interface DesignAttemptDiagnosis {
  readonly attempt: number;
  /** `null` when this attempt produced the manifest that was returned. */
  readonly failure: DesignFailureKind | null;
  readonly fault: DesignFault | null;
  /** `null` when nothing was read back from the model (a refused or failed call). */
  readonly shape: DesignOutputShape | null;
  readonly wrapper: DesignOutputWrapper | null;
  readonly outputChars: number;
  readonly issues: readonly string[];
}

export interface DesignResult {
  ok: boolean;
  manifest: Record<string, unknown> | null;
  manifestHash: string | null;
  issues: readonly string[];
  attempts: number;
  providerLabel: string | null;
  usage: DesignUsage | null;
  /** The classification of the final attempt; `null` on success. */
  readonly failure: DesignFailureKind | null;
  readonly fault: DesignFault | null;
  /** How the accepted manifest had to be unwrapped; `null` when there is no manifest. */
  readonly recovery: DesignOutputWrapper | null;
  readonly diagnosis: readonly DesignAttemptDiagnosis[];
}

export type DesignPhase = "generating" | "validating" | "retrying";

export interface DesignProgress {
  readonly phase: DesignPhase;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly outputChars: number;
  readonly issues: readonly string[];
  readonly failure?: DesignFailureKind;
  readonly shape?: DesignOutputShape;
  readonly wrapper?: DesignOutputWrapper;
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

/**
 * The top-level JSON object in a model reply, or `null`. A thin read of
 * `classifyDesignOutput` so there is exactly one parser: the diagnosis an operator sees
 * and the object the validator runs on can never disagree about what the model said.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  return classifyDesignOutput(text).object;
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

/**
 * The retry instruction for an unreadable reply. Each shape gets its own, because the
 * corrective action differs: a fenced reply needs the fence dropped, a truncated one
 * needs to be shorter, and a non-JSON one needs the format restated.
 */
function correctiveForShape(shape: DesignOutputShape, wrapper: DesignOutputWrapper): string {
  const head = ((): string => {
    switch (shape) {
      case "empty":
        return "Your previous reply was empty.";
      case "no_json":
        return "Your previous reply was prose with no JSON in it.";
      case "truncated_json":
        return "Your previous reply was cut off mid-structure. Produce a smaller manifest — fewer entities and fewer fields per entity — so it fits in one reply.";
      case "malformed_json":
        return "Your previous reply was not valid JSON (check for trailing commas, unquoted keys and single quotes).";
      case "array_not_object":
        return "Your previous reply was a JSON array. A manifest is one JSON object, not a list.";
      case "scalar_not_object":
        return "Your previous reply was a JSON string or number, not an object.";
      case "object_not_manifest":
        return "Your previous reply was a JSON object, but not a manifest — it must have manifestVersion, meta and entities.";
      case "manifest_shaped_object":
        return "Your previous reply needs correcting.";
    }
  })();
  const fence =
    wrapper === "code_fence"
      ? " Do not wrap it in a markdown code fence."
      : wrapper === "surrounding_prose"
        ? " Do not write anything before or after it."
        : "";
  return `${head} Respond with ONLY one JSON object — the manifest.${fence}`;
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
  /**
   * The per-request cost ceiling (ADR-0267). Absent leaves the pre-ceiling behaviour:
   * only the caller's monthly budget is consulted, between requests.
   */
  maxRequestDollars?: number;
  /**
   * The estimator's learned correction for this tenant, carried across restarts (ADR-0330).
   *
   * ADR-0311 made `reconcileRequestCost` feed the worst observed ratio back so the estimator stops
   * being optimistic, and left it in process memory — so a restart forgot it, in the direction that
   * *admits* requests it had learned to delay. Supplying it seeds the run; `onInflationObserved`
   * carries each reading back out to wherever it is kept.
   *
   * Optional, and 1 when absent, which is the pre-ADR-0330 behaviour exactly.
   */
  inflation?: number;
  onInflationObserved?: (ratio: number) => void | Promise<void>;
  onProgress?: DesignProgressListener;
}): Promise<DesignResult> {
  const providerLabel = opts.providerLabel ?? null;
  const maxAttempts = opts.maxAttempts ?? MAX_DESIGN_ATTEMPTS;
  const maxTokens = opts.maxTokens ?? DEFAULT_DESIGN_MAX_TOKENS;
  const onProgress = opts.onProgress;
  const diagnosis: DesignAttemptDiagnosis[] = [];

  const emit = (progress: DesignProgress): void => {
    if (onProgress === undefined) return;
    try {
      onProgress(progress);
    } catch {
      // Progress is observational: a caller's listener must never abort a design run.
    }
  };

  const fail = (
    failure: DesignFailureKind,
    failIssues: readonly string[],
    attempts: number,
    usage: DesignUsage | null,
  ): DesignResult => ({
    ok: false,
    manifest: null,
    manifestHash: null,
    issues: failIssues,
    attempts,
    providerLabel,
    usage,
    failure,
    fault: DESIGN_FAILURE_FAULT[failure],
    recovery: null,
    diagnosis,
  });

  if (opts.description.length > MAX_DESIGN_DESCRIPTION_CHARS) {
    return fail(
      "description_too_long",
      [`description is ${opts.description.length} chars; the limit is ${MAX_DESIGN_DESCRIPTION_CHARS}`],
      0,
      null,
    );
  }

  const ceiling: PerRequestCostCeiling | null =
    opts.maxRequestDollars !== undefined ? { maxDollars: opts.maxRequestDollars } : null;
  const pricing = opts.provider.pricing;
  if (ceiling !== null && pricing === undefined) {
    // Fail closed: a configured ceiling that cannot be computed is not a ceiling. Sending
    // the request anyway would re-open exactly the hole the ceiling was added to close.
    return fail(
      "request_cost_ceiling",
      ["a per-request cost ceiling is configured but the provider publishes no pricing"],
      0,
      null,
    );
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
  let failure: DesignFailureKind = "provider_error";
  let usage: DesignUsage | null = null;
  // Raised whenever a settled request cost more than it was estimated to, so the next
  // attempt in this run is priced against what this model actually does rather than
  // against the same optimistic guess. Seeded from the caller (ADR-0330), because a restart
  // otherwise forgets the correction in the direction that admits a request it had learned to
  // delay. Never below 1: a factor under 1 would *deflate* an estimate that feeds a ceiling.
  let inflation = Math.max(1, opts.inflation ?? 1);
  let sealed = false;

  while (attempts < maxAttempts && !sealed) {
    attempts += 1;
    const attemptNumber = attempts;
    const record = (
      kind: DesignFailureKind,
      reason: readonly string[],
      outputChars: number,
      shape: DesignOutputShape | null,
      wrapper: DesignOutputWrapper | null,
      terminal = false,
    ): void => {
      issues = reason;
      failure = kind;
      diagnosis.push({
        attempt: attemptNumber,
        failure: kind,
        fault: DESIGN_FAILURE_FAULT[kind],
        shape,
        wrapper,
        outputChars,
        issues: reason,
      });
      // A terminal failure is not followed by a retry, so announcing one would be a lie.
      if (terminal || attemptNumber >= maxAttempts) return;
      emit({
        phase: "retrying",
        attempt: attemptNumber,
        maxAttempts,
        outputChars,
        issues: reason,
        failure: kind,
        ...(shape !== null ? { shape } : {}),
        ...(wrapper !== null ? { wrapper } : {}),
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

    let meter: StreamCostMeter | null = null;
    let estimatedDollars = 0;
    if (ceiling !== null && pricing !== undefined) {
      const promptChars = request.messages.reduce((n, m) => n + m.content.length, 0);
      const admission = admitRequestCost(ceiling, {
        pricing,
        promptChars,
        // The script-aware reading beside the character count (ADR-0330), which takes the greater
        // of the two — so supplying the text can only ever raise the figure. This is the half of
        // ADR-0311's CJK note that reaches production: `.length` under-counts an ideographic
        // prompt by more than 4x, and under-counting is the direction that *admits* a request the
        // ceiling exists to refuse.
        promptText: request.messages.map((m) => m.content),
        maxOutputTokens: maxTokens,
        inflation,
      });
      if (admission.outcome === "refuse") {
        // Terminal, not retryable: the prompt only ever grows across attempts, so the
        // next estimate cannot come out lower than this one.
        record("request_cost_ceiling", [admission.reason], 0, null, null, true);
        break;
      }
      if (admission.estimate.kind === "bounded") {
        estimatedDollars = admission.estimate.dollars;
        meter = new StreamCostMeter({
          pricing,
          ceiling,
          inputTokens: admission.estimate.inputTokens,
        });
      }
    }

    let text = "";
    let oversized = false;
    let overCost = false;
    let turnCost: number | null = null;
    let lastEmittedChars = 0;
    try {
      for await (const chunk of opts.provider.complete(request)) {
        if (chunk.kind === "text") {
          text += chunk.text;
          if (meter !== null && meter.accrueChars(chunk.text.length) === "abort") {
            overCost = true;
            break;
          }
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
          turnCost = chunk.usage.cost;
          usage = addUsage(usage, chunk.usage);
        }
      }
    } catch (err) {
      record(
        "provider_error",
        [`provider error: ${err instanceof Error ? err.message : String(err)}`],
        text.length,
        null,
        null,
      );
      continue;
    }

    if (overCost && meter !== null) {
      // The stream was abandoned, so no `usage_final` ever arrived — but those tokens were
      // generated and will be billed, so the meter's own figure stands in for them rather
      // than reporting the attempt as free.
      usage = addUsage(usage, {
        inputTokens: 0,
        outputTokens: meter.outputTokens,
        cost: meter.dollars,
      });
      record(
        "response_cost_ceiling",
        [
          `response was abandoned at an estimated $${meter.dollars.toFixed(4)}, over the per-request ceiling of $${(ceiling?.maxDollars ?? 0).toFixed(4)}`,
        ],
        text.length,
        null,
        null,
      );
      messages.push({
        role: "user",
        content:
          "Your previous response was too expensive to finish. Respond with ONLY one compact JSON manifest object.",
      });
      continue;
    }

    if (turnCost !== null && ceiling !== null) {
      const verdict = reconcileRequestCost({
        ceiling,
        estimatedDollars,
        actualDollars: turnCost,
      });
      if (verdict.ratio !== undefined) {
        if (verdict.kind !== "within_estimate") {
          inflation = Math.max(inflation, verdict.ratio);
        }
        // Reported for **every** verdict including `within_estimate`, because that arm is the only
        // observation that can *relax* a stored high-water mark. Reporting only the bad ones would
        // make the mark rise forever and pin a tenant pessimistically on one outlier (ADR-0330).
        try {
          await opts.onInflationObserved?.(verdict.ratio);
        } catch (err) {
          // A failed observation costs a correction, never the design. The next settled request
          // re-derives the same ratio, so this is delayed rather than lost.
          console.warn("[ai-design] could not record the cost ratio", err);
        }
      }
      // An actual cost over the cap means the estimator does not model this model, so stop
      // after this attempt. The attempt itself is still read out below: the money is spent,
      // and throwing away a manifest that turned out valid would waste it for nothing.
      if (verdict.kind === "over_ceiling") sealed = true;
    }

    if (oversized) {
      record(
        "response_too_long",
        [`model response exceeded ${MAX_DESIGN_RESPONSE_CHARS} chars`],
        text.length,
        null,
        null,
      );
      messages.push({
        role: "user",
        content:
          "Your previous response was too long. Respond with ONLY one compact JSON manifest object.",
      });
      continue;
    }

    const classified = classifyDesignOutput(text);
    if (classified.shape !== "manifest_shaped_object" || classified.object === null) {
      // The `??` arm is unreachable — a manifest-shaped diagnosis always carries its
      // object — but `not_a_manifest` is the honest reading if that ever stops holding.
      const kind = designFailureForShape(classified.shape) ?? "not_a_manifest";
      record(kind, [classified.detail], text.length, classified.shape, classified.wrapper);
      // ADR-0330. This loop used to `continue` on **every** non-manifest shape, which is the blind
      // retry ADR-0311 warned about: an `array_not_object` is the model answering a *different
      // question*, and asking again collects the same wrong answer at the cost of another paid
      // call. `DESIGN_SHAPE_RETRIABILITY` draws the line on "did the model understand the
      // question" rather than on "will it recur", so a broken-syntax failure is retried and a
      // confident answer to something else is not.
      if (DESIGN_SHAPE_RETRIABILITY[classified.shape] === "wrong_question") {
        break;
      }
      messages.push({ role: "assistant", content: truncate(text, MAX_ASSISTANT_ECHO_CHARS) });
      messages.push({
        role: "user",
        content: correctiveForShape(classified.shape, classified.wrapper),
      });
      continue;
    }

    emit({
      phase: "validating",
      attempt: attemptNumber,
      maxAttempts,
      outputChars: text.length,
      issues: [],
      shape: classified.shape,
      wrapper: classified.wrapper,
    });

    const normalized = ensureRolesInManifest(
      normalizeGeneratedManifest(
        classified.object,
        opts.name !== undefined ? { name: opts.name } : {},
      ),
      opts.ensureRoles ?? [],
    );
    const parsed = ManifestSchema.safeParse(normalized);
    if (!parsed.success) {
      record(
        "schema_invalid",
        parsed.error.issues
          .slice(0, MAX_FEEDBACK_ISSUES)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        text.length,
        classified.shape,
        classified.wrapper,
      );
      messages.push({ role: "assistant", content: truncate(text, MAX_ASSISTANT_ECHO_CHARS) });
      messages.push({ role: "user", content: correctiveMessage(issues) });
      continue;
    }

    const manifest: Manifest = parsed.data;
    let crossIssues: readonly string[];
    try {
      const result = tryValidateManifest(manifest);
      if (result.ok) {
        diagnosis.push({
          attempt: attemptNumber,
          failure: null,
          fault: null,
          shape: classified.shape,
          wrapper: classified.wrapper,
          outputChars: text.length,
          issues: [],
        });
        return {
          ok: true,
          manifest: manifest as unknown as Record<string, unknown>,
          manifestHash: manifestHash(manifest),
          issues: [],
          attempts,
          providerLabel,
          usage,
          failure: null,
          fault: null,
          recovery: classified.wrapper,
          diagnosis,
        };
      }
      crossIssues = result.errors.slice(0, MAX_FEEDBACK_ISSUES).map((e) => e.message);
    } catch (err) {
      // validateManifest throws non-ManifestValidationError kinds (e.g. cycle errors) past tryValidateManifest
      crossIssues = [err instanceof Error ? err.message : String(err)];
    }
    record(
      "cross_validation_failed",
      crossIssues,
      text.length,
      classified.shape,
      classified.wrapper,
    );
    messages.push({ role: "assistant", content: truncate(text, MAX_ASSISTANT_ECHO_CHARS) });
    messages.push({ role: "user", content: correctiveMessage(issues) });
  }

  return fail(failure, issues, attempts, usage);
}

export function buildDesignDesigner(opts: {
  provider: DesignCompletionProvider;
  model?: string;
  maxTokens?: number;
  providerLabel?: string | null;
  ensureRoles?: readonly string[];
  maxRequestDollars?: number;
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
      ...(opts.maxRequestDollars !== undefined ? { maxRequestDollars: opts.maxRequestDollars } : {}),
      ...(listener !== undefined ? { onProgress: listener } : {}),
    });
  };
}

export interface DesignProviderBuild {
  readonly provider: DesignCompletionProvider;
  readonly providerLabel: string;
  readonly model: string;
}

/**
 * The self-hosted endpoint, following the Architect CLI's convention: `LOCAL_LLM_BASE_URL`, or
 * `OLLAMA_BASE_URL` for an Ollama box. Empty means unset, the same reading `OPENAI_BASE_URL` gets.
 * Returning `"malformed"` keeps a typo from falling through to a cloud vendor.
 */
function resolveLocalBaseUrl(
  env: NodeJS.ProcessEnv,
): { readonly kind: "absent" } | { readonly kind: "malformed"; readonly raw: string } | { readonly kind: "present"; readonly baseUrl: string } {
  const raw = env["LOCAL_LLM_BASE_URL"] ?? env["OLLAMA_BASE_URL"] ?? "";
  if (raw.length === 0) return { kind: "absent" };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { kind: "malformed", raw };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { kind: "malformed", raw };
  }
  return { kind: "present", baseUrl: raw };
}

export function buildDesignProviderFromEnv(
  env: NodeJS.ProcessEnv,
  opts?: { model?: string },
): DesignProviderBuild | null {
  // Self-hosted first, and refused outright when its base URL is unusable. Unlike an API key, a
  // local base URL has exactly one meaning in this process — "run the model on our own hardware" —
  // so honouring a stray ANTHROPIC_API_KEY instead would ship the tenant's business description to
  // a vendor the operator deliberately opted out of.
  const local = resolveLocalBaseUrl(env);
  if (local.kind === "malformed") return null;
  if (local.kind === "present") {
    // No catalogue to gate against: a local server names its own models, and the provider's pricing
    // is zero per token, so a per-tenant cost ceiling never trips on self-hosted inference.
    const model: string = opts?.model !== undefined && opts.model.length > 0 ? opts.model : DEFAULT_LOCAL_MODEL;
    const apiKey = env["LOCAL_LLM_API_KEY"];
    const provider = new LocalLlmProvider({
      defaultModel: model,
      baseUrl: local.baseUrl,
      ...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
    });
    return { provider, providerLabel: `local/${model}`, model };
  }
  const anthropicKey = env["ANTHROPIC_API_KEY"];
  if (anthropicKey !== undefined && anthropicKey.length > 0) {
    const model: AnthropicModel =
      opts?.model !== undefined && isAnthropicModel(opts.model) ? opts.model : "claude-sonnet-4-6";
    const provider = new AnthropicProvider({ apiKey: anthropicKey, defaultModel: model });
    return { provider, providerLabel: `anthropic/${model}`, model };
  }
  const openaiKey = env["OPENAI_API_KEY"];
  if (openaiKey !== undefined && openaiKey.length > 0) {
    const baseUrl = env["OPENAI_BASE_URL"];
    const custom = baseUrl !== undefined && baseUrl.length > 0;
    // A custom base URL means a self-hosted or proxied endpoint, whose model ids have
    // nothing to do with OpenAI's catalogue — validating against it there would silently
    // rewrite `qwen2.5:14b` to `gpt-4o` and ask Ollama for a model it does not have.
    const model: string =
      opts?.model !== undefined && (custom || isOpenAiChatModel(opts.model))
        ? opts.model
        : "gpt-4o";
    const provider = new OpenAiProvider({
      apiKey: openaiKey,
      defaultModel: model,
      ...(custom ? { baseUrl } : {}),
    });
    return { provider, providerLabel: `openai/${model}`, model };
  }
  return null;
}
