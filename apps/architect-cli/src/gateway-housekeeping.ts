import type { PgConnection, TenantRetentionPolicyRow } from "@crossengin/kernel-pg";
import { PostgresIdempotencyStore } from "@crossengin/api-gateway-pg";
import { PostgresTraceRetention } from "@crossengin/kernel-pg";

import { getMultiFlag, getStringFlag, type ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import { printError, printJson } from "./format.js";
import {
  installSigintBridge,
  parseWatchFlags,
  runHousekeepingWatchLoop,
  type WatchOverride,
} from "./housekeeping-watch.js";
import {
  evaluateAlertOnRow,
  parseThresholdAlertFlags,
  renderTrippedAlert,
  type AlertableFieldSpec,
  type ThresholdAlertSpec,
  type TrippedAlert,
} from "./threshold-alert.js";

// Field registry for gateway housekeeping. Subset of retention's set —
// no perTenantPolicyCount (gateway housekeeping doesn't expose it).
// tableName + pruneSemantic excluded (static / non-numeric).
const GATEWAY_ALERTABLE_FIELDS: ReadonlyArray<AlertableFieldSpec> = [
  { name: "totalRowCount", type: "number" },
  { name: "oldestAt", type: "timestamp_nullable" },
  { name: "wouldPruneCount", type: "number" },
  { name: "retentionDays", type: "number_nullable" },
  { name: "lastPrunedAt", type: "timestamp_nullable" },
];

// The three gateway housekeeping tables. Each has a single canonical row-
// reduction mechanism: retention-policy-based for the audit surfaces, TTL-
// based for the idempotency records.
type PruneSemantic = "retention_days" | "expires_at";

interface TableSpec {
  readonly tableName: string;
  readonly timeColumn: string;
  readonly pruneSemantic: PruneSemantic;
}

const HOUSEKEEPING_TABLES: ReadonlyArray<TableSpec> = [
  // M4.11 — retention substrate, started_at as the audit time column.
  {
    tableName: "gateway_pipeline_executions",
    timeColumn: "started_at",
    pruneSemantic: "retention_days",
  },
  // M4.12/M4.13 — own TTL via expires_at (NOT in PRUNABLE_TABLES).
  {
    tableName: "gateway_idempotency_records",
    timeColumn: "expires_at",
    pruneSemantic: "expires_at",
  },
  // M4.11.x — retention substrate, decided_at as the audit time column.
  {
    tableName: "rate_limit_decisions",
    timeColumn: "decided_at",
    pruneSemantic: "retention_days",
  },
];

export interface HousekeepingTableReport {
  readonly tableName: string;
  readonly pruneSemantic: PruneSemantic;
  readonly totalRowCount: number;
  readonly oldestAt: string | null;
  readonly wouldPruneCount: number;
  // Populated when pruneSemantic === "retention_days" and a platform policy
  // is configured. `null` when no policy exists for the table.
  readonly retentionDays: number | null;
  // For retention-substrate tables: the platform policy's last_pruned_at.
  // For idempotency: always null (no policy table).
  readonly lastPrunedAt: string | null;
  // M4.14.v — only present when `--tenant <uuid>` is set. For retention-
  // governed tables: the tenant's override row when one exists, else `null`
  // (the tenant inherits the platform default for this table). For the
  // expires_at-governed idempotency table: always `null` and explicitly
  // surfaced as "(not applicable — expires_at-managed)" in human output
  // since per-tenant overrides don't exist on the TTL surface.
  readonly tenantPolicy?: TenantRetentionPolicyRow | null;
}

export interface HousekeepingReport {
  readonly asOf: string;
  readonly tables: ReadonlyArray<HousekeepingTableReport>;
  // M4.14.v — present only under `--tenant <uuid>`, echoes the filter so
  // downstream JSON consumers know which tenant the tenantPolicy fields
  // correspond to.
  readonly tenantId?: string;
}

export interface GatherHousekeepingInput {
  readonly conn: PgConnection;
  readonly retention: PostgresTraceRetention;
  readonly idempotencyStore: PostgresIdempotencyStore;
  readonly now: Date;
  // M4.14.v — when set, every table report includes a `tenantPolicy` field
  // (Option B: drill-down only; aggregates stay cross-tenant for mental-
  // model continuity, zero new substrate queries).
  readonly tenantId?: string;
}

export async function gatherHousekeepingReport(
  input: GatherHousekeepingInput,
): Promise<HousekeepingReport> {
  const platformPolicies = await input.retention.listPolicies();
  const platformByTable = new Map(platformPolicies.map((p) => [p.tableName, p]));
  const previewEntries = await input.retention.previewPrune();
  // Sum platform-level wouldDeleteCount per table (per-tenant entries are
  // separate rows; the housekeeping dashboard surfaces the platform sweep
  // total, matching how operators read it).
  const previewByTable = new Map<string, number>();
  for (const entry of previewEntries) {
    if (entry.tenantId !== undefined) continue;
    if (entry.status !== "previewed") continue;
    previewByTable.set(entry.tableName, entry.wouldDeleteCount);
  }

  // M4.14.v — when --tenant is set, build a per-table lookup of THIS
  // tenant's overrides. listTenantPolicies returns ALL tenants' rows; we
  // filter client-side because the substrate doesn't expose a tenant-
  // scoped variant and the table is bounded (~2N rows where N = tenant
  // count, sub-millisecond at the typical 10K-tenant scale).
  const tenantPolicyByTable = new Map<string, TenantRetentionPolicyRow>();
  if (input.tenantId !== undefined) {
    const tenantPolicies = await input.retention.listTenantPolicies();
    for (const p of tenantPolicies) {
      if (p.tenantId === input.tenantId) tenantPolicyByTable.set(p.tableName, p);
    }
  }

  const tables: HousekeepingTableReport[] = [];
  for (const spec of HOUSEKEEPING_TABLES) {
    const stats = await queryTableStats(input.conn, spec);
    let wouldPrune: number;
    let retentionDays: number | null = null;
    let lastPrunedAt: string | null = null;
    if (spec.pruneSemantic === "expires_at") {
      wouldPrune = await input.idempotencyStore.previewDeleteExpired(input.now);
    } else {
      const platformPolicy = platformByTable.get(spec.tableName);
      retentionDays = platformPolicy?.retentionDays ?? null;
      lastPrunedAt = platformPolicy?.lastPrunedAt ?? null;
      wouldPrune = previewByTable.get(spec.tableName) ?? 0;
    }
    const baseRow: HousekeepingTableReport = {
      tableName: spec.tableName,
      pruneSemantic: spec.pruneSemantic,
      totalRowCount: stats.totalRowCount,
      oldestAt: stats.oldestAt,
      wouldPruneCount: wouldPrune,
      retentionDays,
      lastPrunedAt,
    };
    // M4.14.v — under --tenant, tenantPolicy is always set:
    //   - retention-governed tables: the matched override row or `null`
    //     (the tenant inherits platform default for this table)
    //   - expires_at-governed idempotency: `null` always — per-tenant
    //     overrides don't exist on the TTL surface; renderer surfaces
    //     the "(not applicable)" semantic to operators.
    tables.push(
      input.tenantId !== undefined
        ? {
            ...baseRow,
            tenantPolicy:
              spec.pruneSemantic === "expires_at"
                ? null
                : (tenantPolicyByTable.get(spec.tableName) ?? null),
          }
        : baseRow,
    );
  }
  return {
    asOf: input.now.toISOString(),
    tables,
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
  };
}

async function queryTableStats(
  conn: PgConnection,
  spec: TableSpec,
): Promise<{ totalRowCount: number; oldestAt: string | null }> {
  const result = await conn.query<{ total: string; oldest: string | null }>(
    `SELECT COUNT(*)::TEXT AS total, MIN(${spec.timeColumn})::TEXT AS oldest
       FROM meta.${spec.tableName}`,
  );
  const row = result.rows[0];
  return {
    totalRowCount: Number(row?.total ?? 0),
    oldestAt: row?.oldest ?? null,
  };
}

export interface HousekeepingContext extends RunContext {
  readonly pgConnectionOverride?: PgConnection;
  readonly retentionOverride?: PostgresTraceRetention;
  readonly idempotencyStoreOverride?: PostgresIdempotencyStore;
  readonly clockOverride?: () => Date;
  // M4.14.w — `--watch` mode test-injection hooks.
  readonly watchOverride?: WatchOverride;
}

export async function runGatewayHousekeeping(
  command: ParsedCommand,
  ctx: HousekeepingContext,
  // The dispatcher must supply a connection factory; the action itself owns
  // adapter wiring + cleanup. Tests inject the overrides instead.
  buildConnection: () => PgConnection,
): Promise<number> {
  // Parse --watch + --watch-interval BEFORE PG resolution so misuse exits
  // cleanly without burning a connection.
  const watchFlags = parseWatchFlags(command, ctx.io, "gateway housekeeping");
  if (typeof watchFlags === "number") return watchFlags;

  // Parse --threshold-alert flags. Same fail-fast-on-validation discipline.
  const alertRaws = getMultiFlag(command, "threshold-alert");
  const alerts = parseThresholdAlertFlags(
    alertRaws,
    GATEWAY_ALERTABLE_FIELDS,
    ctx.io,
    "gateway housekeeping",
  );
  if (typeof alerts === "number") return alerts;

  // M4.14.v — `--tenant <uuid>` drill-down filter. Validate at CLI boundary
  // (UUID syntax) so misuse exits 2 BEFORE PG resolution (same fail-fast
  // discipline as --watch + --threshold-alert).
  const tenantFlag = getStringFlag(command, "tenant");
  if (tenantFlag !== null && !isValidUuid(tenantFlag)) {
    printError(
      ctx.io,
      `gateway housekeeping: --tenant '${tenantFlag}' must be a UUID (e.g., 11111111-2222-3333-4444-555555555555)`,
    );
    return 2;
  }
  const tenantId = tenantFlag ?? undefined;

  let conn: PgConnection;
  try {
    conn = ctx.pgConnectionOverride ?? buildConnection();
  } catch (err) {
    printError(
      ctx.io,
      `gateway housekeeping: requires PG env vars (PGHOST/PGDATABASE/...): ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const retention = ctx.retentionOverride ?? new PostgresTraceRetention({ conn });
  const idempotencyStore = ctx.idempotencyStoreOverride ?? new PostgresIdempotencyStore(conn);

  // Shared gather closure for both single-shot + watch modes.
  const gather = async (): Promise<HousekeepingReport> => {
    const now = ctx.clockOverride !== undefined ? ctx.clockOverride() : new Date();
    return await gatherHousekeepingReport({
      conn,
      retention,
      idempotencyStore,
      now,
      tenantId,
    });
  };

  // Per-tick render + alert evaluation. Returns "halt" if any alert tripped.
  const renderTick = (report: HousekeepingReport): "halt" | void => {
    const tripped = alerts.length > 0 ? evaluateAlertsForReport(report, alerts) : [];
    if (command.format === "json") {
      ctx.io.stdout.write(
        JSON.stringify({ action: "gateway.housekeeping", ...report, alerts: tripped }) + "\n",
      );
    } else {
      renderHumanReport(ctx, report);
      if (tripped.length > 0) renderTrippedAlertsHuman(ctx, tripped);
    }
    return tripped.length > 0 ? "halt" : undefined;
  };

  // M4.14.s — error rendering used only under --watch-keep-going.
  const renderError = (err: Error): void => {
    const message = err.message;
    if (command.format === "json") {
      const nowIso = (
        ctx.clockOverride !== undefined ? ctx.clockOverride() : new Date()
      ).toISOString();
      ctx.io.stdout.write(
        JSON.stringify({
          action: "gateway.housekeeping",
          asOf: nowIso,
          error: { message },
        }) + "\n",
      );
    } else {
      ctx.io.stdout.write(`gateway housekeeping: (error this tick: ${message})\n`);
    }
  };

  try {
    if (watchFlags.watch) {
      const isJson = command.format === "json";
      // M4.14.r — SIGINT-to-AbortController bridge for graceful Ctrl-C
      // shutdown (skips when caller supplies abortSignal directly, e.g.,
      // in tests).
      const sigintBridge =
        ctx.watchOverride?.abortSignal === undefined
          ? installSigintBridge(ctx.watchOverride?.signalRegistrar)
          : undefined;
      try {
        const result = await runHousekeepingWatchLoop<HousekeepingReport>({
          gather,
          render: renderTick,
          clearScreenBeforeRender: !isJson,
          io: ctx.io,
          options: {
            intervalMs: watchFlags.intervalSeconds * 1000,
            maxIterations: ctx.watchOverride?.maxIterations,
            abortSignal: ctx.watchOverride?.abortSignal ?? sigintBridge?.signal,
            setTimeoutFn: ctx.watchOverride?.setTimeoutFn,
            clearTimeoutFn: ctx.watchOverride?.clearTimeoutFn,
          },
          keepGoing: watchFlags.keepGoing,
          errorRender: renderError,
        });
        return result.halted ? 3 : 0;
      } finally {
        sigintBridge?.cleanup();
      }
    }
    const report = await gather();
    const tripped = alerts.length > 0 ? evaluateAlertsForReport(report, alerts) : [];
    if (command.format === "json") {
      printJson(ctx.io, { action: "gateway.housekeeping", ...report, alerts: tripped });
    } else {
      renderHumanReport(ctx, report);
      if (tripped.length > 0) renderTrippedAlertsHuman(ctx, tripped);
    }
    return tripped.length > 0 ? 3 : 0;
  } catch (err) {
    printError(ctx.io, `gateway housekeeping: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Evaluate every alert against every table row in the report. asOf drives
// duration-based timestamp alert checks.
function evaluateAlertsForReport(
  report: HousekeepingReport,
  alerts: ReadonlyArray<ThresholdAlertSpec>,
): TrippedAlert[] {
  const asOfMs = Date.parse(report.asOf);
  const tripped: TrippedAlert[] = [];
  for (const tableRow of report.tables) {
    for (const alert of alerts) {
      const fieldSpec = GATEWAY_ALERTABLE_FIELDS.find((f) => f.name === alert.field);
      if (fieldSpec === undefined) continue;
      const fieldValue = readField(tableRow, alert.field);
      const hit = evaluateAlertOnRow(alert, tableRow.tableName, fieldValue, fieldSpec.type, asOfMs);
      if (hit !== null) tripped.push(hit);
    }
  }
  return tripped;
}

function readField(row: HousekeepingTableReport, field: string): number | string | null {
  switch (field) {
    case "totalRowCount":
      return row.totalRowCount;
    case "oldestAt":
      return row.oldestAt;
    case "wouldPruneCount":
      return row.wouldPruneCount;
    case "retentionDays":
      return row.retentionDays;
    case "lastPrunedAt":
      return row.lastPrunedAt;
    default:
      return null;
  }
}

function renderTrippedAlertsHuman(
  ctx: HousekeepingContext,
  tripped: ReadonlyArray<TrippedAlert>,
): void {
  ctx.io.stdout.write(`\nTHRESHOLD ALERTS (${tripped.length} tripped):\n`);
  for (const alert of tripped) {
    ctx.io.stdout.write(renderTrippedAlert(alert) + "\n");
  }
}

function renderHumanReport(ctx: HousekeepingContext, report: HousekeepingReport): void {
  const header =
    report.tenantId !== undefined
      ? `gateway housekeeping (as of ${report.asOf}, filtered to tenant ${report.tenantId}):\n`
      : `gateway housekeeping (as of ${report.asOf}):\n`;
  ctx.io.stdout.write(header);
  for (const t of report.tables) {
    ctx.io.stdout.write(`\n  ${t.tableName}\n`);
    ctx.io.stdout.write(`    semantic:       ${t.pruneSemantic}\n`);
    ctx.io.stdout.write(`    total rows:     ${t.totalRowCount.toLocaleString("en-US")}\n`);
    ctx.io.stdout.write(`    oldest row:     ${t.oldestAt ?? "(empty)"}\n`);
    ctx.io.stdout.write(`    would prune:    ${t.wouldPruneCount.toLocaleString("en-US")}\n`);
    if (t.pruneSemantic === "retention_days") {
      ctx.io.stdout.write(
        `    retention:      ${t.retentionDays !== null ? `${t.retentionDays} day(s)` : "(no platform policy configured)"}\n`,
      );
      ctx.io.stdout.write(`    last pruned:    ${t.lastPrunedAt ?? "never"}\n`);
    }
    // M4.14.v — tenantPolicy is set only when --tenant filter is active.
    // null on retention-governed tables = "this tenant has no override on
    // this table" (inherits platform default); null on the expires_at table
    // = "(not applicable — expires_at-managed)". A populated row shows the
    // override detail.
    if (t.tenantPolicy !== undefined) {
      renderTenantPolicyHuman(ctx, t.tenantPolicy, t.pruneSemantic);
    }
  }
}

function renderTenantPolicyHuman(
  ctx: HousekeepingContext,
  policy: TenantRetentionPolicyRow | null,
  semantic: PruneSemantic,
): void {
  if (policy === null) {
    if (semantic === "expires_at") {
      ctx.io.stdout.write(`    tenant policy:   (not applicable — expires_at-managed)\n`);
    } else {
      ctx.io.stdout.write(`    tenant policy:   (no override — inherits platform default)\n`);
    }
    return;
  }
  ctx.io.stdout.write(`    tenant policy:\n`);
  ctx.io.stdout.write(
    `      retention:     ${policy.retentionDays} day(s) (${policy.enabled ? "enabled" : "disabled"})\n`,
  );
  if (policy.optOut) {
    const until = policy.optOutUntil ?? "indefinite";
    const reason = policy.optOutReason ?? "<no reason>";
    ctx.io.stdout.write(`      opt-out:       yes (until ${until}, reason: ${reason})\n`);
  } else {
    ctx.io.stdout.write(`      opt-out:       no\n`);
  }
  ctx.io.stdout.write(`      last pruned:   ${policy.lastPrunedAt ?? "never"}\n`);
}

// CLI-side UUID format check. The kernel/PG layer enforces strict
// validation at INSERT/SELECT time; this is just an operator-friendly
// guard against typos so misuse exits 2 cleanly without burning a PG
// connection.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}
