import { describe, expect, it } from "vitest";
import {
  ACTIVITY_EVENTS,
  EVENT_KINDS,
  SIGNAL_EVENTS,
  STATE_CHANGING_EVENTS,
  TIMER_EVENTS,
  WorkflowEventSchema,
  isHistoryDense,
  reconstructStateTimeline,
  summarizeInstanceHistory,
  type WorkflowEvent,
} from "./history.js";

const baseEvent: WorkflowEvent = {
  id: "wfe_event001",
  instanceId: "wfi_pr00000001",
  tenantId: "11111111-1111-1111-1111-111111111111",
  sequenceNumber: 0,
  kind: "instance_started",
  occurredAt: "2026-05-16T10:00:00.000Z",
  actorPrincipalId: "22222222-2222-2222-2222-222222222222",
  actorSystemId: null,
  previousState: null,
  newState: "submitted",
  activityId: null,
  signalId: null,
  timerId: null,
  childInstanceId: null,
  variableName: null,
  payload: {},
  correlationId: null,
  causationEventId: null,
};

describe("constants", () => {
  it("has 25 event kinds", () => {
    expect(EVENT_KINDS).toHaveLength(25);
  });
  it("STATE_CHANGING_EVENTS includes instance_started", () => {
    expect(STATE_CHANGING_EVENTS.has("instance_started")).toBe(true);
  });
  it("ACTIVITY_EVENTS has 6 kinds", () => {
    expect(ACTIVITY_EVENTS.size).toBe(6);
  });
  it("SIGNAL_EVENTS has 2 kinds", () => {
    expect(SIGNAL_EVENTS.size).toBe(2);
  });
  it("TIMER_EVENTS has 3 kinds", () => {
    expect(TIMER_EVENTS.size).toBe(3);
  });
});

describe("WorkflowEventSchema", () => {
  it("accepts an instance_started event", () => {
    expect(() => WorkflowEventSchema.parse(baseEvent)).not.toThrow();
  });

  it("accepts a state_transitioned event with prev + new", () => {
    expect(() =>
      WorkflowEventSchema.parse({
        ...baseEvent,
        id: "wfe_state001",
        sequenceNumber: 1,
        kind: "state_transitioned",
        previousState: "submitted",
        newState: "manager_review",
      }),
    ).not.toThrow();
  });

  it("rejects state_transitioned without previousState", () => {
    expect(() =>
      WorkflowEventSchema.parse({
        ...baseEvent,
        id: "wfe_state002",
        kind: "state_transitioned",
        previousState: null,
        newState: "manager_review",
      }),
    ).toThrow(/previousState \+ newState/);
  });

  it("rejects state_transitioned where prev === new", () => {
    expect(() =>
      WorkflowEventSchema.parse({
        ...baseEvent,
        id: "wfe_state003",
        kind: "state_transitioned",
        previousState: "submitted",
        newState: "submitted",
      }),
    ).toThrow(/must change state/);
  });

  it("rejects activity event without activityId", () => {
    expect(() =>
      WorkflowEventSchema.parse({
        ...baseEvent,
        id: "wfe_act00001",
        kind: "activity_scheduled",
      }),
    ).toThrow(/activity_scheduled event requires activityId/);
  });

  it("rejects signal event without signalId", () => {
    expect(() =>
      WorkflowEventSchema.parse({
        ...baseEvent,
        id: "wfe_sig00001",
        kind: "signal_received",
      }),
    ).toThrow(/signal_received event requires signalId/);
  });

  it("rejects timer event without timerId", () => {
    expect(() =>
      WorkflowEventSchema.parse({
        ...baseEvent,
        id: "wfe_tmr00001",
        kind: "timer_fired",
      }),
    ).toThrow(/timer_fired event requires timerId/);
  });

  it("rejects variable_updated without variableName", () => {
    expect(() =>
      WorkflowEventSchema.parse({
        ...baseEvent,
        id: "wfe_var00001",
        kind: "variable_updated",
      }),
    ).toThrow(/variableName/);
  });

  it("rejects child_workflow_spawned without childInstanceId", () => {
    expect(() =>
      WorkflowEventSchema.parse({
        ...baseEvent,
        id: "wfe_child001",
        kind: "child_workflow_spawned",
      }),
    ).toThrow(/childInstanceId/);
  });

  it("rejects manual_action_taken without actorPrincipalId", () => {
    expect(() =>
      WorkflowEventSchema.parse({
        ...baseEvent,
        id: "wfe_man00001",
        kind: "manual_action_taken",
        actorPrincipalId: null,
        actorSystemId: "system",
      }),
    ).toThrow(/manual_action_taken event requires actorPrincipalId/);
  });

  it("accepts timer_fired with no actor (system-fired)", () => {
    expect(() =>
      WorkflowEventSchema.parse({
        ...baseEvent,
        id: "wfe_tmrsys01",
        kind: "timer_fired",
        timerId: "wft_review01",
        actorPrincipalId: null,
        actorSystemId: null,
      }),
    ).not.toThrow();
  });
});

const eventStream: WorkflowEvent[] = [
  baseEvent,
  {
    ...baseEvent,
    id: "wfe_stt00001",
    sequenceNumber: 1,
    kind: "state_transitioned",
    occurredAt: "2026-05-16T10:00:30.000Z",
    previousState: "submitted",
    newState: "manager_review",
  },
  {
    ...baseEvent,
    id: "wfe_act00001",
    sequenceNumber: 2,
    kind: "activity_scheduled",
    occurredAt: "2026-05-16T10:00:31.000Z",
    activityId: "wfa_call0001",
    newState: null,
    actorSystemId: "scheduler",
    actorPrincipalId: null,
  },
];

describe("summarizeInstanceHistory", () => {
  it("returns zeros for empty input", () => {
    const s = summarizeInstanceHistory([]);
    expect(s.totalEvents).toBe(0);
  });

  it("counts events by category", () => {
    const s = summarizeInstanceHistory(eventStream);
    expect(s.totalEvents).toBe(3);
    expect(s.stateTransitionCount).toBe(1);
    expect(s.activityCount).toBe(1);
  });

  it("computes durationSeconds from first → last", () => {
    const s = summarizeInstanceHistory(eventStream);
    expect(s.durationSeconds).toBe(31);
  });
});

describe("isHistoryDense", () => {
  it("returns true for dense (0, 1, 2)", () => {
    expect(isHistoryDense(eventStream)).toBe(true);
  });
  it("returns false for gap", () => {
    expect(
      isHistoryDense([
        baseEvent,
        { ...baseEvent, id: "wfe_gap000001", sequenceNumber: 5 },
      ]),
    ).toBe(false);
  });
  it("returns true for empty", () => {
    expect(isHistoryDense([])).toBe(true);
  });
});

describe("reconstructStateTimeline", () => {
  it("returns ordered timeline from instance_started + state_transitioned", () => {
    const timeline = reconstructStateTimeline(eventStream);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.state).toBe("submitted");
    expect(timeline[1]?.state).toBe("manager_review");
  });
});
