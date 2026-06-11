import { CliUsageError } from "./cli.js";

/**
 * Options for `operate-server openapi-client` (P3.38) — emit a typed TypeScript
 * client projected from the manifest's served OpenAPI document. Exactly one of
 * `--pack` / `--manifest`; `--out` writes to a file (else stdout).
 */
export type ClientLang = "ts" | "python";

export interface OpenApiClientOptions {
  readonly pack: string | null;
  readonly manifestPath: string | null;
  readonly lang: ClientLang;
  readonly out: string | null;
  readonly clientName: string | null;
  readonly help: boolean;
}

function takeValue(arg: string, next: string | undefined, flag: string): string {
  if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
  if (next === undefined) throw new CliUsageError(`flag ${flag} requires a value`);
  return next;
}

export function parseOpenApiClientArgs(argv: readonly string[]): OpenApiClientOptions {
  let pack: string | null = null;
  let manifestPath: string | null = null;
  let lang: ClientLang = "ts";
  let out: string | null = null;
  let clientName: string | null = null;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = argv[i + 1];
    const consumed = (): number => (arg.includes("=") ? 0 : 1);
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--pack" || arg.startsWith("--pack=")) {
      pack = takeValue(arg, next, "--pack");
      i += consumed();
    } else if (arg === "--manifest" || arg.startsWith("--manifest=")) {
      manifestPath = takeValue(arg, next, "--manifest");
      i += consumed();
    } else if (arg === "--lang" || arg.startsWith("--lang=")) {
      const raw = takeValue(arg, next, "--lang");
      if (raw !== "ts" && raw !== "python") throw new CliUsageError(`invalid --lang: ${raw} (ts|python)`);
      lang = raw;
      i += consumed();
    } else if (arg === "--out" || arg.startsWith("--out=")) {
      out = takeValue(arg, next, "--out");
      i += consumed();
    } else if (arg === "--client-name" || arg.startsWith("--client-name=")) {
      clientName = takeValue(arg, next, "--client-name");
      i += consumed();
    } else {
      throw new CliUsageError(`unknown flag: ${arg}`);
    }
  }

  if (!help && (pack === null) === (manifestPath === null)) {
    throw new CliUsageError("exactly one of --pack / --manifest is required");
  }
  return { pack, manifestPath, lang, out, clientName, help };
}

export const openApiClientHelpText = `operate-server openapi-client — emit a typed TypeScript client from the OpenAPI document

Usage:
  operate-server openapi-client (--pack <alias> | --manifest <file>) [--out <file>] [--client-name <name>]

Flags:
  --pack <alias>         built-in vertical pack (erp-core | erp-retail | erp-healthcare | erp-grocery)
  --manifest <file>      a pre-resolved manifest JSON
  --lang <ts|python>     target language (default ts)
  --out <file>           write the client module to a file (default: stdout)
  --client-name <name>   factory/class name (default: createOperateClient / OperateClient)
  --help / -h
`;
