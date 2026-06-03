import { readFile } from "node:fs/promises";

import type {
  LlmProvider,
  TaskPolicyMap,
  TenantResidency,
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
import { DefaultLlmRouter, type RouterResolution } from "@crossengin/ai-router";
import {
  computeManifestDiff,
  manifestHash,
  tryValidateManifest,
  validateManifest,
  type Manifest,
} from "@crossengin/kernel/manifest";

import { PostgresTranscript, type Transcript } from "@crossengin/ai-architect-pg";
import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";

import {
  DEFAULT_ARCHITECT_SYSTEM_PROMPT,
  DEFAULT_CHAT_MAX_TOKENS,
  DEFAULT_CHAT_MODEL,
  DEFAULT_MAX_TOOL_ITERATIONS,
  DEFAULT_TENANT_ID,
  formatUsageLine,
  interactiveApprover,
  lineReaderFromIterable,
  linesFromReadable,
  runChatRepl,
  type CompletionProvider,
  type LineReader,
} from "./chat.js";
import {
  autoApprover,
  buildToolCatalog,
  type ChatToolDefinition,
  type WriteApprover,
} from "./tools.js";
import type { ParsedCommand } from "./cli.js";
import { getBooleanFlag, getStringFlag } from "./cli.js";
import {
  formatDiff,
  formatManifestSummary,
  formatValidationErrors,
  printError,
  printJson,
  printSuccess,
  type DiffCounts,
  type IoStreams,
} from "./format.js";
import {
  buildManifestSummary,
  emptyManifest,
  readManifestFile,
  writeManifestFile,
} from "./manifest-io.js";

export interface RunContext {
  readonly io: IoStreams;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: AsyncIterable<string>;
  readonly lineReader?: LineReader;
  readonly providerOverride?: LlmProvider;
  readonly transcriptOverride?: Transcript;
}

export async function runInit(
  command: ParsedCommand,
  ctx: RunContext,
): Promise<number> {
  const [outputPath] = command.positional;
  if (outputPath === undefined) {
    printError(ctx.io, "init: missing output path. usage: crossengin init <path>");
    return 2;
  }
  const name = getStringFlag(command, "name") ?? "New CrossEngin Pack";
  const slug = getStringFlag(command, "slug") ?? "new-pack";
  const description = getStringFlag(command, "description") ?? undefined;
  const force = getBooleanFlag(command, "force");
  let manifest: Manifest;
  try {
    manifest = emptyManifest({ name, slug, description });
  } catch (err) {
    printError(ctx.io, `init: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  try {
    await writeManifestFile(outputPath, manifest, { force });
  } catch (err) {
    printError(ctx.io, `init: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (command.format === "json") {
    printJson(ctx.io, { ok: true, path: outputPath, hash: manifestHash(manifest) });
  } else {
    printSuccess(ctx.io, `wrote manifest scaffold to ${outputPath}`);
  }
  return 0;
}

export async function runValidate(
  command: ParsedCommand,
  ctx: RunContext,
): Promise<number> {
  const [path] = command.positional;
  if (path === undefined) {
    printError(ctx.io, "validate: missing path. usage: crossengin validate <path>");
    return 2;
  }
  let manifest: Manifest;
  try {
    manifest = await readManifestFile(path);
  } catch (err) {
    printError(ctx.io, `validate: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const result = tryValidateManifest(manifest);
  if (!result.ok) {
    if (command.format === "json") {
      printJson(ctx.io, { ok: false, errors: result.errors });
    } else {
      printError(ctx.io, formatValidationErrors(result.errors));
    }
    return 1;
  }
  try {
    validateManifest(manifest);
  } catch (err) {
    if (command.format === "json") {
      printJson(ctx.io, {
        ok: false,
        errors: [{ path: "manifest", message: err instanceof Error ? err.message : String(err) }],
      });
    } else {
      printError(ctx.io, `validate: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 1;
  }
  const summary = buildManifestSummary(manifest);
  if (command.format === "json") {
    printJson(ctx.io, { ok: true, summary });
  } else {
    printSuccess(ctx.io, "manifest is valid");
    printSuccess(ctx.io, formatManifestSummary(summary));
  }
  return 0;
}

export async function runDiff(
  command: ParsedCommand,
  ctx: RunContext,
): Promise<number> {
  const [oldPath, newPath] = command.positional;
  if (oldPath === undefined || newPath === undefined) {
    printError(ctx.io, "diff: missing path. usage: crossengin diff <old> <new>");
    return 2;
  }
  let oldManifest: Manifest;
  let newManifest: Manifest;
  try {
    oldManifest = await readManifestFile(oldPath);
    newManifest = await readManifestFile(newPath);
  } catch (err) {
    printError(ctx.io, `diff: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const diff = computeManifestDiff(oldManifest, newManifest);
  if (command.format === "json") {
    printJson(ctx.io, { diff });
    return 0;
  }
  const counts = countDiff(diff);
  printSuccess(ctx.io, formatDiff(counts));
  return 0;
}

function countDiff(diff: ReturnType<typeof computeManifestDiff>): DiffCounts {
  return {
    entitiesAdded: diff.addedEntities.length,
    entitiesRemoved: diff.removedEntities.length,
    entitiesModified: diff.modifiedEntities.length,
    workflowsAdded: 0,
    workflowsRemoved: 0,
    workflowsModified: 0,
  };
}

export async function runHash(
  command: ParsedCommand,
  ctx: RunContext,
): Promise<number> {
  const [path] = command.positional;
  if (path === undefined) {
    printError(ctx.io, "hash: missing path. usage: crossengin hash <path>");
    return 2;
  }
  let manifest: Manifest;
  try {
    manifest = await readManifestFile(path);
  } catch (err) {
    printError(ctx.io, `hash: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const hash = manifestHash(manifest);
  if (command.format === "json") {
    printJson(ctx.io, { hash });
  } else {
    printSuccess(ctx.io, hash);
  }
  return 0;
}

export async function runPatch(
  command: ParsedCommand,
  ctx: RunContext,
): Promise<number> {
  const [basePath, patchPath] = command.positional;
  if (basePath === undefined || patchPath === undefined) {
    printError(ctx.io, "patch: missing path. usage: crossengin patch <base> <patch>");
    return 2;
  }
  let patchManifest: Manifest;
  try {
    patchManifest = await readManifestFile(patchPath);
  } catch (err) {
    printError(ctx.io, `patch: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const outputPath = getStringFlag(command, "output") ?? basePath;
  const force = getBooleanFlag(command, "force") || outputPath === basePath;
  try {
    await writeManifestFile(outputPath, patchManifest, { force });
  } catch (err) {
    printError(ctx.io, `patch: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const hash = manifestHash(patchManifest);
  if (command.format === "json") {
    printJson(ctx.io, { ok: true, path: outputPath, hash });
  } else {
    printSuccess(ctx.io, `wrote ${outputPath} (hash ${hash})`);
  }
  return 0;
}

export const DEFAULT_CHAT_OPENAI_MODEL: OpenAiChatModel = "gpt-4o";
export const CHAT_PROVIDER_CHOICES: ReadonlySet<string> = new Set(["auto", "anthropic", "openai"]);

type ProviderBuild =
  | { readonly provider: CompletionProvider; readonly describeLastTurn: () => string | null }
  | { readonly error: string; readonly code: number };

function buildChatRouter(
  anthropic: AnthropicProvider,
  openai: OpenAiProvider,
  anthropicModel: AnthropicModel,
  openaiModel: OpenAiChatModel,
  onResolved: (resolution: RouterResolution) => void,
): DefaultLlmRouter {
  const providers = new Map<string, LlmProvider>([
    ["anthropic", anthropic],
    ["openai", openai],
  ]);
  const textChain = {
    primary: `anthropic/${anthropicModel}`,
    fallback: [`openai/${openaiModel}`],
  };
  const taskPolicies: TaskPolicyMap = {
    planner: textChain,
    executor: textChain,
    summarizer: textChain,
    "diff-narrator": textChain,
    classifier: textChain,
    rerank: textChain,
    embedding: { primary: "openai/text-embedding-3-small", fallback: [] },
  };
  return new DefaultLlmRouter({
    providers,
    taskPolicies,
    getTenantResidency: async (): Promise<TenantResidency> => "unrestricted",
    onResolved,
  });
}

function describeResolution(r: RouterResolution | null): string | null {
  if (r === null) return null;
  const model = r.modelId ?? "?";
  return r.fallbackDepth > 0 ? `${r.providerId}/${model} (fallback)` : `${r.providerId}/${model}`;
}

/**
 * Builds the chat completion source. An explicit `providerOverride` (tests)
 * wins. Otherwise: `--provider anthropic|openai` forces a single vendor;
 * `auto` (default) builds a multi-vendor `DefaultLlmRouter` (Anthropic
 * primary, OpenAI fallback) when both API keys are present, else the single
 * available provider.
 */
export function buildChatProvider(
  ctx: RunContext,
  opts: { model: AnthropicModel; openaiModel: OpenAiChatModel; choice: string },
): ProviderBuild {
  if (ctx.providerOverride !== undefined) {
    return { provider: ctx.providerOverride, describeLastTurn: () => null };
  }

  const anthropicKey = ctx.env["ANTHROPIC_API_KEY"];
  const openaiKey = ctx.env["OPENAI_API_KEY"];
  const hasAnthropic = anthropicKey !== undefined && anthropicKey.length > 0;
  const hasOpenai = openaiKey !== undefined && openaiKey.length > 0;
  const makeAnthropic = (): AnthropicProvider =>
    new AnthropicProvider({ apiKey: anthropicKey as string, defaultModel: opts.model });
  const makeOpenai = (): OpenAiProvider =>
    new OpenAiProvider({ apiKey: openaiKey as string, defaultModel: opts.openaiModel });

  if (opts.choice === "anthropic") {
    if (!hasAnthropic) return { error: "chat: --provider anthropic requires ANTHROPIC_API_KEY.", code: 1 };
    return { provider: makeAnthropic(), describeLastTurn: () => `anthropic/${opts.model}` };
  }
  if (opts.choice === "openai") {
    if (!hasOpenai) return { error: "chat: --provider openai requires OPENAI_API_KEY.", code: 1 };
    return { provider: makeOpenai(), describeLastTurn: () => `openai/${opts.openaiModel}` };
  }
  if (hasAnthropic && hasOpenai) {
    let lastResolution: RouterResolution | null = null;
    const router = buildChatRouter(makeAnthropic(), makeOpenai(), opts.model, opts.openaiModel, (r) => {
      lastResolution = r;
    });
    return { provider: router, describeLastTurn: () => describeResolution(lastResolution) };
  }
  if (hasAnthropic) return { provider: makeAnthropic(), describeLastTurn: () => `anthropic/${opts.model}` };
  if (hasOpenai) return { provider: makeOpenai(), describeLastTurn: () => `openai/${opts.openaiModel}` };
  return {
    error: "chat: set ANTHROPIC_API_KEY and/or OPENAI_API_KEY before running 'crossengin chat'.",
    code: 1,
  };
}

export async function runChat(
  command: ParsedCommand,
  ctx: RunContext,
): Promise<number> {
  const modelFlag = getStringFlag(command, "model") ?? DEFAULT_CHAT_MODEL;
  if (!isAnthropicModel(modelFlag)) {
    printError(ctx.io, `chat: unsupported model: ${modelFlag}`);
    return 2;
  }
  const model: AnthropicModel = modelFlag;
  const maxTokensFlag = getStringFlag(command, "max-tokens");
  const maxTokens =
    maxTokensFlag !== null ? Number.parseInt(maxTokensFlag, 10) : DEFAULT_CHAT_MAX_TOKENS;
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    printError(ctx.io, `chat: invalid --max-tokens: ${maxTokensFlag ?? ""}`);
    return 2;
  }
  let systemPrompt = DEFAULT_ARCHITECT_SYSTEM_PROMPT;
  const systemFlag = getStringFlag(command, "system");
  if (systemFlag !== null) systemPrompt = systemFlag;
  const systemFile = getStringFlag(command, "system-file");
  if (systemFile !== null) {
    try {
      systemPrompt = await readFile(systemFile, "utf8");
    } catch (err) {
      printError(ctx.io, `chat: failed to read --system-file: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  const tenantId = getStringFlag(command, "tenant-id") ?? DEFAULT_TENANT_ID;
  const sessionId =
    getStringFlag(command, "session-id") ?? `cli-${Date.now().toString(36)}`;
  const prompt = getStringFlag(command, "prompt") ?? undefined;
  const oneShot = prompt !== undefined || getBooleanFlag(command, "one-shot");
  const toolsDisabled = getBooleanFlag(command, "no-tools");
  const allowFileRead = getBooleanFlag(command, "allow-file-read");
  const allowFileWrite = getBooleanFlag(command, "allow-file-write");
  const autoApprove = getBooleanFlag(command, "auto-approve-writes");
  const maxIterationsFlag = getStringFlag(command, "max-tool-iterations");
  const maxToolIterations =
    maxIterationsFlag !== null
      ? Number.parseInt(maxIterationsFlag, 10)
      : DEFAULT_MAX_TOOL_ITERATIONS;
  if (!Number.isFinite(maxToolIterations) || maxToolIterations <= 0) {
    printError(ctx.io, `chat: invalid --max-tool-iterations: ${maxIterationsFlag ?? ""}`);
    return 2;
  }
  const lines: LineReader =
    ctx.lineReader ??
    lineReaderFromIterable(
      ctx.stdin ?? (oneShot ? emptyStdin() : linesFromReadable(process.stdin)),
    );
  let approver: WriteApprover | undefined;
  if (allowFileWrite) {
    if (autoApprove) {
      approver = autoApprover(true);
    } else if (oneShot) {
      printError(
        ctx.io,
        "chat: --allow-file-write in one-shot mode requires --auto-approve-writes (no interactive prompt available).",
      );
      return 2;
    } else {
      approver = interactiveApprover({ io: ctx.io, reader: lines });
    }
  }
  let toolCatalog: readonly ChatToolDefinition[] | undefined;
  if (!toolsDisabled) {
    toolCatalog = buildToolCatalog({
      allowFileRead,
      allowFileWrite,
      approver,
    });
  }

  const providerChoice = getStringFlag(command, "provider") ?? "auto";
  if (!CHAT_PROVIDER_CHOICES.has(providerChoice)) {
    printError(ctx.io, `chat: invalid --provider '${providerChoice}' (expected auto, anthropic, or openai).`);
    return 2;
  }
  const openaiModelFlag = getStringFlag(command, "openai-model") ?? DEFAULT_CHAT_OPENAI_MODEL;
  if (!isOpenAiChatModel(openaiModelFlag)) {
    printError(ctx.io, `chat: unsupported --openai-model: ${openaiModelFlag}`);
    return 2;
  }

  const built = buildChatProvider(ctx, { model, openaiModel: openaiModelFlag, choice: providerChoice });
  if ("error" in built) {
    printError(ctx.io, built.error);
    return built.code;
  }
  const provider: CompletionProvider = built.provider;

  const persistFlag = getBooleanFlag(command, "persist");
  let transcript: Transcript | undefined = ctx.transcriptOverride;
  let pgConnection: PgConnection | null = null;
  if (transcript === undefined && persistFlag) {
    try {
      const config = parsePgEnvConfig(ctx.env);
      pgConnection = createNodePgConnection(config);
      transcript = new PostgresTranscript(pgConnection);
    } catch (err) {
      printError(
        ctx.io,
        `chat: --persist requires PG env vars (PGHOST/PGDATABASE/...): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  try {
    const result = await runChatRepl({
      provider,
      io: ctx.io,
      lines,
      systemPrompt,
      tenantId,
      sessionId,
      model,
      maxTokens,
      format: command.format,
      prompt,
      oneShot,
      toolCatalog,
      maxToolIterations,
      transcript,
      autoApprove,
      providerLabel: built.describeLastTurn,
    });
    if (command.format === "json") {
      printJson(ctx.io, {
        ok: true,
        turns: result.turns,
        aggregateUsage: result.aggregateUsage,
      });
    } else {
      ctx.io.stdout.write(
        `\nSession ended after ${result.turns.toString()} turn(s). Aggregate ${formatUsageLine(result.aggregateUsage)}.\n`,
      );
    }
    return 0;
  } catch (err) {
    printError(ctx.io, `chat: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    if (pgConnection !== null) {
      await pgConnection.close().catch(() => {
        // Best-effort close; ignore errors during cleanup.
      });
    }
  }
}

async function* emptyStdin(): AsyncGenerator<string, void, void> {
  // Intentionally empty — one-shot mode skips the REPL loop entirely.
}

export interface VersionInfo {
  readonly cliVersion: string;
  readonly metaTablesCount: number;
}

export function runVersion(
  command: ParsedCommand,
  ctx: RunContext,
  info: VersionInfo,
): number {
  if (command.format === "json") {
    printJson(ctx.io, info);
  } else {
    printSuccess(ctx.io, `crossengin ${info.cliVersion}`);
    printSuccess(ctx.io, `META_TABLES: ${info.metaTablesCount.toString()}`);
  }
  return 0;
}
