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

describe("PostgresSloLatencyEvaluationStore.listSince", () => {
  it("selects newest-first since a cutoff with a bound limit", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloLatencyEvaluationStore(mockConnection(capture));
    await store.listSince(new Date("2026-06-01T00:00:00.000Z"), 50);
    expect(capture[0]?.sql).toContain("FROM meta.slo_latency_evaluations");
    expect(capture[0]?.sql).toContain("WHERE evaluated_at >= $1");
    expect(capture[0]?.sql).toContain("ORDER BY evaluated_at DESC");
    expect(capture[0]?.params?.[0]).toBe("2026-06-01T00:00:00.000Z");
    expect(capture[0]?.params?.[1]).toBe(50);
  });

  it("maps a row back into a validated record", async () => {
    const row = {
      evaluation_id: "slle_auto00000001",
      tenant_id: TENANT,
      slo_id: "catalog-latency",
      surface: "GET /v1/catalog",
      breached: true,
      worst_severity: "sev2",
      worst_threshold_id: "latency-page",
      worst_percentile: "p95",
      sample_count: 30,
      breaches: [{ percentile: "p95", observedMs: 700 }],
      evaluated_at: new Date("2026-06-03T12:00:00.000Z"),
    };
    const store = new PostgresSloLatencyEvaluationStore(
      mockConnection(undefined, { rows: [row], rowCount: 1 }),
    );
    const out = await store.listSince(new Date(0));
    expect(out).toHaveLength(1);
    expect(out[0]!.evaluationId).toBe("slle_auto00000001");
    expect(out[0]!.surface).toBe("GET /v1/catalog");
    expect(out[0]!.worstPercentile).toBe("p95");
    expect(out[0]!.evaluatedAt).toBe("2026-06-03T12:00:00.000Z");
    expect(out[0]!.breaches).toHaveLength(1);
  });

  it("parses a JSON-string breaches column", async () => {
    const row = {
      evaluation_id: "slle_auto00000002",
      tenant_id: null,
      slo_id: "catalog-latency",
      surface: "GET /v1/catalog",
      breached: false,
      worst_severity: null,
      worst_threshold_id: null,
      worst_percentile: null,
      sample_count: 12,
      breaches: "[]",
      evaluated_at: "2026-06-03T12:00:00.000Z",
    };
    const store = new PostgresSloLatencyEvaluationStore(
      mockConnection(undefined, { rows: [row], rowCount: 1 }),
    );
    const out = await store.listSince(new Date(0));
    expect(out[0]!.breaches).toEqual([]);
    expect(out[0]!.tenantId).toBeNull();
  });

  it("rejects a non-positive limit", async () => {
    const store = new PostgresSloLatencyEvaluationStore(mockConnection());
    await expect(store.listSince(new Date(0), 0)).rejects.toThrow("limit must be positive");
  });
});
