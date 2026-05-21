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
      opt_out: boolean;
      opt_out_reason: string | null;
      opt_out_until: string | null;
      last_pruned_at: string | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      table_name: tableName,
      retention_days: 7,
      enabled: true,
      opt_out: false,
      opt_out_reason: null,
      opt_out_until: null,
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
      optOut: false,
      optOutReason: null,
      optOutUntil: null,
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

  it("prune skips opt-out tenants with status='skipped_opt_out' and issues NO DELETE for that tenant", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (
          sql.startsWith("SELECT") &&
          sql.includes("FROM meta.tenant_retention_policies")
        ) {
          return {
            rows: [
              tenantPolicyRow(TENANT_A, "workflow_traces", {
                enabled: false,
                opt_out: true,
              }),
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const results = await r.prune();
    const tenantResult = results.find((x) => x.tenantId === TENANT_A);
    expect(tenantResult?.status).toBe("skipped_opt_out");
    expect(tenantResult?.deletedCount).toBe(0);
    const tenantDelete = capture.find(
      (c) =>
        c.sql.startsWith("DELETE FROM meta.workflow_traces") &&
        c.sql.includes("tenant_id = $1"),
    );
    expect(tenantDelete).toBeUndefined();
  });

  it("opt-out tenant takes precedence over enabled — opt_out=true wins even when enabled looks active", async () => {
    const conn = mockConnection((sql) => {
      if (
        sql.startsWith("SELECT") &&
        sql.includes("FROM meta.tenant_retention_policies")
      ) {
        return {
          rows: [
            tenantPolicyRow(TENANT_A, "workflow_traces", {
              enabled: false,
              opt_out: true,
            }),
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const results = await r.prune();
    const tenantResult = results.find((x) => x.tenantId === TENANT_A);
    expect(tenantResult?.status).toBe("skipped_opt_out");
  });

  it("platform-default DELETE excludes opt-out tenants too via the NOT IN subquery", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (
          sql.startsWith("SELECT") &&
          sql.includes("FROM meta.retention_policies")
        ) {
          return {
            rows: [policyRow("workflow_traces")],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.prune();
    const platformDelete = capture.find((c) =>
      c.sql.startsWith("DELETE FROM meta.workflow_traces"),
    );
    expect(platformDelete?.sql).toContain("opt_out = true");
    expect(platformDelete?.sql).toContain("enabled = true");
    expect(platformDelete?.sql).toContain("opt_out_until IS NULL OR opt_out_until > now()");
  });

  it("previewPrune reports opt-out tenants with status='skipped_opt_out' wouldDeleteCount=0 and issues NO COUNT for that tenant", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (
          sql.startsWith("SELECT") &&
          sql.includes("FROM meta.tenant_retention_policies")
        ) {
          return {
            rows: [
              tenantPolicyRow(TENANT_A, "workflow_traces", {
                enabled: false,
                opt_out: true,
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("COUNT(*)")) {
          return { rows: [{ count: "999" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const results = await r.previewPrune();
    const tenantResult = results.find((x) => x.tenantId === TENANT_A);
    expect(tenantResult?.status).toBe("skipped_opt_out");
    expect(tenantResult?.wouldDeleteCount).toBe(0);
    const tenantCount = capture.find(
      (c) =>
        c.sql.includes("COUNT(*)") &&
        c.sql.includes("FROM meta.workflow_traces") &&
        c.sql.includes("tenant_id = $1"),
    );
    expect(tenantCount).toBeUndefined();
  });

  it("previewPrune platform-default COUNT excludes opt-out tenants via NOT IN subquery", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (
          sql.startsWith("SELECT") &&
          sql.includes("FROM meta.retention_policies")
        ) {
          return {
            rows: [policyRow("workflow_traces")],
            rowCount: 1,
          };
        }
        if (sql.includes("COUNT(*)")) {
          return { rows: [{ count: "0" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.previewPrune();
    const platformCount = capture.find(
      (c) =>
        c.sql.includes("COUNT(*)") &&
        c.sql.includes("FROM meta.workflow_traces"),
    );
    expect(platformCount?.sql).toContain("enabled = true");
    expect(platformCount?.sql).toContain("opt_out = true");
    expect(platformCount?.sql).toContain("opt_out_until IS NULL OR opt_out_until > now()");
  });

  it("disabled-and-not-opt-out tenant falls back to platform default (M6.7.zz.tenant baseline preserved)", async () => {
    const conn = mockConnection((sql) => {
      if (
        sql.startsWith("SELECT") &&
        sql.includes("FROM meta.tenant_retention_policies")
      ) {
        return {
          rows: [
            tenantPolicyRow(TENANT_A, "workflow_traces", {
              enabled: false,
              opt_out: false,
            }),
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
  });

  it("listTenantPolicies SELECT includes opt_out_reason column", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listTenantPolicies();
    expect(capture[0]?.sql).toContain("opt_out_reason");
  });

  it("listTenantPolicies maps opt_out_reason to optOutReason field", async () => {
    const conn = mockConnection(() => ({
      rows: [
        tenantPolicyRow(TENANT_A, "workflow_traces", {
          opt_out: true,
          enabled: false,
          opt_out_reason: "legal_hold:case#42",
        }),
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const policies = await r.listTenantPolicies();
    expect(policies[0]?.optOutReason).toBe("legal_hold:case#42");
  });

  it("prune threads optOutReason into the skipped_opt_out result", async () => {
    const conn = mockConnection((sql) => {
      if (
        sql.startsWith("SELECT") &&
        sql.includes("FROM meta.tenant_retention_policies")
      ) {
        return {
          rows: [
            tenantPolicyRow(TENANT_A, "workflow_traces", {
              opt_out: true,
              enabled: false,
              opt_out_reason: "21cfr11:trial-9",
            }),
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const results = await r.prune();
    const tenantResult = results.find((x) => x.tenantId === TENANT_A);
    expect(tenantResult?.status).toBe("skipped_opt_out");
    expect(tenantResult?.optOutReason).toBe("21cfr11:trial-9");
  });

  it("prune threads NULL optOutReason when opt-out has no reason set", async () => {
    const conn = mockConnection((sql) => {
      if (
        sql.startsWith("SELECT") &&
        sql.includes("FROM meta.tenant_retention_policies")
      ) {
        return {
          rows: [
            tenantPolicyRow(TENANT_A, "workflow_traces", {
              opt_out: true,
              enabled: false,
              opt_out_reason: null,
            }),
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const results = await r.prune();
    const tenantResult = results.find((x) => x.tenantId === TENANT_A);
    expect(tenantResult?.status).toBe("skipped_opt_out");
    expect(tenantResult?.optOutReason).toBeNull();
  });

  it("previewPrune threads optOutReason into the skipped_opt_out result", async () => {
    const conn = mockConnection((sql) => {
      if (
        sql.startsWith("SELECT") &&
        sql.includes("FROM meta.tenant_retention_policies")
      ) {
        return {
          rows: [
            tenantPolicyRow(TENANT_A, "workflow_traces", {
              opt_out: true,
              enabled: false,
              opt_out_reason: "vip_contract:tenant-xyz",
            }),
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const results = await r.previewPrune();
    const tenantResult = results.find((x) => x.tenantId === TENANT_A);
    expect(tenantResult?.status).toBe("skipped_opt_out");
    expect(tenantResult?.optOutReason).toBe("vip_contract:tenant-xyz");
  });

  describe("opt_out_until expiry semantics (M6.7.zz.tenant.opt-out.expiry)", () => {
    const NOW_MS = Date.parse("2026-05-20T12:00:00.000Z");
    const FUTURE_ISO = "2027-01-01T00:00:00.000Z";
    const PAST_ISO = "2025-01-01T00:00:00.000Z";

    it("opt_out with null opt_out_until is treated as indefinite (skipped_opt_out)", async () => {
      const conn = mockConnection((sql) => {
        if (
          sql.startsWith("SELECT") &&
          sql.includes("FROM meta.tenant_retention_policies")
        ) {
          return {
            rows: [
              tenantPolicyRow(TENANT_A, "workflow_traces", {
                opt_out: true,
                enabled: false,
                opt_out_until: null,
              }),
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });
      const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
      const results = await r.prune();
      const tenantResult = results.find((x) => x.tenantId === TENANT_A);
      expect(tenantResult?.status).toBe("skipped_opt_out");
    });

    it("opt_out with future opt_out_until is active (skipped_opt_out)", async () => {
      const conn = mockConnection((sql) => {
        if (
          sql.startsWith("SELECT") &&
          sql.includes("FROM meta.tenant_retention_policies")
        ) {
          return {
            rows: [
              tenantPolicyRow(TENANT_A, "workflow_traces", {
                opt_out: true,
                enabled: false,
                opt_out_until: FUTURE_ISO,
              }),
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });
      const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
      const results = await r.prune();
      const tenantResult = results.find((x) => x.tenantId === TENANT_A);
      expect(tenantResult?.status).toBe("skipped_opt_out");
      expect(tenantResult?.optOutUntil).toBe(FUTURE_ISO);
    });

    it("opt_out with past opt_out_until is expired (skipped_opt_out_expired) and issues NO DELETE for that tenant", async () => {
      const capture: Capture[] = [];
      const conn = mockConnection(
        (sql) => {
          if (
            sql.startsWith("SELECT") &&
            sql.includes("FROM meta.tenant_retention_policies")
          ) {
            return {
              rows: [
                tenantPolicyRow(TENANT_A, "workflow_traces", {
                  opt_out: true,
                  enabled: false,
                  opt_out_until: PAST_ISO,
                  opt_out_reason: "legal_hold:case#42",
                }),
              ],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        },
        capture,
      );
      const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
      const results = await r.prune();
      const tenantResult = results.find((x) => x.tenantId === TENANT_A);
      expect(tenantResult?.status).toBe("skipped_opt_out_expired");
      expect(tenantResult?.optOutUntil).toBe(PAST_ISO);
      expect(tenantResult?.optOutReason).toBe("legal_hold:case#42");
      const tenantDelete = capture.find(
        (c) =>
          c.sql.startsWith("DELETE FROM meta.workflow_traces") &&
          c.sql.includes("tenant_id = $1"),
      );
      expect(tenantDelete).toBeUndefined();
    });

    it("opt_out_until exactly at clock now is treated as expired (boundary case)", async () => {
      const NOW_ISO = "2026-05-20T12:00:00.000Z";
      const conn = mockConnection((sql) => {
        if (
          sql.startsWith("SELECT") &&
          sql.includes("FROM meta.tenant_retention_policies")
        ) {
          return {
            rows: [
              tenantPolicyRow(TENANT_A, "workflow_traces", {
                opt_out: true,
                enabled: false,
                opt_out_until: NOW_ISO,
              }),
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });
      const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
      const results = await r.prune();
      const tenantResult = results.find((x) => x.tenantId === TENANT_A);
      expect(tenantResult?.status).toBe("skipped_opt_out_expired");
    });

    it("previewPrune surfaces skipped_opt_out_expired for expired opt-outs", async () => {
      const conn = mockConnection((sql) => {
        if (
          sql.startsWith("SELECT") &&
          sql.includes("FROM meta.tenant_retention_policies")
        ) {
          return {
            rows: [
              tenantPolicyRow(TENANT_A, "workflow_traces", {
                opt_out: true,
                enabled: false,
                opt_out_until: PAST_ISO,
              }),
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });
      const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
      const results = await r.previewPrune();
      const tenantResult = results.find((x) => x.tenantId === TENANT_A);
      expect(tenantResult?.status).toBe("skipped_opt_out_expired");
      expect(tenantResult?.optOutUntil).toBe(PAST_ISO);
    });

    it("listTenantPolicies SELECT includes opt_out_until column", async () => {
      const capture: Capture[] = [];
      const conn = mockConnection(
        () => ({ rows: [], rowCount: 0 }),
        capture,
      );
      const r = new PostgresTraceRetention({ conn });
      await r.listTenantPolicies();
      expect(capture[0]?.sql).toContain("opt_out_until");
    });

    it("listTenantPolicies maps opt_out_until to optOutUntil field", async () => {
      const conn = mockConnection(() => ({
        rows: [
          tenantPolicyRow(TENANT_A, "workflow_traces", {
            opt_out: true,
            enabled: false,
            opt_out_until: FUTURE_ISO,
          }),
        ],
        rowCount: 1,
      }));
      const r = new PostgresTraceRetention({ conn });
      const policies = await r.listTenantPolicies();
      expect(policies[0]?.optOutUntil).toBe(FUTURE_ISO);
    });
  });
});

describe("PostgresTraceRetention.effectiveRetention (M6.7.zz.tenant.dashboard)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";

  function tenantPolicyRow(
    tenantId: string,
    tableName: string,
    overrides: Partial<{
      retention_days: number;
      enabled: boolean;
      opt_out: boolean;
      opt_out_reason: string | null;
      opt_out_until: string | null;
      last_pruned_at: string | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      table_name: tableName,
      retention_days: 7,
      enabled: true,
      opt_out: false,
      opt_out_reason: null,
      opt_out_until: null,
      last_pruned_at: null,
      ...overrides,
    };
  }

  it("returns source='tenant' when an enabled per-tenant policy exists", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            tenantPolicyRow(TENANT_A, "workflow_traces", {
              retention_days: 30,
            }),
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetention(TENANT_A, "workflow_traces");
    expect(result).toEqual({
      source: "tenant",
      retentionDays: 30,
      enabled: true,
      tenantId: TENANT_A,
    });
  });

  it("falls back to platform policy when per-tenant policy is disabled", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            tenantPolicyRow(TENANT_A, "workflow_traces", {
              enabled: false,
              retention_days: 30,
            }),
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [policyRow("workflow_traces", { retention_days: 90 })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetention(TENANT_A, "workflow_traces");
    expect(result).toEqual({
      source: "platform",
      retentionDays: 90,
      enabled: true,
    });
  });

  it("falls back to platform policy when no per-tenant policy exists", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [policyRow("workflow_traces", { retention_days: 90 })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetention(TENANT_A, "workflow_traces");
    expect(result).toEqual({
      source: "platform",
      retentionDays: 90,
      enabled: true,
    });
  });

  it("returns source='platform' with enabled=false when platform policy is disabled", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [
            policyRow("workflow_traces", {
              enabled: false,
              retention_days: 90,
            }),
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetention(TENANT_A, "workflow_traces");
    expect(result).toEqual({
      source: "platform",
      retentionDays: 90,
      enabled: false,
    });
  });

  it("returns source='none' when neither per-tenant nor platform policy exists", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetention(TENANT_A, "workflow_traces");
    expect(result).toEqual({
      source: "none",
      retentionDays: null,
      enabled: false,
    });
  });

  it("works for llm_latency_samples (no tenant override possible — always platform or none)", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [policyRow("llm_latency_samples", { retention_days: 30 })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetention(TENANT_A, "llm_latency_samples");
    expect(result).toEqual({
      source: "platform",
      retentionDays: 30,
      enabled: true,
    });
  });

  it("returns source='none' for unknown tables", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetention(TENANT_A, "unknown_table");
    expect(result).toEqual({
      source: "none",
      retentionDays: null,
      enabled: false,
    });
  });

  it("queries tenant_retention_policies with the (tenant_id, table_name) PK lookup", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.effectiveRetention(TENANT_A, "workflow_traces");
    const tenantCall = capture.find((c) =>
      c.sql.includes("FROM meta.tenant_retention_policies"),
    );
    expect(tenantCall?.params).toEqual([TENANT_A, "workflow_traces"]);
    expect(tenantCall?.sql).toContain("tenant_id = $1");
    expect(tenantCall?.sql).toContain("table_name = $2");
  });

  it("skips the platform query when an enabled per-tenant policy exists (single round-trip happy path)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.includes("FROM meta.tenant_retention_policies")) {
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
    await r.effectiveRetention(TENANT_A, "workflow_traces");
    const platformCall = capture.find(
      (c) =>
        c.sql.includes("FROM meta.retention_policies") &&
        !c.sql.includes("FROM meta.tenant_retention_policies"),
    );
    expect(platformCall).toBeUndefined();
  });

  it("issues both queries when per-tenant policy is disabled (two round-trips for the fallback)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.includes("FROM meta.tenant_retention_policies")) {
          return {
            rows: [tenantPolicyRow(TENANT_A, "workflow_traces", { enabled: false })],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.effectiveRetention(TENANT_A, "workflow_traces");
    const tenantCall = capture.find((c) =>
      c.sql.includes("FROM meta.tenant_retention_policies"),
    );
    const platformCall = capture.find(
      (c) =>
        c.sql.includes("FROM meta.retention_policies") &&
        !c.sql.includes("FROM meta.tenant_retention_policies"),
    );
    expect(tenantCall).toBeDefined();
    expect(platformCall).toBeDefined();
  });

  it("TypeScript discriminated union: source='tenant' narrows to include tenantId field", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [tenantPolicyRow(TENANT_A, "workflow_traces")],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetention(TENANT_A, "workflow_traces");
    if (result.source === "tenant") {
      const tenantId: string = result.tenantId;
      const retentionDays: number = result.retentionDays;
      const enabled: true = result.enabled;
      expect(tenantId).toBe(TENANT_A);
      expect(retentionDays).toBe(7);
      expect(enabled).toBe(true);
    } else {
      throw new Error("expected source='tenant'");
    }
  });

  it("returns source='tenant_opt_out' when per-tenant policy has opt_out=true", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            tenantPolicyRow(TENANT_A, "workflow_traces", {
              enabled: false,
              opt_out: true,
            }),
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetention(TENANT_A, "workflow_traces");
    expect(result).toEqual({
      source: "tenant_opt_out",
      retentionDays: null,
      enabled: false,
      tenantId: TENANT_A,
      optOutReason: null,
      optOutUntil: null,
    });
  });

  it("opt_out takes precedence over platform policy — no platform fallback when opt_out=true", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.includes("FROM meta.tenant_retention_policies")) {
          return {
            rows: [
              tenantPolicyRow(TENANT_A, "workflow_traces", {
                enabled: false,
                opt_out: true,
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM meta.retention_policies")) {
          return {
            rows: [policyRow("workflow_traces", { retention_days: 90 })],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetention(TENANT_A, "workflow_traces");
    expect(result.source).toBe("tenant_opt_out");
    const platformCall = capture.find(
      (c) =>
        c.sql.includes("FROM meta.retention_policies") &&
        !c.sql.includes("FROM meta.tenant_retention_policies"),
    );
    expect(platformCall).toBeUndefined();
  });

  it("TypeScript discriminated union: source='tenant_opt_out' narrows with null retentionDays + tenantId + enabled=false", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            tenantPolicyRow(TENANT_A, "workflow_traces", {
              enabled: false,
              opt_out: true,
            }),
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetention(TENANT_A, "workflow_traces");
    if (result.source === "tenant_opt_out") {
      const tenantId: string = result.tenantId;
      const retentionDays: null = result.retentionDays;
      const enabled: false = result.enabled;
      expect(tenantId).toBe(TENANT_A);
      expect(retentionDays).toBeNull();
      expect(enabled).toBe(false);
    } else {
      throw new Error("expected source='tenant_opt_out'");
    }
  });

  it("effectiveRetention threads optOutReason into the tenant_opt_out variant", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            tenantPolicyRow(TENANT_A, "workflow_traces", {
              enabled: false,
              opt_out: true,
              opt_out_reason: "legal_hold:case#42",
            }),
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetention(TENANT_A, "workflow_traces");
    if (result.source === "tenant_opt_out") {
      expect(result.optOutReason).toBe("legal_hold:case#42");
    } else {
      throw new Error("expected source='tenant_opt_out'");
    }
  });

  it("effectiveRetention returns null optOutReason when no reason set on opt-out row", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            tenantPolicyRow(TENANT_A, "workflow_traces", {
              enabled: false,
              opt_out: true,
              opt_out_reason: null,
            }),
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetention(TENANT_A, "workflow_traces");
    if (result.source === "tenant_opt_out") {
      expect(result.optOutReason).toBeNull();
    } else {
      throw new Error("expected source='tenant_opt_out'");
    }
  });

  it("effectiveRetention SELECT includes opt_out_reason column", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.effectiveRetention(TENANT_A, "workflow_traces");
    const tenantCall = capture.find((c) =>
      c.sql.includes("FROM meta.tenant_retention_policies"),
    );
    expect(tenantCall?.sql).toContain("opt_out_reason");
  });

  describe("opt_out_until expiry (M6.7.zz.tenant.opt-out.expiry)", () => {
    const NOW_MS = Date.parse("2026-05-20T12:00:00.000Z");
    const FUTURE_ISO = "2027-01-01T00:00:00.000Z";
    const PAST_ISO = "2025-01-01T00:00:00.000Z";

    it("active opt_out with future opt_out_until returns tenant_opt_out with optOutUntil", async () => {
      const conn = mockConnection((sql) => {
        if (sql.includes("FROM meta.tenant_retention_policies")) {
          return {
            rows: [
              tenantPolicyRow(TENANT_A, "workflow_traces", {
                opt_out: true,
                enabled: false,
                opt_out_until: FUTURE_ISO,
              }),
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });
      const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
      const result = await r.effectiveRetention(TENANT_A, "workflow_traces");
      if (result.source === "tenant_opt_out") {
        expect(result.optOutUntil).toBe(FUTURE_ISO);
      } else {
        throw new Error("expected source='tenant_opt_out'");
      }
    });

    it("expired opt_out falls through to platform when platform policy exists", async () => {
      const conn = mockConnection((sql) => {
        if (sql.includes("FROM meta.tenant_retention_policies")) {
          return {
            rows: [
              tenantPolicyRow(TENANT_A, "workflow_traces", {
                opt_out: true,
                enabled: false,
                opt_out_until: PAST_ISO,
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM meta.retention_policies")) {
          return {
            rows: [policyRow("workflow_traces", { retention_days: 90 })],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });
      const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
      const result = await r.effectiveRetention(TENANT_A, "workflow_traces");
      expect(result.source).toBe("platform");
      if (result.source === "platform") {
        expect(result.retentionDays).toBe(90);
      }
    });

    it("expired opt_out with no platform policy returns source='none'", async () => {
      const conn = mockConnection((sql) => {
        if (sql.includes("FROM meta.tenant_retention_policies")) {
          return {
            rows: [
              tenantPolicyRow(TENANT_A, "workflow_traces", {
                opt_out: true,
                enabled: false,
                opt_out_until: PAST_ISO,
              }),
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });
      const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
      const result = await r.effectiveRetention(TENANT_A, "workflow_traces");
      expect(result.source).toBe("none");
    });

    it("null opt_out_until is treated as indefinite (active)", async () => {
      const conn = mockConnection((sql) => {
        if (sql.includes("FROM meta.tenant_retention_policies")) {
          return {
            rows: [
              tenantPolicyRow(TENANT_A, "workflow_traces", {
                opt_out: true,
                enabled: false,
                opt_out_until: null,
              }),
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });
      const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
      const result = await r.effectiveRetention(TENANT_A, "workflow_traces");
      expect(result.source).toBe("tenant_opt_out");
      if (result.source === "tenant_opt_out") {
        expect(result.optOutUntil).toBeNull();
      }
    });

    it("clock injection drives expiry decision (same row resolves differently across clocks)", async () => {
      const handler = (sql: string) => {
        if (sql.includes("FROM meta.tenant_retention_policies")) {
          return {
            rows: [
              tenantPolicyRow(TENANT_A, "workflow_traces", {
                opt_out: true,
                enabled: false,
                opt_out_until: "2026-06-01T00:00:00.000Z",
              }),
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      };
      const beforeExpiry = Date.parse("2026-05-20T12:00:00.000Z");
      const afterExpiry = Date.parse("2026-07-01T12:00:00.000Z");
      const rBefore = new PostgresTraceRetention({
        conn: mockConnection(handler),
        clock: () => beforeExpiry,
      });
      const rAfter = new PostgresTraceRetention({
        conn: mockConnection(handler),
        clock: () => afterExpiry,
      });
      const resultBefore = await rBefore.effectiveRetention(
        TENANT_A,
        "workflow_traces",
      );
      const resultAfter = await rAfter.effectiveRetention(
        TENANT_A,
        "workflow_traces",
      );
      expect(resultBefore.source).toBe("tenant_opt_out");
      expect(resultAfter.source).toBe("none");
    });

    it("effectiveRetention SELECT includes opt_out_until column", async () => {
      const capture: Capture[] = [];
      const conn = mockConnection(
        () => ({ rows: [], rowCount: 0 }),
        capture,
      );
      const r = new PostgresTraceRetention({ conn });
      await r.effectiveRetention(TENANT_A, "workflow_traces");
      const tenantCall = capture.find((c) =>
        c.sql.includes("FROM meta.tenant_retention_policies"),
      );
      expect(tenantCall?.sql).toContain("opt_out_until");
    });
  });
});

describe("PostgresTraceRetention.expiringOptOuts (M6.7.zz.tenant.opt-out.alerts)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";
  const NOW_MS = Date.parse("2026-05-20T12:00:00.000Z");
  const isoPlusDays = (d: number) =>
    new Date(NOW_MS + d * 86_400 * 1_000).toISOString();

  function row(
    tenantId: string,
    tableName: string,
    optOutUntilIso: string,
    optOutReason: string | null = null,
  ): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      table_name: tableName,
      opt_out_until: optOutUntilIso,
      opt_out_reason: optOutReason,
    };
  }

  it("returns opt-outs whose opt_out_until is within the window (default includeExpired=false)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        row(TENANT_A, "workflow_traces", isoPlusDays(5), "legal_hold:case#42"),
        row(TENANT_B, "llm_call_traces", isoPlusDays(20)),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
    const results = await r.expiringOptOuts({ withinDays: 30 });
    expect(results).toHaveLength(2);
    expect(results[0]?.tenantId).toBe(TENANT_A);
    expect(results[0]?.optOutReason).toBe("legal_hold:case#42");
    expect(results[0]?.daysUntilExpiry).toBeCloseTo(5, 6);
    expect(results[1]?.daysUntilExpiry).toBeCloseTo(20, 6);
  });

  it("SQL excludes already-expired when includeExpired=false (default)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
    await r.expiringOptOuts({ withinDays: 30 });
    expect(capture[0]?.sql).toContain("opt_out_until > to_timestamp($2");
    expect(capture[0]?.sql).toContain("opt_out_until <= to_timestamp($1");
    expect(capture[0]?.params).toEqual([
      NOW_MS + 30 * 86_400 * 1_000,
      NOW_MS,
    ]);
  });

  it("SQL includes already-expired when includeExpired=true", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
    await r.expiringOptOuts({ withinDays: 30, includeExpired: true });
    expect(capture[0]?.sql).toContain("opt_out_until <= to_timestamp($1");
    expect(capture[0]?.sql).not.toContain("opt_out_until > to_timestamp($2");
    expect(capture[0]?.params).toEqual([NOW_MS + 30 * 86_400 * 1_000]);
  });

  it("daysUntilExpiry is negative for already-expired opt-outs (includeExpired=true)", async () => {
    const conn = mockConnection(() => ({
      rows: [row(TENANT_A, "workflow_traces", isoPlusDays(-10))],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
    const results = await r.expiringOptOuts({
      withinDays: 30,
      includeExpired: true,
    });
    expect(results[0]?.daysUntilExpiry).toBeCloseTo(-10, 6);
  });

  it("SQL filters opt_out = true and opt_out_until IS NOT NULL", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
    await r.expiringOptOuts({ withinDays: 30 });
    expect(capture[0]?.sql).toContain("opt_out = true");
    expect(capture[0]?.sql).toContain("opt_out_until IS NOT NULL");
  });

  it("SQL orders results by opt_out_until ASC (soonest first)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
    await r.expiringOptOuts({ withinDays: 30 });
    expect(capture[0]?.sql).toContain("ORDER BY opt_out_until ASC");
  });

  it("withinDays=0 + includeExpired=false returns empty window (nothing in the strict (now, now] range)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
    const results = await r.expiringOptOuts({ withinDays: 0 });
    expect(results).toEqual([]);
    expect(capture[0]?.params).toEqual([NOW_MS, NOW_MS]);
  });

  it("withinDays=0 + includeExpired=true returns all already-expired", async () => {
    const conn = mockConnection(() => ({
      rows: [
        row(TENANT_A, "workflow_traces", isoPlusDays(-30)),
        row(TENANT_B, "llm_call_traces", isoPlusDays(-1)),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
    const results = await r.expiringOptOuts({
      withinDays: 0,
      includeExpired: true,
    });
    expect(results).toHaveLength(2);
    expect(results[0]?.daysUntilExpiry).toBeCloseTo(-30, 6);
    expect(results[1]?.daysUntilExpiry).toBeCloseTo(-1, 6);
  });

  it("withinDays < 0 throws", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(r.expiringOptOuts({ withinDays: -1 })).rejects.toThrow(
      /withinDays/,
    );
  });

  it("withinDays = Infinity throws", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.expiringOptOuts({ withinDays: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(/withinDays/);
  });

  it("withinDays = NaN throws", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.expiringOptOuts({ withinDays: Number.NaN }),
    ).rejects.toThrow(/withinDays/);
  });

  it("empty result returns empty array", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
    const results = await r.expiringOptOuts({ withinDays: 30 });
    expect(results).toEqual([]);
  });

  it("threads optOutReason from row to result", async () => {
    const conn = mockConnection(() => ({
      rows: [
        row(TENANT_A, "workflow_traces", isoPlusDays(7), "vip_contract:xyz"),
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
    const results = await r.expiringOptOuts({ withinDays: 30 });
    expect(results[0]?.optOutReason).toBe("vip_contract:xyz");
  });

  it("threads null optOutReason when row has no reason", async () => {
    const conn = mockConnection(() => ({
      rows: [row(TENANT_A, "workflow_traces", isoPlusDays(7), null)],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
    const results = await r.expiringOptOuts({ withinDays: 30 });
    expect(results[0]?.optOutReason).toBeNull();
  });

  it("supports tiered alert windows (operator buckets by daysUntilExpiry)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        row(TENANT_A, "workflow_traces", isoPlusDays(0.5)),
        row(TENANT_B, "workflow_traces", isoPlusDays(5)),
        row(TENANT_A, "llm_call_traces", isoPlusDays(20)),
      ],
      rowCount: 3,
    }));
    const r = new PostgresTraceRetention({ conn, clock: () => NOW_MS });
    const results = await r.expiringOptOuts({ withinDays: 30 });
    const urgent = results.filter((x) => x.daysUntilExpiry < 1);
    const week = results.filter(
      (x) => x.daysUntilExpiry >= 1 && x.daysUntilExpiry < 7,
    );
    const month = results.filter(
      (x) => x.daysUntilExpiry >= 7 && x.daysUntilExpiry < 30,
    );
    expect(urgent).toHaveLength(1);
    expect(week).toHaveLength(1);
    expect(month).toHaveLength(1);
  });
});

describe("PostgresTraceRetention.setTenantOptOut (M6.7.zz.tenant.opt-out.cli.mutate)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";

  function returnedRow(
    overrides: Partial<{
      retention_days: number;
      enabled: boolean;
      opt_out: boolean;
      opt_out_reason: string | null;
      opt_out_until: string | null;
      last_pruned_at: string | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      tenant_id: TENANT_A,
      table_name: "workflow_traces",
      retention_days: 365,
      enabled: false,
      opt_out: true,
      opt_out_reason: null,
      opt_out_until: null,
      last_pruned_at: null,
      ...overrides,
    };
  }

  it("INSERTs with INSERT ... ON CONFLICT DO UPDATE and sets opt_out=true + enabled=false", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [returnedRow()], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).toContain(
      "INSERT INTO meta.tenant_retention_policies",
    );
    expect(capture[0]?.sql).toContain("ON CONFLICT (tenant_id, table_name)");
    expect(capture[0]?.sql).toContain("enabled = false");
    expect(capture[0]?.sql).toContain("opt_out = true");
  });

  it("threads retentionDays + optOutReason + optOutUntil into params", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [
          returnedRow({
            retention_days: 90,
            opt_out_reason: "legal_hold:case#42",
            opt_out_until: "2027-01-01T00:00:00.000Z",
          }),
        ],
        rowCount: 1,
      }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 90,
      optOutReason: "legal_hold:case#42",
      optOutUntil: "2027-01-01T00:00:00.000Z",
    });
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "workflow_traces",
      90,
      "legal_hold:case#42",
      "2027-01-01T00:00:00.000Z",
    ]);
  });

  it("defaults retentionDays to 365 when not provided", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [returnedRow()], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    expect(capture[0]?.params?.[2]).toBe(365);
  });

  it("defaults optOutReason + optOutUntil to NULL when not provided", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [returnedRow()], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    expect(capture[0]?.params?.[3]).toBeNull();
    expect(capture[0]?.params?.[4]).toBeNull();
  });

  it("returns the policy row mapped to camelCase", async () => {
    const conn = mockConnection(() => ({
      rows: [
        returnedRow({
          opt_out_reason: "legal_hold:case#42",
          opt_out_until: "2027-01-01T00:00:00.000Z",
        }),
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const policy = await r.setTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      optOutReason: "legal_hold:case#42",
      optOutUntil: "2027-01-01T00:00:00.000Z",
    });
    expect(policy.tenantId).toBe(TENANT_A);
    expect(policy.optOut).toBe(true);
    expect(policy.enabled).toBe(false);
    expect(policy.optOutReason).toBe("legal_hold:case#42");
    expect(policy.optOutUntil).toBe("2027-01-01T00:00:00.000Z");
  });

  it("ON CONFLICT DO UPDATE preserves retention_days (excluded from SET clause)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [returnedRow()], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    // The UPDATE clause should NOT touch retention_days
    const sql = capture[0]?.sql ?? "";
    const updateClause = sql.slice(sql.indexOf("DO UPDATE SET"));
    expect(updateClause).not.toContain("retention_days =");
  });

  it("ON CONFLICT DO UPDATE uses EXCLUDED.opt_out_reason + EXCLUDED.opt_out_until", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [returnedRow()], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).toContain("opt_out_reason = EXCLUDED.opt_out_reason");
    expect(capture[0]?.sql).toContain("opt_out_until = EXCLUDED.opt_out_until");
  });

  it("rejects retentionDays < 1", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.setTenantOptOut({
        tenantId: TENANT_A,
        tableName: "workflow_traces",
        retentionDays: 0,
      }),
    ).rejects.toThrow(/retentionDays/);
  });

  it("rejects non-integer retentionDays", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.setTenantOptOut({
        tenantId: TENANT_A,
        tableName: "workflow_traces",
        retentionDays: 1.5,
      }),
    ).rejects.toThrow(/retentionDays/);
  });

  it("throws when RETURNING yields no rows", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.setTenantOptOut({
        tenantId: TENANT_A,
        tableName: "workflow_traces",
      }),
    ).rejects.toThrow(/returned no rows/);
  });
});

describe("PostgresTraceRetention.clearTenantOptOut (M6.7.zz.tenant.opt-out.cli.mutate)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";

  function returnedRow(
    overrides: Partial<{
      retention_days: number;
      enabled: boolean;
      opt_out: boolean;
      opt_out_reason: string | null;
      opt_out_until: string | null;
      last_pruned_at: string | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      tenant_id: TENANT_A,
      table_name: "workflow_traces",
      retention_days: 365,
      enabled: false,
      opt_out: false,
      opt_out_reason: "legal_hold:case#42",
      opt_out_until: null,
      last_pruned_at: null,
      ...overrides,
    };
  }

  it("UPDATEs opt_out=false + opt_out_until=NULL via UPDATE statement", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [returnedRow()], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.clearTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).toContain("UPDATE meta.tenant_retention_policies");
    expect(capture[0]?.sql).toContain("opt_out = false");
    expect(capture[0]?.sql).toContain("opt_out_until = NULL");
  });

  it("preserves opt_out_reason on lift-off (per ADR-0161 historical context)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [returnedRow()], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.clearTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    // UPDATE clause should NOT touch opt_out_reason
    expect(capture[0]?.sql).not.toContain("opt_out_reason =");
  });

  it("returns the policy row mapped to camelCase when a row is updated", async () => {
    const conn = mockConnection(() => ({
      rows: [returnedRow({ opt_out_reason: "legal_hold:case#42" })],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const policy = await r.clearTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    expect(policy).not.toBeNull();
    expect(policy?.optOut).toBe(false);
    expect(policy?.optOutReason).toBe("legal_hold:case#42");
    expect(policy?.optOutUntil).toBeNull();
  });

  it("returns null when no matching opt-out row exists", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const policy = await r.clearTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    expect(policy).toBeNull();
  });

  it("WHERE clause filters opt_out = true (only opt-out rows are cleared)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.clearTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).toContain("opt_out = true");
  });

  it("threads tenantId + tableName as WHERE clause params", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.clearTenantOptOut({
      tenantId: TENANT_A,
      tableName: "llm_call_traces",
    });
    expect(capture[0]?.params).toEqual([TENANT_A, "llm_call_traces"]);
  });
});

describe("PostgresTraceRetention.setTenantRetention (M6.7.zz.tenant.retention-set)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";

  function returnedRow(
    overrides: Partial<{
      retention_days: number;
      enabled: boolean;
      opt_out: boolean;
      opt_out_reason: string | null;
      opt_out_until: string | null;
      last_pruned_at: string | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      tenant_id: TENANT_A,
      table_name: "workflow_traces",
      retention_days: 30,
      enabled: true,
      opt_out: false,
      opt_out_reason: null,
      opt_out_until: null,
      last_pruned_at: null,
      ...overrides,
    };
  }

  it("INSERTs with ON CONFLICT DO UPDATE setting opt_out=false", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [returnedRow()], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantRetention({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 30,
    });
    expect(capture[0]?.sql).toContain(
      "INSERT INTO meta.tenant_retention_policies",
    );
    expect(capture[0]?.sql).toContain("ON CONFLICT (tenant_id, table_name)");
    expect(capture[0]?.sql).toContain("opt_out = false");
  });

  it("threads retentionDays + enabled into params", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [returnedRow({ retention_days: 90, enabled: false })],
        rowCount: 1,
      }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantRetention({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 90,
      enabled: false,
    });
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "workflow_traces",
      90,
      false,
    ]);
  });

  it("defaults enabled to true when not provided", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [returnedRow()], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantRetention({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 30,
    });
    expect(capture[0]?.params?.[3]).toBe(true);
  });

  it("returns the policy row mapped to camelCase", async () => {
    const conn = mockConnection(() => ({
      rows: [returnedRow({ retention_days: 90 })],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const policy = await r.setTenantRetention({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 90,
    });
    expect(policy.tenantId).toBe(TENANT_A);
    expect(policy.retentionDays).toBe(90);
    expect(policy.enabled).toBe(true);
    expect(policy.optOut).toBe(false);
  });

  it("ON CONFLICT clears opt_out_until (to NULL) on UPDATE", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [returnedRow()], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantRetention({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 30,
    });
    const sql = capture[0]?.sql ?? "";
    const updateClause = sql.slice(sql.indexOf("DO UPDATE SET"));
    expect(updateClause).toContain("opt_out_until = NULL");
  });

  it("ON CONFLICT DO UPDATE PRESERVES opt_out_reason (omitted from SET clause)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [returnedRow()], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantRetention({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 30,
    });
    const sql = capture[0]?.sql ?? "";
    const updateClause = sql.slice(sql.indexOf("DO UPDATE SET"));
    expect(updateClause).not.toContain("opt_out_reason =");
  });

  it("ON CONFLICT updates retention_days + enabled to EXCLUDED.* values", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [returnedRow()], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantRetention({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 30,
    });
    expect(capture[0]?.sql).toContain(
      "retention_days = EXCLUDED.retention_days",
    );
    expect(capture[0]?.sql).toContain("enabled = EXCLUDED.enabled");
  });

  it("rejects retentionDays < 1", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.setTenantRetention({
        tenantId: TENANT_A,
        tableName: "workflow_traces",
        retentionDays: 0,
      }),
    ).rejects.toThrow(/retentionDays/);
  });

  it("rejects non-integer retentionDays", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.setTenantRetention({
        tenantId: TENANT_A,
        tableName: "workflow_traces",
        retentionDays: 1.5,
      }),
    ).rejects.toThrow(/retentionDays/);
  });

  it("throws when RETURNING yields no rows", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.setTenantRetention({
        tenantId: TENANT_A,
        tableName: "workflow_traces",
        retentionDays: 30,
      }),
    ).rejects.toThrow(/returned no rows/);
  });
});
