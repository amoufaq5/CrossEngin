import type { WorkflowEvent } from "@crossengin/workflow-engine";
import { describe, expect, it } from "vitest";

import {
  outstandingTimersFromLog,
  surveyCancellableWork,
} from "./instance-cancellation.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const INSTANCE = "wfi_inst0001";

let seq = 0;

function event(over: Partial<WorkflowEvent> & Pick<WorkflowEvent, "kind">): WorkflowEvent {
  return {
    id: `wfe_ev${(seq + 1).toString().padStart(6, "0")}`,
    instanceId: INSTANCE,
    tenantId: TENANT,
    sequenceNumber: seq++,
    occurredAt: "2026-05-16T12:00:00.000Z",
    actorPrincipalId: null,
    actorSystemId: "workflow-engine",
    previousState: null,
    newState: null,
    activityId: null,
    signalId: null,
    timerId: null,
    childInstanceId: null,
    variableName: null,
    payload: {},
    correlationId: null,
    causationEventId: null,
    ...over,
  };
}

function log(...events: readonly WorkflowEvent[]): readonly WorkflowEvent[] {
  seq = 0;
  return events;
}

function scheduled(activityId: string, over: Record<string, unknown> = {}): WorkflowEvent {
  return event({
    kind: "activity_scheduled",
    activityId,
    payload: { kind: "http_call", definitionActivityKey: "charge_card", ...over },
  });
}

describe("outstandingTimersFromLog", () => {
  it("is empty for an empty log", () => {
    expect(outstandingTimersFromLog([])).toEqual([]);
  });

  it("reports a scheduled timer with its name and fire instant", () => {
    const timers = outstandingTimersFromLog(
      log(
        event({
          kind: "timer_scheduled",
          timerId: "wft_00000001",
          payload: { timerName: "deadline", fireAt: "2026-05-16T13:00:00.000Z" },
        }),
      ),
    );
    expect(timers).toEqual([
      {
        id: "wft_00000001",
        name: "deadline",
        fireAt: Date.parse("2026-05-16T13:00:00.000Z"),
      },
    ]);
  });

  it("drops a fired timer and a cancelled one", () => {
    const timers = outstandingTimersFromLog(
      log(
        event({ kind: "timer_scheduled", timerId: "wft_00000001", payload: { timerName: "a" } }),
        event({ kind: "timer_scheduled", timerId: "wft_00000002", payload: { timerName: "b" } }),
        event({ kind: "timer_scheduled", timerId: "wft_00000003", payload: { timerName: "c" } }),
        event({ kind: "timer_fired", timerId: "wft_00000001", payload: { timerName: "a" } }),
        event({ kind: "timer_cancelled", timerId: "wft_00000002", payload: { timerName: "b" } }),
      ),
    );
    expect(timers.map((t) => t.id)).toEqual(["wft_00000003"]);
  });

  it("parks a timer with an unparsable fireAt at the far future rather than treating it as due", () => {
    const [timer] = outstandingTimersFromLog(
      log(
        event({
          kind: "timer_scheduled",
          timerId: "wft_00000001",
          payload: { timerName: "a", fireAt: "not a date" },
        }),
      ),
    );
    expect(timer?.fireAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("keeps the latest schedule when one timer id is rescheduled", () => {
    const timers = outstandingTimersFromLog(
      log(
        event({
          kind: "timer_scheduled",
          timerId: "wft_00000001",
          payload: { timerName: "a", fireAt: "2026-05-16T13:00:00.000Z" },
        }),
        event({
          kind: "timer_scheduled",
          timerId: "wft_00000001",
          payload: { timerName: "a", fireAt: "2026-05-16T14:00:00.000Z" },
        }),
      ),
    );
    expect(timers).toHaveLength(1);
    expect(timers[0]?.fireAt).toBe(Date.parse("2026-05-16T14:00:00.000Z"));
  });
});

describe("surveyCancellableWork", () => {
  it("finds nothing in an empty log", () => {
    expect(surveyCancellableWork([])).toEqual({
      outstandingTimerIds: [],
      scheduledActivityIds: [],
      inFlightActivityIds: [],
      compensatableActivityIds: [],
    });
  });

  it("calls a scheduled-but-unstarted activity scheduled", () => {
    const survey = surveyCancellableWork(log(scheduled("wfa_00000001")));
    expect(survey.scheduledActivityIds).toEqual(["wfa_00000001"]);
    expect(survey.inFlightActivityIds).toEqual([]);
  });

  it("moves an activity to in-flight once its handler was entered", () => {
    const survey = surveyCancellableWork(
      log(scheduled("wfa_00000001"), event({ kind: "activity_started", activityId: "wfa_00000001" })),
    );
    expect(survey.scheduledActivityIds).toEqual([]);
    expect(survey.inFlightActivityIds).toEqual(["wfa_00000001"]);
  });

  it("resolves an activity on each of its five outcome kinds", () => {
    for (const kind of [
      "activity_completed",
      "activity_failed",
      "activity_timed_out",
      "activity_cancelled",
      "activity_compensated",
    ] as const) {
      const survey = surveyCancellableWork(
        log(
          scheduled("wfa_00000001"),
          event({ kind: "activity_started", activityId: "wfa_00000001" }),
          event({ kind, activityId: "wfa_00000001" }),
        ),
      );
      expect(survey.scheduledActivityIds, kind).toEqual([]);
      expect(survey.inFlightActivityIds, kind).toEqual([]);
    }
  });

  it("does not invent an in-flight activity from an activity_started it never scheduled", () => {
    // A corrupt log, and the expensive mistake would be for the cancellation to then claim it
    // signalled something that does not exist.
    const survey = surveyCancellableWork(
      log(event({ kind: "activity_started", activityId: "wfa_09999999" })),
    );
    expect(survey.inFlightActivityIds).toEqual([]);
    expect(survey.scheduledActivityIds).toEqual([]);
  });

  it("separates several activities by the position each reached", () => {
    const survey = surveyCancellableWork(
      log(
        scheduled("wfa_00000001"),
        event({ kind: "activity_started", activityId: "wfa_00000001" }),
        event({ kind: "activity_completed", activityId: "wfa_00000001" }),
        scheduled("wfa_00000002"),
        event({ kind: "activity_started", activityId: "wfa_00000002" }),
        scheduled("wfa_00000003"),
      ),
    );
    expect(survey.inFlightActivityIds).toEqual(["wfa_00000002"]);
    expect(survey.scheduledActivityIds).toEqual(["wfa_00000003"]);
  });

  it("reports a completed side effect with a compensating key as compensatable", () => {
    const survey = surveyCancellableWork(
      log(
        scheduled("wfa_00000001", { compensationActivityKey: "refund_card" }),
        event({ kind: "activity_started", activityId: "wfa_00000001" }),
        event({ kind: "activity_completed", activityId: "wfa_00000001" }),
      ),
    );
    expect(survey.compensatableActivityIds).toEqual(["wfa_00000001"]);
  });

  it("does not report a side effect with no compensating key", () => {
    const survey = surveyCancellableWork(
      log(
        scheduled("wfa_00000001"),
        event({ kind: "activity_started", activityId: "wfa_00000001" }),
        event({ kind: "activity_completed", activityId: "wfa_00000001" }),
      ),
    );
    expect(survey.compensatableActivityIds).toEqual([]);
  });

  it("does not report a non-side-effect kind, however it is keyed", () => {
    const survey = surveyCancellableWork(
      log(
        scheduled("wfa_00000001", {
          kind: "transformation",
          compensationActivityKey: "undo_transform",
        }),
        event({ kind: "activity_completed", activityId: "wfa_00000001" }),
      ),
    );
    expect(survey.compensatableActivityIds).toEqual([]);
  });

  it("drops an already-compensated activity, so a repeat cancellation plans nothing twice", () => {
    const survey = surveyCancellableWork(
      log(
        scheduled("wfa_00000001", { compensationActivityKey: "refund_card" }),
        event({ kind: "activity_completed", activityId: "wfa_00000001" }),
        event({ kind: "activity_compensated", activityId: "wfa_00000001" }),
      ),
    );
    expect(survey.compensatableActivityIds).toEqual([]);
  });

  it("reports compensatable work regardless of the definition's strategy, which it never sees", () => {
    // Strategy-independent on purpose: a `no_compensation` definition must still *report* what it
    // cannot undo rather than report nothing.
    const survey = surveyCancellableWork(
      log(
        scheduled("wfa_00000001", { compensationActivityKey: "refund_card" }),
        event({ kind: "activity_completed", activityId: "wfa_00000001" }),
      ),
    );
    expect(survey.compensatableActivityIds).toEqual(["wfa_00000001"]);
  });

  it("carries the outstanding timers through unchanged", () => {
    const survey = surveyCancellableWork(
      log(
        event({ kind: "timer_scheduled", timerId: "wft_00000001", payload: { timerName: "a" } }),
        event({ kind: "timer_scheduled", timerId: "wft_00000002", payload: { timerName: "b" } }),
        event({ kind: "timer_fired", timerId: "wft_00000001", payload: { timerName: "a" } }),
      ),
    );
    expect(survey.outstandingTimerIds).toEqual(["wft_00000002"]);
  });

  it("is a pure function of the log: the same events survey identically", () => {
    const events = log(
      scheduled("wfa_00000001", { compensationActivityKey: "refund_card" }),
      event({ kind: "activity_completed", activityId: "wfa_00000001" }),
      scheduled("wfa_00000002"),
      event({ kind: "timer_scheduled", timerId: "wft_00000001", payload: { timerName: "a" } }),
    );
    expect(surveyCancellableWork(events)).toEqual(surveyCancellableWork(events));
  });

  it("ignores events that carry no activity or timer id", () => {
    const survey = surveyCancellableWork(
      log(
        event({ kind: "variable_updated", variableName: "amount", payload: { newValue: 1 } }),
        event({ kind: "state_transitioned", previousState: "a", newState: "b" }),
        event({ kind: "manual_action_taken", actorPrincipalId: null }),
      ),
    );
    expect(survey).toEqual({
      outstandingTimerIds: [],
      scheduledActivityIds: [],
      inFlightActivityIds: [],
      compensatableActivityIds: [],
    });
  });
});

describe("outstandingTimersFromLog — a re-armed recurring timer", () => {
  const timerEvent = (
    _seq: number,
    kind: WorkflowEvent["kind"],
    timerId: string,
    payload: Record<string, unknown>,
  ): WorkflowEvent => event({ kind, timerId, payload });

  it("re-admits a timer id that a later timer_scheduled arms again", () => {
    // The ordering is the guarantee: `timer_fired` removes the id and the re-arm puts it back, so a
    // recurring timer is outstanding again after it fires. Arming before firing would cancel out.
    const out = outstandingTimersFromLog([
      timerEvent(1, "timer_scheduled", "wft_cron0001", { timerName: "heartbeat", fireAt: "2026-05-16T13:00:00.000Z" }),
      timerEvent(2, "timer_fired", "wft_cron0001", { timerName: "heartbeat", nextFireAt: "2026-05-16T14:00:00.000Z" }),
      timerEvent(3, "timer_scheduled", "wft_cron0001", { timerName: "heartbeat", fireAt: "2026-05-16T14:00:00.000Z", rearm: true }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.fireAt).toBe(Date.parse("2026-05-16T14:00:00.000Z"));
  });

  it("leaves a fired-and-not-re-armed timer out", () => {
    const out = outstandingTimersFromLog([
      timerEvent(1, "timer_scheduled", "wft_cron0001", { timerName: "heartbeat", fireAt: "2026-05-16T13:00:00.000Z" }),
      timerEvent(2, "timer_fired", "wft_cron0001", { timerName: "heartbeat", nextFireAt: "2026-05-16T14:00:00.000Z" }),
    ]);
    expect(out).toEqual([]);
  });

  it("a cancellation after a re-arm removes it again", () => {
    const out = outstandingTimersFromLog([
      timerEvent(1, "timer_scheduled", "wft_cron0001", { timerName: "heartbeat", fireAt: "2026-05-16T13:00:00.000Z" }),
      timerEvent(2, "timer_fired", "wft_cron0001", { timerName: "heartbeat", nextFireAt: "2026-05-16T14:00:00.000Z" }),
      timerEvent(3, "timer_scheduled", "wft_cron0001", { timerName: "heartbeat", fireAt: "2026-05-16T14:00:00.000Z", rearm: true }),
      timerEvent(4, "timer_cancelled", "wft_cron0001", { timerName: "heartbeat" }),
    ]);
    expect(out).toEqual([]);
  });
});
