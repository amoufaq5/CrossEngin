import type { SloEnforcementActionRecord } from "./records.js";
import {
  summarizeEnforcement,
  type DriftIssue,
  type EnforcementSummary,
} from "./replayer.js";

export type SloCommand = "actions" | "summary" | "verify";
export type OutputFormat = "human" | "json";

/** The resolved options an `slo` command runs with (a CLI parser produces these). */
export interface SloCliOptions {
  readonly command: SloCommand;
  readonly since: string | null;
  readonly limit: number | null;
  readonly format: OutputFormat;
  readonly help: boolean;
}

/**
 * The structural read surface the runner needs — `SloQuerySourceAdapter` (built
 * from `PostgresSloEnforcementActionStore` + `SloEnforcementReplayer`) satisfies
 * it. Keeping the runner over this interface lets it be offline-tested with a
 * fake source.
 */
export interface SloQuerySource {
  listActions(opts: {
    readonly since?: Date;
    readonly limit?: number;
  }): Promise<readonly SloEnforcementActionRecord[]>;
  verifyActions(opts: {
    readonly since?: Date;
    readonly limit?: number;
  }): Promise<readonly DriftIssue[]>;
}

export interface RunSloResult {
  readonly exitCode: number;
}

function actionLine(a: SloEnforcementActionRecord): string {
  const sev = a.severity ?? "-";
  const paged = a.paged ? `paged(${a.pageChannelCount.toString()})` : "no-page";
  return `${a.actionId}  ${a.signal.padEnd(12)}  ${a.surface.padEnd(20)}  ${a.decision.padEnd(14)}  sev=${sev}  ${paged}  ${a.incidentId}  ${a.occurredAt}`;
}

/** Human-readable rendering of an enforcement-action list. */
export function formatSloActions(
  actions: readonly SloEnforcementActionRecord[],
  heading: string,
): string {
  if (actions.length === 0) return `${heading}: none`;
  const lines = actions.map(actionLine);
  return [`${heading} (${actions.length.toString()}):`, ...lines].join("\n");
}

/** Human-readable rendering of the `summarizeEnforcement` rollup. */
export function formatSloSummary(summary: EnforcementSummary, heading: string): string {
  return [
    `${heading}:`,
    `  total      ${summary.total.toString()}`,
    `  opened     ${summary.opened.toString()}`,
    `  ongoing    ${summary.ongoing.toString()}`,
    `  recovered  ${summary.recovered.toString()}`,
    `  paged      ${summary.paged.toString()} (${(summary.pagedRatio * 100).toFixed(1)}%)`,
  ].join("\n");
}

/** Human-readable rendering of a verify sweep (per-issue lines + a summary). */
export function formatSloVerify(
  issues: readonly DriftIssue[],
  verifiedActions: number,
): string {
  const head = `verified ${verifiedActions.toString()} enforcement action(s): ${issues.length === 0 ? "no drift" : `${issues.length.toString()} issue(s)`}`;
  if (issues.length === 0) return `${head}\nOK — no enforcement-history drift`;
  const lines = issues.map((i) => `  ${i.actionId}  ${i.incidentId}  ${i.kind}  ${i.detail}`);
  return [head, ...lines].join("\n");
}

function buildOpts(options: SloCliOptions): { since?: Date; limit?: number } {
  const opts: { since?: Date; limit?: number } = {};
  if (options.since !== null) opts.since = new Date(options.since);
  if (options.limit !== null) opts.limit = options.limit;
  return opts;
}

/**
 * Executes a parsed `slo` command against a query source, writing the formatted
 * result to `out`. `actions` lists recent enforcement actions; `summary`
 * aggregates the `summarizeEnforcement` rollup; `verify` runs
 * `verifyEnforcementHistory` over the window and exits **1 when any drift is
 * found** (so CI can gate on "zero enforcement-history drift"). An empty table
 * verifies clean. Pure over the injected source + out — no DB/IO of its own.
 */
export async function runSloQuery(
  options: SloCliOptions,
  source: SloQuerySource,
  out: (line: string) => void,
): Promise<RunSloResult> {
  const json = options.format === "json";
  const opts = buildOpts(options);
  const window = options.since !== null ? `since ${options.since}` : "recent";

  if (options.command === "actions") {
    const actions = await source.listActions(opts);
    out(json ? JSON.stringify(actions, null, 2) : formatSloActions(actions, `enforcement actions ${window}`));
    return { exitCode: 0 };
  }
  if (options.command === "summary") {
    const actions = await source.listActions(opts);
    const summary = summarizeEnforcement(actions);
    out(json ? JSON.stringify(summary, null, 2) : formatSloSummary(summary, `enforcement summary ${window}`));
    return { exitCode: 0 };
  }
  // verify
  const actions = await source.listActions(opts);
  const issues = await source.verifyActions(opts);
  if (json) {
    out(JSON.stringify({ verifiedActions: actions.length, issues }, null, 2));
  } else {
    out(formatSloVerify(issues, actions.length));
  }
  return { exitCode: issues.length > 0 ? 1 : 0 };
}

export class CliUsageError extends Error {}

function flagValue(argv: readonly string[], name: string): string | null {
  const inlinePrefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith(inlinePrefix)) return arg.slice(inlinePrefix.length);
    if (arg === `--${name}`) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new CliUsageError(`--${name} requires a value`);
      }
      return next;
    }
  }
  return null;
}

function parseIntFlag(value: string | null, name: string): number | null {
  if (value === null) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliUsageError(`--${name} must be a positive integer`);
  }
  return n;
}

/**
 * Parses the `slo <actions|summary|verify>` argv tail into resolved
 * {@link SloCliOptions}. `argv` is everything after the subcommand word (so
 * `argv[0]` is the command). Throws {@link CliUsageError} on misuse.
 */
export function parseSloArgs(argv: readonly string[]): SloCliOptions {
  const help = argv.includes("--help") || argv.includes("-h");
  const positional = argv.filter((a) => !a.startsWith("-"));
  const word = positional[0];
  if (help && word === undefined) {
    return { command: "verify", since: null, limit: null, format: "human", help: true };
  }
  if (word !== "actions" && word !== "summary" && word !== "verify") {
    throw new CliUsageError(`unknown slo command '${word ?? ""}' (expected actions|summary|verify)`);
  }
  const formatRaw = flagValue(argv, "format") ?? "human";
  if (formatRaw !== "human" && formatRaw !== "json") {
    throw new CliUsageError(`--format must be human|json`);
  }
  return {
    command: word,
    since: flagValue(argv, "since"),
    limit: parseIntFlag(flagValue(argv, "limit"), "limit"),
    format: formatRaw,
    help,
  };
}
