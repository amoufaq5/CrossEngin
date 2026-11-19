import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { WorkflowDefinition, WorkflowEvent } from "@crossengin/workflow-engine";
import { InMemoryEventLog, projectInstance } from "@crossengin/workflow-runtime";
import { describe, expect, it, vi } from "vitest";

import { PostgresActivityStore } from "./activity-store.js";
import {
  WorkflowDefinitionIdResolver,
  WorkflowInstanceIdResolver,
} from "./id-mapping.js";
import { PostgresInstanceStore } from "./instance-store.js";
import { PostgresSignalStore } from "./signal-store.js";
import { PostgresTimerStore } from "./timer-store.js";
import {
  ProjectingEventLog,
  buildPersistentStores,
  transactionalAppendUnit,
  type AppendUnit,
} from "./projecting-event-log.js";

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
      { name: "draft", kind: "initial", label: "D", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "awaiting", kind: "waiting", label: "W", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "approved", kind: "terminal_success", label: "A", onEntryActions: [], onExitActions: [], slaSeconds: null },
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
    // Declared for the same reason as the signal below: a timer's `kind` lives only on its
    // `TimerDefinition`, so a timer the definition does not declare cannot be persisted.
    timers: [
      {
        name: "deadline",
        kind: "relative_after",
        relativeSeconds: 86_400,
        absoluteTimestampVariable: null,
        cronExpression: null,
        timezone: "UTC",
      },
    ],
    // Declared, because `WorkflowDefinitionSchema` refuses a `signal_received` transition naming an
    // undeclared signal — and because the declaration is where the delivery guarantee lives.
    signals: [
      {
        name: "approve",
        correlationVariable: "poNumber",
        payloadSchemaSha256: null,
        deliveryGuarantee: "at_least_once",
        idempotencyKey: null,
      },
    ],
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

function signalReceivedEvent(): WorkflowEvent {
  return {
    id: "wfe_event0002",
    instanceId: "wfi_inst0001",
    tenantId: TENANT,
    sequenceNumber: 1,
    kind: "signal_received",
    occurredAt: "2026-05-16T12:00:01.000Z",
    actorPrincipalId: null,
    actorSystemId: "inbox-webhook",
    previousState: null,
    newState: null,
    activityId: null,
    signalId: "wfs_sig00001",
    timerId: null,
    childInstanceId: null,
    variableName: null,
    payload: { signalName: "approve", correlationKey: "po-1", idempotencyKey: "evt-1" },
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

function buildSuite(
  opts: { definitions?: ReadonlyMap<string, WorkflowDefinition>; appendUnit?: AppendUnit } = {},
) {
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
    appendUnit: opts.appendUnit ?? null,
    instanceResolver,
  });
  return { projecting, inner, capture, instanceResolver, scope: { inner, instanceStore, activityStore, signalStore, timerStore } };
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
    const updateInstance = capture.find((c) =>
      c.sql.includes("UPDATE meta.workflow_instances"),
    );
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
      // `maxAttempts` as the engine records it: a retry ceiling is a decision the definition made,
      // and `activity-provenance.ts` refuses rather than assuming one attempt.
      payload: { kind: "http_call", definitionActivityKey: "charge", maxAttempts: 3 },
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
    await projecting.append(signalReceivedEvent());
    const signalInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.workflow_signals"),
    );
    expect(signalInsert).toBeDefined();
    expect(signalInsert?.params?.[0]).toBe("wfs_sig00001");
    // The two NOT NULL columns with no default: without them the INSERT could never commit, which
    // is why every submitSignal against a real database threw.
    expect(signalInsert?.params?.[5]).toBe("at_least_once");
    expect(signalInsert?.params?.[7]).toBe("inbox-webhook");
    // And the column the table's unique index is on, which nothing had ever bound.
    expect(signalInsert?.params?.[6]).toBe("evt-1");
  });

  it("refuses a signal whose definition is not in the map", async () => {
    const { projecting, capture } = buildSuite({ definitions: new Map() });
    await projecting.append(startedEvent());
    capture.length = 0;
    await expect(projecting.append(signalReceivedEvent())).rejects.toThrow(
      /definition_unavailable/,
    );
    expect(capture.some((c) => c.sql.includes("INSERT INTO meta.workflow_signals"))).toBe(
      false,
    );
  });

  it("refuses a signal the definition does not declare", async () => {
    const undeclared = { ...fixtureDefinition(), signals: [] };
    const { projecting } = buildSuite({
      definitions: new Map([[undeclared.id, undeclared]]),
    });
    await projecting.append(startedEvent());
    await expect(projecting.append(signalReceivedEvent())).rejects.toThrow(
      /signal_undeclared/,
    );
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
    const timerInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.workflow_timers"),
    );
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
    const updates = capture.filter((c) =>
      c.sql.includes("UPDATE meta.workflow_instances"),
    );
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

/**
 * A connection whose `transaction` runs its callback over a second connection, so a statement issued
 * inside the unit and one issued on the pool are distinguishable in the capture.
 */
function txConnection(opts: { failOn?: string } = {}) {
  const pool: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  const tx: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  const answer = (sql: string): PgQueryResult => {
    if (opts.failOn !== undefined && sql.includes(opts.failOn)) throw new Error("projection refused");
    if (sql.includes("INSERT INTO meta.workflow_instances")) return { rows: [{ id: INSTANCE_UUID }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  const txConn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      tx.push({ sql, params });
      return answer(sql);
    }) as PgConnection["query"],
    transaction: (async () => {
      throw new Error("nested transaction");
    }) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  let transactions = 0;
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      pool.push({ sql, params });
      return answer(sql);
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (c: PgConnection) => Promise<T>): Promise<T> => {
      transactions += 1;
      return fn(txConn);
    }) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return { conn, pool, tx, transactions: () => transactions };
}

describe("transactionalAppendUnit", () => {
  function initialProjection() {
    const projection = projectInstance([startedEvent()], fixtureDefinition());
    if (projection === null) throw new Error("fixture does not project");
    return projection;
  }

  it("writes the instance, the event and its projections inside one transaction under the event's tenant", async () => {
    const { conn, pool, tx, transactions } = txConnection();
    const stores = buildPersistentStores({ conn });
    stores.definitionResolver.register("wfd_def00001", DEF_UUID);
    const unit = transactionalAppendUnit(conn, stores);
    await unit(TENANT, async (scope) => {
      await scope.instanceStore.create({ projection: initialProjection(), definitionId: "wfd_def00001" });
      await scope.inner.append(startedEvent());
    });
    expect(transactions()).toBe(1);
    expect(tx[0]!.sql).toContain("set_config('app.current_tenant_id'");
    expect(tx[0]!.params).toEqual([TENANT]);
    expect(tx.some((c) => c.sql.includes("INSERT INTO meta.workflow_instances"))).toBe(true);
    expect(tx.some((c) => c.sql.includes("INSERT INTO meta.workflow_events"))).toBe(true);
    // Nothing the unit wrote went to the pool, where it would have committed on its own.
    expect(pool).toEqual([]);
    // The id the transaction registered is in the pool resolver's map: one cache, two connections.
    expect(await stores.instanceResolver.resolve("wfi_inst0001")).toBe(INSTANCE_UUID);
    expect(pool).toEqual([]);
  });

  it("lets a failure inside the unit escape, so the transaction rolls the event back with it", async () => {
    const { conn } = txConnection({ failOn: "INSERT INTO meta.workflow_events" });
    const stores = buildPersistentStores({ conn });
    stores.definitionResolver.register("wfd_def00001", DEF_UUID);
    const unit = transactionalAppendUnit(conn, stores);
    await expect(
      unit(TENANT, async (scope) => {
        await scope.instanceStore.create({ projection: initialProjection(), definitionId: "wfd_def00001" });
        await scope.inner.append(startedEvent());
      }),
    ).rejects.toThrow("projection refused");
  });

  it("refuses a malformed tenant before opening a transaction", async () => {
    const { conn, transactions } = txConnection();
    const unit = transactionalAppendUnit(conn, buildPersistentStores({ conn }));
    await expect(unit("not-a-tenant", async () => undefined)).rejects.toThrow();
    expect(transactions()).toBe(0);
  });
});

describe("ProjectingEventLog.append — atomic with its projections", () => {
  it("runs the instance creation, the event and the projections through the unit's scope", async () => {
    let calls = 0;
    const suite: { scope?: Parameters<Parameters<AppendUnit>[1]>[0] } = {};
    const unit: AppendUnit = async (tenantId, work) => {
      calls += 1;
      expect(tenantId).toBe(TENANT);
      return work(suite.scope!);
    };
    const built = buildSuite({ appendUnit: unit });
    suite.scope = built.scope;
    await built.projecting.append(startedEvent());
    await built.projecting.append(signalReceivedEvent());
    expect(calls).toBe(2);
    expect(await built.inner.count()).toBe(2);
  });

  it("forgets a created instance whose transaction rolled back, so a retry creates it again", async () => {
    let fail = true;
    const suite: { scope?: Parameters<Parameters<AppendUnit>[1]>[0] } = {};
    // A rolled-back unit: its event goes to a log that is then thrown away, as the transaction's is.
    const unit: AppendUnit = async (_tenantId, work) => {
      if (!fail) return work(suite.scope!);
      await work({ ...suite.scope!, inner: new InMemoryEventLog() });
      throw new Error("commit refused");
    };
    const built = buildSuite({ appendUnit: unit });
    suite.scope = built.scope;
    await expect(built.projecting.append(startedEvent())).rejects.toThrow("commit refused");
    // The row the rolled-back transaction created does not exist, so its id must not resolve from
    // the shared cache — the mock answers the fall-through lookup with no row.
    expect(await built.instanceResolver.resolve("wfi_inst0001")).toBeNull();

    fail = false;
    built.capture.length = 0;
    await built.projecting.append(startedEvent());
    expect(built.capture.some((c) => c.sql.includes("INSERT INTO meta.workflow_instances"))).toBe(true);
  });

  it("does not forget an instance when a later event's transaction fails", async () => {
    let fail = false;
    const suite: { scope?: Parameters<Parameters<AppendUnit>[1]>[0] } = {};
    const unit: AppendUnit = async (_tenantId, work) => {
      const out = await work(suite.scope!);
      if (fail) throw new Error("commit refused");
      return out;
    };
    const built = buildSuite({ appendUnit: unit });
    suite.scope = built.scope;
    await built.projecting.append(startedEvent());
    fail = true;
    await expect(built.projecting.append(signalReceivedEvent())).rejects.toThrow("commit refused");
    expect(await built.instanceResolver.resolve("wfi_inst0001")).toBe(INSTANCE_UUID);
  });
});
