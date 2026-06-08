import { BUILTIN_PACK_NAMES } from "./manifest-source.js";

export interface WebServeOptions {
  readonly port: number;
  readonly pack: string | null;
  readonly manifestPath: string | null;
  readonly apiKeys: readonly string[];
  readonly help: boolean;
  readonly version: boolean;
}

export class CliUsageError extends Error {}

const DEFAULT_PORT = 8788;

function takeValue(arg: string, next: string | undefined, flag: string): string {
  if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
  if (next === undefined) throw new CliUsageError(`flag ${flag} requires a value`);
  return next;
}

function isInline(arg: string): boolean {
  return arg.includes("=");
}

/**
 * Parses `operate-web` argv into `WebServeOptions`. Supports `--flag value` and
 * `--flag=value`; `--api-key` repeats. Exactly one of `--pack` / `--manifest` is
 * required (unless `--help` / `--version`).
 */
export function parseWebArgs(argv: readonly string[]): WebServeOptions {
  let port = DEFAULT_PORT;
  let pack: string | null = null;
  let manifestPath: string | null = null;
  const apiKeys: string[] = [];
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = argv[i + 1];
    const consumed = (): number => (isInline(arg) ? 0 : 1);
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg === "--port" || arg.startsWith("--port=")) {
      const raw = takeValue(arg, next, "--port");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new CliUsageError(`invalid --port: ${raw}`);
      port = n;
      i += consumed();
    } else if (arg === "--pack" || arg.startsWith("--pack=")) {
      pack = takeValue(arg, next, "--pack");
      i += consumed();
    } else if (arg === "--manifest" || arg.startsWith("--manifest=")) {
      manifestPath = takeValue(arg, next, "--manifest");
      i += consumed();
    } else if (arg === "--api-key" || arg.startsWith("--api-key=")) {
      apiKeys.push(takeValue(arg, next, "--api-key"));
      i += consumed();
    } else {
      throw new CliUsageError(`unknown argument: ${arg}`);
    }
  }

  if (!help && !version) {
    if (pack === null && manifestPath === null) {
      throw new CliUsageError("one of --pack or --manifest is required");
    }
    if (pack !== null && manifestPath !== null) {
      throw new CliUsageError("--pack and --manifest are mutually exclusive");
    }
  }

  return { port, pack, manifestPath, apiKeys, help, version };
}

export const helpText = `operate-web — serve a resolved CrossEngin manifest as redaction-aware UI view models

Usage:
  operate-web --pack <name> [options]
  operate-web --manifest <file.json> [options]

Manifest source (exactly one):
  --pack <name>        Built-in vertical pack: ${BUILTIN_PACK_NAMES.join(", ")}
  --manifest <file>    Path to a resolved manifest JSON document

Options:
  --port <n>           Port to listen on (default 8788)
  --api-key <spec>     API key binding key:role:tenant (repeatable)
  --help, -h           Show this help
  --version, -v        Print version

Routes (all GET, JSON; auth via x-api-key or Authorization: Bearer <key>):
  /ui/app              The app view model (title + per-entity nav)
  /ui/:entity          { table, page: { data, nextCursor } } — model + data page
  /ui/:entity/new      { form } — the create form model
  /ui/:entity/:id      { detail, record } — record view + the record

Every model + every data row is compiled / redacted for the caller's role, so a
field the viewer can't read never appears in the JSON.
`;
