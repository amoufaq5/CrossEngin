import {
  DEFAULT_INCIDENT_ACTOR,
  type IncidentsCliOptions,
  type IncidentsCommand,
  type OutputFormat,
} from "@crossengin/incident-response-pg";

import { CliUsageError } from "./cli.js";

export type { IncidentsCliOptions, IncidentsCommand, OutputFormat } from "@crossengin/incident-response-pg";
export {
  DEFAULT_INCIDENT_ACTOR,
  formatIncidentList,
  formatVerifyReport,
  runIncidentWrite,
  runIncidents,
  type IncidentQuerySource,
  type IncidentWriteSink,
  type RunIncidentsResult,
} from "@crossengin/incident-response-pg";

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
 * Parses `operate-server incidents <open|period|verify|metrics|ack|mitigate>
 * [options]` argv (the slice after the `incidents` verb). `period`/`verify`/
 * `metrics` require `--from` + `--to` (an ISO window); `ack`/`mitigate` require
 * a positional incident id. `--format human|json` (default human). Throws
 * `CliUsageError` on misuse. Produces the `IncidentsCliOptions` the
 * `@crossengin/incident-response-pg` runner consumes. Mirrors the workflow-worker
 * incidents parser so an operator queries the same `meta.incidents` audit table
 * from either binary — operate-server is the second consumer of the SLO →
 * incident loop (P2.32), so it now exposes the same operator surface.
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

export const incidentsHelpText = `operate-server incidents — query the meta.incidents audit table

Usage:
  operate-server incidents open     [--limit N] [--format human|json] [--schema s]
  operate-server incidents period   --from <iso> --to <iso> [--limit N] [--format human|json] [--schema s]
  operate-server incidents verify   --from <iso> --to <iso> [--format human|json] [--schema s]
  operate-server incidents metrics  --from <iso> --to <iso> [--limit N] [--format human|json] [--schema s]
  operate-server incidents ack      <incident-id> [--actor <uuid>] [--schema s]
  operate-server incidents mitigate <incident-id> [--actor <uuid>] [--schema s]

Commands:
  open      List incidents that are still open (status not resolved/closed/cancelled)
  period    List every incident declared within the --from..--to window
  verify    Run the timeline drift sweep over the window; exits 1 if any drift
  metrics   Aggregate the window into MTTP/MTTA/MTTM/MTTR (mean/p50/p95/max),
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
