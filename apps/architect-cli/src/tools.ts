import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { LlmTool } from "@crossengin/ai-providers";
import { evaluateProposalGate, formatProposalGate, scanProposalRefusalRequest } from "@crossengin/ai-architect-runtime";
import {
  computeManifestDiff,
  manifestHash,
  ManifestSchema,
  tryValidateManifest,
  type Manifest,
} from "@crossengin/kernel/manifest";

import { buildManifestSummary } from "./manifest-io.js";

export type ToolInput = Record<string, unknown>;

export interface ChatToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly execute: (input: ToolInput) => Promise<unknown>;
}

export interface ChatToolOptions {
  readonly allowFileRead?: boolean;
  readonly allowFileWrite?: boolean;
  readonly fileRootDir?: string;
  readonly maxFileBytes?: number;
  readonly approver?: WriteApprover;
}

export interface WriteApprovalRequest {
  readonly path: string;
  readonly isNew: boolean;
  readonly newHash: string;
  readonly diffSummary: {
    readonly entitiesAdded: number;
    readonly entitiesRemoved: number;
    readonly entitiesModified: number;
  };
}

export interface WriteApprover {
  approve(request: WriteApprovalRequest): Promise<boolean>;
}

export function autoApprover(approve = true): WriteApprover {
  return {
    async approve() {
      return approve;
    },
  };
}

const DEFAULT_MAX_FILE_BYTES = 1_048_576;
const ALLOWED_FILE_EXTENSIONS = [".json", ".yaml", ".yml", ".txt", ".md"] as const;

export function buildToolCatalog(opts: ChatToolOptions = {}): readonly ChatToolDefinition[] {
  const tools: ChatToolDefinition[] = [
    {
      name: "validate_manifest",
      description:
        "Validate a CrossEngin manifest against the kernel schema. Returns {ok: true, summary} on success or {ok: false, errors: [...]} on failure. Pass the manifest as a JSON string.",
      inputSchema: {
        type: "object",
        properties: {
          manifest_json: {
            type: "string",
            description: "The manifest serialized as a JSON string.",
          },
        },
        required: ["manifest_json"],
      },
      execute: async (input) => {
        const manifest = parseManifestArg(input, "manifest_json");
        const result = tryValidateManifest(manifest);
        if (!result.ok) {
          return { ok: false, errors: result.errors };
        }
        return { ok: true, summary: buildManifestSummary(manifest) };
      },
    },
    {
      name: "hash_manifest",
      description:
        "Compute the deterministic content hash of a CrossEngin manifest. Pass the manifest as a JSON string. Returns {hash}.",
      inputSchema: {
        type: "object",
        properties: {
          manifest_json: {
            type: "string",
            description: "The manifest serialized as a JSON string.",
          },
        },
        required: ["manifest_json"],
      },
      execute: async (input) => {
        const manifest = parseManifestArg(input, "manifest_json");
        return { hash: manifestHash(manifest) };
      },
    },
    {
      name: "diff_manifests",
      description:
        "Diff two CrossEngin manifests (old vs new). Returns the entity-level diff with added / removed / modified lists.",
      inputSchema: {
        type: "object",
        properties: {
          old_manifest_json: {
            type: "string",
            description: "The previous manifest serialized as a JSON string.",
          },
          new_manifest_json: {
            type: "string",
            description: "The new manifest serialized as a JSON string.",
          },
        },
        required: ["old_manifest_json", "new_manifest_json"],
      },
      execute: async (input) => {
        const oldManifest = parseManifestArg(input, "old_manifest_json");
        const newManifest = parseManifestArg(input, "new_manifest_json");
        return computeManifestDiff(oldManifest, newManifest);
      },
    },
    {
      name: "summarize_manifest",
      description:
        "Summarize a CrossEngin manifest (counts of entities, workflows, views, etc.) without running full validation. Pass the manifest as a JSON string.",
      inputSchema: {
        type: "object",
        properties: {
          manifest_json: {
            type: "string",
            description: "The manifest serialized as a JSON string.",
          },
        },
        required: ["manifest_json"],
      },
      execute: async (input) => {
        const manifest = parseManifestArg(input, "manifest_json");
        return buildManifestSummary(manifest);
      },
    },
  ];
  if (opts.allowFileRead === true) {
    const root = opts.fileRootDir ?? process.cwd();
    const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    tools.push({
      name: "read_file",
      description: `Read a text file from the local filesystem (relative to the working directory). Allowed extensions: ${ALLOWED_FILE_EXTENSIONS.join(", ")}. Max ${maxBytes.toString()} bytes.`,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative or absolute path to the file.",
          },
        },
        required: ["path"],
      },
      execute: async (input) => readFileTool(input, root, maxBytes),
    });
  }
  if (opts.allowFileWrite === true && opts.approver !== undefined) {
    const root = opts.fileRootDir ?? process.cwd();
    const approver = opts.approver;
    tools.push({
      name: "propose_manifest_edit",
      description:
        "Propose writing a CrossEngin manifest to disk. The user is shown the diff against any existing file at the path and must approve before the write happens. On approval the file is written and the new hash is returned. On denial nothing is written. The manifest must validate against the kernel schema.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Destination path. Must end in .json. Resolved relative to the working directory.",
          },
          new_manifest_json: {
            type: "string",
            description: "The proposed manifest serialized as a JSON string.",
          },
        },
        required: ["path", "new_manifest_json"],
      },
      execute: async (input) => proposeManifestEditTool(input, root, approver),
    });
  }
  return tools;
}

function parseManifestArg(input: ToolInput, key: string): Manifest {
  const raw = input[key];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ToolExecutionError(`tool input missing string field "${key}"`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ToolExecutionError(
      `tool input "${key}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return ManifestSchema.parse(parsed);
}

async function readFileTool(
  input: ToolInput,
  rootDir: string,
  maxBytes: number,
): Promise<{ path: string; contents: string }> {
  const path = input["path"];
  if (typeof path !== "string" || path.length === 0) {
    throw new ToolExecutionError(`tool input missing string field "path"`);
  }
  const absolute = resolve(rootDir, path);
  if (!isExtensionAllowed(absolute)) {
    throw new ToolExecutionError(
      `read_file: extension not allowed; permitted: ${ALLOWED_FILE_EXTENSIONS.join(", ")}`,
    );
  }
  let contents: string;
  try {
    contents = await readFile(absolute, "utf8");
  } catch (err) {
    throw new ToolExecutionError(
      `read_file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (Buffer.byteLength(contents, "utf8") > maxBytes) {
    throw new ToolExecutionError(`read_file: file exceeds ${maxBytes.toString()} bytes`);
  }
  return { path: absolute, contents };
}

async function proposeManifestEditTool(
  input: ToolInput,
  rootDir: string,
  approver: WriteApprover,
): Promise<unknown> {
  const pathRaw = input["path"];
  if (typeof pathRaw !== "string" || pathRaw.length === 0) {
    throw new ToolExecutionError(`tool input missing string field "path"`);
  }
  if (!pathRaw.toLowerCase().endsWith(".json")) {
    throw new ToolExecutionError(`propose_manifest_edit: path must end in .json`);
  }
  const newJsonRaw = input["new_manifest_json"];
  if (typeof newJsonRaw !== "string" || newJsonRaw.length === 0) {
    throw new ToolExecutionError(`tool input missing string field "new_manifest_json"`);
  }
  let proposedUnknown: unknown;
  try {
    proposedUnknown = JSON.parse(newJsonRaw);
  } catch (err) {
    throw new ToolExecutionError(
      `new_manifest_json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const schemaResult = ManifestSchema.safeParse(proposedUnknown);
  if (!schemaResult.success) {
    return {
      applied: false,
      reason: "invalid_manifest",
      errors: schemaResult.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      })),
    };
  }
  const proposed = schemaResult.data;
  const validation = tryValidateManifest(proposed);
  if (!validation.ok) {
    return {
      applied: false,
      reason: "invalid_manifest",
      errors: validation.errors,
    };
  }
  const absolute = resolve(rootDir, pathRaw);
  const existing = await loadExistingManifest(absolute);
  const isNew = existing === null;
  const oldHash = existing !== null ? manifestHash(existing) : null;
  const newHash = manifestHash(proposed);
  if (oldHash === newHash) {
    return {
      applied: false,
      reason: "no_changes",
      path: absolute,
      hash: newHash,
    };
  }
  const diff =
    existing !== null
      ? computeManifestDiff(existing, proposed)
      : { addedEntities: proposed.entities ?? [], removedEntities: [], modifiedEntities: [] };
  const diffSummary = {
    entitiesAdded: diff.addedEntities.length,
    entitiesRemoved: diff.removedEntities.length,
    entitiesModified: diff.modifiedEntities.length,
  };
  // P7.2: enforce the AI-Architect safety policy before asking for approval. A hard
  // refusal (e.g. removing audit from a phi-carrying entity, weakening encryption
  // below a pack minimum) is non-overridable — reject it without offering the write.
  if (existing !== null) {
    const refusalRequest = scanProposalRefusalRequest(
      { entities: existing.entities ?? [] },
      { entities: proposed.entities ?? [] },
      { requester: "ai_architect", tenantId: "architect-cli", attemptedAt: new Date().toISOString() },
    );
    if (refusalRequest !== null) {
      const decision = evaluateProposalGate({ hardRefusal: { request: refusalRequest } });
      return {
        applied: false,
        reason: "safety_refused",
        path: absolute,
        refusal: refusalRequest.refusal,
        message: formatProposalGate(decision),
      };
    }
  }
  const approved = await approver.approve({
    path: absolute,
    isNew,
    newHash,
    diffSummary,
  });
  if (!approved) {
    return {
      applied: false,
      reason: "user_denied",
      path: absolute,
      diff_summary: diffSummary,
    };
  }
  try {
    await ensureParentExists(absolute);
    await writeFile(absolute, JSON.stringify(proposed, null, 2) + "\n", "utf8");
  } catch (err) {
    throw new ToolExecutionError(
      `propose_manifest_edit: failed to write ${absolute}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    applied: true,
    path: absolute,
    hash: newHash,
    is_new: isNew,
    diff_summary: diffSummary,
    summary: buildManifestSummary(proposed),
  };
}

async function loadExistingManifest(absolutePath: string): Promise<Manifest | null> {
  try {
    await access(absolutePath);
  } catch {
    return null;
  }
  let text: string;
  try {
    text = await readFile(absolutePath, "utf8");
  } catch (err) {
    throw new ToolExecutionError(
      `propose_manifest_edit: failed to read existing ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ToolExecutionError(
      `propose_manifest_edit: existing file at ${absolutePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const schemaResult = ManifestSchema.safeParse(parsed);
  if (!schemaResult.success) return null;
  return schemaResult.data;
}

async function ensureParentExists(absolutePath: string): Promise<void> {
  const parent = dirname(absolutePath);
  try {
    await access(parent);
  } catch {
    throw new ToolExecutionError(
      `propose_manifest_edit: parent directory does not exist: ${parent}`,
    );
  }
}

function isExtensionAllowed(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of ALLOWED_FILE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

export function toolsToLlmTools(catalog: readonly ChatToolDefinition[]): readonly LlmTool[] {
  return catalog.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export interface ToolExecutionResult {
  readonly id: string;
  readonly name: string;
  readonly output: string;
  readonly isError: boolean;
}

export async function executeToolCall(
  catalog: readonly ChatToolDefinition[],
  call: { readonly id: string; readonly name: string; readonly input: unknown },
): Promise<ToolExecutionResult> {
  const tool = catalog.find((t) => t.name === call.name);
  if (tool === undefined) {
    return {
      id: call.id,
      name: call.name,
      output: JSON.stringify({ error: `unknown tool: ${call.name}` }),
      isError: true,
    };
  }
  const input = call.input === undefined || call.input === null
    ? {}
    : typeof call.input === "object" && !Array.isArray(call.input)
      ? (call.input as ToolInput)
      : null;
  if (input === null) {
    return {
      id: call.id,
      name: call.name,
      output: JSON.stringify({ error: `tool input must be a JSON object, got ${typeof call.input}` }),
      isError: true,
    };
  }
  try {
    const result = await tool.execute(input);
    return {
      id: call.id,
      name: call.name,
      output: JSON.stringify(result),
      isError: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: call.id,
      name: call.name,
      output: JSON.stringify({ error: message }),
      isError: true,
    };
  }
}
