import { describe, expect, it } from "vitest";
import {
  IncidentRecordSchema,
  type IncidentRecord,
  type IncidentRole,
  type Severity,
} from "@crossengin/incident-response";

import {
  IllegalIncidentTransitionError,
  IncidentTransitionBlockedError,
  cancelIfUntriaged,
  draftTransition,
  incidentTransitionBlockers,
  isIncidentOpen,
  transitionIncident,
} from "./transitions.js";

const T0 = "2026-09-30T10:00:00.000Z";
const T1 = "2026-09-30T10:05:00.000Z";
const T2 = "2026-09-30T10:30:00.000Z";
const T3 = "2026-09-30T11:00:00.000Z";

function declared(severity: Severity = "sev3"): IncidentRecord {
  return IncidentRecordSchema.parse({
    id: "INC-2026-0001",
    title: "Checkout latency",
    severity,
    category: "availability",
    status: "declared",
    declaredAt: T0,
    declaredBy: "operate-server",
    timeline: [
      { occurredAt: T0, actorUserId: "operate-server", kind: "declared", message: "burn" },
    ],
  });
}

function roles(
  list: readonly IncidentRole[],
  at = T0,
): ReadonlyArray<Record<string, unknown>> {
  return list.map((role, i) => ({
    role,
    userId: `u${i}`,
    assignedAt: at,
    handedOffAt: null,
    handedOffToUserId: null,
  }));
}

const SEV3_ROLES: readonly IncidentRole[] = ["incident_commander", "scribe", "comms_lead"];

function triaged(severity: Severity = "sev3"): IncidentRecord {
  const base = declared(severity);
  return transitionIncident(
    IncidentRecordSchema.parse({
      ...base,
      roleAssignments: roles(SEV3_ROLES),
      publiclyVisible: severity === "sev1" || severity === "sev2",
    }),
    { to: "triaged", at: T1, actorUserId: "u0" },
  );
}

describe("draftTransition", () => {
  it("appends exactly one timeline entry", () => {
    const draft = draftTransition(declared(), {
      to: "cancelled",
      at: T1,
      actorUserId: "u0",
      cancelledReason: "duplicate",
    }) as IncidentRecord;
    expect(draft.timeline).toHaveLength(2);
  });

  it("marks a resolve with the 'resolved' timeline kind, not 'status_changed'", () => {
    const record = transitionIncident(triaged(), {
      to: "mitigating",
      at: T2,
      actorUserId: "u0",
    });
    const resolved = transitionIncident(record, { to: "resolved", at: T3, actorUserId: "u0" });
    expect(resolved.timeline[resolved.timeline.length - 1]?.kind).toBe("resolved");
  });

  it("uses a default message naming both statuses", () => {
    const draft = draftTransition(declared(), {
      to: "cancelled",
      at: T1,
      actorUserId: "u0",
      cancelledReason: "x",
    }) as IncidentRecord;
    expect(draft.timeline[1]?.message).toBe("status declared -> cancelled");
  });

  it("carries caller metadata onto the entry", () => {
    const draft = draftTransition(declared(), {
      to: "cancelled",
      at: T1,
      actorUserId: "u0",
      cancelledReason: "x",
      metadata: { source: "slo" },
    }) as IncidentRecord;
    expect(draft.timeline[1]?.metadata).toEqual({ source: "slo" });
  });

  it("does not mutate the input record", () => {
    const base = declared();
    draftTransition(base, { to: "cancelled", at: T1, actorUserId: "u0", cancelledReason: "x" });
    expect(base.timeline).toHaveLength(1);
    expect(base.status).toBe("declared");
  });
});

describe("timestamp stamping", () => {
  it("stamps ackedAt on the move to triaged", () => {
    expect(triaged().ackedAt).toBe(T1);
  });

  it("preserves an ackedAt that was already set", () => {
    const base = IncidentRecordSchema.parse({
      ...declared(),
      roleAssignments: roles(SEV3_ROLES),
      ackedAt: T0,
    });
    expect(transitionIncident(base, { to: "triaged", at: T2, actorUserId: "u0" }).ackedAt).toBe(
      T0,
    );
  });

  it("stamps mitigatedAt on the move to mitigated", () => {
    const m = transitionIncident(triaged(), { to: "mitigating", at: T2, actorUserId: "u0" });
    expect(transitionIncident(m, { to: "mitigated", at: T3, actorUserId: "u0" }).mitigatedAt).toBe(
      T3,
    );
  });

  it("back-fills mitigatedAt when resolving straight from mitigating", () => {
    const m = transitionIncident(triaged(), { to: "mitigating", at: T2, actorUserId: "u0" });
    const resolved = transitionIncident(m, { to: "resolved", at: T3, actorUserId: "u0" });
    expect(resolved.mitigatedAt).toBe(T3);
    expect(resolved.resolvedAt).toBe(T3);
  });

  it("clears mitigatedAt when mitigation is re-entered", () => {
    const m = transitionIncident(triaged(), { to: "mitigating", at: T2, actorUserId: "u0" });
    const done = transitionIncident(m, { to: "mitigated", at: T3, actorUserId: "u0" });
    const again = transitionIncident(done, {
      to: "mitigating",
      at: "2026-09-30T12:00:00.000Z",
      actorUserId: "u0",
    });
    expect(again.mitigatedAt).toBeNull();
  });

  it("keeps mitigatedAt when re-entering mitigation on an already-resolved record", () => {
    // Schema-legal but unusual: resolvedAt set while status is still `mitigated`. Clearing
    // mitigatedAt here would break resolvedAt-implies-mitigatedAt.
    const odd = IncidentRecordSchema.parse({
      ...declared(),
      roleAssignments: roles(SEV3_ROLES),
      status: "mitigated",
      ackedAt: T1,
      mitigatedAt: T2,
      resolvedAt: T3,
    });
    const again = transitionIncident(odd, { to: "mitigating", at: T3, actorUserId: "u0" });
    expect(again.mitigatedAt).toBe(T2);
  });

  it("stamps closedAt on close", () => {
    const resolved = resolvedSev3();
    const closed = transitionIncident(resolved, {
      to: "closed",
      at: T3,
      actorUserId: "u0",
      rootCause: "bad deploy",
    });
    expect(closed.closedAt).toBe(T3);
  });

  it("stamps cancelledAt on cancel", () => {
    const c = transitionIncident(declared(), {
      to: "cancelled",
      at: T1,
      actorUserId: "u0",
      cancelledReason: "recovered",
    });
    expect(c.cancelledAt).toBe(T1);
  });

  it("stamps nothing new on postmortem_pending", () => {
    const resolved = resolvedSev3();
    const pending = transitionIncident(resolved, {
      to: "postmortem_pending",
      at: T3,
      actorUserId: "u0",
    });
    expect(pending.closedAt).toBeNull();
    expect(pending.resolvedAt).toBe(resolved.resolvedAt);
  });
});

function resolvedSev3(): IncidentRecord {
  const m = transitionIncident(triaged(), { to: "mitigating", at: T2, actorUserId: "u0" });
  return transitionIncident(m, { to: "resolved", at: T3, actorUserId: "u0" });
}

describe("incidentTransitionBlockers", () => {
  it("is empty for a transition that would be accepted", () => {
    const base = IncidentRecordSchema.parse({
      ...declared(),
      roleAssignments: roles(SEV3_ROLES),
    });
    expect(incidentTransitionBlockers(base, { to: "triaged", at: T1, actorUserId: "u0" })).toEqual(
      [],
    );
  });

  it("names an illegal transition without consulting the schema", () => {
    expect(
      incidentTransitionBlockers(declared(), { to: "closed", at: T1, actorUserId: "u0" }),
    ).toEqual(["illegal transition 'declared' -> 'closed'"]);
  });

  it("reports missing roles when triaging a bare declared incident", () => {
    const blockers = incidentTransitionBlockers(declared(), {
      to: "triaged",
      at: T1,
      actorUserId: "u0",
    });
    expect(blockers.join(" ")).toContain("incident_commander");
    expect(blockers.join(" ")).toContain("roleAssignments");
  });

  it("requires five roles at sev1, not three", () => {
    const sev1 = IncidentRecordSchema.parse({
      ...declared("sev1"),
      roleAssignments: roles(SEV3_ROLES),
      publiclyVisible: true,
    });
    const blockers = incidentTransitionBlockers(sev1, {
      to: "triaged",
      at: T1,
      actorUserId: "u0",
    });
    expect(blockers.join(" ")).toContain("technical_lead");
    expect(blockers.join(" ")).toContain("executive_sponsor");
  });

  it("reports an un-flipped status page for sev1", () => {
    const sev1 = IncidentRecordSchema.parse({
      ...declared("sev1"),
      roleAssignments: roles([
        "incident_commander",
        "scribe",
        "comms_lead",
        "technical_lead",
        "executive_sponsor",
      ]),
    });
    const blockers = incidentTransitionBlockers(sev1, {
      to: "triaged",
      at: T1,
      actorUserId: "u0",
    });
    expect(blockers.join(" ")).toContain("publiclyVisible");
  });

  it("clears once publiclyVisible is supplied with the transition", () => {
    const sev1 = IncidentRecordSchema.parse({
      ...declared("sev1"),
      roleAssignments: roles([
        "incident_commander",
        "scribe",
        "comms_lead",
        "technical_lead",
        "executive_sponsor",
      ]),
    });
    expect(
      incidentTransitionBlockers(sev1, {
        to: "triaged",
        at: T1,
        actorUserId: "u0",
        publiclyVisible: true,
      }),
    ).toEqual([]);
  });

  it("reports a missing rootCause on close", () => {
    const blockers = incidentTransitionBlockers(resolvedSev3(), {
      to: "closed",
      at: T3,
      actorUserId: "u0",
    });
    expect(blockers.join(" ")).toContain("rootCause");
  });

  it("reports a missing postmortemId when the severity requires one", () => {
    const sev2Roles: readonly IncidentRole[] = SEV3_ROLES;
    const base = IncidentRecordSchema.parse({
      ...declared("sev2"),
      roleAssignments: roles(sev2Roles),
      publiclyVisible: true,
      status: "resolved",
      ackedAt: T1,
      mitigatedAt: T2,
      resolvedAt: T3,
    });
    const blockers = incidentTransitionBlockers(base, {
      to: "closed",
      at: T3,
      actorUserId: "u0",
      rootCause: "x",
    });
    expect(blockers.join(" ")).toContain("postmortemId");
  });

  it("reports a missing cancelledReason on cancel", () => {
    const blockers = incidentTransitionBlockers(declared(), {
      to: "cancelled",
      at: T1,
      actorUserId: "u0",
    });
    expect(blockers.join(" ")).toContain("cancelledReason");
  });

  it("prefixes each blocker with the failing field path", () => {
    const blockers = incidentTransitionBlockers(declared(), {
      to: "cancelled",
      at: T1,
      actorUserId: "u0",
    });
    expect(blockers.every((b) => b.includes(": "))).toBe(true);
  });
});

describe("transitionIncident", () => {
  it("throws IllegalIncidentTransitionError for a move the machine forbids", () => {
    expect(() =>
      transitionIncident(declared(), { to: "closed", at: T1, actorUserId: "u0" }),
    ).toThrow(IllegalIncidentTransitionError);
  });

  it("throws IncidentTransitionBlockedError carrying the blockers", () => {
    try {
      transitionIncident(declared(), { to: "triaged", at: T1, actorUserId: "u0" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IncidentTransitionBlockedError);
      const blocked = err as IncidentTransitionBlockedError;
      expect(blocked.from).toBe("declared");
      expect(blocked.to).toBe("triaged");
      expect(blocked.blockers.length).toBeGreaterThan(0);
    }
  });

  it("reports the same blockers it refused on", () => {
    const blockers = incidentTransitionBlockers(declared(), {
      to: "triaged",
      at: T1,
      actorUserId: "u0",
    });
    try {
      transitionIncident(declared(), { to: "triaged", at: T1, actorUserId: "u0" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as IncidentTransitionBlockedError).blockers).toEqual(blockers);
    }
  });

  it("walks a full sev3 lifecycle to closed", () => {
    const closed = transitionIncident(resolvedSev3(), {
      to: "closed",
      at: T3,
      actorUserId: "u0",
      rootCause: "bad deploy",
    });
    expect(closed.status).toBe("closed");
    expect(closed.timeline).toHaveLength(5);
  });

  it("accepts a customerImpactSummary supplied on the way through", () => {
    const resolved = transitionIncident(
      transitionIncident(triaged(), { to: "mitigating", at: T2, actorUserId: "u0" }),
      {
        to: "resolved",
        at: T3,
        actorUserId: "u0",
        customerImpactSummary: "4 minutes of 502s",
      },
    );
    expect(resolved.customerImpactSummary).toBe("4 minutes of 502s");
  });
});

describe("isIncidentOpen", () => {
  it("counts declared through postmortem_pending as open", () => {
    expect(isIncidentOpen(declared())).toBe(true);
    expect(isIncidentOpen(resolvedSev3())).toBe(true);
  });

  it("counts closed and cancelled as not open", () => {
    const closed = transitionIncident(resolvedSev3(), {
      to: "closed",
      at: T3,
      actorUserId: "u0",
      rootCause: "x",
    });
    expect(isIncidentOpen(closed)).toBe(false);
    const cancelled = transitionIncident(declared(), {
      to: "cancelled",
      at: T1,
      actorUserId: "u0",
      cancelledReason: "x",
    });
    expect(isIncidentOpen(cancelled)).toBe(false);
  });
});

describe("cancelIfUntriaged", () => {
  it("cancels an incident nobody has taken", () => {
    const cancelled = cancelIfUntriaged(declared(), {
      at: T1,
      actorUserId: "operate-server",
      reason: "signal recovered before triage",
    });
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cancelledReason).toBe("signal recovered before triage");
  });

  it("cancels a sev1 without any roles assigned", () => {
    // The point of cancelling rather than resolving: `triaged` needs five roles at sev1, so no
    // automated recovery could reach a resolved state.
    const cancelled = cancelIfUntriaged(declared("sev1"), {
      at: T1,
      actorUserId: "operate-server",
      reason: "recovered",
    });
    expect(cancelled?.status).toBe("cancelled");
  });

  it("marks the entry as auto-cancelled", () => {
    const cancelled = cancelIfUntriaged(declared(), {
      at: T1,
      actorUserId: "operate-server",
      reason: "recovered",
    });
    const last = cancelled?.timeline[cancelled.timeline.length - 1];
    expect(last?.metadata).toMatchObject({ autoCancelled: true });
  });

  it("returns null once a human has triaged it", () => {
    expect(
      cancelIfUntriaged(triaged(), { at: T2, actorUserId: "operate-server", reason: "r" }),
    ).toBeNull();
  });

  it("returns null for an already-cancelled incident", () => {
    const cancelled = transitionIncident(declared(), {
      to: "cancelled",
      at: T1,
      actorUserId: "u0",
      cancelledReason: "x",
    });
    expect(
      cancelIfUntriaged(cancelled, { at: T2, actorUserId: "operate-server", reason: "r" }),
    ).toBeNull();
  });

  it("merges caller metadata with the auto-cancelled marker", () => {
    const cancelled = cancelIfUntriaged(declared(), {
      at: T1,
      actorUserId: "operate-server",
      reason: "recovered",
      metadata: { sloId: "slo-1" },
    });
    expect(cancelled?.timeline[1]?.metadata).toEqual({ sloId: "slo-1", autoCancelled: true });
  });
});
