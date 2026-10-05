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
    // Declared: the `approve` transition triggers on it, and the declaration is the only place the
    // delivery guarantee `meta.workflow_signals` demands can come from.
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
    actorSystemId: "procurement-gateway",
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

function buildReplayer(
  state: MockState,
  opts: { readonly definitions?: ReadonlyMap<string, WorkflowDefinition> } = {},
) {
  const conn = buildMockConnection(state);
  const instanceResolver = new WorkflowInstanceIdResolver(conn);
  instanceResolver.register("wfi_inst0001", INSTANCE_UUID);
  const definitionResolver = new WorkflowDefinitionIdResolver(conn);
  definitionResolver.register("wfd_def00001", "00000000-0000-4000-8000-000000000900");
  const definitions =
    opts.definitions ?? new Map([[fixtureDefinition().id, fixtureDefinition()]]);
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

  it("binds the declared guarantee and the event's source system on the signal row", async () => {
    const state = emptyState([startedEvent(), signalReceivedEvent()]);
    const replayer = buildReplayer(state);
    await replayer.resyncInstance("wfi_inst0001");
    const insert = state.updates.find((u) =>
      u.sql.includes("INSERT INTO meta.workflow_signals"),
    );
    expect(insert?.params?.[5]).toBe("at_least_once");
    expect(insert?.params?.[6]).toBe("procurement-gateway");
  });

  it("refuses the resync, writing nothing, when the guarantee cannot be read", async () => {
    const state = emptyState([startedEvent(), signalReceivedEvent()]);
    const replayer = buildReplayer(state, { definitions: new Map() });
    await expect(replayer.resyncInstance("wfi_inst0001")).rejects.toThrow(
      /definition_unavailable/,
    );
    expect(state.updates).toEqual([]);
  });
});

describe("WorkflowReplayer.verifyInstance", () => {
  it("returns hasEvents=false + drifted=false when there are no events", async () => {
    const replayer = buildReplayer(emptyState());
    const report = await replayer.verifyInstance("wfi_inst0001");
    expect(report.hasEvents).toBe(false);
    expect(report.drifted).toBe(false);
  });

  it("still answers for signals when the definition map is incomplete", async () => {
    const state = emptyState([startedEvent(), signalReceivedEvent()]);
    state.signals = [{ signal_id: "wfs_sig00001", status: "matched_to_instance" }];
    const replayer = buildReplayer(state, { definitions: new Map() });
    const report = await replayer.verifyInstance("wfi_inst0001");
    expect(report.signals.missingIds).toEqual([]);
    expect(report.signals.mismatchedIds).toEqual([]);
  });

  it("reports a stored signal whose status the log does not support", async () => {
    const state = emptyState([startedEvent(), signalReceivedEvent()]);
    state.signals = [{ signal_id: "wfs_sig00001", status: "consumed" }];
    const replayer = buildReplayer(state);
    const report = await replayer.verifyInstance("wfi_inst0001");
    expect(report.signals.mismatchedIds).toEqual(["wfs_sig00001"]);
    expect(report.drifted).toBe(true);
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
      cancellation_requested_at: null,
      cancellation_requested_by: null,
      cancellation_disposition: null,
      cancellation_signalled_activity_ids: [],
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
      cancellation_requested_at: null,
      cancellation_requested_by: null,
      cancellation_disposition: null,
      cancellation_signalled_activity_ids: [],
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
      cancellation_requested_at: null,
      cancellation_requested_by: null,
      cancellation_disposition: null,
      cancellation_signalled_activity_ids: [],
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
      cancellation_requested_at: null,
      cancellation_requested_by: null,
      cancellation_disposition: null,
      cancellation_signalled_activity_ids: [],
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
      cancellation_requested_at: null,
      cancellation_requested_by: null,
      cancellation_disposition: null,
      cancellation_signalled_activity_ids: [],
    };
    state.activities = [
      { activity_id: "wfa_act00001", status: "failed", definition_activity_key: "charge" },
    ];
    const replayer = buildReplayer(state);
    const report = await replayer.verifyInstance("wfi_inst0001");
    expect(report.activities.mismatchedIds).toContain("wfa_act00001");
  });
});

/** An `activity_scheduled` → `activity_started` → `activity_cancelled` triple for one activity. */
function signalledActivityEvents(
  activityId: string,
  firstSequence: number,
): readonly WorkflowEvent[] {
  const base = {
    instanceId: "wfi_inst0001",
    tenantId: TENANT,
    occurredAt: "2026-05-16T12:00:01.000Z",
    actorPrincipalId: null,
    actorSystemId: "engine",
    previousState: null,
    newState: null,
    signalId: null,
    timerId: null,
    childInstanceId: null,
    variableName: null,
    correlationId: null,
    causationEventId: null,
  };
  return [
    {
      ...base,
      id: `wfe_sch_${activityId}`,
      sequenceNumber: firstSequence,
      kind: "activity_scheduled" as const,
      activityId,
      payload: { kind: "http_call", definitionActivityKey: "charge" },
    },
    {
      ...base,
      id: `wfe_srt_${activityId}`,
      sequenceNumber: firstSequence + 1,
      kind: "activity_started" as const,
      activityId,
      payload: {},
    },
    {
      ...base,
      id: `wfe_can_${activityId}`,
      sequenceNumber: firstSequence + 2,
      kind: "activity_cancelled" as const,
      activityId,
      payload: { checkpoint: "cooperative_abort", signalDelivered: true },
    },
  ];
}

function cancelledInstanceEvents(): WorkflowEvent[] {
  const requested: WorkflowEvent = {
    id: "wfe_req0001",
    instanceId: "wfi_inst0001",
    tenantId: TENANT,
    sequenceNumber: 1,
    kind: "instance_cancellation_requested",
    occurredAt: "2026-05-16T12:30:00.000Z",
    actorPrincipalId: "00000000-0000-4000-8000-0000000000aa",
    actorSystemId: null,
    previousState: null,
    newState: null,
    activityId: null,
    signalId: null,
    timerId: null,
    childInstanceId: null,
    variableName: null,
    payload: { reason: "superseded", disposition: "abandon" },
    correlationId: null,
    causationEventId: null,
  };
  return [
    startedEvent(),
    requested,
    // Two in-flight activities, told in log order. `wfa_zz` first on purpose: a sorted comparison
    // would call the healthy row drifted.
    ...signalledActivityEvents("wfa_zz00001", 2),
    ...signalledActivityEvents("wfa_aa00001", 5),
  ];
}

const CANCELLED_ROW_BASE = {
  instance_id: "wfi_inst0001",
  current_state: "draft",
  variables: { amount: 250 },
  completed_at: null,
  failed_at: null,
  cancelled_at: null,
  suspended_at: null,
  compensation_started_at: null,
  compensation_completed_at: null,
} as const;

describe("WorkflowReplayer.verifyInstance — the cancellation fence", () => {
  async function fieldsFor(
    over: Record<string, unknown>,
  ): Promise<readonly { readonly field: string; readonly stored: unknown }[]> {
    const state = emptyState([...cancelledInstanceEvents()]);
    const expected = {
      ...CANCELLED_ROW_BASE,
      status: "running",
      sequence_cursor: 7,
      cancellation_requested_at: "2026-05-16T12:30:00.000Z",
      cancellation_requested_by: "00000000-0000-4000-8000-0000000000aa",
      cancellation_disposition: "abandon",
      cancellation_signalled_activity_ids: ["wfa_zz00001", "wfa_aa00001"],
    };
    state.instanceRow = { ...expected, ...over };
    const report = await buildReplayer(state).verifyInstance("wfi_inst0001");
    return report.instance.fields;
  }

  it("reports no cancellation drift for a row that matches the log", async () => {
    const fields = await fieldsFor({});
    expect(fields.filter((f) => f.field.startsWith("cancellation_"))).toEqual([]);
  });

  it("catches a cleared cancellation_requested_at, which would un-fence the instance", async () => {
    const fields = await fieldsFor({ cancellation_requested_at: null });
    const drift = fields.find((f) => f.field === "cancellation_requested_at");
    expect(drift).toBeDefined();
    expect(drift?.stored).toBeNull();
  });

  it("catches a rewritten cancellation_requested_by", async () => {
    const fields = await fieldsFor({ cancellation_requested_by: "somebody_else" });
    expect(fields.map((f) => f.field)).toContain("cancellation_requested_by");
  });

  it("catches a flipped disposition, which is the difference between reversing and not", async () => {
    const fields = await fieldsFor({ cancellation_disposition: "compensate" });
    const drift = fields.find((f) => f.field === "cancellation_disposition");
    expect(drift?.stored).toBe("compensate");
  });

  it("catches an unreadable disposition rather than reading it as unknown-and-equal", async () => {
    const fields = await fieldsFor({ cancellation_disposition: "rollback" });
    const drift = fields.find((f) => f.field === "cancellation_disposition");
    expect(drift?.stored).toBeNull();
    expect(drift).toBeDefined();
  });

  it("catches a dropped signalled activity id", async () => {
    const fields = await fieldsFor({ cancellation_signalled_activity_ids: ["wfa_zz00001"] });
    expect(fields.map((f) => f.field)).toContain("cancellation_signalled_activity_ids");
  });

  it("catches a reordered signalled list, which the healthy writer could not produce", async () => {
    const fields = await fieldsFor({
      cancellation_signalled_activity_ids: ["wfa_aa00001", "wfa_zz00001"],
    });
    expect(fields.map((f) => f.field)).toContain("cancellation_signalled_activity_ids");
  });

  it("accepts the signalled list as a JSON string, as a jsonb column may arrive", async () => {
    const fields = await fieldsFor({
      cancellation_signalled_activity_ids: '["wfa_zz00001","wfa_aa00001"]',
    });
    expect(fields.filter((f) => f.field.startsWith("cancellation_"))).toEqual([]);
  });

  it("reports a non-array signalled column as drift, with the raw value", async () => {
    const fields = await fieldsFor({ cancellation_signalled_activity_ids: { a: 1 } });
    const drift = fields.find((f) => f.field === "cancellation_signalled_activity_ids");
    expect(drift?.stored).toEqual({ a: 1 });
  });

  it("marks the whole report drifted on a cancellation-only tamper", async () => {
    const state = emptyState([...cancelledInstanceEvents()]);
    state.instanceRow = {
      ...CANCELLED_ROW_BASE,
      status: "running",
      sequence_cursor: 7,
      cancellation_requested_at: null,
      cancellation_requested_by: null,
      cancellation_disposition: null,
      cancellation_signalled_activity_ids: ["wfa_zz00001", "wfa_aa00001"],
    };
    const report = await buildReplayer(state).verifyInstance("wfi_inst0001");
    expect(report.drifted).toBe(true);
  });

  it("reports no cancellation drift for an instance that was never asked to cancel", async () => {
    const state = emptyState([startedEvent()]);
    state.instanceRow = {
      ...CANCELLED_ROW_BASE,
      status: "running",
      sequence_cursor: 0,
      cancellation_requested_at: null,
      cancellation_requested_by: null,
      cancellation_disposition: null,
      cancellation_signalled_activity_ids: [],
    };
    const report = await buildReplayer(state).verifyInstance("wfi_inst0001");
    expect(report.instance.fields).toEqual([]);
  });

  it("reports no drift when the timestamps arrive as Dates, as a real row delivers them", async () => {
    // The shape a fake `PgConnection` cannot produce and a real cluster always does. Before
    // `isoInstant`, this reported `completed_at`, `cancelled_at` and the fence as drifted on a row
    // that was exactly correct.
    const state = emptyState([...cancelledInstanceEvents()]);
    state.instanceRow = {
      ...CANCELLED_ROW_BASE,
      status: "running",
      sequence_cursor: 7,
      cancellation_requested_at: new Date("2026-05-16T12:30:00.000Z"),
      cancellation_requested_by: "00000000-0000-4000-8000-0000000000aa",
      cancellation_disposition: "abandon",
      cancellation_signalled_activity_ids: ["wfa_zz00001", "wfa_aa00001"],
    };
    const report = await buildReplayer(state).verifyInstance("wfi_inst0001");
    expect(report.instance.fields).toEqual([]);
  });

  it("resyncs the fence back into the row it repairs", async () => {
    const state = emptyState([...cancelledInstanceEvents()]);
    await buildReplayer(state).resyncInstance("wfi_inst0001");
    const update = state.updates.find((u) => u.sql.includes("UPDATE meta.workflow_instances"));
    expect(update?.params?.[20]).toBe("2026-05-16T12:30:00.000Z");
    expect(update?.params?.[22]).toBe("abandon");
    expect(JSON.parse(update?.params?.[23] as string)).toEqual(["wfa_zz00001", "wfa_aa00001"]);
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
