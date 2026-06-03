import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresSloLatencyEvaluationStore } from "./latency-evaluation-store.js";
import type { SloLatencyEvaluationRecord } from "./records.js";

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

function fixture(
  overrides: Partial<SloLatencyEvaluationRecord> = {},
): SloLatencyEvaluationRecord {
  return {
    evaluationId: "slle_auto00000001",
    tenantId: TENANT,
    sloId: "catalog-latency",
    surface: "GET /v1/catalog",
    breached: true,
    worstSeverity: "sev2",
    worstThresholdId: "latency-page",
    worstPercentile: "p95",
    sampleCount: 30,
    breaches: [{ percentile: "p95", observedMs: 700, budgetMs: 300 }],
    evaluatedAt: "2026-06-03T12:00:00.000Z",
    ...overrides,
  };
}

describe("PostgresSloLatencyEvaluationStore.record", () => {
  it("issues an INSERT ... ON CONFLICT DO NOTHING into the latency table", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloLatencyEvaluationStore(mockConnection(capture));
    await store.record(fixture());
    expect(capture[0]?.sql).toContain("INSERT INTO meta.slo_latency_evaluations");
    expect(capture[0]?.sql).toContain("ON CONFLICT (evaluation_id) DO NOTHING");
  });

  it("serializes breaches to a JSON string", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloLatencyEvaluationStore(mockConnection(capture));
    await store.record(fixture());
    const breachesParam = capture[0]?.params?.[9] as string;
    expect(typeof breachesParam).toBe("string");
    expect(JSON.parse(breachesParam)).toHaveLength(1);
  });

  it("threads the worst percentile + sample count", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloLatencyEvaluationStore(mockConnection(capture));
    await store.record(fixture());
    expect(capture[0]?.params?.[7]).toBe("p95");
    expect(capture[0]?.params?.[8]).toBe(30);
  });

  it("rejects a malformed evaluation id", async () => {
    const store = new PostgresSloLatencyEvaluationStore(mockConnection());
    await expect(store.record(fixture({ evaluationId: "sloe_wrongprefix1" }))).rejects.toThrow();
  });

  it("counts latency breaches since a cutoff", async () => {
    const store = new PostgresSloLatencyEvaluationStore(
      mockConnection(undefined, { rows: [{ count: "4" }], rowCount: 1 }),
    );
    expect(await store.countBreachesSince("catalog-latency", new Date())).toBe(4);
  });
});
