import type { WorkflowDefinition } from "@crossengin/workflow-engine";
import { describe, expect, it } from "vitest";

import type { ActivityRegistry } from "./activity-handlers.js";
import { createDefaultRegistry, type ActivityHandler } from "./activity-handlers.js";
import { CountingIdGenerator, FixedClock } from "./clock.js";
import { InMemoryEventLog } from "./event-log.js";
import { WorkflowEngine } from "./engine.js";
import {
  WORKFLOW_INSTRUMENTATION_KINDS,
  captureInstrumentation,
  type WorkflowInstrumentation,
} from "./instrumentation.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000099";

function definitionFixture(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  const base: WorkflowDefinition = {
    id: "wfd_def00001",
    tenantId: null,
    definitionKey: "purchase.approval",
    version: "1.0.0",
    label: "Purchase approval",
    description: "",
    status: "published",
    states: [
      {
        name: "draft",
        kind: "initial",
        label: "Draft",
        onEntryActions: [],
        onExitActions: [],
        slaSeconds: null,
      },
      {
        name: "awaiting_approval",
        kind: "waiting",
        label: "Awaiting",
        onEntryActions: [],
        onExitActions: [],
        slaSeconds: null,
      },
      {
        name: "approved",
        kind: "terminal_success",
        label: "Approved",
        onEntryActions: [],
        onExitActions: [],
        slaSeconds: null,
      },
      {
        name: "rejected",
        kind: "terminal_failure",
        label: "Rejected",
        onEntryActions: [],
        onExitActions: [],
        slaSeconds: null,
      },
    ],
    transitions: [
      {
        name: "submit",
        fromState: "draft",
        toState: "awaiting_approval",
        trigger: { kind: "automatic" },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      },
      {
        name: "approve",
        fromState: "awaiting_approval",
        toState: "approved",
        trigger: { kind: "signal_received", signalName: "approve" },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      },
      {
        name: "reject",
        fromState: "awaiting_approval",
        toState: "rejected",
        trigger: { kind: "signal_received", signalName: "reject" },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      },
      {
        name: "timeout",
        fromState: "awaiting_approval",
        toState: "rejected",
        trigger: { kind: "timer_fired", timerName: "deadline" },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      },
    ],
    variables: [],
    timers: [],
    signals: [],
    initialState: "draft",
    compensationStrategy: "no_compensation",
    timeoutSeconds: 86_400,
    createdAt: "2026-05-01T00:00:00.000Z",
    createdBy: USER,
    publishedAt: "2026-05-01T00:00:00.000Z",
    publishedBy: USER,
    deprecatedAt: null,
    supersededByDefinitionId: null,
    sourceManifestSha256: null,
  };
  return { ...base, ...overrides };
}

function makeEngine(
  opts: {
    readonly definition?: WorkflowDefinition;
    readonly registry?: ActivityRegistry;
    readonly clock?: FixedClock;
    readonly instrumentation?: WorkflowInstrumentation;
  } = {},
) {
  const definition = opts.definition ?? definitionFixture();
  const log = new InMemoryEventLog();
  const clock = opts.clock ?? new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
  const ids = new CountingIdGenerator();
  const registry = opts.registry ?? createDefaultRegistry();
  const engine = new WorkflowEngine({
    eventLog: log,
    definitions: new Map([[definition.id, definition]]),
    activityRegistry: registry,
    clock,
    idGenerator: ids,
    ...(opts.instrumentation !== undefined ? { instrumentation: opts.instrumentation } : {}),
  });
  return { engine, log, clock, definition, ids };
}

describe("startInstance", () => {
  it("emits instance_started + state_transitioned for the automatic initial transition", async () => {
    const { engine, definition } = makeEngine();
    const state = await engine.startInstance({
      definitionId: definition.id,
      tenantId: TENANT,
      startedByUserId: USER,
    });
    expect(state.status).toBe("waiting_for_signal");
    expect(state.currentState).toBe("awaiting_approval");
    const events = await engine.listEvents(state.instanceId);
    expect(events.map((e) => e.kind)).toEqual(["instance_started", "state_transitioned"]);
  });

  it("uses the injected clock for occurredAt", async () => {
    const fixed = new FixedClock(new Date("2026-06-01T00:00:00.000Z"));
    const { engine, definition } = makeEngine({ clock: fixed });
    const state = await engine.startInstance({
      definitionId: definition.id,
      tenantId: TENANT,
    });
    expect(state.startedAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("rejects an unknown definition id", async () => {
    const { engine } = makeEngine();
    await expect(
      engine.startInstance({ definitionId: "wfd_nope0001", tenantId: TENANT }),
    ).rejects.toThrow(/unknown workflow/);
  });

  it("rejects a draft (unpublished) definition", async () => {
    const draft = { ...definitionFixture(), status: "draft" as const };
    const { engine } = makeEngine({ definition: draft });
    await expect(
      engine.startInstance({ definitionId: draft.id, tenantId: TENANT }),
    ).rejects.toThrow(/draft definition|published/);
  });

  it("rejects a cross-tenant start", async () => {
    const def = definitionFixture({ tenantId: TENANT });
    const { engine } = makeEngine({ definition: def });
    await expect(
      engine.startInstance({
        definitionId: def.id,
        tenantId: "00000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toThrow(/belongs to tenant/);
  });

  it("threads initial variables into projection", async () => {
    const { engine, definition } = makeEngine();
    const state = await engine.startInstance({
      definitionId: definition.id,
      tenantId: TENANT,
      variables: { amount: 250 },
    });
    expect(state.variables).toEqual({ amount: 250 });
  });

  it("computes timeoutAt from clock + definition.timeoutSeconds", async () => {
    const fixed = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine, definition } = makeEngine({ clock: fixed });
    const state = await engine.startInstance({
      definitionId: definition.id,
      tenantId: TENANT,
    });
    expect(state.timeoutAt).toBe("2026-05-17T12:00:00.000Z");
  });
});

describe("submitSignal", () => {
  it("advances a waiting instance via a matching signal", async () => {
    const { engine, definition } = makeEngine();
    const state = await engine.startInstance({
      definitionId: definition.id,
      tenantId: TENANT,
      correlationKey: "po-123",
    });
    expect(state.status).toBe("waiting_for_signal");
    const result = await engine.submitSignal({
      signalName: "approve",
      correlationKey: "po-123",
      tenantId: TENANT,
    });
    expect(result.matchedInstanceIds).toEqual([state.instanceId]);
    const finalState = await engine.getInstanceState(state.instanceId);
    expect(finalState?.status).toBe("completed");
    expect(finalState?.currentState).toBe("approved");
    const events = await engine.listEvents(state.instanceId);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("signal_received");
    expect(kinds).toContain("signal_consumed");
    expect(kinds).toContain("instance_completed");
  });

  it("does nothing for a signal with no matching correlation key", async () => {
    const { engine, definition } = makeEngine();
    const state = await engine.startInstance({
      definitionId: definition.id,
      tenantId: TENANT,
      correlationKey: "po-123",
    });
    const result = await engine.submitSignal({
      signalName: "approve",
      correlationKey: "po-999",
      tenantId: TENANT,
    });
    expect(result.matchedInstanceIds).toEqual([]);
    const finalState = await engine.getInstanceState(state.instanceId);
    expect(finalState?.status).toBe("waiting_for_signal");
  });

  it("does not cross tenant boundaries", async () => {
    const { engine, definition } = makeEngine();
    await engine.startInstance({
      definitionId: definition.id,
      tenantId: TENANT,
      correlationKey: "po-1",
    });
    const result = await engine.submitSignal({
      signalName: "approve",
      correlationKey: "po-1",
      tenantId: "00000000-0000-4000-8000-000000000002",
    });
    expect(result.matchedInstanceIds).toEqual([]);
  });

  it("deduplicates exactly_once_idempotent signals", async () => {
    const { engine, definition } = makeEngine();
    await engine.startInstance({
      definitionId: definition.id,
      tenantId: TENANT,
      correlationKey: "po-9",
    });
    const first = await engine.submitSignal({
      signalName: "approve",
      correlationKey: "po-9",
      tenantId: TENANT,
      idempotencyKey: "key-1",
    });
    const second = await engine.submitSignal({
      signalName: "approve",
      correlationKey: "po-9",
      tenantId: TENANT,
      idempotencyKey: "key-1",
    });
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
  });

  it("rejects a transition into rejected (terminal_failure) emits instance_failed", async () => {
    const { engine, definition } = makeEngine();
    const state = await engine.startInstance({
      definitionId: definition.id,
      tenantId: TENANT,
      correlationKey: "po-r",
    });
    await engine.submitSignal({
      signalName: "reject",
      correlationKey: "po-r",
      tenantId: TENANT,
    });
    const finalState = await engine.getInstanceState(state.instanceId);
    expect(finalState?.status).toBe("failed");
    expect(finalState?.currentState).toBe("rejected");
  });
});

describe("tickTimers", () => {
  it("fires a scheduled timer and runs the timer_fired transition", async () => {
    const def: WorkflowDefinition = {
      ...definitionFixture(),
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "awaiting_approval",
          kind: "waiting",
          label: "Awaiting",
          onEntryActions: [
            {
              kind: "schedule_timer",
              parameters: { timerName: "deadline", relativeSeconds: 60 },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "approved",
          kind: "terminal_success",
          label: "Approved",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "rejected",
          kind: "terminal_failure",
          label: "Rejected",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
    };
    const fixed = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine } = makeEngine({ definition: def, clock: fixed });
    const state = await engine.startInstance({
      definitionId: def.id,
      tenantId: TENANT,
    });
    expect(state.status).toBe("waiting_for_timer");
    expect(state.awaitingTimerNames).toContain("deadline");
    fixed.advance(120_000);
    const tick = await engine.tickTimers(fixed.now().getTime());
    expect(tick.firedTimerIds).toHaveLength(1);
    const finalState = await engine.getInstanceState(state.instanceId);
    expect(finalState?.currentState).toBe("rejected");
    expect(finalState?.status).toBe("failed");
  });

  it("does not fire a timer whose fireAt is in the future", async () => {
    const def: WorkflowDefinition = {
      ...definitionFixture(),
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "awaiting_approval",
          kind: "waiting",
          label: "Awaiting",
          onEntryActions: [
            {
              kind: "schedule_timer",
              parameters: { timerName: "deadline", relativeSeconds: 3_600 },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "approved",
          kind: "terminal_success",
          label: "A",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "rejected",
          kind: "terminal_failure",
          label: "R",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
    };
    const fixed = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine } = makeEngine({ definition: def, clock: fixed });
    await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    fixed.advance(60_000);
    const tick = await engine.tickTimers(fixed.now().getTime());
    expect(tick.firedTimerIds).toEqual([]);
  });
});

describe("schedule_activity action", () => {
  it("runs the registered handler and emits scheduled+started+completed", async () => {
    const def: WorkflowDefinition = {
      ...definitionFixture(),
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [
            {
              kind: "schedule_activity",
              parameters: {
                activityKey: "process_payment",
                kind: "transformation",
                input: { amount: 100 },
              },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "done",
          kind: "terminal_success",
          label: "Done",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "complete",
          fromState: "draft",
          toState: "done",
          trigger: { kind: "activity_completed", activityKey: "process_payment" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
      initialState: "draft",
    };
    const { engine } = makeEngine({ definition: def });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    expect(state.status).toBe("completed");
    const events = await engine.listEvents(state.instanceId);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("activity_scheduled");
    expect(kinds).toContain("activity_started");
    expect(kinds).toContain("activity_completed");
    expect(kinds).toContain("instance_completed");
  });

  it("emits activity_failed when the handler returns failed", async () => {
    const failingHandler: ActivityHandler = () => ({
      status: "failed",
      errorCode: "TEST_FAIL",
      errorMessage: "intentional failure",
      retryable: false,
    });
    const def: WorkflowDefinition = {
      ...definitionFixture(),
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [
            {
              kind: "schedule_activity",
              parameters: {
                activityKey: "do_thing",
                kind: "http_call",
                input: {},
              },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "failed",
          kind: "terminal_failure",
          label: "Failed",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "fail",
          fromState: "draft",
          toState: "failed",
          trigger: { kind: "activity_failed", activityKey: "do_thing" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
      initialState: "draft",
    };
    const registry = createDefaultRegistry().registerForKind("http_call", failingHandler);
    const { engine } = makeEngine({ definition: def, registry });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    expect(state.status).toBe("failed");
    expect(state.failureCode).toBe("TERMINAL_FAILURE_STATE");
    const events = await engine.listEvents(state.instanceId);
    expect(events.map((e) => e.kind)).toContain("activity_failed");
  });

  it("uses unsupportedHandler when no handler is registered", async () => {
    const def: WorkflowDefinition = {
      ...definitionFixture(),
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [
            {
              kind: "schedule_activity",
              parameters: {
                activityKey: "do_thing",
                kind: "http_call",
                input: {},
              },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "failed",
          kind: "terminal_failure",
          label: "F",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "fail",
          fromState: "draft",
          toState: "failed",
          trigger: { kind: "activity_failed", activityKey: "do_thing" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
      initialState: "draft",
    };
    const { engine } = makeEngine({ definition: def });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    expect(state.status).toBe("failed");
  });
});

describe("set_variable action", () => {
  it("emits variable_updated and updates projection", async () => {
    const def: WorkflowDefinition = {
      ...definitionFixture(),
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "after_set",
          kind: "intermediate",
          label: "After",
          onEntryActions: [
            { kind: "set_variable", parameters: { variableName: "status", value: "checked" } },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "done",
          kind: "terminal_success",
          label: "D",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "go",
          fromState: "draft",
          toState: "after_set",
          trigger: { kind: "automatic" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
        {
          name: "finish",
          fromState: "after_set",
          toState: "done",
          trigger: { kind: "automatic" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
      initialState: "draft",
    };
    const { engine } = makeEngine({ definition: def });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    expect(state.variables["status"]).toBe("checked");
    expect(state.status).toBe("completed");
  });
});

describe("cancelInstance", () => {
  it("emits instance_cancelled", async () => {
    const { engine, definition } = makeEngine();
    const state = await engine.startInstance({
      definitionId: definition.id,
      tenantId: TENANT,
    });
    await engine.cancelInstance({
      instanceId: state.instanceId,
      reason: "user requested",
      cancelledByUserId: USER,
    });
    const finalState = await engine.getInstanceState(state.instanceId);
    expect(finalState?.status).toBe("cancelled");
    expect(finalState?.cancelledReason).toBe("user requested");
    expect(finalState?.cancelledByUserId).toBe(USER);
  });

  it("rejects cancellation of a completed instance", async () => {
    const { engine, definition } = makeEngine();
    const state = await engine.startInstance({
      definitionId: definition.id,
      tenantId: TENANT,
      correlationKey: "po-x",
    });
    await engine.submitSignal({
      signalName: "approve",
      correlationKey: "po-x",
      tenantId: TENANT,
    });
    await expect(
      engine.cancelInstance({ instanceId: state.instanceId, reason: "late" }),
    ).rejects.toThrow(/terminal status/);
  });

  it("rejects cancellation of an unknown instance", async () => {
    const { engine } = makeEngine();
    await expect(
      engine.cancelInstance({ instanceId: "wfi_nope0001", reason: "x" }),
    ).rejects.toThrow(/unknown instance/);
  });
});

describe("getInstanceState + listEvents", () => {
  it("returns null for an unknown instance", async () => {
    const { engine } = makeEngine();
    expect(await engine.getInstanceState("wfi_nope0001")).toBeNull();
    expect(await engine.listEvents("wfi_nope0001")).toEqual([]);
  });
});

describe("event sequence numbers", () => {
  it("are strictly monotonic per instance", async () => {
    const { engine, definition } = makeEngine();
    const state = await engine.startInstance({
      definitionId: definition.id,
      tenantId: TENANT,
      correlationKey: "po-z",
    });
    await engine.submitSignal({
      signalName: "approve",
      correlationKey: "po-z",
      tenantId: TENANT,
    });
    const events = await engine.listEvents(state.instanceId);
    for (let i = 0; i < events.length; i++) {
      expect(events[i]?.sequenceNumber).toBe(i);
    }
  });
});

describe("WorkflowEngine — instrumentation (M8)", () => {
  it("emits instance_started + state_transitioned + instance_failed during a full reject flow", async () => {
    const cap = captureInstrumentation();
    const { engine } = makeEngine({ instrumentation: cap.instrumentation });
    const { instanceId } = await engine.startInstance({
      tenantId: TENANT,
      definitionId: "wfd_def00001",
      correlationKey: "po-1",
    });
    await engine.submitSignal({
      signalName: "reject",
      correlationKey: "po-1",
      tenantId: TENANT,
    });
    const kinds = cap.events.map((e) => e.kind);
    expect(kinds).toContain("instance_started");
    expect(kinds).toContain("state_transitioned");
    expect(kinds).toContain("signal_received");
    expect(kinds).toContain("signal_consumed");
    expect(kinds).toContain("instance_failed");
    const started = cap.events.find((e) => e.kind === "instance_started")!;
    expect(started.instanceId).toBe(instanceId);
    expect(started.definitionId).toBe("wfd_def00001");
    expect(started.correlationId).toBe("po-1");
    expect(started.attributes["definitionKey"]).toBe("purchase.approval");
  });

  it("emits instance_completed on terminal_success", async () => {
    const cap = captureInstrumentation();
    const { engine } = makeEngine({ instrumentation: cap.instrumentation });
    await engine.startInstance({
      tenantId: TENANT,
      definitionId: "wfd_def00001",
      correlationKey: "po-2",
    });
    await engine.submitSignal({
      signalName: "approve",
      correlationKey: "po-2",
      tenantId: TENANT,
    });
    const completed = cap.events.find((e) => e.kind === "instance_completed");
    expect(completed).toBeDefined();
    expect(completed!.attributes["terminalState"]).toBe("approved");
    expect(completed!.attributes["terminalKind"]).toBe("terminal_success");
  });

  it("emits instance_cancelled on explicit cancellation", async () => {
    const cap = captureInstrumentation();
    const { engine } = makeEngine({ instrumentation: cap.instrumentation });
    const { instanceId } = await engine.startInstance({
      tenantId: TENANT,
      definitionId: "wfd_def00001",
      correlationKey: "po-3",
    });
    cap.clear();
    await engine.cancelInstance({
      instanceId,
      reason: "operator-stopped",
      cancelledByUserId: USER,
    });
    const cancelled = cap.events.find((e) => e.kind === "instance_cancelled")!;
    expect(cancelled.instanceId).toBe(instanceId);
    expect(cancelled.attributes["reason"]).toBe("operator-stopped");
    expect(cancelled.attributes["cancelledByUserId"]).toBe(USER);
  });

  it("emits signal_received before signal_consumed in submitSignal", async () => {
    const cap = captureInstrumentation();
    const { engine } = makeEngine({ instrumentation: cap.instrumentation });
    await engine.startInstance({
      tenantId: TENANT,
      definitionId: "wfd_def00001",
      correlationKey: "po-4",
    });
    cap.clear();
    await engine.submitSignal({
      signalName: "approve",
      correlationKey: "po-4",
      tenantId: TENANT,
    });
    const receivedIdx = cap.events.findIndex((e) => e.kind === "signal_received");
    const consumedIdx = cap.events.findIndex((e) => e.kind === "signal_consumed");
    expect(receivedIdx).toBeGreaterThanOrEqual(0);
    expect(consumedIdx).toBeGreaterThan(receivedIdx);
  });

  it("does not double-emit terminal instrumentation when projection re-evaluates", async () => {
    const cap = captureInstrumentation();
    const { engine } = makeEngine({ instrumentation: cap.instrumentation });
    await engine.startInstance({
      tenantId: TENANT,
      definitionId: "wfd_def00001",
      correlationKey: "po-5",
    });
    await engine.submitSignal({
      signalName: "approve",
      correlationKey: "po-5",
      tenantId: TENANT,
    });
    const completedCount = cap.events.filter((e) => e.kind === "instance_completed").length;
    expect(completedCount).toBe(1);
  });

  it("emits timer_fired when scheduled timers tick past their deadline", async () => {
    const def = definitionFixture({
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [
            {
              kind: "schedule_timer",
              parameters: {
                timerName: "deadline",
                fireAfterSeconds: 60,
              },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "awaiting_approval",
          kind: "waiting",
          label: "Awaiting",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "rejected",
          kind: "terminal_failure",
          label: "Rejected",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "submit",
          fromState: "draft",
          toState: "awaiting_approval",
          trigger: { kind: "automatic" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
        {
          name: "timeout",
          fromState: "awaiting_approval",
          toState: "rejected",
          trigger: { kind: "timer_fired", timerName: "deadline" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
    });
    const cap = captureInstrumentation();
    const clock = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine } = makeEngine({
      definition: def,
      clock,
      instrumentation: cap.instrumentation,
    });
    await engine.startInstance({
      tenantId: TENANT,
      definitionId: def.id,
      correlationKey: "timeout-1",
    });
    cap.clear();
    await engine.tickTimers(new Date("2026-05-16T12:05:00.000Z").getTime());
    const fired = cap.events.find((e) => e.kind === "timer_fired");
    expect(fired).toBeDefined();
    expect(fired!.attributes["timerName"]).toBe("deadline");
  });

  it("populates occurredAt from the engine clock", async () => {
    const cap = captureInstrumentation();
    const clock = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine } = makeEngine({ clock, instrumentation: cap.instrumentation });
    await engine.startInstance({
      tenantId: TENANT,
      definitionId: "wfd_def00001",
      correlationKey: "po-time",
    });
    for (const e of cap.events) {
      expect(e.occurredAt).toBe("2026-05-16T12:00:00.000Z");
    }
  });

  it("swallows instrumentation errors without breaking the engine", async () => {
    const failing: WorkflowInstrumentation = {
      onEvent() {
        throw new Error("instrumentation backend down");
      },
    };
    const { engine } = makeEngine({ instrumentation: failing });
    const result = await engine.startInstance({
      tenantId: TENANT,
      definitionId: "wfd_def00001",
      correlationKey: "po-noisy",
    });
    expect(result.instanceId).toMatch(/^wfi_/);
    // submitSignal also exercises a different instrumentation path.
    await expect(
      engine.submitSignal({
        signalName: "approve",
        correlationKey: "po-noisy",
        tenantId: TENANT,
      }),
    ).resolves.toMatchObject({ deduplicated: false });
  });

  it("default engine without instrumentation continues to work (NoopInstrumentation fallback)", async () => {
    const { engine } = makeEngine();
    const result = await engine.startInstance({
      tenantId: TENANT,
      definitionId: "wfd_def00001",
      correlationKey: "po-no-instr",
    });
    expect(result.currentState).toBe("awaiting_approval");
    expect(result.status).toBe("waiting_for_signal");
  });
});

describe("WorkflowEngine — activity execution instrumentation (M8.1)", () => {
  function activityDef(
    overrides: {
      activityKey?: string;
      activityKind?: string;
      completedTransition?: boolean;
      failedTransition?: boolean;
    } = {},
  ): WorkflowDefinition {
    const activityKey = overrides.activityKey ?? "process_payment";
    const activityKind = overrides.activityKind ?? "transformation";
    const transitions = [];
    if (overrides.completedTransition !== false) {
      transitions.push({
        name: "complete",
        fromState: "draft",
        toState: "done",
        trigger: { kind: "activity_completed" as const, activityKey },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      });
    }
    if (overrides.failedTransition === true) {
      transitions.push({
        name: "fail",
        fromState: "draft",
        toState: "failed",
        trigger: { kind: "activity_failed" as const, activityKey },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      });
    }
    return {
      ...definitionFixture(),
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [
            {
              kind: "schedule_activity",
              parameters: {
                activityKey,
                kind: activityKind,
                input: { amount: 100 },
              },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "done",
          kind: "terminal_success",
          label: "Done",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "failed",
          kind: "terminal_failure",
          label: "Failed",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions,
      initialState: "draft",
    };
  }

  it("emits activity_scheduled + activity_started + activity_completed in order on success", async () => {
    const cap = captureInstrumentation();
    const def = activityDef();
    const { engine } = makeEngine({
      definition: def,
      instrumentation: cap.instrumentation,
    });
    await engine.startInstance({
      definitionId: def.id,
      tenantId: TENANT,
      correlationKey: "act-1",
    });
    const activityEvents = cap.events.filter((e) => e.kind.startsWith("activity_"));
    expect(activityEvents.map((e) => e.kind)).toEqual([
      "activity_scheduled",
      "activity_started",
      "activity_completed",
    ]);
  });

  it("includes activityId / activityKey / activityKind on each event", async () => {
    const cap = captureInstrumentation();
    const def = activityDef({ activityKey: "process_payment" });
    const { engine } = makeEngine({
      definition: def,
      instrumentation: cap.instrumentation,
    });
    await engine.startInstance({
      definitionId: def.id,
      tenantId: TENANT,
      correlationKey: "act-2",
    });
    const completed = cap.events.find((e) => e.kind === "activity_completed")!;
    expect(completed.attributes["activityKey"]).toBe("process_payment");
    expect(completed.attributes["activityKind"]).toBe("transformation");
    expect(typeof completed.attributes["activityId"]).toBe("string");
  });

  it("activity_completed carries a non-negative durationMs", async () => {
    const cap = captureInstrumentation();
    const def = activityDef();
    const { engine } = makeEngine({
      definition: def,
      instrumentation: cap.instrumentation,
    });
    await engine.startInstance({
      definitionId: def.id,
      tenantId: TENANT,
      correlationKey: "act-3",
    });
    const completed = cap.events.find((e) => e.kind === "activity_completed")!;
    expect(completed.durationMs).not.toBeNull();
    expect(completed.durationMs!).toBeGreaterThanOrEqual(0);
  });

  it("emits activity_failed with errorCode + errorMessage + retryable when handler fails", async () => {
    const failingHandler: ActivityHandler = () => ({
      status: "failed",
      errorCode: "TEST_FAIL",
      errorMessage: "intentional failure",
      retryable: false,
    });
    const registry = createDefaultRegistry();
    registry.registerForKind("http_call", failingHandler);
    const def = activityDef({
      activityKey: "do_thing",
      activityKind: "http_call",
      completedTransition: false,
      failedTransition: true,
    });
    const cap = captureInstrumentation();
    const { engine } = makeEngine({
      definition: def,
      registry,
      instrumentation: cap.instrumentation,
    });
    await engine.startInstance({
      definitionId: def.id,
      tenantId: TENANT,
      correlationKey: "act-fail",
    });
    const failed = cap.events.find((e) => e.kind === "activity_failed")!;
    expect(failed).toBeDefined();
    expect(failed.attributes["errorCode"]).toBe("TEST_FAIL");
    expect(failed.attributes["errorMessage"]).toBe("intentional failure");
    expect(failed.attributes["retryable"]).toBe(false);
    expect(failed.durationMs).not.toBeNull();
  });

  it("activity_failed also fires when handler THROWS (exception path)", async () => {
    const throwingHandler: ActivityHandler = () => {
      throw new Error("boom");
    };
    const registry = createDefaultRegistry();
    registry.registerForKind("http_call", throwingHandler);
    const def = activityDef({
      activityKey: "do_thing",
      activityKind: "http_call",
      completedTransition: false,
      failedTransition: true,
    });
    const cap = captureInstrumentation();
    const { engine } = makeEngine({
      definition: def,
      registry,
      instrumentation: cap.instrumentation,
    });
    await engine.startInstance({
      definitionId: def.id,
      tenantId: TENANT,
      correlationKey: "act-throw",
    });
    const failed = cap.events.find((e) => e.kind === "activity_failed")!;
    expect(failed).toBeDefined();
    expect(failed.attributes["errorCode"]).toBe("HANDLER_EXCEPTION");
    expect(failed.attributes["errorMessage"]).toBe("boom");
  });

  it("activity_scheduled fires BEFORE activity_started in the instrumentation stream", async () => {
    const cap = captureInstrumentation();
    const def = activityDef();
    const { engine } = makeEngine({
      definition: def,
      instrumentation: cap.instrumentation,
    });
    await engine.startInstance({
      definitionId: def.id,
      tenantId: TENANT,
      correlationKey: "act-order",
    });
    const scheduledIdx = cap.events.findIndex((e) => e.kind === "activity_scheduled");
    const startedIdx = cap.events.findIndex((e) => e.kind === "activity_started");
    expect(scheduledIdx).toBeGreaterThanOrEqual(0);
    expect(startedIdx).toBeGreaterThan(scheduledIdx);
  });

  it("propagates correlationId through activity events", async () => {
    const cap = captureInstrumentation();
    const def = activityDef();
    const { engine } = makeEngine({
      definition: def,
      instrumentation: cap.instrumentation,
    });
    await engine.startInstance({
      definitionId: def.id,
      tenantId: TENANT,
      correlationKey: "act-corr-xyz",
    });
    const activityEvents = cap.events.filter((e) => e.kind.startsWith("activity_"));
    for (const e of activityEvents) {
      expect(e.correlationId).toBe("act-corr-xyz");
    }
  });
});

describe("WorkflowEngine — timer lifecycle instrumentation (M8.2)", () => {
  function timerSchedulingDefinition(): WorkflowDefinition {
    return {
      ...definitionFixture(),
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [
            {
              kind: "schedule_timer",
              parameters: { timerName: "deadline", relativeSeconds: 60 },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "approved",
          kind: "terminal_success",
          label: "Approved",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [],
    };
  }

  it("emits timer_set when applyScheduleTimer runs", async () => {
    const cap = captureInstrumentation();
    const clock = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine } = makeEngine({
      definition: timerSchedulingDefinition(),
      clock,
      instrumentation: cap.instrumentation,
    });
    await engine.startInstance({
      tenantId: TENANT,
      definitionId: timerSchedulingDefinition().id,
      correlationKey: "po-timer-set",
    });
    const set = cap.events.find((e) => e.kind === "timer_set");
    expect(set).toBeDefined();
  });

  it("populates timer_set attributes (timerId + timerName + fireAt + relativeSeconds)", async () => {
    const cap = captureInstrumentation();
    const clock = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine } = makeEngine({
      definition: timerSchedulingDefinition(),
      clock,
      instrumentation: cap.instrumentation,
    });
    await engine.startInstance({
      tenantId: TENANT,
      definitionId: timerSchedulingDefinition().id,
      correlationKey: "po-timer-attrs",
    });
    const set = cap.events.find((e) => e.kind === "timer_set");
    expect(set!.attributes["timerName"]).toBe("deadline");
    expect(set!.attributes["relativeSeconds"]).toBe(60);
    expect(set!.attributes["timerId"]).toBeDefined();
    expect(typeof set!.attributes["timerId"]).toBe("string");
    // fireAt = clock.now() + relativeSeconds → 12:01:00
    expect(set!.attributes["fireAt"]).toBe("2026-05-16T12:01:00.000Z");
  });

  it("threads tenantId + instanceId + definitionId into the timer_set event", async () => {
    const cap = captureInstrumentation();
    const clock = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const def = timerSchedulingDefinition();
    const { engine } = makeEngine({
      definition: def,
      clock,
      instrumentation: cap.instrumentation,
    });
    const { instanceId } = await engine.startInstance({
      tenantId: TENANT,
      definitionId: def.id,
      correlationKey: "po-timer-ids",
    });
    const set = cap.events.find((e) => e.kind === "timer_set");
    expect(set!.tenantId).toBe(TENANT);
    expect(set!.instanceId).toBe(instanceId);
    expect(set!.definitionId).toBe(def.id);
  });

  it("timer_set carries the SAME timerId that the subsequent timer_fired event reports", async () => {
    const def: WorkflowDefinition = {
      ...definitionFixture(),
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "awaiting_approval",
          kind: "waiting",
          label: "Awaiting",
          onEntryActions: [
            {
              kind: "schedule_timer",
              parameters: { timerName: "deadline", relativeSeconds: 60 },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "rejected",
          kind: "terminal_failure",
          label: "Rejected",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "submit",
          fromState: "draft",
          toState: "awaiting_approval",
          trigger: { kind: "automatic" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
        {
          name: "timeout",
          fromState: "awaiting_approval",
          toState: "rejected",
          trigger: { kind: "timer_fired", timerName: "deadline" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
    };
    const cap = captureInstrumentation();
    const clock = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine } = makeEngine({
      definition: def,
      clock,
      instrumentation: cap.instrumentation,
    });
    await engine.startInstance({
      tenantId: TENANT,
      definitionId: def.id,
      correlationKey: "po-timer-id-link",
    });
    await engine.tickTimers(new Date("2026-05-16T12:05:00.000Z").getTime());
    const set = cap.events.find((e) => e.kind === "timer_set");
    const fired = cap.events.find((e) => e.kind === "timer_fired");
    expect(set).toBeDefined();
    expect(fired).toBeDefined();
    expect(set!.attributes["timerId"]).toBe(fired!.attributes["timerId"]);
  });

  it("multiple timers in a single transition each emit their own timer_set", async () => {
    const def: WorkflowDefinition = {
      ...definitionFixture(),
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [
            {
              kind: "schedule_timer",
              parameters: { timerName: "reminder", relativeSeconds: 30 },
            },
            {
              kind: "schedule_timer",
              parameters: { timerName: "deadline", relativeSeconds: 90 },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "done",
          kind: "terminal_success",
          label: "Done",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [],
    };
    const cap = captureInstrumentation();
    const clock = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine } = makeEngine({
      definition: def,
      clock,
      instrumentation: cap.instrumentation,
    });
    await engine.startInstance({
      tenantId: TENANT,
      definitionId: def.id,
      correlationKey: "po-multi-timers",
    });
    const sets = cap.events.filter((e) => e.kind === "timer_set");
    expect(sets).toHaveLength(2);
    expect(sets[0]!.attributes["timerName"]).toBe("reminder");
    expect(sets[1]!.attributes["timerName"]).toBe("deadline");
    expect(sets[0]!.attributes["timerId"]).not.toBe(sets[1]!.attributes["timerId"]);
  });

  // A scheduled timer puts the instance in waiting_for_timer, so the cancel is
  // driven by a *firing* timer: a short "checkpoint" (60s) fires and transitions
  // into "settled", whose on-entry cancels the still-pending long "deadline"
  // (3600s) — the canonical SLA "completed early, cancel the deadline" pattern.
  function timerCancellingDefinition(): WorkflowDefinition {
    return {
      ...definitionFixture(),
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "armed",
          kind: "waiting",
          label: "Armed",
          onEntryActions: [
            {
              kind: "schedule_timer",
              parameters: { timerName: "deadline", relativeSeconds: 3_600 },
            },
            {
              kind: "schedule_timer",
              parameters: { timerName: "checkpoint", relativeSeconds: 60 },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "settled",
          kind: "terminal_success",
          label: "Settled",
          onEntryActions: [{ kind: "cancel_timer", parameters: { timerName: "deadline" } }],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "arm",
          fromState: "draft",
          toState: "armed",
          trigger: { kind: "automatic" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
        {
          name: "checkpoint_fired",
          fromState: "armed",
          toState: "settled",
          trigger: { kind: "timer_fired", timerName: "checkpoint" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
    };
  }

  it("emits timer_cancelled when cancel_timer runs", async () => {
    const cap = captureInstrumentation();
    const clock = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const def = timerCancellingDefinition();
    const { engine } = makeEngine({
      definition: def,
      clock,
      instrumentation: cap.instrumentation,
    });
    const { instanceId } = await engine.startInstance({
      tenantId: TENANT,
      definitionId: def.id,
      correlationKey: "po-cancel",
    });
    await engine.tickTimers(new Date("2026-05-16T12:02:00.000Z").getTime());
    const cancelled = cap.events.find((e) => e.kind === "timer_cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled!.tenantId).toBe(TENANT);
    expect(cancelled!.instanceId).toBe(instanceId);
    expect(cancelled!.definitionId).toBe(def.id);
    expect(cancelled!.attributes["timerName"]).toBe("deadline");
  });

  it("timer_cancelled carries the SAME timerId as the timer_set it cancels", async () => {
    const cap = captureInstrumentation();
    const clock = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const def = timerCancellingDefinition();
    const { engine } = makeEngine({
      definition: def,
      clock,
      instrumentation: cap.instrumentation,
    });
    await engine.startInstance({
      tenantId: TENANT,
      definitionId: def.id,
      correlationKey: "po-cancel-id",
    });
    await engine.tickTimers(new Date("2026-05-16T12:02:00.000Z").getTime());
    const deadlineSet = cap.events.find(
      (e) => e.kind === "timer_set" && e.attributes["timerName"] === "deadline",
    );
    const cancelled = cap.events.find((e) => e.kind === "timer_cancelled");
    expect(deadlineSet).toBeDefined();
    expect(cancelled).toBeDefined();
    expect(cancelled!.attributes["timerId"]).toBe(deadlineSet!.attributes["timerId"]);
  });

  it("a cancelled timer does NOT fire on a later tick", async () => {
    const cap = captureInstrumentation();
    const clock = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const def = timerCancellingDefinition();
    const { engine } = makeEngine({
      definition: def,
      clock,
      instrumentation: cap.instrumentation,
    });
    await engine.startInstance({
      tenantId: TENANT,
      definitionId: def.id,
      correlationKey: "po-cancel-nofire",
    });
    // First tick fires "checkpoint" (60s) and cancels "deadline" (3600s = 13:00).
    await engine.tickTimers(new Date("2026-05-16T12:02:00.000Z").getTime());
    // Tick past the deadline's original fireAt — it must NOT fire (cancelled).
    await engine.tickTimers(new Date("2026-05-16T14:00:00.000Z").getTime());
    expect(cap.events.some((e) => e.kind === "timer_cancelled")).toBe(true);
    const fired = cap.events.filter((e) => e.kind === "timer_fired");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.attributes["timerName"]).toBe("checkpoint");
  });

  it("cancel_timer for an unknown timer is a safe no-op", async () => {
    const def: WorkflowDefinition = {
      ...definitionFixture(),
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [{ kind: "cancel_timer", parameters: { timerName: "ghost" } }],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [],
    };
    const cap = captureInstrumentation();
    const clock = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine } = makeEngine({
      definition: def,
      clock,
      instrumentation: cap.instrumentation,
    });
    const { instanceId } = await engine.startInstance({
      tenantId: TENANT,
      definitionId: def.id,
      correlationKey: "po-cancel-ghost",
    });
    expect(cap.events.some((e) => e.kind === "timer_cancelled")).toBe(false);
    const state = await engine.getInstanceState(instanceId);
    expect(state!.currentState).toBe("draft");
  });

  it("includes timer_set + timer_cancelled in the kinds enum", () => {
    // Both timer_set (emitted by schedule_timer) and timer_cancelled (emitted
    // by cancel_timer) are first-class instrumentation kinds and CHECK-allowed.
    const enabled = WORKFLOW_INSTRUMENTATION_KINDS as readonly string[];
    expect(enabled).toContain("timer_set");
    expect(enabled).toContain("timer_fired");
    expect(enabled).toContain("timer_cancelled");
  });
});

describe("send_signal action (M8.4)", () => {
  const TENANT_B = "00000000-0000-4000-8000-000000000002";

  // A coordinator workflow whose terminal state's on-entry send_signal emits a
  // signal to participants correlated by a batch key, and a participant workflow
  // that advances on that signal. Both live on one engine (submitSignal matches
  // across instances). Start the participant first, then the coordinator — the
  // coordinator's send_signal fires during its startInstance step loop.
  function makeSignalEngine(
    opts: {
      readonly instrumentation?: WorkflowInstrumentation;
      readonly sendParams?: Record<string, unknown>;
    } = {},
  ) {
    const participant = definitionFixture({
      id: "wfd_participant",
      definitionKey: "batch.participant",
      initialState: "waiting",
      states: [
        {
          name: "waiting",
          kind: "waiting",
          label: "Waiting",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "done",
          kind: "terminal_success",
          label: "Done",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "proceed",
          fromState: "waiting",
          toState: "done",
          trigger: { kind: "signal_received", signalName: "proceed" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
    });
    const sendParams = opts.sendParams ?? { signalName: "proceed", correlationKey: "batch-1" };
    const coordinator = definitionFixture({
      id: "wfd_coordina1",
      definitionKey: "batch.coordinator",
      initialState: "start",
      states: [
        {
          name: "start",
          kind: "initial",
          label: "Start",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "sent",
          kind: "terminal_success",
          label: "Sent",
          onEntryActions: [{ kind: "send_signal", parameters: sendParams }],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "go",
          fromState: "start",
          toState: "sent",
          trigger: { kind: "automatic" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
    });
    const log = new InMemoryEventLog();
    const engine = new WorkflowEngine({
      eventLog: log,
      definitions: new Map([
        [participant.id, participant],
        [coordinator.id, coordinator],
      ]),
      activityRegistry: createDefaultRegistry(),
      clock: new FixedClock(new Date("2026-05-16T12:00:00.000Z")),
      idGenerator: new CountingIdGenerator(),
      ...(opts.instrumentation !== undefined ? { instrumentation: opts.instrumentation } : {}),
    });
    return { engine, participant, coordinator, log };
  }

  it("emits a signal that advances a correlated receiver instance", async () => {
    const { engine, participant, coordinator } = makeSignalEngine();
    const recv = await engine.startInstance({
      definitionId: participant.id,
      tenantId: TENANT,
      correlationKey: "batch-1",
    });
    expect(recv.status).toBe("waiting_for_signal");
    await engine.startInstance({
      definitionId: coordinator.id,
      tenantId: TENANT,
      correlationKey: "coordinator",
    });
    const recvState = await engine.getInstanceState(recv.instanceId);
    expect(recvState?.status).toBe("completed");
    expect(recvState?.currentState).toBe("done");
    const kinds = (await engine.listEvents(recv.instanceId)).map((e) => e.kind);
    expect(kinds).toContain("signal_received");
    expect(kinds).toContain("signal_consumed");
  });

  it("records a signal_emitted instrumentation trace on the sender", async () => {
    const cap = captureInstrumentation();
    const { engine, participant, coordinator } = makeSignalEngine({
      instrumentation: cap.instrumentation,
    });
    await engine.startInstance({
      definitionId: participant.id,
      tenantId: TENANT,
      correlationKey: "batch-1",
    });
    const send = await engine.startInstance({
      definitionId: coordinator.id,
      tenantId: TENANT,
      correlationKey: "coordinator",
    });
    const emitted = cap.events.find((e) => e.kind === "signal_emitted");
    expect(emitted).toBeDefined();
    expect(emitted?.instanceId).toBe(send.instanceId);
    expect(emitted?.attributes["signalName"]).toBe("proceed");
    expect(emitted?.attributes["targetCorrelationKey"]).toBe("batch-1");
    expect(emitted?.attributes["matchedInstanceCount"]).toBe(1);
    expect(emitted?.attributes["signalId"]).not.toBeNull();
  });

  it("threads the sender instanceId as sourceSystem on the receiver's signal_received", async () => {
    const { engine, participant, coordinator } = makeSignalEngine();
    const recv = await engine.startInstance({
      definitionId: participant.id,
      tenantId: TENANT,
      correlationKey: "batch-1",
    });
    const send = await engine.startInstance({
      definitionId: coordinator.id,
      tenantId: TENANT,
      correlationKey: "coordinator",
    });
    const received = (await engine.listEvents(recv.instanceId)).find(
      (e) => e.kind === "signal_received",
    );
    expect(received?.actorSystemId).toBe(send.instanceId);
  });

  it("emits with matchedInstanceCount 0 and changes no receiver when nothing is correlated", async () => {
    const cap = captureInstrumentation();
    const { engine, coordinator } = makeSignalEngine({ instrumentation: cap.instrumentation });
    const send = await engine.startInstance({
      definitionId: coordinator.id,
      tenantId: TENANT,
      correlationKey: "coordinator",
    });
    const emitted = cap.events.find((e) => e.kind === "signal_emitted");
    expect(emitted?.attributes["matchedInstanceCount"]).toBe(0);
    // The sender still completes its own transition regardless of matches.
    const sendState = await engine.getInstanceState(send.instanceId);
    expect(sendState?.currentState).toBe("sent");
  });

  it("delivers to every correlated receiver (matchedInstanceCount = N)", async () => {
    const cap = captureInstrumentation();
    const { engine, participant, coordinator } = makeSignalEngine({
      instrumentation: cap.instrumentation,
    });
    const r1 = await engine.startInstance({
      definitionId: participant.id,
      tenantId: TENANT,
      correlationKey: "batch-1",
    });
    const r2 = await engine.startInstance({
      definitionId: participant.id,
      tenantId: TENANT,
      correlationKey: "batch-1",
    });
    await engine.startInstance({
      definitionId: coordinator.id,
      tenantId: TENANT,
      correlationKey: "coordinator",
    });
    expect((await engine.getInstanceState(r1.instanceId))?.currentState).toBe("done");
    expect((await engine.getInstanceState(r2.instanceId))?.currentState).toBe("done");
    const emitted = cap.events.find((e) => e.kind === "signal_emitted");
    expect(emitted?.attributes["matchedInstanceCount"]).toBe(2);
  });

  it("does not cross tenant boundaries (sender tenant scopes delivery)", async () => {
    const cap = captureInstrumentation();
    const { engine, participant, coordinator } = makeSignalEngine({
      instrumentation: cap.instrumentation,
    });
    const recv = await engine.startInstance({
      definitionId: participant.id,
      tenantId: TENANT,
      correlationKey: "batch-1",
    });
    await engine.startInstance({
      definitionId: coordinator.id,
      tenantId: TENANT_B,
      correlationKey: "coordinator",
    });
    const emitted = cap.events.find((e) => e.kind === "signal_emitted");
    expect(emitted?.attributes["matchedInstanceCount"]).toBe(0);
    expect((await engine.getInstanceState(recv.instanceId))?.status).toBe("waiting_for_signal");
  });

  it("no-ops (no signal_emitted) when signalName / correlationKey are missing", async () => {
    const cap = captureInstrumentation();
    const { engine, coordinator } = makeSignalEngine({
      instrumentation: cap.instrumentation,
      sendParams: {},
    });
    await engine.startInstance({
      definitionId: coordinator.id,
      tenantId: TENANT,
      correlationKey: "coordinator",
    });
    expect(cap.events.some((e) => e.kind === "signal_emitted")).toBe(false);
  });

  it("includes signal_emitted in the kinds enum", () => {
    expect(WORKFLOW_INSTRUMENTATION_KINDS as readonly string[]).toContain("signal_emitted");
  });
});

describe("spawn_child_workflow action (M8.5)", () => {
  // Async child: parent_start →(auto) awaiting_child [on-entry: spawn childflow]
  // →(child_workflow_completed) parent_done. The child waits for a "finish"
  // signal, so it does NOT complete during spawn — the parent quiesces at
  // waiting_for_child and is driven to parent_done when the child completes.
  function childFlowDef(): WorkflowDefinition {
    return definitionFixture({
      id: "wfd_childflow1",
      definitionKey: "childflow",
      initialState: "child_start",
      states: [
        {
          name: "child_start",
          kind: "initial",
          label: "S",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "child_wait",
          kind: "waiting",
          label: "W",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "child_done",
          kind: "terminal_success",
          label: "D",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "begin",
          fromState: "child_start",
          toState: "child_wait",
          trigger: { kind: "automatic" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
        {
          name: "finish",
          fromState: "child_wait",
          toState: "child_done",
          trigger: { kind: "signal_received", signalName: "finish" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
    });
  }

  function parentFlowDef(spawnParams: Record<string, unknown>): WorkflowDefinition {
    return definitionFixture({
      id: "wfd_parentfl1",
      definitionKey: "parentflow",
      initialState: "parent_start",
      states: [
        {
          name: "parent_start",
          kind: "initial",
          label: "S",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "awaiting_child",
          kind: "waiting",
          label: "Awaiting",
          onEntryActions: [{ kind: "spawn_child_workflow", parameters: spawnParams }],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "parent_done",
          kind: "terminal_success",
          label: "D",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "spawn",
          fromState: "parent_start",
          toState: "awaiting_child",
          trigger: { kind: "automatic" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
        {
          name: "child_done",
          fromState: "awaiting_child",
          toState: "parent_done",
          trigger: { kind: "child_workflow_completed", childDefinitionKey: "childflow" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
    });
  }

  const DEFAULT_SPAWN = {
    childDefinitionKey: "childflow",
    correlationKey: "child-corr",
    input: { ticket: "T1" },
  };

  function engineWith(
    defs: readonly WorkflowDefinition[],
    instrumentation?: WorkflowInstrumentation,
  ) {
    const engine = new WorkflowEngine({
      eventLog: new InMemoryEventLog(),
      definitions: new Map(defs.map((d) => [d.id, d])),
      activityRegistry: createDefaultRegistry(),
      clock: new FixedClock(new Date("2026-05-26T12:00:00.000Z")),
      idGenerator: new CountingIdGenerator(),
      ...(instrumentation !== undefined ? { instrumentation } : {}),
    });
    return { engine };
  }

  async function childIdOf(engine: WorkflowEngine, parentInstanceId: string): Promise<string> {
    const spawned = (await engine.listEvents(parentInstanceId)).find(
      (e) => e.kind === "child_workflow_spawned",
    );
    if (spawned?.childInstanceId == null) throw new Error("no child_workflow_spawned event");
    return spawned.childInstanceId;
  }

  it("parent waits at waiting_for_child, then completes when the child completes", async () => {
    const { engine } = engineWith([parentFlowDef(DEFAULT_SPAWN), childFlowDef()]);
    const parent = await engine.startInstance({
      definitionId: "wfd_parentfl1",
      tenantId: TENANT,
      correlationKey: "parent-corr",
    });
    expect(parent.status).toBe("waiting_for_child");
    expect(parent.currentState).toBe("awaiting_child");

    await engine.submitSignal({
      signalName: "finish",
      correlationKey: "child-corr",
      tenantId: TENANT,
    });

    const final = await engine.getInstanceState(parent.instanceId);
    expect(final?.status).toBe("completed");
    expect(final?.currentState).toBe("parent_done");
  });

  it("records child_workflow_spawned + child_workflow_completed on the parent", async () => {
    const { engine } = engineWith([parentFlowDef(DEFAULT_SPAWN), childFlowDef()]);
    const parent = await engine.startInstance({
      definitionId: "wfd_parentfl1",
      tenantId: TENANT,
    });
    await engine.submitSignal({
      signalName: "finish",
      correlationKey: "child-corr",
      tenantId: TENANT,
    });
    const kinds = (await engine.listEvents(parent.instanceId)).map((e) => e.kind);
    expect(kinds).toContain("child_workflow_spawned");
    expect(kinds).toContain("child_workflow_completed");
  });

  it("links the child to the parent and threads input variables", async () => {
    const { engine } = engineWith([parentFlowDef(DEFAULT_SPAWN), childFlowDef()]);
    const parent = await engine.startInstance({
      definitionId: "wfd_parentfl1",
      tenantId: TENANT,
    });
    const childId = await childIdOf(engine, parent.instanceId);
    const child = await engine.getInstanceState(childId);
    expect(child?.parentInstanceId).toBe(parent.instanceId);
    expect(child?.definitionKey).toBe("childflow");
    expect(child?.currentState).toBe("child_wait");
    expect(child?.variables["ticket"]).toBe("T1");
  });

  it("emits child_workflow_spawned + child_workflow_completed instrumentation on the parent", async () => {
    const cap = captureInstrumentation();
    const { engine } = engineWith(
      [parentFlowDef(DEFAULT_SPAWN), childFlowDef()],
      cap.instrumentation,
    );
    const parent = await engine.startInstance({
      definitionId: "wfd_parentfl1",
      tenantId: TENANT,
    });
    await engine.submitSignal({
      signalName: "finish",
      correlationKey: "child-corr",
      tenantId: TENANT,
    });
    const spawned = cap.events.find((e) => e.kind === "child_workflow_spawned");
    expect(spawned?.instanceId).toBe(parent.instanceId);
    expect(spawned?.attributes["childDefinitionKey"]).toBe("childflow");
    const completed = cap.events.find((e) => e.kind === "child_workflow_completed");
    expect(completed?.instanceId).toBe(parent.instanceId);
    expect(completed?.attributes["childTerminalKind"]).toBe("terminal_success");
  });

  it("no-ops (no child spawned) when childDefinitionKey is missing", async () => {
    const { engine } = engineWith([parentFlowDef({}), childFlowDef()]);
    const parent = await engine.startInstance({
      definitionId: "wfd_parentfl1",
      tenantId: TENANT,
    });
    const kinds = (await engine.listEvents(parent.instanceId)).map((e) => e.kind);
    expect(kinds).not.toContain("child_workflow_spawned");
    expect(parent.status).toBe("waiting_for_child");
  });

  it("no-ops when no published definition has the child key", async () => {
    const { engine } = engineWith([
      parentFlowDef({ childDefinitionKey: "ghostflow" }),
      childFlowDef(),
    ]);
    const parent = await engine.startInstance({
      definitionId: "wfd_parentfl1",
      tenantId: TENANT,
    });
    const kinds = (await engine.listEvents(parent.instanceId)).map((e) => e.kind);
    expect(kinds).not.toContain("child_workflow_spawned");
  });

  it("a synchronously-terminating child drives the parent to completion within startInstance", async () => {
    const trivChild = definitionFixture({
      id: "wfd_trivchild",
      definitionKey: "trivchild",
      initialState: "t_start",
      states: [
        {
          name: "t_start",
          kind: "initial",
          label: "S",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "t_done",
          kind: "terminal_success",
          label: "D",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "go",
          fromState: "t_start",
          toState: "t_done",
          trigger: { kind: "automatic" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
    });
    const trivParent = definitionFixture({
      id: "wfd_trivparen",
      definitionKey: "trivparent",
      initialState: "tp_start",
      states: [
        {
          name: "tp_start",
          kind: "initial",
          label: "S",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "tp_wait",
          kind: "waiting",
          label: "W",
          onEntryActions: [
            { kind: "spawn_child_workflow", parameters: { childDefinitionKey: "trivchild" } },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "tp_done",
          kind: "terminal_success",
          label: "D",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "spawn",
          fromState: "tp_start",
          toState: "tp_wait",
          trigger: { kind: "automatic" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
        {
          name: "done",
          fromState: "tp_wait",
          toState: "tp_done",
          trigger: { kind: "child_workflow_completed", childDefinitionKey: "trivchild" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
    });
    const { engine } = engineWith([trivParent, trivChild]);
    const parent = await engine.startInstance({ definitionId: "wfd_trivparen", tenantId: TENANT });
    expect(parent.status).toBe("completed");
    expect(parent.currentState).toBe("tp_done");
    const kinds = (await engine.listEvents(parent.instanceId)).map((e) => e.kind);
    expect(kinds).toContain("child_workflow_spawned");
    expect(kinds).toContain("child_workflow_completed");
  });

  it("includes child_workflow_spawned + child_workflow_completed in the kinds enum", () => {
    const enabled = WORKFLOW_INSTRUMENTATION_KINDS as readonly string[];
    expect(enabled).toContain("child_workflow_spawned");
    expect(enabled).toContain("child_workflow_completed");
  });
});

describe("multi-trigger wait drivers — signals + timers cross-reach (M8.6)", () => {
  // The "deadline + early-completion" pattern: a state with kind="waiting",
  // both signal_received and timer_fired outgoing triggers, and an on-entry
  // schedule_timer. The timer_scheduled event projects the instance to
  // status="waiting_for_timer" (the timer set overrides refineStatus), so the
  // deadline drives via tickTimers (always worked). M8.6 widens submitSignal
  // to ALSO reach a waiting_for_timer instance — a signal can now pre-empt
  // the deadline directly without waiting for the timer to fire. The
  // symmetric widening lets tickTimers reach a waiting_for_signal instance
  // (for long-lived cross-state timers that outlive their scheduling state).
  function deadlineSignalDef(): WorkflowDefinition {
    return definitionFixture({
      id: "wfd_deadline1",
      definitionKey: "deadline_signal",
      initialState: "start",
      states: [
        {
          name: "start",
          kind: "initial",
          label: "S",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "active",
          kind: "waiting",
          label: "Active",
          onEntryActions: [
            {
              kind: "schedule_timer",
              parameters: { timerName: "deadline", relativeSeconds: 60 },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "aborted",
          kind: "terminal_success",
          label: "Aborted",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "expired",
          kind: "terminal_failure",
          label: "Expired",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "begin",
          fromState: "start",
          toState: "active",
          trigger: { kind: "automatic" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
        {
          name: "abort",
          fromState: "active",
          toState: "aborted",
          trigger: { kind: "signal_received", signalName: "abort" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
        {
          name: "expire",
          fromState: "active",
          toState: "expired",
          trigger: { kind: "timer_fired", timerName: "deadline" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
    });
  }

  // A state with ONLY a timer trigger (no signal) — status waiting_for_timer.
  // Used to prove submitSignal now reaches such instances (signal events
  // appended; no transition fires because the state has no signal_received
  // trigger).
  function timerOnlyDef(): WorkflowDefinition {
    return definitionFixture({
      id: "wfd_timeronly",
      definitionKey: "timer_only",
      initialState: "start",
      states: [
        {
          name: "start",
          kind: "initial",
          label: "S",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "wait",
          kind: "waiting",
          label: "Wait",
          onEntryActions: [
            {
              kind: "schedule_timer",
              parameters: { timerName: "tick", relativeSeconds: 60 },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "done",
          kind: "terminal_success",
          label: "Done",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "begin",
          fromState: "start",
          toState: "wait",
          trigger: { kind: "automatic" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
        {
          name: "tick",
          fromState: "wait",
          toState: "done",
          trigger: { kind: "timer_fired", timerName: "tick" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
    });
  }

  // A cross-state timer: a long-lived timer is scheduled in "prep", a signal
  // moves the instance to "mid" (waiting on a different signal), but the
  // timer is still active. Used to prove tickTimers' widening to
  // waiting_for_signal — the cross-state timer fires on the new state.
  function crossStateTimerDef(): WorkflowDefinition {
    return definitionFixture({
      id: "wfd_crossstat",
      definitionKey: "cross_state_timer",
      initialState: "start",
      states: [
        {
          name: "start",
          kind: "initial",
          label: "S",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "prep",
          kind: "waiting",
          label: "Prep",
          onEntryActions: [
            {
              kind: "schedule_timer",
              parameters: { timerName: "sla", relativeSeconds: 60 },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "mid",
          kind: "waiting",
          label: "Mid",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "done",
          kind: "terminal_success",
          label: "Done",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
        {
          name: "expired",
          kind: "terminal_failure",
          label: "Expired",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "begin",
          fromState: "start",
          toState: "prep",
          trigger: { kind: "automatic" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
        {
          name: "kick",
          fromState: "prep",
          toState: "mid",
          trigger: { kind: "signal_received", signalName: "kick" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
        {
          name: "finish",
          fromState: "mid",
          toState: "done",
          trigger: { kind: "signal_received", signalName: "finish" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
        {
          name: "sla_in_mid",
          fromState: "mid",
          toState: "expired",
          trigger: { kind: "timer_fired", timerName: "sla" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
    });
  }

  it("submitSignal reaches a waiting_for_timer instance and pre-empts the deadline", async () => {
    // The on-entry schedule_timer forces status=waiting_for_timer. Before
    // M8.6, submitSignal SKIPPED such instances → the signal couldn't pre-empt
    // the deadline. With the widening, the signal_received transition fires
    // and the instance transitions before the timer would have fired.
    const { engine } = makeEngine({ definition: deadlineSignalDef() });
    const state = await engine.startInstance({
      definitionId: "wfd_deadline1",
      tenantId: TENANT,
      correlationKey: "x",
    });
    expect(state.status).toBe("waiting_for_timer");
    expect(state.currentState).toBe("active");

    const result = await engine.submitSignal({
      signalName: "abort",
      correlationKey: "x",
      tenantId: TENANT,
    });
    expect(result.matchedInstanceIds).toEqual([state.instanceId]);

    const final = await engine.getInstanceState(state.instanceId);
    expect(final?.status).toBe("completed");
    expect(final?.currentState).toBe("aborted");
  });

  it("tickTimers still fires the deadline on the same multi-trigger state (sanity, behavior preserved)", async () => {
    const clock = new FixedClock(new Date("2026-05-26T12:00:00.000Z"));
    const { engine } = makeEngine({ definition: deadlineSignalDef(), clock });
    const state = await engine.startInstance({
      definitionId: "wfd_deadline1",
      tenantId: TENANT,
      correlationKey: "x",
    });
    clock.advance(120_000);
    const result = await engine.tickTimers(clock.now().getTime());
    expect(result.firedTimerIds.length).toBe(1);
    const final = await engine.getInstanceState(state.instanceId);
    expect(final?.status).toBe("failed");
    expect(final?.currentState).toBe("expired");
  });

  it("tickTimers reaches a waiting_for_signal instance with a cross-state active timer", async () => {
    // prep schedules a long timer T → status waiting_for_timer. submitSignal
    // 'kick' moves the instance to mid (waiting on a different signal) — after
    // refineStatus on mid (signal_received outgoing only) the status flips to
    // waiting_for_signal, but T is still active (never fired/cancelled). With
    // M8.6's widening, tickTimers picks up the waiting_for_signal instance,
    // fires T, and drives mid's timer_fired transition to expired.
    const clock = new FixedClock(new Date("2026-05-26T12:00:00.000Z"));
    const { engine } = makeEngine({ definition: crossStateTimerDef(), clock });
    const state = await engine.startInstance({
      definitionId: "wfd_crossstat",
      tenantId: TENANT,
      correlationKey: "x",
    });
    expect(state.status).toBe("waiting_for_timer"); // timer scheduled in prep

    await engine.submitSignal({
      signalName: "kick",
      correlationKey: "x",
      tenantId: TENANT,
    });
    const afterKick = await engine.getInstanceState(state.instanceId);
    expect(afterKick?.currentState).toBe("mid");
    expect(afterKick?.status).toBe("waiting_for_signal"); // mid has only signal triggers in refineStatus

    clock.advance(120_000);
    const tick = await engine.tickTimers(clock.now().getTime());
    expect(tick.firedTimerIds.length).toBe(1);
    const final = await engine.getInstanceState(state.instanceId);
    expect(final?.status).toBe("failed");
    expect(final?.currentState).toBe("expired");
  });

  it("submitSignal reaches a waiting_for_timer instance even without a matching trigger (signal events recorded; no transition)", async () => {
    const { engine } = makeEngine({ definition: timerOnlyDef() });
    const state = await engine.startInstance({
      definitionId: "wfd_timeronly",
      tenantId: TENANT,
      correlationKey: "x",
    });
    expect(state.status).toBe("waiting_for_timer");

    const result = await engine.submitSignal({
      signalName: "anything",
      correlationKey: "x",
      tenantId: TENANT,
    });
    expect(result.matchedInstanceIds).toEqual([state.instanceId]);

    const kinds = (await engine.listEvents(state.instanceId)).map((e) => e.kind);
    expect(kinds).toContain("signal_received");
    expect(kinds).toContain("signal_consumed");

    const after = await engine.getInstanceState(state.instanceId);
    expect(after?.status).toBe("waiting_for_timer");
    expect(after?.currentState).toBe("wait");
  });
});
