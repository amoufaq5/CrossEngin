import { describe, expect, it } from "vitest";
import {
  COMM_AUDIENCES,
  COMM_KINDS,
  IncidentCommunicationSchema,
  STATUS_PAGE_LEVELS,
  bounceRate,
  isBreachNotificationTimely,
  publishedCommsFor,
  type IncidentCommunication,
} from "./comms.js";

describe("constants", () => {
  it("COMM_AUDIENCES has 7 entries", () => {
    expect(COMM_AUDIENCES).toContain("status_page_public");
    expect(COMM_AUDIENCES).toContain("regulators");
    expect(COMM_AUDIENCES).toContain("law_enforcement");
  });

  it("COMM_KINDS has 7 entries", () => {
    expect(COMM_KINDS).toContain("investigating");
    expect(COMM_KINDS).toContain("breach_notification");
  });

  it("STATUS_PAGE_LEVELS has 5 entries", () => {
    expect(STATUS_PAGE_LEVELS).toContain("operational");
    expect(STATUS_PAGE_LEVELS).toContain("major_outage");
  });
});

describe("IncidentCommunicationSchema", () => {
  const base: IncidentCommunication = {
    id: "com-1",
    incidentId: "INC-2026-0042",
    audience: "status_page_public",
    kind: "investigating",
    statusPageLevel: "partial_outage",
    title: "API latency",
    body: "We're investigating elevated latency",
    publishedAt: "2026-05-14T10:05:00Z",
    publishedBy: "u-comms",
    languages: ["en"],
    requiresLegalReview: false,
    legalReviewedBy: null,
    legalReviewedAt: null,
    requiresExecutiveApproval: false,
    executiveApprovedBy: null,
    executiveApprovedAt: null,
    deliveryChannels: ["status_page", "rss"],
    recipientCount: 0,
    bouncesCount: 0,
    supersedesId: null,
    retractedAt: null,
  };

  it("accepts a valid status page comm", () => {
    expect(() => IncidentCommunicationSchema.parse(base)).not.toThrow();
  });

  it("rejects status_page_public without statusPageLevel", () => {
    expect(() =>
      IncidentCommunicationSchema.parse({ ...base, statusPageLevel: undefined }),
    ).toThrow(/statusPageLevel/);
  });

  it("rejects statusPageLevel on non-status_page audience", () => {
    expect(() =>
      IncidentCommunicationSchema.parse({
        ...base,
        audience: "affected_tenants",
        deliveryChannels: ["email"],
      }),
    ).toThrow(/only valid for status_page_public/);
  });

  it("rejects breach_notification with wrong audience", () => {
    expect(() =>
      IncidentCommunicationSchema.parse({
        ...base,
        kind: "breach_notification",
        statusPageLevel: undefined,
        requiresLegalReview: true,
        legalReviewedBy: "u-legal",
        legalReviewedAt: "2026-05-14T10:00:00Z",
        breachNotificationDeadlineAt: "2026-05-17T10:00:00Z",
      }),
    ).toThrow(/'affected_tenants' or 'regulators'/);
  });

  it("rejects breach_notification without legal review flag", () => {
    expect(() =>
      IncidentCommunicationSchema.parse({
        ...base,
        audience: "affected_tenants",
        kind: "breach_notification",
        statusPageLevel: undefined,
        breachNotificationDeadlineAt: "2026-05-17T10:00:00Z",
        deliveryChannels: ["email"],
      }),
    ).toThrow(/requiresLegalReview=true/);
  });

  it("rejects breach_notification published after deadline", () => {
    expect(() =>
      IncidentCommunicationSchema.parse({
        ...base,
        audience: "affected_tenants",
        kind: "breach_notification",
        statusPageLevel: undefined,
        publishedAt: "2026-05-20T10:00:00Z",
        requiresLegalReview: true,
        legalReviewedBy: "u-legal",
        legalReviewedAt: "2026-05-20T09:00:00Z",
        breachNotificationDeadlineAt: "2026-05-17T10:00:00Z",
        deliveryChannels: ["email"],
      }),
    ).toThrow(/notification was late/);
  });

  it("rejects requiresLegalReview without reviewer", () => {
    expect(() =>
      IncidentCommunicationSchema.parse({
        ...base,
        requiresLegalReview: true,
      }),
    ).toThrow(/legalReviewedBy/);
  });

  it("rejects regulators audience without legal review", () => {
    expect(() =>
      IncidentCommunicationSchema.parse({
        ...base,
        audience: "regulators",
        statusPageLevel: undefined,
        deliveryChannels: ["email"],
      }),
    ).toThrow(/requiresLegalReview=true/);
  });

  it("rejects bounces > recipients", () => {
    expect(() =>
      IncidentCommunicationSchema.parse({
        ...base,
        recipientCount: 10,
        bouncesCount: 20,
      }),
    ).toThrow(/cannot exceed recipientCount/);
  });

  it("rejects retractedAt without reason", () => {
    expect(() =>
      IncidentCommunicationSchema.parse({
        ...base,
        retractedAt: "2026-05-14T11:00:00Z",
      }),
    ).toThrow(/retractedReason/);
  });

  it("rejects duplicate languages", () => {
    expect(() =>
      IncidentCommunicationSchema.parse({
        ...base,
        languages: ["en", "en"],
      }),
    ).toThrow(/duplicate language/);
  });
});

describe("helpers", () => {
  const com: IncidentCommunication = {
    id: "x",
    incidentId: "INC-2026-0042",
    audience: "affected_tenants",
    kind: "breach_notification",
    title: "x",
    body: "x",
    publishedAt: "2026-05-15T10:00:00Z",
    publishedBy: "u-comms",
    languages: ["en"],
    requiresLegalReview: true,
    legalReviewedBy: "u-legal",
    legalReviewedAt: "2026-05-15T09:00:00Z",
    requiresExecutiveApproval: false,
    executiveApprovedBy: null,
    executiveApprovedAt: null,
    deliveryChannels: ["email"],
    recipientCount: 1_000,
    bouncesCount: 50,
    supersedesId: null,
    retractedAt: null,
    breachNotificationDeadlineAt: "2026-05-17T10:00:00Z",
  };

  it("bounceRate returns percent", () => {
    expect(bounceRate(com)).toBe(5);
  });

  it("bounceRate returns 0 for no recipients", () => {
    expect(bounceRate({ ...com, recipientCount: 0, bouncesCount: 0 })).toBe(0);
  });

  it("isBreachNotificationTimely true when published before deadline", () => {
    expect(isBreachNotificationTimely(com)).toBe(true);
  });

  it("isBreachNotificationTimely true for non-breach kind", () => {
    expect(
      isBreachNotificationTimely({
        ...com,
        kind: "investigating",
        audience: "status_page_public",
        statusPageLevel: "degraded",
        requiresLegalReview: false,
        legalReviewedBy: null,
        legalReviewedAt: null,
        breachNotificationDeadlineAt: undefined,
        deliveryChannels: ["status_page"],
      }),
    ).toBe(true);
  });

  it("publishedCommsFor filters by incident + retracted state", () => {
    const earlier = { ...com, id: "a", publishedAt: "2026-05-15T08:00:00Z" };
    const later = { ...com, id: "b", publishedAt: "2026-05-15T12:00:00Z" };
    const retracted = {
      ...com,
      id: "c",
      retractedAt: "2026-05-15T13:00:00Z",
      retractedReason: "incorrect info",
    };
    const result = publishedCommsFor(
      [later, earlier, retracted],
      "INC-2026-0042",
    );
    expect(result.map((c) => c.id)).toEqual(["a", "b"]);
  });
});
