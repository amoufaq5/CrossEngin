import { SEVERITIES, type Severity } from "@crossengin/incident-response";

import { isOpenIncidentStatus, type IncidentSummary } from "./incident-replayer.js";

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
  const durations: number[] = [];

  for (const s of summaries) {
    bySeverity[s.severity] += 1;
    escalations += incidentEscalationCount(s);
    if (isOpenIncidentStatus(s.status)) {
      open += 1;
      openBySeverity[s.severity] += 1;
    }
    if (s.status === "resolved") resolved += 1;
    const ms = incidentResolutionMs(s);
    if (ms !== null) durations.push(ms);
  }

  let mttr: MttrStats | null = null;
  if (durations.length > 0) {
    durations.sort((a, b) => a - b);
    const sum = durations.reduce((acc, n) => acc + n, 0);
    mttr = {
      count: durations.length,
      meanMs: Math.round(sum / durations.length),
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: durations[durations.length - 1] ?? 0,
    };
  }

  return {
    total: summaries.length,
    open,
    resolved,
    bySeverity,
    openBySeverity,
    escalations,
    mttr,
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

/** Human-readable rendering of the incident metrics. */
export function formatIncidentMetrics(metrics: IncidentMetrics, heading: string): string {
  const lines = [
    `${heading}:`,
    `  total ${metrics.total.toString()}  open ${metrics.open.toString()}  resolved ${metrics.resolved.toString()}  escalations ${metrics.escalations.toString()}`,
    `  by severity:      ${severityBreakdown(metrics.bySeverity)}`,
    `  open by severity: ${severityBreakdown(metrics.openBySeverity)}`,
  ];
  if (metrics.mttr === null) {
    lines.push("  MTTR: n/a (no resolved incidents in range)");
  } else {
    const { mttr } = metrics;
    lines.push(
      `  MTTR (${mttr.count.toString()} resolved): mean ${formatDurationMs(mttr.meanMs)}  p50 ${formatDurationMs(mttr.p50Ms)}  p95 ${formatDurationMs(mttr.p95Ms)}  max ${formatDurationMs(mttr.maxMs)}`,
    );
  }
  return lines.join("\n");
}
