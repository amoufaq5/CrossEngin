import { describe, expect, it } from "vitest";
import {
  INCIDENT_STATUSES,
  IncidentRecordSchema,
  canTransitionIncident,
  metAckSla,
  metMitigateSla,
  timeToAckMinutes,
  timeToResolveMinutes,
  type IncidentRecord,
} from "./incidents.js";

const requiredRoles = [
  {
    role: "incident_commander" as const,
    userId: "u-ic",
    assignedAt: "2026-05-14T10:00:00Z",
    handedOffAt: null,
    handedOffToUserId: null,
  },
  {
    role: "scribe" as const,
    userId: "u-sc",
    assignedAt: "2026-05-14T10:00:00Z",
    handedOffAt: null,
    handedOffToUserId: null,
  },
  {
    role: "comms_lead" as const,
    userId: "u-co",
    assignedAt: "2026-05-14T10:00:00Z",
    handedOffAt: null,
    handedOffToUserId: null,
  },
];

const baseTimeline = [
  {
    occurredAt: "2026-05-14T10:00:00Z",
    actorUserId: "u-ic",
    kind: "declared" as const,
    message: "Incident declared",
    metadata: {},
  },
];

describe("constants", () => {
  it("INCIDENT_STATUSES has 8 entries", () => {
    expect(INCIDENT_STATUSES).toContain("declared");
    expect(INCIDENT_STATUSES).toContain("postmortem_pending");
    expect(INCIDENT_STATUSES).toContain("cancelled");
  });
});

describe("canTransitionIncident", () => {
  it("declared -> triaged", () => {
    expect(canTransitionIncident("declared", "triaged")).toBe(true);
  });

  it("mitigating -> resolved", () => {
    expect(canTransitionIncident("mitigating", "resolved")).toBe(true);
  });

  it("closed is terminal", () => {
    expect(canTransitionIncident("closed", "declared")).toBe(false);
  });

  it("declared -> resolved is not allowed (must go through triaged/mitigating)", () => {
    expect(canTransitionIncident("declared", "resolved")).toBe(false);
  });
});

describe("IncidentRecordSchema", () => {
  const base: IncidentRecord = {
    id: "INC-2026-0042",
    title: "API latency spike",
    severity: "sev2",
    category: "performance",
    status: "mitigating",
    affectedTenantIds: ["t-1"],
    affectedRegions: ["eu-central"],
    publiclyVisible: true,
    declaredAt: "2026-05-14T10:00:00Z",
    declaredBy: "u-1",
    ackedAt: "2026-05-14T10:05:00Z",
    mitigatedAt: null,
    resolvedAt: null,
    closedAt: null,
    cancelledAt: null,
    roleAssignments: requiredRoles,
    timeline: baseTimeline,
    runbookExecutionIds: [],
    relatedDeploymentIds: [],
    securityIncident: false,
    breachDataClasses: [],
    postmortemId: null,
  };

  it("accepts a valid mitigating incident", () => {
    expect(() => IncidentRecordSchema.parse(base)).not.toThrow();
  });

  it("rejects ack/mitigate timestamps before declaration", () => {
    expect(() =>
      IncidentRecordSchema.parse({
        ...base,
        ackedAt: "2026-05-14T09:00:00Z",
      }),
    ).toThrow(/before declaredAt/);
  });

  it("rejects mitigatedAt without ackedAt", () => {
    expect(() =>
      IncidentRecordSchema.parse({
        ...base,
        ackedAt: null,
        mitigatedAt: "2026-05-14T10:30:00Z",
      }),
    ).toThrow(/requires ackedAt/);
  });

  it("rejects resolvedAt without mitigatedAt", () => {
    expect(() =>
      IncidentRecordSchema.parse({
        ...base,
        resolvedAt: "2026-05-14T11:00:00Z",
      }),
    ).toThrow(/requires mitigatedAt/);
  });

  it("rejects active statuses without required roles", () => {
    expect(() =>
      IncidentRecordSchema.parse({
        ...base,
        roleAssignments: [requiredRoles[0]!],
      }),
    ).toThrow(/requires roles/);
  });

  it("rejects sev1 mitigating without technical_lead + executive_sponsor", () => {
    expect(() =>
      IncidentRecordSchema.parse({
        ...base,
        severity: "sev1",
        category: "availability",
      }),
    ).toThrow(/technical_lead|executive_sponsor/);
  });

  it("rejects securityIncident=true with non-security category", () => {
    expect(() =>
      IncidentRecordSchema.parse({
        ...base,
        securityIncident: true,
      }),
    ).toThrow(/category='security'/);
  });

  it("rejects breachDataClasses without securityIncident", () => {
    expect(() =>
      IncidentRecordSchema.parse({
        ...base,
        breachDataClasses: ["pii"],
      }),
    ).toThrow(/securityIncident=true/);
  });

  it("rejects closed without rootCause", () => {
    expect(() =>
      IncidentRecordSchema.parse({
        ...base,
        status: "closed",
        ackedAt: "2026-05-14T10:05:00Z",
        mitigatedAt: "2026-05-14T11:00:00Z",
        resolvedAt: "2026-05-14T11:30:00Z",
        closedAt: "2026-05-14T12:00:00Z",
      }),
    ).toThrow(/rootCause/);
  });

  it("rejects sev2 closed without postmortemId", () => {
    expect(() =>
      IncidentRecordSchema.parse({
        ...base,
        status: "closed",
        ackedAt: "2026-05-14T10:05:00Z",
        mitigatedAt: "2026-05-14T11:00:00Z",
        resolvedAt: "2026-05-14T11:30:00Z",
        closedAt: "2026-05-14T12:00:00Z",
        rootCause: "DB connection pool exhaustion",
      }),
    ).toThrow(/postmortemId/);
  });

  it("rejects malformed incident id", () => {
    expect(() =>
      IncidentRecordSchema.parse({ ...base, id: "INC-42" }),
    ).toThrow();
  });

  it("rejects duplicate affected tenant ids", () => {
    expect(() =>
      IncidentRecordSchema.parse({
        ...base,
        affectedTenantIds: ["t-1", "t-1"],
      }),
    ).toThrow(/duplicate tenant/);
  });

  it("requires publiclyVisible=true once triaged for sev1/sev2", () => {
    expect(() =>
      IncidentRecordSchema.parse({
        ...base,
        publiclyVisible: false,
      }),
    ).toThrow(/publiclyVisible=true/);
  });
});

describe("helpers", () => {
  const base: IncidentRecord = {
    id: "INC-2026-0042",
    title: "x",
    severity: "sev2",
    category: "performance",
    status: "resolved",
    affectedTenantIds: [],
    affectedRegions: [],
    publiclyVisible: true,
    declaredAt: "2026-05-14T10:00:00Z",
    declaredBy: "u-1",
    ackedAt: "2026-05-14T10:10:00Z",
    mitigatedAt: "2026-05-14T13:00:00Z",
    resolvedAt: "2026-05-14T20:00:00Z",
    closedAt: null,
    cancelledAt: null,
    roleAssignments: requiredRoles,
    timeline: baseTimeline,
    runbookExecutionIds: [],
    relatedDeploymentIds: [],
    securityIncident: false,
    breachDataClasses: [],
    postmortemId: null,
  };

  it("timeToAckMinutes computes correctly", () => {
    expect(timeToAckMinutes(base)).toBe(10);
  });

  it("timeToResolveMinutes computes correctly", () => {
    expect(timeToResolveMinutes(base)).toBe(600);
  });

  it("metAckSla within SLA for sev2 (15min)", () => {
    expect(metAckSla(base)).toBe(true);
  });

  it("metMitigateSla within SLA for sev2 (240min)", () => {
    expect(metMitigateSla(base)).toBe(true);
  });

  it("metAckSla false when over the SLA", () => {
    expect(
      metAckSla({ ...base, ackedAt: "2026-05-14T10:30:00Z" }),
    ).toBe(false);
  });
});
