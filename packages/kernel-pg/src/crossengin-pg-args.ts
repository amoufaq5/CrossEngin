import { parseFlags, parseNonNegativeIntegerFlag, type FlagSpec, type ParsedFlags } from "./cli-flags.js";

export const CROSSENGIN_PG_COMMANDS = ["apply", "drift", "inspect", "encrypt", "version", "help"] as const;
export type CrossenginPgCommand = (typeof CROSSENGIN_PG_COMMANDS)[number];

/** The bounds `apply` and `drift` accept, as the CLI parsed them; absent means the library default. */
export interface MigrationBounds {
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly lockRetries?: number;
}

const BOUND_FLAGS = {
  "lock-timeout-ms": "value",
  "statement-timeout-ms": "value",
  "lock-retries": "value",
} as const satisfies FlagSpec;

/** Every flag each command reads, and nothing else; a total map so a new command must declare its own. */
export const CROSSENGIN_PG_FLAGS: Readonly<Record<CrossenginPgCommand, FlagSpec>> = {
  apply: {
    help: "boolean",
    "dry-run": "boolean",
    plan: "boolean",
    confirm: "boolean",
    "allow-loosening": "boolean",
    ...BOUND_FLAGS,
  },
  drift: {
    help: "boolean",
    json: "boolean",
    "exit-zero-on-drift": "boolean",
    "lock-timeout-ms": "value",
  },
  inspect: { help: "boolean", json: "boolean" },
  encrypt: {
    help: "boolean",
    verify: "boolean",
    plan: "boolean",
    apply: "boolean",
    confirm: "boolean",
    provision: "boolean",
    json: "boolean",
    "exit-zero-on-drift": "boolean",
    schema: "value",
    "key-ref": "value",
  },
  version: { help: "boolean" },
  help: { help: "boolean" },
};

export type CrossenginPgArgs =
  | {
      readonly ok: true;
      readonly command: CrossenginPgCommand;
      readonly flags: ParsedFlags;
      readonly bounds: MigrationBounds;
    }
  | { readonly ok: false; readonly error: string };

function isCommand(value: string): value is CrossenginPgCommand {
  return (CROSSENGIN_PG_COMMANDS as readonly string[]).includes(value);
}

/**
 * The command is the first argument and nothing else positional is accepted. An unknown command is a
 * refusal and not help: `aply` printed help and exited 0, which a script reads as success.
 */
export function parseCrossenginPgArgs(argv: readonly string[]): CrossenginPgArgs {
  const args = argv.slice(2);
  const first = args[0];
  if (first === undefined || first === "--help") {
    return { ok: true, command: "help", flags: { positional: [], booleans: new Set(), values: new Map() }, bounds: {} };
  }
  if (first.startsWith("--")) {
    return { ok: false, error: `expected a command before ${first}` };
  }
  if (!isCommand(first)) return { ok: false, error: `unknown command '${first}'` };
  const parsed = parseFlags(args.slice(1), CROSSENGIN_PG_FLAGS[first]);
  if (!parsed.ok) return { ok: false, error: `${first}: ${parsed.error}` };
  if (parsed.flags.positional.length > 0) {
    return { ok: false, error: `${first}: unexpected argument '${parsed.flags.positional[0]!}'` };
  }
  const bounds: { lockTimeoutMs?: number; statementTimeoutMs?: number; lockRetries?: number } = {};
  const keys = {
    "lock-timeout-ms": "lockTimeoutMs",
    "statement-timeout-ms": "statementTimeoutMs",
    "lock-retries": "lockRetries",
  } as const;
  for (const [flag, key] of Object.entries(keys) as [keyof typeof keys, (typeof keys)[keyof typeof keys]][]) {
    const raw = parsed.flags.values.get(flag);
    if (raw === undefined) continue;
    const n = parseNonNegativeIntegerFlag(flag, raw);
    if (!n.ok) return { ok: false, error: `${first}: ${n.error}` };
    bounds[key] = n.value;
  }
  const command = parsed.flags.booleans.has("help") ? "help" : first;
  return { ok: true, command, flags: parsed.flags, bounds };
}
