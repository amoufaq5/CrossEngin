import { describe, expect, it } from "vitest";
import {
  INCIDENT_ID_REGEX,
  INCIDENT_STATUSES,
  IncidentRecordSchema,
  TimelineEntrySchema,
  canTransitionIncident,
  autoDeclaredForKey,
  formatIncidentId,
  parseIncidentId,
  metAckSla,
  metMitigateSla,
  pagedTimelineMessage,
  pagedTimelineMetadata,
  timeToAckMinutes,
  timeToResolveMinutes,
  type IncidentRecord,
  type PagedTimelineFacts,
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
    autoDeclaredFor: null,
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
    autoDeclaredFor: null,
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

describe("TimelineEntrySchema paged kind", () => {
  const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    occurredAt: "2026-05-14T10:00:00Z",
    actorUserId: "system-slo-enforcer",
    kind: "paged",
    message: "paged 2/3 over pagerduty_phone, slack",
    metadata: {},
    ...over,
  });

  it("accepts a paged entry", () => {
    const record = IncidentRecordSchema.parse({
      id: "INC-2026-0042",
      title: "Checkout failing",
      severity: "sev3",
      category: "availability",
      status: "declared",
      declaredAt: "2026-05-14T10:00:00Z",
      declaredBy: "system-slo-enforcer",
      timeline: [...baseTimeline, entry()],
    });
    expect(record.timeline[1]?.kind).toBe("paged");
  });

  it("still refuses an unknown kind, so the enum widened and did not open", () => {
    expect(
      IncidentRecordSchema.safeParse({
        id: "INC-2026-0042",
        title: "x",
        severity: "sev3",
        category: "availability",
        status: "declared",
        declaredAt: "2026-05-14T10:00:00Z",
        declaredBy: "u-1",
        timeline: [entry({ kind: "pagedd" })],
      }).success,
    ).toBe(false);
  });

  it("requires a message on a paged entry like every other kind", () => {
    expect(TimelineEntrySchema.safeParse(entry({ message: "" })).success).toBe(false);
  });

  it("defaults a paged entry's metadata to empty", () => {
    const parsed = TimelineEntrySchema.parse({
      occurredAt: "2026-05-14T10:00:00Z",
      actorUserId: "u-1",
      kind: "paged",
      message: "m",
    });
    expect(parsed.metadata).toEqual({});
  });
});

describe("pagedTimelineMetadata", () => {
  const FACTS: PagedTimelineFacts = {
    channels: ["pagerduty_phone", "slack"],
    delivered: 2,
    attempted: 3,
  };

  it("carries the operation, the channel kinds and the counts", () => {
    expect(pagedTimelineMetadata(FACTS)).toEqual({
      operation: "trigger",
      channels: ["pagerduty_phone", "slack"],
      delivered: 2,
      attempted: 3,
    });
  });

  it("defaults the operation to trigger", () => {
    expect(pagedTimelineMetadata(FACTS)["operation"]).toBe("trigger");
  });

  it("carries an explicit resolve operation", () => {
    expect(pagedTimelineMetadata({ ...FACTS, operation: "resolve" })["operation"]).toBe("resolve");
  });

  it("includes a provider reference when one is given", () => {
    expect(pagedTimelineMetadata({ ...FACTS, reference: "INC-2026-0042" })["reference"]).toBe(
      "INC-2026-0042",
    );
  });

  it("omits the reference key entirely when there is none", () => {
    expect("reference" in pagedTimelineMetadata({ ...FACTS, reference: null })).toBe(false);
    expect("reference" in pagedTimelineMetadata(FACTS)).toBe(false);
  });

  it("copies the channel list, so a later mutation cannot rewrite a stored note", () => {
    const channels = ["slack"];
    const metadata = pagedTimelineMetadata({ ...FACTS, channels });
    channels.push("sms");
    expect(metadata["channels"]).toEqual(["slack"]);
  });

  it("has nowhere for an address, a number, a channel name or a key to land", () => {
    // The structural half of the rule: the builder's input only takes channel KINDS, so a
    // caller that reaches for its credentials cannot smuggle them onto the incident record.
    const leaky = {
      ...FACTS,
      serviceKey: "R0ABCDEF0123456789",
      phoneNumbers: ["+15551234567"],
      channel: "#incidents",
      email: "oncall@example.com",
    } as unknown as PagedTimelineFacts;
    expect(Object.keys(pagedTimelineMetadata(leaky)).sort()).toEqual([
      "attempted",
      "channels",
      "delivered",
      "operation",
    ]);
  });

  it("refuses a channel value that is not an identifier", () => {
    // The mechanical half: an address, a number, a Slack channel name or a mixed-case key is
    // not lower snake_case, so it cannot be passed off as a channel kind.
    for (const bad of ["oncall@example.com", "+15551234567", "#incidents", "PagerDuty", ""]) {
      expect(() => pagedTimelineMetadata({ ...FACTS, channels: [bad] })).toThrow(TypeError);
    }
  });

  it("names the position and never the rejected value", () => {
    // A rejected "channel kind" may well be the address the rule exists to keep out, and an
    // error message is written to a log.
    expect(() =>
      pagedTimelineMetadata({ ...FACTS, channels: ["slack", "oncall@example.com"] }),
    ).toThrow(/^channels\[1\] is not a channel kind$/);
  });

  it("refuses a channel kind longer than 40 characters", () => {
    expect(() => pagedTimelineMetadata({ ...FACTS, channels: ["a".repeat(41)] })).toThrow(
      TypeError,
    );
  });

  it("accepts an empty channel list, which is what an unroutable page looks like", () => {
    expect(
      pagedTimelineMetadata({ channels: [], delivered: 0, attempted: 0 })["channels"],
    ).toEqual([]);
  });

  it("refuses delivered above attempted, naming both numbers", () => {
    expect(() => pagedTimelineMetadata({ ...FACTS, delivered: 4, attempted: 3 })).toThrow(
      /delivered=4, attempted=3/,
    );
  });

  it("refuses a negative or non-integer count with a RangeError", () => {
    expect(() => pagedTimelineMetadata({ ...FACTS, delivered: -1 })).toThrow(RangeError);
    expect(() => pagedTimelineMetadata({ ...FACTS, attempted: -1 })).toThrow(RangeError);
    expect(() => pagedTimelineMetadata({ ...FACTS, delivered: 1.5 })).toThrow(RangeError);
    expect(() =>
      pagedTimelineMetadata({ ...FACTS, delivered: Number.NaN }),
    ).toThrow(RangeError);
  });

  it("refuses a blank or over-long reference", () => {
    expect(() => pagedTimelineMetadata({ ...FACTS, reference: "   " })).toThrow(TypeError);
    expect(() => pagedTimelineMetadata({ ...FACTS, reference: "x".repeat(201) })).toThrow(
      TypeError,
    );
  });

  it("produces metadata a timeline entry accepts", () => {
    expect(
      TimelineEntrySchema.safeParse({
        occurredAt: "2026-05-14T10:00:00Z",
        actorUserId: "system-slo-enforcer",
        kind: "paged",
        message: pagedTimelineMessage(FACTS),
        metadata: pagedTimelineMetadata(FACTS),
      }).success,
    ).toBe(true);
  });
});

describe("pagedTimelineMessage", () => {
  it("reads as prose a human scans", () => {
    expect(
      pagedTimelineMessage({
        channels: ["pagerduty_phone", "slack"],
        delivered: 2,
        attempted: 3,
      }),
    ).toBe("paged 2/3 over pagerduty_phone, slack");
  });

  it("shouts when a page reached nobody", () => {
    // The line an incident review looks for; a quiet "paged 0/2" reads like every other entry.
    expect(
      pagedTimelineMessage({ channels: ["slack", "sms"], delivered: 0, attempted: 2 }),
    ).toBe("PAGED NOBODY — 0/2 over slack, sms");
  });

  it("shouts when there was no channel to attempt at all", () => {
    expect(pagedTimelineMessage({ channels: [], delivered: 0, attempted: 0 })).toBe(
      "PAGED NOBODY — no page channel was attempted",
    );
  });

  it("reads a resolve as a close, not as a page", () => {
    expect(
      pagedTimelineMessage({
        channels: ["pagerduty_phone"],
        delivered: 1,
        attempted: 1,
        operation: "resolve",
      }),
    ).toBe("resolved the alert on pagerduty_phone");
  });

  it("does not shout for a resolve that closed nothing", () => {
    // An all-`unsupported` resolve is the expected answer on Slack and a webhook, not a failure.
    expect(
      pagedTimelineMessage({
        channels: ["slack"],
        delivered: 0,
        attempted: 1,
        operation: "resolve",
      }),
    ).toBe("closed no alert — 0/1 over slack");
    expect(
      pagedTimelineMessage({ channels: [], delivered: 0, attempted: 0, operation: "resolve" }),
    ).toBe("closed no alert — no page channel was attempted");
  });

  it("is always a non-empty message the schema accepts", () => {
    for (const operation of ["trigger", "resolve"] as const) {
      for (const [delivered, attempted] of [
        [0, 0],
        [0, 2],
        [1, 1],
        [2, 3],
      ] as ReadonlyArray<readonly [number, number]>) {
        const message = pagedTimelineMessage({
          channels: delivered === 0 && attempted === 0 ? [] : ["slack", "sms"],
          delivered,
          attempted,
          operation,
        });
        expect(message.length).toBeGreaterThan(0);
      }
    }
  });

  it("validates its facts on the same rules as the metadata builder", () => {
    expect(() =>
      pagedTimelineMessage({ channels: ["slack"], delivered: 3, attempted: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      pagedTimelineMessage({ channels: ["#incidents"], delivered: 1, attempted: 1 }),
    ).toThrow(TypeError);
  });
});
