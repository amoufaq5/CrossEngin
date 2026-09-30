import { describe, expect, it } from "vitest";
import { IncidentRecordSchema, type IncidentRecord } from "@crossengin/incident-response";

import {
  INCIDENT_DRIFT_KINDS,
  formatIncidentReplayReport,
  replayIncidents,
} from "./replayer.js";
import {
  EMPTY,
  T0,
  declaredIncident,
  incidentRow,
  mockConnection,
  type Captured,
} from "./test-fakes.js";

const LATER = "2026-09-30T10:10:00.000Z";
const MUCH_LATER = "2026-10-05T10:00:00.000Z";

const SEV3_ROLES = [
  { role: "incident_commander", userId: "a", assignedAt: T0 },
  { role: "scribe", userId: "b", assignedAt: T0 },
  { role: "comms_lead", userId: "c", assignedAt: T0 },
];

function rowsConn(rows: ReadonlyArray<Record<string, unknown>>, capture?: Captured[]) {
  return mockConnection(capture, () => ({ rows: [...rows], rowCount: rows.length }));
}

function closed(): IncidentRecord {
  return IncidentRecordSchema.parse({
    ...declaredIncident(),
    roleAssignments: SEV3_ROLES,
    status: "closed",
    ackedAt: "2026-09-30T10:01:00.000Z",
    mitigatedAt: "2026-09-30T10:02:00.000Z",
    resolvedAt: "2026-09-30T10:03:00.000Z",
    closedAt: "2026-09-30T10:04:00.000Z",
    rootCause: "bad deploy",
  });
}

describe("INCIDENT_DRIFT_KINDS", () => {
  it("names every kind the replayer can report", () => {
    expect([...INCIDENT_DRIFT_KINDS]).toEqual([
      "unparseable_record",
      "id_sequence_mismatch",
      "timeline_out_of_order",
      "terminal_without_timestamp",
      "sla_breached_while_open",
    ]);
  });
});

describe("replayIncidents", () => {
  it("reports nothing for a clean closed incident", async () => {
    const report = await replayIncidents(rowsConn([incidentRow(closed())]), {
      nowIso: MUCH_LATER,
    });
    expect(report.scanned).toBe(1);
    expect(report.open).toBe(0);
    expect(report.drift).toEqual([]);
  });

  it("counts open incidents", async () => {
    const report = await replayIncidents(rowsConn([incidentRow(declaredIncident())]), {
      nowIso: LATER,
    });
    expect(report.open).toBe(1);
  });

  it("orders newest first with a bound limit", async () => {
    const capture: Captured[] = [];
    await replayIncidents(rowsConn([], capture), { limit: 42, nowIso: LATER });
    expect(capture[0]?.sql).toContain("ORDER BY declared_at DESC");
    expect(capture[0]?.params).toEqual([42]);
  });

  it("defaults the limit to 500", async () => {
    const capture: Captured[] = [];
    await replayIncidents(rowsConn([], capture), { nowIso: LATER });
    expect(capture[0]?.params).toEqual([500]);
  });

  it("rejects a non-positive limit", async () => {
    await expect(replayIncidents(rowsConn([]), { limit: 0 })).rejects.toThrow(/limit/);
  });

  it("handles an empty table", async () => {
    const report = await replayIncidents(mockConnection(undefined, () => EMPTY), {
      nowIso: LATER,
    });
    expect(report).toMatchObject({ scanned: 0, open: 0, drift: [] });
  });

  it("stamps the assessment time", async () => {
    const report = await replayIncidents(rowsConn([]), { nowIso: LATER });
    expect(report.checkedAt).toBe(LATER);
  });

  it("flags a row whose record no longer satisfies the contract", async () => {
    // Exactly what a hand-written UPDATE does and no CHECK constraint catches.
    const row = incidentRow(declaredIncident());
    row["status"] = "closed";
    const report = await replayIncidents(rowsConn([row]), { nowIso: LATER });
    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]?.kind).toBe("unparseable_record");
    expect(report.drift[0]?.incidentId).toBe("INC-2026-0007");
  });

  it("keeps scanning after an unparseable row", async () => {
    const bad = incidentRow(declaredIncident());
    bad["status"] = "closed";
    const report = await replayIncidents(rowsConn([bad, incidentRow(closed())]), {
      nowIso: MUCH_LATER,
    });
    expect(report.scanned).toBe(2);
    expect(report.drift.filter((d) => d.kind === "unparseable_record")).toHaveLength(1);
  });

  it("flags year/sequence columns that disagree with the id", async () => {
    const row = incidentRow(closed());
    row["sequence_number"] = 99;
    const report = await replayIncidents(rowsConn([row]), { nowIso: MUCH_LATER });
    expect(report.drift[0]?.kind).toBe("id_sequence_mismatch");
    expect(report.drift[0]?.detail).toContain("99");
  });

  it("flags a year column that disagrees with the id", async () => {
    const row = incidentRow(closed());
    row["year"] = 2020;
    const report = await replayIncidents(rowsConn([row]), { nowIso: MUCH_LATER });
    expect(report.drift[0]?.kind).toBe("id_sequence_mismatch");
  });

  it("flags a timeline whose entries run backwards", async () => {
    const record = IncidentRecordSchema.parse({
      ...declaredIncident(),
      timeline: [
        { occurredAt: LATER, actorUserId: "a", kind: "declared", message: "second" },
        { occurredAt: T0, actorUserId: "a", kind: "observation", message: "first" },
      ],
    });
    const report = await replayIncidents(rowsConn([incidentRow(record)]), { nowIso: LATER });
    expect(report.drift.some((d) => d.kind === "timeline_out_of_order")).toBe(true);
  });

  it("reports an out-of-order timeline once, not per entry", async () => {
    const record = IncidentRecordSchema.parse({
      ...declaredIncident(),
      timeline: [
        { occurredAt: MUCH_LATER, actorUserId: "a", kind: "declared", message: "third" },
        { occurredAt: T0, actorUserId: "a", kind: "observation", message: "first" },
        { occurredAt: T0, actorUserId: "a", kind: "observation", message: "second" },
      ],
    });
    const report = await replayIncidents(rowsConn([incidentRow(record)]), { nowIso: LATER });
    expect(report.drift.filter((d) => d.kind === "timeline_out_of_order")).toHaveLength(1);
  });

  it("accepts a timeline with equal timestamps", async () => {
    const record = IncidentRecordSchema.parse({
      ...declaredIncident(),
      timeline: [
        { occurredAt: T0, actorUserId: "a", kind: "declared", message: "one" },
        { occurredAt: T0, actorUserId: "a", kind: "observation", message: "two" },
      ],
    });
    const report = await replayIncidents(rowsConn([incidentRow(record)]), { nowIso: LATER });
    expect(report.drift.some((d) => d.kind === "timeline_out_of_order")).toBe(false);
  });

  it("flags an open incident past its severity's SLA", async () => {
    // A sev1 declared and never acknowledged: not corruption, but the signal persistence makes
    // cheap to ask for.
    const report = await replayIncidents(
      rowsConn([incidentRow(declaredIncident({}, "sev1"))]),
      { nowIso: MUCH_LATER },
    );
    const breach = report.drift.find((d) => d.kind === "sla_breached_while_open");
    expect(breach?.detail).toContain("sev1");
    expect(breach?.detail).toContain("ack");
  });

  it("does not flag an open incident still inside its window", async () => {
    const report = await replayIncidents(
      rowsConn([incidentRow(declaredIncident({}, "sev5"))]),
      { nowIso: LATER },
    );
    expect(report.drift).toEqual([]);
  });

  it("does not assess SLA for a closed incident", async () => {
    const report = await replayIncidents(rowsConn([incidentRow(closed())]), {
      nowIso: "2027-01-01T00:00:00.000Z",
    });
    expect(report.drift).toEqual([]);
  });

  it("does not assess SLA for a cancelled incident", async () => {
    const cancelled = IncidentRecordSchema.parse({
      ...declaredIncident({}, "sev1"),
      status: "cancelled",
      cancelledAt: LATER,
      cancelledReason: "signal recovered before triage",
    });
    const report = await replayIncidents(rowsConn([incidentRow(cancelled)]), {
      nowIso: MUCH_LATER,
    });
    expect(report.drift).toEqual([]);
    expect(report.open).toBe(0);
  });

  it("reports several findings across several rows", async () => {
    const mismatched = incidentRow(closed());
    mismatched["sequence_number"] = 99;
    const report = await replayIncidents(
      rowsConn([mismatched, incidentRow(declaredIncident({}, "sev1"))]),
      { nowIso: MUCH_LATER },
    );
    expect(report.scanned).toBe(2);
    expect(report.drift.map((d) => d.kind).sort()).toEqual([
      "id_sequence_mismatch",
      "sla_breached_while_open",
    ]);
  });
});

describe("formatIncidentReplayReport", () => {
  it("summarizes a clean scan on one line", async () => {
    const report = await replayIncidents(rowsConn([incidentRow(closed())]), {
      nowIso: MUCH_LATER,
    });
    expect(formatIncidentReplayReport(report)).toBe("incidents: scanned 1, 0 open, 0 finding(s)");
  });

  it("lists each finding with its kind and incident", async () => {
    const report = await replayIncidents(
      rowsConn([incidentRow(declaredIncident({}, "sev1"))]),
      { nowIso: MUCH_LATER },
    );
    const text = formatIncidentReplayReport(report);
    expect(text).toContain("1 finding(s)");
    expect(text).toContain("[sla_breached_while_open] INC-2026-0007");
  });
});

describe("drift detail readability", () => {
  it("flattens a schema failure to one line of path: message pairs", async () => {
    // A ZodError's own message is a multi-line JSON dump; a report an operator scans needs one line.
    const row = incidentRow(declaredIncident());
    row["status"] = "closed";
    const report = await replayIncidents(rowsConn([row]), { nowIso: LATER });
    const detail = report.drift[0]?.detail ?? "";
    expect(detail).not.toContain("\n");
    expect(detail).toContain("closedAt: closed status requires closedAt");
    expect(detail).toContain("rootCause: closed incidents must declare rootCause");
  });

  it("keeps a plain error's message as-is", async () => {
    const row = incidentRow(declaredIncident());
    row["timeline"] = "{not json";
    const report = await replayIncidents(rowsConn([row]), { nowIso: LATER });
    expect(report.drift[0]?.kind).toBe("unparseable_record");
    expect(report.drift[0]?.detail).not.toContain("\n");
  });
});
