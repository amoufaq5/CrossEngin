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

describe("runRetention housekeeping --watch (M4.14.w)", () => {
  const fixedNow = new Date("2026-05-29T12:00:00.000Z");

  // Stable connection + retention adapter for watch-mode tests (no PG
  // side effects).
  function fixtures() {
    const conn = fakeStatsConnection({
      workflow_traces: { total: "100", oldest: null },
      llm_call_traces: { total: "0", oldest: null },
      llm_latency_samples: { total: "0", oldest: null },
      tenant_retention_opt_out_history: { total: "0", oldest: null },
      gateway_pipeline_executions: { total: "0", oldest: null },
      rate_limit_decisions: { total: "0", oldest: null },
    });
    const retention = fakeRetention({ platform: [], tenant: [], preview: [] });
    return { conn, retention };
  }

  // Test-only setTimeout that fires synchronously without waiting — lets the
  // watch loop drain N iterations instantly. Production uses real setTimeout.
  const immediateSetTimeout = (cb: () => void, _ms: number) => {
    cb();
    return 1 as unknown;
  };

  it("loops N times when --watch + watchOverride.maxIterations is set", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = fixtures();
    const code = await runRetention(parsed("retention", "housekeeping", "--watch"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: retention,
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 3, setTimeoutFn: immediateSetTimeout },
    } as RetentionContext);
    expect(code).toBe(0);
    const stdout = out();
    // Three renders → three "retention housekeeping (as of ...)" headers.
    const headerMatches = stdout.match(/retention housekeeping \(as of /g);
    expect(headerMatches).not.toBeNull();
    expect(headerMatches!.length).toBe(3);
    // Human format clears the screen between renders via ANSI escape.
    expect(stdout).toContain("\x1b[2J\x1b[H");
  });

  it("--watch with --format json streams NDJSON-of-envelopes (one per tick)", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = fixtures();
    const code = await runRetention(
      parsed("retention", "housekeeping", "--watch", "--format", "json"),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: retention,
        clockOverride: () => fixedNow,
        watchOverride: { maxIterations: 2, setTimeoutFn: immediateSetTimeout },
      } as RetentionContext,
    );
    expect(code).toBe(0);
    // Two ticks → two JSON envelopes, each on its own line.
    const lines = out().trim().split("\n");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const env = JSON.parse(line) as { action: string; asOf: string };
      expect(env.action).toBe("retention.housekeeping");
      expect(env.asOf).toBe(fixedNow.toISOString());
    }
    // JSON streaming should NOT clear the screen between ticks.
    expect(out()).not.toContain("\x1b[2J");
  });

  it("--watch-interval threads custom interval (verified via setTimeout injection)", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = fixtures();
    const recordedDelays: number[] = [];
    const fakeSetTimeout = (cb: () => void, ms: number) => {
      recordedDelays.push(ms);
      // Fire immediately so the loop doesn't block in tests.
      cb();
      return 1 as unknown;
    };
    const code = await runRetention(
      parsed("retention", "housekeeping", "--watch", "--watch-interval", "10"),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: retention,
        clockOverride: () => fixedNow,
        watchOverride: {
          maxIterations: 3,
          setTimeoutFn: fakeSetTimeout,
        },
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out().match(/retention housekeeping \(as of /g)!.length).toBe(3);
    // Two waits between three renders, both at the custom interval (10s = 10000ms).
    expect(recordedDelays).toEqual([10000, 10000]);
  });

  it("--watch-interval requires --watch (exit 2)", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "housekeeping", "--watch-interval", "10"),
      ctx as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--watch-interval requires --watch");
  });

  it("--watch-interval rejects non-integer / out-of-range / non-numeric values (exit 2)", async () => {
    for (const bad of ["0", "3601", "abc", "1.5", "-1"]) {
      const { ctx, err } = buffers();
      const code = await runRetention(
        parsed("retention", "housekeeping", "--watch", "--watch-interval", bad),
        ctx as RetentionContext,
      );
      expect(code).toBe(2);
      expect(err()).toContain("invalid --watch-interval");
    }
  });

  it("--watch rejects --format csv/tsv/ndjson/yaml (exit 2 with format note)", async () => {
    for (const fmt of ["csv", "tsv", "ndjson", "yaml"]) {
      const { ctx, err } = buffers();
      const code = await runRetention(
        parsed("retention", "housekeeping", "--watch", "--format", fmt),
        ctx as RetentionContext,
      );
      expect(code).toBe(2);
      expect(err()).toContain("--watch requires --format human or json");
      expect(err()).toContain(fmt);
    }
  });

  it("--watch validation fires BEFORE PG resolution (no connection burned on misuse)", async () => {
    // No pgConnectionOverride + no PG env → would normally exit 1 with
    // "PG env vars" error. But --watch validation fails first with exit 2.
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "housekeeping", "--watch", "--format", "csv"),
      ctx as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--watch requires --format");
    expect(err()).not.toMatch(/PG env/);
  });

  it("--watch with abortSignal cancels the loop between ticks", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = fixtures();
    const controller = new AbortController();
    // Abort after the first tick — the loop should exit cleanly.
    let tickCount = 0;
    const fakeSetTimeout = (cb: () => void, _ms: number) => {
      tickCount++;
      if (tickCount === 1) controller.abort();
      cb();
      return 1 as unknown;
    };
    const code = await runRetention(parsed("retention", "housekeeping", "--watch"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: retention,
      clockOverride: () => fixedNow,
      watchOverride: {
        // Cap at 5 so abort is the actual termination — if abort fails we'd
        // see 5 renders rather than 2.
        maxIterations: 5,
        abortSignal: controller.signal,
        setTimeoutFn: fakeSetTimeout,
      },
    } as RetentionContext);
    expect(code).toBe(0);
    const headerMatches = out().match(/retention housekeeping \(as of /g);
    // After tick 1: render, then setTimeout fires + aborts. Loop wakes,
    // sees aborted, exits before tick 2. So exactly 1 render.
    expect(headerMatches!.length).toBe(1);
  });

  it("--watch propagates gather errors as exit 1 (no infinite retry)", async () => {
    const { ctx, err } = buffers();
    const throwingRetention = {
      listPolicies: async () => {
        throw new Error('relation "meta.retention_policies" does not exist');
      },
      listTenantPolicies: async () => [],
      previewPrune: async () => [],
    } as unknown as PostgresTraceRetention;
    const { conn } = fixtures();
    const code = await runRetention(parsed("retention", "housekeeping", "--watch"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: throwingRetention,
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 5, setTimeoutFn: immediateSetTimeout },
    } as RetentionContext);
    expect(code).toBe(1);
    expect(err()).toContain("does not exist");
  });
});

describe("runRetention housekeeping --threshold-alert (M4.14.t)", () => {
  const fixedNow = new Date("2026-05-29T12:00:00.000Z");

  function bigTableFixtures() {
    const conn = fakeStatsConnection({
      workflow_traces: { total: "5000000", oldest: "2026-04-01T00:00:00.000Z" },
      llm_call_traces: { total: "100", oldest: null },
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
        // 5 days ago — passes <24h threshold but fails >24h threshold.
        lastPrunedAt: new Date(fixedNow.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ];
    const preview = [
      {
        tableName: "workflow_traces",
        status: "previewed" as const,
        wouldDeleteCount: 2_000_000,
        retentionDays: 30,
        cutoffMs: 0,
      },
    ];
    const retention = fakeRetention({ platform, preview });
    return { conn, retention };
  }

  it("exits 0 + does not print THRESHOLD ALERTS section when no alert trips", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = bigTableFixtures();
    const code = await runRetention(
      parsed(
        "retention",
        "housekeeping",
        "--threshold-alert",
        "wouldPruneCount:>10000000", // 10M > 2M in fixture; doesn't trip
      ),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: retention,
        clockOverride: () => fixedNow,
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).not.toContain("THRESHOLD ALERTS");
  });

  it("exits 3 + prints THRESHOLD ALERTS section when a numeric alert trips", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = bigTableFixtures();
    const code = await runRetention(
      parsed(
        "retention",
        "housekeeping",
        "--threshold-alert",
        "wouldPruneCount:>1000000", // 1M < 2M in fixture; trips
      ),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: retention,
        clockOverride: () => fixedNow,
      } as RetentionContext,
    );
    expect(code).toBe(3);
    expect(out()).toContain("THRESHOLD ALERTS (1 tripped):");
    expect(out()).toContain("workflow_traces wouldPruneCount=2,000,000");
    expect(out()).toContain('"wouldPruneCount:>1000000"');
  });

  it("exits 3 when a duration alert trips on a nullable timestamp (lastPrunedAt:>24h)", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = bigTableFixtures();
    const code = await runRetention(
      parsed(
        "retention",
        "housekeeping",
        "--threshold-alert",
        "lastPrunedAt:>24h", // fixture's policy was 5 days ago; trips
      ),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: retention,
        clockOverride: () => fixedNow,
      } as RetentionContext,
    );
    expect(code).toBe(3);
    expect(out()).toContain("THRESHOLD ALERTS");
    expect(out()).toContain("lastPrunedAt=");
    expect(out()).toContain("age 5.0d");
  });

  it("exits 3 for multiple alerts (all tripped lines printed)", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = bigTableFixtures();
    const code = await runRetention(
      parsed(
        "retention",
        "housekeeping",
        "--threshold-alert",
        "wouldPruneCount:>1000000",
        "--threshold-alert",
        "lastPrunedAt:>24h",
      ),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: retention,
        clockOverride: () => fixedNow,
      } as RetentionContext,
    );
    expect(code).toBe(3);
    // Both alert specs should appear in the output.
    expect(out()).toMatch(/THRESHOLD ALERTS \(\d+ tripped\):/);
    expect(out()).toContain('"wouldPruneCount:>1000000"');
    expect(out()).toContain('"lastPrunedAt:>24h"');
  });

  it("exits 2 on invalid alert syntax (no PG call)", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "housekeeping", "--threshold-alert", "bogusSyntax"),
      ctx as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid threshold alert");
  });

  it("exits 2 on unknown field name", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "housekeeping", "--threshold-alert", "ghostField:>1"),
      ctx as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("unknown field");
    expect(err()).toContain("wouldPruneCount");
  });

  it("JSON envelope includes 'alerts' array (empty when no alerts pass) and tripped entries", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = bigTableFixtures();
    // No --threshold-alert → alerts should be empty array (not undefined)
    const codeNoAlerts = await runRetention(
      parsed("retention", "housekeeping", "--format", "json"),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: retention,
        clockOverride: () => fixedNow,
      } as RetentionContext,
    );
    expect(codeNoAlerts).toBe(0);
    const envNoAlerts = JSON.parse(out()) as { alerts: unknown[] };
    expect(envNoAlerts.alerts).toEqual([]);
  });

  it("JSON envelope embeds tripped alert details on hit", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = bigTableFixtures();
    const code = await runRetention(
      parsed(
        "retention",
        "housekeeping",
        "--format",
        "json",
        "--threshold-alert",
        "wouldPruneCount:>1000000",
      ),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: retention,
        clockOverride: () => fixedNow,
      } as RetentionContext,
    );
    expect(code).toBe(3);
    const env = JSON.parse(out()) as {
      alerts: Array<{
        spec: string;
        tableName: string;
        fieldName: string;
        op: string;
        actual: number;
        thresholdRaw: string;
      }>;
    };
    expect(env.alerts).toHaveLength(1);
    const hit = env.alerts[0]!;
    expect(hit.spec).toBe("wouldPruneCount:>1000000");
    expect(hit.tableName).toBe("workflow_traces");
    expect(hit.fieldName).toBe("wouldPruneCount");
    expect(hit.op).toBe("GT");
    expect(hit.actual).toBe(2_000_000);
  });

  it("composes with --watch — first tripped tick exits 3", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = bigTableFixtures();
    let tickCount = 0;
    const immediateSetTimeout = (cb: () => void, _ms: number) => {
      tickCount++;
      cb();
      return 1 as unknown;
    };
    const code = await runRetention(
      parsed(
        "retention",
        "housekeeping",
        "--watch",
        "--threshold-alert",
        "wouldPruneCount:>1000000",
      ),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: retention,
        clockOverride: () => fixedNow,
        watchOverride: {
          maxIterations: 5, // would loop 5x if alerts didn't trip
          setTimeoutFn: immediateSetTimeout,
        },
      } as RetentionContext,
    );
    expect(code).toBe(3);
    // Loop should exit after FIRST tick that trips — no setTimeout call
    // between tick 1 and exit.
    expect(tickCount).toBe(0);
    expect(out()).toContain("THRESHOLD ALERTS");
  });
});

describe("runRetention housekeeping --watch-keep-going (M4.14.s)", () => {
  const fixedNow = new Date("2026-05-29T12:00:00.000Z");

  const immediateSetTimeout = (cb: () => void, _ms: number) => {
    cb();
    return 1 as unknown;
  };

  function cleanFixtures() {
    const conn = fakeStatsConnection({
      workflow_traces: { total: "100", oldest: null },
      llm_call_traces: { total: "0", oldest: null },
      llm_latency_samples: { total: "0", oldest: null },
      tenant_retention_opt_out_history: { total: "0", oldest: null },
      gateway_pipeline_executions: { total: "0", oldest: null },
      rate_limit_decisions: { total: "0", oldest: null },
    });
    const retention = fakeRetention({ platform: [], tenant: [], preview: [] });
    return { conn, retention };
  }

  function trippingFixtures() {
    const conn = fakeStatsConnection({
      workflow_traces: { total: "5000000", oldest: null },
      llm_call_traces: { total: "0", oldest: null },
      llm_latency_samples: { total: "0", oldest: null },
      tenant_retention_opt_out_history: { total: "0", oldest: null },
      gateway_pipeline_executions: { total: "0", oldest: null },
      rate_limit_decisions: { total: "0", oldest: null },
    });
    const preview = [
      {
        tableName: "workflow_traces",
        status: "previewed" as const,
        wouldDeleteCount: 2_000_000,
        retentionDays: 30,
        cutoffMs: 0,
      },
    ];
    const retention = fakeRetention({ platform: [], tenant: [], preview });
    return { conn, retention };
  }

  it("--watch-keep-going requires --watch (exit 2 otherwise)", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "housekeeping", "--watch-keep-going"),
      ctx as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--watch-keep-going requires --watch");
  });

  it("exits 0 when no errors + no trips occur across N ticks", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = cleanFixtures();
    const code = await runRetention(
      parsed("retention", "housekeeping", "--watch", "--watch-keep-going"),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: retention,
        clockOverride: () => fixedNow,
        watchOverride: { maxIterations: 3, setTimeoutFn: immediateSetTimeout },
      } as RetentionContext,
    );
    expect(code).toBe(0);
    // Three ticks rendered.
    const headers = out().match(/retention housekeeping \(as of /g);
    expect(headers!.length).toBe(3);
  });

  it("does NOT halt on first trip — loops through maxIterations + exits 3 (sticky)", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = trippingFixtures();
    const code = await runRetention(
      parsed(
        "retention",
        "housekeeping",
        "--watch",
        "--watch-keep-going",
        "--threshold-alert",
        "wouldPruneCount:>1000000",
      ),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: retention,
        clockOverride: () => fixedNow,
        watchOverride: { maxIterations: 3, setTimeoutFn: immediateSetTimeout },
      } as RetentionContext,
    );
    expect(code).toBe(3);
    // All 3 ticks should have run + all 3 should render the alert.
    const headers = out().match(/retention housekeeping \(as of /g);
    expect(headers!.length).toBe(3);
    const alertSections = out().match(/THRESHOLD ALERTS/g);
    expect(alertSections!.length).toBe(3);
  });

  it("catches gather() errors + renders them + continues looping (exit 0 when no trip)", async () => {
    const { ctx, out } = buffers();
    const { conn } = cleanFixtures();
    let callCount = 0;
    const flakyRetention = {
      listPolicies: async () => {
        callCount++;
        // Error on the 2nd tick to simulate a transient PG blip.
        if (callCount === 2) throw new Error("connection terminated unexpectedly");
        return [];
      },
      listTenantPolicies: async () => [],
      previewPrune: async () => [],
    } as unknown as PostgresTraceRetention;
    const code = await runRetention(
      parsed("retention", "housekeeping", "--watch", "--watch-keep-going"),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: flakyRetention,
        clockOverride: () => fixedNow,
        watchOverride: { maxIterations: 3, setTimeoutFn: immediateSetTimeout },
      } as RetentionContext,
    );
    expect(code).toBe(0);
    // Tick 1 and 3 should render the full report; tick 2 renders the error.
    expect(out()).toContain("error this tick: connection terminated unexpectedly");
    const headers = out().match(/retention housekeeping \(as of /g);
    // Ticks 1 + 3 render the full "as of" header; tick 2 renders the error line.
    // (The error line uses a different prefix.)
    expect(headers!.length).toBe(2);
  });

  it("WITHOUT --watch-keep-going, gather errors still propagate as exit 1", async () => {
    const { ctx, err } = buffers();
    const { conn } = cleanFixtures();
    const throwingRetention = {
      listPolicies: async () => {
        throw new Error("boom");
      },
      listTenantPolicies: async () => [],
      previewPrune: async () => [],
    } as unknown as PostgresTraceRetention;
    // No --watch-keep-going flag → existing exit-1 behavior preserved.
    const code = await runRetention(parsed("retention", "housekeeping", "--watch"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: throwingRetention,
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 5, setTimeoutFn: immediateSetTimeout },
    } as RetentionContext);
    expect(code).toBe(1);
    expect(err()).toContain("boom");
  });

  it("under --watch-keep-going + json, errors render as compact NDJSON envelope per tick", async () => {
    const { ctx, out } = buffers();
    const { conn } = cleanFixtures();
    let callCount = 0;
    const flakyRetention = {
      listPolicies: async () => {
        callCount++;
        if (callCount === 2) throw new Error("transient PG blip");
        return [];
      },
      listTenantPolicies: async () => [],
      previewPrune: async () => [],
    } as unknown as PostgresTraceRetention;
    const code = await runRetention(
      parsed("retention", "housekeeping", "--watch", "--watch-keep-going", "--format", "json"),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: flakyRetention,
        clockOverride: () => fixedNow,
        watchOverride: { maxIterations: 3, setTimeoutFn: immediateSetTimeout },
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines.length).toBe(3);
    // Tick 2 is an error envelope.
    const env2 = JSON.parse(lines[1]!) as { error?: { message: string }; tables?: unknown };
    expect(env2.error?.message).toBe("transient PG blip");
    expect(env2.tables).toBeUndefined();
    // Ticks 1 and 3 have the normal envelope.
    const env1 = JSON.parse(lines[0]!) as { tables?: unknown };
    expect(env1.tables).toBeDefined();
  });

  it("trip in middle tick survives a later non-tripping tick (sticky halted=true)", async () => {
    const { ctx, out } = buffers();
    const { conn } = cleanFixtures();
    // First call returns trip-worthy preview; subsequent calls return empty.
    let callCount = 0;
    const oscillatingRetention = {
      listPolicies: async () => [],
      listTenantPolicies: async () => [],
      previewPrune: async () => {
        callCount++;
        if (callCount === 1) {
          return [
            {
              tableName: "workflow_traces",
              status: "previewed" as const,
              wouldDeleteCount: 5_000_000,
              retentionDays: 30,
              cutoffMs: 0,
            },
          ];
        }
        return [];
      },
    } as unknown as PostgresTraceRetention;
    const code = await runRetention(
      parsed(
        "retention",
        "housekeeping",
        "--watch",
        "--watch-keep-going",
        "--threshold-alert",
        "wouldPruneCount:>1000000",
      ),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: oscillatingRetention,
        clockOverride: () => fixedNow,
        watchOverride: { maxIterations: 3, setTimeoutFn: immediateSetTimeout },
      } as RetentionContext,
    );
    // Tick 1 trips; ticks 2 + 3 don't. With sticky tracking, exit = 3.
    expect(code).toBe(3);
    // First THRESHOLD ALERTS appears once (tick 1).
    expect(out().match(/THRESHOLD ALERTS/g)!.length).toBe(1);
  });
});

describe("runRetention housekeeping --watch SIGINT bridge (M4.14.r)", () => {
  const fixedNow = new Date("2026-05-29T12:00:00.000Z");

  function fixtures() {
    const conn = fakeStatsConnection({
      workflow_traces: { total: "0", oldest: null },
      llm_call_traces: { total: "0", oldest: null },
      llm_latency_samples: { total: "0", oldest: null },
      tenant_retention_opt_out_history: { total: "0", oldest: null },
      gateway_pipeline_executions: { total: "0", oldest: null },
      rate_limit_decisions: { total: "0", oldest: null },
    });
    const retention = fakeRetention({ platform: [], tenant: [], preview: [] });
    return { conn, retention };
  }

  // M4.14.r captured SIGINT only; M4.14.p extends the bridge to register
  // BOTH SIGINT and SIGTERM under a shared AbortController. The capture
  // tracks each signal's handler separately so tests can assert both are
  // registered + verify per-signal abort semantics.
  function captureSignalRegistrar() {
    const captured: { handlers: Map<string, () => void> } = { handlers: new Map() };
    const removeCalls: { count: number; signals: string[] } = { count: 0, signals: [] };
    const registrar = (signal: string, handler: () => void): (() => void) => {
      captured.handlers.set(signal, handler);
      return () => {
        removeCalls.count++;
        removeCalls.signals.push(signal);
      };
    };
    return { registrar, captured, removeCalls };
  }

  it("installs the shutdown bridge under --watch when no abortSignal override is supplied (both signals)", async () => {
    const { ctx } = buffers();
    const { conn, retention } = fixtures();
    const { registrar, captured, removeCalls } = captureSignalRegistrar();
    let tickCount = 0;
    const immediateSetTimeout = (cb: () => void, _ms: number) => {
      tickCount++;
      cb();
      return 1 as unknown;
    };
    const code = await runRetention(parsed("retention", "housekeeping", "--watch"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: retention,
      clockOverride: () => fixedNow,
      watchOverride: {
        maxIterations: 1, // exit cleanly after 1 tick (no setTimeout call)
        setTimeoutFn: immediateSetTimeout,
        signalRegistrar: registrar,
      },
    } as RetentionContext);
    expect(code).toBe(0);
    // M4.14.p — both SIGINT and SIGTERM handlers registered + both removed.
    expect(captured.handlers.has("SIGINT")).toBe(true);
    expect(captured.handlers.has("SIGTERM")).toBe(true);
    expect(removeCalls.count).toBe(2);
    expect(removeCalls.signals.sort()).toEqual(["SIGINT", "SIGTERM"]);
    // maxIterations=1 + immediate setTimeout → 0 setTimeout calls because
    // the loop exited after tick 1 before waitInterval was called.
    expect(tickCount).toBe(0);
  });

  it("firing the captured SIGINT handler aborts the loop cleanly (exit 0)", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = fixtures();
    const { registrar, captured } = captureSignalRegistrar();
    let tickCount = 0;
    // setTimeout that fires SIGINT on its first call (simulating Ctrl-C
    // during the wait between ticks).
    const setTimeoutFiringSigint = (cb: () => void, _ms: number) => {
      tickCount++;
      const sigintHandler = captured.handlers.get("SIGINT");
      if (tickCount === 1 && sigintHandler !== undefined) {
        // Trigger SIGINT abort before the timeout fires.
        sigintHandler();
      }
      cb();
      return 1 as unknown;
    };
    const code = await runRetention(parsed("retention", "housekeeping", "--watch"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: retention,
      clockOverride: () => fixedNow,
      watchOverride: {
        maxIterations: 10, // would loop 10x if SIGINT didn't abort
        setTimeoutFn: setTimeoutFiringSigint,
        signalRegistrar: registrar,
      },
    } as RetentionContext);
    // Clean exit (NOT exit 130 — the bridge intercepts SIGINT cleanly).
    expect(code).toBe(0);
    // Tick 1 rendered; SIGINT fired during wait; loop exited.
    expect(out().match(/retention housekeeping \(as of /g)!.length).toBe(1);
  });

  it("does NOT install the bridge when abortSignal override is supplied (neither signal registered)", async () => {
    const { ctx } = buffers();
    const { conn, retention } = fixtures();
    const { registrar, captured, removeCalls } = captureSignalRegistrar();
    const controller = new AbortController();
    const code = await runRetention(parsed("retention", "housekeeping", "--watch"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: retention,
      clockOverride: () => fixedNow,
      watchOverride: {
        maxIterations: 1,
        setTimeoutFn: (cb: () => void) => {
          cb();
          return 1 as unknown;
        },
        abortSignal: controller.signal,
        signalRegistrar: registrar,
      },
    } as RetentionContext);
    expect(code).toBe(0);
    // Registrar was NOT called — the bridge was skipped because the
    // caller supplied an abortSignal directly.
    expect(captured.handlers.size).toBe(0);
    expect(removeCalls.count).toBe(0);
  });

  it("cleans up both signal handlers even when the loop throws (gather error without keep-going)", async () => {
    const { ctx } = buffers();
    const { conn } = fixtures();
    const { registrar, removeCalls } = captureSignalRegistrar();
    const throwingRetention = {
      listPolicies: async () => {
        throw new Error("simulated PG failure");
      },
      listTenantPolicies: async () => [],
      previewPrune: async () => [],
    } as unknown as PostgresTraceRetention;
    const code = await runRetention(parsed("retention", "housekeeping", "--watch"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: throwingRetention,
      clockOverride: () => fixedNow,
      watchOverride: {
        maxIterations: 5,
        setTimeoutFn: (cb: () => void) => {
          cb();
          return 1 as unknown;
        },
        signalRegistrar: registrar,
      },
    } as RetentionContext);
    expect(code).toBe(1);
    // M4.14.p — both signal handlers cleaned up even when the loop threw.
    expect(removeCalls.count).toBe(2);
    expect(removeCalls.signals.sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  // M4.14.p — Kubernetes / systemd / container managers send SIGTERM for
  // graceful shutdown. The bridge handles SIGTERM with the same semantic
  // as SIGINT — clean exit code 0 (or 3 under sticky-trip from M4.14.s)
  // with PG closed via the action's finally block.

  it("M4.14.p — firing the captured SIGTERM handler aborts the loop cleanly (Kubernetes shutdown)", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = fixtures();
    const { registrar, captured } = captureSignalRegistrar();
    let tickCount = 0;
    const setTimeoutFiringSigterm = (cb: () => void, _ms: number) => {
      tickCount++;
      const sigtermHandler = captured.handlers.get("SIGTERM");
      if (tickCount === 1 && sigtermHandler !== undefined) {
        sigtermHandler();
      }
      cb();
      return 1 as unknown;
    };
    const code = await runRetention(parsed("retention", "housekeeping", "--watch"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: retention,
      clockOverride: () => fixedNow,
      watchOverride: {
        maxIterations: 10,
        setTimeoutFn: setTimeoutFiringSigterm,
        signalRegistrar: registrar,
      },
    } as RetentionContext);
    // Clean exit (NOT 143 — the bridge intercepts SIGTERM cleanly).
    expect(code).toBe(0);
    expect(out().match(/retention housekeeping \(as of /g)!.length).toBe(1);
  });
});

describe("runRetention housekeeping --tenant (M4.14.u)", () => {
  const fixedNow = new Date("2026-05-29T12:00:00.000Z");

  function fixtures() {
    const conn = fakeStatsConnection({
      workflow_traces: { total: "1000000", oldest: "2026-04-01T00:00:00.000Z" },
      llm_call_traces: { total: "0", oldest: null },
      llm_latency_samples: { total: "0", oldest: null },
      tenant_retention_opt_out_history: { total: "0", oldest: null },
      gateway_pipeline_executions: { total: "0", oldest: null },
      rate_limit_decisions: { total: "0", oldest: null },
    });
    const tenant: TenantRetentionPolicyRow[] = [
      // TENANT_A has overrides on workflow_traces + llm_call_traces.
      {
        tenantId: TENANT_A,
        tableName: "workflow_traces",
        retentionDays: 365,
        enabled: true,
        optOut: false,
        optOutReason: null,
        optOutUntil: null,
        lastPrunedAt: "2026-05-20T00:00:00.000Z",
      },
      {
        tenantId: TENANT_A,
        tableName: "llm_call_traces",
        retentionDays: 30,
        enabled: false,
        optOut: true,
        optOutReason: "legal_hold:case#42",
        optOutUntil: "2099-01-01T00:00:00.000Z",
        lastPrunedAt: null,
      },
      // TENANT_B has only one override (workflow_traces) — used to verify
      // the filter discriminates correctly between tenants.
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
    ];
    const retention = fakeRetention({ platform: [], tenant, preview: [] });
    return { conn, retention };
  }

  it("exits 2 on invalid --tenant value (non-UUID)", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "housekeeping", "--tenant", "not-a-uuid"),
      ctx as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --tenant");
    expect(err()).toContain("must be a UUID");
  });

  it("accepts a valid UUID and renders tenantPolicy sections for the filtered tenant", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = fixtures();
    const code = await runRetention(parsed("retention", "housekeeping", "--tenant", TENANT_A), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: retention,
      clockOverride: () => fixedNow,
    } as RetentionContext);
    expect(code).toBe(0);
    const stdout = out();
    // Header includes the tenant filter callout.
    expect(stdout).toContain(`filtered to tenant ${TENANT_A}`);
    // workflow_traces shows TENANT_A's override (365d, enabled, no opt-out).
    expect(stdout).toMatch(
      /workflow_traces[\s\S]*?tenant policy:[\s\S]*?retention:\s+365 day\(s\) \(enabled\)[\s\S]*?opt-out:\s+no/,
    );
    // llm_call_traces shows TENANT_A's opt-out with reason + until.
    expect(stdout).toMatch(
      /llm_call_traces[\s\S]*?tenant policy:[\s\S]*?opt-out:\s+yes \(until 2099-01-01T00:00:00\.000Z, reason: legal_hold:case#42\)/,
    );
    // Tables where TENANT_A has no override show the no-override message.
    expect(stdout).toMatch(
      /rate_limit_decisions[\s\S]*?tenant policy:\s+\(no override — inherits platform default\)/,
    );
  });

  it("filter discriminates between tenants — TENANT_B sees its own override", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = fixtures();
    const code = await runRetention(parsed("retention", "housekeeping", "--tenant", TENANT_B), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: retention,
      clockOverride: () => fixedNow,
    } as RetentionContext);
    expect(code).toBe(0);
    const stdout = out();
    // TENANT_B's override is 60d (NOT TENANT_A's 365d).
    expect(stdout).toMatch(
      /workflow_traces[\s\S]*?tenant policy:[\s\S]*?retention:\s+60 day\(s\) \(enabled\)/,
    );
    expect(stdout).not.toContain("365 day(s)");
    // TENANT_B has no override on llm_call_traces.
    expect(stdout).toMatch(
      /llm_call_traces[\s\S]*?tenant policy:\s+\(no override — inherits platform default\)/,
    );
  });

  it("JSON envelope includes top-level tenantId + per-table tenantPolicy", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = fixtures();
    const code = await runRetention(
      parsed("retention", "housekeeping", "--format", "json", "--tenant", TENANT_A),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: retention,
        clockOverride: () => fixedNow,
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      tenantId: string;
      tables: Array<{
        tableName: string;
        tenantPolicy: TenantRetentionPolicyRow | null | undefined;
      }>;
    };
    expect(env.tenantId).toBe(TENANT_A);
    const wt = env.tables.find((t) => t.tableName === "workflow_traces")!;
    expect(wt.tenantPolicy).not.toBeNull();
    expect(wt.tenantPolicy!.retentionDays).toBe(365);
    expect(wt.tenantPolicy!.tenantId).toBe(TENANT_A);
    const lct = env.tables.find((t) => t.tableName === "llm_call_traces")!;
    expect(lct.tenantPolicy!.optOut).toBe(true);
    // No override = explicit null (not undefined) so JSON consumers can
    // distinguish "filter active, no policy" from "filter not active."
    const rl = env.tables.find((t) => t.tableName === "rate_limit_decisions")!;
    expect(rl.tenantPolicy).toBeNull();
  });

  it("WITHOUT --tenant, the envelope omits tenantId + per-table tenantPolicy entirely", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = fixtures();
    const code = await runRetention(parsed("retention", "housekeeping", "--format", "json"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: retention,
      clockOverride: () => fixedNow,
    } as RetentionContext);
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      tenantId?: string;
      tables: Array<{ tableName: string; tenantPolicy?: unknown }>;
    };
    expect(env.tenantId).toBeUndefined();
    for (const table of env.tables) {
      expect(table.tenantPolicy).toBeUndefined();
    }
  });

  it("composes with --threshold-alert (tenant filter is drill-down; alerts still evaluate against cross-tenant fields)", async () => {
    const { ctx, out } = buffers();
    const conn = fakeStatsConnection({
      workflow_traces: { total: "1000000", oldest: null },
      llm_call_traces: { total: "0", oldest: null },
      llm_latency_samples: { total: "0", oldest: null },
      tenant_retention_opt_out_history: { total: "0", oldest: null },
      gateway_pipeline_executions: { total: "0", oldest: null },
      rate_limit_decisions: { total: "0", oldest: null },
    });
    const platform: RetentionPolicyRow[] = [];
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
    ];
    const preview = [
      {
        tableName: "workflow_traces",
        status: "previewed" as const,
        wouldDeleteCount: 2_000_000,
        retentionDays: 30,
        cutoffMs: 0,
      },
    ];
    const retention = fakeRetention({ platform, tenant, preview });
    const code = await runRetention(
      parsed(
        "retention",
        "housekeeping",
        "--tenant",
        TENANT_A,
        "--threshold-alert",
        "wouldPruneCount:>1000000",
      ),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: retention,
        clockOverride: () => fixedNow,
      } as RetentionContext,
    );
    expect(code).toBe(3);
    // Alert still trips (cross-tenant aggregate of 2M > 1M).
    expect(out()).toContain("THRESHOLD ALERTS");
    // Tenant filter still active in the header.
    expect(out()).toContain(`filtered to tenant ${TENANT_A}`);
    // tenant policy rendered for workflow_traces too.
    expect(out()).toContain("365 day(s)");
  });
});

describe("runRetention housekeeping --all-tenants (M4.14.q)", () => {
  const fixedNow = new Date("2026-05-29T12:00:00.000Z");

  function fixtures() {
    const conn = fakeStatsConnection({
      workflow_traces: { total: "1000000", oldest: "2026-04-01T00:00:00.000Z" },
      llm_call_traces: { total: "0", oldest: null },
      llm_latency_samples: { total: "0", oldest: null },
      tenant_retention_opt_out_history: { total: "0", oldest: null },
      gateway_pipeline_executions: { total: "0", oldest: null },
      rate_limit_decisions: { total: "0", oldest: null },
    });
    // Mix of overrides — TENANT_A overrides workflow_traces + llm_call_traces;
    // TENANT_B overrides workflow_traces. rate_limit_decisions has zero
    // overrides (exercises the empty-array placeholder). Unsorted input
    // verifies the gather sorts by tenantId for stable output.
    const tenant: TenantRetentionPolicyRow[] = [
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
        tableName: "workflow_traces",
        retentionDays: 365,
        enabled: true,
        optOut: false,
        optOutReason: null,
        optOutUntil: null,
        lastPrunedAt: null,
      },
      {
        tenantId: TENANT_A,
        tableName: "llm_call_traces",
        retentionDays: 30,
        enabled: false,
        optOut: true,
        optOutReason: "legal_hold:case#42",
        optOutUntil: "2099-01-01T00:00:00.000Z",
        lastPrunedAt: null,
      },
    ];
    const retention = fakeRetention({ platform: [], tenant, preview: [] });
    return { conn, retention };
  }

  it("exits 2 when --tenant and --all-tenants are both set (mutual exclusivity)", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "housekeeping", "--tenant", TENANT_A, "--all-tenants"),
      ctx as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("mutually exclusive");
  });

  it("renders per-table matrix block in human output with overrides sorted by tenantId", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = fixtures();
    const code = await runRetention(parsed("retention", "housekeeping", "--all-tenants"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: retention,
      clockOverride: () => fixedNow,
    } as RetentionContext);
    expect(code).toBe(0);
    const stdout = out();
    expect(stdout).toContain("matrix mode — all tenants");
    // workflow_traces has 2 overrides → "matrix (2):" header + both lines.
    expect(stdout).toMatch(/workflow_traces[\s\S]*?matrix \(2\):/);
    // TENANT_A (...000A) sorts before TENANT_B (...000B) — verify the
    // tenants appear in sorted order via a single regex spanning the table
    // block.
    expect(stdout).toMatch(
      new RegExp(
        `workflow_traces[\\s\\S]*?${TENANT_A}\\s+retention=365d[\\s\\S]*?${TENANT_B}\\s+retention=60d`,
      ),
    );
    // llm_call_traces has 1 override (TENANT_A opt-out).
    expect(stdout).toMatch(
      /llm_call_traces[\s\S]*?matrix \(1\):[\s\S]*?retention=30d \(disabled\) opt-out=yes/,
    );
    // Tables with no overrides surface the empty-matrix placeholder.
    expect(stdout).toMatch(
      /rate_limit_decisions[\s\S]*?matrix:\s+\(no per-tenant overrides on this table\)/,
    );
  });

  it("JSON envelope includes allTenants:true + each table has tenantOverrides[] (sorted)", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = fixtures();
    const code = await runRetention(
      parsed("retention", "housekeeping", "--all-tenants", "--format", "json"),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: retention,
        clockOverride: () => fixedNow,
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      action: string;
      allTenants: boolean;
      tenantId?: string;
      tables: Array<{ tableName: string; tenantOverrides: Array<{ tenantId: string }> }>;
    };
    expect(env.allTenants).toBe(true);
    expect(env.tenantId).toBeUndefined();
    const wt = env.tables.find((t) => t.tableName === "workflow_traces")!;
    expect(wt.tenantOverrides).toHaveLength(2);
    expect(wt.tenantOverrides[0]!.tenantId).toBe(TENANT_A);
    expect(wt.tenantOverrides[1]!.tenantId).toBe(TENANT_B);
    const rl = env.tables.find((t) => t.tableName === "rate_limit_decisions")!;
    expect(rl.tenantOverrides).toEqual([]);
  });

  it("omitting --all-tenants preserves backward-compat envelope shape (no tenantOverrides field)", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = fixtures();
    const code = await runRetention(parsed("retention", "housekeeping", "--format", "json"), {
      ...ctx,
      pgConnectionOverride: conn,
      retentionOverride: retention,
      clockOverride: () => fixedNow,
    } as RetentionContext);
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      allTenants?: boolean;
      tables: Array<{ tableName: string; tenantOverrides?: unknown }>;
    };
    expect(env.allTenants).toBeUndefined();
    for (const t of env.tables) {
      expect("tenantOverrides" in t).toBe(false);
    }
  });

  it("composes with --threshold-alert — drill-down preserves CI-gate semantic (exit 3 on trip)", async () => {
    const { ctx, out } = buffers();
    const { conn, retention } = fixtures();
    const code = await runRetention(
      parsed(
        "retention",
        "housekeeping",
        "--all-tenants",
        "--threshold-alert",
        "totalRowCount:>500000",
      ),
      {
        ...ctx,
        pgConnectionOverride: conn,
        retentionOverride: retention,
        clockOverride: () => fixedNow,
      } as RetentionContext,
    );
    expect(code).toBe(3);
    expect(out()).toContain("THRESHOLD ALERTS");
    expect(out()).toContain("matrix mode — all tenants");
  });
});
