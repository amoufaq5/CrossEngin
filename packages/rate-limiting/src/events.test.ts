import { describe, expect, it } from "vitest";
import {
  ALERT_WORTHY_EVENT_KINDS,
  THROTTLE_EVENT_KINDS,
  ThrottleEventSchema,
  aggregateThrottleEvents,
  groupEventsByKind,
  isAlertWorthy,
  type ThrottleEvent,
} from "./events.js";

const baseEvent: ThrottleEvent = {
  id: "rlt_evt000001",
  tenantId: "11111111-1111-1111-1111-111111111111",
  kind: "hard_limit_hit",
  occurredAt: "2026-05-16T10:00:00.000Z",
  policyId: "rlp_apistd001",
  quotaDefinitionId: null,
  exceptionId: null,
  scopeKey: "tenant:11111111-1111-1111-1111-111111111111",
  relatedDecisionOutcome: "denied_rate_limit_exceeded",
  actorPrincipalId: null,
  actorSystemId: "rate-limit-worker",
  payload: {},
  notificationDispatched: false,
  incidentDeclared: false,
  relatedIncidentId: null,
};

describe("constants", () => {
  it("has 10 throttle event kinds", () => {
    expect(THROTTLE_EVENT_KINDS).toHaveLength(10);
  });
  it("ALERT_WORTHY includes hard_limit_hit + circuit_opened + exception_approved", () => {
    expect(ALERT_WORTHY_EVENT_KINDS.size).toBe(3);
    expect(ALERT_WORTHY_EVENT_KINDS.has("hard_limit_hit")).toBe(true);
    expect(ALERT_WORTHY_EVENT_KINDS.has("soft_limit_hit")).toBe(false);
  });
});

describe("ThrottleEventSchema", () => {
  it("accepts a hard_limit_hit event", () => {
    expect(() => ThrottleEventSchema.parse(baseEvent)).not.toThrow();
  });

  it("rejects neither actor user nor system", () => {
    expect(() =>
      ThrottleEventSchema.parse({
        ...baseEvent,
        actorSystemId: null,
      }),
    ).toThrow(/either actorPrincipalId or actorSystemId/);
  });

  it("rejects exception_approved without exceptionId", () => {
    expect(() =>
      ThrottleEventSchema.parse({
        ...baseEvent,
        kind: "exception_approved",
      }),
    ).toThrow(/exception_approved event requires exceptionId/);
  });

  it("rejects policy_activated without policyId", () => {
    expect(() =>
      ThrottleEventSchema.parse({
        ...baseEvent,
        kind: "policy_activated",
        policyId: null,
      }),
    ).toThrow(/policy_activated event requires policyId/);
  });

  it("rejects quota_period_reset without quotaDefinitionId", () => {
    expect(() =>
      ThrottleEventSchema.parse({
        ...baseEvent,
        kind: "quota_period_reset",
      }),
    ).toThrow(/quotaDefinitionId/);
  });

  it("rejects incidentDeclared=true without relatedIncidentId", () => {
    expect(() =>
      ThrottleEventSchema.parse({
        ...baseEvent,
        incidentDeclared: true,
      }),
    ).toThrow(/relatedIncidentId/);
  });
});

describe("isAlertWorthy", () => {
  it("hard_limit_hit is alert-worthy", () => {
    expect(isAlertWorthy("hard_limit_hit")).toBe(true);
  });
  it("burst_consumed is not alert-worthy", () => {
    expect(isAlertWorthy("burst_consumed")).toBe(false);
  });
});

describe("aggregateThrottleEvents", () => {
  it("returns zeros for empty input", () => {
    const a = aggregateThrottleEvents([]);
    expect(a.totalEvents).toBe(0);
    expect(a.windowStart).toBeNull();
  });

  it("aggregates kind counts and alert-worthy count", () => {
    const events: ThrottleEvent[] = [
      baseEvent,
      {
        ...baseEvent,
        id: "rlt_evt000002",
        kind: "soft_limit_hit",
        occurredAt: "2026-05-16T10:00:30.000Z",
      },
      {
        ...baseEvent,
        id: "rlt_evt000003",
        kind: "hard_limit_hit",
        occurredAt: "2026-05-16T10:01:00.000Z",
        incidentDeclared: true,
        relatedIncidentId: "INC-2026-0001",
        notificationDispatched: true,
      },
    ];
    const a = aggregateThrottleEvents(events);
    expect(a.totalEvents).toBe(3);
    expect(a.kindCounts.hard_limit_hit).toBe(2);
    expect(a.kindCounts.soft_limit_hit).toBe(1);
    expect(a.alertWorthyCount).toBe(2);
    expect(a.incidentsDeclared).toBe(1);
    expect(a.notificationsDispatched).toBe(1);
    expect(a.windowStart).toBe("2026-05-16T10:00:00.000Z");
    expect(a.windowEnd).toBe("2026-05-16T10:01:00.000Z");
  });
});

describe("groupEventsByKind", () => {
  it("groups events by kind", () => {
    const events: ThrottleEvent[] = [
      baseEvent,
      {
        ...baseEvent,
        id: "rlt_evt000002",
        kind: "soft_limit_hit",
      },
      {
        ...baseEvent,
        id: "rlt_evt000003",
        kind: "hard_limit_hit",
      },
    ];
    const grouped = groupEventsByKind(events);
    expect(grouped.get("hard_limit_hit")).toHaveLength(2);
    expect(grouped.get("soft_limit_hit")).toHaveLength(1);
  });
});
