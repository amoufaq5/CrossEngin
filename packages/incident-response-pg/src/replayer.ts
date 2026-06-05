import { SEVERITIES, TimelineEntrySchema, type Severity, type TimelineEntry } from "@crossengin/incident-response";
import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

/** Incident statuses that are no longer open — an incident in one of these is
 * done and won't escalate/resolve further. */
export const INCIDENT_TERMINAL_STATUSES = ["resolved", "closed", "cancelled"] as const;

/** True when an incident status is still open (not terminal). */
export function isOpenIncidentStatus(status: string): boolean {
  return !(INCIDENT_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * The read projection of a `meta.incidents` row the replayer surfaces — the
 * fields the stale-worker sink writes/transitions plus the lifecycle timestamps.
 * `timeline` carries only the entries that parsed against `TimelineEntrySchema`;
 * `invalidTimelineEntries` counts any that didn't (so a verifier can flag drift
 * without the read throwing).
 */
export interface IncidentSummary {
  readonly incidentId: string;
  readonly title: string;
  readonly severity: Severity;
  readonly category: string;
  readonly status: string;
  readonly declaredAt: string;
  readonly declaredBy: string;
  readonly resolvedAt: string | null;
  readonly timeline: readonly TimelineEntry[];
  readonly invalidTimelineEntries: number;
}

export type IncidentTimelineIssueKind =
  | "empty_timeline"
  | "first_entry_not_declared"
  | "non_monotonic_timeline"
  | "invalid_timeline_entry"
  | "resolved_status_without_resolved_at"
  | "resolved_at_without_resolved_status"
  | "resolved_status_without_timeline_entry"
  | "timeline_resolved_but_status_open";

export interface IncidentTimelineIssue {
  readonly incidentId: string;
  readonly kind: IncidentTimelineIssueKind;
  readonly detail: string;
}

/**
 * Pure drift check over one incident's timeline + lifecycle status: every
 * incident should open with a `declared` entry, carry monotonically-timestamped
 * entries, and have its `resolved` status, `resolved_at` stamp, and `resolved`
 * timeline entry all agree. Returns the issues found (empty = clean). Mirrors the
 * gateway / SLO replayers' `verifyXShape` shape.
 */
export function verifyTimelineShape(summary: IncidentSummary): readonly IncidentTimelineIssue[] {
  const issues: IncidentTimelineIssue[] = [];
  const push = (kind: IncidentTimelineIssueKind, detail: string): void => {
    issues.push({ incidentId: summary.incidentId, kind, detail });
  };

  if (summary.invalidTimelineEntries > 0) {
    push("invalid_timeline_entry", `${summary.invalidTimelineEntries.toString()} timeline entr(y/ies) failed schema validation`);
  }

  const { timeline } = summary;
  if (timeline.length === 0) {
    push("empty_timeline", "incident has no timeline entries (expected at least a declared entry)");
  } else {
    if (timeline[0]?.kind !== "declared") {
      push("first_entry_not_declared", `first timeline entry is "${String(timeline[0]?.kind)}", expected "declared"`);
    }
    for (let i = 1; i < timeline.length; i += 1) {
      const prev = timeline[i - 1];
      const cur = timeline[i];
      if (prev !== undefined && cur !== undefined && cur.occurredAt < prev.occurredAt) {
        push("non_monotonic_timeline", `entry ${i.toString()} (${cur.occurredAt}) precedes entry ${(i - 1).toString()} (${prev.occurredAt})`);
      }
    }
  }

  const hasResolvedEntry = timeline.some((e) => e.kind === "resolved");
  const statusResolved = summary.status === "resolved";
  if (statusResolved && summary.resolvedAt === null) {
    push("resolved_status_without_resolved_at", "status is resolved but resolved_at is null");
  }
  if (!statusResolved && summary.resolvedAt !== null) {
    push("resolved_at_without_resolved_status", `resolved_at is set but status is "${summary.status}"`);
  }
  if (statusResolved && !hasResolvedEntry) {
    push("resolved_status_without_timeline_entry", "status is resolved but no resolved timeline entry was appended");
  }
  if (!statusResolved && hasResolvedEntry) {
    push("timeline_resolved_but_status_open", `a resolved timeline entry exists but status is "${summary.status}"`);
  }
  return issues;
}

export interface IncidentIssueSummary {
  readonly incidents: number;
  readonly clean: number;
  readonly withIssues: number;
  readonly totalIssues: number;
  readonly byKind: Readonly<Record<string, number>>;
}

/** Folds a flat issue list (plus the verified incident count) into counts. Pure. */
export function summarizeIncidentIssues(
  issues: readonly IncidentTimelineIssue[],
  verifiedIncidents: number,
): IncidentIssueSummary {
  const byKind: Record<string, number> = {};
  const dirty = new Set<string>();
  for (const issue of issues) {
    byKind[issue.kind] = (byKind[issue.kind] ?? 0) + 1;
    dirty.add(issue.incidentId);
  }
  return {
    incidents: verifiedIncidents,
    clean: Math.max(0, verifiedIncidents - dirty.size),
    withIssues: dirty.size,
    totalIssues: issues.length,
    byKind,
  };
}

interface IncidentRow {
  readonly incident_id: string;
  readonly title: string;
  readonly severity: string;
  readonly category: string;
  readonly status: string;
  readonly declared_at: Date | string;
  readonly declared_by: string;
  readonly resolved_at: Date | string | null;
  readonly timeline: unknown;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function parseTimeline(raw: unknown): { entries: TimelineEntry[]; invalid: number } {
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? (JSON.parse(raw) as unknown) : [];
  const items = Array.isArray(arr) ? arr : [];
  const entries: TimelineEntry[] = [];
  let invalid = 0;
  for (const item of items) {
    const parsed = TimelineEntrySchema.safeParse(item);
    if (parsed.success) entries.push(parsed.data);
    else invalid += 1;
  }
  return { entries, invalid };
}

function coerceSeverity(value: string): Severity {
  return (SEVERITIES as readonly string[]).includes(value) ? (value as Severity) : "sev5";
}

/** Maps a `meta.incidents` row to the read projection. */
export function rowToIncidentSummary(row: IncidentRow): IncidentSummary {
  const declaredAt = toIso(row.declared_at);
  const { entries, invalid } = parseTimeline(row.timeline);
  return {
    incidentId: row.incident_id,
    title: row.title,
    severity: coerceSeverity(row.severity),
    category: row.category,
    status: row.status,
    declaredAt: declaredAt ?? "",
    declaredBy: row.declared_by,
    resolvedAt: toIso(row.resolved_at),
    timeline: entries,
    invalidTimelineEntries: invalid,
  };
}

const SELECT_COLUMNS =
  "incident_id, title, severity, category, status, declared_at, declared_by::text AS declared_by, resolved_at, timeline";

export interface ListPeriodQuery {
  readonly from: Date | string;
  readonly to: Date | string;
  readonly limit?: number;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  return Math.max(1, Math.min(1000, Math.trunc(limit)));
}

/**
 * The read side of `meta.incidents` — a typed query + drift-verify API over the
 * incidents the stale-worker sink writes (and any other producer of the same
 * table). `listOpen` / `listForPeriod` answer "which incidents are live" / "every
 * incident in a window and its full timeline" in one query; `verifyByIncidentId`
 * / `bulkVerify` run the pure `verifyTimelineShape` over stored rows for periodic
 * audit sweeps. Read-only (no writes); the connecting role needs to read
 * `meta.incidents`.
 */
export class PostgresIncidentReplayer {
  private readonly conn: PgConnection;
  private readonly table: string;

  constructor(conn: PgConnection, opts: { readonly schema?: string } = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    this.table = `${schema}.incidents`;
  }

  async getByIncidentId(incidentId: string): Promise<IncidentSummary | null> {
    const res = await this.conn.query<IncidentRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE incident_id = $1`,
      [incidentId],
    );
    const row = res.rows[0];
    return row === undefined ? null : rowToIncidentSummary(row);
  }

  /** Incidents that are still open (status not in the terminal set), newest first. */
  async listOpen(opts: { readonly limit?: number } = {}): Promise<readonly IncidentSummary[]> {
    const terminal = INCIDENT_TERMINAL_STATUSES.map((_, i) => `$${(i + 1).toString()}`).join(", ");
    const res = await this.conn.query<IncidentRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${this.table}
        WHERE status NOT IN (${terminal})
        ORDER BY declared_at DESC, incident_id DESC
        LIMIT ${clampLimit(opts.limit, 500).toString()}`,
      [...INCIDENT_TERMINAL_STATUSES],
    );
    return res.rows.map(rowToIncidentSummary);
  }

  /** Every incident declared within `[from, to]`, oldest first. */
  async listForPeriod(query: ListPeriodQuery): Promise<readonly IncidentSummary[]> {
    const res = await this.conn.query<IncidentRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${this.table}
        WHERE declared_at >= $1 AND declared_at <= $2
        ORDER BY declared_at ASC, incident_id ASC
        LIMIT ${clampLimit(query.limit, 500).toString()}`,
      [query.from, query.to],
    );
    return res.rows.map(rowToIncidentSummary);
  }

  /** Verifies one incident's timeline shape; `null` if the incident is absent. */
  async verifyByIncidentId(incidentId: string): Promise<readonly IncidentTimelineIssue[] | null> {
    const summary = await this.getByIncidentId(incidentId);
    return summary === null ? null : verifyTimelineShape(summary);
  }

  /** Verifies every incident in a period, returning the flat issue list. */
  async bulkVerify(query: ListPeriodQuery): Promise<readonly IncidentTimelineIssue[]> {
    const summaries = await this.listForPeriod(query);
    return summaries.flatMap((s) => verifyTimelineShape(s));
  }
}
