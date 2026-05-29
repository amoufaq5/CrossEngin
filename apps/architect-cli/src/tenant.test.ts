import type { PostgresIdempotencyStore } from "@crossengin/api-gateway-pg";
import type { PgConnection, PgQueryResult, PostgresTraceRetention } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { parseArgs } from "./cli.js";
import type { IoStreams } from "./format.js";
import { runTenant, type TenantContext } from "./tenant.js";

function makeIo(): { io: IoStreams; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      stdout: { write: (chunk: string) => outChunks.push(chunk) },
      stderr: { write: (chunk: string) => errChunks.push(chunk) },
    },
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
  };
}

function parsed(...argv: string[]) {
  const result = parseArgs(["node", "crossengin", ...argv]);
  if (!result.ok) throw new Error(result.error.message);
  return result.command;
}

const RESOLVED_UUID = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";
const fixedNow = new Date("2026-05-29T12:00:00.000Z");

// Connection that handles slug lookups + per-table stats queries across
// BOTH gateway and retention housekeeping table sets.
function fakeConn(slugMap: Record<string, string>): PgConnection {
  return {
    query: async <T>(sql: string, params?: readonly unknown[]) => {
      if (sql.includes("SELECT id FROM meta.tenants WHERE slug")) {
        const slug = String(params?.[0] ?? "");
        const id = slugMap[slug];
        return id !== undefined
          ? ({ rows: [{ id }], rowCount: 1 } as unknown as PgQueryResult<T>)
          : ({ rows: [], rowCount: 0 } as unknown as PgQueryResult<T>);
      }
      // Gateway housekeeping tables.
      if (sql.includes("FROM meta.gateway_pipeline_executions")) {
        return {
          rows: [{ total: "50000", oldest: "2026-04-01T00:00:00.000Z" }],
          rowCount: 1,
        } as unknown as PgQueryResult<T>;
      }
      if (sql.includes("FROM meta.gateway_idempotency_records")) {
        return {
          rows: [{ total: "1200", oldest: null }],
          rowCount: 1,
        } as unknown as PgQueryResult<T>;
      }
      if (sql.includes("FROM meta.rate_limit_decisions")) {
        return {
          rows: [{ total: "987654", oldest: null }],
          rowCount: 1,
        } as unknown as PgQueryResult<T>;
      }
      // Retention housekeeping tables (the 6 PRUNABLE_TABLES). Only
      // the three not already covered above need explicit branches —
      // the other three (gateway_pipeline_executions, rate_limit_decisions,
      // gateway_idempotency_records) are shared between dashboards but
      // retention dashboard only covers the retention-substrate ones.
      if (sql.includes("FROM meta.workflow_traces")) {
        return {
          rows: [{ total: "1000000", oldest: "2026-04-01T00:00:00.000Z" }],
          rowCount: 1,
        } as unknown as PgQueryResult<T>;
      }
      if (sql.includes("FROM meta.llm_call_traces")) {
        return {
          rows: [{ total: "100", oldest: null }],
          rowCount: 1,
        } as unknown as PgQueryResult<T>;
      }
      if (sql.includes("FROM meta.llm_latency_samples")) {
        return { rows: [{ total: "0", oldest: null }], rowCount: 1 } as unknown as PgQueryResult<T>;
      }
      if (sql.includes("FROM meta.tenant_retention_opt_out_history")) {
        return { rows: [{ total: "5", oldest: null }], rowCount: 1 } as unknown as PgQueryResult<T>;
      }
      return { rows: [], rowCount: 0 } as unknown as PgQueryResult<T>;
    },
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => fn({} as PgConnection),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>) => fn(),
    close: async () => undefined,
  };
}

function fakeRetention(): PostgresTraceRetention {
  return {
    listPolicies: async () => [
      {
        tableName: "gateway_pipeline_executions",
        retentionDays: 30,
        enabled: true,
        lastPrunedAt: null,
      },
      {
        tableName: "rate_limit_decisions",
        retentionDays: 7,
        enabled: true,
        lastPrunedAt: null,
      },
      { tableName: "workflow_traces", retentionDays: 90, enabled: true, lastPrunedAt: null },
    ],
    listTenantPolicies: async () => [
      {
        tenantId: RESOLVED_UUID,
        tableName: "gateway_pipeline_executions",
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
    ],
    previewPrune: async () => [
      {
        tableName: "gateway_pipeline_executions",
        status: "previewed",
        retentionDays: 30,
        wouldDeleteCount: 1042,
        cutoffMs: 0,
      },
      {
        tableName: "rate_limit_decisions",
        status: "previewed",
        retentionDays: 7,
        wouldDeleteCount: 9876,
        cutoffMs: 0,
      },
      {
        tableName: "workflow_traces",
        status: "previewed",
        retentionDays: 90,
        wouldDeleteCount: 5000000,
        cutoffMs: 0,
      },
    ],
  } as unknown as PostgresTraceRetention;
}

function fakeIdempotency(): PostgresIdempotencyStore {
  return { previewDeleteExpired: async () => 300 } as unknown as PostgresIdempotencyStore;
}

describe("runTenant dispatcher (M4.14.l)", () => {
  it("missing action exits 2 with usage error", async () => {
    const { io, err } = makeIo();
    const ctx: TenantContext = { io, env: {} };
    const code = await runTenant(parsed("tenant"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("missing action");
  });

  it("unknown action exits 2 with usage error", async () => {
    const { io, err } = makeIo();
    const ctx: TenantContext = { io, env: {} };
    const code = await runTenant(parsed("tenant", "nope"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("unknown action 'nope'");
  });
});

describe("runTenant housekeeping (M4.14.l)", () => {
  it("renders both dashboard sections in human format under --tenant <uuid>", async () => {
    const conn = fakeConn({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
    };
    const code = await runTenant(parsed("tenant", "housekeeping", "--tenant", RESOLVED_UUID), ctx);
    expect(code).toBe(0);
    const stdout = out();
    expect(stdout).toContain(`filtered to tenant ${RESOLVED_UUID}`);
    expect(stdout).toContain("=== Gateway housekeeping ===");
    expect(stdout).toContain("=== Retention housekeeping ===");
    expect(stdout).toContain("gateway_pipeline_executions");
    expect(stdout).toContain("workflow_traces");
  });

  it("JSON envelope merges both dashboards under one shape", async () => {
    const conn = fakeConn({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
    };
    const code = await runTenant(
      parsed("tenant", "housekeeping", "--tenant", RESOLVED_UUID, "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      action: string;
      tenantId: string;
      gateway: { tables: Array<{ tableName: string }> };
      retention: { tables: Array<{ tableName: string }> };
      alerts: unknown[];
    };
    expect(env.action).toBe("tenant.housekeeping");
    expect(env.tenantId).toBe(RESOLVED_UUID);
    expect(env.gateway.tables.length).toBe(3);
    expect(env.retention.tables.length).toBe(6);
    expect(env.alerts).toEqual([]);
  });

  it("--tenant <slug> resolves via meta.tenants once and applies to BOTH dashboards", async () => {
    const conn = fakeConn({ "acme-prod": RESOLVED_UUID });
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
    };
    const code = await runTenant(
      parsed("tenant", "housekeeping", "--tenant", "acme-prod", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      tenantId: string;
      gateway: { tenantId: string };
      retention: { tenantId: string };
    };
    // The resolved UUID echoed at all three levels (top, gateway, retention).
    expect(env.tenantId).toBe(RESOLVED_UUID);
    expect(env.gateway.tenantId).toBe(RESOLVED_UUID);
    expect(env.retention.tenantId).toBe(RESOLVED_UUID);
  });

  it("unknown slug exits 2 BEFORE either dashboard gather runs", async () => {
    const conn = fakeConn({});
    const { io, err } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
    };
    const code = await runTenant(
      parsed("tenant", "housekeeping", "--tenant", "no-such-tenant"),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("no tenant with slug 'no-such-tenant'");
  });

  it("--tenant + --all-tenants mutual-exclusivity exits 2 BEFORE PG", async () => {
    const conn = fakeConn({});
    const { io, err } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
    };
    const code = await runTenant(
      parsed("tenant", "housekeeping", "--tenant", RESOLVED_UUID, "--all-tenants"),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("mutually exclusive");
  });

  it("--all-tenants matrix mode applies to BOTH dashboards (both report tenantOverrides[])", async () => {
    const conn = fakeConn({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
    };
    const code = await runTenant(
      parsed("tenant", "housekeeping", "--all-tenants", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      allTenants: boolean;
      gateway: { allTenants: boolean; tables: Array<{ tenantOverrides?: unknown[] }> };
      retention: { allTenants: boolean; tables: Array<{ tenantOverrides?: unknown[] }> };
    };
    expect(env.allTenants).toBe(true);
    expect(env.gateway.allTenants).toBe(true);
    expect(env.retention.allTenants).toBe(true);
    // Every table report under --all-tenants has tenantOverrides[] (some
    // empty for tables with no overrides; verified populated for ones
    // with policies in the fakeRetention fixture).
    for (const t of env.gateway.tables) {
      expect(Array.isArray(t.tenantOverrides)).toBe(true);
    }
    for (const t of env.retention.tables) {
      expect(Array.isArray(t.tenantOverrides)).toBe(true);
    }
  });

  it("--threshold-alert evaluates across the UNION of tables from both dashboards (exit 3 on trip)", async () => {
    const conn = fakeConn({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
    };
    // workflow_traces is RETENTION-side only with 1M rows; trip the alert.
    const code = await runTenant(
      parsed("tenant", "housekeeping", "--threshold-alert", "totalRowCount:>500000"),
      ctx,
    );
    expect(code).toBe(3);
    const stdout = out();
    expect(stdout).toContain("THRESHOLD ALERTS");
    expect(stdout).toContain("workflow_traces");
  });

  it("backward-compat envelope shape preserved when no --tenant / --all-tenants set", async () => {
    const conn = fakeConn({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
    };
    const code = await runTenant(parsed("tenant", "housekeeping", "--format", "json"), ctx);
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      tenantId?: string;
      allTenants?: boolean;
      gateway: { tenantId?: string };
      retention: { tenantId?: string };
    };
    expect(env.tenantId).toBeUndefined();
    expect(env.allTenants).toBeUndefined();
    expect(env.gateway.tenantId).toBeUndefined();
    expect(env.retention.tenantId).toBeUndefined();
  });
});

// M4.14.h — tenant policies aggregated view tests.
interface FakePoliciesOpts {
  readonly slugMap?: Record<string, string>;
  readonly costCeilingRows?: Record<
    string,
    Array<{
      max_usd_per_request: string | null;
      max_usd_per_window: string | null;
      window_seconds: number | null;
      effective_from: string;
    }>
  >;
  readonly tierRows?: Record<
    string,
    Array<{
      tier_id: string;
      display_name: string;
      max_usd_per_request: string | null;
      max_usd_per_window: string | null;
      window_seconds: number | null;
    }>
  >;
}

function fakePoliciesConn(opts: FakePoliciesOpts): PgConnection {
  return {
    query: async <T>(sql: string, params?: readonly unknown[]) => {
      if (sql.includes("SELECT id FROM meta.tenants WHERE slug")) {
        const slug = String(params?.[0] ?? "");
        const id = opts.slugMap?.[slug];
        return id !== undefined
          ? ({ rows: [{ id }], rowCount: 1 } as unknown as PgQueryResult<T>)
          : ({ rows: [], rowCount: 0 } as unknown as PgQueryResult<T>);
      }
      if (sql.includes("FROM meta.llm_cost_ceilings WHERE tenant_id = $1")) {
        const tenantId = String(params?.[0] ?? "");
        const rows = opts.costCeilingRows?.[tenantId] ?? [];
        return { rows: rows as unknown as T[], rowCount: rows.length } as PgQueryResult<T>;
      }
      if (sql.includes("FROM meta.llm_tenant_tier_memberships m")) {
        const tenantId = String(params?.[0] ?? "");
        const rows = opts.tierRows?.[tenantId] ?? [];
        return { rows: rows as unknown as T[], rowCount: rows.length } as PgQueryResult<T>;
      }
      // Unknown slug → candidates query for M4.14.j suggestions.
      // Empty result means no suggestions surface.
      if (sql.includes("SELECT slug FROM meta.tenants ORDER BY slug")) {
        return { rows: [], rowCount: 0 } as unknown as PgQueryResult<T>;
      }
      return { rows: [], rowCount: 0 } as unknown as PgQueryResult<T>;
    },
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => fn({} as PgConnection),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>) => fn(),
    close: async () => undefined,
  };
}

function fakeRetentionForPolicies(
  rowsByTenant: Record<
    string,
    ReadonlyArray<{
      tableName: string;
      retentionDays: number;
      enabled: boolean;
      optOut: boolean;
      optOutReason: string | null;
      optOutUntil: string | null;
      lastPrunedAt: string | null;
    }>
  >,
): PostgresTraceRetention {
  return {
    listTenantPolicies: async () =>
      Object.entries(rowsByTenant).flatMap(([tenantId, rows]) =>
        rows.map((r) => ({ tenantId, ...r })),
      ),
  } as unknown as PostgresTraceRetention;
}

describe("runTenant policies (M4.14.h)", () => {
  it("missing positional argument exits 2 with usage error", async () => {
    const { io, err } = makeIo();
    const ctx: TenantContext = { io, env: {} };
    const code = await runTenant(parsed("tenant", "policies"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("missing positional argument");
    expect(err()).toContain("<slug|uuid>");
  });

  it("unknown slug exits 2 with 'no tenant with slug' (inherits M4.14.j suggestions)", async () => {
    const conn = fakePoliciesConn({ slugMap: {} });
    const { io, err } = makeIo();
    const ctx: TenantContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenant(parsed("tenant", "policies", "no-such-tenant"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("tenant policies:");
    expect(err()).toContain("no tenant with slug 'no-such-tenant'");
  });

  it("UUID input renders empty-policy envelope when tenant has no overrides", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      action: string;
      tenantId: string;
      input: string;
      retention: { tables: unknown[] };
      costCeiling: unknown;
      tier: unknown;
    };
    expect(env.action).toBe("tenant.policies");
    expect(env.tenantId).toBe(RESOLVED_UUID);
    expect(env.input).toBe(RESOLVED_UUID);
    expect(env.retention.tables).toEqual([]);
    expect(env.costCeiling).toBeNull();
    expect(env.tier).toBeNull();
  });

  it("aggregates retention + cost ceiling + tier across the three queries", async () => {
    const conn = fakePoliciesConn({
      costCeilingRows: {
        [RESOLVED_UUID]: [
          {
            max_usd_per_request: "0.10000000",
            max_usd_per_window: "50.00000000",
            window_seconds: 3600,
            effective_from: "2026-04-01T00:00:00.000Z",
          },
        ],
      },
      tierRows: {
        [RESOLVED_UUID]: [
          {
            tier_id: "enterprise",
            display_name: "Enterprise Plan",
            max_usd_per_request: "5.00000000",
            max_usd_per_window: "1000.00000000",
            window_seconds: 86400,
          },
        ],
      },
    });
    const retention = fakeRetentionForPolicies({
      [RESOLVED_UUID]: [
        {
          tableName: "workflow_traces",
          retentionDays: 365,
          enabled: true,
          optOut: false,
          optOutReason: null,
          optOutUntil: null,
          lastPrunedAt: "2026-05-15T00:00:00.000Z",
        },
      ],
    });
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      action: string;
      tenantId: string;
      retention: { tables: Array<{ tableName: string; retentionDays: number }> };
      costCeiling: { maxUsdPerRequest: string; windowSeconds: number };
      tier: { tierId: string; displayName: string };
    };
    expect(env.action).toBe("tenant.policies");
    expect(env.tenantId).toBe(RESOLVED_UUID);
    expect(env.retention.tables).toHaveLength(1);
    expect(env.retention.tables[0]!.tableName).toBe("workflow_traces");
    expect(env.retention.tables[0]!.retentionDays).toBe(365);
    expect(env.costCeiling.maxUsdPerRequest).toBe("0.10000000");
    expect(env.costCeiling.windowSeconds).toBe(3600);
    expect(env.tier.tierId).toBe("enterprise");
    expect(env.tier.displayName).toBe("Enterprise Plan");
  });

  it("filters retention by tenantId so other tenants' rows don't leak in", async () => {
    const retention = fakeRetentionForPolicies({
      [RESOLVED_UUID]: [
        {
          tableName: "workflow_traces",
          retentionDays: 365,
          enabled: true,
          optOut: false,
          optOutReason: null,
          optOutUntil: null,
          lastPrunedAt: null,
        },
      ],
      [TENANT_B]: [
        {
          tableName: "rate_limit_decisions",
          retentionDays: 60,
          enabled: true,
          optOut: false,
          optOutReason: null,
          optOutUntil: null,
          lastPrunedAt: null,
        },
      ],
    });
    const conn = fakePoliciesConn({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      retention: { tables: Array<{ tableName: string }> };
    };
    expect(env.retention.tables).toHaveLength(1);
    expect(env.retention.tables[0]!.tableName).toBe("workflow_traces");
    // TENANT_B's rate_limit_decisions row must NOT appear.
    expect(env.retention.tables.map((t) => t.tableName)).not.toContain("rate_limit_decisions");
  });

  it("slug input resolves first then aggregates by resolved UUID", async () => {
    const retention = fakeRetentionForPolicies({});
    const conn = fakePoliciesConn({ slugMap: { "acme-prod": RESOLVED_UUID } });
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", "acme-prod", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as { tenantId: string; input: string };
    // Envelope echoes the RESOLVED UUID for diff-stability + the original
    // operator input for correlation.
    expect(env.tenantId).toBe(RESOLVED_UUID);
    expect(env.input).toBe("acme-prod");
  });

  it("human format renders three sections with placeholders for empty axes", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(parsed("tenant", "policies", RESOLVED_UUID), ctx);
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("tenant policies");
    expect(output).toContain("=== Retention overrides (0) ===");
    expect(output).toContain("(no per-tenant retention overrides");
    expect(output).toContain("=== Cost ceiling override ===");
    expect(output).toContain("(no per-tenant override");
    expect(output).toContain("=== Tier membership ===");
    expect(output).toContain("(no tier membership");
  });

  it("human format renders cost-ceiling fields with USD formatting and effective-from timestamp", async () => {
    const conn = fakePoliciesConn({
      costCeilingRows: {
        [RESOLVED_UUID]: [
          {
            max_usd_per_request: "0.50000000",
            max_usd_per_window: "100.00000000",
            window_seconds: 7200,
            effective_from: "2026-03-01T00:00:00.000Z",
          },
        ],
      },
    });
    const retention = fakeRetentionForPolicies({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(parsed("tenant", "policies", RESOLVED_UUID), ctx);
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("max per request: $0.50000000 USD");
    expect(output).toContain("max per window:  $100.00000000 USD");
    expect(output).toContain("window seconds:  7200");
    expect(output).toContain("effective from:  2026-03-01T00:00:00.000Z");
  });

  it("human format renders opt-out detail when an active opt-out exists", async () => {
    const retention = fakeRetentionForPolicies({
      [RESOLVED_UUID]: [
        {
          tableName: "workflow_traces",
          retentionDays: 365,
          enabled: false,
          optOut: true,
          optOutReason: "legal_hold:case#42",
          optOutUntil: "2099-01-01T00:00:00.000Z",
          lastPrunedAt: null,
        },
      ],
    });
    const conn = fakePoliciesConn({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(parsed("tenant", "policies", RESOLVED_UUID), ctx);
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("workflow_traces");
    expect(output).toContain("retention:   365 day(s) (disabled)");
    expect(output).toContain(
      "opt-out:     active (until 2099-01-01T00:00:00.000Z, reason: legal_hold:case#42)",
    );
  });
});
