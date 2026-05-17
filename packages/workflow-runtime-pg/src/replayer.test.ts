import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { WorkflowDefinition, WorkflowEvent } from "@crossengin/workflow-engine";
import { describe, expect, it, vi } from "vitest";

import {
  WorkflowDefinitionIdResolver,
  WorkflowInstanceIdResolver,
} from "./id-mapping.js";
import { WorkflowReplayer } from "./replayer.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const INSTANCE_UUID = "00000000-0000-4000-8000-000000000111";

interface MockState {
  readonly events: WorkflowEvent[];
  instanceRow: Record<string, unknown> | null;
  activities: Array<{ activity_id: string; status: string; definition_activity_key: string }>;
  signals: Array<{ signal_id: string; status: string }>;
  timers: Array<{ timer_id: string; status: string }>;
  instanceListing: string[];
  updates: Array<{ sql: string; params: readonly unknown[] | undefined }>;
}

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

function buildMockConnection(state: MockState): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      void params;
      if (sql.includes("SELECT instance_id FROM meta.workflow_instances")) {
        const requested = Number(state.instanceListing.length);
        const limit =
          typeof params?.[params.length - 2] === "number"
            ? (params[params.length - 2] as number)
            : requested;
        return {
          rows: state.instanceListing.slice(0, limit).map((id) => ({ instance_id: id })),
          rowCount: Math.min(state.instanceListing.length, limit),
        };
      }
      if (sql.includes("SELECT instance_id, status, current_state")) {
        if (state.instanceRow === null) return { rows: [], rowCount: 0 };
        return { rows: [state.instanceRow], rowCount: 1 };
      }
      if (sql.includes("SELECT id FROM meta.workflow_instances")) {
        return { rows: [{ id: INSTANCE_UUID }], rowCount: 1 };
      }
      if (sql.includes("FROM meta.workflow_events") && sql.includes("ORDER BY")) {
        return {
          rows: state.events.map((e) => ({
            event_id: e.id,
            tenant_id: e.tenantId,
            sequence_number: e.sequenceNumber,
            kind: e.kind,
            occurred_at: e.occurredAt,
            actor_principal_id: e.actorPrincipalId,
            actor_system_id: e.actorSystemId,
            previous_state: e.previousState,
            new_state: e.newState,
            activity_id: e.activityId,
            signal_id: e.signalId,
            timer_id: e.timerId,
            child_instance_id: e.childInstanceId,
            variable_name: e.variableName,
            payload: e.payload,
            correlation_id: e.correlationId,
            causation_event_id: e.causationEventId,
            instance_text_id: e.instanceId,
          })),
          rowCount: state.events.length,
        };
      }
      if (sql.includes("FROM meta.workflow_activities")) {
        return { rows: state.activities, rowCount: state.activities.length };
      }
      if (sql.includes("FROM meta.workflow_signals")) {
        return { rows: state.signals, rowCount: state.signals.length };
      }
      if (sql.includes("FROM meta.workflow_timers")) {
        return { rows: state.timers, rowCount: state.timers.length };
      }
      if (sql.includes("UPDATE meta.workflow_instances") || sql.includes("INSERT")) {
        state.updates.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

function buildReplayer(state: MockState) {
  const conn = buildMockConnection(state);
  const instanceResolver = new WorkflowInstanceIdResolver(conn);
  instanceResolver.register("wfi_inst0001", INSTANCE_UUID);
  const definitionResolver = new WorkflowDefinitionIdResolver(conn);
  definitionResolver.register("wfd_def00001", "00000000-0000-4000-8000-000000000900");
  const definitions = new Map([[fixtureDefinition().id, fixtureDefinition()]]);
  return new WorkflowReplayer({ conn, definitions, instanceResolver, definitionResolver });
}

function emptyState(events: WorkflowEvent[] = []): MockState {
  return {
    events,
    instanceRow: null,
    activities: [],
    signals: [],
    timers: [],
    instanceListing: [],
    updates: [],
  };
}

describe("WorkflowReplayer.resyncInstance", () => {
  it("returns hadEvents=false when no events exist", async () => {
    const state = emptyState();
    const replayer = buildReplayer(state);
    const report = await replayer.resyncInstance("wfi_inst0001");
    expect(report.hadEvents).toBe(false);
    expect(report.upserts.instance).toBe(false);
  });

  it("upserts the instance projection when events exist", async () => {
    const state = emptyState([startedEvent()]);
    const replayer = buildReplayer(state);
    const report = await replayer.resyncInstance("wfi_inst0001");
    expect(report.hadEvents).toBe(true);
    expect(report.upserts.instance).toBe(true);
    const updates = state.updates.filter((u) => u.sql.includes("UPDATE meta.workflow_instances"));
    expect(updates.length).toBeGreaterThan(0);
  });

  it("upserts activities when activity events exist", async () => {
    const events = [
      startedEvent(),
      {
        id: "wfe_event0002",
        instanceId: "wfi_inst0001",
        tenantId: TENANT,
        sequenceNumber: 1,
        kind: "activity_scheduled" as const,
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
      },
    ];
    const state = emptyState(events);
    const replayer = buildReplayer(state);
    const report = await replayer.resyncInstance("wfi_inst0001");
    expect(report.upserts.activities).toBe(1);
    const inserts = state.updates.filter((u) =>
      u.sql.includes("INSERT INTO meta.workflow_activities"),
    );
    expect(inserts.length).toBe(1);
  });

  it("upserts signals when signal events exist", async () => {
    const events = [
      startedEvent(),
      {
        id: "wfe_event0002",
        instanceId: "wfi_inst0001",
        tenantId: TENANT,
        sequenceNumber: 1,
        kind: "signal_received" as const,
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
      },
    ];
    const state = emptyState(events);
    const replayer = buildReplayer(state);
    const report = await replayer.resyncInstance("wfi_inst0001");
    expect(report.upserts.signals).toBe(1);
  });
});

describe("WorkflowReplayer.verifyInstance", () => {
  it("returns hasEvents=false + drifted=false when there are no events", async () => {
    const replayer = buildReplayer(emptyState());
    const report = await replayer.verifyInstance("wfi_inst0001");
    expect(report.hasEvents).toBe(false);
    expect(report.drifted).toBe(false);
  });

  it("flags instance as drifted when stored row is missing but events exist", async () => {
    const state = emptyState([startedEvent()]);
    state.instanceRow = null;
    const replayer = buildReplayer(state);
    const report = await replayer.verifyInstance("wfi_inst0001");
    expect(report.hasEvents).toBe(true);
    expect(report.instance.instanceMissing).toBe(true);
    expect(report.drifted).toBe(true);
  });

  it("flags status field as drifted when stored status differs from projection", async () => {
    const state = emptyState([startedEvent()]);
    state.instanceRow = {
      instance_id: "wfi_inst0001",
      status: "completed",
      current_state: "draft",
      variables: { amount: 250 },
      sequence_cursor: 0,
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      suspended_at: null,
      compensation_started_at: null,
      compensation_completed_at: null,
    };
    const replayer = buildReplayer(state);
    const report = await replayer.verifyInstance("wfi_inst0001");
    expect(report.drifted).toBe(true);
    const statusField = report.instance.fields.find((f) => f.field === "status");
    expect(statusField).toBeDefined();
    expect(statusField?.stored).toBe("completed");
  });

  it("reports drifted=false when stored matches expected", async () => {
    const state = emptyState([startedEvent()]);
    state.instanceRow = {
      instance_id: "wfi_inst0001",
      status: "running",
      current_state: "draft",
      variables: { amount: 250 },
      sequence_cursor: 0,
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      suspended_at: null,
      compensation_started_at: null,
      compensation_completed_at: null,
    };
    const replayer = buildReplayer(state);
    const report = await replayer.verifyInstance("wfi_inst0001");
    expect(report.instance.fields).toEqual([]);
  });

  it("flags missing activity in stored when expected has one", async () => {
    const events = [
      startedEvent(),
      {
        id: "wfe_event0002",
        instanceId: "wfi_inst0001",
        tenantId: TENANT,
        sequenceNumber: 1,
        kind: "activity_scheduled" as const,
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
      },
    ];
    const state = emptyState(events);
    state.instanceRow = {
      instance_id: "wfi_inst0001",
      status: "waiting_for_activity",
      current_state: "draft",
      variables: { amount: 250 },
      sequence_cursor: 1,
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      suspended_at: null,
      compensation_started_at: null,
      compensation_completed_at: null,
    };
    const replayer = buildReplayer(state);
    const report = await replayer.verifyInstance("wfi_inst0001");
    expect(report.activities.missingIds).toContain("wfa_act00001");
    expect(report.drifted).toBe(true);
  });

  it("flags extra activity in stored when expected has none", async () => {
    const state = emptyState([startedEvent()]);
    state.instanceRow = {
      instance_id: "wfi_inst0001",
      status: "waiting_for_signal",
      current_state: "draft",
      variables: { amount: 250 },
      sequence_cursor: 0,
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      suspended_at: null,
      compensation_started_at: null,
      compensation_completed_at: null,
    };
    state.activities = [
      { activity_id: "wfa_orphan001", status: "succeeded", definition_activity_key: "x" },
    ];
    const replayer = buildReplayer(state);
    const report = await replayer.verifyInstance("wfi_inst0001");
    expect(report.activities.extraIds).toContain("wfa_orphan001");
    expect(report.drifted).toBe(true);
  });

  it("flags status mismatch on activity", async () => {
    const events = [
      startedEvent(),
      {
        id: "wfe_event0002",
        instanceId: "wfi_inst0001",
        tenantId: TENANT,
        sequenceNumber: 1,
        kind: "activity_scheduled" as const,
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
      },
    ];
    const state = emptyState(events);
    state.instanceRow = {
      instance_id: "wfi_inst0001",
      status: "waiting_for_activity",
      current_state: "draft",
      variables: { amount: 250 },
      sequence_cursor: 1,
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      suspended_at: null,
      compensation_started_at: null,
      compensation_completed_at: null,
    };
    state.activities = [
      { activity_id: "wfa_act00001", status: "failed", definition_activity_key: "charge" },
    ];
    const replayer = buildReplayer(state);
    const report = await replayer.verifyInstance("wfi_inst0001");
    expect(report.activities.mismatchedIds).toContain("wfa_act00001");
  });
});

describe("WorkflowReplayer.listInstanceIds", () => {
  it("returns the rows from workflow_instances", async () => {
    const state = emptyState();
    state.instanceListing = ["wfi_a", "wfi_b", "wfi_c"];
    const replayer = buildReplayer(state);
    const ids = await replayer.listInstanceIds();
    expect(ids).toEqual(["wfi_a", "wfi_b", "wfi_c"]);
  });

  it("returns [] when no rows match", async () => {
    const replayer = buildReplayer(emptyState());
    expect(await replayer.listInstanceIds()).toEqual([]);
  });
});

describe("WorkflowReplayer.bulkResync", () => {
  it("returns empty when no instances match", async () => {
    const replayer = buildReplayer(emptyState());
    const reports = await replayer.bulkResync();
    expect(reports).toEqual([]);
  });

  it("re-syncs each instance returned by listInstanceIds", async () => {
    const state = emptyState([startedEvent()]);
    state.instanceListing = ["wfi_inst0001"];
    const replayer = buildReplayer(state);
    const reports = await replayer.bulkResync({ batchSize: 10, maxInstances: 5 });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.hadEvents).toBe(true);
  });

  it("respects maxInstances", async () => {
    const state = emptyState();
    state.instanceListing = ["wfi_a", "wfi_b", "wfi_c", "wfi_d"];
    const replayer = buildReplayer(state);
    const reports = await replayer.bulkResync({ batchSize: 10, maxInstances: 2 });
    expect(reports.length).toBeLessThanOrEqual(2);
  });
});
