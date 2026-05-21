import { describe, expect, it, vi } from "vitest";

import type { PgConnection, PgQueryResult } from "./connection.js";
import {
  computeFieldDiffs,
  isOptOutHistoryEventKind,
  OPT_OUT_HISTORY_EVENT_KINDS,
  PostgresTraceRetention,
} from "./trace-retention.js";

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
  it("exposes the four trace tables the adapter knows how to prune", () => {
    const tables = PostgresTraceRetention.knownPrunableTables();
    expect(new Set(tables)).toEqual(
      new Set([
        "workflow_traces",
        "llm_latency_samples",
        "llm_call_traces",
        "tenant_retention_opt_out_history",
      ]),
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
    expect(allowed.length).toBe(4);
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
      new Set([
        "workflow_traces",
        "llm_call_traces",
        "tenant_retention_opt_out_history",
      ]),
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
      null,
      "{}",
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
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "llm_call_traces",
      null,
      "{}",
    ]);
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
      null,
      "{}",
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

describe("PostgresTraceRetention.deleteTenantPolicy (M6.7.zz.tenant.retention-delete)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";

  it("issues DELETE WHERE tenant_id = $1 AND table_name = $2", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.deleteTenantPolicy({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).toContain(
      "DELETE FROM meta.tenant_retention_policies",
    );
    expect(capture[0]?.sql).toContain("tenant_id = $1");
    expect(capture[0]?.sql).toContain("table_name = $2");
  });

  it("threads tenantId + tableName + actorId + attributes as params", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [{ deleted: "1" }], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.deleteTenantPolicy({
      tenantId: TENANT_A,
      tableName: "llm_call_traces",
    });
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "llm_call_traces",
      null,
      "{}",
    ]);
  });

  it("returns true when a row was deleted (count > 0)", async () => {
    const conn = mockConnection(() => ({
      rows: [{ deleted: "1" }],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const deleted = await r.deleteTenantPolicy({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    expect(deleted).toBe(true);
  });

  it("returns false when no row matched (count === 0)", async () => {
    const conn = mockConnection(() => ({
      rows: [{ deleted: "0" }],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const deleted = await r.deleteTenantPolicy({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    expect(deleted).toBe(false);
  });

  it("does NOT filter on opt_out column in the DELETE WHERE clause", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [{ deleted: "1" }], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.deleteTenantPolicy({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    const sql = capture[0]?.sql ?? "";
    // Extract the DELETE statement only (history INSERT references opt_out_* columns by name)
    const delMatch = sql.match(/DELETE FROM [^)]+RETURNING/s);
    expect(delMatch).not.toBeNull();
    // The DELETE FROM ... WHERE ... clause should NOT include opt_out as a predicate
    expect(delMatch?.[0]).not.toMatch(/WHERE[^)]*opt_out\s*=/);
  });
});

describe("PostgresTraceRetention history-write CTE (M6.7.zz.tenant.opt-out.history)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const ACTOR = "11111111-1111-4111-8111-111111111111";

  it("setTenantOptOut SQL writes a history row with event_kind='opt_out_set'", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [
          {
            tenant_id: TENANT_A,
            table_name: "workflow_traces",
            retention_days: 365,
            enabled: false,
            opt_out: true,
            opt_out_reason: null,
            opt_out_until: null,
            last_pruned_at: null,
          },
        ],
        rowCount: 1,
      }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    const sql = capture[0]?.sql ?? "";
    expect(sql).toContain(
      "INSERT INTO meta.tenant_retention_opt_out_history",
    );
    expect(sql).toContain("'opt_out_set'");
  });

  it("clearTenantOptOut SQL writes a history row with event_kind='opt_out_cleared'", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [
          {
            tenant_id: TENANT_A,
            table_name: "workflow_traces",
            retention_days: 365,
            enabled: false,
            opt_out: false,
            opt_out_reason: "legal_hold:case#42",
            opt_out_until: null,
            last_pruned_at: null,
          },
        ],
        rowCount: 1,
      }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.clearTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    const sql = capture[0]?.sql ?? "";
    expect(sql).toContain(
      "INSERT INTO meta.tenant_retention_opt_out_history",
    );
    expect(sql).toContain("'opt_out_cleared'");
  });

  it("setTenantRetention SQL writes a history row with event_kind='retention_set'", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [
          {
            tenant_id: TENANT_A,
            table_name: "workflow_traces",
            retention_days: 30,
            enabled: true,
            opt_out: false,
            opt_out_reason: null,
            opt_out_until: null,
            last_pruned_at: null,
          },
        ],
        rowCount: 1,
      }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantRetention({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 30,
    });
    const sql = capture[0]?.sql ?? "";
    expect(sql).toContain(
      "INSERT INTO meta.tenant_retention_opt_out_history",
    );
    expect(sql).toContain("'retention_set'");
  });

  it("deleteTenantPolicy SQL writes a history row with event_kind='policy_deleted'", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [{ deleted: "1" }], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.deleteTenantPolicy({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    const sql = capture[0]?.sql ?? "";
    expect(sql).toContain(
      "INSERT INTO meta.tenant_retention_opt_out_history",
    );
    expect(sql).toContain("'policy_deleted'");
  });

  it("setTenantOptOut threads actorId param into history insert", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [
          {
            tenant_id: TENANT_A,
            table_name: "workflow_traces",
            retention_days: 365,
            enabled: false,
            opt_out: true,
            opt_out_reason: null,
            opt_out_until: null,
            last_pruned_at: null,
          },
        ],
        rowCount: 1,
      }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      actorId: ACTOR,
    });
    expect(capture[0]?.params?.[5]).toBe(ACTOR);
  });

  it("threads attributes JSONB through every mutation", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [
          {
            tenant_id: TENANT_A,
            table_name: "workflow_traces",
            retention_days: 365,
            enabled: false,
            opt_out: true,
            opt_out_reason: null,
            opt_out_until: null,
            last_pruned_at: null,
          },
        ],
        rowCount: 1,
      }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      attributes: { source: "cli", correlationId: "req_abc" },
    });
    const last = capture[0]?.params?.[6];
    expect(last).toBe(
      JSON.stringify({ source: "cli", correlationId: "req_abc" }),
    );
  });

  it("setTenantOptOut captures prev_state via existing CTE", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [
          {
            tenant_id: TENANT_A,
            table_name: "workflow_traces",
            retention_days: 365,
            enabled: false,
            opt_out: true,
            opt_out_reason: null,
            opt_out_until: null,
            last_pruned_at: null,
          },
        ],
        rowCount: 1,
      }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.setTenantOptOut({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    const sql = capture[0]?.sql ?? "";
    expect(sql).toContain("WITH existing AS");
    expect(sql).toContain("SELECT to_jsonb(e.*) FROM existing e");
  });

  it("deleteTenantPolicy captures prev_state from RETURNING d.*", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [{ deleted: "1" }], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.deleteTenantPolicy({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    const sql = capture[0]?.sql ?? "";
    expect(sql).toContain("to_jsonb(d.*)");
  });
});

describe("PostgresTraceRetention.listOptOutHistory (M6.7.zz.tenant.opt-out.history)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";

  function historyRow(
    overrides: Partial<{
      id: string;
      tenant_id: string;
      table_name: string;
      event_kind: string;
      actor_id: string | null;
      occurred_at: string;
      prev_state: Record<string, unknown> | null;
      next_state: Record<string, unknown> | null;
      attributes: Record<string, unknown>;
    }> = {},
  ): Record<string, unknown> {
    return {
      id: "10000000-0000-4000-8000-000000000001",
      tenant_id: TENANT_A,
      table_name: "workflow_traces",
      event_kind: "opt_out_set",
      actor_id: null,
      occurred_at: "2026-05-20T12:00:00.000Z",
      prev_state: null,
      next_state: { opt_out: true, retention_days: 365 },
      attributes: {},
      ...overrides,
    };
  }

  it("returns history entries with no filters applied", async () => {
    const conn = mockConnection(() => ({
      rows: [historyRow()],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const entries = await r.listOptOutHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tenantId).toBe(TENANT_A);
    expect(entries[0]?.eventKind).toBe("opt_out_set");
  });

  it("maps snake_case row fields to camelCase entries", async () => {
    const conn = mockConnection(() => ({
      rows: [
        historyRow({
          event_kind: "policy_deleted",
          actor_id: "actor-uuid",
          prev_state: { opt_out: true },
          next_state: null,
          attributes: { source: "cli" },
        }),
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const entries = await r.listOptOutHistory();
    expect(entries[0]).toEqual({
      id: "10000000-0000-4000-8000-000000000001",
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      eventKind: "policy_deleted",
      actorId: "actor-uuid",
      occurredAt: "2026-05-20T12:00:00.000Z",
      prevState: { opt_out: true },
      nextState: null,
      attributes: { source: "cli" },
    });
  });

  it("filters by tenantId when provided", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ tenantId: TENANT_A });
    expect(capture[0]?.sql).toContain("tenant_id = $1");
    expect(capture[0]?.params?.[0]).toBe(TENANT_A);
  });

  it("filters by tableName when provided", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ tableName: "workflow_traces" });
    expect(capture[0]?.sql).toContain("table_name = $1");
    expect(capture[0]?.params?.[0]).toBe("workflow_traces");
  });

  it("filters by eventKind when provided", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ eventKind: "opt_out_set" });
    expect(capture[0]?.sql).toContain("event_kind = $1");
    expect(capture[0]?.params?.[0]).toBe("opt_out_set");
  });

  it("filters by since + until time range when provided", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      since: "2026-05-01T00:00:00.000Z",
      until: "2026-05-31T23:59:59.000Z",
    });
    expect(capture[0]?.sql).toContain("occurred_at >= $1");
    expect(capture[0]?.sql).toContain("occurred_at <= $2");
  });

  it("ORDER BY occurred_at DESC + LIMIT applied", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ limit: 50 });
    const sql = capture[0]?.sql ?? "";
    expect(sql).toContain("ORDER BY occurred_at DESC");
    expect(sql).toContain("LIMIT $1");
    expect(capture[0]?.params).toEqual([50]);
  });

  it("default limit is 100 when not provided", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory();
    expect(capture[0]?.params).toEqual([100]);
  });

  it("rejects limit < 1", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(r.listOptOutHistory({ limit: 0 })).rejects.toThrow(/limit/);
  });

  it("rejects non-integer limit", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(r.listOptOutHistory({ limit: 1.5 })).rejects.toThrow(/limit/);
  });

  it("throws on unknown event_kind in row", async () => {
    const conn = mockConnection(() => ({
      rows: [historyRow({ event_kind: "weird_kind" })],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(r.listOptOutHistory()).rejects.toThrow(/event_kind/);
  });
});

describe("OPT_OUT_HISTORY_EVENT_KINDS", () => {
  it("exposes the 4 documented event kinds", () => {
    expect(new Set(OPT_OUT_HISTORY_EVENT_KINDS)).toEqual(
      new Set(["opt_out_set", "opt_out_cleared", "retention_set", "policy_deleted"]),
    );
  });

  it("isOptOutHistoryEventKind narrows correctly", () => {
    expect(isOptOutHistoryEventKind("opt_out_set")).toBe(true);
    expect(isOptOutHistoryEventKind("retention_set")).toBe(true);
    expect(isOptOutHistoryEventKind("bogus")).toBe(false);
    expect(isOptOutHistoryEventKind(42)).toBe(false);
    expect(isOptOutHistoryEventKind(undefined)).toBe(false);
  });
});

describe("PostgresTraceRetention.restoreTenantPolicy (M6.7.zz.tenant.opt-out.cli.restore)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const HISTORY_ID = "30000000-0000-4000-8000-000000000003";

  function historyRow(
    overrides: Partial<{
      tenant_id: string;
      table_name: string;
      prev_state: Record<string, unknown> | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      tenant_id: TENANT_A,
      table_name: "workflow_traces",
      prev_state: null,
      ...overrides,
    };
  }

  function mutationReturnedRow(
    overrides: Partial<{
      retention_days: number;
      enabled: boolean;
      opt_out: boolean;
      opt_out_reason: string | null;
      opt_out_until: string | null;
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

  it("throws when history id is not found", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.restoreTenantPolicy({ historyId: HISTORY_ID }),
    ).rejects.toThrow(/not found/);
  });

  it("looks up source history row by id (first query)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.includes("FROM meta.tenant_retention_opt_out_history")) {
          return { rows: [historyRow()], rowCount: 1 };
        }
        return { rows: [{ deleted: "0" }], rowCount: 1 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.restoreTenantPolicy({ historyId: HISTORY_ID });
    expect(capture[0]?.sql).toContain(
      "FROM meta.tenant_retention_opt_out_history",
    );
    expect(capture[0]?.sql).toContain("WHERE id = $1");
    expect(capture[0]?.params).toEqual([HISTORY_ID]);
  });

  it("prev_state=null restores via DELETE (kind='deleted')", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.includes("FROM meta.tenant_retention_opt_out_history")) {
          return { rows: [historyRow({ prev_state: null })], rowCount: 1 };
        }
        return { rows: [{ deleted: "1" }], rowCount: 1 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const result = await r.restoreTenantPolicy({ historyId: HISTORY_ID });
    expect(result).toEqual({
      kind: "deleted",
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
    // Second query should be the DELETE-with-history CTE
    expect(capture[1]?.sql).toContain(
      "DELETE FROM meta.tenant_retention_policies",
    );
    expect(capture[1]?.sql).toContain("'policy_deleted'");
  });

  it("prev_state with opt_out=true restores via setTenantOptOut", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.includes("FROM meta.tenant_retention_opt_out_history")) {
          return {
            rows: [
              historyRow({
                prev_state: {
                  retention_days: 90,
                  enabled: false,
                  opt_out: true,
                  opt_out_reason: "legal_hold:case#42",
                  opt_out_until: "2027-01-01T00:00:00.000Z",
                },
              }),
            ],
            rowCount: 1,
          };
        }
        return {
          rows: [
            mutationReturnedRow({
              retention_days: 90,
              enabled: false,
              opt_out: true,
              opt_out_reason: "legal_hold:case#42",
              opt_out_until: "2027-01-01T00:00:00.000Z",
            }),
          ],
          rowCount: 1,
        };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const result = await r.restoreTenantPolicy({ historyId: HISTORY_ID });
    expect(result.kind).toBe("restored");
    if (result.kind === "restored") {
      expect(result.policy.optOut).toBe(true);
      expect(result.policy.optOutReason).toBe("legal_hold:case#42");
    }
    // Second query should emit opt_out_set event
    expect(capture[1]?.sql).toContain("'opt_out_set'");
  });

  it("prev_state with opt_out=false restores via setTenantRetention", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.includes("FROM meta.tenant_retention_opt_out_history")) {
          return {
            rows: [
              historyRow({
                prev_state: {
                  retention_days: 30,
                  enabled: true,
                  opt_out: false,
                  opt_out_reason: null,
                  opt_out_until: null,
                },
              }),
            ],
            rowCount: 1,
          };
        }
        return {
          rows: [
            mutationReturnedRow({ retention_days: 30, enabled: true }),
          ],
          rowCount: 1,
        };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const result = await r.restoreTenantPolicy({ historyId: HISTORY_ID });
    expect(result.kind).toBe("restored");
    if (result.kind === "restored") {
      expect(result.policy.retentionDays).toBe(30);
      expect(result.policy.enabled).toBe(true);
      expect(result.policy.optOut).toBe(false);
    }
    expect(capture[1]?.sql).toContain("'retention_set'");
  });

  it("adds 'restored_from' to attributes for downstream audit", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.includes("FROM meta.tenant_retention_opt_out_history")) {
          return {
            rows: [
              historyRow({
                prev_state: { retention_days: 30, enabled: true, opt_out: false },
              }),
            ],
            rowCount: 1,
          };
        }
        return { rows: [mutationReturnedRow()], rowCount: 1 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.restoreTenantPolicy({ historyId: HISTORY_ID });
    const attributesParam = capture[1]?.params?.[5];
    expect(attributesParam).toBe(JSON.stringify({ restored_from: HISTORY_ID }));
  });

  it("merges caller-provided attributes with restored_from", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.includes("FROM meta.tenant_retention_opt_out_history")) {
          return {
            rows: [
              historyRow({
                prev_state: { retention_days: 30, enabled: true, opt_out: false },
              }),
            ],
            rowCount: 1,
          };
        }
        return { rows: [mutationReturnedRow()], rowCount: 1 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.restoreTenantPolicy({
      historyId: HISTORY_ID,
      attributes: { source: "cli", correlationId: "req_abc" },
    });
    const attrs = JSON.parse(capture[1]?.params?.[5] as string);
    expect(attrs).toEqual({
      source: "cli",
      correlationId: "req_abc",
      restored_from: HISTORY_ID,
    });
  });

  it("threads actorId to the underlying mutation method", async () => {
    const ACTOR = "11111111-1111-4111-8111-111111111111";
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.includes("FROM meta.tenant_retention_opt_out_history")) {
          return {
            rows: [
              historyRow({
                prev_state: { retention_days: 30, enabled: true, opt_out: false },
              }),
            ],
            rowCount: 1,
          };
        }
        return { rows: [mutationReturnedRow()], rowCount: 1 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.restoreTenantPolicy({ historyId: HISTORY_ID, actorId: ACTOR });
    expect(capture[1]?.params?.[4]).toBe(ACTOR);
  });

  it("throws when prev_state is missing retention_days", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_opt_out_history")) {
        return {
          rows: [
            historyRow({
              prev_state: { enabled: true, opt_out: false },
            }),
          ],
          rowCount: 1,
        };
      }
      return { rows: [mutationReturnedRow()], rowCount: 1 };
    });
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.restoreTenantPolicy({ historyId: HISTORY_ID }),
    ).rejects.toThrow(/retention_days/);
  });

  it("kind='deleted' result carries tenantId + tableName from source history row", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_opt_out_history")) {
        return {
          rows: [
            historyRow({
              tenant_id: TENANT_A,
              table_name: "llm_call_traces",
              prev_state: null,
            }),
          ],
          rowCount: 1,
        };
      }
      return { rows: [{ deleted: "0" }], rowCount: 1 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.restoreTenantPolicy({ historyId: HISTORY_ID });
    expect(result).toEqual({
      kind: "deleted",
      tenantId: TENANT_A,
      tableName: "llm_call_traces",
    });
  });
});

describe("PostgresTraceRetention history-table retention (M6.7.zz.tenant.opt-out.history-retention)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";

  it("prune issues DELETE against meta.tenant_retention_opt_out_history using occurred_at column", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
          return {
            rows: [
              {
                table_name: "tenant_retention_opt_out_history",
                retention_days: 90,
                enabled: true,
                last_pruned_at: null,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn, clock: () => 1_700_000_000_000 });
    await r.prune();
    const delCall = capture.find((c) =>
      c.sql.startsWith("DELETE FROM meta.tenant_retention_opt_out_history"),
    );
    expect(delCall?.sql).toContain("occurred_at < to_timestamp");
  });

  it("platform-default DELETE on history table uses tenant_id NOT IN subquery (hasTenantId=true)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
          return {
            rows: [
              {
                table_name: "tenant_retention_opt_out_history",
                retention_days: 30,
                enabled: true,
                last_pruned_at: null,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.prune();
    const delCall = capture.find((c) =>
      c.sql.startsWith("DELETE FROM meta.tenant_retention_opt_out_history"),
    );
    expect(delCall?.sql).toContain("tenant_id NOT IN");
  });

  it("per-tenant retention applies to history table (hasTenantId=true)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (
          sql.startsWith("SELECT") &&
          sql.includes("FROM meta.tenant_retention_policies")
        ) {
          return {
            rows: [
              {
                tenant_id: TENANT_A,
                table_name: "tenant_retention_opt_out_history",
                retention_days: 365,
                enabled: true,
                opt_out: false,
                opt_out_reason: null,
                opt_out_until: null,
                last_pruned_at: null,
              },
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
    const tenantResult = results.find(
      (x) =>
        x.tenantId === TENANT_A &&
        x.tableName === "tenant_retention_opt_out_history",
    );
    expect(tenantResult?.status).toBe("pruned");
    const tenantDelete = capture.find(
      (c) =>
        c.sql.startsWith(
          "DELETE FROM meta.tenant_retention_opt_out_history",
        ) && c.sql.includes("tenant_id = $1"),
    );
    expect(tenantDelete).toBeDefined();
    expect(tenantDelete?.params?.[0]).toBe(TENANT_A);
  });

  it("effectiveRetention resolves for the history table when platform policy is set", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [
            {
              table_name: "tenant_retention_opt_out_history",
              retention_days: 365,
              enabled: true,
              last_pruned_at: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetention(
      TENANT_A,
      "tenant_retention_opt_out_history",
    );
    expect(result.source).toBe("platform");
    if (result.source === "platform") {
      expect(result.retentionDays).toBe(365);
    }
  });

  it("previewPrune renders count for history table", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      (sql) => {
        if (sql.startsWith("SELECT") && sql.includes("FROM meta.retention_policies")) {
          return {
            rows: [
              {
                table_name: "tenant_retention_opt_out_history",
                retention_days: 30,
                enabled: true,
                last_pruned_at: null,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("COUNT(*)") && sql.includes("tenant_retention_opt_out_history")) {
          return { rows: [{ count: "42" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const results = await r.previewPrune();
    const result = results.find(
      (x) => x.tableName === "tenant_retention_opt_out_history",
    );
    expect(result?.status).toBe("previewed");
    expect(result?.wouldDeleteCount).toBe(42);
  });
});

describe("PostgresTraceRetention.diffHistoryEntries (M6.7.zz.tenant.opt-out.cli.diff-history)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";
  const ID_A = "40000000-0000-4000-8000-000000000001";
  const ID_B = "40000000-0000-4000-8000-000000000002";

  function historyRow(
    overrides: Partial<{
      id: string;
      tenant_id: string;
      table_name: string;
      event_kind: string;
      occurred_at: string;
      next_state: Record<string, unknown> | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      id: ID_A,
      tenant_id: TENANT_A,
      table_name: "workflow_traces",
      event_kind: "opt_out_set",
      occurred_at: "2026-05-20T12:00:00.000Z",
      next_state: { opt_out: true, retention_days: 365 },
      ...overrides,
    };
  }

  it("throws when neither id exists", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({ idA: ID_A, idB: ID_B }),
    ).rejects.toThrow(/not found.*40000000-0000-4000-8000-000000000001.*40000000-0000-4000-8000-000000000002/);
  });

  it("throws when only one id is missing", async () => {
    const conn = mockConnection(() => ({
      rows: [historyRow({ id: ID_A })],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({ idA: ID_A, idB: ID_B }),
    ).rejects.toThrow(/not found.*40000000-0000-4000-8000-000000000002/);
  });

  it("throws when events on different tenants", async () => {
    const conn = mockConnection(() => ({
      rows: [
        historyRow({ id: ID_A, tenant_id: TENANT_A }),
        historyRow({ id: ID_B, tenant_id: TENANT_B }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({ idA: ID_A, idB: ID_B }),
    ).rejects.toThrow(/different tenants/);
  });

  it("throws when events on different tables", async () => {
    const conn = mockConnection(() => ({
      rows: [
        historyRow({ id: ID_A, table_name: "workflow_traces" }),
        historyRow({ id: ID_B, table_name: "llm_call_traces" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({ idA: ID_A, idB: ID_B }),
    ).rejects.toThrow(/different tables/);
  });

  it("throws when event_kind is unknown", async () => {
    const conn = mockConnection(() => ({
      rows: [
        historyRow({ id: ID_A, event_kind: "bogus_kind" }),
        historyRow({ id: ID_B }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({ idA: ID_A, idB: ID_B }),
    ).rejects.toThrow(/unknown event_kind/);
  });

  it("returns metadata + fieldDiffs for two events on the same (tenant, table)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        historyRow({
          id: ID_A,
          event_kind: "opt_out_set",
          occurred_at: "2026-05-20T12:00:00.000Z",
          next_state: {
            opt_out: true,
            retention_days: 365,
            enabled: false,
          },
        }),
        historyRow({
          id: ID_B,
          event_kind: "retention_set",
          occurred_at: "2026-05-21T12:00:00.000Z",
          next_state: {
            opt_out: false,
            retention_days: 30,
            enabled: true,
          },
        }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({ idA: ID_A, idB: ID_B });
    expect(result.idA).toBe(ID_A);
    expect(result.idB).toBe(ID_B);
    expect(result.tenantId).toBe(TENANT_A);
    expect(result.tableName).toBe("workflow_traces");
    expect(result.eventKindA).toBe("opt_out_set");
    expect(result.eventKindB).toBe("retention_set");
    expect(result.fieldDiffs).toEqual([
      { field: "enabled", valueA: false, valueB: true },
      { field: "opt_out", valueA: true, valueB: false },
      { field: "retention_days", valueA: 365, valueB: 30 },
    ]);
  });

  it("DELETE event (next_state=null) shows full diff as 'absent' on that side", async () => {
    const conn = mockConnection(() => ({
      rows: [
        historyRow({
          id: ID_A,
          event_kind: "policy_deleted",
          next_state: null,
        }),
        historyRow({
          id: ID_B,
          event_kind: "opt_out_set",
          next_state: {
            opt_out: true,
            retention_days: 365,
          },
        }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({ idA: ID_A, idB: ID_B });
    expect(result.fieldDiffs).toEqual([
      { field: "opt_out", valueA: undefined, valueB: true },
      { field: "retention_days", valueA: undefined, valueB: 365 },
    ]);
  });

  it("returns empty fieldDiffs when both next_state are equal", async () => {
    const sameState = { opt_out: true, retention_days: 90 };
    const conn = mockConnection(() => ({
      rows: [
        historyRow({ id: ID_A, next_state: sameState }),
        historyRow({ id: ID_B, next_state: sameState }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({ idA: ID_A, idB: ID_B });
    expect(result.fieldDiffs).toEqual([]);
  });

  it("returns empty fieldDiffs when both next_state are null (both DELETE)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        historyRow({ id: ID_A, event_kind: "policy_deleted", next_state: null }),
        historyRow({ id: ID_B, event_kind: "policy_deleted", next_state: null }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({ idA: ID_A, idB: ID_B });
    expect(result.fieldDiffs).toEqual([]);
  });

  it("SELECT shape uses WHERE id IN ($1, $2) with both ids as params", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [historyRow({ id: ID_A }), historyRow({ id: ID_B })],
        rowCount: 2,
      }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryEntries({ idA: ID_A, idB: ID_B });
    expect(capture[0]?.sql).toContain(
      "FROM meta.tenant_retention_opt_out_history",
    );
    expect(capture[0]?.sql).toContain("WHERE id IN ($1, $2)");
    expect(capture[0]?.params).toEqual([ID_A, ID_B]);
  });
});

describe("PostgresTraceRetention.listOptOutHistory cursor pagination (M6.7.zz.tenant.opt-out.cli.history.cursor)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const AFTER_ID = "50000000-0000-4000-8000-000000000005";

  it("--after-id threads as $N param into compound cursor subquery", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ afterId: AFTER_ID });
    expect(capture[0]?.sql).toContain("(occurred_at, id) <");
    expect(capture[0]?.sql).toContain("SELECT occurred_at FROM meta.tenant_retention_opt_out_history WHERE id = $1");
    expect(capture[0]?.params).toEqual([AFTER_ID, 100]);
  });

  it("compound cursor handles ties via id DESC tiebreaker in ORDER BY", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({});
    expect(capture[0]?.sql).toContain("ORDER BY occurred_at DESC, id DESC");
  });

  it("combines --after-id with other filters via WHERE AND", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      tenantId: TENANT_A,
      afterId: AFTER_ID,
    });
    expect(capture[0]?.sql).toContain("tenant_id = $1");
    expect(capture[0]?.sql).toContain("(occurred_at, id) <");
    expect(capture[0]?.params).toEqual([TENANT_A, AFTER_ID, 100]);
  });

  it("returns empty when cursor row does not exist (subquery returns NULL)", async () => {
    // In production, the subquery (SELECT occurred_at FROM ... WHERE id = $1)
    // returns NULL when the cursor row doesn't exist. The outer comparison
    // (occurred_at, id) < (NULL, $1) is NULL → row filtered out → empty result.
    // We just verify the SQL shape; PG behavior is what enforces the empty.
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.listOptOutHistory({ afterId: AFTER_ID });
    expect(result).toEqual([]);
  });

  it("compound cursor uses the same $N param for both occurred_at lookup and tiebreaker", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ afterId: AFTER_ID });
    const sql = capture[0]?.sql ?? "";
    // Both references to the cursor id should use $1 (the only param besides limit at $2)
    const matches = sql.match(/\$1/g);
    expect(matches?.length).toBe(2);
  });

  it("combines --after-id + tenantId + eventKind + since + until + limit correctly", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      eventKind: "opt_out_set",
      since: "2026-05-01T00:00:00.000Z",
      until: "2026-05-31T23:59:59.000Z",
      afterId: AFTER_ID,
      limit: 50,
    });
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "workflow_traces",
      "opt_out_set",
      "2026-05-01T00:00:00.000Z",
      "2026-05-31T23:59:59.000Z",
      AFTER_ID,
      50,
    ]);
  });

  it("backward compat: omitting --after-id produces identical query shape as before", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ limit: 10 });
    expect(capture[0]?.sql).not.toContain("(occurred_at, id) <");
    expect(capture[0]?.params).toEqual([10]);
  });
});

describe("computeFieldDiffs", () => {
  it("returns sorted alphabetical diffs", () => {
    const diffs = computeFieldDiffs(
      { z: 1, a: 1, m: 1 },
      { z: 2, a: 2, m: 2 },
    );
    expect(diffs.map((d) => d.field)).toEqual(["a", "m", "z"]);
  });

  it("returns empty array when both states are equal", () => {
    expect(computeFieldDiffs({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it("returns empty array when both states are null", () => {
    expect(computeFieldDiffs(null, null)).toEqual([]);
  });

  it("treats null state as empty object", () => {
    const diffs = computeFieldDiffs(null, { a: 1 });
    expect(diffs).toEqual([{ field: "a", valueA: undefined, valueB: 1 }]);
  });

  it("compares values via JSON.stringify for deep equality", () => {
    const diffs = computeFieldDiffs(
      { nested: { x: 1 } },
      { nested: { x: 2 } },
    );
    expect(diffs).toEqual([
      { field: "nested", valueA: { x: 1 }, valueB: { x: 2 } },
    ]);
  });

  it("treats deep-equal objects as no diff", () => {
    const diffs = computeFieldDiffs(
      { nested: { x: 1, y: 2 } },
      { nested: { x: 1, y: 2 } },
    );
    expect(diffs).toEqual([]);
  });
});

describe("PostgresTraceRetention.previewRestoreTenantPolicy (M6.7.zz.tenant.opt-out.cli.restore.dry-run)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const HISTORY_ID = "30000000-0000-4000-8000-000000000003";

  function historyRow(
    overrides: Partial<{
      tenant_id: string;
      table_name: string;
      prev_state: Record<string, unknown> | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      tenant_id: TENANT_A,
      table_name: "workflow_traces",
      prev_state: null,
      ...overrides,
    };
  }

  it("throws when history id is not found", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.previewRestoreTenantPolicy({ historyId: HISTORY_ID }),
    ).rejects.toThrow(/not found/);
  });

  it("does NOT issue any mutation queries (read-only)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [historyRow()], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.previewRestoreTenantPolicy({ historyId: HISTORY_ID });
    // Only the SELECT against the history table should be issued
    expect(capture).toHaveLength(1);
    expect(capture[0]?.sql).toContain("SELECT");
    expect(capture[0]?.sql).not.toContain("INSERT");
    expect(capture[0]?.sql).not.toContain("UPDATE");
    expect(capture[0]?.sql).not.toContain("DELETE");
  });

  it("prev_state=null returns kind='would_delete' with tenantId + tableName + sourceHistoryId", async () => {
    const conn = mockConnection(() => ({
      rows: [historyRow({ prev_state: null })],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.previewRestoreTenantPolicy({ historyId: HISTORY_ID });
    expect(result).toEqual({
      kind: "would_delete",
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      sourceHistoryId: HISTORY_ID,
    });
  });

  it("prev_state with opt_out=true returns kind='would_set_opt_out' with retention + until + reason", async () => {
    const conn = mockConnection(() => ({
      rows: [
        historyRow({
          prev_state: {
            retention_days: 90,
            enabled: false,
            opt_out: true,
            opt_out_reason: "legal_hold:case#42",
            opt_out_until: "2027-01-01T00:00:00.000Z",
          },
        }),
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.previewRestoreTenantPolicy({ historyId: HISTORY_ID });
    expect(result).toEqual({
      kind: "would_set_opt_out",
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 90,
      optOutUntil: "2027-01-01T00:00:00.000Z",
      optOutReason: "legal_hold:case#42",
      sourceHistoryId: HISTORY_ID,
    });
  });

  it("prev_state with opt_out=true + null reason/until returns kind='would_set_opt_out' with nulls", async () => {
    const conn = mockConnection(() => ({
      rows: [
        historyRow({
          prev_state: {
            retention_days: 365,
            enabled: false,
            opt_out: true,
          },
        }),
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.previewRestoreTenantPolicy({ historyId: HISTORY_ID });
    if (result.kind === "would_set_opt_out") {
      expect(result.optOutUntil).toBeNull();
      expect(result.optOutReason).toBeNull();
    } else {
      throw new Error("expected kind='would_set_opt_out'");
    }
  });

  it("prev_state with opt_out=false returns kind='would_set_retention' with days + enabled", async () => {
    const conn = mockConnection(() => ({
      rows: [
        historyRow({
          prev_state: {
            retention_days: 30,
            enabled: true,
            opt_out: false,
            opt_out_reason: null,
            opt_out_until: null,
          },
        }),
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.previewRestoreTenantPolicy({ historyId: HISTORY_ID });
    expect(result).toEqual({
      kind: "would_set_retention",
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 30,
      enabled: true,
      sourceHistoryId: HISTORY_ID,
    });
  });

  it("prev_state with opt_out=false + enabled=false returns kind='would_set_retention' with enabled=false", async () => {
    const conn = mockConnection(() => ({
      rows: [
        historyRow({
          prev_state: {
            retention_days: 90,
            enabled: false,
            opt_out: false,
          },
        }),
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.previewRestoreTenantPolicy({ historyId: HISTORY_ID });
    if (result.kind === "would_set_retention") {
      expect(result.enabled).toBe(false);
    } else {
      throw new Error("expected kind='would_set_retention'");
    }
  });

  it("throws when prev_state is missing retention_days", async () => {
    const conn = mockConnection(() => ({
      rows: [
        historyRow({
          prev_state: { enabled: true, opt_out: false },
        }),
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.previewRestoreTenantPolicy({ historyId: HISTORY_ID }),
    ).rejects.toThrow(/retention_days/);
  });

  it("kind discriminates which mutation method would run", async () => {
    // Three calls — same lookup shape but different prev_state → different kinds
    const conn = mockConnection((sql, params) => {
      const id = params?.[0] as string;
      if (id === "id-delete") {
        return { rows: [historyRow({ prev_state: null })], rowCount: 1 };
      }
      if (id === "id-opt-out") {
        return {
          rows: [
            historyRow({
              prev_state: { retention_days: 90, opt_out: true, enabled: false },
            }),
          ],
          rowCount: 1,
        };
      }
      return {
        rows: [
          historyRow({
            prev_state: { retention_days: 30, opt_out: false, enabled: true },
          }),
        ],
        rowCount: 1,
      };
    });
    const r = new PostgresTraceRetention({ conn });
    const a = await r.previewRestoreTenantPolicy({ historyId: "id-delete" });
    const b = await r.previewRestoreTenantPolicy({ historyId: "id-opt-out" });
    const c = await r.previewRestoreTenantPolicy({ historyId: "id-set" });
    expect(a.kind).toBe("would_delete");
    expect(b.kind).toBe("would_set_opt_out");
    expect(c.kind).toBe("would_set_retention");
  });
});
