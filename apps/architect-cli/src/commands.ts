import { readFile } from "node:fs/promises";

import type { LlmProvider } from "@crossengin/ai-providers";
import type { CostCeiling } from "@crossengin/ai-router";

import {
  buildChatCompleter,
  NoProvidersConfiguredError,
} from "./router-setup.js";
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
  DEFAULT_MAX_TOOL_ITERATIONS,
  DEFAULT_TENANT_ID,
  formatUsageLine,
  interactiveApprover,
  lineReaderFromIterable,
  linesFromReadable,
  runChatRepl,
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

export async function runChat(
  command: ParsedCommand,
  ctx: RunContext,
): Promise<number> {
  const modelFlag = getStringFlag(command, "model");
  const model = modelFlag ?? undefined;
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

  const costCeilingFlag = getStringFlag(command, "cost-ceiling-usd");
  let costCeiling: CostCeiling | undefined;
  if (costCeilingFlag !== null) {
    const parsed = Number.parseFloat(costCeilingFlag);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      printError(ctx.io, `chat: invalid --cost-ceiling-usd: ${costCeilingFlag}`);
      return 2;
    }
    costCeiling = { maxUsdPerRequest: parsed };
  }
  const maxCostFlag = getStringFlag(command, "max-cost-usd");
  let maxCostUsd: number | undefined;
  if (maxCostFlag !== null) {
    const parsed = Number.parseFloat(maxCostFlag);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      printError(ctx.io, `chat: invalid --max-cost-usd: ${maxCostFlag}`);
      return 2;
    }
    maxCostUsd = parsed;
  }

  let provider: LlmProvider;
  let providerInfo: { providerKind: "single" | "router"; availableProviders: readonly string[] } = {
    providerKind: "single",
    availableProviders: ["override"],
  };
  if (ctx.providerOverride !== undefined) {
    provider = ctx.providerOverride;
  } else {
    try {
      const built = buildChatCompleter({
        env: ctx.env,
        forceModel: model,
        costCeiling,
      });
      provider = built.provider;
      providerInfo = {
        providerKind: built.providerKind,
        availableProviders: built.availableProviders,
      };
    } catch (err) {
      if (err instanceof NoProvidersConfiguredError) {
        printError(ctx.io, err.message);
        return 1;
      }
      throw err;
    }
    if (model !== undefined && !provider.models.includes(model)) {
      printError(
        ctx.io,
        `chat: unsupported model: ${model} (available: ${provider.models.join(", ")})`,
      );
      return 2;
    }
  }

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
      maxCostUsd,
    });
    if (command.format === "json") {
      printJson(ctx.io, {
        ok: true,
        turns: result.turns,
        aggregateUsage: result.aggregateUsage,
        providerKind: providerInfo.providerKind,
        availableProviders: providerInfo.availableProviders,
        ...(result.budgetExceeded === true ? { budgetExceeded: true } : {}),
      });
    } else {
      const providerSuffix =
        providerInfo.providerKind === "router"
          ? ` (router over ${providerInfo.availableProviders.join(" + ")})`
          : "";
      ctx.io.stdout.write(
        `\nSession ended after ${result.turns.toString()} turn(s)${providerSuffix}. Aggregate ${formatUsageLine(result.aggregateUsage)}.\n`,
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
