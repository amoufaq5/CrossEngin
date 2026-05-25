import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { WorkflowDefinition } from "@crossengin/workflow-engine";
import { CountingIdGenerator, FixedClock } from "@crossengin/workflow-runtime";
import { describe, expect, it, vi } from "vitest";

import { buildPersistentEngine } from "./persistent-engine.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000099";
const INSTANCE_UUID = "00000000-0000-4000-8000-000000000111";
const DEF_UUID = "00000000-0000-4000-8000-000000000900";

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
    createdBy: USER,
    publishedAt: "2026-05-01T00:00:00.000Z",
    publishedBy: USER,
    deprecatedAt: null,
    supersededByDefinitionId: null,
    sourceManifestSha256: null,
  };
}

function mockConnection(
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  const eventRows: Array<Record<string, unknown>> = [];
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      if (capture !== undefined) capture.push({ sql, params });
      if (sql.includes("INSERT INTO meta.workflow_instances")) {
        return { rows: [{ id: INSTANCE_UUID }], rowCount: 1 };
      }
      if (sql.includes("FROM meta.workflow_definitions")) {
        return { rows: [{ id: DEF_UUID }], rowCount: 1 };
      }
      if (sql.includes("FROM meta.workflow_instances")) {
        return { rows: [{ id: INSTANCE_UUID }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO meta.workflow_events")) {
        const p = params ?? [];
        const payloadRaw = typeof p[15] === "string" ? (p[15] as string) : "{}";
        let payload: unknown;
        try {
          payload = JSON.parse(payloadRaw);
        } catch {
          payload = {};
        }
        eventRows.push({
          event_id: p[0],
          tenant_id: p[2],
          sequence_number: p[3],
          kind: p[4],
          occurred_at: p[5],
          actor_principal_id: p[6],
          actor_system_id: p[7],
          previous_state: p[8],
          new_state: p[9],
          activity_id: p[10],
          signal_id: p[11],
          timer_id: p[12],
          child_instance_id: p[13],
          variable_name: p[14],
          payload,
          correlation_id: p[16],
          causation_event_id: p[17],
          instance_text_id: "wfi_00000001",
          sortKey: eventRows.length,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM meta.workflow_events") && sql.includes("ORDER BY")) {
        const sorted = [...eventRows].sort(
          (a, b) => (a["sortKey"] as number) - (b["sortKey"] as number),
        );
        return { rows: sorted, rowCount: sorted.length };
      }
      if (sql.includes("MAX(sequence_number)")) {
        if (eventRows.length === 0) return { rows: [{ max: null }], rowCount: 1 };
        const max = Math.max(...eventRows.map((r) => r["sequence_number"] as number));
        return { rows: [{ max }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

describe("buildPersistentEngine", () => {
  it("returns engine + eventLog + stores", () => {
    const conn = mockConnection();
    const definitions = new Map([[fixtureDefinition().id, fixtureDefinition()]]);
    const bundle = buildPersistentEngine({ conn, definitions });
    expect(bundle.engine).toBeDefined();
    expect(bundle.eventLog).toBeDefined();
    expect(bundle.stores.instanceStore).toBeDefined();
    expect(bundle.stores.activityStore).toBeDefined();
    expect(bundle.stores.signalStore).toBeDefined();
    expect(bundle.stores.timerStore).toBeDefined();
  });

  it("starting an instance writes to workflow_instances + workflow_events", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const definitions = new Map([[fixtureDefinition().id, fixtureDefinition()]]);
    const { engine } = buildPersistentEngine({
      conn,
      definitions,
      clock: new FixedClock(new Date("2026-05-16T12:00:00.000Z")),
      idGenerator: new CountingIdGenerator(),
    });
    await engine.startInstance({
      definitionId: "wfd_def00001",
      tenantId: TENANT,
      correlationKey: "po-1",
    });
    const instanceInserts = capture.filter((c) =>
      c.sql.includes("INSERT INTO meta.workflow_instances"),
    );
    expect(instanceInserts.length).toBeGreaterThan(0);
    const eventInserts = capture.filter((c) => c.sql.includes("INSERT INTO meta.workflow_events"));
    expect(eventInserts.length).toBeGreaterThan(0);
  });

  it("submitting a signal that triggers a transition writes signal_received + signal_consumed events", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const definitions = new Map([[fixtureDefinition().id, fixtureDefinition()]]);
    const { engine } = buildPersistentEngine({
      conn,
      definitions,
      clock: new FixedClock(new Date("2026-05-16T12:00:00.000Z")),
      idGenerator: new CountingIdGenerator(),
    });
    await engine.startInstance({
      definitionId: "wfd_def00001",
      tenantId: TENANT,
      correlationKey: "po-1",
    });
    capture.length = 0;
    await engine.submitSignal({
      signalName: "approve",
      correlationKey: "po-1",
      tenantId: TENANT,
    });
    const signalInserts = capture.filter((c) =>
      c.sql.includes("INSERT INTO meta.workflow_signals"),
    );
    expect(signalInserts.length).toBeGreaterThan(0);
  });

  it("upserts the instance projection on each event after start", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const definitions = new Map([[fixtureDefinition().id, fixtureDefinition()]]);
    const { engine } = buildPersistentEngine({
      conn,
      definitions,
      clock: new FixedClock(new Date("2026-05-16T12:00:00.000Z")),
      idGenerator: new CountingIdGenerator(),
    });
    await engine.startInstance({
      definitionId: "wfd_def00001",
      tenantId: TENANT,
      correlationKey: "po-x",
    });
    capture.length = 0;
    await engine.submitSignal({
      signalName: "approve",
      correlationKey: "po-x",
      tenantId: TENANT,
    });
    const updates = capture.filter((c) => c.sql.includes("UPDATE meta.workflow_instances"));
    expect(updates.length).toBeGreaterThan(0);
  });

  it("persistTraces=true wires PostgresWorkflowInstrumentation that writes meta.workflow_traces (M8)", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const definitions = new Map([[fixtureDefinition().id, fixtureDefinition()]]);
    const { engine } = buildPersistentEngine({
      conn,
      definitions,
      clock: new FixedClock(new Date("2026-05-16T12:00:00.000Z")),
      idGenerator: new CountingIdGenerator(),
      persistTraces: true,
    });
    await engine.startInstance({
      definitionId: "wfd_def00001",
      tenantId: TENANT,
      correlationKey: "po-traces",
    });
    const traceInserts = capture.filter((c) => c.sql.includes("INSERT INTO meta.workflow_traces"));
    expect(traceInserts.length).toBeGreaterThan(0);
    const kinds = traceInserts.map((c) => c.params?.[3]);
    expect(kinds).toContain("instance_started");
  });

  it("persistTraces=false (default) emits no traces (M8)", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const definitions = new Map([[fixtureDefinition().id, fixtureDefinition()]]);
    const { engine } = buildPersistentEngine({
      conn,
      definitions,
      clock: new FixedClock(new Date("2026-05-16T12:00:00.000Z")),
      idGenerator: new CountingIdGenerator(),
    });
    await engine.startInstance({
      definitionId: "wfd_def00001",
      tenantId: TENANT,
      correlationKey: "po-no-traces",
    });
    const traceInserts = capture.filter((c) => c.sql.includes("INSERT INTO meta.workflow_traces"));
    expect(traceInserts.length).toBe(0);
  });

  it("custom instrumentation overrides persistTraces (M8)", async () => {
    const events: string[] = [];
    const conn = mockConnection();
    const definitions = new Map([[fixtureDefinition().id, fixtureDefinition()]]);
    const { engine } = buildPersistentEngine({
      conn,
      definitions,
      clock: new FixedClock(new Date("2026-05-16T12:00:00.000Z")),
      idGenerator: new CountingIdGenerator(),
      persistTraces: true,
      instrumentation: {
        onEvent(e) {
          events.push(e.kind);
        },
      },
    });
    await engine.startInstance({
      definitionId: "wfd_def00001",
      tenantId: TENANT,
      correlationKey: "po-custom-instr",
    });
    expect(events).toContain("instance_started");
  });
});
