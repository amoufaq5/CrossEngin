import { describe, expect, it } from "vitest";
import {
  KILL_SWITCH_STATUSES,
  KILL_SWITCH_TRANSITIONS,
  KILL_SWITCH_TRIGGER_KINDS,
  KillSwitchSchema,
  REQUIRES_FOUR_EYES,
  REQUIRES_INCIDENT_LINK,
  canTransitionKillSwitch,
  findActiveKillSwitch,
  isKillSwitchActive,
  requiresFourEyes,
  type KillSwitch,
} from "./kill-switches.js";

const baseSwitch: KillSwitch = {
  id: "fks_emerg00001",
  tenantId: null,
  flagId: "ff_payments01",
  status: "armed",
  triggerKind: "manual_admin",
  justification: "Pre-armed emergency switch for the new payments integration",
  armedAt: "2026-05-15T10:00:00.000Z",
  armedByUserId: "22222222-2222-2222-2222-222222222222",
  triggeredAt: null,
  triggeredByUserId: null,
  coTriggeredByUserId: null,
  coTriggeredAt: null,
  expiresAt: null,
  releasedAt: null,
  releasedByUserId: null,
  releasedReason: null,
  expiredAt: null,
  relatedIncidentId: null,
  overriddenValueJson: "false",
  impactScopeNotes: undefined,
};

describe("constants", () => {
  it("has 8 trigger kinds", () => {
    expect(KILL_SWITCH_TRIGGER_KINDS).toHaveLength(8);
  });
  it("has 4 statuses", () => {
    expect(KILL_SWITCH_STATUSES).toHaveLength(4);
  });
  it("REQUIRES_INCIDENT_LINK includes incident + security", () => {
    expect(REQUIRES_INCIDENT_LINK.has("incident_response")).toBe(true);
    expect(REQUIRES_INCIDENT_LINK.has("security_event")).toBe(true);
  });
  it("REQUIRES_FOUR_EYES includes manual_admin + compliance", () => {
    expect(REQUIRES_FOUR_EYES.has("manual_admin")).toBe(true);
    expect(REQUIRES_FOUR_EYES.has("compliance_directive")).toBe(true);
  });
});

describe("canTransitionKillSwitch", () => {
  it("allows armed → triggered_active", () => {
    expect(canTransitionKillSwitch("armed", "triggered_active")).toBe(true);
  });
  it("blocks released → triggered_active", () => {
    expect(canTransitionKillSwitch("released", "triggered_active")).toBe(false);
  });
  it("released is terminal", () => {
    expect(KILL_SWITCH_TRANSITIONS.released).toEqual([]);
  });
});

describe("KillSwitchSchema", () => {
  it("accepts an armed kill switch", () => {
    expect(() => KillSwitchSchema.parse(baseSwitch)).not.toThrow();
  });

  it("rejects incident_response trigger without relatedIncidentId", () => {
    expect(() =>
      KillSwitchSchema.parse({
        ...baseSwitch,
        triggerKind: "incident_response",
      }),
    ).toThrow(/relatedIncidentId/);
  });

  it("rejects triggered_active without triggeredAt + triggeredByUserId", () => {
    expect(() =>
      KillSwitchSchema.parse({
        ...baseSwitch,
        status: "triggered_active",
      }),
    ).toThrow(/triggered_active status requires/);
  });

  it("rejects manual_admin triggered without four-eyes", () => {
    expect(() =>
      KillSwitchSchema.parse({
        ...baseSwitch,
        status: "triggered_active",
        triggeredAt: "2026-05-16T11:00:00.000Z",
        triggeredByUserId: "33333333-3333-3333-3333-333333333333",
      }),
    ).toThrow(/four-eyes/);
  });

  it("rejects co-trigger same as primary trigger user", () => {
    expect(() =>
      KillSwitchSchema.parse({
        ...baseSwitch,
        status: "triggered_active",
        triggeredAt: "2026-05-16T11:00:00.000Z",
        triggeredByUserId: "33333333-3333-3333-3333-333333333333",
        coTriggeredByUserId: "33333333-3333-3333-3333-333333333333",
        coTriggeredAt: "2026-05-16T11:01:00.000Z",
      }),
    ).toThrow(/co-trigger must differ from primary trigger/);
  });

  it("rejects co-trigger same as armer (full separation)", () => {
    expect(() =>
      KillSwitchSchema.parse({
        ...baseSwitch,
        status: "triggered_active",
        triggeredAt: "2026-05-16T11:00:00.000Z",
        triggeredByUserId: "33333333-3333-3333-3333-333333333333",
        coTriggeredByUserId: baseSwitch.armedByUserId,
        coTriggeredAt: "2026-05-16T11:01:00.000Z",
      }),
    ).toThrow(/separation of duties/);
  });

  it("rejects released without releasedReason", () => {
    expect(() =>
      KillSwitchSchema.parse({
        ...baseSwitch,
        status: "released",
        triggeredAt: "2026-05-16T11:00:00.000Z",
        triggeredByUserId: "33333333-3333-3333-3333-333333333333",
        coTriggeredByUserId: "44444444-4444-4444-4444-444444444444",
        coTriggeredAt: "2026-05-16T11:01:00.000Z",
        releasedAt: "2026-05-17T10:00:00.000Z",
        releasedByUserId: "55555555-5555-5555-5555-555555555555",
      }),
    ).toThrow(/released status requires/);
  });

  it("rejects expiresAt <= armedAt", () => {
    expect(() =>
      KillSwitchSchema.parse({
        ...baseSwitch,
        expiresAt: baseSwitch.armedAt,
      }),
    ).toThrow(/expiresAt must be after armedAt/);
  });

  it("rejects invalid overriddenValueJson", () => {
    expect(() =>
      KillSwitchSchema.parse({
        ...baseSwitch,
        overriddenValueJson: "{not valid",
      }),
    ).toThrow(/must be valid JSON/);
  });
});

describe("isKillSwitchActive / findActiveKillSwitch", () => {
  const triggered: KillSwitch = {
    ...baseSwitch,
    status: "triggered_active",
    triggeredAt: "2026-05-16T11:00:00.000Z",
    triggeredByUserId: "33333333-3333-3333-3333-333333333333",
    coTriggeredByUserId: "44444444-4444-4444-4444-444444444444",
    coTriggeredAt: "2026-05-16T11:01:00.000Z",
    expiresAt: "2026-05-17T11:00:00.000Z",
  };

  it("returns true for triggered_active within window", () => {
    expect(
      isKillSwitchActive(triggered, new Date("2026-05-16T15:00:00Z")),
    ).toBe(true);
  });

  it("returns false past expiresAt", () => {
    expect(
      isKillSwitchActive(triggered, new Date("2026-05-18T00:00:00Z")),
    ).toBe(false);
  });

  it("returns false for armed status (not yet triggered)", () => {
    expect(
      isKillSwitchActive(baseSwitch, new Date("2026-05-16T11:00:00Z")),
    ).toBe(false);
  });

  it("findActiveKillSwitch matches by flagId", () => {
    expect(
      findActiveKillSwitch(
        [triggered],
        triggered.flagId,
        new Date("2026-05-16T15:00:00Z"),
      ),
    ).not.toBeNull();
  });

  it("findActiveKillSwitch returns null on flagId mismatch", () => {
    expect(
      findActiveKillSwitch(
        [triggered],
        "ff_otherflag1",
        new Date("2026-05-16T15:00:00Z"),
      ),
    ).toBeNull();
  });
});

describe("requiresFourEyes", () => {
  it("manual_admin requires", () => {
    expect(requiresFourEyes("manual_admin")).toBe(true);
  });
  it("automated_metric_breach does not require", () => {
    expect(requiresFourEyes("automated_metric_breach")).toBe(false);
  });
});
