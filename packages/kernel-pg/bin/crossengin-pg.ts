#!/usr/bin/env node

import {
  META_SCHEMA_NAME,
  META_TABLES,
  emitMetaBootstrapSql,
} from "@crossengin/kernel/bootstrap";

import { MigrationApplier, formatApplyReport } from "../src/applier.js";
import {
  type PgConnection,
  looksLikeProductionDatabase,
  parsePgEnvConfig,
} from "../src/connection.js";
import { diffSchema, expressionRequestsFor, formatSchemaDiff } from "../src/diff.js";
import { renderExpressions } from "../src/expression-render.js";
import { formatReconciliationPlan, planLiveReconciliation } from "../src/reconcile.js";
import {
  EncryptionApplier,
  formatEncryptionCoverage,
} from "../src/encryption.js";
import {
  EncryptionMigrator,
  formatEncryptionPlan,
} from "../src/encryption-migration.js";
import { introspectSchema } from "../src/introspection.js";
import { createNodePgConnection } from "../src/node-pg.js";

const CLI_VERSION = "0.0.0";
const DEFAULT_KEY_REF = "current_setting('app.column_encryption_key')";

type Command = "apply" | "drift" | "inspect" | "encrypt" | "version" | "help";

function flagValue(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

function parseCommand(argv: readonly string[]): { command: Command; flags: ReadonlySet<string> } {
  const positional = argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const flags = new Set(argv.slice(2).filter((arg) => arg.startsWith("--") && !arg.includes("=")));
  const first = positional[0];
  if (first === undefined || first === "help" || flags.has("--help")) {
    return { command: "help", flags };
  }
  if (
    first === "apply" ||
    first === "drift" ||
    first === "inspect" ||
    first === "encrypt" ||
    first === "version"
  ) {
    return { command: first, flags };
  }
  return { command: "help", flags };
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: crossengin-pg <command> [flags]",
      "",
      "Commands:",
      "  apply                Reconcile the meta-schema with the database",
      "  apply --dry-run      Print the full bootstrap SQL without running it",
      "  apply --plan         Introspect and print the reconciliation plan without running it",
      "  apply --allow-loosening  Also DROP foreign keys the catalog no longer declares",
      "  drift                Introspect the live schema and report drift vs META_TABLES",
      "  inspect              Print the live schema as JSON",
      "  encrypt --verify     Report at-rest encryption coverage for hinted columns",
      "  encrypt --plan       Print the encrypt-on-write migration SQL (dry-run)",
      "  encrypt --apply      Run the encrypt-on-write migration",
      "  version              Print the applier version and META_TABLES count",
      "  help                 Show this help text",
      "",
      "Flags:",
      "  --dry-run            With apply, emit SQL without executing",
      "  --confirm            Required when PGDATABASE looks like production",
      "  --exit-zero-on-drift With drift, do not exit non-zero when drift exists",
      "  --json               With drift/inspect, emit JSON instead of human form",
      "  --schema=<name>      With encrypt, the schema to operate on (default: meta)",
      "  --key-ref=<sql>      With encrypt --plan/--apply, the SQL key reference",
      "                       (default: current_setting('app.column_encryption_key'))",
      "  --provision          With encrypt --apply, CREATE EXTENSION pgcrypto first",
      "  --verify|--plan|--apply  encrypt action (default: --plan)",
      "",
      "Environment:",
      "  PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE, PGAPPNAME",
      "",
    ].join("\n"),
  );
}

async function runApply(flags: ReadonlySet<string>): Promise<number> {
  if (flags.has("--dry-run")) {
    const statements = emitMetaBootstrapSql();
    for (const s of statements) process.stdout.write(s + "\n");
    process.stdout.write(`-- ${statements.length} statement(s)\n`);
    return 0;
  }
  const config = parsePgEnvConfig();
  if (looksLikeProductionDatabase(config.database) && !flags.has("--confirm")) {
    process.stderr.write(
      `Refusing to apply against production-looking database '${config.database}' without --confirm.\n`,
    );
    return 2;
  }
  const conn: PgConnection = createNodePgConnection(config);
  try {
    // Same reconciliation path as `crossengin apply`: replaying the bootstrap SQL against a
    // database that already has the schema re-runs CREATE TABLE and halts.
    // `--allow-loosening` is the one reconciliation refusal an operator can override from here
    // (ADR-0328). It has existed on `ReconciliationOptions` since ADR-0308 and nothing could pass
    // it, so the four kill-switch `meta.users` foreign keys ADR-0296 removed from the catalog have
    // been reported as undeclared drift on every existing deployment ever since, with no way to
    // drop them but by hand. It reaches **foreign keys only** — not a column, table, index, policy
    // or CHECK — because dropping a foreign key is the one loosening that cannot fail against
    // existing rows, which is what keeps ADR-0290's "every step is expected to succeed" true.
    const allowLoosening = flags.has("--allow-loosening");
    const plan = await planLiveReconciliation(conn, META_SCHEMA_NAME, META_TABLES, {
      ...(allowLoosening ? { allowLoosening: true } : {}),
    });
    if (allowLoosening && !flags.has("--plan")) {
      // Said out loud before anything runs, because this is the one invocation that *removes* a
      // constraint the database is currently enforcing, and the plan it prints afterwards is the
      // only other place it would be visible.
      process.stderr.write(
        "--allow-loosening: undeclared foreign keys will be DROPPED rather than reported.\n",
      );
    }
    if (flags.has("--plan")) {
      process.stdout.write(formatReconciliationPlan(plan) + "\n");
      return 0;
    }
    const applier = new MigrationApplier({
      connection: conn,
      schema: META_SCHEMA_NAME,
      // The plan's own statements, and nothing prepended. `emitSchemaCreate` used to lead this
      // list and was redundant twice over: `MigrationApplier` calls `ensureMigrationLog` before the
      // first statement and *its* first DDL is `CREATE SCHEMA IF NOT EXISTS`, and on an empty
      // database the plan is `emitBootstrapSql`, which already begins with the same statement. The
      // cost was a report that read as a claim about the schema: on a fully converged database the
      // plan is empty, so the applier ran exactly that one idempotent statement and printed
      // `total: 1, executed: 1` — "one change was made" where nothing had changed, which is the
      // confusion ADR-0331 added the re-plan to remove.
      statements: [...plan.statements],
      skipApplied: false,
    });
    const report = await applier.apply();
    process.stdout.write(formatApplyReport(report) + "\n");
    if (plan.unreconciled.length > 0) {
      process.stdout.write(formatReconciliationPlan(plan) + "\n");
    }
    if (!report.preconditions.ok || report.failed > 0) return 1;
    return 0;
  } finally {
    await conn.close();
  }
}

async function runDrift(flags: ReadonlySet<string>): Promise<number> {
  const config = parsePgEnvConfig();
  const conn = createNodePgConnection(config);
  try {
    const live = await introspectSchema(conn, META_SCHEMA_NAME);
    // Index predicates and policy clauses are compared through Postgres's own rendering of the
    // declared text; without it they are not compared at all.
    const liveNames = new Set(live.tables.map((t) => t.name));
    const rendered = await renderExpressions(
      conn,
      META_SCHEMA_NAME,
      META_TABLES.filter((t) => liveNames.has(t.name)).flatMap((t) => expressionRequestsFor(t)),
    );
    const diff = diffSchema(META_TABLES, live, rendered);
    if (flags.has("--json")) {
      process.stdout.write(JSON.stringify(diff, null, 2) + "\n");
    } else {
      process.stdout.write(formatSchemaDiff(diff) + "\n");
    }
    if (diff.hasDrift && !flags.has("--exit-zero-on-drift")) return 1;
    return 0;
  } finally {
    await conn.close();
  }
}

async function runInspect(flags: ReadonlySet<string>): Promise<number> {
  const config = parsePgEnvConfig();
  const conn = createNodePgConnection(config);
  try {
    const live = await introspectSchema(conn, META_SCHEMA_NAME);
    if (flags.has("--json")) {
      process.stdout.write(JSON.stringify(live, null, 2) + "\n");
    } else {
      process.stdout.write(`Live schema "${live.schema}": ${live.tables.length} table(s)\n`);
      for (const t of live.tables) {
        process.stdout.write(
          `  ${t.name} (cols=${t.columns.length} idx=${t.indexes.length} pol=${t.policies.length} rls=${t.rlsEnabled})\n`,
        );
      }
    }
    return 0;
  } finally {
    await conn.close();
  }
}

async function runEncrypt(
  flags: ReadonlySet<string>,
  argv: readonly string[],
): Promise<number> {
  const schema = flagValue(argv, "schema") ?? META_SCHEMA_NAME;
  const keyRef = flagValue(argv, "key-ref") ?? DEFAULT_KEY_REF;
  const config = parsePgEnvConfig();
  const conn = createNodePgConnection(config);
  try {
    if (flags.has("--verify")) {
      const report = await new EncryptionApplier(conn).coverage(schema);
      if (flags.has("--json")) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        process.stdout.write(formatEncryptionCoverage(report) + "\n");
      }
      return report.issues.length > 0 && !flags.has("--exit-zero-on-drift") ? 1 : 0;
    }

    const migrator = new EncryptionMigrator(conn);
    if (flags.has("--apply")) {
      if (looksLikeProductionDatabase(config.database) && !flags.has("--confirm")) {
        process.stderr.write(
          `Refusing to migrate against production-looking database '${config.database}' without --confirm.\n`,
        );
        return 2;
      }
      if (flags.has("--provision")) {
        await new EncryptionApplier(conn).ensureProvisioned();
      }
      const plans = await migrator.migrateSchema(schema, keyRef);
      process.stdout.write(
        plans.length === 0
          ? "No plaintext columns to encrypt.\n"
          : `Encrypted ${plans.length.toString()} column(s) in schema "${schema}".\n`,
      );
      return 0;
    }

    // default: --plan (dry-run)
    const plans = await migrator.planSchema(schema, keyRef);
    process.stdout.write(formatEncryptionPlan(plans) + "\n");
    return 0;
  } finally {
    await conn.close();
  }
}

function runVersion(): number {
  process.stdout.write(
    `crossengin-pg ${CLI_VERSION}\nMETA_TABLES: ${META_TABLES.length}\nMETA_SCHEMA_NAME: ${META_SCHEMA_NAME}\n`,
  );
  return 0;
}

async function main(): Promise<void> {
  const { command, flags } = parseCommand(process.argv);
  let exitCode = 0;
  switch (command) {
    case "apply":
      exitCode = await runApply(flags);
      break;
    case "drift":
      exitCode = await runDrift(flags);
      break;
    case "inspect":
      exitCode = await runInspect(flags);
      break;
    case "encrypt":
      exitCode = await runEncrypt(flags, process.argv);
      break;
    case "version":
      exitCode = runVersion();
      break;
    case "help":
      printHelp();
      exitCode = 0;
      break;
  }
  process.exit(exitCode);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(message + "\n");
  process.exit(1);
});
