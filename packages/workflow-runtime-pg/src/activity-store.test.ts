import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import {
  PostgresActivityStore,
  type ActivityProjection,
} from "./activity-store.js";
import { WorkflowInstanceIdResolver } from "./id-mapping.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const INSTANCE_UUID = "00000000-0000-4000-8000-000000000123";

function fixtureActivity(overrides: Partial<ActivityProjection> = {}): ActivityProjection {
  return {
    id: "wfa_act00001",
    instanceId: "wfi_inst0001",
    tenantId: TENANT,
    kind: "http_call",
    definitionActivityKey: "charge_card",
    label: "charge_card",
    status: "scheduled",
    attemptNumber: 1,
    sequenceCursor: 1,
    maxAttempts: 3,
    retryPolicy: {
      strategy: "exponential_backoff",
      maxAttempts: 3,
      initialDelaySeconds: 1,
      maxDelaySeconds: 300,
      retryableErrorCodes: [],
      nonRetryableErrorCodes: [],
    },
    scheduledAt: "2026-05-16T12:00:00.000Z",
    startedAt: null,
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    inputSha256: null,
    outputSha256: null,
    nextRetryAt: null,
    timeoutSeconds: 300,
    timeoutAt: "2026-05-16T12:05:00.000Z",
    ...overrides,
  };
}

function mockConnection(
  handler: (sql: string, params: readonly unknown[] | undefined) => PgQueryResult,
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

describe("PostgresActivityStore.upsert", () => {
  it("INSERTs with ON CONFLICT (activity_id) DO UPDATE", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresActivityStore({ conn, instanceResolver: resolver });
    await store.upsert(fixtureActivity());
    const insert = capture[0]!;
    expect(insert.sql).toContain("INSERT INTO meta.workflow_activities");
    expect(insert.sql).toContain("ON CONFLICT (activity_id) DO UPDATE");
    expect(insert.params?.[0]).toBe("wfa_act00001");
    expect(insert.params?.[1]).toBe(INSTANCE_UUID);
    expect(insert.params?.[4]).toBe("http_call");
    expect(insert.params?.[5]).toBe("scheduled");
  });

  it("threads completedAt + outputSha256 for succeeded activities", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresActivityStore({ conn, instanceResolver: resolver });
    await store.upsert(
      fixtureActivity({
        status: "succeeded",
        completedAt: "2026-05-16T12:00:30.000Z",
        outputSha256: "a".repeat(64),
      }),
    );
    expect(capture[0]?.params?.[11]).toBe("2026-05-16T12:00:30.000Z");
    expect(capture[0]?.params?.[15]).toBe("a".repeat(64));
  });

  it("threads errorCode + errorMessage for failed activities", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresActivityStore({ conn, instanceResolver: resolver });
    await store.upsert(
      fixtureActivity({
        status: "failed",
        completedAt: "2026-05-16T12:00:30.000Z",
        errorCode: "503",
        errorMessage: "service unavailable",
      }),
    );
    expect(capture[0]?.params?.[16]).toBe("503");
    expect(capture[0]?.params?.[17]).toBe("service unavailable");
  });

  it("persists max_attempts, retry_policy (jsonb), timeout, and next_retry_at", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresActivityStore({ conn, instanceResolver: resolver });
    await store.upsert(
      fixtureActivity({
        status: "failed",
        maxAttempts: 5,
        nextRetryAt: "2026-05-16T12:00:30.000Z",
        timeoutSeconds: 120,
        timeoutAt: "2026-05-16T12:02:00.000Z",
      }),
    );
    const insert = capture[0]!;
    expect(insert.sql).toContain("retry_policy");
    expect(insert.sql).toContain("$9::jsonb");
    expect(insert.sql).toContain("next_retry_at = EXCLUDED.next_retry_at");
    expect(insert.params?.[7]).toBe(5); // max_attempts
    expect(JSON.parse(insert.params?.[8] as string).strategy).toBe("exponential_backoff");
    expect(insert.params?.[12]).toBe(120); // timeout_seconds
    expect(insert.params?.[13]).toBe("2026-05-16T12:02:00.000Z"); // timeout_at
    expect(insert.params?.[18]).toBe("2026-05-16T12:00:30.000Z"); // next_retry_at
  });

  it("rejects when instance is not resolvable", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const resolver = new WorkflowInstanceIdResolver(conn);
    const store = new PostgresActivityStore({ conn, instanceResolver: resolver });
    await expect(store.upsert(fixtureActivity({ instanceId: "wfi_unknown01" }))).rejects.toThrow(
      /workflow instance not found/,
    );
  });
});

describe("PostgresActivityStore.upsertMany", () => {
  it("calls upsert for each projection", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresActivityStore({ conn, instanceResolver: resolver });
    await store.upsertMany([
      fixtureActivity({ id: "wfa_act00001" }),
      fixtureActivity({ id: "wfa_act00002", definitionActivityKey: "notify" }),
    ]);
    const inserts = capture.filter((c) => c.sql.includes("INSERT INTO meta.workflow_activities"));
    expect(inserts).toHaveLength(2);
  });
});
