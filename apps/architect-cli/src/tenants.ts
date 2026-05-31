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
// - `tenants get <slug|uuid>` — full TenantRow for one tenant (M4.14.i).
//   Resolves slug→UUID via resolveTenantIdentifier (inherits M4.14.j's
//   "did you mean" suggestions on slug miss), then SELECTs the full row
//   by id. Output: multi-line key:value or JSON envelope.

import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";

import { getBooleanFlag, getStringFlag, type ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import {
  applyColumnsFilter,
  parseColumnsFlag,
  printCsv,
  printError,
  printJson,
  printTsv,
} from "./format.js";
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

// M4.14.i — full row shape for `tenants get`. Extends TenantRow with the
// remaining META_TENANTS columns (region + schema_name + residency JSONB +
// search_locale + timestamps). Operators auditing tenants need the full
// view; list keeps the compact 5-field shape for table-friendly output.
export interface TenantRowFull extends TenantRow {
  readonly region: string;
  readonly schema_name: string;
  readonly residency: unknown;
  readonly search_locale: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export async function runTenants(command: ParsedCommand, ctx: TenantsContext): Promise<number> {
  const action = command.positional[0];
  if (action === undefined) {
    printError(
      ctx.io,
      "tenants: missing action. usage: crossengin tenants <list|resolve|get> [args] [flags]",
    );
    return 2;
  }
  switch (action) {
    case "list":
      return await runTenantsList(command, ctx);
    case "resolve":
      return await runTenantsResolve(command, ctx);
    case "get":
      return await runTenantsGet(command, ctx);
    default:
      printError(
        ctx.io,
        `tenants: unknown action '${action}'. usage: crossengin tenants <list|resolve|get> [args] [flags]`,
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
  // M4.15.g — --include-policy-count adds a computed `policy_count`
  // column via LEFT JOIN against meta.tenant_retention_policies.
  // Tenants with no overrides report 0 (via COALESCE). Composes
  // with --has-overrides (which gates on EXISTS) — operators using
  // both get only tenants with policy_count > 0 returned.
  const includePolicyCount = getBooleanFlag(command, "include-policy-count");
  // M4.15.k — --min-policy-count N filters to tenants with at least
  // N policies. Implies the policy_count JOIN even if --include-
  // policy-count isn't set (otherwise the WHERE clause has nothing
  // to reference). N must be a positive integer (>= 1) — N=0 is a
  // no-op (everyone qualifies) and rejected with a usage error so
  // a typo'd `0` doesn't silently widen the result set.
  const minPolicyCountFlag = getStringFlag(command, "min-policy-count");
  let minPolicyCount: number | null = null;
  if (minPolicyCountFlag !== null) {
    const parsed = Number.parseInt(minPolicyCountFlag, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== minPolicyCountFlag.trim()) {
      printError(
        ctx.io,
        `tenants list: invalid --min-policy-count '${minPolicyCountFlag}' (expected a positive integer >= 1)`,
      );
      return 2;
    }
    minPolicyCount = parsed;
  }
  // M4.15.r — --max-policy-count N filters to tenants with at most N
  // policies (inverse cohort: "under-customized" / "platform-default"
  // tenants). Same JOIN-forcing semantic as --min-policy-count.
  // N >= 0 is valid here (N=0 = "no overrides" = pure platform
  // defaults; inverse of --has-overrides). Composes with --min for
  // range queries: --min 3 --max 10 → tenants with 3-10 policies.
  // Negative + non-numeric + float rejected with same round-trip
  // check as --min.
  const maxPolicyCountFlag = getStringFlag(command, "max-policy-count");
  let maxPolicyCount: number | null = null;
  if (maxPolicyCountFlag !== null) {
    const parsed = Number.parseInt(maxPolicyCountFlag, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== maxPolicyCountFlag.trim()) {
      printError(
        ctx.io,
        `tenants list: invalid --max-policy-count '${maxPolicyCountFlag}' (expected a non-negative integer >= 0)`,
      );
      return 2;
    }
    maxPolicyCount = parsed;
  }
  // Range consistency: --min > --max would yield empty result set
  // intentionally if accepted, but it's almost always an operator
  // typo. Reject with explanatory error so the operator notices.
  if (minPolicyCount !== null && maxPolicyCount !== null && minPolicyCount > maxPolicyCount) {
    printError(
      ctx.io,
      `tenants list: --min-policy-count (${minPolicyCount}) cannot exceed --max-policy-count (${maxPolicyCount})`,
    );
    return 2;
  }

  const conn = await resolveConn(ctx, "tenants list");
  if (conn === null) return 1;

  // M4.15.b — --csv-separator validation BEFORE PG. Mirrors the
  // retention/policies pattern: reject '"' and newlines (would
  // produce ambiguous CSV that no parser can round-trip). Only
  // meaningful under --format csv; under tsv/human/json it's
  // silently ignored, matching the retention precedent.
  const csvSeparatorFlag = getStringFlag(command, "csv-separator");
  if (csvSeparatorFlag !== null && (csvSeparatorFlag === '"' || /[\n\r]/.test(csvSeparatorFlag))) {
    printError(ctx.io, "tenants list: --csv-separator cannot be '\"' or newline");
    return 2;
  }
  // M4.15.p — --no-header suppresses the leading CSV header row so
  // per-tenant fetches can be appended onto bulk-list output without
  // producing duplicate header lines (e.g., `tenants list --format
  // csv-full > all.csv` then `tenants get <slug> --format csv-full
  // --no-header >> all.csv`). Honored on csv/tsv/csv-full; silently
  // ignored under json/human formats (matching --csv-separator
  // precedent).
  const noHeader = getBooleanFlag(command, "no-header");
  // M4.15.q — --columns <col1,col2,...> narrows the CSV output to a
  // subset of columns, preserving the operator-specified order
  // (operators may want `tier,slug,name` instead of the canonical
  // `id,slug,name,status,tier`). Validation is deferred to
  // applyColumnsFilter at the emit site since the valid column set
  // differs between the 5-col compact path and the 11-col full path.
  const columnsFilter = parseColumnsFlag(getStringFlag(command, "columns"));

  try {
    if (command.format === "csv-full") {
      // M4.15.f — 11-column TenantRowFull CSV. Uses the wider SELECT
      // (region, schema, residency JSONB, search_locale, timestamps)
      // rather than the compact 5-column list query. residency is
      // serialized to compact JSON for embedding in a CSV cell;
      // timestamps emitted in stable ISO format via to_char (same
      // shape as `tenants get`).
      const { sql, params } = buildListQueryFull(
        statusFlag,
        tableFilter,
        hasOverrides,
        includePolicyCount,
        minPolicyCount,
        maxPolicyCount,
      );
      const fullResult = await conn.exec.query<TenantRowFull & { policy_count?: number }>(
        sql,
        params,
      );
      const fullRows = fullResult.rows;
      const baseHeaders = [
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
      const headers = includePolicyCount
        ? ([...baseHeaders, "policy_count"] as const)
        : (baseHeaders as ReadonlyArray<string>);
      const csvRows = fullRows.map((r) => {
        const base = [
          r.id,
          r.slug,
          r.name,
          r.status,
          r.tier,
          r.region,
          r.schema_name,
          // residency JSONB → compact JSON string for CSV. printCsv
          // handles quoting + escaping for embedded quotes.
          r.residency === null ? null : JSON.stringify(r.residency),
          r.search_locale,
          r.created_at,
          r.updated_at,
        ];
        return includePolicyCount ? [...base, r.policy_count ?? 0] : base;
      });
      // M4.15.q — apply --columns filter (if set) before printing.
      // Invalid column → exit 2 with the validation error surfaced.
      if (columnsFilter !== null) {
        const filtered = applyColumnsFilter(headers, csvRows, columnsFilter);
        if (!filtered.ok) {
          printError(ctx.io, `tenants list: ${filtered.error}`);
          return 2;
        }
        printCsv(ctx.io, filtered.headers, filtered.rows, csvSeparatorFlag ?? ",", {
          noHeader,
        });
      } else {
        printCsv(ctx.io, headers, csvRows, csvSeparatorFlag ?? ",", { noHeader });
      }
      return 0;
    }

    const { sql, params } = buildListQuery(
      statusFlag,
      tableFilter,
      hasOverrides,
      includePolicyCount,
      minPolicyCount,
      maxPolicyCount,
    );
    const result = await conn.exec.query<TenantRow & { policy_count?: number }>(sql, params);
    const rows = result.rows;
    if (command.format === "json") {
      printJson(ctx.io, { action: "tenants.list", count: rows.length, tenants: rows });
    } else if (command.format === "csv" || command.format === "tsv") {
      // M4.15.b — CSV/TSV bulk export. Headers match TenantRow shape
      // (id, slug, name, status, tier). Filter context lives in the
      // command invocation; CSV is pure data rows for downstream
      // pipelines (pandas, Excel, jq-equivalents). Empty result set
      // still emits the header row (valid CSV; spreadsheet workflows
      // want the header present even when no rows match).
      // M4.15.g — --include-policy-count appends a `policy_count`
      // column for cohort analysis.
      const baseHeaders = ["id", "slug", "name", "status", "tier"];
      const headers = includePolicyCount
        ? ([...baseHeaders, "policy_count"] as const)
        : (baseHeaders as ReadonlyArray<string>);
      const csvRows = rows.map((r) => {
        const base = [r.id, r.slug, r.name, r.status, r.tier];
        return includePolicyCount ? [...base, r.policy_count ?? 0] : base;
      });
      // M4.15.q — --columns filter applied uniformly across tsv + csv
      // emit. Failure returns 2 with the validation error; caller
      // gets actionable feedback before any data is written.
      let outHeaders: ReadonlyArray<string> = headers;
      let outRows: ReadonlyArray<ReadonlyArray<unknown>> = csvRows;
      if (columnsFilter !== null) {
        const filtered = applyColumnsFilter(headers, csvRows, columnsFilter);
        if (!filtered.ok) {
          printError(ctx.io, `tenants list: ${filtered.error}`);
          return 2;
        }
        outHeaders = filtered.headers;
        outRows = filtered.rows;
      }
      if (command.format === "tsv") {
        printTsv(ctx.io, outHeaders, outRows, { noHeader });
      } else {
        printCsv(ctx.io, outHeaders, outRows, csvSeparatorFlag ?? ",", { noHeader });
      }
    } else {
      renderHumanTable(ctx, rows, statusFlag, tableFilter, hasOverrides, includePolicyCount);
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

// M4.14.i — `tenants get <slug|uuid>` returns the full TenantRow for one
// tenant. Resolves slug→UUID via resolveTenantIdentifier (inherits the
// M4.14.j "did you mean" suggestion path on slug miss), then SELECTs the
// full row by id. UUID-shaped input short-circuits the resolve step but
// still must pass the id-existence check — a typo'd UUID surfaces as
// "no tenant with id 'X'" (exit 2) distinct from the slug-not-found
// "no tenant with slug 'X' — did you mean ..." (also exit 2) so
// operators can tell the failure modes apart.
async function runTenantsGet(command: ParsedCommand, ctx: TenantsContext): Promise<number> {
  const input = command.positional[1];
  if (input === undefined) {
    printError(
      ctx.io,
      "tenants get: missing positional argument. usage: crossengin tenants get <slug|uuid>",
    );
    return 2;
  }

  const conn = await resolveConn(ctx, "tenants get");
  if (conn === null) return 1;
  // M4.15.p — --no-header suppresses CSV header row (see tenants
  // list comment block for the operational rationale). Honored on
  // csv/tsv/csv-full; ignored under json/human.
  const noHeader = getBooleanFlag(command, "no-header");
  // M4.15.q — --columns subset filter (see tenants list comment).
  const columnsFilter = parseColumnsFlag(getStringFlag(command, "columns"));

  try {
    const resolved = await resolveTenantIdentifier(conn.exec, input);
    if (!resolved.ok) {
      printError(ctx.io, `tenants get: ${resolved.error}`);
      return 2;
    }
    const result = await conn.exec.query<TenantRowFull>(
      `SELECT id, slug, name, status, tier, region, schema_name, residency, search_locale,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
       FROM meta.tenants WHERE id = $1`,
      [resolved.tenantId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      // UUID short-circuit + missing row: operator's UUID doesn't match
      // any tenant. Slug input that fell through to this branch is
      // impossible (resolveTenantIdentifier would have returned ok:false
      // first), so we can confidently report by id.
      printError(ctx.io, `tenants get: no tenant with id '${resolved.tenantId}'`);
      return 2;
    }
    if (command.format === "json") {
      printJson(ctx.io, { action: "tenants.get", tenant: row });
    } else if (command.format === "csv" || command.format === "tsv") {
      // M4.15.j — single-row CSV/TSV. Column order mirrors `tenants
      // list --format csv` exactly (id, slug, name, status, tier) so
      // downstream pipelines can concat per-tenant fetches into the
      // same shape as list-bulk output without re-aligning columns.
      const baseHeaders: ReadonlyArray<string> = ["id", "slug", "name", "status", "tier"];
      const baseRows: ReadonlyArray<ReadonlyArray<unknown>> = [
        [row.id, row.slug, row.name, row.status, row.tier],
      ];
      // M4.15.q — apply --columns filter before emitting.
      let outHeaders: ReadonlyArray<string> = baseHeaders;
      let outRows: ReadonlyArray<ReadonlyArray<unknown>> = baseRows;
      if (columnsFilter !== null) {
        const filtered = applyColumnsFilter(baseHeaders, baseRows, columnsFilter);
        if (!filtered.ok) {
          printError(ctx.io, `tenants get: ${filtered.error}`);
          return 2;
        }
        outHeaders = filtered.headers;
        outRows = filtered.rows;
      }
      if (command.format === "tsv") {
        printTsv(ctx.io, outHeaders, outRows, { noHeader });
      } else {
        const csvSeparator = getStringFlag(command, "csv-separator");
        printCsv(ctx.io, outHeaders, outRows, csvSeparator ?? ",", { noHeader });
      }
    } else if (command.format === "csv-full") {
      // M4.15.j — single-row 11-column TenantRowFull CSV. Mirrors
      // `tenants list --format csv-full` (M4.15.f) exactly: id, slug,
      // name, status, tier, region, schema_name, residency (JSONB →
      // compact JSON), search_locale, created_at, updated_at.
      const headers = [
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
      const csvRows = [
        [
          row.id,
          row.slug,
          row.name,
          row.status,
          row.tier,
          row.region,
          row.schema_name,
          row.residency === null ? null : JSON.stringify(row.residency),
          row.search_locale,
          row.created_at,
          row.updated_at,
        ],
      ];
      const csvSeparator = getStringFlag(command, "csv-separator");
      // M4.15.q — apply --columns filter against the 11-col csv-full
      // shape. Operators can select any subset / re-order (e.g.,
      // `--columns slug,tier,residency` for a tier-residency audit).
      if (columnsFilter !== null) {
        const filtered = applyColumnsFilter(headers, csvRows, columnsFilter);
        if (!filtered.ok) {
          printError(ctx.io, `tenants get: ${filtered.error}`);
          return 2;
        }
        printCsv(ctx.io, filtered.headers, filtered.rows, csvSeparator ?? ",", { noHeader });
      } else {
        printCsv(ctx.io, headers, csvRows, csvSeparator ?? ",", { noHeader });
      }
    } else {
      renderHumanTenant(ctx, row);
    }
    return 0;
  } finally {
    await conn.close();
  }
}

function renderHumanTenant(ctx: TenantsContext, row: TenantRowFull): void {
  ctx.io.stdout.write(`tenant: ${row.slug}\n`);
  ctx.io.stdout.write(`  id:          ${row.id}\n`);
  ctx.io.stdout.write(`  name:        ${row.name}\n`);
  ctx.io.stdout.write(`  status:      ${row.status}\n`);
  ctx.io.stdout.write(`  tier:        ${row.tier}\n`);
  ctx.io.stdout.write(`  region:      ${row.region}\n`);
  ctx.io.stdout.write(`  schema:      ${row.schema_name}\n`);
  ctx.io.stdout.write(`  created_at:  ${row.created_at}\n`);
  ctx.io.stdout.write(`  updated_at:  ${row.updated_at}\n`);
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
  includePolicyCount: boolean = false,
  minPolicyCount: number | null = null,
  maxPolicyCount: number | null = null,
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
  // M4.15.k — --min-policy-count N forces the LEFT JOIN (so the
  // policy_count expression is available to WHERE) even if
  // --include-policy-count isn't set. WHERE filter is on the
  // COALESCE expression directly rather than the SELECT alias so
  // the JOIN can be referenced without exposing the column.
  if (minPolicyCount !== null) {
    params.push(minPolicyCount);
    where.push(`COALESCE(pc.policy_count, 0) >= $${params.length}`);
  }
  // M4.15.r — --max-policy-count N adds the inverse bound. Either
  // flag forces the JOIN; both compose via AND for range filtering.
  if (maxPolicyCount !== null) {
    params.push(maxPolicyCount);
    where.push(`COALESCE(pc.policy_count, 0) <= $${params.length}`);
  }
  const whereClause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  // M4.15.g — --include-policy-count adds COALESCE(pc.policy_count,
  // 0) AS policy_count from a LEFT JOIN against a per-tenant
  // count subquery. Tenants with no overrides report 0 (COALESCE
  // handles the LEFT-JOIN-missed case). M4.15.k/r — --min/--max-
  // policy-count also need the JOIN; any of the three flags forces
  // it on.
  const needsJoin = includePolicyCount || minPolicyCount !== null || maxPolicyCount !== null;
  const selectExtra = includePolicyCount
    ? ", COALESCE(pc.policy_count, 0)::int AS policy_count"
    : "";
  const joinExtra = needsJoin
    ? " LEFT JOIN (SELECT tenant_id, COUNT(*)::int AS policy_count FROM meta.tenant_retention_policies GROUP BY tenant_id) pc ON pc.tenant_id = t.id"
    : "";
  const sql = `SELECT t.id, t.slug, t.name, t.status, t.tier${selectExtra} FROM meta.tenants t${joinExtra}${whereClause} ORDER BY t.slug`;
  return { sql, params };
}

// M4.15.f — full-row variant of buildListQuery. Adds region,
// schema_name, residency (JSONB), search_locale + ISO-formatted
// timestamps. Mirrors the SELECT shape from `tenants get` so
// downstream consumers see consistent columns across the
// list-bulk and per-tenant single-row paths.
function buildListQueryFull(
  statusFlag: string | null,
  tableFilter: string | null,
  hasOverrides: boolean,
  includePolicyCount: boolean = false,
  minPolicyCount: number | null = null,
  maxPolicyCount: number | null = null,
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
  if (minPolicyCount !== null) {
    params.push(minPolicyCount);
    where.push(`COALESCE(pc.policy_count, 0) >= $${params.length}`);
  }
  // M4.15.r — --max-policy-count adds the inverse bound (same shape
  // as the buildListQuery 5-col path).
  if (maxPolicyCount !== null) {
    params.push(maxPolicyCount);
    where.push(`COALESCE(pc.policy_count, 0) <= $${params.length}`);
  }
  const whereClause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  // M4.15.g — --include-policy-count integration (same shape as
  // buildListQuery; the join + COALESCE is identical). M4.15.k/r —
  // --min-policy-count + --max-policy-count also need the JOIN;
  // any of the three flags forces it on.
  const needsJoin = includePolicyCount || minPolicyCount !== null || maxPolicyCount !== null;
  const selectExtra = includePolicyCount
    ? ", COALESCE(pc.policy_count, 0)::int AS policy_count"
    : "";
  const joinExtra = needsJoin
    ? " LEFT JOIN (SELECT tenant_id, COUNT(*)::int AS policy_count FROM meta.tenant_retention_policies GROUP BY tenant_id) pc ON pc.tenant_id = t.id"
    : "";
  const sql = `SELECT t.id, t.slug, t.name, t.status, t.tier, t.region, t.schema_name, t.residency, t.search_locale,
                      to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
                      to_char(t.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at${selectExtra}
               FROM meta.tenants t${joinExtra}${whereClause}
               ORDER BY t.slug`;
  return { sql, params };
}

function renderHumanTable(
  ctx: TenantsContext,
  rows: ReadonlyArray<TenantRow & { policy_count?: number }>,
  statusFlag: string | null,
  tableFilter: string | null,
  hasOverrides: boolean,
  includePolicyCount: boolean = false,
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
  // M4.15.g — extra `policies` column (just the count number) when
  // --include-policy-count is set. Right-padded to a 7-char min
  // matching the header "policies".
  const policyCountSuffix = includePolicyCount ? `  ${"policies".padEnd(8)}` : "";
  ctx.io.stdout.write(
    `  ${"id".padEnd(36)}  ${"slug".padEnd(slugWidth)}  ${"name".padEnd(nameWidth)}  ${"status".padEnd(statusWidth)}  ${"tier".padEnd(tierWidth)}${policyCountSuffix}\n`,
  );
  for (const r of rows) {
    const pcSuffix = includePolicyCount ? `  ${String(r.policy_count ?? 0).padEnd(8)}` : "";
    ctx.io.stdout.write(
      `  ${r.id.padEnd(36)}  ${r.slug.padEnd(slugWidth)}  ${r.name.padEnd(nameWidth)}  ${r.status.padEnd(statusWidth)}  ${r.tier.padEnd(tierWidth)}${pcSuffix}\n`,
    );
  }
}
