import { computeIncidentMetrics, formatIncidentMetrics } from "./metrics.js";
import {
  summarizeIncidentIssues,
  type IncidentSummary,
  type IncidentTimelineIssue,
  type ListPeriodQuery,
} from "./replayer.js";

export type IncidentsCommand = "open" | "period" | "verify" | "metrics" | "ack" | "mitigate";
export type OutputFormat = "human" | "json";

/** A system actor id used when an `ack`/`mitigate` command omits an actor. */
export const DEFAULT_INCIDENT_ACTOR = "00000000-0000-4000-8000-000000000000";

/** The resolved options an `incidents` command runs with (a CLI parser produces these). */
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

export interface RunIncidentsResult {
  readonly exitCode: number;
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

/**
 * Executes a parsed `incidents` command against a query source, writing the
 * formatted result to `out`. `open` / `period` list incidents; `metrics`
 * aggregates the KPI set; `verify` runs the drift sweep and exits **1 when any
 * issue is found** (so CI can gate on "zero timeline drift"). Pure over the
 * injected source + sink — no DB/IO of its own.
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
