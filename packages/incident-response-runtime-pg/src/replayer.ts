import { ZodError } from "zod";

import type { PgConnection } from "@crossengin/kernel-pg";
import { parseIncidentId } from "@crossengin/incident-response";
import { assessIncidentSla, isIncidentOpen } from "@crossengin/incident-response-runtime";

import { INCIDENT_COLUMNS, rowToIncident } from "./records.js";

/**
 * `terminal_without_timestamp` is gone, because it could never be reported.
 *
 * It fired on `status === "closed" && closedAt === null` (and the `cancelled` pair) — which is
 * exactly what `IncidentRecordSchema.superRefine` refuses, with the messages *"closed status
 * requires closedAt"* and *"cancelled status requires cancelledAt"*. `rowToIncident` runs that parse
 * first and unconditionally in the same loop, so any row reaching the check had already been
 * reported `unparseable_record` and `continue`d past. Its own comment said it "can only fire on a
 * row written around it"; there is no writing around it, because the detector is upstream of the
 * detector.
 *
 * This module's test proves it from both ends and the two assertions contradicted each other: one
 * declares this list to be "every kind the replayer can report", while *"flags a row whose record no
 * longer satisfies the contract"* sets `row["status"] = "closed"` on a row with no `closedAt` and
 * asserts the result is **one** finding of kind `unparseable_record`. Nothing asserted the dead kind
 * ever fired, so a list and a behaviour disagreed for as long as both passed.
 *
 * Removed rather than made reachable: reaching it means parsing leniently first, which would trade
 * this module's whole reason for existing — the re-parse — for a sharper label on one of the things
 * the re-parse already catches. The information is not lost; `describeError` flattens the
 * `ZodError` to `closedAt: closed status requires closedAt`, which names the field.
 */
export const INCIDENT_DRIFT_KINDS = [
  "unparseable_record",
  "id_sequence_mismatch",
  "timeline_out_of_order",
  "sla_breached_while_open",
  "duplicate_open_for_signal",
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
  /**
   * Whether this pass saw the whole table, or only the newest `limit` rows.
   *
   * Without it a clean report is ambiguous in the direction that matters: "no incident has drifted"
   * and "none of the 500 newest has drifted" are different claims and only the first is what an
   * operator reads off `0 finding(s)`. ADR-0328's rule for the tombstone sweep — the coverage
   * guarantee is per completed lap, so the lap has to be reported — on a smaller table.
   *
   * It bites hardest on `sla_breached_while_open`, and in the inverting direction:
   * `ORDER BY declared_at DESC` keeps the *newest* incidents, while an incident sitting past its
   * severity's window is by definition an old one, so a truncated pass drops exactly the rows that
   * check exists to find. `PostgresIncidentStore.listOpen` orders ascending for that reason. The
   * ordering is left as it is — it is right for the other four kinds, and `unparseable_record` on a
   * freshly tampered row is what a scheduled pass is mostly for — so the honest move is to say when
   * the window cut rather than to pick a different set of rows to miss.
   */
  readonly windowComplete: boolean;
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
 *
 * `duplicate_open_for_signal` is the one finding that is about the table rather than a row:
 * `idx_incidents_auto_declared_open` makes two open incidents for one automated signal impossible
 * on write, and `findOpenFor` refuses to prefer one if it ever sees two — but both of those need a
 * declaration to happen first. This notices it without one.
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
  /**
   * Open incidents by the signal they were auto-declared for, which is what
   * `idx_incidents_auto_declared_open` constrains: keyed rows only (a human declaration has no key
   * to collide on) and non-terminal statuses only (`isIncidentOpen` is exactly the index's
   * `status NOT IN ('closed', 'cancelled')`, so two *closed* episodes of one signal are correct and
   * not grouped).
   */
  const openBySignal = new Map<string, string[]>();

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

    // No terminal-timestamp check here: `IncidentRecordSchema` pairs `closed`/`cancelled` with
    // their stamps, and `rowToIncident` above has already applied it, so such a row left this loop
    // as `unparseable_record` several lines ago. See `INCIDENT_DRIFT_KINDS`.

    if (isIncidentOpen(record)) {
      open++;
      if (record.autoDeclaredFor !== null) {
        const ids = openBySignal.get(record.autoDeclaredFor);
        if (ids === undefined) openBySignal.set(record.autoDeclaredFor, [record.id]);
        else ids.push(record.id);
      }
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

  // One finding per colliding signal rather than per extra row: the operator needs the key and
  // every id open under it to decide which episode is the real one. Only what this scan read, so a
  // collision whose other half fell outside `limit` is reported the next time the window covers it.
  for (const [signal, ids] of openBySignal) {
    const first = ids[0];
    if (ids.length < 2 || first === undefined) continue;
    drift.push({
      incidentId: first,
      kind: "duplicate_open_for_signal",
      detail: `${ids.length} open incidents for signal '${signal}': ${ids.join(", ")}`,
    });
  }

  return {
    scanned: result.rows.length,
    open,
    drift,
    checkedAt: nowIso,
    // A short page is the only evidence available that the table ended: a full page means there may
    // be more, and `count(*)` beside the read would be a second question answered at another moment.
    windowComplete: result.rows.length < limit,
  };
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
    `incidents: scanned ${report.scanned}${report.windowComplete ? "" : " (window truncated)"}` +
      `, ${report.open} open, ${report.drift.length} finding(s)`,
  ];
  for (const d of report.drift) {
    lines.push(`  [${d.kind}] ${d.incidentId}: ${d.detail}`);
  }
  return lines.join("\n");
}
