/**
 * Strict command-line flags for the migration CLIs (H-23).
 *
 * The parser this replaces kept every `--x` and dropped every `--x=…`, so `apply --plan=true` was an
 * *apply* — measured: it executed a statement — and so was the misspelt `apply --paln`. An unknown
 * command printed help and exited 0. On a command whose effect is DDL against a live database a flag
 * that is not understood must refuse, because the one thing the operator was trying to say may be
 * the one thing that made the run harmless.
 */
export type FlagKind = "boolean" | "value";
export type FlagSpec = Readonly<Record<string, FlagKind>>;

export interface ParsedFlags {
  readonly positional: readonly string[];
  readonly booleans: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
}

export type FlagParse =
  | { readonly ok: true; readonly flags: ParsedFlags }
  | { readonly ok: false; readonly error: string };

/**
 * A boolean is bare or explicitly `=true`/`=false` (`1`/`0`); anything else is refused rather than
 * read as false, since `--plan=yes` read as false is an apply. A value flag takes `--x=v` or `--x v`.
 * A flag named twice is refused: which of two values wins must not depend on argv order.
 */
export function parseFlags(args: readonly string[], spec: FlagSpec): FlagParse {
  const positional: string[] = [];
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inline = eq >= 0 ? arg.slice(eq + 1) : null;
    const kind = Object.prototype.hasOwnProperty.call(spec, name) ? spec[name] : undefined;
    if (kind === undefined) return { ok: false, error: `unknown flag --${name}` };
    if (seen.has(name)) return { ok: false, error: `--${name} given more than once` };
    seen.add(name);
    if (kind === "boolean") {
      if (inline === null || inline === "true" || inline === "1") booleans.add(name);
      else if (inline !== "false" && inline !== "0") {
        return { ok: false, error: `--${name} takes no value, or =true / =false; got '${inline}'` };
      }
      continue;
    }
    if (inline !== null) {
      values.set(name, inline);
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      return { ok: false, error: `--${name} needs a value` };
    }
    values.set(name, next);
    i++;
  }
  return { ok: true, flags: { positional, booleans, values } };
}

/** A non-negative integer count of milliseconds or retries, or a refusal naming the flag. */
export function parseNonNegativeIntegerFlag(
  name: string,
  raw: string,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string } {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) {
    return { ok: false, error: `--${name} must be a non-negative whole number; got '${raw}'` };
  }
  return { ok: true, value };
}
