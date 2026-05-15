import { describe, expect, it } from "vitest";
import {
  INCIDENT_ROLES,
  REQUIRED_ROLES,
  RoleAssignmentSchema,
  RoleAssignmentSetSchema,
  SEV1_REQUIRED_ROLES,
  activeAssignmentFor,
  handoffChainFor,
  rolesMissingRequired,
  type RoleAssignment,
} from "./roles.js";

describe("constants", () => {
  it("INCIDENT_ROLES has 7 entries", () => {
    expect(INCIDENT_ROLES).toContain("incident_commander");
    expect(INCIDENT_ROLES).toContain("executive_sponsor");
    expect(INCIDENT_ROLES).toContain("customer_liaison");
  });

  it("REQUIRED_ROLES = IC + scribe + comms_lead", () => {
    expect(REQUIRED_ROLES).toEqual(["incident_commander", "scribe", "comms_lead"]);
  });

  it("SEV1_REQUIRED_ROLES extends with technical_lead + executive_sponsor", () => {
    expect(SEV1_REQUIRED_ROLES).toContain("technical_lead");
    expect(SEV1_REQUIRED_ROLES).toContain("executive_sponsor");
  });
});

describe("RoleAssignmentSchema", () => {
  const base: RoleAssignment = {
    role: "incident_commander",
    userId: "u-1",
    assignedAt: "2026-05-14T10:00:00Z",
    handedOffAt: null,
    handedOffToUserId: null,
    handedOffReason: undefined,
  };

  it("accepts a valid assignment", () => {
    expect(() => RoleAssignmentSchema.parse(base)).not.toThrow();
  });

  it("rejects handoff without recipient", () => {
    expect(() =>
      RoleAssignmentSchema.parse({
        ...base,
        handedOffAt: "2026-05-14T11:00:00Z",
        handedOffReason: "shift change",
      }),
    ).toThrow(/handedOffToUserId/);
  });

  it("rejects handoff without reason", () => {
    expect(() =>
      RoleAssignmentSchema.parse({
        ...base,
        handedOffAt: "2026-05-14T11:00:00Z",
        handedOffToUserId: "u-2",
      }),
    ).toThrow(/handedOffReason/);
  });

  it("rejects self-handoff", () => {
    expect(() =>
      RoleAssignmentSchema.parse({
        ...base,
        handedOffAt: "2026-05-14T11:00:00Z",
        handedOffToUserId: "u-1",
        handedOffReason: "x",
      }),
    ).toThrow(/cannot hand off to yourself/);
  });

  it("rejects handoff time before assignment", () => {
    expect(() =>
      RoleAssignmentSchema.parse({
        ...base,
        handedOffAt: "2026-05-14T09:00:00Z",
        handedOffToUserId: "u-2",
        handedOffReason: "x",
      }),
    ).toThrow(/after assignedAt/);
  });
});

describe("RoleAssignmentSetSchema", () => {
  it("rejects two active assignments for the same role", () => {
    expect(() =>
      RoleAssignmentSetSchema.parse([
        {
          role: "incident_commander",
          userId: "u-1",
          assignedAt: "2026-05-14T10:00:00Z",
          handedOffAt: null,
          handedOffToUserId: null,
        },
        {
          role: "incident_commander",
          userId: "u-2",
          assignedAt: "2026-05-14T10:30:00Z",
          handedOffAt: null,
          handedOffToUserId: null,
        },
      ]),
    ).toThrow(/more than one active assignment/);
  });

  it("accepts handoff chain (one active, prior handed off)", () => {
    expect(() =>
      RoleAssignmentSetSchema.parse([
        {
          role: "incident_commander",
          userId: "u-1",
          assignedAt: "2026-05-14T10:00:00Z",
          handedOffAt: "2026-05-14T11:00:00Z",
          handedOffToUserId: "u-2",
          handedOffReason: "shift change",
        },
        {
          role: "incident_commander",
          userId: "u-2",
          assignedAt: "2026-05-14T11:00:00Z",
          handedOffAt: null,
          handedOffToUserId: null,
        },
      ]),
    ).not.toThrow();
  });
});

describe("helpers", () => {
  const a: RoleAssignment = {
    role: "incident_commander",
    userId: "u-1",
    assignedAt: "2026-05-14T10:00:00Z",
    handedOffAt: "2026-05-14T11:00:00Z",
    handedOffToUserId: "u-2",
    handedOffReason: "x",
  };
  const b: RoleAssignment = {
    role: "incident_commander",
    userId: "u-2",
    assignedAt: "2026-05-14T11:00:00Z",
    handedOffAt: null,
    handedOffToUserId: null,
  };
  const c: RoleAssignment = {
    role: "scribe",
    userId: "u-3",
    assignedAt: "2026-05-14T10:05:00Z",
    handedOffAt: null,
    handedOffToUserId: null,
  };

  it("activeAssignmentFor returns the un-handed-off one", () => {
    expect(activeAssignmentFor([a, b, c], "incident_commander")?.userId).toBe("u-2");
  });

  it("rolesMissingRequired identifies absent roles", () => {
    expect(rolesMissingRequired([a, b], REQUIRED_ROLES)).toContain("scribe");
    expect(rolesMissingRequired([a, b], REQUIRED_ROLES)).toContain("comms_lead");
  });

  it("handoffChainFor sorts by assignedAt", () => {
    expect(handoffChainFor([b, a], "incident_commander").map((x) => x.userId)).toEqual([
      "u-1",
      "u-2",
    ]);
  });
});
