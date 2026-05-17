export const SUBCOMMANDS = [
  "init",
  "validate",
  "diff",
  "patch",
  "hash",
  "apply",
  "chat",
  "version",
  "help",
] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export const OUTPUT_FORMATS = ["human", "json"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export interface ParsedCommand {
  readonly subcommand: Subcommand;
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
  readonly format: OutputFormat;
}

export interface ParseError {
  readonly kind: "parse_error";
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly command: ParsedCommand }
  | { readonly ok: false; readonly error: ParseError };

export function parseArgs(argv: readonly string[]): ParseResult {
  const args = argv.slice(2);
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  let subcommandRaw: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(arg.slice(2), next);
          i += 1;
        } else {
          flags.set(arg.slice(2), true);
        }
      }
      continue;
    }
    if (subcommandRaw === null) {
      subcommandRaw = arg;
    } else {
      positional.push(arg);
    }
  }

  if (subcommandRaw === null) {
    return { ok: true, command: { subcommand: "help", positional, flags, format: "human" } };
  }
  if (!isSubcommand(subcommandRaw)) {
    return {
      ok: false,
      error: { kind: "parse_error", message: `unknown subcommand: ${subcommandRaw}` },
    };
  }
  const formatRaw = flags.get("format");
  let format: OutputFormat = "human";
  if (typeof formatRaw === "string") {
    if (formatRaw !== "human" && formatRaw !== "json") {
      return {
        ok: false,
        error: { kind: "parse_error", message: `unknown output format: ${formatRaw}` },
      };
    }
    format = formatRaw;
  }
  return {
    ok: true,
    command: { subcommand: subcommandRaw, positional, flags, format },
  };
}

export function isSubcommand(value: unknown): value is Subcommand {
  return typeof value === "string" && (SUBCOMMANDS as readonly string[]).includes(value);
}

export function getStringFlag(
  command: ParsedCommand,
  name: string,
): string | null {
  const value = command.flags.get(name);
  if (typeof value === "string") return value;
  return null;
}

export function getBooleanFlag(command: ParsedCommand, name: string): boolean {
  const value = command.flags.get(name);
  return value === true || value === "true" || value === "1";
}

export function helpText(): string {
  return [
    "Usage: crossengin <command> [options]",
    "",
    "Commands:",
    "  init <output>           Scaffold a new manifest file",
    "  validate <path>         Validate a manifest against the kernel schema",
    "  diff <old> <new>        Compare two manifests",
    "  patch <base> <patch>    Apply a manifest patch (writes new manifest)",
    "  hash <path>             Print the deterministic manifest hash",
    "  apply [--dry-run]       Apply the meta-schema to the configured Postgres",
    "  chat                    Interactive AI Architect session (Claude-backed)",
    "  version                 Print the CLI version + workspace info",
    "  help                    Show this help text",
    "",
    "Flags:",
    "  --format human|json     Output format (default: human)",
    "  --force                 With init / patch, overwrite an existing file",
    "  --output <path>         With patch, write the result to a different path",
    "  --dry-run               With apply, emit SQL without executing",
    "  --confirm               Required when PGDATABASE looks like production",
    "  --prompt <text>         With chat, run a one-shot turn and exit",
    "  --model <id>            With chat, pick a Claude model (default: claude-sonnet-4-6)",
    "  --max-tokens <n>        With chat, cap response tokens (default: 4096)",
    "  --system <text>         With chat, override the system prompt",
    "  --system-file <path>    With chat, load the system prompt from a file",
    "  --tenant-id <uuid>      With chat, set the tenant id (default: nil-uuid)",
    "  --session-id <id>       With chat, set the session id (default: cli-<ts>)",
    "  --no-tools              With chat, disable manifest tools (text-only mode)",
    "  --allow-file-read       With chat, expose a read_file tool (json/yaml/txt/md)",
    "  --allow-file-write      With chat, expose propose_manifest_edit (human approval)",
    "  --auto-approve-writes   With chat, skip the y/N prompt for write tools",
    "  --max-tool-iterations N With chat, cap tool-dispatch loops per turn (default: 5)",
    "  --persist               With chat, log session/messages/tools/proposals to Postgres",
    "  --cost-ceiling-usd N    With chat, refuse calls whose estimated cost exceeds N USD",
    "",
    "Environment (for apply / chat --persist):",
    "  PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE, PGAPPNAME",
    "",
    "Environment (for chat):",
    "  ANTHROPIC_API_KEY       Anthropic API key. At least one of the two is required.",
    "  OPENAI_API_KEY          OpenAI API key. With both set, the router fans out.",
    "",
  ].join("\n");
}
