import { describe, expect, it, vi } from "vitest";

import type { PgConnection, PgQueryResult } from "./connection.js";
import {
  computeFieldDiffs,
  computeFieldVariations,
  effectiveRetentionKey,
  isOptOutHistoryEventKind,
  normalizeResolutionForDiff,
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

  it("filters by single eventKind when provided (multi-value array)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ eventKinds: ["opt_out_set"] });
    expect(capture[0]?.sql).toContain("event_kind IN ($1)");
    expect(capture[0]?.params?.[0]).toBe("opt_out_set");
  });

  it("filters by multiple eventKinds with IN clause when provided (OR-semantic)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      eventKinds: ["opt_out_set", "opt_out_cleared"],
    });
    expect(capture[0]?.sql).toContain("event_kind IN ($1, $2)");
    expect(capture[0]?.params?.[0]).toBe("opt_out_set");
    expect(capture[0]?.params?.[1]).toBe("opt_out_cleared");
  });

  it("omits the event_kind WHERE clause when eventKinds is empty array", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ eventKinds: [] });
    expect(capture[0]?.sql).not.toContain("event_kind IN");
  });

  it("omits the event_kind WHERE clause when eventKinds not set (backward compat)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({});
    expect(capture[0]?.sql).not.toContain("event_kind IN");
  });

  it("excludes by single eventKindsNot when provided", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ eventKindsNot: ["policy_deleted"] });
    expect(capture[0]?.sql).toContain("event_kind NOT IN ($1)");
    expect(capture[0]?.params?.[0]).toBe("policy_deleted");
  });

  it("excludes by multiple eventKindsNot with NOT IN clause (OR-semantic)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      eventKindsNot: ["policy_deleted", "retention_set"],
    });
    expect(capture[0]?.sql).toContain("event_kind NOT IN ($1, $2)");
    expect(capture[0]?.params?.[0]).toBe("policy_deleted");
    expect(capture[0]?.params?.[1]).toBe("retention_set");
  });

  it("omits NOT IN clause when eventKindsNot empty array", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ eventKindsNot: [] });
    expect(capture[0]?.sql).not.toContain("NOT IN");
  });

  it("composes eventKinds + eventKindsNot independently (both clauses fire)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      eventKinds: ["opt_out_set", "opt_out_cleared"],
      eventKindsNot: ["policy_deleted"],
    });
    expect(capture[0]?.sql).toContain("event_kind IN ($1, $2)");
    expect(capture[0]?.sql).toContain("event_kind NOT IN ($3)");
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
    expect(sql).toContain("ORDER BY h.occurred_at DESC");
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
    expect(capture[0]?.sql).toContain("WHERE h.id IN ($1, $2)");
    expect(capture[0]?.params).toEqual([ID_A, ID_B]);
  });
});

describe("PostgresTraceRetention.diffHistoryEntries --kind expectation check (M6.7.zz.tenant.opt-out.cli.diff-history.kind-filter + .multi)", () => {
  const TENANT = "00000000-0000-4000-8000-00000000000A";
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";

  function rawEntry(
    id: string,
    overrides: Partial<{
      event_kind: string;
      next_state: Record<string, unknown> | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      id,
      tenant_id: TENANT,
      table_name: "workflow_traces",
      event_kind: "opt_out_set",
      occurred_at: "2026-05-21T12:00:00.000Z",
      next_state: { opt_out: true, retention_days: 365 },
      ...overrides,
    };
  }

  it("single-value: accepts when both events have the expected event_kind", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "opt_out_set" }),
        rawEntry(ID_B, { event_kind: "opt_out_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      eventKinds: ["opt_out_set"],
    });
    expect(result.eventKindA).toBe("opt_out_set");
    expect(result.eventKindB).toBe("opt_out_set");
  });

  it("single-value: throws when event A's kind doesn't match expected", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "retention_set" }),
        rawEntry(ID_B, { event_kind: "opt_out_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKinds: ["opt_out_set"],
      }),
    ).rejects.toThrow(
      "expected both events to have event_kind in ['opt_out_set'] but A is 'retention_set'",
    );
  });

  it("single-value: throws when event B's kind doesn't match expected", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "opt_out_set" }),
        rawEntry(ID_B, { event_kind: "policy_deleted" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKinds: ["opt_out_set"],
      }),
    ).rejects.toThrow(
      "expected both events to have event_kind in ['opt_out_set'] but B is 'policy_deleted'",
    );
  });

  it("single-value: throws naming both sides when neither matches expected", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "retention_set" }),
        rawEntry(ID_B, { event_kind: "policy_deleted" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKinds: ["opt_out_set"],
      }),
    ).rejects.toThrow(
      "expected both events to have event_kind in ['opt_out_set'] but A is 'retention_set' and B is 'policy_deleted'",
    );
  });

  it("multi-value: accepts when both events have ANY of the expected event_kinds (OR-semantic)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "opt_out_set" }),
        rawEntry(ID_B, { event_kind: "opt_out_cleared" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      eventKinds: ["opt_out_set", "opt_out_cleared"],
    });
    expect(result.eventKindA).toBe("opt_out_set");
    expect(result.eventKindB).toBe("opt_out_cleared");
  });

  it("multi-value: throws when A is not in tuple with multi-value error format", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "policy_deleted" }),
        rawEntry(ID_B, { event_kind: "opt_out_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKinds: ["opt_out_set", "opt_out_cleared"],
      }),
    ).rejects.toThrow(
      "expected both events to have event_kind in ['opt_out_set', 'opt_out_cleared'] but A is 'policy_deleted'",
    );
  });

  it("multi-value: throws naming both when neither is in tuple", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "policy_deleted" }),
        rawEntry(ID_B, { event_kind: "retention_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKinds: ["opt_out_set", "opt_out_cleared"],
      }),
    ).rejects.toThrow(
      "expected both events to have event_kind in ['opt_out_set', 'opt_out_cleared'] but A is 'policy_deleted' and B is 'retention_set'",
    );
  });

  it("omits the check when eventKinds not set (backward compat)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "opt_out_set" }),
        rawEntry(ID_B, { event_kind: "policy_deleted" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
    });
    expect(result.eventKindA).toBe("opt_out_set");
    expect(result.eventKindB).toBe("policy_deleted");
  });

  it("treats empty eventKinds array as filter-not-set", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "opt_out_set" }),
        rawEntry(ID_B, { event_kind: "policy_deleted" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      eventKinds: [],
    });
    expect(result.eventKindA).toBe("opt_out_set");
    expect(result.eventKindB).toBe("policy_deleted");
  });
});

describe("PostgresTraceRetention.diffHistoryEntries --actor-id expectation check (M6.7.zz.tenant.opt-out.cli.diff-history.actor-filter + .multi)", () => {
  const TENANT = "00000000-0000-4000-8000-00000000000A";
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";
  const ACTOR_ALICE = "11111111-0000-4000-8000-000000000001";
  const ACTOR_BOB = "22222222-0000-4000-8000-000000000002";
  const ACTOR_CAROL = "33333333-0000-4000-8000-000000000003";

  function rawEntry(
    id: string,
    overrides: Partial<{
      actor_id: string | null;
      event_kind: string;
      next_state: Record<string, unknown> | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      id,
      tenant_id: TENANT,
      table_name: "workflow_traces",
      event_kind: "opt_out_set",
      actor_id: ACTOR_ALICE,
      occurred_at: "2026-05-22T12:00:00.000Z",
      next_state: { opt_out: true, retention_days: 365 },
      ...overrides,
    };
  }

  it("accepts when both events have the expected actor_id (single)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_ALICE }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorIds: [ACTOR_ALICE],
    });
    expect(result.idA).toBe(ID_A);
    expect(result.idB).toBe(ID_B);
  });

  it("throws when event A's actor doesn't match expected (single)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_BOB }),
        rawEntry(ID_B, { actor_id: ACTOR_ALICE }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIds: [ACTOR_ALICE],
      }),
    ).rejects.toThrow(
      `expected both events to have actor_id in ['${ACTOR_ALICE}'] but A is '${ACTOR_BOB}'`,
    );
  });

  it("throws when event B's actor doesn't match expected (single)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIds: [ACTOR_ALICE],
      }),
    ).rejects.toThrow(
      `expected both events to have actor_id in ['${ACTOR_ALICE}'] but B is '${ACTOR_BOB}'`,
    );
  });

  it("throws naming both sides when neither matches expected (single)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_BOB }),
        rawEntry(ID_B, { actor_id: null }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIds: [ACTOR_ALICE],
      }),
    ).rejects.toThrow(
      `expected both events to have actor_id in ['${ACTOR_ALICE}'] but A is '${ACTOR_BOB}' and B is <system>`,
    );
  });

  it("renders <system> for null actor_id in mismatch message (single)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: null }),
        rawEntry(ID_B, { actor_id: ACTOR_ALICE }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIds: [ACTOR_ALICE],
      }),
    ).rejects.toThrow(
      `expected both events to have actor_id in ['${ACTOR_ALICE}'] but A is <system>`,
    );
  });

  it("accepts when both events have any of N expected actors (multi)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorIds: [ACTOR_ALICE, ACTOR_BOB],
    });
    expect(result.idA).toBe(ID_A);
    expect(result.idB).toBe(ID_B);
  });

  it("throws when A doesn't match any of N actors with multi-value error format", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_CAROL }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIds: [ACTOR_ALICE, ACTOR_BOB],
      }),
    ).rejects.toThrow(
      `expected both events to have actor_id in ['${ACTOR_ALICE}', '${ACTOR_BOB}'] but A is '${ACTOR_CAROL}'`,
    );
  });

  it("throws naming both when both events fail the actor tuple (multi)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_CAROL }),
        rawEntry(ID_B, { actor_id: null }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIds: [ACTOR_ALICE, ACTOR_BOB],
      }),
    ).rejects.toThrow(
      `expected both events to have actor_id in ['${ACTOR_ALICE}', '${ACTOR_BOB}'] but A is '${ACTOR_CAROL}' and B is <system>`,
    );
  });

  it("omits the check when actorIds not set (backward compat)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
    });
    expect(result.idA).toBe(ID_A);
    expect(result.idB).toBe(ID_B);
  });

  it("treats empty actorIds array as filter-not-set", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorIds: [],
    });
    expect(result.idA).toBe(ID_A);
    expect(result.idB).toBe(ID_B);
  });

  it("composes with eventKind check (both pass)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, {
          actor_id: ACTOR_ALICE,
          event_kind: "opt_out_set",
        }),
        rawEntry(ID_B, {
          actor_id: ACTOR_ALICE,
          event_kind: "opt_out_set",
        }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      eventKinds: ["opt_out_set"],
      actorIds: [ACTOR_ALICE],
    });
    expect(result.idA).toBe(ID_A);
    expect(result.idB).toBe(ID_B);
  });
});

describe("PostgresTraceRetention.diffHistoryEntries --with-actor-names (M6.7.zz.tenant.opt-out.cli.diff-history.with-actor-names)", () => {
  const TENANT = "00000000-0000-4000-8000-00000000000A";
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";
  const ACTOR_ALICE = "11111111-0000-4000-8000-000000000001";
  const ACTOR_BOB = "22222222-0000-4000-8000-000000000002";

  function rawEntry(
    id: string,
    overrides: Partial<{
      actor_id: string | null;
      actor_display_name: string | null;
      actor_email: string | null;
      next_state: Record<string, unknown> | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      id,
      tenant_id: TENANT,
      table_name: "workflow_traces",
      event_kind: "opt_out_set",
      actor_id: ACTOR_ALICE,
      occurred_at: "2026-05-22T12:00:00.000Z",
      next_state: { opt_out: true, retention_days: 365 },
      ...overrides,
    };
  }

  it("omits LEFT JOIN when joinActor not set (backward compat)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [rawEntry(ID_A), rawEntry(ID_B)], rowCount: 2 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryEntries({ idA: ID_A, idB: ID_B });
    expect(capture[0]?.sql).not.toContain("LEFT JOIN meta.users");
    expect(capture[0]?.sql).not.toContain("actor_display_name");
    expect(capture[0]?.sql).not.toContain("actor_email");
  });

  it("emits LEFT JOIN meta.users when joinActor=true with display_name + email in SELECT", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [rawEntry(ID_A), rawEntry(ID_B)], rowCount: 2 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryEntries({ idA: ID_A, idB: ID_B, joinActor: true });
    expect(capture[0]?.sql).toContain(
      "LEFT JOIN meta.users u ON u.id = h.actor_id",
    );
    expect(capture[0]?.sql).toContain("u.display_name AS actor_display_name");
    expect(capture[0]?.sql).toContain("u.email AS actor_email");
  });

  it("returns actor info for both events when joinActor=true + users exist", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, {
          actor_id: ACTOR_ALICE,
          actor_display_name: "Alice Smith",
          actor_email: "alice@example.com",
        }),
        rawEntry(ID_B, {
          actor_id: ACTOR_BOB,
          actor_display_name: "Bob Jones",
          actor_email: "bob@example.com",
        }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      joinActor: true,
    });
    expect(result.actorIdA).toBe(ACTOR_ALICE);
    expect(result.actorIdB).toBe(ACTOR_BOB);
    expect(result.actorDisplayNameA).toBe("Alice Smith");
    expect(result.actorDisplayNameB).toBe("Bob Jones");
    expect(result.actorEmailA).toBe("alice@example.com");
    expect(result.actorEmailB).toBe("bob@example.com");
  });

  it("returns null actorDisplayName + actorEmail when actor has no user row (orphan FK)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, {
          actor_id: ACTOR_ALICE,
          actor_display_name: "Alice Smith",
          actor_email: "alice@example.com",
        }),
        rawEntry(ID_B, {
          actor_id: ACTOR_BOB,
          actor_display_name: null,
          actor_email: null,
        }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      joinActor: true,
    });
    expect(result.actorIdB).toBe(ACTOR_BOB);
    expect(result.actorDisplayNameB).toBeNull();
    expect(result.actorEmailB).toBeNull();
  });

  it("returns null for system actor (actor_id is null)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, {
          actor_id: null,
          actor_display_name: null,
          actor_email: null,
        }),
        rawEntry(ID_B, {
          actor_id: ACTOR_ALICE,
          actor_display_name: "Alice Smith",
          actor_email: "alice@example.com",
        }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      joinActor: true,
    });
    expect(result.actorIdA).toBeNull();
    expect(result.actorDisplayNameA).toBeNull();
    expect(result.actorEmailA).toBeNull();
    expect(result.actorIdB).toBe(ACTOR_ALICE);
    expect(result.actorDisplayNameB).toBe("Alice Smith");
  });

  it("omits actor display fields when joinActor is false (TypeScript undefined)", async () => {
    const conn = mockConnection(() => ({
      rows: [rawEntry(ID_A), rawEntry(ID_B)],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({ idA: ID_A, idB: ID_B });
    expect(result.actorIdA).toBe(ACTOR_ALICE);
    expect(result.actorIdB).toBe(ACTOR_ALICE);
    expect(result.actorDisplayNameA).toBeUndefined();
    expect(result.actorDisplayNameB).toBeUndefined();
    expect(result.actorEmailA).toBeUndefined();
    expect(result.actorEmailB).toBeUndefined();
  });

  it("always populates actorIdA + actorIdB even without joinActor (from actor_id column)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: null }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({ idA: ID_A, idB: ID_B });
    expect(result.actorIdA).toBe(ACTOR_ALICE);
    expect(result.actorIdB).toBeNull();
  });

  it("composes with --actor-id expectation check (joinActor + actorId)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, {
          actor_id: ACTOR_ALICE,
          actor_display_name: "Alice Smith",
          actor_email: "alice@example.com",
        }),
        rawEntry(ID_B, {
          actor_id: ACTOR_ALICE,
          actor_display_name: "Alice Smith",
          actor_email: "alice@example.com",
        }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorIds: [ACTOR_ALICE],
      joinActor: true,
    });
    expect(result.actorIdA).toBe(ACTOR_ALICE);
    expect(result.actorDisplayNameA).toBe("Alice Smith");
  });
});

describe("PostgresTraceRetention.diffHistoryEntries --actor-id-not exclusion check (M6.7.zz.tenant.opt-out.cli.diff-history.actor-not + .multi)", () => {
  const TENANT = "00000000-0000-4000-8000-00000000000A";
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";
  const ACTOR_ALICE = "11111111-0000-4000-8000-000000000001";
  const ACTOR_BOB = "22222222-0000-4000-8000-000000000002";
  const ACTOR_CAROL = "33333333-0000-4000-8000-000000000003";
  const ACTOR_DAVE = "44444444-0000-4000-8000-000000000004";

  function rawEntry(
    id: string,
    overrides: Partial<{
      actor_id: string | null;
      event_kind: string;
      next_state: Record<string, unknown> | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      id,
      tenant_id: TENANT,
      table_name: "workflow_traces",
      event_kind: "opt_out_set",
      actor_id: ACTOR_ALICE,
      occurred_at: "2026-05-22T12:00:00.000Z",
      next_state: { opt_out: true, retention_days: 365 },
      ...overrides,
    };
  }

  it("accepts when neither event has the excluded actor_id (single)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorIdsNot: [ACTOR_CAROL],
    });
    expect(result.idA).toBe(ID_A);
    expect(result.idB).toBe(ID_B);
  });

  it("accepts when both events have null actor_id (system) and excluded is a UUID", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: null }),
        rawEntry(ID_B, { actor_id: null }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorIdsNot: [ACTOR_ALICE],
    });
    expect(result.idA).toBe(ID_A);
  });

  it("throws when event A matches the excluded actor (single)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_CAROL }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIdsNot: [ACTOR_CAROL],
      }),
    ).rejects.toThrow(
      `expected neither event to have actor_id in ['${ACTOR_CAROL}'] but A matches`,
    );
  });

  it("throws when event B matches the excluded actor (single)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_CAROL }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIdsNot: [ACTOR_CAROL],
      }),
    ).rejects.toThrow(
      `expected neither event to have actor_id in ['${ACTOR_CAROL}'] but B matches`,
    );
  });

  it("throws naming both when both events match the excluded actor (single)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_CAROL }),
        rawEntry(ID_B, { actor_id: ACTOR_CAROL }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIdsNot: [ACTOR_CAROL],
      }),
    ).rejects.toThrow(
      `expected neither event to have actor_id in ['${ACTOR_CAROL}'] but both A and B match`,
    );
  });

  it("accepts when neither event has any of N excluded actors (multi)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorIdsNot: [ACTOR_CAROL, ACTOR_DAVE],
    });
    expect(result.idA).toBe(ID_A);
    expect(result.idB).toBe(ID_B);
  });

  it("throws when A matches one of N excluded actors with multi-value error format", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_CAROL }),
        rawEntry(ID_B, { actor_id: ACTOR_ALICE }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIdsNot: [ACTOR_CAROL, ACTOR_DAVE],
      }),
    ).rejects.toThrow(
      `expected neither event to have actor_id in ['${ACTOR_CAROL}', '${ACTOR_DAVE}'] but A matches`,
    );
  });

  it("throws naming both when both events match different actors in exclusion list (multi)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_CAROL }),
        rawEntry(ID_B, { actor_id: ACTOR_DAVE }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIdsNot: [ACTOR_CAROL, ACTOR_DAVE],
      }),
    ).rejects.toThrow(
      `expected neither event to have actor_id in ['${ACTOR_CAROL}', '${ACTOR_DAVE}'] but both A and B match`,
    );
  });

  it("omits the check when actorIdsNot not set (backward compat)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({ idA: ID_A, idB: ID_B });
    expect(result.idA).toBe(ID_A);
  });

  it("treats empty actorIdsNot array as filter-not-set", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_CAROL }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorIdsNot: [],
    });
    expect(result.idA).toBe(ID_A);
  });

  it("composes with --actor-id expectation check (both pass when distinct)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_ALICE }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorIds: [ACTOR_ALICE],
      actorIdsNot: [ACTOR_BOB],
    });
    expect(result.idA).toBe(ID_A);
  });

  it("contradictory --actor-id + --actor-id-not surfaces actorId check first", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_BOB }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIds: [ACTOR_ALICE],
        actorIdsNot: [ACTOR_BOB],
      }),
    ).rejects.toThrow(
      `expected both events to have actor_id in ['${ACTOR_ALICE}']`,
    );
  });
});

describe("PostgresTraceRetention.diffHistoryEntries --kind-not exclusion check (M6.7.zz.tenant.opt-out.cli.diff-history.kind-not + .multi)", () => {
  const TENANT = "00000000-0000-4000-8000-00000000000A";
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";

  function rawEntry(
    id: string,
    overrides: Partial<{
      event_kind: string;
      next_state: Record<string, unknown> | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      id,
      tenant_id: TENANT,
      table_name: "workflow_traces",
      event_kind: "opt_out_set",
      occurred_at: "2026-05-22T12:00:00.000Z",
      next_state: { opt_out: true, retention_days: 365 },
      ...overrides,
    };
  }

  it("single-value: accepts when neither event has the excluded event_kind", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "opt_out_set" }),
        rawEntry(ID_B, { event_kind: "retention_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      eventKindsNot: ["policy_deleted"],
    });
    expect(result.eventKindA).toBe("opt_out_set");
    expect(result.eventKindB).toBe("retention_set");
  });

  it("single-value: throws when event A matches the excluded event_kind", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "policy_deleted" }),
        rawEntry(ID_B, { event_kind: "opt_out_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKindsNot: ["policy_deleted"],
      }),
    ).rejects.toThrow(
      "expected neither event to have event_kind in ['policy_deleted'] but A matches",
    );
  });

  it("single-value: throws when event B matches the excluded event_kind", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "opt_out_set" }),
        rawEntry(ID_B, { event_kind: "policy_deleted" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKindsNot: ["policy_deleted"],
      }),
    ).rejects.toThrow(
      "expected neither event to have event_kind in ['policy_deleted'] but B matches",
    );
  });

  it("single-value: throws naming both when both events match the excluded event_kind", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "policy_deleted" }),
        rawEntry(ID_B, { event_kind: "policy_deleted" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKindsNot: ["policy_deleted"],
      }),
    ).rejects.toThrow(
      "expected neither event to have event_kind in ['policy_deleted'] but both A and B match",
    );
  });

  it("multi-value: accepts when neither event has any of the excluded event_kinds", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "opt_out_set" }),
        rawEntry(ID_B, { event_kind: "opt_out_cleared" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      eventKindsNot: ["policy_deleted", "retention_set"],
    });
    expect(result.eventKindA).toBe("opt_out_set");
    expect(result.eventKindB).toBe("opt_out_cleared");
  });

  it("multi-value: throws when A matches one of N excluded kinds with multi-value error format", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "retention_set" }),
        rawEntry(ID_B, { event_kind: "opt_out_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKindsNot: ["policy_deleted", "retention_set"],
      }),
    ).rejects.toThrow(
      "expected neither event to have event_kind in ['policy_deleted', 'retention_set'] but A matches",
    );
  });

  it("multi-value: throws naming both when both events match different kinds in the exclusion list", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "policy_deleted" }),
        rawEntry(ID_B, { event_kind: "retention_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKindsNot: ["policy_deleted", "retention_set"],
      }),
    ).rejects.toThrow(
      "expected neither event to have event_kind in ['policy_deleted', 'retention_set'] but both A and B match",
    );
  });

  it("omits the check when eventKindsNot not set (backward compat)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "policy_deleted" }),
        rawEntry(ID_B, { event_kind: "policy_deleted" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({ idA: ID_A, idB: ID_B });
    expect(result.eventKindA).toBe("policy_deleted");
    expect(result.eventKindB).toBe("policy_deleted");
  });

  it("treats empty eventKindsNot array as filter-not-set", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "policy_deleted" }),
        rawEntry(ID_B, { event_kind: "policy_deleted" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      eventKindsNot: [],
    });
    expect(result.eventKindA).toBe("policy_deleted");
    expect(result.eventKindB).toBe("policy_deleted");
  });

  it("composes with --kind expectation check (both pass when distinct kinds)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "opt_out_set" }),
        rawEntry(ID_B, { event_kind: "opt_out_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      eventKinds: ["opt_out_set"],
      eventKindsNot: ["policy_deleted", "retention_set"],
    });
    expect(result.eventKindA).toBe("opt_out_set");
  });

  it("contradictory --kind + --kind-not surfaces kind check first", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "policy_deleted" }),
        rawEntry(ID_B, { event_kind: "policy_deleted" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKinds: ["opt_out_set"],
        eventKindsNot: ["policy_deleted"],
      }),
    ).rejects.toThrow(
      "expected both events to have event_kind in ['opt_out_set']",
    );
  });

  it("composes with --actor-id-not (both checks fire independently)", async () => {
    const ACTOR_BOB = "22222222-0000-4000-8000-000000000002";
    const conn = mockConnection(() => ({
      rows: [
        { ...rawEntry(ID_A, { event_kind: "opt_out_set" }), actor_id: null },
        { ...rawEntry(ID_B, { event_kind: "opt_out_set" }), actor_id: null },
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      eventKindsNot: ["policy_deleted", "retention_set"],
      actorIdsNot: [ACTOR_BOB],
    });
    expect(result.eventKindA).toBe("opt_out_set");
  });
});

describe("PostgresTraceRetention.diffHistoryEntries actorPresence expectation check (M6.7.zz.tenant.opt-out.cli.diff-history.system-only)", () => {
  const TENANT = "00000000-0000-4000-8000-00000000000A";
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";
  const ACTOR_ALICE = "11111111-0000-4000-8000-000000000001";
  const ACTOR_BOB = "22222222-0000-4000-8000-000000000002";

  function rawEntry(
    id: string,
    overrides: Partial<{
      actor_id: string | null;
      event_kind: string;
      next_state: Record<string, unknown> | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      id,
      tenant_id: TENANT,
      table_name: "workflow_traces",
      event_kind: "opt_out_set",
      actor_id: ACTOR_ALICE,
      occurred_at: "2026-05-22T12:00:00.000Z",
      next_state: { opt_out: true, retention_days: 365 },
      ...overrides,
    };
  }

  it("system_only: accepts when both events are system-authored (null actor_id)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: null }),
        rawEntry(ID_B, { actor_id: null }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorPresence: "system_only",
    });
    expect(result.actorIdA).toBeNull();
    expect(result.actorIdB).toBeNull();
  });

  it("system_only: throws when A has actor_id with explicit error naming side A", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: null }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorPresence: "system_only",
      }),
    ).rejects.toThrow(
      `expected both events to be system-authored (actor_id IS NULL) but A is '${ACTOR_ALICE}'`,
    );
  });

  it("system_only: throws when B has actor_id with explicit error naming side B", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: null }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorPresence: "system_only",
      }),
    ).rejects.toThrow(
      `expected both events to be system-authored (actor_id IS NULL) but B is '${ACTOR_BOB}'`,
    );
  });

  it("system_only: throws naming both sides when neither is system-authored", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorPresence: "system_only",
      }),
    ).rejects.toThrow(
      "expected both events to be system-authored (actor_id IS NULL)",
    );
  });

  it("no_system: accepts when both events have non-null actor_id", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorPresence: "no_system",
    });
    expect(result.actorIdA).toBe(ACTOR_ALICE);
    expect(result.actorIdB).toBe(ACTOR_BOB);
  });

  it("no_system: throws when A is system-authored with explicit '<system>' error", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: null }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorPresence: "no_system",
      }),
    ).rejects.toThrow(
      "expected neither event to be system-authored (actor_id IS NULL) but A is <system>",
    );
  });

  it("no_system: throws when B is system-authored", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: null }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorPresence: "no_system",
      }),
    ).rejects.toThrow(
      "expected neither event to be system-authored (actor_id IS NULL) but B is <system>",
    );
  });

  it("no_system: throws naming both when both events are system-authored", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: null }),
        rawEntry(ID_B, { actor_id: null }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorPresence: "no_system",
      }),
    ).rejects.toThrow(
      "expected neither event to be system-authored (actor_id IS NULL) but both A and B are <system>",
    );
  });

  it("omits the check when actorPresence not set (backward compat)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: null }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({ idA: ID_A, idB: ID_B });
    expect(result.actorIdA).toBeNull();
    expect(result.actorIdB).toBe(ACTOR_BOB);
  });

  it("composes with --kind expectation check (both pass when actor + kind expectations met)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: null, event_kind: "opt_out_set" }),
        rawEntry(ID_B, { actor_id: null, event_kind: "opt_out_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      eventKinds: ["opt_out_set"],
      actorPresence: "system_only",
    });
    expect(result.actorIdA).toBeNull();
  });
});

describe("PostgresTraceRetention.diffHistoryEntries per-side expectation checks (M6.7.zz.tenant.opt-out.cli.diff-history.per-side + .multi)", () => {
  const TENANT = "00000000-0000-4000-8000-00000000000A";
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";
  const ACTOR_ALICE = "11111111-0000-4000-8000-000000000001";
  const ACTOR_BOB = "22222222-0000-4000-8000-000000000002";
  const ACTOR_CAROL = "33333333-0000-4000-8000-000000000003";

  function rawEntry(
    id: string,
    overrides: Partial<{
      actor_id: string | null;
      event_kind: string;
      next_state: Record<string, unknown> | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      id,
      tenant_id: TENANT,
      table_name: "workflow_traces",
      event_kind: "opt_out_set",
      actor_id: ACTOR_ALICE,
      occurred_at: "2026-05-22T12:00:00.000Z",
      next_state: { opt_out: true, retention_days: 365 },
      ...overrides,
    };
  }

  it("--kind-a (single): accepts when event A has expected kind", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "opt_out_set" }),
        rawEntry(ID_B, { event_kind: "policy_deleted" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      eventKindsA: ["opt_out_set"],
    });
    expect(result.eventKindA).toBe("opt_out_set");
    expect(result.eventKindB).toBe("policy_deleted");
  });

  it("--kind-a (single): throws when event A has wrong kind with multi-value list error format", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "retention_set" }),
        rawEntry(ID_B, { event_kind: "opt_out_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKindsA: ["opt_out_set"],
      }),
    ).rejects.toThrow(
      "expected event A to have event_kind in ['opt_out_set'] but A is 'retention_set'",
    );
  });

  it("--kind-a (multi): accepts when A has any of N expected kinds", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "opt_out_set" }),
        rawEntry(ID_B, { event_kind: "policy_deleted" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      eventKindsA: ["opt_out_set", "opt_out_cleared"],
    });
    expect(result.eventKindA).toBe("opt_out_set");
  });

  it("--kind-a (multi): throws with multi-value list when A doesn't match any of N kinds", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "policy_deleted" }),
        rawEntry(ID_B, { event_kind: "opt_out_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKindsA: ["opt_out_set", "opt_out_cleared"],
      }),
    ).rejects.toThrow(
      "expected event A to have event_kind in ['opt_out_set', 'opt_out_cleared'] but A is 'policy_deleted'",
    );
  });

  it("--kind-b (single): throws when event B has wrong kind", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "retention_set" }),
        rawEntry(ID_B, { event_kind: "opt_out_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKindsB: ["policy_deleted"],
      }),
    ).rejects.toThrow(
      "expected event B to have event_kind in ['policy_deleted'] but B is 'opt_out_set'",
    );
  });

  it("--kind-b (multi): accepts when B has any of N expected kinds", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "retention_set" }),
        rawEntry(ID_B, { event_kind: "opt_out_cleared" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      eventKindsB: ["opt_out_set", "opt_out_cleared"],
    });
    expect(result.eventKindB).toBe("opt_out_cleared");
  });

  it("--kind-a + --kind-b: accepts when both sides match their respective tuple expectations", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "opt_out_set" }),
        rawEntry(ID_B, { event_kind: "opt_out_cleared" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      eventKindsA: ["opt_out_set"],
      eventKindsB: ["opt_out_cleared"],
    });
    expect(result.eventKindA).toBe("opt_out_set");
    expect(result.eventKindB).toBe("opt_out_cleared");
  });

  it("--kind-not-a: accepts when event A doesn't have any excluded kind (multi-value)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "opt_out_set" }),
        rawEntry(ID_B, { event_kind: "policy_deleted" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      eventKindsNotA: ["policy_deleted", "retention_set"],
    });
    expect(result.eventKindA).toBe("opt_out_set");
    expect(result.eventKindB).toBe("policy_deleted");
  });

  it("--kind-not-a: throws with multi-value list format when A matches one of excluded kinds", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "retention_set" }),
        rawEntry(ID_B, { event_kind: "opt_out_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKindsNotA: ["policy_deleted", "retention_set"],
      }),
    ).rejects.toThrow(
      "expected event A to have event_kind NOT in ['policy_deleted', 'retention_set'] but A is 'retention_set'",
    );
  });

  it("--kind-not-b: throws when B matches one of excluded kinds (B side independent of A)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "opt_out_set" }),
        rawEntry(ID_B, { event_kind: "policy_deleted" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKindsNotB: ["policy_deleted"],
      }),
    ).rejects.toThrow(
      "expected event B to have event_kind NOT in ['policy_deleted'] but B is 'policy_deleted'",
    );
  });

  it("--actor-id-a (single): accepts when A has expected actor", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorIdsA: [ACTOR_ALICE],
    });
    expect(result.actorIdA).toBe(ACTOR_ALICE);
    expect(result.actorIdB).toBe(ACTOR_BOB);
  });

  it("--actor-id-a (single): throws when A has wrong actor with multi-value list error format", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_BOB }),
        rawEntry(ID_B, { actor_id: ACTOR_ALICE }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIdsA: [ACTOR_ALICE],
      }),
    ).rejects.toThrow(
      `expected event A to have actor_id in ['${ACTOR_ALICE}'] but A is '${ACTOR_BOB}'`,
    );
  });

  it("--actor-id-a: throws with <system> rendering when A is system-authored (null actor_id)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: null }),
        rawEntry(ID_B, { actor_id: ACTOR_ALICE }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIdsA: [ACTOR_ALICE],
      }),
    ).rejects.toThrow(
      `expected event A to have actor_id in ['${ACTOR_ALICE}'] but A is <system>`,
    );
  });

  it("--actor-id-a (multi): accepts when A has any of N expected actors", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_CAROL }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorIdsA: [ACTOR_ALICE, ACTOR_BOB],
    });
    expect(result.actorIdA).toBe(ACTOR_ALICE);
  });

  it("--actor-id-a (multi): throws with multi-value list when A doesn't match any of N actors", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_CAROL }),
        rawEntry(ID_B, { actor_id: ACTOR_ALICE }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIdsA: [ACTOR_ALICE, ACTOR_BOB],
      }),
    ).rejects.toThrow(
      `expected event A to have actor_id in ['${ACTOR_ALICE}', '${ACTOR_BOB}'] but A is '${ACTOR_CAROL}'`,
    );
  });

  it("--actor-id-b (single): throws when B has wrong actor", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_CAROL }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIdsB: [ACTOR_BOB],
      }),
    ).rejects.toThrow(
      `expected event B to have actor_id in ['${ACTOR_BOB}'] but B is '${ACTOR_CAROL}'`,
    );
  });

  it("--actor-id-b (multi): accepts when B has any of N expected actors", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_CAROL }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorIdsB: [ACTOR_ALICE, ACTOR_BOB],
    });
    expect(result.actorIdB).toBe(ACTOR_BOB);
  });

  it("--actor-id-not-a (single): accepts when A is not the excluded actor", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorIdsNotA: [ACTOR_CAROL],
    });
    expect(result.actorIdA).toBe(ACTOR_ALICE);
  });

  it("--actor-id-not-a (single): throws when A matches the excluded actor with multi-value list format", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_BOB }),
        rawEntry(ID_B, { actor_id: ACTOR_ALICE }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIdsNotA: [ACTOR_BOB],
      }),
    ).rejects.toThrow(
      `expected event A to have actor_id NOT in ['${ACTOR_BOB}'] but A matches`,
    );
  });

  it("--actor-id-not-a (multi): throws when A matches one of N excluded actors with multi-value error format", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_CAROL }),
        rawEntry(ID_B, { actor_id: ACTOR_ALICE }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIdsNotA: [ACTOR_BOB, ACTOR_CAROL],
      }),
    ).rejects.toThrow(
      `expected event A to have actor_id NOT in ['${ACTOR_BOB}', '${ACTOR_CAROL}'] but A matches`,
    );
  });

  it("--actor-id-not-b (single): throws when B matches the excluded actor", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorIdsNotB: [ACTOR_BOB],
      }),
    ).rejects.toThrow(
      `expected event B to have actor_id NOT in ['${ACTOR_BOB}'] but B matches`,
    );
  });

  it("--actor-id-not-b (multi): accepts when B doesn't match any of N excluded actors", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_CAROL }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorIdsNotB: [ACTOR_BOB],
    });
    expect(result.actorIdB).toBe(ACTOR_CAROL);
  });

  it("composition: --actor-id-a + --actor-id-b + --kind-a + --kind-b all check independently (all multi)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, {
          actor_id: ACTOR_ALICE,
          event_kind: "opt_out_set",
        }),
        rawEntry(ID_B, {
          actor_id: ACTOR_BOB,
          event_kind: "opt_out_cleared",
        }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorIdsA: [ACTOR_ALICE, ACTOR_BOB],
      actorIdsB: [ACTOR_BOB, ACTOR_CAROL],
      eventKindsA: ["opt_out_set", "opt_out_cleared"],
      eventKindsB: ["opt_out_set", "opt_out_cleared"],
    });
    expect(result.actorIdA).toBe(ACTOR_ALICE);
    expect(result.actorIdB).toBe(ACTOR_BOB);
  });

  it("composition: global --kind fires BEFORE per-side --kind-a (global check surfaces first error)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "policy_deleted" }),
        rawEntry(ID_B, { event_kind: "opt_out_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        eventKinds: ["opt_out_set"],
        eventKindsA: ["retention_set"],
      }),
    ).rejects.toThrow(
      "expected both events to have event_kind in ['opt_out_set']",
    );
  });

  it("treats empty per-side arrays as filter-not-set across all 6 fields", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_BOB, event_kind: "policy_deleted" }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB, event_kind: "retention_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      eventKindsA: [],
      eventKindsB: [],
      actorIdsA: [],
      actorIdsB: [],
      actorIdsNotA: [],
      actorIdsNotB: [],
    });
    expect(result.eventKindA).toBe("policy_deleted");
  });

  it("omits per-side checks when none of the per-side fields are set (backward compat)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { event_kind: "policy_deleted" }),
        rawEntry(ID_B, { event_kind: "retention_set" }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({ idA: ID_A, idB: ID_B });
    expect(result.eventKindA).toBe("policy_deleted");
    expect(result.eventKindB).toBe("retention_set");
  });
});

describe("PostgresTraceRetention.diffHistoryEntries per-side actorPresence expectation checks (M6.7.zz.tenant.opt-out.cli.diff-history.per-side.system-only)", () => {
  const TENANT = "00000000-0000-4000-8000-00000000000A";
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";
  const ACTOR_ALICE = "11111111-0000-4000-8000-000000000001";
  const ACTOR_BOB = "22222222-0000-4000-8000-000000000002";

  function rawEntry(
    id: string,
    overrides: Partial<{
      actor_id: string | null;
      event_kind: string;
      next_state: Record<string, unknown> | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      id,
      tenant_id: TENANT,
      table_name: "workflow_traces",
      event_kind: "opt_out_set",
      actor_id: ACTOR_ALICE,
      occurred_at: "2026-05-22T12:00:00.000Z",
      next_state: { opt_out: true, retention_days: 365 },
      ...overrides,
    };
  }

  it("--system-only-a: accepts when A has null actor_id (regardless of B)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: null }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorPresenceA: "system_only",
    });
    expect(result.actorIdA).toBeNull();
    expect(result.actorIdB).toBe(ACTOR_BOB);
  });

  it("--system-only-a: throws when A has UUID with actual UUID in error", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: null }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorPresenceA: "system_only",
      }),
    ).rejects.toThrow(
      `expected event A to be system-authored (actor_id IS NULL) but A is '${ACTOR_ALICE}'`,
    );
  });

  it("--no-system-a: accepts when A has UUID actor (regardless of B)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: null }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorPresenceA: "no_system",
    });
    expect(result.actorIdA).toBe(ACTOR_ALICE);
    expect(result.actorIdB).toBeNull();
  });

  it("--no-system-a: throws with <system> rendering when A is null actor_id", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: null }),
        rawEntry(ID_B, { actor_id: ACTOR_ALICE }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorPresenceA: "no_system",
      }),
    ).rejects.toThrow(
      "expected event A to NOT be system-authored (actor_id IS NULL) but A is <system>",
    );
  });

  it("--system-only-b: throws when B has UUID (B side independent of A)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: null }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorPresenceB: "system_only",
      }),
    ).rejects.toThrow(
      `expected event B to be system-authored (actor_id IS NULL) but B is '${ACTOR_BOB}'`,
    );
  });

  it("--no-system-b: throws with <system> rendering when B is null actor_id", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: null }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorPresenceB: "no_system",
      }),
    ).rejects.toThrow(
      "expected event B to NOT be system-authored (actor_id IS NULL) but B is <system>",
    );
  });

  it("canonical asymmetric pattern: --system-only-a + --no-system-b accepts when A=null, B=UUID", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: null }),
        rawEntry(ID_B, { actor_id: ACTOR_ALICE }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({
      idA: ID_A,
      idB: ID_B,
      actorPresenceA: "system_only",
      actorPresenceB: "no_system",
    });
    expect(result.actorIdA).toBeNull();
    expect(result.actorIdB).toBe(ACTOR_ALICE);
  });

  it("composition: global --system-only fires BEFORE per-side --no-system-a (global error first)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: null }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorPresence: "system_only",
        actorPresenceA: "no_system",
      }),
    ).rejects.toThrow(
      "expected both events to be system-authored (actor_id IS NULL)",
    );
  });

  it("omits per-side actor-presence checks when fields not set (backward compat)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: null }),
        rawEntry(ID_B, { actor_id: ACTOR_ALICE }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryEntries({ idA: ID_A, idB: ID_B });
    expect(result.actorIdA).toBeNull();
    expect(result.actorIdB).toBe(ACTOR_ALICE);
  });

  it("per-side A fires BEFORE per-side B in check order", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawEntry(ID_A, { actor_id: ACTOR_ALICE }),
        rawEntry(ID_B, { actor_id: ACTOR_BOB }),
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryEntries({
        idA: ID_A,
        idB: ID_B,
        actorPresenceA: "system_only",
        actorPresenceB: "system_only",
      }),
    ).rejects.toThrow(
      `expected event A to be system-authored (actor_id IS NULL) but A is '${ACTOR_ALICE}'`,
    );
  });
});

describe("PostgresTraceRetention.diffHistoryTimeline (M6.7.zz.tenant.opt-out.cli.diff-timeline)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";

  function rawRow(
    tenant_id: string,
    overrides: Partial<{
      id: string;
      event_kind: string;
      occurred_at: string;
      next_state: Record<string, unknown> | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      id: "h1",
      tenant_id,
      table_name: "workflow_traces",
      event_kind: "opt_out_set",
      occurred_at: "2026-01-01T00:00:00.000Z",
      prev_state: null,
      next_state: { opt_out: true, retention_days: 365 },
      attributes: {},
      ...overrides,
    };
  }

  it("issues a single query with WHERE (h.tenant_id = $1 OR h.tenant_id = $2) AND h.table_name = $3", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(capture).toHaveLength(1);
    expect(capture[0]?.sql).toContain(
      "(h.tenant_id = $1 OR h.tenant_id = $2)",
    );
    expect(capture[0]?.sql).toContain("h.table_name = $3");
    expect(capture[0]?.params).toEqual([TENANT_A, TENANT_B, "workflow_traces", 100]);
  });

  it("orders by h.occurred_at ASC, h.id ASC (chronological)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).toContain("ORDER BY h.occurred_at ASC, h.id ASC");
  });

  it("tags each entry with tenantSide A or B by matching tenant_id", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawRow(TENANT_A, { id: "h1", occurred_at: "2026-01-01T00:00:00.000Z" }),
        rawRow(TENANT_B, { id: "h2", occurred_at: "2026-01-15T00:00:00.000Z" }),
        rawRow(TENANT_A, { id: "h3", occurred_at: "2026-02-01T00:00:00.000Z" }),
      ],
      rowCount: 3,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]!.tenantSide).toBe("A");
    expect(result.entries[1]!.tenantSide).toBe("B");
    expect(result.entries[2]!.tenantSide).toBe("A");
  });

  it("returns empty entries when no history for either tenant", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(result.entries).toEqual([]);
    expect(result.tenantIdA).toBe(TENANT_A);
    expect(result.tenantIdB).toBe(TENANT_B);
    expect(result.tableName).toBe("workflow_traces");
  });

  it("threads --since filter as 4th param", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      since: "2026-01-01T00:00:00.000Z",
    });
    expect(capture[0]?.sql).toContain("occurred_at >= $4");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      "2026-01-01T00:00:00.000Z",
      100,
    ]);
  });

  it("threads --until filter", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      until: "2026-06-01T00:00:00.000Z",
    });
    expect(capture[0]?.sql).toContain("occurred_at <= $4");
  });

  it("threads --since + --until together", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-06-01T00:00:00.000Z",
    });
    expect(capture[0]?.sql).toContain("occurred_at >= $4");
    expect(capture[0]?.sql).toContain("occurred_at <= $5");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      "2026-01-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
      100,
    ]);
  });

  it("threads custom --limit + default to 100 when omitted", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      limit: 50,
    });
    expect(capture[0]?.params).toEqual([TENANT_A, TENANT_B, "workflow_traces", 50]);
  });

  it("rejects limit < 1", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryTimeline({
        tenantIdA: TENANT_A,
        tenantIdB: TENANT_B,
        tableName: "workflow_traces",
        limit: 0,
      }),
    ).rejects.toThrow("limit must be an integer >= 1");
  });

  it("rejects non-integer limit", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryTimeline({
        tenantIdA: TENANT_A,
        tenantIdB: TENANT_B,
        tableName: "workflow_traces",
        limit: 1.5,
      }),
    ).rejects.toThrow("limit must be an integer >= 1");
  });

  it("throws on unknown event_kind in returned row (schema-drift guard)", async () => {
    const conn = mockConnection(() => ({
      rows: [rawRow(TENANT_A, { event_kind: "unknown_kind" })],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryTimeline({
        tenantIdA: TENANT_A,
        tenantIdB: TENANT_B,
        tableName: "workflow_traces",
      }),
    ).rejects.toThrow("unknown event_kind 'unknown_kind'");
  });

  it("preserves all fields in returned entries (id, occurredAt, prevState, nextState, attributes)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawRow(TENANT_A, {
          id: "h-test",
          occurred_at: "2026-03-15T00:00:00.000Z",
          next_state: { opt_out: true, retention_days: 365 },
        }),
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    const entry = result.entries[0]!;
    expect(entry.id).toBe("h-test");
    expect(entry.tenantId).toBe(TENANT_A);
    expect(entry.tenantSide).toBe("A");
    expect(entry.tableName).toBe("workflow_traces");
    expect(entry.eventKind).toBe("opt_out_set");
    expect(entry.occurredAt).toBe("2026-03-15T00:00:00.000Z");
    expect(entry.prevState).toBeNull();
    expect(entry.nextState).toEqual({ opt_out: true, retention_days: 365 });
    expect(entry.attributes).toEqual({});
  });

  it("omits LEFT JOIN when joinActor is not set (backward compat)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).not.toContain("LEFT JOIN meta.users");
    expect(capture[0]?.sql).not.toContain("actor_display_name");
    expect(capture[0]?.sql).not.toContain("actor_email");
  });

  it("emits LEFT JOIN meta.users when joinActor is true with display_name + email in SELECT", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      joinActor: true,
    });
    expect(capture[0]?.sql).toContain("LEFT JOIN meta.users u ON u.id = h.actor_id");
    expect(capture[0]?.sql).toContain("u.display_name AS actor_display_name");
    expect(capture[0]?.sql).toContain("u.email AS actor_email");
  });

  it("returns actorDisplayName + actorEmail when joinActor=true + user row exists", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          ...rawRow(TENANT_A),
          actor_id: "11111111-1111-1111-1111-111111111111",
          actor_display_name: "Alice Smith",
          actor_email: "alice@example.com",
        },
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      joinActor: true,
    });
    const entry = result.entries[0]!;
    expect(entry.actorId).toBe("11111111-1111-1111-1111-111111111111");
    expect(entry.actorDisplayName).toBe("Alice Smith");
    expect(entry.actorEmail).toBe("alice@example.com");
  });

  it("returns null actorDisplayName + actorEmail when joinActor=true but actor has no user row (orphan FK)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          ...rawRow(TENANT_A),
          actor_id: "22222222-2222-2222-2222-222222222222",
          actor_display_name: null,
          actor_email: null,
        },
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      joinActor: true,
    });
    const entry = result.entries[0]!;
    expect(entry.actorId).toBe("22222222-2222-2222-2222-222222222222");
    expect(entry.actorDisplayName).toBeNull();
    expect(entry.actorEmail).toBeNull();
  });

  it("returns null actorDisplayName + actorEmail when joinActor=true but actor_id is null (system actor)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          ...rawRow(TENANT_A),
          actor_id: null,
          actor_display_name: null,
          actor_email: null,
        },
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      joinActor: true,
    });
    const entry = result.entries[0]!;
    expect(entry.actorId).toBeNull();
    expect(entry.actorDisplayName).toBeNull();
    expect(entry.actorEmail).toBeNull();
  });

  it("omits actorDisplayName + actorEmail fields when joinActor is false (TypeScript undefined)", async () => {
    const conn = mockConnection(() => ({
      rows: [{ ...rawRow(TENANT_A), actor_id: "33333333-3333-3333-3333-333333333333" }],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    const entry = result.entries[0]!;
    expect(entry.actorId).toBe("33333333-3333-3333-3333-333333333333");
    expect(entry.actorDisplayName).toBeUndefined();
    expect(entry.actorEmail).toBeUndefined();
  });
});

describe("PostgresTraceRetention.diffHistoryTimelineNway (M6.7.zz.tenant.opt-out.cli.diff-timeline.add-tenant)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";
  const TENANT_C = "00000000-0000-4000-8000-00000000000C";
  const TENANT_D = "00000000-0000-4000-8000-00000000000D";

  function rawRow(
    tenant_id: string,
    overrides: Partial<{
      id: string;
      event_kind: string;
      occurred_at: string;
      next_state: Record<string, unknown> | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      id: "h1",
      tenant_id,
      table_name: "workflow_traces",
      event_kind: "opt_out_set",
      actor_id: null,
      occurred_at: "2026-01-01T00:00:00.000Z",
      prev_state: null,
      next_state: { opt_out: true, retention_days: 365 },
      attributes: {},
      ...overrides,
    };
  }

  it("rejects fewer than 2 tenantIds", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryTimelineNway({
        tenantIds: [TENANT_A],
        tableName: "workflow_traces",
      }),
    ).rejects.toThrow("at least 2 tenantIds required");
  });

  it("issues a single query with h.tenant_id IN ($1, $2, $3) for 3 tenants", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
    });
    expect(capture).toHaveLength(1);
    expect(capture[0]?.sql).toContain("h.tenant_id IN ($1, $2, $3)");
    expect(capture[0]?.sql).toContain("h.table_name = $4");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      TENANT_C,
      "workflow_traces",
      100,
    ]);
  });

  it("tags each entry with tenantLabel A/B/C from input order", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawRow(TENANT_A, { id: "h1" }),
        rawRow(TENANT_B, { id: "h2" }),
        rawRow(TENANT_C, { id: "h3" }),
      ],
      rowCount: 3,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
    });
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]?.tenantLabel).toBe("A");
    expect(result.entries[1]?.tenantLabel).toBe("B");
    expect(result.entries[2]?.tenantLabel).toBe("C");
  });

  it("assigns T27, T28, ... labels for indices beyond 26", async () => {
    const tenantIds: string[] = [];
    for (let i = 0; i < 28; i++) {
      tenantIds.push(`00000000-0000-4000-8000-0000000000${i.toString(16).padStart(2, "0")}`);
    }
    const conn = mockConnection(() => ({
      rows: [rawRow(tenantIds[26]!, { id: "h-27" }), rawRow(tenantIds[27]!, { id: "h-28" })],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryTimelineNway({
      tenantIds,
      tableName: "workflow_traces",
    });
    expect(result.entries[0]?.tenantLabel).toBe("T27");
    expect(result.entries[1]?.tenantLabel).toBe("T28");
  });

  it("orders by h.occurred_at ASC, h.id ASC (chronological)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).toContain("ORDER BY h.occurred_at ASC, h.id ASC");
  });

  it("returns empty entries when no rows match", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
    });
    expect(result.entries).toEqual([]);
    expect(result.tenantIds).toEqual([TENANT_A, TENANT_B, TENANT_C]);
    expect(result.tableName).toBe("workflow_traces");
  });

  it("threads --since + --until + --limit through (param positions after tenant IN list)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C, TENANT_D],
      tableName: "workflow_traces",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-06-01T00:00:00.000Z",
      limit: 50,
    });
    expect(capture[0]?.sql).toContain("h.occurred_at >= $6");
    expect(capture[0]?.sql).toContain("h.occurred_at <= $7");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      TENANT_C,
      TENANT_D,
      "workflow_traces",
      "2026-01-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
      50,
    ]);
  });

  it("composes with joinActor=true emitting LEFT JOIN + actor cols", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [
          {
            ...rawRow(TENANT_A),
            actor_id: "11111111-1111-1111-1111-111111111111",
            actor_display_name: "Alice Smith",
            actor_email: "alice@example.com",
          },
        ],
        rowCount: 1,
      }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
      joinActor: true,
    });
    expect(capture[0]?.sql).toContain("LEFT JOIN meta.users u ON u.id = h.actor_id");
    const entry = result.entries[0]!;
    expect(entry.actorDisplayName).toBe("Alice Smith");
    expect(entry.actorEmail).toBe("alice@example.com");
  });

  it("rejects limit < 1", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryTimelineNway({
        tenantIds: [TENANT_A, TENANT_B],
        tableName: "workflow_traces",
        limit: 0,
      }),
    ).rejects.toThrow("limit must be an integer >= 1");
  });

  it("throws on unknown event_kind in returned row (schema-drift guard)", async () => {
    const conn = mockConnection(() => ({
      rows: [rawRow(TENANT_A, { event_kind: "unknown_kind" })],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryTimelineNway({
        tenantIds: [TENANT_A, TENANT_B, TENANT_C],
        tableName: "workflow_traces",
      }),
    ).rejects.toThrow("unknown event_kind 'unknown_kind'");
  });

  it("preserves duplicate tenantIds — first occurrence wins the label", async () => {
    const conn = mockConnection(() => ({
      rows: [rawRow(TENANT_A, { id: "h-dup" })],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_A, TENANT_B],
      tableName: "workflow_traces",
    });
    expect(result.entries[0]?.tenantLabel).toBe("A");
  });
});

describe("PostgresTraceRetention.diffHistoryTimelineCrossTable (M6.7.zz.tenant.opt-out.cli.diff-timeline.cross-table)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";

  function rawRow(
    table_name: string,
    overrides: Partial<{
      id: string;
      event_kind: string;
      occurred_at: string;
      next_state: Record<string, unknown> | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      id: "h1",
      tenant_id: TENANT_A,
      table_name,
      event_kind: "opt_out_set",
      actor_id: null,
      occurred_at: "2026-01-01T00:00:00.000Z",
      prev_state: null,
      next_state: { opt_out: true, retention_days: 365 },
      attributes: {},
      ...overrides,
    };
  }

  it("rejects fewer than 2 tableNames", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryTimelineCrossTable({
        tenantId: TENANT_A,
        tableNames: ["workflow_traces"],
      }),
    ).rejects.toThrow("at least 2 tableNames required");
  });

  it("issues a single query with h.table_name IN ($2, $3, $4) + h.tenant_id = $1", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces", "llm_latency_samples"],
    });
    expect(capture).toHaveLength(1);
    expect(capture[0]?.sql).toContain("h.tenant_id = $1");
    expect(capture[0]?.sql).toContain("h.table_name IN ($2, $3, $4)");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "workflow_traces",
      "llm_call_traces",
      "llm_latency_samples",
      100,
    ]);
  });

  it("tags each entry with tableLabel A/B/C from input order", async () => {
    const conn = mockConnection(() => ({
      rows: [
        rawRow("workflow_traces", { id: "h1" }),
        rawRow("llm_call_traces", { id: "h2" }),
        rawRow("llm_latency_samples", { id: "h3" }),
      ],
      rowCount: 3,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces", "llm_latency_samples"],
    });
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]?.tableLabel).toBe("A");
    expect(result.entries[0]?.tableName).toBe("workflow_traces");
    expect(result.entries[1]?.tableLabel).toBe("B");
    expect(result.entries[1]?.tableName).toBe("llm_call_traces");
    expect(result.entries[2]?.tableLabel).toBe("C");
    expect(result.entries[2]?.tableName).toBe("llm_latency_samples");
  });

  it("orders by h.occurred_at ASC, h.id ASC (chronological)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces"],
    });
    expect(capture[0]?.sql).toContain("ORDER BY h.occurred_at ASC, h.id ASC");
  });

  it("returns empty entries when no rows match", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces"],
    });
    expect(result.entries).toEqual([]);
    expect(result.tenantId).toBe(TENANT_A);
    expect(result.tableNames).toEqual(["workflow_traces", "llm_call_traces"]);
  });

  it("threads --since + --until + --limit through (param positions after table IN list)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces", "llm_latency_samples"],
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-06-01T00:00:00.000Z",
      limit: 50,
    });
    expect(capture[0]?.sql).toContain("h.occurred_at >= $5");
    expect(capture[0]?.sql).toContain("h.occurred_at <= $6");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "workflow_traces",
      "llm_call_traces",
      "llm_latency_samples",
      "2026-01-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
      50,
    ]);
  });

  it("composes with joinActor=true emitting LEFT JOIN + actor cols", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [
          {
            ...rawRow("workflow_traces"),
            actor_id: "11111111-1111-1111-1111-111111111111",
            actor_display_name: "Alice Smith",
            actor_email: "alice@example.com",
          },
        ],
        rowCount: 1,
      }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces"],
      joinActor: true,
    });
    expect(capture[0]?.sql).toContain("LEFT JOIN meta.users u ON u.id = h.actor_id");
    const entry = result.entries[0]!;
    expect(entry.actorDisplayName).toBe("Alice Smith");
    expect(entry.actorEmail).toBe("alice@example.com");
  });

  it("rejects limit < 1", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryTimelineCrossTable({
        tenantId: TENANT_A,
        tableNames: ["workflow_traces", "llm_call_traces"],
        limit: 0,
      }),
    ).rejects.toThrow("limit must be an integer >= 1");
  });

  it("throws on unknown event_kind in returned row (schema-drift guard)", async () => {
    const conn = mockConnection(() => ({
      rows: [rawRow("workflow_traces", { event_kind: "unknown_kind" })],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffHistoryTimelineCrossTable({
        tenantId: TENANT_A,
        tableNames: ["workflow_traces", "llm_call_traces"],
      }),
    ).rejects.toThrow("unknown event_kind 'unknown_kind'");
  });

  it("supports the 4-table full-cohort across all prunable tables", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: [
        "workflow_traces",
        "llm_call_traces",
        "llm_latency_samples",
        "tenant_retention_opt_out_history",
      ],
    });
    expect(capture[0]?.sql).toContain("IN ($2, $3, $4, $5)");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "workflow_traces",
      "llm_call_traces",
      "llm_latency_samples",
      "tenant_retention_opt_out_history",
      100,
    ]);
  });
});

describe("PostgresTraceRetention diff-timeline --actor-id filter (M6.7.zz.tenant.opt-out.cli.diff-timeline.actor-filter + .multi-actor)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";
  const TENANT_C = "00000000-0000-4000-8000-00000000000C";
  const ACTOR_A = "11111111-1111-1111-1111-111111111111";
  const ACTOR_B = "22222222-2222-2222-2222-222222222222";

  it("pair-wise: adds h.actor_id IN ($N) WHERE clause when single actorIds is set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      actorIds: [ACTOR_A],
    });
    expect(capture[0]?.sql).toContain("h.actor_id IN ($4)");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      ACTOR_A,
      100,
    ]);
  });

  it("pair-wise: builds h.actor_id IN ($N1, $N2, ...) for multi-actor OR filter", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      actorIds: [ACTOR_A, ACTOR_B],
    });
    expect(capture[0]?.sql).toContain("h.actor_id IN ($4, $5)");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      ACTOR_A,
      ACTOR_B,
      100,
    ]);
  });

  it("pair-wise: omits h.actor_id WHERE clause when actorIds not set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).not.toContain("h.actor_id IN");
  });

  it("pair-wise: omits h.actor_id WHERE clause when actorIds is empty array", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      actorIds: [],
    });
    expect(capture[0]?.sql).not.toContain("h.actor_id IN");
  });

  it("N-way: adds h.actor_id IN WHERE positioned after tenant IN list", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
      actorIds: [ACTOR_A],
    });
    expect(capture[0]?.sql).toContain("h.actor_id IN ($5)");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      TENANT_C,
      "workflow_traces",
      ACTOR_A,
      100,
    ]);
  });

  it("N-way: multi-actor IN clause threads after tenant list", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
      actorIds: [ACTOR_A, ACTOR_B],
    });
    expect(capture[0]?.sql).toContain("h.actor_id IN ($5, $6)");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      TENANT_C,
      "workflow_traces",
      ACTOR_A,
      ACTOR_B,
      100,
    ]);
  });

  it("cross-table: adds h.actor_id IN WHERE positioned after table IN list", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces", "llm_latency_samples"],
      actorIds: [ACTOR_A],
    });
    expect(capture[0]?.sql).toContain("h.actor_id IN ($5)");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "workflow_traces",
      "llm_call_traces",
      "llm_latency_samples",
      ACTOR_A,
      100,
    ]);
  });

  it("cross-table: multi-actor IN clause threads after table list", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces"],
      actorIds: [ACTOR_A, ACTOR_B],
    });
    expect(capture[0]?.sql).toContain("h.actor_id IN ($4, $5)");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "workflow_traces",
      "llm_call_traces",
      ACTOR_A,
      ACTOR_B,
      100,
    ]);
  });

  it("pair-wise: composes actorIds with --since + --until + --limit + joinActor", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      actorIds: [ACTOR_A],
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-06-01T00:00:00.000Z",
      limit: 50,
      joinActor: true,
    });
    expect(capture[0]?.sql).toContain("LEFT JOIN meta.users u ON u.id = h.actor_id");
    expect(capture[0]?.sql).toContain("h.actor_id IN ($4)");
    expect(capture[0]?.sql).toContain("h.occurred_at >= $5");
    expect(capture[0]?.sql).toContain("h.occurred_at <= $6");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      ACTOR_A,
      "2026-01-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
      50,
    ]);
  });

  it("N-way: omits h.actor_id WHERE clause when actorIds not set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).not.toContain("h.actor_id IN");
  });

  it("cross-table: omits h.actor_id WHERE clause when actorIds not set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces"],
    });
    expect(capture[0]?.sql).not.toContain("h.actor_id IN");
  });
});

describe("PostgresTraceRetention diff-timeline --actor-id-not filter (M6.7.zz.tenant.opt-out.cli.diff-timeline.actor-not)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";
  const TENANT_C = "00000000-0000-4000-8000-00000000000C";
  const ACTOR_A = "11111111-1111-4000-8000-111111111111";
  const ACTOR_B = "22222222-2222-4000-8000-222222222222";
  const ACTOR_C = "33333333-3333-4000-8000-333333333333";

  it("pair-wise: single excluded actor adds (h.actor_id IS NULL OR h.actor_id NOT IN ($N)) WHERE clause", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      actorIdsNot: [ACTOR_A],
    });
    expect(capture[0]?.sql).toContain(
      "(h.actor_id IS NULL OR h.actor_id NOT IN ($4))",
    );
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      ACTOR_A,
      100,
    ]);
  });

  it("pair-wise: multi-excluded actors adds NOT IN with multiple placeholders", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      actorIdsNot: [ACTOR_A, ACTOR_B],
    });
    expect(capture[0]?.sql).toContain(
      "(h.actor_id IS NULL OR h.actor_id NOT IN ($4, $5))",
    );
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      ACTOR_A,
      ACTOR_B,
      100,
    ]);
  });

  it("pair-wise: omits actorIdsNot WHERE clause when not set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).not.toContain("NOT IN");
  });

  it("pair-wise: treats empty array as filter-not-set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      actorIdsNot: [],
    });
    expect(capture[0]?.sql).not.toContain("NOT IN");
  });

  it("N-way: single excluded actor positioned after tenant IN list", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
      actorIdsNot: [ACTOR_A],
    });
    expect(capture[0]?.sql).toContain(
      "(h.actor_id IS NULL OR h.actor_id NOT IN ($5))",
    );
  });

  it("N-way: multi-excluded actors with multiple placeholders", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B],
      tableName: "workflow_traces",
      actorIdsNot: [ACTOR_A, ACTOR_B],
    });
    expect(capture[0]?.sql).toContain(
      "(h.actor_id IS NULL OR h.actor_id NOT IN ($4, $5))",
    );
  });

  it("cross-table: single excluded actor positioned after table IN list", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces", "llm_latency_samples"],
      actorIdsNot: [ACTOR_A],
    });
    expect(capture[0]?.sql).toContain(
      "(h.actor_id IS NULL OR h.actor_id NOT IN ($5))",
    );
  });

  it("pair-wise: composes with actorIds (positive + negative both clauses present)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      actorIds: [ACTOR_A],
      actorIdsNot: [ACTOR_B],
    });
    expect(capture[0]?.sql).toContain("h.actor_id IN ($4)");
    expect(capture[0]?.sql).toContain(
      "(h.actor_id IS NULL OR h.actor_id NOT IN ($5))",
    );
  });

  it("pair-wise: composes with joinActor + eventKinds + actorIdsNot", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      actorIdsNot: [ACTOR_C],
      eventKinds: ["opt_out_set"],
      joinActor: true,
    });
    expect(capture[0]?.sql).toContain(
      "LEFT JOIN meta.users u ON u.id = h.actor_id",
    );
    expect(capture[0]?.sql).toContain(
      "(h.actor_id IS NULL OR h.actor_id NOT IN ($4))",
    );
    expect(capture[0]?.sql).toContain("h.event_kind IN ($5)");
  });
});

describe("PostgresTraceRetention diff-timeline actorPresence filter (M6.7.zz.tenant.opt-out.cli.diff-timeline.system-only)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";
  const TENANT_C = "00000000-0000-4000-8000-00000000000C";

  it("pair-wise: adds h.actor_id IS NULL WHERE clause when actorPresence='system_only'", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      actorPresence: "system_only",
    });
    expect(capture[0]?.sql).toContain("h.actor_id IS NULL");
    expect(capture[0]?.sql).not.toContain("h.actor_id IS NOT NULL");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      100,
    ]);
  });

  it("pair-wise: adds h.actor_id IS NOT NULL WHERE clause when actorPresence='no_system'", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      actorPresence: "no_system",
    });
    expect(capture[0]?.sql).toContain("h.actor_id IS NOT NULL");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      100,
    ]);
  });

  it("pair-wise: omits actor-presence WHERE clause when actorPresence not set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).not.toContain("h.actor_id IS NULL");
    expect(capture[0]?.sql).not.toContain("h.actor_id IS NOT NULL");
  });

  it("N-way: adds h.actor_id IS NULL positioned after tenant IN list", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
      actorPresence: "system_only",
    });
    expect(capture[0]?.sql).toContain("h.tenant_id IN ($1, $2, $3)");
    expect(capture[0]?.sql).toContain("h.actor_id IS NULL");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      TENANT_C,
      "workflow_traces",
      100,
    ]);
  });

  it("N-way: adds h.actor_id IS NOT NULL when actorPresence='no_system'", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B],
      tableName: "workflow_traces",
      actorPresence: "no_system",
    });
    expect(capture[0]?.sql).toContain("h.actor_id IS NOT NULL");
  });

  it("cross-table: adds h.actor_id IS NULL positioned after table IN list", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces"],
      actorPresence: "system_only",
    });
    expect(capture[0]?.sql).toContain("h.table_name IN ($2, $3)");
    expect(capture[0]?.sql).toContain("h.actor_id IS NULL");
  });

  it("cross-table: adds h.actor_id IS NOT NULL when actorPresence='no_system'", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces"],
      actorPresence: "no_system",
    });
    expect(capture[0]?.sql).toContain("h.actor_id IS NOT NULL");
  });

  it("pair-wise: composes with actorIds + actorIdsNot + actorPresence + eventKinds + joinActor", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    const ACTOR_X = "11111111-1111-1111-1111-111111111111";
    const ACTOR_Y = "22222222-2222-2222-2222-222222222222";
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      actorIds: [ACTOR_X],
      actorIdsNot: [ACTOR_Y],
      actorPresence: "no_system",
      eventKinds: ["opt_out_set"],
      joinActor: true,
    });
    expect(capture[0]?.sql).toContain("LEFT JOIN meta.users");
    expect(capture[0]?.sql).toContain("h.actor_id IN ($4)");
    expect(capture[0]?.sql).toContain(
      "(h.actor_id IS NULL OR h.actor_id NOT IN ($5))",
    );
    expect(capture[0]?.sql).toContain("h.actor_id IS NOT NULL");
    expect(capture[0]?.sql).toContain("h.event_kind IN ($6)");
  });

  it("pair-wise: adds no params for IS NULL / IS NOT NULL clauses (LIMIT position correct)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      actorPresence: "system_only",
    });
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      100,
    ]);
    expect(capture[0]?.sql).toContain("LIMIT $4");
  });
});

describe("PostgresTraceRetention diff-timeline --kind filter (M6.7.zz.tenant.opt-out.cli.diff-timeline.kind-filter + .multi-kind)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";
  const TENANT_C = "00000000-0000-4000-8000-00000000000C";

  it("pair-wise: adds h.event_kind IN ($N) WHERE clause when single eventKinds is set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      eventKinds: ["opt_out_set"],
    });
    expect(capture[0]?.sql).toContain("h.event_kind IN ($4)");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      "opt_out_set",
      100,
    ]);
  });

  it("pair-wise: builds h.event_kind IN ($N1, $N2, ...) for multi-kind OR filter", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      eventKinds: ["opt_out_set", "opt_out_cleared"],
    });
    expect(capture[0]?.sql).toContain("h.event_kind IN ($4, $5)");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      "opt_out_set",
      "opt_out_cleared",
      100,
    ]);
  });

  it("pair-wise: omits h.event_kind WHERE clause when eventKinds not set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).not.toContain("h.event_kind IN");
  });

  it("pair-wise: omits h.event_kind WHERE clause when eventKinds is empty array", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      eventKinds: [],
    });
    expect(capture[0]?.sql).not.toContain("h.event_kind IN");
  });

  it("N-way: adds h.event_kind IN WHERE positioned after tenant IN list", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
      eventKinds: ["policy_deleted"],
    });
    expect(capture[0]?.sql).toContain("h.event_kind IN ($5)");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      TENANT_C,
      "workflow_traces",
      "policy_deleted",
      100,
    ]);
  });

  it("N-way: multi-kind IN clause threads after tenant list", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
      eventKinds: ["retention_set", "policy_deleted"],
    });
    expect(capture[0]?.sql).toContain("h.event_kind IN ($5, $6)");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      TENANT_C,
      "workflow_traces",
      "retention_set",
      "policy_deleted",
      100,
    ]);
  });

  it("cross-table: adds h.event_kind IN WHERE positioned after table IN list", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces", "llm_latency_samples"],
      eventKinds: ["retention_set"],
    });
    expect(capture[0]?.sql).toContain("h.event_kind IN ($5)");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "workflow_traces",
      "llm_call_traces",
      "llm_latency_samples",
      "retention_set",
      100,
    ]);
  });

  it("cross-table: multi-kind IN clause threads after table list", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces"],
      eventKinds: ["opt_out_set", "opt_out_cleared"],
    });
    expect(capture[0]?.sql).toContain("h.event_kind IN ($4, $5)");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "workflow_traces",
      "llm_call_traces",
      "opt_out_set",
      "opt_out_cleared",
      100,
    ]);
  });

  it("pair-wise: composes eventKinds with actorIds + --since + --until + --limit + joinActor", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    const ACTOR_A = "11111111-1111-1111-1111-111111111111";
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      actorIds: [ACTOR_A],
      eventKinds: ["opt_out_set"],
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-06-01T00:00:00.000Z",
      limit: 50,
      joinActor: true,
    });
    expect(capture[0]?.sql).toContain("LEFT JOIN meta.users u ON u.id = h.actor_id");
    expect(capture[0]?.sql).toContain("h.actor_id IN ($4)");
    expect(capture[0]?.sql).toContain("h.event_kind IN ($5)");
    expect(capture[0]?.sql).toContain("h.occurred_at >= $6");
    expect(capture[0]?.sql).toContain("h.occurred_at <= $7");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      ACTOR_A,
      "opt_out_set",
      "2026-01-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
      50,
    ]);
  });

  it("N-way: omits h.event_kind WHERE when eventKinds not set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).not.toContain("h.event_kind IN");
  });

  it("cross-table: omits h.event_kind WHERE when eventKinds not set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces"],
    });
    expect(capture[0]?.sql).not.toContain("h.event_kind IN");
  });
});

describe("PostgresTraceRetention diff-timeline --kind-not exclusion filter (M6.7.zz.tenant.opt-out.cli.diff-timeline.kind-not.multi)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";
  const TENANT_C = "00000000-0000-4000-8000-00000000000C";

  it("pair-wise: adds h.event_kind NOT IN ($N) when single eventKindsNot is set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      eventKindsNot: ["policy_deleted"],
    });
    expect(capture[0]?.sql).toContain("h.event_kind NOT IN ($4)");
  });

  it("pair-wise: builds h.event_kind NOT IN ($N1, $N2) for multi-kind exclusion", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      eventKindsNot: ["policy_deleted", "retention_set"],
    });
    expect(capture[0]?.sql).toContain("h.event_kind NOT IN ($4, $5)");
  });

  it("pair-wise: composes with eventKinds IN + eventKindsNot NOT IN independently", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      eventKinds: ["opt_out_set"],
      eventKindsNot: ["policy_deleted"],
    });
    expect(capture[0]?.sql).toContain("h.event_kind IN ($4)");
    expect(capture[0]?.sql).toContain("h.event_kind NOT IN ($5)");
  });

  it("pair-wise: omits NOT IN clause when eventKindsNot empty array", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      eventKindsNot: [],
    });
    expect(capture[0]?.sql).not.toContain("NOT IN");
  });

  it("N-way: adds h.event_kind NOT IN when eventKindsNot set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
      eventKindsNot: ["policy_deleted", "retention_set"],
    });
    expect(capture[0]?.sql).toContain("h.event_kind NOT IN");
  });

  it("cross-table: adds h.event_kind NOT IN when eventKindsNot set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "tenant_opt_outs"],
      eventKindsNot: ["policy_deleted"],
    });
    expect(capture[0]?.sql).toContain("h.event_kind NOT IN");
  });
});

describe("PostgresTraceRetention diff-timeline --after-id cursor pagination (M6.7.zz.tenant.opt-out.cli.diff-timeline.cursor)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";
  const TENANT_C = "00000000-0000-4000-8000-00000000000C";
  const AFTER_ID = "50000000-0000-4000-8000-000000000005";

  it("pair-wise: --after-id threads as $N param into compound cursor with > operator (ASC walk-forward)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      afterId: AFTER_ID,
    });
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) >");
    expect(capture[0]?.sql).toContain(
      "SELECT occurred_at FROM meta.tenant_retention_opt_out_history WHERE id = $4",
    );
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      AFTER_ID,
      100,
    ]);
  });

  it("pair-wise: same $N param reused for both subquery lookup and tiebreaker", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      afterId: AFTER_ID,
    });
    const sql = capture[0]?.sql ?? "";
    const matches = sql.match(/\$4/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("pair-wise: omits cursor WHERE clause when afterId not set (backward compat)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).not.toContain("(h.occurred_at, h.id) >");
  });

  it("N-way: --after-id threads positioned after tenant IN list + table param", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
      afterId: AFTER_ID,
    });
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) >");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      TENANT_C,
      "workflow_traces",
      AFTER_ID,
      100,
    ]);
  });

  it("cross-table: --after-id threads positioned after table IN list + tenant param", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces", "llm_latency_samples"],
      afterId: AFTER_ID,
    });
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) >");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "workflow_traces",
      "llm_call_traces",
      "llm_latency_samples",
      AFTER_ID,
      100,
    ]);
  });

  it("pair-wise: composes afterId with actorId + eventKind + --since + --until + --limit", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    const ACTOR_A = "11111111-1111-1111-1111-111111111111";
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      actorIds: [ACTOR_A],
      eventKinds: ["opt_out_set"],
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-06-01T00:00:00.000Z",
      afterId: AFTER_ID,
      limit: 50,
    });
    expect(capture[0]?.sql).toContain("h.actor_id IN ($4)");
    expect(capture[0]?.sql).toContain("h.event_kind IN ($5)");
    expect(capture[0]?.sql).toContain("h.occurred_at >= $6");
    expect(capture[0]?.sql).toContain("h.occurred_at <= $7");
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) >");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      ACTOR_A,
      "opt_out_set",
      "2026-01-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
      AFTER_ID,
      50,
    ]);
  });

  it("N-way: omits cursor WHERE when afterId not set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).not.toContain("(h.occurred_at, h.id) >");
  });

  it("cross-table: omits cursor WHERE when afterId not set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces"],
    });
    expect(capture[0]?.sql).not.toContain("(h.occurred_at, h.id) >");
  });
});

describe("PostgresTraceRetention diff-timeline --before-id reverse cursor (M6.7.zz.tenant.opt-out.cli.diff-timeline.before-id)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";
  const TENANT_C = "00000000-0000-4000-8000-00000000000C";
  const BEFORE_ID = "80000000-0000-4000-8000-000000000008";

  it("pair-wise: --before-id threads as $N param into compound cursor with < operator (ASC walk-backward toward older)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      beforeId: BEFORE_ID,
    });
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) <");
    expect(capture[0]?.sql).toContain(
      "SELECT occurred_at FROM meta.tenant_retention_opt_out_history WHERE id = $4",
    );
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      BEFORE_ID,
      100,
    ]);
  });

  it("pair-wise: same $N param reused for both subquery lookup and tiebreaker", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      beforeId: BEFORE_ID,
    });
    const sql = capture[0]?.sql ?? "";
    const matches = sql.match(/\$4/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("pair-wise: omits beforeId cursor WHERE when not set (backward compat)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).not.toContain("(h.occurred_at, h.id) <");
  });

  it("N-way: --before-id threads positioned after tenant IN list + table param", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
      beforeId: BEFORE_ID,
    });
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) <");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      TENANT_C,
      "workflow_traces",
      BEFORE_ID,
      100,
    ]);
  });

  it("cross-table: --before-id threads positioned after table IN list + tenant param", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces", "llm_latency_samples"],
      beforeId: BEFORE_ID,
    });
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) <");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "workflow_traces",
      "llm_call_traces",
      "llm_latency_samples",
      BEFORE_ID,
      100,
    ]);
  });

  it("pair-wise: composes beforeId with afterId in SAME query (both cursor clauses present — range semantic)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const AFTER_ID = "50000000-0000-4000-8000-000000000005";
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      afterId: AFTER_ID,
      beforeId: BEFORE_ID,
    });
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) >");
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) <");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
      AFTER_ID,
      BEFORE_ID,
      100,
    ]);
  });

  it("N-way: omits beforeId cursor WHERE when not set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
    });
    expect(capture[0]?.sql).not.toContain("(h.occurred_at, h.id) <");
  });

  it("cross-table: omits beforeId cursor WHERE when not set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimelineCrossTable({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces"],
    });
    expect(capture[0]?.sql).not.toContain("(h.occurred_at, h.id) <");
  });

  it("pair-wise: ORDER BY remains h.occurred_at ASC, h.id ASC (no direction reversal)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffHistoryTimeline({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      beforeId: BEFORE_ID,
    });
    expect(capture[0]?.sql).toContain("ORDER BY h.occurred_at ASC, h.id ASC");
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
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) <");
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
    expect(capture[0]?.sql).toContain("ORDER BY h.occurred_at DESC, h.id DESC");
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
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) <");
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
      eventKinds: ["opt_out_set"],
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
    expect(capture[0]?.sql).not.toContain("(h.occurred_at, h.id) <");
    expect(capture[0]?.params).toEqual([10]);
  });
});

describe("PostgresTraceRetention.listOptOutHistory --before-id reverse cursor (M6.7.zz.tenant.opt-out.history.before-id)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const BEFORE_ID = "70000000-0000-4000-8000-000000000007";

  it("--before-id threads as $N param into compound cursor with > operator (reverse direction on DESC ordering)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ beforeId: BEFORE_ID });
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) >");
    expect(capture[0]?.sql).toContain(
      "SELECT occurred_at FROM meta.tenant_retention_opt_out_history WHERE id = $1",
    );
    expect(capture[0]?.params).toEqual([BEFORE_ID, 100]);
  });

  it("compound cursor same $N param reused for both subquery lookup and tiebreaker", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ beforeId: BEFORE_ID });
    const sql = capture[0]?.sql ?? "";
    const matches = sql.match(/\$1/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("omits beforeId cursor WHERE when not set (backward compat)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({});
    expect(capture[0]?.sql).not.toContain("(h.occurred_at, h.id) >");
  });

  it("composes with afterId in the SAME query — both cursor clauses present (range semantic)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const AFTER_ID = "50000000-0000-4000-8000-000000000005";
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ afterId: AFTER_ID, beforeId: BEFORE_ID });
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) <");
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) >");
    expect(capture[0]?.params).toEqual([AFTER_ID, BEFORE_ID, 100]);
  });

  it("composes with all other filters (tenant + table + kind + actor + since + until + beforeId + limit)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const ACTOR_A = "11111111-1111-1111-1111-111111111111";
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      eventKinds: ["opt_out_set"],
      actorIds: [ACTOR_A],
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-06-01T00:00:00.000Z",
      beforeId: BEFORE_ID,
      limit: 50,
    });
    expect(capture[0]?.sql).toContain("h.tenant_id = $1");
    expect(capture[0]?.sql).toContain("h.table_name = $2");
    expect(capture[0]?.sql).toContain("h.event_kind IN ($3)");
    expect(capture[0]?.sql).toContain("h.actor_id IN ($4)");
    expect(capture[0]?.sql).toContain("h.occurred_at >= $5");
    expect(capture[0]?.sql).toContain("h.occurred_at <= $6");
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) >");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "workflow_traces",
      "opt_out_set",
      ACTOR_A,
      "2026-01-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
      BEFORE_ID,
      50,
    ]);
  });

  it("ORDER BY remains h.occurred_at DESC, h.id DESC (no direction reversal)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ beforeId: BEFORE_ID });
    expect(capture[0]?.sql).toContain("ORDER BY h.occurred_at DESC, h.id DESC");
  });
});

describe("PostgresTraceRetention.listOptOutHistory actorIds filter (M6.7.zz.tenant.opt-out.cli.history.actor-filter + actor-filter.multi)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const ACTOR_A = "11111111-1111-4000-8000-111111111111";
  const ACTOR_B = "22222222-2222-4000-8000-222222222222";
  const ACTOR_C = "33333333-3333-4000-8000-333333333333";

  it("adds h.actor_id IN ($1) WHERE clause for single actor", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ actorIds: [ACTOR_A] });
    expect(capture[0]?.sql).toContain("h.actor_id IN ($1)");
    expect(capture[0]?.params).toEqual([ACTOR_A, 100]);
  });

  it("adds h.actor_id IN ($1, $2) for multi-actor OR semantic", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ actorIds: [ACTOR_A, ACTOR_B] });
    expect(capture[0]?.sql).toContain("h.actor_id IN ($1, $2)");
    expect(capture[0]?.params).toEqual([ACTOR_A, ACTOR_B, 100]);
  });

  it("omits actor_id WHERE clause when actorIds is not set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({});
    expect(capture[0]?.sql).not.toContain("h.actor_id IN");
  });

  it("treats empty actorIds array as filter-not-set (no clause emitted)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ actorIds: [] });
    expect(capture[0]?.sql).not.toContain("h.actor_id IN");
    expect(capture[0]?.params).toEqual([100]);
  });

  it("composes with other filters (tenantId + multi-actor)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      tenantId: TENANT_A,
      actorIds: [ACTOR_A, ACTOR_B],
    });
    expect(capture[0]?.sql).toContain("h.tenant_id = $1");
    expect(capture[0]?.sql).toContain("h.actor_id IN ($2, $3)");
    expect(capture[0]?.params).toEqual([TENANT_A, ACTOR_A, ACTOR_B, 100]);
  });

  it("composes with joinActor (actor-id filter + LEFT JOIN names)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      actorIds: [ACTOR_A, ACTOR_B],
      joinActor: true,
    });
    expect(capture[0]?.sql).toContain("LEFT JOIN meta.users");
    expect(capture[0]?.sql).toContain("h.actor_id IN ($1, $2)");
  });

  it("composes with actorIdsNot (positive + negative both threaded)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      actorIds: [ACTOR_A, ACTOR_B],
      actorIdsNot: [ACTOR_C],
    });
    expect(capture[0]?.sql).toContain("h.actor_id IN ($1, $2)");
    expect(capture[0]?.sql).toContain(
      "(h.actor_id IS NULL OR h.actor_id NOT IN ($3))",
    );
    expect(capture[0]?.params).toEqual([ACTOR_A, ACTOR_B, ACTOR_C, 100]);
  });

  it("composes with all filter dimensions (tenant + table + kind + multi-actor + since + until + afterId)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      eventKinds: ["opt_out_set"],
      actorIds: [ACTOR_A, ACTOR_B],
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-06-01T00:00:00.000Z",
      afterId: "00000000-0000-0000-0000-000000000001",
      limit: 50,
    });
    expect(capture[0]?.sql).toContain("h.tenant_id = $1");
    expect(capture[0]?.sql).toContain("h.table_name = $2");
    expect(capture[0]?.sql).toContain("h.event_kind IN ($3)");
    expect(capture[0]?.sql).toContain("h.actor_id IN ($4, $5)");
    expect(capture[0]?.sql).toContain("h.occurred_at >= $6");
    expect(capture[0]?.sql).toContain("h.occurred_at <= $7");
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) <");
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "workflow_traces",
      "opt_out_set",
      ACTOR_A,
      ACTOR_B,
      "2026-01-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
      "00000000-0000-0000-0000-000000000001",
      50,
    ]);
  });

  it("returns only rows matching the actors (substrate verifies WHERE filter)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          id: "h1",
          tenant_id: TENANT_A,
          table_name: "workflow_traces",
          event_kind: "opt_out_set",
          actor_id: ACTOR_A,
          occurred_at: "2026-05-21T00:00:00.000Z",
          prev_state: null,
          next_state: { opt_out: true },
          attributes: {},
        },
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const entries = await r.listOptOutHistory({
      actorIds: [ACTOR_A, ACTOR_B],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorId).toBe(ACTOR_A);
  });

  it("returns empty array when filtered actors have no rows", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const entries = await r.listOptOutHistory({ actorIds: [ACTOR_B] });
    expect(entries).toEqual([]);
  });

  it("treats duplicate actorIds values as duplicate placeholders (PG dedupes via IN)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ actorIds: [ACTOR_A, ACTOR_A] });
    expect(capture[0]?.sql).toContain("h.actor_id IN ($1, $2)");
    expect(capture[0]?.params).toEqual([ACTOR_A, ACTOR_A, 100]);
  });
});

describe("PostgresTraceRetention.listOptOutHistory actorIdsNot filter (M6.7.zz.tenant.opt-out.cli.history.actor-not + actor-not.multi)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const ACTOR_A = "11111111-1111-4000-8000-111111111111";
  const ACTOR_B = "22222222-2222-4000-8000-222222222222";
  const ACTOR_C = "33333333-3333-4000-8000-333333333333";

  it("adds (h.actor_id IS NULL OR h.actor_id NOT IN ($1)) WHERE clause for single excluded actor", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ actorIdsNot: [ACTOR_A] });
    expect(capture[0]?.sql).toContain(
      "(h.actor_id IS NULL OR h.actor_id NOT IN ($1))",
    );
    expect(capture[0]?.params).toEqual([ACTOR_A, 100]);
  });

  it("adds NOT IN ($1, $2) with two placeholders for multi-excluded actors", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ actorIdsNot: [ACTOR_A, ACTOR_B] });
    expect(capture[0]?.sql).toContain(
      "(h.actor_id IS NULL OR h.actor_id NOT IN ($1, $2))",
    );
    expect(capture[0]?.params).toEqual([ACTOR_A, ACTOR_B, 100]);
  });

  it("omits actorIdsNot WHERE clause when actorIdsNot is not set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({});
    expect(capture[0]?.sql).not.toContain("h.actor_id NOT IN");
  });

  it("treats empty actorIdsNot array as filter-not-set (no clause emitted)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ actorIdsNot: [] });
    expect(capture[0]?.sql).not.toContain("h.actor_id NOT IN");
    expect(capture[0]?.params).toEqual([100]);
  });

  it("includes system events (null actor_id) when filtering with actorIdsNot", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ actorIdsNot: [ACTOR_A] });
    expect(capture[0]?.sql).toContain("h.actor_id IS NULL");
  });

  it("composes with tenantId (both filters present)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      tenantId: TENANT_A,
      actorIdsNot: [ACTOR_A, ACTOR_B],
    });
    expect(capture[0]?.sql).toContain("h.tenant_id = $1");
    expect(capture[0]?.sql).toContain(
      "(h.actor_id IS NULL OR h.actor_id NOT IN ($2, $3))",
    );
    expect(capture[0]?.params).toEqual([TENANT_A, ACTOR_A, ACTOR_B, 100]);
  });

  it("composes with actorIds (positive + negative both present — contradictory but adapter doesn't enforce)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      actorIds: [ACTOR_A],
      actorIdsNot: [ACTOR_B],
    });
    expect(capture[0]?.sql).toContain("h.actor_id IN ($1)");
    expect(capture[0]?.sql).toContain(
      "(h.actor_id IS NULL OR h.actor_id NOT IN ($2))",
    );
    expect(capture[0]?.params).toEqual([ACTOR_A, ACTOR_B, 100]);
  });

  it("composes with joinActor + actorIdsNot (LEFT JOIN + WHERE clause both present)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      actorIdsNot: [ACTOR_A, ACTOR_B],
      joinActor: true,
    });
    expect(capture[0]?.sql).toContain(
      "LEFT JOIN meta.users u ON u.id = h.actor_id",
    );
    expect(capture[0]?.sql).toContain(
      "(h.actor_id IS NULL OR h.actor_id NOT IN ($1, $2))",
    );
  });

  it("composes with all filter dimensions (multi-actor exclusion)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      eventKinds: ["opt_out_set"],
      actorIdsNot: [ACTOR_B, ACTOR_C],
      since: "2026-05-01T00:00:00.000Z",
      until: "2026-05-31T00:00:00.000Z",
      limit: 50,
    });
    expect(capture[0]?.params).toEqual([
      TENANT_A,
      "workflow_traces",
      "opt_out_set",
      ACTOR_B,
      ACTOR_C,
      "2026-05-01T00:00:00.000Z",
      "2026-05-31T00:00:00.000Z",
      50,
    ]);
  });

  it("returns rows excluding the listed actors when adapter returns filtered results", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          tenant_id: TENANT_A,
          table_name: "workflow_traces",
          event_kind: "opt_out_set",
          actor_id: ACTOR_C,
          occurred_at: "2026-05-22T12:00:00.000Z",
          prev_state: null,
          next_state: { opt_out: true },
          attributes: {},
        },
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const entries = await r.listOptOutHistory({
      actorIdsNot: [ACTOR_A, ACTOR_B],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorId).toBe(ACTOR_C);
  });

  it("treats duplicate actorIdsNot values as duplicate placeholders (PG dedupes via NOT IN)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ actorIdsNot: [ACTOR_A, ACTOR_A] });
    expect(capture[0]?.sql).toContain(
      "(h.actor_id IS NULL OR h.actor_id NOT IN ($1, $2))",
    );
    expect(capture[0]?.params).toEqual([ACTOR_A, ACTOR_A, 100]);
  });
});

describe("PostgresTraceRetention.listOptOutHistory actorPresence filter (M6.7.zz.tenant.opt-out.cli.history.system-only)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const ACTOR_A = "11111111-1111-4000-8000-111111111111";

  it("adds h.actor_id IS NULL WHERE clause when actorPresence='system_only'", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ actorPresence: "system_only" });
    expect(capture[0]?.sql).toContain("h.actor_id IS NULL");
    expect(capture[0]?.sql).not.toContain("h.actor_id IS NOT NULL");
    expect(capture[0]?.params).toEqual([100]);
  });

  it("adds h.actor_id IS NOT NULL WHERE clause when actorPresence='no_system'", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ actorPresence: "no_system" });
    expect(capture[0]?.sql).toContain("h.actor_id IS NOT NULL");
    expect(capture[0]?.params).toEqual([100]);
  });

  it("omits actor-presence WHERE clause when actorPresence is not set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({});
    expect(capture[0]?.sql).not.toContain("h.actor_id IS NULL");
    expect(capture[0]?.sql).not.toContain("h.actor_id IS NOT NULL");
  });

  it("adds no params for IS NULL/IS NOT NULL clauses (no placeholder pollution)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      tenantId: TENANT_A,
      actorPresence: "system_only",
    });
    expect(capture[0]?.params).toEqual([TENANT_A, 100]);
    expect(capture[0]?.sql).toContain("h.tenant_id = $1");
    expect(capture[0]?.sql).toContain("h.actor_id IS NULL");
    expect(capture[0]?.sql).toContain("LIMIT $2");
  });

  it("composes with tenantId + tableName (system_only)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      actorPresence: "system_only",
    });
    expect(capture[0]?.sql).toContain("h.tenant_id = $1");
    expect(capture[0]?.sql).toContain("h.table_name = $2");
    expect(capture[0]?.sql).toContain("h.actor_id IS NULL");
    expect(capture[0]?.params).toEqual([TENANT_A, "workflow_traces", 100]);
  });

  it("composes with actorIdsNot + no_system (redundant but valid)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      actorIdsNot: [ACTOR_A],
      actorPresence: "no_system",
    });
    expect(capture[0]?.sql).toContain(
      "(h.actor_id IS NULL OR h.actor_id NOT IN ($1))",
    );
    expect(capture[0]?.sql).toContain("h.actor_id IS NOT NULL");
    expect(capture[0]?.params).toEqual([ACTOR_A, 100]);
  });

  it("composes with joinActor + actorPresence (LEFT JOIN + IS NULL both present)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      actorPresence: "system_only",
      joinActor: true,
    });
    expect(capture[0]?.sql).toContain(
      "LEFT JOIN meta.users u ON u.id = h.actor_id",
    );
    expect(capture[0]?.sql).toContain("h.actor_id IS NULL");
  });

  it("returns rows with null actor_id when system_only filter matches", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          tenant_id: TENANT_A,
          table_name: "workflow_traces",
          event_kind: "opt_out_set",
          actor_id: null,
          occurred_at: "2026-05-22T12:00:00.000Z",
          prev_state: null,
          next_state: { opt_out: true },
          attributes: {},
        },
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const entries = await r.listOptOutHistory({
      actorPresence: "system_only",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorId).toBeNull();
  });
});

describe("PostgresTraceRetention.listOptOutHistory joinActor (M6.7.zz.tenant.opt-out.history.actor-join)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const ACTOR_A = "11111111-1111-4000-8000-111111111111";
  const ACTOR_B = "22222222-2222-4000-8000-222222222222";

  it("omits LEFT JOIN when joinActor is false / not set", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ tenantId: TENANT_A });
    expect(capture[0]?.sql).not.toContain("LEFT JOIN meta.users");
    expect(capture[0]?.sql).not.toContain("actor_display_name");
  });

  it("emits LEFT JOIN meta.users when joinActor=true", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({ tenantId: TENANT_A, joinActor: true });
    expect(capture[0]?.sql).toContain("LEFT JOIN meta.users u ON u.id = h.actor_id");
    expect(capture[0]?.sql).toContain("u.display_name AS actor_display_name");
    expect(capture[0]?.sql).toContain("u.email AS actor_email");
  });

  it("returns actorDisplayName + actorEmail when joinActor=true and user row exists", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          id: "h1",
          tenant_id: TENANT_A,
          table_name: "workflow_traces",
          event_kind: "opt_out_set",
          actor_id: ACTOR_A,
          actor_display_name: "Alice Smith",
          actor_email: "alice@example.com",
          occurred_at: "2026-05-21T00:00:00.000Z",
          prev_state: null,
          next_state: { opt_out: true },
          attributes: {},
        },
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const entries = await r.listOptOutHistory({ joinActor: true });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorId).toBe(ACTOR_A);
    expect(entries[0]?.actorDisplayName).toBe("Alice Smith");
    expect(entries[0]?.actorEmail).toBe("alice@example.com");
  });

  it("returns null for actorDisplayName + actorEmail when joinActor=true but actor has no user row (orphan FK)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          id: "h1",
          tenant_id: TENANT_A,
          table_name: "workflow_traces",
          event_kind: "opt_out_set",
          actor_id: ACTOR_A,
          actor_display_name: null,
          actor_email: null,
          occurred_at: "2026-05-21T00:00:00.000Z",
          prev_state: null,
          next_state: { opt_out: true },
          attributes: {},
        },
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const entries = await r.listOptOutHistory({ joinActor: true });
    expect(entries[0]?.actorId).toBe(ACTOR_A);
    expect(entries[0]?.actorDisplayName).toBeNull();
    expect(entries[0]?.actorEmail).toBeNull();
  });

  it("returns null for actorDisplayName + actorEmail when actor_id is null (system actor)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          id: "h1",
          tenant_id: TENANT_A,
          table_name: "workflow_traces",
          event_kind: "opt_out_set",
          actor_id: null,
          actor_display_name: null,
          actor_email: null,
          occurred_at: "2026-05-21T00:00:00.000Z",
          prev_state: null,
          next_state: { opt_out: true },
          attributes: {},
        },
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const entries = await r.listOptOutHistory({ joinActor: true });
    expect(entries[0]?.actorId).toBeNull();
    expect(entries[0]?.actorDisplayName).toBeNull();
    expect(entries[0]?.actorEmail).toBeNull();
  });

  it("omits actorDisplayName + actorEmail fields when joinActor is false", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          id: "h1",
          tenant_id: TENANT_A,
          table_name: "workflow_traces",
          event_kind: "opt_out_set",
          actor_id: ACTOR_A,
          occurred_at: "2026-05-21T00:00:00.000Z",
          prev_state: null,
          next_state: { opt_out: true },
          attributes: {},
        },
      ],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const entries = await r.listOptOutHistory({});
    expect(entries[0]?.actorId).toBe(ACTOR_A);
    expect(entries[0]?.actorDisplayName).toBeUndefined();
    expect(entries[0]?.actorEmail).toBeUndefined();
  });

  it("LEFT JOIN preserves history rows even when user has been deleted (orphan FK)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          id: "h1",
          tenant_id: TENANT_A,
          table_name: "workflow_traces",
          event_kind: "opt_out_set",
          actor_id: ACTOR_A,
          actor_display_name: "Alice",
          actor_email: "alice@example.com",
          occurred_at: "2026-05-21T00:00:00.000Z",
          prev_state: null,
          next_state: { opt_out: true },
          attributes: {},
        },
        {
          id: "h2",
          tenant_id: TENANT_A,
          table_name: "workflow_traces",
          event_kind: "opt_out_cleared",
          actor_id: ACTOR_B,
          actor_display_name: null,
          actor_email: null,
          occurred_at: "2026-05-21T01:00:00.000Z",
          prev_state: { opt_out: true },
          next_state: { opt_out: false },
          attributes: {},
        },
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const entries = await r.listOptOutHistory({ joinActor: true });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.actorDisplayName).toBe("Alice");
    expect(entries[1]?.actorDisplayName).toBeNull();
  });

  it("composes with other filters (tenantId + tableName + joinActor)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      joinActor: true,
    });
    expect(capture[0]?.sql).toContain("LEFT JOIN meta.users");
    expect(capture[0]?.sql).toContain("h.tenant_id = $1");
    expect(capture[0]?.sql).toContain("h.table_name = $2");
    expect(capture[0]?.params).toEqual([TENANT_A, "workflow_traces", 100]);
  });

  it("composes with cursor pagination (joinActor + afterId)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.listOptOutHistory({
      afterId: "00000000-0000-0000-0000-000000000001",
      joinActor: true,
    });
    expect(capture[0]?.sql).toContain("LEFT JOIN meta.users");
    expect(capture[0]?.sql).toContain("(h.occurred_at, h.id) <");
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

describe("PostgresTraceRetention.effectiveRetentionBatch (M6.7.zz.tenant.batch)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";

  it("returns empty Map when pairs is empty", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetentionBatch({ pairs: [] });
    expect(result.size).toBe(0);
  });

  it("issues exactly 2 queries (tenant + platform) when pairs are present", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.effectiveRetentionBatch({
      pairs: [
        { tenantId: TENANT_A, tableName: "workflow_traces" },
        { tenantId: TENANT_B, tableName: "llm_call_traces" },
      ],
    });
    expect(capture).toHaveLength(2);
  });

  it("tenant query uses (tenant_id, table_name) IN tuple list", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.effectiveRetentionBatch({
      pairs: [
        { tenantId: TENANT_A, tableName: "workflow_traces" },
        { tenantId: TENANT_B, tableName: "llm_call_traces" },
      ],
    });
    const tenantCall = capture.find((c) =>
      c.sql.includes("FROM meta.tenant_retention_policies"),
    );
    expect(tenantCall?.sql).toContain("(tenant_id, table_name) IN");
    expect(tenantCall?.params).toEqual([
      TENANT_A,
      "workflow_traces",
      TENANT_B,
      "llm_call_traces",
    ]);
  });

  it("platform query uses table_name IN list (unique tables only)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.effectiveRetentionBatch({
      pairs: [
        { tenantId: TENANT_A, tableName: "workflow_traces" },
        { tenantId: TENANT_B, tableName: "workflow_traces" }, // same table
      ],
    });
    const platformCall = capture.find(
      (c) =>
        c.sql.includes("FROM meta.retention_policies") &&
        !c.sql.includes("FROM meta.tenant_retention_policies"),
    );
    expect(platformCall?.sql).toContain("WHERE table_name IN");
    expect(platformCall?.params).toEqual(["workflow_traces"]);
  });

  it("deduplicates input pairs in the result Map", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetentionBatch({
      pairs: [
        { tenantId: TENANT_A, tableName: "workflow_traces" },
        { tenantId: TENANT_A, tableName: "workflow_traces" }, // duplicate
        { tenantId: TENANT_A, tableName: "workflow_traces" }, // duplicate
      ],
    });
    expect(result.size).toBe(1);
  });

  it("resolves tenant variant when tenant policy exists + enabled", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
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
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetentionBatch({
      pairs: [{ tenantId: TENANT_A, tableName: "workflow_traces" }],
    });
    const key = effectiveRetentionKey(TENANT_A, "workflow_traces");
    expect(result.get(key)).toEqual({
      source: "tenant",
      retentionDays: 30,
      enabled: true,
      tenantId: TENANT_A,
    });
  });

  it("resolves tenant_opt_out variant when opt_out=true + active", async () => {
    const NOW = Date.parse("2026-05-20T12:00:00.000Z");
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            {
              tenant_id: TENANT_A,
              table_name: "workflow_traces",
              retention_days: 365,
              enabled: false,
              opt_out: true,
              opt_out_reason: "legal_hold:case#42",
              opt_out_until: "2027-01-01T00:00:00.000Z",
              last_pruned_at: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({
      conn,
      clock: () => NOW,
    });
    const result = await r.effectiveRetentionBatch({
      pairs: [{ tenantId: TENANT_A, tableName: "workflow_traces" }],
    });
    const key = effectiveRetentionKey(TENANT_A, "workflow_traces");
    const resolution = result.get(key);
    expect(resolution?.source).toBe("tenant_opt_out");
    if (resolution?.source === "tenant_opt_out") {
      expect(resolution.optOutReason).toBe("legal_hold:case#42");
    }
  });

  it("expired opt_out falls through to platform", async () => {
    const NOW = Date.parse("2026-05-20T12:00:00.000Z");
    const PAST = "2025-01-01T00:00:00.000Z";
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            {
              tenant_id: TENANT_A,
              table_name: "workflow_traces",
              retention_days: 365,
              enabled: false,
              opt_out: true,
              opt_out_reason: null,
              opt_out_until: PAST,
              last_pruned_at: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [
            {
              table_name: "workflow_traces",
              retention_days: 90,
              enabled: true,
              last_pruned_at: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn, clock: () => NOW });
    const result = await r.effectiveRetentionBatch({
      pairs: [{ tenantId: TENANT_A, tableName: "workflow_traces" }],
    });
    const key = effectiveRetentionKey(TENANT_A, "workflow_traces");
    expect(result.get(key)?.source).toBe("platform");
  });

  it("resolves platform variant when no tenant policy + platform exists", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [
            {
              table_name: "workflow_traces",
              retention_days: 90,
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
    const result = await r.effectiveRetentionBatch({
      pairs: [{ tenantId: TENANT_A, tableName: "workflow_traces" }],
    });
    const key = effectiveRetentionKey(TENANT_A, "workflow_traces");
    expect(result.get(key)).toEqual({
      source: "platform",
      retentionDays: 90,
      enabled: true,
    });
  });

  it("resolves none variant when neither tenant nor platform policy exists", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.effectiveRetentionBatch({
      pairs: [{ tenantId: TENANT_A, tableName: "workflow_traces" }],
    });
    const key = effectiveRetentionKey(TENANT_A, "workflow_traces");
    expect(result.get(key)).toEqual({
      source: "none",
      retentionDays: null,
      enabled: false,
    });
  });

  it("resolves mixed variants in one batch correctly", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
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
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [
            {
              table_name: "llm_call_traces",
              retention_days: 180,
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
    const result = await r.effectiveRetentionBatch({
      pairs: [
        { tenantId: TENANT_A, tableName: "workflow_traces" }, // tenant
        { tenantId: TENANT_B, tableName: "llm_call_traces" }, // platform
        { tenantId: TENANT_B, tableName: "workflow_traces" }, // none (no platform for workflow_traces, no tenant policy for B)
      ],
    });
    expect(
      result.get(effectiveRetentionKey(TENANT_A, "workflow_traces"))?.source,
    ).toBe("tenant");
    expect(
      result.get(effectiveRetentionKey(TENANT_B, "llm_call_traces"))?.source,
    ).toBe("platform");
    expect(
      result.get(effectiveRetentionKey(TENANT_B, "workflow_traces"))?.source,
    ).toBe("none");
  });

  it("uses Promise.all for parallel adapter calls (single round-trip wall time)", async () => {
    const callOrder: string[] = [];
    const conn = mockConnection((sql) => {
      callOrder.push(
        sql.includes("tenant_retention_policies") ? "tenant" : "platform",
      );
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    await r.effectiveRetentionBatch({
      pairs: [{ tenantId: TENANT_A, tableName: "workflow_traces" }],
    });
    expect(callOrder).toHaveLength(2);
    expect(new Set(callOrder)).toEqual(new Set(["tenant", "platform"]));
  });

  it("key format is `${tenantId}:${tableName}` (exported helper)", () => {
    expect(effectiveRetentionKey(TENANT_A, "workflow_traces")).toBe(
      `${TENANT_A}:workflow_traces`,
    );
  });
});

describe("PostgresTraceRetention.diffTenantPolicies (M6.7.zz.tenant.opt-out.cli.diff)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";

  function platformRow(
    overrides: Partial<{
      table_name: string;
      retention_days: number;
      enabled: boolean;
    }> = {},
  ): Record<string, unknown> {
    return {
      table_name: "workflow_traces",
      retention_days: 90,
      enabled: true,
      last_pruned_at: null,
      ...overrides,
    };
  }

  function tenantRow(
    overrides: Partial<{
      tenant_id: string;
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

  it("uses effectiveRetentionBatch internally — issues exactly 2 queries", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.diffTenantPolicies({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(capture).toHaveLength(2);
  });

  it("returns metadata + resolutions + empty fieldDiffs when both resolve to none", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantPolicies({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(result.tenantIdA).toBe(TENANT_A);
    expect(result.tenantIdB).toBe(TENANT_B);
    expect(result.tableName).toBe("workflow_traces");
    expect(result.resolutionA.source).toBe("none");
    expect(result.resolutionB.source).toBe("none");
    expect(result.fieldDiffs).toEqual([]);
  });

  it("returns empty fieldDiffs when both tenants have identical platform resolution", async () => {
    const conn = mockConnection((sql) => {
      if (
        sql.includes("FROM meta.retention_policies") &&
        !sql.includes("FROM meta.tenant_retention_policies")
      ) {
        return { rows: [platformRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantPolicies({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(result.resolutionA.source).toBe("platform");
    expect(result.resolutionB.source).toBe("platform");
    expect(result.fieldDiffs).toEqual([]);
  });

  it("returns fieldDiffs when tenant resolutions differ (tenant vs platform)", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [tenantRow({ tenant_id: TENANT_A, retention_days: 30 })],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [platformRow({ retention_days: 90 })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantPolicies({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(result.resolutionA.source).toBe("tenant");
    expect(result.resolutionB.source).toBe("platform");
    const fields = result.fieldDiffs.map((d) => d.field);
    expect(fields).toContain("source");
    expect(fields).toContain("retention_days");
  });

  it("returns fieldDiffs comparing tenant_opt_out vs tenant", async () => {
    const NOW = Date.parse("2026-05-20T12:00:00.000Z");
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            tenantRow({
              tenant_id: TENANT_A,
              retention_days: 365,
              enabled: false,
              opt_out: true,
              opt_out_reason: "legal_hold:case#42",
              opt_out_until: "2027-01-01T00:00:00.000Z",
            }),
            tenantRow({
              tenant_id: TENANT_B,
              retention_days: 30,
              enabled: true,
            }),
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn, clock: () => NOW });
    const result = await r.diffTenantPolicies({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(result.resolutionA.source).toBe("tenant_opt_out");
    expect(result.resolutionB.source).toBe("tenant");
    const fields = result.fieldDiffs.map((d) => d.field);
    expect(fields).toContain("source");
    expect(fields).toContain("opt_out");
    expect(fields).toContain("opt_out_reason");
    expect(fields).toContain("opt_out_until");
  });

  it("fieldDiffs sorted alphabetically", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [tenantRow({ tenant_id: TENANT_A })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantPolicies({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    const fields = result.fieldDiffs.map((d) => d.field);
    expect(fields).toEqual([...fields].sort());
  });

  it("resolutionA carries TENANT_A's resolution and resolutionB carries TENANT_B's", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            tenantRow({ tenant_id: TENANT_A, retention_days: 30 }),
            tenantRow({ tenant_id: TENANT_B, retention_days: 60 }),
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantPolicies({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    if (
      result.resolutionA.source !== "tenant" ||
      result.resolutionB.source !== "tenant"
    ) {
      throw new Error("expected both to resolve to tenant");
    }
    expect(result.resolutionA.retentionDays).toBe(30);
    expect(result.resolutionB.retentionDays).toBe(60);
    expect(result.resolutionA.tenantId).toBe(TENANT_A);
    expect(result.resolutionB.tenantId).toBe(TENANT_B);
  });

  it("uses table_name on both axes (same table for both tenants)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [], rowCount: 0 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    await r.diffTenantPolicies({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "llm_call_traces",
    });
    const tenantCall = capture.find((c) =>
      c.sql.includes("FROM meta.tenant_retention_policies"),
    );
    expect(tenantCall?.params).toEqual([
      TENANT_A,
      "llm_call_traces",
      TENANT_B,
      "llm_call_traces",
    ]);
    const platformCall = capture.find(
      (c) =>
        c.sql.includes("FROM meta.retention_policies") &&
        !c.sql.includes("FROM meta.tenant_retention_policies"),
    );
    expect(platformCall?.params).toEqual(["llm_call_traces"]);
  });

  it("clock-aware expiry preserved (expired opt_out falls through to platform on diff)", async () => {
    const NOW = Date.parse("2026-05-20T12:00:00.000Z");
    const PAST = "2025-01-01T00:00:00.000Z";
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            tenantRow({
              tenant_id: TENANT_A,
              retention_days: 365,
              enabled: false,
              opt_out: true,
              opt_out_until: PAST,
            }),
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return { rows: [platformRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn, clock: () => NOW });
    const result = await r.diffTenantPolicies({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(result.resolutionA.source).toBe("platform");
    expect(result.resolutionB.source).toBe("platform");
    expect(result.fieldDiffs).toEqual([]);
  });
});

describe("PostgresTraceRetention.diffTenantTables (M6.7.zz.tenant.opt-out.cli.diff.cross-table)", () => {
  const TENANT = "00000000-0000-4000-8000-00000000000D";

  function platformRow(
    table_name: string,
    overrides: Partial<{
      retention_days: number;
      enabled: boolean;
    }> = {},
  ): Record<string, unknown> {
    return {
      table_name,
      retention_days: 90,
      enabled: true,
      last_pruned_at: null,
      ...overrides,
    };
  }

  function tenantRow(
    table_name: string,
    overrides: Partial<{
      retention_days: number;
      enabled: boolean;
      opt_out: boolean;
      opt_out_reason: string | null;
      opt_out_until: string | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      tenant_id: TENANT,
      table_name,
      retention_days: 30,
      enabled: true,
      opt_out: false,
      opt_out_reason: null,
      opt_out_until: null,
      last_pruned_at: null,
      ...overrides,
    };
  }

  it("composes on effectiveRetentionBatch — issues exactly 2 queries", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffTenantTables({
      tenantId: TENANT,
      tableNameA: "workflow_traces",
      tableNameB: "llm_call_traces",
    });
    expect(capture).toHaveLength(2);
  });

  it("returns metadata + resolutions + empty fieldDiffs when both resolve to none", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantTables({
      tenantId: TENANT,
      tableNameA: "workflow_traces",
      tableNameB: "llm_call_traces",
    });
    expect(result.tenantId).toBe(TENANT);
    expect(result.tableNameA).toBe("workflow_traces");
    expect(result.tableNameB).toBe("llm_call_traces");
    expect(result.resolutionA.source).toBe("none");
    expect(result.resolutionB.source).toBe("none");
    expect(result.fieldDiffs).toEqual([]);
  });

  it("returns empty fieldDiffs when both tables resolve to identical platform retention", async () => {
    const conn = mockConnection((sql) => {
      if (
        sql.includes("FROM meta.retention_policies") &&
        !sql.includes("FROM meta.tenant_retention_policies")
      ) {
        return {
          rows: [
            platformRow("workflow_traces", { retention_days: 90 }),
            platformRow("llm_call_traces", { retention_days: 90 }),
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantTables({
      tenantId: TENANT,
      tableNameA: "workflow_traces",
      tableNameB: "llm_call_traces",
    });
    expect(result.resolutionA.source).toBe("platform");
    expect(result.resolutionB.source).toBe("platform");
    expect(result.fieldDiffs).toEqual([]);
  });

  it("returns fieldDiffs when retention differs across tables (tenant override on one, platform on other)", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [tenantRow("workflow_traces", { retention_days: 30 })],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [
            platformRow("workflow_traces", { retention_days: 7 }),
            platformRow("llm_call_traces", { retention_days: 365 }),
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantTables({
      tenantId: TENANT,
      tableNameA: "workflow_traces",
      tableNameB: "llm_call_traces",
    });
    expect(result.resolutionA.source).toBe("tenant");
    expect(result.resolutionB.source).toBe("platform");
    const fields = result.fieldDiffs.map((d) => d.field);
    expect(fields).toContain("source");
    expect(fields).toContain("retention_days");
  });

  it("returns fieldDiffs comparing tenant_opt_out on table A vs tenant on table B", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            tenantRow("workflow_traces", {
              enabled: false,
              opt_out: true,
              opt_out_reason: "legal_hold",
              opt_out_until: "2099-01-01T00:00:00.000Z",
            }),
            tenantRow("llm_call_traces", { retention_days: 30 }),
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantTables({
      tenantId: TENANT,
      tableNameA: "workflow_traces",
      tableNameB: "llm_call_traces",
    });
    expect(result.resolutionA.source).toBe("tenant_opt_out");
    expect(result.resolutionB.source).toBe("tenant");
    const fields = result.fieldDiffs.map((d) => d.field);
    expect(fields).toContain("source");
    expect(fields).toContain("opt_out");
    expect(fields).toContain("opt_out_reason");
    expect(fields).toContain("opt_out_until");
  });

  it("resolutionA carries A's data and resolutionB carries B's", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [
            platformRow("workflow_traces", { retention_days: 30 }),
            platformRow("llm_call_traces", { retention_days: 90 }),
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantTables({
      tenantId: TENANT,
      tableNameA: "workflow_traces",
      tableNameB: "llm_call_traces",
    });
    expect(result.resolutionA).toEqual({
      source: "platform",
      retentionDays: 30,
      enabled: true,
    });
    expect(result.resolutionB).toEqual({
      source: "platform",
      retentionDays: 90,
      enabled: true,
    });
  });

  it("clock-aware expiry preserved across both table resolutions", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            tenantRow("workflow_traces", {
              enabled: true,
              opt_out: true,
              opt_out_reason: "expired",
              opt_out_until: "2020-01-01T00:00:00.000Z",
            }),
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [
            platformRow("workflow_traces"),
            platformRow("llm_call_traces"),
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({
      conn,
      clock: () => Date.parse("2026-06-01T00:00:00Z"),
    });
    const result = await r.diffTenantTables({
      tenantId: TENANT,
      tableNameA: "workflow_traces",
      tableNameB: "llm_call_traces",
    });
    expect(result.resolutionA.source).toBe("tenant");
    expect(result.resolutionB.source).toBe("platform");
  });

  it("supports same tenant on same table for both axes (degenerate but valid)", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [platformRow("workflow_traces", { retention_days: 90 })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantTables({
      tenantId: TENANT,
      tableNameA: "workflow_traces",
      tableNameB: "workflow_traces",
    });
    expect(result.resolutionA.source).toBe("platform");
    expect(result.resolutionB.source).toBe("platform");
    expect(result.fieldDiffs).toEqual([]);
  });
});

describe("PostgresTraceRetention.diffTenantVsPlatform (M6.7.zz.tenant.opt-out.cli.diff.vs-platform)", () => {
  const TENANT = "00000000-0000-4000-8000-00000000000C";

  function platformRow(
    overrides: Partial<{
      table_name: string;
      retention_days: number;
      enabled: boolean;
    }> = {},
  ): Record<string, unknown> {
    return {
      table_name: "workflow_traces",
      retention_days: 90,
      enabled: true,
      last_pruned_at: null,
      ...overrides,
    };
  }

  function tenantRow(
    overrides: Partial<{
      retention_days: number;
      enabled: boolean;
      opt_out: boolean;
      opt_out_reason: string | null;
      opt_out_until: string | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      tenant_id: TENANT,
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

  it("issues exactly 2 queries in parallel — one tenant lookup + one platform lookup", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffTenantVsPlatform({
      tenantId: TENANT,
      tableName: "workflow_traces",
    });
    expect(capture).toHaveLength(2);
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
    expect(tenantCall?.params).toEqual([TENANT, "workflow_traces"]);
    expect(platformCall?.params).toEqual(["workflow_traces"]);
  });

  it("returns both resolutions as none + empty fieldDiffs when neither row exists", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantVsPlatform({
      tenantId: TENANT,
      tableName: "workflow_traces",
    });
    expect(result.tenantId).toBe(TENANT);
    expect(result.tableName).toBe("workflow_traces");
    expect(result.tenantResolution.source).toBe("none");
    expect(result.platformResolution.source).toBe("none");
    expect(result.fieldDiffs).toEqual([]);
  });

  it("returns identical resolutions + empty fieldDiffs when tenant falls back to platform", async () => {
    const conn = mockConnection((sql) => {
      if (
        sql.includes("FROM meta.retention_policies") &&
        !sql.includes("FROM meta.tenant_retention_policies")
      ) {
        return { rows: [platformRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantVsPlatform({
      tenantId: TENANT,
      tableName: "workflow_traces",
    });
    expect(result.tenantResolution.source).toBe("platform");
    expect(result.platformResolution.source).toBe("platform");
    expect(result.fieldDiffs).toEqual([]);
  });

  it("returns fieldDiffs when tenant override differs from platform default", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [tenantRow({ retention_days: 30, enabled: true })],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [platformRow({ retention_days: 90, enabled: true })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantVsPlatform({
      tenantId: TENANT,
      tableName: "workflow_traces",
    });
    expect(result.tenantResolution.source).toBe("tenant");
    expect(result.platformResolution.source).toBe("platform");
    const fields = result.fieldDiffs.map((d) => d.field);
    expect(fields).toContain("source");
    expect(fields).toContain("retention_days");
  });

  it("renders tenant_opt_out as tenantResolution when active opt-out present", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            tenantRow({
              enabled: false,
              opt_out: true,
              opt_out_reason: "legal_hold:case#42",
              opt_out_until: "2099-01-01T00:00:00.000Z",
            }),
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return { rows: [platformRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantVsPlatform({
      tenantId: TENANT,
      tableName: "workflow_traces",
    });
    expect(result.tenantResolution.source).toBe("tenant_opt_out");
    expect(result.platformResolution.source).toBe("platform");
    const fields = result.fieldDiffs.map((d) => d.field);
    expect(fields).toContain("opt_out");
    expect(fields).toContain("opt_out_reason");
    expect(fields).toContain("opt_out_until");
  });

  it("platformResolution always reflects the platform table — independent of tenant", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [tenantRow({ retention_days: 7 })],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [platformRow({ retention_days: 365, enabled: false })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantVsPlatform({
      tenantId: TENANT,
      tableName: "workflow_traces",
    });
    expect(result.platformResolution).toEqual({
      source: "platform",
      retentionDays: 365,
      enabled: false,
    });
  });

  it("returns platformResolution=none when no platform row exists", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return { rows: [tenantRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantVsPlatform({
      tenantId: TENANT,
      tableName: "workflow_traces",
    });
    expect(result.platformResolution.source).toBe("none");
    expect(result.tenantResolution.source).toBe("tenant");
  });

  it("expired opt-out falls through to platform on tenantResolution (clock-aware)", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            tenantRow({
              enabled: true,
              opt_out: true,
              opt_out_reason: "expired_hold",
              opt_out_until: "2020-01-01T00:00:00.000Z",
            }),
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return { rows: [platformRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({
      conn,
      clock: () => Date.parse("2026-06-01T00:00:00Z"),
    });
    const result = await r.diffTenantVsPlatform({
      tenantId: TENANT,
      tableName: "workflow_traces",
    });
    expect(result.tenantResolution.source).toBe("tenant");
    expect(result.platformResolution.source).toBe("platform");
  });

  it("tenant row with enabled=false + opt_out=false falls through to platform", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [tenantRow({ enabled: false, opt_out: false })],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return { rows: [platformRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantVsPlatform({
      tenantId: TENANT,
      tableName: "workflow_traces",
    });
    expect(result.tenantResolution.source).toBe("platform");
    expect(result.platformResolution.source).toBe("platform");
    expect(result.fieldDiffs).toEqual([]);
  });
});

describe("PostgresTraceRetention.diffTenantTablesNway (M6.7.zz.tenant.opt-out.cli.diff.add-table)", () => {
  const TENANT = "00000000-0000-4000-8000-00000000000A";

  function platformRow(
    table_name: string,
    overrides: Partial<{
      retention_days: number;
      enabled: boolean;
    }> = {},
  ): Record<string, unknown> {
    return {
      table_name,
      retention_days: 90,
      enabled: true,
      last_pruned_at: null,
      ...overrides,
    };
  }

  function tenantRow(
    table_name: string,
    overrides: Partial<{
      retention_days: number;
      enabled: boolean;
      opt_out: boolean;
      opt_out_reason: string | null;
      opt_out_until: string | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      tenant_id: TENANT,
      table_name,
      retention_days: 30,
      enabled: true,
      opt_out: false,
      opt_out_reason: null,
      opt_out_until: null,
      last_pruned_at: null,
      ...overrides,
    };
  }

  it("rejects fewer than 2 tableNames", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffTenantTablesNway({
        tenantId: TENANT,
        tableNames: ["workflow_traces"],
      }),
    ).rejects.toThrow("at least 2 tableNames");
  });

  it("composes on effectiveRetentionBatch — issues exactly 2 queries for 3 tables", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffTenantTablesNway({
      tenantId: TENANT,
      tableNames: [
        "workflow_traces",
        "llm_call_traces",
        "tenant_retention_opt_out_history",
      ],
    });
    expect(capture).toHaveLength(2);
  });

  it("returns resolutions ordered by input tableNames + empty fieldVariations when all match", async () => {
    const conn = mockConnection((sql) => {
      if (
        sql.includes("FROM meta.retention_policies") &&
        !sql.includes("FROM meta.tenant_retention_policies")
      ) {
        return {
          rows: [
            platformRow("workflow_traces"),
            platformRow("llm_call_traces"),
            platformRow("tenant_retention_opt_out_history"),
          ],
          rowCount: 3,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantTablesNway({
      tenantId: TENANT,
      tableNames: [
        "workflow_traces",
        "llm_call_traces",
        "tenant_retention_opt_out_history",
      ],
    });
    expect(result.tenantId).toBe(TENANT);
    expect(result.tableNames).toEqual([
      "workflow_traces",
      "llm_call_traces",
      "tenant_retention_opt_out_history",
    ]);
    expect(result.resolutions).toHaveLength(3);
    expect(result.resolutions[0]!.tableName).toBe("workflow_traces");
    expect(result.resolutions[1]!.tableName).toBe("llm_call_traces");
    expect(result.resolutions[2]!.tableName).toBe(
      "tenant_retention_opt_out_history",
    );
    expect(result.fieldVariations).toEqual([]);
  });

  it("returns fieldVariations when 3 tables have different retention", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [tenantRow("workflow_traces", { retention_days: 30 })],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [
            platformRow("llm_call_traces", { retention_days: 90 }),
            platformRow("tenant_retention_opt_out_history", {
              retention_days: 365,
            }),
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantTablesNway({
      tenantId: TENANT,
      tableNames: [
        "workflow_traces",
        "llm_call_traces",
        "tenant_retention_opt_out_history",
      ],
    });
    expect(result.resolutions[0]!.resolution.source).toBe("tenant");
    expect(result.resolutions[1]!.resolution.source).toBe("platform");
    expect(result.resolutions[2]!.resolution.source).toBe("platform");
    const fields = result.fieldVariations.map((v) => v.field);
    expect(fields).toContain("retention_days");
    expect(fields).toContain("source");
  });

  it("source variation distinctValues uses table names as labels", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [tenantRow("workflow_traces", { retention_days: 30 })],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [platformRow("llm_call_traces", { retention_days: 90 })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantTablesNway({
      tenantId: TENANT,
      tableNames: ["workflow_traces", "llm_call_traces", "llm_latency_samples"],
    });
    const sourceVar = result.fieldVariations.find((v) => v.field === "source");
    expect(sourceVar).toBeDefined();
    const tenantGroup = sourceVar!.distinctValues.find(
      (g) => g.value === "tenant",
    );
    const platformGroup = sourceVar!.distinctValues.find(
      (g) => g.value === "platform",
    );
    const noneGroup = sourceVar!.distinctValues.find(
      (g) => g.value === "none",
    );
    expect(tenantGroup?.labels).toEqual(["workflow_traces"]);
    expect(platformGroup?.labels).toEqual(["llm_call_traces"]);
    expect(noneGroup?.labels).toEqual(["llm_latency_samples"]);
  });

  it("supports 2-table N-way call (degenerate; equivalent to diffTenantTables)", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantTablesNway({
      tenantId: TENANT,
      tableNames: ["workflow_traces", "llm_call_traces"],
    });
    expect(result.resolutions).toHaveLength(2);
    expect(result.fieldVariations).toEqual([]);
  });

  it("handles all 4 prunable tables (full-cohort cross-table audit)", async () => {
    const conn = mockConnection((sql) => {
      if (
        sql.includes("FROM meta.retention_policies") &&
        !sql.includes("FROM meta.tenant_retention_policies")
      ) {
        return {
          rows: [
            platformRow("workflow_traces"),
            platformRow("llm_call_traces"),
            platformRow("tenant_retention_opt_out_history"),
            platformRow("llm_latency_samples"),
          ],
          rowCount: 4,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantTablesNway({
      tenantId: TENANT,
      tableNames: [
        "workflow_traces",
        "llm_call_traces",
        "tenant_retention_opt_out_history",
        "llm_latency_samples",
      ],
    });
    expect(result.resolutions).toHaveLength(4);
    expect(result.fieldVariations).toEqual([]);
  });

  it("preserves duplicate tableNames in resolutions order", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantTablesNway({
      tenantId: TENANT,
      tableNames: [
        "workflow_traces",
        "workflow_traces",
        "llm_call_traces",
      ],
    });
    expect(result.resolutions).toHaveLength(3);
    expect(result.resolutions[0]!.tableName).toBe("workflow_traces");
    expect(result.resolutions[1]!.tableName).toBe("workflow_traces");
    expect(result.resolutions[2]!.tableName).toBe("llm_call_traces");
  });
});

describe("PostgresTraceRetention.diffTenantPoliciesNway (M6.7.zz.tenant.opt-out.cli.diff.add-tenant)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";
  const TENANT_C = "00000000-0000-4000-8000-00000000000C";

  function tenantRow(
    tenant_id: string,
    overrides: Partial<{
      retention_days: number;
      enabled: boolean;
      opt_out: boolean;
      opt_out_reason: string | null;
      opt_out_until: string | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      tenant_id,
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

  function platformRow(
    overrides: Partial<{
      retention_days: number;
      enabled: boolean;
    }> = {},
  ): Record<string, unknown> {
    return {
      table_name: "workflow_traces",
      retention_days: 90,
      enabled: true,
      last_pruned_at: null,
      ...overrides,
    };
  }

  it("rejects fewer than 2 tenantIds", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    await expect(
      r.diffTenantPoliciesNway({
        tenantIds: [TENANT_A],
        tableName: "workflow_traces",
      }),
    ).rejects.toThrow("at least 2 tenantIds");
  });

  it("composes on effectiveRetentionBatch — issues exactly 2 queries for 3 tenants", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    await r.diffTenantPoliciesNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
    });
    expect(capture).toHaveLength(2);
  });

  it("returns resolutions ordered by input tenantIds + empty fieldVariations when all match", async () => {
    const conn = mockConnection((sql) => {
      if (
        sql.includes("FROM meta.retention_policies") &&
        !sql.includes("FROM meta.tenant_retention_policies")
      ) {
        return { rows: [platformRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantPoliciesNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
    });
    expect(result.tenantIds).toEqual([TENANT_A, TENANT_B, TENANT_C]);
    expect(result.tableName).toBe("workflow_traces");
    expect(result.resolutions).toHaveLength(3);
    expect(result.resolutions[0]!.tenantId).toBe(TENANT_A);
    expect(result.resolutions[1]!.tenantId).toBe(TENANT_B);
    expect(result.resolutions[2]!.tenantId).toBe(TENANT_C);
    for (const e of result.resolutions) {
      expect(e.resolution.source).toBe("platform");
    }
    expect(result.fieldVariations).toEqual([]);
  });

  it("returns fieldVariations when 3 tenants have 3 different sources", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            tenantRow(TENANT_A, { retention_days: 30 }),
            tenantRow(TENANT_C, {
              enabled: false,
              opt_out: true,
              opt_out_reason: "legal_hold",
              opt_out_until: "2099-01-01T00:00:00.000Z",
            }),
          ],
          rowCount: 2,
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [platformRow({ retention_days: 90 })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantPoliciesNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
    });
    expect(result.resolutions[0]!.resolution.source).toBe("tenant");
    expect(result.resolutions[1]!.resolution.source).toBe("platform");
    expect(result.resolutions[2]!.resolution.source).toBe("tenant_opt_out");
    const fields = result.fieldVariations.map((v) => v.field);
    expect(fields).toContain("source");
    expect(fields).toContain("retention_days");
    expect(fields).toContain("opt_out");
  });

  it("source variation distinctValues includes tenant attribution", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [tenantRow(TENANT_A, { retention_days: 30 })],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return {
          rows: [platformRow({ retention_days: 90 })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantPoliciesNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
    });
    const sourceVar = result.fieldVariations.find((v) => v.field === "source");
    expect(sourceVar).toBeDefined();
    const tenantGroup = sourceVar!.distinctValues.find(
      (g) => g.value === "tenant",
    );
    const platformGroup = sourceVar!.distinctValues.find(
      (g) => g.value === "platform",
    );
    expect(tenantGroup?.labels).toEqual([TENANT_A]);
    expect(platformGroup?.labels).toEqual([TENANT_B, TENANT_C]);
  });

  it("supports 2-tenant N-way call (degenerate; equivalent to diffTenantPolicies)", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantPoliciesNway({
      tenantIds: [TENANT_A, TENANT_B],
      tableName: "workflow_traces",
    });
    expect(result.resolutions).toHaveLength(2);
    expect(result.fieldVariations).toEqual([]);
  });

  it("handles 5-tenant comparison with all on platform default (no variations)", async () => {
    const conn = mockConnection((sql) => {
      if (
        sql.includes("FROM meta.retention_policies") &&
        !sql.includes("FROM meta.tenant_retention_policies")
      ) {
        return { rows: [platformRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({ conn });
    const t1 = TENANT_A;
    const t2 = TENANT_B;
    const t3 = TENANT_C;
    const t4 = "00000000-0000-4000-8000-00000000000D";
    const t5 = "00000000-0000-4000-8000-00000000000E";
    const result = await r.diffTenantPoliciesNway({
      tenantIds: [t1, t2, t3, t4, t5],
      tableName: "workflow_traces",
    });
    expect(result.resolutions).toHaveLength(5);
    expect(result.fieldVariations).toEqual([]);
  });

  it("clock-aware expiry preserved across N tenants", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.tenant_retention_policies")) {
        return {
          rows: [
            tenantRow(TENANT_A, {
              enabled: true,
              opt_out: true,
              opt_out_reason: "expired",
              opt_out_until: "2020-01-01T00:00:00.000Z",
            }),
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM meta.retention_policies")) {
        return { rows: [platformRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = new PostgresTraceRetention({
      conn,
      clock: () => Date.parse("2026-06-01T00:00:00Z"),
    });
    const result = await r.diffTenantPoliciesNway({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
    });
    expect(result.resolutions[0]!.resolution.source).toBe("tenant");
    expect(result.resolutions[1]!.resolution.source).toBe("platform");
    expect(result.resolutions[2]!.resolution.source).toBe("platform");
  });

  it("deduplicates duplicate tenantIds in resolutions (input order preserved at adapter call)", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.diffTenantPoliciesNway({
      tenantIds: [TENANT_A, TENANT_A, TENANT_B],
      tableName: "workflow_traces",
    });
    expect(result.resolutions).toHaveLength(3);
    expect(result.resolutions[0]!.tenantId).toBe(TENANT_A);
    expect(result.resolutions[1]!.tenantId).toBe(TENANT_A);
    expect(result.resolutions[2]!.tenantId).toBe(TENANT_B);
  });
});

describe("computeFieldVariations", () => {
  it("returns empty array when fewer than 2 entries", () => {
    expect(
      computeFieldVariations([
        { label: "a", normalized: { source: "tenant" } },
      ]),
    ).toEqual([]);
  });

  it("returns empty array when all entries agree on all fields", () => {
    expect(
      computeFieldVariations([
        { label: "a", normalized: { source: "platform", days: 90 } },
        { label: "b", normalized: { source: "platform", days: 90 } },
        { label: "c", normalized: { source: "platform", days: 90 } },
      ]),
    ).toEqual([]);
  });

  it("returns variation when one field differs", () => {
    const result = computeFieldVariations([
      { label: "a", normalized: { source: "tenant", days: 30 } },
      { label: "b", normalized: { source: "platform", days: 30 } },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.field).toBe("source");
    expect(result[0]!.distinctValues).toHaveLength(2);
  });

  it("groups tenants by distinct value", () => {
    const result = computeFieldVariations([
      { label: "a", normalized: { source: "tenant" } },
      { label: "b", normalized: { source: "platform" } },
      { label: "c", normalized: { source: "platform" } },
    ]);
    const sourceVar = result.find((v) => v.field === "source")!;
    const tenantGroup = sourceVar.distinctValues.find(
      (g) => g.value === "tenant",
    );
    const platformGroup = sourceVar.distinctValues.find(
      (g) => g.value === "platform",
    );
    expect(tenantGroup?.labels).toEqual(["a"]);
    expect(platformGroup?.labels).toEqual(["b", "c"]);
  });

  it("treats absent field on one entry as undefined distinct from null on another", () => {
    const result = computeFieldVariations([
      { label: "a", normalized: { x: null } },
      { label: "b", normalized: {} },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.field).toBe("x");
    expect(result[0]!.distinctValues).toHaveLength(2);
  });

  it("sorts variations alphabetically by field name", () => {
    const result = computeFieldVariations([
      { label: "a", normalized: { z: 1, a: 1, m: 1 } },
      { label: "b", normalized: { z: 2, a: 2, m: 2 } },
    ]);
    const fields = result.map((v) => v.field);
    expect(fields).toEqual(["a", "m", "z"]);
  });
});

describe("normalizeResolutionForDiff", () => {
  it("flattens tenant variant to {source, retention_days, enabled, opt_out:false}", () => {
    const out = normalizeResolutionForDiff({
      source: "tenant",
      retentionDays: 30,
      enabled: true,
      tenantId: "tenant-a",
    });
    expect(out).toEqual({
      source: "tenant",
      retention_days: 30,
      enabled: true,
      opt_out: false,
    });
  });

  it("flattens tenant_opt_out variant including reason + until", () => {
    const out = normalizeResolutionForDiff({
      source: "tenant_opt_out",
      retentionDays: null,
      enabled: false,
      tenantId: "tenant-a",
      optOutReason: "legal_hold:case#42",
      optOutUntil: "2027-01-01T00:00:00.000Z",
    });
    expect(out).toEqual({
      source: "tenant_opt_out",
      retention_days: null,
      enabled: false,
      opt_out: true,
      opt_out_reason: "legal_hold:case#42",
      opt_out_until: "2027-01-01T00:00:00.000Z",
    });
  });

  it("flattens platform variant to {source, retention_days, enabled, opt_out:false}", () => {
    const out = normalizeResolutionForDiff({
      source: "platform",
      retentionDays: 90,
      enabled: true,
    });
    expect(out).toEqual({
      source: "platform",
      retention_days: 90,
      enabled: true,
      opt_out: false,
    });
  });

  it("flattens none variant to {source, retention_days:null, enabled:false, opt_out:false}", () => {
    const out = normalizeResolutionForDiff({
      source: "none",
      retentionDays: null,
      enabled: false,
    });
    expect(out).toEqual({
      source: "none",
      retention_days: null,
      enabled: false,
      opt_out: false,
    });
  });
});

describe("PostgresTraceRetention query builders (M6.7.zz.tenant.opt-out.cli.explain-flag.raw-sql)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";
  const TENANT_C = "00000000-0000-4000-8000-00000000000C";
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";

  function makeAdapter() {
    return new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
  }

  it("buildListOptOutHistoryQuery returns SQL with WHERE clauses for filters", () => {
    const r = makeAdapter();
    const { sql, params } = r.buildListOptOutHistoryQuery({
      tenantId: TENANT_A,
      eventKinds: ["opt_out_set", "opt_out_cleared"],
      limit: 50,
    });
    expect(sql).toContain("SELECT");
    expect(sql).toContain("FROM meta.tenant_retention_opt_out_history h");
    expect(sql).toContain("h.tenant_id = $1");
    expect(sql).toContain("h.event_kind IN ($2, $3)");
    expect(sql).toContain("ORDER BY h.occurred_at DESC, h.id DESC");
    expect(params).toEqual([TENANT_A, "opt_out_set", "opt_out_cleared", 50]);
  });

  it("buildListOptOutHistoryQuery same SQL as the executed query (consistency)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
    const r = new PostgresTraceRetention({ conn });
    const input = {
      tenantId: TENANT_A,
      eventKinds: ["opt_out_set" as const],
      actorIds: ["11111111-0000-4000-8000-000000000001"],
    };
    await r.listOptOutHistory(input);
    const built = r.buildListOptOutHistoryQuery(input);
    expect(capture[0]?.sql).toBe(built.sql);
    expect(capture[0]?.params).toEqual(built.params);
  });

  it("buildDiffHistoryEntriesQuery returns SQL with h.id IN ($1, $2)", () => {
    const r = makeAdapter();
    const { sql, params } = r.buildDiffHistoryEntriesQuery({
      idA: ID_A,
      idB: ID_B,
    });
    expect(sql).toContain("WHERE h.id IN ($1, $2)");
    expect(params).toEqual([ID_A, ID_B]);
  });

  it("buildDiffHistoryEntriesQuery includes LEFT JOIN when joinActor=true", () => {
    const r = makeAdapter();
    const { sql } = r.buildDiffHistoryEntriesQuery({
      idA: ID_A,
      idB: ID_B,
      joinActor: true,
    });
    expect(sql).toContain("LEFT JOIN meta.users u ON u.id = h.actor_id");
    expect(sql).toContain("actor_display_name");
  });

  it("buildDiffHistoryTimelineQuery returns SQL with pair-wise WHERE shape", () => {
    const r = makeAdapter();
    const { sql, params } = r.buildDiffHistoryTimelineQuery({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
    expect(sql).toContain("(h.tenant_id = $1 OR h.tenant_id = $2)");
    expect(sql).toContain("h.table_name = $3");
    expect(sql).toContain("ORDER BY h.occurred_at ASC, h.id ASC");
    expect(params.slice(0, 3)).toEqual([
      TENANT_A,
      TENANT_B,
      "workflow_traces",
    ]);
  });

  it("buildDiffHistoryTimelineNwayQuery returns SQL with h.tenant_id IN (...)", () => {
    const r = makeAdapter();
    const { sql, params } = r.buildDiffHistoryTimelineNwayQuery({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
    });
    expect(sql).toContain("h.tenant_id IN ($1, $2, $3)");
    expect(sql).toContain("h.table_name = $4");
    expect(params.slice(0, 4)).toEqual([
      TENANT_A,
      TENANT_B,
      TENANT_C,
      "workflow_traces",
    ]);
  });

  it("buildDiffHistoryTimelineCrossTableQuery returns SQL with table_name IN (...)", () => {
    const r = makeAdapter();
    const { sql, params } = r.buildDiffHistoryTimelineCrossTableQuery({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "tenant_opt_outs"],
    });
    expect(sql).toContain("h.tenant_id = $1");
    expect(sql).toContain("h.table_name IN ($2, $3)");
    expect(params.slice(0, 3)).toEqual([
      TENANT_A,
      "workflow_traces",
      "tenant_opt_outs",
    ]);
  });

  it("builders throw on invalid limit (validation lives in builder)", () => {
    const r = makeAdapter();
    expect(() =>
      r.buildListOptOutHistoryQuery({ limit: 0 }),
    ).toThrow(/limit must be an integer >= 1/);
    expect(() =>
      r.buildDiffHistoryTimelineQuery({
        tenantIdA: TENANT_A,
        tenantIdB: TENANT_B,
        tableName: "workflow_traces",
        limit: -1,
      }),
    ).toThrow(/limit must be an integer >= 1/);
  });

  it("buildDiffHistoryTimelineNwayQuery throws on tenantIds.length < 2", () => {
    const r = makeAdapter();
    expect(() =>
      r.buildDiffHistoryTimelineNwayQuery({
        tenantIds: [TENANT_A],
        tableName: "workflow_traces",
      }),
    ).toThrow(/at least 2 tenantIds required/);
  });

  it("buildDiffHistoryTimelineCrossTableQuery throws on tableNames.length < 2", () => {
    const r = makeAdapter();
    expect(() =>
      r.buildDiffHistoryTimelineCrossTableQuery({
        tenantId: TENANT_A,
        tableNames: ["workflow_traces"],
      }),
    ).toThrow(/at least 2 tableNames required/);
  });
});

describe("PostgresTraceRetention.summarizeOptOutHistory (M6.7.zz.tenant.opt-out.cli.summary)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const ACTOR_ALICE = "11111111-0000-4000-8000-000000000001";

  it("buildSummarizeOptOutHistoryQuery groups by event_kind (default dimension)", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql } = r.buildSummarizeOptOutHistoryQuery({ groupBy: "kind" });
    expect(sql).toContain("SELECT h.event_kind AS key, COUNT(*)::bigint AS count");
    expect(sql).toContain("GROUP BY h.event_kind");
    expect(sql).toContain("ORDER BY COUNT(*) DESC, h.event_kind ASC");
  });

  it("buildSummarizeOptOutHistoryQuery groups by tenant", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql } = r.buildSummarizeOptOutHistoryQuery({ groupBy: "tenant" });
    expect(sql).toContain("h.tenant_id AS key");
    expect(sql).toContain("GROUP BY h.tenant_id");
  });

  it("buildSummarizeOptOutHistoryQuery groups by actor", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql } = r.buildSummarizeOptOutHistoryQuery({ groupBy: "actor" });
    expect(sql).toContain("h.actor_id AS key");
    expect(sql).toContain("GROUP BY h.actor_id");
  });

  it("buildSummarizeOptOutHistoryQuery groups by table", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql } = r.buildSummarizeOptOutHistoryQuery({ groupBy: "table" });
    expect(sql).toContain("h.table_name AS key");
    expect(sql).toContain("GROUP BY h.table_name");
  });

  it("buildSummarizeOptOutHistoryQuery applies filters in WHERE clause", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "kind",
      tenantId: TENANT_A,
      eventKinds: ["opt_out_set", "opt_out_cleared"],
      since: "2026-05-01T00:00:00.000Z",
    });
    expect(sql).toContain("h.tenant_id = $1");
    expect(sql).toContain("h.event_kind IN ($2, $3)");
    expect(sql).toContain("h.occurred_at >= $4");
    expect(params).toEqual([
      TENANT_A,
      "opt_out_set",
      "opt_out_cleared",
      "2026-05-01T00:00:00.000Z",
    ]);
  });

  it("buildSummarizeOptOutHistoryQuery applies actorPresence system_only", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "kind",
      actorPresence: "system_only",
    });
    expect(sql).toContain("h.actor_id IS NULL");
  });

  it("summarizeOptOutHistory parses bigint count + computes totalCount", async () => {
    const conn = mockConnection(() => ({
      rows: [
        { key: "opt_out_set", count: "12" },
        { key: "opt_out_cleared", count: "3" },
        { key: "policy_deleted", count: "1" },
      ],
      rowCount: 3,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.summarizeOptOutHistory({ groupBy: "kind" });
    expect(result.groupBy).toBe("kind");
    expect(result.totalCount).toBe(16);
    expect(result.buckets).toEqual([
      { key: "opt_out_set", count: 12 },
      { key: "opt_out_cleared", count: 3 },
      { key: "policy_deleted", count: 1 },
    ]);
  });

  it("summarizeOptOutHistory handles numeric count (non-string driver)", async () => {
    const conn = mockConnection(() => ({
      rows: [{ key: ACTOR_ALICE, count: 5 }],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.summarizeOptOutHistory({ groupBy: "actor" });
    expect(result.totalCount).toBe(5);
    expect(result.buckets[0]).toEqual({ key: ACTOR_ALICE, count: 5 });
  });

  it("summarizeOptOutHistory preserves null key (system actor) in buckets", async () => {
    const conn = mockConnection(() => ({
      rows: [
        { key: null, count: "4" },
        { key: ACTOR_ALICE, count: "2" },
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.summarizeOptOutHistory({ groupBy: "actor" });
    expect(result.buckets[0]?.key).toBeNull();
    expect(result.totalCount).toBe(6);
  });

  it("summarizeOptOutHistory returns empty buckets + zero total when no rows", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.summarizeOptOutHistory({ groupBy: "kind" });
    expect(result.totalCount).toBe(0);
    expect(result.buckets).toEqual([]);
  });

  it("buildSummarizeOptOutHistoryQuery groups by day with date_trunc + UTC + chronological order", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql } = r.buildSummarizeOptOutHistoryQuery({ groupBy: "day" });
    expect(sql).toContain(
      "date_trunc('day', h.occurred_at AT TIME ZONE 'UTC')::text AS key",
    );
    expect(sql).toContain(
      "GROUP BY date_trunc('day', h.occurred_at AT TIME ZONE 'UTC')",
    );
    // temporal dimensions order chronologically (key ASC), NOT count DESC
    expect(sql).toContain(
      "ORDER BY date_trunc('day', h.occurred_at AT TIME ZONE 'UTC') ASC",
    );
    expect(sql).not.toContain("ORDER BY COUNT(*) DESC");
  });

  it("buildSummarizeOptOutHistoryQuery supports hour / week / month temporal units", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    for (const unit of ["hour", "week", "month"] as const) {
      const { sql } = r.buildSummarizeOptOutHistoryQuery({ groupBy: unit });
      expect(sql).toContain(`date_trunc('${unit}', h.occurred_at AT TIME ZONE 'UTC')`);
    }
  });

  it("buildSummarizeOptOutHistoryQuery temporal grouping composes with filters", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "day",
      tenantId: "00000000-0000-4000-8000-00000000000A",
      eventKinds: ["opt_out_set"],
    });
    expect(sql).toContain("h.tenant_id = $1");
    expect(sql).toContain("h.event_kind IN ($2)");
    expect(sql).toContain("date_trunc('day'");
    expect(params).toEqual([
      "00000000-0000-4000-8000-00000000000A",
      "opt_out_set",
    ]);
  });

  it("categorical grouping retains count DESC ordering (not chronological)", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql } = r.buildSummarizeOptOutHistoryQuery({ groupBy: "kind" });
    expect(sql).toContain("ORDER BY COUNT(*) DESC, h.event_kind ASC");
  });

  it("summarizeOptOutHistory returns time-bucket keys as ISO-ish timestamp strings", async () => {
    const conn = mockConnection(() => ({
      rows: [
        { key: "2026-05-20 00:00:00", count: "8" },
        { key: "2026-05-21 00:00:00", count: "5" },
      ],
      rowCount: 2,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.summarizeOptOutHistory({ groupBy: "day" });
    expect(result.groupBy).toBe("day");
    expect(result.totalCount).toBe(13);
    expect(result.buckets[0]?.key).toBe("2026-05-20 00:00:00");
    expect(result.buckets[1]?.key).toBe("2026-05-21 00:00:00");
  });

  it("cross-tab: buildSummarizeOptOutHistoryQuery groups by two dimensions with sub_key", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "day",
      thenBy: "kind",
    });
    expect(sql).toContain(
      "date_trunc('day', h.occurred_at AT TIME ZONE 'UTC')::text AS key",
    );
    expect(sql).toContain("h.event_kind AS sub_key");
    expect(sql).toContain(
      "GROUP BY date_trunc('day', h.occurred_at AT TIME ZONE 'UTC'), h.event_kind",
    );
    // cross-tab orders grid (primary ASC, secondary ASC), not count DESC
    expect(sql).toContain(
      "ORDER BY date_trunc('day', h.occurred_at AT TIME ZONE 'UTC') ASC, h.event_kind ASC",
    );
    expect(sql).not.toContain("ORDER BY COUNT(*) DESC");
  });

  it("cross-tab: categorical × categorical (kind × tenant)", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "kind",
      thenBy: "tenant",
    });
    expect(sql).toContain("h.event_kind AS key, h.tenant_id AS sub_key");
    expect(sql).toContain("GROUP BY h.event_kind, h.tenant_id");
    expect(sql).toContain("ORDER BY h.event_kind ASC, h.tenant_id ASC");
  });

  it("cross-tab: composes with filters", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "tenant",
      thenBy: "day",
      eventKinds: ["opt_out_set"],
    });
    expect(sql).toContain("h.event_kind IN ($1)");
    expect(sql).toContain("h.tenant_id AS key");
    expect(sql).toContain("AS sub_key");
    expect(params).toEqual(["opt_out_set"]);
  });

  it("cross-tab: summarizeOptOutHistory returns buckets with key + subKey + thenBy in result", async () => {
    const conn = mockConnection(() => ({
      rows: [
        { key: "2026-05-20 00:00:00", sub_key: "opt_out_set", count: "5" },
        { key: "2026-05-20 00:00:00", sub_key: "policy_deleted", count: "2" },
        { key: "2026-05-21 00:00:00", sub_key: "opt_out_set", count: "3" },
      ],
      rowCount: 3,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.summarizeOptOutHistory({
      groupBy: "day",
      thenBy: "kind",
    });
    expect(result.groupBy).toBe("day");
    expect(result.thenBy).toBe("kind");
    expect(result.totalCount).toBe(10);
    expect(result.buckets[0]).toEqual({
      key: "2026-05-20 00:00:00",
      subKey: "opt_out_set",
      count: 5,
    });
    expect(result.buckets[1]?.subKey).toBe("policy_deleted");
  });

  it("single-dimension result omits thenBy + subKey (backward compat)", async () => {
    const conn = mockConnection(() => ({
      rows: [{ key: "opt_out_set", count: "12" }],
      rowCount: 1,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.summarizeOptOutHistory({ groupBy: "kind" });
    expect(result.thenBy).toBeUndefined();
    expect(result.buckets[0]).toEqual({ key: "opt_out_set", count: 12 });
    expect("subKey" in result.buckets[0]!).toBe(false);
  });

  it("fillGaps: generates zero-count buckets via generate_series + LEFT JOIN", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "day",
      fillGaps: true,
      since: "2026-05-01T00:00:00.000Z",
      until: "2026-05-07T00:00:00.000Z",
    });
    expect(sql).toContain("generate_series(");
    expect(sql).toContain(
      "date_trunc('day', $1::timestamptz AT TIME ZONE 'UTC')",
    );
    expect(sql).toContain(
      "date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC')",
    );
    expect(sql).toContain("interval '1 day'");
    expect(sql).toContain("LEFT JOIN meta.tenant_retention_opt_out_history h");
    expect(sql).toContain("COUNT(h.id)::bigint AS count");
    expect(sql).toContain("h.occurred_at >= $1");
    expect(sql).toContain("h.occurred_at <= $2");
    expect(params).toEqual([
      "2026-05-01T00:00:00.000Z",
      "2026-05-07T00:00:00.000Z",
    ]);
  });

  it("fillGaps: filters live in the LEFT JOIN ON clause (zero buckets survive)", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "day",
      fillGaps: true,
      since: "2026-05-01T00:00:00.000Z",
      until: "2026-05-07T00:00:00.000Z",
      eventKinds: ["opt_out_set"],
      tenantId: "00000000-0000-4000-8000-00000000000A",
    });
    // filters in ON clause, not WHERE, so empty buckets still appear
    expect(sql).not.toContain("WHERE");
    expect(sql).toContain("h.event_kind IN ($4)");
    expect(sql).toContain("h.tenant_id = $3");
    expect(params).toEqual([
      "2026-05-01T00:00:00.000Z",
      "2026-05-07T00:00:00.000Z",
      "00000000-0000-4000-8000-00000000000A",
      "opt_out_set",
    ]);
  });

  it("fillGaps: throws when groupBy is not temporal", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    expect(() =>
      r.buildSummarizeOptOutHistoryQuery({
        groupBy: "kind",
        fillGaps: true,
        since: "2026-05-01T00:00:00.000Z",
        until: "2026-05-07T00:00:00.000Z",
      }),
    ).toThrow(/fillGaps requires a temporal groupBy/);
  });

  it("fillGaps: throws when since or until is missing", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    expect(() =>
      r.buildSummarizeOptOutHistoryQuery({
        groupBy: "day",
        fillGaps: true,
        since: "2026-05-01T00:00:00.000Z",
      }),
    ).toThrow(/fillGaps requires both since and until/);
  });

  it("fillGaps: throws when thenBy (cross-tab) is set", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    expect(() =>
      r.buildSummarizeOptOutHistoryQuery({
        groupBy: "day",
        thenBy: "kind",
        fillGaps: true,
        since: "2026-05-01T00:00:00.000Z",
        until: "2026-05-07T00:00:00.000Z",
      }),
    ).toThrow(/fillGaps is not supported with thenBy/);
  });

  it("fillGaps: summarizeOptOutHistory returns zero-count buckets for empty days", async () => {
    const conn = mockConnection(() => ({
      rows: [
        { key: "2026-05-01 00:00:00", count: "5" },
        { key: "2026-05-02 00:00:00", count: "0" },
        { key: "2026-05-03 00:00:00", count: "2" },
      ],
      rowCount: 3,
    }));
    const r = new PostgresTraceRetention({ conn });
    const result = await r.summarizeOptOutHistory({
      groupBy: "day",
      fillGaps: true,
      since: "2026-05-01T00:00:00.000Z",
      until: "2026-05-03T00:00:00.000Z",
    });
    expect(result.totalCount).toBe(7);
    expect(result.buckets[1]).toEqual({
      key: "2026-05-02 00:00:00",
      count: 0,
    });
  });

  it("timezone: defaults to literal 'UTC' when not provided (backward compat)", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "day",
    });
    expect(sql).toContain("AT TIME ZONE 'UTC'");
    expect(params).toEqual([]);
  });

  it("timezone: parameterizes custom timezone as $1 (defense-in-depth vs injection)", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "day",
      timezone: "America/New_York",
    });
    expect(sql).toContain("AT TIME ZONE $1");
    expect(sql).not.toContain("AT TIME ZONE 'America");
    expect(params[0]).toBe("America/New_York");
  });

  it("timezone: custom tz is $1, filters follow as $2+", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "day",
      timezone: "Europe/London",
      tenantId: "00000000-0000-4000-8000-00000000000A",
    });
    expect(sql).toContain("AT TIME ZONE $1");
    expect(sql).toContain("h.tenant_id = $2");
    expect(params).toEqual([
      "Europe/London",
      "00000000-0000-4000-8000-00000000000A",
    ]);
  });

  it("timezone: ignored (no param) for categorical groupBy", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "kind",
      timezone: "America/New_York",
    });
    // categorical grouping has no date_trunc; timezone not used
    expect(sql).not.toContain("AT TIME ZONE");
    expect(params).toEqual([]);
  });

  it("timezone: applies in gap-filling (tz is $3 after since/until)", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "day",
      fillGaps: true,
      since: "2026-05-01T00:00:00.000Z",
      until: "2026-05-07T00:00:00.000Z",
      timezone: "America/New_York",
    });
    expect(sql).toContain("AT TIME ZONE $3");
    expect(sql).not.toContain("AT TIME ZONE 'UTC'");
    expect(params[2]).toBe("America/New_York");
  });

  it("timezone: cross-tab uses parameterized tz once for both temporal dims", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "day",
      thenBy: "hour",
      timezone: "Asia/Tokyo",
    });
    expect(sql).toContain("AT TIME ZONE $1");
    expect(params[0]).toBe("Asia/Tokyo");
  });

  it("top: adds LIMIT + forces count-DESC ordering on temporal dimension", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "day",
      top: 5,
    });
    // --top overrides chronological ordering with count-DESC to pick top
    expect(sql).toContain("ORDER BY COUNT(*) DESC, date_trunc");
    expect(sql).toContain("LIMIT $1");
    expect(params).toEqual([5]);
  });

  it("top: LIMIT on categorical retains count-DESC ordering", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "actor",
      top: 10,
    });
    expect(sql).toContain("ORDER BY COUNT(*) DESC, h.actor_id ASC");
    expect(sql).toContain("LIMIT $1");
    expect(params).toEqual([10]);
  });

  it("minCount: adds HAVING COUNT(*) >= threshold", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "kind",
      minCount: 3,
    });
    expect(sql).toContain("HAVING COUNT(*) >= $1");
    expect(params).toEqual([3]);
  });

  it("top + minCount compose (HAVING then ORDER BY count DESC LIMIT)", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "tenant",
      minCount: 2,
      top: 5,
    });
    expect(sql).toContain("HAVING COUNT(*) >= $1");
    expect(sql).toContain("LIMIT $2");
    expect(sql).toContain("ORDER BY COUNT(*) DESC");
    expect(params).toEqual([2, 5]);
  });

  it("top + filters: top param follows filter params", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "kind",
      tenantId: "00000000-0000-4000-8000-00000000000A",
      top: 3,
    });
    expect(sql).toContain("h.tenant_id = $1");
    expect(sql).toContain("LIMIT $2");
    expect(params).toEqual(["00000000-0000-4000-8000-00000000000A", 3]);
  });

  it("top + cross-tab: forces count-DESC grid ordering + LIMIT", () => {
    const r = new PostgresTraceRetention({
      conn: mockConnection(() => ({ rows: [], rowCount: 0 })),
    });
    const { sql } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "day",
      thenBy: "kind",
      top: 10,
    });
    expect(sql).toContain("ORDER BY COUNT(*) DESC");
    expect(sql).toContain("LIMIT");
  });

  it("explainAnalyzeQuery: wraps SQL in EXPLAIN (ANALYZE, FORMAT JSON) + returns QUERY PLAN", async () => {
    const capture: Capture[] = [];
    const planJson = [{ Plan: { "Node Type": "Seq Scan", "Actual Total Time": 0.5 } }];
    const conn = mockConnection(
      () => ({ rows: [{ "QUERY PLAN": planJson }], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const plan = await r.explainAnalyzeQuery(
      "SELECT * FROM meta.foo WHERE x = $1",
      ["abc"],
    );
    expect(capture[0]?.sql).toBe(
      "EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM meta.foo WHERE x = $1",
    );
    expect(capture[0]?.params).toEqual(["abc"]);
    expect(plan).toEqual(planJson);
  });

  it("explainAnalyzeQuery: returns null when no plan row", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const r = new PostgresTraceRetention({ conn });
    const plan = await r.explainAnalyzeQuery("SELECT 1", []);
    expect(plan).toBeNull();
  });

  it("explainAnalyzeQuery: composes with a builder-produced query", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({ rows: [{ "QUERY PLAN": [{ Plan: {} }] }], rowCount: 1 }),
      capture,
    );
    const r = new PostgresTraceRetention({ conn });
    const { sql, params } = r.buildSummarizeOptOutHistoryQuery({
      groupBy: "kind",
    });
    await r.explainAnalyzeQuery(sql, params);
    expect(capture[0]?.sql).toContain("EXPLAIN (ANALYZE, FORMAT JSON) SELECT");
    expect(capture[0]?.sql).toContain("GROUP BY h.event_kind");
  });
});
