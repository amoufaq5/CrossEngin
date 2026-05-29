import type {
  PgConnection,
  PgQueryResult,
  PostgresTraceRetention,
  RetentionPolicyRow,
  TenantRetentionPolicyRow,
} from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { parseArgs, type ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import { runRetention, type RetentionContext } from "./retention.js";

const TENANT_A = "00000000-0000-4000-8000-00000000000A";
const TENANT_B = "00000000-0000-4000-8000-00000000000B";

function buffers(): { ctx: RunContext; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ctx: {
      io: {
        stdout: { write: (chunk: string) => out.push(chunk) },
        stderr: { write: (chunk: string) => err.push(chunk) },
      },
      env: {},
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

function parsed(...argv: string[]): ParsedCommand {
  const result = parseArgs(["node", "crossengin", ...argv]);
  if (!result.ok) throw new Error(result.error.message);
  return result.command;
}

// Mock PG connection that returns canned (total, oldest) rows per table.
// The housekeeping handler issues `SELECT COUNT(*)::TEXT AS total,
// MIN(<time_col>)::TEXT AS oldest FROM meta.<tableName>` per table — match
// on the FROM clause to dispatch.
function fakeStatsConnection(
  perTable: Record<string, { total: string; oldest: string | null }>,
): PgConnection {
  return {
    query: async <T>(sql: string, _params?: readonly unknown[]) => {
      for (const [name, stats] of Object.entries(perTable)) {
        if (sql.includes(`FROM meta.${name}`)) {
          return { rows: [stats], rowCount: 1 } as unknown as PgQueryResult<T>;
        }
      }
      return { rows: [], rowCount: 0 } as unknown as PgQueryResult<T>;
    },
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => fn({} as PgConnection),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>) => fn(),
    close: async () => undefined,
  };
}

function fakeRetention(opts: {
  platform?: readonly RetentionPolicyRow[];
  tenant?: readonly TenantRetentionPolicyRow[];
  preview?: ReadonlyArray<{
    tenantId?: string;
    tableName: string;
    status: "previewed" | "skipped_disabled" | "skipped_unknown_table";
    wouldDeleteCount: number;
    retentionDays: number;
    cutoffMs: number;
  }>;
}): PostgresTraceRetention {
  return {
    listPolicies: async () => opts.platform ?? [],
    listTenantPolicies: async () => opts.tenant ?? [],
    previewPrune: async () => opts.preview ?? [],
  } as unknown as PostgresTraceRetention;
}

describe("runRetention housekeeping (M4.14.x)", () => {
  const fixedNow = new Date("2026-05-29T12:00:00.000Z");

  it("default mode renders the six-table dashboard in human format", async () => {
    const { ctx, out } = buffers();
    const conn = fakeStatsConnection({
      workflow_traces: { total: "1234567", oldest: "2026-04-01T00:00:00.000Z" },
      llm_call_traces: { total: "9876543", oldest: "2026-03-15T00:00:00.000Z" },
      llm_latency_samples: { total: "555", oldest: "2026-05-20T00:00:00.000Z" },
      tenant_retention_opt_out_history: { total: "42", oldest: "2026-01-10T00:00:00.000Z" },
      gateway_pipeline_executions: { total: "50000", oldest: "2026-04-01T00:00:00.000Z" },
      rate_limit_decisions: { total: "987654", oldest: "2026-03-15T00:00:00.000Z" },
    });
    const platform: RetentionPolicyRow[] = [
      {
        tableName: "workflow_traces",
        retentionDays: 90,
        enabled: true,
        lastPrunedAt: "2026-05-28T00:00:00.000Z",
      },
      {
        tableName: "llm_call_traces",
        retentionDays: 30,
        enabled: true,
        lastPrunedAt: null,
      },
      {
        tableName: "rate_limit_decisions",
        retentionDays: 7,
        enabled: false,
        lastPrunedAt: "2026-05-29T00:00:00.000Z",
      },
    ];
    const tenant: TenantRetentionPolicyRow[] = [
      {
        tenantId: TENANT_A,
        tableName: "workflow_traces",
        retentionDays: 365,
        enabled: true,
        optOut: false,
        optOutReason: null,
        optOutUntil: null,
        lastPrunedAt: null,
      },
      {
        tenantId: TENANT_B,
        tableName: "workflow_traces",
        retentionDays: 60,
        enabled: true,
        optOut: false,
        optOutReason: null,
        optOutUntil: null,
        lastPrunedAt: null,
      },
      {
        tenantId: TENANT_A,
        tableName: "llm_call_traces",
        retentionDays: 7,
        enabled: false,
        optOut: true,
        optOutReason: "legal_hold:case#42",
        optOutUntil: null,
        lastPrunedAt: null,
      },
    ];
    const preview = [
      {
        tableName: "workflow_traces",
        status: "previewed" as const,
        wouldDeleteCount: 1000,
        retentionDays: 90,
        cutoffMs: 0,
      },
      {
        tableName: "llm_call_traces",
        status: "previewed" as const,
        wouldDeleteCount: 50,
        retentionDays: 30,
        cutoffMs: 0,
      },
      {
        tableName: "rate_limit_decisions",
        status: "previewed" as const,
        wouldDeleteCount: 9876,
        retentionDays: 7,
        cutoffMs: 0,
      },
    ];
    const retention = fakeRetention({ platform, tenant, preview });
    const code = await runRetention(parsed("retention", "housekeeping"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: retention,
      clockOverride: () => fixedNow,
    } as RetentionContext);
    expect(code).toBe(0);
    const stdout = out();
    expect(stdout).toContain(`retention housekeeping (as of ${fixedNow.toISOString()})`);
    // All 6 table names present.
    expect(stdout).toContain("workflow_traces");
    expect(stdout).toContain("llm_call_traces");
    expect(stdout).toContain("llm_latency_samples");
    expect(stdout).toContain("tenant_retention_opt_out_history");
    expect(stdout).toContain("gateway_pipeline_executions");
    expect(stdout).toContain("rate_limit_decisions");
    // Locale-formatted row counts (en-US commas).
    expect(stdout).toContain("1,234,567");
    expect(stdout).toContain("9,876,543");
    expect(stdout).toContain("987,654");
    // Would-prune counts surface from previewPrune.
    expect(stdout).toContain("1,000");
    expect(stdout).toContain("9,876");
    // Retention policies shown for the three tables that have them.
    expect(stdout).toContain("90 day(s) (enabled)");
    expect(stdout).toContain("30 day(s) (enabled)");
    expect(stdout).toContain("7 day(s) (disabled)");
    // lastPrunedAt rendering.
    expect(stdout).toContain("2026-05-28T00:00:00.000Z");
    expect(stdout).toContain("never");
    // Per-tenant override counts.
    // workflow_traces has 2 tenant policies (A and B).
    // llm_call_traces has 1 (A).
    expect(stdout).toMatch(/workflow_traces[\s\S]*?tenant overrides: 2/);
    expect(stdout).toMatch(/llm_call_traces[\s\S]*?tenant overrides: 1/);
  });

  it("JSON envelope includes asOf + all 6 tables with full field shape", async () => {
    const { ctx, out } = buffers();
    const conn = fakeStatsConnection({
      workflow_traces: { total: "100", oldest: null },
      llm_call_traces: { total: "0", oldest: null },
      llm_latency_samples: { total: "5", oldest: "2026-05-01T00:00:00.000Z" },
      tenant_retention_opt_out_history: { total: "0", oldest: null },
      gateway_pipeline_executions: { total: "200", oldest: "2026-04-15T00:00:00.000Z" },
      rate_limit_decisions: { total: "10000", oldest: "2026-05-10T00:00:00.000Z" },
    });
    const platform: RetentionPolicyRow[] = [
      {
        tableName: "workflow_traces",
        retentionDays: 30,
        enabled: true,
        lastPrunedAt: null,
      },
    ];
    const preview = [
      {
        tableName: "workflow_traces",
        status: "previewed" as const,
        wouldDeleteCount: 25,
        retentionDays: 30,
        cutoffMs: 0,
      },
    ];
    const retention = fakeRetention({ platform, preview });
    const code = await runRetention(parsed("retention", "housekeeping", "--format", "json"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: retention,
      clockOverride: () => fixedNow,
    } as RetentionContext);
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      action: string;
      asOf: string;
      tables: Array<{
        tableName: string;
        totalRowCount: number;
        oldestAt: string | null;
        wouldPruneCount: number;
        retentionDays: number | null;
        enabled: boolean | null;
        lastPrunedAt: string | null;
        perTenantPolicyCount: number;
      }>;
    };
    expect(env.action).toBe("retention.housekeeping");
    expect(env.asOf).toBe(fixedNow.toISOString());
    expect(env.tables).toHaveLength(6);
    const byName = new Map(env.tables.map((t) => [t.tableName, t]));
    const wt = byName.get("workflow_traces")!;
    expect(wt.totalRowCount).toBe(100);
    expect(wt.oldestAt).toBeNull();
    expect(wt.wouldPruneCount).toBe(25);
    expect(wt.retentionDays).toBe(30);
    expect(wt.enabled).toBe(true);
    expect(wt.lastPrunedAt).toBeNull();
    expect(wt.perTenantPolicyCount).toBe(0);
    const lct = byName.get("llm_call_traces")!;
    expect(lct.totalRowCount).toBe(0);
    expect(lct.retentionDays).toBeNull();
    expect(lct.enabled).toBeNull();
    expect(lct.wouldPruneCount).toBe(0);
    const lls = byName.get("llm_latency_samples")!;
    expect(lls.totalRowCount).toBe(5);
    expect(lls.oldestAt).toBe("2026-05-01T00:00:00.000Z");
    const tr = byName.get("tenant_retention_opt_out_history")!;
    expect(tr.totalRowCount).toBe(0);
    const gpe = byName.get("gateway_pipeline_executions")!;
    expect(gpe.totalRowCount).toBe(200);
    expect(gpe.retentionDays).toBeNull();
    const rl = byName.get("rate_limit_decisions")!;
    expect(rl.totalRowCount).toBe(10000);
    expect(rl.retentionDays).toBeNull();
  });

  it("renders '(empty)' and '(no platform policy configured)' fallbacks for empty tables + missing policies", async () => {
    const { ctx, out } = buffers();
    const conn = fakeStatsConnection({
      workflow_traces: { total: "0", oldest: null },
      llm_call_traces: { total: "0", oldest: null },
      llm_latency_samples: { total: "0", oldest: null },
      tenant_retention_opt_out_history: { total: "0", oldest: null },
      gateway_pipeline_executions: { total: "0", oldest: null },
      rate_limit_decisions: { total: "0", oldest: null },
    });
    const retention = fakeRetention({ platform: [], tenant: [], preview: [] });
    const code = await runRetention(parsed("retention", "housekeeping"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: retention,
      clockOverride: () => fixedNow,
    } as RetentionContext);
    expect(code).toBe(0);
    const stdout = out();
    // Every table renders the empty oldest-row fallback.
    expect(stdout).toContain("(empty)");
    // Every table renders the missing-policy fallback.
    expect(stdout).toContain("(no platform policy configured)");
    // No-tenant-override count for every table.
    expect(stdout).toContain("tenant overrides: 0");
  });

  it("ignores per-tenant rows in previewPrune output (uses platform-level rows only)", async () => {
    const { ctx, out } = buffers();
    const conn = fakeStatsConnection({
      workflow_traces: { total: "100", oldest: null },
      llm_call_traces: { total: "0", oldest: null },
      llm_latency_samples: { total: "0", oldest: null },
      tenant_retention_opt_out_history: { total: "0", oldest: null },
      gateway_pipeline_executions: { total: "0", oldest: null },
      rate_limit_decisions: { total: "0", oldest: null },
    });
    const platform: RetentionPolicyRow[] = [
      {
        tableName: "workflow_traces",
        retentionDays: 30,
        enabled: true,
        lastPrunedAt: null,
      },
    ];
    // previewPrune returns BOTH platform-level + per-tenant rows. The
    // dashboard surfaces the platform sweep only — per-tenant detail stays
    // under `retention list-policies --tenant`.
    const preview = [
      {
        tableName: "workflow_traces",
        status: "previewed" as const,
        wouldDeleteCount: 75,
        retentionDays: 30,
        cutoffMs: 0,
      },
      {
        tenantId: TENANT_A,
        tableName: "workflow_traces",
        status: "previewed" as const,
        wouldDeleteCount: 999, // per-tenant noise — must NOT be surfaced.
        retentionDays: 7,
        cutoffMs: 0,
      },
    ];
    const retention = fakeRetention({ platform, preview });
    const code = await runRetention(parsed("retention", "housekeeping", "--format", "json"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: retention,
      clockOverride: () => fixedNow,
    } as RetentionContext);
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      tables: Array<{ tableName: string; wouldPruneCount: number }>;
    };
    const wt = env.tables.find((t) => t.tableName === "workflow_traces")!;
    expect(wt.wouldPruneCount).toBe(75); // platform-level not per-tenant
  });

  it("propagates adapter errors as exit 1 with a clear message", async () => {
    const { ctx, err } = buffers();
    const conn = fakeStatsConnection({});
    const throwingRetention = {
      listPolicies: async () => {
        throw new Error('relation "meta.retention_policies" does not exist');
      },
      listTenantPolicies: async () => [],
      previewPrune: async () => [],
    } as unknown as PostgresTraceRetention;
    const code = await runRetention(parsed("retention", "housekeeping"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: throwingRetention,
      clockOverride: () => fixedNow,
    } as RetentionContext);
    expect(code).toBe(1);
    expect(err()).toContain("does not exist");
  });

  it("exits 1 with PG-missing error when no PG env and no override", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "housekeeping"), ctx as RetentionContext);
    expect(code).toBe(1);
    expect(err()).toMatch(/PG env/);
  });

  it("dispatcher includes housekeeping in the unknown-action error message", async () => {
    const { ctx, err } = buffers();
    // Unknown actions still go through resolveRetention before hitting the
    // switch default — supply an override so the PG-missing check doesn't
    // short-circuit to exit 1.
    const code = await runRetention(parsed("retention", "nuke"), {
      ...ctx,
      retentionOverride: fakeRetention({}),
    } as RetentionContext);
    expect(code).toBe(2);
    expect(err()).toMatch(/housekeeping/);
  });

  it("dispatcher includes housekeeping in the missing-action error message", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention"), ctx as RetentionContext);
    expect(code).toBe(2);
    expect(err()).toMatch(/housekeeping/);
  });
});
