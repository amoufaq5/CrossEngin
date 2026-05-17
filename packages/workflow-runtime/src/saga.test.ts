import type { WorkflowDefinition, WorkflowEvent } from "@crossengin/workflow-engine";
import { describe, expect, it } from "vitest";

import {
  hasOutstandingCompensation,
  listCompensatableActivities,
  planCompensation,
} from "./saga.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function definitionFixture(
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    id: "wfd_def00001",
    tenantId: null,
    definitionKey: "purchase.approval",
    version: "1.0.0",
    label: "L",
    description: "",
    status: "published",
    states: [
      { name: "start", kind: "initial", label: "S", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "end", kind: "terminal_success", label: "E", onEntryActions: [], onExitActions: [], slaSeconds: null },
    ],
    transitions: [
      {
        name: "go",
        fromState: "start",
        toState: "end",
        trigger: { kind: "automatic" },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      },
    ],
    variables: [],
    timers: [],
    signals: [],
    initialState: "start",
    compensationStrategy: "immediate_reverse_order",
    timeoutSeconds: 86_400,
    createdAt: "2026-05-01T00:00:00.000Z",
    createdBy: "00000000-0000-4000-8000-000000000099",
    publishedAt: "2026-05-01T00:00:00.000Z",
    publishedBy: "00000000-0000-4000-8000-000000000099",
    deprecatedAt: null,
    supersededByDefinitionId: null,
    sourceManifestSha256: null,
    ...overrides,
  };
}

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

describe("listCompensatableActivities", () => {
  it("returns no activities when none scheduled", () => {
    expect(listCompensatableActivities([])).toEqual([]);
  });

  it("returns side-effect activities that completed and have not been compensated", () => {
    const out = listCompensatableActivities([
      event({
        kind: "activity_scheduled",
        sequenceNumber: 0,
        activityId: "wfa_act00001",
        payload: { kind: "http_call", definitionActivityKey: "charge_card", compensationActivityKey: "refund_card" },
      }),
      event({
        kind: "activity_completed",
        sequenceNumber: 1,
        activityId: "wfa_act00001",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.activityId).toBe("wfa_act00001");
    expect(out[0]?.compensationActivityKey).toBe("refund_card");
  });

  it("excludes already-compensated activities", () => {
    const out = listCompensatableActivities([
      event({
        kind: "activity_scheduled",
        sequenceNumber: 0,
        activityId: "wfa_act00001",
        payload: { kind: "http_call", compensationActivityKey: "refund" },
      }),
      event({ kind: "activity_completed", sequenceNumber: 1, activityId: "wfa_act00001" }),
      event({ kind: "activity_compensated", sequenceNumber: 2, activityId: "wfa_act00001" }),
    ]);
    expect(out).toEqual([]);
  });

  it("excludes idempotent activity kinds (db_read, transformation, audit_emit)", () => {
    const out = listCompensatableActivities([
      event({
        kind: "activity_scheduled",
        sequenceNumber: 0,
        activityId: "wfa_act00001",
        payload: { kind: "db_read", compensationActivityKey: "noop" },
      }),
      event({ kind: "activity_completed", sequenceNumber: 1, activityId: "wfa_act00001" }),
      event({
        kind: "activity_scheduled",
        sequenceNumber: 2,
        activityId: "wfa_act00002",
        payload: { kind: "transformation", compensationActivityKey: "noop" },
      }),
      event({ kind: "activity_completed", sequenceNumber: 3, activityId: "wfa_act00002" }),
    ]);
    expect(out).toEqual([]);
  });

  it("includes side-effect kinds (http_call, db_write, ai_call, send_notification, child_workflow)", () => {
    const kinds = ["http_call", "db_write", "ai_call", "send_notification", "child_workflow"] as const;
    const events: WorkflowEvent[] = [];
    let seq = 0;
    for (let i = 0; i < kinds.length; i++) {
      const activityId = `wfa_act0000${(i + 1).toString()}`;
      events.push(
        event({
          kind: "activity_scheduled",
          sequenceNumber: seq++,
          activityId,
          payload: { kind: kinds[i]!, compensationActivityKey: `comp_${i.toString()}` },
        }),
      );
      events.push(event({ kind: "activity_completed", sequenceNumber: seq++, activityId }));
    }
    expect(listCompensatableActivities(events)).toHaveLength(kinds.length);
  });
});

describe("planCompensation", () => {
  it("returns an empty plan for no_compensation strategy", () => {
    const plan = planCompensation({
      definition: definitionFixture({ compensationStrategy: "no_compensation" }),
      events: [
        event({
          kind: "activity_scheduled",
          sequenceNumber: 0,
          activityId: "wfa_act00001",
          payload: { kind: "http_call", compensationActivityKey: "refund" },
        }),
        event({ kind: "activity_completed", sequenceNumber: 1, activityId: "wfa_act00001" }),
      ],
    });
    expect(plan.steps).toEqual([]);
    expect(plan.strategy).toBe("no_compensation");
  });

  it("reverses order for immediate_reverse_order", () => {
    const plan = planCompensation({
      definition: definitionFixture({ compensationStrategy: "immediate_reverse_order" }),
      events: [
        event({
          kind: "activity_scheduled",
          sequenceNumber: 0,
          activityId: "wfa_act00001",
          payload: { kind: "http_call", compensationActivityKey: "refund_1" },
        }),
        event({ kind: "activity_completed", sequenceNumber: 1, activityId: "wfa_act00001" }),
        event({
          kind: "activity_scheduled",
          sequenceNumber: 2,
          activityId: "wfa_act00002",
          payload: { kind: "db_write", compensationActivityKey: "undo_2" },
        }),
        event({ kind: "activity_completed", sequenceNumber: 3, activityId: "wfa_act00002" }),
      ],
    });
    expect(plan.steps.map((s) => s.compensationActivityKey)).toEqual(["undo_2", "refund_1"]);
  });

  it("keeps insertion order for parallel strategy", () => {
    const plan = planCompensation({
      definition: definitionFixture({ compensationStrategy: "parallel" }),
      events: [
        event({
          kind: "activity_scheduled",
          sequenceNumber: 0,
          activityId: "wfa_act00001",
          payload: { kind: "http_call", compensationActivityKey: "refund_1" },
        }),
        event({ kind: "activity_completed", sequenceNumber: 1, activityId: "wfa_act00001" }),
        event({
          kind: "activity_scheduled",
          sequenceNumber: 2,
          activityId: "wfa_act00002",
          payload: { kind: "db_write", compensationActivityKey: "undo_2" },
        }),
        event({ kind: "activity_completed", sequenceNumber: 3, activityId: "wfa_act00002" }),
      ],
    });
    expect(plan.steps.map((s) => s.compensationActivityKey)).toEqual(["refund_1", "undo_2"]);
  });

  it("omits activities without a compensationActivityKey", () => {
    const plan = planCompensation({
      definition: definitionFixture(),
      events: [
        event({
          kind: "activity_scheduled",
          sequenceNumber: 0,
          activityId: "wfa_act00001",
          payload: { kind: "http_call" },
        }),
        event({ kind: "activity_completed", sequenceNumber: 1, activityId: "wfa_act00001" }),
      ],
    });
    expect(plan.steps).toEqual([]);
  });

  it("reports manual_review strategy without auto-stepping", () => {
    const plan = planCompensation({
      definition: definitionFixture({ compensationStrategy: "manual_review" }),
      events: [
        event({
          kind: "activity_scheduled",
          sequenceNumber: 0,
          activityId: "wfa_act00001",
          payload: { kind: "http_call", compensationActivityKey: "refund" },
        }),
        event({ kind: "activity_completed", sequenceNumber: 1, activityId: "wfa_act00001" }),
      ],
    });
    expect(plan.strategy).toBe("manual_review");
    expect(plan.steps).toHaveLength(1);
  });
});

describe("hasOutstandingCompensation", () => {
  it("returns false on empty event list", () => {
    expect(hasOutstandingCompensation([])).toBe(false);
  });

  it("returns true when at least one side-effect activity completed", () => {
    expect(
      hasOutstandingCompensation([
        event({
          kind: "activity_scheduled",
          sequenceNumber: 0,
          activityId: "wfa_act00001",
          payload: { kind: "http_call" },
        }),
        event({ kind: "activity_completed", sequenceNumber: 1, activityId: "wfa_act00001" }),
      ]),
    ).toBe(true);
  });

  it("returns false when the activity is fully compensated", () => {
    expect(
      hasOutstandingCompensation([
        event({
          kind: "activity_scheduled",
          sequenceNumber: 0,
          activityId: "wfa_act00001",
          payload: { kind: "http_call" },
        }),
        event({ kind: "activity_completed", sequenceNumber: 1, activityId: "wfa_act00001" }),
        event({ kind: "activity_compensated", sequenceNumber: 2, activityId: "wfa_act00001" }),
      ]),
    ).toBe(false);
  });
});
