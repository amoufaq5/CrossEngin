import type { WorkflowDefinition, WorkflowEvent } from "@crossengin/workflow-engine";
import { WorkflowEventSchema, isHistoryDense } from "@crossengin/workflow-engine";
import { describe, expect, it } from "vitest";

import {
  ActivityRegistry,
  createDefaultRegistry,
  type ActivityHandler,
} from "./activity-handlers.js";
import { CountingIdGenerator, FixedClock } from "./clock.js";
import { InMemoryEventLog } from "./event-log.js";
import {
  MAX_CHILD_WORKFLOW_DEPTH,
  MAX_SIGNAL_DISPATCH_DEPTH,
  WORKFLOW_ACTION_FAILURES,
  WorkflowActionError,
  WorkflowEngine,
  activityRetryDelayMs,
  parseActivityBackoff,
} from "./engine.js";
import {
  isInstanceCancellationRequested,
  isInstanceCancelled,
  projectActivities,
  projectInstance,
  projectTimers,
} from "./projection.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000099";

function definitionFixture(
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  const base: WorkflowDefinition = {
    id: "wfd_def00001",
    tenantId: null,
    definitionKey: "purchase.approval",
    version: "1.0.0",
    label: "Purchase approval",
    description: "",
    status: "published",
    states: [
      { name: "draft", kind: "initial", label: "Draft", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "awaiting_approval", kind: "waiting", label: "Awaiting", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "approved", kind: "terminal_success", label: "Approved", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "rejected", kind: "terminal_failure", label: "Rejected", onEntryActions: [], onExitActions: [], slaSeconds: null },
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

function makeEngine(opts: {
  readonly definition?: WorkflowDefinition;
  readonly registry?: ActivityRegistry;
  readonly clock?: FixedClock;
  readonly deferActivities?: boolean;
} = {}) {
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
    ...(opts.deferActivities === undefined ? {} : { deferActivities: opts.deferActivities }),
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
    expect(events.map((e) => e.kind)).toEqual([
      "instance_started",
      "state_transitioned",
    ]);
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
        { name: "draft", kind: "initial", label: "Draft", onEntryActions: [], onExitActions: [], slaSeconds: null },
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
        { name: "approved", kind: "terminal_success", label: "Approved", onEntryActions: [], onExitActions: [], slaSeconds: null },
        { name: "rejected", kind: "terminal_failure", label: "Rejected", onEntryActions: [], onExitActions: [], slaSeconds: null },
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
        { name: "draft", kind: "initial", label: "Draft", onEntryActions: [], onExitActions: [], slaSeconds: null },
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
        { name: "approved", kind: "terminal_success", label: "A", onEntryActions: [], onExitActions: [], slaSeconds: null },
        { name: "rejected", kind: "terminal_failure", label: "R", onEntryActions: [], onExitActions: [], slaSeconds: null },
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

describe("fireDueTimersForInstance (distributed firing)", () => {
  function timerDef(relativeSeconds: number): WorkflowDefinition {
    return {
      ...definitionFixture(),
      states: [
        { name: "draft", kind: "initial", label: "Draft", onEntryActions: [], onExitActions: [], slaSeconds: null },
        {
          name: "awaiting_approval",
          kind: "waiting",
          label: "Awaiting",
          onEntryActions: [{ kind: "schedule_timer", parameters: { timerName: "deadline", relativeSeconds } }],
          onExitActions: [],
          slaSeconds: null,
        },
        { name: "approved", kind: "terminal_success", label: "A", onEntryActions: [], onExitActions: [], slaSeconds: null },
        { name: "rejected", kind: "terminal_failure", label: "R", onEntryActions: [], onExitActions: [], slaSeconds: null },
      ],
    };
  }

  it("fires a specific instance's due timer + transition", async () => {
    const def = timerDef(60);
    const fixed = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine } = makeEngine({ definition: def, clock: fixed });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    fixed.advance(120_000);
    const result = await engine.fireDueTimersForInstance(state.instanceId, fixed.now().getTime());
    expect(result.firedTimerIds).toHaveLength(1);
    expect(result.affectedInstanceIds).toEqual([state.instanceId]);
    expect((await engine.getInstanceState(state.instanceId))?.status).toBe("failed");
  });

  it("fires a timer for an instance a second engine never started (cross-process over one log)", async () => {
    const def = timerDef(60);
    const fixed = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine: engineA, log } = makeEngine({ definition: def, clock: fixed });
    const state = await engineA.startInstance({ definitionId: def.id, tenantId: TENANT });
    fixed.advance(120_000);

    // Engine B shares only the event log — it never called startInstance (its in-memory map is empty).
    const engineB = new WorkflowEngine({
      eventLog: log,
      definitions: new Map([[def.id, def]]),
      activityRegistry: createDefaultRegistry(),
      clock: new FixedClock(fixed.now()),
      idGenerator: new CountingIdGenerator(),
    });
    // tickTimers on B finds nothing (empty in-memory map), but the targeted call fires from the log.
    expect((await engineB.tickTimers(fixed.now().getTime())).firedTimerIds).toEqual([]);
    const result = await engineB.fireDueTimersForInstance(state.instanceId, fixed.now().getTime());
    expect(result.firedTimerIds).toHaveLength(1);
    expect((await engineB.getInstanceState(state.instanceId))?.status).toBe("failed");
  });

  it("is idempotent — a re-fire after the timer already fired does nothing", async () => {
    const def = timerDef(60);
    const fixed = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine } = makeEngine({ definition: def, clock: fixed });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    fixed.advance(120_000);
    await engine.fireDueTimersForInstance(state.instanceId, fixed.now().getTime());
    const second = await engine.fireDueTimersForInstance(state.instanceId, fixed.now().getTime());
    expect(second.firedTimerIds).toEqual([]);
  });

  it("returns empty for an unknown instance", async () => {
    const { engine } = makeEngine();
    expect((await engine.fireDueTimersForInstance("wfi_nope0001", Date.parse("2026-05-16T12:00:00.000Z"))).firedTimerIds).toEqual([]);
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
        { name: "done", kind: "terminal_success", label: "Done", onEntryActions: [], onExitActions: [], slaSeconds: null },
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
        { name: "failed", kind: "terminal_failure", label: "Failed", onEntryActions: [], onExitActions: [], slaSeconds: null },
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
        { name: "failed", kind: "terminal_failure", label: "F", onEntryActions: [], onExitActions: [], slaSeconds: null },
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
        { name: "draft", kind: "initial", label: "Draft", onEntryActions: [], onExitActions: [], slaSeconds: null },
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
        { name: "done", kind: "terminal_success", label: "D", onEntryActions: [], onExitActions: [], slaSeconds: null },
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

describe("deferActivities + executeScheduledActivity (distributed activities)", () => {
  function activityDef(): WorkflowDefinition {
    return {
      ...definitionFixture(),
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [
            { kind: "schedule_activity", parameters: { activityKey: "process_payment", kind: "transformation", input: { amount: 100 } } },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        { name: "done", kind: "terminal_success", label: "Done", onEntryActions: [], onExitActions: [], slaSeconds: null },
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
  }

  function deferredEngine(def: WorkflowDefinition, log = new InMemoryEventLog()) {
    return {
      log,
      engine: new WorkflowEngine({
        eventLog: log,
        definitions: new Map([[def.id, def]]),
        activityRegistry: createDefaultRegistry(),
        clock: new FixedClock(new Date("2026-05-16T12:00:00.000Z")),
        idGenerator: new CountingIdGenerator(),
        deferActivities: true,
      }),
    };
  }

  it("schedules the activity but does NOT run it inline", async () => {
    const def = activityDef();
    const { engine } = deferredEngine(def);
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const kinds = (await engine.listEvents(state.instanceId)).map((e) => e.kind);
    expect(kinds).toContain("activity_scheduled");
    expect(kinds).not.toContain("activity_started");
    expect(kinds).not.toContain("instance_completed");
  });

  it("executeScheduledActivity runs the handler + transitions the instance", async () => {
    const def = activityDef();
    const { engine } = deferredEngine(def);
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const scheduled = (await engine.listEvents(state.instanceId)).find((e) => e.kind === "activity_scheduled")!;
    const result = await engine.executeScheduledActivity(state.instanceId, scheduled.activityId!);
    expect(result.executed).toBe(true);
    const kinds = (await engine.listEvents(state.instanceId)).map((e) => e.kind);
    expect(kinds).toContain("activity_started");
    expect(kinds).toContain("activity_completed");
    expect(kinds).toContain("instance_completed");
    expect((await engine.getInstanceState(state.instanceId))?.status).toBe("completed");
  });

  it("is idempotent — a second execute of an already-started activity is a no-op", async () => {
    const def = activityDef();
    const { engine } = deferredEngine(def);
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const activityId = (await engine.listEvents(state.instanceId)).find((e) => e.kind === "activity_scheduled")!.activityId!;
    await engine.executeScheduledActivity(state.instanceId, activityId);
    const before = (await engine.listEvents(state.instanceId)).length;
    const again = await engine.executeScheduledActivity(state.instanceId, activityId);
    expect(again.executed).toBe(false);
    expect((await engine.listEvents(state.instanceId)).length).toBe(before); // no duplicate events
  });

  it("executes for an instance a second engine never started (cross-process over one log)", async () => {
    const def = activityDef();
    const { engine: engineA, log } = deferredEngine(def);
    const state = await engineA.startInstance({ definitionId: def.id, tenantId: TENANT });
    const activityId = (await engineA.listEvents(state.instanceId)).find((e) => e.kind === "activity_scheduled")!.activityId!;
    // Engine B shares only the log — never started this instance.
    const engineB = new WorkflowEngine({
      eventLog: log,
      definitions: new Map([[def.id, def]]),
      activityRegistry: createDefaultRegistry(),
      clock: new FixedClock(new Date("2026-05-16T12:00:00.000Z")),
      idGenerator: new CountingIdGenerator(),
    });
    expect((await engineB.executeScheduledActivity(state.instanceId, activityId)).executed).toBe(true);
    expect((await engineB.getInstanceState(state.instanceId))?.status).toBe("completed");
  });

  it("returns executed:false for an unknown activity", async () => {
    const def = activityDef();
    const { engine } = deferredEngine(def);
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    expect((await engine.executeScheduledActivity(state.instanceId, "wfa_nope0001")).executed).toBe(false);
  });
});

describe("activity retry + dead-letter", () => {
  function retryDef(maxAttempts: number, withFailTransition = true): WorkflowDefinition {
    return {
      ...definitionFixture(),
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [
            { kind: "schedule_activity", parameters: { activityKey: "do_thing", kind: "http_call", input: {}, maxAttempts } },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        { name: "done", kind: "terminal_success", label: "Done", onEntryActions: [], onExitActions: [], slaSeconds: null },
        { name: "failed", kind: "terminal_failure", label: "Failed", onEntryActions: [], onExitActions: [], slaSeconds: null },
      ],
      transitions: [
        {
          name: "complete",
          fromState: "draft",
          toState: "done",
          trigger: { kind: "activity_completed", activityKey: "do_thing" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
        ...(withFailTransition
          ? [
              {
                name: "fail",
                fromState: "draft",
                toState: "failed",
                trigger: { kind: "activity_failed" as const, activityKey: "do_thing" },
                guards: [],
                preTransitionActions: [],
                postTransitionActions: [],
              },
            ]
          : []),
      ],
      initialState: "draft",
    };
  }

  const alwaysRetryableFail: ActivityHandler = () => ({
    status: "failed",
    errorCode: "FLAKY",
    errorMessage: "transient",
    retryable: true,
  });

  it("retries a retryable failure up to maxAttempts, then dead-letters", async () => {
    const def = retryDef(3);
    const registry = createDefaultRegistry().registerForKind("http_call", alwaysRetryableFail);
    const { engine } = makeEngine({ definition: def, registry });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const events = await engine.listEvents(state.instanceId);
    expect(events.filter((e) => e.kind === "activity_started")).toHaveLength(3); // 3 attempts
    const failures = events.filter((e) => e.kind === "activity_failed");
    expect(failures).toHaveLength(3);
    expect(failures.slice(0, 2).every((e) => e.payload["willRetry"] === true && e.payload["deadLettered"] === false)).toBe(true);
    expect(failures[2]!.payload["deadLettered"]).toBe(true);
    expect((await engine.getInstanceState(state.instanceId))?.status).toBe("failed"); // dead-letter fired the transition
  });

  it("stops retrying and completes when a retry succeeds", async () => {
    const succeedOnSecond: ActivityHandler = (ctx) =>
      ctx.attemptNumber >= 2
        ? { status: "succeeded", output: {} }
        : { status: "failed", errorCode: "FLAKY", errorMessage: "transient", retryable: true };
    const def = retryDef(3);
    const registry = createDefaultRegistry().registerForKind("http_call", succeedOnSecond);
    const { engine } = makeEngine({ definition: def, registry });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const events = await engine.listEvents(state.instanceId);
    expect(events.filter((e) => e.kind === "activity_started")).toHaveLength(2);
    expect(events.some((e) => e.kind === "activity_completed")).toBe(true);
    expect((await engine.getInstanceState(state.instanceId))?.status).toBe("completed");
  });

  it("does not retry a non-retryable failure even with maxAttempts>1", async () => {
    const nonRetryable: ActivityHandler = () => ({ status: "failed", errorCode: "FATAL", errorMessage: "no", retryable: false });
    const def = retryDef(5);
    const registry = createDefaultRegistry().registerForKind("http_call", nonRetryable);
    const { engine } = makeEngine({ definition: def, registry });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const events = await engine.listEvents(state.instanceId);
    expect(events.filter((e) => e.kind === "activity_started")).toHaveLength(1); // no retry
    expect(events.find((e) => e.kind === "activity_failed")?.payload["deadLettered"]).toBe(true);
    expect((await engine.getInstanceState(state.instanceId))?.status).toBe("failed");
  });

  it("deferred mode reschedules the retry as a fresh scheduled activity for a worker", async () => {
    const def = retryDef(3);
    const log = new InMemoryEventLog();
    const engine = new WorkflowEngine({
      eventLog: log,
      definitions: new Map([[def.id, def]]),
      activityRegistry: createDefaultRegistry().registerForKind("http_call", alwaysRetryableFail),
      clock: new FixedClock(new Date("2026-05-16T12:00:00.000Z")),
      idGenerator: new CountingIdGenerator(),
      deferActivities: true,
    });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    // Attempt 1 scheduled but not run (deferred). A worker executes it → it fails retryably → the
    // engine reschedules attempt 2 as a new scheduled activity (still no inline run).
    const a1 = (await engine.listEvents(state.instanceId)).find((e) => e.kind === "activity_scheduled")!.activityId!;
    await engine.executeScheduledActivity(state.instanceId, a1);
    const scheduled = (await engine.listEvents(state.instanceId)).filter((e) => e.kind === "activity_scheduled");
    expect(scheduled).toHaveLength(2); // attempt 1 + rescheduled attempt 2
    expect(scheduled[1]!.payload["attemptNumber"]).toBe(2);
    expect((await engine.listEvents(state.instanceId)).filter((e) => e.kind === "activity_started")).toHaveLength(1); // only attempt 1 ran
  });
});

describe("saga compensation", () => {
  interface CompletedSpec {
    readonly key: string;
    readonly comp: string;
  }

  function sagaDef(
    strategy: WorkflowDefinition["compensationStrategy"],
    completed: readonly CompletedSpec[],
    failingKey: string,
  ): WorkflowDefinition {
    const states: WorkflowDefinition["states"] = [];
    const transitions: WorkflowDefinition["transitions"] = [];
    const stateNames = completed.map((_, i) => `s${i.toString()}`);
    const failState = "s_fail";
    for (let i = 0; i < completed.length; i++) {
      const c = completed[i]!;
      const name = stateNames[i]!;
      const next = i + 1 < completed.length ? stateNames[i + 1]! : failState;
      states.push({
        name,
        kind: i === 0 ? "initial" : "intermediate",
        label: name,
        onEntryActions: [
          {
            kind: "schedule_activity",
            parameters: { activityKey: c.key, kind: "http_call", input: {}, compensationActivityKey: c.comp },
          },
        ],
        onExitActions: [],
        slaSeconds: null,
      });
      transitions.push({
        name: `t_${name}`,
        fromState: name,
        toState: next,
        trigger: { kind: "activity_completed", activityKey: c.key },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      });
    }
    states.push({
      name: failState,
      kind: completed.length === 0 ? "initial" : "intermediate",
      label: failState,
      onEntryActions: [
        { kind: "schedule_activity", parameters: { activityKey: failingKey, kind: "http_call", input: {} } },
      ],
      onExitActions: [],
      slaSeconds: null,
    });
    transitions.push({
      name: "t_fail",
      fromState: failState,
      toState: "failed",
      trigger: { kind: "activity_failed", activityKey: failingKey },
      guards: [],
      preTransitionActions: [],
      postTransitionActions: [],
    });
    states.push({
      name: "failed",
      kind: "terminal_failure",
      label: "Failed",
      onEntryActions: [],
      onExitActions: [],
      slaSeconds: null,
    });
    const initialState = completed.length > 0 ? stateNames[0]! : failState;
    return { ...definitionFixture({ compensationStrategy: strategy }), states, transitions, initialState };
  }

  const succeed: ActivityHandler = () => ({ status: "succeeded", output: {} });
  const fail: ActivityHandler = () => ({ status: "failed", errorCode: "BOOM", errorMessage: "boom", retryable: false });

  function sagaRegistry(
    def: WorkflowDefinition,
    completed: readonly CompletedSpec[],
    failingKey: string,
    order: string[],
    registerCompensators = true,
  ): ActivityRegistry {
    const registry = createDefaultRegistry();
    for (const c of completed) {
      registry.registerForActivity(def.id, c.key, succeed);
      if (registerCompensators) {
        registry.registerForActivity(def.id, c.comp, () => {
          order.push(c.comp);
          return { status: "succeeded", output: {} };
        });
      }
    }
    registry.registerForActivity(def.id, failingKey, fail);
    return registry;
  }

  it("auto-compensates a completed activity when the instance reaches terminal_failure", async () => {
    const completed = [{ key: "charge", comp: "refund" }];
    const def = sagaDef("immediate_reverse_order", completed, "ship");
    const order: string[] = [];
    const registry = sagaRegistry(def, completed, "ship", order);
    const { engine } = makeEngine({ definition: def, registry });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });

    const final = await engine.getInstanceState(state.instanceId);
    expect(final?.status).toBe("compensated");
    const events = await engine.listEvents(state.instanceId);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("instance_failed");
    expect(kinds).toContain("compensation_started");
    expect(kinds).toContain("activity_compensated");
    expect(kinds).toContain("compensation_completed");
    expect(order).toEqual(["refund"]);

    const chargeActivityId = events.find(
      (e) => e.kind === "activity_scheduled" && e.payload["definitionActivityKey"] === "charge",
    )!.activityId;
    const compEvent = events.find((e) => e.kind === "activity_compensated")!;
    expect(compEvent.activityId).toBe(chargeActivityId);
    expect(compEvent.payload["handlerRegistered"]).toBe(true);
  });

  it("compensates immediate_reverse_order in reverse of completion order", async () => {
    const completed = [
      { key: "charge", comp: "refund_charge" },
      { key: "reserve", comp: "undo_reserve" },
    ];
    const def = sagaDef("immediate_reverse_order", completed, "ship");
    const order: string[] = [];
    const registry = sagaRegistry(def, completed, "ship", order);
    const { engine } = makeEngine({ definition: def, registry });
    await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    expect(order).toEqual(["undo_reserve", "refund_charge"]);
  });

  it("compensates parallel strategy in completion order", async () => {
    const completed = [
      { key: "charge", comp: "refund_charge" },
      { key: "reserve", comp: "undo_reserve" },
    ];
    const def = sagaDef("parallel", completed, "ship");
    const order: string[] = [];
    const registry = sagaRegistry(def, completed, "ship", order);
    const { engine } = makeEngine({ definition: def, registry });
    await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    expect(order).toEqual(["refund_charge", "undo_reserve"]);
  });

  it("no_compensation compensates nothing and stays failed", async () => {
    const completed = [{ key: "charge", comp: "refund" }];
    const def = sagaDef("no_compensation", completed, "ship");
    const order: string[] = [];
    const registry = sagaRegistry(def, completed, "ship", order);
    const { engine } = makeEngine({ definition: def, registry });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });

    const final = await engine.getInstanceState(state.instanceId);
    expect(final?.status).toBe("failed");
    const kinds = (await engine.listEvents(state.instanceId)).map((e) => e.kind);
    expect(kinds).not.toContain("compensation_started");
    expect(kinds).not.toContain("activity_compensated");
    expect(order).toEqual([]);
  });

  it("manual_review defers — no automatic compensation, stays failed", async () => {
    const completed = [{ key: "charge", comp: "refund" }];
    const def = sagaDef("manual_review", completed, "ship");
    const order: string[] = [];
    const registry = sagaRegistry(def, completed, "ship", order);
    const { engine } = makeEngine({ definition: def, registry });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });

    expect((await engine.getInstanceState(state.instanceId))?.status).toBe("failed");
    const result = await engine.compensateInstance(state.instanceId);
    expect(result.strategy).toBe("manual_review");
    expect(result.compensatedActivityIds).toEqual([]);
    expect(order).toEqual([]);
  });

  it("records a no-op activity_compensated when no compensating handler is registered", async () => {
    const completed = [{ key: "charge", comp: "refund" }];
    const def = sagaDef("immediate_reverse_order", completed, "ship");
    const order: string[] = [];
    const registry = sagaRegistry(def, completed, "ship", order, false);
    const { engine } = makeEngine({ definition: def, registry });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });

    expect((await engine.getInstanceState(state.instanceId))?.status).toBe("compensated");
    const compEvent = (await engine.listEvents(state.instanceId)).find((e) => e.kind === "activity_compensated")!;
    expect(compEvent.payload["handlerRegistered"]).toBe(false);
    expect(compEvent.payload["compensationStatus"]).toBe("succeeded");
  });

  it("is idempotent — compensateInstance twice compensates each activity only once", async () => {
    const completed = [{ key: "charge", comp: "refund" }];
    const def = sagaDef("immediate_reverse_order", completed, "ship");
    const order: string[] = [];
    const registry = sagaRegistry(def, completed, "ship", order);
    const { engine } = makeEngine({ definition: def, registry });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });

    // Auto compensation already ran once at terminal_failure.
    expect(order).toEqual(["refund"]);
    const countAfterAuto = (await engine.listEvents(state.instanceId)).length;

    const first = await engine.compensateInstance(state.instanceId);
    const second = await engine.compensateInstance(state.instanceId);
    expect(first.compensatedActivityIds).toEqual([]);
    expect(second.compensatedActivityIds).toEqual([]);
    expect(order).toEqual(["refund"]); // handler not invoked again
    const compEvents = (await engine.listEvents(state.instanceId)).filter((e) => e.kind === "activity_compensated");
    expect(compEvents).toHaveLength(1);
    expect((await engine.listEvents(state.instanceId)).length).toBe(countAfterAuto); // no new events
  });

  it("compensateInstance returns strategy null for an unknown instance", async () => {
    const { engine } = makeEngine();
    const result = await engine.compensateInstance("wfi_nope0001");
    expect(result.strategy).toBeNull();
    expect(result.compensatedActivityIds).toEqual([]);
  });
});

describe("activity retry backoff", () => {
  it("activityRetryDelayMs computes per-kind delays with a cap", () => {
    expect(activityRetryDelayMs(null, 3)).toBe(0);
    expect(activityRetryDelayMs({ kind: "constant", initialMs: 5000 }, 4)).toBe(5000);
    expect(activityRetryDelayMs({ kind: "linear", initialMs: 5000 }, 3)).toBe(15000);
    expect(activityRetryDelayMs({ kind: "exponential", initialMs: 5000 }, 3)).toBe(20000);
    expect(activityRetryDelayMs({ kind: "exponential", initialMs: 5000, maxMs: 12000 }, 3)).toBe(12000);
  });

  it("parseActivityBackoff reads the schedule_activity parameters (default kind exponential)", () => {
    expect(parseActivityBackoff({})).toBeNull();
    expect(parseActivityBackoff({ retryBackoffMs: 0 })).toBeNull();
    expect(parseActivityBackoff({ retryBackoffMs: 5000 })).toEqual({ kind: "exponential", initialMs: 5000 });
    expect(parseActivityBackoff({ retryBackoffMs: 5000, retryBackoffKind: "linear", retryMaxBackoffMs: 60000 })).toEqual({
      kind: "linear",
      initialMs: 5000,
      maxMs: 60000,
    });
  });

  function backoffDef(): WorkflowDefinition {
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
                activityKey: "do_thing",
                kind: "http_call",
                input: {},
                maxAttempts: 3,
                retryBackoffMs: 30000,
                retryBackoffKind: "constant",
              },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        { name: "done", kind: "terminal_success", label: "Done", onEntryActions: [], onExitActions: [], slaSeconds: null },
        { name: "failed", kind: "terminal_failure", label: "Failed", onEntryActions: [], onExitActions: [], slaSeconds: null },
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
  }

  const alwaysRetryableFail: ActivityHandler = () => ({
    status: "failed",
    errorCode: "FLAKY",
    errorMessage: "transient",
    retryable: true,
  });

  it("defers the rescheduled attempt's availableAt (and projected scheduledAt) by the backoff", async () => {
    const def = backoffDef();
    const log = new InMemoryEventLog();
    const engine = new WorkflowEngine({
      eventLog: log,
      definitions: new Map([[def.id, def]]),
      activityRegistry: createDefaultRegistry().registerForKind("http_call", alwaysRetryableFail),
      clock: new FixedClock(new Date("2026-05-16T12:00:00.000Z")),
      idGenerator: new CountingIdGenerator(),
      deferActivities: true,
    });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const a1 = (await engine.listEvents(state.instanceId)).find((e) => e.kind === "activity_scheduled")!.activityId!;
    await engine.executeScheduledActivity(state.instanceId, a1);

    const events = await engine.listEvents(state.instanceId);
    const scheduled = events.filter((e) => e.kind === "activity_scheduled");
    expect(scheduled).toHaveLength(2);
    // attempt 1 persisted the backoff; attempt 2 was deferred 30s past the fixed clock.
    expect(scheduled[0]!.payload["retryBackoff"]).toEqual({ kind: "constant", initialMs: 30000 });
    expect(scheduled[1]!.payload["availableAt"]).toBe("2026-05-16T12:00:30.000Z");

    const attempt2 = projectActivities(events).find((a) => a.attemptNumber === 2)!;
    expect(attempt2.scheduledAt).toBe("2026-05-16T12:00:30.000Z"); // claim defers until backoff elapses
  });

  it("keeps the first attempt due immediately (no availableAt)", async () => {
    const def = backoffDef();
    const { engine } = makeEngine({
      definition: def,
      registry: createDefaultRegistry().registerForKind("http_call", alwaysRetryableFail),
    });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const first = (await engine.listEvents(state.instanceId)).filter((e) => e.kind === "activity_scheduled")[0]!;
    expect(first.payload["availableAt"]).toBeUndefined();
  });
});

type DefState = WorkflowDefinition["states"][number];
type DefTransition = WorkflowDefinition["transitions"][number];
type DefAction = DefState["onEntryActions"][number];

function st(name: string, kind: DefState["kind"], onEntryActions: readonly DefAction[] = []): DefState {
  return { name, kind, label: name, onEntryActions: [...onEntryActions], onExitActions: [], slaSeconds: null };
}

function tr(input: {
  name: string;
  from: string;
  to: string;
  trigger: DefTransition["trigger"];
  pre?: readonly DefAction[];
  post?: readonly DefAction[];
}): DefTransition {
  return {
    name: input.name,
    fromState: input.from,
    toState: input.to,
    trigger: input.trigger,
    guards: [],
    preTransitionActions: [...(input.pre ?? [])],
    postTransitionActions: [...(input.post ?? [])],
  };
}

function makeMultiEngine(
  definitions: readonly WorkflowDefinition[],
  opts: { readonly clock?: FixedClock } = {},
): { engine: WorkflowEngine; log: InMemoryEventLog; clock: FixedClock } {
  const log = new InMemoryEventLog();
  const clock = opts.clock ?? new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
  const engine = new WorkflowEngine({
    eventLog: log,
    definitions: new Map(definitions.map((d) => [d.id, d])),
    activityRegistry: createDefaultRegistry(),
    clock,
    idGenerator: new CountingIdGenerator(),
  });
  return { engine, log, clock };
}

/** Re-derives an instance from the log in a *second* engine that executed nothing. */
async function replayIn(
  definitions: readonly WorkflowDefinition[],
  log: InMemoryEventLog,
  instanceId: string,
) {
  const replayEngine = new WorkflowEngine({
    eventLog: log,
    definitions: new Map(definitions.map((d) => [d.id, d])),
    activityRegistry: createDefaultRegistry(),
    clock: new FixedClock(new Date("2030-01-01T00:00:00.000Z")),
    idGenerator: new CountingIdGenerator(),
  });
  return replayEngine.getInstanceState(instanceId);
}

function expectSchemaValid(events: readonly WorkflowEvent[]): void {
  for (const event of events) {
    const parsed = WorkflowEventSchema.safeParse(event);
    expect(parsed.success, `${event.kind}@${event.sequenceNumber.toString()}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
  }
  expect(isHistoryDense(events)).toBe(true);
}

// ── cancel_timer ───────────────────────────────────────────────────────────────

/**
 * Two timers are armed on entry; the short one firing cancels the long one. Cancelling from a
 * timer_fired transition is the only reachable shape, because an instance holding a scheduled timer
 * projects as waiting_for_timer and submitSignal declines to deliver into that status.
 */
function cancelTimerDef(cancelParams: Record<string, unknown> = { timerName: "long_deadline" }): WorkflowDefinition {
  return definitionFixture({
    id: "wfd_cancel01",
    definitionKey: "cancel.timer",
    initialState: "armed",
    states: [
      st("armed", "initial", [
        { kind: "schedule_timer", parameters: { timerName: "short_deadline", relativeSeconds: 60 } },
        { kind: "schedule_timer", parameters: { timerName: "long_deadline", relativeSeconds: 3600 } },
      ]),
      st("settled", "terminal_success"),
    ],
    transitions: [
      tr({
        name: "settle",
        from: "armed",
        to: "settled",
        trigger: { kind: "timer_fired", timerName: "short_deadline" },
        pre: [{ kind: "cancel_timer", parameters: cancelParams }],
      }),
    ],
  });
}

describe("cancel_timer action", () => {
  it("cancels the still-outstanding timer and lets the instance leave waiting_for_timer", async () => {
    const def = cancelTimerDef();
    const { engine } = makeMultiEngine([def]);
    const started = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    expect(started.status).toBe("waiting_for_timer");
    expect([...started.awaitingTimerNames].sort()).toEqual(["long_deadline", "short_deadline"]);

    await engine.tickTimers(Date.parse("2026-05-16T12:01:00.000Z"));
    const events = await engine.listEvents(started.instanceId);
    expect(events.map((e) => e.kind)).toEqual([
      "instance_started",
      "timer_scheduled",
      "timer_scheduled",
      "timer_fired",
      "timer_cancelled",
      "state_transitioned",
      "instance_completed",
    ]);
    const state = await engine.getInstanceState(started.instanceId);
    expect(state?.status).toBe("completed");
    expect(state?.awaitingTimerNames).toEqual([]);
  });

  it("names the cancelled timer and carries its timerId", async () => {
    const def = cancelTimerDef();
    const { engine } = makeMultiEngine([def]);
    const started = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    await engine.tickTimers(Date.parse("2026-05-16T12:01:00.000Z"));
    const events = await engine.listEvents(started.instanceId);
    const longTimer = events.find(
      (e) => e.kind === "timer_scheduled" && e.payload["timerName"] === "long_deadline",
    )!;
    const cancelled = events.find((e) => e.kind === "timer_cancelled")!;
    expect(cancelled.timerId).toBe(longTimer.timerId);
    expect(cancelled.payload["timerName"]).toBe("long_deadline");
    expect(projectTimers(events).find((t) => t.timerName === "long_deadline")?.status).toBe("cancelled");
  });

  it("is a no-op for a timer name nothing scheduled", async () => {
    const def = cancelTimerDef({ timerName: "never_armed" });
    const { engine } = makeMultiEngine([def]);
    const started = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    await engine.tickTimers(Date.parse("2026-05-16T12:01:00.000Z"));
    const events = await engine.listEvents(started.instanceId);
    expect(events.filter((e) => e.kind === "timer_cancelled")).toHaveLength(0);
    // long_deadline is still outstanding, so the instance stays parked on it.
    const state = await engine.getInstanceState(started.instanceId);
    expect(state?.awaitingTimerNames).toEqual(["long_deadline"]);
  });

  it("does not re-cancel the timer that just fired", async () => {
    const def = cancelTimerDef({ timerName: "short_deadline" });
    const { engine } = makeMultiEngine([def]);
    const started = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    await engine.tickTimers(Date.parse("2026-05-16T12:01:00.000Z"));
    const events = await engine.listEvents(started.instanceId);
    expect(events.filter((e) => e.kind === "timer_cancelled")).toHaveLength(0);
  });

  it("refuses an action with no timerName as a typed WorkflowActionError", async () => {
    const def = cancelTimerDef({});
    const { engine } = makeMultiEngine([def]);
    const started = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const err = await engine
      .tickTimers(Date.parse("2026-05-16T12:01:00.000Z"))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowActionError);
    expect((err as WorkflowActionError).failure).toBe("missing_parameter");
    expect((err as WorkflowActionError).actionKind).toBe("cancel_timer");
    expect((err as WorkflowActionError).instanceId).toBe(started.instanceId);
    expect((err as WorkflowActionError).message).not.toMatch(/M3/);
  });

  it("replays identically in a second engine over the same log", async () => {
    const def = cancelTimerDef();
    const { engine, log } = makeMultiEngine([def]);
    const started = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    await engine.tickTimers(Date.parse("2026-05-16T12:01:00.000Z"));
    const live = await engine.getInstanceState(started.instanceId);
    const events = await engine.listEvents(started.instanceId);
    expectSchemaValid(events);
    expect(await replayIn([def], log, started.instanceId)).toEqual(live);
    expect(projectInstance(events, def)).toEqual(live);
  });
});

// ── spawn_child_workflow ───────────────────────────────────────────────────────

const CHILD_KEY = "child.flow";

function childDef(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return definitionFixture({
    id: "wfd_child001",
    definitionKey: CHILD_KEY,
    version: "1.0.0",
    initialState: "begin",
    states: [st("begin", "initial"), st("end", "terminal_success")],
    transitions: [tr({ name: "finish", from: "begin", to: "end", trigger: { kind: "automatic" } })],
    ...overrides,
  });
}

function parentDef(spawnParams: Record<string, unknown> = { definitionKey: CHILD_KEY }): WorkflowDefinition {
  return definitionFixture({
    id: "wfd_parent01",
    definitionKey: "parent.flow",
    initialState: "start",
    states: [st("start", "initial"), st("running_child", "intermediate"), st("finished", "terminal_success")],
    transitions: [
      tr({
        name: "spawn",
        from: "start",
        to: "running_child",
        trigger: { kind: "automatic" },
        post: [{ kind: "spawn_child_workflow", parameters: spawnParams }],
      }),
      tr({
        name: "child_done",
        from: "running_child",
        to: "finished",
        trigger: { kind: "child_workflow_completed", childDefinitionKey: CHILD_KEY },
      }),
    ],
  });
}

describe("spawn_child_workflow action", () => {
  it("starts the child, links it on the parent, and fires the child_workflow_completed trigger", async () => {
    const parent = parentDef();
    const child = childDef();
    const { engine } = makeMultiEngine([parent, child]);
    const state = await engine.startInstance({ definitionId: parent.id, tenantId: TENANT });
    expect(state.status).toBe("completed");
    const events = await engine.listEvents(state.instanceId);
    expect(events.map((e) => e.kind)).toEqual([
      "instance_started",
      "state_transitioned",
      "child_workflow_spawned",
      "child_workflow_completed",
      "state_transitioned",
      "instance_completed",
    ]);
  });

  it("records the child definition's key, id and version on the spawn event", async () => {
    const parent = parentDef();
    const child = childDef();
    const { engine } = makeMultiEngine([parent, child]);
    const state = await engine.startInstance({ definitionId: parent.id, tenantId: TENANT });
    const spawned = (await engine.listEvents(state.instanceId)).find((e) => e.kind === "child_workflow_spawned")!;
    expect(spawned.payload["childDefinitionKey"]).toBe(CHILD_KEY);
    expect(spawned.payload["childDefinitionId"]).toBe(child.id);
    expect(spawned.payload["childDefinitionVersion"]).toBe("1.0.0");
    expect(spawned.childInstanceId).toMatch(/^wfi_/);
  });

  it("the child is a real instance in the same log, pointing back at its parent", async () => {
    const parent = parentDef();
    const child = childDef();
    const { engine } = makeMultiEngine([parent, child]);
    const state = await engine.startInstance({ definitionId: parent.id, tenantId: TENANT });
    const spawned = (await engine.listEvents(state.instanceId)).find((e) => e.kind === "child_workflow_spawned")!;
    const childState = await engine.getInstanceState(spawned.childInstanceId!);
    expect(childState?.parentInstanceId).toBe(state.instanceId);
    expect(childState?.tenantId).toBe(TENANT);
    expect(childState?.status).toBe("completed");
    expect((await engine.listEvents(spawned.childInstanceId!)).map((e) => e.kind)).toEqual([
      "instance_started",
      "state_transitioned",
      "instance_completed",
    ]);
  });

  it("resolves the child by definitionId as well as by key", async () => {
    const parent = parentDef({ definitionId: "wfd_child001" });
    const child = childDef();
    const { engine } = makeMultiEngine([parent, child]);
    const state = await engine.startInstance({ definitionId: parent.id, tenantId: TENANT });
    expect(state.status).toBe("completed");
  });

  it("threads variables and a correlation key into the child", async () => {
    const parent = parentDef({
      definitionKey: CHILD_KEY,
      variables: { order_id: "SO-7" },
      correlationKey: "corr-7",
    });
    const child = childDef();
    const { engine } = makeMultiEngine([parent, child]);
    const state = await engine.startInstance({ definitionId: parent.id, tenantId: TENANT });
    const spawned = (await engine.listEvents(state.instanceId)).find((e) => e.kind === "child_workflow_spawned")!;
    const childState = await engine.getInstanceState(spawned.childInstanceId!);
    expect(childState?.variables).toEqual({ order_id: "SO-7" });
    expect(childState?.correlationKey).toBe("corr-7");
    expect(spawned.correlationId).toBe("corr-7");
  });

  it("records only the spawn when the child parks instead of completing", async () => {
    const parent = parentDef();
    const waitingChild = childDef({
      states: [st("begin", "waiting"), st("end", "terminal_success")],
      transitions: [
        tr({ name: "finish", from: "begin", to: "end", trigger: { kind: "signal_received", signalName: "go" } }),
      ],
    });
    const { engine } = makeMultiEngine([parent, waitingChild]);
    const state = await engine.startInstance({ definitionId: parent.id, tenantId: TENANT });
    const events = await engine.listEvents(state.instanceId);
    expect(events.map((e) => e.kind)).toEqual(["instance_started", "state_transitioned", "child_workflow_spawned"]);
    expect(state.currentState).toBe("running_child");
    expect(events.find((e) => e.kind === "child_workflow_spawned")!.payload["childStatus"]).toBe(
      "waiting_for_signal",
    );
  });

  it("picks the highest published version when a key has several", async () => {
    const parent = parentDef();
    const v1 = childDef({ id: "wfd_child001", version: "1.0.0" });
    const v2 = childDef({ id: "wfd_child002", version: "2.1.0" });
    // Registered lowest-first, so insertion order alone would pick the wrong one.
    const { engine } = makeMultiEngine([parent, v1, v2]);
    const state = await engine.startInstance({ definitionId: parent.id, tenantId: TENANT });
    const spawned = (await engine.listEvents(state.instanceId)).find((e) => e.kind === "child_workflow_spawned")!;
    expect(spawned.payload["childDefinitionVersion"]).toBe("2.1.0");
    expect(spawned.payload["childDefinitionId"]).toBe("wfd_child002");
  });

  it("ignores an unpublished version when resolving a key", async () => {
    const parent = parentDef();
    const published = childDef({ id: "wfd_child001", version: "1.0.0" });
    const draft = childDef({ id: "wfd_child002", version: "9.0.0", status: "draft" });
    const { engine } = makeMultiEngine([parent, published, draft]);
    const state = await engine.startInstance({ definitionId: parent.id, tenantId: TENANT });
    const spawned = (await engine.listEvents(state.instanceId)).find((e) => e.kind === "child_workflow_spawned")!;
    expect(spawned.payload["childDefinitionVersion"]).toBe("1.0.0");
  });

  it("refuses an unknown definitionKey with unknown_child_definition", async () => {
    const parent = parentDef({ definitionKey: "nope.flow" });
    const { engine } = makeMultiEngine([parent, childDef()]);
    const err = await engine
      .startInstance({ definitionId: parent.id, tenantId: TENANT })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowActionError);
    expect((err as WorkflowActionError).failure).toBe("unknown_child_definition");
    expect((err as WorkflowActionError).message).toMatch(/nope\.flow/);
  });

  it("refuses an unknown definitionId with unknown_child_definition", async () => {
    const parent = parentDef({ definitionId: "wfd_missing1" });
    const { engine } = makeMultiEngine([parent, childDef()]);
    await expect(engine.startInstance({ definitionId: parent.id, tenantId: TENANT })).rejects.toThrow(
      /no workflow definition with id wfd_missing1/,
    );
  });

  it("refuses an action naming neither definitionKey nor definitionId", async () => {
    const parent = parentDef({});
    const { engine } = makeMultiEngine([parent, childDef()]);
    const err = await engine
      .startInstance({ definitionId: parent.id, tenantId: TENANT })
      .then(() => null)
      .catch((e: unknown) => e);
    expect((err as WorkflowActionError).failure).toBe("missing_parameter");
    expect((err as WorkflowActionError).actionKind).toBe("spawn_child_workflow");
  });

  it("refuses a lineage deeper than MAX_CHILD_WORKFLOW_DEPTH instead of recursing forever", async () => {
    const selfSpawning = definitionFixture({
      id: "wfd_selfspa1",
      definitionKey: "self.flow",
      initialState: "start",
      states: [st("start", "initial"), st("looping", "intermediate")],
      transitions: [
        tr({
          name: "recurse",
          from: "start",
          to: "looping",
          trigger: { kind: "automatic" },
          post: [{ kind: "spawn_child_workflow", parameters: { definitionKey: "self.flow" } }],
        }),
      ],
    });
    const { engine } = makeMultiEngine([selfSpawning]);
    const err = await engine
      .startInstance({ definitionId: selfSpawning.id, tenantId: TENANT })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowActionError);
    expect((err as WorkflowActionError).failure).toBe("child_depth_exceeded");
    expect(MAX_CHILD_WORKFLOW_DEPTH).toBeGreaterThan(0);
  });

  it("replays parent and child identically in a second engine", async () => {
    const parent = parentDef();
    const child = childDef();
    const { engine, log } = makeMultiEngine([parent, child]);
    const state = await engine.startInstance({ definitionId: parent.id, tenantId: TENANT });
    const parentEvents = await engine.listEvents(state.instanceId);
    expectSchemaValid(parentEvents);
    const childId = parentEvents.find((e) => e.kind === "child_workflow_spawned")!.childInstanceId!;
    expectSchemaValid(await engine.listEvents(childId));
    expect(await replayIn([parent, child], log, state.instanceId)).toEqual(state);
    expect(await replayIn([parent, child], log, childId)).toEqual(await engine.getInstanceState(childId));
  });
});

// ── send_signal ────────────────────────────────────────────────────────────────

function senderDef(sendParams: Record<string, unknown>, variables: Record<string, unknown> = {}): WorkflowDefinition {
  return definitionFixture({
    id: "wfd_sender01",
    definitionKey: "sender.flow",
    initialState: "start",
    states: [
      st("start", "initial", Object.entries(variables).map(
        ([name, value]): DefAction => ({ kind: "set_variable", parameters: { variableName: name, value } }),
      )),
      st("sent", "terminal_success"),
    ],
    transitions: [
      tr({
        name: "send",
        from: "start",
        to: "sent",
        trigger: { kind: "automatic" },
        pre: [{ kind: "send_signal", parameters: sendParams }],
      }),
    ],
  });
}

async function startReceiver(engine: WorkflowEngine, receiver: WorkflowDefinition, correlationKey: string) {
  return engine.startInstance({ definitionId: receiver.id, tenantId: TENANT, correlationKey });
}

describe("send_signal action", () => {
  it("delivers to a correlated sibling, which advances and completes", async () => {
    const receiver = definitionFixture();
    const sender = senderDef({ signalName: "approve", correlationKey: "po-1" });
    const { engine } = makeMultiEngine([receiver, sender]);
    const waiting = await startReceiver(engine, receiver, "po-1");
    expect(waiting.status).toBe("waiting_for_signal");

    const sent = await engine.startInstance({ definitionId: sender.id, tenantId: TENANT });
    expect(sent.status).toBe("completed");
    const received = await engine.listEvents(waiting.instanceId);
    expect(received.map((e) => e.kind)).toEqual([
      "instance_started",
      "state_transitioned",
      "signal_received",
      "state_transitioned",
      "signal_consumed",
      "instance_completed",
    ]);
    expect((await engine.getInstanceState(waiting.instanceId))?.currentState).toBe("approved");
  });

  it("threads the action payload into the delivered signal", async () => {
    const receiver = definitionFixture();
    const sender = senderDef({ signalName: "approve", correlationKey: "po-1", payload: { approver: "ops" } });
    const { engine } = makeMultiEngine([receiver, sender]);
    const waiting = await startReceiver(engine, receiver, "po-1");
    await engine.startInstance({ definitionId: sender.id, tenantId: TENANT });
    const signal = (await engine.listEvents(waiting.instanceId)).find((e) => e.kind === "signal_received")!;
    expect(signal.payload["payload"]).toEqual({ approver: "ops" });
    expect(signal.payload["signalName"]).toBe("approve");
  });

  it("reads the correlation key from an instance variable", async () => {
    const receiver = definitionFixture();
    const sender = senderDef({ signalName: "approve", correlationVariable: "target_key" }, { target_key: "po-2" });
    const { engine } = makeMultiEngine([receiver, sender]);
    const waiting = await startReceiver(engine, receiver, "po-2");
    await engine.startInstance({ definitionId: sender.id, tenantId: TENANT });
    expect((await engine.getInstanceState(waiting.instanceId))?.status).toBe("completed");
  });

  it("stringifies a numeric correlation variable", async () => {
    const receiver = definitionFixture();
    const sender = senderDef({ signalName: "approve", correlationVariable: "target_key" }, { target_key: 42 });
    const { engine } = makeMultiEngine([receiver, sender]);
    const waiting = await startReceiver(engine, receiver, "42");
    await engine.startInstance({ definitionId: sender.id, tenantId: TENANT });
    expect((await engine.getInstanceState(waiting.instanceId))?.status).toBe("completed");
  });

  it("prefers an explicit correlationKey over a correlationVariable", async () => {
    const receiver = definitionFixture();
    const sender = senderDef(
      { signalName: "approve", correlationKey: "po-1", correlationVariable: "target_key" },
      { target_key: "po-other" },
    );
    const { engine } = makeMultiEngine([receiver, sender]);
    const addressed = await startReceiver(engine, receiver, "po-1");
    await engine.startInstance({ definitionId: sender.id, tenantId: TENANT });
    expect((await engine.getInstanceState(addressed.instanceId))?.status).toBe("completed");
  });

  it("completes the sender even when nothing correlates", async () => {
    const sender = senderDef({ signalName: "approve", correlationKey: "nobody" });
    const { engine } = makeMultiEngine([sender]);
    const sent = await engine.startInstance({ definitionId: sender.id, tenantId: TENANT });
    expect(sent.status).toBe("completed");
  });

  it("does not deliver across tenants", async () => {
    const receiver = definitionFixture();
    const sender = senderDef({ signalName: "approve", correlationKey: "po-1" });
    const { engine } = makeMultiEngine([receiver, sender]);
    const waiting = await startReceiver(engine, receiver, "po-1");
    await engine.startInstance({
      definitionId: sender.id,
      tenantId: "00000000-0000-4000-8000-000000000002",
    });
    expect((await engine.getInstanceState(waiting.instanceId))?.status).toBe("waiting_for_signal");
  });

  it("refuses an action with no signalName", async () => {
    const sender = senderDef({ correlationKey: "po-1" });
    const { engine } = makeMultiEngine([sender]);
    const err = await engine
      .startInstance({ definitionId: sender.id, tenantId: TENANT })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowActionError);
    expect((err as WorkflowActionError).failure).toBe("missing_parameter");
    expect((err as WorkflowActionError).actionKind).toBe("send_signal");
  });

  it("refuses an action with no correlation key at all", async () => {
    const sender = senderDef({ signalName: "approve" });
    const { engine } = makeMultiEngine([sender]);
    const err = await engine
      .startInstance({ definitionId: sender.id, tenantId: TENANT })
      .then(() => null)
      .catch((e: unknown) => e);
    expect((err as WorkflowActionError).failure).toBe("missing_parameter");
    expect((err as WorkflowActionError).message).toMatch(/correlationKey or correlationVariable/);
  });

  it("refuses a correlationVariable holding no usable key rather than correlating to nothing", async () => {
    const sender = senderDef({ signalName: "approve", correlationVariable: "target_key" }, { target_key: null });
    const { engine } = makeMultiEngine([sender]);
    const err = await engine
      .startInstance({ definitionId: sender.id, tenantId: TENANT })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowActionError);
    expect((err as WorkflowActionError).failure).toBe("unresolved_correlation_key");
    expect((err as WorkflowActionError).message).toMatch(/target_key/);
  });

  it("refuses a signal cycle at MAX_SIGNAL_DISPATCH_DEPTH", async () => {
    const echo = definitionFixture({
      id: "wfd_echo0001",
      definitionKey: "echo.flow",
      initialState: "a",
      states: [st("a", "initial"), st("b", "intermediate")],
      transitions: [
        tr({
          name: "a_to_b",
          from: "a",
          to: "b",
          trigger: { kind: "signal_received", signalName: "ping" },
          pre: [{ kind: "send_signal", parameters: { signalName: "ping", correlationKey: "echo" } }],
        }),
      ],
    });
    const { engine } = makeMultiEngine([echo]);
    await engine.startInstance({ definitionId: echo.id, tenantId: TENANT, correlationKey: "echo" });
    const err = await engine
      .submitSignal({ signalName: "ping", correlationKey: "echo", tenantId: TENANT })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowActionError);
    expect((err as WorkflowActionError).failure).toBe("signal_depth_exceeded");
    expect(MAX_SIGNAL_DISPATCH_DEPTH).toBeGreaterThan(0);
  });

  it("releases the dispatch depth so a later send still works", async () => {
    const receiver = definitionFixture();
    const sender = senderDef({ signalName: "approve", correlationKey: "po-1" });
    const { engine } = makeMultiEngine([receiver, sender]);
    const first = await startReceiver(engine, receiver, "po-1");
    await engine.startInstance({ definitionId: sender.id, tenantId: TENANT });
    const second = await startReceiver(engine, receiver, "po-1");
    await engine.startInstance({ definitionId: sender.id, tenantId: TENANT });
    expect((await engine.getInstanceState(first.instanceId))?.status).toBe("completed");
    expect((await engine.getInstanceState(second.instanceId))?.status).toBe("completed");
  });

  it("replays sender and receiver identically in a second engine", async () => {
    const receiver = definitionFixture();
    const sender = senderDef({ signalName: "approve", correlationKey: "po-1" });
    const { engine, log } = makeMultiEngine([receiver, sender]);
    const waiting = await startReceiver(engine, receiver, "po-1");
    const sent = await engine.startInstance({ definitionId: sender.id, tenantId: TENANT });
    expectSchemaValid(await engine.listEvents(waiting.instanceId));
    expectSchemaValid(await engine.listEvents(sent.instanceId));
    expect(await replayIn([receiver, sender], log, waiting.instanceId)).toEqual(
      await engine.getInstanceState(waiting.instanceId),
    );
    expect(await replayIn([receiver, sender], log, sent.instanceId)).toEqual(sent);
  });
});

describe("WorkflowActionError", () => {
  it("carries the action kind, failure and instance id, and names what to change", () => {
    const err = new WorkflowActionError({
      actionKind: "send_signal",
      failure: "missing_parameter",
      instanceId: "wfi_00000001",
      detail: "parameters.signalName must be a non-empty string",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("WorkflowActionError");
    expect(err.actionKind).toBe("send_signal");
    expect(err.failure).toBe("missing_parameter");
    expect(err.instanceId).toBe("wfi_00000001");
    expect(err.message).toBe(
      "send_signal action on instance wfi_00000001 cannot run: parameters.signalName must be a non-empty string",
    );
  });

  it("enumerates every failure kind it can report", () => {
    expect([...WORKFLOW_ACTION_FAILURES]).toEqual([
      "missing_parameter",
      "unknown_child_definition",
      "unresolved_correlation_key",
      "child_depth_exceeded",
      "signal_depth_exceeded",
    ]);
  });
});

describe("cancelInstance — the guarantee", () => {
  /**
   * A definition with a timer, a compensatable side-effect activity and a terminal state, so one
   * fixture exercises every kind of outstanding work a cancellation has to answer for.
   */
  function sagaDef(
    over: Partial<WorkflowDefinition> = {},
  ): WorkflowDefinition {
    return {
      ...definitionFixture(),
      compensationStrategy: "immediate_reverse_order",
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [
            {
              kind: "schedule_activity",
              parameters: {
                activityKey: "charge_card",
                kind: "http_call",
                input: { amount: 100 },
                compensationActivityKey: "refund_card",
              },
            },
            { kind: "schedule_timer", parameters: { timerName: "deadline", relativeSeconds: 600 } },
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
          name: "approved",
          kind: "terminal_success",
          label: "Approved",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [
        {
          name: "charged",
          fromState: "draft",
          toState: "awaiting_approval",
          trigger: { kind: "activity_completed", activityKey: "charge_card" },
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
          name: "timeout",
          fromState: "awaiting_approval",
          toState: "approved",
          trigger: { kind: "timer_fired", timerName: "deadline" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
      initialState: "draft",
      ...over,
    };
  }

  function sideEffectRegistry(
    refunds: string[] = [],
  ): ActivityRegistry {
    const r = createDefaultRegistry();
    r.registerForKind("http_call", () => ({ status: "succeeded", output: { charged: true } }));
    r.registerForActivity("wfd_def00001", "refund_card", (inv) => {
      refunds.push(inv.instanceId);
      return { status: "succeeded" };
    });
    return r;
  }

  const abandon = { disposition: "abandon" as const, reason: "buyer withdrew", requestedByUserId: USER };
  const compensate = { disposition: "compensate" as const, reason: "buyer withdrew", requestedByUserId: USER };

  it("records the fence first and the terminal event last", async () => {
    const { engine, definition } = makeEngine({
      definition: sagaDef(),
      registry: sideEffectRegistry(),
    });
    const state = await engine.startInstance({ definitionId: definition.id, tenantId: TENANT });
    const result = await engine.cancelInstance({ ...abandon, instanceId: state.instanceId });
    expect(result.outcome).toBe("cancelled");
    const kinds = (await engine.listEvents(state.instanceId)).map((e) => e.kind);
    expect(kinds.indexOf("instance_cancellation_requested")).toBeGreaterThan(-1);
    expect(kinds.indexOf("instance_cancellation_requested")).toBeLessThan(
      kinds.indexOf("instance_cancelled"),
    );
    expect(kinds[kinds.length - 1]).toBe("instance_cancelled");
  });

  it("lands the instance cancelled with its reason and actor", async () => {
    const { engine, definition } = makeEngine({
      definition: sagaDef(),
      registry: sideEffectRegistry(),
    });
    const state = await engine.startInstance({ definitionId: definition.id, tenantId: TENANT });
    await engine.cancelInstance({ ...abandon, instanceId: state.instanceId });
    const final = await engine.getInstanceState(state.instanceId);
    expect(final?.status).toBe("cancelled");
    expect(final?.cancelledReason).toBe("buyer withdrew");
    expect(final?.cancelledByUserId).toBe(USER);
    expect(final?.cancellationDisposition).toBe("abandon");
    expect(final?.cancellationRequestedAt).not.toBeNull();
  });

  it("cancels from every non-terminal status the map admits", async () => {
    // created / running are reached by a definition that parks immediately; waiting_for_activity,
    // waiting_for_timer and waiting_for_signal by the saga fixture at its three resting points.
    const cases: readonly [string, WorkflowDefinition][] = [
      ["waiting_for_signal", definitionFixture()],
      ["waiting_for_timer", sagaDef()],
    ];
    for (const [label, def] of cases) {
      const { engine } = makeEngine({ definition: def, registry: sideEffectRegistry() });
      const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
      const result = await engine.cancelInstance({ ...abandon, instanceId: state.instanceId });
      expect(result.outcome, label).toBe("cancelled");
      expect((await engine.getInstanceState(state.instanceId))?.status, label).toBe("cancelled");
    }
  });

  it("refuses a completed instance as terminal, and appends nothing", async () => {
    const { engine, definition } = makeEngine();
    const state = await engine.startInstance({
      definitionId: definition.id,
      tenantId: TENANT,
      correlationKey: "po-x",
    });
    await engine.submitSignal({ signalName: "approve", correlationKey: "po-x", tenantId: TENANT });
    const before = (await engine.listEvents(state.instanceId)).length;
    const result = await engine.cancelInstance({ ...abandon, instanceId: state.instanceId });
    expect(result.outcome).toBe("refused_terminal");
    expect((await engine.listEvents(state.instanceId)).length).toBe(before);
    expect((await engine.getInstanceState(state.instanceId))?.status).toBe("completed");
  });

  it("refuses a failed instance as not cancellable, because the map sends it to compensating", async () => {
    const { engine, definition } = makeEngine();
    const state = await engine.startInstance({
      definitionId: definition.id,
      tenantId: TENANT,
      correlationKey: "po-y",
    });
    await engine.submitSignal({ signalName: "reject", correlationKey: "po-y", tenantId: TENANT });
    expect((await engine.getInstanceState(state.instanceId))?.status).toBe("failed");
    const result = await engine.cancelInstance({ ...abandon, instanceId: state.instanceId });
    expect(result.outcome).toBe("refused_not_cancellable");
  });

  it("reports an unknown instance rather than throwing", async () => {
    const { engine } = makeEngine();
    const result = await engine.cancelInstance({ ...abandon, instanceId: "wfi_nope0001" });
    expect(result.outcome).toBe("unknown_instance");
  });

  it("is idempotent: a second request appends nothing and reports already_requested", async () => {
    const { engine, definition } = makeEngine({
      definition: sagaDef(),
      registry: sideEffectRegistry(),
    });
    const state = await engine.startInstance({ definitionId: definition.id, tenantId: TENANT });
    await engine.cancelInstance({ ...abandon, instanceId: state.instanceId });
    const after = await engine.listEvents(state.instanceId);
    const second = await engine.cancelInstance({
      ...abandon,
      reason: "a different reason",
      instanceId: state.instanceId,
    });
    expect(second.outcome).toBe("already_requested");
    expect((await engine.listEvents(state.instanceId)).length).toBe(after.length);
    // The first request's reason stands, as `COALESCE`-stamping gives the job record.
    expect((await engine.getInstanceState(state.instanceId))?.cancelledReason).toBe(
      "buyer withdrew",
    );
  });

  it("drops an unfired timer, and the drop is in the log with the schedule's name", async () => {
    const { engine, definition } = makeEngine({
      definition: sagaDef(),
      registry: sideEffectRegistry(),
    });
    const state = await engine.startInstance({ definitionId: definition.id, tenantId: TENANT });
    expect(state.awaitingTimerNames).toEqual(["deadline"]);
    const result = await engine.cancelInstance({ ...abandon, instanceId: state.instanceId });
    expect(result.cancelledTimerIds).toHaveLength(1);
    const events = await engine.listEvents(state.instanceId);
    const drop = events.find((e) => e.kind === "timer_cancelled");
    expect(drop?.timerId).toBe(result.cancelledTimerIds[0]);
    expect(drop?.payload["timerName"]).toBe("deadline");
    expect(drop?.payload["cancelledBy"]).toBe("instance_cancellation");
    expect(projectTimers(events).map((t) => t.status)).toEqual(["cancelled"]);
    // The drop carries the name, so the instance stops being recorded as waiting on it.
    expect((await engine.getInstanceState(state.instanceId))?.awaitingTimerNames).toEqual([]);
  });

  it("does not fire a due timer after cancellation", async () => {
    const clock = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine, definition } = makeEngine({
      definition: sagaDef(),
      registry: sideEffectRegistry(),
      clock,
    });
    const state = await engine.startInstance({ definitionId: definition.id, tenantId: TENANT });
    await engine.cancelInstance({ ...abandon, instanceId: state.instanceId });
    clock.advance(3_600_000);
    const tick = await engine.tickTimers(clock.now().getTime());
    expect(tick.firedTimerIds).toEqual([]);
    const kinds = (await engine.listEvents(state.instanceId)).map((e) => e.kind);
    expect(kinds).not.toContain("timer_fired");
    expect((await engine.getInstanceState(state.instanceId))?.status).toBe("cancelled");
  });

  it("does not fire a due timer for an instance that is cancelled but was never requested", async () => {
    // A `terminal_cancelled` state emits `instance_cancelled` with no request event, so the fence
    // has to answer from the status too.
    const clock = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const def = sagaDef();
    const { engine, log } = makeEngine({ definition: def, registry: sideEffectRegistry(), clock });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const seq = (await log.latestSequence(state.instanceId))!;
    await log.append({
      id: "wfe_handwritten1",
      instanceId: state.instanceId,
      tenantId: TENANT,
      sequenceNumber: seq + 1,
      kind: "instance_cancelled",
      occurredAt: clock.nowIso(),
      actorPrincipalId: null,
      actorSystemId: "terminal-state",
      previousState: null,
      newState: null,
      activityId: null,
      signalId: null,
      timerId: null,
      childInstanceId: null,
      variableName: null,
      payload: { reason: "terminal_cancelled state" },
      correlationId: null,
      causationEventId: null,
    });
    const projected = await engine.getInstanceState(state.instanceId);
    expect(projected?.cancellationRequestedAt).toBeNull();
    clock.advance(3_600_000);
    expect((await engine.tickTimers(clock.now().getTime())).firedTimerIds).toEqual([]);
  });

  it("does not start a scheduled activity after cancellation, and records it at before_handler", async () => {
    const { engine, definition } = makeEngine({
      definition: sagaDef(),
      registry: sideEffectRegistry(),
      deferActivities: true,
    });
    const state = await engine.startInstance({ definitionId: definition.id, tenantId: TENANT });
    const scheduledId = state.awaitingActivityIds[0]!;
    const result = await engine.cancelInstance({ ...abandon, instanceId: state.instanceId });
    expect(result.beforeHandlerActivityIds).toEqual([scheduledId]);
    const cancelled = (await engine.listEvents(state.instanceId)).find(
      (e) => e.kind === "activity_cancelled",
    );
    expect(cancelled?.payload["checkpoint"]).toBe("before_handler");
    expect(cancelled?.payload["signalDelivered"]).toBe(false);
    // The deferred worker's entry point refuses it, and says so rather than reporting a phantom run.
    expect(await engine.executeScheduledActivity(state.instanceId, scheduledId)).toEqual({
      executed: false,
    });
    const kinds = (await engine.listEvents(state.instanceId)).map((e) => e.kind);
    expect(kinds).not.toContain("activity_started");
  });

  it("fences every driver entry point, so nothing advances a cancelled instance", async () => {
    // `runStepLoop`'s own guard is defence in depth: the timer, signal and activity fences all sit
    // above it, so no public entry point can reach the loop with a cancelled instance. What is
    // observable — and what a cancellation that stopped only some of the three would break — is that
    // invoking all of them appends nothing and moves nothing.
    const def = sagaDef();
    const { engine, clock } = makeEngine({
      definition: def,
      registry: sideEffectRegistry(),
      deferActivities: true,
    });
    const state = await engine.startInstance({
      definitionId: def.id,
      tenantId: TENANT,
      correlationKey: "po-fence",
    });
    const scheduledId = state.awaitingActivityIds[0]!;
    await engine.cancelInstance({ ...abandon, instanceId: state.instanceId });
    const afterCancel = await engine.listEvents(state.instanceId);
    const stateAfterCancel = await engine.getInstanceState(state.instanceId);

    clock.advance(3_600_000);
    await engine.tickTimers(clock.now().getTime());
    await engine.submitSignal({
      signalName: "approve",
      correlationKey: "po-fence",
      tenantId: TENANT,
    });
    expect(await engine.executeScheduledActivity(state.instanceId, scheduledId)).toEqual({
      executed: false,
    });

    expect(await engine.listEvents(state.instanceId)).toEqual(afterCancel);
    expect(await engine.getInstanceState(state.instanceId)).toEqual(stateAfterCancel);
  });

  it("emits no instance_completed for a cancelled instance parked in a terminal state", async () => {
    // The step-loop fence is checked *above* the terminal-state-kind emit for this case: a cancelled
    // instance whose currentState is `terminal_success` must not then be reported as completed.
    const def = sagaDef();
    const { engine, log, clock } = makeEngine({
      definition: def,
      registry: sideEffectRegistry(),
      deferActivities: true,
    });
    const state = await engine.startInstance({
      definitionId: def.id,
      tenantId: TENANT,
      correlationKey: "po-terminal",
    });
    await engine.cancelInstance({ ...abandon, instanceId: state.instanceId });
    const seq = (await log.latestSequence(state.instanceId))!;
    await log.append({
      id: "wfe_handplaced1",
      instanceId: state.instanceId,
      tenantId: TENANT,
      sequenceNumber: seq + 1,
      kind: "state_transitioned",
      occurredAt: clock.nowIso(),
      actorPrincipalId: null,
      actorSystemId: "test",
      previousState: "draft",
      newState: "approved",
      activityId: null,
      signalId: null,
      timerId: null,
      childInstanceId: null,
      variableName: null,
      payload: { transitionName: "hand-placed" },
      correlationId: null,
      causationEventId: null,
    });
    const parked = await engine.getInstanceState(state.instanceId);
    expect(parked?.currentState).toBe("approved");
    // The seal keeps the status cancelled even though a state_transitioned followed it.
    expect(parked?.status).toBe("cancelled");

    clock.advance(3_600_000);
    await engine.tickTimers(clock.now().getTime());
    await engine.submitSignal({
      signalName: "approve",
      correlationKey: "po-terminal",
      tenantId: TENANT,
    });
    const kinds = (await engine.listEvents(state.instanceId)).map((e) => e.kind);
    expect(kinds).not.toContain("instance_completed");
    expect((await engine.getInstanceState(state.instanceId))?.status).toBe("cancelled");
  });

  it("does not deliver a signal to a cancelled instance", async () => {
    const { engine, definition } = makeEngine();
    const state = await engine.startInstance({
      definitionId: definition.id,
      tenantId: TENANT,
      correlationKey: "po-sig",
    });
    await engine.cancelInstance({ ...abandon, instanceId: state.instanceId });
    const delivery = await engine.submitSignal({
      signalName: "approve",
      correlationKey: "po-sig",
      tenantId: TENANT,
    });
    expect(delivery.matchedInstanceIds).toEqual([]);
    const kinds = (await engine.listEvents(state.instanceId)).map((e) => e.kind);
    expect(kinds).not.toContain("signal_received");
    expect((await engine.getInstanceState(state.instanceId))?.status).toBe("cancelled");
  });

  it("tells an in-flight handler, and one that ignores the signal still lands cancelled", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let announce: ((id: string) => void) | undefined;
    const entered = new Promise<string>((resolve) => {
      announce = resolve;
    });
    let sawAbort = false;
    const registry = createDefaultRegistry();
    registry.registerForKind("http_call", async (inv) => {
      announce?.(inv.instanceId);
      await gate;
      sawAbort = inv.signal.aborted;
      // Deliberately ignores the signal and reports success anyway.
      return { status: "succeeded", output: { charged: true } };
    });
    const def = sagaDef();
    const { engine } = makeEngine({ definition: def, registry });

    // Parked inside the handler, which is the only window in which `in_flight_activity`'s weaker
    // guarantee is the one that applies.
    const starting = engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const id = await entered;

    const result = await engine.cancelInstance({ ...abandon, instanceId: id });
    expect(result.outcome).toBe("cancelled");
    expect(result.cooperativeAbortActivityIds).toHaveLength(1);
    expect(result.signalDeliveredActivityIds).toEqual(result.cooperativeAbortActivityIds);

    release?.();
    await starting;
    expect(sawAbort).toBe(true);

    const events = await engine.listEvents(id);
    const cancelled = events.find((e) => e.kind === "activity_cancelled");
    expect(cancelled?.payload["checkpoint"]).toBe("cooperative_abort");
    expect(cancelled?.payload["signalDelivered"]).toBe(true);
    // The handler's report is a fact and is in the log; it moves nothing.
    expect(events.map((e) => e.kind)).toContain("activity_completed");
    const final = await engine.getInstanceState(id);
    expect(final?.status).toBe("cancelled");
    expect(final?.cancellationSignalledActivityIds).toEqual(result.cooperativeAbortActivityIds);
    // And the activity record keeps `cancelled` while still carrying what the handler produced.
    const activity = projectActivities(events).find(
      (a) => a.id === result.cooperativeAbortActivityIds[0],
    );
    expect(activity?.status).toBe("cancelled");
    expect(activity?.outputSha256).not.toBeNull();
  });

  it("runs the saga rollback when the request asks to compensate", async () => {
    const refunds: string[] = [];
    const def = sagaDef();
    const { engine } = makeEngine({ definition: def, registry: sideEffectRegistry(refunds) });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    expect(state.currentState).toBe("awaiting_approval");
    const result = await engine.cancelInstance({ ...compensate, instanceId: state.instanceId });
    expect(result.compensationOutcome).toBe("executed");
    expect(result.compensatedActivityIds).toHaveLength(1);
    expect(result.unreversedActivityIds).toEqual([]);
    expect(refunds).toEqual([state.instanceId]);
    const events = await engine.listEvents(state.instanceId);
    expect(events.map((e) => e.kind)).toContain("activity_compensated");
    // Not the compensating/compensated bracket: the instance ends `cancelled`, because that is what
    // the caller asked for and `compensated` would be indistinguishable from unwinding a failure.
    expect(events.map((e) => e.kind)).not.toContain("compensation_started");
    expect((await engine.getInstanceState(state.instanceId))?.status).toBe("cancelled");
  });

  it("leaves the side effect standing when the request abandons, and says which", async () => {
    const refunds: string[] = [];
    const def = sagaDef();
    const { engine } = makeEngine({ definition: def, registry: sideEffectRegistry(refunds) });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const result = await engine.cancelInstance({ ...abandon, instanceId: state.instanceId });
    expect(result.compensationOutcome).toBe("skipped_by_request");
    expect(result.compensatedActivityIds).toEqual([]);
    expect(result.unreversedActivityIds).toHaveLength(1);
    expect(refunds).toEqual([]);
    const final = (await engine.listEvents(state.instanceId)).at(-1);
    expect(final?.payload["unreversedActivityIds"]).toEqual(result.unreversedActivityIds);
    expect(final?.payload["compensationOutcome"]).toBe("skipped_by_request");
  });

  it("defers rather than rolls back under manual_review, and records that", async () => {
    const refunds: string[] = [];
    const def = sagaDef({ compensationStrategy: "manual_review" });
    const { engine } = makeEngine({ definition: def, registry: sideEffectRegistry(refunds) });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const result = await engine.cancelInstance({ ...compensate, instanceId: state.instanceId });
    expect(result.compensationOutcome).toBe("deferred_to_human");
    expect(refunds).toEqual([]);
    expect(result.unreversedActivityIds).toHaveLength(1);
  });

  it("reports unavailable when the definition declares no compensation", async () => {
    const def = sagaDef({ compensationStrategy: "no_compensation" });
    const { engine } = makeEngine({ definition: def, registry: sideEffectRegistry() });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const result = await engine.cancelInstance({ ...compensate, instanceId: state.instanceId });
    expect(result.compensationOutcome).toBe("unavailable");
    expect(result.unreversedActivityIds).toHaveLength(1);
  });

  it("refuses a request with no disposition", async () => {
    const { engine, definition } = makeEngine({
      definition: sagaDef(),
      registry: sideEffectRegistry(),
    });
    const state = await engine.startInstance({ definitionId: definition.id, tenantId: TENANT });
    await expect(
      engine.cancelInstance({
        instanceId: state.instanceId,
        reason: "no disposition",
        requestedByUserId: USER,
      } as never),
    ).rejects.toThrow(/disposition/);
  });

  it("answers from the log alone: a fresh fold of the events gives the same state", async () => {
    const def = sagaDef();
    const { engine } = makeEngine({ definition: def, registry: sideEffectRegistry() });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    await engine.cancelInstance({ ...compensate, instanceId: state.instanceId });
    const events = await engine.listEvents(state.instanceId);
    const refolded = projectInstance(events, def);
    const live = await engine.getInstanceState(state.instanceId);
    expect(refolded).toEqual(live);
    expect(refolded?.status).toBe("cancelled");
    expect(isInstanceCancelled(refolded!)).toBe(true);
    expect(isInstanceCancellationRequested(refolded!)).toBe(true);
    // And the whole history stays a dense, schema-valid, append-only log.
    expect(isHistoryDense(events)).toBe(true);
    for (const e of events) {
      expect(() => WorkflowEventSchema.parse(e), e.kind).not.toThrow();
    }
  });

  it("records the cancellation under the requesting system when no user asked", async () => {
    const { engine, definition } = makeEngine({
      definition: sagaDef(),
      registry: sideEffectRegistry(),
    });
    const state = await engine.startInstance({ definitionId: definition.id, tenantId: TENANT });
    await engine.cancelInstance({
      instanceId: state.instanceId,
      disposition: "abandon",
      reason: "tenant deprovisioned",
      requestedBySystem: "tenant-lifecycle",
    });
    const fence = (await engine.listEvents(state.instanceId)).find(
      (e) => e.kind === "instance_cancellation_requested",
    );
    expect(fence?.actorSystemId).toBe("tenant-lifecycle");
    expect((await engine.getInstanceState(state.instanceId))?.cancellationRequestedBy).toBe(
      "tenant-lifecycle",
    );
  });

  it("does not cascade to a child instance", async () => {
    const childDef: WorkflowDefinition = {
      ...definitionFixture(),
      id: "wfd_child0001",
      definitionKey: "child.flow",
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [
            { kind: "schedule_timer", parameters: { timerName: "child_deadline", relativeSeconds: 600 } },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [],
      initialState: "draft",
    };
    const parentDef: WorkflowDefinition = {
      ...definitionFixture(),
      states: [
        {
          name: "draft",
          kind: "initial",
          label: "Draft",
          onEntryActions: [
            { kind: "spawn_child_workflow", parameters: { definitionKey: "child.flow" } },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: [],
      initialState: "draft",
    };
    const log = new InMemoryEventLog();
    const engine = new WorkflowEngine({
      eventLog: log,
      definitions: new Map([
        [parentDef.id, parentDef],
        [childDef.id, childDef],
      ]),
      activityRegistry: createDefaultRegistry(),
      clock: new FixedClock(new Date("2026-05-16T12:00:00.000Z")),
      idGenerator: new CountingIdGenerator(),
    });
    const parent = await engine.startInstance({
      definitionId: parentDef.id,
      tenantId: TENANT,
    });
    const spawn = (await engine.listEvents(parent.instanceId)).find(
      (e) => e.kind === "child_workflow_spawned",
    );
    const childId = spawn?.childInstanceId;
    expect(childId).toBeDefined();
    await engine.cancelInstance({ ...abandon, instanceId: parent.instanceId });
    const child = await engine.getInstanceState(childId!);
    expect(child?.status).not.toBe("cancelled");
    expect(child?.cancellationRequestedAt).toBeNull();
    // Cancelling it is a separate request, by its own id — and it then works.
    expect(
      (await engine.cancelInstance({ ...abandon, instanceId: childId! })).outcome,
    ).toBe("cancelled");
  });
});
