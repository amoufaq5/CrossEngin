import { describe, expect, it, vi } from "vitest";

import type { PgConnection, PgQueryResult } from "./connection.js";
import { PostgresTraceRetention } from "./trace-retention.js";

interface Capture {
  sql: string;
  params: readonly unknown[] | undefined;
}

function mockConnection(
  handler: (sql: string, params: readonly unknown[] | undefined) => PgQueryResult,
  capture?: Capture[],
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

function policyRow(
  tableName: string,
  overrides: Partial<{
    retention_days: number;
    enabled: boolean;
    last_pruned_at: string | null;
  }> = {},
): Record<string, unknown> {
  return {
    table_name: tableName,
    retention_days: 30,
    enabled: true,
    last_pruned_at: null,
    ...overrides,
  };
}

describe("PostgresTraceRetention.knownPrunableTables", () => {
  it("exposes the three trace tables the adapter knows how to prune", () => {
    const tables = PostgresTraceRetention.knownPrunableTables();
    expect(new Set(tables)).toEqual(
      new Set(["workflow_traces", "llm_latency_samples", "llm_call_traces"]),
    );
  });
});

describe("PostgresTraceRetention.listPolicies", () => {
  it("SELECTs from meta.retention_policies in alphabetical order", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [policyRow("workflow_traces"), policyRow("llm_call_traces")],
        rowCount: 2,
      }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const policies = await r.listPolicies();
    expect(policies).toHaveLength(2);
    expect(capture[0]?.sql).toContain("FROM meta.retention_policies");
    expect(capture[0]?.sql).toContain("ORDER BY table_name ASC");
  });

  it("maps snake_case row fields to camelCase API", async () => {
    const conn = mockConnection(() => ({
      rows: [
        policyRow("workflow_traces", {
          retention_days: 90,
          enabled: false,
          last_pruned_at: "2026-05-19T12:00:00.000Z",
        }),
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const policies = await r.listPolicies();
    expect(policies[0]).toEqual({
      tableName: "workflow_traces",
      retentionDays: 90,
      enabled: false,
      lastPrunedAt: "2026-05-19T12:00:00.000Z",
    });
  });

  it("returns empty array when no policies configured", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    expect(await r.listPolicies()).toEqual([]);
  });
});

describe("PostgresTraceRetention.prune", () => {
  it("issues DELETE against meta.workflow_traces using occurred_at column", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT")) {
          return {
            rows: [policyRow("workflow_traces", { retention_days: 30 })],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 7 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn, clock: () => 100_000_000_000 });
    const results = await r.prune();
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("pruned");
    expect(results[0]?.deletedCount).toBe(7);
    const deleteSql = capture.find((c) => c.sql.includes("DELETE"))?.sql ?? "";
    expect(deleteSql).toContain("DELETE FROM meta.workflow_traces");
    expect(deleteSql).toContain("occurred_at <");
  });

  it("uses recorded_at for llm_latency_samples (not occurred_at)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT")) {
          return {
            rows: [policyRow("llm_latency_samples")],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.prune();
    const deleteSql = capture.find((c) => c.sql.includes("DELETE"))?.sql ?? "";
    expect(deleteSql).toContain("DELETE FROM meta.llm_latency_samples");
    expect(deleteSql).toContain("recorded_at <");
    expect(deleteSql).not.toContain("occurred_at <");
  });

  it("uses occurred_at for llm_call_traces", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT")) {
          return { rows: [policyRow("llm_call_traces")], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.prune();
    const deleteSql = capture.find((c) => c.sql.includes("DELETE"))?.sql ?? "";
    expect(deleteSql).toContain("DELETE FROM meta.llm_call_traces");
    expect(deleteSql).toContain("occurred_at <");
  });

  it("threads the cutoff timestamp computed from clock - retentionDays", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT")) {
          return {
            rows: [policyRow("workflow_traces", { retention_days: 7 })],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const NOW = 1_000_000_000_000;
    const r = new PostgresTraceRetention({ conn, clock: () => NOW });
    const results = await r.prune();
    const expectedCutoff = NOW - 7 * 86_400 * 1_000;
    expect(results[0]?.cutoffMs).toBe(expectedCutoff);
    const deleteCall = capture.find((c) => c.sql.includes("DELETE"));
    expect(deleteCall?.params).toEqual([expectedCutoff]);
  });

  it("updates last_pruned_at on the policy row after a successful prune", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT")) {
          return { rows: [policyRow("workflow_traces")], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.prune();
    const updateCall = capture.find((c) => c.sql.includes("UPDATE"));
    expect(updateCall?.sql).toContain("UPDATE meta.retention_policies");
    expect(updateCall?.sql).toContain("last_pruned_at = now()");
    expect(updateCall?.params).toEqual(["workflow_traces"]);
  });

  it("skips disabled policies and reports status=skipped_disabled", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT")) {
          return {
            rows: [policyRow("workflow_traces", { enabled: false })],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const results = await r.prune();
    expect(results[0]?.status).toBe("skipped_disabled");
    expect(results[0]?.deletedCount).toBe(0);
    expect(results[0]?.cutoffMs).toBeNull();
    const deleteCall = capture.find((c) => c.sql.includes("DELETE"));
    expect(deleteCall).toBeUndefined();
  });

  it("skips unknown table names defensively (DB CHECK constraint catches first)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT")) {
          return {
            rows: [policyRow("unknown_table_name")],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const results = await r.prune();
    expect(results[0]?.status).toBe("skipped_unknown_table");
    expect(results[0]?.deletedCount).toBe(0);
    const deleteCall = capture.find((c) => c.sql.includes("DELETE"));
    expect(deleteCall).toBeUndefined();
  });

  it("handles multiple policies in a single prune run", async () => {
    const capture: Capture[] = [];
    let deleteCount = 0;
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT") && sql.includes("retention_policies")) {
          return {
            rows: [
              policyRow("workflow_traces"),
              policyRow("llm_call_traces"),
              policyRow("llm_latency_samples"),
            ],
            rowCount: 3,
          };
        }
        if (sql.startsWith("DELETE")) {
          deleteCount += 1;
          return { rows: [], rowCount: deleteCount };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const results = await r.prune();
    expect(results).toHaveLength(3);
    expect(results.every((x) => x.status === "pruned")).toBe(true);
    const deletes = capture.filter((c) => c.sql.includes("DELETE"));
    expect(deletes).toHaveLength(3);
  });

  it("returns 0 deletedCount when no rows match the cutoff", async () => {
    const conn = mockConnection((sql) => {
      if (sql.startsWith("SELECT")) {
        return { rows: [policyRow("workflow_traces")], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const results = await r.prune();
    expect(results[0]?.status).toBe("pruned");
    expect(results[0]?.deletedCount).toBe(0);
  });

  it("uses default Date.now clock when clock option omitted", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT")) {
          return {
            rows: [policyRow("workflow_traces", { retention_days: 1 })],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const before = Date.now() - 86_400 * 1_000 - 1000;
    await r.prune();
    const after = Date.now() - 86_400 * 1_000 + 1000;
    const deleteCall = capture.find((c) => c.sql.includes("DELETE"));
    const cutoff = deleteCall?.params?.[0] as number;
    expect(cutoff).toBeGreaterThanOrEqual(before);
    expect(cutoff).toBeLessThanOrEqual(after);
  });

  it("does not issue DELETE when no policies are configured", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    const results = await r.prune();
    expect(results).toEqual([]);
    expect(capture.filter((c) => c.sql.includes("DELETE"))).toHaveLength(0);
  });
});

describe("PostgresTraceRetention — safety properties", () => {
  it("the table allowlist is hardcoded (table name is not user-supplied in DELETE SQL)", () => {
    // This is a documentation test: the allowlist is private but exposed via
    // knownPrunableTables(). Any change to the allowlist requires source edits.
    const allowed = PostgresTraceRetention.knownPrunableTables();
    expect(allowed.length).toBe(3);
    for (const t of allowed) {
      expect(t).toMatch(/^[a-z_]+$/);
    }
  });
});
