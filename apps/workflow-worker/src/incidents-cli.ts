import { CliUsageError } from "./cli.js";
import { computeIncidentMetrics, formatIncidentMetrics } from "./incident-metrics.js";
import {
  summarizeIncidentIssues,
  type IncidentSummary,
  type IncidentTimelineIssue,
  type ListPeriodQuery,
} from "./incident-replayer.js";

export type IncidentsCommand = "open" | "period" | "verify" | "metrics" | "ack" | "mitigate";
export type OutputFormat = "human" | "json";

/** A system actor id used when an `ack`/`mitigate` command omits `--actor`. */
export const DEFAULT_INCIDENT_ACTOR = "00000000-0000-4000-8000-000000000000";

export interface IncidentsCliOptions {
  readonly command: IncidentsCommand;
  readonly incidentId: string | null;
  readonly actor: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly limit: number | null;
  readonly schema: string | null;
  readonly format: OutputFormat;
  readonly help: boolean;
}

const COMMANDS: ReadonlySet<string> = new Set(["open", "period", "verify", "metrics", "ack", "mitigate"]);
const WINDOW_COMMANDS: ReadonlySet<string> = new Set(["period", "verify", "metrics"]);
const WRITE_COMMANDS: ReadonlySet<string> = new Set(["ack", "mitigate"]);

function takeValue(arg: string, next: string | undefined, flag: string): string {
  if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
  if (next === undefined) throw new CliUsageError(`flag ${flag} requires a value`);
  return next;
}

function intFlag(raw: string, flag: string, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new CliUsageError(`invalid ${flag}: ${raw} (integer >= ${min.toString()})`);
  return n;
}

/**
 * Parses `workflow-worker incidents <open|period|verify> [options]` argv (the
 * slice after the `incidents` verb). `period` / `verify` require `--from` +
 * `--to` (an ISO window). `--format human|json` (default human). Throws
 * `CliUsageError` on misuse.
 */
export function parseIncidentsArgs(argv: readonly string[]): IncidentsCliOptions {
  const first = argv[0];
  if (first === "--help" || first === "-h" || first === undefined) {
    return { command: "open", incidentId: null, actor: DEFAULT_INCIDENT_ACTOR, from: null, to: null, limit: null, schema: null, format: "human", help: true };
  }
  if (!COMMANDS.has(first)) throw new CliUsageError(`unknown incidents command: ${first} (open|period|verify|metrics|ack|mitigate)`);
  const command = first as IncidentsCommand;

  let incidentId: string | null = null;
  let actor = DEFAULT_INCIDENT_ACTOR;
  let from: string | null = null;
  let to: string | null = null;
  let limit: number | null = null;
  let schema: string | null = null;
  let format: OutputFormat = "human";
  let help = false;

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = argv[i + 1];
    const consumed = (): number => (arg.includes("=") ? 0 : 1);
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--actor" || arg.startsWith("--actor=")) {
      actor = takeValue(arg, next, "--actor");
      i += consumed();
    } else if (arg === "--from" || arg.startsWith("--from=")) {
      from = takeValue(arg, next, "--from");
      i += consumed();
    } else if (arg === "--to" || arg.startsWith("--to=")) {
      to = takeValue(arg, next, "--to");
      i += consumed();
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      limit = intFlag(takeValue(arg, next, "--limit"), "--limit", 1);
      i += consumed();
    } else if (arg === "--schema" || arg.startsWith("--schema=")) {
      schema = takeValue(arg, next, "--schema");
      i += consumed();
    } else if (arg === "--format" || arg.startsWith("--format=")) {
      const raw = takeValue(arg, next, "--format");
      if (raw !== "human" && raw !== "json") throw new CliUsageError(`invalid --format: ${raw} (human|json)`);
      format = raw;
      i += consumed();
    } else if (!arg.startsWith("-") && WRITE_COMMANDS.has(command) && incidentId === null) {
      incidentId = arg; // positional incident id for ack/mitigate
    } else {
      throw new CliUsageError(`unknown argument: ${arg}`);
    }
  }

  if (WINDOW_COMMANDS.has(command) && (from === null || to === null)) {
    throw new CliUsageError(`incidents ${command} requires --from and --to (an ISO window)`);
  }
  if (WRITE_COMMANDS.has(command) && incidentId === null) {
    throw new CliUsageError(`incidents ${command} requires an incident id (e.g. INC-2026-0001)`);
  }
  return { command, incidentId, actor, from, to, limit, schema, format, help };
}

function summaryLine(s: IncidentSummary): string {
  const kinds = s.timeline.map((e) => e.kind).join(" → ");
  const resolved = s.resolvedAt === null ? "" : ` resolved=${s.resolvedAt}`;
  return `${s.incidentId}  ${s.severity}  ${s.status.padEnd(10)}  ${s.declaredAt}${resolved}  ${s.title}  [${kinds}]`;
}

/** Human-readable rendering of an incident list. */
export function formatIncidentList(summaries: readonly IncidentSummary[], heading: string): string {
  if (summaries.length === 0) return `${heading}: none`;
  const lines = summaries.map(summaryLine);
  return [`${heading} (${summaries.length.toString()}):`, ...lines].join("\n");
}

/** Human-readable rendering of a verify sweep (per-issue lines + a summary). */
export function formatVerifyReport(
  issues: readonly IncidentTimelineIssue[],
  verifiedIncidents: number,
): string {
  const summary = summarizeIncidentIssues(issues, verifiedIncidents);
  const head = `verified ${summary.incidents.toString()} incident(s): ${summary.clean.toString()} clean, ${summary.withIssues.toString()} with ${summary.totalIssues.toString()} issue(s)`;
  if (issues.length === 0) return `${head}\nOK — no timeline drift`;
  const lines = issues.map((i) => `  ${i.incidentId}  ${i.kind}  ${i.detail}`);
  return [head, ...lines].join("\n");
}

/** The structural read surface the runner needs — `PostgresIncidentReplayer` satisfies it. */
export interface IncidentQuerySource {
  listOpen(opts?: { readonly limit?: number }): Promise<readonly IncidentSummary[]>;
  listForPeriod(query: ListPeriodQuery): Promise<readonly IncidentSummary[]>;
  bulkVerify(query: ListPeriodQuery): Promise<readonly IncidentTimelineIssue[]>;
}

/** The structural write surface for the milestone commands — `PostgresIncidentSink` satisfies it. */
export interface IncidentWriteSink {
  acknowledge(incidentId: string, actorUserId: string): Promise<boolean>;
  mitigate(incidentId: string, actorUserId: string): Promise<boolean>;
}

/**
 * Executes a parsed `ack` / `mitigate` command against a write sink. Records the
 * milestone (status_changed timeline entry + acked_at/mitigated_at stamp) and
 * reports whether a row actually changed — a no-op (incident absent / already
 * past that state) prints a notice and exits 0 (idempotent, not an error). Pure
 * over the injected sink + out.
 */
export async function runIncidentWrite(
  options: IncidentsCliOptions,
  sink: IncidentWriteSink,
  out: (line: string) => void,
): Promise<RunIncidentsResult> {
  const id = options.incidentId as string;
  const changed =
    options.command === "ack" ? await sink.acknowledge(id, options.actor) : await sink.mitigate(id, options.actor);
  const verb = options.command === "ack" ? "acknowledged" : "mitigated";
  out(changed ? `${verb} ${id} (actor ${options.actor})` : `no-op: ${id} was not ${verb} (absent or already past that state)`);
  return { exitCode: 0 };
}

export interface RunIncidentsResult {
  readonly exitCode: number;
}

/**
 * Executes a parsed `incidents` command against a query source, writing the
 * formatted result to `out`. `open` / `period` list incidents; `verify` runs the
 * drift sweep and exits **1 when any issue is found** (so CI can gate on "zero
 * timeline drift"). Pure over the injected source + sink — no DB/IO of its own.
 */
export async function runIncidents(
  options: IncidentsCliOptions,
  source: IncidentQuerySource,
  out: (line: string) => void,
): Promise<RunIncidentsResult> {
  const json = options.format === "json";
  if (options.command === "open") {
    const list = await source.listOpen(options.limit !== null ? { limit: options.limit } : {});
    out(json ? JSON.stringify(list, null, 2) : formatIncidentList(list, "open incidents"));
    return { exitCode: 0 };
  }
  const query: ListPeriodQuery = {
    from: options.from as string,
    to: options.to as string,
    ...(options.limit !== null ? { limit: options.limit } : {}),
  };
  if (options.command === "period") {
    const list = await source.listForPeriod(query);
    out(json ? JSON.stringify(list, null, 2) : formatIncidentList(list, `incidents ${query.from as string}..${query.to as string}`));
    return { exitCode: 0 };
  }
  if (options.command === "metrics") {
    const list = await source.listForPeriod(query);
    const metrics = computeIncidentMetrics(list);
    out(json ? JSON.stringify(metrics, null, 2) : formatIncidentMetrics(metrics, `incident metrics ${query.from as string}..${query.to as string}`));
    return { exitCode: 0 };
  }
  // verify
  const list = await source.listForPeriod(query);
  const issues = await source.bulkVerify(query);
  if (json) {
    out(JSON.stringify({ summary: summarizeIncidentIssues(issues, list.length), issues }, null, 2));
  } else {
    out(formatVerifyReport(issues, list.length));
  }
  return { exitCode: issues.length > 0 ? 1 : 0 };
}

export const incidentsHelpText = `workflow-worker incidents — query the meta.incidents audit table

Usage:
  workflow-worker incidents open     [--limit N] [--format human|json] [--schema s]
  workflow-worker incidents period   --from <iso> --to <iso> [--limit N] [--format human|json] [--schema s]
  workflow-worker incidents verify   --from <iso> --to <iso> [--format human|json] [--schema s]
  workflow-worker incidents metrics  --from <iso> --to <iso> [--limit N] [--format human|json] [--schema s]
  workflow-worker incidents ack      <incident-id> [--actor <uuid>] [--schema s]
  workflow-worker incidents mitigate <incident-id> [--actor <uuid>] [--schema s]

Commands:
  open      List incidents that are still open (status not resolved/closed/cancelled)
  period    List every incident declared within the --from..--to window
  verify    Run the timeline drift sweep over the window; exits 1 if any drift
  metrics   Aggregate the window into MTTA/MTTM/MTTR (mean/p50/p95/max),
            open/resolved counts, per-severity gauges, and escalation totals
  ack       Acknowledge an incident (declared → triaged; records MTTA)
  mitigate  Mitigate an incident (→ mitigated; records MTTM)

Options:
  --from <iso>     Window start (ISO timestamp; required for period/verify/metrics)
  --to <iso>       Window end (ISO timestamp; required for period/verify/metrics)
  --actor <uuid>   Actor id for ack/mitigate (default the system actor)
  --limit <n>      Max rows (default 500, clamped to 1000)
  --schema <name>  Postgres schema for meta.incidents (default meta)
  --format <f>     human (default) | json
  --help, -h       Show this help

Postgres: standard PG* env vars (PGHOST, PGDATABASE, ...).
`;
