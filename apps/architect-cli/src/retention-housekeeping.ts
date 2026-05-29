import {
  createNodePgConnection,
  parsePgEnvConfig,
  PostgresTraceRetention,
  type PgConnection,
} from "@crossengin/kernel-pg";

import type { ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import { printError, printJson } from "./format.js";
import {
  parseWatchFlags,
  runHousekeepingWatchLoop,
  type WatchOverride,
} from "./housekeeping-watch.js";

// The 6 PRUNABLE_TABLES entries that PostgresTraceRetention.knownPrunableTables()
// surfaces. Hardcoded with their time columns so the helper can issue
// `SELECT COUNT(*), MIN(<col>)` per table — the substrate doesn't expose the
// timeColumn publicly, and operator-curated listing is more honest than a
// fragile dynamic introspection.
//
// Includes the gateway tables (gateway_pipeline_executions, rate_limit_decisions)
// so `retention housekeeping` is the substrate-centric view across every
// retention-substrate-governed table; the gateway-domain view from M4.14
// (gateway housekeeping) is the operator-domain complement which also covers
// gateway_idempotency_records (NOT retention-governed — own expires_at TTL).
interface RetentionTableSpec {
  readonly tableName: string;
  readonly timeColumn: string;
}

const RETENTION_HOUSEKEEPING_TABLES: ReadonlyArray<RetentionTableSpec> = [
  { tableName: "workflow_traces", timeColumn: "occurred_at" },
  { tableName: "llm_call_traces", timeColumn: "occurred_at" },
  { tableName: "llm_latency_samples", timeColumn: "recorded_at" },
  { tableName: "tenant_retention_opt_out_history", timeColumn: "occurred_at" },
  { tableName: "gateway_pipeline_executions", timeColumn: "started_at" },
  { tableName: "rate_limit_decisions", timeColumn: "decided_at" },
];

export interface RetentionHousekeepingTableReport {
  readonly tableName: string;
  readonly totalRowCount: number;
  readonly oldestAt: string | null;
  readonly wouldPruneCount: number;
  readonly retentionDays: number | null;
  readonly enabled: boolean | null;
  readonly lastPrunedAt: string | null;
  readonly perTenantPolicyCount: number;
}

export interface RetentionHousekeepingReport {
  readonly asOf: string;
  readonly tables: ReadonlyArray<RetentionHousekeepingTableReport>;
}

export interface GatherRetentionHousekeepingInput {
  readonly conn: PgConnection;
  readonly retention: PostgresTraceRetention;
  readonly now: Date;
}

export async function gatherRetentionHousekeepingReport(
  input: GatherRetentionHousekeepingInput,
): Promise<RetentionHousekeepingReport> {
  const platformPolicies = await input.retention.listPolicies();
  const platformByTable = new Map(platformPolicies.map((p) => [p.tableName, p]));
  const tenantPolicies = await input.retention.listTenantPolicies();
  const tenantCountByTable = new Map<string, number>();
  for (const p of tenantPolicies) {
    tenantCountByTable.set(p.tableName, (tenantCountByTable.get(p.tableName) ?? 0) + 1);
  }
  const previewEntries = await input.retention.previewPrune();
  // Sum platform-level wouldDeleteCount per table; per-tenant entries are
  // distinct rows in the preview result, and the housekeeping dashboard
  // surfaces the platform sweep total (per-tenant detail stays under
  // `retention list-policies --tenant`).
  const previewByTable = new Map<string, number>();
  for (const entry of previewEntries) {
    if (entry.tenantId !== undefined) continue;
    if (entry.status !== "previewed") continue;
    previewByTable.set(entry.tableName, entry.wouldDeleteCount);
  }

  const tables: RetentionHousekeepingTableReport[] = [];
  for (const spec of RETENTION_HOUSEKEEPING_TABLES) {
    const stats = await queryTableStats(input.conn, spec);
    const platformPolicy = platformByTable.get(spec.tableName);
    tables.push({
      tableName: spec.tableName,
      totalRowCount: stats.totalRowCount,
      oldestAt: stats.oldestAt,
      wouldPruneCount: previewByTable.get(spec.tableName) ?? 0,
      retentionDays: platformPolicy?.retentionDays ?? null,
      enabled: platformPolicy?.enabled ?? null,
      lastPrunedAt: platformPolicy?.lastPrunedAt ?? null,
      perTenantPolicyCount: tenantCountByTable.get(spec.tableName) ?? 0,
    });
  }
  return { asOf: input.now.toISOString(), tables };
}

async function queryTableStats(
  conn: PgConnection,
  spec: RetentionTableSpec,
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

export interface RetentionHousekeepingContext extends RunContext {
  readonly pgConnectionOverride?: PgConnection;
  readonly retentionOverride?: PostgresTraceRetention;
  readonly clockOverride?: () => Date;
  // M4.14.w — `--watch` mode test-injection hooks (production-side leaves
  // undefined and the watch loop uses real setTimeout + runs forever).
  readonly watchOverride?: WatchOverride;
}

export async function runRetentionHousekeeping(
  command: ParsedCommand,
  ctx: RetentionHousekeepingContext,
): Promise<number> {
  // Parse --watch + --watch-interval BEFORE PG resolution so misuse exits
  // cleanly without burning a connection.
  const watchFlags = parseWatchFlags(command, ctx.io, "retention housekeeping");
  if (typeof watchFlags === "number") return watchFlags;

  let conn: PgConnection | null = null;
  let closeConn: () => Promise<void> = async () => undefined;
  try {
    if (ctx.pgConnectionOverride !== undefined) {
      conn = ctx.pgConnectionOverride;
    } else {
      try {
        const config = parsePgEnvConfig(ctx.env);
        conn = createNodePgConnection(config);
        closeConn = async () => {
          await conn?.close().catch(() => undefined);
        };
      } catch (err) {
        printError(
          ctx.io,
          `retention housekeeping: requires PG env vars (PGHOST/PGDATABASE/...): ${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }
    }
    const retention = ctx.retentionOverride ?? new PostgresTraceRetention({ conn });

    // Shared gather/render closures used by both single-shot and watch modes.
    // gather() reads the clock per call so each watch tick reflects current
    // time (operators expect `asOf` to move).
    const activeConn = conn;
    const gather = async (): Promise<RetentionHousekeepingReport> => {
      const now = ctx.clockOverride !== undefined ? ctx.clockOverride() : new Date();
      return await gatherRetentionHousekeepingReport({ conn: activeConn, retention, now });
    };

    try {
      if (watchFlags.watch) {
        const isJson = command.format === "json";
        await runHousekeepingWatchLoop<RetentionHousekeepingReport>({
          gather,
          // JSON streaming uses compact one-line NDJSON-of-envelopes
          // (no indent). Human format uses the same multi-section text
          // renderer as single-shot but with screen-clearing handled by
          // the loop itself.
          render: isJson
            ? (report) =>
                ctx.io.stdout.write(
                  JSON.stringify({ action: "retention.housekeeping", ...report }) + "\n",
                )
            : (report) => renderHumanReport(ctx, report),
          clearScreenBeforeRender: !isJson,
          io: ctx.io,
          options: {
            intervalMs: watchFlags.intervalSeconds * 1000,
            maxIterations: ctx.watchOverride?.maxIterations,
            abortSignal: ctx.watchOverride?.abortSignal,
            setTimeoutFn: ctx.watchOverride?.setTimeoutFn,
            clearTimeoutFn: ctx.watchOverride?.clearTimeoutFn,
          },
        });
        return 0;
      }
      const report = await gather();
      if (command.format === "json") {
        printJson(ctx.io, { action: "retention.housekeeping", ...report });
      } else {
        renderHumanReport(ctx, report);
      }
      return 0;
    } catch (err) {
      printError(
        ctx.io,
        `retention housekeeping: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  } finally {
    await closeConn();
  }
}

function renderHumanReport(
  ctx: RetentionHousekeepingContext,
  report: RetentionHousekeepingReport,
): void {
  ctx.io.stdout.write(`retention housekeeping (as of ${report.asOf}):\n`);
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
