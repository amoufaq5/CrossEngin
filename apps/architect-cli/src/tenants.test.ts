import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { parseArgs } from "./cli.js";
import type { IoStreams } from "./format.js";
import { runTenants, type TenantRow, type TenantRowFull, type TenantsContext } from "./tenants.js";

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

const TENANT_A_FULL: TenantRowFull = {
  id: TENANT_A.id,
  slug: TENANT_A.slug,
  name: TENANT_A.name,
  status: TENANT_A.status,
  tier: TENANT_A.tier,
  region: "us",
  schema_name: "tenant_acme_prod",
  residency: { primary: "us-east-1", failover: "us-west-2" },
  search_locale: "english",
  created_at: "2026-04-15T10:30:00.000Z",
  updated_at: "2026-05-15T14:45:00.000Z",
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
  // M4.15.f — full-row variant for `tenants list --format csv-full`
  // tests. When set + the SELECT mentions `residency` (the marker
  // column that distinguishes the wider query), this is returned
  // instead of tenantRows.
  tenantRowsFull?: ReadonlyArray<TenantRowFull>;
  slugMap?: Record<string, string>;
  getMap?: Record<string, TenantRowFull>;
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
      if (sql.includes("FROM meta.tenants WHERE id = $1")) {
        const id = String(params?.[0] ?? "");
        const row = opts.getMap?.[id];
        return row !== undefined
          ? ({ rows: [row], rowCount: 1 } as unknown as PgQueryResult<T>)
          : ({ rows: [], rowCount: 0 } as unknown as PgQueryResult<T>);
      }
      if (sql.includes("FROM meta.tenants t")) {
        // M4.15.f — distinguish full-row SELECT (mentions residency)
        // from compact SELECT (5 cols). The wider query path needs
        // TenantRowFull-shaped data so route to tenantRowsFull when
        // available; otherwise fall back to the compact rows.
        const isFull = sql.includes("t.residency");
        if (isFull && opts.tenantRowsFull !== undefined) {
          const rows = opts.tenantRowsFull as unknown as T[];
          return { rows, rowCount: rows.length } as PgQueryResult<T>;
        }
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

describe("runTenants get (M4.14.i)", () => {
  it("missing positional argument exits 2 with usage error", async () => {
    const { io, err } = makeIo();
    const ctx: TenantsContext = { io, env: {} };
    const code = await runTenants(parsed("tenants", "get"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("missing positional argument");
    expect(err()).toContain("<slug|uuid>");
  });

  it("UUID input short-circuits resolve and SELECTs by id directly", async () => {
    const { conn, queries } = fakeConn({ getMap: { [TENANT_A.id]: TENANT_A_FULL } });
    const { io } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "get", TENANT_A.id, "--format", "json"), ctx);
    expect(code).toBe(0);
    // Only one query — the WHERE id = $1 SELECT. The resolver short-circuited.
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain("FROM meta.tenants WHERE id = $1");
    expect(queries[0]!.params).toEqual([TENANT_A.id]);
  });

  it("slug input resolves first then SELECTs the full row by resolved id", async () => {
    const { conn, queries } = fakeConn({
      slugMap: { "acme-prod": TENANT_A.id },
      getMap: { [TENANT_A.id]: TENANT_A_FULL },
    });
    const { io } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "get", "acme-prod", "--format", "json"), ctx);
    expect(code).toBe(0);
    // Two queries: slug→UUID resolve + full-row SELECT.
    expect(queries).toHaveLength(2);
    expect(queries[0]!.sql).toContain("SELECT id FROM meta.tenants WHERE slug");
    expect(queries[1]!.sql).toContain("FROM meta.tenants WHERE id = $1");
    expect(queries[1]!.params).toEqual([TENANT_A.id]);
  });

  it("unknown slug exits 2 with 'no tenant with slug' (and inherits M4.14.j suggestions)", async () => {
    // No slug match + no candidates → bare error.
    const { conn } = fakeConn({ slugMap: {} });
    const { io, err } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "get", "no-such-tenant"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("tenants get:");
    expect(err()).toContain("no tenant with slug 'no-such-tenant'");
  });

  it("UUID input that doesn't exist exits 2 with 'no tenant with id' (distinct from slug error)", async () => {
    const { conn } = fakeConn({ getMap: {} });
    const { io, err } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const unknownUuid = "99999999-0000-4000-8000-000000000000";
    const code = await runTenants(parsed("tenants", "get", unknownUuid), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("tenants get:");
    expect(err()).toContain(`no tenant with id '${unknownUuid}'`);
    // Distinct from slug error so operators can tell the failure modes apart.
    expect(err()).not.toContain("did you mean");
  });

  it("JSON envelope includes action + full TenantRow with all 11 META columns", async () => {
    const { conn } = fakeConn({ getMap: { [TENANT_A.id]: TENANT_A_FULL } });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "get", TENANT_A.id, "--format", "json"), ctx);
    expect(code).toBe(0);
    const env = JSON.parse(out()) as { action: string; tenant: TenantRowFull };
    expect(env.action).toBe("tenants.get");
    expect(env.tenant.id).toBe(TENANT_A.id);
    expect(env.tenant.slug).toBe(TENANT_A.slug);
    expect(env.tenant.name).toBe(TENANT_A.name);
    expect(env.tenant.status).toBe(TENANT_A.status);
    expect(env.tenant.tier).toBe(TENANT_A.tier);
    expect(env.tenant.region).toBe("us");
    expect(env.tenant.schema_name).toBe("tenant_acme_prod");
    expect(env.tenant.residency).toEqual({ primary: "us-east-1", failover: "us-west-2" });
    expect(env.tenant.search_locale).toBe("english");
    expect(env.tenant.created_at).toBe("2026-04-15T10:30:00.000Z");
    expect(env.tenant.updated_at).toBe("2026-05-15T14:45:00.000Z");
  });

  it("human format renders the 9 essential fields in a key:value block", async () => {
    const { conn } = fakeConn({ getMap: { [TENANT_A.id]: TENANT_A_FULL } });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "get", TENANT_A.id), ctx);
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain(`tenant: ${TENANT_A.slug}`);
    expect(output).toContain(`id:          ${TENANT_A.id}`);
    expect(output).toContain(`name:        ${TENANT_A.name}`);
    expect(output).toContain("status:      active");
    expect(output).toContain("tier:        enterprise");
    expect(output).toContain("region:      us");
    expect(output).toContain("schema:      tenant_acme_prod");
    expect(output).toContain("created_at:  2026-04-15T10:30:00.000Z");
    expect(output).toContain("updated_at:  2026-05-15T14:45:00.000Z");
  });
});

// M4.15.j — `tenants get --format csv|tsv|csv-full` single-row export
// tests. Closes ADR-0293 Q3. Single-row CSV/TSV mirrors `tenants list`
// column order exactly (5-col for csv/tsv, 11-col for csv-full) so
// per-tenant fetches can be concat'd into list-bulk output without
// column realignment. --csv-separator honored on both csv variants.
describe("runTenants get --format csv|tsv|csv-full (M4.15.j)", () => {
  it("--format csv emits 5-column header + single data row", async () => {
    const { conn } = fakeConn({ getMap: { [TENANT_A.id]: TENANT_A_FULL } });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "get", TENANT_A.id, "--format", "csv"), ctx);
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toBe("id,slug,name,status,tier");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`${TENANT_A.id},acme-prod,Acme Production,active,enterprise`);
  });

  it("--format tsv emits tab-separated single row", async () => {
    const { conn } = fakeConn({ getMap: { [TENANT_A.id]: TENANT_A_FULL } });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "get", TENANT_A.id, "--format", "tsv"), ctx);
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toBe("id\tslug\tname\tstatus\ttier");
    expect(lines[1]).toBe(`${TENANT_A.id}\tacme-prod\tAcme Production\tactive\tenterprise`);
  });

  it("--format csv-full emits 11-column header + data row with residency as compact JSON", async () => {
    const { conn } = fakeConn({ getMap: { [TENANT_A.id]: TENANT_A_FULL } });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "get", TENANT_A.id, "--format", "csv-full"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toBe(
      "id,slug,name,status,tier,region,schema_name,residency,search_locale,created_at,updated_at",
    );
    expect(lines).toHaveLength(2);
    // residency JSONB → compact JSON, quoted by printCsv because of
    // embedded commas in the JSON object representation.
    expect(lines[1]).toContain(
      `${TENANT_A.id},acme-prod,Acme Production,active,enterprise,us,tenant_acme_prod,`,
    );
    expect(lines[1]).toContain(`"{""primary"":""us-east-1"",""failover"":""us-west-2""}"`);
    expect(lines[1]).toContain(",english,2026-04-15T10:30:00.000Z,2026-05-15T14:45:00.000Z");
  });

  it("--format csv-full honors --csv-separator override (semicolon)", async () => {
    const { conn } = fakeConn({ getMap: { [TENANT_A.id]: TENANT_A_FULL } });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "get", TENANT_A.id, "--format", "csv-full", "--csv-separator", ";"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toContain(
      "id;slug;name;status;tier;region;schema_name;residency;search_locale;created_at;updated_at",
    );
    // Cell quoting is independent of separator — printCsv quotes any
    // cell containing embedded quotes, regardless of which separator
    // is in use. residency JSON contains `"` chars so it stays quoted.
    expect(lines[1]).toContain('"{""primary"":""us-east-1"",""failover"":""us-west-2""}"');
    expect(lines[1]).toContain(";acme-prod;Acme Production;active;enterprise;us;");
  });

  it("--format csv honors --csv-separator override (pipe)", async () => {
    const { conn } = fakeConn({ getMap: { [TENANT_A.id]: TENANT_A_FULL } });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "get", TENANT_A.id, "--format", "csv", "--csv-separator", "|"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toBe("id|slug|name|status|tier");
    expect(lines[1]).toBe(`${TENANT_A.id}|acme-prod|Acme Production|active|enterprise`);
  });

  it("--format csv-full preserves null residency as empty cell", async () => {
    const tenantWithNullResidency = { ...TENANT_A_FULL, residency: null };
    const { conn } = fakeConn({ getMap: { [TENANT_A.id]: tenantWithNullResidency } });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "get", TENANT_A.id, "--format", "csv-full"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    // null residency → empty cell between schema_name and search_locale.
    expect(lines[1]).toContain(",tenant_acme_prod,,english,");
  });

  it("--format csv resolves slug→UUID first then SELECTs by id (same 2-query path as JSON)", async () => {
    const { conn, queries } = fakeConn({
      slugMap: { "acme-prod": TENANT_A.id },
      getMap: { [TENANT_A.id]: TENANT_A_FULL },
    });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "get", "acme-prod", "--format", "csv"), ctx);
    expect(code).toBe(0);
    // Resolver still runs for slug input — CSV format doesn't change query path.
    expect(queries).toHaveLength(2);
    const lines = out().trim().split("\n");
    expect(lines[1]).toBe(`${TENANT_A.id},acme-prod,Acme Production,active,enterprise`);
  });

  it("--format csv-full column order matches `tenants list --format csv-full` for concat-able output", async () => {
    // Verifying column-order equality with list-bulk CSV-full output so
    // operators can `tenants list --format csv-full > all.csv` then
    // `tenants get <slug> --format csv-full | tail -1 >> all.csv` without
    // breaking column alignment.
    const { conn } = fakeConn({ getMap: { [TENANT_A.id]: TENANT_A_FULL } });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "get", TENANT_A.id, "--format", "csv-full"),
      ctx,
    );
    expect(code).toBe(0);
    const header = out().split("\n")[0]!;
    const expectedColumns = [
      "id",
      "slug",
      "name",
      "status",
      "tier",
      "region",
      "schema_name",
      "residency",
      "search_locale",
      "created_at",
      "updated_at",
    ];
    expect(header.split(",")).toEqual(expectedColumns);
  });
});

// M4.15.b — `tenants list --format csv|tsv` bulk export tests.
// Closes ADR-0285 Q4. CSV/TSV output is a 5-column row-per-tenant
// shape (id, slug, name, status, tier) suitable for spreadsheet /
// pandas workflows. Empty result still emits the header row.
// --csv-separator overrides comma with the same validation pattern
// retention/policies use (rejects '"' and newlines).
describe("runTenants list --format csv|tsv (M4.15.b)", () => {
  it("--format csv emits header + one row per tenant", async () => {
    const { conn } = fakeConn({ tenantRows: [TENANT_A, TENANT_B, TENANT_C] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "list", "--format", "csv"), ctx);
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toBe("id,slug,name,status,tier");
    expect(lines).toHaveLength(4); // header + 3 tenants
    expect(lines[1]).toBe(`${TENANT_A.id},acme-prod,Acme Production,active,enterprise`);
    expect(lines[2]).toBe(`${TENANT_B.id},beta-corp,Beta Corp,suspended,small`);
    expect(lines[3]).toBe(`${TENANT_C.id},candidate-inc,Candidate Inc,active,regulated`);
  });

  it("--format tsv emits header + rows with tab separator", async () => {
    const { conn } = fakeConn({ tenantRows: [TENANT_A] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "list", "--format", "tsv"), ctx);
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toBe("id\tslug\tname\tstatus\ttier");
    expect(lines[1]).toBe(`${TENANT_A.id}\tacme-prod\tAcme Production\tactive\tenterprise`);
  });

  it("--format csv with empty result emits header only", async () => {
    const { conn } = fakeConn({ tenantRows: [] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "list", "--format", "csv"), ctx);
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("id,slug,name,status,tier");
  });

  it("--format csv respects --status filter (only filtered rows in output)", async () => {
    const { conn, queries } = fakeConn({ tenantRows: [TENANT_A, TENANT_C] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--status", "active", "--format", "csv"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines).toHaveLength(3); // header + 2 active tenants
    // Filter passed through to SQL params.
    expect(queries[0]?.params).toEqual(["active"]);
  });

  it("--format csv with --csv-separator ';' uses semicolon", async () => {
    const { conn } = fakeConn({ tenantRows: [TENANT_A] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--format", "csv", "--csv-separator", ";"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toBe("id;slug;name;status;tier");
    expect(lines[1]).toBe(`${TENANT_A.id};acme-prod;Acme Production;active;enterprise`);
  });

  it("--csv-separator '\"' exits 2 BEFORE PG ('cannot be \" or newline')", async () => {
    const { conn, queries } = fakeConn({ tenantRows: [TENANT_A] });
    const { io, err } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--format", "csv", "--csv-separator", '"'),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--csv-separator cannot be");
    // Validation fires BEFORE the SQL query.
    expect(queries.length).toBe(0);
  });

  it("--csv-separator newline exits 2 BEFORE PG", async () => {
    const { conn, queries } = fakeConn({ tenantRows: [TENANT_A] });
    const { io, err } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--format", "csv", "--csv-separator", "\n"),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--csv-separator cannot be");
    expect(queries.length).toBe(0);
  });

  it("--csv-separator is silently ignored under --format json", async () => {
    const { conn } = fakeConn({ tenantRows: [TENANT_A] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--format", "json", "--csv-separator", ";"),
      ctx,
    );
    expect(code).toBe(0);
    // JSON envelope unchanged regardless of csv-separator (silently
    // ignored in non-CSV formats — matches retention precedent).
    const env = JSON.parse(out()) as { action: string };
    expect(env.action).toBe("tenants.list");
  });
});

// M4.15.f — `tenants list --format csv-full` 11-column bulk export.
// Closes ADR-0289 Q1. Adds region, schema_name, residency (JSONB
// stringified), search_locale, created_at, updated_at to the
// compact 5-column M4.15.b shape. Useful for full audit exports.
describe("runTenants list --format csv-full (M4.15.f)", () => {
  const TENANT_A_FULL_LIST: TenantRowFull = {
    id: TENANT_A.id,
    slug: TENANT_A.slug,
    name: TENANT_A.name,
    status: TENANT_A.status,
    tier: TENANT_A.tier,
    region: "us",
    schema_name: "tenant_acme_prod",
    residency: { primary: "us-east-1", failover: "us-west-2" },
    search_locale: "english",
    created_at: "2026-04-15T10:30:00.000Z",
    updated_at: "2026-05-15T14:45:00.000Z",
  };
  const TENANT_B_FULL_LIST: TenantRowFull = {
    id: TENANT_B.id,
    slug: TENANT_B.slug,
    name: TENANT_B.name,
    status: TENANT_B.status,
    tier: TENANT_B.tier,
    region: "eu",
    schema_name: "tenant_beta_corp",
    residency: { primary: "eu-west-1" },
    search_locale: "german",
    created_at: "2026-03-01T08:00:00.000Z",
    updated_at: "2026-05-20T16:30:00.000Z",
  };

  it("--format csv-full emits 11-column header + one row per tenant", async () => {
    const { conn } = fakeConn({ tenantRowsFull: [TENANT_A_FULL_LIST, TENANT_B_FULL_LIST] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "list", "--format", "csv-full"), ctx);
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toBe(
      "id,slug,name,status,tier,region,schema_name,residency,search_locale,created_at,updated_at",
    );
    expect(lines).toHaveLength(3); // header + 2 tenants
  });

  it("--format csv-full serializes residency JSONB as compact JSON in CSV cell", async () => {
    const { conn } = fakeConn({ tenantRowsFull: [TENANT_A_FULL_LIST] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "list", "--format", "csv-full"), ctx);
    expect(code).toBe(0);
    const output = out();
    // residency object stringified to compact JSON. CSV embeds the
    // JSON via quote-wrapping since the JSON contains a comma; the
    // quoted form preserves the original JSON literal.
    expect(output).toContain('"{""primary"":""us-east-1"",""failover"":""us-west-2""}"');
  });

  it("--format csv-full uses the wider SELECT query (includes residency)", async () => {
    const { conn, queries } = fakeConn({ tenantRowsFull: [TENANT_A_FULL_LIST] });
    const { io } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "list", "--format", "csv-full"), ctx);
    expect(code).toBe(0);
    // The wider query mentions residency + schema_name + search_locale
    // + the to_char timestamps.
    expect(queries[0]?.sql).toContain("t.residency");
    expect(queries[0]?.sql).toContain("t.schema_name");
    expect(queries[0]?.sql).toContain("t.search_locale");
    expect(queries[0]?.sql).toContain("to_char(t.created_at");
  });

  it("--format csv-full respects --status filter", async () => {
    const { conn, queries } = fakeConn({ tenantRowsFull: [TENANT_A_FULL_LIST] });
    const { io } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--status", "active", "--format", "csv-full"),
      ctx,
    );
    expect(code).toBe(0);
    expect(queries[0]?.params).toEqual(["active"]);
  });

  it("--format csv-full respects --has-overrides filter", async () => {
    const { conn, queries } = fakeConn({ tenantRowsFull: [TENANT_A_FULL_LIST] });
    const { io } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--has-overrides", "--format", "csv-full"),
      ctx,
    );
    expect(code).toBe(0);
    expect(queries[0]?.sql).toContain("EXISTS");
  });

  it("--format csv-full with empty result emits header-only", async () => {
    const { conn } = fakeConn({ tenantRowsFull: [] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "list", "--format", "csv-full"), ctx);
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      "id,slug,name,status,tier,region,schema_name,residency,search_locale,created_at,updated_at",
    );
  });

  it("--format csv-full with --csv-separator ';' uses semicolon", async () => {
    const { conn } = fakeConn({ tenantRowsFull: [TENANT_A_FULL_LIST] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--format", "csv-full", "--csv-separator", ";"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toBe(
      "id;slug;name;status;tier;region;schema_name;residency;search_locale;created_at;updated_at",
    );
  });

  it("--format csv-full with null residency renders as empty CSV cell", async () => {
    const tenantNullResidency: TenantRowFull = {
      ...TENANT_A_FULL_LIST,
      residency: null as unknown as TenantRowFull["residency"],
    };
    const { conn } = fakeConn({ tenantRowsFull: [tenantNullResidency] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "list", "--format", "csv-full"), ctx);
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    // null serialized to empty cell by printCsv (verify the residency
    // column is empty by checking the column count + that the line
    // doesn't contain a literal "null" string).
    const parts = lines[1]!.split(",");
    expect(parts).toHaveLength(11);
    // residency is the 8th column (0-indexed 7). Should be empty
    // string (printCsv renders null as empty by convention).
    expect(parts[7]).toBe("");
  });
});

// M4.15.g — `tenants list --include-policy-count` computed column.
// Closes ADR-0289 Q2 + ADR-0293 Q1. LEFT JOIN against
// meta.tenant_retention_policies counts per-tenant overrides via
// COALESCE-to-0 for tenants with no policies. Composes with all
// formats (json, csv, csv-full, tsv, human) — extends each shape
// with one additional `policy_count` column.
describe("runTenants list --include-policy-count (M4.15.g)", () => {
  const TENANT_A_WITH_COUNT = {
    ...TENANT_A,
    policy_count: 5,
  };
  const TENANT_B_WITH_COUNT = {
    ...TENANT_B,
    policy_count: 0,
  };

  it("--include-policy-count adds LEFT JOIN subquery + COALESCE to SQL", async () => {
    const { conn, queries } = fakeConn({ tenantRows: [TENANT_A_WITH_COUNT] });
    const { io } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--include-policy-count", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    expect(queries[0]?.sql).toContain("LEFT JOIN");
    expect(queries[0]?.sql).toContain("COALESCE(pc.policy_count, 0)");
    expect(queries[0]?.sql).toContain("meta.tenant_retention_policies");
    expect(queries[0]?.sql).toContain("GROUP BY tenant_id");
  });

  it("--include-policy-count exposes policy_count field in JSON envelope", async () => {
    const { conn } = fakeConn({ tenantRows: [TENANT_A_WITH_COUNT, TENANT_B_WITH_COUNT] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--include-policy-count", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      tenants: Array<{ slug: string; policy_count: number }>;
    };
    expect(env.tenants[0].policy_count).toBe(5);
    expect(env.tenants[1].policy_count).toBe(0);
  });

  it("--include-policy-count appends column to --format csv", async () => {
    const { conn } = fakeConn({ tenantRows: [TENANT_A_WITH_COUNT, TENANT_B_WITH_COUNT] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--include-policy-count", "--format", "csv"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toBe("id,slug,name,status,tier,policy_count");
    expect(lines[1]).toBe(`${TENANT_A.id},acme-prod,Acme Production,active,enterprise,5`);
    expect(lines[2]).toBe(`${TENANT_B.id},beta-corp,Beta Corp,suspended,small,0`);
  });

  it("--include-policy-count appends column to --format csv-full", async () => {
    const TENANT_A_FULL_WITH_COUNT = {
      ...TENANT_A_FULL,
      policy_count: 3,
    };
    const { conn } = fakeConn({ tenantRowsFull: [TENANT_A_FULL_WITH_COUNT] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--include-policy-count", "--format", "csv-full"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toBe(
      "id,slug,name,status,tier,region,schema_name,residency,search_locale,created_at,updated_at,policy_count",
    );
    expect(lines[1]).toContain(",3");
  });

  it("--include-policy-count appends column to --format tsv", async () => {
    const { conn } = fakeConn({ tenantRows: [TENANT_A_WITH_COUNT] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--include-policy-count", "--format", "tsv"),
      ctx,
    );
    expect(code).toBe(0);
    const lines = out().trim().split("\n");
    expect(lines[0]).toBe("id\tslug\tname\tstatus\ttier\tpolicy_count");
    expect(lines[1]).toContain("\t5");
  });

  it("--include-policy-count adds `policies` column to human render", async () => {
    const { conn } = fakeConn({ tenantRows: [TENANT_A_WITH_COUNT, TENANT_B_WITH_COUNT] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "list", "--include-policy-count"), ctx);
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("policies");
    // Each row should include a numeric count after the standard
    // tier column. With slug-padded widths, the absolute position
    // varies, but the count values 5 and 0 must appear.
    expect(output).toContain("5 ");
    expect(output).toContain("0 ");
  });

  it("no --include-policy-count: SQL does NOT include the LEFT JOIN", async () => {
    const { conn, queries } = fakeConn({ tenantRows: [TENANT_A] });
    const { io } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "list", "--format", "json"), ctx);
    expect(code).toBe(0);
    expect(queries[0]?.sql).not.toContain("LEFT JOIN");
    expect(queries[0]?.sql).not.toContain("policy_count");
  });

  it("--include-policy-count composes with --status filter", async () => {
    const { conn, queries } = fakeConn({ tenantRows: [TENANT_A_WITH_COUNT] });
    const { io } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--include-policy-count", "--status", "active"),
      ctx,
    );
    expect(code).toBe(0);
    // Both the LEFT JOIN AND the status filter present.
    expect(queries[0]?.sql).toContain("LEFT JOIN");
    expect(queries[0]?.sql).toContain("t.status = $1");
    expect(queries[0]?.params).toEqual(["active"]);
  });
});

// M4.15.k — `tenants list --min-policy-count N` server-side cohort
// filter tests. Closes ADR-0294 Q4. Forces the policy_count LEFT
// JOIN even when --include-policy-count is off (the WHERE filter
// references the JOIN expression). N must be a positive integer
// >= 1 (rejects 0, negative, non-numeric). Composes with all other
// filters (--status, --table-filter, --has-overrides, --include-
// policy-count) via AND.
describe("runTenants list --min-policy-count (M4.15.k)", () => {
  it("--min-policy-count 5 adds COALESCE(pc.policy_count, 0) >= $N to WHERE + forces JOIN", async () => {
    const { conn, queries } = fakeConn({ tenantRows: [TENANT_A] });
    const { io } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--min-policy-count", "5", "--format", "json"),
      ctx,
    );
    expect(code).toBe(0);
    // LEFT JOIN forced on even without --include-policy-count.
    expect(queries[0]?.sql).toContain("LEFT JOIN");
    expect(queries[0]?.sql).toContain("COALESCE(pc.policy_count, 0) >= $1");
    expect(queries[0]?.params).toEqual([5]);
    // The outer SELECT does NOT add `COALESCE(...)::int AS
    // policy_count` (that's only added when --include-policy-count is
    // on). The inner JOIN subquery has `COUNT(*)::int AS policy_count`
    // unavoidably — that's how the subquery names its column for
    // the outer COALESCE reference, but it's not exposed to callers.
    expect(queries[0]?.sql).not.toContain("COALESCE(pc.policy_count, 0)::int AS policy_count");
  });

  it("--min-policy-count composes with --include-policy-count (single JOIN, both behaviors)", async () => {
    const { conn, queries } = fakeConn({ tenantRows: [TENANT_A] });
    const { io, out } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed(
        "tenants",
        "list",
        "--min-policy-count",
        "3",
        "--include-policy-count",
        "--format",
        "json",
      ),
      ctx,
    );
    expect(code).toBe(0);
    // Only ONE LEFT JOIN despite both flags requesting one — the join
    // is shared. Both the SELECT and the WHERE reference it.
    const sql = queries[0]!.sql;
    expect(sql.match(/LEFT JOIN/g)?.length).toBe(1);
    expect(sql).toContain("AS policy_count");
    expect(sql).toContain("COALESCE(pc.policy_count, 0) >= $1");
    expect(queries[0]?.params).toEqual([3]);
    // JSON envelope still emits the action label.
    const env = JSON.parse(out()) as { action: string };
    expect(env.action).toBe("tenants.list");
  });

  it("--min-policy-count composes with --status (both filters AND'd, params indexed)", async () => {
    const { conn, queries } = fakeConn({ tenantRows: [TENANT_A] });
    const { io } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed(
        "tenants",
        "list",
        "--status",
        "active",
        "--min-policy-count",
        "10",
        "--format",
        "json",
      ),
      ctx,
    );
    expect(code).toBe(0);
    // Both filters appear; param indices reflect insertion order
    // (status first since runTenantsList builds status before the
    // min-policy-count clause).
    expect(queries[0]?.sql).toContain("t.status = $1");
    expect(queries[0]?.sql).toContain("COALESCE(pc.policy_count, 0) >= $2");
    expect(queries[0]?.params).toEqual(["active", 10]);
  });

  it("--min-policy-count works with --format csv-full (forces JOIN in full-row query path)", async () => {
    const { conn, queries } = fakeConn({ tenantRowsFull: [TENANT_A_FULL] });
    const { io } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(
      parsed("tenants", "list", "--min-policy-count", "1", "--format", "csv-full"),
      ctx,
    );
    expect(code).toBe(0);
    // buildListQueryFull also threads the filter through.
    expect(queries[0]?.sql).toContain("LEFT JOIN");
    expect(queries[0]?.sql).toContain("COALESCE(pc.policy_count, 0) >= $1");
    expect(queries[0]?.params).toEqual([1]);
  });

  it("--min-policy-count 0 rejected with usage error (N=0 is no-op, prevents typo'd widening)", async () => {
    const { io, err } = makeIo();
    const ctx: TenantsContext = { io, env: {} };
    const code = await runTenants(parsed("tenants", "list", "--min-policy-count", "0"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("invalid --min-policy-count '0'");
    expect(err()).toContain("positive integer >= 1");
  });

  it("--min-policy-count negative rejected with usage error", async () => {
    const { io, err } = makeIo();
    const ctx: TenantsContext = { io, env: {} };
    const code = await runTenants(parsed("tenants", "list", "--min-policy-count", "-3"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("invalid --min-policy-count '-3'");
  });

  it("--min-policy-count non-numeric rejected with usage error", async () => {
    const { io, err } = makeIo();
    const ctx: TenantsContext = { io, env: {} };
    const code = await runTenants(parsed("tenants", "list", "--min-policy-count", "many"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("invalid --min-policy-count 'many'");
  });

  it("--min-policy-count float rejected with usage error (integer-only)", async () => {
    // Number.parseInt('5.5') returns 5 but String(5) !== '5.5' so the
    // round-trip check rejects floats with a stricter "integer-only"
    // signal than parseInt's silent truncation.
    const { io, err } = makeIo();
    const ctx: TenantsContext = { io, env: {} };
    const code = await runTenants(parsed("tenants", "list", "--min-policy-count", "5.5"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("invalid --min-policy-count '5.5'");
  });

  it("--min-policy-count not set → no JOIN, no extra WHERE clause (M4.15.k is opt-in only)", async () => {
    const { conn, queries } = fakeConn({ tenantRows: [TENANT_A] });
    const { io } = makeIo();
    const ctx: TenantsContext = { io, env: {}, pgConnectionOverride: conn };
    const code = await runTenants(parsed("tenants", "list", "--format", "json"), ctx);
    expect(code).toBe(0);
    expect(queries[0]?.sql).not.toContain("LEFT JOIN");
    expect(queries[0]?.sql).not.toContain("COALESCE(pc.policy_count");
  });
});
