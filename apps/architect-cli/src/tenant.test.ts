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
// M4.14.a — additional tenant for N-way --add-tenant test cases.
const TENANT_C = "00000000-0000-4000-8000-00000000000c";
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
  // M4.14.b — tier-definition lookups (not via membership) for
  // --vs-tier synthetic-RHS comparisons. Keyed by tierId.
  readonly tierDefinitions?: Record<
    string,
    {
      tier_id: string;
      display_name: string;
      max_usd_per_request: string | null;
      max_usd_per_window: string | null;
      window_seconds: number | null;
    }
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
      // M4.14.b — direct tier-definition lookup by tierId (no
      // membership join) for --vs-tier synthetic-RHS comparisons.
      if (sql.includes("FROM meta.llm_cost_tiers") && sql.includes("WHERE tier_id = $1")) {
        const tierId = String(params?.[0] ?? "");
        const def = opts.tierDefinitions?.[tierId];
        return def !== undefined
          ? ({ rows: [def as unknown as T], rowCount: 1 } as PgQueryResult<T>)
          : ({ rows: [], rowCount: 0 } as unknown as PgQueryResult<T>);
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

describe("runTenant policies --effective (M4.14.g)", () => {
  it("default mode (no --effective) omits effective field from envelope (backward compat)", async () => {
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
    const env = JSON.parse(out()) as Record<string, unknown>;
    expect("effective" in env).toBe(false);
  });

  it("--effective with override present surfaces source='override' + ceiling from override row", async () => {
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
    const retention = fakeRetentionForPolicies({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--effective", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      effective: {
        source: string;
        ceiling: { maxUsdPerRequest: string; windowSeconds: number };
        tierId?: string;
      };
    };
    expect(env.effective.source).toBe("override");
    // Override beats tier — the override values surface, NOT the tier values.
    expect(env.effective.ceiling.maxUsdPerRequest).toBe("0.10000000");
    expect(env.effective.ceiling.windowSeconds).toBe(3600);
    expect(env.effective.tierId).toBeUndefined();
  });

  it("--effective with only tier present surfaces source='tier' + tierId echoed", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [
          {
            tier_id: "pro",
            display_name: "Pro Plan",
            max_usd_per_request: "1.00000000",
            max_usd_per_window: "200.00000000",
            window_seconds: 86400,
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
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--effective", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      effective: {
        source: string;
        ceiling: { maxUsdPerRequest: string };
        tierId?: string;
      };
    };
    expect(env.effective.source).toBe("tier");
    expect(env.effective.ceiling.maxUsdPerRequest).toBe("1.00000000");
    expect(env.effective.tierId).toBe("pro");
  });

  it("--effective with neither override nor tier surfaces source='none' + no ceiling field", async () => {
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
      parsed("tenant", "policies", RESOLVED_UUID, "--effective", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      effective: { source: string; ceiling?: unknown };
    };
    expect(env.effective.source).toBe("none");
    // The "none" variant has no ceiling field — runtime falls back to
    // router-level global config.
    expect(env.effective.ceiling).toBeUndefined();
  });

  it("--effective does NOT issue an extra PG query — derives from already-fetched axes", async () => {
    const queries: string[] = [];
    const conn: PgConnection = {
      query: async <T>(sql: string, _params?: readonly unknown[]) => {
        queries.push(sql);
        if (sql.includes("FROM meta.llm_cost_ceilings WHERE tenant_id = $1")) {
          return {
            rows: [
              {
                max_usd_per_request: "0.25000000",
                max_usd_per_window: null,
                window_seconds: null,
                effective_from: "2026-04-01T00:00:00.000Z",
              },
            ] as unknown as T[],
            rowCount: 1,
          } as PgQueryResult<T>;
        }
        if (sql.includes("FROM meta.llm_tenant_tier_memberships m")) {
          return { rows: [], rowCount: 0 } as PgQueryResult<T>;
        }
        return { rows: [], rowCount: 0 } as PgQueryResult<T>;
      },
      transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => fn({} as PgConnection),
      withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>) => fn(),
      close: async () => undefined,
    };
    const retention = fakeRetentionForPolicies({});
    const { io } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--effective", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    // Two queries: cost_ceilings + tier_memberships. The effective view
    // is derived client-side from those rows — no 3rd "resolve" query.
    expect(queries).toHaveLength(2);
    expect(queries.some((q) => q.includes("FROM meta.llm_cost_ceilings"))).toBe(true);
    expect(queries.some((q) => q.includes("FROM meta.llm_tenant_tier_memberships"))).toBe(true);
  });

  it("human format renders the effective-policy section when --effective is set", async () => {
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
    });
    const retention = fakeRetentionForPolicies({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(parsed("tenant", "policies", RESOLVED_UUID, "--effective"), ctx);
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("=== Effective policy (source: override) ===");
    expect(output).toContain("max per request: $0.10000000 USD");
  });

  it("human format renders the source='none' placeholder when no override AND no tier", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(parsed("tenant", "policies", RESOLVED_UUID, "--effective"), ctx);
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("=== Effective policy (source: none) ===");
    expect(output).toContain("(no per-tenant or tier policy configured");
    expect(output).toContain("router-level global");
  });
});

// M4.14.f — tenant policies --diff tests. Closes ADR-0280 Q5.
// Reuses the module-scoped TENANT_B constant for the right-hand side.

describe("runTenant policies --diff (M4.14.f)", () => {
  it("identical policies on both sides → empty fieldDiffs + 'No differences' human output", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [
          {
            tier_id: "pro",
            display_name: "Pro Plan",
            max_usd_per_request: "1.00000000",
            max_usd_per_window: "200.00000000",
            window_seconds: 86400,
          },
        ],
        [TENANT_B]: [
          {
            tier_id: "pro",
            display_name: "Pro Plan",
            max_usd_per_request: "1.00000000",
            max_usd_per_window: "200.00000000",
            window_seconds: 86400,
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
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--diff", TENANT_B),
      ctx,
    );
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("Diff between tenant policies:");
    expect(output).toContain("No differences");
  });

  it("JSON envelope shape: action='tenant.policies.diff' + left + right + fieldDiffs", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [
          {
            tier_id: "free",
            display_name: "Free",
            max_usd_per_request: "0.05000000",
            max_usd_per_window: "5.00000000",
            window_seconds: 3600,
          },
        ],
        [TENANT_B]: [
          {
            tier_id: "enterprise",
            display_name: "Enterprise",
            max_usd_per_request: "5.00000000",
            max_usd_per_window: "1000.00000000",
            window_seconds: 86400,
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
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--diff", TENANT_B, "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      action: string;
      left: { tenantId: string };
      right: { tenantId: string };
      fieldDiffs: Array<{ axis: string; field: string; valueA: unknown; valueB: unknown }>;
    };
    expect(env.action).toBe("tenant.policies.diff");
    expect(env.left.tenantId).toBe(RESOLVED_UUID);
    expect(env.right.tenantId).toBe(TENANT_B);
    expect(env.fieldDiffs.some((d) => d.field === "tier.tierId")).toBe(true);
    const tierDiff = env.fieldDiffs.find((d) => d.field === "tier.tierId");
    expect(tierDiff?.valueA).toBe("free");
    expect(tierDiff?.valueB).toBe("enterprise");
  });

  it("retention table on only one side surfaces 'exists' diff (not per-field diffs)", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({
      [RESOLVED_UUID]: [
        {
          tableName: "events",
          retentionDays: 30,
          enabled: true,
          optOut: false,
          optOutReason: null,
          optOutUntil: null,
          lastPrunedAt: null,
        },
      ],
      [TENANT_B]: [],
    });
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--diff", TENANT_B, "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      fieldDiffs: Array<{ field: string; valueA: unknown; valueB: unknown }>;
    };
    const tableDiffs = env.fieldDiffs.filter((d) => d.field.startsWith("retention.events"));
    expect(tableDiffs).toHaveLength(1);
    expect(tableDiffs[0]!.field).toBe("retention.events.exists");
    expect(tableDiffs[0]!.valueA).toBe(true);
    expect(tableDiffs[0]!.valueB).toBe(false);
  });

  it("retention table on both sides with different retentionDays surfaces per-field diff", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({
      [RESOLVED_UUID]: [
        {
          tableName: "events",
          retentionDays: 30,
          enabled: true,
          optOut: false,
          optOutReason: null,
          optOutUntil: null,
          lastPrunedAt: null,
        },
      ],
      [TENANT_B]: [
        {
          tableName: "events",
          retentionDays: 90,
          enabled: true,
          optOut: false,
          optOutReason: null,
          optOutUntil: null,
          lastPrunedAt: null,
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
      parsed("tenant", "policies", RESOLVED_UUID, "--diff", TENANT_B, "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      fieldDiffs: Array<{ field: string; valueA: unknown; valueB: unknown }>;
    };
    const retentionDaysDiff = env.fieldDiffs.find(
      (d) => d.field === "retention.events.retentionDays",
    );
    expect(retentionDaysDiff).toBeDefined();
    expect(retentionDaysDiff!.valueA).toBe(30);
    expect(retentionDaysDiff!.valueB).toBe(90);
    // No 'exists' diff — both sides have the table.
    expect(env.fieldDiffs.find((d) => d.field === "retention.events.exists")).toBeUndefined();
  });

  it("cost ceiling on only one side → single 'costCeiling.exists' diff (not per-field)", async () => {
    const conn = fakePoliciesConn({
      costCeilingRows: {
        [RESOLVED_UUID]: [
          {
            max_usd_per_request: "0.10000000",
            max_usd_per_window: null,
            window_seconds: null,
            effective_from: "2026-04-01T00:00:00.000Z",
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
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--diff", TENANT_B, "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      fieldDiffs: Array<{ field: string; valueA: unknown; valueB: unknown }>;
    };
    const ceilingDiffs = env.fieldDiffs.filter((d) => d.field.startsWith("costCeiling"));
    expect(ceilingDiffs).toHaveLength(1);
    expect(ceilingDiffs[0]!.field).toBe("costCeiling.exists");
    expect(ceilingDiffs[0]!.valueA).toBe(true);
    expect(ceilingDiffs[0]!.valueB).toBe(false);
  });

  it("same tier on both sides → no tier diff (tier-policy fields identical by construction)", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [
          {
            tier_id: "pro",
            display_name: "Pro Plan",
            max_usd_per_request: "1.00000000",
            max_usd_per_window: "200.00000000",
            window_seconds: 86400,
          },
        ],
        [TENANT_B]: [
          {
            tier_id: "pro",
            display_name: "Pro Plan",
            max_usd_per_request: "1.00000000",
            max_usd_per_window: "200.00000000",
            window_seconds: 86400,
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
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--diff", TENANT_B, "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      fieldDiffs: Array<{ field: string }>;
    };
    expect(env.fieldDiffs.filter((d) => d.field.startsWith("tier."))).toHaveLength(0);
  });

  it("self-diff guard: same tenant on both sides → exit 2 + clear error", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({});
    const { io, err } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--diff", RESOLVED_UUID),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("left and right resolve to the same tenant");
  });

  it("--exit-on-divergence with divergence trips exit 3", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [
          {
            tier_id: "free",
            display_name: "Free",
            max_usd_per_request: "0.05000000",
            max_usd_per_window: "5.00000000",
            window_seconds: 3600,
          },
        ],
        [TENANT_B]: [
          {
            tier_id: "pro",
            display_name: "Pro",
            max_usd_per_request: "1.00000000",
            max_usd_per_window: "200.00000000",
            window_seconds: 86400,
          },
        ],
      },
    });
    const retention = fakeRetentionForPolicies({});
    const { io } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed(
        "tenant",
        "policies",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--exit-on-divergence",
        "--format",
        "json",
      ),
      ctx,
    );
    expect(code).toBe(3);
  });

  it("--exit-on-divergence + --threshold 2 + only 1 diff → exit 0", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [
          {
            tier_id: "free",
            display_name: "Free",
            max_usd_per_request: "0.05000000",
            max_usd_per_window: "5.00000000",
            window_seconds: 3600,
          },
        ],
        [TENANT_B]: [
          {
            tier_id: "pro",
            display_name: "Pro",
            max_usd_per_request: "1.00000000",
            max_usd_per_window: "200.00000000",
            window_seconds: 86400,
          },
        ],
      },
    });
    const retention = fakeRetentionForPolicies({});
    const { io } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed(
        "tenant",
        "policies",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--exit-on-divergence",
        "--threshold",
        "2",
        "--format",
        "json",
      ),
      ctx,
    );
    // Only 1 fieldDiff (tier.tierId); threshold is 2 → no exit-3.
    expect(code).toBe(0);
  });

  it("--threshold without --exit-on-divergence → exit 2 + error", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({});
    const { io, err } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--diff", TENANT_B, "--threshold", "2"),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--threshold requires --exit-on-divergence");
  });

  it("--diff composes with --effective: both sides get effective field", async () => {
    const conn = fakePoliciesConn({
      costCeilingRows: {
        [RESOLVED_UUID]: [
          {
            max_usd_per_request: "0.10000000",
            max_usd_per_window: null,
            window_seconds: null,
            effective_from: "2026-04-01T00:00:00.000Z",
          },
        ],
      },
      tierRows: {
        [TENANT_B]: [
          {
            tier_id: "pro",
            display_name: "Pro",
            max_usd_per_request: "1.00000000",
            max_usd_per_window: "200.00000000",
            window_seconds: 86400,
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
    const code = await runTenant(
      parsed(
        "tenant",
        "policies",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--effective",
        "--format",
        "json",
      ),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      left: { effective?: { source: string } };
      right: { effective?: { source: string } };
    };
    expect(env.left.effective?.source).toBe("override");
    expect(env.right.effective?.source).toBe("tier");
  });

  it("invalid 'left' tenant identifier surfaces 'left' qualifier in error", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({});
    const { io, err } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(parsed("tenant", "policies", "ghost-a", "--diff", TENANT_B), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("left 'ghost-a'");
  });

  it("invalid 'right' tenant identifier surfaces 'right' qualifier in error", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({});
    const { io, err } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--diff", "ghost-b"),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("right 'ghost-b'");
  });

  it("human format groups diffs by axis ([retention], [costCeiling], [tier])", async () => {
    const conn = fakePoliciesConn({
      costCeilingRows: {
        [RESOLVED_UUID]: [
          {
            max_usd_per_request: "0.10000000",
            max_usd_per_window: null,
            window_seconds: null,
            effective_from: "2026-04-01T00:00:00.000Z",
          },
        ],
      },
      tierRows: {
        [RESOLVED_UUID]: [
          {
            tier_id: "free",
            display_name: "Free",
            max_usd_per_request: "0.05000000",
            max_usd_per_window: "5.00000000",
            window_seconds: 3600,
          },
        ],
        [TENANT_B]: [
          {
            tier_id: "pro",
            display_name: "Pro",
            max_usd_per_request: "1.00000000",
            max_usd_per_window: "200.00000000",
            window_seconds: 86400,
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
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--diff", TENANT_B),
      ctx,
    );
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("Field changes");
    expect(output).toContain("[costCeiling]");
    expect(output).toContain("[tier]");
  });
});

describe("runTenant policies --explain (M4.14.e)", () => {
  it("default mode (no --explain) omits explain field from envelope (backward compat)", async () => {
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
    const env = JSON.parse(out()) as Record<string, unknown>;
    expect("explain" in env).toBe(false);
  });

  it("--explain implies --effective (effective field populated even without --effective flag)", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [
          {
            tier_id: "pro",
            display_name: "Pro Plan",
            max_usd_per_request: "1.00000000",
            max_usd_per_window: "200.00000000",
            window_seconds: 86400,
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
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--explain", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      effective?: { source: string };
      explain?: unknown;
    };
    expect(env.effective?.source).toBe("tier");
    expect(env.explain).toBeDefined();
  });

  it("override + tier present: withoutOverride falls through to tier; withoutTier still shows override", async () => {
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
            tier_id: "pro",
            display_name: "Pro Plan",
            max_usd_per_request: "1.00000000",
            max_usd_per_window: "200.00000000",
            window_seconds: 86400,
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
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--explain", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      effective: { source: string; ceiling: { maxUsdPerRequest: string } };
      explain: {
        withoutOverride: {
          source: string;
          ceiling?: { maxUsdPerRequest: string };
          tierId?: string;
        };
        withoutTier: { source: string; ceiling?: { maxUsdPerRequest: string } };
      };
    };
    // Current effective surface = override
    expect(env.effective.source).toBe("override");
    expect(env.effective.ceiling.maxUsdPerRequest).toBe("0.10000000");
    // Strip the override → tier wins
    expect(env.explain.withoutOverride.source).toBe("tier");
    expect(env.explain.withoutOverride.ceiling?.maxUsdPerRequest).toBe("1.00000000");
    expect(env.explain.withoutOverride.tierId).toBe("pro");
    // Strip the tier → override still wins
    expect(env.explain.withoutTier.source).toBe("override");
    expect(env.explain.withoutTier.ceiling?.maxUsdPerRequest).toBe("0.10000000");
  });

  it("override only (no tier): withoutOverride falls through to 'none'", async () => {
    const conn = fakePoliciesConn({
      costCeilingRows: {
        [RESOLVED_UUID]: [
          {
            max_usd_per_request: "0.10000000",
            max_usd_per_window: null,
            window_seconds: null,
            effective_from: "2026-04-01T00:00:00.000Z",
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
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--explain", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      explain: {
        withoutOverride: { source: string };
        withoutTier: { source: string };
      };
    };
    // Override stripped + no tier → none (falls to router-level global)
    expect(env.explain.withoutOverride.source).toBe("none");
    // Tier stripped (was already absent) → override still wins
    expect(env.explain.withoutTier.source).toBe("override");
  });

  it("tier only (no override): withoutOverride still tier; withoutTier falls to 'none'", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [
          {
            tier_id: "free",
            display_name: "Free Plan",
            max_usd_per_request: "0.05000000",
            max_usd_per_window: null,
            window_seconds: null,
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
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--explain", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      explain: {
        withoutOverride: { source: string };
        withoutTier: { source: string };
      };
    };
    expect(env.explain.withoutOverride.source).toBe("tier");
    expect(env.explain.withoutTier.source).toBe("none");
  });

  it("neither override nor tier: both scenarios resolve to 'none'", async () => {
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
      parsed("tenant", "policies", RESOLVED_UUID, "--explain", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      explain: {
        withoutOverride: { source: string };
        withoutTier: { source: string };
      };
    };
    expect(env.explain.withoutOverride.source).toBe("none");
    expect(env.explain.withoutTier.source).toBe("none");
  });

  it("--explain + --diff are mutually exclusive: exits 2 with clear error", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({});
    const { io, err } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--diff", TENANT_B, "--explain"),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--diff and --explain are mutually exclusive");
  });

  it("human format renders the explain section with both scenarios", async () => {
    const conn = fakePoliciesConn({
      costCeilingRows: {
        [RESOLVED_UUID]: [
          {
            max_usd_per_request: "0.10000000",
            max_usd_per_window: null,
            window_seconds: null,
            effective_from: "2026-04-01T00:00:00.000Z",
          },
        ],
      },
      tierRows: {
        [RESOLVED_UUID]: [
          {
            tier_id: "pro",
            display_name: "Pro Plan",
            max_usd_per_request: "1.00000000",
            max_usd_per_window: "200.00000000",
            window_seconds: 86400,
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
    const code = await runTenant(parsed("tenant", "policies", RESOLVED_UUID, "--explain"), ctx);
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("=== Explain (what-if precedence walk) ===");
    expect(output).toContain("without override:");
    expect(output).toContain("source=tier");
    expect(output).toContain("tier=pro");
    expect(output).toContain("without tier:");
    expect(output).toContain("source=override");
  });

  it("human format renders 'source=none' placeholder for scenarios that fall through to global", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(parsed("tenant", "policies", RESOLVED_UUID, "--explain"), ctx);
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("source=none");
    expect(output).toContain("router-level global");
  });

  it("--explain does NOT issue an extra PG query — derives from already-fetched axes", async () => {
    const queries: string[] = [];
    const conn: PgConnection = {
      query: async <T>(sql: string, _params?: readonly unknown[]) => {
        queries.push(sql);
        if (sql.includes("FROM meta.llm_cost_ceilings WHERE tenant_id = $1")) {
          return {
            rows: [
              {
                max_usd_per_request: "0.25000000",
                max_usd_per_window: null,
                window_seconds: null,
                effective_from: "2026-04-01T00:00:00.000Z",
              },
            ] as unknown as T[],
            rowCount: 1,
          } as PgQueryResult<T>;
        }
        return { rows: [], rowCount: 0 } as PgQueryResult<T>;
      },
      transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => fn({} as PgConnection),
      withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>) => fn(),
      close: async () => undefined,
    };
    const retention = fakeRetentionForPolicies({});
    const { io } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--explain", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    // Same two queries M4.14.h fires (cost_ceilings + tier_memberships).
    // The explain view + effective view are both derived client-side.
    expect(queries).toHaveLength(2);
  });
});

// M4.14.d — tenant housekeeping --watch tests. Closes ADR-0265 Q1 +
// ADR-0276 Q1. Combines two independent watch loops (gateway +
// retention) under one cross-dashboard view with a SINGLE tick that
// gathers BOTH dashboards atomically then renders ONCE — no
// interleaved-render layout garbling.
describe("runTenant housekeeping --watch (M4.14.d)", () => {
  // Test-only setTimeout that fires synchronously so watch loops
  // drain instantly under maxIterations.
  const immediateSetTimeout = (cb: () => void, _ms: number): unknown => {
    cb();
    return 1 as unknown;
  };

  it("loops N times when --watch + watchOverride.maxIterations is set", async () => {
    const conn = fakeConn({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 3, setTimeoutFn: immediateSetTimeout },
    };
    const code = await runTenant(parsed("tenant", "housekeeping", "--watch"), ctx);
    expect(code).toBe(0);
    const stdout = out();
    // One header per tick; 3 ticks → 3 headers.
    const headerMatches = stdout.match(/tenant housekeeping \(as of /g);
    expect(headerMatches).not.toBeNull();
    expect(headerMatches!.length).toBe(3);
    // ANSI clear-screen between ticks (one per tick).
    expect(stdout).toContain("\x1b[2J\x1b[H");
  });

  it("renders BOTH gateway and retention sections each tick", async () => {
    const conn = fakeConn({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 2, setTimeoutFn: immediateSetTimeout },
    };
    const code = await runTenant(parsed("tenant", "housekeeping", "--watch"), ctx);
    expect(code).toBe(0);
    const stdout = out();
    const gatewayMatches = stdout.match(/=== Gateway housekeeping ===/g);
    const retentionMatches = stdout.match(/=== Retention housekeeping ===/g);
    expect(gatewayMatches!.length).toBe(2);
    expect(retentionMatches!.length).toBe(2);
  });

  it("--watch with --format json streams NDJSON-of-envelopes (one envelope per tick)", async () => {
    const conn = fakeConn({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 3, setTimeoutFn: immediateSetTimeout },
    };
    const code = await runTenant(
      parsed("tenant", "housekeeping", "--watch", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const env = JSON.parse(line) as { action: string; gateway: unknown; retention: unknown };
      expect(env.action).toBe("tenant.housekeeping");
      expect(env.gateway).toBeDefined();
      expect(env.retention).toBeDefined();
    }
    // JSON streaming MUST NOT emit ANSI clear-screen — that would break
    // log aggregators consuming NDJSON.
    expect(out()).not.toContain("\x1b[2J");
  });

  it("--watch-interval threads custom interval (default 5s; custom honored)", async () => {
    const conn = fakeConn({});
    const delays: number[] = [];
    const fakeSetTimeout = (cb: () => void, ms: number): unknown => {
      delays.push(ms);
      cb();
      return 1 as unknown;
    };
    const { io } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 3, setTimeoutFn: fakeSetTimeout },
    };
    const code = await runTenant(
      parsed("tenant", "housekeeping", "--watch", "--watch-interval", "20"),
      ctx,
    );
    expect(code).toBe(0);
    // 3 iterations → 2 intervals between them (last tick has no
    // trailing wait when maxIterations is hit). Each interval is 20s.
    expect(delays).toEqual([20000, 20000]);
  });

  it("--watch-interval requires --watch (exit 2)", async () => {
    const { io, err } = makeIo();
    const ctx: TenantContext = { io, env: {} };
    const code = await runTenant(parsed("tenant", "housekeeping", "--watch-interval", "10"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("--watch-interval requires --watch");
  });

  it("--watch-keep-going requires --watch (exit 2)", async () => {
    const { io, err } = makeIo();
    const ctx: TenantContext = { io, env: {} };
    const code = await runTenant(parsed("tenant", "housekeeping", "--watch-keep-going"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("--watch-keep-going requires --watch");
  });

  it("--watch rejects --format csv/tsv/ndjson/yaml (exit 2)", async () => {
    for (const fmt of ["csv", "tsv", "ndjson", "yaml"]) {
      const { io, err } = makeIo();
      const ctx: TenantContext = { io, env: {} };
      const code = await runTenant(
        parsed("tenant", "housekeeping", "--watch", "--format", fmt),
        ctx,
      );
      expect(code).toBe(2);
      expect(err()).toContain("--watch requires --format human or json");
    }
  });

  it("--watch with abortSignal pre-aborted cancels the loop after first tick", async () => {
    const conn = fakeConn({});
    const controller = new AbortController();
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
      watchOverride: {
        // No maxIterations — abort drives termination.
        abortSignal: controller.signal,
        setTimeoutFn: (cb, _ms) => {
          // Abort during the first inter-tick wait — loop should return
          // cleanly without firing a 2nd render.
          controller.abort();
          cb();
          return 1 as unknown;
        },
      },
    };
    const code = await runTenant(parsed("tenant", "housekeeping", "--watch"), ctx);
    expect(code).toBe(0);
    const headerMatches = out().match(/tenant housekeeping \(as of /g);
    expect(headerMatches!.length).toBe(1);
  });

  it("threshold-alert tripping in --watch (without --keep-going) exits 3", async () => {
    const conn = fakeConn({});
    const { io } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
      // No maxIterations needed — first tick should halt.
      watchOverride: { setTimeoutFn: immediateSetTimeout },
    };
    const code = await runTenant(
      parsed("tenant", "housekeeping", "--watch", "--threshold-alert", "totalRowCount:>10"),
      ctx,
    );
    expect(code).toBe(3);
  });

  it("--watch-keep-going records trips but continues looping (exits 3 only at end)", async () => {
    const conn = fakeConn({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 3, setTimeoutFn: immediateSetTimeout },
    };
    const code = await runTenant(
      parsed(
        "tenant",
        "housekeeping",
        "--watch",
        "--watch-keep-going",
        "--threshold-alert",
        "totalRowCount:>10",
      ),
      ctx,
    );
    // Trip is sticky → exit 3 after 3 iterations.
    expect(code).toBe(3);
    // But the loop ran 3 ticks (not halted early on first trip).
    expect(out().match(/tenant housekeeping \(as of /g)!.length).toBe(3);
  });

  it("--watch-keep-going catches gather() errors (renders error placeholder + continues)", async () => {
    // Connection that fails the first call then succeeds.
    let callCount = 0;
    const failingConn: PgConnection = {
      query: async <T>(sql: string, _params?: readonly unknown[]) => {
        callCount++;
        // First tick: fail on the first PG query (any of them).
        if (callCount <= 1) throw new Error("boom-from-pg");
        // Subsequent calls succeed using the same fixtures as fakeConn.
        if (sql.includes("FROM meta.gateway_pipeline_executions")) {
          return {
            rows: [{ total: "0", oldest: null }],
            rowCount: 1,
          } as unknown as PgQueryResult<T>;
        }
        return { rows: [{ total: "0", oldest: null }], rowCount: 1 } as unknown as PgQueryResult<T>;
      },
      transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => fn({} as PgConnection),
      withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>) => fn(),
      close: async () => undefined,
    };
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: failingConn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
      watchOverride: { maxIterations: 2, setTimeoutFn: immediateSetTimeout },
    };
    const code = await runTenant(
      parsed("tenant", "housekeeping", "--watch", "--watch-keep-going"),
      ctx,
    );
    // No alerts tripped + no halt → exit 0 despite the gather error.
    expect(code).toBe(0);
    expect(out()).toContain("(error this tick: boom-from-pg)");
  });

  it("--watch installs SIGINT + SIGTERM handlers via signalRegistrar", async () => {
    const registered: string[] = [];
    const removed: string[] = [];
    const recordingRegistrar = (sig: string, _handler: () => void): (() => void) => {
      registered.push(sig);
      return () => removed.push(sig);
    };
    const conn = fakeConn({});
    const { io } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
      watchOverride: {
        maxIterations: 1,
        setTimeoutFn: immediateSetTimeout,
        signalRegistrar: recordingRegistrar,
      },
    };
    const code = await runTenant(parsed("tenant", "housekeeping", "--watch"), ctx);
    expect(code).toBe(0);
    expect(registered).toEqual(["SIGINT", "SIGTERM"]);
    expect(removed).toEqual(["SIGINT", "SIGTERM"]);
  });
});

// M4.14.c — tenant policies CSV/TSV tests. Closes ADR-0280 Q6 +
// ADR-0282 Q4. Single-tenant emits one row per axis (retention,
// cost_ceiling, tier, effective, explain.*) with axis-irrelevant
// fields as empty cells; --diff emits one row per fieldDiff.
describe("runTenant policies --format csv|tsv (M4.14.c)", () => {
  it("single-tenant CSV emits headers + one row per axis (retention, cost_ceiling, tier)", async () => {
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
            display_name: "Enterprise",
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
      parsed("tenant", "policies", RESOLVED_UUID, "--format", "csv"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    // header + 1 retention + 1 cost_ceiling + 1 tier = 4 lines
    expect(lines.length).toBe(4);
    expect(lines[0]).toBe(
      "tenant_id,input,axis,table_name,retention_days,enabled,opt_out,opt_out_reason,opt_out_until,last_pruned_at,max_usd_per_request,max_usd_per_window,window_seconds,effective_from,tier_id,display_name,effective_source",
    );
    expect(lines[1]).toContain(",retention,workflow_traces,365,true,false,");
    expect(lines[2]).toContain(",cost_ceiling,");
    expect(lines[2]).toContain("0.10000000,50.00000000,3600,2026-04-01T00:00:00.000Z");
    expect(lines[3]).toContain(",tier,");
    expect(lines[3]).toContain("5.00000000,1000.00000000,86400,,enterprise,Enterprise,");
  });

  it("single-tenant TSV uses tab separator", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({
      [RESOLVED_UUID]: [
        {
          tableName: "workflow_traces",
          retentionDays: 90,
          enabled: true,
          optOut: false,
          optOutReason: null,
          optOutUntil: null,
          lastPrunedAt: null,
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
      parsed("tenant", "policies", RESOLVED_UUID, "--format", "tsv"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toContain("\t");
    expect(lines[0]).not.toContain(",");
    expect(lines[0].split("\t").length).toBe(17);
    expect(lines[1]).toContain("\tretention\tworkflow_traces\t90\t");
  });

  it("single-tenant CSV with --csv-separator ';' uses semicolon", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({
      [RESOLVED_UUID]: [
        {
          tableName: "workflow_traces",
          retentionDays: 90,
          enabled: true,
          optOut: false,
          optOutReason: null,
          optOutUntil: null,
          lastPrunedAt: null,
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
      parsed("tenant", "policies", RESOLVED_UUID, "--format", "csv", "--csv-separator", ";"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toContain(";");
    expect(lines[0].split(";").length).toBe(17);
  });

  it("--csv-separator rejects '\"' and newline (exit 2)", async () => {
    for (const bad of ['"', "\n"]) {
      const conn = fakePoliciesConn({});
      const retention = fakeRetentionForPolicies({});
      const { io, err } = makeIo();
      const ctx: TenantContext = {
        io,
        env: {},
        pgConnectionOverride: conn,
        retentionOverride: retention,
      };
      const code = await runTenant(
        parsed("tenant", "policies", RESOLVED_UUID, "--format", "csv", "--csv-separator", bad),
        ctx,
      );
      expect(code).toBe(2);
      expect(err()).toContain("--csv-separator cannot be");
    }
  });

  it("--effective adds an 'effective' axis row with effective_source populated", async () => {
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
    });
    const retention = fakeRetentionForPolicies({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--format", "csv", "--effective"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    // header + cost_ceiling + effective = 3 lines
    expect(lines.length).toBe(3);
    expect(lines[2]).toContain(",effective,");
    expect(lines[2].endsWith(",override")).toBe(true);
  });

  it("--explain (implies --effective) adds effective + explain.* rows", async () => {
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
            display_name: "Enterprise",
            max_usd_per_request: "5.00000000",
            max_usd_per_window: "1000.00000000",
            window_seconds: 86400,
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
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--format", "csv", "--explain"),
      ctx,
    );
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain(",effective,");
    expect(output).toContain(",explain.without_override,");
    expect(output).toContain(",explain.without_tier,");
    // withoutOverride → falls back to tier (source=tier)
    const woRow = output.split("\n").find((l) => l.includes(",explain.without_override,"));
    expect(woRow!.endsWith(",tier")).toBe(true);
    // withoutTier → override still wins (source=override)
    const wtRow = output.split("\n").find((l) => l.includes(",explain.without_tier,"));
    expect(wtRow!.endsWith(",override")).toBe(true);
  });

  it("empty-policy tenant CSV emits headers + zero rows", async () => {
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
      parsed("tenant", "policies", RESOLVED_UUID, "--format", "csv"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0].startsWith("tenant_id,input,axis,")).toBe(true);
  });

  it("--diff CSV emits one row per fieldDiff with tenant_a/tenant_b columns", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [
          {
            tier_id: "free",
            display_name: "Free",
            max_usd_per_request: "0.05000000",
            max_usd_per_window: "5.00000000",
            window_seconds: 3600,
          },
        ],
        [TENANT_B]: [
          {
            tier_id: "enterprise",
            display_name: "Enterprise",
            max_usd_per_request: "5.00000000",
            max_usd_per_window: "1000.00000000",
            window_seconds: 86400,
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
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--diff", TENANT_B, "--format", "csv"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toBe(
      "tenant_a_id,tenant_a_input,tenant_b_id,tenant_b_input,axis,field,value_a,value_b",
    );
    // computePolicyFieldDiffs coalesces tier-policy differences into
    // a single tier.tierId diff when both sides have tiers (same
    // tierId → same fields by construction). Header + 1 row = 2.
    expect(lines.length).toBe(2);
    expect(lines[1]).toBe(
      `${RESOLVED_UUID},${RESOLVED_UUID},${TENANT_B},${TENANT_B},tier,tier.tierId,free,enterprise`,
    );
  });

  it("--diff CSV emits header-only when policies match (empty fieldDiffs)", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [
          {
            tier_id: "pro",
            display_name: "Pro",
            max_usd_per_request: "1.00000000",
            max_usd_per_window: "200.00000000",
            window_seconds: 86400,
          },
        ],
        [TENANT_B]: [
          {
            tier_id: "pro",
            display_name: "Pro",
            max_usd_per_request: "1.00000000",
            max_usd_per_window: "200.00000000",
            window_seconds: 86400,
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
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--diff", TENANT_B, "--format", "csv"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    // Header-only is one line; trim().split("\n") on a string with a
    // single line returns [line], not [].
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe(
      "tenant_a_id,tenant_a_input,tenant_b_id,tenant_b_input,axis,field,value_a,value_b",
    );
  });

  it("--diff TSV with --exit-on-divergence still triggers exit 3 on divergence", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [
          {
            tier_id: "free",
            display_name: "Free",
            max_usd_per_request: "0.05000000",
            max_usd_per_window: "5.00000000",
            window_seconds: 3600,
          },
        ],
        [TENANT_B]: [
          {
            tier_id: "enterprise",
            display_name: "Enterprise",
            max_usd_per_request: "5.00000000",
            max_usd_per_window: "1000.00000000",
            window_seconds: 86400,
          },
        ],
      },
    });
    const retention = fakeRetentionForPolicies({});
    const { io } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed(
        "tenant",
        "policies",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--format",
        "tsv",
        "--exit-on-divergence",
      ),
      ctx,
    );
    expect(code).toBe(3);
  });

  it("CSV field with comma is quoted (cost ceiling row with display name containing comma)", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [
          {
            tier_id: "ent",
            display_name: "Enterprise, Premium",
            max_usd_per_request: "5.00000000",
            max_usd_per_window: "1000.00000000",
            window_seconds: 86400,
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
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--format", "csv"),
      ctx,
    );
    expect(code).toBe(0);
    expect(out()).toContain('"Enterprise, Premium"');
  });
});

// M4.14.b — tenant policies --vs-tier tests. Closes ADR-0282 Q2 +
// ADR-0283 Q3. Synthetic-RHS comparison: same tenant, same retention,
// same cost-ceiling override, tier replaced by lookup against
// meta.llm_cost_tiers. Operators preview tier-change impact before
// committing a membership update.
describe("runTenant policies --vs-tier (M4.14.b)", () => {
  const ENTERPRISE_TIER = {
    tier_id: "enterprise",
    display_name: "Enterprise",
    max_usd_per_request: "5.00000000",
    max_usd_per_window: "1000.00000000",
    window_seconds: 86400,
  };
  const FREE_TIER = {
    tier_id: "free",
    display_name: "Free",
    max_usd_per_request: "0.05000000",
    max_usd_per_window: "5.00000000",
    window_seconds: 3600,
  };

  it("unknown tier exits 2 with 'no tier with id' error", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({});
    const { io, err } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--vs-tier", "nonexistent"),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("no tier with id 'nonexistent'");
  });

  it("--vs-tier and --diff are mutually exclusive (exit 2)", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({});
    const { io, err } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--vs-tier", "enterprise", "--diff", TENANT_B),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--diff and --vs-tier are mutually exclusive");
  });

  it("--vs-tier and --explain are mutually exclusive (exit 2)", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({});
    const { io, err } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--vs-tier", "enterprise", "--explain"),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--vs-tier and --explain are mutually exclusive");
  });

  it("synthetic RHS uses 'vs-tier:<tierId>' input marker in human output", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [FREE_TIER],
      },
      tierDefinitions: { enterprise: ENTERPRISE_TIER },
    });
    const retention = fakeRetentionForPolicies({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--vs-tier", "enterprise"),
      ctx,
    );
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("Diff between tenant policies:");
    expect(output).toContain(`Left:  ${RESOLVED_UUID}`);
    expect(output).toContain("Right:");
    expect(output).toContain("vs-tier:enterprise");
  });

  it("vs-tier from free → enterprise surfaces tier.tierId diff", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [FREE_TIER],
      },
      tierDefinitions: { enterprise: ENTERPRISE_TIER },
    });
    const retention = fakeRetentionForPolicies({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--vs-tier", "enterprise", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      action: string;
      left: { tier: { tierId: string } };
      right: { tier: { tierId: string }; input: string; tenantId: string };
      fieldDiffs: Array<{ axis: string; field: string; valueA: unknown; valueB: unknown }>;
    };
    expect(env.action).toBe("tenant.policies.diff");
    expect(env.left.tier.tierId).toBe("free");
    expect(env.right.tier.tierId).toBe("enterprise");
    expect(env.right.tenantId).toBe(RESOLVED_UUID);
    expect(env.right.input).toBe("vs-tier:enterprise");
    expect(env.fieldDiffs).toHaveLength(1);
    expect(env.fieldDiffs[0]).toEqual({
      axis: "tier",
      field: "tier.tierId",
      valueA: "free",
      valueB: "enterprise",
    });
  });

  it("vs-tier with NO current tier surfaces tier.exists false→true", async () => {
    const conn = fakePoliciesConn({
      tierDefinitions: { enterprise: ENTERPRISE_TIER },
    });
    const retention = fakeRetentionForPolicies({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--vs-tier", "enterprise", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      fieldDiffs: Array<{ axis: string; field: string; valueA: unknown; valueB: unknown }>;
    };
    expect(env.fieldDiffs).toHaveLength(1);
    expect(env.fieldDiffs[0]).toEqual({
      axis: "tier",
      field: "tier.exists",
      valueA: false,
      valueB: true,
    });
  });

  it("vs-tier where current tier == target tier yields empty fieldDiffs (no self-guard)", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [ENTERPRISE_TIER],
      },
      tierDefinitions: { enterprise: ENTERPRISE_TIER },
    });
    const retention = fakeRetentionForPolicies({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--vs-tier", "enterprise"),
      ctx,
    );
    // Empty diff is the useful "moving here changes nothing" answer
    // — not an operator typo. Exit 0 (no divergence, no --exit-on-
    // divergence gate).
    expect(code).toBe(0);
    expect(out()).toContain("No differences");
  });

  it("--vs-tier --effective populates both sides with effective field (override shadows tier)", async () => {
    const conn = fakePoliciesConn({
      costCeilingRows: {
        [RESOLVED_UUID]: [
          {
            max_usd_per_request: "0.50000000",
            max_usd_per_window: "100.00000000",
            window_seconds: 3600,
            effective_from: "2026-04-01T00:00:00.000Z",
          },
        ],
      },
      tierRows: { [RESOLVED_UUID]: [FREE_TIER] },
      tierDefinitions: { enterprise: ENTERPRISE_TIER },
    });
    const retention = fakeRetentionForPolicies({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed(
        "tenant",
        "policies",
        RESOLVED_UUID,
        "--vs-tier",
        "enterprise",
        "--effective",
        "--format",
        "json",
      ),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      left: { effective: { source: string; ceiling: { maxUsdPerRequest: string } } };
      right: { effective: { source: string; ceiling: { maxUsdPerRequest: string } } };
    };
    // Both sides have effective populated; both should yield
    // source=override since the per-tenant override shadows the
    // tier on each side. The canonical "your override is doing all
    // the work" finding.
    expect(env.left.effective.source).toBe("override");
    expect(env.right.effective.source).toBe("override");
    expect(env.left.effective.ceiling.maxUsdPerRequest).toBe("0.50000000");
    expect(env.right.effective.ceiling.maxUsdPerRequest).toBe("0.50000000");
  });

  it("--vs-tier with --exit-on-divergence triggers exit 3 on tier change", async () => {
    const conn = fakePoliciesConn({
      tierRows: { [RESOLVED_UUID]: [FREE_TIER] },
      tierDefinitions: { enterprise: ENTERPRISE_TIER },
    });
    const retention = fakeRetentionForPolicies({});
    const { io } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed(
        "tenant",
        "policies",
        RESOLVED_UUID,
        "--vs-tier",
        "enterprise",
        "--exit-on-divergence",
      ),
      ctx,
    );
    expect(code).toBe(3);
  });

  it("--vs-tier CSV emits one row per fieldDiff with synthetic input marker", async () => {
    const conn = fakePoliciesConn({
      tierRows: { [RESOLVED_UUID]: [FREE_TIER] },
      tierDefinitions: { enterprise: ENTERPRISE_TIER },
    });
    const retention = fakeRetentionForPolicies({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--vs-tier", "enterprise", "--format", "csv"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toBe(
      "tenant_a_id,tenant_a_input,tenant_b_id,tenant_b_input,axis,field,value_a,value_b",
    );
    expect(lines.length).toBe(2);
    // Both tenant_a_id and tenant_b_id are the same UUID (synthetic
    // RHS uses same tenant); only the input column differs.
    expect(lines[1]).toBe(
      `${RESOLVED_UUID},${RESOLVED_UUID},${RESOLVED_UUID},vs-tier:enterprise,tier,tier.tierId,free,enterprise`,
    );
  });

  it("--vs-tier propagates LHS slug-resolution errors (unknown LHS → exit 2)", async () => {
    const conn = fakePoliciesConn({
      slugMap: {},
      tierDefinitions: { enterprise: ENTERPRISE_TIER },
    });
    const retention = fakeRetentionForPolicies({});
    const { io, err } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", "no-such-tenant", "--vs-tier", "enterprise"),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--vs-tier (left 'no-such-tenant')");
  });
});

// M4.14.a — N-way tenant policies diff tests. Closes ADR-0282 Q1 +
// ADR-0286 Q1. --add-tenant extends --diff to N RHSes; repeated
// --vs-tier extends the tier-preview to N tiers. Exit code = max-
// divergence across comparisons. CSV/JSON envelopes change shape
// when N>1; single-comparison preserves the M4.14.f/M4.14.b shape.
describe("runTenant policies N-way --diff/--vs-tier (M4.14.a)", () => {
  const FREE_TIER = {
    tier_id: "free",
    display_name: "Free",
    max_usd_per_request: "0.05000000",
    max_usd_per_window: "5.00000000",
    window_seconds: 3600,
  };
  const PRO_TIER = {
    tier_id: "pro",
    display_name: "Pro",
    max_usd_per_request: "1.00000000",
    max_usd_per_window: "200.00000000",
    window_seconds: 86400,
  };
  const ENTERPRISE_TIER = {
    tier_id: "enterprise",
    display_name: "Enterprise",
    max_usd_per_request: "5.00000000",
    max_usd_per_window: "1000.00000000",
    window_seconds: 86400,
  };

  it("--add-tenant without --diff exits 2", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({});
    const { io, err } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--add-tenant", TENANT_B),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--add-tenant requires --diff");
  });

  it("--add-tenant + --vs-tier are mutually exclusive (exit 2)", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({});
    const { io, err } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed(
        "tenant",
        "policies",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--add-tenant",
        TENANT_C,
        "--vs-tier",
        "enterprise",
      ),
      ctx,
    );
    expect(code).toBe(2);
    // --diff + --vs-tier exclusivity fires first.
    expect(err()).toContain("--diff and --vs-tier are mutually exclusive");
  });

  it("N-way --diff with --add-tenant: JSON envelope uses tenant.policies.diff.multi shape", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [FREE_TIER],
        [TENANT_B]: [PRO_TIER],
        [TENANT_C]: [ENTERPRISE_TIER],
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
    const code = await runTenant(
      parsed(
        "tenant",
        "policies",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--add-tenant",
        TENANT_C,
        "--format",
        "json",
      ),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      action: string;
      anchor: { tenantId: string };
      comparisons: Array<{ right: { tenantId: string }; fieldDiffs: Array<unknown> }>;
    };
    expect(env.action).toBe("tenant.policies.diff.multi");
    expect(env.anchor.tenantId).toBe(RESOLVED_UUID);
    expect(env.comparisons).toHaveLength(2);
    expect(env.comparisons[0].right.tenantId).toBe(TENANT_B);
    expect(env.comparisons[1].right.tenantId).toBe(TENANT_C);
    // Each comparison has its own fieldDiffs (free vs pro = 1
    // tier.tierId diff; free vs enterprise = 1 tier.tierId diff).
    expect(env.comparisons[0].fieldDiffs).toHaveLength(1);
    expect(env.comparisons[1].fieldDiffs).toHaveLength(1);
  });

  it("N-way --diff: single --diff (no --add-tenant) preserves M4.14.f envelope", async () => {
    const conn = fakePoliciesConn({
      tierRows: { [RESOLVED_UUID]: [FREE_TIER], [TENANT_B]: [PRO_TIER] },
    });
    const retention = fakeRetentionForPolicies({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--diff", TENANT_B, "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as { action: string; left: unknown; right: unknown };
    expect(env.action).toBe("tenant.policies.diff");
    expect(env.left).toBeDefined();
    expect(env.right).toBeDefined();
  });

  it("N-way --diff duplicate RHS UUIDs exits 2 ('appears in multiple RHS slots')", async () => {
    const conn = fakePoliciesConn({});
    const retention = fakeRetentionForPolicies({});
    const { io, err } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--diff", TENANT_B, "--add-tenant", TENANT_B),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("appears in multiple RHS slots");
  });

  it("N-way --diff: max-divergence exit 3 (any comparison trips → exit 3)", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [FREE_TIER],
        [TENANT_B]: [FREE_TIER], // identical
        [TENANT_C]: [ENTERPRISE_TIER], // differs
      },
    });
    const retention = fakeRetentionForPolicies({});
    const { io } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed(
        "tenant",
        "policies",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--add-tenant",
        TENANT_C,
        "--exit-on-divergence",
      ),
      ctx,
    );
    // Comparison 1: free vs free → 0 diffs. Comparison 2: free vs
    // enterprise → 1 diff. Max = 1 ≥ threshold (default 1) → exit 3.
    expect(code).toBe(3);
  });

  it("N-way --diff: all comparisons identical → exit 0 under --exit-on-divergence", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [FREE_TIER],
        [TENANT_B]: [FREE_TIER],
        [TENANT_C]: [FREE_TIER],
      },
    });
    const retention = fakeRetentionForPolicies({});
    const { io } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed(
        "tenant",
        "policies",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--add-tenant",
        TENANT_C,
        "--exit-on-divergence",
      ),
      ctx,
    );
    expect(code).toBe(0);
  });

  it("N-way --diff CSV adds comparison_index column", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [FREE_TIER],
        [TENANT_B]: [PRO_TIER],
        [TENANT_C]: [ENTERPRISE_TIER],
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
    const code = await runTenant(
      parsed(
        "tenant",
        "policies",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--add-tenant",
        TENANT_C,
        "--format",
        "csv",
      ),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toBe(
      "comparison_index,tenant_a_id,tenant_a_input,tenant_b_id,tenant_b_input,axis,field,value_a,value_b",
    );
    // 2 comparisons × 1 diff each = 2 data rows + 1 header = 3 lines.
    expect(lines.length).toBe(3);
    expect(lines[1]!.startsWith("0,")).toBe(true);
    expect(lines[2]!.startsWith("1,")).toBe(true);
  });

  it("N-way --diff human render emits section per comparison", async () => {
    const conn = fakePoliciesConn({
      tierRows: {
        [RESOLVED_UUID]: [FREE_TIER],
        [TENANT_B]: [PRO_TIER],
        [TENANT_C]: [ENTERPRISE_TIER],
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
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--diff", TENANT_B, "--add-tenant", TENANT_C),
      ctx,
    );
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("Multi-comparison tenant policies");
    expect(output).toContain("2 comparisons");
    expect(output).toContain("=== Comparison 1/2 ===");
    expect(output).toContain("=== Comparison 2/2 ===");
  });

  it("repeated --vs-tier: JSON multi-comparison envelope shape", async () => {
    const conn = fakePoliciesConn({
      tierRows: { [RESOLVED_UUID]: [FREE_TIER] },
      tierDefinitions: { pro: PRO_TIER, enterprise: ENTERPRISE_TIER },
    });
    const retention = fakeRetentionForPolicies({});
    const { io, out } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed(
        "tenant",
        "policies",
        RESOLVED_UUID,
        "--vs-tier",
        "pro",
        "--vs-tier",
        "enterprise",
        "--format",
        "json",
      ),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      action: string;
      anchor: { tenantId: string };
      comparisons: Array<{
        right: { input: string; tier: { tierId: string } };
        fieldDiffs: unknown[];
      }>;
    };
    expect(env.action).toBe("tenant.policies.diff.multi");
    expect(env.comparisons).toHaveLength(2);
    expect(env.comparisons[0].right.input).toBe("vs-tier:pro");
    expect(env.comparisons[1].right.input).toBe("vs-tier:enterprise");
    expect(env.comparisons[0].right.tier.tierId).toBe("pro");
    expect(env.comparisons[1].right.tier.tierId).toBe("enterprise");
  });

  it("repeated --vs-tier with duplicate tier id exits 2", async () => {
    const conn = fakePoliciesConn({
      tierDefinitions: { pro: PRO_TIER },
    });
    const retention = fakeRetentionForPolicies({});
    const { io, err } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed("tenant", "policies", RESOLVED_UUID, "--vs-tier", "pro", "--vs-tier", "pro"),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("appears in multiple --vs-tier slots");
  });

  it("N-way --add-tenant unknown RHS surfaces 'right 2' label", async () => {
    const conn = fakePoliciesConn({
      slugMap: { "acme-prod": TENANT_B },
      tierRows: { [RESOLVED_UUID]: [FREE_TIER], [TENANT_B]: [PRO_TIER] },
    });
    const retention = fakeRetentionForPolicies({});
    const { io, err } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: retention,
    };
    const code = await runTenant(
      parsed(
        "tenant",
        "policies",
        RESOLVED_UUID,
        "--diff",
        "acme-prod",
        "--add-tenant",
        "no-such-tenant",
      ),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("(right 2 'no-such-tenant')");
  });
});

// M4.15.a — `tenant housekeeping --diff` tests. Closes ADR-0284 Q5.
// Pair-wise comparison of two tenants' combined gateway + retention
// housekeeping dashboards. Diff focuses on tenantPolicy fields per
// table (global stats are tenant-agnostic under the same PG snapshot
// so excluded). Self-diff + validation guards exit 2 BEFORE PG;
// max-divergence-style exit code (any field diff trips exit 3 under
// --exit-on-divergence).
describe("runTenant housekeeping --diff (M4.15.a)", () => {
  it("--diff without --tenant exits 2 ('--diff requires --tenant')", async () => {
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
    const code = await runTenant(parsed("tenant", "housekeeping", "--diff", TENANT_B), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("--diff requires --tenant");
  });

  it("--diff + --all-tenants mutually exclusive (exit 2)", async () => {
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
      parsed(
        "tenant",
        "housekeeping",
        "--tenant",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--all-tenants",
      ),
      ctx,
    );
    expect(code).toBe(2);
    // --tenant + --all-tenants exclusivity fires first (also correct).
    expect(err()).toContain("mutually exclusive");
  });

  it("--diff + --watch mutually exclusive (exit 2)", async () => {
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
      parsed("tenant", "housekeeping", "--tenant", RESOLVED_UUID, "--diff", TENANT_B, "--watch"),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--diff and --watch are mutually exclusive");
  });

  it("--diff + --threshold-alert mutually exclusive (exit 2)", async () => {
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
      parsed(
        "tenant",
        "housekeeping",
        "--tenant",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--threshold-alert",
        "would_prune > 1000",
      ),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--diff and --threshold-alert are mutually exclusive");
  });

  it("--diff self-diff (LHS == RHS) exits 2", async () => {
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
      parsed("tenant", "housekeeping", "--tenant", RESOLVED_UUID, "--diff", RESOLVED_UUID),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("resolve to the same tenant");
  });

  it("--diff unknown RHS exits 2 with 'right' label", async () => {
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
      parsed("tenant", "housekeeping", "--tenant", RESOLVED_UUID, "--diff", "no-such-tenant"),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--diff (right 'no-such-tenant')");
  });

  it("--diff JSON envelope uses tenant.housekeeping.diff action with both sides", async () => {
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
      parsed(
        "tenant",
        "housekeeping",
        "--tenant",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--format",
        "json",
      ),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      action: string;
      left: { tenantId: string; gateway: unknown; retention: unknown };
      right: { tenantId: string; gateway: unknown; retention: unknown };
      fieldDiffs: Array<{ axis: string; tableName: string; field: string }>;
    };
    expect(env.action).toBe("tenant.housekeeping.diff");
    expect(env.left.tenantId).toBe(RESOLVED_UUID);
    expect(env.right.tenantId).toBe(TENANT_B);
    expect(env.left.gateway).toBeDefined();
    expect(env.left.retention).toBeDefined();
    expect(env.right.gateway).toBeDefined();
    expect(env.right.retention).toBeDefined();
    // RESOLVED_UUID has override on gateway_pipeline_executions (365 days);
    // TENANT_B has override on workflow_traces (60 days). The diff
    // surfaces tenantPolicy.exists divergences on both tables across
    // BOTH gateway + retention axes since both tables appear in the
    // retention housekeeping report. Find at least one of each.
    expect(env.fieldDiffs.length).toBeGreaterThan(0);
    const hasGatewayPipelineDiff = env.fieldDiffs.some(
      (d) => d.tableName === "gateway_pipeline_executions",
    );
    const hasWorkflowTracesDiff = env.fieldDiffs.some((d) => d.tableName === "workflow_traces");
    expect(hasGatewayPipelineDiff).toBe(true);
    expect(hasWorkflowTracesDiff).toBe(true);
  });

  it("--diff human render emits 'Diff between tenant housekeeping dashboards' header + diff list", async () => {
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
      parsed("tenant", "housekeeping", "--tenant", RESOLVED_UUID, "--diff", TENANT_B),
      ctx,
    );
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("Diff between tenant housekeeping dashboards");
    expect(output).toContain(`Left:  ${RESOLVED_UUID}`);
    expect(output).toContain(`Right: ${TENANT_B}`);
    expect(output).toContain("Field changes");
    expect(output).toContain("tenantPolicy.exists");
  });

  it("--diff with --exit-on-divergence and divergent tenants exits 3", async () => {
    const conn = fakeConn({});
    const { io } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
    };
    const code = await runTenant(
      parsed(
        "tenant",
        "housekeeping",
        "--tenant",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--exit-on-divergence",
      ),
      ctx,
    );
    expect(code).toBe(3);
  });

  it("--diff slug RHS resolves via meta.tenants once and is echoed correctly in output", async () => {
    const conn = fakeConn({ "acme-staging": TENANT_B });
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
      parsed(
        "tenant",
        "housekeeping",
        "--tenant",
        RESOLVED_UUID,
        "--diff",
        "acme-staging",
        "--format",
        "json",
      ),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      left: { input: string };
      right: { tenantId: string; input: string };
    };
    expect(env.right.tenantId).toBe(TENANT_B);
    expect(env.right.input).toBe("acme-staging");
  });
});

// M4.15.c — `tenant housekeeping --add-tenant` N-way diff tests.
// Closes ADR-0288 Q1. Mirrors policies M4.14.a shape: --add-tenant
// extends --diff into N-way comparison; multi-comparison envelope
// when N>1 with anchor + comparisons[] array; max-divergence exit
// code; duplicate-target guards.
describe("runTenant housekeeping --add-tenant N-way (M4.15.c)", () => {
  it("--add-tenant without --diff exits 2", async () => {
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
      parsed("tenant", "housekeeping", "--tenant", RESOLVED_UUID, "--add-tenant", TENANT_B),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--add-tenant requires --diff");
  });

  it("--diff + --add-tenant: JSON envelope uses tenant.housekeeping.diff.multi", async () => {
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
      parsed(
        "tenant",
        "housekeeping",
        "--tenant",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--add-tenant",
        TENANT_C,
        "--format",
        "json",
      ),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      action: string;
      anchor: { tenantId: string };
      comparisons: Array<{ right: { tenantId: string }; fieldDiffs: Array<unknown> }>;
    };
    expect(env.action).toBe("tenant.housekeeping.diff.multi");
    expect(env.anchor.tenantId).toBe(RESOLVED_UUID);
    expect(env.comparisons).toHaveLength(2);
    expect(env.comparisons[0].right.tenantId).toBe(TENANT_B);
    expect(env.comparisons[1].right.tenantId).toBe(TENANT_C);
  });

  it("single --diff (no --add-tenant) preserves M4.15.a single envelope", async () => {
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
      parsed(
        "tenant",
        "housekeeping",
        "--tenant",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--format",
        "json",
      ),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as { action: string; left: unknown; right: unknown };
    // Backward-compat preserved: single-comparison stays
    // tenant.housekeeping.diff (NOT .multi).
    expect(env.action).toBe("tenant.housekeeping.diff");
    expect(env.left).toBeDefined();
    expect(env.right).toBeDefined();
  });

  it("duplicate RHS UUIDs exit 2 ('appears in multiple RHS slots')", async () => {
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
      parsed(
        "tenant",
        "housekeeping",
        "--tenant",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--add-tenant",
        TENANT_B,
      ),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("appears in multiple RHS slots");
  });

  it("N-way max-divergence exit code: any comparison trips → exit 3", async () => {
    const conn = fakeConn({});
    const { io } = makeIo();
    const ctx: TenantContext = {
      io,
      env: {},
      pgConnectionOverride: conn,
      retentionOverride: fakeRetention(),
      idempotencyStoreOverride: fakeIdempotency(),
      clockOverride: () => fixedNow,
    };
    const code = await runTenant(
      parsed(
        "tenant",
        "housekeeping",
        "--tenant",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--add-tenant",
        TENANT_C,
        "--exit-on-divergence",
      ),
      ctx,
    );
    // RESOLVED_UUID has override on gateway_pipeline_executions;
    // TENANT_B has override on workflow_traces; TENANT_C has no
    // overrides in the fixture. Comparison vs B trips, comparison
    // vs C trips. Max-divergence exit code = exit 3.
    expect(code).toBe(3);
  });

  it("N-way human render emits section per comparison", async () => {
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
      parsed(
        "tenant",
        "housekeeping",
        "--tenant",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--add-tenant",
        TENANT_C,
      ),
      ctx,
    );
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("Multi-comparison tenant housekeeping");
    expect(output).toContain("2 comparisons");
    expect(output).toContain("=== Comparison 1/2 ===");
    expect(output).toContain("=== Comparison 2/2 ===");
  });

  it("N-way unknown --add-tenant target surfaces 'right 2' label", async () => {
    const conn = fakeConn({ "acme-prod": TENANT_B });
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
      parsed(
        "tenant",
        "housekeeping",
        "--tenant",
        RESOLVED_UUID,
        "--diff",
        "acme-prod",
        "--add-tenant",
        "no-such-tenant",
      ),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("(right 2 'no-such-tenant')");
  });

  it("N-way anchor matching any RHS slot exits 2 with slot-labeled message", async () => {
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
      parsed(
        "tenant",
        "housekeeping",
        "--tenant",
        RESOLVED_UUID,
        "--diff",
        TENANT_B,
        "--add-tenant",
        RESOLVED_UUID,
      ),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("left and right 2 resolve to the same tenant");
  });
});
