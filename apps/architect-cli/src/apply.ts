import {
  emitMetaBootstrapSql,
  emitSchemaCreate,
  META_SCHEMA_NAME,
  META_TABLES,
} from "@crossengin/kernel/bootstrap";
import {
  MigrationApplier,
  applyFailures,
  createNodePgConnection,
  formatApplyReport,
  formatReconciliationPlan,
  looksLikeProductionDatabase,
  parsePgEnvConfig,
  planLiveReconciliation,
  type ApplyReport,
  type ApplyStatementRecord,
  type ReconciliationPlan,
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
  const planOnly = getBooleanFlag(command, "plan");
  const confirm = getBooleanFlag(command, "confirm");
  // The one reconciliation refusal an operator can override (ADR-0328). It has existed on
  // `ReconciliationOptions` since ADR-0308 with no way to pass it, so the four kill-switch
  // `meta.users` foreign keys ADR-0296 removed from the catalog have been reported as undeclared
  // drift on every existing deployment since, with no way to drop them but by hand. It reaches
  // **foreign keys only**, because dropping one is the single loosening that cannot fail against
  // existing rows — which is what keeps ADR-0290's "every step in the plan is expected to succeed"
  // true.
  const allowLoosening = getBooleanFlag(command, "allow-loosening");
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
    // Reconcile against the live schema rather than replaying the bootstrap SQL. On an empty
    // database the plan *is* the bootstrap SQL, so a fresh install is unchanged; on a database
    // that already has the schema, only the differences are applied — which is what lets an
    // edited table definition migrate instead of re-running `CREATE TABLE` and halting.
    const plan = await planLiveReconciliation(conn, META_SCHEMA_NAME, META_TABLES, {
      ...(allowLoosening ? { allowLoosening: true } : {}),
    });
    if (planOnly) {
      if (command.format === "json") {
        printJson(ctx.io, plan);
      } else {
        printSuccess(ctx.io, formatReconciliationPlan(plan));
      }
      return 0;
    }
    if (allowLoosening) {
      // Said out loud before anything runs: this is the one invocation that *removes* a constraint
      // the database is currently enforcing, and the apply report alone would not say so.
      printError(
        ctx.io,
        "apply: --allow-loosening — undeclared foreign keys will be DROPPED rather than reported",
      );
    }
    const applier = new MigrationApplier({
      connection: conn,
      schema: META_SCHEMA_NAME,
      statements: [emitSchemaCreate(META_SCHEMA_NAME), ...plan.statements],
      // The plan was computed from the live schema, so every statement in it is needed; the hash
      // log records what ran, not what the database holds, and skipping on it here would leave a
      // dropped object missing.
      skipApplied: false,
      // Continue past a failed statement. The plan is built to succeed and its steps are largely
      // independent, so one refused ALTER must not hide the thirty additions behind it.
      stopOnFailure: false,
    });
    const report = await applier.apply();
    if (command.format === "json") {
      printJson(ctx.io, applyJsonPayload(report, plan));
    } else {
      printSuccess(ctx.io, formatApplyReport(report));
      if (plan.unreconciled.length > 0) {
        printSuccess(ctx.io, formatReconciliationPlan(plan));
      }
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

export interface ApplyJsonPayload {
  readonly report: ApplyReport;
  readonly plan: ReconciliationPlan;
  /**
   * The failed statements, lifted out of `report.statements` so a consumer sees each failure's SQL
   * and error without walking 800 outcome entries to find them.
   */
  readonly failures: readonly ApplyStatementRecord[];
}

export function applyJsonPayload(
  report: ApplyReport,
  plan: ReconciliationPlan,
): ApplyJsonPayload {
  return { report, plan, failures: applyFailures(report) };
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
