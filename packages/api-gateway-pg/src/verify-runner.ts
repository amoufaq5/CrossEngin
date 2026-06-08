import type { ExecutionVerifyReport } from "./replayer.js";

export type ExecutionsCommand = "verify" | "summary";
export type OutputFormat = "human" | "json";

/** The resolved options an `executions` command runs with (a CLI parser produces these). */
export interface ExecutionsCliOptions {
  readonly command: ExecutionsCommand;
  readonly since: string | null;
  readonly tenantId: string | null;
  readonly maxExecutions: number | null;
  readonly batchSize: number | null;
  readonly format: OutputFormat;
  readonly help: boolean;
}

/**
 * The structural read surface the runner needs — `GatewayReplayer` satisfies it
 * (its `bulkVerify` returns one report per execution in the window). Keeping the
 * runner over this interface lets it be offline-tested with a fake source.
 */
export interface ExecutionVerifySource {
  bulkVerify(opts?: {
    readonly since?: Date;
    readonly tenantId?: string;
    readonly batchSize?: number;
    readonly maxExecutions?: number;
  }): Promise<readonly ExecutionVerifyReport[]>;
}

export interface RunVerifyResult {
  readonly exitCode: number;
}

interface VerifySweepSummary {
  readonly executions: number;
  readonly clean: number;
  readonly drifted: number;
  readonly totalIssues: number;
}

/** Folds a set of per-execution reports into clean/drifted/issue counts. */
export function summarizeExecutionReports(
  reports: readonly ExecutionVerifyReport[],
): VerifySweepSummary {
  let drifted = 0;
  let totalIssues = 0;
  for (const r of reports) {
    if (r.drifted) drifted++;
    totalIssues += r.issues.length;
  }
  return {
    executions: reports.length,
    clean: reports.length - drifted,
    drifted,
    totalIssues,
  };
}

/** Human-readable rendering of a verify sweep (per-issue lines + a summary). */
export function formatExecutionVerifyReport(reports: readonly ExecutionVerifyReport[]): string {
  const summary = summarizeExecutionReports(reports);
  const head = `verified ${summary.executions.toString()} execution(s): ${summary.clean.toString()} clean, ${summary.drifted.toString()} drifted with ${summary.totalIssues.toString()} issue(s)`;
  const lines: string[] = [];
  for (const r of reports) {
    if (!r.drifted) continue;
    for (const issue of r.issues) {
      lines.push(`  ${r.requestId}  ${issue.code}  ${issue.detail}`);
    }
  }
  if (lines.length === 0) return `${head}\nOK — no pipeline-execution drift`;
  return [head, ...lines].join("\n");
}

function buildBulkVerifyOpts(options: ExecutionsCliOptions): {
  since?: Date;
  tenantId?: string;
  batchSize?: number;
  maxExecutions?: number;
} {
  const opts: {
    since?: Date;
    tenantId?: string;
    batchSize?: number;
    maxExecutions?: number;
  } = {};
  if (options.since !== null) opts.since = new Date(options.since);
  if (options.tenantId !== null) opts.tenantId = options.tenantId;
  if (options.batchSize !== null) opts.batchSize = options.batchSize;
  if (options.maxExecutions !== null) opts.maxExecutions = options.maxExecutions;
  return opts;
}

/**
 * Executes a parsed `executions` command against a verify source, writing the
 * formatted result to `out`. `verify` runs the drift sweep over the window and
 * exits **1 when any execution drifted** (so CI can gate on "zero
 * pipeline-execution drift"); `summary` reports the same counts but always exits
 * 0. An empty table verifies clean. Pure over the injected source + out — no
 * DB/IO of its own.
 */
export async function runVerifyExecutions(
  options: ExecutionsCliOptions,
  source: ExecutionVerifySource,
  out: (line: string) => void,
): Promise<RunVerifyResult> {
  const reports = await source.bulkVerify(buildBulkVerifyOpts(options));
  const json = options.format === "json";
  if (json) {
    out(JSON.stringify({ summary: summarizeExecutionReports(reports), reports }, null, 2));
  } else {
    out(formatExecutionVerifyReport(reports));
  }
  if (options.command === "summary") return { exitCode: 0 };
  const drifted = reports.some((r) => r.drifted);
  return { exitCode: drifted ? 1 : 0 };
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
 * Parses the `executions <verify|summary>` argv tail into resolved
 * {@link ExecutionsCliOptions}. `argv` is everything after the subcommand word
 * (so `argv[0]` is the command). Throws {@link CliUsageError} on misuse.
 */
export function parseExecutionsArgs(argv: readonly string[]): ExecutionsCliOptions {
  const help = argv.includes("--help") || argv.includes("-h");
  const positional = argv.filter((a) => !a.startsWith("-"));
  const word = positional[0];
  if (help && word === undefined) {
    return {
      command: "verify",
      since: null,
      tenantId: null,
      maxExecutions: null,
      batchSize: null,
      format: "human",
      help: true,
    };
  }
  if (word !== "verify" && word !== "summary") {
    throw new CliUsageError(`unknown executions command '${word ?? ""}' (expected verify|summary)`);
  }
  const formatRaw = flagValue(argv, "format") ?? "human";
  if (formatRaw !== "human" && formatRaw !== "json") {
    throw new CliUsageError(`--format must be human|json`);
  }
  return {
    command: word,
    since: flagValue(argv, "since"),
    tenantId: flagValue(argv, "tenant-id"),
    maxExecutions: parseIntFlag(flagValue(argv, "max"), "max"),
    batchSize: parseIntFlag(flagValue(argv, "batch-size"), "batch-size"),
    format: formatRaw,
    help,
  };
}
