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

  it("reports the open incident a restart should adopt", async () => {
    const record = declaredIncident({ autoDeclaredFor: "availability:product.list" });
    const conn = mockConnection(
      [],
      respondTo([["auto_declared_for", { rows: [incidentRow(record)], rowCount: 1 }]]),
    );
    const found = await new PostgresIncidentDeclarer({ conn }).findOpen(
      "availability:product.list",
    );
    expect(found?.id).toBe(record.id);
  });

  it("reports nothing open when the signal has no incident", async () => {
    const conn = mockConnection([], respondTo([["auto_declared_for", EMPTY]]));
    expect(await new PostgresIncidentDeclarer({ conn }).findOpen("availability:x")).toBeNull();
  });

  it("declares with the signal key it was given", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(
      capture,
      respondTo([["COALESCE(MAX(sequence_number)", { rows: [{ next: "1" }], rowCount: 1 }]]),
    );
    const record = await new PostgresIncidentDeclarer({ conn }).declare({
      ...REQUEST,
      autoDeclaredFor: "availability:product.list",
    });
    expect(record.autoDeclaredFor).toBe("availability:product.list");
    const insert = capture.find((c) => c.sql.includes("INSERT INTO meta.incidents"));
    expect(insert?.params).toContain("availability:product.list");
  });

  it("reads the grade a resolve has to route on, by id", async () => {
    const record = declaredIncident({}, "sev1");
    const conn = mockConnection(
      [],
      respondTo([["WHERE incident_id = $1", { rows: [incidentRow(record)], rowCount: 1 }]]),
    );
    const found = await new PostgresIncidentDeclarer({ conn }).findById(record.id);
    expect(found?.id).toBe(record.id);
    expect(found?.severity).toBe("sev1");
  });

  it("reads by incident_id, binding the id it was given", async () => {
    const capture: Captured[] = [];
    const record = declaredIncident();
    const conn = mockConnection(
      capture,
      respondTo([["WHERE incident_id = $1", { rows: [incidentRow(record)], rowCount: 1 }]]),
    );
    await new PostgresIncidentDeclarer({ conn }).findById("INC-2026-0007");
    expect(capture).toHaveLength(1);
    expect(capture[0]?.sql).toContain("FROM meta.incidents");
    expect(capture[0]?.sql).toContain("WHERE incident_id = $1");
    expect(capture[0]?.params).toEqual(["INC-2026-0007"]);
  });

  it("answers null for an id no row holds", async () => {
    const conn = mockConnection([], respondTo([["WHERE incident_id = $1", EMPTY]]));
    expect(await new PostgresIncidentDeclarer({ conn }).findById("INC-2026-0404")).toBeNull();
  });

  it("writes nothing, so a resolve cannot mutate the record it is reading", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(
      capture,
      respondTo([
        ["WHERE incident_id = $1", { rows: [incidentRow(declaredIncident())], rowCount: 1 }],
      ]),
    );
    await new PostgresIncidentDeclarer({ conn }).findById("INC-2026-0007");
    expect(capture.some((c) => /INSERT|UPDATE|DELETE/.test(c.sql))).toBe(false);
  });

  it("refuses a row whose severity is not in the vocabulary", async () => {
    const row = { ...incidentRow(declaredIncident()), severity: "sev9" };
    const conn = mockConnection(
      [],
      respondTo([["WHERE incident_id = $1", { rows: [row], rowCount: 1 }]]),
    );
    await expect(
      new PostgresIncidentDeclarer({ conn }).findById("INC-2026-0007"),
    ).rejects.toThrow();
  });

  it("refuses a row edited into a state the contract forbids but a CHECK permits", async () => {
    // `status = 'resolved'` with `resolved_at` NULL is beyond what the database can express, so
    // re-parsing is the only detector (ADR-0289) — and answering null here would make the recovery
    // path the one read in this package that absorbs a tampered row in silence.
    const row = { ...incidentRow(declaredIncident()), status: "resolved", resolved_at: null };
    const conn = mockConnection(
      [],
      respondTo([["WHERE incident_id = $1", { rows: [row], rowCount: 1 }]]),
    );
    await expect(
      new PostgresIncidentDeclarer({ conn }).findById("INC-2026-0007"),
    ).rejects.toThrow();
  });

  it("distinguishes a tampered row from an absent one", async () => {
    // Collapsing the two into null would report "nothing to resolve" for a record that has been
    // rewritten, which is the opposite of what a reviewer needs to hear.
    const tampered = { ...incidentRow(declaredIncident()), severity: "sev9" };
    const present = mockConnection(
      [],
      respondTo([["WHERE incident_id = $1", { rows: [tampered], rowCount: 1 }]]),
    );
    const absent = mockConnection([], respondTo([["WHERE incident_id = $1", EMPTY]]));
    await expect(
      new PostgresIncidentDeclarer({ conn: present }).findById("INC-2026-0007"),
    ).rejects.toThrow();
    expect(
      await new PostgresIncidentDeclarer({ conn: absent }).findById("INC-2026-0007"),
    ).toBeNull();
  });

  it("reads through a prepared engine when one was supplied", async () => {
    const record = declaredIncident();
    const conn = mockConnection(
      [],
      respondTo([["WHERE incident_id = $1", { rows: [incidentRow(record)], rowCount: 1 }]]),
    );
    const engine = new PersistentIncidentEngine({ conn });
    expect((await new PostgresIncidentDeclarer({ engine }).findById(record.id))?.id).toBe(
      record.id,
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
