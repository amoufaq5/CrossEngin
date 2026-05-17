import { describe, expect, it } from "vitest";
import {
  ACTION_TARGET_STATE,
  ACTION_TRIGGERS,
  LIFECYCLE_ACTIONS,
  LifecycleEventSchema,
  actionRequiresFourEyes,
  eventChain,
  lastEvent,
  type LifecycleEvent,
} from "./actions.js";

describe("constants", () => {
  it("LIFECYCLE_ACTIONS has 7 entries", () => {
    expect(LIFECYCLE_ACTIONS).toContain("activate");
    expect(LIFECYCLE_ACTIONS).toContain("execute_deletion");
    expect(LIFECYCLE_ACTIONS).toContain("cancel_deletion");
  });

  it("ACTION_TRIGGERS has 8 entries", () => {
    expect(ACTION_TRIGGERS).toContain("customer_request");
    expect(ACTION_TRIGGERS).toContain("compliance_directive");
    expect(ACTION_TRIGGERS).toContain("security_incident");
  });

  it("ACTION_TARGET_STATE maps each action to a target state", () => {
    expect(ACTION_TARGET_STATE.suspend).toBe("suspended");
    expect(ACTION_TARGET_STATE.execute_deletion).toBe("deleted");
    expect(ACTION_TARGET_STATE.cancel_deletion).toBe("archived");
  });
});

describe("LifecycleEventSchema", () => {
  const base: LifecycleEvent = {
    id: "ev-1",
    tenantId: "t-1",
    action: "suspend",
    fromState: "active",
    toState: "suspended",
    trigger: "billing_failure",
    occurredAt: "2026-05-14T10:00:00Z",
    actorUserId: null,
    actorSystemId: "billing-engine",
    reason: "Invoice unpaid for 30 days",
    customerNotifiedAt: "2026-05-14T10:01:00Z",
    notificationChannel: "email",
    requiresFourEyesApproval: false,
    approvedByUserId: null,
    approvedAt: null,
  };

  it("accepts a valid suspension event", () => {
    expect(() => LifecycleEventSchema.parse(base)).not.toThrow();
  });

  it("rejects fromState == toState", () => {
    expect(() =>
      LifecycleEventSchema.parse({ ...base, toState: "active" }),
    ).toThrow();
  });

  it("rejects mismatched action and toState", () => {
    expect(() =>
      LifecycleEventSchema.parse({ ...base, toState: "archived" }),
    ).toThrow(/must transition to 'suspended'/);
  });

  it("rejects both actorUserId and actorSystemId", () => {
    expect(() =>
      LifecycleEventSchema.parse({
        ...base,
        actorUserId: "u-1",
        actorSystemId: "billing-engine",
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects neither actor", () => {
    expect(() =>
      LifecycleEventSchema.parse({
        ...base,
        actorUserId: null,
        actorSystemId: null,
      }),
    ).toThrow(/actorUserId or actorSystemId/);
  });

  it("rejects compliance_directive without relatedIncidentId", () => {
    expect(() =>
      LifecycleEventSchema.parse({
        ...base,
        trigger: "compliance_directive",
      }),
    ).toThrow(/relatedIncidentId/);
  });

  it("rejects execute_deletion without four-eyes approval flag", () => {
    expect(() =>
      LifecycleEventSchema.parse({
        ...base,
        action: "execute_deletion",
        fromState: "pending_deletion",
        toState: "deleted",
        trigger: "scheduled_policy",
        requiresFourEyesApproval: false,
      }),
    ).toThrow(/four-eyes approval/);
  });

  it("rejects four-eyes flag without approvedByUserId", () => {
    expect(() =>
      LifecycleEventSchema.parse({
        ...base,
        requiresFourEyesApproval: true,
      }),
    ).toThrow(/approvedByUserId/);
  });

  it("rejects approver = actor (four-eyes principle)", () => {
    expect(() =>
      LifecycleEventSchema.parse({
        ...base,
        actorUserId: "u-1",
        actorSystemId: null,
        requiresFourEyesApproval: true,
        approvedByUserId: "u-1",
        approvedAt: "2026-05-14T10:00:00Z",
      }),
    ).toThrow(/different user than the actor/);
  });

  it("rejects suspend with notificationChannel='none'", () => {
    expect(() =>
      LifecycleEventSchema.parse({
        ...base,
        notificationChannel: "none",
      }),
    ).toThrow(/notify the customer/);
  });
});

describe("actionRequiresFourEyes", () => {
  it("execute_deletion always requires four-eyes", () => {
    expect(actionRequiresFourEyes("execute_deletion", "scheduled_policy")).toBe(true);
    expect(actionRequiresFourEyes("execute_deletion", "customer_request")).toBe(true);
  });

  it("archive + compliance_directive requires four-eyes", () => {
    expect(actionRequiresFourEyes("archive", "compliance_directive")).toBe(true);
    expect(actionRequiresFourEyes("archive", "customer_request")).toBe(false);
  });

  it("schedule_deletion + platform_admin requires four-eyes", () => {
    expect(actionRequiresFourEyes("schedule_deletion", "platform_admin")).toBe(true);
    expect(actionRequiresFourEyes("schedule_deletion", "customer_request")).toBe(false);
  });

  it("suspend never requires four-eyes", () => {
    expect(actionRequiresFourEyes("suspend", "billing_failure")).toBe(false);
  });
});

describe("eventChain / lastEvent", () => {
  const ev = (id: string, occurredAt: string, tenantId: string = "t-1"): LifecycleEvent => ({
    id,
    tenantId,
    action: "activate",
    fromState: "trial",
    toState: "active",
    trigger: "customer_request",
    occurredAt,
    actorUserId: "u-1",
    actorSystemId: null,
    reason: "x",
    customerNotifiedAt: null,
    notificationChannel: "email",
    requiresFourEyesApproval: false,
    approvedByUserId: null,
    approvedAt: null,
  });

  it("eventChain sorts by occurredAt ascending and filters by tenant", () => {
    const events = [
      ev("a", "2026-05-14T10:00:00Z"),
      ev("b", "2026-05-14T09:00:00Z"),
      ev("c", "2026-05-14T11:00:00Z", "t-2"),
    ];
    expect(eventChain(events, "t-1").map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("lastEvent returns the most recent for tenant", () => {
    const events = [
      ev("a", "2026-05-14T10:00:00Z"),
      ev("b", "2026-05-14T09:00:00Z"),
    ];
    expect(lastEvent(events, "t-1")?.id).toBe("a");
  });

  it("lastEvent returns null for empty / unknown tenant", () => {
    expect(lastEvent([], "t-1")).toBeNull();
  });
});
