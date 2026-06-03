import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresSloEvaluationStore } from "./evaluation-store.js";
import type { SloEvaluationRecord } from "./records.js";

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

function fixture(overrides: Partial<SloEvaluationRecord> = {}): SloEvaluationRecord {
  return {
    evaluationId: "sloe_auto00000001",
    tenantId: TENANT,
    sloId: "orders-availability",
    surface: "POST /v1/orders",
    breached: true,
    worstSeverity: "sev2",
    worstThresholdId: "fast-burn",
    target: 0.99,
    evaluations: [{ threshold: "fast-burn" }],
    evaluatedAt: "2026-06-02T12:00:00.000Z",
    ...overrides,
  };
}

describe("PostgresSloEvaluationStore.record", () => {
  it("issues an INSERT ... ON CONFLICT DO NOTHING", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEvaluationStore(mockConnection(capture));
    await store.record(fixture());
    expect(capture).toHaveLength(1);
    expect(capture[0]?.sql).toContain("INSERT INTO meta.slo_evaluations");
    expect(capture[0]?.sql).toContain("ON CONFLICT (evaluation_id) DO NOTHING");
  });

  it("serializes evaluations to a JSON string", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEvaluationStore(mockConnection(capture));
    await store.record(fixture());
    const evalParam = capture[0]?.params?.[8] as string;
    expect(typeof evalParam).toBe("string");
    expect(JSON.parse(evalParam)).toHaveLength(1);
  });

  it("validates the record before insert", async () => {
    const store = new PostgresSloEvaluationStore(mockConnection());
    await expect(store.record(fixture({ target: 2 }))).rejects.toThrow();
  });

  it("threads tenant + breached as bind params", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEvaluationStore(mockConnection(capture));
    await store.record(fixture());
    expect(capture[0]?.params?.[1]).toBe(TENANT);
    expect(capture[0]?.params?.[4]).toBe(true);
  });
});

describe("PostgresSloEvaluationStore.countBreachesSince", () => {
  it("parses COUNT(*) from the row", async () => {
    const store = new PostgresSloEvaluationStore(
      mockConnection(undefined, { rows: [{ count: "7" }], rowCount: 1 }),
    );
    expect(await store.countBreachesSince("orders-availability", new Date())).toBe(7);
  });

  it("returns 0 with no rows", async () => {
    const store = new PostgresSloEvaluationStore(
      mockConnection(undefined, { rows: [], rowCount: 0 }),
    );
    expect(await store.countBreachesSince("x", new Date())).toBe(0);
  });
});
