import type { PgConnection } from "@crossengin/kernel-pg";
import { PostgresIdempotencyStore } from "@crossengin/api-gateway-pg";
import { PostgresTraceRetention } from "@crossengin/kernel-pg";

import type { ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import { printError, printJson } from "./format.js";
import {
  parseWatchFlags,
  runHousekeepingWatchLoop,
  type WatchOverride,
} from "./housekeeping-watch.js";

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
}

export interface HousekeepingReport {
  readonly asOf: string;
  readonly tables: ReadonlyArray<HousekeepingTableReport>;
}

export interface GatherHousekeepingInput {
  readonly conn: PgConnection;
  readonly retention: PostgresTraceRetention;
  readonly idempotencyStore: PostgresIdempotencyStore;
  readonly now: Date;
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
    tables.push({
      tableName: spec.tableName,
      pruneSemantic: spec.pruneSemantic,
      totalRowCount: stats.totalRowCount,
      oldestAt: stats.oldestAt,
      wouldPruneCount: wouldPrune,
      retentionDays,
      lastPrunedAt,
    });
  }
  return { asOf: input.now.toISOString(), tables };
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
    return await gatherHousekeepingReport({ conn, retention, idempotencyStore, now });
  };

  try {
    if (watchFlags.watch) {
      const isJson = command.format === "json";
      await runHousekeepingWatchLoop<HousekeepingReport>({
        gather,
        // JSON streaming = compact NDJSON-of-envelopes; human = multi-section
        // text with screen-clearing handled by the loop.
        render: isJson
          ? (report) =>
              ctx.io.stdout.write(
                JSON.stringify({ action: "gateway.housekeeping", ...report }) + "\n",
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
      printJson(ctx.io, { action: "gateway.housekeeping", ...report });
    } else {
      renderHumanReport(ctx, report);
    }
    return 0;
  } catch (err) {
    printError(ctx.io, `gateway housekeeping: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function renderHumanReport(ctx: HousekeepingContext, report: HousekeepingReport): void {
  ctx.io.stdout.write(`gateway housekeeping (as of ${report.asOf}):\n`);
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
