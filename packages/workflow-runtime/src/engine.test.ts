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

describe("fireTimer (per-unit, for the distributed worker)", () => {
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

  async function scheduledTimerId(engine: ReturnType<typeof makeEngine>["engine"], instanceId: string): Promise<string> {
    const events = await engine.listEvents(instanceId);
    const ev = events.find((e) => e.kind === "timer_scheduled" && e.timerId !== null);
    return ev!.timerId!;
  }

  it("fires one specific due timer and runs the transition", async () => {
    const def = timerDef(60);
    const fixed = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine } = makeEngine({ definition: def, clock: fixed });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const timerId = await scheduledTimerId(engine, state.instanceId);
    fixed.advance(120_000);

    const result = await engine.fireTimer({ instanceId: state.instanceId, timerId, nowMs: fixed.now().getTime() });
    expect(result).toMatchObject({ fired: true, timerId, timerName: "deadline" });
    expect((await engine.getInstanceState(state.instanceId))?.currentState).toBe("rejected");
  });

  it("is idempotent: firing an already-fired timer is a no-op", async () => {
    const def = timerDef(60);
    const fixed = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine } = makeEngine({ definition: def, clock: fixed });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const timerId = await scheduledTimerId(engine, state.instanceId);
    fixed.advance(120_000);
    await engine.fireTimer({ instanceId: state.instanceId, timerId, nowMs: fixed.now().getTime() });
    const second = await engine.fireTimer({ instanceId: state.instanceId, timerId, nowMs: fixed.now().getTime() });
    expect(second.fired).toBe(false);
  });

  it("does not fire a timer that isn't due yet", async () => {
    const def = timerDef(3_600);
    const fixed = new FixedClock(new Date("2026-05-16T12:00:00.000Z"));
    const { engine } = makeEngine({ definition: def, clock: fixed });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const timerId = await scheduledTimerId(engine, state.instanceId);
    fixed.advance(60_000);
    expect((await engine.fireTimer({ instanceId: state.instanceId, timerId, nowMs: fixed.now().getTime() })).fired).toBe(false);
  });

  it("is a no-op for an unknown timer / instance", async () => {
    const def = timerDef(60);
    const { engine } = makeEngine({ definition: def, clock: new FixedClock(new Date("2026-05-16T12:00:00.000Z")) });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    expect((await engine.fireTimer({ instanceId: state.instanceId, timerId: "wft_nope" })).fired).toBe(false);
    expect((await engine.fireTimer({ instanceId: "wfi_nope", timerId: "wft_x" })).fired).toBe(false);
  });
});

describe("retryActivity (per-unit, for the activity retry executor)", () => {
  const activityDef: WorkflowDefinition = {
    ...definitionFixture(),
    states: [
      { name: "draft", kind: "initial", label: "Draft", onEntryActions: [], onExitActions: [], slaSeconds: null },
      {
        name: "working",
        kind: "intermediate",
        label: "Working",
        onEntryActions: [{ kind: "schedule_activity", parameters: { activityKey: "work", kind: "transformation", input: { n: 7 } } }],
        onExitActions: [],
        slaSeconds: null,
      },
      { name: "done", kind: "terminal_success", label: "Done", onEntryActions: [], onExitActions: [], slaSeconds: null },
    ],
    transitions: [
      { name: "start", fromState: "draft", toState: "working", trigger: { kind: "automatic" }, guards: [], preTransitionActions: [], postTransitionActions: [] },
      { name: "complete", fromState: "working", toState: "done", trigger: { kind: "activity_completed", activityKey: "work" }, guards: [], preTransitionActions: [], postTransitionActions: [] },
    ],
    initialState: "draft",
  };

  /** Registry whose "work" activity fails on attempt 1, succeeds on attempt 2 — capturing the input it saw. */
  function flakyRegistry(): { registry: ActivityRegistry; inputs: unknown[] } {
    const registry = createDefaultRegistry();
    const inputs: unknown[] = [];
    registry.registerForActivity(activityDef.id, "work", async (inv) => {
      inputs.push(inv.input);
      return inv.attemptNumber === 1
        ? { status: "failed", errorCode: "FLAKY", errorMessage: "first attempt fails", retryable: true }
        : { status: "succeeded", output: { ok: true } };
    });
    return { registry, inputs };
  }

  async function activityId(engine: ReturnType<typeof makeEngine>["engine"], instanceId: string): Promise<string> {
    const events = await engine.listEvents(instanceId);
    return events.find((e) => e.kind === "activity_scheduled")!.activityId!;
  }

  it("re-runs a failed activity (with its original input) and completes the workflow", async () => {
    const { registry, inputs } = flakyRegistry();
    const { engine } = makeEngine({ definition: activityDef, registry });
    const state = await engine.startInstance({ definitionId: activityDef.id, tenantId: TENANT });
    // attempt 1 failed inline; instance is parked in "working"
    expect((await engine.getInstanceState(state.instanceId))?.currentState).toBe("working");
    const aId = await activityId(engine, state.instanceId);

    const result = await engine.retryActivity({ instanceId: state.instanceId, activityId: aId });
    expect(result).toMatchObject({ retried: true, status: "succeeded", activityId: aId });
    expect((await engine.getInstanceState(state.instanceId))?.currentState).toBe("done");
    expect(inputs).toEqual([{ n: 7 }, { n: 7 }]); // original input replayed on retry
  });

  it("is a no-op for an activity that already succeeded", async () => {
    const { registry } = flakyRegistry();
    const { engine } = makeEngine({ definition: activityDef, registry });
    const state = await engine.startInstance({ definitionId: activityDef.id, tenantId: TENANT });
    const aId = await activityId(engine, state.instanceId);
    await engine.retryActivity({ instanceId: state.instanceId, activityId: aId }); // succeeds
    const again = await engine.retryActivity({ instanceId: state.instanceId, activityId: aId });
    expect(again.retried).toBe(false);
  });

  it("is a no-op for an unknown activity / instance", async () => {
    const { registry } = flakyRegistry();
    const { engine } = makeEngine({ definition: activityDef, registry });
    const state = await engine.startInstance({ definitionId: activityDef.id, tenantId: TENANT });
    expect((await engine.retryActivity({ instanceId: state.instanceId, activityId: "wfa_nope" })).retried).toBe(false);
    expect((await engine.retryActivity({ instanceId: "wfi_nope", activityId: "wfa_x" })).retried).toBe(false);
  });
});

describe("timeoutInstance (per-unit, for the timeout sweeper)", () => {
  const FAR_FUTURE = new Date("2026-06-01T00:00:00.000Z").getTime();

  it("fails a non-terminal instance past its deadline with INSTANCE_TIMEOUT", async () => {
    const { engine } = makeEngine();
    const def = definitionFixture();
    const start = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    // parked waiting for the approve/reject signal
    expect((await engine.getInstanceState(start.instanceId))?.status).toBe("waiting_for_signal");

    const result = await engine.timeoutInstance({ instanceId: start.instanceId, nowMs: FAR_FUTURE });
    expect(result).toMatchObject({ timedOut: true, previousStatus: "waiting_for_signal" });
    const state = await engine.getInstanceState(start.instanceId);
    expect(state?.status).toBe("failed");
    expect(state?.failureCode).toBe("INSTANCE_TIMEOUT");
  });

  it("is a no-op when the deadline has not passed (race-safe)", async () => {
    const { engine } = makeEngine();
    const def = definitionFixture();
    const start = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const result = await engine.timeoutInstance({ instanceId: start.instanceId, nowMs: Date.parse("2026-05-16T12:00:01.000Z") });
    expect(result.timedOut).toBe(false);
    expect((await engine.getInstanceState(start.instanceId))?.status).toBe("waiting_for_signal");
  });

  it("is idempotent — a second sweep of a timed-out instance is a no-op", async () => {
    const { engine } = makeEngine();
    const def = definitionFixture();
    const start = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    await engine.timeoutInstance({ instanceId: start.instanceId, nowMs: FAR_FUTURE });
    const again = await engine.timeoutInstance({ instanceId: start.instanceId, nowMs: FAR_FUTURE });
    expect(again).toMatchObject({ timedOut: false, previousStatus: "failed" });
  });

  it("is a no-op for an unknown instance", async () => {
    const { engine } = makeEngine();
    expect((await engine.timeoutInstance({ instanceId: "wfi_nope", nowMs: FAR_FUTURE })).timedOut).toBe(false);
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

  it("persists the retry policy on the scheduled event and stamps nextRetryAt on the failure", async () => {
    const failingHandler: ActivityHandler = () => ({
      status: "failed",
      errorCode: "FLAKY",
      errorMessage: "fails",
      retryable: true,
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
                timeoutSeconds: 120,
                retryPolicy: {
                  strategy: "fixed_delay",
                  maxAttempts: 3,
                  initialDelaySeconds: 30,
                  maxDelaySeconds: 300,
                  retryableErrorCodes: [],
                  nonRetryableErrorCodes: [],
                },
              },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        { name: "parked", kind: "waiting", label: "Parked", onEntryActions: [], onExitActions: [], slaSeconds: null },
      ],
      transitions: [
        { name: "park", fromState: "draft", toState: "parked", trigger: { kind: "activity_failed", activityKey: "do_thing" }, guards: [], preTransitionActions: [], postTransitionActions: [] },
      ],
      initialState: "draft",
    };
    const registry = createDefaultRegistry().registerForKind("http_call", failingHandler);
    const { engine } = makeEngine({ definition: def, registry });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const events = await engine.listEvents(state.instanceId);
    const scheduled = events.find((e) => e.kind === "activity_scheduled")!;
    expect(scheduled.payload["maxAttempts"]).toBe(3);
    expect((scheduled.payload["retryPolicy"] as { strategy: string }).strategy).toBe("fixed_delay");
    expect(scheduled.payload["timeoutSeconds"]).toBe(120);
    const failed = events.find((e) => e.kind === "activity_failed")!;
    // clock fixed at 12:00:00, fixed_delay 30s → 12:00:30, attempt 1 < maxAttempts 3
    expect(failed.payload["nextRetryAt"]).toBe("2026-05-16T12:00:30.000Z");
  });

  it("leaves nextRetryAt null when the policy won't retry (no_retry)", async () => {
    const failingHandler: ActivityHandler = () => ({ status: "failed", errorCode: "X", errorMessage: "x", retryable: false });
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
                retryPolicy: {
                  strategy: "no_retry",
                  maxAttempts: 1,
                  initialDelaySeconds: 1,
                  maxDelaySeconds: 1,
                  retryableErrorCodes: [],
                  nonRetryableErrorCodes: [],
                },
              },
            },
          ],
          onExitActions: [],
          slaSeconds: null,
        },
        { name: "parked", kind: "waiting", label: "Parked", onEntryActions: [], onExitActions: [], slaSeconds: null },
      ],
      transitions: [
        { name: "park", fromState: "draft", toState: "parked", trigger: { kind: "activity_failed", activityKey: "do_thing" }, guards: [], preTransitionActions: [], postTransitionActions: [] },
      ],
      initialState: "draft",
    };
    const registry = createDefaultRegistry().registerForKind("http_call", failingHandler);
    const { engine } = makeEngine({ definition: def, registry });
    const state = await engine.startInstance({ definitionId: def.id, tenantId: TENANT });
    const events = await engine.listEvents(state.instanceId);
    expect(events.find((e) => e.kind === "activity_failed")!.payload["nextRetryAt"]).toBeNull();
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
