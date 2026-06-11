import { CliUsageError } from "./cli.js";

/**
 * Options for `operate-web web-client` (P3.39) — emit a typed TypeScript
 * view-model client projected from the manifest's `/ui/_describe` descriptor.
 * Exactly one of `--pack` / `--manifest`; `--role` (repeatable) is the viewer the
 * per-caller descriptor is built for; `--out` writes a file (else stdout).
 */
export interface WebClientOptions {
  readonly pack: string | null;
  readonly manifestPath: string | null;
  readonly roles: readonly string[];
  readonly out: string | null;
  readonly clientName: string | null;
  readonly help: boolean;
}

function takeValue(arg: string, next: string | undefined, flag: string): string {
  if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
  if (next === undefined) throw new CliUsageError(`flag ${flag} requires a value`);
  return next;
}

export function parseWebClientArgs(argv: readonly string[]): WebClientOptions {
  let pack: string | null = null;
  let manifestPath: string | null = null;
  const roles: string[] = [];
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
    } else if (arg === "--role" || arg.startsWith("--role=")) {
      roles.push(takeValue(arg, next, "--role"));
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
  return { pack, manifestPath, roles, out, clientName, help };
}

export const webClientHelpText = `operate-web web-client — emit a typed view-model client from the /ui/_describe descriptor

Usage:
  operate-web web-client (--pack <alias> | --manifest <file>) [--role <name>]... [--out <file>] [--client-name <name>]

Flags:
  --pack <alias>         built-in vertical pack (erp-core | erp-retail | erp-healthcare | erp-grocery)
  --manifest <file>      a pre-resolved manifest JSON
  --role <name>          a viewer role the descriptor is built for (repeatable; the client reflects that caller)
  --out <file>           write the client module to a file (default: stdout)
  --client-name <name>   exported factory name (default: createWebClient)
  --help / -h
`;
