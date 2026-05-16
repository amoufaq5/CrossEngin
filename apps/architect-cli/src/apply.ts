import { emitMetaBootstrapSql, META_SCHEMA_NAME, META_TABLES } from "@crossengin/kernel/bootstrap";
import {
  MigrationApplier,
  createNodePgConnection,
  formatApplyReport,
  looksLikeProductionDatabase,
  parsePgEnvConfig,
} from "@crossengin/kernel-pg";

import type { ParsedCommand } from "./cli.js";
import { getBooleanFlag } from "./cli.js";
import { printError, printJson, printSuccess, type IoStreams } from "./format.js";
import type { RunContext } from "./commands.js";

export async function runApply(
  command: ParsedCommand,
  ctx: RunContext,
): Promise<number> {
  const dryRun = getBooleanFlag(command, "dry-run");
  const confirm = getBooleanFlag(command, "confirm");
  if (dryRun) {
    return emitDryRun(ctx.io, command);
  }
  let config: ReturnType<typeof parsePgEnvConfig>;
  try {
    config = parsePgEnvConfig(ctx.env);
  } catch (err) {
    printError(ctx.io, `apply: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (looksLikeProductionDatabase(config.database) && !confirm) {
    printError(
      ctx.io,
      `apply: refusing to apply against production-looking database '${config.database}' without --confirm`,
    );
    return 2;
  }
  const conn = createNodePgConnection(config);
  try {
    const applier = new MigrationApplier({
      connection: conn,
      schema: META_SCHEMA_NAME,
      statements: emitMetaBootstrapSql(),
    });
    const report = await applier.apply();
    if (command.format === "json") {
      printJson(ctx.io, report);
    } else {
      printSuccess(ctx.io, formatApplyReport(report));
    }
    if (!report.preconditions.ok || report.failed > 0) return 1;
    return 0;
  } catch (err) {
    printError(ctx.io, `apply: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await conn.close().catch(() => undefined);
  }
}

function emitDryRun(io: IoStreams, command: ParsedCommand): number {
  const statements = emitMetaBootstrapSql();
  if (command.format === "json") {
    printJson(io, {
      schema: META_SCHEMA_NAME,
      tableCount: META_TABLES.length,
      statementCount: statements.length,
      statements,
    });
    return 0;
  }
  for (const stmt of statements) {
    io.stdout.write(stmt + "\n");
  }
  io.stdout.write(`-- ${statements.length.toString()} statement(s); ${META_TABLES.length.toString()} tables\n`);
  return 0;
}
