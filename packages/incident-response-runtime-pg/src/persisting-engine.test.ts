import { describe, expect, it } from "vitest";
import { IncidentRecordSchema, type IncidentRecord } from "@crossengin/incident-response";
import { FixedClock, IncidentTransitionBlockedError } from "@crossengin/incident-response-runtime";

import { IncidentNotFoundError, PostgresIncidentStore } from "./incident-store.js";
import {
  IncidentTimelineRewriteError,
  PersistentIncidentEngine,
} from "./persisting-engine.js";
import { INCIDENT_COLUMN_NAMES } from "./records.js";
import {
  EMPTY,
  T0,
  declaredIncident,
  incidentRow,
  mockConnection,
  respondTo,
  type Captured,
} from "./test-fakes.js";

const T1 = "2026-09-30T10:05:00.000Z";

function engineOver(
  record: IncidentRecord | null,
  revision = 1,
  capture?: Captured[],
  at = T1,
): PersistentIncidentEngine {
  const conn = mockConnection(
    capture,
    respondTo([
      [
        "WHERE incident_id = $1",
        record === null ? EMPTY : { rows: [incidentRow(record, revision)], rowCount: 1 },
      ],
      ["MAX(sequence_number)", { rows: [{ next: "7" }], rowCount: 1 }],
    ]),
  );
  return new PersistentIncidentEngine({ conn, clock: new FixedClock(new Date(at)) });
}

const DECLARE_INPUT = {
  title: "Checkout latency",
  severity: "sev3",
  category: "availability",
  declaredBy: "operate-server",
  detail: "burn 14.4x",
} as const;

const SEV3_ROLES = [
  { role: "incident_commander", userId: "a", assignedAt: T0 },
  { role: "scribe", userId: "b", assignedAt: T0 },
  { role: "comms_lead", userId: "c", assignedAt: T0 },
];

function triaged(): IncidentRecord {
  const base = declaredIncident();
  return IncidentRecordSchema.parse({
    ...base,
    roleAssignments: SEV3_ROLES,
    status: "triaged",
    ackedAt: T0,
    timeline: [
      ...base.timeline,
      { occurredAt: T0, actorUserId: "a", kind: "status_changed", message: "declared -> triaged" },
    ],
  });
}

describe("declare", () => {
  it("allocates the id from the store and inserts", async () => {
    const capture: Captured[] = [];
    const stored = await engineOver(null, 1, capture).declare({
      ...DECLARE_INPUT,
      declaredAt: T0,
    });
    expect(stored.record.id).toBe("INC-2026-0007");
    expect(stored.revision).toBe(1);
    expect(capture.some((c) => c.sql.includes("MAX(sequence_number)"))).toBe(true);
    expect(capture.some((c) => c.sql.includes("INSERT INTO meta.incidents"))).toBe(true);
  });

  it("takes the sequence year from declaredAt, not the wall clock", async () => {
    const capture: Captured[] = [];
    await engineOver(null, 1, capture).declare({
      ...DECLARE_INPUT,
      declaredAt: "2027-01-02T00:00:00.000Z",
    });
    const alloc = capture.find((c) => c.sql.includes("MAX(sequence_number)"));
    expect(alloc?.params).toEqual([2027]);
  });

  it("falls back to the clock when declaredAt is omitted", async () => {
    const stored = await engineOver(null, 1, undefined, T1).declare(DECLARE_INPUT);
    expect(stored.record.declaredAt).toBe(T1);
  });

  it("declares in the `declared` status with one timeline entry", async () => {
    const stored = await engineOver(null).declare({ ...DECLARE_INPUT, declaredAt: T0 });
    expect(stored.record.status).toBe("declared");
    expect(stored.record.timeline).toHaveLength(1);
  });
});

describe("persistDeclared", () => {
  it("inserts a record whose id the caller already chose", async () => {
    const capture: Captured[] = [];
    const record = declaredIncident();
    const stored = await engineOver(null, 1, capture).persistDeclared(record);
    expect(stored.record).toEqual(record);
    expect(capture.some((c) => c.sql.includes("MAX(sequence_number)"))).toBe(false);
  });
});

describe("apply", () => {
  it("reads, transforms and writes under the revision it read", async () => {
    const capture: Captured[] = [];
    const engine = engineOver(declaredIncident(), 4, capture);
    const stored = await engine.apply("INC-2026-0007", (r) =>
      IncidentRecordSchema.parse({ ...r, title: "renamed" }),
    );
    expect(stored.record.title).toBe("renamed");
    expect(stored.revision).toBe(5);
    const update = capture.find((c) => c.sql.includes("UPDATE meta.incidents"));
    expect(update?.params?.[INCIDENT_COLUMN_NAMES.length]).toBe(4);
  });

  it("throws IncidentNotFoundError for an unknown incident", async () => {
    await expect(engineOver(null).apply("INC-2026-9999", (r) => r)).rejects.toThrow(
      IncidentNotFoundError,
    );
  });

  it("refuses a mutation that drops a recorded timeline entry", async () => {
    const engine = engineOver(triaged());
    await expect(
      engine.apply("INC-2026-0007", (r) =>
        IncidentRecordSchema.parse({ ...r, timeline: [r.timeline[0]] }),
      ),
    ).rejects.toThrow(IncidentTimelineRewriteError);
  });

  it("refuses a mutation that edits a recorded timeline entry", async () => {
    const engine = engineOver(declaredIncident());
    await expect(
      engine.apply("INC-2026-0007", (r) =>
        IncidentRecordSchema.parse({
          ...r,
          timeline: [{ ...r.timeline[0]!, message: "rewritten" }],
        }),
      ),
    ).rejects.toThrow(IncidentTimelineRewriteError);
  });

  it("does not write when the mutation is refused", async () => {
    const capture: Captured[] = [];
    const engine = engineOver(declaredIncident(), 1, capture);
    await expect(
      engine.apply("INC-2026-0007", (r) =>
        IncidentRecordSchema.parse({
          ...r,
          timeline: [{ ...r.timeline[0]!, message: "rewritten" }],
        }),
      ),
    ).rejects.toThrow();
    expect(capture.some((c) => c.sql.includes("UPDATE"))).toBe(false);
  });

  it("allows a mutation that only appends", async () => {
    const engine = engineOver(declaredIncident());
    const stored = await engine.apply("INC-2026-0007", (r) =>
      IncidentRecordSchema.parse({
        ...r,
        timeline: [
          ...r.timeline,
          { occurredAt: T1, actorUserId: "a", kind: "observation", message: "still bad" },
        ],
      }),
    );
    expect(stored.record.timeline).toHaveLength(2);
  });
});

describe("transition", () => {
  it("persists a legal transition", async () => {
    const capture: Captured[] = [];
    const engine = engineOver(triaged(), 2, capture);
    const stored = await engine.transition("INC-2026-0007", {
      to: "mitigating",
      at: T1,
      actorUserId: "a",
    });
    expect(stored.record.status).toBe("mitigating");
    expect(stored.revision).toBe(3);
  });

  it("refuses a blocked transition before touching the database", async () => {
    const capture: Captured[] = [];
    const engine = engineOver(declaredIncident(), 1, capture);
    await expect(
      engine.transition("INC-2026-0007", { to: "triaged", at: T1, actorUserId: "a" }),
    ).rejects.toThrow(IncidentTransitionBlockedError);
    expect(capture.some((c) => c.sql.includes("UPDATE"))).toBe(false);
  });
});

describe("role operations", () => {
  it("persists a role assignment", async () => {
    const engine = engineOver(declaredIncident());
    const stored = await engine.assignRole("INC-2026-0007", {
      role: "incident_commander",
      userId: "alice",
      actorUserId: "alice",
      at: T1,
    });
    expect(stored.record.roleAssignments).toHaveLength(1);
  });

  it("persists a handoff as one write", async () => {
    const capture: Captured[] = [];
    const engine = engineOver(triaged(), 1, capture);
    const stored = await engine.handOffRole("INC-2026-0007", {
      role: "incident_commander",
      toUserId: "dave",
      reason: "shift",
      actorUserId: "a",
      at: T1,
    });
    expect(stored.record.roleAssignments).toHaveLength(4);
    expect(capture.filter((c) => c.sql.includes("UPDATE meta.incidents"))).toHaveLength(1);
  });
});

describe("changeSeverity, note, attachPostmortem", () => {
  it("persists a severity change", async () => {
    const engine = engineOver(declaredIncident());
    const stored = await engine.changeSeverity("INC-2026-0007", {
      severity: "sev4",
      reason: "narrower",
      actorUserId: "a",
      at: T1,
    });
    expect(stored.record.severity).toBe("sev4");
  });

  it("persists a note without changing status", async () => {
    const engine = engineOver(declaredIncident());
    const stored = await engine.note("INC-2026-0007", {
      kind: "observation",
      message: "errors falling",
      actorUserId: "a",
      at: T1,
    });
    expect(stored.record.status).toBe("declared");
    expect(stored.record.timeline).toHaveLength(2);
  });

  it("persists a postmortem link", async () => {
    const engine = engineOver(declaredIncident());
    const stored = await engine.attachPostmortem("INC-2026-0007", {
      postmortemId: "PM-2026-0001",
      actorUserId: "a",
      at: T1,
    });
    expect(stored.record.postmortemId).toBe("PM-2026-0001");
  });
});

describe("cancelIfUntriaged", () => {
  it("cancels an untouched incident and writes it", async () => {
    const capture: Captured[] = [];
    const engine = engineOver(declaredIncident(), 1, capture);
    const stored = await engine.cancelIfUntriaged("INC-2026-0007", {
      reason: "signal recovered before triage",
      actorUserId: "operate-server",
      at: T1,
    });
    expect(stored?.record.status).toBe("cancelled");
    expect(stored?.record.cancelledReason).toBe("signal recovered before triage");
    expect(capture.some((c) => c.sql.includes("UPDATE meta.incidents"))).toBe(true);
  });

  it("returns null and writes nothing once a human has triaged it", async () => {
    const capture: Captured[] = [];
    const engine = engineOver(triaged(), 1, capture);
    const stored = await engine.cancelIfUntriaged("INC-2026-0007", {
      reason: "recovered",
      actorUserId: "operate-server",
      at: T1,
    });
    expect(stored).toBeNull();
    expect(capture.some((c) => c.sql.includes("UPDATE"))).toBe(false);
  });

  it("throws for an unknown incident", async () => {
    await expect(
      engineOver(null).cancelIfUntriaged("INC-2026-9999", {
        reason: "r",
        actorUserId: "operate-server",
      }),
    ).rejects.toThrow(IncidentNotFoundError);
  });

  it("falls back to the clock for the cancellation time", async () => {
    const engine = engineOver(declaredIncident(), 1, undefined, T1);
    const stored = await engine.cancelIfUntriaged("INC-2026-0007", {
      reason: "recovered",
      actorUserId: "operate-server",
    });
    expect(stored?.record.cancelledAt).toBe(T1);
  });
});

describe("load and listOpen", () => {
  it("loads through the store", async () => {
    const engine = engineOver(declaredIncident(), 3);
    const stored = await engine.load("INC-2026-0007");
    expect(stored?.revision).toBe(3);
  });

  it("returns null for a missing incident rather than throwing", async () => {
    expect(await engineOver(null).load("INC-2026-9999")).toBeNull();
  });

  it("delegates listOpen to the store", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, () => EMPTY);
    const engine = new PersistentIncidentEngine({ conn });
    await engine.listOpen(5);
    expect(capture[0]?.sql).toContain("status NOT IN ('closed', 'cancelled')");
  });

  it("accepts an injected store", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, () => EMPTY);
    const store = new PostgresIncidentStore(conn);
    const engine = new PersistentIncidentEngine({ conn, store });
    await engine.listOpen();
    expect(capture).toHaveLength(1);
  });
});
