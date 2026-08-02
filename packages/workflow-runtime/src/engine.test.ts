import type { WorkflowDefinition } from "@crossengin/workflow-engine";
import { describe, expect, it } from "vitest";

import {
  ActivityRegistry,
  createDefaultRegistry,
  type ActivityHandler,
} from "./activity-handlers.js";
import { CountingIdGenerator, FixedClock } from "./clock.js";
import { InMemoryEventLog } from "./event-log.js";
import { WorkflowEngine } from "./engine.js";

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
