import { SEVERITIES, type Severity } from "@crossengin/incident-response";

import { isOpenIncidentStatus, type IncidentSummary } from "./replayer.js";

export interface MttrStats {
  readonly count: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface IncidentMetrics {
  readonly total: number;
  readonly open: number;
  readonly resolved: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly openBySeverity: Readonly<Record<Severity, number>>;
  readonly escalations: number;
  readonly mttp: MttrStats | null;
  readonly mtta: MttrStats | null;
  readonly mttm: MttrStats | null;
  readonly mttr: MttrStats | null;
}

function zeroBySeverity(): Record<Severity, number> {
  const out = {} as Record<Severity, number>;
  for (const s of SEVERITIES) out[s] = 0;
  return out;
}

/** The nearest percentile (`p` in [0,1]) of an ascending-sorted numeric list. */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx] ?? 0;
}

/**
 * The wall-clock time an incident took to resolve, in ms — from its `declared`
 * timeline entry (falling back to `declaredAt`) to its last `resolved` entry
 * (falling back to `resolvedAt`). `null` when the incident isn't resolved or the
 * timestamps don't yield a non-negative finite duration. Pure.
 */
export function incidentResolutionMs(summary: IncidentSummary): number | null {
  const declared = summary.timeline.find((e) => e.kind === "declared")?.occurredAt ?? summary.declaredAt;
  let resolvedAt: string | null = null;
  for (const entry of summary.timeline) {
    if (entry.kind === "resolved") resolvedAt = entry.occurredAt; // last wins
  }
  resolvedAt = resolvedAt ?? summary.resolvedAt;
  if (resolvedAt === null || declared.length === 0) return null;
  const ms = Date.parse(resolvedAt) - Date.parse(declared);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Counts the `severity_changed` timeline entries across an incident (escalations). */
export function incidentEscalationCount(summary: IncidentSummary): number {
  return summary.timeline.reduce((n, e) => (e.kind === "severity_changed" ? n + 1 : n), 0);
}

function declaredAtOf(summary: IncidentSummary): string {
  return summary.timeline.find((e) => e.kind === "declared")?.occurredAt ?? summary.declaredAt;
}

function nonNegativeDeltaMs(fromIso: string, toIso: string | undefined): number | null {
  if (toIso === undefined || fromIso.length === 0) return null;
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * The wall-clock time from declaration to the **first** `status_changed` timeline
 * entry that moved the incident to `targetStatus` (e.g. `triaged` for MTTA,
 * `mitigated` for MTTM), in ms. `null` when no such milestone exists or the
 * delta isn't a non-negative finite number. Pure.
 */
export function incidentMilestoneMs(summary: IncidentSummary, targetStatus: string): number | null {
  const milestone = summary.timeline.find(
    (e) => e.kind === "status_changed" && e.metadata["status"] === targetStatus,
  )?.occurredAt;
  return nonNegativeDeltaMs(declaredAtOf(summary), milestone);
}

/**
 * The wall-clock time from declaration to the **first** `comms_sent` timeline
 * entry (on-call was paged), in ms — MTTP. `null` when the incident was never
 * paged or the delta isn't a non-negative finite number. Pure.
 */
export function incidentTimeToPageMs(summary: IncidentSummary): number | null {
  const paged = summary.timeline.find((e) => e.kind === "comms_sent")?.occurredAt;
  return nonNegativeDeltaMs(declaredAtOf(summary), paged);
}

function statsFrom(durations: number[]): MttrStats | null {
  if (durations.length === 0) return null;
  durations.sort((a, b) => a - b);
  const sum = durations.reduce((acc, n) => acc + n, 0);
  return {
    count: durations.length,
    meanMs: Math.round(sum / durations.length),
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations[durations.length - 1] ?? 0,
  };
}

/**
 * Folds a list of incident summaries into operational metrics: total / open /
 * resolved counts, per-severity + open-per-severity gauges, total escalations,
 * and MTTR stats (mean / p50 / p95 / max over the incidents that resolved with a
 * computable duration; `null` when none did). Pure — drives the
 * `incidents metrics` CLI and any observability report.
 */
export function computeIncidentMetrics(summaries: readonly IncidentSummary[]): IncidentMetrics {
  const bySeverity = zeroBySeverity();
  const openBySeverity = zeroBySeverity();
  let open = 0;
  let resolved = 0;
  let escalations = 0;
  const pageDurations: number[] = [];
  const ackDurations: number[] = [];
  const mitigateDurations: number[] = [];
  const resolveDurations: number[] = [];

  for (const s of summaries) {
    bySeverity[s.severity] += 1;
    escalations += incidentEscalationCount(s);
    if (isOpenIncidentStatus(s.status)) {
      open += 1;
      openBySeverity[s.severity] += 1;
    }
    if (s.status === "resolved") resolved += 1;
    const page = incidentTimeToPageMs(s);
    if (page !== null) pageDurations.push(page);
    const ack = incidentMilestoneMs(s, "triaged");
    if (ack !== null) ackDurations.push(ack);
    const mitigate = incidentMilestoneMs(s, "mitigated");
    if (mitigate !== null) mitigateDurations.push(mitigate);
    const resolve = incidentResolutionMs(s);
    if (resolve !== null) resolveDurations.push(resolve);
  }

  return {
    total: summaries.length,
    open,
    resolved,
    bySeverity,
    openBySeverity,
    escalations,
    mttp: statsFrom(pageDurations),
    mtta: statsFrom(ackDurations),
    mttm: statsFrom(mitigateDurations),
    mttr: statsFrom(resolveDurations),
  };
}

/** Renders a duration in ms as a compact `1h 2m 3s` / `45s` / `120ms` string. */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms).toString()}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h.toString()}h`);
  if (m > 0) parts.push(`${m.toString()}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s.toString()}s`);
  return parts.join(" ");
}

function severityBreakdown(counts: Readonly<Record<Severity, number>>): string {
  return SEVERITIES.filter((s) => counts[s] > 0).map((s) => `${s}=${counts[s].toString()}`).join(" ") || "none";
}

function statsLine(label: string, noun: string, stats: MttrStats | null): string {
  if (stats === null) return `  ${label}: n/a (no ${noun} in range)`;
  return `  ${label} (${stats.count.toString()} ${noun}): mean ${formatDurationMs(stats.meanMs)}  p50 ${formatDurationMs(stats.p50Ms)}  p95 ${formatDurationMs(stats.p95Ms)}  max ${formatDurationMs(stats.maxMs)}`;
}

/** Human-readable rendering of the incident metrics. */
export function formatIncidentMetrics(metrics: IncidentMetrics, heading: string): string {
  return [
    `${heading}:`,
    `  total ${metrics.total.toString()}  open ${metrics.open.toString()}  resolved ${metrics.resolved.toString()}  escalations ${metrics.escalations.toString()}`,
    `  by severity:      ${severityBreakdown(metrics.bySeverity)}`,
    `  open by severity: ${severityBreakdown(metrics.openBySeverity)}`,
    statsLine("MTTP", "paged", metrics.mttp),
    statsLine("MTTA", "acknowledged", metrics.mtta),
    statsLine("MTTM", "mitigated", metrics.mttm),
    statsLine("MTTR", "resolved", metrics.mttr),
  ].join("\n");
}
