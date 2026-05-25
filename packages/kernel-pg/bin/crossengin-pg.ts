#!/usr/bin/env node

import { META_SCHEMA_NAME, META_TABLES, emitMetaBootstrapSql } from "@crossengin/kernel/bootstrap";

import { MigrationApplier, formatApplyReport } from "../src/applier.js";
import {
  type PgConnection,
  looksLikeProductionDatabase,
  parsePgEnvConfig,
} from "../src/connection.js";
import { diffSchema, formatSchemaDiff } from "../src/diff.js";
import { introspectSchema } from "../src/introspection.js";
import { createNodePgConnection } from "../src/node-pg.js";

const CLI_VERSION = "0.0.0";

type Command = "apply" | "drift" | "inspect" | "version" | "help";

function parseCommand(argv: readonly string[]): { command: Command; flags: ReadonlySet<string> } {
  const positional = argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const flags = new Set(argv.slice(2).filter((arg) => arg.startsWith("--")));
  const first = positional[0];
  if (first === undefined || first === "help" || flags.has("--help")) {
    return { command: "help", flags };
  }
  if (first === "apply" || first === "drift" || first === "inspect" || first === "version") {
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
      "  apply                Apply the meta-schema to the database",
      "  apply --dry-run      Print the SQL that would be executed without running it",
      "  drift                Introspect the live schema and report drift vs META_TABLES",
      "  inspect              Print the live schema as JSON",
      "  version              Print the applier version and META_TABLES count",
      "  help                 Show this help text",
      "",
      "Flags:",
      "  --dry-run            With apply, emit SQL without executing",
      "  --confirm            Required when PGDATABASE looks like production",
      "  --exit-zero-on-drift With drift, do not exit non-zero when drift exists",
      "  --json               With drift/inspect, emit JSON instead of human form",
      "",
      "Environment:",
      "  PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE, PGAPPNAME",
      "",
    ].join("\n"),
  );
}

async function runApply(flags: ReadonlySet<string>): Promise<number> {
  const statements = emitMetaBootstrapSql();
  if (flags.has("--dry-run")) {
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
    const applier = new MigrationApplier({
      connection: conn,
      schema: META_SCHEMA_NAME,
      statements,
    });
    const report = await applier.apply();
    process.stdout.write(formatApplyReport(report) + "\n");
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
    const diff = diffSchema(META_TABLES, live);
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
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(message + "\n");
  process.exit(1);
});
