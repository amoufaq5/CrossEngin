import type { WorkflowEvent } from "@crossengin/workflow-engine";
import { describe, expect, it } from "vitest";

import {
  isInstanceCancellationRequested,
  isInstanceCancelled,
  projectActivities,
  projectInstance,
  projectSignals,
  projectTimers,
} from "./projection.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function event(o: Partial<WorkflowEvent> & { kind: WorkflowEvent["kind"]; sequenceNumber: number }): WorkflowEvent {
  return {
    id: o.id ?? `wfe_${o.sequenceNumber.toString().padStart(8, "0")}`,
    instanceId: o.instanceId ?? "wfi_00000001",
    tenantId: o.tenantId ?? TENANT,
    sequenceNumber: o.sequenceNumber,
    kind: o.kind,
    occurredAt: o.occurredAt ?? "2026-05-16T12:00:00.000Z",
    actorPrincipalId: o.actorPrincipalId ?? null,
    actorSystemId: o.actorSystemId ?? "engine",
    previousState: o.previousState ?? null,
    newState: o.newState ?? null,
    activityId: o.activityId ?? null,
    signalId: o.signalId ?? null,
    timerId: o.timerId ?? null,
    childInstanceId: o.childInstanceId ?? null,
    variableName: o.variableName ?? null,
    payload: o.payload ?? {},
    correlationId: o.correlationId ?? null,
    causationEventId: o.causationEventId ?? null,
  };
}

function startEvent(payload: Record<string, unknown> = {}): WorkflowEvent {
  return event({
    kind: "instance_started",
    sequenceNumber: 0,
    payload: {
      definitionId: "wfd_def00001",
      definitionKey: "purchase.approval",
      definitionVersion: "1.0.0",
      initialState: "draft",
      variables: { amount: 100 },
      timeoutAt: "2026-05-17T12:00:00.000Z",
      ...payload,
    },
  });
}

describe("projectInstance — empty", () => {
  it("returns null with no events", () => {
    expect(projectInstance([])).toBeNull();
  });

  it("throws when the first event is not instance_started", () => {
    expect(() =>
      projectInstance([event({ kind: "state_transitioned", sequenceNumber: 0, newState: "x" })]),
    ).toThrow(/instance_started/);
  });
});

describe("projectInstance — initial", () => {
  it("seeds from instance_started payload", () => {
    const out = projectInstance([startEvent()]);
    expect(out?.status).toBe("running");
    expect(out?.currentState).toBe("draft");
    expect(out?.definitionId).toBe("wfd_def00001");
    expect(out?.definitionKey).toBe("purchase.approval");
    expect(out?.definitionVersion).toBe("1.0.0");
    expect(out?.variables).toEqual({ amount: 100 });
    expect(out?.timeoutAt).toBe("2026-05-17T12:00:00.000Z");
    expect(out?.sequenceCursor).toBe(0);
  });

  it("threads actorPrincipalId / actorSystemId to startedBy* fields", () => {
    const ev = {
      ...startEvent(),
      actorPrincipalId: "00000000-0000-4000-8000-000000000099",
      actorSystemId: null,
    };
    const out = projectInstance([ev]);
    expect(out?.startedByUserId).toBe("00000000-0000-4000-8000-000000000099");
    expect(out?.startedBySystem).toBeNull();
  });
});

describe("projectInstance — transitions", () => {
  it("advances currentState on state_transitioned events", () => {
    const out = projectInstance([
      startEvent(),
      event({
        kind: "state_transitioned",
        sequenceNumber: 1,
        previousState: "draft",
        newState: "submitted",
      }),
      event({
        kind: "state_transitioned",
        sequenceNumber: 2,
        previousState: "submitted",
        newState: "approved",
      }),
    ]);
    expect(out?.currentState).toBe("approved");
    expect(out?.sequenceCursor).toBe(2);
  });

  it("rejects a duplicate instance_started", () => {
    expect(() =>
      projectInstance([
        startEvent(),
        { ...startEvent(), id: "wfe_00000002", sequenceNumber: 1 },
      ]),
    ).toThrow(/duplicate instance_started/);
  });
});

describe("projectInstance — terminal events", () => {
  it("instance_completed sets status + completedAt", () => {
    const out = projectInstance([
      startEvent(),
      event({
        kind: "instance_completed",
        sequenceNumber: 1,
        occurredAt: "2026-05-16T13:00:00.000Z",
      }),
    ]);
    expect(out?.status).toBe("completed");
    expect(out?.completedAt).toBe("2026-05-16T13:00:00.000Z");
  });

  it("instance_failed sets status + failure fields", () => {
    const out = projectInstance([
      startEvent(),
      event({
        kind: "instance_failed",
        sequenceNumber: 1,
        occurredAt: "2026-05-16T13:00:00.000Z",
        payload: { errorCode: "TIMEOUT", errorMessage: "exceeded" },
      }),
    ]);
    expect(out?.status).toBe("failed");
    expect(out?.failedAt).toBe("2026-05-16T13:00:00.000Z");
    expect(out?.failureCode).toBe("TIMEOUT");
    expect(out?.failureMessage).toBe("exceeded");
  });

  it("instance_cancelled sets status + cancelledBy + reason", () => {
    const out = projectInstance([
      startEvent(),
      event({
        kind: "instance_cancelled",
        sequenceNumber: 1,
        actorPrincipalId: "00000000-0000-4000-8000-000000000099",
        payload: { reason: "user requested" },
      }),
    ]);
    expect(out?.status).toBe("cancelled");
    expect(out?.cancelledByUserId).toBe("00000000-0000-4000-8000-000000000099");
    expect(out?.cancelledReason).toBe("user requested");
  });
});

describe("projectInstance — suspend/resume", () => {
  it("instance_suspended captures reason", () => {
    const out = projectInstance([
      startEvent(),
      event({
        kind: "instance_suspended",
        sequenceNumber: 1,
        payload: { reason: "maintenance" },
      }),
    ]);
    expect(out?.status).toBe("suspended");
    expect(out?.suspendedReason).toBe("maintenance");
  });

  it("instance_resumed clears the suspend fields", () => {
    const out = projectInstance([
      startEvent(),
      event({ kind: "instance_suspended", sequenceNumber: 1, payload: { reason: "x" } }),
      event({ kind: "instance_resumed", sequenceNumber: 2 }),
    ]);
    expect(out?.status).toBe("running");
    expect(out?.suspendedAt).toBeNull();
    expect(out?.suspendedReason).toBeNull();
  });
});

describe("projectInstance — activity waits", () => {
  it("activity_scheduled puts instance into waiting_for_activity", () => {
    const out = projectInstance([
      startEvent(),
      event({
        kind: "activity_scheduled",
        sequenceNumber: 1,
        activityId: "wfa_act00001",
      }),
    ]);
    expect(out?.status).toBe("waiting_for_activity");
    expect(out?.awaitingActivityIds).toEqual(["wfa_act00001"]);
  });

  it("activity_completed clears the waiting activity and resumes running", () => {
    const out = projectInstance([
      startEvent(),
      event({ kind: "activity_scheduled", sequenceNumber: 1, activityId: "wfa_act00001" }),
      event({ kind: "activity_completed", sequenceNumber: 2, activityId: "wfa_act00001" }),
    ]);
    expect(out?.status).toBe("running");
    expect(out?.awaitingActivityIds).toEqual([]);
  });

  it("activity_failed clears the waiting activity", () => {
    const out = projectInstance([
      startEvent(),
      event({ kind: "activity_scheduled", sequenceNumber: 1, activityId: "wfa_act00001" }),
      event({
        kind: "activity_failed",
        sequenceNumber: 2,
        activityId: "wfa_act00001",
        payload: { errorCode: "X", errorMessage: "boom" },
      }),
    ]);
    expect(out?.awaitingActivityIds).toEqual([]);
  });
});

describe("projectInstance — timer waits", () => {
  it("timer_scheduled puts instance into waiting_for_timer", () => {
    const out = projectInstance([
      startEvent(),
      event({
        kind: "timer_scheduled",
        sequenceNumber: 1,
        timerId: "wft_tim00001",
        payload: { timerName: "approval_deadline" },
      }),
    ]);
    expect(out?.status).toBe("waiting_for_timer");
    expect(out?.awaitingTimerNames).toContain("approval_deadline");
  });

  it("timer_fired clears the waiting timer", () => {
    const out = projectInstance([
      startEvent(),
      event({
        kind: "timer_scheduled",
        sequenceNumber: 1,
        timerId: "wft_tim00001",
        payload: { timerName: "deadline" },
      }),
      event({
        kind: "timer_fired",
        sequenceNumber: 2,
        timerId: "wft_tim00001",
        payload: { timerName: "deadline" },
      }),
    ]);
    expect(out?.status).toBe("running");
    expect(out?.awaitingTimerNames).toEqual([]);
  });
});

describe("projectInstance — variables", () => {
  it("variable_updated overlays a single variable", () => {
    const out = projectInstance([
      startEvent({ variables: { amount: 100, currency: "USD" } }),
      event({
        kind: "variable_updated",
        sequenceNumber: 1,
        variableName: "amount",
        payload: { newValue: 250 },
      }),
    ]);
    expect(out?.variables).toEqual({ amount: 250, currency: "USD" });
  });
});

describe("projectInstance — compensation", () => {
  it("compensation_started + completed flow", () => {
    const out = projectInstance([
      startEvent(),
      event({
        kind: "instance_failed",
        sequenceNumber: 1,
        payload: { errorCode: "X", errorMessage: "y" },
      }),
      event({
        kind: "compensation_started",
        sequenceNumber: 2,
        occurredAt: "2026-05-16T13:00:00.000Z",
      }),
      event({
        kind: "compensation_completed",
        sequenceNumber: 3,
        occurredAt: "2026-05-16T13:01:00.000Z",
      }),
    ]);
    expect(out?.status).toBe("compensated");
    expect(out?.compensationStartedAt).toBe("2026-05-16T13:00:00.000Z");
    expect(out?.compensationCompletedAt).toBe("2026-05-16T13:01:00.000Z");
  });
});

describe("projectActivities", () => {
  it("emits one activity per activity_scheduled event", () => {
    const acts = projectActivities([
      startEvent(),
      event({
        kind: "activity_scheduled",
        sequenceNumber: 1,
        activityId: "wfa_act00001",
        payload: { kind: "http_call", definitionActivityKey: "post_invoice" },
      }),
      event({ kind: "activity_started", sequenceNumber: 2, activityId: "wfa_act00001" }),
      event({
        kind: "activity_completed",
        sequenceNumber: 3,
        activityId: "wfa_act00001",
        payload: { outputSha256: "a".repeat(64) },
      }),
    ]);
    expect(acts).toHaveLength(1);
    expect(acts[0]?.id).toBe("wfa_act00001");
    expect(acts[0]?.kind).toBe("http_call");
    expect(acts[0]?.status).toBe("succeeded");
    expect(acts[0]?.outputSha256).toBe("a".repeat(64));
  });

  it("marks failed activities and captures error", () => {
    const acts = projectActivities([
      event({
        kind: "activity_scheduled",
        sequenceNumber: 1,
        activityId: "wfa_act00002",
        payload: { kind: "http_call" },
      }),
      event({
        kind: "activity_failed",
        sequenceNumber: 2,
        activityId: "wfa_act00002",
        payload: { errorCode: "503", errorMessage: "service unavailable" },
      }),
    ]);
    expect(acts[0]?.status).toBe("failed");
    expect(acts[0]?.errorCode).toBe("503");
  });
});

describe("projectSignals", () => {
  it("captures received + consumed transitions", () => {
    const sigs = projectSignals([
      event({
        kind: "signal_received",
        sequenceNumber: 1,
        signalId: "wfs_sig00001",
        payload: { signalName: "external.approve", correlationKey: "po-1" },
      }),
      event({
        kind: "signal_consumed",
        sequenceNumber: 2,
        signalId: "wfs_sig00001",
        payload: { signalName: "external.approve" },
      }),
    ]);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]?.status).toBe("consumed");
    expect(sigs[0]?.signalName).toBe("external.approve");
  });
});

describe("projectTimers", () => {
  it("captures scheduled + fired transitions", () => {
    const tims = projectTimers([
      event({
        kind: "timer_scheduled",
        sequenceNumber: 1,
        timerId: "wft_tim00001",
        payload: { timerName: "deadline", fireAt: "2026-05-17T00:00:00.000Z" },
      }),
      event({
        kind: "timer_fired",
        sequenceNumber: 2,
        timerId: "wft_tim00001",
        payload: { timerName: "deadline" },
      }),
    ]);
    expect(tims).toHaveLength(1);
    expect(tims[0]?.status).toBe("fired");
    expect(tims[0]?.fireAt).toBe("2026-05-17T00:00:00.000Z");
  });
});

describe("projectInstance — cancellation", () => {
  const CANCEL_REQUEST = { reason: "buyer withdrew", disposition: "abandon" };

  it("leaves the cancellation fields null for an instance nobody cancelled", () => {
    const p = projectInstance([startEvent()])!;
    expect(p.cancellationRequestedAt).toBeNull();
    expect(p.cancellationRequestedBy).toBeNull();
    expect(p.cancellationDisposition).toBeNull();
    expect(p.cancellationSignalledActivityIds).toEqual([]);
    expect(isInstanceCancelled(p)).toBe(false);
    expect(isInstanceCancellationRequested(p)).toBe(false);
  });

  it("records the request without moving the status off where the instance stood", () => {
    const p = projectInstance([
      startEvent(),
      event({
        kind: "instance_cancellation_requested",
        sequenceNumber: 1,
        occurredAt: "2026-05-16T12:30:00.000Z",
        actorPrincipalId: "22222222-2222-2222-2222-222222222222",
        payload: CANCEL_REQUEST,
      }),
    ])!;
    expect(p.status).toBe("running");
    expect(p.cancellationRequestedAt).toBe("2026-05-16T12:30:00.000Z");
    expect(p.cancellationRequestedBy).toBe("22222222-2222-2222-2222-222222222222");
    expect(p.cancellationDisposition).toBe("abandon");
    // Already fenced, even though the status still says running.
    expect(isInstanceCancellationRequested(p)).toBe(true);
    expect(isInstanceCancelled(p)).toBe(false);
  });

  it("falls back to the requesting system when no principal asked", () => {
    const p = projectInstance([
      startEvent(),
      event({
        kind: "instance_cancellation_requested",
        sequenceNumber: 1,
        actorSystemId: "tenant-lifecycle",
        payload: CANCEL_REQUEST,
      }),
    ])!;
    expect(p.cancellationRequestedBy).toBe("tenant-lifecycle");
  });

  it("reads an unrecognised disposition as null rather than as either answer", () => {
    const p = projectInstance([
      startEvent(),
      event({
        kind: "instance_cancellation_requested",
        sequenceNumber: 1,
        payload: { reason: "r", disposition: "roll_back_everything" },
      }),
    ])!;
    expect(p.cancellationDisposition).toBeNull();
    // The fence does not depend on it, so a payload edit cannot unfence the instance.
    expect(isInstanceCancellationRequested(p)).toBe(true);
  });

  it("fences an instance_cancelled that arrived with no request event", () => {
    const p = projectInstance([
      startEvent(),
      event({ kind: "instance_cancelled", sequenceNumber: 1, payload: { reason: "terminal state" } }),
    ])!;
    expect(p.cancellationRequestedAt).toBeNull();
    expect(isInstanceCancellationRequested(p)).toBe(true);
    expect(isInstanceCancelled(p)).toBe(true);
  });

  it("collects the activities told to stop, and only those", () => {
    const p = projectInstance([
      startEvent(),
      event({ kind: "activity_scheduled", sequenceNumber: 1, activityId: "wfa_00000001", payload: {} }),
      event({ kind: "activity_scheduled", sequenceNumber: 2, activityId: "wfa_00000002", payload: {} }),
      event({ kind: "activity_started", sequenceNumber: 3, activityId: "wfa_00000002" }),
      event({ kind: "instance_cancellation_requested", sequenceNumber: 4, payload: CANCEL_REQUEST }),
      event({
        kind: "activity_cancelled",
        sequenceNumber: 5,
        activityId: "wfa_00000001",
        payload: { checkpoint: "before_handler", signalDelivered: false },
      }),
      event({
        kind: "activity_cancelled",
        sequenceNumber: 6,
        activityId: "wfa_00000002",
        payload: { checkpoint: "cooperative_abort", signalDelivered: true },
      }),
    ])!;
    expect(p.cancellationSignalledActivityIds).toEqual(["wfa_00000002"]);
    // Both stop being awaited, whichever checkpoint they were cancelled at.
    expect(p.awaitingActivityIds).toEqual([]);
  });

  it("seals the status: a late activity_completed does not resurrect the instance", () => {
    const p = projectInstance([
      startEvent(),
      event({ kind: "activity_scheduled", sequenceNumber: 1, activityId: "wfa_00000001", payload: {} }),
      event({ kind: "activity_started", sequenceNumber: 2, activityId: "wfa_00000001" }),
      event({ kind: "instance_cancellation_requested", sequenceNumber: 3, payload: CANCEL_REQUEST }),
      event({
        kind: "activity_cancelled",
        sequenceNumber: 4,
        activityId: "wfa_00000001",
        payload: { checkpoint: "cooperative_abort", signalDelivered: true },
      }),
      event({ kind: "instance_cancelled", sequenceNumber: 5, payload: CANCEL_REQUEST }),
      event({
        kind: "activity_completed",
        sequenceNumber: 6,
        activityId: "wfa_00000001",
        payload: { outputSha256: "abc" },
      }),
    ])!;
    expect(p.status).toBe("cancelled");
    expect(p.sequenceCursor).toBe(6);
  });

  it("seals the status against every later status-moving event kind", () => {
    const later: readonly WorkflowEvent[] = [
      event({ kind: "state_transitioned", sequenceNumber: 2, previousState: "draft", newState: "next", payload: {} }),
      event({ kind: "instance_completed", sequenceNumber: 3, payload: {} }),
      event({ kind: "instance_resumed", sequenceNumber: 4, payload: {} }),
      event({ kind: "instance_suspended", sequenceNumber: 5, payload: { reason: "r" } }),
      event({ kind: "instance_failed", sequenceNumber: 6, payload: { errorCode: "E", errorMessage: "m" } }),
      event({ kind: "compensation_started", sequenceNumber: 7, payload: {} }),
      event({ kind: "compensation_completed", sequenceNumber: 8, payload: {} }),
      event({ kind: "timer_scheduled", sequenceNumber: 9, timerId: "wft_00000001", payload: { timerName: "t" } }),
      event({ kind: "activity_scheduled", sequenceNumber: 10, activityId: "wfa_00000009", payload: {} }),
    ];
    const p = projectInstance([
      startEvent(),
      event({ kind: "instance_cancelled", sequenceNumber: 1, payload: CANCEL_REQUEST }),
      ...later,
    ])!;
    expect(p.status).toBe("cancelled");
  });

  it("re-folds to the same answer from the same log", () => {
    const events = [
      startEvent(),
      event({ kind: "instance_cancellation_requested", sequenceNumber: 1, payload: CANCEL_REQUEST }),
      event({ kind: "instance_cancelled", sequenceNumber: 2, payload: CANCEL_REQUEST }),
    ];
    expect(projectInstance(events)).toEqual(projectInstance([...events]));
  });
});

describe("projectActivities — cancellation", () => {
  it("marks an activity cancelled", () => {
    const acts = projectActivities([
      event({ kind: "activity_scheduled", sequenceNumber: 1, activityId: "wfa_00000001", payload: {} }),
      event({
        kind: "activity_cancelled",
        sequenceNumber: 2,
        activityId: "wfa_00000001",
        payload: { checkpoint: "before_handler", signalDelivered: false },
      }),
    ]);
    expect(acts[0]?.status).toBe("cancelled");
  });

  it("keeps a cancelled activity cancelled when its handler reports success anyway", () => {
    // ADR-0315's promise verbatim: a handler which ignores the signal still lands as `cancelled`
    // rather than `completed` — while the output it produced is still recorded.
    const acts = projectActivities([
      event({ kind: "activity_scheduled", sequenceNumber: 1, activityId: "wfa_00000001", payload: {} }),
      event({ kind: "activity_started", sequenceNumber: 2, activityId: "wfa_00000001" }),
      event({
        kind: "activity_cancelled",
        sequenceNumber: 3,
        activityId: "wfa_00000001",
        payload: { checkpoint: "cooperative_abort", signalDelivered: true },
      }),
      event({
        kind: "activity_completed",
        sequenceNumber: 4,
        activityId: "wfa_00000001",
        payload: { outputSha256: "deadbeef" },
      }),
    ]);
    expect(acts[0]?.status).toBe("cancelled");
    expect(acts[0]?.outputSha256).toBe("deadbeef");
    expect(acts[0]?.completedAt).toBe("2026-05-16T12:00:00.000Z");
  });

  it("keeps a cancelled activity cancelled when its handler fails or times out instead", () => {
    for (const kind of ["activity_failed", "activity_timed_out"] as const) {
      const acts = projectActivities([
        event({ kind: "activity_scheduled", sequenceNumber: 1, activityId: "wfa_00000001", payload: {} }),
        event({ kind: "activity_started", sequenceNumber: 2, activityId: "wfa_00000001" }),
        event({
          kind: "activity_cancelled",
          sequenceNumber: 3,
          activityId: "wfa_00000001",
          payload: { checkpoint: "cooperative_abort", signalDelivered: true },
        }),
        event({ kind, sequenceNumber: 4, activityId: "wfa_00000001", payload: { errorCode: "E", errorMessage: "m" } }),
      ]);
      expect(acts[0]?.status, kind).toBe("cancelled");
    }
  });

  it("still lets a cancelled activity be compensated, which the saga planner depends on", () => {
    const acts = projectActivities([
      event({ kind: "activity_scheduled", sequenceNumber: 1, activityId: "wfa_00000001", payload: {} }),
      event({
        kind: "activity_cancelled",
        sequenceNumber: 2,
        activityId: "wfa_00000001",
        payload: { checkpoint: "cooperative_abort", signalDelivered: true },
      }),
      event({ kind: "activity_compensated", sequenceNumber: 3, activityId: "wfa_00000001", payload: {} }),
    ]);
    expect(acts[0]?.status).toBe("compensated");
  });
});
