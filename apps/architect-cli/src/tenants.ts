// M4.14.k — `crossengin tenants` (plural) standalone subcommand.
// Closes ADR-0273 Q3 + ADR-0275 Q6.
//
// Operators wanting to discover slugs OR pre-resolve slugs without
// invoking a dashboard had no path. After M4.14.o/m wired slug
// acceptance into housekeeping + the three retention query actions,
// operators still had to either remember slugs OR look them up via
// raw SQL against meta.tenants. The new `tenants` (plural) top-level
// subcommand reserves a namespace for collection-level tenant
// operations distinct from `tenant` (singular, per-tenant actions
// from M4.14.l).
//
// Actions (v1):
// - `tenants list` — enumerate tenants from meta.tenants with optional
//   filters (--status, --table-filter, --has-overrides). Output:
//   human table or JSON envelope.
// - `tenants resolve <slug>` — one-shot UUID lookup helper for shell
//   scripting. Output: just the UUID + newline (pipeline-friendly) or
//   JSON envelope.

import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";

import { getBooleanFlag, getStringFlag, type ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import { printError, printJson } from "./format.js";
import { resolveTenantIdentifier } from "./tenant-resolver.js";

export interface TenantsContext extends RunContext {
  readonly pgConnectionOverride?: PgConnection;
}

// Matches meta.tenants.status CHECK constraint verbatim.
const TENANT_STATUSES = ["active", "suspended", "archived", "deleted"] as const;
type TenantStatus = (typeof TENANT_STATUSES)[number];

function isTenantStatus(value: string): value is TenantStatus {
  return (TENANT_STATUSES as readonly string[]).includes(value);
}

export interface TenantRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
  readonly tier: string;
}

export async function runTenants(command: ParsedCommand, ctx: TenantsContext): Promise<number> {
  const action = command.positional[0];
  if (action === undefined) {
    printError(
      ctx.io,
      "tenants: missing action. usage: crossengin tenants <list|resolve> [args] [flags]",
    );
    return 2;
  }
  switch (action) {
    case "list":
      return await runTenantsList(command, ctx);
    case "resolve":
      return await runTenantsResolve(command, ctx);
    default:
      printError(
        ctx.io,
        `tenants: unknown action '${action}'. usage: crossengin tenants <list|resolve> [args] [flags]`,
      );
      return 2;
  }
}

async function runTenantsList(command: ParsedCommand, ctx: TenantsContext): Promise<number> {
  const statusFlag = getStringFlag(command, "status");
  if (statusFlag !== null && !isTenantStatus(statusFlag)) {
    printError(
      ctx.io,
      `tenants list: invalid --status '${statusFlag}' (expected one of: ${TENANT_STATUSES.join(", ")})`,
    );
    return 2;
  }
  const tableFilter = getStringFlag(command, "table-filter");
  const hasOverrides = getBooleanFlag(command, "has-overrides");

  const conn = await resolveConn(ctx, "tenants list");
  if (conn === null) return 1;

  try {
    const { sql, params } = buildListQuery(statusFlag, tableFilter, hasOverrides);
    const result = await conn.exec.query<TenantRow>(sql, params);
    const rows = result.rows;
    if (command.format === "json") {
      printJson(ctx.io, { action: "tenants.list", count: rows.length, tenants: rows });
    } else {
      renderHumanTable(ctx, rows, statusFlag, tableFilter, hasOverrides);
    }
    return 0;
  } catch (err) {
    printError(ctx.io, `tenants list: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await conn.close();
  }
}

async function runTenantsResolve(command: ParsedCommand, ctx: TenantsContext): Promise<number> {
  const input = command.positional[1];
  if (input === undefined) {
    printError(
      ctx.io,
      "tenants resolve: missing positional argument. usage: crossengin tenants resolve <slug|uuid>",
    );
    return 2;
  }

  const conn = await resolveConn(ctx, "tenants resolve");
  if (conn === null) return 1;

  try {
    const result = await resolveTenantIdentifier(conn.exec, input);
    if (!result.ok) {
      printError(ctx.io, `tenants resolve: ${result.error}`);
      return 2;
    }
    if (command.format === "json") {
      printJson(ctx.io, {
        action: "tenants.resolve",
        input,
        tenantId: result.tenantId,
      });
    } else {
      // Pipeline-friendly: just the UUID + newline so shell
      // composition (`crossengin tenants resolve acme-prod | xargs
      // -I {} crossengin gateway housekeeping --tenant {}`) works.
      ctx.io.stdout.write(result.tenantId + "\n");
    }
    return 0;
  } finally {
    await conn.close();
  }
}

interface ConnHandle {
  readonly exec: PgConnection;
  readonly close: () => Promise<void>;
}

async function resolveConn(ctx: TenantsContext, actionLabel: string): Promise<ConnHandle | null> {
  if (ctx.pgConnectionOverride !== undefined) {
    return { exec: ctx.pgConnectionOverride, close: async () => undefined };
  }
  try {
    const config = parsePgEnvConfig(ctx.env);
    const conn = createNodePgConnection(config);
    return {
      exec: conn,
      close: async () => {
        await conn.close().catch(() => undefined);
      },
    };
  } catch (err) {
    printError(
      ctx.io,
      `${actionLabel}: requires PG env vars (PGHOST/PGDATABASE/...): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function buildListQuery(
  statusFlag: string | null,
  tableFilter: string | null,
  hasOverrides: boolean,
): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (statusFlag !== null) {
    params.push(statusFlag);
    where.push(`t.status = $${params.length}`);
  }
  if (tableFilter !== null) {
    params.push(tableFilter);
    where.push(
      `EXISTS (SELECT 1 FROM meta.tenant_retention_policies p WHERE p.tenant_id = t.id AND p.table_name = $${params.length})`,
    );
  } else if (hasOverrides) {
    where.push(`EXISTS (SELECT 1 FROM meta.tenant_retention_policies p WHERE p.tenant_id = t.id)`);
  }
  const whereClause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT t.id, t.slug, t.name, t.status, t.tier FROM meta.tenants t${whereClause} ORDER BY t.slug`;
  return { sql, params };
}

function renderHumanTable(
  ctx: TenantsContext,
  rows: ReadonlyArray<TenantRow>,
  statusFlag: string | null,
  tableFilter: string | null,
  hasOverrides: boolean,
): void {
  const filters: string[] = [];
  if (statusFlag !== null) filters.push(`status=${statusFlag}`);
  if (tableFilter !== null) filters.push(`table=${tableFilter}`);
  else if (hasOverrides) filters.push("has-overrides");
  const filterSuffix = filters.length > 0 ? ` (filtered: ${filters.join(", ")})` : "";
  ctx.io.stdout.write(`tenants (${rows.length})${filterSuffix}:\n`);
  if (rows.length === 0) {
    ctx.io.stdout.write("  (no tenants match)\n");
    return;
  }
  const slugWidth = Math.max(4, ...rows.map((r) => r.slug.length));
  const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));
  const statusWidth = Math.max(6, ...rows.map((r) => r.status.length));
  const tierWidth = Math.max(4, ...rows.map((r) => r.tier.length));
  ctx.io.stdout.write(
    `  ${"id".padEnd(36)}  ${"slug".padEnd(slugWidth)}  ${"name".padEnd(nameWidth)}  ${"status".padEnd(statusWidth)}  ${"tier".padEnd(tierWidth)}\n`,
  );
  for (const r of rows) {
    ctx.io.stdout.write(
      `  ${r.id.padEnd(36)}  ${r.slug.padEnd(slugWidth)}  ${r.name.padEnd(nameWidth)}  ${r.status.padEnd(statusWidth)}  ${r.tier.padEnd(tierWidth)}\n`,
    );
  }
}
