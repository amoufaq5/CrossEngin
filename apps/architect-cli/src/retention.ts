import {
  createNodePgConnection,
  parsePgEnvConfig,
  PostgresTraceRetention,
  type EffectiveRetentionResolution,
  type ExpiringOptOut,
  type PgConnection,
  type RetentionPolicyRow,
  type TenantRetentionPolicyRow,
} from "@crossengin/kernel-pg";

import type { ParsedCommand } from "./cli.js";
import { getBooleanFlag, getStringFlag } from "./cli.js";
import type { RunContext } from "./commands.js";
import { printError, printJson, printSuccess } from "./format.js";

const DEFAULT_WITHIN_DAYS = 30;

export interface RetentionContext extends RunContext {
  readonly retentionOverride?: PostgresTraceRetention;
}

interface ResolvedHandle {
  readonly retention: PostgresTraceRetention;
  readonly close: () => Promise<void>;
}

export async function runRetention(
  command: ParsedCommand,
  ctx: RetentionContext,
): Promise<number> {
  const action = command.positional[0];
  if (action === undefined) {
    printError(
      ctx.io,
      "retention: missing action. usage: crossengin retention <expiring|effective|opt-out|opt-in|set|list-policies> [args]",
    );
    return 2;
  }
  const handle = await resolveRetention(ctx);
  if (handle === null) return 1;
  try {
    switch (action) {
      case "expiring":
        return await runRetentionExpiring(command, ctx, handle.retention);
      case "effective":
        return await runRetentionEffective(command, ctx, handle.retention);
      case "opt-out":
        return await runRetentionOptOut(command, ctx, handle.retention);
      case "opt-in":
        return await runRetentionOptIn(command, ctx, handle.retention);
      case "set":
        return await runRetentionSet(command, ctx, handle.retention);
      case "list-policies":
        return await runRetentionListPolicies(command, ctx, handle.retention);
      default:
        printError(
          ctx.io,
          `retention: unknown action '${action}'. expected one of: expiring, effective, opt-out, opt-in, set, list-policies`,
        );
        return 2;
    }
  } finally {
    await handle.close();
  }
}

async function resolveRetention(
  ctx: RetentionContext,
): Promise<ResolvedHandle | null> {
  if (ctx.retentionOverride !== undefined) {
    return { retention: ctx.retentionOverride, close: async () => undefined };
  }
  let conn: PgConnection;
  try {
    const config = parsePgEnvConfig(ctx.env);
    conn = createNodePgConnection(config);
  } catch (err) {
    printError(
      ctx.io,
      `retention: requires PG env vars (PGHOST/PGDATABASE/...): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  return {
    retention: new PostgresTraceRetention({ conn }),
    close: async () => {
      await conn.close().catch(() => undefined);
    },
  };
}

async function runRetentionExpiring(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
): Promise<number> {
  const withinDaysFlag = getStringFlag(command, "within-days");
  const withinDays =
    withinDaysFlag !== null ? Number.parseFloat(withinDaysFlag) : DEFAULT_WITHIN_DAYS;
  if (!Number.isFinite(withinDays) || withinDays < 0) {
    printError(
      ctx.io,
      `retention expiring: invalid --within-days '${withinDaysFlag ?? ""}' (must be a finite number >= 0)`,
    );
    return 2;
  }
  const includeExpired = getBooleanFlag(command, "include-expired");

  let results: ReadonlyArray<ExpiringOptOut>;
  try {
    results = await retention.expiringOptOuts({ withinDays, includeExpired });
  } catch (err) {
    printError(
      ctx.io,
      `retention expiring: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (command.format === "json") {
    printJson(ctx.io, {
      withinDays,
      includeExpired,
      count: results.length,
      results,
    });
    return 0;
  }

  if (results.length === 0) {
    printSuccess(
      ctx.io,
      `no opt-outs ${includeExpired ? "expired or expiring" : "expiring"} within ${withinDays} day(s)`,
    );
    return 0;
  }

  ctx.io.stdout.write(formatExpiringTable(results, withinDays, includeExpired));
  return 0;
}

export function formatExpiringTable(
  results: ReadonlyArray<ExpiringOptOut>,
  withinDays: number,
  includeExpired: boolean,
): string {
  const header = includeExpired
    ? `Opt-outs expired or expiring within ${withinDays} day(s) (${results.length} total):`
    : `Opt-outs expiring within ${withinDays} day(s) (${results.length} total):`;
  const rows = results.map((r) => {
    const days = r.daysUntilExpiry;
    const daysLabel =
      days < 0
        ? `EXPIRED ${(-days).toFixed(1)}d ago`
        : `${days.toFixed(1)}d`;
    const reason = r.optOutReason ?? "<no reason>";
    return `  ${daysLabel.padEnd(20)} ${r.tenantId}  ${r.tableName}  ${reason}`;
  });
  return [header, ...rows, ""].join("\n");
}

async function runRetentionEffective(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
): Promise<number> {
  const tenantId = command.positional[1];
  const tableName = command.positional[2];
  if (tenantId === undefined || tableName === undefined) {
    printError(
      ctx.io,
      "retention effective: missing arguments. usage: crossengin retention effective <tenant-id> <table-name>",
    );
    return 2;
  }

  let resolution: EffectiveRetentionResolution;
  try {
    resolution = await retention.effectiveRetention(tenantId, tableName);
  } catch (err) {
    printError(
      ctx.io,
      `retention effective: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (command.format === "json") {
    printJson(ctx.io, { tenantId, tableName, resolution });
    return 0;
  }

  ctx.io.stdout.write(
    formatEffectiveResolution(resolution, tenantId, tableName),
  );
  return 0;
}

export function formatEffectiveResolution(
  resolution: EffectiveRetentionResolution,
  queriedTenantId: string,
  tableName: string,
): string {
  const lines: string[] = [];
  switch (resolution.source) {
    case "tenant":
      lines.push("Tenant override (active)");
      lines.push(`  Tenant:     ${resolution.tenantId}`);
      lines.push(`  Table:      ${tableName}`);
      lines.push(`  Retention:  ${resolution.retentionDays} day(s)`);
      lines.push(`  Enabled:    yes`);
      break;
    case "tenant_opt_out": {
      lines.push("Tenant opt-out (active)");
      lines.push(`  Tenant:     ${resolution.tenantId}`);
      lines.push(`  Table:      ${tableName}`);
      const until =
        resolution.optOutUntil === null
          ? "indefinite"
          : resolution.optOutUntil;
      lines.push(`  Until:      ${until}`);
      lines.push(
        `  Reason:     ${resolution.optOutReason ?? "<no reason>"}`,
      );
      break;
    }
    case "platform":
      lines.push("Platform default");
      lines.push(`  Tenant:     ${queriedTenantId}`);
      lines.push(`  Table:      ${tableName}`);
      lines.push(`  Retention:  ${resolution.retentionDays} day(s)`);
      lines.push(`  Enabled:    ${resolution.enabled ? "yes" : "no"}`);
      break;
    case "none":
      lines.push("No policy configured");
      lines.push(`  Tenant:     ${queriedTenantId}`);
      lines.push(`  Table:      ${tableName}`);
      break;
  }
  return lines.join("\n") + "\n";
}

async function runRetentionOptOut(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
): Promise<number> {
  const tenantId = command.positional[1];
  const tableName = command.positional[2];
  if (tenantId === undefined || tableName === undefined) {
    printError(
      ctx.io,
      "retention opt-out: missing arguments. usage: crossengin retention opt-out <tenant-id> <table-name> [--until DATE] [--reason TEXT] [--retention-days N]",
    );
    return 2;
  }

  const untilFlag = getStringFlag(command, "until");
  let optOutUntil: string | null = null;
  if (untilFlag !== null) {
    const parsedMs = Date.parse(untilFlag);
    if (!Number.isFinite(parsedMs)) {
      printError(
        ctx.io,
        `retention opt-out: invalid --until '${untilFlag}' (must be an ISO 8601 timestamp)`,
      );
      return 2;
    }
    optOutUntil = new Date(parsedMs).toISOString();
  }

  const reasonFlag = getStringFlag(command, "reason");
  if (reasonFlag !== null && (reasonFlag.length < 1 || reasonFlag.length > 256)) {
    printError(
      ctx.io,
      `retention opt-out: invalid --reason length ${reasonFlag.length} (must be 1..256)`,
    );
    return 2;
  }
  const optOutReason: string | null = reasonFlag;

  const retentionDaysFlag = getStringFlag(command, "retention-days");
  let retentionDays: number | undefined;
  if (retentionDaysFlag !== null) {
    const parsed = Number.parseInt(retentionDaysFlag, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      printError(
        ctx.io,
        `retention opt-out: invalid --retention-days '${retentionDaysFlag}' (must be an integer >= 1)`,
      );
      return 2;
    }
    retentionDays = parsed;
  }

  let policy: TenantRetentionPolicyRow;
  try {
    policy = await retention.setTenantOptOut({
      tenantId,
      tableName,
      retentionDays,
      optOutUntil,
      optOutReason,
    });
  } catch (err) {
    printError(
      ctx.io,
      `retention opt-out: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (command.format === "json") {
    printJson(ctx.io, { action: "opt-out", policy });
    return 0;
  }
  ctx.io.stdout.write(formatPolicyChange("opted out", policy));
  return 0;
}

async function runRetentionOptIn(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
): Promise<number> {
  const tenantId = command.positional[1];
  const tableName = command.positional[2];
  if (tenantId === undefined || tableName === undefined) {
    printError(
      ctx.io,
      "retention opt-in: missing arguments. usage: crossengin retention opt-in <tenant-id> <table-name>",
    );
    return 2;
  }

  let policy: TenantRetentionPolicyRow | null;
  try {
    policy = await retention.clearTenantOptOut({ tenantId, tableName });
  } catch (err) {
    printError(
      ctx.io,
      `retention opt-in: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (command.format === "json") {
    printJson(ctx.io, { action: "opt-in", policy });
    return 0;
  }
  if (policy === null) {
    printSuccess(
      ctx.io,
      `no active opt-out for tenant ${tenantId} on ${tableName} (idempotent no-op)`,
    );
    return 0;
  }
  ctx.io.stdout.write(formatPolicyChange("opted in", policy));
  return 0;
}

export function formatPolicyChange(
  action: string,
  policy: TenantRetentionPolicyRow,
): string {
  const lines: string[] = [];
  lines.push(`Tenant ${action}: ${policy.tenantId} / ${policy.tableName}`);
  lines.push(`  Retention:  ${policy.retentionDays} day(s)`);
  lines.push(`  Enabled:    ${policy.enabled ? "yes" : "no"}`);
  lines.push(`  Opt-out:    ${policy.optOut ? "yes" : "no"}`);
  if (policy.optOut) {
    const until = policy.optOutUntil ?? "indefinite";
    lines.push(`  Until:      ${until}`);
  } else if (policy.optOutUntil !== null) {
    lines.push(`  Until:      ${policy.optOutUntil}`);
  }
  if (policy.optOutReason !== null) {
    lines.push(`  Reason:     ${policy.optOutReason}`);
  }
  return lines.join("\n") + "\n";
}

async function runRetentionListPolicies(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
): Promise<number> {
  const tenantFilter = getStringFlag(command, "tenant");
  const tableFilter = getStringFlag(command, "table");

  let platform: ReadonlyArray<RetentionPolicyRow>;
  let tenantPolicies: ReadonlyArray<TenantRetentionPolicyRow>;
  try {
    [platform, tenantPolicies] = await Promise.all([
      retention.listPolicies(),
      retention.listTenantPolicies(),
    ]);
  } catch (err) {
    printError(
      ctx.io,
      `retention list-policies: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const filteredPlatform = platform.filter(
    (p) => tableFilter === null || p.tableName === tableFilter,
  );
  const filteredTenant = tenantPolicies.filter(
    (p) =>
      (tenantFilter === null || p.tenantId === tenantFilter) &&
      (tableFilter === null || p.tableName === tableFilter),
  );

  if (command.format === "json") {
    printJson(ctx.io, {
      tenantFilter: tenantFilter ?? null,
      tableFilter: tableFilter ?? null,
      platform: filteredPlatform,
      tenantPolicies: filteredTenant,
    });
    return 0;
  }

  ctx.io.stdout.write(
    formatPoliciesList(filteredPlatform, filteredTenant, {
      tenantFilter,
      tableFilter,
    }),
  );
  return 0;
}

export interface PoliciesListFilters {
  readonly tenantFilter: string | null;
  readonly tableFilter: string | null;
}

export function formatPoliciesList(
  platform: ReadonlyArray<RetentionPolicyRow>,
  tenantPolicies: ReadonlyArray<TenantRetentionPolicyRow>,
  filters: PoliciesListFilters,
): string {
  const lines: string[] = [];

  const filterDesc: string[] = [];
  if (filters.tenantFilter !== null) {
    filterDesc.push(`tenant=${filters.tenantFilter}`);
  }
  if (filters.tableFilter !== null) {
    filterDesc.push(`table=${filters.tableFilter}`);
  }
  const filterSuffix =
    filterDesc.length > 0 ? ` (filtered: ${filterDesc.join(", ")})` : "";

  lines.push(`Platform defaults (${platform.length} total)${filterSuffix}:`);
  if (platform.length === 0) {
    lines.push("  (none configured)");
  } else {
    for (const p of platform) {
      const last = p.lastPrunedAt ?? "never";
      lines.push(
        `  ${p.tableName.padEnd(24)} ${`${p.retentionDays}d`.padEnd(8)} ${
          p.enabled ? "enabled " : "disabled"
        }   last pruned ${last}`,
      );
    }
  }

  lines.push("");
  lines.push(
    `Per-tenant policies (${tenantPolicies.length} total)${filterSuffix}:`,
  );
  if (tenantPolicies.length === 0) {
    lines.push("  (none configured)");
  } else {
    for (const p of tenantPolicies) {
      const optOutDetail = formatTenantOptOutSummary(p);
      lines.push(
        `  ${p.tenantId}  ${p.tableName.padEnd(20)} ${`${p.retentionDays}d`.padEnd(8)} ${
          p.enabled ? "enabled " : "disabled"
        }  ${optOutDetail}`,
      );
    }
  }

  return lines.join("\n") + "\n";
}

function formatTenantOptOutSummary(p: TenantRetentionPolicyRow): string {
  if (!p.optOut) {
    return "opt-out=no";
  }
  const until = p.optOutUntil ?? "indefinite";
  const reason = p.optOutReason ?? "<no reason>";
  return `opt-out=yes (until ${until}, reason: ${reason})`;
}

async function runRetentionSet(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
): Promise<number> {
  const tenantId = command.positional[1];
  const tableName = command.positional[2];
  if (tenantId === undefined || tableName === undefined) {
    printError(
      ctx.io,
      "retention set: missing arguments. usage: crossengin retention set <tenant-id> <table-name> --days N [--enabled true|false]",
    );
    return 2;
  }

  const daysFlag = getStringFlag(command, "days");
  if (daysFlag === null) {
    printError(
      ctx.io,
      "retention set: missing --days flag. usage: crossengin retention set <tenant-id> <table-name> --days N [--enabled true|false]",
    );
    return 2;
  }
  const days = Number.parseInt(daysFlag, 10);
  if (!Number.isFinite(days) || days < 1) {
    printError(
      ctx.io,
      `retention set: invalid --days '${daysFlag}' (must be an integer >= 1)`,
    );
    return 2;
  }

  const enabledFlag = getStringFlag(command, "enabled");
  let enabled = true;
  if (enabledFlag !== null) {
    if (enabledFlag === "true") {
      enabled = true;
    } else if (enabledFlag === "false") {
      enabled = false;
    } else {
      printError(
        ctx.io,
        `retention set: invalid --enabled '${enabledFlag}' (expected 'true' or 'false')`,
      );
      return 2;
    }
  }

  let policy: TenantRetentionPolicyRow;
  try {
    policy = await retention.setTenantRetention({
      tenantId,
      tableName,
      retentionDays: days,
      enabled,
    });
  } catch (err) {
    printError(
      ctx.io,
      `retention set: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (command.format === "json") {
    printJson(ctx.io, { action: "set", policy });
    return 0;
  }
  ctx.io.stdout.write(formatPolicyChange("retention set", policy));
  return 0;
}
