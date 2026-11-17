import type { LlmTool } from "@crossengin/ai-providers";
import {
  computeManifestDiff,
  manifestHash,
  ManifestSchema,
  tryValidateManifest,
  type Manifest,
} from "@crossengin/kernel/manifest";

import { approvalDetailLines } from "./approval-detail.js";
import {
  confinePath,
  FileToolRefusal,
  readConfinedText,
  resolveFileRoot,
  secretContentKind,
  writeConfinedText,
  type ConfinedPath,
} from "./file-confinement.js";
import { unifiedDiff } from "./unified-diff.js";
import { buildManifestSummary } from "./manifest-io.js";
import { classifyManifestEditRefusal, manifestEditRefusalResult } from "./refusal.js";

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
  /**
   * The one directory both file tools are confined to, symlinks resolved (H-29). Defaults to the
   * working directory; `resolveFileRoot` refuses the filesystem root.
   */
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
  /**
   * What the counts summarise, one fact per line. Required, so an approver that renders only the
   * counts is a decision somebody made rather than a field nobody populated.
   */
  readonly details: readonly string[];
  /**
   * The file's text on disk against exactly the bytes that will be written, as a unified diff.
   * Required for the reason `details` is: it is what a person approving a write is approving.
   */
  readonly unifiedDiff: readonly string[];
}

export interface WriteApprover {
  approve(request: WriteApprovalRequest): Promise<boolean>;
  /**
   * Whether a person sees the request before answering. Absent reads as false, so the tool
   * description never promises a review an approver did not declare it performs.
   */
  readonly showsDiffToPerson?: boolean;
}

export function autoApprover(approve = true): WriteApprover {
  return {
    showsDiffToPerson: false,
    async approve() {
      return approve;
    },
  };
}

const DEFAULT_MAX_FILE_BYTES = 1_048_576;
const ALLOWED_FILE_EXTENSIONS = [".json", ".yaml", ".yml", ".txt", ".md"] as const;
const WRITABLE_FILE_EXTENSIONS = [".json"] as const;

const CONFINEMENT_RULES =
  "Hidden files and directories (.env, .git, .ssh, …), credential-named files and symlinks leading outside the root are refused";

/** Resolves the root once per catalog, on first use, so a refusal surfaces as the tool's error. */
function memoRoot(dir: string): () => Promise<string> {
  let pending: Promise<string> | null = null;
  return () => {
    pending ??= resolveFileRoot(dir);
    return pending;
  };
}

function refusalError(tool: string, err: unknown): unknown {
  if (err instanceof FileToolRefusal) {
    return new ToolExecutionError(`${tool}: refused (${err.reason}): ${err.message}`);
  }
  return err;
}

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
  const rootDir = opts.fileRootDir ?? process.cwd();
  const root = memoRoot(rootDir);
  if (opts.allowFileRead === true) {
    const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    tools.push({
      name: "read_file",
      description: `Read a text file under the session's file root; its contents are returned to this conversation. Paths outside the root are refused. ${CONFINEMENT_RULES}, as is a file containing a credential-shaped value. Allowed extensions: ${ALLOWED_FILE_EXTENSIONS.join(", ")}. Max ${maxBytes.toString()} bytes.`,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path relative to the file root.",
          },
        },
        required: ["path"],
      },
      execute: async (input) => readFileTool(input, root, maxBytes),
    });
  }
  if (opts.allowFileWrite === true && opts.approver !== undefined) {
    const approver = opts.approver;
    const review =
      approver.showsDiffToPerson === true
        ? "A person is shown a unified diff of the file's current text against exactly what will be written, and nothing is written unless they approve."
        : "This session approves writes without showing them to a person: the file is written as soon as the manifest validates.";
    tools.push({
      name: "propose_manifest_edit",
      description: `Propose writing a CrossEngin manifest to a .json file under the session's file root. ${review} An existing file at the path must itself be a manifest; any other file is refused rather than overwritten. Paths outside the root are refused. ${CONFINEMENT_RULES}. On approval the new hash is returned; on denial nothing is written. The manifest must validate against the kernel schema.`,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Destination path relative to the file root. Must end in .json.",
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
  root: () => Promise<string>,
  maxBytes: number,
): Promise<{ path: string; contents: string }> {
  const path = input["path"];
  if (typeof path !== "string" || path.length === 0) {
    throw new ToolExecutionError(`tool input missing string field "path"`);
  }
  try {
    const confined = await confinePath(await root(), path, ALLOWED_FILE_EXTENSIONS, "read");
    const contents = await readConfinedText(confined, maxBytes);
    const kind = secretContentKind(contents);
    if (kind !== null) {
      throw new FileToolRefusal(
        "secret_content",
        `${confined.relative} contains a value shaped like a credential (${kind}); its contents are not sent`,
      );
    }
    return { path: confined.relative, contents };
  } catch (err) {
    throw refusalError("read_file", err);
  }
}

async function proposeManifestEditTool(
  input: ToolInput,
  root: () => Promise<string>,
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
  let target: ConfinedPath;
  let existingText: string | null;
  try {
    target = await confinePath(await root(), pathRaw, WRITABLE_FILE_EXTENSIONS, "write");
    existingText = target.exists ? await readConfinedText(target, MAX_EXISTING_MANIFEST_BYTES) : null;
  } catch (err) {
    throw refusalError("propose_manifest_edit", err);
  }
  const relativePath = target.relative;
  const existing = existingText === null ? null : parseExistingManifest(existingText);
  if (existingText !== null && existing === null) {
    // Treating it as absent is what let this tool present an overwrite of package.json as a CREATE.
    return {
      applied: false,
      reason: "existing_file_not_a_manifest",
      path: relativePath,
      message: `${relativePath} exists and is not a CrossEngin manifest; it is not overwritten. Choose another path, or move the file aside first.`,
    };
  }
  const refusal = classifyManifestEditRefusal(existing, proposed);
  if (refusal !== null) {
    return manifestEditRefusalResult(refusal);
  }
  const isNew = existing === null;
  const oldHash = existing !== null ? manifestHash(existing) : null;
  const newHash = manifestHash(proposed);
  if (oldHash === newHash) {
    return {
      applied: false,
      reason: "no_changes",
      path: relativePath,
      hash: newHash,
    };
  }
  const kernelDiff = existing !== null ? computeManifestDiff(existing, proposed) : null;
  const diff =
    kernelDiff ?? { addedEntities: proposed.entities ?? [], removedEntities: [], modifiedEntities: [] };
  const diffSummary = {
    entitiesAdded: diff.addedEntities.length,
    entitiesRemoved: diff.removedEntities.length,
    entitiesModified: diff.modifiedEntities.length,
  };
  const newText = JSON.stringify(proposed, null, 2) + "\n";
  const approved = await approver.approve({
    path: target.real,
    isNew,
    newHash,
    diffSummary,
    details: approvalDetailLines(existing, proposed, kernelDiff),
    unifiedDiff: unifiedDiff(existingText ?? "", newText, {
      oldLabel: isNew ? "/dev/null" : `a/${relativePath}`,
      newLabel: `b/${relativePath}`,
    }),
  });
  if (!approved) {
    return {
      applied: false,
      reason: "user_denied",
      path: relativePath,
      diff_summary: diffSummary,
    };
  }
  try {
    // The diff approved was against the text read above; a file changed while the prompt was open
    // would be overwritten with an edit nobody reviewed against it.
    const recheck = await confinePath(await root(), pathRaw, WRITABLE_FILE_EXTENSIONS, "write");
    const nowText = recheck.exists ? await readConfinedText(recheck, MAX_EXISTING_MANIFEST_BYTES) : null;
    if (recheck.real !== target.real || nowText !== existingText) {
      return {
        applied: false,
        reason: "file_changed_since_approval",
        path: relativePath,
        message: `${relativePath} changed after the diff was shown; nothing was written. Propose the edit again.`,
      };
    }
    await writeConfinedText(recheck, newText);
  } catch (err) {
    const refused = refusalError("propose_manifest_edit", err);
    if (refused instanceof ToolExecutionError) throw refused;
    throw new ToolExecutionError(
      `propose_manifest_edit: failed to write ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    applied: true,
    path: relativePath,
    hash: newHash,
    is_new: isNew,
    diff_summary: diffSummary,
    summary: buildManifestSummary(proposed),
  };
}

/** A manifest file is read whole to diff it, so it gets its own cap, not the read tool's. */
const MAX_EXISTING_MANIFEST_BYTES = 16_777_216;

function parseExistingManifest(text: string): Manifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const schemaResult = ManifestSchema.safeParse(parsed);
  return schemaResult.success ? schemaResult.data : null;
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
