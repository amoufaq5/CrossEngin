import { readFile } from "node:fs/promises";

import {
  createNodePgConnection,
  effectiveRetentionKey,
  isOptOutHistoryEventKind,
  labelForIndex,
  parsePgEnvConfig,
  PostgresTraceRetention,
  type DiffHistoryEntriesResult,
  type DiffHistoryTimelineCrossTableResult,
  type DiffHistoryTimelineNwayResult,
  type DiffHistoryTimelineResult,
  type DiffTenantPoliciesNwayResult,
  type DiffTenantPoliciesResult,
  type DiffTenantTablesNwayResult,
  type DiffTenantTablesResult,
  type DiffTenantVsPlatformResult,
  type EffectiveRetentionResolution,
  type ExpiringOptOut,
  type OptOutHistoryEntry,
  type OptOutHistoryEventKind,
  type PgConnection,
  type RestoreTenantPolicyPreview,
  type RestoreTenantPolicyResult,
  type RetentionPolicyRow,
  type RetentionPreviewResult,
  type RetentionRunResult,
  type TenantRetentionPolicyRow,
} from "@crossengin/kernel-pg";

import type { ParsedCommand } from "./cli.js";
import { getBooleanFlag, getMultiFlag, getStringFlag } from "./cli.js";
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
      "retention: missing action. usage: crossengin retention <expiring|effective|effective-batch|opt-out|opt-in|set|delete|list-policies|history|restore|diff-history|diff-timeline|diff|prune> [args]",
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
      case "effective-batch":
        return await runRetentionEffectiveBatch(
          command,
          ctx,
          handle.retention,
        );
      case "opt-out":
        return await runRetentionOptOut(command, ctx, handle.retention);
      case "opt-in":
        return await runRetentionOptIn(command, ctx, handle.retention);
      case "set":
        return await runRetentionSet(command, ctx, handle.retention);
      case "delete":
        return await runRetentionDelete(command, ctx, handle.retention);
      case "list-policies":
        return await runRetentionListPolicies(command, ctx, handle.retention);
      case "history":
        return await runRetentionHistory(command, ctx, handle.retention);
      case "restore":
        return await runRetentionRestore(command, ctx, handle.retention);
      case "diff-history":
        return await runRetentionDiffHistory(command, ctx, handle.retention);
      case "diff-timeline":
        return await runRetentionDiffTimeline(command, ctx, handle.retention);
      case "diff":
        return await runRetentionDiff(command, ctx, handle.retention);
      case "prune":
        return await runRetentionPrune(command, ctx, handle.retention);
      default:
        printError(
          ctx.io,
          `retention: unknown action '${action}'. expected one of: expiring, effective, effective-batch, opt-out, opt-in, set, delete, list-policies, history, restore, diff-history, diff-timeline, diff, prune`,
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

interface EffectiveBatchPairInput {
  readonly tenantId: string;
  readonly tableName: string;
}

interface EffectiveBatchResultEntry {
  readonly tenantId: string;
  readonly tableName: string;
  readonly resolution: EffectiveRetentionResolution;
}

async function runRetentionEffectiveBatch(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
): Promise<number> {
  const pairsFile = getStringFlag(command, "pairs-file");
  if (pairsFile === null) {
    printError(
      ctx.io,
      "retention effective-batch: missing --pairs-file. usage: crossengin retention effective-batch --pairs-file <path>",
    );
    return 2;
  }

  let raw: string;
  try {
    raw = await readFile(pairsFile, "utf8");
  } catch (err) {
    printError(
      ctx.io,
      `retention effective-batch: failed to read '${pairsFile}': ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    printError(
      ctx.io,
      `retention effective-batch: '${pairsFile}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }

  const validation = validateBatchPairs(parsedJson);
  if (!validation.ok) {
    printError(
      ctx.io,
      `retention effective-batch: '${pairsFile}' ${validation.error}`,
    );
    return 2;
  }
  const pairs = validation.pairs;

  let resolutionMap: ReadonlyMap<string, EffectiveRetentionResolution>;
  try {
    resolutionMap = await retention.effectiveRetentionBatch({ pairs });
  } catch (err) {
    printError(
      ctx.io,
      `retention effective-batch: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const results: EffectiveBatchResultEntry[] = pairs.map((p) => {
    const resolution = resolutionMap.get(
      effectiveRetentionKey(p.tenantId, p.tableName),
    );
    if (resolution === undefined) {
      throw new Error(
        `retention effective-batch: resolver returned no entry for ${p.tenantId}:${p.tableName}`,
      );
    }
    return { tenantId: p.tenantId, tableName: p.tableName, resolution };
  });

  if (command.format === "json") {
    printJson(ctx.io, {
      action: "effective-batch",
      count: results.length,
      results,
    });
    return 0;
  }
  ctx.io.stdout.write(formatEffectiveBatch(results));
  return 0;
}

interface BatchPairsValidation {
  ok: true;
  pairs: EffectiveBatchPairInput[];
}
interface BatchPairsValidationFail {
  ok: false;
  error: string;
}

function validateBatchPairs(
  raw: unknown,
): BatchPairsValidation | BatchPairsValidationFail {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "must be a JSON array of {tenantId, tableName} objects" };
  }
  const pairs: EffectiveBatchPairInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "object" || entry === null) {
      return {
        ok: false,
        error: `entry at index ${i} is not an object`,
      };
    }
    const obj = entry as Record<string, unknown>;
    const tenantId = obj.tenantId;
    const tableName = obj.tableName;
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      return {
        ok: false,
        error: `entry at index ${i} missing or empty tenantId (string)`,
      };
    }
    if (typeof tableName !== "string" || tableName.length === 0) {
      return {
        ok: false,
        error: `entry at index ${i} missing or empty tableName (string)`,
      };
    }
    pairs.push({ tenantId, tableName });
  }
  return { ok: true, pairs };
}

export function formatEffectiveBatch(
  results: ReadonlyArray<EffectiveBatchResultEntry>,
): string {
  if (results.length === 0) {
    return "Effective retention for 0 pair(s): (empty input)\n";
  }
  const lines: string[] = [];
  lines.push(`Effective retention for ${results.length} pair(s):`);
  for (const entry of results) {
    lines.push(
      `  ${entry.tenantId}  ${entry.tableName.padEnd(20)} ${summarizeBatchResolution(entry.resolution)}`,
    );
  }
  return lines.join("\n") + "\n";
}

function summarizeBatchResolution(
  resolution: EffectiveRetentionResolution,
): string {
  switch (resolution.source) {
    case "tenant":
      return `source=tenant         retention=${resolution.retentionDays}d  enabled=yes`;
    case "tenant_opt_out": {
      const until = resolution.optOutUntil ?? "indefinite";
      const reason = resolution.optOutReason ?? "<no reason>";
      return `source=tenant_opt_out  reason=${reason}  until=${until}`;
    }
    case "platform":
      return `source=platform       retention=${resolution.retentionDays}d  enabled=${resolution.enabled ? "yes" : "no"}`;
    case "none":
      return `source=none           (no policy configured)`;
  }
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

  const actorId = getStringFlag(command, "actor");
  const attributesResult = parseAttributesFlag(command);
  if (!attributesResult.ok) {
    printError(ctx.io, `retention opt-out: ${attributesResult.error}`);
    return 2;
  }

  let policy: TenantRetentionPolicyRow;
  try {
    policy = await retention.setTenantOptOut({
      tenantId,
      tableName,
      retentionDays,
      optOutUntil,
      optOutReason,
      actorId,
      attributes: attributesResult.attributes,
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

  const actorId = getStringFlag(command, "actor");
  const attributesResult = parseAttributesFlag(command);
  if (!attributesResult.ok) {
    printError(ctx.io, `retention opt-in: ${attributesResult.error}`);
    return 2;
  }

  let policy: TenantRetentionPolicyRow | null;
  try {
    policy = await retention.clearTenantOptOut({
      tenantId,
      tableName,
      actorId,
      attributes: attributesResult.attributes,
    });
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

  const actorId = getStringFlag(command, "actor");
  const attributesResult = parseAttributesFlag(command);
  if (!attributesResult.ok) {
    printError(ctx.io, `retention set: ${attributesResult.error}`);
    return 2;
  }

  let policy: TenantRetentionPolicyRow;
  try {
    policy = await retention.setTenantRetention({
      tenantId,
      tableName,
      retentionDays: days,
      enabled,
      actorId,
      attributes: attributesResult.attributes,
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

async function runRetentionHistory(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
): Promise<number> {
  const tenantFilter = getStringFlag(command, "tenant");
  const tableFilter = getStringFlag(command, "table");
  const kindFlag = getStringFlag(command, "kind");
  const sinceFlag = getStringFlag(command, "since");
  const untilFlag = getStringFlag(command, "until");
  const limitFlag = getStringFlag(command, "limit");
  const afterIdFlag = getStringFlag(command, "after-id");
  const beforeIdFlag = getStringFlag(command, "before-id");
  const rangeFlag = getStringFlag(command, "range");
  const actorIdsFlags = getMultiFlag(command, "actor-id");
  const actorIds: ReadonlyArray<string> | undefined =
    actorIdsFlags.length > 0 ? actorIdsFlags : undefined;
  const actorIdsNotFlags = getMultiFlag(command, "actor-id-not");
  const actorIdsNot: ReadonlyArray<string> | undefined =
    actorIdsNotFlags.length > 0 ? actorIdsNotFlags : undefined;
  const systemOnlyFlag = getBooleanFlag(command, "system-only");
  const noSystemFlag = getBooleanFlag(command, "no-system");
  const withActorNames = getBooleanFlag(command, "with-actor-names");

  if (systemOnlyFlag && noSystemFlag) {
    printError(
      ctx.io,
      "retention history: --system-only and --no-system are mutually exclusive",
    );
    return 2;
  }
  const actorPresence:
    | "system_only"
    | "no_system"
    | undefined = systemOnlyFlag
    ? "system_only"
    : noSystemFlag
      ? "no_system"
      : undefined;

  let kind: OptOutHistoryEventKind | undefined;
  if (kindFlag !== null) {
    if (!isOptOutHistoryEventKind(kindFlag)) {
      printError(
        ctx.io,
        `retention history: invalid --kind '${kindFlag}' (expected one of: opt_out_set, opt_out_cleared, retention_set, policy_deleted)`,
      );
      return 2;
    }
    kind = kindFlag;
  }

  let effectiveAfterId: string | undefined =
    afterIdFlag !== null ? afterIdFlag : undefined;
  let effectiveBeforeId: string | undefined =
    beforeIdFlag !== null ? beforeIdFlag : undefined;

  if (rangeFlag !== null) {
    if (afterIdFlag !== null || beforeIdFlag !== null) {
      printError(
        ctx.io,
        "retention history: --range cannot be combined with --after-id or --before-id",
      );
      return 2;
    }
    const parts = rangeFlag.split("..");
    if (
      parts.length !== 2 ||
      parts[0] === undefined ||
      parts[0].length === 0 ||
      parts[1] === undefined ||
      parts[1].length === 0
    ) {
      printError(
        ctx.io,
        `retention history: invalid --range '${rangeFlag}' (expected <after-id>..<before-id>)`,
      );
      return 2;
    }
    effectiveAfterId = parts[0];
    effectiveBeforeId = parts[1];
  } else if (afterIdFlag !== null && beforeIdFlag !== null) {
    printError(
      ctx.io,
      "retention history: --after-id and --before-id are mutually exclusive (use --range <after-id>..<before-id> for window cursor)",
    );
    return 2;
  }

  let since: string | undefined;
  if (sinceFlag !== null) {
    const ms = Date.parse(sinceFlag);
    if (!Number.isFinite(ms)) {
      printError(
        ctx.io,
        `retention history: invalid --since '${sinceFlag}' (must be an ISO 8601 timestamp)`,
      );
      return 2;
    }
    since = new Date(ms).toISOString();
  }

  let until: string | undefined;
  if (untilFlag !== null) {
    const ms = Date.parse(untilFlag);
    if (!Number.isFinite(ms)) {
      printError(
        ctx.io,
        `retention history: invalid --until '${untilFlag}' (must be an ISO 8601 timestamp)`,
      );
      return 2;
    }
    until = new Date(ms).toISOString();
  }

  let limit = 100;
  if (limitFlag !== null) {
    const parsed = Number.parseInt(limitFlag, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      printError(
        ctx.io,
        `retention history: invalid --limit '${limitFlag}' (must be an integer >= 1)`,
      );
      return 2;
    }
    limit = parsed;
  }

  let entries: ReadonlyArray<OptOutHistoryEntry>;
  try {
    entries = await retention.listOptOutHistory({
      tenantId: tenantFilter ?? undefined,
      tableName: tableFilter ?? undefined,
      eventKind: kind,
      actorIds,
      actorIdsNot,
      actorPresence,
      since,
      until,
      limit,
      afterId: effectiveAfterId,
      beforeId: effectiveBeforeId,
      joinActor: withActorNames || undefined,
    });
  } catch (err) {
    printError(
      ctx.io,
      `retention history: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const nextAfterId =
    entries.length === limit ? (entries[entries.length - 1]?.id ?? null) : null;
  const nextBeforeId =
    entries.length === limit ? (entries[0]?.id ?? null) : null;

  if (command.format === "json") {
    printJson(ctx.io, {
      tenantFilter: tenantFilter ?? null,
      tableFilter: tableFilter ?? null,
      eventKind: kind ?? null,
      actorIds: actorIds ?? null,
      actorIdsNot: actorIdsNot ?? null,
      systemOnly: systemOnlyFlag,
      noSystem: noSystemFlag,
      since: since ?? null,
      until: until ?? null,
      afterId: effectiveAfterId ?? null,
      beforeId: effectiveBeforeId ?? null,
      range: rangeFlag ?? null,
      limit,
      count: entries.length,
      entries,
      nextAfterId,
      nextBeforeId,
    });
    return 0;
  }

  if (entries.length === 0) {
    printSuccess(ctx.io, "no history entries match the given filters");
    return 0;
  }

  ctx.io.stdout.write(
    formatHistoryList(entries, limit, nextAfterId, nextBeforeId),
  );
  return 0;
}

export function formatHistoryList(
  entries: ReadonlyArray<OptOutHistoryEntry>,
  limit: number,
  nextAfterId?: string | null,
  nextBeforeId?: string | null,
): string {
  const lines: string[] = [];
  lines.push(
    `Retention history (${entries.length} entries, limit ${limit}):`,
  );
  for (const e of entries) {
    lines.push(
      `  ${e.occurredAt}  ${e.eventKind.padEnd(16)} tenant=${e.tenantId}  table=${e.tableName}  actor=${formatActor(e)}`,
    );
  }
  if (nextAfterId !== undefined && nextAfterId !== null) {
    lines.push("");
    lines.push(
      `Page full — next page: crossengin retention history --after-id ${nextAfterId} ...`,
    );
  }
  if (nextBeforeId !== undefined && nextBeforeId !== null) {
    lines.push("");
    lines.push(
      `Page full — previous page: crossengin retention history --before-id ${nextBeforeId} ...`,
    );
  }
  return lines.join("\n") + "\n";
}

function formatActor(e: {
  readonly actorId: string | null;
  readonly actorDisplayName?: string | null;
  readonly actorEmail?: string | null;
}): string {
  if (e.actorId === null) return "<system>";
  const name = e.actorDisplayName ?? e.actorEmail;
  if (name === undefined || name === null) return e.actorId;
  return `${name} (${e.actorId})`;
}

async function runRetentionDelete(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
): Promise<number> {
  const tenantId = command.positional[1];
  const tableName = command.positional[2];
  if (tenantId === undefined || tableName === undefined) {
    printError(
      ctx.io,
      "retention delete: missing arguments. usage: crossengin retention delete <tenant-id> <table-name>",
    );
    return 2;
  }

  const actorId = getStringFlag(command, "actor");
  const attributesResult = parseAttributesFlag(command);
  if (!attributesResult.ok) {
    printError(ctx.io, `retention delete: ${attributesResult.error}`);
    return 2;
  }

  let deleted: boolean;
  try {
    deleted = await retention.deleteTenantPolicy({
      tenantId,
      tableName,
      actorId,
      attributes: attributesResult.attributes,
    });
  } catch (err) {
    printError(
      ctx.io,
      `retention delete: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (command.format === "json") {
    printJson(ctx.io, {
      action: "delete",
      deleted,
      tenantId,
      tableName,
    });
    return 0;
  }
  if (deleted) {
    printSuccess(
      ctx.io,
      `deleted per-tenant policy: ${tenantId} / ${tableName}`,
    );
  } else {
    printSuccess(
      ctx.io,
      `no per-tenant policy for tenant ${tenantId} on ${tableName} (idempotent no-op)`,
    );
  }
  return 0;
}

async function runRetentionRestore(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
): Promise<number> {
  const historyId = command.positional[1];
  if (historyId === undefined) {
    printError(
      ctx.io,
      "retention restore: missing argument. usage: crossengin retention restore <history-id> [--dry-run] [--actor <uuid>]",
    );
    return 2;
  }
  const dryRun = getBooleanFlag(command, "dry-run");

  if (dryRun) {
    let preview: RestoreTenantPolicyPreview;
    try {
      preview = await retention.previewRestoreTenantPolicy({ historyId });
    } catch (err) {
      printError(
        ctx.io,
        `retention restore: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
    if (command.format === "json") {
      printJson(ctx.io, {
        action: "restore",
        dryRun: true,
        historyId,
        preview,
      });
      return 0;
    }
    ctx.io.stdout.write(formatRestorePreview(preview));
    return 0;
  }

  const actorId = getStringFlag(command, "actor");
  const attributesResult = parseAttributesFlag(command);
  if (!attributesResult.ok) {
    printError(ctx.io, `retention restore: ${attributesResult.error}`);
    return 2;
  }

  let result: RestoreTenantPolicyResult;
  try {
    result = await retention.restoreTenantPolicy({
      historyId,
      actorId,
      attributes: attributesResult.attributes,
    });
  } catch (err) {
    printError(
      ctx.io,
      `retention restore: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (command.format === "json") {
    printJson(ctx.io, { action: "restore", dryRun: false, historyId, result });
    return 0;
  }
  if (result.kind === "deleted") {
    printSuccess(
      ctx.io,
      `restored from ${historyId}: policy deleted (prev_state was null) — tenant ${result.tenantId} / ${result.tableName}`,
    );
    return 0;
  }
  ctx.io.stdout.write(formatPolicyChange("restored", result.policy));
  return 0;
}

export function formatRestorePreview(
  preview: RestoreTenantPolicyPreview,
): string {
  const lines: string[] = [];
  lines.push("Restore preview (no changes applied):");
  lines.push(`  Source history: ${preview.sourceHistoryId}`);
  lines.push(`  Tenant:         ${preview.tenantId}`);
  lines.push(`  Table:          ${preview.tableName}`);
  switch (preview.kind) {
    case "would_delete":
      lines.push(`  Action:         deleteTenantPolicy (prev_state was null)`);
      break;
    case "would_set_opt_out":
      lines.push(`  Action:         setTenantOptOut`);
      lines.push(`    retention_days: ${preview.retentionDays}`);
      lines.push(`    opt_out_until:  ${preview.optOutUntil ?? "indefinite"}`);
      lines.push(
        `    opt_out_reason: ${preview.optOutReason ?? "<no reason>"}`,
      );
      break;
    case "would_set_retention":
      lines.push(`  Action:         setTenantRetention`);
      lines.push(`    retention_days: ${preview.retentionDays}`);
      lines.push(`    enabled:        ${preview.enabled ? "yes" : "no"}`);
      break;
  }
  return lines.join("\n") + "\n";
}

async function runRetentionDiffHistory(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
): Promise<number> {
  const idA = command.positional[1];
  const idB = command.positional[2];
  if (idA === undefined || idB === undefined) {
    printError(
      ctx.io,
      "retention diff-history: missing arguments. usage: crossengin retention diff-history <history-id-a> <history-id-b>",
    );
    return 2;
  }

  const kindFlags = getMultiFlag(command, "kind");
  const validatedKinds: OptOutHistoryEventKind[] = [];
  for (const kindFlag of kindFlags) {
    if (!isOptOutHistoryEventKind(kindFlag)) {
      printError(
        ctx.io,
        `retention diff-history: invalid --kind '${kindFlag}' (expected one of: opt_out_set, opt_out_cleared, retention_set, policy_deleted)`,
      );
      return 2;
    }
    validatedKinds.push(kindFlag);
  }
  const eventKinds: ReadonlyArray<OptOutHistoryEventKind> | undefined =
    validatedKinds.length > 0 ? validatedKinds : undefined;

  const kindAFlags = getMultiFlag(command, "kind-a");
  const validatedKindsA: OptOutHistoryEventKind[] = [];
  for (const kindAFlag of kindAFlags) {
    if (!isOptOutHistoryEventKind(kindAFlag)) {
      printError(
        ctx.io,
        `retention diff-history: invalid --kind-a '${kindAFlag}' (expected one of: opt_out_set, opt_out_cleared, retention_set, policy_deleted)`,
      );
      return 2;
    }
    validatedKindsA.push(kindAFlag);
  }
  const eventKindsA: ReadonlyArray<OptOutHistoryEventKind> | undefined =
    validatedKindsA.length > 0 ? validatedKindsA : undefined;

  const kindBFlags = getMultiFlag(command, "kind-b");
  const validatedKindsB: OptOutHistoryEventKind[] = [];
  for (const kindBFlag of kindBFlags) {
    if (!isOptOutHistoryEventKind(kindBFlag)) {
      printError(
        ctx.io,
        `retention diff-history: invalid --kind-b '${kindBFlag}' (expected one of: opt_out_set, opt_out_cleared, retention_set, policy_deleted)`,
      );
      return 2;
    }
    validatedKindsB.push(kindBFlag);
  }
  const eventKindsB: ReadonlyArray<OptOutHistoryEventKind> | undefined =
    validatedKindsB.length > 0 ? validatedKindsB : undefined;

  const kindNotFlags = getMultiFlag(command, "kind-not");
  const validatedKindsNot: OptOutHistoryEventKind[] = [];
  for (const kindNotFlag of kindNotFlags) {
    if (!isOptOutHistoryEventKind(kindNotFlag)) {
      printError(
        ctx.io,
        `retention diff-history: invalid --kind-not '${kindNotFlag}' (expected one of: opt_out_set, opt_out_cleared, retention_set, policy_deleted)`,
      );
      return 2;
    }
    validatedKindsNot.push(kindNotFlag);
  }
  const eventKindsNot: ReadonlyArray<OptOutHistoryEventKind> | undefined =
    validatedKindsNot.length > 0 ? validatedKindsNot : undefined;

  const kindNotAFlags = getMultiFlag(command, "kind-not-a");
  const validatedKindsNotA: OptOutHistoryEventKind[] = [];
  for (const kindNotAFlag of kindNotAFlags) {
    if (!isOptOutHistoryEventKind(kindNotAFlag)) {
      printError(
        ctx.io,
        `retention diff-history: invalid --kind-not-a '${kindNotAFlag}' (expected one of: opt_out_set, opt_out_cleared, retention_set, policy_deleted)`,
      );
      return 2;
    }
    validatedKindsNotA.push(kindNotAFlag);
  }
  const eventKindsNotA: ReadonlyArray<OptOutHistoryEventKind> | undefined =
    validatedKindsNotA.length > 0 ? validatedKindsNotA : undefined;

  const kindNotBFlags = getMultiFlag(command, "kind-not-b");
  const validatedKindsNotB: OptOutHistoryEventKind[] = [];
  for (const kindNotBFlag of kindNotBFlags) {
    if (!isOptOutHistoryEventKind(kindNotBFlag)) {
      printError(
        ctx.io,
        `retention diff-history: invalid --kind-not-b '${kindNotBFlag}' (expected one of: opt_out_set, opt_out_cleared, retention_set, policy_deleted)`,
      );
      return 2;
    }
    validatedKindsNotB.push(kindNotBFlag);
  }
  const eventKindsNotB: ReadonlyArray<OptOutHistoryEventKind> | undefined =
    validatedKindsNotB.length > 0 ? validatedKindsNotB : undefined;

  const actorIdFlags = getMultiFlag(command, "actor-id");
  const actorIds: ReadonlyArray<string> | undefined =
    actorIdFlags.length > 0 ? actorIdFlags : undefined;
  const actorIdAFlags = getMultiFlag(command, "actor-id-a");
  const actorIdsA: ReadonlyArray<string> | undefined =
    actorIdAFlags.length > 0 ? actorIdAFlags : undefined;
  const actorIdBFlags = getMultiFlag(command, "actor-id-b");
  const actorIdsB: ReadonlyArray<string> | undefined =
    actorIdBFlags.length > 0 ? actorIdBFlags : undefined;
  const actorIdNotFlags = getMultiFlag(command, "actor-id-not");
  const actorIdsNot: ReadonlyArray<string> | undefined =
    actorIdNotFlags.length > 0 ? actorIdNotFlags : undefined;
  const actorIdNotAFlags = getMultiFlag(command, "actor-id-not-a");
  const actorIdsNotA: ReadonlyArray<string> | undefined =
    actorIdNotAFlags.length > 0 ? actorIdNotAFlags : undefined;
  const actorIdNotBFlags = getMultiFlag(command, "actor-id-not-b");
  const actorIdsNotB: ReadonlyArray<string> | undefined =
    actorIdNotBFlags.length > 0 ? actorIdNotBFlags : undefined;
  const systemOnlyFlag = getBooleanFlag(command, "system-only");
  const noSystemFlag = getBooleanFlag(command, "no-system");
  const systemOnlyAFlag = getBooleanFlag(command, "system-only-a");
  const noSystemAFlag = getBooleanFlag(command, "no-system-a");
  const systemOnlyBFlag = getBooleanFlag(command, "system-only-b");
  const noSystemBFlag = getBooleanFlag(command, "no-system-b");
  const withActorNames = getBooleanFlag(command, "with-actor-names");

  if (systemOnlyFlag && noSystemFlag) {
    printError(
      ctx.io,
      "retention diff-history: --system-only and --no-system are mutually exclusive",
    );
    return 2;
  }
  if (systemOnlyAFlag && noSystemAFlag) {
    printError(
      ctx.io,
      "retention diff-history: --system-only-a and --no-system-a are mutually exclusive",
    );
    return 2;
  }
  if (systemOnlyBFlag && noSystemBFlag) {
    printError(
      ctx.io,
      "retention diff-history: --system-only-b and --no-system-b are mutually exclusive",
    );
    return 2;
  }
  const actorPresence:
    | "system_only"
    | "no_system"
    | undefined = systemOnlyFlag
    ? "system_only"
    : noSystemFlag
      ? "no_system"
      : undefined;
  const actorPresenceA:
    | "system_only"
    | "no_system"
    | undefined = systemOnlyAFlag
    ? "system_only"
    : noSystemAFlag
      ? "no_system"
      : undefined;
  const actorPresenceB:
    | "system_only"
    | "no_system"
    | undefined = systemOnlyBFlag
    ? "system_only"
    : noSystemBFlag
      ? "no_system"
      : undefined;

  let result: DiffHistoryEntriesResult;
  try {
    result = await retention.diffHistoryEntries({
      idA,
      idB,
      eventKinds,
      eventKindsA,
      eventKindsB,
      eventKindsNot,
      eventKindsNotA,
      eventKindsNotB,
      actorIds,
      actorIdsA,
      actorIdsB,
      actorIdsNot,
      actorIdsNotA,
      actorIdsNotB,
      actorPresence,
      actorPresenceA,
      actorPresenceB,
      joinActor: withActorNames ? true : undefined,
    });
  } catch (err) {
    printError(
      ctx.io,
      `retention diff-history: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (command.format === "json") {
    printJson(ctx.io, {
      action: "diff-history",
      kinds: eventKinds ?? null,
      kindsA: eventKindsA ?? null,
      kindsB: eventKindsB ?? null,
      kindsNot: eventKindsNot ?? null,
      kindsNotA: eventKindsNotA ?? null,
      kindsNotB: eventKindsNotB ?? null,
      actorIds: actorIds ?? null,
      actorIdsA: actorIdsA ?? null,
      actorIdsB: actorIdsB ?? null,
      actorIdsNot: actorIdsNot ?? null,
      actorIdsNotA: actorIdsNotA ?? null,
      actorIdsNotB: actorIdsNotB ?? null,
      systemOnly: systemOnlyFlag,
      noSystem: noSystemFlag,
      systemOnlyA: systemOnlyAFlag,
      noSystemA: noSystemAFlag,
      systemOnlyB: systemOnlyBFlag,
      noSystemB: noSystemBFlag,
      withActorNames,
      result,
    });
    return 0;
  }
  ctx.io.stdout.write(formatHistoryDiff(result, { withActorNames }));
  return 0;
}

export function formatHistoryDiff(
  result: DiffHistoryEntriesResult,
  opts: { readonly withActorNames?: boolean } = {},
): string {
  const lines: string[] = [];
  lines.push("Diff between history events:");
  const actorSuffixA = opts.withActorNames
    ? ` by ${formatActor({
        actorId: result.actorIdA,
        actorDisplayName: result.actorDisplayNameA,
        actorEmail: result.actorEmailA,
      })}`
    : "";
  const actorSuffixB = opts.withActorNames
    ? ` by ${formatActor({
        actorId: result.actorIdB,
        actorDisplayName: result.actorDisplayNameB,
        actorEmail: result.actorEmailB,
      })}`
    : "";
  lines.push(
    `  A: ${result.idA} at ${result.occurredAtA} (event_kind=${result.eventKindA})${actorSuffixA}`,
  );
  lines.push(
    `  B: ${result.idB} at ${result.occurredAtB} (event_kind=${result.eventKindB})${actorSuffixB}`,
  );
  lines.push(`  Tenant: ${result.tenantId}`);
  lines.push(`  Table:  ${result.tableName}`);
  lines.push("");
  if (result.fieldDiffs.length === 0) {
    lines.push(
      "No differences between the two events' policy states.",
    );
  } else {
    lines.push(`Field changes (${result.fieldDiffs.length}):`);
    for (const d of result.fieldDiffs) {
      const a = d.valueA === undefined ? "absent" : JSON.stringify(d.valueA);
      const b = d.valueB === undefined ? "absent" : JSON.stringify(d.valueB);
      lines.push(`  ${d.field.padEnd(20)} ${a}  →  ${b}`);
    }
  }
  return lines.join("\n") + "\n";
}

async function runRetentionPrune(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
): Promise<number> {
  const dryRun = getBooleanFlag(command, "dry-run");

  if (dryRun) {
    let results: ReadonlyArray<RetentionPreviewResult>;
    try {
      results = await retention.previewPrune();
    } catch (err) {
      printError(
        ctx.io,
        `retention prune: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
    if (command.format === "json") {
      printJson(ctx.io, { action: "prune", dryRun: true, results });
      return 0;
    }
    ctx.io.stdout.write(formatPrunePreview(results));
    return 0;
  }

  let results: ReadonlyArray<RetentionRunResult>;
  try {
    results = await retention.prune();
  } catch (err) {
    printError(
      ctx.io,
      `retention prune: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  if (command.format === "json") {
    printJson(ctx.io, { action: "prune", dryRun: false, results });
    return 0;
  }
  ctx.io.stdout.write(formatPruneRun(results));
  return 0;
}

export function formatPruneRun(
  results: ReadonlyArray<RetentionRunResult>,
): string {
  if (results.length === 0) {
    return "no retention policies configured\n";
  }
  const lines: string[] = [];
  lines.push(`Retention prune results (${results.length} entries):`);
  for (const r of results) {
    lines.push(`  ${formatPruneResultLine(r, "deleted", r.deletedCount)}`);
  }
  lines.push("");
  lines.push(formatPruneSummary(results, "deleted"));
  return lines.join("\n") + "\n";
}

export function formatPrunePreview(
  results: ReadonlyArray<RetentionPreviewResult>,
): string {
  if (results.length === 0) {
    return "no retention policies configured (dry-run)\n";
  }
  const lines: string[] = [];
  lines.push(
    `Retention prune dry-run results (${results.length} entries):`,
  );
  for (const r of results) {
    lines.push(
      `  ${formatPruneResultLine(r, "would_delete", r.wouldDeleteCount)}`,
    );
  }
  lines.push("");
  lines.push(formatPruneSummary(results, "would_delete"));
  return lines.join("\n") + "\n";
}

interface PruneResultLike {
  readonly tableName: string;
  readonly tenantId?: string;
  readonly status: string;
  readonly retentionDays: number;
  readonly cutoffMs: number | null;
  readonly optOutReason?: string | null;
  readonly optOutUntil?: string | null;
}

function formatPruneResultLine(
  r: PruneResultLike,
  countLabel: string,
  count: number,
): string {
  const tenant = r.tenantId !== undefined ? `tenant=${r.tenantId}` : "(platform)";
  const isCountedStatus =
    r.status === "pruned" || r.status === "previewed";
  const countPart = isCountedStatus ? `${countLabel}=${count}` : "-";
  const cutoffPart =
    r.cutoffMs === null
      ? "-"
      : `cutoff=${new Date(r.cutoffMs).toISOString()}`;
  let extra = "";
  if (r.status === "skipped_opt_out" || r.status === "skipped_opt_out_expired") {
    const reason = r.optOutReason ?? "<no reason>";
    const until = r.optOutUntil ?? "indefinite";
    const expiredMark =
      r.status === "skipped_opt_out_expired" ? " (EXPIRED)" : "";
    extra = `  reason=${reason}  until=${until}${expiredMark}`;
  }
  return `${r.status.padEnd(24)} ${r.tableName.padEnd(36)} ${tenant.padEnd(48)} ${countPart.padEnd(20)} retention=${r.retentionDays}d  ${cutoffPart}${extra}`;
}

function formatPruneSummary(
  results: ReadonlyArray<PruneResultLike & { deletedCount?: number; wouldDeleteCount?: number }>,
  countLabel: string,
): string {
  const verb = countLabel === "deleted" ? "pruned" : "would prune";
  let prunedCount = 0;
  let totalRows = 0;
  const skippedByStatus: Record<string, number> = {};
  for (const r of results) {
    if (r.status === "pruned" || r.status === "previewed") {
      prunedCount += 1;
      totalRows +=
        countLabel === "deleted"
          ? (r as RetentionRunResult).deletedCount
          : (r as RetentionPreviewResult).wouldDeleteCount;
    } else {
      skippedByStatus[r.status] = (skippedByStatus[r.status] ?? 0) + 1;
    }
  }
  const skippedParts = Object.entries(skippedByStatus)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, n]) => `${n} ${status}`);
  const totalSkipped = Object.values(skippedByStatus).reduce(
    (acc, n) => acc + n,
    0,
  );
  const skippedSuffix =
    totalSkipped > 0
      ? `, ${totalSkipped} skipped (${skippedParts.join(", ")})`
      : "";
  return `Summary: ${prunedCount} ${verb} (${totalRows} rows)${skippedSuffix}`;
}

async function runRetentionDiffTimeline(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
): Promise<number> {
  const crossTable = getBooleanFlag(command, "cross-table");
  const addTenants = getMultiFlag(command, "add-tenant");
  const addTables = getMultiFlag(command, "add-table");
  const hasAddTenant = addTenants.length > 0;
  const hasAddTable = addTables.length > 0;

  if (hasAddTable && !crossTable) {
    printError(
      ctx.io,
      "retention diff-timeline: --add-table requires --cross-table",
    );
    return 2;
  }
  if (crossTable && hasAddTenant) {
    printError(
      ctx.io,
      "retention diff-timeline: --cross-table and --add-tenant are mutually exclusive",
    );
    return 2;
  }

  const positionalA = command.positional[1];
  const positionalB = command.positional[2];
  const positionalC = command.positional[3];
  if (
    positionalA === undefined ||
    positionalB === undefined ||
    positionalC === undefined
  ) {
    const usage = crossTable
      ? "crossengin retention diff-timeline <tenant> <table-a> <table-b> --cross-table [--add-table <table-c> ...]"
      : "crossengin retention diff-timeline <tenant-a> <tenant-b> <table-name> [--add-tenant <tenant-c> ...]";
    printError(
      ctx.io,
      `retention diff-timeline: missing arguments. usage: ${usage}`,
    );
    return 2;
  }

  const sinceFlag = getStringFlag(command, "since");
  const untilFlag = getStringFlag(command, "until");
  const limitFlag = getStringFlag(command, "limit");

  let since: string | undefined;
  if (sinceFlag !== null) {
    const ms = Date.parse(sinceFlag);
    if (!Number.isFinite(ms)) {
      printError(
        ctx.io,
        `retention diff-timeline: invalid --since '${sinceFlag}' (must be an ISO 8601 timestamp)`,
      );
      return 2;
    }
    since = new Date(ms).toISOString();
  }
  let until: string | undefined;
  if (untilFlag !== null) {
    const ms = Date.parse(untilFlag);
    if (!Number.isFinite(ms)) {
      printError(
        ctx.io,
        `retention diff-timeline: invalid --until '${untilFlag}' (must be an ISO 8601 timestamp)`,
      );
      return 2;
    }
    until = new Date(ms).toISOString();
  }
  let limit = 100;
  if (limitFlag !== null) {
    const parsed = Number.parseInt(limitFlag, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      printError(
        ctx.io,
        `retention diff-timeline: invalid --limit '${limitFlag}' (must be an integer >= 1)`,
      );
      return 2;
    }
    limit = parsed;
  }

  const withActorNames = getBooleanFlag(command, "with-actor-names");
  const actorIdFlags = getMultiFlag(command, "actor-id");
  const actorIds = actorIdFlags.length > 0 ? actorIdFlags : undefined;
  const actorIdNotFlags = getMultiFlag(command, "actor-id-not");
  const actorIdsNot =
    actorIdNotFlags.length > 0 ? actorIdNotFlags : undefined;
  const systemOnlyFlag = getBooleanFlag(command, "system-only");
  const noSystemFlag = getBooleanFlag(command, "no-system");
  if (systemOnlyFlag && noSystemFlag) {
    printError(
      ctx.io,
      "retention diff-timeline: --system-only and --no-system are mutually exclusive",
    );
    return 2;
  }
  const actorPresence:
    | "system_only"
    | "no_system"
    | undefined = systemOnlyFlag
    ? "system_only"
    : noSystemFlag
      ? "no_system"
      : undefined;

  const kindFlags = getMultiFlag(command, "kind");
  const validatedKinds: OptOutHistoryEventKind[] = [];
  for (const kindFlag of kindFlags) {
    if (!isOptOutHistoryEventKind(kindFlag)) {
      printError(
        ctx.io,
        `retention diff-timeline: invalid --kind '${kindFlag}' (expected one of: opt_out_set, opt_out_cleared, retention_set, policy_deleted)`,
      );
      return 2;
    }
    validatedKinds.push(kindFlag);
  }
  const eventKinds = validatedKinds.length > 0 ? validatedKinds : undefined;

  const afterIdFlag = getStringFlag(command, "after-id");
  const beforeIdFlag = getStringFlag(command, "before-id");
  const rangeFlag = getStringFlag(command, "range");

  let afterId: string | undefined =
    afterIdFlag !== null ? afterIdFlag : undefined;
  let beforeId: string | undefined =
    beforeIdFlag !== null ? beforeIdFlag : undefined;

  if (rangeFlag !== null) {
    if (afterIdFlag !== null || beforeIdFlag !== null) {
      printError(
        ctx.io,
        "retention diff-timeline: --range cannot be combined with --after-id or --before-id",
      );
      return 2;
    }
    const parts = rangeFlag.split("..");
    if (
      parts.length !== 2 ||
      parts[0] === undefined ||
      parts[0].length === 0 ||
      parts[1] === undefined ||
      parts[1].length === 0
    ) {
      printError(
        ctx.io,
        `retention diff-timeline: invalid --range '${rangeFlag}' (expected <after-id>..<before-id>)`,
      );
      return 2;
    }
    afterId = parts[0];
    beforeId = parts[1];
  } else if (afterIdFlag !== null && beforeIdFlag !== null) {
    printError(
      ctx.io,
      "retention diff-timeline: --after-id and --before-id are mutually exclusive (use --range <after-id>..<before-id> for window cursor)",
    );
    return 2;
  }

  if (crossTable) {
    const tenantId = positionalA;
    const tableNames = [positionalB, positionalC, ...addTables];
    let crossResult: DiffHistoryTimelineCrossTableResult;
    try {
      crossResult = await retention.diffHistoryTimelineCrossTable({
        tenantId,
        tableNames,
        since,
        until,
        limit,
        joinActor: withActorNames || undefined,
        actorIds,
        actorIdsNot,
        actorPresence,
        eventKinds,
        afterId,
        beforeId,
      });
    } catch (err) {
      printError(
        ctx.io,
        `retention diff-timeline: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }

    const nextAfterIdCross =
      crossResult.entries.length === limit
        ? (crossResult.entries[crossResult.entries.length - 1]?.id ?? null)
        : null;
    const nextBeforeIdCross =
      crossResult.entries.length === limit
        ? (crossResult.entries[0]?.id ?? null)
        : null;

    if (command.format === "json") {
      printJson(ctx.io, {
        action: "diff-timeline",
        crossTable: true,
        since: since ?? null,
        until: until ?? null,
        limit,
        withActorNames,
        actorIds: actorIds ?? null,
        actorIdsNot: actorIdsNot ?? null,
        systemOnly: systemOnlyFlag,
        noSystem: noSystemFlag,
        kinds: eventKinds ?? null,
        afterId: afterId ?? null,
        beforeId: beforeId ?? null,
        range: rangeFlag ?? null,
        nextAfterId: nextAfterIdCross,
        nextBeforeId: nextBeforeIdCross,
        result: crossResult,
      });
      return 0;
    }
    ctx.io.stdout.write(
      formatTimelineCrossTableDiff(crossResult, {
        withActorNames,
        nextAfterId: nextAfterIdCross,
        nextBeforeId: nextBeforeIdCross,
      }),
    );
    return 0;
  }

  const tenantIdA = positionalA;
  const tenantIdB = positionalB;
  const tableName = positionalC;

  if (hasAddTenant) {
    const tenantIds = [tenantIdA, tenantIdB, ...addTenants];
    let nwayResult: DiffHistoryTimelineNwayResult;
    try {
      nwayResult = await retention.diffHistoryTimelineNway({
        tenantIds,
        tableName,
        since,
        until,
        limit,
        joinActor: withActorNames || undefined,
        actorIds,
        actorIdsNot,
        actorPresence,
        eventKinds,
        afterId,
        beforeId,
      });
    } catch (err) {
      printError(
        ctx.io,
        `retention diff-timeline: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }

    const nextAfterIdNway =
      nwayResult.entries.length === limit
        ? (nwayResult.entries[nwayResult.entries.length - 1]?.id ?? null)
        : null;
    const nextBeforeIdNway =
      nwayResult.entries.length === limit
        ? (nwayResult.entries[0]?.id ?? null)
        : null;

    if (command.format === "json") {
      printJson(ctx.io, {
        action: "diff-timeline",
        nway: true,
        since: since ?? null,
        until: until ?? null,
        limit,
        withActorNames,
        actorIds: actorIds ?? null,
        actorIdsNot: actorIdsNot ?? null,
        systemOnly: systemOnlyFlag,
        noSystem: noSystemFlag,
        kinds: eventKinds ?? null,
        afterId: afterId ?? null,
        beforeId: beforeId ?? null,
        range: rangeFlag ?? null,
        nextAfterId: nextAfterIdNway,
        nextBeforeId: nextBeforeIdNway,
        result: nwayResult,
      });
      return 0;
    }
    ctx.io.stdout.write(
      formatTimelineNwayDiff(nwayResult, {
        withActorNames,
        nextAfterId: nextAfterIdNway,
        nextBeforeId: nextBeforeIdNway,
      }),
    );
    return 0;
  }

  let result: DiffHistoryTimelineResult;
  try {
    result = await retention.diffHistoryTimeline({
      tenantIdA,
      tenantIdB,
      tableName,
      since,
      until,
      limit,
      joinActor: withActorNames || undefined,
      actorIds,
      actorIdsNot,
      actorPresence,
      eventKinds,
      afterId,
      beforeId,
    });
  } catch (err) {
    printError(
      ctx.io,
      `retention diff-timeline: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const nextAfterIdPair =
    result.entries.length === limit
      ? (result.entries[result.entries.length - 1]?.id ?? null)
      : null;
  const nextBeforeIdPair =
    result.entries.length === limit
      ? (result.entries[0]?.id ?? null)
      : null;

  if (command.format === "json") {
    printJson(ctx.io, {
      action: "diff-timeline",
      since: since ?? null,
      until: until ?? null,
      limit,
      withActorNames,
      actorIds: actorIds ?? null,
      actorIdsNot: actorIdsNot ?? null,
      systemOnly: systemOnlyFlag,
      noSystem: noSystemFlag,
      kinds: eventKinds ?? null,
      afterId: afterId ?? null,
      beforeId: beforeId ?? null,
      range: rangeFlag ?? null,
      nextAfterId: nextAfterIdPair,
      nextBeforeId: nextBeforeIdPair,
      result,
    });
    return 0;
  }
  ctx.io.stdout.write(
    formatTimelineDiff(result, {
      withActorNames,
      nextAfterId: nextAfterIdPair,
      nextBeforeId: nextBeforeIdPair,
    }),
  );
  return 0;
}

export function formatTimelineDiff(
  result: DiffHistoryTimelineResult,
  opts: {
    readonly withActorNames?: boolean;
    readonly nextAfterId?: string | null;
    readonly nextBeforeId?: string | null;
  } = {},
): string {
  const lines: string[] = [];
  lines.push(`Timeline for tenants on ${result.tableName}:`);
  lines.push(`  Tenant A: ${result.tenantIdA}`);
  lines.push(`  Tenant B: ${result.tenantIdB}`);
  lines.push("");
  if (result.entries.length === 0) {
    lines.push("No history events for either tenant on this table.");
    return lines.join("\n") + "\n";
  }
  lines.push(`Events (${result.entries.length}):`);
  for (const e of result.entries) {
    const stateSummary = summarizeTimelineEntry(e);
    const actorSuffix = opts.withActorNames
      ? `  by ${formatActor(e)}`
      : "";
    lines.push(
      `  ${e.occurredAt}  [${e.tenantSide}] ${e.eventKind.padEnd(16)} ${stateSummary}${actorSuffix}`,
    );
  }
  if (opts.nextAfterId !== undefined && opts.nextAfterId !== null) {
    lines.push("");
    lines.push(
      `Page full — next page: crossengin retention diff-timeline --after-id ${opts.nextAfterId} ...`,
    );
  }
  if (opts.nextBeforeId !== undefined && opts.nextBeforeId !== null) {
    lines.push("");
    lines.push(
      `Page full — previous page: crossengin retention diff-timeline --before-id ${opts.nextBeforeId} ...`,
    );
  }
  return lines.join("\n") + "\n";
}

export function formatTimelineNwayDiff(
  result: DiffHistoryTimelineNwayResult,
  opts: {
    readonly withActorNames?: boolean;
    readonly nextAfterId?: string | null;
    readonly nextBeforeId?: string | null;
  } = {},
): string {
  const lines: string[] = [];
  lines.push(
    `N-way timeline for ${result.tenantIds.length} tenants on ${result.tableName}:`,
  );
  result.tenantIds.forEach((id, i) => {
    lines.push(`  Tenant ${labelForIndex(i)}: ${id}`);
  });
  lines.push("");
  if (result.entries.length === 0) {
    lines.push("No history events for any of these tenants on this table.");
    return lines.join("\n") + "\n";
  }
  lines.push(`Events (${result.entries.length}):`);
  for (const e of result.entries) {
    const stateSummary = summarizeTimelineEntry(e);
    const actorSuffix = opts.withActorNames
      ? `  by ${formatActor(e)}`
      : "";
    lines.push(
      `  ${e.occurredAt}  [${e.tenantLabel}] ${e.eventKind.padEnd(16)} ${stateSummary}${actorSuffix}`,
    );
  }
  if (opts.nextAfterId !== undefined && opts.nextAfterId !== null) {
    lines.push("");
    lines.push(
      `Page full — next page: crossengin retention diff-timeline --after-id ${opts.nextAfterId} ...`,
    );
  }
  if (opts.nextBeforeId !== undefined && opts.nextBeforeId !== null) {
    lines.push("");
    lines.push(
      `Page full — previous page: crossengin retention diff-timeline --before-id ${opts.nextBeforeId} ...`,
    );
  }
  return lines.join("\n") + "\n";
}

export function formatTimelineCrossTableDiff(
  result: DiffHistoryTimelineCrossTableResult,
  opts: {
    readonly withActorNames?: boolean;
    readonly nextAfterId?: string | null;
    readonly nextBeforeId?: string | null;
  } = {},
): string {
  const lines: string[] = [];
  lines.push(
    `Cross-table timeline for tenant ${result.tenantId} across ${result.tableNames.length} tables:`,
  );
  result.tableNames.forEach((t, i) => {
    lines.push(`  Table ${labelForIndex(i)}: ${t}`);
  });
  lines.push("");
  if (result.entries.length === 0) {
    lines.push("No history events for this tenant on any of these tables.");
    return lines.join("\n") + "\n";
  }
  lines.push(`Events (${result.entries.length}):`);
  for (const e of result.entries) {
    const stateSummary = summarizeTimelineEntry(e);
    const actorSuffix = opts.withActorNames
      ? `  by ${formatActor(e)}`
      : "";
    lines.push(
      `  ${e.occurredAt}  [${e.tableLabel}] ${e.eventKind.padEnd(16)} ${stateSummary}${actorSuffix}`,
    );
  }
  if (opts.nextAfterId !== undefined && opts.nextAfterId !== null) {
    lines.push("");
    lines.push(
      `Page full — next page: crossengin retention diff-timeline --after-id ${opts.nextAfterId} ...`,
    );
  }
  if (opts.nextBeforeId !== undefined && opts.nextBeforeId !== null) {
    lines.push("");
    lines.push(
      `Page full — previous page: crossengin retention diff-timeline --before-id ${opts.nextBeforeId} ...`,
    );
  }
  return lines.join("\n") + "\n";
}

function summarizeTimelineEntry(e: {
  readonly eventKind: string;
  readonly nextState: Record<string, unknown> | null;
}): string {
  if (e.nextState === null) {
    return "(policy deleted)";
  }
  const parts: string[] = [];
  if (
    typeof e.nextState.retention_days === "number" ||
    e.nextState.retention_days === null
  ) {
    parts.push(`retention=${e.nextState.retention_days ?? "null"}`);
  }
  if (typeof e.nextState.opt_out === "boolean") {
    parts.push(`opt_out=${e.nextState.opt_out}`);
  }
  if (typeof e.nextState.enabled === "boolean") {
    parts.push(`enabled=${e.nextState.enabled}`);
  }
  if (typeof e.nextState.opt_out_reason === "string") {
    parts.push(`reason=${e.nextState.opt_out_reason}`);
  }
  return parts.join("  ");
}

async function runRetentionDiff(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
): Promise<number> {
  const thresholdError = validateThresholdFlag(command);
  if (thresholdError !== null) {
    printError(ctx.io, `retention diff: ${thresholdError}`);
    return 2;
  }

  const vsPlatform = getBooleanFlag(command, "vs-platform");
  const crossTable = getBooleanFlag(command, "cross-table");
  const addTenants = getMultiFlag(command, "add-tenant");
  const addTables = getMultiFlag(command, "add-table");
  const hasAddTenant = addTenants.length > 0;
  const hasAddTable = addTables.length > 0;

  if (hasAddTable && !crossTable) {
    printError(
      ctx.io,
      "retention diff: --add-table requires --cross-table",
    );
    return 2;
  }

  const conflicts: string[] = [];
  if (vsPlatform) conflicts.push("--vs-platform");
  if (crossTable) conflicts.push("--cross-table");
  if (hasAddTenant) conflicts.push("--add-tenant");
  if (conflicts.length > 1) {
    printError(
      ctx.io,
      `retention diff: ${conflicts.join(", ")} are mutually exclusive`,
    );
    return 2;
  }

  if (vsPlatform) {
    return await runRetentionDiffVsPlatform(command, ctx, retention);
  }
  if (crossTable) {
    if (hasAddTable) {
      return await runRetentionDiffCrossTableNway(
        command,
        ctx,
        retention,
        addTables,
      );
    }
    return await runRetentionDiffCrossTable(command, ctx, retention);
  }
  if (hasAddTenant) {
    return await runRetentionDiffNway(command, ctx, retention, addTenants);
  }

  const tenantIdA = command.positional[1];
  const tenantIdB = command.positional[2];
  const tableName = command.positional[3];
  if (
    tenantIdA === undefined ||
    tenantIdB === undefined ||
    tableName === undefined
  ) {
    printError(
      ctx.io,
      "retention diff: missing arguments. usage: crossengin retention diff <tenant-a> <tenant-b> <table-name>",
    );
    return 2;
  }

  let result: DiffTenantPoliciesResult;
  try {
    result = await retention.diffTenantPolicies({
      tenantIdA,
      tenantIdB,
      tableName,
    });
  } catch (err) {
    printError(
      ctx.io,
      `retention diff: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (command.format === "json") {
    printJson(ctx.io, { action: "diff", result });
  } else {
    ctx.io.stdout.write(formatTenantDiff(result));
  }
  return divergenceExitCode(command, result.fieldDiffs.length);
}

async function runRetentionDiffVsPlatform(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
): Promise<number> {
  const tenantId = command.positional[1];
  const tableName = command.positional[2];
  if (tenantId === undefined || tableName === undefined) {
    printError(
      ctx.io,
      "retention diff --vs-platform: missing arguments. usage: crossengin retention diff <tenant> <table-name> --vs-platform",
    );
    return 2;
  }

  let result: DiffTenantVsPlatformResult;
  try {
    result = await retention.diffTenantVsPlatform({ tenantId, tableName });
  } catch (err) {
    printError(
      ctx.io,
      `retention diff: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (command.format === "json") {
    printJson(ctx.io, { action: "diff", vsPlatform: true, result });
  } else {
    ctx.io.stdout.write(formatTenantVsPlatformDiff(result));
  }
  return divergenceExitCode(command, result.fieldDiffs.length);
}

async function runRetentionDiffCrossTable(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
): Promise<number> {
  const tenantId = command.positional[1];
  const tableNameA = command.positional[2];
  const tableNameB = command.positional[3];
  if (
    tenantId === undefined ||
    tableNameA === undefined ||
    tableNameB === undefined
  ) {
    printError(
      ctx.io,
      "retention diff --cross-table: missing arguments. usage: crossengin retention diff <tenant> <table-a> <table-b> --cross-table",
    );
    return 2;
  }

  let result: DiffTenantTablesResult;
  try {
    result = await retention.diffTenantTables({
      tenantId,
      tableNameA,
      tableNameB,
    });
  } catch (err) {
    printError(
      ctx.io,
      `retention diff: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (command.format === "json") {
    printJson(ctx.io, { action: "diff", crossTable: true, result });
  } else {
    ctx.io.stdout.write(formatTenantTablesDiff(result));
  }
  return divergenceExitCode(command, result.fieldDiffs.length);
}

async function runRetentionDiffNway(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
  addTenants: ReadonlyArray<string>,
): Promise<number> {
  const tenantIdA = command.positional[1];
  const tenantIdB = command.positional[2];
  const tableName = command.positional[3];
  if (
    tenantIdA === undefined ||
    tenantIdB === undefined ||
    tableName === undefined
  ) {
    printError(
      ctx.io,
      "retention diff --add-tenant: missing arguments. usage: crossengin retention diff <tenant-a> <tenant-b> <table-name> --add-tenant <tenant-c> [--add-tenant <tenant-d> ...]",
    );
    return 2;
  }
  const tenantIds: string[] = [tenantIdA, tenantIdB, ...addTenants];

  let result: DiffTenantPoliciesNwayResult;
  try {
    result = await retention.diffTenantPoliciesNway({ tenantIds, tableName });
  } catch (err) {
    printError(
      ctx.io,
      `retention diff: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (command.format === "json") {
    printJson(ctx.io, { action: "diff", nway: true, result });
  } else {
    ctx.io.stdout.write(formatTenantNwayDiff(result));
  }
  return divergenceExitCode(command, result.fieldVariations.length);
}

async function runRetentionDiffCrossTableNway(
  command: ParsedCommand,
  ctx: RunContext,
  retention: PostgresTraceRetention,
  addTables: ReadonlyArray<string>,
): Promise<number> {
  const tenantId = command.positional[1];
  const tableNameA = command.positional[2];
  const tableNameB = command.positional[3];
  if (
    tenantId === undefined ||
    tableNameA === undefined ||
    tableNameB === undefined
  ) {
    printError(
      ctx.io,
      "retention diff --cross-table --add-table: missing arguments. usage: crossengin retention diff <tenant> <table-a> <table-b> --cross-table --add-table <table-c> [--add-table <table-d> ...]",
    );
    return 2;
  }
  const tableNames: string[] = [tableNameA, tableNameB, ...addTables];

  let result: DiffTenantTablesNwayResult;
  try {
    result = await retention.diffTenantTablesNway({ tenantId, tableNames });
  } catch (err) {
    printError(
      ctx.io,
      `retention diff: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (command.format === "json") {
    printJson(ctx.io, {
      action: "diff",
      nway: true,
      crossTable: true,
      result,
    });
  } else {
    ctx.io.stdout.write(formatTenantTablesNwayDiff(result));
  }
  return divergenceExitCode(command, result.fieldVariations.length);
}

function divergenceExitCode(
  command: ParsedCommand,
  fieldDiffsLength: number,
): number {
  if (!getBooleanFlag(command, "exit-on-divergence")) return 0;
  const thresholdRaw = getStringFlag(command, "threshold");
  const threshold = thresholdRaw === null ? 1 : Number(thresholdRaw);
  return fieldDiffsLength >= threshold ? 3 : 0;
}

interface AttributesParseOk {
  readonly ok: true;
  readonly attributes: Record<string, unknown> | undefined;
}
interface AttributesParseFail {
  readonly ok: false;
  readonly error: string;
}

function parseAttributesFlag(
  command: ParsedCommand,
): AttributesParseOk | AttributesParseFail {
  const raw = getStringFlag(command, "attributes");
  if (raw === null) return { ok: true, attributes: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `--attributes is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return {
      ok: false,
      error: "--attributes must be a JSON object (not array, primitive, or null)",
    };
  }
  return { ok: true, attributes: parsed as Record<string, unknown> };
}

function validateThresholdFlag(command: ParsedCommand): string | null {
  const thresholdRaw = getStringFlag(command, "threshold");
  if (thresholdRaw === null) return null;
  if (!getBooleanFlag(command, "exit-on-divergence")) {
    return "--threshold requires --exit-on-divergence";
  }
  const n = Number(thresholdRaw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return `--threshold must be a positive integer, got '${thresholdRaw}'`;
  }
  return null;
}

function summarizeResolutionForDiff(
  resolution: EffectiveRetentionResolution,
): string {
  switch (resolution.source) {
    case "tenant":
      return `source=tenant         retention=${resolution.retentionDays}d  enabled=yes`;
    case "tenant_opt_out": {
      const until = resolution.optOutUntil ?? "indefinite";
      const reason = resolution.optOutReason ?? "<no reason>";
      return `source=tenant_opt_out  reason=${reason}  until=${until}`;
    }
    case "platform":
      return `source=platform       retention=${resolution.retentionDays}d  enabled=${resolution.enabled ? "yes" : "no"}`;
    case "none":
      return `source=none           (no policy configured)`;
  }
}

export function formatTenantDiff(result: DiffTenantPoliciesResult): string {
  const lines: string[] = [];
  lines.push(`Diff between tenant policies (table: ${result.tableName}):`);
  lines.push(
    `  Tenant A: ${result.tenantIdA}  ${summarizeResolutionForDiff(result.resolutionA)}`,
  );
  lines.push(
    `  Tenant B: ${result.tenantIdB}  ${summarizeResolutionForDiff(result.resolutionB)}`,
  );
  lines.push("");
  if (result.fieldDiffs.length === 0) {
    lines.push(
      "No differences — both tenants have the same effective retention policy.",
    );
  } else {
    lines.push(`Field changes (${result.fieldDiffs.length}):`);
    for (const d of result.fieldDiffs) {
      const a = d.valueA === undefined ? "absent" : JSON.stringify(d.valueA);
      const b = d.valueB === undefined ? "absent" : JSON.stringify(d.valueB);
      lines.push(`  ${d.field.padEnd(20)} ${a}  →  ${b}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function formatTenantNwayDiff(
  result: DiffTenantPoliciesNwayResult,
): string {
  const lines: string[] = [];
  lines.push(
    `N-way diff between ${result.resolutions.length} tenants (table: ${result.tableName}):`,
  );
  for (let i = 0; i < result.resolutions.length; i++) {
    const entry = result.resolutions[i]!;
    const label = labelForIndex(i);
    lines.push(
      `  Tenant ${label}: ${entry.tenantId}  ${summarizeResolutionForDiff(entry.resolution)}`,
    );
  }
  lines.push("");
  if (result.fieldVariations.length === 0) {
    lines.push(
      `No differences — all ${result.resolutions.length} tenants have the same effective retention policy.`,
    );
  } else {
    lines.push(`Field variations (${result.fieldVariations.length}):`);
    const labelByTenant = new Map<string, string>();
    for (let i = 0; i < result.tenantIds.length; i++) {
      const tid = result.tenantIds[i]!;
      if (!labelByTenant.has(tid)) {
        labelByTenant.set(tid, labelForIndex(i));
      }
    }
    for (const variation of result.fieldVariations) {
      const groups = variation.distinctValues
        .map((group) => {
          const value =
            group.value === undefined ? "absent" : JSON.stringify(group.value);
          const labels = group.labels
            .map((tid) => labelByTenant.get(tid) ?? "?")
            .join(", ");
          return `${value} (${labels})`;
        })
        .join(" | ");
      lines.push(`  ${variation.field.padEnd(20)} ${groups}`);
    }
  }
  return lines.join("\n") + "\n";
}

function labelForIndex(i: number): string {
  if (i < 26) return String.fromCharCode(65 + i);
  return `T${i + 1}`;
}

export function formatTenantTablesNwayDiff(
  result: DiffTenantTablesNwayResult,
): string {
  const lines: string[] = [];
  lines.push(
    `N-way diff across ${result.resolutions.length} tables for tenant ${result.tenantId}:`,
  );
  for (let i = 0; i < result.resolutions.length; i++) {
    const entry = result.resolutions[i]!;
    const label = labelForIndex(i);
    lines.push(
      `  Table ${label}: ${entry.tableName.padEnd(36)} ${summarizeResolutionForDiff(entry.resolution)}`,
    );
  }
  lines.push("");
  if (result.fieldVariations.length === 0) {
    lines.push(
      `No differences — all ${result.resolutions.length} tables resolve to the same effective retention policy for this tenant.`,
    );
  } else {
    lines.push(`Field variations (${result.fieldVariations.length}):`);
    const labelByTable = new Map<string, string>();
    for (let i = 0; i < result.tableNames.length; i++) {
      const tname = result.tableNames[i]!;
      if (!labelByTable.has(tname)) {
        labelByTable.set(tname, labelForIndex(i));
      }
    }
    for (const variation of result.fieldVariations) {
      const groups = variation.distinctValues
        .map((group) => {
          const value =
            group.value === undefined ? "absent" : JSON.stringify(group.value);
          const labels = group.labels
            .map((tname) => labelByTable.get(tname) ?? "?")
            .join(", ");
          return `${value} (${labels})`;
        })
        .join(" | ");
      lines.push(`  ${variation.field.padEnd(20)} ${groups}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function formatTenantTablesDiff(
  result: DiffTenantTablesResult,
): string {
  const lines: string[] = [];
  lines.push(`Diff between tables for tenant ${result.tenantId}:`);
  lines.push(
    `  Table A: ${result.tableNameA.padEnd(20)} ${summarizeResolutionForDiff(result.resolutionA)}`,
  );
  lines.push(
    `  Table B: ${result.tableNameB.padEnd(20)} ${summarizeResolutionForDiff(result.resolutionB)}`,
  );
  lines.push("");
  if (result.fieldDiffs.length === 0) {
    lines.push(
      "No differences — both tables resolve to the same effective retention policy for this tenant.",
    );
  } else {
    lines.push(`Field changes (${result.fieldDiffs.length}):`);
    for (const d of result.fieldDiffs) {
      const a = d.valueA === undefined ? "absent" : JSON.stringify(d.valueA);
      const b = d.valueB === undefined ? "absent" : JSON.stringify(d.valueB);
      lines.push(`  ${d.field.padEnd(20)} ${a}  →  ${b}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function formatTenantVsPlatformDiff(
  result: DiffTenantVsPlatformResult,
): string {
  const lines: string[] = [];
  lines.push(
    `Diff between tenant and platform default (table: ${result.tableName}):`,
  );
  lines.push(
    `  Tenant:   ${result.tenantId}  ${summarizeResolutionForDiff(result.tenantResolution)}`,
  );
  lines.push(
    `  Platform: ${summarizeResolutionForDiff(result.platformResolution)}`,
  );
  lines.push("");
  if (result.fieldDiffs.length === 0) {
    lines.push(
      "No differences — tenant has the same effective retention policy as the platform default.",
    );
  } else {
    lines.push(`Field changes (${result.fieldDiffs.length}):`);
    for (const d of result.fieldDiffs) {
      const a = d.valueA === undefined ? "absent" : JSON.stringify(d.valueA);
      const b = d.valueB === undefined ? "absent" : JSON.stringify(d.valueB);
      lines.push(`  ${d.field.padEnd(20)} ${a}  →  ${b}`);
    }
  }
  return lines.join("\n") + "\n";
}
