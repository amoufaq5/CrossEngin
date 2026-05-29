// M4.14.l — cross-dashboard `crossengin tenant housekeeping` combined
// view. Closes ADR-0270 Q7.
//
// Operators running compliance audits across a single tenant previously
// had to run two commands (`crossengin gateway housekeeping --tenant X`
// + `crossengin retention housekeeping --tenant X`) and stitch the
// outputs. The new `tenant housekeeping` action runs both internally
// with the SAME --tenant / --all-tenants resolution and concatenates the
// reports under one envelope.
//
// Scope (v1):
// - --tenant <uuid|slug> + --all-tenants supported (same semantics +
//   mutual exclusivity as the individual dashboards).
// - --threshold-alert supported; alerts from EITHER dashboard trip exit 3.
// - --format human|json supported.
// - --watch / --watch-keep-going deferred (combining two watch loops has
//   subtle ordering concerns + isn't requested for compliance audits
//   which run as one-shot commands). Documented as future Q in ADR-0276.
//
// Shape:
// - Single PG connection used by both dashboards.
// - Single --tenant resolution (slug→UUID happens once).
// - Single threshold-alert evaluation across the union of all tables.
// - Output: human format prints two clearly-separated sections; JSON
//   envelope merges both dashboards under one envelope with the tenant
//   echo + alerts array at the top level.

import {
  PostgresTraceRetention,
  createNodePgConnection,
  parsePgEnvConfig,
  type PgConnection,
} from "@crossengin/kernel-pg";
import { PostgresIdempotencyStore } from "@crossengin/api-gateway-pg";

import { getBooleanFlag, getMultiFlag, getStringFlag, type ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import { printError, printJson } from "./format.js";
import {
  gatherHousekeepingReport,
  type HousekeepingReport,
  type HousekeepingTableReport,
} from "./gateway-housekeeping.js";
import {
  gatherRetentionHousekeepingReport,
  type RetentionHousekeepingReport,
  type RetentionHousekeepingTableReport,
} from "./retention-housekeeping.js";
import { resolveTenantIdentifier } from "./tenant-resolver.js";
import {
  evaluateAlertCompound,
  parseThresholdAlertFlags,
  renderTrippedAlert,
  type AlertableFieldSpec,
  type AlertableFieldType,
  type ThresholdAlertSpec,
  type TrippedAlert,
} from "./threshold-alert.js";

export interface TenantContext extends RunContext {
  readonly pgConnectionOverride?: PgConnection;
  readonly retentionOverride?: PostgresTraceRetention;
  readonly idempotencyStoreOverride?: PostgresIdempotencyStore;
  readonly clockOverride?: () => Date;
}

// The combined view's alertable-field set is the UNION of both
// dashboards. Numeric fields are mostly shared (totalRowCount,
// wouldPruneCount, retentionDays); perTenantPolicyCount is retention-
// only.
const COMBINED_ALERTABLE_FIELDS: ReadonlyArray<AlertableFieldSpec> = [
  { name: "totalRowCount", type: "number" },
  { name: "oldestAt", type: "timestamp_nullable" },
  { name: "wouldPruneCount", type: "number" },
  { name: "retentionDays", type: "number_nullable" },
  { name: "lastPrunedAt", type: "timestamp_nullable" },
  { name: "perTenantPolicyCount", type: "number_nullable" },
];

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runTenant(command: ParsedCommand, ctx: TenantContext): Promise<number> {
  const action = command.positional[0];
  if (action === undefined) {
    printError(ctx.io, "tenant: missing action. usage: crossengin tenant <housekeeping> [flags]");
    return 2;
  }
  if (action !== "housekeeping") {
    printError(
      ctx.io,
      `tenant: unknown action '${action}'. usage: crossengin tenant <housekeeping> [flags]`,
    );
    return 2;
  }
  return await runTenantHousekeeping(command, ctx);
}

async function runTenantHousekeeping(command: ParsedCommand, ctx: TenantContext): Promise<number> {
  // --tenant + --all-tenants parsing + mutual-exclusivity check BEFORE
  // PG resolution.
  const tenantFlag = getStringFlag(command, "tenant");
  const allTenantsFlag = getBooleanFlag(command, "all-tenants");
  if (allTenantsFlag && tenantFlag !== null) {
    printError(
      ctx.io,
      `tenant housekeeping: --tenant and --all-tenants are mutually exclusive (use one or the other)`,
    );
    return 2;
  }
  const allTenants = allTenantsFlag ? (true as const) : undefined;

  // --threshold-alert flags. Same fail-fast-on-validation discipline.
  const alertRaws = getMultiFlag(command, "threshold-alert");
  const alerts = parseThresholdAlertFlags(
    alertRaws,
    COMBINED_ALERTABLE_FIELDS,
    ctx.io,
    "tenant housekeeping",
  );
  if (typeof alerts === "number") return alerts;

  // PG conn setup. Production: createNodePgConnection from env. Tests:
  // pgConnectionOverride.
  let conn: PgConnection;
  let closeConn: () => Promise<void> = async () => undefined;
  if (ctx.pgConnectionOverride !== undefined) {
    conn = ctx.pgConnectionOverride;
  } else {
    try {
      const config = parsePgEnvConfig(ctx.env);
      conn = createNodePgConnection(config);
      closeConn = async () => {
        await conn.close().catch(() => undefined);
      };
    } catch (err) {
      printError(
        ctx.io,
        `tenant housekeeping: requires PG env vars (PGHOST/PGDATABASE/...): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  // M4.14.o — resolve --tenant <uuid|slug>. Same shared helper.
  let tenantId: string | undefined;
  if (tenantFlag !== null) {
    if (UUID_REGEX.test(tenantFlag)) {
      tenantId = tenantFlag;
    } else {
      const resolved = await resolveTenantIdentifier(conn, tenantFlag);
      if (!resolved.ok) {
        await closeConn();
        printError(ctx.io, `tenant housekeeping: ${resolved.error}`);
        return 2;
      }
      tenantId = resolved.tenantId;
    }
  }

  try {
    const retention = ctx.retentionOverride ?? new PostgresTraceRetention({ conn });
    const idempotencyStore = ctx.idempotencyStoreOverride ?? new PostgresIdempotencyStore(conn);
    const now = ctx.clockOverride !== undefined ? ctx.clockOverride() : new Date();

    // Gather both dashboards. Parallel via Promise.all — they share the
    // conn but each does its own queries; PG connection is request-
    // serial so this effectively interleaves rather than parallelizing,
    // but the code shape mirrors how independent gather closures
    // compose.
    let gateway: HousekeepingReport;
    let retentionReport: RetentionHousekeepingReport;
    try {
      [gateway, retentionReport] = await Promise.all([
        gatherHousekeepingReport({
          conn,
          retention,
          idempotencyStore,
          now,
          tenantId,
          allTenants,
        }),
        gatherRetentionHousekeepingReport({
          conn,
          retention,
          now,
          tenantId,
          allTenants,
        }),
      ]);
    } catch (err) {
      printError(
        ctx.io,
        `tenant housekeeping: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }

    const tripped =
      alerts.length > 0 ? evaluateAlertsAcrossDashboards(gateway, retentionReport, alerts) : [];

    if (command.format === "json") {
      printJson(ctx.io, {
        action: "tenant.housekeeping",
        asOf: gateway.asOf,
        ...(tenantId !== undefined ? { tenantId } : {}),
        ...(allTenants === true ? { allTenants: true as const } : {}),
        gateway,
        retention: retentionReport,
        alerts: tripped,
      });
    } else {
      renderHumanReport(ctx, gateway, retentionReport, tenantId, allTenants);
      if (tripped.length > 0) {
        ctx.io.stdout.write(`\nTHRESHOLD ALERTS (${tripped.length} tripped):\n`);
        for (const t of tripped) ctx.io.stdout.write(renderTrippedAlert(t) + "\n");
      }
    }

    return tripped.length > 0 ? 3 : 0;
  } finally {
    await closeConn();
  }
}

function evaluateAlertsAcrossDashboards(
  gateway: HousekeepingReport,
  retention: RetentionHousekeepingReport,
  alerts: ReadonlyArray<ThresholdAlertSpec>,
): TrippedAlert[] {
  const asOfMs = Date.parse(gateway.asOf);
  const tripped: TrippedAlert[] = [];
  const fieldTypeOf = (field: string): AlertableFieldType | undefined =>
    COMBINED_ALERTABLE_FIELDS.find((f) => f.name === field)?.type;

  // Iterate every table from BOTH dashboards. Operators get one tripped
  // alert per (table, alert) match across the union of all surfaces.
  for (const t of gateway.tables) {
    for (const alert of alerts) {
      const hit = evaluateAlertCompound(
        alert,
        t.tableName,
        (field) => readGatewayField(t, field),
        fieldTypeOf,
        asOfMs,
      );
      if (hit !== null) tripped.push(hit);
    }
  }
  for (const t of retention.tables) {
    for (const alert of alerts) {
      const hit = evaluateAlertCompound(
        alert,
        t.tableName,
        (field) => readRetentionField(t, field),
        fieldTypeOf,
        asOfMs,
      );
      if (hit !== null) tripped.push(hit);
    }
  }
  return tripped;
}

function readGatewayField(row: HousekeepingTableReport, field: string): number | string | null {
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

function readRetentionField(
  row: RetentionHousekeepingTableReport,
  field: string,
): number | string | null {
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
    case "perTenantPolicyCount":
      return row.perTenantPolicyCount;
    default:
      return null;
  }
}

function renderHumanReport(
  ctx: TenantContext,
  gateway: HousekeepingReport,
  retention: RetentionHousekeepingReport,
  tenantId: string | undefined,
  allTenants: true | undefined,
): void {
  let header: string;
  if (tenantId !== undefined) {
    header = `tenant housekeeping (as of ${gateway.asOf}, filtered to tenant ${tenantId}):\n`;
  } else if (allTenants === true) {
    header = `tenant housekeeping (as of ${gateway.asOf}, matrix mode — all tenants):\n`;
  } else {
    header = `tenant housekeeping (as of ${gateway.asOf}):\n`;
  }
  ctx.io.stdout.write(header);
  ctx.io.stdout.write(`\n=== Gateway housekeeping ===\n`);
  renderGatewaySection(ctx, gateway);
  ctx.io.stdout.write(`\n=== Retention housekeeping ===\n`);
  renderRetentionSection(ctx, retention);
}

function renderGatewaySection(ctx: TenantContext, report: HousekeepingReport): void {
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
  }
}

function renderRetentionSection(ctx: TenantContext, report: RetentionHousekeepingReport): void {
  for (const t of report.tables) {
    ctx.io.stdout.write(`\n  ${t.tableName}\n`);
    ctx.io.stdout.write(`    total rows:      ${t.totalRowCount.toLocaleString("en-US")}\n`);
    ctx.io.stdout.write(`    oldest row:      ${t.oldestAt ?? "(empty)"}\n`);
    ctx.io.stdout.write(`    would prune:     ${t.wouldPruneCount.toLocaleString("en-US")}\n`);
    if (t.retentionDays !== null) {
      ctx.io.stdout.write(
        `    retention:       ${t.retentionDays} day(s) (${t.enabled === true ? "enabled" : "disabled"})\n`,
      );
    } else {
      ctx.io.stdout.write(`    retention:       (no platform policy configured)\n`);
    }
    ctx.io.stdout.write(`    last pruned:     ${t.lastPrunedAt ?? "never"}\n`);
    ctx.io.stdout.write(
      `    tenant overrides: ${t.perTenantPolicyCount.toLocaleString("en-US")}\n`,
    );
  }
}
