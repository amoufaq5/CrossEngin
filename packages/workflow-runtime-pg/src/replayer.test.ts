import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { WorkflowDefinition, WorkflowEvent } from "@crossengin/workflow-engine";
import { describe, expect, it, vi } from "vitest";

import {
  WorkflowDefinitionIdResolver,
  WorkflowInstanceIdResolver,
} from "./id-mapping.js";
import { WorkflowReplayer, timerProjectionSignature } from "./replayer.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const INSTANCE_UUID = "00000000-0000-4000-8000-000000000111";

interface MockState {
  readonly events: WorkflowEvent[];
  instanceRow: Record<string, unknown> | null;
  activities: Array<{ activity_id: string; status: string; definition_activity_key: string }>;
  signals: Array<{ signal_id: string; status: string }>;
  timers: Array<{
    timer_id: string;
    status: string;
    fire_count?: unknown;
    /** `TIMESTAMPTZ` comes back from node-postgres as a `Date`, so the fake offers both. */
    next_fire_at?: unknown;
  }>;
  instanceListing: string[];
  updates: Array<{ sql: string; params: readonly unknown[] | undefined }>;
  /**
   * What the catalog probe answers. `visible` by default, because an owner connection is the
   * documented precondition — but modelled, not assumed, so the confined case is reachable in a
   * test. A fake that answered the probe unconditionally would be the class of fake ADR-0334
   * condemned: one answering a statement it could not really serve.
   */
  rlsEnabled: boolean;
  isOwner: boolean;
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

/** The fixture plus a declared one-shot timer, so timer provenance resolves. */
function withTimer(): WorkflowDefinition {
  return {
    ...fixtureDefinition(),
    timers: [
      {
        name: "deadline",
        kind: "relative_after",
        relativeSeconds: 3600,
        absoluteTimestampVariable: null,
        cronExpression: null,
        timezone: "UTC",
      },
    ],
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
    payload: { signalName: "approve", correlationKey: "po-1", idempotencyKey: "evt-1" },
    correlationId: null,
    causationEventId: null,
  };
}

function buildMockConnection(state: MockState): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      void params;
      if (sql.includes("FROM pg_class c")) {
        return {
          rows: [
            {
              role: "app",
              bypasses_rls: false,
              is_owner: state.isOwner,
              rls_enabled: state.rlsEnabled,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT instance_id FROM meta.workflow_instances")) {
        // Keyset, not offset: the limit is the **last** bound parameter and `after` is the one
        // before it when present. Modelled rather than ignored — a fake that returned the whole
        // listing whatever the cursor said would make a paging bug untestable, which is how the
        // `OFFSET` walk's skipping went unnoticed.
        const sorted = [...state.instanceListing].sort();
        const limit =
          typeof params?.[params.length - 1] === "number"
            ? (params[params.length - 1] as number)
            : sorted.length;
        const after = sql.includes("instance_id > $")
          ? (params?.[params.length - 2] as string | undefined)
          : undefined;
        const page = sorted
          .filter((id) => after === undefined || id > after)
          .slice(0, limit);
        return {
          rows: page.map((id) => ({ instance_id: id })),
          rowCount: page.length,
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
      if (sql.includes("UPDATE meta.workflow_instances")) {
        state.updates.push({ sql, params });
        // **`rowCount` follows the row's existence**, which the old fake did not model: it answered
        // `1` unconditionally, so an `UPDATE … WHERE instance_id = $n` matching nothing looked
        // exactly like one that matched — and the replayer's report of what it had repaired was
        // asserted against that. ADR-0333's `INSERT 0 0` blind spot, in a fake.
        return { rows: [], rowCount: state.instanceRow === null ? 0 : 1 };
      }
      if (sql.includes("INSERT")) {
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
    rlsEnabled: true,
    isOwner: true,
  };
}

/**
 * A healthy stored instance row, as `projectInstance` over `startedEvent()` derives it.
 *
 * Added because every resync test used to run with `instanceRow: null` — i.e. against an instance
 * that does not exist — and asserted that the repair had happened. The repair is an `UPDATE`, so
 * those were asserting a write that matched no row.
 */
function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
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
    state.instanceRow = storedRow();
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
        payload: { kind: "http_call", definitionActivityKey: "charge", maxAttempts: 3 },
        correlationId: null,
        causationEventId: null,
      },
    ];
    const state = emptyState(events);
    state.instanceRow = storedRow();
    const replayer = buildReplayer(state);
    const report = await replayer.resyncInstance("wfi_inst0001");
    expect(report.upserts.activities).toBe(1);
    const inserts = state.updates.filter((u) =>
      u.sql.includes("INSERT INTO meta.workflow_activities"),
    );
    expect(inserts.length).toBe(1);
  });

  it("writes nothing at all when any child projection refuses", async () => {
    // The whole point of resolving all three before the first write: a refusal part-way through
    // would leave a half-resynced instance behind, from the one tool whose job is to make the
    // projections agree with the log. An activity with no recorded retry ceiling is the cheapest
    // refusal to provoke, and the instance upsert must not have happened.
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
    await expect(replayer.resyncInstance("wfi_inst0001")).rejects.toThrow(
      /max_attempts_unrecorded/,
    );
    expect(state.updates.filter((u) => u.sql.includes("UPDATE meta.workflow_instances"))).toEqual(
      [],
    );
    expect(
      state.updates.filter((u) => u.sql.includes("INSERT INTO meta.workflow_activities")),
    ).toEqual([]);
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
    state.instanceRow = storedRow();
    const replayer = buildReplayer(state);
    const report = await replayer.resyncInstance("wfi_inst0001");
    expect(report.upserts.signals).toBe(1);
  });

  it("binds the declared guarantee and the event's source system on the signal row", async () => {
    const state = emptyState([startedEvent(), signalReceivedEvent()]);
    state.instanceRow = storedRow();
    const replayer = buildReplayer(state);
    await replayer.resyncInstance("wfi_inst0001");
    const insert = state.updates.find((u) =>
      u.sql.includes("INSERT INTO meta.workflow_signals"),
    );
    expect(insert?.params?.[5]).toBe("at_least_once");
    expect(insert?.params?.[6]).toBe("evt-1");
    expect(insert?.params?.[7]).toBe("procurement-gateway");
  });

  it("refuses before projecting anything when the definition is not in the map", async () => {
    // Previously this reached `projectPersistableSignals` and surfaced as `definition_unavailable`
    // — the right outcome by accident, because this instance happens to have a signal. The refusal
    // is now the missing definition itself, named before anything is projected, so an instance with
    // no child entity refuses too instead of writing a de-refined status.
    const state = emptyState([startedEvent(), signalReceivedEvent()]);
    state.instanceRow = storedRow();
    const replayer = buildReplayer(state, { definitions: new Map() });
    const report = await replayer.resyncInstance("wfi_inst0001");
    expect(report.refusal).toBe("definition_unresolved");
    expect(report.detail).toContain("wfd_def00001");
    expect(state.updates).toEqual([]);
  });

  it("refuses a purely state-machine instance rather than writing away its refined status", async () => {
    // The case the three child projections cannot catch: no activity, no signal, no timer, so
    // nothing refuses on provenance — and `refineStatusFromDefinition` is skipped, so the resync
    // used to write `running` over a correct `waiting_for_manual` / `waiting_for_signal` row and
    // report success. This is the load-bearing refusal.
    const state = emptyState([startedEvent()]);
    state.instanceRow = storedRow();
    const replayer = buildReplayer(state, { definitions: new Map() });
    const report = await replayer.resyncInstance("wfi_inst0001");
    expect(report.refusal).toBe("definition_unresolved");
    expect(report.upserts.instance).toBe(false);
    expect(state.updates).toEqual([]);
  });

  it("refuses rather than claiming a repair when no instance row exists", async () => {
    // `upsertProjection` is an UPDATE, so an absent row means it matched nothing — and that is the
    // one instance-level divergence `verifyInstance` can detect. It used to report
    // `upserts.instance: true`.
    const state = emptyState([startedEvent()]);
    state.instanceRow = null;
    const replayer = buildReplayer(state);
    const report = await replayer.resyncInstance("wfi_inst0001");
    expect(report.refusal).toBe("instance_row_absent");
    expect(report.upserts.instance).toBe(false);
    expect(
      state.updates.filter((u) => u.sql.includes("INSERT INTO meta.workflow_signals")),
    ).toEqual([]);
  });

  it("refuses before reading the log when RLS confines this session", async () => {
    // A confined session reads zero events, so without this refusal the repairer answers
    // `hadEvents: false` — "nothing to repair" — for every instance in the database.
    const state = emptyState([startedEvent()]);
    state.instanceRow = storedRow();
    state.isOwner = false;
    const replayer = buildReplayer(state);
    const report = await replayer.resyncInstance("wfi_inst0001");
    expect(report.refusal).toBe("rls_would_confine_this_session");
    expect(report.detail).toContain("workflow_events");
    expect(state.updates).toEqual([]);
  });

  it("does not release a timer claim, because a repair is not the result of one", async () => {
    const events = [
      startedEvent(),
      {
        id: "wfe_event0003",
        instanceId: "wfi_inst0001",
        tenantId: TENANT,
        sequenceNumber: 1,
        kind: "timer_scheduled" as const,
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
      },
    ];
    const state = emptyState(events);
    state.instanceRow = storedRow();
    const replayer = buildReplayer(
      state,
      { definitions: new Map([[withTimer().id, withTimer()]]) },
    );
    await replayer.resyncInstance("wfi_inst0001");
    const insert = state.updates.find((u) => u.sql.includes("INSERT INTO meta.workflow_timers"));
    expect(insert).toBeDefined();
    expect(insert?.sql).not.toContain("claimed_by");
    expect(insert?.sql).not.toContain("claim_expires_at");
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
        payload: { kind: "http_call", definitionActivityKey: "charge", maxAttempts: 3 },
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
        payload: { kind: "http_call", definitionActivityKey: "charge", maxAttempts: 3 },
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
      payload: { kind: "http_call", definitionActivityKey: "charge", maxAttempts: 3 },
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
    const bulk = await replayer.bulkResync();
    expect(bulk.reports).toEqual([]);
    expect(bulk.errors).toEqual([]);
  });

  it("re-syncs each instance returned by listInstanceIds", async () => {
    const state = emptyState([startedEvent()]);
    state.instanceRow = storedRow();
    state.instanceListing = ["wfi_inst0001"];
    const replayer = buildReplayer(state);
    const bulk = await replayer.bulkResync({ batchSize: 10, maxInstances: 5 });
    expect(bulk.reports).toHaveLength(1);
    expect(bulk.reports[0]?.hadEvents).toBe(true);
    expect(bulk.reports[0]?.refusal).toBeNull();
  });

  it("respects maxInstances", async () => {
    const state = emptyState();
    state.instanceListing = ["wfi_a", "wfi_b", "wfi_c", "wfi_d"];
    const replayer = buildReplayer(state);
    const bulk = await replayer.bulkResync({ batchSize: 10, maxInstances: 2 });
    expect(bulk.reports.length).toBeLessThanOrEqual(2);
  });
});

describe("timerProjectionSignature", () => {
  it("encodes the recurrence position beside the status", () => {
    expect(timerProjectionSignature({ status: "fired", fireCount: 3, nextFireAt: "2026-05-16T14:00:00.000Z" })).toBe(
      "fired|3|2026-05-16T14:00:00.000Z",
    );
  });

  it("distinguishes a cron timer that stopped advancing from one that did not", () => {
    const stalled = timerProjectionSignature({ status: "scheduled", fireCount: 1, nextFireAt: null });
    const healthy = timerProjectionSignature({ status: "scheduled", fireCount: 4, nextFireAt: null });
    expect(stalled).not.toBe(healthy);
  });

  it("reads a missing next occurrence as a dash rather than as the string 'null'", () => {
    expect(timerProjectionSignature({ status: "scheduled", fireCount: 0, nextFireAt: null })).toBe(
      "scheduled|0|-",
    );
  });
});

describe("WorkflowReplayer — recurring timer drift", () => {
  function recurringEvents(): WorkflowEvent[] {
    const base = {
      instanceId: "wfi_inst0001",
      tenantId: "00000000-0000-4000-8000-000000000001",
      occurredAt: "2026-05-16T12:00:00.000Z",
      actorPrincipalId: null,
      actorSystemId: "engine",
      previousState: null,
      newState: null,
      activityId: null,
      signalId: null,
      childInstanceId: null,
      variableName: null,
      correlationId: null,
      causationEventId: null,
    } as const;
    return [
      {
        ...base,
        id: "wfe_00000001",
        sequenceNumber: 1,
        kind: "instance_started",
        timerId: null,
        payload: { definitionId: "wfd_def00001", currentState: "draft" },
      },
      {
        ...base,
        id: "wfe_00000002",
        sequenceNumber: 2,
        kind: "timer_scheduled",
        timerId: "wft_cron0001",
        payload: { timerName: "heartbeat", fireAt: "2026-05-16T13:00:00.000Z", timerKind: "cron_schedule" },
      },
      {
        ...base,
        id: "wfe_00000003",
        sequenceNumber: 3,
        kind: "timer_fired",
        timerId: "wft_cron0001",
        occurredAt: "2026-05-16T13:00:00.000Z",
        payload: { timerName: "heartbeat", nextFireAt: "2026-05-16T14:00:00.000Z" },
      },
      {
        ...base,
        id: "wfe_00000004",
        sequenceNumber: 4,
        kind: "timer_scheduled",
        timerId: "wft_cron0001",
        occurredAt: "2026-05-16T13:00:00.000Z",
        payload: { timerName: "heartbeat", fireAt: "2026-05-16T14:00:00.000Z", rearm: true },
      },
    ] as WorkflowEvent[];
  }

  it("reports no drift when the row's fire_count matches the log", async () => {
    const state = { ...emptyState(), events: recurringEvents() };
    state.timers = [{ timer_id: "wft_cron0001", status: "scheduled", fire_count: 1, next_fire_at: null }];
    const report = await buildReplayer(state).verifyInstance("wfi_inst0001");
    expect(report.timers.mismatchedIds).toEqual([]);
  });

  it("reports drift when a recurring timer's row stopped advancing — status alone cannot see it", async () => {
    const state = { ...emptyState(), events: recurringEvents() };
    // Same status, stale count: this is exactly a cron timer that quietly stopped recurring.
    state.timers = [{ timer_id: "wft_cron0001", status: "scheduled", fire_count: 0, next_fire_at: null }];
    const report = await buildReplayer(state).verifyInstance("wfi_inst0001");
    expect(report.timers.mismatchedIds).toEqual(["wft_cron0001"]);
    expect(report.drifted).toBe(true);
  });

  it("normalises a Date out of next_fire_at rather than comparing an object", async () => {
    const state = { ...emptyState(), events: recurringEvents().slice(0, 3) };
    state.timers = [
      {
        timer_id: "wft_cron0001",
        status: "fired",
        fire_count: 1,
        next_fire_at: new Date("2026-05-16T14:00:00.000Z"),
      },
    ];
    const report = await buildReplayer(state).verifyInstance("wfi_inst0001");
    expect(report.timers.mismatchedIds).toEqual([]);
  });
});

describe("WorkflowReplayer.verifyInstance — a variable that is not a scalar", () => {
  function nestedVariableEvents(): WorkflowEvent[] {
    return [
      {
        ...startedEvent(),
        payload: {
          ...startedEvent().payload,
          variables: { lines: [{ sku: "A", qty: 2 }], meta: { region: "eu" } },
        },
      },
    ];
  }

  it("reports no drift when a nested variable round-trips", async () => {
    // The defect: `JSONB` comes back from node-postgres **parsed**, as a fresh object, and the old
    // comparison compared values with `!==`. So every healthy instance carrying one object- or
    // array-valued variable reported permanent `variables` drift. The fake handed back the very
    // object the test put in, so identity held and no test could see it — hence the structurally
    // distinct copy here.
    const state = emptyState(nestedVariableEvents());
    state.instanceRow = storedRow({
      variables: { lines: [{ sku: "A", qty: 2 }], meta: { region: "eu" } },
    });
    const report = await buildReplayer(state).verifyInstance("wfi_inst0001");
    expect(report.instance.fields.map((f) => f.field)).not.toContain("variables");
  });

  it("is insensitive to object key order, because JSONB does not preserve it", async () => {
    const state = emptyState(nestedVariableEvents());
    state.instanceRow = storedRow({
      variables: { meta: { region: "eu" }, lines: [{ qty: 2, sku: "A" }] },
    });
    const report = await buildReplayer(state).verifyInstance("wfi_inst0001");
    expect(report.instance.fields.map((f) => f.field)).not.toContain("variables");
  });

  it("is sensitive to array order, because a variable holding a list is a list", async () => {
    const state = emptyState([
      {
        ...startedEvent(),
        payload: { ...startedEvent().payload, variables: { tags: ["a", "b"] } },
      },
    ]);
    state.instanceRow = storedRow({ variables: { tags: ["b", "a"] } });
    const report = await buildReplayer(state).verifyInstance("wfi_inst0001");
    expect(report.instance.fields.map((f) => f.field)).toContain("variables");
  });

  it("reports a nested value that genuinely differs", async () => {
    const state = emptyState(nestedVariableEvents());
    state.instanceRow = storedRow({
      variables: { lines: [{ sku: "A", qty: 3 }], meta: { region: "eu" } },
    });
    const report = await buildReplayer(state).verifyInstance("wfi_inst0001");
    expect(report.instance.fields.map((f) => f.field)).toContain("variables");
    expect(report.drifted).toBe(true);
  });

  it("reports an unreadable variables column rather than reading it as empty", async () => {
    // `parseJsonObject` answered `{}` for anything that was not an object, so a column tampered to
    // a scalar or an array compared **equal** to the healthy empty case. `parseStringArray` one
    // column over already refused to collapse those two facts; this is the same rule, applied.
    const state = emptyState([
      { ...startedEvent(), payload: { ...startedEvent().payload, variables: {} } },
    ]);
    state.instanceRow = storedRow({ variables: 42 });
    const report = await buildReplayer(state).verifyInstance("wfi_inst0001");
    const field = report.instance.fields.find((f) => f.field === "variables");
    expect(field).toBeDefined();
    expect(field?.stored).toBe(42);
  });
});

describe("WorkflowReplayer.verifyInstance — the qualifiers on a report", () => {
  it("reports an instance row the log cannot account for", async () => {
    // `ProjectingEventLog.append` creates the row before appending `instance_started`, and the two
    // are not one transaction — so this is the drift the write ordering actually produces. It used
    // to answer `drifted: false` without issuing the query.
    const state = emptyState();
    state.instanceRow = storedRow();
    const report = await buildReplayer(state).verifyInstance("wfi_inst0001");
    expect(report.hasEvents).toBe(false);
    expect(report.instance.instanceOrphaned).toBe(true);
    expect(report.drifted).toBe(true);
  });

  it("still reports no drift for an instance that exists in neither place", async () => {
    const report = await buildReplayer(emptyState()).verifyInstance("wfi_inst0001");
    expect(report.instance.instanceOrphaned).toBe(false);
    expect(report.drifted).toBe(false);
  });

  it("reports an unfoldable log instead of throwing", async () => {
    // `projectInstance` raises when the first event is not `instance_started`, which a partially
    // erased log produces. A sweep must not die on its most corrupt instance.
    const state = emptyState([signalReceivedEvent()]);
    state.instanceRow = storedRow();
    const report = await buildReplayer(state).verifyInstance("wfi_inst0001");
    expect(report.logUnprojectable).toContain("instance_started");
    expect(report.drifted).toBe(true);
    expect(report.instance.fields).toEqual([]);
  });

  it("names the definition the log names, and says it was not resolved", async () => {
    const state = emptyState([startedEvent()]);
    state.instanceRow = storedRow();
    const report = await buildReplayer(state, { definitions: new Map() }).verifyInstance(
      "wfi_inst0001",
    );
    expect(report.definitionId).toBe("wfd_def00001");
    expect(report.definitionResolved).toBe(false);
  });

  it("marks the report unverifiable when RLS confines the session", async () => {
    // Everything below `verifiable: false` is a statement about the session, not the instance: a
    // confined read matches zero rows on all five tables at once, so the empty log, the absent row
    // and the empty child lists arrive together and compose into a clean bill of health.
    const state = emptyState([startedEvent()]);
    state.instanceRow = storedRow();
    state.isOwner = false;
    const report = await buildReplayer(state).verifyInstance("wfi_inst0001");
    expect(report.verifiable).toBe(false);
  });

  it("marks the report verifiable as the table owner", async () => {
    const state = emptyState([startedEvent()]);
    state.instanceRow = storedRow();
    const report = await buildReplayer(state).verifyInstance("wfi_inst0001");
    expect(report.verifiable).toBe(true);
  });
});

describe("WorkflowReplayer.probeVisibility", () => {
  it("answers usable for an owner connection", async () => {
    const report = await buildReplayer(emptyState()).probeVisibility();
    expect(report.usable).toBe(true);
    expect(report.tables).toHaveLength(5);
  });

  it("names every confined table, not just the first", async () => {
    const state = emptyState();
    state.isOwner = false;
    const report = await buildReplayer(state).probeVisibility();
    expect(report.usable).toBe(false);
    for (const table of ["workflow_events", "workflow_instances", "workflow_timers"]) {
      expect(report.detail).toContain(table);
    }
  });

  it("reports a table with RLS switched off as unguarded rather than as visible", async () => {
    const state = emptyState();
    state.isOwner = false;
    state.rlsEnabled = false;
    const report = await buildReplayer(state).probeVisibility();
    expect(report.usable).toBe(false);
    expect(report.tables[0]?.report.visibility).toBe("unguarded");
  });

  it("is asked once and memoised across calls", async () => {
    const state = emptyState();
    const conn = buildMockConnection(state);
    const replayer = new WorkflowReplayer({ conn, definitions: new Map() });
    await replayer.probeVisibility();
    await replayer.probeVisibility();
    const calls = (conn.query as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("FROM pg_class c"),
    );
    expect(calls).toHaveLength(5);
  });
});

describe("WorkflowReplayer.listInstanceIds — keyset paging", () => {
  it("orders by instance_id and binds the limit last", async () => {
    const state = emptyState();
    state.instanceListing = ["wfi_c", "wfi_a", "wfi_b"];
    const ids = await buildReplayer(state).listInstanceIds({ limit: 2 });
    expect(ids).toEqual(["wfi_a", "wfi_b"]);
  });

  it("takes an exclusive cursor rather than an offset", async () => {
    const state = emptyState();
    state.instanceListing = ["wfi_a", "wfi_b", "wfi_c"];
    const ids = await buildReplayer(state).listInstanceIds({ after: "wfi_a", limit: 10 });
    expect(ids).toEqual(["wfi_b", "wfi_c"]);
  });

  it("walks every row across pages without stepping over one", async () => {
    const state = emptyState();
    state.instanceListing = ["wfi_a", "wfi_b", "wfi_c", "wfi_d", "wfi_e"];
    const replayer = buildReplayer(state);
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await replayer.listInstanceIds({
        limit: 2,
        ...(after !== undefined ? { after } : {}),
      });
      if (page.length === 0) break;
      seen.push(...page);
      after = page[page.length - 1];
    }
    expect(seen).toEqual(["wfi_a", "wfi_b", "wfi_c", "wfi_d", "wfi_e"]);
  });
});

describe("WorkflowReplayer.bulkResync — one bad instance does not end the sweep", () => {
  it("collects the error and goes on", async () => {
    const state = emptyState([startedEvent(), signalReceivedEvent()]);
    state.instanceRow = storedRow();
    state.instanceListing = ["wfi_inst0001"];
    // No `maxAttempts` anywhere would raise; here the signal's declared guarantee is present, so
    // provoke the throw with an activity that has no recorded retry ceiling.
    state.events.push({
      ...signalReceivedEvent(),
      id: "wfe_event0003",
      sequenceNumber: 2,
      kind: "activity_scheduled",
      signalId: null,
      activityId: "wfa_act00001",
      payload: { kind: "http_call", definitionActivityKey: "charge" },
    });
    const bulk = await buildReplayer(state).bulkResync({ batchSize: 10 });
    expect(bulk.reports).toEqual([]);
    expect(bulk.errors).toHaveLength(1);
    expect(bulk.errors[0]?.instanceId).toBe("wfi_inst0001");
    expect(bulk.errors[0]?.message).toContain("max_attempts_unrecorded");
  });

  it("refuses every instance, writing nothing, when the session is confined", async () => {
    const state = emptyState([startedEvent()]);
    state.instanceRow = storedRow();
    state.instanceListing = ["wfi_a", "wfi_b"];
    state.isOwner = false;
    const bulk = await buildReplayer(state).bulkResync({ batchSize: 10 });
    expect(bulk.reports.map((r) => r.refusal)).toEqual([
      "rls_would_confine_this_session",
      "rls_would_confine_this_session",
    ]);
    expect(state.updates).toEqual([]);
  });
});
