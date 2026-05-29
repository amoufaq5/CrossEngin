import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { parseArgs } from "./cli.js";
import type { IoStreams } from "./format.js";
import { runTenants, type TenantsContext, type TenantRow } from "./tenants.js";

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

const TENANT_A: TenantRow = {
  id: "00000000-0000-4000-8000-00000000000a",
  slug: "acme-prod",
  name: "Acme Production",
  status: "active",
  tier: "enterprise",
};
const TENANT_B: TenantRow = {
  id: "00000000-0000-4000-8000-00000000000b",
  slug: "beta-corp",
  name: "Beta Corp",
  status: "suspended",
  tier: "small",
};
const TENANT_C: TenantRow = {
  id: "00000000-0000-4000-8000-00000000000c",
  slug: "candidate-inc",
  name: "Candidate Inc",
  status: "active",
  tier: "regulated",
};

interface CapturedQuery {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

// Test conn that records SELECT queries against meta.tenants and slug
// lookups. The `tenantRows` array is returned for `SELECT ... FROM
// meta.tenants ...` queries; `slugMap` resolves single-row slug
// lookups (used by the resolveTenantIdentifier path).
function fakeConn(opts: {
  tenantRows?: ReadonlyArray<TenantRow>;
  slugMap?: Record<string, string>;
}): { conn: PgConnection; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const conn: PgConnection = {
    query: async <T>(sql: string, params?: readonly unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("SELECT id FROM meta.tenants WHERE slug")) {
        const slug = String(params?.[0] ?? "");
        const id = opts.slugMap?.[slug];
        return id !== undefined
          ? ({ rows: [{ id }], rowCount: 1 } as unknown as PgQueryResult<T>)
          : ({ rows: [], rowCount: 0 } as unknown as PgQueryResult<T>);
      }
      if (sql.includes("FROM meta.tenants t")) {
        const rows = (opts.tenantRows ?? []) as unknown as T[];
        return { rows, rowCount: rows.length } as PgQueryResult<T>;
      }
      return { rows: [], rowCount: 0 } as unknown as PgQueryResult<T>;
    },
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>) => fn(),
    close: async () => undefined,
  };
  return { conn, queries };
}

describe("runTenants dispatcher (M4.14.k)", () => {
  it("missing action exits 2 with usage error", async () => {
    const { io, err } = makeIo();
    const ctx: TenantsContext = { io, env: {} };
    const code = await runTenants(parsed("tenants"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("missing action");
  });

  it("unknown action exits 2 with usage error", async () => {
    const { io, err } = makeIo();
    const ctx: TenantsContext = { io, env: {} };
    const code = await runTenants(parsed("tenants", "bogus"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("unknown action 'bogus'");
  });
});

describe("runTenants list (M4.14.k)", () => {
  it("returns all tenants sorted by slug when no filters set", async () => {
    const { conn, queries } = fakeConn({ tenantRows: [TENANT_A, TENANT_B, TENANT_C] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "list", "--format", "json"), ctx);
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      action: string;
      count: number;
      tenants: Array<{ slug: string }>;
    };
    expect(env.action).toBe("tenants.list");
    expect(env.count).toBe(3);
    expect(env.tenants.map((t) => t.slug)).toEqual(["acme-prod", "beta-corp", "candidate-inc"]);
    // No WHERE clause + ORDER BY slug.
    expect(queries[0]!.sql).not.toContain("WHERE");
    expect(queries[0]!.sql).toContain("ORDER BY t.slug");
  });

  it("--status filter threads through to SQL as parameterized clause", async () => {
    const { conn, queries } = fakeConn({ tenantRows: [TENANT_A, TENANT_C] });
    const { io } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--status", "active", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    expect(queries[0]!.sql).toContain("t.status = $1");
    expect(queries[0]!.params).toEqual(["active"]);
  });

  it("invalid --status exits 2 with explanatory error listing valid values", async () => {
    const { io, err } = makeIo();
    const ctx: TenantsContext = { io, env: {} };
    const code = await runTenants(parsed("tenants", "list", "--status", "bogus"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("invalid --status 'bogus'");
    expect(err()).toContain("active, suspended, archived, deleted");
  });

  it("--table-filter threads through as EXISTS subquery against tenant_retention_policies", async () => {
    const { conn, queries } = fakeConn({ tenantRows: [TENANT_A] });
    const { io } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--table-filter", "workflow_traces", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    expect(queries[0]!.sql).toContain(
      "EXISTS (SELECT 1 FROM meta.tenant_retention_policies p WHERE p.tenant_id = t.id AND p.table_name = $1)",
    );
    expect(queries[0]!.params).toEqual(["workflow_traces"]);
  });

  it("--has-overrides threads through as EXISTS subquery without table predicate", async () => {
    const { conn, queries } = fakeConn({ tenantRows: [TENANT_A] });
    const { io } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "list", "--has-overrides"), ctx);
    expect(code).toBe(0);
    expect(queries[0]!.sql).toContain(
      "EXISTS (SELECT 1 FROM meta.tenant_retention_policies p WHERE p.tenant_id = t.id)",
    );
  });

  it("--table-filter takes precedence over --has-overrides (table predicate strictly narrower)", async () => {
    const { conn, queries } = fakeConn({ tenantRows: [] });
    const { io } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--table-filter", "workflow_traces", "--has-overrides"),
      ctx,
    );
    expect(code).toBe(0);
    // Single EXISTS — the table-filter variant wins; --has-overrides is
    // a strict superset so the table-filter naturally includes it.
    expect(queries[0]!.sql).toContain("p.table_name = $1");
    expect(queries[0]!.sql.match(/EXISTS/g)!.length).toBe(1);
  });

  it("human-format renders a sorted table with filter suffix in header + per-row fields", async () => {
    const { conn } = fakeConn({ tenantRows: [TENANT_A, TENANT_B] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "list", "--status", "active"), ctx);
    expect(code).toBe(0);
    const stdout = out();
    expect(stdout).toContain("tenants (2)");
    expect(stdout).toContain("filtered: status=active");
    expect(stdout).toContain("acme-prod");
    expect(stdout).toContain("Acme Production");
    expect(stdout).toContain("enterprise");
  });

  it("renders '(no tenants match)' message when result set is empty", async () => {
    const { conn } = fakeConn({ tenantRows: [] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "list"), ctx);
    expect(code).toBe(0);
    expect(out()).toContain("(no tenants match)");
  });
});

describe("runTenants resolve (M4.14.k)", () => {
  it("missing positional argument exits 2 with usage error", async () => {
    const { io, err } = makeIo();
    const ctx: TenantsContext = { io, env: {} };
    const code = await runTenants(parsed("tenants", "resolve"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("missing positional");
  });

  it("UUID input short-circuits and prints UUID + newline (pipeline-friendly)", async () => {
    const { conn, queries } = fakeConn({});
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "resolve", TENANT_A.id), ctx);
    expect(code).toBe(0);
    expect(out()).toBe(TENANT_A.id + "\n");
    // No PG round-trip — UUID short-circuited.
    expect(queries).toHaveLength(0);
  });

  it("slug input resolves via meta.tenants and prints UUID + newline", async () => {
    const { conn, queries } = fakeConn({ slugMap: { "acme-prod": TENANT_A.id } });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "resolve", "acme-prod"), ctx);
    expect(code).toBe(0);
    expect(out()).toBe(TENANT_A.id + "\n");
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain("SELECT id FROM meta.tenants WHERE slug");
  });

  it("unknown slug exits 2 with 'no tenant with slug' error", async () => {
    const { conn } = fakeConn({ slugMap: {} });
    const { io, err } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "resolve", "no-such-tenant"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("no tenant with slug 'no-such-tenant'");
  });

  it("JSON envelope includes action + input + resolved tenantId", async () => {
    const { conn } = fakeConn({ slugMap: { "acme-prod": TENANT_A.id } });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "resolve", "acme-prod", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as { action: string; input: string; tenantId: string };
    expect(env.action).toBe("tenants.resolve");
    expect(env.input).toBe("acme-prod");
    expect(env.tenantId).toBe(TENANT_A.id);
  });
});
