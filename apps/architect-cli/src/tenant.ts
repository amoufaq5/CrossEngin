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
    printError(
      ctx.io,
      "tenant: missing action. usage: crossengin tenant <housekeeping|policies> [args] [flags]",
    );
    return 2;
  }
  switch (action) {
    case "housekeeping":
      return await runTenantHousekeeping(command, ctx);
    case "policies":
      return await runTenantPolicies(command, ctx);
    default:
      printError(
        ctx.io,
        `tenant: unknown action '${action}'. usage: crossengin tenant <housekeeping|policies> [args] [flags]`,
      );
      return 2;
  }
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

// M4.14.h — `tenant policies <slug|uuid>` — per-tenant cross-substrate
// policy summary. Closes ADR-0276 Q3 + ADR-0277 Q2.
//
// Aggregates what's configured for ONE tenant across three policy axes
// with substrate-level support today:
//
//   1. Retention overrides (meta.tenant_retention_policies) — per-table
//      retention_days + enabled + opt_out state. Reuses
//      PostgresTraceRetention.listTenantPolicies filtered by tenantId.
//   2. Cost ceiling (meta.llm_cost_ceilings) — per-tenant ceiling
//      override that takes precedence over tier + global. One row max
//      per tenant.
//   3. Tier membership (meta.llm_tenant_tier_memberships join
//      meta.llm_cost_tiers) — tier assignment + the tier's policy
//      shape. The fallback path when no per-tenant ceiling override is
//      set. One row max per tenant.
//
// Rate-limit per-tenant overrides are intentionally NOT included in v1
// because no per-tenant override table exists in the substrate today
// (rate-limit policy is platform-defined; tenant variation goes
// through tiers). Documented as a future Q in ADR-0280.
export interface TenantPolicyRetentionEntry {
  readonly tableName: string;
  readonly retentionDays: number;
  readonly enabled: boolean;
  readonly optOut: boolean;
  readonly optOutReason: string | null;
  readonly optOutUntil: string | null;
  readonly lastPrunedAt: string | null;
}

export interface TenantCostCeilingRow {
  // NUMERIC(18,8) preserved as strings to avoid JS number precision loss.
  readonly maxUsdPerRequest: string | null;
  readonly maxUsdPerWindow: string | null;
  readonly windowSeconds: number | null;
  readonly effectiveFrom: string;
}

export interface TenantTierMembershipRow {
  readonly tierId: string;
  readonly displayName: string;
  // Tier policy fields — same NUMERIC(18,8) string preservation.
  readonly maxUsdPerRequest: string | null;
  readonly maxUsdPerWindow: string | null;
  readonly windowSeconds: number | null;
}

export interface TenantPoliciesReport {
  readonly tenantId: string;
  readonly input: string;
  readonly retention: { readonly tables: ReadonlyArray<TenantPolicyRetentionEntry> };
  readonly costCeiling: TenantCostCeilingRow | null;
  readonly tier: TenantTierMembershipRow | null;
}

async function runTenantPolicies(command: ParsedCommand, ctx: TenantContext): Promise<number> {
  const input = command.positional[1];
  if (input === undefined) {
    printError(
      ctx.io,
      "tenant policies: missing positional argument. usage: crossengin tenant policies <slug|uuid>",
    );
    return 2;
  }

  // PG conn setup mirrors runTenantHousekeeping. Tests inject via
  // pgConnectionOverride; production builds from env.
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
        `tenant policies: requires PG env vars (PGHOST/PGDATABASE/...): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  try {
    // Slug→UUID resolution inherits M4.14.j "did you mean" suggestions.
    const resolved = await resolveTenantIdentifier(conn, input);
    if (!resolved.ok) {
      printError(ctx.io, `tenant policies: ${resolved.error}`);
      return 2;
    }
    const tenantId = resolved.tenantId;

    // Gather all three policy axes. Run concurrently — they share the
    // connection but each fires its own SELECT; PG connection is
    // request-serial so this effectively interleaves rather than
    // parallelizes, but the code shape stays clean.
    let report: TenantPoliciesReport;
    try {
      const retention = ctx.retentionOverride ?? new PostgresTraceRetention({ conn });
      const [retentionEntries, costCeiling, tier] = await Promise.all([
        gatherRetentionEntriesForTenant(retention, tenantId),
        gatherCostCeilingForTenant(conn, tenantId),
        gatherTierMembershipForTenant(conn, tenantId),
      ]);
      report = {
        tenantId,
        input,
        retention: { tables: retentionEntries },
        costCeiling,
        tier,
      };
    } catch (err) {
      printError(ctx.io, `tenant policies: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    if (command.format === "json") {
      printJson(ctx.io, { action: "tenant.policies", ...report });
    } else {
      renderPoliciesHuman(ctx, report);
    }
    return 0;
  } finally {
    await closeConn();
  }
}

async function gatherRetentionEntriesForTenant(
  retention: PostgresTraceRetention,
  tenantId: string,
): Promise<ReadonlyArray<TenantPolicyRetentionEntry>> {
  // listTenantPolicies returns ALL per-tenant rows across all tenants;
  // filter client-side by tenantId. Mirrors the retention housekeeping
  // pattern. At typical scale (≤ 1K per-tenant policy rows) the filter
  // cost is negligible vs the SELECT round-trip.
  const all = await retention.listTenantPolicies();
  return all
    .filter((r) => r.tenantId === tenantId)
    .map((r) => ({
      tableName: r.tableName,
      retentionDays: r.retentionDays,
      enabled: r.enabled,
      optOut: r.optOut,
      optOutReason: r.optOutReason,
      optOutUntil: r.optOutUntil,
      lastPrunedAt: r.lastPrunedAt,
    }));
}

async function gatherCostCeilingForTenant(
  conn: PgConnection,
  tenantId: string,
): Promise<TenantCostCeilingRow | null> {
  // NUMERIC(18,8)::TEXT cast preserves sub-cent precision across the
  // node-postgres boundary (the driver returns NUMERIC as strings by
  // default but the explicit cast keeps the contract obvious + matches
  // the pattern from PostgresCostCeilingResolver).
  const result = await conn.query<{
    max_usd_per_request: string | null;
    max_usd_per_window: string | null;
    window_seconds: number | null;
    effective_from: string;
  }>(
    `SELECT max_usd_per_request::TEXT AS max_usd_per_request,
            max_usd_per_window::TEXT AS max_usd_per_window,
            window_seconds,
            to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS effective_from
     FROM meta.llm_cost_ceilings WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    maxUsdPerRequest: row.max_usd_per_request,
    maxUsdPerWindow: row.max_usd_per_window,
    windowSeconds: row.window_seconds,
    effectiveFrom: row.effective_from,
  };
}

async function gatherTierMembershipForTenant(
  conn: PgConnection,
  tenantId: string,
): Promise<TenantTierMembershipRow | null> {
  // INNER JOIN against llm_cost_tiers — tier_id FK has ON DELETE
  // RESTRICT (ADR-0144) so a membership row's tier always resolves.
  const result = await conn.query<{
    tier_id: string;
    display_name: string;
    max_usd_per_request: string | null;
    max_usd_per_window: string | null;
    window_seconds: number | null;
  }>(
    `SELECT t.tier_id, t.display_name,
            t.max_usd_per_request::TEXT AS max_usd_per_request,
            t.max_usd_per_window::TEXT AS max_usd_per_window,
            t.window_seconds
     FROM meta.llm_tenant_tier_memberships m
     JOIN meta.llm_cost_tiers t ON t.tier_id = m.tier_id
     WHERE m.tenant_id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    tierId: row.tier_id,
    displayName: row.display_name,
    maxUsdPerRequest: row.max_usd_per_request,
    maxUsdPerWindow: row.max_usd_per_window,
    windowSeconds: row.window_seconds,
  };
}

function renderPoliciesHuman(ctx: TenantContext, report: TenantPoliciesReport): void {
  ctx.io.stdout.write(`tenant policies (tenantId: ${report.tenantId}):\n`);

  // Retention block.
  ctx.io.stdout.write(`\n=== Retention overrides (${report.retention.tables.length}) ===\n`);
  if (report.retention.tables.length === 0) {
    ctx.io.stdout.write(`  (no per-tenant retention overrides — inherits platform defaults)\n`);
  } else {
    for (const t of report.retention.tables) {
      ctx.io.stdout.write(`\n  ${t.tableName}\n`);
      ctx.io.stdout.write(
        `    retention:   ${t.retentionDays} day(s) (${t.enabled ? "enabled" : "disabled"})\n`,
      );
      if (t.optOut) {
        const until = t.optOutUntil ?? "indefinite";
        const reason = t.optOutReason ?? "<no reason>";
        ctx.io.stdout.write(`    opt-out:     active (until ${until}, reason: ${reason})\n`);
      } else {
        ctx.io.stdout.write(`    opt-out:     no\n`);
      }
      ctx.io.stdout.write(`    last pruned: ${t.lastPrunedAt ?? "never"}\n`);
    }
  }

  // Cost ceiling block.
  ctx.io.stdout.write(`\n=== Cost ceiling override ===\n`);
  if (report.costCeiling === null) {
    ctx.io.stdout.write(`  (no per-tenant override — inherits from tier or global)\n`);
  } else {
    ctx.io.stdout.write(`  max per request: ${renderUsd(report.costCeiling.maxUsdPerRequest)}\n`);
    ctx.io.stdout.write(`  max per window:  ${renderUsd(report.costCeiling.maxUsdPerWindow)}\n`);
    ctx.io.stdout.write(
      `  window seconds:  ${report.costCeiling.windowSeconds ?? "(unbounded)"}\n`,
    );
    ctx.io.stdout.write(`  effective from:  ${report.costCeiling.effectiveFrom}\n`);
  }

  // Tier membership block.
  ctx.io.stdout.write(`\n=== Tier membership ===\n`);
  if (report.tier === null) {
    ctx.io.stdout.write(`  (no tier membership — inherits global ceiling)\n`);
  } else {
    ctx.io.stdout.write(`  tier:            ${report.tier.tierId} (${report.tier.displayName})\n`);
    ctx.io.stdout.write(`  max per request: ${renderUsd(report.tier.maxUsdPerRequest)}\n`);
    ctx.io.stdout.write(`  max per window:  ${renderUsd(report.tier.maxUsdPerWindow)}\n`);
    ctx.io.stdout.write(`  window seconds:  ${report.tier.windowSeconds ?? "(unbounded)"}\n`);
  }
}

function renderUsd(value: string | null): string {
  return value === null ? "(unbounded)" : `$${value} USD`;
}
