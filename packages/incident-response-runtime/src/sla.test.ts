import { describe, expect, it } from "vitest";
import {
  IncidentRecordSchema,
  metAckSla,
  profileFor,
  type IncidentRecord,
  type Severity,
} from "@crossengin/incident-response";

import {
  SLA_TARGETS,
  assessIncidentSla,
  formatIncidentSla,
  incidentsBreachingSla,
} from "./sla.js";

const T0 = "2026-09-30T10:00:00.000Z";

function atMinutes(n: number): string {
  return new Date(new Date(T0).getTime() + n * 60_000).toISOString();
}

function incident(
  severity: Severity,
  over: Partial<Record<string, unknown>> = {},
): IncidentRecord {
  return IncidentRecordSchema.parse({
    id: "INC-2026-0001",
    title: "Checkout latency",
    severity,
    category: "availability",
    status: "declared",
    declaredAt: T0,
    declaredBy: "operate-server",
    timeline: [{ occurredAt: T0, actorUserId: "operate-server", kind: "declared", message: "x" }],
    ...over,
  });
}

describe("SLA_TARGETS", () => {
  it("names the three profile clocks", () => {
    expect([...SLA_TARGETS]).toEqual(["ack", "mitigate", "resolve"]);
  });
});

describe("assessIncidentSla", () => {
  it("reports a clock per target", () => {
    const a = assessIncidentSla(incident("sev3"), atMinutes(1));
    expect(a.clocks).toHaveLength(3);
    expect(a.clocks.map((c) => c.target)).toEqual(["ack", "mitigate", "resolve"]);
  });

  it("takes the target minutes from the severity profile", () => {
    const a = assessIncidentSla(incident("sev1"), atMinutes(1));
    const profile = profileFor("sev1");
    expect(a.clocks[0]?.targetMinutes).toBe(profile.ackMinutes);
    expect(a.clocks[1]?.targetMinutes).toBe(profile.mitigateMinutes);
    expect(a.clocks[2]?.targetMinutes).toBe(profile.resolveMinutes);
  });

  it("reports no breach one minute into a sev1", () => {
    const a = assessIncidentSla(incident("sev1"), atMinutes(1));
    expect(a.breachedTargets).toEqual([]);
  });

  it("counts down the minutes remaining on an outstanding target", () => {
    // sev1 ack target is 5 minutes.
    const a = assessIncidentSla(incident("sev1"), atMinutes(2));
    expect(a.clocks[0]?.minutesRemaining).toBe(3);
  });

  it("breaches an unacknowledged sev1 after its ack window elapses", () => {
    const a = assessIncidentSla(incident("sev1"), atMinutes(6));
    expect(a.breachedTargets).toContain("ack");
    expect(a.clocks[0]?.reachedAt).toBeNull();
    expect(a.clocks[0]?.minutesRemaining).toBeNull();
  });

  it("is the case the contracts helper cannot report", () => {
    // `metAckSla` returns null while ackedAt is unset, so a breach on an open incident is
    // invisible to it — which is the gap this module exists to close.
    const open = incident("sev1");
    expect(metAckSla(open)).toBeNull();
    expect(assessIncidentSla(open, atMinutes(6)).breachedTargets).toContain("ack");
  });

  it("stops the ack clock at the stamp once acknowledged", () => {
    const acked = incident("sev1", { ackedAt: atMinutes(3) });
    const a = assessIncidentSla(acked, atMinutes(600));
    expect(a.clocks[0]?.reachedAt).toBe(atMinutes(3));
    expect(a.clocks[0]?.elapsedMinutes).toBe(3);
    expect(a.breachedTargets).not.toContain("ack");
  });

  it("agrees with the contracts helper once a target is reached", () => {
    const late = incident("sev1", { ackedAt: atMinutes(9) });
    expect(metAckSla(late)).toBe(false);
    expect(assessIncidentSla(late, atMinutes(10)).breachedTargets).toContain("ack");
  });

  it("marks a target reached exactly on the boundary as met", () => {
    const a = assessIncidentSla(incident("sev1", { ackedAt: atMinutes(5) }), atMinutes(10));
    expect(a.clocks[0]?.breached).toBe(false);
  });

  it("holds the mitigate clock at the resolve stamp for a finished incident", () => {
    // sev1 mitigate target is 60 minutes; resolved at 30 and never separately mitigated, so the
    // clock must stop at 30 rather than running on to `now`.
    const resolved = incident("sev1", {
      roleAssignments: [
        { role: "incident_commander", userId: "a", assignedAt: T0 },
        { role: "scribe", userId: "b", assignedAt: T0 },
        { role: "comms_lead", userId: "c", assignedAt: T0 },
      ],
      publiclyVisible: true,
      status: "resolved",
      ackedAt: atMinutes(2),
      mitigatedAt: atMinutes(20),
      resolvedAt: atMinutes(30),
    });
    const a = assessIncidentSla(resolved, atMinutes(5000));
    expect(a.clocks[1]?.elapsedMinutes).toBe(20);
    expect(a.breachedTargets).toEqual([]);
  });

  it("breaches the resolve target on an incident left open past its window", () => {
    // sev1 resolve target is 240 minutes.
    const a = assessIncidentSla(incident("sev1", { ackedAt: atMinutes(1) }), atMinutes(300));
    expect(a.breachedTargets).toContain("resolve");
  });

  it("reports every breached target at once", () => {
    const a = assessIncidentSla(incident("sev1"), atMinutes(5000));
    expect(a.breachedTargets).toEqual(["ack", "mitigate", "resolve"]);
  });

  it("treats a cancelled incident as owing nothing", () => {
    const cancelled = incident("sev1", {
      status: "cancelled",
      cancelledAt: atMinutes(1),
      cancelledReason: "signal recovered before triage",
    });
    const a = assessIncidentSla(cancelled, atMinutes(5000));
    expect(a.applicable).toBe(false);
    expect(a.breachedTargets).toEqual([]);
  });

  it("still applies to a closed incident", () => {
    const closed = incident("sev3", {
      roleAssignments: [
        { role: "incident_commander", userId: "a", assignedAt: T0 },
        { role: "scribe", userId: "b", assignedAt: T0 },
        { role: "comms_lead", userId: "c", assignedAt: T0 },
      ],
      status: "closed",
      ackedAt: atMinutes(1),
      mitigatedAt: atMinutes(2),
      resolvedAt: atMinutes(3),
      closedAt: atMinutes(4),
      rootCause: "bad deploy",
    });
    expect(assessIncidentSla(closed, atMinutes(5000)).applicable).toBe(true);
  });

  it("echoes the incident id, severity and assessment time", () => {
    const a = assessIncidentSla(incident("sev2"), atMinutes(1));
    expect(a.incidentId).toBe("INC-2026-0001");
    expect(a.severity).toBe("sev2");
    expect(a.assessedAt).toBe(atMinutes(1));
  });

  it("gives a looser sev5 more room than a sev1 at the same elapsed time", () => {
    const at = atMinutes(30);
    expect(assessIncidentSla(incident("sev1"), at).breachedTargets).toContain("ack");
    expect(assessIncidentSla(incident("sev5"), at).breachedTargets).toEqual([]);
  });
});

describe("incidentsBreachingSla", () => {
  it("keeps only the breaching incidents", () => {
    const records = [
      incident("sev1"),
      IncidentRecordSchema.parse({ ...incident("sev5"), id: "INC-2026-0002" }),
    ];
    const breaching = incidentsBreachingSla(records, atMinutes(30));
    expect(breaching).toHaveLength(1);
    expect(breaching[0]?.incidentId).toBe("INC-2026-0001");
  });

  it("returns an empty list when nothing is breaching", () => {
    expect(incidentsBreachingSla([incident("sev1")], atMinutes(1))).toEqual([]);
  });

  it("excludes cancelled incidents however long they sat", () => {
    const cancelled = incident("sev1", {
      status: "cancelled",
      cancelledAt: atMinutes(1),
      cancelledReason: "recovered",
    });
    expect(incidentsBreachingSla([cancelled], atMinutes(9999))).toEqual([]);
  });

  it("handles an empty input", () => {
    expect(incidentsBreachingSla([], atMinutes(1))).toEqual([]);
  });
});

describe("formatIncidentSla", () => {
  it("reports a within-SLA incident", () => {
    expect(formatIncidentSla(assessIncidentSla(incident("sev1"), atMinutes(1)))).toBe(
      "INC-2026-0001 (sev1): within SLA",
    );
  });

  it("names each breached clock with its numbers", () => {
    const line = formatIncidentSla(assessIncidentSla(incident("sev1"), atMinutes(6)));
    expect(line).toContain("BREACHED");
    expect(line).toContain("ack 6m > 5m");
  });

  it("says a cancelled incident owed nothing", () => {
    const cancelled = incident("sev1", {
      status: "cancelled",
      cancelledAt: atMinutes(1),
      cancelledReason: "recovered",
    });
    expect(formatIncidentSla(assessIncidentSla(cancelled, atMinutes(9999)))).toBe(
      "INC-2026-0001: cancelled, no SLA owed",
    );
  });
});
