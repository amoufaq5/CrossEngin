import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { WorkflowDefinition, WorkflowEvent } from "@crossengin/workflow-engine";
import { InMemoryEventLog } from "@crossengin/workflow-runtime";
import { describe, expect, it, vi } from "vitest";

import { PostgresActivityStore } from "./activity-store.js";
import { WorkflowDefinitionIdResolver, WorkflowInstanceIdResolver } from "./id-mapping.js";
import { PostgresInstanceStore } from "./instance-store.js";
import { PostgresSignalStore } from "./signal-store.js";
import { PostgresTimerStore } from "./timer-store.js";
import { ProjectingEventLog, buildPersistentStores } from "./projecting-event-log.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const DEF_UUID = "00000000-0000-4000-8000-000000000900";
const INSTANCE_UUID = "00000000-0000-4000-8000-000000000111";

function fixtureDefinition(): WorkflowDefinition {
  return {
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
        label: "D",
        onEntryActions: [],
        onExitActions: [],
        slaSeconds: null,
      },
      {
        name: "awaiting",
        kind: "waiting",
        label: "W",
        onEntryActions: [],
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
    ],
    transitions: [
      {
        name: "submit",
        fromState: "draft",
        toState: "awaiting",
        trigger: { kind: "automatic" },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      },
      {
        name: "approve",
        fromState: "awaiting",
        toState: "approved",
        trigger: { kind: "signal_received", signalName: "approve" },
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
    createdBy: "00000000-0000-4000-8000-000000000099",
    publishedAt: "2026-05-01T00:00:00.000Z",
    publishedBy: "00000000-0000-4000-8000-000000000099",
    deprecatedAt: null,
    supersededByDefinitionId: null,
    sourceManifestSha256: null,
  };
}

function startedEvent(): WorkflowEvent {
  return {
    id: "wfe_event0001",
    instanceId: "wfi_inst0001",
    tenantId: TENANT,
    sequenceNumber: 0,
    kind: "instance_started",
    occurredAt: "2026-05-16T12:00:00.000Z",
    actorPrincipalId: null,
    actorSystemId: "engine",
    previousState: null,
    newState: null,
    activityId: null,
    signalId: null,
    timerId: null,
    childInstanceId: null,
    variableName: null,
    payload: {
      definitionId: "wfd_def00001",
      definitionKey: "purchase.approval",
      definitionVersion: "1.0.0",
      initialState: "draft",
      variables: { amount: 250 },
      timeoutAt: "2026-05-17T12:00:00.000Z",
    },
    correlationId: null,
    causationEventId: null,
  };
}

function mockConnection(
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      if (capture !== undefined) capture.push({ sql, params });
      if (sql.includes("INSERT INTO meta.workflow_instances")) {
        return { rows: [{ id: INSTANCE_UUID }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

function buildSuite(opts: { definitions?: ReadonlyMap<string, WorkflowDefinition> } = {}) {
  const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  const conn = mockConnection(capture);
  const definitionResolver = new WorkflowDefinitionIdResolver(conn);
  definitionResolver.register("wfd_def00001", DEF_UUID);
  const instanceResolver = new WorkflowInstanceIdResolver(conn);
  const instanceStore = new PostgresInstanceStore({
    conn,
    instanceResolver,
    definitionResolver,
  });
  const activityStore = new PostgresActivityStore({ conn, instanceResolver });
  const signalStore = new PostgresSignalStore({ conn, instanceResolver });
  const timerStore = new PostgresTimerStore({ conn, instanceResolver });
  const inner = new InMemoryEventLog();
  const definitions = opts.definitions ?? new Map([[fixtureDefinition().id, fixtureDefinition()]]);
  const projecting = new ProjectingEventLog({
    inner,
    definitions,
    instanceStore,
    activityStore,
    signalStore,
    timerStore,
  });
  return { projecting, inner, capture, instanceResolver };
}

describe("ProjectingEventLog.append — instance_started", () => {
  it("creates the workflow_instances row before appending the event", async () => {
    const { projecting, capture, instanceResolver } = buildSuite();
    await projecting.append(startedEvent());
    const insertInstance = capture.findIndex((c) =>
      c.sql.includes("INSERT INTO meta.workflow_instances"),
    );
    expect(insertInstance).toBeGreaterThanOrEqual(0);
    expect(await instanceResolver.resolve("wfi_inst0001")).toBe(INSTANCE_UUID);
  });

  it("rejects when definitionId is missing from payload", async () => {
    const { projecting } = buildSuite();
    const event: WorkflowEvent = {
      ...startedEvent(),
      payload: { initialState: "draft" },
    };
    await expect(projecting.append(event)).rejects.toThrow(/definitionId/);
  });
});

describe("ProjectingEventLog.append — subsequent events", () => {
  it("upserts the instance projection on state_transitioned", async () => {
    const { projecting, capture } = buildSuite();
    await projecting.append(startedEvent());
    capture.length = 0;
    await projecting.append({
      id: "wfe_event0002",
      instanceId: "wfi_inst0001",
      tenantId: TENANT,
      sequenceNumber: 1,
      kind: "state_transitioned",
      occurredAt: "2026-05-16T12:00:01.000Z",
      actorPrincipalId: null,
      actorSystemId: "engine",
      previousState: "draft",
      newState: "awaiting",
      activityId: null,
      signalId: null,
      timerId: null,
      childInstanceId: null,
      variableName: null,
      payload: { transitionName: "submit" },
      correlationId: null,
      causationEventId: null,
    });
    const updateInstance = capture.find((c) => c.sql.includes("UPDATE meta.workflow_instances"));
    expect(updateInstance).toBeDefined();
  });

  it("persists activity projections on activity_scheduled", async () => {
    const { projecting, capture } = buildSuite();
    await projecting.append(startedEvent());
    capture.length = 0;
    await projecting.append({
      id: "wfe_event0002",
      instanceId: "wfi_inst0001",
      tenantId: TENANT,
      sequenceNumber: 1,
      kind: "activity_scheduled",
      occurredAt: "2026-05-16T12:00:01.000Z",
      actorPrincipalId: null,
      actorSystemId: "engine",
      previousState: null,
      newState: null,
      activityId: "wfa_act00001",
      signalId: null,
      timerId: null,
      childInstanceId: null,
      variableName: null,
      payload: { kind: "http_call", definitionActivityKey: "charge" },
      correlationId: null,
      causationEventId: null,
    });
    const activityInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.workflow_activities"),
    );
    expect(activityInsert).toBeDefined();
    expect(activityInsert?.params?.[0]).toBe("wfa_act00001");
  });

  it("persists signal projections on signal_received", async () => {
    const { projecting, capture } = buildSuite();
    await projecting.append(startedEvent());
    capture.length = 0;
    await projecting.append({
      id: "wfe_event0002",
      instanceId: "wfi_inst0001",
      tenantId: TENANT,
      sequenceNumber: 1,
      kind: "signal_received",
      occurredAt: "2026-05-16T12:00:01.000Z",
      actorPrincipalId: null,
      actorSystemId: "engine",
      previousState: null,
      newState: null,
      activityId: null,
      signalId: "wfs_sig00001",
      timerId: null,
      childInstanceId: null,
      variableName: null,
      payload: { signalName: "approve", correlationKey: "po-1" },
      correlationId: null,
      causationEventId: null,
    });
    const signalInsert = capture.find((c) => c.sql.includes("INSERT INTO meta.workflow_signals"));
    expect(signalInsert).toBeDefined();
    expect(signalInsert?.params?.[0]).toBe("wfs_sig00001");
  });

  it("persists timer projections on timer_scheduled", async () => {
    const { projecting, capture } = buildSuite();
    await projecting.append(startedEvent());
    capture.length = 0;
    await projecting.append({
      id: "wfe_event0002",
      instanceId: "wfi_inst0001",
      tenantId: TENANT,
      sequenceNumber: 1,
      kind: "timer_scheduled",
      occurredAt: "2026-05-16T12:00:01.000Z",
      actorPrincipalId: null,
      actorSystemId: "engine",
      previousState: null,
      newState: null,
      activityId: null,
      signalId: null,
      timerId: "wft_tim00001",
      childInstanceId: null,
      variableName: null,
      payload: { timerName: "deadline", fireAt: "2026-05-17T12:00:00.000Z" },
      correlationId: null,
      causationEventId: null,
    });
    const timerInsert = capture.find((c) => c.sql.includes("INSERT INTO meta.workflow_timers"));
    expect(timerInsert).toBeDefined();
    expect(timerInsert?.params?.[0]).toBe("wft_tim00001");
  });
});

describe("ProjectingEventLog — read-through helpers", () => {
  it("delegates listByInstance to the inner log", async () => {
    const { projecting } = buildSuite();
    await projecting.append(startedEvent());
    const events = await projecting.listByInstance("wfi_inst0001");
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("instance_started");
  });

  it("delegates latestSequence to the inner log", async () => {
    const { projecting } = buildSuite();
    await projecting.append(startedEvent());
    expect(await projecting.latestSequence("wfi_inst0001")).toBe(0);
  });

  it("count() reflects the inner log", async () => {
    const { projecting } = buildSuite();
    await projecting.append(startedEvent());
    expect(await projecting.count()).toBe(1);
  });

  it("appendBatch processes each event with projection", async () => {
    const { projecting, capture } = buildSuite();
    await projecting.appendBatch([
      startedEvent(),
      {
        id: "wfe_event0002",
        instanceId: "wfi_inst0001",
        tenantId: TENANT,
        sequenceNumber: 1,
        kind: "instance_completed",
        occurredAt: "2026-05-16T12:00:05.000Z",
        actorPrincipalId: null,
        actorSystemId: "engine",
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
      },
    ]);
    const updates = capture.filter((c) => c.sql.includes("UPDATE meta.workflow_instances"));
    expect(updates.length).toBeGreaterThan(0);
  });
});

describe("buildPersistentStores", () => {
  it("constructs all four stores with a shared resolver", () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const stores = buildPersistentStores({ conn });
    expect(stores.instanceResolver).toBeDefined();
    expect(stores.definitionResolver).toBeDefined();
    expect(stores.instanceStore).toBeDefined();
    expect(stores.activityStore).toBeDefined();
    expect(stores.signalStore).toBeDefined();
    expect(stores.timerStore).toBeDefined();
  });

  it("respects pre-supplied resolvers", () => {
    const conn = mockConnection();
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    instanceResolver.register("wfi_existing", "00000000-0000-4000-8000-000000000200");
    const stores = buildPersistentStores({ conn, instanceResolver });
    expect(stores.instanceResolver).toBe(instanceResolver);
  });
});
