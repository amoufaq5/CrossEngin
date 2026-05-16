import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { ProjectedInstance } from "@crossengin/workflow-runtime";
import { describe, expect, it, vi } from "vitest";

import {
  WorkflowDefinitionIdResolver,
  WorkflowInstanceIdResolver,
} from "./id-mapping.js";
import { PostgresInstanceStore } from "./instance-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const DEF_UUID = "00000000-0000-4000-8000-000000000900";
const INSTANCE_UUID = "00000000-0000-4000-8000-000000000123";

function fixtureProjection(overrides: Partial<ProjectedInstance> = {}): ProjectedInstance {
  return {
    instanceId: "wfi_inst0001",
    tenantId: TENANT,
    definitionId: "wfd_def00001",
    definitionKey: "purchase.approval",
    definitionVersion: "1.0.0",
    status: "waiting_for_signal",
    currentState: "awaiting_approval",
    variables: { amount: 250 },
    correlationKey: "po-1",
    parentInstanceId: null,
    startedAt: "2026-05-16T12:00:00.000Z",
    startedByUserId: null,
    startedBySystem: "engine",
    lastTransitionAt: "2026-05-16T12:00:00.000Z",
    completedAt: null,
    cancelledAt: null,
    cancelledByUserId: null,
    cancelledReason: null,
    failedAt: null,
    failureCode: null,
    failureMessage: null,
    suspendedAt: null,
    suspendedReason: null,
    compensationStartedAt: null,
    compensationCompletedAt: null,
    timeoutAt: "2026-05-17T12:00:00.000Z",
    sequenceCursor: 1,
    awaitingActivityIds: [],
    awaitingSignalNames: ["approve"],
    awaitingTimerNames: [],
    ...overrides,
  };
}

function mockConnection(
  handler: (sql: string, params: readonly unknown[] | undefined) => PgQueryResult<Record<string, unknown>>,
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

describe("PostgresInstanceStore.create", () => {
  it("INSERTs and registers the resolved UUID", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection((sql) => {
      if (sql.includes("INSERT INTO meta.workflow_instances")) {
        return { rows: [{ id: INSTANCE_UUID }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }, capture);
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    definitionResolver.register("wfd_def00001", DEF_UUID);
    const store = new PostgresInstanceStore({ conn, instanceResolver, definitionResolver });
    const id = await store.create({
      projection: fixtureProjection(),
      definitionId: "wfd_def00001",
    });
    expect(id).toBe(INSTANCE_UUID);
    expect(await instanceResolver.resolve("wfi_inst0001")).toBe(INSTANCE_UUID);
    const insert = capture.find((c) => c.sql.includes("INSERT"));
    expect(insert?.params?.[0]).toBe("wfi_inst0001");
    expect(insert?.params?.[2]).toBe(DEF_UUID);
    expect(insert?.params?.[5]).toBe("waiting_for_signal");
  });

  it("serializes variables + awaiting arrays as JSON", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(
      () => ({ rows: [{ id: INSTANCE_UUID }], rowCount: 1 }),
      capture,
    );
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    definitionResolver.register("wfd_def00001", DEF_UUID);
    const store = new PostgresInstanceStore({ conn, instanceResolver, definitionResolver });
    await store.create({
      projection: fixtureProjection({
        variables: { amount: 250, currency: "USD" },
        awaitingActivityIds: ["wfa_a1"],
        awaitingSignalNames: ["approve", "reject"],
      }),
      definitionId: "wfd_def00001",
    });
    const insert = capture[0]!;
    expect(JSON.parse(insert.params?.[7] as string)).toEqual({ amount: 250, currency: "USD" });
    expect(JSON.parse(insert.params?.[16] as string)).toEqual(["wfa_a1"]);
    expect(JSON.parse(insert.params?.[17] as string)).toEqual(["approve", "reject"]);
  });

  it("threads relatedEntity when supplied", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(
      () => ({ rows: [{ id: INSTANCE_UUID }], rowCount: 1 }),
      capture,
    );
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    definitionResolver.register("wfd_def00001", DEF_UUID);
    const store = new PostgresInstanceStore({ conn, instanceResolver, definitionResolver });
    await store.create({
      projection: fixtureProjection(),
      definitionId: "wfd_def00001",
      relatedEntity: { kind: "purchase_request", id: "PR-001" },
    });
    expect(JSON.parse(capture[0]!.params?.[8] as string)).toEqual({
      kind: "purchase_request",
      id: "PR-001",
    });
  });

  it("rejects when definition UUID is unknown", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    const store = new PostgresInstanceStore({ conn, instanceResolver, definitionResolver });
    await expect(
      store.create({ projection: fixtureProjection(), definitionId: "wfd_unknown" }),
    ).rejects.toThrow(/workflow definition not found/);
  });

  it("throws when INSERT returns no row", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    definitionResolver.register("wfd_def00001", DEF_UUID);
    const store = new PostgresInstanceStore({ conn, instanceResolver, definitionResolver });
    await expect(
      store.create({ projection: fixtureProjection(), definitionId: "wfd_def00001" }),
    ).rejects.toThrow(/failed to insert/);
  });
});

describe("PostgresInstanceStore.upsertProjection", () => {
  it("UPDATEs the workflow_instances row by instance_id", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    const store = new PostgresInstanceStore({ conn, instanceResolver, definitionResolver });
    await store.upsertProjection(
      fixtureProjection({ status: "completed", completedAt: "2026-05-16T13:00:00.000Z" }),
    );
    const update = capture[0]!;
    expect(update.sql).toContain("UPDATE meta.workflow_instances");
    expect(update.sql).toContain("WHERE instance_id = $21");
    expect(update.params?.[0]).toBe("completed");
    expect(update.params?.[5]).toBe("2026-05-16T13:00:00.000Z");
    expect(update.params?.[20]).toBe("wfi_inst0001");
  });
});
