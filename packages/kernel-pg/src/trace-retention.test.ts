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
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
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
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
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
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
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
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
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
    // Platform-default DELETE on tables with tenant_id includes the
    // tenant_retention_policies NOT IN subquery, so params are [cutoffMs, table_name].
    expect(deleteCall?.params).toEqual([expectedCutoff, "workflow_traces"]);
  });

  it("updates last_pruned_at on the policy row after a successful prune", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
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
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
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
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
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
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
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
      if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
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
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
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

describe("PostgresTraceRetention.previewPrune (M6.7.zz.dry-run)", () => {
  it("issues SELECT COUNT(*) against meta.workflow_traces using occurred_at column", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
          return {
            rows: [policyRow("workflow_traces", { retention_days: 30 })],
            rowCount: 1,
          };
        }
        if (sql.startsWith("SELECT") && sql.includes("COUNT(*)")) {
          return { rows: [{ count: "42" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn, clock: () => 100_000_000_000 });
    const results = await r.previewPrune();
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("previewed");
    expect(results[0]?.wouldDeleteCount).toBe(42);
    const countSql = capture.find((c) => c.sql.includes("COUNT(*)"))?.sql ?? "";
    expect(countSql).toContain("FROM meta.workflow_traces");
    expect(countSql).toContain("occurred_at <");
  });

  it("uses recorded_at for llm_latency_samples in COUNT query", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
          return { rows: [policyRow("llm_latency_samples")], rowCount: 1 };
        }
        return { rows: [{ count: "100" }], rowCount: 1 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.previewPrune();
    const countSql = capture.find((c) => c.sql.includes("COUNT(*)"))?.sql ?? "";
    expect(countSql).toContain("FROM meta.llm_latency_samples");
    expect(countSql).toContain("recorded_at <");
    expect(countSql).not.toContain("occurred_at <");
  });

  it("uses occurred_at for llm_call_traces in COUNT query", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
          return { rows: [policyRow("llm_call_traces")], rowCount: 1 };
        }
        return { rows: [{ count: "5" }], rowCount: 1 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.previewPrune();
    const countSql = capture.find((c) => c.sql.includes("COUNT(*)"))?.sql ?? "";
    expect(countSql).toContain("FROM meta.llm_call_traces");
    expect(countSql).toContain("occurred_at <");
  });

  it("threads the cutoff timestamp computed from clock - retentionDays", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.includes("COUNT(*)")) {
          return { rows: [{ count: "10" }], rowCount: 1 };
        }
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
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
    const results = await r.previewPrune();
    const expectedCutoff = NOW - 7 * 86_400 * 1_000;
    expect(results[0]?.cutoffMs).toBe(expectedCutoff);
    const countCall = capture.find((c) => c.sql.includes("COUNT(*)"));
    // platform-default COUNT for tables with tenant_id includes the NOT IN subquery + table_name param
    expect(countCall?.params).toEqual([expectedCutoff, "workflow_traces"]);
  });

  it("does NOT issue any DELETE statement (read-only)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
          return { rows: [policyRow("workflow_traces")], rowCount: 1 };
        }
        return { rows: [{ count: "42" }], rowCount: 1 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.previewPrune();
    const deletes = capture.filter((c) => c.sql.includes("DELETE"));
    expect(deletes).toHaveLength(0);
  });

  it("does NOT update last_pruned_at (read-only)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
          return { rows: [policyRow("workflow_traces")], rowCount: 1 };
        }
        return { rows: [{ count: "42" }], rowCount: 1 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.previewPrune();
    const updates = capture.filter((c) => c.sql.includes("UPDATE"));
    expect(updates).toHaveLength(0);
  });

  it("skips disabled policies with status=skipped_disabled and wouldDeleteCount=0", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
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
    const results = await r.previewPrune();
    expect(results[0]?.status).toBe("skipped_disabled");
    expect(results[0]?.wouldDeleteCount).toBe(0);
    expect(results[0]?.cutoffMs).toBeNull();
    const counts = capture.filter((c) => c.sql.includes("COUNT(*)"));
    expect(counts).toHaveLength(0);
  });

  it("skips unknown table names defensively (DB CHECK constraint catches first)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
          return { rows: [policyRow("unknown_future_table")], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const results = await r.previewPrune();
    expect(results[0]?.status).toBe("skipped_unknown_table");
    expect(results[0]?.wouldDeleteCount).toBe(0);
    const counts = capture.filter((c) => c.sql.includes("COUNT(*)"));
    expect(counts).toHaveLength(0);
  });

  it("handles multiple policies in a single preview run", async () => {
    const capture: Capture[] = [];
    let nextCount = 5;
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
          return {
            rows: [
              policyRow("workflow_traces"),
              policyRow("llm_call_traces"),
              policyRow("llm_latency_samples"),
            ],
            rowCount: 3,
          };
        }
        if (sql.includes("COUNT(*)")) {
          const count = nextCount;
          nextCount += 10;
          return { rows: [{ count: count.toString() }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const results = await r.previewPrune();
    expect(results).toHaveLength(3);
    expect(results.every((x) => x.status === "previewed")).toBe(true);
    expect(results.map((x) => x.wouldDeleteCount)).toEqual([5, 15, 25]);
  });

  it("parses PG's BIGINT COUNT result via ::TEXT cast (handles large counts)", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("COUNT(*)")) {
        // PG COUNT(*) returns BIGINT — large values come back as strings via ::TEXT.
        return { rows: [{ count: "9876543210" }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
        return { rows: [policyRow("workflow_traces")], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const results = await r.previewPrune();
    expect(results[0]?.wouldDeleteCount).toBe(9_876_543_210);
  });

  it("returns 0 wouldDeleteCount when no rows match the cutoff", async () => {
    const conn = mockConnection((sql) => {
      if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
        return { rows: [policyRow("workflow_traces")], rowCount: 1 };
      }
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ count: "0" }], rowCount: 1 };
    });
    const r = new PostgresTraceRetention({ conn });
    const results = await r.previewPrune();
    expect(results[0]?.status).toBe("previewed");
    expect(results[0]?.wouldDeleteCount).toBe(0);
  });

  it("returns empty array when no policies are configured", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    const results = await r.previewPrune();
    expect(results).toEqual([]);
    expect(capture.filter((c) => c.sql.includes("COUNT(*)"))).toHaveLength(0);
  });

  it("preview and prune use the same cutoff for the same clock + policy", async () => {
    const NOW = 1_000_000_000_000;
    const policies = [policyRow("workflow_traces", { retention_days: 30 })];
    const captureP: Capture[] = [];
    const connPreview = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
          return { rows: policies, rowCount: 1 };
        }
        if (sql.includes("FROM meta.tenant_retention_policies")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ count: "0" }], rowCount: 1 };
      },
      captureP,
    );
    const captureR: Capture[] = [];
    const connRun = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
          return { rows: policies, rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      captureR,
    );
    const previewResults = await new PostgresTraceRetention({
      conn: connPreview,
      clock: () => NOW,
    }).previewPrune();
    const runResults = await new PostgresTraceRetention({
      conn: connRun,
      clock: () => NOW,
    }).prune();
    expect(previewResults[0]?.cutoffMs).toBe(runResults[0]?.cutoffMs);
  });
});

describe("PostgresTraceRetention — per-tenant policies (M6.7.zz.tenant)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";

  function tenantPolicyRow(
    tenantId: string,
    tableName: string,
    overrides: Partial<{
      retention_days: number;
      enabled: boolean;
      last_pruned_at: string | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      table_name: tableName,
      retention_days: 7,
      enabled: true,
      last_pruned_at: null,
      ...overrides,
    };
  }

  it("listTenantPolicies SELECTs from meta.tenant_retention_policies ordered by table + tenant", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [tenantPolicyRow(TENANT_A, "workflow_traces")],
        rowCount: 1,
      }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const policies = await r.listTenantPolicies();
    expect(policies).toHaveLength(1);
    expect(capture[0]?.sql).toContain("FROM meta.tenant_retention_policies");
    expect(capture[0]?.sql).toContain("ORDER BY table_name ASC, tenant_id ASC");
  });

  it("listTenantPolicies maps snake_case row fields to camelCase API", async () => {
    const conn = mockConnection(() => ({
      rows: [
        tenantPolicyRow(TENANT_A, "workflow_traces", {
          retention_days: 14,
          enabled: false,
          last_pruned_at: "2026-05-20T12:00:00.000Z",
        }),
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const policies = await r.listTenantPolicies();
    expect(policies[0]).toEqual({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 14,
      enabled: false,
      lastPrunedAt: "2026-05-20T12:00:00.000Z",
    });
  });

  it("prune issues per-tenant DELETE with tenant_id = $1 AND time_column < cutoff", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (
          sql.startsWith("SELECT") &&
          sql.includes("FROM meta.tenant_retention_policies")
        ) {
          return {
            rows: [
              tenantPolicyRow(TENANT_A, "workflow_traces", { retention_days: 7 }),
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 5 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn, clock: () => 1_000_000_000_000 });
    const results = await r.prune();
    const tenantResult = results.find((x) => x.tenantId === TENANT_A);
    expect(tenantResult?.status).toBe("pruned");
    expect(tenantResult?.tableName).toBe("workflow_traces");
    expect(tenantResult?.deletedCount).toBe(5);

    const deleteCall = capture.find(
      (c) => c.sql.includes("DELETE FROM meta.workflow_traces") && c.sql.includes("tenant_id = $1"),
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.params?.[0]).toBe(TENANT_A);
  });

  it("platform-default DELETE excludes tenants with enabled per-tenant policies (NOT IN subquery)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
          return {
            rows: [policyRow("workflow_traces", { retention_days: 30 })],
            rowCount: 1,
          };
        }
        if (
          sql.startsWith("SELECT") &&
          sql.includes("FROM meta.tenant_retention_policies")
        ) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 5 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.prune();
    const platformDelete = capture.find(
      (c) => c.sql.startsWith("DELETE FROM meta.workflow_traces"),
    );
    expect(platformDelete?.sql).toContain(
      "tenant_id NOT IN",
    );
    expect(platformDelete?.sql).toContain("FROM meta.tenant_retention_policies");
    expect(platformDelete?.sql).toContain("enabled = true");
  });

  it("updates last_pruned_at on the tenant_retention_policies row after a successful per-tenant prune", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (
          sql.startsWith("SELECT") &&
          sql.includes("FROM meta.tenant_retention_policies")
        ) {
          return {
            rows: [tenantPolicyRow(TENANT_A, "workflow_traces")],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.prune();
    const updateCall = capture.find((c) =>
      c.sql.includes("UPDATE meta.tenant_retention_policies"),
    );
    expect(updateCall?.sql).toContain("SET last_pruned_at = now()");
    expect(updateCall?.sql).toContain(
      "WHERE tenant_id = $1 AND table_name = $2",
    );
    expect(updateCall?.params).toEqual([TENANT_A, "workflow_traces"]);
  });

  it("skips disabled tenant policies with status=skipped_disabled", async () => {
    const conn = mockConnection((sql) => {
      if (
        sql.startsWith("SELECT") &&
        sql.includes("FROM meta.tenant_retention_policies")
      ) {
        return {
          rows: [
            tenantPolicyRow(TENANT_A, "workflow_traces", { enabled: false }),
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const results = await r.prune();
    const tenantResult = results.find((x) => x.tenantId === TENANT_A);
    expect(tenantResult?.status).toBe("skipped_disabled");
    expect(tenantResult?.deletedCount).toBe(0);
  });

  it("skips tenant policies for tables without tenant_id (defensive — CHECK constraint catches first)", async () => {
    const conn = mockConnection((sql) => {
      if (
        sql.startsWith("SELECT") &&
        sql.includes("FROM meta.tenant_retention_policies")
      ) {
        // Hypothetical bad row that bypassed the CHECK constraint.
        return {
          rows: [tenantPolicyRow(TENANT_A, "llm_latency_samples")],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const results = await r.prune();
    const tenantResult = results.find((x) => x.tenantId === TENANT_A);
    expect(tenantResult?.status).toBe("skipped_unknown_table");
  });

  it("previewPrune reports per-tenant + platform-default counts independently", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.includes("COUNT(*)")) {
          // per-tenant COUNT returns 3; platform COUNT returns 7
          if (sql.includes("tenant_id = $1")) {
            return { rows: [{ count: "3" }], rowCount: 1 };
          }
          return { rows: [{ count: "7" }], rowCount: 1 };
        }
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
          return { rows: [policyRow("workflow_traces")], rowCount: 1 };
        }
        if (
          sql.startsWith("SELECT") &&
          sql.includes("FROM meta.tenant_retention_policies")
        ) {
          return {
            rows: [tenantPolicyRow(TENANT_A, "workflow_traces")],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const results = await r.previewPrune();
    const tenantResult = results.find((x) => x.tenantId === TENANT_A);
    const platformResult = results.find((x) => x.tenantId === undefined);
    expect(tenantResult?.wouldDeleteCount).toBe(3);
    expect(platformResult?.wouldDeleteCount).toBe(7);
    expect(platformResult?.tableName).toBe("workflow_traces");
  });

  it("multiple tenants on the same table each get their own prune result", async () => {
    const conn = mockConnection((sql) => {
      if (
        sql.startsWith("SELECT") &&
        sql.includes("FROM meta.tenant_retention_policies")
      ) {
        return {
          rows: [
            tenantPolicyRow(TENANT_A, "workflow_traces", { retention_days: 7 }),
            tenantPolicyRow(TENANT_B, "workflow_traces", { retention_days: 14 }),
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const results = await r.prune();
    const tenantA = results.find((x) => x.tenantId === TENANT_A);
    const tenantB = results.find((x) => x.tenantId === TENANT_B);
    expect(tenantA?.retentionDays).toBe(7);
    expect(tenantB?.retentionDays).toBe(14);
    expect(tenantA?.status).toBe("pruned");
    expect(tenantB?.status).toBe("pruned");
  });

  it("tablesWithTenantId exposes the prunable tables that can have per-tenant policies", () => {
    const tables = PostgresTraceRetention.tablesWithTenantId();
    expect(new Set(tables)).toEqual(
      new Set(["workflow_traces", "llm_call_traces"]),
    );
    expect(tables).not.toContain("llm_latency_samples");
  });
});
