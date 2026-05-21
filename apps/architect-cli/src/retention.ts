import {
  createNodePgConnection,
  parsePgEnvConfig,
  PostgresTraceRetention,
  type ExpiringOptOut,
  type PgConnection,
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
      "retention: missing action. usage: crossengin retention <expiring> [args]",
    );
    return 2;
  }
  const handle = await resolveRetention(ctx);
  if (handle === null) return 1;
  try {
    switch (action) {
      case "expiring":
        return await runRetentionExpiring(command, ctx, handle.retention);
      default:
        printError(
          ctx.io,
          `retention: unknown action '${action}'. expected one of: expiring`,
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
