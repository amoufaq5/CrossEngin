import { describe, expect, it } from "vitest";

import { PostgresIncidentDeclarer } from "./declarer.js";
import { PersistentIncidentEngine } from "./persisting-engine.js";
import {
  EMPTY,
  T0,
  declaredIncident,
  incidentRow,
  mockConnection,
  respondTo,
  type Captured,
} from "./test-fakes.js";

const REQUEST = {
  title: "SLO burn alert: slo_api on api.read",
  severity: "sev3",
  category: "availability",
  declaredBy: "system-slo-enforcer",
  detail: "burn 14.4x over 1h",
  declaredAt: T0,
  metadata: { surface: "api.read", autoDeclared: true },
} as const;

describe("PostgresIncidentDeclarer", () => {
  it("takes the id from the database, not from a counter", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(
      capture,
      respondTo([["COALESCE(MAX(sequence_number)", { rows: [{ next: "41" }], rowCount: 1 }]]),
    );
    const record = await new PostgresIncidentDeclarer({ conn }).declare(REQUEST);
    expect(record.id).toBe("INC-2026-0041");
  });

  it("writes the record before handing the id back", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(
      capture,
      respondTo([["COALESCE(MAX(sequence_number)", { rows: [{ next: "1" }], rowCount: 1 }]]),
    );
    const record = await new PostgresIncidentDeclarer({ conn }).declare(REQUEST);
    const insert = capture.find((c) => c.sql.includes("INSERT INTO meta.incidents"));
    expect(insert).toBeDefined();
    expect(insert?.params?.[0]).toBe(record.id);
  });

  it("holds the allocation lock across the insert", async () => {
    const conn = mockConnection(
      [],
      respondTo([["COALESCE(MAX(sequence_number)", { rows: [{ next: "1" }], rowCount: 1 }]]),
    );
    await new PostgresIncidentDeclarer({ conn }).declare(REQUEST);
    expect(conn.withAdvisoryLock).toHaveBeenCalledTimes(1);
  });

  it("accepts a prepared engine instead of a connection", async () => {
    const conn = mockConnection(
      [],
      respondTo([["COALESCE(MAX(sequence_number)", { rows: [{ next: "9" }], rowCount: 1 }]]),
    );
    const engine = new PersistentIncidentEngine({ conn });
    const record = await new PostgresIncidentDeclarer({ engine }).declare(REQUEST);
    expect(record.id).toBe("INC-2026-0009");
  });

  it("refuses to be built with neither a connection nor an engine", () => {
    expect(() => new PostgresIncidentDeclarer({})).toThrow(
      /needs either a connection or an engine/,
    );
  });

  it("cancels an untaken incident on close-out", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(
      capture,
      respondTo([["SELECT", { rows: [incidentRow(declaredIncident())], rowCount: 1 }]]),
    );
    const outcome = await new PostgresIncidentDeclarer({ conn }).closeOut("INC-2026-0007", {
      reason: "burn recovered",
      actorUserId: "system-slo-enforcer",
    });
    expect(outcome).toBe("cancelled");
    const update = capture.find((c) => c.sql.includes("UPDATE meta.incidents"));
    expect(update).toBeDefined();
  });

  it("leaves a triaged incident to its responders", async () => {
    const base = declaredIncident();
    const triaged = declaredIncident({
      status: "triaged",
      ackedAt: T0,
      roleAssignments: [
        { role: "incident_commander", userId: "a", assignedAt: T0 },
        { role: "scribe", userId: "b", assignedAt: T0 },
        { role: "comms_lead", userId: "c", assignedAt: T0 },
      ],
      timeline: [
        ...base.timeline,
        { occurredAt: T0, actorUserId: "a", kind: "status_changed", message: "declared -> triaged" },
      ],
    });
    const capture: Captured[] = [];
    const conn = mockConnection(
      capture,
      respondTo([["SELECT", { rows: [incidentRow(triaged)], rowCount: 1 }]]),
    );
    const outcome = await new PostgresIncidentDeclarer({ conn }).closeOut("INC-2026-0007", {
      reason: "burn recovered",
      actorUserId: "system-slo-enforcer",
    });
    expect(outcome).toBe("human_owned");
    expect(capture.some((c) => c.sql.includes("UPDATE meta.incidents"))).toBe(false);
  });

  it("stamps the cancellation at the supplied time", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(
      capture,
      respondTo([["SELECT", { rows: [incidentRow(declaredIncident())], rowCount: 1 }]]),
    );
    const at = "2026-09-30T11:30:00.000Z";
    await new PostgresIncidentDeclarer({ conn }).closeOut("INC-2026-0007", {
      reason: "burn recovered",
      actorUserId: "system-slo-enforcer",
      at,
    });
    const update = capture.find((c) => c.sql.includes("UPDATE meta.incidents"));
    expect(update?.params).toContain(at);
  });

  it("propagates a missing incident rather than reporting a close-out", async () => {
    const conn = mockConnection([], respondTo([["SELECT", EMPTY]]));
    await expect(
      new PostgresIncidentDeclarer({ conn }).closeOut("INC-2026-0404", {
        reason: "burn recovered",
        actorUserId: "system-slo-enforcer",
      }),
    ).rejects.toThrow(/not found/);
  });
});
