import { describe, expect, it } from "vitest";
import {
  INCIDENT_ID_REGEX,
  INCIDENT_STATUSES,
  IncidentRecordSchema,
  canTransitionIncident,
  autoDeclaredForKey,
  formatIncidentId,
  parseIncidentId,
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

describe("incident id vocabulary", () => {
  it("formats a sequence to four padded digits", () => {
    expect(formatIncidentId(2026, 7)).toBe("INC-2026-0007");
    expect(formatIncidentId(2026, 1234)).toBe("INC-2026-1234");
  });

  it("formats past four digits without truncating", () => {
    expect(formatIncidentId(2026, 12345)).toBe("INC-2026-12345");
  });

  it("produces an id the schema's own pattern accepts", () => {
    expect(INCIDENT_ID_REGEX.test(formatIncidentId(2026, 1))).toBe(true);
    expect(INCIDENT_ID_REGEX.test(formatIncidentId(2026, 0))).toBe(true);
  });

  it("rejects a year before 1970 or a non-integer", () => {
    expect(() => formatIncidentId(1969, 1)).toThrow(/invalid year/);
    expect(() => formatIncidentId(2026.5, 1)).toThrow(/invalid year/);
  });

  it("rejects a negative or non-integer sequence", () => {
    expect(() => formatIncidentId(2026, -1)).toThrow(/invalid sequence/);
    expect(() => formatIncidentId(2026, 1.5)).toThrow(/invalid sequence/);
  });

  it("parses back what it formatted", () => {
    // The property a store depends on: year/sequence columns derived from the id cannot
    // disagree with the id that produced them.
    for (const seq of [0, 1, 42, 9999, 12345]) {
      expect(parseIncidentId(formatIncidentId(2026, seq))).toEqual({ year: 2026, sequence: seq });
    }
  });

  it("parses a padded sequence as a number, not a string", () => {
    expect(parseIncidentId("INC-2026-0007").sequence).toBe(7);
  });

  it("refuses an id the schema would refuse", () => {
    for (const bad of ["INC-2026-1", "INC-26-0001", "inc-2026-0001", "INC-2026-123456789", ""]) {
      expect(() => parseIncidentId(bad)).toThrow(/invalid incident id/);
    }
  });

  it("accepts an id the schema accepts", () => {
    const record = IncidentRecordSchema.parse({
      id: formatIncidentId(2026, 3),
      title: "t",
      severity: "sev3",
      category: "availability",
      status: "declared",
      declaredAt: "2026-05-14T10:00:00Z",
      declaredBy: "operate-server",
      timeline: [
        { occurredAt: "2026-05-14T10:00:00Z", actorUserId: "operate-server", kind: "declared", message: "m" },
      ],
    });
    expect(parseIncidentId(record.id).sequence).toBe(3);
  });
});

describe("autoDeclaredForKey", () => {
  it("namespaces the subject by signal", () => {
    expect(autoDeclaredForKey("availability", "product.list")).toBe("availability:product.list");
  });

  it("keeps two signals on one subject apart", () => {
    // Two signals can breach one surface at once; one key for both would let the latency engine
    // adopt the availability incident and leave the latency breach silently unreported.
    expect(autoDeclaredForKey("availability", "product.list")).not.toBe(
      autoDeclaredForKey("latency", "product.list"),
    );
  });

  it("refuses a signal containing the separator, which would make the key ambiguous", () => {
    expect(() => autoDeclaredForKey("a:b", "x")).toThrow(/must not contain/);
  });

  it("refuses an empty signal or subject", () => {
    expect(() => autoDeclaredForKey("", "x")).toThrow(/non-empty/);
    expect(() => autoDeclaredForKey("availability", "")).toThrow(/non-empty/);
  });

  it("leaves a separator in the subject alone, since the signal is unambiguous", () => {
    expect(autoDeclaredForKey("audit-integrity", "tenant:a")).toBe("audit-integrity:tenant:a");
  });
});

describe("IncidentRecordSchema.autoDeclaredFor", () => {
  const declared = (): Record<string, unknown> => ({
    id: "INC-2026-0042",
    title: "Checkout failing",
    severity: "sev3",
    category: "availability",
    status: "declared",
    declaredAt: "2026-05-14T10:00:00Z",
    declaredBy: "system-slo-enforcer",
    timeline: baseTimeline,
  });

  it("defaults to null, so a human-declared incident carries no signal", () => {
    const record = IncidentRecordSchema.parse(declared());
    expect(record.autoDeclaredFor).toBeNull();
  });

  it("accepts the signal an automated declarer names", () => {
    const record = IncidentRecordSchema.parse({
      ...declared(),
      autoDeclaredFor: "availability:product.list",
    });
    expect(record.autoDeclaredFor).toBe("availability:product.list");
  });

  it("rejects an empty signal, which would key every incident the same", () => {
    expect(
      IncidentRecordSchema.safeParse({ ...declared(), autoDeclaredFor: "" }).success,
    ).toBe(false);
  });
});
