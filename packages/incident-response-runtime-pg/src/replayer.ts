import { ZodError } from "zod";

import type { PgConnection } from "@crossengin/kernel-pg";
import { parseIncidentId } from "@crossengin/incident-response";
import { assessIncidentSla, isIncidentOpen } from "@crossengin/incident-response-runtime";

import { INCIDENT_COLUMNS, rowToIncident } from "./records.js";

export const INCIDENT_DRIFT_KINDS = [
  "unparseable_record",
  "id_sequence_mismatch",
  "timeline_out_of_order",
  "terminal_without_timestamp",
  "sla_breached_while_open",
] as const;
export type IncidentDriftKind = (typeof INCIDENT_DRIFT_KINDS)[number];

export interface IncidentDrift {
  readonly incidentId: string;
  readonly kind: IncidentDriftKind;
  readonly detail: string;
}

export interface IncidentReplayReport {
  readonly scanned: number;
  readonly open: number;
  readonly drift: readonly IncidentDrift[];
  readonly checkedAt: string;
}

export interface ReplayIncidentsOptions {
  readonly limit?: number;
  readonly nowIso?: string;
}

/**
 * Re-reads stored incidents and reports every way a row no longer describes a coherent incident.
 *
 * This exists because the database cannot hold the contract. A CHECK constraint can say `status`
 * is one of eight values; it cannot say that a triaged sev1 has five active role holders, that
 * `resolvedAt` implies `mitigatedAt`, or that a closed incident carries a root cause. Those live
 * in `IncidentRecordSchema`, which means a row edited by hand — or written by a future version
 * that skipped the schema — is invalid in ways only a re-parse can find. A `sla_breached_while_open`
 * finding is not corruption at all but the operational signal this makes cheap to ask for: an
 * incident sitting past its severity's window with nobody on it.
 */
export async function replayIncidents(
  conn: PgConnection,
  opts: ReplayIncidentsOptions = {},
): Promise<IncidentReplayReport> {
  const limit = opts.limit ?? 500;
  if (limit <= 0) throw new Error("limit must be positive");
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const result = await conn.query<Record<string, unknown>>(
    `SELECT ${INCIDENT_COLUMNS} FROM meta.incidents
     ORDER BY declared_at DESC
     LIMIT $1`,
    [limit],
  );

  const drift: IncidentDrift[] = [];
  let open = 0;

  for (const row of result.rows) {
    const id = String(row["incident_id"] ?? "<unknown>");
    let stored;
    try {
      stored = rowToIncident(row);
    } catch (err) {
      drift.push({ incidentId: id, kind: "unparseable_record", detail: describeError(err) });
      continue;
    }
    const record = stored.record;

    const { year, sequence } = parseIncidentId(record.id);
    const rowYear = Number(row["year"]);
    const rowSeq = Number(row["sequence_number"]);
    if (rowYear !== year || rowSeq !== sequence) {
      drift.push({
        incidentId: id,
        kind: "id_sequence_mismatch",
        detail: `columns say ${rowYear}/${rowSeq}, id says ${year}/${sequence}`,
      });
    }

    for (let i = 1; i < record.timeline.length; i++) {
      const prev = new Date(record.timeline[i - 1]!.occurredAt).getTime();
      const cur = new Date(record.timeline[i]!.occurredAt).getTime();
      if (cur < prev) {
        drift.push({
          incidentId: id,
          kind: "timeline_out_of_order",
          detail: `entry ${i} occurred before entry ${i - 1}`,
        });
        break;
      }
    }

    // The schema pairs `closed`/`cancelled` with their stamps, so this can only fire on a row
    // written around it — but that is exactly the case a drift report is for.
    if (record.status === "closed" && record.closedAt === null) {
      drift.push({
        incidentId: id,
        kind: "terminal_without_timestamp",
        detail: "status is closed but closedAt is null",
      });
    }
    if (record.status === "cancelled" && record.cancelledAt === null) {
      drift.push({
        incidentId: id,
        kind: "terminal_without_timestamp",
        detail: "status is cancelled but cancelledAt is null",
      });
    }

    if (isIncidentOpen(record)) {
      open++;
      const sla = assessIncidentSla(record, nowIso);
      if (sla.breachedTargets.length > 0) {
        drift.push({
          incidentId: id,
          kind: "sla_breached_while_open",
          detail: `${record.severity} open past ${sla.breachedTargets.join(", ")}`,
        });
      }
    }
  }

  return { scanned: result.rows.length, open, drift, checkedAt: nowIso };
}

/**
 * A `ZodError`'s message is a multi-line JSON dump of every issue, which turns one finding into
 * twenty lines of a report an operator is meant to scan. Flattened to `path: message` pairs on one
 * line — the same shape `incidentTransitionBlockers` produces.
 */
function describeError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
      })
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

export function formatIncidentReplayReport(report: IncidentReplayReport): string {
  const lines = [
    `incidents: scanned ${report.scanned}, ${report.open} open, ${report.drift.length} finding(s)`,
  ];
  for (const d of report.drift) {
    lines.push(`  [${d.kind}] ${d.incidentId}: ${d.detail}`);
  }
  return lines.join("\n");
}
