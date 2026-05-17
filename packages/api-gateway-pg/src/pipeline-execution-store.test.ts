import type { PipelineExecution } from "@crossengin/api-gateway";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresPipelineExecutionStore } from "./pipeline-execution-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function mockConnection(
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
  result: PgQueryResult = { rows: [], rowCount: 1 },
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (capture !== undefined) capture.push({ sql, params });
      return result;
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

function fixtureExecution(overrides: Partial<PipelineExecution> = {}): PipelineExecution {
  return {
    requestId: "req_test00000001",
    tenantId: TENANT,
    startedAt: "2026-05-16T12:00:00.000Z",
    completedAt: "2026-05-16T12:00:00.025Z",
    totalDurationMs: 25,
    finalStage: "emit_audit",
    finalOutcome: "pass",
    finalResponseStatus: 200,
    stages: [
      {
        stage: "receive",
        outcome: "pass",
        startedAt: "2026-05-16T12:00:00.000Z",
        completedAt: "2026-05-16T12:00:00.001Z",
        durationMs: 1,
        reason: "ok",
        appliedHeaders: {},
        problemTypeUri: null,
        responseStatus: null,
      },
      {
        stage: "emit_audit",
        outcome: "pass",
        startedAt: "2026-05-16T12:00:00.020Z",
        completedAt: "2026-05-16T12:00:00.025Z",
        durationMs: 5,
        reason: "audit_emitted",
        appliedHeaders: {},
        problemTypeUri: null,
        responseStatus: null,
      },
    ],
    authOutcome: "authenticated",
    routeMatchOutcome: "matched",
    idempotencyOutcome: "no_key_required",
    principalId: "00000000-0000-4000-8000-000000000010",
    routeOperationId: "tenants.create",
    resolvedApiVersion: "v1",
    correlationId: "corr-1",
    rateLimitDecisionId: null,
    bytesIn: 0,
    bytesOut: 200,
    ...overrides,
  };
}

describe("PostgresPipelineExecutionStore.record", () => {
  it("issues an INSERT ... ON CONFLICT DO NOTHING", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresPipelineExecutionStore(mockConnection(capture));
    await store.record(fixtureExecution());
    expect(capture).toHaveLength(1);
    expect(capture[0]?.sql).toContain("INSERT INTO meta.gateway_pipeline_executions");
    expect(capture[0]?.sql).toContain("ON CONFLICT (request_id) DO NOTHING");
  });

  it("serializes stages to a JSON string", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresPipelineExecutionStore(mockConnection(capture));
    await store.record(fixtureExecution());
    const stagesParam = capture[0]?.params?.[8] as string;
    expect(typeof stagesParam).toBe("string");
    const parsed = JSON.parse(stagesParam) as unknown[];
    expect(parsed).toHaveLength(2);
  });

  it("passes the request id as the first bind param", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresPipelineExecutionStore(mockConnection(capture));
    await store.record(fixtureExecution({ requestId: "req_unique000001" }));
    expect(capture[0]?.params?.[0]).toBe("req_unique000001");
  });

  it("threads bytesIn / bytesOut", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresPipelineExecutionStore(mockConnection(capture));
    await store.record(fixtureExecution({ bytesIn: 512, bytesOut: 2048 }));
    expect(capture[0]?.params?.[17]).toBe(512);
    expect(capture[0]?.params?.[18]).toBe(2048);
  });
});

describe("PostgresPipelineExecutionStore.countSince", () => {
  it("parses COUNT(*) from the result row", async () => {
    const conn = mockConnection(undefined, {
      rows: [{ count: "42" }],
      rowCount: 1,
    });
    const store = new PostgresPipelineExecutionStore(conn);
    const count = await store.countSince(new Date("2026-05-16T00:00:00.000Z"));
    expect(count).toBe(42);
  });

  it("returns 0 when the result has no rows", async () => {
    const store = new PostgresPipelineExecutionStore(
      mockConnection(undefined, { rows: [], rowCount: 0 }),
    );
    expect(await store.countSince(new Date())).toBe(0);
  });
});
