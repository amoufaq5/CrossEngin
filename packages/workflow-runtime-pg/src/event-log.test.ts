import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { WorkflowEvent } from "@crossengin/workflow-engine";
import { describe, expect, it, vi } from "vitest";

import { PostgresEventLog } from "./event-log.js";
import { WorkflowInstanceIdResolver } from "./id-mapping.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const INSTANCE_UUID = "00000000-0000-4000-8000-000000000111";

function fixtureEvent(o: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    id: o.id ?? "wfe_event0001",
    instanceId: o.instanceId ?? "wfi_inst0001",
    tenantId: o.tenantId ?? TENANT,
    sequenceNumber: o.sequenceNumber ?? 0,
    kind: o.kind ?? "instance_started",
    occurredAt: o.occurredAt ?? "2026-05-16T12:00:00.000Z",
    actorPrincipalId: o.actorPrincipalId ?? null,
    actorSystemId: o.actorSystemId ?? "engine",
    previousState: o.previousState ?? null,
    newState: o.newState ?? null,
    activityId: o.activityId ?? null,
    signalId: o.signalId ?? null,
    timerId: o.timerId ?? null,
    childInstanceId: o.childInstanceId ?? null,
    variableName: o.variableName ?? null,
    payload: o.payload ?? {},
    correlationId: o.correlationId ?? null,
    causationEventId: o.causationEventId ?? null,
  };
}

function mockConnection(
  handler: (
    sql: string,
    params: readonly unknown[] | undefined,
  ) => PgQueryResult<Record<string, unknown>>,
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (capture !== undefined) capture.push({ sql, params });
      return handler(sql, params);
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

function buildEventLog(): {
  log: PostgresEventLog;
  resolver: WorkflowInstanceIdResolver;
  capture: Array<{ sql: string; params: readonly unknown[] | undefined }>;
} {
  const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
  const resolver = new WorkflowInstanceIdResolver(conn);
  resolver.register("wfi_inst0001", INSTANCE_UUID);
  return { log: new PostgresEventLog({ conn, instanceResolver: resolver }), resolver, capture };
}

describe("PostgresEventLog.append", () => {
  it("inserts a row with the resolved UUID + JSON payload", async () => {
    const { log, capture } = buildEventLog();
    await log.append(fixtureEvent({ payload: { definitionId: "wfd_x" } }));
    const insert = capture.find((c) => c.sql.includes("INSERT INTO meta.workflow_events"));
    expect(insert).toBeDefined();
    expect(insert?.params?.[0]).toBe("wfe_event0001");
    expect(insert?.params?.[1]).toBe(INSTANCE_UUID);
    expect(insert?.params?.[2]).toBe(TENANT);
    expect(insert?.params?.[3]).toBe(0);
    expect(insert?.params?.[4]).toBe("instance_started");
    expect(typeof insert?.params?.[15]).toBe("string");
    const payloadJson = JSON.parse(insert?.params?.[15] as string) as Record<string, unknown>;
    expect(payloadJson["definitionId"]).toBe("wfd_x");
  });

  it("rejects when instance row does not exist", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.workflow_instances")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    }, capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    await expect(log.append(fixtureEvent({ instanceId: "wfi_unknown01" }))).rejects.toThrow(
      /workflow instance not found/,
    );
  });
});

describe("PostgresEventLog.appendBatch", () => {
  it("appends events one-by-one (preserving order)", async () => {
    const { log, capture } = buildEventLog();
    await log.appendBatch([
      fixtureEvent({ id: "wfe_e1", sequenceNumber: 0 }),
      fixtureEvent({
        id: "wfe_e2",
        sequenceNumber: 1,
        kind: "state_transitioned",
        newState: "approved",
      }),
    ]);
    const inserts = capture.filter((c) => c.sql.includes("INSERT INTO meta.workflow_events"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.params?.[0]).toBe("wfe_e1");
    expect(inserts[1]?.params?.[0]).toBe("wfe_e2");
  });
});

describe("PostgresEventLog.listByInstance", () => {
  it("returns [] when the instance UUID can't be resolved", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const resolver = new WorkflowInstanceIdResolver(conn);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    expect(await log.listByInstance("wfi_unknown01")).toEqual([]);
  });

  it("maps rows back to WorkflowEvent objects", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.workflow_events")) {
        return {
          rows: [
            {
              event_id: "wfe_event0001",
              tenant_id: TENANT,
              sequence_number: 0,
              kind: "instance_started",
              occurred_at: "2026-05-16T12:00:00.000Z",
              actor_principal_id: null,
              actor_system_id: "engine",
              previous_state: null,
              new_state: null,
              activity_id: null,
              signal_id: null,
              timer_id: null,
              child_instance_id: null,
              variable_name: null,
              payload: { definitionId: "wfd_x" },
              correlation_id: null,
              causation_event_id: null,
              instance_text_id: "wfi_inst0001",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }, capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    const events = await log.listByInstance("wfi_inst0001");
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("wfe_event0001");
    expect(events[0]?.instanceId).toBe("wfi_inst0001");
    expect((events[0]?.payload as Record<string, unknown>)["definitionId"]).toBe("wfd_x");
  });

  it("parses JSON-string payloads from libpq", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.workflow_events")) {
        return {
          rows: [
            {
              event_id: "wfe_event0001",
              tenant_id: TENANT,
              sequence_number: 0,
              kind: "instance_started",
              occurred_at: "2026-05-16T12:00:00.000Z",
              actor_principal_id: null,
              actor_system_id: null,
              previous_state: null,
              new_state: null,
              activity_id: null,
              signal_id: null,
              timer_id: null,
              child_instance_id: null,
              variable_name: null,
              payload: '{"a":42}',
              correlation_id: null,
              causation_event_id: null,
              instance_text_id: "wfi_inst0001",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    const events = await log.listByInstance("wfi_inst0001");
    expect((events[0]?.payload as Record<string, unknown>)["a"]).toBe(42);
  });
});

describe("PostgresEventLog.latestSequence", () => {
  it("returns null when the instance is unknown", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const resolver = new WorkflowInstanceIdResolver(conn);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    expect(await log.latestSequence("wfi_unknown01")).toBeNull();
  });

  it("returns the max sequence_number for the instance", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("MAX(sequence_number)")) {
        return { rows: [{ max: 7 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    expect(await log.latestSequence("wfi_inst0001")).toBe(7);
  });

  it("returns null when MAX(sequence_number) is null (no events yet)", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("MAX(sequence_number)")) {
        return { rows: [{ max: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    expect(await log.latestSequence("wfi_inst0001")).toBeNull();
  });
});

describe("PostgresEventLog.count", () => {
  it("returns the workflow_events total", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("COUNT(*)")) return { rows: [{ count: "13" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const resolver = new WorkflowInstanceIdResolver(conn);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    expect(await log.count()).toBe(13);
  });

  it("returns 0 when no row is returned", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const resolver = new WorkflowInstanceIdResolver(conn);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    expect(await log.count()).toBe(0);
  });
});
