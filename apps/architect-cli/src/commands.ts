import {
  computeManifestDiff,
  manifestHash,
  tryValidateManifest,
  validateManifest,
  type Manifest,
} from "@crossengin/kernel/manifest";

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

export function runChat(_command: ParsedCommand, ctx: RunContext): Promise<number> {
  printSuccess(
    ctx.io,
    "chat mode is not implemented in M5; ships in M5.5 alongside the Anthropic SDK provider binding.",
  );
  return Promise.resolve(0);
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
