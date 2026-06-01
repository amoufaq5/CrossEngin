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
  type TenantRetentionPolicyRow,
} from "@crossengin/kernel-pg";
import { PostgresIdempotencyStore } from "@crossengin/api-gateway-pg";

import { getBooleanFlag, getMultiFlag, getStringFlag, type ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import { printCsv, printError, printJson, printTsv } from "./format.js";
import {
  gatherHousekeepingReport,
  type HousekeepingReport,
  type HousekeepingTableReport,
} from "./gateway-housekeeping.js";
import {
  installShutdownBridge,
  parseWatchFlags,
  runHousekeepingWatchLoop,
  type WatchOverride,
} from "./housekeeping-watch.js";
import {
  gatherRetentionHousekeepingReport,
  type RetentionHousekeepingReport,
  type RetentionHousekeepingTableReport,
} from "./retention-housekeeping.js";
import { resolveTenantIdentifier, reverseTenantSlug } from "./tenant-resolver.js";
import {
  evaluateAlertCompound,
  formatTrippedAlertsGhSummaryTable,
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
  // M4.14.d — `--watch` mode test-injection hooks. Production callers
  // leave undefined and get default setTimeout/SIGINT+SIGTERM handling.
  readonly watchOverride?: WatchOverride;
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
  // M4.14.d — parse --watch flags BEFORE PG resolution so misuse exits
  // fast without a connection attempt. Shared infrastructure handles
  // --watch-interval bounds + --watch-keep-going + format compatibility
  // checks identically to gateway and retention housekeeping.
  const watchFlags = parseWatchFlags(command, ctx.io, "tenant housekeeping");
  if (typeof watchFlags === "number") return watchFlags;

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

  // M4.15.a — --diff <other-slug|uuid> compares two tenants' housekeeping
  // dashboards side-by-side. Requires --tenant (the LHS is the existing
  // --tenant filter; --diff supplies the RHS). The diff focuses on
  // tenantPolicy / tenantOverrides fields — the GLOBAL per-table stats
  // (totalRowCount, oldestAt, wouldPruneCount) are platform-wide and
  // shouldn't differ between two tenants under the same PG snapshot
  // (any divergence there would be a race between the two gather
  // calls, not a meaningful policy difference). Mutually exclusive
  // with --all-tenants (diff and matrix don't compose) and --watch
  // (diff is one-shot for v1 — looped diff layouts garble badly).
  // Threshold alerts also rejected (alert semantics target a single
  // tenant view, not pair-wise divergence — which side trips?).
  const diffFlag = getStringFlag(command, "diff");
  // M4.15.c — --add-tenant <other> (repeatable, requires --diff)
  // extends --diff into N-way housekeeping comparison. Mirrors the
  // policies M4.14.a shape: --diff supplies the first RHS, each
  // --add-tenant adds another RHS compared against the anchor.
  // When N>1, the envelope switches to multi-comparison form with
  // action `tenant.housekeeping.diff.multi` + `anchor` +
  // `comparisons[]` array. Exit code = max-divergence across all
  // comparisons (any comparison's fieldDiffs.length >= threshold
  // trips exit 3).
  const addTenantFlags = getMultiFlag(command, "add-tenant");
  if (diffFlag !== null) {
    if (tenantFlag === null) {
      printError(
        ctx.io,
        `tenant housekeeping: --diff requires --tenant (the LHS comes from --tenant; --diff supplies the RHS)`,
      );
      return 2;
    }
    if (allTenantsFlag) {
      printError(
        ctx.io,
        `tenant housekeeping: --diff and --all-tenants are mutually exclusive (diff is pair-wise; --all-tenants is matrix)`,
      );
      return 2;
    }
    if (watchFlags.watch) {
      printError(
        ctx.io,
        `tenant housekeeping: --diff and --watch are mutually exclusive in v1 (looped diff layouts garble; run --diff one-shot)`,
      );
      return 2;
    }
    if (getMultiFlag(command, "threshold-alert").length > 0) {
      printError(
        ctx.io,
        `tenant housekeeping: --diff and --threshold-alert are mutually exclusive (alert semantics target a single tenant view, not pair-wise divergence)`,
      );
      return 2;
    }
    // M4.15.h — --axis gateway|retention filters the fieldDiffs to a
    // single substrate surface. Useful when operators audit one axis
    // only (e.g., "did retention overrides drift?" without the
    // gateway-axis noise). Validate the value BEFORE PG so typos
    // exit fast.
    const axisFlag = getStringFlag(command, "axis");
    if (axisFlag !== null && axisFlag !== "gateway" && axisFlag !== "retention") {
      printError(
        ctx.io,
        `tenant housekeeping: invalid --axis '${axisFlag}' (expected 'gateway' or 'retention')`,
      );
      return 2;
    }
    return await runTenantHousekeepingDiff(
      command,
      ctx,
      tenantFlag,
      [diffFlag, ...addTenantFlags],
      axisFlag as "gateway" | "retention" | null,
    );
  }
  if (addTenantFlags.length > 0) {
    // --add-tenant without --diff has no anchor model: --diff supplies
    // the first RHS; --add-tenant only adds more. Reject explicitly
    // rather than silently treating the first --add-tenant as --diff.
    printError(
      ctx.io,
      `tenant housekeeping: --add-tenant requires --diff (the first RHS comes from --diff; --add-tenant adds more)`,
    );
    return 2;
  }

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
  // M4.15.aj — operator's raw --tenant input as tenantSlug when it was a
  // slug (differs from resolved UUID). Threaded into BOTH JSON envelopes
  // (watch tick + single tick) and the gh-summary header so programmatic
  // consumers parsing JSON for audit-trail purposes don't need to re-
  // resolve slugs at their layer. UUID input → undefined → field omitted
  // from envelope (backward-compatible with M4.15.aa shape for UUID
  // callers). Closes ADR-0322 future Q3.
  //
  // M4.15.ak — extends with reverse slug lookup for UUID input: when
  // operator passes a UUID, query meta.tenants for the canonical slug so
  // audit-trail consumers see both regardless of input shape. One extra
  // indexed PK lookup per call (negligible at typical scales); best-
  // effort degrades silently on missing row or query failure. Closes
  // ADR-0322 Q2 + ADR-0323 Q1.
  let tenantSlug: string | undefined;
  if (tenantFlag !== null && tenantId !== undefined) {
    if (tenantFlag !== tenantId) {
      // Slug input — preserve operator-typed value (M4.15.aj behavior).
      tenantSlug = tenantFlag;
    } else {
      // UUID input — reverse-lookup canonical slug from meta.tenants.
      tenantSlug = await reverseTenantSlug(conn, tenantId);
    }
  }

  // M4.14.d — gather closure shared by single-tick AND --watch loop. Each
  // tick fetches BOTH dashboards concurrently (Promise.all interleaves on
  // the single PG connection so total wall-clock is approximately the sum
  // of both gather sequences, but the code shape stays clean) AND
  // evaluates threshold alerts across the union. Returning one envelope
  // means the loop renders ONCE per tick — no interleaved-render layout
  // garbling. `now` is sampled INSIDE the closure so each tick gets a
  // fresh clock; under fixed clock injection the value stays constant.
  type CombinedReport = {
    readonly gateway: HousekeepingReport;
    readonly retention: RetentionHousekeepingReport;
    readonly tripped: ReadonlyArray<TrippedAlert>;
  };
  const gather = async (): Promise<CombinedReport> => {
    const retention = ctx.retentionOverride ?? new PostgresTraceRetention({ conn });
    const idempotencyStore = ctx.idempotencyStoreOverride ?? new PostgresIdempotencyStore(conn);
    const now = ctx.clockOverride !== undefined ? ctx.clockOverride() : new Date();
    const [gateway, retentionReport] = await Promise.all([
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
    const tripped =
      alerts.length > 0 ? evaluateAlertsAcrossDashboards(gateway, retentionReport, alerts) : [];
    return { gateway, retention: retentionReport, tripped };
  };

  // Per-tick render. Used by both single-tick and watch paths so the
  // human + JSON layouts stay in sync. Returns "halt" when any
  // threshold alert tripped; the watch loop maps that to exit 3 (or
  // records it as "ever halted" under --watch-keep-going).
  const renderTick = (report: CombinedReport): "halt" | void => {
    if (command.format === "json") {
      // NDJSON under --watch (one envelope per line). Single-tick mode
      // also uses this branch — JSON output is line-terminated either
      // way so the shape stays identical to the gateway/retention
      // housekeeping convention.
      ctx.io.stdout.write(
        JSON.stringify({
          action: "tenant.housekeeping",
          asOf: report.gateway.asOf,
          ...(tenantId !== undefined ? { tenantId } : {}),
          ...(tenantSlug !== undefined ? { tenantSlug } : {}),
          ...(allTenants === true ? { allTenants: true as const } : {}),
          gateway: report.gateway,
          retention: report.retention,
          alerts: report.tripped,
        }) + "\n",
      );
    } else {
      renderHumanReport(ctx, report.gateway, report.retention, tenantId, allTenants);
      if (report.tripped.length > 0) {
        ctx.io.stdout.write(`\nTHRESHOLD ALERTS (${report.tripped.length} tripped):\n`);
        for (const t of report.tripped) ctx.io.stdout.write(renderTrippedAlert(t) + "\n");
      }
    }
    return report.tripped.length > 0 ? "halt" : undefined;
  };

  // Error renderer used only under --watch-keep-going. When a tick's
  // gather() throws, render a placeholder line/envelope and the loop
  // continues. Mirrors gateway-housekeeping.ts:renderError shape.
  const renderError = (err: Error): void => {
    if (command.format === "json") {
      const nowIso = (
        ctx.clockOverride !== undefined ? ctx.clockOverride() : new Date()
      ).toISOString();
      ctx.io.stdout.write(
        JSON.stringify({
          action: "tenant.housekeeping",
          asOf: nowIso,
          error: { message: err.message },
        }) + "\n",
      );
    } else {
      ctx.io.stdout.write(`tenant housekeeping: (error this tick: ${err.message})\n`);
    }
  };

  try {
    if (watchFlags.watch) {
      // SIGINT/SIGTERM-to-AbortController bridge for graceful Ctrl-C +
      // pod-shutdown handling. Skips when tests supply abortSignal
      // directly via watchOverride.
      const shutdownBridge =
        ctx.watchOverride?.abortSignal === undefined
          ? installShutdownBridge(ctx.watchOverride?.signalRegistrar)
          : undefined;
      try {
        const result = await runHousekeepingWatchLoop<CombinedReport>({
          gather,
          render: renderTick,
          clearScreenBeforeRender: command.format === "human",
          io: ctx.io,
          options: {
            intervalMs: watchFlags.intervalSeconds * 1000,
            maxIterations: ctx.watchOverride?.maxIterations,
            abortSignal: ctx.watchOverride?.abortSignal ?? shutdownBridge?.signal,
            setTimeoutFn: ctx.watchOverride?.setTimeoutFn,
            clearTimeoutFn: ctx.watchOverride?.clearTimeoutFn,
          },
          keepGoing: watchFlags.keepGoing,
          errorRender: renderError,
        });
        return result.halted ? 3 : 0;
      } finally {
        shutdownBridge?.cleanup();
      }
    }

    // Single-tick mode (no --watch). Gather errors bubble up to the
    // generic catch below so the error message has the right prefix.
    let report: CombinedReport;
    try {
      report = await gather();
    } catch (err) {
      printError(
        ctx.io,
        `tenant housekeeping: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
    if (command.format === "json") {
      printJson(ctx.io, {
        action: "tenant.housekeeping",
        asOf: report.gateway.asOf,
        ...(tenantId !== undefined ? { tenantId } : {}),
        ...(tenantSlug !== undefined ? { tenantSlug } : {}),
        ...(allTenants === true ? { allTenants: true as const } : {}),
        gateway: report.gateway,
        retention: report.retention,
        alerts: report.tripped,
      });
    } else if (command.format === "gh-summary") {
      // M4.15.aa — Cross-dashboard Markdown for CI step summary
      // integration. Mirrors the gateway-side gh-summary from M4.15.z
      // but renders two substrate sections (Gateway + Retention) under
      // a single `## Tenant housekeeping` title. Reuses the shared
      // formatTrippedAlertsGhSummaryTable helper for the alerts
      // section. Verdict semantic matches M4.15.z: alerts not
      // evaluated → no verdict; evaluated + none tripped →
      // :white_check_mark:; tripped → :x: + exit 3.
      // M4.15.ai — pass operator's original --tenant input as tenantSlug
      // when it was a slug (resolver was called) so the header surfaces
      // `**Tenant:** \`<uuid>\` (slug: \`<slug>\`)`. Uses the shared
      // tenantSlug computed at the dispatcher level (M4.15.aj).
      ctx.io.stdout.write(
        formatTenantHousekeepingReportGhSummary({
          gateway: report.gateway,
          retention: report.retention,
          tripped: report.tripped,
          tenantId,
          tenantSlug,
          allTenants: allTenants === true,
          hadAlerts: alerts.length > 0,
        }),
      );
    } else {
      renderHumanReport(ctx, report.gateway, report.retention, tenantId, allTenants);
      if (report.tripped.length > 0) {
        ctx.io.stdout.write(`\nTHRESHOLD ALERTS (${report.tripped.length} tripped):\n`);
        for (const t of report.tripped) ctx.io.stdout.write(renderTrippedAlert(t) + "\n");
      }
    }
    return report.tripped.length > 0 ? 3 : 0;
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

// M4.15.aa — gh-summary Markdown renderer for tenant housekeeping
// (cross-dashboard). Two substrate sections (Gateway + Retention)
// under a single `## Tenant housekeeping` title. Reuses the
// formatTrippedAlertsGhSummaryTable helper from threshold-alert.ts
// for the alerts section (so this surface and gateway-housekeeping
// emit the same alert-table shape). Verdict semantic matches
// M4.15.z: alerts not evaluated → no verdict, evaluated + none
// tripped → :white_check_mark:, tripped → :x: + exit 3.
export interface TenantHousekeepingReportGhSummaryInput {
  readonly gateway: HousekeepingReport;
  readonly retention: RetentionHousekeepingReport;
  readonly tripped: ReadonlyArray<TrippedAlert>;
  readonly tenantId?: string;
  // M4.15.ai — operator's original --tenant input when it was a slug
  // (not the resolved UUID). When set and differs from tenantId, the
  // gh-summary header surfaces `**Tenant:** \`<uuid>\` (slug: \`<slug>\`)`
  // so CI step summaries echo back the human-readable identifier the
  // operator typed. When undefined OR equal to tenantId (UUID input),
  // header preserves M4.15.aa bare-UUID shape exactly.
  readonly tenantSlug?: string;
  readonly allTenants: boolean;
  readonly hadAlerts: boolean;
}

export function formatTenantHousekeepingReportGhSummary(
  input: TenantHousekeepingReportGhSummaryInput,
): string {
  const lines: string[] = [];
  lines.push(`## Tenant housekeeping`);
  lines.push("");
  lines.push(`**As of:** \`${input.gateway.asOf}\`  `);
  if (input.tenantId !== undefined) {
    if (input.tenantSlug !== undefined && input.tenantSlug !== input.tenantId) {
      lines.push(`**Tenant:** \`${input.tenantId}\` (slug: \`${input.tenantSlug}\`)  `);
    } else {
      lines.push(`**Tenant:** \`${input.tenantId}\`  `);
    }
  }
  if (input.allTenants) {
    lines.push(`**Scope:** all tenants  `);
  }
  lines.push(
    `**Gateway tables:** ${input.gateway.tables.length} | **Retention tables:** ${input.retention.tables.length}`,
  );
  lines.push("");
  lines.push(`### Gateway substrate`);
  lines.push("");
  lines.push(`| Table | Total rows | Oldest | Would prune | Retention |`);
  lines.push(`|-------|-----------:|--------|------------:|-----------|`);
  for (const t of input.gateway.tables) {
    const oldest = t.oldestAt === null ? "—" : `\`${t.oldestAt}\``;
    const retention =
      t.pruneSemantic === "expires_at"
        ? "_TTL-managed_"
        : t.retentionDays === null
          ? "—"
          : `${t.retentionDays}d`;
    lines.push(
      `| \`${t.tableName}\` | ${t.totalRowCount.toLocaleString("en-US")} | ${oldest} | ${t.wouldPruneCount.toLocaleString("en-US")} | ${retention} |`,
    );
  }
  lines.push("");
  lines.push(`### Retention substrate`);
  lines.push("");
  lines.push(`| Table | Total rows | Oldest | Would prune | Retention | Enabled |`);
  lines.push(`|-------|-----------:|--------|------------:|-----------|---------|`);
  for (const t of input.retention.tables) {
    const oldest = t.oldestAt === null ? "—" : `\`${t.oldestAt}\``;
    const retention = t.retentionDays === null ? "—" : `${t.retentionDays}d`;
    const enabled = t.enabled === null ? "—" : t.enabled ? "yes" : "no";
    lines.push(
      `| \`${t.tableName}\` | ${t.totalRowCount.toLocaleString("en-US")} | ${oldest} | ${t.wouldPruneCount.toLocaleString("en-US")} | ${retention} | ${enabled} |`,
    );
  }
  lines.push("");
  if (input.tripped.length > 0) {
    lines.push(`### Threshold alerts (${input.tripped.length})`);
    lines.push("");
    lines.push(formatTrippedAlertsGhSummaryTable(input.tripped).trimEnd());
    lines.push("");
    lines.push(
      `:x: **${input.tripped.length} threshold alert(s) tripped** — exit 3 (CI gate failed).`,
    );
  } else if (input.hadAlerts) {
    lines.push(`:white_check_mark: **All threshold alerts passed.**`);
  }
  // No verdict when hadAlerts === false (query surface, not a gate).
  return lines.join("\n") + "\n";
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

// M4.14.g — effective-policy view derived from the raw axes via the
// override→tier→global precedence walk. Pure client-side composition
// from the existing report — no extra PG query. Mirrors the contract
// from PostgresCostCeilingResolver.resolveDetailed (ADR-0154) so
// operators reading the substrate-level resolver source see the same
// shape. The "none" variant has no `ceiling` field — runtime falls
// back to the router-level global config which lives outside the
// substrate (the router constructor's `costCeiling` option).
export interface TenantPolicyEffectiveCeiling {
  readonly maxUsdPerRequest: string | null;
  readonly maxUsdPerWindow: string | null;
  readonly windowSeconds: number | null;
}

export type TenantPolicyEffective =
  | { readonly source: "override"; readonly ceiling: TenantPolicyEffectiveCeiling }
  | {
      readonly source: "tier";
      readonly ceiling: TenantPolicyEffectiveCeiling;
      readonly tierId: string;
    }
  | { readonly source: "none" };

// M4.14.e — what-if precedence walk surfacing what would happen if
// the override or tier was stripped. Operators auditing whether an
// override is actually doing anything different from what the tier
// would produce ("can I safely clear this override?") read
// `withoutOverride` and compare to `effective`. The `withoutTier`
// path is included for symmetry — operators planning to demote a
// tenant out of a tier read this. Pure client-side derivation,
// composed from `deriveEffectivePolicy` with each input stripped
// to null.
export interface TenantPolicyExplain {
  readonly withoutOverride: TenantPolicyEffective;
  readonly withoutTier: TenantPolicyEffective;
}

export interface TenantPoliciesReport {
  readonly tenantId: string;
  readonly input: string;
  readonly retention: { readonly tables: ReadonlyArray<TenantPolicyRetentionEntry> };
  readonly costCeiling: TenantCostCeilingRow | null;
  readonly tier: TenantTierMembershipRow | null;
  readonly effective?: TenantPolicyEffective;
  readonly explain?: TenantPolicyExplain;
}

async function runTenantPolicies(command: ParsedCommand, ctx: TenantContext): Promise<number> {
  const input = command.positional[1];
  if (input === undefined) {
    printError(
      ctx.io,
      "tenant policies: missing positional argument. usage: crossengin tenant policies <slug|uuid> [--diff <other-slug|uuid>] [--effective] [--explain]",
    );
    return 2;
  }

  // M4.14.g — --effective adds a section showing the precedence-
  // resolved ceiling (override → tier → none). Pure client-side
  // composition from the existing raw axes; no extra PG query.
  // M4.14.e — --explain ALSO implies --effective (operators reading
  // the what-if walk almost always want the current effective view
  // as the baseline; forcing both flags is friction).
  const explainFlag = getBooleanFlag(command, "explain");
  const effectiveFlag = getBooleanFlag(command, "effective") || explainFlag;

  // M4.14.f — --diff <other-slug|uuid> compares two tenants' policy
  // shapes side-by-side. Mirrors the `retention diff` matrix pattern.
  // Pure client-side comparison from two TenantPoliciesReports — no
  // server-side diff query. Composes with --effective: both reports
  // get the effective field if --effective is set.
  const diffFlag = getStringFlag(command, "diff");
  // M4.14.a — --add-tenant <slug|uuid> extends --diff into N-way
  // comparison. Each --add-tenant adds another RHS compared against
  // the LHS anchor. Requires --diff (--add-tenant alone has no anchor
  // model; the LHS is the positional argument but the original RHS
  // comes from --diff). When N>1, the envelope shape changes to a
  // multi-comparison form with action `tenant.policies.diff.multi`
  // and a comparisons[] array.
  const addTenantFlags = getMultiFlag(command, "add-tenant");
  // M4.14.b — --vs-tier <tierId> is a synthetic-RHS comparison: the
  // right side is constructed from the SAME tenant with the same
  // retention + same cost-ceiling override but with the tier replaced
  // by a lookup against meta.llm_cost_tiers. Operators answering
  // "what would change if I moved this tenant to <tierId>?" use this
  // before committing a membership change. Mutually exclusive with
  // --diff (both define the RHS) and with --explain (matches the
  // existing --diff vs --explain rule from ADR-0283).
  // M4.14.a — --vs-tier accepts repetition for N-way tier-preview
  // matrix. Each occurrence is one synthetic comparison; multiple
  // occurrences trip the multi-comparison envelope shape.
  const vsTierFlags = getMultiFlag(command, "vs-tier");
  if (diffFlag !== null && vsTierFlags.length > 0) {
    printError(
      ctx.io,
      "tenant policies: --diff and --vs-tier are mutually exclusive (both define the right-hand-side; pick one)",
    );
    return 2;
  }
  if (addTenantFlags.length > 0 && diffFlag === null) {
    printError(
      ctx.io,
      "tenant policies: --add-tenant requires --diff (the first RHS comes from --diff; --add-tenant adds more)",
    );
    return 2;
  }
  if (addTenantFlags.length > 0 && vsTierFlags.length > 0) {
    printError(
      ctx.io,
      "tenant policies: --add-tenant and --vs-tier are mutually exclusive (tenant-vs-tenant and tenant-vs-tier comparisons can't mix in one envelope)",
    );
    return 2;
  }
  if (vsTierFlags.length > 0 && explainFlag) {
    printError(
      ctx.io,
      "tenant policies: --vs-tier and --explain are mutually exclusive in v1 (the synthetic RHS already answers the what-if question --explain provides)",
    );
    return 2;
  }
  if (vsTierFlags.length > 0) {
    return await runTenantPoliciesVsTier(command, ctx, input, vsTierFlags, effectiveFlag);
  }
  if (diffFlag !== null) {
    // --explain semantics don't compose cleanly with --diff in v1
    // (which side gets explained? both? selectively?). Reject the
    // combination explicitly rather than silently picking a behavior.
    if (explainFlag) {
      printError(
        ctx.io,
        "tenant policies: --diff and --explain are mutually exclusive in v1 (run --explain against each side separately)",
      );
      return 2;
    }
    return await runTenantPoliciesDiff(
      command,
      ctx,
      input,
      [diffFlag, ...addTenantFlags],
      effectiveFlag,
    );
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

    let report: TenantPoliciesReport;
    try {
      report = await gatherPoliciesReport(conn, ctx, tenantId, input, effectiveFlag, explainFlag);
    } catch (err) {
      printError(ctx.io, `tenant policies: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    if (command.format === "json") {
      printJson(ctx.io, { action: "tenant.policies", ...report });
    } else if (command.format === "csv" || command.format === "tsv") {
      // M4.14.c — CSV/TSV emits one row per axis with all axis-fields
      // flattened into the same wide header. The separator is
      // validated INSIDE the format branch so misuse on the
      // human/json path doesn't trigger the check.
      const sepResult = validatePoliciesCsvSeparator(command);
      if (typeof sepResult === "string") {
        printError(ctx.io, `tenant policies: ${sepResult}`);
        return 2;
      }
      const rows = buildPoliciesCsvRows(report);
      if (command.format === "tsv") {
        printTsv(ctx.io, POLICIES_CSV_HEADERS, rows);
      } else {
        printCsv(ctx.io, POLICIES_CSV_HEADERS, rows, sepResult.separator);
      }
    } else {
      renderPoliciesHuman(ctx, report);
    }
    return 0;
  } finally {
    await closeConn();
  }
}

// M4.14.f + M4.14.a — diff orchestrator. Resolves the anchor (LHS)
// + every RHS (slug→UUID for each independently), gathers all
// reports concurrently, computes pair-wise field-level diffs client-
// side, renders the result. Accepts a list of RHS inputs to support
// N-way comparison (M4.14.a): the first element is the `--diff`
// target, subsequent elements are `--add-tenant` targets. When
// length(rhsInputs) === 1, emits the single-comparison envelope
// shape from M4.14.f for backward compatibility; when length > 1,
// switches to the multi-comparison envelope.
async function runTenantPoliciesDiff(
  command: ParsedCommand,
  ctx: TenantContext,
  inputA: string,
  rhsInputs: ReadonlyArray<string>,
  effectiveFlag: boolean,
): Promise<number> {
  // --threshold validation (matches retention diff convention).
  const thresholdError = validateDiffThresholdFlag(command);
  if (thresholdError !== null) {
    printError(ctx.io, `tenant policies: ${thresholdError}`);
    return 2;
  }

  // M4.15.l — --axis validation (mirrors M4.15.h housekeeping pattern,
  // extended to 3 axes since PolicyFieldDiff has retention/costCeiling/
  // tier). Validated up-front so the early-exit fires before any PG
  // round-trip; the filter itself is applied post-compute in emit*.
  const axisFilterError = validatePoliciesAxisFlag(command);
  if (axisFilterError !== null) {
    printError(ctx.io, `tenant policies: ${axisFilterError}`);
    return 2;
  }

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
    // Resolve the anchor + every RHS concurrently. Each resolution
    // gets the M4.14.j "did you mean" treatment independently — if
    // any side fails, the error message identifies which side
    // failed by input. For N-way, "right N" replaces the M4.14.f
    // "right" label so operators can identify which --add-tenant
    // typo'd.
    const allResolvedResults = await Promise.all([
      resolveTenantIdentifier(conn, inputA),
      ...rhsInputs.map((r) => resolveTenantIdentifier(conn, r)),
    ]);
    const resolvedAnchor = allResolvedResults[0]!;
    const resolvedRhsResults = allResolvedResults.slice(1);
    if (!resolvedAnchor.ok) {
      printError(ctx.io, `tenant policies --diff (left '${inputA}'): ${resolvedAnchor.error}`);
      return 2;
    }
    const resolvedRhs: Array<{ readonly ok: true; readonly tenantId: string }> = [];
    for (let i = 0; i < resolvedRhsResults.length; i++) {
      const r = resolvedRhsResults[i]!;
      if (!r.ok) {
        const label = rhsInputs.length === 1 ? "right" : `right ${i + 1}`;
        printError(ctx.io, `tenant policies --diff (${label} '${rhsInputs[i]!}'): ${r.error}`);
        return 2;
      }
      resolvedRhs.push(r);
    }

    // Self-diff guard — comparing the anchor to itself in ANY RHS
    // slot yields empty fieldDiffs and is almost always an operator
    // typo. Fail fast.
    for (let i = 0; i < resolvedRhs.length; i++) {
      if (resolvedAnchor.tenantId === resolvedRhs[i]!.tenantId) {
        const label = rhsInputs.length === 1 ? "right" : `right ${i + 1}`;
        printError(
          ctx.io,
          `tenant policies --diff: left and ${label} resolve to the same tenant '${resolvedAnchor.tenantId}' — nothing to diff`,
        );
        return 2;
      }
    }
    // Self-add-tenant guard — same RHS listed twice in slots yields a
    // tautological comparison. Detect duplicate RHS UUIDs.
    const rhsUuidSeen = new Set<string>();
    for (let i = 0; i < resolvedRhs.length; i++) {
      const uuid = resolvedRhs[i]!.tenantId;
      if (rhsUuidSeen.has(uuid)) {
        printError(
          ctx.io,
          `tenant policies --diff: tenant '${uuid}' appears in multiple RHS slots — each --diff/--add-tenant target must be unique`,
        );
        return 2;
      }
      rhsUuidSeen.add(uuid);
    }

    let reportAnchor: TenantPoliciesReport;
    let reportsRhs: ReadonlyArray<TenantPoliciesReport>;
    try {
      const allReports = await Promise.all([
        // --explain is rejected with --diff above, so pass false here.
        gatherPoliciesReport(conn, ctx, resolvedAnchor.tenantId, inputA, effectiveFlag, false),
        ...resolvedRhs.map((r, i) =>
          gatherPoliciesReport(conn, ctx, r.tenantId, rhsInputs[i]!, effectiveFlag, false),
        ),
      ]);
      reportAnchor = allReports[0]!;
      reportsRhs = allReports.slice(1);
    } catch (err) {
      printError(ctx.io, `tenant policies: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    const firstRhs = reportsRhs[0];
    if (reportsRhs.length === 1 && firstRhs !== undefined) {
      return emitDiffOutput(command, ctx, reportAnchor, firstRhs);
    }
    return emitMultiDiffOutput(command, ctx, reportAnchor, reportsRhs);
  } finally {
    await closeConn();
  }
}

// M4.14.b — extracted from runTenantPoliciesDiff so the synthetic-RHS
// path (--vs-tier) can reuse the format-branching + exit-code
// machinery without duplicating it. Computes fieldDiffs, dispatches
// json / csv / tsv / human render, returns the divergence exit code.
// Returns 2 on --csv-separator validation failure (matches the
// inline-branch semantic from M4.14.c).
function emitDiffOutput(
  command: ParsedCommand,
  ctx: TenantContext,
  reportA: TenantPoliciesReport,
  reportB: TenantPoliciesReport,
): number {
  // M4.15.l — axis filter applied post-compute (no extra PG cost
  // since gather already retrieved all 3 axes). Filter is a no-op
  // when --axis isn't set; otherwise narrows to retention|cost
  // Ceiling|tier rows. Exit-code threshold gates on FILTERED count
  // so `--axis retention --exit-on-divergence` only trips when
  // retention-axis fields diverge.
  const axisFilter = getPoliciesAxisFilter(command);
  const fieldDiffs = filterFieldDiffsByAxis(computePolicyFieldDiffs(reportA, reportB), axisFilter);

  if (command.format === "json") {
    printJson(ctx.io, {
      action: "tenant.policies.diff",
      left: reportA,
      right: reportB,
      fieldDiffs,
    });
  } else if (command.format === "csv" || command.format === "tsv") {
    // M4.14.c — one row per fieldDiff. Empty fieldDiffs still emit
    // the header row (valid CSV; spreadsheet workflows want the
    // header present even when policies match). Divergence exit
    // code still fires per --exit-on-divergence semantics — CSV
    // doesn't suppress it.
    const sepResult = validatePoliciesCsvSeparator(command);
    if (typeof sepResult === "string") {
      printError(ctx.io, `tenant policies: ${sepResult}`);
      return 2;
    }
    const rows = buildPoliciesDiffCsvRows(reportA, reportB, fieldDiffs);
    if (command.format === "tsv") {
      printTsv(ctx.io, POLICIES_DIFF_CSV_HEADERS, rows);
    } else {
      printCsv(ctx.io, POLICIES_DIFF_CSV_HEADERS, rows, sepResult.separator);
    }
  } else if (command.format === "gh-summary") {
    // M4.15.s — pass axisFilter so the renderer can scope the title,
    // section header, verdict text, and drop the redundant Axis col.
    renderPoliciesDiffGhSummary(ctx, reportA, reportB, fieldDiffs, axisFilter);
  } else {
    renderPoliciesDiffHuman(ctx, reportA, reportB, fieldDiffs);
  }

  // Divergence exit code mirrors retention diff: only fires when
  // --exit-on-divergence is set, gated by --threshold.
  return diffDivergenceExitCode(command, fieldDiffs.length);
}

// M4.14.a — N-way multi-comparison envelope. The anchor is compared
// against EACH rhsReports[i] producing a comparisons[] array. Used
// when --diff + --add-tenant produces > 1 RHS, or when --vs-tier is
// repeated > 1 time. Exit code is the MAX across comparisons
// (canonical "any divergence trips the gate" semantic — operators
// gating CI on `tenant policies anchor --diff a --add-tenant b
// --exit-on-divergence` want exit 3 if EITHER (a) or (b) differs).
function emitMultiDiffOutput(
  command: ParsedCommand,
  ctx: TenantContext,
  anchor: TenantPoliciesReport,
  rhsReports: ReadonlyArray<TenantPoliciesReport>,
): number {
  // M4.15.l — axis filter applied per-comparison (no extra PG cost
  // since gather already retrieved all 3 axes). Each comparison's
  // fieldDiffs narrowed independently; the max-divergence exit code
  // is computed across the FILTERED counts.
  const axisFilter = getPoliciesAxisFilter(command);
  const comparisons = rhsReports.map((rhs) => ({
    right: rhs,
    fieldDiffs: filterFieldDiffsByAxis(computePolicyFieldDiffs(anchor, rhs), axisFilter),
  }));

  if (command.format === "json") {
    printJson(ctx.io, {
      action: "tenant.policies.diff.multi",
      anchor,
      comparisons: comparisons.map((c) => ({
        right: c.right,
        fieldDiffs: c.fieldDiffs,
      })),
    });
  } else if (command.format === "csv" || command.format === "tsv") {
    // Multi-comparison CSV: extra `comparison_index` column tags each
    // row with which (anchor, right[i]) pair it came from. Empty
    // fieldDiffs across all comparisons still emits header-only —
    // valid CSV for spreadsheet workflows.
    const sepResult = validatePoliciesCsvSeparator(command);
    if (typeof sepResult === "string") {
      printError(ctx.io, `tenant policies: ${sepResult}`);
      return 2;
    }
    const allRows: Array<ReadonlyArray<unknown>> = [];
    for (let i = 0; i < comparisons.length; i++) {
      const c = comparisons[i]!;
      const baseRows = buildPoliciesDiffCsvRows(anchor, c.right, c.fieldDiffs);
      for (const r of baseRows) {
        allRows.push([i, ...r]);
      }
    }
    const headers = ["comparison_index", ...POLICIES_DIFF_CSV_HEADERS];
    if (command.format === "tsv") {
      printTsv(ctx.io, headers, allRows);
    } else {
      printCsv(ctx.io, headers, allRows, sepResult.separator);
    }
  } else if (command.format === "gh-summary") {
    // M4.15.s — axis-aware multi-comparison rendering.
    renderPoliciesMultiDiffGhSummary(ctx, anchor, comparisons, axisFilter);
  } else {
    renderPoliciesMultiDiffHuman(ctx, anchor, comparisons);
  }

  // Max-divergence exit code: report the GREATEST fieldDiffs count
  // across all comparisons to diffDivergenceExitCode. Any
  // comparison whose count >= threshold trips exit 3. This matches
  // operator intent for CI gates ("any divergence is a problem").
  const maxFieldDiffsLength = comparisons.reduce((max, c) => Math.max(max, c.fieldDiffs.length), 0);
  return diffDivergenceExitCode(command, maxFieldDiffsLength);
}

// M4.14.a — human render for multi-comparison. Emits one section per
// comparison, each with its own Left/Right header + fieldDiffs (or
// "No differences"). Same per-comparison shape as
// renderPoliciesDiffHuman so operators reading multi output recognize
// each section.
function renderPoliciesMultiDiffHuman(
  ctx: TenantContext,
  anchor: TenantPoliciesReport,
  comparisons: ReadonlyArray<{
    right: TenantPoliciesReport;
    fieldDiffs: ReadonlyArray<PolicyFieldDiff>;
  }>,
): void {
  ctx.io.stdout.write(
    `Multi-comparison tenant policies (anchor: ${anchor.tenantId} input: '${anchor.input}', ${comparisons.length} comparisons):\n\n`,
  );
  for (let i = 0; i < comparisons.length; i++) {
    const c = comparisons[i]!;
    ctx.io.stdout.write(`=== Comparison ${i + 1}/${comparisons.length} ===\n`);
    renderPoliciesDiffHuman(ctx, anchor, c.right, c.fieldDiffs);
    if (i < comparisons.length - 1) ctx.io.stdout.write(`\n`);
  }
}

// M4.14.b — `tenant policies <lhs> --vs-tier <tierId>` orchestrator.
// Closes ADR-0282 Q2 + ADR-0283 Q3.
//
// Constructs a synthetic right-hand-side TenantPoliciesReport for the
// SAME tenant where only the tier is swapped — retention + cost-
// ceiling override stay identical. Operators answering "what would
// change if I moved this tenant to <tierId>?" use this before
// committing a membership change. Without --effective, the diff
// usually surfaces a single tier.tierId change (when both sides
// have a tier) which is operationally obvious; pair with
// --effective so both sides carry their effective-ceiling field and
// operators can read whether the effective ceiling actually changes
// (it doesn't when the override shadows the tier — the canonical
// "your override is doing all the work" finding).
async function runTenantPoliciesVsTier(
  command: ParsedCommand,
  ctx: TenantContext,
  inputLhs: string,
  tierIds: ReadonlyArray<string>,
  effectiveFlag: boolean,
): Promise<number> {
  // --threshold validation (matches retention diff convention).
  const thresholdError = validateDiffThresholdFlag(command);
  if (thresholdError !== null) {
    printError(ctx.io, `tenant policies: ${thresholdError}`);
    return 2;
  }

  // M4.14.a — duplicate-tier guard. Repeating the same tier in
  // multiple --vs-tier slots yields tautological comparisons. Catch
  // before resolving anything.
  const tierSeen = new Set<string>();
  for (const t of tierIds) {
    if (tierSeen.has(t)) {
      printError(
        ctx.io,
        `tenant policies --vs-tier: tier '${t}' appears in multiple --vs-tier slots — each target must be unique`,
      );
      return 2;
    }
    tierSeen.add(t);
  }

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
    // Resolve LHS slug→UUID + look up EVERY tier definition
    // concurrently. The tier lookups are from meta.llm_cost_tiers
    // directly (NOT via membership; we want the tier shape, not
    // "is this tenant in this tier").
    const [resolvedLhs, ...tierDefinitions] = await Promise.all([
      resolveTenantIdentifier(conn, inputLhs),
      ...tierIds.map((t) => gatherTierDefinition(conn, t)),
    ]);
    if (!resolvedLhs.ok) {
      printError(ctx.io, `tenant policies --vs-tier (left '${inputLhs}'): ${resolvedLhs.error}`);
      return 2;
    }
    for (let i = 0; i < tierDefinitions.length; i++) {
      if (tierDefinitions[i] === null) {
        printError(ctx.io, `tenant policies --vs-tier: no tier with id '${tierIds[i]}'`);
        return 2;
      }
    }
    const resolvedTiers = tierDefinitions as ReadonlyArray<TenantTierMembershipRow>;

    let reportLhs: TenantPoliciesReport;
    try {
      reportLhs = await gatherPoliciesReport(
        conn,
        ctx,
        resolvedLhs.tenantId,
        inputLhs,
        effectiveFlag,
        false,
      );
    } catch (err) {
      printError(ctx.io, `tenant policies: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    // Synthetic RHSes: same tenant, same retention, same override —
    // tier replaced with each looked-up definition. `input` carries a
    // `vs-tier:` prefix per RHS so the human + CSV output makes it
    // obvious which synthetic this is. The effective field (under
    // --effective) is computed against the NEW tier so operators see
    // the precedence-walk result with the hypothetical tier
    // substituted.
    const syntheticRhsReports: ReadonlyArray<TenantPoliciesReport> = resolvedTiers.map(
      (tierDef, i) => ({
        tenantId: resolvedLhs.tenantId,
        input: `vs-tier:${tierIds[i]}`,
        retention: reportLhs.retention,
        costCeiling: reportLhs.costCeiling,
        tier: tierDef,
        ...(effectiveFlag
          ? { effective: deriveEffectivePolicy(reportLhs.costCeiling, tierDef) }
          : {}),
      }),
    );

    // No self-diff guard for matching current tier: if the tenant's
    // CURRENT tierId equals any --vs-tier tierId, the diff is empty
    // — that's actually the useful "moving to this tier changes
    // nothing" answer, not an operator typo. Different from --diff
    // where same-tenant-as-self is almost always a typo.

    const first = syntheticRhsReports[0];
    if (syntheticRhsReports.length === 1 && first !== undefined) {
      return emitDiffOutput(command, ctx, reportLhs, first);
    }
    return emitMultiDiffOutput(command, ctx, reportLhs, syntheticRhsReports);
  } finally {
    await closeConn();
  }
}

// M4.15.a — `tenant housekeeping --tenant <A> --diff <B>` orchestrator.
// Compares two tenants' housekeeping dashboards side-by-side. The
// meaningful diff axis is per-tenant overrides — the GLOBAL per-table
// stats (totalRowCount, oldestAt, wouldPruneCount) are platform-wide
// under the same PG snapshot and shouldn't differ between two
// tenants. The diff walks the tenantPolicy field on every gateway
// table + every retention table and emits HousekeepingFieldDiff
// entries for each value mismatch. The threshold + exit-code
// semantics mirror tenant policies --diff: --exit-on-divergence +
// optional --threshold N.
async function runTenantHousekeepingDiff(
  command: ParsedCommand,
  ctx: TenantContext,
  inputLhs: string,
  rhsInputs: ReadonlyArray<string>,
  axisFilter: "gateway" | "retention" | null = null,
): Promise<number> {
  // --threshold validation (matches policies --diff convention).
  const thresholdError = validateDiffThresholdFlag(command);
  if (thresholdError !== null) {
    printError(ctx.io, `tenant housekeeping: ${thresholdError}`);
    return 2;
  }

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

  try {
    // Resolve anchor + every RHS concurrently. The "did you mean"
    // suggestion treatment from M4.14.j fires per side; when N>1,
    // RHSes are labeled "right N" so operators know which
    // --add-tenant typo'd. Single RHS preserves the "right" label
    // from M4.15.a for backward compat.
    const allResolvedResults = await Promise.all([
      resolveTenantIdentifier(conn, inputLhs),
      ...rhsInputs.map((r) => resolveTenantIdentifier(conn, r)),
    ]);
    const resolvedAnchor = allResolvedResults[0]!;
    const resolvedRhsResults = allResolvedResults.slice(1);
    if (!resolvedAnchor.ok) {
      printError(
        ctx.io,
        `tenant housekeeping --diff (left '${inputLhs}'): ${resolvedAnchor.error}`,
      );
      return 2;
    }
    const resolvedRhs: Array<{ readonly ok: true; readonly tenantId: string }> = [];
    for (let i = 0; i < resolvedRhsResults.length; i++) {
      const r = resolvedRhsResults[i]!;
      if (!r.ok) {
        const label = rhsInputs.length === 1 ? "right" : `right ${i + 1}`;
        printError(ctx.io, `tenant housekeeping --diff (${label} '${rhsInputs[i]!}'): ${r.error}`);
        return 2;
      }
      resolvedRhs.push(r);
    }

    // Self-diff guard — anchor matching any RHS slot yields empty
    // fieldDiffs for that comparison and is almost always an
    // operator typo. Mirrors policies M4.14.a N-way self-diff.
    for (let i = 0; i < resolvedRhs.length; i++) {
      if (resolvedAnchor.tenantId === resolvedRhs[i]!.tenantId) {
        const label = rhsInputs.length === 1 ? "right" : `right ${i + 1}`;
        printError(
          ctx.io,
          `tenant housekeeping --diff: left and ${label} resolve to the same tenant '${resolvedAnchor.tenantId}' — nothing to diff`,
        );
        return 2;
      }
    }
    // Duplicate-RHS guard — same RHS in multiple slots yields a
    // tautological comparison. Mirrors policies M4.14.a.
    const rhsUuidSeen = new Set<string>();
    for (let i = 0; i < resolvedRhs.length; i++) {
      const uuid = resolvedRhs[i]!.tenantId;
      if (rhsUuidSeen.has(uuid)) {
        printError(
          ctx.io,
          `tenant housekeeping --diff: tenant '${uuid}' appears in multiple RHS slots — each --diff/--add-tenant target must be unique`,
        );
        return 2;
      }
      rhsUuidSeen.add(uuid);
    }

    // Gather anchor's 2 reports + each RHS's 2 reports concurrently.
    // Total reports = 2 * (1 + N) where N = rhsInputs.length. All
    // tenant-filtered so tenantPolicy fields populate per table.
    const retention = ctx.retentionOverride ?? new PostgresTraceRetention({ conn });
    const idempotencyStore = ctx.idempotencyStoreOverride ?? new PostgresIdempotencyStore(conn);
    const now = ctx.clockOverride !== undefined ? ctx.clockOverride() : new Date();

    const n = resolvedRhs.length;
    let gatewayAnchor: HousekeepingReport;
    let gatewayRhs: ReadonlyArray<HousekeepingReport>;
    let retentionAnchor: RetentionHousekeepingReport;
    let retentionRhs: ReadonlyArray<RetentionHousekeepingReport>;
    try {
      // Order: gateway_anchor, gateway_rhs[0..N-1], retention_anchor,
      // retention_rhs[0..N-1]. Stable slice ordering for downstream.
      const allReports = await Promise.all([
        gatherHousekeepingReport({
          conn,
          retention,
          idempotencyStore,
          now,
          tenantId: resolvedAnchor.tenantId,
        }),
        ...resolvedRhs.map((r) =>
          gatherHousekeepingReport({
            conn,
            retention,
            idempotencyStore,
            now,
            tenantId: r.tenantId,
          }),
        ),
        gatherRetentionHousekeepingReport({
          conn,
          retention,
          now,
          tenantId: resolvedAnchor.tenantId,
        }),
        ...resolvedRhs.map((r) =>
          gatherRetentionHousekeepingReport({
            conn,
            retention,
            now,
            tenantId: r.tenantId,
          }),
        ),
      ]);
      gatewayAnchor = allReports[0] as HousekeepingReport;
      gatewayRhs = allReports.slice(1, 1 + n) as ReadonlyArray<HousekeepingReport>;
      retentionAnchor = allReports[1 + n] as RetentionHousekeepingReport;
      retentionRhs = allReports.slice(2 + n) as ReadonlyArray<RetentionHousekeepingReport>;
    } catch (err) {
      printError(
        ctx.io,
        `tenant housekeeping: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }

    const anchorSide = {
      tenantId: resolvedAnchor.tenantId,
      input: inputLhs,
      gateway: gatewayAnchor,
      retention: retentionAnchor,
    };
    const rhsSides = resolvedRhs.map((r, i) => ({
      tenantId: r.tenantId,
      input: rhsInputs[i]!,
      gateway: gatewayRhs[i]!,
      retention: retentionRhs[i]!,
    }));

    if (n === 1) {
      const rhs = rhsSides[0]!;
      const rawFieldDiffs = computeHousekeepingFieldDiffs(
        { gateway: anchorSide.gateway, retention: anchorSide.retention },
        { gateway: rhs.gateway, retention: rhs.retention },
      );
      // M4.15.h — --axis filter narrows fieldDiffs to one substrate.
      // Acts as a post-processing step on the computed diffs; the
      // gather already retrieved both axes so there's no extra PG
      // cost. Empty result on a filtered axis is still a valid no-
      // divergence outcome.
      const fieldDiffs =
        axisFilter === null ? rawFieldDiffs : rawFieldDiffs.filter((d) => d.axis === axisFilter);
      if (command.format === "json") {
        printJson(ctx.io, {
          action: "tenant.housekeeping.diff",
          left: anchorSide,
          right: rhs,
          fieldDiffs,
        });
      } else if (command.format === "csv" || command.format === "tsv") {
        // M4.15.d — single-comparison CSV: one row per fieldDiff with
        // tenant_a/tenant_b identity columns + axis + table_name +
        // field + value_a + value_b. Empty fieldDiffs still emits the
        // header row (valid CSV; spreadsheet workflows want the
        // header present even when policies match — same convention
        // as policies --diff M4.14.c). Divergence exit code still
        // fires per --exit-on-divergence semantics.
        const sepResult = validatePoliciesCsvSeparator(command);
        if (typeof sepResult === "string") {
          printError(ctx.io, `tenant housekeeping: ${sepResult}`);
          return 2;
        }
        const rows = buildHousekeepingDiffCsvRows(
          { tenantId: anchorSide.tenantId, input: anchorSide.input },
          { tenantId: rhs.tenantId, input: rhs.input },
          fieldDiffs,
        );
        if (command.format === "tsv") {
          printTsv(ctx.io, HOUSEKEEPING_DIFF_CSV_HEADERS, rows);
        } else {
          printCsv(ctx.io, HOUSEKEEPING_DIFF_CSV_HEADERS, rows, sepResult.separator);
        }
      } else if (command.format === "gh-summary") {
        // M4.15.ah — pass axisFilter so the renderer scopes the title,
        // section header, verdict text + drops Axis column.
        renderHousekeepingDiffGhSummary(
          ctx,
          { tenantId: anchorSide.tenantId, input: anchorSide.input },
          { tenantId: rhs.tenantId, input: rhs.input },
          fieldDiffs,
          axisFilter,
        );
      } else {
        renderHousekeepingDiffHuman(
          ctx,
          { tenantId: anchorSide.tenantId, input: anchorSide.input },
          { tenantId: rhs.tenantId, input: rhs.input },
          fieldDiffs,
        );
      }
      return diffDivergenceExitCode(command, fieldDiffs.length);
    }

    // M4.15.c — N>1: multi-comparison envelope. Each comparison is
    // anchor vs one RHS yielding its own fieldDiffs. Exit code =
    // max-divergence across all comparisons (any comparison's
    // fieldDiffs.length >= threshold trips exit 3, matching
    // policies M4.14.a semantic).
    // M4.15.h — same axis filter applies per comparison in N-way
    // mode. The filter narrows EACH comparison's fieldDiffs to the
    // chosen axis; max-divergence exit code reflects the filtered
    // counts (so operators gating on "any retention drift" don't
    // trip on gateway-axis differences).
    const comparisons = rhsSides.map((rhs) => {
      const raw = computeHousekeepingFieldDiffs(
        { gateway: anchorSide.gateway, retention: anchorSide.retention },
        { gateway: rhs.gateway, retention: rhs.retention },
      );
      return {
        right: rhs,
        fieldDiffs: axisFilter === null ? raw : raw.filter((d) => d.axis === axisFilter),
      };
    });

    if (command.format === "json") {
      printJson(ctx.io, {
        action: "tenant.housekeeping.diff.multi",
        anchor: anchorSide,
        comparisons: comparisons.map((c) => ({
          right: c.right,
          fieldDiffs: c.fieldDiffs,
        })),
      });
    } else if (command.format === "csv" || command.format === "tsv") {
      // M4.15.d — multi-comparison CSV: prepend comparison_index
      // column tagging each row with which (anchor, right[i]) pair
      // it came from. Empty fieldDiffs across all comparisons still
      // emits header-only (matches policies multi-CSV from M4.14.a).
      const sepResult = validatePoliciesCsvSeparator(command);
      if (typeof sepResult === "string") {
        printError(ctx.io, `tenant housekeeping: ${sepResult}`);
        return 2;
      }
      const allRows: Array<ReadonlyArray<unknown>> = [];
      for (let i = 0; i < comparisons.length; i++) {
        const c = comparisons[i]!;
        const baseRows = buildHousekeepingDiffCsvRows(
          { tenantId: anchorSide.tenantId, input: anchorSide.input },
          { tenantId: c.right.tenantId, input: c.right.input },
          c.fieldDiffs,
        );
        for (const r of baseRows) {
          allRows.push([i, ...r]);
        }
      }
      const headers = ["comparison_index", ...HOUSEKEEPING_DIFF_CSV_HEADERS];
      if (command.format === "tsv") {
        printTsv(ctx.io, headers, allRows);
      } else {
        printCsv(ctx.io, headers, allRows, sepResult.separator);
      }
    } else if (command.format === "gh-summary") {
      // M4.15.ah — axis-aware multi-comparison rendering.
      renderHousekeepingMultiDiffGhSummary(
        ctx,
        { tenantId: anchorSide.tenantId, input: anchorSide.input },
        comparisons,
        axisFilter,
      );
    } else {
      renderHousekeepingMultiDiffHuman(ctx, anchorSide, comparisons);
    }

    const maxFieldDiffsLength = comparisons.reduce(
      (max, c) => Math.max(max, c.fieldDiffs.length),
      0,
    );
    return diffDivergenceExitCode(command, maxFieldDiffsLength);
  } finally {
    await closeConn();
  }
}

// M4.15.c — human render for N-way housekeeping diff. Emits one
// section per comparison, each using the existing
// renderHousekeepingDiffHuman shape so the per-comparison layout
// matches what operators see in single-diff mode.
function renderHousekeepingMultiDiffHuman(
  ctx: TenantContext,
  anchor: { readonly tenantId: string; readonly input: string },
  comparisons: ReadonlyArray<{
    readonly right: { readonly tenantId: string; readonly input: string };
    readonly fieldDiffs: ReadonlyArray<HousekeepingFieldDiff>;
  }>,
): void {
  ctx.io.stdout.write(
    `Multi-comparison tenant housekeeping (anchor: ${anchor.tenantId} input: '${anchor.input}', ${comparisons.length} comparisons):\n\n`,
  );
  for (let i = 0; i < comparisons.length; i++) {
    const c = comparisons[i]!;
    ctx.io.stdout.write(`=== Comparison ${i + 1}/${comparisons.length} ===\n`);
    renderHousekeepingDiffHuman(
      ctx,
      { tenantId: anchor.tenantId, input: anchor.input },
      { tenantId: c.right.tenantId, input: c.right.input },
      c.fieldDiffs,
    );
    if (i < comparisons.length - 1) ctx.io.stdout.write(`\n`);
  }
}

// M4.15.a — field-diff shape for housekeeping. Mirrors PolicyFieldDiff
// but with housekeeping axes ("gateway" | "retention") and the
// per-table tenantPolicy.* field naming.
export interface HousekeepingFieldDiff {
  readonly axis: "gateway" | "retention";
  readonly tableName: string;
  readonly field: string;
  readonly valueA: string | number | boolean | null | undefined;
  readonly valueB: string | number | boolean | null | undefined;
}

// M4.15.a — compute per-table tenantPolicy diffs across BOTH gateway
// and retention dashboards. Skips global stats (totalRowCount,
// oldestAt, wouldPruneCount, retentionDays at the platform level,
// lastPrunedAt) since those are tenant-agnostic under the same PG
// snapshot. Walks UNION of table names per axis for deterministic
// output sorted alphabetically.
export function computeHousekeepingFieldDiffs(
  a: { gateway: HousekeepingReport; retention: RetentionHousekeepingReport },
  b: { gateway: HousekeepingReport; retention: RetentionHousekeepingReport },
): ReadonlyArray<HousekeepingFieldDiff> {
  const diffs: HousekeepingFieldDiff[] = [];

  // Gateway axis — walk per-table tenantPolicy fields. The gateway
  // housekeeping report includes BOTH retention-substrate tables and
  // the idempotency table; the idempotency table has tenantPolicy
  // always null (no per-tenant overrides exist on the TTL surface),
  // so it's effectively a no-op for the diff.
  const gwTablesA = new Map(a.gateway.tables.map((t) => [t.tableName, t] as const));
  const gwTablesB = new Map(b.gateway.tables.map((t) => [t.tableName, t] as const));
  const gwAllTables = new Set<string>([...gwTablesA.keys(), ...gwTablesB.keys()]);
  for (const tableName of [...gwAllTables].sort()) {
    const ta = gwTablesA.get(tableName);
    const tb = gwTablesB.get(tableName);
    if (ta === undefined || tb === undefined) {
      diffs.push({
        axis: "gateway",
        tableName,
        field: "exists",
        valueA: ta !== undefined,
        valueB: tb !== undefined,
      });
      continue;
    }
    appendTenantPolicyDiffs("gateway", tableName, ta.tenantPolicy, tb.tenantPolicy, diffs);
  }

  // Retention axis — same walk against the retention housekeeping
  // report's per-table tenantPolicy field.
  const rtTablesA = new Map(a.retention.tables.map((t) => [t.tableName, t] as const));
  const rtTablesB = new Map(b.retention.tables.map((t) => [t.tableName, t] as const));
  const rtAllTables = new Set<string>([...rtTablesA.keys(), ...rtTablesB.keys()]);
  for (const tableName of [...rtAllTables].sort()) {
    const ta = rtTablesA.get(tableName);
    const tb = rtTablesB.get(tableName);
    if (ta === undefined || tb === undefined) {
      diffs.push({
        axis: "retention",
        tableName,
        field: "exists",
        valueA: ta !== undefined,
        valueB: tb !== undefined,
      });
      continue;
    }
    appendTenantPolicyDiffs("retention", tableName, ta.tenantPolicy, tb.tenantPolicy, diffs);
  }

  return diffs;
}

// Walk tenantPolicy fields for a (tableName, axis) pair and append
// any divergences to the diffs array. tenantPolicy === undefined
// shouldn't happen here (we always pass tenantId to the gather
// calls) but the null case is the meaningful one ("tenant has no
// override; inherits platform default").
function appendTenantPolicyDiffs(
  axis: "gateway" | "retention",
  tableName: string,
  policyA: TenantRetentionPolicyRow | null | undefined,
  policyB: TenantRetentionPolicyRow | null | undefined,
  diffs: HousekeepingFieldDiff[],
): void {
  // Both null = both inherit platform default = no diff.
  if (policyA == null && policyB == null) return;
  // One side has override, other inherits — surface the existence
  // mismatch as a single diff so operators see "tenant A has
  // override here, tenant B doesn't" without N field-level diffs.
  if (policyA == null || policyB == null) {
    diffs.push({
      axis,
      tableName,
      field: "tenantPolicy.exists",
      valueA: policyA != null,
      valueB: policyB != null,
    });
    return;
  }
  // Both sides have overrides — compare each field. Fields mirror
  // TenantPolicyRetentionEntry (M4.14.h).
  const fields: ReadonlyArray<keyof TenantRetentionPolicyRow> = [
    "retentionDays",
    "enabled",
    "optOut",
    "optOutReason",
    "optOutUntil",
  ];
  for (const field of fields) {
    if (policyA[field] !== policyB[field]) {
      diffs.push({
        axis,
        tableName,
        field: `tenantPolicy.${String(field)}`,
        valueA: policyA[field] as HousekeepingFieldDiff["valueA"],
        valueB: policyB[field] as HousekeepingFieldDiff["valueB"],
      });
    }
  }
}

// M4.15.a — human render for housekeeping --diff. Single-tenant-pair
// shape: header naming both sides + a "Field changes" list. Empty
// diffs render "No differences found between tenants" (matches
// policies --diff convention from M4.14.f).
function renderHousekeepingDiffHuman(
  ctx: TenantContext,
  left: { readonly tenantId: string; readonly input: string },
  right: { readonly tenantId: string; readonly input: string },
  fieldDiffs: ReadonlyArray<HousekeepingFieldDiff>,
): void {
  ctx.io.stdout.write(`Diff between tenant housekeeping dashboards:\n`);
  ctx.io.stdout.write(`  Left:  ${left.tenantId} (input: '${left.input}')\n`);
  ctx.io.stdout.write(`  Right: ${right.tenantId} (input: '${right.input}')\n`);
  if (fieldDiffs.length === 0) {
    ctx.io.stdout.write(`\n  No differences found between tenants.\n`);
    return;
  }
  ctx.io.stdout.write(`\n  Field changes (${fieldDiffs.length}):\n`);
  for (const d of fieldDiffs) {
    ctx.io.stdout.write(
      `    [${d.axis}] ${d.tableName}.${d.field}: ${renderDiffValue(d.valueA)} -> ${renderDiffValue(d.valueB)}\n`,
    );
  }
}

// Look up a tier definition by tierId from meta.llm_cost_tiers (no
// membership join). Returns null when the tier doesn't exist — the
// caller renders an error. Shape matches TenantTierMembershipRow so
// the synthetic RHS uses the existing type without coercion.
async function gatherTierDefinition(
  conn: PgConnection,
  tierId: string,
): Promise<TenantTierMembershipRow | null> {
  const result = await conn.query<{
    tier_id: string;
    display_name: string;
    max_usd_per_request: string | null;
    max_usd_per_window: string | null;
    window_seconds: number | null;
  }>(
    `SELECT tier_id, display_name,
            max_usd_per_request::TEXT AS max_usd_per_request,
            max_usd_per_window::TEXT AS max_usd_per_window,
            window_seconds
     FROM meta.llm_cost_tiers
     WHERE tier_id = $1`,
    [tierId],
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

// Pure helper — gathers a single tenant's policy report. Extracted
// from runTenantPolicies so the diff orchestrator can reuse it
// without duplicating the three-axis concurrent-fetch wiring.
async function gatherPoliciesReport(
  conn: PgConnection,
  ctx: TenantContext,
  tenantId: string,
  input: string,
  effectiveFlag: boolean,
  explainFlag: boolean,
): Promise<TenantPoliciesReport> {
  const retention = ctx.retentionOverride ?? new PostgresTraceRetention({ conn });
  const [retentionEntries, costCeiling, tier] = await Promise.all([
    gatherRetentionEntriesForTenant(retention, tenantId),
    gatherCostCeilingForTenant(conn, tenantId),
    gatherTierMembershipForTenant(conn, tenantId),
  ]);
  return {
    tenantId,
    input,
    retention: { tables: retentionEntries },
    costCeiling,
    tier,
    ...(effectiveFlag ? { effective: deriveEffectivePolicy(costCeiling, tier) } : {}),
    ...(explainFlag ? { explain: deriveExplainView(costCeiling, tier) } : {}),
  };
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

  // M4.14.g — effective-policy block when --effective is set.
  if (report.effective !== undefined) {
    ctx.io.stdout.write(`\n=== Effective policy (source: ${report.effective.source}) ===\n`);
    if (report.effective.source === "none") {
      ctx.io.stdout.write(
        `  (no per-tenant or tier policy configured — runtime falls back to router-level global)\n`,
      );
    } else {
      ctx.io.stdout.write(
        `  max per request: ${renderUsd(report.effective.ceiling.maxUsdPerRequest)}\n`,
      );
      ctx.io.stdout.write(
        `  max per window:  ${renderUsd(report.effective.ceiling.maxUsdPerWindow)}\n`,
      );
      ctx.io.stdout.write(
        `  window seconds:  ${report.effective.ceiling.windowSeconds ?? "(unbounded)"}\n`,
      );
      if (report.effective.source === "tier") {
        ctx.io.stdout.write(`  tier:            ${report.effective.tierId}\n`);
      }
    }
  }

  // M4.14.e — explain (what-if precedence walk) block when --explain
  // is set. Renders two scenarios: what the effective walk would
  // yield if the override was stripped, and if the tier was
  // stripped. Operators compare to the current `effective` source
  // above to decide whether clearing either input would change
  // behavior.
  if (report.explain !== undefined) {
    ctx.io.stdout.write(`\n=== Explain (what-if precedence walk) ===\n`);
    renderExplainScenario(ctx, "without override:", report.explain.withoutOverride);
    renderExplainScenario(ctx, "without tier:    ", report.explain.withoutTier);
  }
}

function renderExplainScenario(
  ctx: TenantContext,
  label: string,
  result: TenantPolicyEffective,
): void {
  if (result.source === "none") {
    ctx.io.stdout.write(`  ${label} source=none  (falls back to router-level global)\n`);
    return;
  }
  const req = renderUsd(result.ceiling.maxUsdPerRequest);
  const win = renderUsd(result.ceiling.maxUsdPerWindow);
  const sec = result.ceiling.windowSeconds ?? "(unbounded)";
  const tierSuffix = result.source === "tier" ? `  tier=${result.tierId}` : "";
  ctx.io.stdout.write(
    `  ${label} source=${result.source}  req=${req}  win=${win}  windowSec=${sec}${tierSuffix}\n`,
  );
}

function renderUsd(value: string | null): string {
  return value === null ? "(unbounded)" : `$${value} USD`;
}

// M4.14.g — pure precedence walk: per-tenant override beats tier
// membership beats neither (which means the runtime falls back to the
// router-level global config). Mirrors PostgresCostCeilingResolver
// .resolveDetailed's source attribution (ADR-0154) so operators
// reading the substrate-level adapter source see the same shape here.
// No PG query — composed entirely from the already-fetched axes.
function deriveEffectivePolicy(
  costCeiling: TenantCostCeilingRow | null,
  tier: TenantTierMembershipRow | null,
): TenantPolicyEffective {
  if (costCeiling !== null) {
    return {
      source: "override",
      ceiling: {
        maxUsdPerRequest: costCeiling.maxUsdPerRequest,
        maxUsdPerWindow: costCeiling.maxUsdPerWindow,
        windowSeconds: costCeiling.windowSeconds,
      },
    };
  }
  if (tier !== null) {
    return {
      source: "tier",
      ceiling: {
        maxUsdPerRequest: tier.maxUsdPerRequest,
        maxUsdPerWindow: tier.maxUsdPerWindow,
        windowSeconds: tier.windowSeconds,
      },
      tierId: tier.tierId,
    };
  }
  return { source: "none" };
}

// M4.14.e — what-if precedence walk. Composes `deriveEffectivePolicy`
// twice with each input stripped to null. Pure function over the
// already-fetched raw axes; no PG query. Operators compare
// `effective` (with current inputs) to `explain.withoutOverride`
// (with override stripped) to answer "is my override actually
// doing anything different from what the tier would produce?"
// Identical answers → override is redundant; safe to clear.
// Different answers → override is actively shadowing the tier.
function deriveExplainView(
  costCeiling: TenantCostCeilingRow | null,
  tier: TenantTierMembershipRow | null,
): TenantPolicyExplain {
  return {
    withoutOverride: deriveEffectivePolicy(null, tier),
    withoutTier: deriveEffectivePolicy(costCeiling, null),
  };
}

// M4.14.c — CSV/TSV row builders. Closes ADR-0280 Q6 + ADR-0282 Q4.
//
// Single-tenant layout (one row per axis): retention rows first
// (sorted by tableName), then cost_ceiling (if any), then tier (if
// any), then effective (if --effective), then explain.* (if
// --explain). Lots of NULLs per row — that's the price of the long-
// format spreadsheet schema; pandas/Excel handle it cleanly. Numeric
// fields preserve the NUMERIC(18,8) string representation from the
// underlying axes so spreadsheet round-trips don't lose precision.
//
// Diff layout (one row per fieldDiff): tenant_a / tenant_b columns
// plus axis + field + value_a + value_b. Empty fieldDiffs emit just
// the header row (still a valid CSV — operators piping into
// spreadsheets get the header even when policies match).
const POLICIES_CSV_HEADERS: ReadonlyArray<string> = [
  "tenant_id",
  "input",
  "axis",
  "table_name",
  "retention_days",
  "enabled",
  "opt_out",
  "opt_out_reason",
  "opt_out_until",
  "last_pruned_at",
  "max_usd_per_request",
  "max_usd_per_window",
  "window_seconds",
  "effective_from",
  "tier_id",
  "display_name",
  "effective_source",
];

const POLICIES_DIFF_CSV_HEADERS: ReadonlyArray<string> = [
  "tenant_a_id",
  "tenant_a_input",
  "tenant_b_id",
  "tenant_b_input",
  "axis",
  "field",
  "value_a",
  "value_b",
];

// M4.15.d — housekeeping --diff CSV/TSV headers. Adds table_name
// column since HousekeepingFieldDiff keys per (axis, tableName,
// field) rather than just (axis, field) like policies. 9-column
// shape (10 under N-way with comparison_index prepended).
const HOUSEKEEPING_DIFF_CSV_HEADERS: ReadonlyArray<string> = [
  "tenant_a_id",
  "tenant_a_input",
  "tenant_b_id",
  "tenant_b_input",
  "axis",
  "table_name",
  "field",
  "value_a",
  "value_b",
];

// M4.15.d — one row per HousekeepingFieldDiff. Empty fieldDiffs
// yields an empty row list; the caller emits header-only CSV in
// that case (matches policies M4.14.c convention).
function buildHousekeepingDiffCsvRows(
  left: { readonly tenantId: string; readonly input: string },
  right: { readonly tenantId: string; readonly input: string },
  fieldDiffs: ReadonlyArray<HousekeepingFieldDiff>,
): ReadonlyArray<ReadonlyArray<unknown>> {
  return fieldDiffs.map((d) => [
    left.tenantId,
    left.input,
    right.tenantId,
    right.input,
    d.axis,
    d.tableName,
    d.field,
    d.valueA ?? null,
    d.valueB ?? null,
  ]);
}

// Each axis emits its sub-fields into a row aligned with the header
// schema. Fields not relevant to the axis are emitted as `null` (the
// CSV/TSV formatter renders null as empty string).
function buildPoliciesCsvRows(report: TenantPoliciesReport): ReadonlyArray<ReadonlyArray<unknown>> {
  const rows: Array<ReadonlyArray<unknown>> = [];
  // Stable retention ordering — already alpha-sorted upstream by
  // PostgresTraceRetention.listTenantPolicies; defense in depth.
  const retentionTables = [...report.retention.tables].sort((a, b) =>
    a.tableName.localeCompare(b.tableName),
  );
  for (const t of retentionTables) {
    rows.push([
      report.tenantId,
      report.input,
      "retention",
      t.tableName,
      t.retentionDays,
      t.enabled,
      t.optOut,
      t.optOutReason,
      t.optOutUntil,
      t.lastPrunedAt,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  }
  if (report.costCeiling !== null) {
    rows.push([
      report.tenantId,
      report.input,
      "cost_ceiling",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      report.costCeiling.maxUsdPerRequest,
      report.costCeiling.maxUsdPerWindow,
      report.costCeiling.windowSeconds,
      report.costCeiling.effectiveFrom,
      null,
      null,
      null,
    ]);
  }
  if (report.tier !== null) {
    rows.push([
      report.tenantId,
      report.input,
      "tier",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      report.tier.maxUsdPerRequest,
      report.tier.maxUsdPerWindow,
      report.tier.windowSeconds,
      null,
      report.tier.tierId,
      report.tier.displayName,
      null,
    ]);
  }
  if (report.effective !== undefined) {
    rows.push(buildEffectiveCsvRow(report, "effective", report.effective));
  }
  if (report.explain !== undefined) {
    rows.push(
      buildEffectiveCsvRow(report, "explain.without_override", report.explain.withoutOverride),
    );
    rows.push(buildEffectiveCsvRow(report, "explain.without_tier", report.explain.withoutTier));
  }
  return rows;
}

// Flatten one TenantPolicyEffective (effective OR explain.* sub-walk)
// into a row. `source="none"` rows have null ceilings — operators
// reading the CSV can filter on `effective_source = 'none'` to find
// tenants relying on the router-level global fallback.
function buildEffectiveCsvRow(
  report: TenantPoliciesReport,
  axis: string,
  eff: TenantPolicyEffective,
): ReadonlyArray<unknown> {
  if (eff.source === "none") {
    return [
      report.tenantId,
      report.input,
      axis,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "none",
    ];
  }
  return [
    report.tenantId,
    report.input,
    axis,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    eff.ceiling.maxUsdPerRequest,
    eff.ceiling.maxUsdPerWindow,
    eff.ceiling.windowSeconds,
    null,
    eff.source === "tier" ? eff.tierId : null,
    null,
    eff.source,
  ];
}

function buildPoliciesDiffCsvRows(
  reportA: TenantPoliciesReport,
  reportB: TenantPoliciesReport,
  fieldDiffs: ReadonlyArray<PolicyFieldDiff>,
): ReadonlyArray<ReadonlyArray<unknown>> {
  return fieldDiffs.map((d) => [
    reportA.tenantId,
    reportA.input,
    reportB.tenantId,
    reportB.input,
    d.axis,
    d.field,
    d.valueA ?? null,
    d.valueB ?? null,
  ]);
}

// Validates --csv-separator. Returns null if separator is valid (or
// not specified — defaults to ","), or an error message string on
// invalid input. Mirrors the retention.ts pattern: reject '"' and
// newlines (would produce ambiguous CSV that no parser can
// round-trip).
function validatePoliciesCsvSeparator(command: ParsedCommand): { separator: string } | string {
  const raw = getStringFlag(command, "csv-separator");
  if (raw === null) return { separator: "," };
  if (raw === '"' || /[\n\r]/.test(raw)) {
    return "--csv-separator cannot be '\"' or newline";
  }
  return { separator: raw };
}

// M4.14.f — field-level diff over the three policy axes. JSON-friendly
// flat list of {axis, field, valueA, valueB} entries; the field path
// uses dotted notation so consumers can render or filter on it.
// `undefined` for valueA/valueB means "axis or sub-axis absent on
// that side" (distinct from `null` which means "field present but
// explicitly NULL").
export interface PolicyFieldDiff {
  readonly axis: "retention" | "costCeiling" | "tier";
  readonly field: string;
  readonly valueA: string | number | boolean | null | undefined;
  readonly valueB: string | number | boolean | null | undefined;
}

export function computePolicyFieldDiffs(
  a: TenantPoliciesReport,
  b: TenantPoliciesReport,
): ReadonlyArray<PolicyFieldDiff> {
  const diffs: PolicyFieldDiff[] = [];

  // --- Retention axis: per-table comparison. Walk the UNION of table
  // names from both sides; for each table, if absent on either side
  // emit a single "exists" diff; if present on both, walk each policy
  // field.
  const tablesA = new Map(a.retention.tables.map((t) => [t.tableName, t] as const));
  const tablesB = new Map(b.retention.tables.map((t) => [t.tableName, t] as const));
  const allTables = new Set<string>([...tablesA.keys(), ...tablesB.keys()]);
  // Sort for deterministic output — operators reading the diff
  // shouldn't see fieldDiffs in random Map-iteration order.
  for (const tableName of [...allTables].sort()) {
    const ta = tablesA.get(tableName);
    const tb = tablesB.get(tableName);
    if (ta === undefined || tb === undefined) {
      diffs.push({
        axis: "retention",
        field: `retention.${tableName}.exists`,
        valueA: ta !== undefined,
        valueB: tb !== undefined,
      });
      continue;
    }
    const retentionFields: ReadonlyArray<keyof TenantPolicyRetentionEntry> = [
      "retentionDays",
      "enabled",
      "optOut",
      "optOutReason",
      "optOutUntil",
    ];
    for (const field of retentionFields) {
      if (ta[field] !== tb[field]) {
        diffs.push({
          axis: "retention",
          field: `retention.${tableName}.${field}`,
          valueA: ta[field],
          valueB: tb[field],
        });
      }
    }
  }

  // --- Cost ceiling axis: if either side has a row, compare each
  // numeric field. If only one side has a row, that's a single
  // "exists" diff (operator-readable; the individual numeric fields
  // would all show as undefined→value pairs which is noisier).
  if (a.costCeiling === null && b.costCeiling !== null) {
    diffs.push({
      axis: "costCeiling",
      field: "costCeiling.exists",
      valueA: false,
      valueB: true,
    });
  } else if (a.costCeiling !== null && b.costCeiling === null) {
    diffs.push({
      axis: "costCeiling",
      field: "costCeiling.exists",
      valueA: true,
      valueB: false,
    });
  } else if (a.costCeiling !== null && b.costCeiling !== null) {
    const ceilingFields: ReadonlyArray<keyof TenantCostCeilingRow> = [
      "maxUsdPerRequest",
      "maxUsdPerWindow",
      "windowSeconds",
    ];
    for (const field of ceilingFields) {
      if (a.costCeiling[field] !== b.costCeiling[field]) {
        diffs.push({
          axis: "costCeiling",
          field: `costCeiling.${field}`,
          valueA: a.costCeiling[field],
          valueB: b.costCeiling[field],
        });
      }
    }
  }

  // --- Tier axis: tier identity drives the comparison. If both
  // tenants share a tierId, the tier policy fields are identical by
  // construction (JOIN against same tier row) — no need to compare
  // them. If tiers differ, the tierId diff is enough; operators
  // wanting the full tier-policy comparison can rerun against the
  // tiers themselves.
  if (a.tier === null && b.tier !== null) {
    diffs.push({ axis: "tier", field: "tier.exists", valueA: false, valueB: true });
  } else if (a.tier !== null && b.tier === null) {
    diffs.push({ axis: "tier", field: "tier.exists", valueA: true, valueB: false });
  } else if (a.tier !== null && b.tier !== null && a.tier.tierId !== b.tier.tierId) {
    diffs.push({
      axis: "tier",
      field: "tier.tierId",
      valueA: a.tier.tierId,
      valueB: b.tier.tierId,
    });
  }

  return diffs;
}

function validateDiffThresholdFlag(command: ParsedCommand): string | null {
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

// M4.15.l — `tenant policies --diff --axis <axis>` substrate filter.
// 3 axes match PolicyFieldDiff.axis exactly: retention, costCeiling,
// tier. Validation pattern mirrors M4.15.h housekeeping --axis
// (returns error string on invalid value, null on absent/valid).
const POLICIES_DIFF_AXIS_VALUES = ["retention", "costCeiling", "tier"] as const;
type PoliciesDiffAxisValue = (typeof POLICIES_DIFF_AXIS_VALUES)[number];

function validatePoliciesAxisFlag(command: ParsedCommand): string | null {
  const raw = getStringFlag(command, "axis");
  if (raw === null) return null;
  if (!POLICIES_DIFF_AXIS_VALUES.includes(raw as PoliciesDiffAxisValue)) {
    return `invalid --axis '${raw}' (expected one of: ${POLICIES_DIFF_AXIS_VALUES.join(", ")})`;
  }
  return null;
}

function getPoliciesAxisFilter(command: ParsedCommand): PoliciesDiffAxisValue | null {
  const raw = getStringFlag(command, "axis");
  if (raw === null) return null;
  // validatePoliciesAxisFlag already ran in runTenantPoliciesDiff so
  // we can narrow without re-checking.
  return raw as PoliciesDiffAxisValue;
}

function filterFieldDiffsByAxis(
  diffs: ReadonlyArray<PolicyFieldDiff>,
  axis: PoliciesDiffAxisValue | null,
): ReadonlyArray<PolicyFieldDiff> {
  if (axis === null) return diffs;
  return diffs.filter((d) => d.axis === axis);
}

function diffDivergenceExitCode(command: ParsedCommand, fieldDiffsLength: number): number {
  if (!getBooleanFlag(command, "exit-on-divergence")) return 0;
  const thresholdRaw = getStringFlag(command, "threshold");
  const threshold = thresholdRaw === null ? 1 : Number(thresholdRaw);
  return fieldDiffsLength >= threshold ? 3 : 0;
}

function renderDiffValue(v: string | number | boolean | null | undefined): string {
  if (v === undefined) return "absent";
  if (v === null) return "<null>";
  return String(v);
}

function renderPoliciesDiffHuman(
  ctx: TenantContext,
  a: TenantPoliciesReport,
  b: TenantPoliciesReport,
  fieldDiffs: ReadonlyArray<PolicyFieldDiff>,
): void {
  ctx.io.stdout.write(`Diff between tenant policies:\n`);
  ctx.io.stdout.write(`  Left:  ${a.tenantId} (input: '${a.input}')\n`);
  ctx.io.stdout.write(`  Right: ${b.tenantId} (input: '${b.input}')\n`);
  ctx.io.stdout.write(`\n`);
  if (fieldDiffs.length === 0) {
    ctx.io.stdout.write(
      `No differences — both tenants have the same configured policy across all three axes.\n`,
    );
    return;
  }
  ctx.io.stdout.write(`Field changes (${fieldDiffs.length}):\n`);
  // Group by axis for readability; within an axis, preserve the order
  // computePolicyFieldDiffs emitted (table-sorted for retention,
  // schema order for ceiling).
  const byAxis = new Map<string, PolicyFieldDiff[]>();
  for (const d of fieldDiffs) {
    let list = byAxis.get(d.axis);
    if (list === undefined) {
      list = [];
      byAxis.set(d.axis, list);
    }
    list.push(d);
  }
  for (const axis of ["retention", "costCeiling", "tier"] as const) {
    const list = byAxis.get(axis);
    if (list === undefined) continue;
    ctx.io.stdout.write(`  [${axis}]\n`);
    for (const d of list) {
      const va = renderDiffValue(d.valueA);
      const vb = renderDiffValue(d.valueB);
      ctx.io.stdout.write(`    ${d.field.padEnd(48)} ${va}  →  ${vb}\n`);
    }
  }
}

// M4.15.s — Human-readable axis labels for gh-summary section
// headers + verdict lines. When --axis is set, every fieldDiff has
// the same axis (filter narrows post-compute) so the section header
// reflects that scope and the Axis column drops out of the table
// (redundant). Labels are sentence-case for use mid-line ("Retention
// field changes" reads better than "retention field changes" in a
// CI step summary).
const POLICIES_AXIS_LABELS: Record<PoliciesDiffAxisValue, string> = {
  retention: "Retention",
  costCeiling: "Cost ceiling",
  tier: "Tier",
};

// M4.15.e — Markdown summary for GitHub Step Summary integration.
// Operators redirect `crossengin tenant policies <a> --diff <b>
// --format gh-summary >> $GITHUB_STEP_SUMMARY` from CI workflows
// to surface diff results in the run UI. Output is Markdown with
// a header (anchor/left/right metadata) + field-changes table +
// summary footer indicating divergence count. Verdict emoji
// (`:white_check_mark:` / `:warning:`) gives a one-glance
// signal whether the gate passed.
//
// M4.15.s — When `axisFilter` is set (from `--axis` flag in M4.15.l),
// the title, section header, and verdict text reflect that scope
// ("## Diff: tenant policies (retention axis)" / "### Retention
// field changes (N)" / ":warning: Retention divergence detected").
// The Axis column also drops out of the table since every row
// shares the same axis — saves horizontal space for the value
// columns which can be wide.
function renderPoliciesDiffGhSummary(
  ctx: TenantContext,
  a: TenantPoliciesReport,
  b: TenantPoliciesReport,
  fieldDiffs: ReadonlyArray<PolicyFieldDiff>,
  axisFilter: PoliciesDiffAxisValue | null = null,
): void {
  const axisLabel = axisFilter !== null ? POLICIES_AXIS_LABELS[axisFilter] : null;
  const titleSuffix = axisLabel !== null ? ` (${axisFilter} axis)` : "";
  ctx.io.stdout.write(`## Diff: tenant policies${titleSuffix}\n\n`);
  ctx.io.stdout.write(`**Left:** \`${a.tenantId}\` (input: \`${a.input}\`)  \n`);
  ctx.io.stdout.write(`**Right:** \`${b.tenantId}\` (input: \`${b.input}\`)\n\n`);
  if (fieldDiffs.length === 0) {
    const matchText =
      axisLabel !== null
        ? `**No ${axisLabel.toLowerCase()} differences** — both tenants match on this axis.`
        : `**No differences** — both tenants match.`;
    ctx.io.stdout.write(`:white_check_mark: ${matchText}\n`);
    return;
  }
  const sectionTitle =
    axisLabel !== null
      ? `### ${axisLabel} field changes (${fieldDiffs.length})`
      : `### Field changes (${fieldDiffs.length})`;
  ctx.io.stdout.write(`${sectionTitle}\n\n`);
  if (axisFilter !== null) {
    // Drop Axis column — every row has the same value.
    ctx.io.stdout.write(`| Field | Left | Right |\n`);
    ctx.io.stdout.write(`|-------|------|-------|\n`);
    for (const d of fieldDiffs) {
      ctx.io.stdout.write(
        `| \`${d.field}\` | ${formatMdValue(d.valueA)} | ${formatMdValue(d.valueB)} |\n`,
      );
    }
  } else {
    ctx.io.stdout.write(`| Axis | Field | Left | Right |\n`);
    ctx.io.stdout.write(`|------|-------|------|-------|\n`);
    for (const d of fieldDiffs) {
      ctx.io.stdout.write(
        `| ${d.axis} | \`${d.field}\` | ${formatMdValue(d.valueA)} | ${formatMdValue(d.valueB)} |\n`,
      );
    }
  }
  const verdictText =
    axisLabel !== null
      ? `**${axisLabel} divergence detected** — ${fieldDiffs.length} field(s) differ.`
      : `**Divergence detected** — ${fieldDiffs.length} field(s) differ.`;
  ctx.io.stdout.write(`\n:warning: ${verdictText}\n`);
}

// M4.15.e — Markdown summary for N-way policies diff. Emits one
// `### Comparison i/N: ...` section per pair, each followed by
// its own field-changes table. Operators reading the summary in
// the GitHub UI can collapse-expand sections via the natural
// Markdown heading hierarchy. Summary footer reports max
// divergence + total comparisons.
//
// M4.15.s — When `axisFilter` is set (from --axis flag), the title
// reflects scope ("## Multi-comparison diff: tenant policies
// (retention axis)"), per-comparison tables drop the Axis column,
// and the verdict text mentions the axis. Same shape conventions
// as the pair-wise renderer.
function renderPoliciesMultiDiffGhSummary(
  ctx: TenantContext,
  anchor: TenantPoliciesReport,
  comparisons: ReadonlyArray<{
    readonly right: TenantPoliciesReport;
    readonly fieldDiffs: ReadonlyArray<PolicyFieldDiff>;
  }>,
  axisFilter: PoliciesDiffAxisValue | null = null,
): void {
  const axisLabel = axisFilter !== null ? POLICIES_AXIS_LABELS[axisFilter] : null;
  const titleSuffix = axisLabel !== null ? ` (${axisFilter} axis)` : "";
  ctx.io.stdout.write(`## Multi-comparison diff: tenant policies${titleSuffix}\n\n`);
  ctx.io.stdout.write(`**Anchor:** \`${anchor.tenantId}\` (input: \`${anchor.input}\`)  \n`);
  ctx.io.stdout.write(`**Comparisons:** ${comparisons.length}\n\n`);
  let maxDivergence = 0;
  for (let i = 0; i < comparisons.length; i++) {
    const c = comparisons[i]!;
    maxDivergence = Math.max(maxDivergence, c.fieldDiffs.length);
    ctx.io.stdout.write(
      `### Comparison ${i + 1}/${comparisons.length}: vs \`${c.right.tenantId}\` (${c.fieldDiffs.length} difference${c.fieldDiffs.length === 1 ? "" : "s"})\n\n`,
    );
    if (c.fieldDiffs.length === 0) {
      ctx.io.stdout.write(`:white_check_mark: No differences.\n\n`);
      continue;
    }
    if (axisFilter !== null) {
      ctx.io.stdout.write(`| Field | Left | Right |\n`);
      ctx.io.stdout.write(`|-------|------|-------|\n`);
      for (const d of c.fieldDiffs) {
        ctx.io.stdout.write(
          `| \`${d.field}\` | ${formatMdValue(d.valueA)} | ${formatMdValue(d.valueB)} |\n`,
        );
      }
    } else {
      ctx.io.stdout.write(`| Axis | Field | Left | Right |\n`);
      ctx.io.stdout.write(`|------|-------|------|-------|\n`);
      for (const d of c.fieldDiffs) {
        ctx.io.stdout.write(
          `| ${d.axis} | \`${d.field}\` | ${formatMdValue(d.valueA)} | ${formatMdValue(d.valueB)} |\n`,
        );
      }
    }
    ctx.io.stdout.write(`\n`);
  }
  ctx.io.stdout.write(`---\n\n`);
  ctx.io.stdout.write(
    `**Summary:** ${comparisons.length} comparisons, max divergence ${maxDivergence} field${maxDivergence === 1 ? "" : "s"}.\n`,
  );
  if (maxDivergence === 0) {
    const matchText =
      axisLabel !== null
        ? `**All comparisons match on the ${axisFilter} axis.**`
        : `**All comparisons match.**`;
    ctx.io.stdout.write(`:white_check_mark: ${matchText}\n`);
  } else {
    const verdictText =
      axisLabel !== null
        ? `**${axisLabel} divergence detected** in at least one comparison.`
        : `**Divergence detected** in at least one comparison.`;
    ctx.io.stdout.write(`:warning: ${verdictText}\n`);
  }
}

// M4.15.e — Markdown summary for single-comparison housekeeping
// diff. Extra `Table` column compared to policies since
// HousekeepingFieldDiff keys by (axis, tableName, field).
// M4.15.s mirror — sentence-case axis labels for gh-summary section
// headers + verdict lines. 2-axis (gateway/retention) vs policies'
// 3-axis. When --axis is set, every fieldDiff has the same axis so
// the section header reflects that scope + the Axis column drops
// out of the table (redundant).
const HOUSEKEEPING_AXIS_LABELS: Record<"gateway" | "retention", string> = {
  gateway: "Gateway",
  retention: "Retention",
};

// M4.15.ah — When `axisFilter` is set (from --axis gateway|retention),
// the title, section header, and verdict text reflect that scope
// ("## Diff: tenant housekeeping (gateway axis)" / "### Gateway field
// changes (N)" / ":warning: Gateway divergence detected"). Axis
// column drops from the table (every row shares the same axis).
// Mirrors M4.15.s policies axis-aware treatment exactly (2-axis vs
// 3-axis only difference).
function renderHousekeepingDiffGhSummary(
  ctx: TenantContext,
  left: { readonly tenantId: string; readonly input: string },
  right: { readonly tenantId: string; readonly input: string },
  fieldDiffs: ReadonlyArray<HousekeepingFieldDiff>,
  axisFilter: "gateway" | "retention" | null = null,
): void {
  const axisLabel = axisFilter !== null ? HOUSEKEEPING_AXIS_LABELS[axisFilter] : null;
  const titleSuffix = axisLabel !== null ? ` (${axisFilter} axis)` : "";
  ctx.io.stdout.write(`## Diff: tenant housekeeping${titleSuffix}\n\n`);
  ctx.io.stdout.write(`**Left:** \`${left.tenantId}\` (input: \`${left.input}\`)  \n`);
  ctx.io.stdout.write(`**Right:** \`${right.tenantId}\` (input: \`${right.input}\`)\n\n`);
  if (fieldDiffs.length === 0) {
    const matchText =
      axisLabel !== null
        ? `**No ${axisLabel.toLowerCase()} differences** — both tenants match on this axis.`
        : `**No differences** — both tenants match.`;
    ctx.io.stdout.write(`:white_check_mark: ${matchText}\n`);
    return;
  }
  const sectionTitle =
    axisLabel !== null
      ? `### ${axisLabel} field changes (${fieldDiffs.length})`
      : `### Field changes (${fieldDiffs.length})`;
  ctx.io.stdout.write(`${sectionTitle}\n\n`);
  if (axisFilter !== null) {
    // Drop Axis column — every row has the same value.
    ctx.io.stdout.write(`| Table | Field | Left | Right |\n`);
    ctx.io.stdout.write(`|-------|-------|------|-------|\n`);
    for (const d of fieldDiffs) {
      ctx.io.stdout.write(
        `| \`${d.tableName}\` | \`${d.field}\` | ${formatMdValue(d.valueA)} | ${formatMdValue(d.valueB)} |\n`,
      );
    }
  } else {
    ctx.io.stdout.write(`| Axis | Table | Field | Left | Right |\n`);
    ctx.io.stdout.write(`|------|-------|-------|------|-------|\n`);
    for (const d of fieldDiffs) {
      ctx.io.stdout.write(
        `| ${d.axis} | \`${d.tableName}\` | \`${d.field}\` | ${formatMdValue(d.valueA)} | ${formatMdValue(d.valueB)} |\n`,
      );
    }
  }
  const verdictText =
    axisLabel !== null
      ? `**${axisLabel} divergence detected** — ${fieldDiffs.length} field(s) differ.`
      : `**Divergence detected** — ${fieldDiffs.length} field(s) differ.`;
  ctx.io.stdout.write(`\n:warning: ${verdictText}\n`);
}

// M4.15.e — Markdown summary for N-way housekeeping diff. Same
// shape as policies multi but with the 5-column housekeeping
// table (extra Table column).
//
// M4.15.ah — When `axisFilter` is set, title gets suffix
// "(gateway axis)" or "(retention axis)", per-comparison tables
// drop the Axis column, and verdict text mentions the axis.
// Mirrors M4.15.s policies N-way axis-aware shape exactly.
function renderHousekeepingMultiDiffGhSummary(
  ctx: TenantContext,
  anchor: { readonly tenantId: string; readonly input: string },
  comparisons: ReadonlyArray<{
    readonly right: { readonly tenantId: string; readonly input: string };
    readonly fieldDiffs: ReadonlyArray<HousekeepingFieldDiff>;
  }>,
  axisFilter: "gateway" | "retention" | null = null,
): void {
  const axisLabel = axisFilter !== null ? HOUSEKEEPING_AXIS_LABELS[axisFilter] : null;
  const titleSuffix = axisLabel !== null ? ` (${axisFilter} axis)` : "";
  ctx.io.stdout.write(`## Multi-comparison diff: tenant housekeeping${titleSuffix}\n\n`);
  ctx.io.stdout.write(`**Anchor:** \`${anchor.tenantId}\` (input: \`${anchor.input}\`)  \n`);
  ctx.io.stdout.write(`**Comparisons:** ${comparisons.length}\n\n`);
  let maxDivergence = 0;
  for (let i = 0; i < comparisons.length; i++) {
    const c = comparisons[i]!;
    maxDivergence = Math.max(maxDivergence, c.fieldDiffs.length);
    ctx.io.stdout.write(
      `### Comparison ${i + 1}/${comparisons.length}: vs \`${c.right.tenantId}\` (${c.fieldDiffs.length} difference${c.fieldDiffs.length === 1 ? "" : "s"})\n\n`,
    );
    if (c.fieldDiffs.length === 0) {
      ctx.io.stdout.write(`:white_check_mark: No differences.\n\n`);
      continue;
    }
    if (axisFilter !== null) {
      ctx.io.stdout.write(`| Table | Field | Left | Right |\n`);
      ctx.io.stdout.write(`|-------|-------|------|-------|\n`);
      for (const d of c.fieldDiffs) {
        ctx.io.stdout.write(
          `| \`${d.tableName}\` | \`${d.field}\` | ${formatMdValue(d.valueA)} | ${formatMdValue(d.valueB)} |\n`,
        );
      }
    } else {
      ctx.io.stdout.write(`| Axis | Table | Field | Left | Right |\n`);
      ctx.io.stdout.write(`|------|-------|-------|------|-------|\n`);
      for (const d of c.fieldDiffs) {
        ctx.io.stdout.write(
          `| ${d.axis} | \`${d.tableName}\` | \`${d.field}\` | ${formatMdValue(d.valueA)} | ${formatMdValue(d.valueB)} |\n`,
        );
      }
    }
    ctx.io.stdout.write(`\n`);
  }
  ctx.io.stdout.write(`---\n\n`);
  ctx.io.stdout.write(
    `**Summary:** ${comparisons.length} comparisons, max divergence ${maxDivergence} field${maxDivergence === 1 ? "" : "s"}.\n`,
  );
  if (maxDivergence === 0) {
    const matchText =
      axisLabel !== null
        ? `**All comparisons match on the ${axisFilter} axis.**`
        : `**All comparisons match.**`;
    ctx.io.stdout.write(`:white_check_mark: ${matchText}\n`);
  } else {
    const verdictText =
      axisLabel !== null
        ? `**${axisLabel} divergence detected** in at least one comparison.`
        : `**Divergence detected** in at least one comparison.`;
    ctx.io.stdout.write(`:warning: ${verdictText}\n`);
  }
}

// Markdown-safe value formatter. `null`/`undefined` → `\`null\``
// for visibility (operators reading the summary need to
// distinguish "absent" from "empty string"). Booleans and numbers
// stringified directly. Strings backtick-wrapped to inhibit
// Markdown interpretation of special chars (asterisks, pipes,
// etc.) and to make the value visually distinct.
function formatMdValue(v: string | number | boolean | null | undefined): string {
  if (v == null) return `\`null\``;
  if (typeof v === "boolean" || typeof v === "number") return `\`${String(v)}\``;
  // Pipes in strings would break Markdown table cells; escape them.
  // Backticks would break the wrapping; escape those too.
  const safe = String(v).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/`/g, "\\`");
  return `\`${safe}\``;
}
