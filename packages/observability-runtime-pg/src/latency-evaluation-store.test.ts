import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresSloLatencyEvaluationStore } from "./latency-evaluation-store.js";
import {
  SET_PLATFORM_RECORD_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
  type SloLatencyEvaluationRecord,
} from "./records.js";

/** `{sql, params}` as the offline fakes in this file record it. */
interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

/**
 * The statement under test, found by what it *is* rather than by where it sits.
 *
 * `scopedWrite` issues a session setting before the write, so every positional `capture[0]` in a
 * write test would otherwise have had to shift by one — and would shift again the next time a
 * statement joins the transaction. Asserting on the session setting itself is a separate test.
 */
function written(capture: readonly Captured[]): Captured {
  const found = capture.find((c) => !c.sql.includes("set_config"));
  if (found === undefined) throw new Error("no statement other than the session setting was issued");
  return found;
}

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
    // `scopedWrite` runs its write inside a transaction, so a fake whose `transaction` returns
    // undefined silently drops the statement under test.
    transaction: vi.fn(async <T>(fn: (tx: PgConnection) => Promise<T>) =>
      fn(mockConnection(capture, result)),
    ) as PgConnection["transaction"],
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
    expect(written(capture).sql).toContain("INSERT INTO meta.slo_latency_evaluations");
    expect(written(capture).sql).toContain("ON CONFLICT (evaluation_id) DO NOTHING");
  });

  it("serializes breaches to a JSON string", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloLatencyEvaluationStore(mockConnection(capture));
    await store.record(fixture());
    const breachesParam = written(capture).params?.[9] as string;
    expect(typeof breachesParam).toBe("string");
    expect(JSON.parse(breachesParam)).toHaveLength(1);
  });

  it("threads the worst percentile + sample count", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloLatencyEvaluationStore(mockConnection(capture));
    await store.record(fixture());
    expect(written(capture).params?.[7]).toBe("p95");
    expect(written(capture).params?.[8]).toBe(30);
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

describe("the platform write arm", () => {
  it("claims app.platform_record_write before a platform-scope write", async () => {
    const capture: Captured[] = [];
    const store = new PostgresSloLatencyEvaluationStore(mockConnection(capture));
    await store.record(fixture({ tenantId: null }));
    expect(capture[0]?.sql).toBe(SET_PLATFORM_RECORD_WRITE_SQL);
    expect(written(capture).sql).toContain("INSERT INTO meta.slo_latency_evaluations");
  });

  it("claims the tenant context instead for a tenant-scope write, never both", async () => {
    const capture: Captured[] = [];
    await new PostgresSloLatencyEvaluationStore(mockConnection(capture)).record(fixture());
    const settings = capture.filter((c) => c.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    expect(settings[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
  });

  it("claims nothing at all on a read, which the split left unchanged", async () => {
    const capture: Captured[] = [];
    await new PostgresSloLatencyEvaluationStore(mockConnection(capture)).countBreachesSince(
      "orders-latency",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(capture.some((c) => c.sql.includes("set_config"))).toBe(false);
  });
});
