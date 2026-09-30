import { describe, expect, it } from "vitest";
import {
  IncidentRecordSchema,
  activeAssignmentFor,
  handoffChainFor,
  type IncidentRecord,
  type IncidentRole,
} from "@crossengin/incident-response";

import { FixedClock } from "./clock.js";
import {
  IncidentExecutor,
  NOTE_KINDS,
  RoleNotAssignedError,
  type DeclareIncidentInput,
} from "./executor.js";
import { IncidentTransitionBlockedError } from "./transitions.js";

const T0 = "2026-09-30T10:00:00.000Z";
const T1 = "2026-09-30T10:05:00.000Z";
const T2 = "2026-09-30T10:30:00.000Z";

function executor(at = T0): IncidentExecutor {
  return new IncidentExecutor({ clock: new FixedClock(new Date(at)) });
}

const BASE: DeclareIncidentInput = {
  id: "INC-2026-0001",
  title: "Checkout latency",
  severity: "sev3",
  category: "availability",
  declaredBy: "operate-server",
  detail: "burn rate 14.4x over 1h",
};

const SEV3_ROLES: readonly IncidentRole[] = ["incident_commander", "scribe", "comms_lead"];

function withRoles(
  exec: IncidentExecutor,
  record: IncidentRecord,
  list: readonly IncidentRole[] = SEV3_ROLES,
): IncidentRecord {
  return list.reduce(
    (acc, role, i) =>
      exec.assignRole(acc, { role, userId: `u${i}`, actorUserId: "u0", at: T1 }),
    record,
  );
}

describe("NOTE_KINDS", () => {
  it("covers the free-form timeline kinds only", () => {
    expect([...NOTE_KINDS]).toEqual([
      "observation",
      "action_taken",
      "comms_sent",
      "runbook_invoked",
    ]);
  });
});

describe("declare", () => {
  it("produces a declared incident with one timeline entry", () => {
    const record = executor().declare(BASE);
    expect(record.status).toBe("declared");
    expect(record.timeline).toHaveLength(1);
    expect(record.timeline[0]?.kind).toBe("declared");
  });

  it("uses the injected clock when declaredAt is omitted", () => {
    expect(executor().declare(BASE).declaredAt).toBe(T0);
  });

  it("prefers an explicit declaredAt", () => {
    expect(executor().declare({ ...BASE, declaredAt: T2 }).declaredAt).toBe(T2);
  });

  it("puts the detail in the declaration entry's message", () => {
    expect(executor().declare(BASE).timeline[0]?.message).toBe("burn rate 14.4x over 1h");
  });

  it("attributes the declaration entry to declaredBy", () => {
    expect(executor().declare(BASE).timeline[0]?.actorUserId).toBe("operate-server");
  });

  it("defaults the optional collections to empty", () => {
    const record = executor().declare(BASE);
    expect(record.affectedTenantIds).toEqual([]);
    expect(record.affectedRegions).toEqual([]);
    expect(record.breachDataClasses).toEqual([]);
    expect(record.roleAssignments).toEqual([]);
  });

  it("carries affected tenants and regions", () => {
    const record = executor().declare({
      ...BASE,
      affectedTenantIds: ["t1", "t2"],
      affectedRegions: ["eu"],
    });
    expect(record.affectedTenantIds).toEqual(["t1", "t2"]);
    expect(record.affectedRegions).toEqual(["eu"]);
  });

  it("carries declaration metadata onto the entry", () => {
    const record = executor().declare({ ...BASE, metadata: { surface: "checkout" } });
    expect(record.timeline[0]?.metadata).toEqual({ surface: "checkout" });
  });

  it("rejects a security incident whose category is not security", () => {
    expect(() => executor().declare({ ...BASE, securityIncident: true })).toThrow();
  });

  it("accepts a security incident in the security category", () => {
    const record = executor().declare({
      ...BASE,
      category: "security",
      securityIncident: true,
      breachDataClasses: ["phi"],
    });
    expect(record.breachDataClasses).toEqual(["phi"]);
  });

  it("rejects a malformed incident id", () => {
    expect(() => executor().declare({ ...BASE, id: "INC-1" })).toThrow();
  });

  it("rejects a duplicated affected tenant", () => {
    expect(() =>
      executor().declare({ ...BASE, affectedTenantIds: ["t1", "t1"] }),
    ).toThrow();
  });
});

describe("assignRole", () => {
  it("appends an active assignment and a role_assigned entry", () => {
    const exec = executor();
    const record = exec.assignRole(exec.declare(BASE), {
      role: "incident_commander",
      userId: "alice",
      actorUserId: "alice",
      at: T1,
    });
    expect(record.roleAssignments).toHaveLength(1);
    expect(activeAssignmentFor(record.roleAssignments, "incident_commander")?.userId).toBe(
      "alice",
    );
    expect(record.timeline[1]?.kind).toBe("role_assigned");
  });

  it("records the role and user in the entry metadata", () => {
    const exec = executor();
    const record = exec.assignRole(exec.declare(BASE), {
      role: "scribe",
      userId: "bob",
      actorUserId: "alice",
      at: T1,
    });
    expect(record.timeline[1]?.metadata).toEqual({ role: "scribe", userId: "bob" });
  });

  it("refuses a second active holder for the same role", () => {
    const exec = executor();
    const one = exec.assignRole(exec.declare(BASE), {
      role: "scribe",
      userId: "bob",
      actorUserId: "alice",
      at: T1,
    });
    expect(() =>
      exec.assignRole(one, { role: "scribe", userId: "carol", actorUserId: "alice", at: T2 }),
    ).toThrow();
  });

  it("uses the injected clock when at is omitted", () => {
    const exec = executor(T2);
    const record = exec.assignRole(exec.declare({ ...BASE, declaredAt: T0 }), {
      role: "scribe",
      userId: "bob",
      actorUserId: "alice",
    });
    expect(record.roleAssignments[0]?.assignedAt).toBe(T2);
  });

  it("assembles the roles a sev3 triage requires", () => {
    const exec = executor();
    const record = withRoles(exec, exec.declare(BASE));
    expect(record.roleAssignments).toHaveLength(3);
    expect(() => exec.transition(record, { to: "triaged", at: T2, actorUserId: "u0" })).not.toThrow();
  });
});

describe("handOffRole", () => {
  it("closes the old assignment and opens a new one in one step", () => {
    const exec = executor();
    const assigned = exec.assignRole(exec.declare(BASE), {
      role: "incident_commander",
      userId: "alice",
      actorUserId: "alice",
      at: T1,
    });
    const handed = exec.handOffRole(assigned, {
      role: "incident_commander",
      toUserId: "bob",
      reason: "end of shift",
      actorUserId: "alice",
      at: T2,
    });
    expect(handed.roleAssignments).toHaveLength(2);
    expect(activeAssignmentFor(handed.roleAssignments, "incident_commander")?.userId).toBe("bob");
    expect(handoffChainFor(handed.roleAssignments, "incident_commander")).toHaveLength(2);
  });

  it("keeps a triaged incident valid across the handoff", () => {
    const exec = executor();
    const triaged = exec.transition(withRoles(exec, exec.declare(BASE)), {
      to: "triaged",
      at: T2,
      actorUserId: "u0",
    });
    expect(() =>
      exec.handOffRole(triaged, {
        role: "incident_commander",
        toUserId: "dave",
        reason: "escalation",
        actorUserId: "u0",
        at: "2026-09-30T11:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("records the reason on the closed assignment", () => {
    const exec = executor();
    const assigned = exec.assignRole(exec.declare(BASE), {
      role: "scribe",
      userId: "alice",
      actorUserId: "alice",
      at: T1,
    });
    const handed = exec.handOffRole(assigned, {
      role: "scribe",
      toUserId: "bob",
      reason: "end of shift",
      actorUserId: "alice",
      at: T2,
    });
    expect(handed.roleAssignments[0]?.handedOffReason).toBe("end of shift");
    expect(handed.roleAssignments[0]?.handedOffToUserId).toBe("bob");
  });

  it("appends a role_handed_off entry naming both users", () => {
    const exec = executor();
    const assigned = exec.assignRole(exec.declare(BASE), {
      role: "scribe",
      userId: "alice",
      actorUserId: "alice",
      at: T1,
    });
    const handed = exec.handOffRole(assigned, {
      role: "scribe",
      toUserId: "bob",
      reason: "shift",
      actorUserId: "alice",
      at: T2,
    });
    const last = handed.timeline[handed.timeline.length - 1];
    expect(last?.kind).toBe("role_handed_off");
    expect(last?.metadata).toEqual({ role: "scribe", fromUserId: "alice", toUserId: "bob" });
  });

  it("throws RoleNotAssignedError when nobody holds the role", () => {
    const exec = executor();
    expect(() =>
      exec.handOffRole(exec.declare(BASE), {
        role: "scribe",
        toUserId: "bob",
        reason: "shift",
        actorUserId: "alice",
        at: T1,
      }),
    ).toThrow(RoleNotAssignedError);
  });

  it("refuses a handoff to the current holder", () => {
    const exec = executor();
    const assigned = exec.assignRole(exec.declare(BASE), {
      role: "scribe",
      userId: "alice",
      actorUserId: "alice",
      at: T1,
    });
    expect(() =>
      exec.handOffRole(assigned, {
        role: "scribe",
        toUserId: "alice",
        reason: "shift",
        actorUserId: "alice",
        at: T2,
      }),
    ).toThrow();
  });
});

describe("changeSeverity", () => {
  it("records the change with both severities", () => {
    const exec = executor();
    const record = exec.changeSeverity(exec.declare(BASE), {
      severity: "sev4",
      reason: "narrower than thought",
      actorUserId: "alice",
      at: T1,
    });
    expect(record.severity).toBe("sev4");
    expect(record.timeline[1]?.kind).toBe("severity_changed");
    expect(record.timeline[1]?.metadata).toEqual({
      from: "sev3",
      to: "sev4",
      reason: "narrower than thought",
    });
  });

  it("refuses an upgrade that the new severity's rules would not sustain", () => {
    const exec = executor();
    const triaged = exec.transition(withRoles(exec, exec.declare(BASE)), {
      to: "triaged",
      at: T2,
      actorUserId: "u0",
    });
    // sev1 demands five roles and a status page; the record has three roles and none.
    expect(() =>
      exec.changeSeverity(triaged, {
        severity: "sev1",
        reason: "wider blast radius",
        actorUserId: "u0",
        at: T2,
      }),
    ).toThrow();
  });

  it("allows an upgrade once the new severity's requirements are met", () => {
    const exec = executor();
    const full = withRoles(exec, exec.declare(BASE), [
      "incident_commander",
      "scribe",
      "comms_lead",
      "technical_lead",
      "executive_sponsor",
    ]);
    const triaged = exec.transition(full, { to: "triaged", at: T2, actorUserId: "u0" });
    const upgraded = exec.changeSeverity(triaged, {
      severity: "sev1",
      reason: "wider blast radius",
      actorUserId: "u0",
      at: T2,
      publiclyVisible: true,
    });
    expect(upgraded.severity).toBe("sev1");
    expect(upgraded.publiclyVisible).toBe(true);
  });

  it("allows a downgrade of an untriaged incident", () => {
    const exec = executor();
    const record = exec.changeSeverity(exec.declare({ ...BASE, severity: "sev1" }), {
      severity: "sev3",
      reason: "single tenant only",
      actorUserId: "u0",
      at: T1,
    });
    expect(record.severity).toBe("sev3");
  });
});

describe("note", () => {
  it("appends an entry of the requested kind without changing state", () => {
    const exec = executor();
    const declared = exec.declare(BASE);
    const noted = exec.note(declared, {
      kind: "observation",
      message: "error rate falling",
      actorUserId: "alice",
      at: T1,
    });
    expect(noted.status).toBe("declared");
    expect(noted.timeline).toHaveLength(2);
    expect(noted.timeline[1]?.kind).toBe("observation");
  });

  it("accepts every note kind", () => {
    const exec = executor();
    let record = exec.declare(BASE);
    for (const kind of NOTE_KINDS) {
      record = exec.note(record, { kind, message: kind, actorUserId: "alice", at: T1 });
    }
    expect(record.timeline).toHaveLength(1 + NOTE_KINDS.length);
  });

  it("carries metadata", () => {
    const exec = executor();
    const noted = exec.note(exec.declare(BASE), {
      kind: "runbook_invoked",
      message: "ran rb-1",
      actorUserId: "alice",
      at: T1,
      metadata: { runbookId: "rb-1" },
    });
    expect(noted.timeline[1]?.metadata).toEqual({ runbookId: "rb-1" });
  });
});

describe("attachPostmortem", () => {
  it("sets postmortemId and records the action", () => {
    const exec = executor();
    const record = exec.attachPostmortem(exec.declare(BASE), {
      postmortemId: "PM-2026-0001",
      actorUserId: "alice",
      at: T1,
    });
    expect(record.postmortemId).toBe("PM-2026-0001");
    expect(record.timeline[1]?.kind).toBe("action_taken");
    expect(record.timeline[1]?.metadata).toEqual({ postmortemId: "PM-2026-0001" });
  });

  it("unblocks closing a sev2 incident", () => {
    const exec = executor();
    const base = IncidentRecordSchema.parse({
      ...exec.declare({ ...BASE, severity: "sev2" }),
      roleAssignments: [
        { role: "incident_commander", userId: "a", assignedAt: T1 },
        { role: "scribe", userId: "b", assignedAt: T1 },
        { role: "comms_lead", userId: "c", assignedAt: T1 },
      ],
      publiclyVisible: true,
      status: "resolved",
      ackedAt: T1,
      mitigatedAt: T1,
      resolvedAt: T2,
    });
    expect(() =>
      exec.transition(base, { to: "closed", at: T2, actorUserId: "a", rootCause: "x" }),
    ).toThrow(IncidentTransitionBlockedError);
    const withPm = exec.attachPostmortem(base, {
      postmortemId: "PM-2026-0001",
      actorUserId: "a",
      at: T2,
    });
    expect(
      exec.transition(withPm, { to: "closed", at: T2, actorUserId: "a", rootCause: "x" }).status,
    ).toBe("closed");
  });
});

describe("transition", () => {
  it("delegates to transitionIncident", () => {
    const exec = executor();
    const triaged = exec.transition(withRoles(exec, exec.declare(BASE)), {
      to: "triaged",
      at: T2,
      actorUserId: "u0",
    });
    expect(triaged.status).toBe("triaged");
    expect(triaged.ackedAt).toBe(T2);
  });
});
