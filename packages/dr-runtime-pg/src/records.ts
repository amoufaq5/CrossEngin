import { DrillRecordSchema, FailoverRecordSchema, type DrillRecord, type FailoverRecord } from "@crossengin/dr";

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") return JSON.parse(value) as T[];
  return [];
}

/** Maps a `meta.failover_records` row to a `FailoverRecord` (parsed through the schema). */
export function rowToFailoverRecord(row: Record<string, unknown>): FailoverRecord {
  const incidentTicketId = row["incident_ticket_id"];
  const notes = row["notes"];
  return FailoverRecordSchema.parse({
    id: String(row["id"]),
    tier: String(row["tier"]),
    trigger: String(row["trigger"]),
    triggeredBy: String(row["triggered_by"]),
    triggeredAt: isoOrNull(row["triggered_at"]),
    fromRegion: String(row["from_region"]),
    toRegion: String(row["to_region"]),
    affectedApps: jsonArray<string>(row["affected_apps"]),
    status: String(row["status"]),
    startedAt: isoOrNull(row["started_at"]),
    completedAt: isoOrNull(row["completed_at"]),
    durationSeconds: numOrNull(row["duration_seconds"]),
    actualRpoSeconds: numOrNull(row["actual_rpo_seconds"]),
    actualRtoSeconds: numOrNull(row["actual_rto_seconds"]),
    revertedAt: isoOrNull(row["reverted_at"]),
    revertedToFailoverId: row["reverted_to_failover_id"] === null || row["reverted_to_failover_id"] === undefined ? null : String(row["reverted_to_failover_id"]),
    ...(incidentTicketId !== null && incidentTicketId !== undefined ? { incidentTicketId: String(incidentTicketId) } : {}),
    ...(notes !== null && notes !== undefined ? { notes: String(notes) } : {}),
  });
}

/** Maps a `meta.dr_drills` row to a `DrillRecord` (parsed through the schema). */
export function rowToDrillRecord(row: Record<string, unknown>): DrillRecord {
  const reportUrl = row["report_url"];
  return DrillRecordSchema.parse({
    id: String(row["id"]),
    kind: String(row["kind"]),
    tier: String(row["tier"]),
    scheduledFor: isoOrNull(row["scheduled_for"]),
    executedAt: isoOrNull(row["executed_at"]),
    executedBy: row["executed_by"] === null || row["executed_by"] === undefined ? null : String(row["executed_by"]),
    scopeRegions: jsonArray<string>(row["scope_regions"]),
    scopeApps: jsonArray<string>(row["scope_apps"]),
    outcome: String(row["outcome"]),
    measuredRpoSeconds: numOrNull(row["measured_rpo_seconds"]),
    measuredRtoSeconds: numOrNull(row["measured_rto_seconds"]),
    findings: jsonArray(row["findings"]),
    ...(reportUrl !== null && reportUrl !== undefined ? { reportUrl: String(reportUrl) } : {}),
    nextDrillDueAt: isoOrNull(row["next_drill_due_at"]),
  });
}

/** The column tuple for a `meta.failover_records` upsert. */
export function failoverInsertParams(record: FailoverRecord): readonly unknown[] {
  return [
    record.id,
    record.tier,
    record.trigger,
    record.triggeredBy,
    record.triggeredAt,
    record.fromRegion,
    record.toRegion,
    JSON.stringify(record.affectedApps),
    record.status,
    record.startedAt,
    record.completedAt,
    record.durationSeconds,
    record.actualRpoSeconds,
    record.actualRtoSeconds,
    record.revertedAt,
    record.revertedToFailoverId,
    record.incidentTicketId ?? null,
    record.notes ?? null,
  ];
}

/** The column tuple for a `meta.dr_drills` upsert. */
export function drillInsertParams(record: DrillRecord): readonly unknown[] {
  return [
    record.id,
    record.kind,
    record.tier,
    record.scheduledFor,
    record.executedAt,
    record.executedBy,
    JSON.stringify(record.scopeRegions),
    JSON.stringify(record.scopeApps),
    record.outcome,
    record.measuredRpoSeconds,
    record.measuredRtoSeconds,
    JSON.stringify(record.findings),
    record.reportUrl ?? null,
    record.nextDrillDueAt,
  ];
}
