import { TIMER_KINDS, type WorkflowDefinition, type WorkflowEvent } from "@crossengin/workflow-engine";
import { describe, expect, it } from "vitest";

import {
  TIMER_PROVENANCE_DEFECTS,
  TimerProvenanceUnresolved,
  projectPersistableTimers,
  resolveTimerProvenance,
} from "./timer-provenance.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: "wfd_def00001",
    tenantId: null,
    definitionKey: "purchase.approval",
    version: "1.0.0",
    label: "Purchase approval",
    description: "",
    status: "published",
    states: [
      { name: "draft", kind: "initial", label: "D", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "awaiting", kind: "waiting", label: "W", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "approved", kind: "terminal_success", label: "A", onEntryActions: [], onExitActions: [], slaSeconds: null },
    ],
    transitions: [
      {
        name: "expire",
        fromState: "awaiting",
        toState: "approved",
        trigger: { kind: "timer_fired", timerName: "approval_deadline" },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      },
    ],
    variables: [],
    timers: [
      {
        name: "approval_deadline",
        kind: "relative_after",
        relativeSeconds: 86_400,
        absoluteTimestampVariable: null,
        cronExpression: null,
        timezone: "UTC",
      },
    ],
    signals: [],
    initialState: "draft",
    compensationStrategy: "no_compensation",
    timeoutSeconds: 86_400,
    createdAt: "2026-05-01T00:00:00.000Z",
    createdBy: "00000000-0000-4000-8000-000000000099",
    publishedAt: "2026-05-01T00:00:00.000Z",
    publishedBy: "00000000-0000-4000-8000-000000000098",
    deprecatedAt: null,
    supersededByDefinitionId: null,
    sourceManifestSha256: null,
    ...overrides,
  };
}

function baseEvent(overrides: Partial<WorkflowEvent>): WorkflowEvent {
  return {
    id: "wfe_event0001",
    instanceId: "wfi_inst0001",
    tenantId: TENANT,
    sequenceNumber: 0,
    kind: "instance_started",
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
    ...overrides,
  };
}

function startedEvent(): WorkflowEvent {
  return baseEvent({
    payload: {
      definitionId: "wfd_def00001",
      definitionKey: "purchase.approval",
      definitionVersion: "1.0.0",
      initialState: "draft",
      variables: {},
      timeoutAt: "2026-05-17T12:00:00.000Z",
    },
  });
}

function scheduledTimer(name = "approval_deadline"): WorkflowEvent {
  return baseEvent({
    id: "wfe_event0002",
    sequenceNumber: 1,
    kind: "timer_scheduled",
    timerId: "wft_tim00001",
    payload: { timerName: name, fireAt: "2026-05-17T12:00:00.000Z" },
  });
}

function firedTimer(name = "approval_deadline"): WorkflowEvent {
  return baseEvent({
    id: "wfe_event0003",
    sequenceNumber: 2,
    kind: "timer_fired",
    occurredAt: "2026-05-17T12:00:00.000Z",
    timerId: "wft_tim00001",
    payload: { timerName: name },
  });
}

describe("TIMER_PROVENANCE_DEFECTS", () => {
  it("names three defects", () => {
    expect(TIMER_PROVENANCE_DEFECTS).toEqual([
      "definition_unavailable",
      "timer_undeclared",
      "cron_next_fire_unresolved",
    ]);
  });

  it("has no duplicates", () => {
    expect(new Set(TIMER_PROVENANCE_DEFECTS).size).toBe(TIMER_PROVENANCE_DEFECTS.length);
  });
});

describe("resolveTimerProvenance", () => {
  const base = {
    timerId: "wft_tim00001",
    timerName: "approval_deadline",
    status: "scheduled" as const,
    fireCount: 0,
  };

  it("reads the declared kind off the definition", () => {
    expect(resolveTimerProvenance({ ...base, definition: definition() }).kind).toBe(
      "relative_after",
    );
  });

  it("carries the kind's parameter with it", () => {
    const resolved = resolveTimerProvenance({ ...base, definition: definition() });
    expect(resolved.relativeSeconds).toBe(86_400);
    expect(resolved.cronExpression).toBeNull();
  });

  it("carries a cron expression for a cron_schedule timer", () => {
    const resolved = resolveTimerProvenance({
      ...base,
      definition: definition({
        timers: [
          {
            name: "approval_deadline",
            kind: "cron_schedule",
            relativeSeconds: null,
            absoluteTimestampVariable: null,
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          },
        ],
      }),
    });
    expect(resolved.kind).toBe("cron_schedule");
    expect(resolved.cronExpression).toBe("0 9 * * *");
  });

  it("carries the declared timezone rather than UTC", () => {
    const resolved = resolveTimerProvenance({
      ...base,
      definition: definition({
        timers: [
          {
            name: "approval_deadline",
            kind: "business_hours",
            relativeSeconds: null,
            absoluteTimestampVariable: null,
            cronExpression: null,
            timezone: "Asia/Tokyo",
          },
        ],
      }),
    });
    expect(resolved.timezone).toBe("Asia/Tokyo");
  });

  it("resolves every TIMER_KINDS member the definition can declare", () => {
    for (const kind of TIMER_KINDS) {
      if (kind === "cron_schedule") continue;
      const resolved = resolveTimerProvenance({
        ...base,
        definition: definition({
          timers: [
            {
              name: "approval_deadline",
              kind,
              relativeSeconds: kind === "relative_after" ? 60 : null,
              absoluteTimestampVariable: kind === "absolute_at" ? "deadline" : null,
              cronExpression: null,
              timezone: "UTC",
            },
          ],
        }),
      });
      expect(resolved.kind).toBe(kind);
    }
  });

  it("names the transition whose timer_fired trigger owns the timer", () => {
    expect(
      resolveTimerProvenance({ ...base, definition: definition() }).transitionToTrigger,
    ).toBe("expire");
  });

  it("answers null when no transition waits on the timer", () => {
    expect(
      resolveTimerProvenance({ ...base, definition: definition({ transitions: [
        {
          name: "submit",
          fromState: "draft",
          toState: "approved",
          trigger: { kind: "automatic" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ] }) }).transitionToTrigger,
    ).toBeNull();
  });

  it("answers null when several transitions wait on the timer, since guards decide at fire time", () => {
    const twoWaiters = definition({
      transitions: [
        {
          name: "escalate",
          fromState: "awaiting",
          toState: "approved",
          trigger: { kind: "timer_fired", timerName: "approval_deadline" },
          guards: [{ kind: "always_true" }],
          preTransitionActions: [],
          postTransitionActions: [],
        },
        {
          name: "expire",
          fromState: "awaiting",
          toState: "approved",
          trigger: { kind: "timer_fired", timerName: "approval_deadline" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
    });
    expect(resolveTimerProvenance({ ...base, definition: twoWaiters }).transitionToTrigger).toBeNull();
  });

  it("ignores a transition waiting on a different timer", () => {
    const other = definition({
      transitions: [
        {
          name: "other",
          fromState: "awaiting",
          toState: "approved",
          trigger: { kind: "timer_fired", timerName: "other_deadline" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
      timers: [
        {
          name: "approval_deadline",
          kind: "relative_after",
          relativeSeconds: 60,
          absoluteTimestampVariable: null,
          cronExpression: null,
          timezone: "UTC",
        },
        {
          name: "other_deadline",
          kind: "relative_after",
          relativeSeconds: 60,
          absoluteTimestampVariable: null,
          cronExpression: null,
          timezone: "UTC",
        },
      ],
    });
    expect(resolveTimerProvenance({ ...base, definition: other }).transitionToTrigger).toBeNull();
  });

  it("refuses definition_unavailable rather than guessing a kind", () => {
    expect(() => resolveTimerProvenance({ ...base, definition: undefined })).toThrow(
      TimerProvenanceUnresolved,
    );
    try {
      resolveTimerProvenance({ ...base, definition: undefined });
    } catch (err) {
      expect((err as TimerProvenanceUnresolved).defect).toBe("definition_unavailable");
      expect((err as TimerProvenanceUnresolved).timerId).toBe("wft_tim00001");
    }
  });

  it("refuses timer_undeclared when the definition declares no such timer", () => {
    try {
      resolveTimerProvenance({ ...base, definition: definition({ timers: [] }) });
      expect.unreachable();
    } catch (err) {
      expect((err as TimerProvenanceUnresolved).defect).toBe("timer_undeclared");
      expect((err as TimerProvenanceUnresolved).timerName).toBe("approval_deadline");
    }
  });

  it("names the defect and the timer in the message", () => {
    try {
      resolveTimerProvenance({ ...base, definition: definition({ timers: [] }) });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("timer_undeclared");
      expect((err as Error).message).toContain("wft_tim00001");
    }
  });

  it("accepts a scheduled cron timer — only a fired one is unresolvable", () => {
    const cron = definition({
      timers: [
        {
          name: "approval_deadline",
          kind: "cron_schedule",
          relativeSeconds: null,
          absoluteTimestampVariable: null,
          cronExpression: "0 9 * * *",
          timezone: "UTC",
        },
      ],
    });
    expect(resolveTimerProvenance({ ...base, definition: cron }).kind).toBe("cron_schedule");
  });

  it("refuses cron_next_fire_unresolved for a fired cron timer", () => {
    const cron = definition({
      timers: [
        {
          name: "approval_deadline",
          kind: "cron_schedule",
          relativeSeconds: null,
          absoluteTimestampVariable: null,
          cronExpression: "0 9 * * *",
          timezone: "UTC",
        },
      ],
    });
    try {
      resolveTimerProvenance({ ...base, status: "fired", fireCount: 1, definition: cron });
      expect.unreachable();
    } catch (err) {
      expect((err as TimerProvenanceUnresolved).defect).toBe("cron_next_fire_unresolved");
    }
  });

  it("does not refuse a fired non-cron timer", () => {
    expect(
      resolveTimerProvenance({ ...base, status: "fired", fireCount: 1, definition: definition() })
        .kind,
    ).toBe("relative_after");
  });

  it("does not refuse a cancelled cron timer", () => {
    const cron = definition({
      timers: [
        {
          name: "approval_deadline",
          kind: "cron_schedule",
          relativeSeconds: null,
          absoluteTimestampVariable: null,
          cronExpression: "0 9 * * *",
          timezone: "UTC",
        },
      ],
    });
    expect(
      resolveTimerProvenance({ ...base, status: "cancelled", definition: cron }).kind,
    ).toBe("cron_schedule");
  });
});

describe("projectPersistableTimers", () => {
  it("produces a complete projection for a scheduled timer", () => {
    const [timer] = projectPersistableTimers(
      [startedEvent(), scheduledTimer()],
      definition(),
    );
    expect(timer).toMatchObject({
      id: "wft_tim00001",
      timerName: "approval_deadline",
      kind: "relative_after",
      status: "scheduled",
      timezone: "UTC",
      relativeSeconds: 86_400,
      cronExpression: null,
      transitionToTrigger: "expire",
      fireCount: 0,
    });
  });

  it("counts a fire rather than flagging it", () => {
    const [timer] = projectPersistableTimers(
      [startedEvent(), scheduledTimer(), firedTimer()],
      definition(),
    );
    expect(timer?.status).toBe("fired");
    expect(timer?.fireCount).toBe(1);
    expect(timer?.firedAt).toBe("2026-05-17T12:00:00.000Z");
  });

  it("answers [] for a log with no timers, so an empty log never refuses", () => {
    expect(projectPersistableTimers([startedEvent()], undefined)).toEqual([]);
  });

  it("refuses once a timer is present and the definition is not", () => {
    expect(() => projectPersistableTimers([startedEvent(), scheduledTimer()], undefined)).toThrow(
      TimerProvenanceUnresolved,
    );
  });

  it("refuses a timer the definition does not declare", () => {
    expect(() =>
      projectPersistableTimers([startedEvent(), scheduledTimer("mystery")], definition()),
    ).toThrow(/timer_undeclared/);
  });
});
