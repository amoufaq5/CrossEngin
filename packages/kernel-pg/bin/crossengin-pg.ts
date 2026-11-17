#!/usr/bin/env node

import {
  META_SCHEMA_NAME,
  META_TABLES,
  emitMetaBootstrapSql,
} from "@crossengin/kernel/bootstrap";

import { MigrationApplier, formatApplyReport } from "../src/applier.js";
import type { ParsedFlags } from "../src/cli-flags.js";
import { type MigrationBounds, parseCrossenginPgArgs } from "../src/crossengin-pg-args.js";
import {
  type PgConnection,
  looksLikeProductionDatabase,
  parsePgEnvConfig,
} from "../src/connection.js";
import { diffSchema, expressionRequestsFor, formatSchemaDiff } from "../src/diff.js";
import { renderExpressions } from "../src/expression-render.js";
import {
  applierStatementsFor,
  applyExitCode,
  driftExitCode,
  formatReconciliationPlan,
  formatUncomparedApplyOutcome,
  planLiveReconciliation,
} from "../src/reconcile.js";
import {
  COLUMN_ENCRYPTION_KEY_ENV,
  DEFAULT_COLUMN_KEY_REF,
  EncryptionApplier,
  formatEncryptionCoverage,
  resolveColumnEncryptionKey,
} from "../src/encryption.js";
import {
  EncryptionMigrator,
  formatEncryptionPlan,
} from "../src/encryption-migration.js";
import { introspectSchema } from "../src/introspection.js";
import { createNodePgConnection } from "../src/node-pg.js";

const CLI_VERSION = "0.0.0";

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: crossengin-pg <command> [flags]",
      "",
      "An unknown command or flag is refused (exit 2). A value flag takes --x=v or --x v; a boolean",
      "flag is bare or =true / =false.",
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
      "  --exit-zero-on-drift With drift, exit 0 even when drift exists or an expression could not",
      "                       be compared (both otherwise exit 1)",
      "  --json               With drift/inspect, emit JSON instead of human form",
      "  --schema=<name>      With encrypt, the schema to operate on (default: meta)",
      "  --key-ref=<sql>      With encrypt --plan/--apply, the SQL key reference",
      `                       (default: ${DEFAULT_COLUMN_KEY_REF})`,
      "                       Must be the one-argument current_setting form: the two-argument",
      "                       form yields NULL when unset and pgp_sym_encrypt(x, NULL) is NULL,",
      "                       which would store NULL over every PHI value and report success.",
      "  --provision          With encrypt --apply, CREATE EXTENSION pgcrypto first",
      "  --lock-timeout-ms <n>  With apply/drift, how long a statement or expression probe waits",
      "                       for a lock before giving up (default 5000; 0 waits indefinitely). A",
      "                       statement that waits forever holds its place in the table's lock queue",
      "                       and every query behind it waits too.",
      "  --lock-retries <n>   With apply, retries after a lock timeout (default 2)",
      "  --statement-timeout-ms <n>  With apply, how long a transactional statement may run",
      "                       holding its lock (default 600000; 0 disables)",
      "  --verify|--plan|--apply  encrypt action (default: --plan)",
      "",
      "Environment:",
      "  PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE, PGAPPNAME",
      `  ${COLUMN_ENCRYPTION_KEY_ENV}  The at-rest column key *value*. Required by`,
      "                            encrypt --apply with the default --key-ref; claimed",
      "                            per transaction as set_config(…, true) with the value",
      "                            bound, never in argv (argv is readable via ps).",
      "",
    ].join("\n"),
  );
}

async function runApply(flags: ParsedFlags, bounds: MigrationBounds): Promise<number> {
  if (flags.booleans.has("dry-run")) {
    const statements = emitMetaBootstrapSql();
    for (const s of statements) process.stdout.write(s + "\n");
    process.stdout.write(`-- ${statements.length} statement(s)\n`);
    return 0;
  }
  const config = parsePgEnvConfig();
  if (looksLikeProductionDatabase(config.database) && !flags.booleans.has("confirm")) {
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
    const allowLoosening = flags.booleans.has("allow-loosening");
    const plan = await planLiveReconciliation(conn, META_SCHEMA_NAME, META_TABLES, {
      ...(allowLoosening ? { allowLoosening: true } : {}),
      ...(bounds.lockTimeoutMs === undefined ? {} : { probeLockTimeoutMs: bounds.lockTimeoutMs }),
    });
    if (allowLoosening && !flags.booleans.has("plan")) {
      // Said out loud before anything runs, because this is the one invocation that *removes* a
      // constraint the database is currently enforcing, and the plan it prints afterwards is the
      // only other place it would be visible.
      process.stderr.write(
        "--allow-loosening: undeclared foreign keys will be DROPPED rather than reported.\n",
      );
    }
    if (flags.booleans.has("plan")) {
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
      statements: applierStatementsFor(plan),
      skipApplied: false,
      ...bounds,
    });
    const report = await applier.apply();
    process.stdout.write(formatApplyReport(report) + "\n");
    const uncompared = plan.uncompared ?? [];
    if (plan.unreconciled.length > 0 || uncompared.length > 0) {
      process.stdout.write(formatReconciliationPlan(plan) + "\n");
    }
    const uncomparedOutcome = formatUncomparedApplyOutcome(uncompared);
    if (uncomparedOutcome !== null) process.stdout.write(uncomparedOutcome + "\n");
    // An `unreconciled` item is **reported and exits 0**, and ADR-0363 is where that was weighed
    // rather than inherited. `constraint_violated_by_existing_rows` is the first reason here that no
    // re-run can clear, so "exit 1 for a difference that will never converge" is a real argument —
    // and the deciding fact is on the other side: `deploy/docker-compose.yml` gates `api` on
    // `migrate` with `condition: service_completed_successfully`, so a non-zero exit takes the whole
    // stack down. A narrowing CHECK on one table is not a reason the API must not serve, and the
    // machine-readable convergence claim ADR-0331 added (`remaining.statements.length === 0` on the
    // JSON payload) is what a caller that does care should read. Exit 1 stays for the conditions
    // that mean *nothing was applied*, *a statement failed*, or *a declared expression was not
    // compared* — the last because its change may have been skipped, and a re-run clears it.
    return applyExitCode(report, uncompared);
  } finally {
    await conn.close();
  }
}

async function runDrift(flags: ParsedFlags, bounds: MigrationBounds): Promise<number> {
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
      bounds.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: bounds.lockTimeoutMs },
    );
    const diff = diffSchema(META_TABLES, live, rendered);
    // An expression the probe could not run (a busy table, a missing privilege) is neither drift nor
    // agreement, so it is said beside the diff rather than folded into it.
    const uncompared = rendered.uncompared ?? [];
    if (flags.booleans.has("json")) {
      process.stdout.write(JSON.stringify({ ...diff, uncompared }, null, 2) + "\n");
    } else {
      process.stdout.write(formatSchemaDiff(diff) + "\n");
      if (uncompared.length > 0) {
        process.stdout.write(
          `NOT VERIFIED — ${String(uncompared.length)} declared expression(s) not compared, so the ` +
            "report above covers only what was; the probe could not run:\n",
        );
        for (const u of uncompared) {
          process.stdout.write(`  ${u.table} [${u.sqlstate ?? "no sqlstate"}] ${u.reason}\n`);
        }
      }
    }
    return driftExitCode(diff.hasDrift, uncompared, flags.booleans.has("exit-zero-on-drift"));
  } finally {
    await conn.close();
  }
}

async function runInspect(flags: ParsedFlags): Promise<number> {
  const config = parsePgEnvConfig();
  const conn = createNodePgConnection(config);
  try {
    const live = await introspectSchema(conn, META_SCHEMA_NAME);
    if (flags.booleans.has("json")) {
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

async function runEncrypt(flags: ParsedFlags): Promise<number> {
  const schema = flags.values.get("schema") ?? META_SCHEMA_NAME;
  const keyRef = flags.values.get("key-ref") ?? DEFAULT_COLUMN_KEY_REF;
  const key = resolveColumnEncryptionKey(keyRef, process.env);

  // Before the connection is opened, let alone the first statement. The migration runs one
  // transaction per column, so raising on statement 1 of N leaves the schema half converted with
  // nothing recording which half; and `--verify` / `--plan` neither set the key nor need it, so the
  // refusal is scoped to `--apply`.
  if (flags.booleans.has("apply") && key.refusal !== null) {
    process.stderr.write(
      `Refusing to run the encryption migration: ${key.refusal.reason}\n${key.refusal.message}\n`,
    );
    return 2;
  }
  if (!flags.booleans.has("apply") && !flags.booleans.has("verify") && key.refusal !== null) {
    // A plan is SQL an operator pastes, so the defect travels with it. Said, not refused: printing
    // the plan is how an operator discovers what the migration would do before arranging a key.
    process.stderr.write(`Warning: ${key.refusal.reason}: ${key.refusal.message}\n`);
  }

  const config = parsePgEnvConfig();
  const conn = createNodePgConnection(config);
  try {
    if (flags.booleans.has("verify")) {
      const report = await new EncryptionApplier(conn).coverage(schema);
      if (flags.booleans.has("json")) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        process.stdout.write(formatEncryptionCoverage(report) + "\n");
      }
      return report.issues.length > 0 && !flags.booleans.has("exit-zero-on-drift") ? 1 : 0;
    }

    const migrator = new EncryptionMigrator(conn, { sessionSettings: key.sessionSettings });
    if (flags.booleans.has("apply")) {
      if (looksLikeProductionDatabase(config.database) && !flags.booleans.has("confirm")) {
        process.stderr.write(
          `Refusing to migrate against production-looking database '${config.database}' without --confirm.\n`,
        );
        return 2;
      }
      if (flags.booleans.has("provision")) {
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
  const parsed = parseCrossenginPgArgs(process.argv);
  if (!parsed.ok) {
    process.stderr.write(`crossengin-pg: ${parsed.error}\nRun 'crossengin-pg help' for usage.\n`);
    process.exit(2);
  }
  const { command, flags, bounds } = parsed;
  let exitCode = 0;
  switch (command) {
    case "apply":
      exitCode = await runApply(flags, bounds);
      break;
    case "drift":
      exitCode = await runDrift(flags, bounds);
      break;
    case "inspect":
      exitCode = await runInspect(flags);
      break;
    case "encrypt":
      exitCode = await runEncrypt(flags);
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
