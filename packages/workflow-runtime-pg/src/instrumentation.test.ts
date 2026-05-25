import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { WorkflowInstrumentationEvent } from "@crossengin/workflow-runtime";
import { describe, expect, it, vi } from "vitest";

import { WorkflowDefinitionIdResolver, WorkflowInstanceIdResolver } from "./id-mapping.js";
import { PostgresWorkflowInstrumentation } from "./instrumentation.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const INSTANCE_UUID = "00000000-0000-4000-8000-000000000123";
const DEFINITION_UUID = "00000000-0000-4000-8000-000000000456";

function mockConnection(
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      if (capture !== undefined) capture.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

function event(
  overrides: Partial<WorkflowInstrumentationEvent> = {},
): WorkflowInstrumentationEvent {
  return {
    kind: "instance_started",
    tenantId: TENANT,
    instanceId: "wfi_inst0001",
    definitionId: "wfd_def00001",
    correlationId: "po-1",
    occurredAt: "2026-05-16T12:00:00.000Z",
    durationMs: null,
    attributes: { definitionKey: "purchase.approval" },
    ...overrides,
  };
}

describe("PostgresWorkflowInstrumentation", () => {
  it("INSERTs into meta.workflow_traces with resolved UUIDs", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    instanceResolver.register("wfi_inst0001", INSTANCE_UUID);
    definitionResolver.register("wfd_def00001", DEFINITION_UUID);
    const inst = new PostgresWorkflowInstrumentation({
      conn,
      instanceResolver,
      definitionResolver,
    });
    await inst.onEvent(event());
    expect(capture.length).toBe(1);
    expect(capture[0]?.sql).toContain("INSERT INTO meta.workflow_traces");
    expect(capture[0]?.params?.[0]).toBe(TENANT);
    expect(capture[0]?.params?.[1]).toBe(INSTANCE_UUID);
    expect(capture[0]?.params?.[2]).toBe(DEFINITION_UUID);
    expect(capture[0]?.params?.[3]).toBe("instance_started");
    expect(capture[0]?.params?.[4]).toBe("2026-05-16T12:00:00.000Z");
    expect(capture[0]?.params?.[6]).toBe("po-1");
    expect(JSON.parse(capture[0]?.params?.[7] as string)).toEqual({
      definitionKey: "purchase.approval",
    });
  });

  it("passes through null for absent instance/definition refs", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const inst = new PostgresWorkflowInstrumentation({ conn });
    await inst.onEvent(event({ instanceId: null, definitionId: null, kind: "engine_error" }));
    expect(capture[0]?.params?.[1]).toBeNull();
    expect(capture[0]?.params?.[2]).toBeNull();
    expect(capture[0]?.params?.[3]).toBe("engine_error");
  });

  it("serializes attributes via JSON.stringify (no leakage of native objects)", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    instanceResolver.register("wfi_inst0001", INSTANCE_UUID);
    definitionResolver.register("wfd_def00001", DEFINITION_UUID);
    const inst = new PostgresWorkflowInstrumentation({
      conn,
      instanceResolver,
      definitionResolver,
    });
    await inst.onEvent(
      event({
        attributes: {
          previousState: "draft",
          newState: "awaiting_approval",
          transitionName: "submit",
          signalId: null,
          timerId: null,
        },
      }),
    );
    const insertCall = capture.find((c) => c.sql.includes("INSERT"));
    const json = JSON.parse(insertCall?.params?.[7] as string) as Record<string, unknown>;
    expect(json["previousState"]).toBe("draft");
    expect(json["newState"]).toBe("awaiting_approval");
    expect(json["signalId"]).toBeNull();
  });

  it("threads durationMs when present", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    instanceResolver.register("wfi_inst0001", INSTANCE_UUID);
    definitionResolver.register("wfd_def00001", DEFINITION_UUID);
    const inst = new PostgresWorkflowInstrumentation({
      conn,
      instanceResolver,
      definitionResolver,
    });
    await inst.onEvent(event({ durationMs: 123 }));
    const insertCall = capture.find((c) => c.sql.includes("INSERT"));
    expect(insertCall?.params?.[5]).toBe(123);
  });

  it("handles unresolved instance_id gracefully (writes null instead of throwing)", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn: PgConnection = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
        capture.push({ sql, params });
        if (sql.startsWith("SELECT")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      }) as PgConnection["query"],
      transaction: vi.fn() as PgConnection["transaction"],
      withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
      close: vi.fn() as PgConnection["close"],
    };
    const inst = new PostgresWorkflowInstrumentation({ conn });
    await inst.onEvent(event({ instanceId: "wfi_unknown" }));
    const insertCall = capture.find((c) => c.sql.includes("INSERT INTO meta.workflow_traces"));
    expect(insertCall?.params?.[1]).toBeNull();
  });

  it("constructs default resolvers when none provided", () => {
    const conn = mockConnection();
    expect(() => new PostgresWorkflowInstrumentation({ conn })).not.toThrow();
  });
});

describe("PostgresWorkflowInstrumentation — kind coverage", () => {
  function buildInst(
    capture: Array<{ sql: string; params: readonly unknown[] | undefined }>,
  ): PostgresWorkflowInstrumentation {
    const conn = mockConnection(capture);
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    instanceResolver.register("wfi_inst0001", INSTANCE_UUID);
    definitionResolver.register("wfd_def00001", DEFINITION_UUID);
    return new PostgresWorkflowInstrumentation({
      conn,
      instanceResolver,
      definitionResolver,
    });
  }

  function insertParams(
    capture: Array<{ sql: string; params: readonly unknown[] | undefined }>,
  ): ReadonlyArray<readonly unknown[] | undefined> {
    return capture
      .filter((c) => c.sql.includes("INSERT INTO meta.workflow_traces"))
      .map((c) => c.params);
  }

  it("writes state_transitioned with the previousState/newState attributes", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const inst = buildInst(capture);
    await inst.onEvent(
      event({
        kind: "state_transitioned",
        attributes: { previousState: "draft", newState: "approved", transitionName: "approve" },
      }),
    );
    const inserts = insertParams(capture);
    expect(inserts[0]?.[3]).toBe("state_transitioned");
  });

  it("writes signal_received + signal_consumed", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const inst = buildInst(capture);
    await inst.onEvent(event({ kind: "signal_received" }));
    await inst.onEvent(event({ kind: "signal_consumed" }));
    const inserts = insertParams(capture);
    expect(inserts.map((p) => p?.[3])).toEqual(["signal_received", "signal_consumed"]);
  });

  it("writes timer_fired with the timer attributes", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const inst = buildInst(capture);
    await inst.onEvent(
      event({
        kind: "timer_fired",
        attributes: { timerId: "wft_t1", timerName: "deadline", fireAt: 1746999999 },
      }),
    );
    const inserts = insertParams(capture);
    expect(inserts[0]?.[3]).toBe("timer_fired");
    const json = JSON.parse(inserts[0]?.[7] as string) as Record<string, unknown>;
    expect(json["timerName"]).toBe("deadline");
  });

  it("writes instance_failed / instance_completed / instance_cancelled", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const inst = buildInst(capture);
    await inst.onEvent(event({ kind: "instance_completed" }));
    await inst.onEvent(event({ kind: "instance_failed" }));
    await inst.onEvent(event({ kind: "instance_cancelled" }));
    const inserts = insertParams(capture);
    expect(inserts.map((p) => p?.[3])).toEqual([
      "instance_completed",
      "instance_failed",
      "instance_cancelled",
    ]);
  });
});
